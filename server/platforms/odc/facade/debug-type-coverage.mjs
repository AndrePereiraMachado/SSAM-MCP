// Read-only per-type coverage auditor (req 2 inside the R19 matrix). It loads the audit/proof files listed in the
// matrix source, checks each file's sha256 and JSON-pointer predicates, and maps every audit to cells
// (lane, runtime, type, role) per surface (mcp|cli) with scenario and pause counts. A cell is closed only with a
// verified live MCP audit AND a verified live CLI audit whose files attest that surface (attestTransport); one
// surface or a manifest-only attribution is partial; a refused audit (or one whose file records the other surface)
// turns its cells open. Native-limit cells need a verified evidence path; types the SDK refuses (e.g. Object) are
// 'refused' only with a verified refusal pin carrying predicates. Only *.json audits under .local/debugger are parsed,
// DPAPI/vault records are never opened, values are never copied (counts only) and nothing contacts a tenant.
// The pin primitives here (confinement, predicates, verifyPin) are shared with debug-final-matrix.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const HEX64 = /^[a-f0-9]{64}$/, PLACEHOLDER = /^(?:d{64}|e{64})$/;
export const COVERAGE_LANES = Object.freeze(['o11', 'odc']), COVERAGE_RUNTIMES = Object.freeze(['client', 'server']);
export const COVERAGE_ROLES = Object.freeze(['input', 'local', 'output', 'return']);
export const COVERAGE_TYPES = Object.freeze(['Text', 'Email', 'Phone Number', 'Integer', 'Long Integer', 'Decimal', 'Currency', 'Boolean', 'Date',
  'Time', 'Date Time', 'Binary Data', 'Integer Identifier', 'Long Integer Identifier', 'Text Identifier', 'Entity Record', 'Structure Record',
  'Record List', 'Basic Type List', 'Object']);
export const SURFACES = Object.freeze(['mcp', 'cli']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = value => value.split(path.sep).join('/');

// DPAPI records and vault files are refused by name before any read (directory names may say vault).
export const privatePath = rel => /\.dpapi$/i.test(rel) || /vault/i.test(path.posix.basename(rel.replace(/\\/g, '/')));
export function confine(base, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return { reason: 'outside-root' };
  const file = path.resolve(base, rel), relative = path.relative(base, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { reason: 'outside-root' };
  if (privatePath(relative)) return { reason: 'private-store-refused' };
  return { file, rel: posix(relative) };
}

// RFC 6901 pointer read; undefined when absent.
export function pointer(value, ptr) {
  if (ptr === '') return value;
  let node = value;
  for (const raw of ptr.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}
// "<pointer><op><json literal>", op one of == != >= <= > <.
export function parsePredicate(text) {
  const match = /^((?:\/[^=!<>]*)+)(==|!=|>=|<=|>|<)(.+)$/.exec(typeof text === 'string' ? text : '');
  if (!match) throw new Error('debug_matrix_predicate_invalid:' + text);
  let expected; try { expected = JSON.parse(match[3]); } catch { throw new Error('debug_matrix_predicate_invalid:' + text); }
  if (['>=', '<=', '>', '<'].includes(match[2]) && typeof expected !== 'number') throw new Error('debug_matrix_predicate_invalid:' + text);
  return { pointer: match[1], op: match[2], expected };
}
export function predicateHolds(value, text) {
  const { pointer: ptr, op, expected } = parsePredicate(text), actual = pointer(value, ptr);
  if (op === '==') return actual !== undefined && JSON.stringify(actual) === JSON.stringify(expected);
  if (op === '!=') return actual !== undefined && JSON.stringify(actual) !== JSON.stringify(expected);
  if (typeof actual !== 'number') return false;
  return op === '>=' ? actual >= expected : op === '<=' ? actual <= expected : op === '>' ? actual > expected : actual < expected;
}

// One pin: confinement, pin shape, exact file sha256, predicates and an optional profile check (injected).
// Returns no value from the file, only verdicts.
export function verifyPin(pin, { base, readFile = fs.readFileSync, profile, parse = false } = {}) {
  const out = { path: pin?.path ?? null, sha256: pin?.sha256 ?? null, ...(pin?.transport ? { transport: pin.transport } : {}),
    ...(pin && 'operationId' in pin ? { operationId: pin.operationId } : {}), ...(pin && 'sessionId' in pin ? { sessionId: pin.sessionId } : {}) };
  const fail = (reason, extra = {}) => ({ ...out, ok: false, reason, ...extra });
  const where = confine(base, pin?.path);
  if (where.reason) return fail(where.reason);
  if (!HEX64.test(pin.sha256 ?? '')) return fail('invalid-pin');
  if (PLACEHOLDER.test(pin.sha256)) return fail('synthetic-pin');
  let bytes; try { bytes = readFile(where.file); } catch { return fail('missing'); }
  const actual = sha(bytes);
  if (actual !== pin.sha256) return fail('hash-mismatch', { actual });
  const predicates = pin.predicates ?? [];
  if (!predicates.length && !pin.profile && !parse) return { ...out, ok: true };
  if (!/\.json$/i.test(where.rel)) return fail('unparsable');
  let value; try { value = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { return fail('unparsable'); }
  let failed; try { failed = predicates.filter(p => !predicateHolds(value, p)); } catch { return fail('predicate-invalid'); }
  const checked = pin.profile && profile ? profile(pin.profile, value, { base, rel: where.rel, file: where.file, readFile }) : null;
  const verdict = { ...out, ...(checked ? { profile: checked } : {}) };
  if (failed.length) return { ...verdict, ok: false, reason: 'predicate-failed', failed };
  if (checked && !checked.ok) return { ...verdict, ok: false, reason: 'profile-failed', failed: [] };
  return { ...verdict, ok: true, ...(predicates.length ? { failed: [] } : {}), _value: value };
}
const strip = ({ _value, ...rest }) => rest;
// Surface recorded by the evidence file itself (/transport, /surface or /publicMcp:true); null when it records none.
export function attestTransport(value) {
  const recorded = [value?.transport, value?.surface].find(v => typeof v === 'string');
  if (recorded !== undefined) { const mcp = /mcp/i.test(recorded), cli = /cli/i.test(recorded); return mcp !== cli ? (mcp ? 'mcp' : 'cli') : null; }
  return value?.publicMcp === true ? 'mcp' : null;
}

const count = (spec, value) => {
  if (Number.isInteger(spec) && spec >= 0) return spec;
  if (typeof spec === 'string' && spec.startsWith('/')) { const v = value === undefined ? undefined : pointer(value, spec);
    return Array.isArray(v) ? v.length : Number.isInteger(v) && v >= 0 ? v : 0; }
  return 0;
};
const validCell = (c, runtime) => COVERAGE_TYPES.includes(c?.type) && COVERAGE_ROLES.includes(c?.role) && COVERAGE_RUNTIMES.includes(c?.runtime ?? runtime);
const key = (lane, runtime, type, role) => [lane, runtime, type, role].join('|');

export function auditTypeCoverage({ root, audits = [], typeLimits = [], refusals = [], limits = {}, readFile = fs.readFileSync } = {}) {
  const base = path.resolve(root, '.local', 'debugger');
  const cells = new Map();
  for (const lane of COVERAGE_LANES) for (const runtime of COVERAGE_RUNTIMES) for (const type of COVERAGE_TYPES) for (const role of COVERAGE_ROLES)
    cells.set(key(lane, runtime, type, role), { lane, runtime, type, role, status: 'open', reasons: [],
      surfaces: Object.fromEntries(SURFACES.map(s => [s, { audits: [], attested: 0, scenarios: 0, pauses: 0 }])), nativeLimit: null, refusal: null, refused: [] });
  const verdicts = audits.map(spec => {
    const valid = COVERAGE_LANES.includes(spec?.lane) && SURFACES.includes(spec?.transport) && COVERAGE_RUNTIMES.includes(spec?.runtime) &&
      Array.isArray(spec?.cells) && spec.cells.length > 0 && spec.cells.every(c => validCell(c, spec.runtime));
    let pinned = valid ? verifyPin(spec, { base, readFile, parse: true }) : { path: spec?.path ?? null, sha256: spec?.sha256 ?? null, ok: false, reason: 'spec-invalid' };
    const value = pinned._value, recorded = pinned.ok ? attestTransport(value) : null;
    if (recorded && recorded !== spec.transport) pinned = { ...strip(pinned), ok: false, reason: 'transport-mismatch', recordedTransport: recorded };
    const audit = { ...strip(pinned), lane: spec?.lane ?? null, runtime: spec?.runtime ?? null, transport: spec?.transport ?? null, live: spec?.live === true,
      transportAttested: pinned.ok && recorded === spec.transport, scenarios: pinned.ok ? count(spec.scenarios, value) : 0, pauses: pinned.ok ? count(spec.pauses, value) : 0 };
    if (valid) for (const c of spec.cells) {
      const cell = cells.get(key(spec.lane, c.runtime ?? spec.runtime, c.type, c.role));
      if (!audit.ok) { cell.refused.push(audit.path + ':' + audit.reason); continue; }
      if (!audit.live) continue;
      const surface = cell.surfaces[spec.transport];
      surface.audits.push(audit.path); surface.attested += audit.transportAttested ? 1 : 0; surface.scenarios += audit.scenarios; surface.pauses += audit.pauses;
    }
    return audit;
  });
  for (const l of typeLimits) {
    const cell = COVERAGE_LANES.includes(l?.lane) && validCell(l, l.runtime) ? cells.get(key(l.lane, l.runtime, l.type, l.role)) : null;
    if (!cell) continue;
    const limit = limits[l.limitId], evidence = limit?.status === 'documented' ? (limit.evidence ?? []).find(e => e.ok && e.path) : null;
    if (evidence) cell.nativeLimit = { id: l.limitId, evidencePath: evidence.path };
    else cell.reasons.push('native-limit-evidence-missing:' + l.limitId);
  }
  // Refusal evidence: the SDK refusing a type is proof only through a verified pin with at least one predicate.
  const refusalVerdicts = refusals.map(spec => {
    const valid = COVERAGE_LANES.includes(spec?.lane) && COVERAGE_RUNTIMES.includes(spec?.runtime) && Array.isArray(spec?.cells) && spec.cells.length > 0 &&
      spec.cells.every(c => validCell(c, spec.runtime));
    const pinned = !valid ? { path: spec?.path ?? null, ok: false, reason: 'spec-invalid' } : !Array.isArray(spec.predicates) || !spec.predicates.length
      ? { path: spec.path ?? null, ok: false, reason: 'predicates-required' } : strip(verifyPin({ ...spec, transport: undefined }, { base, readFile }));
    if (valid) for (const c of spec.cells) {
      const cell = cells.get(key(spec.lane, c.runtime ?? spec.runtime, c.type, c.role));
      if (pinned.ok) cell.refusal = { evidencePath: pinned.path }; else cell.reasons.push('refusal-evidence-invalid:' + pinned.path + ':' + pinned.reason);
    }
    return { ...pinned, lane: spec?.lane ?? null, runtime: spec?.runtime ?? null };
  });
  for (const cell of cells.values()) {
    const live = SURFACES.filter(s => cell.surfaces[s].audits.length), attested = SURFACES.filter(s => cell.surfaces[s].attested);
    if (cell.refused.length) { cell.status = 'open'; cell.reasons.push(...cell.refused.map(r => 'audit-refused:' + r)); }
    else if (cell.reasons.length) cell.status = 'open';
    else if (cell.nativeLimit) cell.status = 'native-limit';
    else if (cell.refusal) cell.status = 'refused';
    else if (attested.length === 2) cell.status = 'closed';
    else if (live.length) { cell.status = 'partial'; cell.reasons.push(...live.filter(s => !cell.surfaces[s].attested).map(s => 'transport-unattested:' + s)); }
    else { cell.status = 'open'; cell.reasons.push('no-live-audit'); }
    delete cell.refused;
  }
  const list = [...cells.values()], counts = {};
  for (const c of list) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return { schema: 'ssam-debugger-type-coverage/1', readOnly: true, audits: verdicts, refusals: refusalVerdicts, cells: list, counts };
}
