// Generated, hash-verifiable final debugger matrix (req 19, O11+ODC). Input is the tracked manifest
// debug-matrix/matrix-source.json (19 requirements x lanes x sub-criteria with evidence pins and JSON-pointer
// predicates) plus debug-matrix/native-limits.json. Every pin is re-verified (file sha256 under .local/debugger,
// predicates, ODC profiles); a missing, changed or synthetic pin turns its cell open, one transport is partial,
// closed needs verified live (live:true) MCP and CLI proofs whose files attest their surface; a file recording the
// other surface opens the cell. Adapter coverage comes from debug-adapter-registry.mjs, the lock inventory from
// debug-lock-inventory.mjs, per-type cells from debug-type-coverage.mjs. Fingerprints: tree hash of facade
// debug*.mjs and kernel/debug/**, worker build receipts, installed Studio/DLL versions (read-only) and the latest
// full Node/.NET test reports (stale when older than the tree). git HEAD is reported beside the matrix, never hashed:
// committing the generated doc must not invalidate it. Output is deterministic JSON + Markdown with its own sha256,
// written only under .local/debugger; check mode never writes.
// Never opens DPAPI/vault records, never copies authorization words or setting values, never contacts a tenant.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { workspaceRoot } from './workspace.mjs';
import { ADAPTERS, SEED_EVIDENCE, qualificationRows } from './debug-adapter-registry.mjs';
import { lockInventory } from './debug-lock-inventory.mjs';
import { auditTypeCoverage, verifyPin, parsePredicate, attestTransport, privatePath, pointer, HEX64 } from './debug-type-coverage.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = value => value.split(path.sep).join('/');
const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCE = path.join(here, 'debug-matrix', 'matrix-source.json');
export const DEFAULT_LIMITS = path.join(here, 'debug-matrix', 'native-limits.json');
export const MATRIX_SCHEMA = 'ssam-debugger-final-matrix/1', SOURCE_SCHEMA = 'ssam-debugger-matrix-source/1', LIMITS_SCHEMA = 'ssam-debugger-native-limits/1';
export const REQUIRED_LIMITS = Object.freeze(['o11-client-suspend-all-threads', 'odc-client-suspend-all-threads', 'o11-service-step-into-from-consumer',
  'odc-exposed-soap-removed', 'o11-remote-session-absence-unqualified']);
export const KINDS = Object.freeze(['proof', 'native-limit', 'excluded', 'type-coverage', 'adapter-coverage', 'lock-inventory', 'matrix-integrity']);
export const PROFILES = Object.freeze(['odc-native-run', 'odc-mount', 'odc-role-cycle', 'odc-settings-restore']);
export const DOC = 'docs/DEBUGGER-MATRIZ-FINAL.md';
export const POINTER_DOCS = Object.freeze(['docs/DEBUGGER-PLANO-FINAL.md', 'docs/DEBUGGER-HEADLESS-FALTA.md', 'docs/DEBUGGER-REPASSE-FABLE-20261009.md', 'docs/DEBUGGER-HEADLESS.md']);
const MARKER = 'ssam-debug-matrix sha256:', MARKER_RE = /ssam-debug-matrix sha256:([a-f0-9]{64})/g;
const LANES = ['o11', 'odc'], TRANSPORTS = ['mcp', 'cli'];
const COUNTERS = ['networkRequests', 'executeRequestSubmissions', 'negotiations', 'socketConnections', 'longPollingConnections', 'longPollingSendRequests'];
const MOUNT_LIMITS = ['lifecycleComplete', 'renderVerified', 'appRequestIdentityProved', 'userRequestIsolationProved'];
const canonical = value => JSON.stringify(value, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
const same = (a, b) => canonical(a) === canonical(b);
const str = v => typeof v === 'string' && v.trim().length > 0;
const inside = (dir, file) => { const r = path.relative(path.resolve(dir), path.resolve(file)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

// ---- manifest validation ---------------------------------------------------------------------------------
function pinErrors(p, where, { transport = true } = {}) {
  const e = [];
  if (!p || typeof p !== 'object') return [where + ': pin'];
  if (!str(p.path) || path.isAbsolute(p.path) || p.path.split(/[\\/]/).includes('..')) e.push(where + ': pin path');
  if (typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256)) e.push(where + ': pin sha256');
  if (transport && !TRANSPORTS.includes(p.transport)) e.push(where + ': pin transport');
  if (transport) for (const k of ['operationId', 'sessionId']) if (!(k in p) || !(p[k] === null || typeof p[k] === 'string')) e.push(where + ': pin ' + k);
  for (const x of p.predicates ?? []) { try { parsePredicate(x); } catch { e.push(where + ': predicate ' + x); } }
  if (p.predicates !== undefined && !Array.isArray(p.predicates)) e.push(where + ': predicates');
  if (p.profile !== undefined && !PROFILES.includes(p.profile?.name)) e.push(where + ': profile');
  if (p.live !== undefined && typeof p.live !== 'boolean') e.push(where + ': live');
  return e;
}
export function validateSource(src) {
  const errors = [], seen = new Set();
  if (src?.schema !== SOURCE_SCHEMA) errors.push('schema');
  if (src?.root !== '.local/debugger') errors.push('root');
  const reqs = Array.isArray(src?.requirements) ? src.requirements : [];
  if (reqs.map(r => r?.id).join(',') !== Array.from({ length: 19 }, (_, i) => i + 1).join(',')) errors.push('requirements must be 1..19 in order');
  for (const r of reqs) {
    if (!str(r?.title)) errors.push(r?.id + ': title');
    for (const lane of LANES) {
      const subs = r?.lanes?.[lane]?.subCriteria;
      if (!Array.isArray(subs) || !subs.length) { errors.push(r?.id + '.' + lane + ': subCriteria'); continue; }
      for (const s of subs) {
        const at = r.id + '.' + lane + ':' + s?.id;
        if (!str(s?.id) || seen.has(s.id)) errors.push(at + ' id'); else seen.add(s.id);
        if (!str(s?.text)) errors.push(at + ' text');
        if (!KINDS.includes(s?.kind)) errors.push(at + ' kind');
        if (!Array.isArray(s?.pins)) errors.push(at + ' pins'); else s.pins.forEach((p, i) => errors.push(...pinErrors(p, at + ' pin ' + i)));
        if (!Array.isArray(s?.nativeLimits) || !s.nativeLimits.every(str)) errors.push(at + ' nativeLimits');
        if (s?.kind === 'native-limit' && !s.nativeLimits?.length) errors.push(at + ' native-limit without ids');
        if (s?.kind === 'excluded' && (!str(s.reason) || !(s.pins?.length || str(s.registry)))) errors.push(at + ' excluded needs reason and evidence');
      }
    }
  }
  if (!Array.isArray(src?.typeAudits)) errors.push('typeAudits'); else src.typeAudits.forEach((a, i) => errors.push(...pinErrors(a, 'typeAudit ' + i)));
  if (!Array.isArray(src?.typeLimits)) errors.push('typeLimits');
  if (src?.typeRefusals !== undefined && !Array.isArray(src.typeRefusals)) errors.push('typeRefusals');
  (Array.isArray(src?.typeRefusals) ? src.typeRefusals : []).forEach((a, i) => {
    errors.push(...pinErrors(a, 'typeRefusal ' + i, { transport: false }));
    if (!Array.isArray(a?.predicates) || !a.predicates.length) errors.push('typeRefusal ' + i + ': predicates required');
    if (!Array.isArray(a?.cells) || !a.cells.length) errors.push('typeRefusal ' + i + ': cells');
  });
  if (!src?.fingerprint || !Array.isArray(src.fingerprint.installed)) errors.push('fingerprint.installed');
  for (const i of src?.fingerprint?.installed ?? []) if (!LANES.includes(i?.lane) || !str(i?.name) || /[\\/]/.test(i.name)) errors.push('fingerprint.installed ' + i?.name);
  const odc = src?.fingerprint?.odc;
  if (odc) { if (!/^[0-9a-f-]{36}$/.test(odc.stageKey ?? '')) errors.push('fingerprint.odc.stageKey');
    for (const k of ['fixture', 'snapshot']) if (odc[k]) errors.push(...pinErrors(odc[k].pin, 'fingerprint.odc.' + k, { transport: false })); }
  return { ok: errors.length === 0, errors };
}
export function validateLimits(doc) {
  const errors = [], ids = new Set();
  if (doc?.schema !== LIMITS_SCHEMA) errors.push('schema');
  for (const l of Array.isArray(doc?.limits) ? doc.limits : (errors.push('limits'), [])) {
    const at = 'limit ' + l?.id;
    if (!/^[a-z0-9-]+$/.test(l?.id ?? '') || ids.has(l.id)) errors.push(at + ' id'); else ids.add(l.id);
    if (!LANES.includes(l?.lane) || !str(l?.title)) errors.push(at + ' lane/title');
    (l?.evidence ?? []).forEach((p, i) => errors.push(...pinErrors(p, at + ' evidence ' + i, { transport: false })));
    if (l?.kind === 'installed-assembly') {
      if (!str(l.assembly?.name) || /[\\/]/.test(l.assembly.name) || !str(l.assembly?.fileVersion) || !HEX64.test(l.assembly?.sha256 ?? '')) errors.push(at + ' assembly');
      if (!str(l.type) || !str(l.member)) errors.push(at + ' type/member');
      if (!Array.isArray(l.evidence) || !l.evidence.length) errors.push(at + ' evidence (decompilation receipt) required');
    } else if (l?.kind === 'official-doc') {
      if (!/^https:\/\/success\.outsystems\.com\//.test(l.url ?? '')) errors.push(at + ' url');
    } else errors.push(at + ' kind');
  }
  return { ok: errors.length === 0, errors };
}

// ---- ODC profiles ----------------------------------------------------------------------------------------
function common(value, failed) {
  if (value?.credentialsReleased !== true) failed.push('credentialsReleased');
  if (value?.lockRetained !== false) failed.push('lockRetained');
  if (value?.uncertain !== false) failed.push('uncertain');
}
function sibling(ctx, name) {
  const dir = path.dirname(ctx.file), file = path.join(dir, name);
  if (privatePath(name) || !inside(ctx.base, file)) return null;
  try { const bytes = ctx.readFile(file); return { bytes, rel: posix(path.relative(ctx.base, file)), value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) }; }
  catch { return null; }
}
export function odcProfile(name, value, ctx = {}) {
  const failed = [], spec = ctx.profile ?? { name };
  if (name === 'odc-native-run') {
    if (value?.schema !== 'ssam-odc-native-run/1') failed.push('schema');
    if (value?.cleanup?.receipt?.cleanupConfirmed !== true) failed.push('cleanup.receipt.cleanupConfirmed');
    const t = value?.cleanup?.receipt?.transport, counters = {};
    if (!t || typeof t !== 'object') failed.push('cleanup.receipt.transport');
    else {
      for (const n of COUNTERS) { if (Number.isInteger(t[n]) && t[n] >= 0) counters[n] = t[n]; else failed.push('transport.' + n); }
      if (t.uncertain !== false) failed.push('transport.uncertain');
      if (t.deadlineExpired === true) failed.push('transport.deadlineExpired');
      if ((t.longPollingConnections ?? 0) > 0 && (t.longPollingCleanupConfirmed !== true || t.longPollingCleanupUncertain === true)) failed.push('transport.longPollingCleanup');
      if ((t.executeRequestSubmissions ?? 0) > 0 && !(t.probes ?? []).length) failed.push('transport.probes');
      for (const p of t.probes ?? []) if ((p?.executeRequestSubmissions ?? 0) > 0 && (p.finished !== true || p.uncertain !== false)) failed.push('transport.probe:' + p.probeId);
    }
    common(value, failed);
    return { name, ok: !failed.length, failed, counters };
  }
  if (name === 'odc-mount') {
    if (value?.schema !== 'ssam-odc-native-run/1' || value?.lifecycle !== 'mounted') failed.push('schema/lifecycle');
    if (value?.staticEffectsQualified !== false) failed.push('staticEffectsQualified');
    const auth = ctx.file ? sibling(ctx, 'authorization.json') : null;
    let authorization = null;
    if (!auth) failed.push('authorization.missing');
    else {
      // CX15 r5 (N-3): the authorization file keeps wordsSha256 (a file of before, with words, is hashed here).
      authorization = { path: auth.rel, sha256: sha(auth.bytes), wordsSha256: /^[0-9a-f]{64}$/.test(String(auth.value?.wordsSha256 ?? '')) ? auth.value.wordsSha256 : str(auth.value?.words) ? sha(auth.value.words) : null };
      if (authorization.sha256 !== value?.authorizationSha256) failed.push('authorization.sha256');
      if (auth.value?.schema !== 'ssam-odc-mount-authorization/1' || auth.value?.operationId !== value?.operationId) failed.push('authorization.binding');
      if (!authorization.wordsSha256) failed.push('authorization.words');
    }
    let names = []; try { names = ctx.file ? fs.readdirSync(path.dirname(ctx.file)) : []; } catch { names = []; }
    const journal = (prefix) => {
      const hits = names.filter(n => n.startsWith(prefix) && n.endsWith('.json'));
      if (hits.length !== 1) { failed.push(prefix + '.single'); return null; }
      const hit = sibling(ctx, hits[0]);
      if (!hit || hit.value?.operationId !== value?.operationId) { failed.push(prefix + '.binding'); return null; }
      return hit;
    };
    const submission = journal('mount-submission'), result = journal('mount-result');
    if (value?.mountSubmitted !== true) failed.push('mountSubmitted');
    if (submission?.value?.metadata?.authorizationSha256 && submission.value.metadata.authorizationSha256 !== value?.authorizationSha256) failed.push('mount-submission.authorization');
    if (result && !same(result.value?.metadata, value?.mountOutcome)) failed.push('mount-result.outcome');
    if (value?.cleanup?.completed !== true) failed.push('cleanup.completed');
    common(value, failed);
    return { name, ok: !failed.length, failed, staticEffectsQualified: value?.staticEffectsQualified ?? null, authorization,
      submission: submission ? { path: submission.rel, sha256: sha(submission.bytes) } : null, result: result ? { path: result.rel, sha256: sha(result.bytes) } : null,
      limits: MOUNT_LIMITS.filter(n => value?.[n] === false) };
  }
  if (name === 'odc-role-cycle') {
    // Hashes recorded by the cycle, or the permission set hashed here from before/after role-key lists (roleSetSha256 rule).
    const set = ptr => { const list = typeof ptr === 'string' ? pointer(value, ptr) : undefined;
      return Array.isArray(list) && list.every(k => typeof k === 'string') ? sha(JSON.stringify([...new Set(list.map(k => k.toLowerCase()))].sort())) : undefined; };
    const at = spec.at ?? '', before = spec.beforeList ? set(spec.beforeList) : pointer(value, at + '/beforeSha256'),
      after = spec.afterList ? set(spec.afterList) : pointer(value, at + '/afterSha256');
    if (!HEX64.test(before ?? '')) failed.push('beforeSha256');
    if (!HEX64.test(after ?? '')) failed.push('afterSha256');
    if (HEX64.test(before ?? '') && before !== after) failed.push('role-set-changed');
    if (pointer(value, at + '/restored') === false) failed.push('restored');
    return { name, ok: !failed.length, failed, beforeSha256: before ?? null, afterSha256: after ?? null };
  }
  if (name === 'odc-settings-restore') {
    const before = typeof spec.before === 'string' ? pointer(value, spec.before) : undefined, after = typeof spec.after === 'string' ? pointer(value, spec.after) : undefined;
    if (!before || typeof before !== 'object' || !after || typeof after !== 'object') return { name, ok: false, failed: ['before/after'], flags: [] };
    // Values are compared, never copied; the origin is part of the restore, not a detail.
    const valueRestored = same(before.value, after.value), originRestored = before.valueOrigin === after.valueOrigin, flags = [];
    if (!originRestored) flags.push('origin-changed:' + before.valueOrigin + '->' + after.valueOrigin);
    if (!valueRestored) failed.push('value-changed');
    if (!originRestored) failed.push('origin-changed');
    return { name, ok: !failed.length, failed, valueRestored, originRestored, originBefore: before.valueOrigin ?? null, originAfter: after.valueOrigin ?? null, flags };
  }
  return { name, ok: false, failed: ['profile-unknown'] };
}
// A proof pin is live only when the manifest marks it live:true; its transport counts only when the file attests it.
const check = (pin, ctx) => {
  const json = !!pin.transport && /\.json$/i.test(pin.path ?? '');
  const { _value, ...rest } = verifyPin(pin, { ...ctx, parse: ctx.parse || json, profile: (spec, value, c) => odcProfile(spec.name, value, { ...c, profile: spec }) });
  const live = pin.live === true, recorded = pin.transport && rest.ok && _value !== undefined ? attestTransport(_value) : null;
  if (recorded && recorded !== pin.transport) return { ...rest, ok: false, reason: 'transport-mismatch', recordedTransport: recorded, live, transportAttested: false };
  return { ...rest, live, ...(pin.transport ? { transportAttested: recorded === pin.transport } : {}), ...(_value !== undefined ? { _value } : {}) };
};
const publicPin = ({ _value, ...rest }) => rest;

// ---- fingerprints ----------------------------------------------------------------------------------------
const KEY = Buffer.from('FileVersion\0', 'utf16le');
export function fileVersion(bytes) {
  const i = bytes.lastIndexOf(KEY); if (i < 0) return null;
  let p = i + KEY.length; while (p < bytes.length - 1 && bytes.readUInt16LE(p) === 0) p += 2;
  let s = ''; while (p < bytes.length - 1 && s.length < 64) { const c = bytes.readUInt16LE(p); if (!c) break; s += String.fromCharCode(c); p += 2; }
  return s.trim() || null;
}
function installedReader(readFile) {
  const cache = new Map();
  return (dir, name) => {
    if (!dir || !str(name) || /[\\/]/.test(name) || privatePath(name)) return { found: false, sha256: null, fileVersion: null };
    const file = path.join(dir, name);
    if (!cache.has(file)) { try { const b = readFile(file); cache.set(file, { found: true, sha256: sha(b), fileVersion: fileVersion(b) }); }
      catch { cache.set(file, { found: false, sha256: null, fileVersion: null }); } }
    return cache.get(file);
  };
}
function gitHead(root, readFile) {
  const text = file => { try { return String(readFile(file)).trim(); } catch { return null; } };
  let dir = path.join(root, '.git'); const link = (() => { try { return fs.statSync(dir).isFile() ? text(dir) : null; } catch { return null; } })();
  if (link?.startsWith('gitdir:')) dir = path.resolve(root, link.slice(7).trim());
  const head = text(path.join(dir, 'HEAD'));
  if (!head) return { ref: null, head: null };
  if (!head.startsWith('ref:')) return { ref: null, head: /^[a-f0-9]{40}$/.test(head) ? head : null };
  const ref = head.slice(4).trim(), common = text(path.join(dir, 'commondir')), stores = [dir, ...(common ? [path.resolve(dir, common)] : [])];
  for (const store of stores) {
    const loose = text(path.join(store, ...ref.split('/'))); if (/^[a-f0-9]{40}$/.test(loose ?? '')) return { ref, head: loose };
    const packed = text(path.join(store, 'packed-refs'))?.split(/\r?\n/).find(l => l.endsWith(' ' + ref)); if (packed) return { ref, head: packed.slice(0, 40) };
  }
  return { ref, head: null };
}
function walk(dir, skip = () => false) {
  let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(e => { const file = path.join(dir, e.name);
    return e.isDirectory() ? (skip(e.name) ? [] : walk(file, skip)) : e.isFile() ? [file] : []; });
}
function tree(root, readFile) {
  const facadeDir = path.join(root, 'platforms', 'odc', 'facade');
  let top = []; try { top = fs.readdirSync(facadeDir).filter(n => /^debug.*\.mjs$/.test(n)).map(n => path.join(facadeDir, n)); } catch { top = []; }
  const kernel = walk(path.join(root, 'kernel', 'debug'), name => ['bin', 'obj', 'node_modules', 'TestResults'].includes(name) || name.startsWith('.'));
  const files = [...top, ...kernel].map(file => ({ file, rel: posix(path.relative(root, file)) })).sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  const hash = createHash('sha256'); let newest = 0;
  for (const f of files) { hash.update(f.rel + '\0' + sha(readFile(f.file)) + '\n'); newest = Math.max(newest, fs.statSync(f.file).mtimeMs); }
  // Content only: mtimes decide test-report staleness but are not part of the tree identity.
  return { sha256: hash.digest('hex'), count: files.length, files: files.map(f => f.rel), _newest: newest };
}
// Only a recognized runner summary counts; a report without one (or with no tests) is never pinned.
function counts(kind, text) {
  let found = null;
  if (kind === 'dotnet') {
    const trx = /<Counters\b[^>]*>/.exec(text)?.[0], attr = n => Number(new RegExp('\\b' + n + '="(\\d+)"').exec(trx ?? '')?.[1] ?? NaN);
    const line = /Failed:\s*(\d+),\s*Passed:\s*(\d+)/.exec(text);
    found = trx ? { passed: attr('passed'), failed: attr('failed') } : line ? { passed: Number(line[2]), failed: Number(line[1]) } : null;
  } else {
    const pass = /^(?:ℹ|#) pass (\d+)/m.exec(text), fail = /^(?:ℹ|#) fail (\d+)/m.exec(text);
    found = pass && fail ? { passed: Number(pass[1]), failed: Number(fail[1]) } : null;
  }
  return found && Number.isInteger(found.passed) && Number.isInteger(found.failed) && found.passed + found.failed > 0 ? found : null;
}
// Candidates: test-reports/<kind>/** (written for the matrix) and full-suite runs under suite-runs/**; partial or
// unrelated runs (catalog, related, rerun) never stand for the suite. The newest recognized report wins.
function testReports(base, newest, readFile) {
  const out = { node: null, dotnet: null };
  for (const kind of ['node', 'dotnet']) {
    const ext = kind === 'dotnet' ? /\.(trx|txt|log)$/i : /\.(txt|tap|log)$/i;
    const files = [...walk(path.join(base, 'test-reports', kind)),
      ...walk(path.join(base, 'suite-runs')).filter(f => /^full-suite/i.test(path.basename(f)) && /dotnet|\.trx$/i.test(path.basename(f)) === (kind === 'dotnet'))]
      .filter(f => ext.test(f) && !privatePath(f));
    const ranked = files.map(f => ({ f, rel: posix(path.relative(base, f)), m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m || (a.rel < b.rel ? -1 : 1));
    for (const { f, rel, m } of ranked) {
      const bytes = readFile(f), n = counts(kind, bytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (!n) continue;
      out[kind] = { path: rel, sha256: sha(bytes), mtime: new Date(m).toISOString(), stale: m < newest, ...n };
      break;
    }
  }
  return out;
}
function workerBuilds(base, readFile) {
  return Object.fromEntries(LANES.map(lane => {
    const dir = path.join(base, 'builds', lane);
    let keys = []; try { keys = fs.readdirSync(dir).filter(k => { try { return fs.statSync(path.join(dir, k, 'ready.json')).isFile(); } catch { return false; } }); } catch { keys = []; }
    if (!keys.length) return [lane, null];
    const ranked = keys.map(k => ({ k, m: fs.statSync(path.join(dir, k, 'ready.json')).mtimeMs })).sort((a, b) => b.m - a.m || (a.k < b.k ? -1 : 1));
    const { k, m } = ranked[0], dll = (() => { try { return sha(readFile(path.join(dir, k, 'SSAM.Debugger.dll'))); } catch { return null; } })();
    return [lane, { key: k, readySha256: sha(readFile(path.join(dir, k, 'ready.json'))), dllSha256: dll, mtime: new Date(m).toISOString(), builds: keys.length }];
  }));
}
function odcFingerprint(spec, ctx, installed) {
  if (!spec) return null;
  const read = (s, fields) => {
    if (!s?.pin) return null;
    const v = check({ ...s.pin, transport: undefined }, { ...ctx, parse: true });
    if (!v.ok) return { ok: false, reason: v.reason, path: v.path, sha256: v.sha256 };
    return { ok: true, ...Object.fromEntries(fields.map(f => [f, typeof s[f] === 'string' ? pointer(v._value, s[f]) ?? null : null])), path: v.path, sha256: v.sha256 };
  };
  const fixture = read(spec.fixture, ['module', 'revision', 'environmentKey']);
  if (fixture?.ok) fixture.stageMatches = fixture.environmentKey === spec.stageKey;
  return { stageKey: spec.stageKey, studioVersion: installed('odc', 'ODCStudio.exe').fileVersion, fixture, snapshot: read(spec.snapshot, ['sourceSha256']) };
}

// ---- matrix ----------------------------------------------------------------------------------------------
function verifyLimits(doc, ctx, installed) {
  return Object.fromEntries((doc.limits ?? []).map(l => {
    const evidence = (l.evidence ?? []).map(p => publicPin(check(p, ctx))), evidenceOk = evidence.every(e => e.ok);
    const reasons = evidence.filter(e => !e.ok).map(e => 'evidence:' + e.path + ':' + e.reason);
    let status = 'open', inst = null;
    if (l.kind === 'installed-assembly') {
      const seen = installed(l.lane, l.assembly?.name);
      inst = { found: seen.found, sha256: seen.sha256, fileVersion: seen.fileVersion, matches: seen.found ? seen.sha256 === l.assembly?.sha256 : null };
      if (!evidence.length) reasons.push('evidence-missing');
      status = !evidence.length || !evidenceOk ? 'open' : inst.found && !inst.matches ? 'stale-installed-assembly' : 'documented';
    } else if (l.kind === 'official-doc') status = /^https:\/\/success\.outsystems\.com\//.test(l.url ?? '') && evidenceOk ? 'documented' : 'open';
    return [l.id, { id: l.id, lane: l.lane, title: l.title, kind: l.kind, status, ...(l.refusalCode ? { refusalCode: l.refusalCode } : {}),
      ...(l.assembly ? { assembly: l.assembly, type: l.type, member: l.member } : {}), ...(l.url ? { url: l.url } : {}),
      ...(inst ? { installed: inst } : {}), evidence, reasons }];
  }));
}
const worst = statuses => statuses.includes('open') ? 'open' : statuses.includes('partial') ? 'partial' : 'closed';
function evaluate(s, lane, ctx) {
  const limitStates = s.nativeLimits.map(id => ({ id, status: ctx.limits[id]?.status ?? 'unregistered' }));
  const limitReasons = limitStates.filter(l => l.status !== 'documented').map(l => 'native-limit-evidence-missing:' + l.id + ':' + l.status);
  const pins = s.pins.map(p => check(p, ctx)), failedPins = pins.filter(p => !p.ok).map(p => 'pin:' + p.path + ':' + p.reason);
  const out = { id: s.id, text: s.text, kind: s.kind, status: 'open', reasons: [], pins: pins.map(publicPin), nativeLimits: limitStates };
  const set = (status, reasons = []) => Object.assign(out, { status, reasons: [...reasons, ...out.reasons] });
  if (s.kind === 'proof') {
    // Closed needs both surfaces attested by live evidence files; a manifest-only attribution is at most partial.
    const live = pins.filter(p => p.ok && p.live), transports = [...new Set(live.filter(p => p.transportAttested).map(p => p.transport))].sort();
    if (!pins.length) return set('open', ['no-evidence', ...limitReasons]);
    if (failedPins.length || limitReasons.length) return set('open', [...failedPins, ...limitReasons]);
    out.transports = transports;
    if (!live.length) return set('open', ['no-live-proof']);
    if (transports.length === 2) return set('closed');
    return set('partial', [...live.filter(p => !p.transportAttested).map(p => 'transport-unattested:' + p.transport + ':' + p.path),
      ...TRANSPORTS.filter(x => !transports.includes(x)).map(x => 'transport-missing:' + x)]);
  }
  if (s.kind === 'native-limit') return failedPins.length || limitReasons.length ? set('open', [...failedPins, ...limitReasons]) : set('native-limit');
  if (s.kind === 'excluded') {
    const [rl, adapter] = (s.registry ?? '').split('/'), row = s.registry ? ADAPTERS.find(r => r.lane === rl && r.adapter === adapter) : null;
    out.reason = s.reason; if (s.registry) out.registry = { ref: s.registry, interactive: row?.interactive ?? null };
    const reasons = [...failedPins, ...(s.registry && row?.interactive !== 'excluded' ? ['registry-row-not-excluded:' + s.registry] : []),
      ...(!s.registry && !pins.length ? ['excluded-without-evidence'] : [])];
    return reasons.length ? set('open', reasons) : set('excluded');
  }
  if (s.kind === 'type-coverage') {
    // Every type counts: a type the SDK refuses (Object) closes only as 'refused' with verified refusal evidence.
    const cells = ctx.typeCoverage.cells.filter(c => c.lane === lane), n = {};
    for (const c of cells) n[c.status] = (n[c.status] ?? 0) + 1;
    out.cells = n;
    const status = n.open ? 'open' : n.partial ? 'partial' : 'closed';
    return set(status, status === 'closed' ? limitReasons : ['type-cells:' + Object.entries(n).map(([k, v]) => k + '=' + v).join(','), ...limitReasons]);
  }
  if (s.kind === 'adapter-coverage') {
    const rows = ctx.adapters[lane], reasons = [];
    for (const r of rows) {
      if (r.interactive === true && r.status !== 'live-mcp-cli') reasons.push('adapter:' + r.adapter + ':' + r.status);
      if (r.interactive === 'native-limit' && r.limit?.status !== 'documented') reasons.push('adapter:' + r.adapter + ':native-limit-undocumented');
    }
    const status = reasons.some(x => /:(pending|native-limit-undocumented)$/.test(x)) ? 'open' : reasons.length ? 'partial' : 'closed';
    return set(failedPins.length || limitReasons.length ? 'open' : status, [...reasons, ...failedPins, ...limitReasons]);
  }
  if (s.kind === 'lock-inventory') {
    const locks = ctx.inventory.locks.filter(l => l.lane === lane || l.lane === 'unknown'), held = {};
    for (const l of locks) if (!l.class || /^(?:retained|candidate)-/.test(l.class)) held[l.class] = (held[l.class] ?? 0) + 1;
    const blocked = ctx.inventory.blockedBindings.filter(b => b.lane === lane).length;
    const reasons = [...Object.entries(held).sort().map(([k, v]) => 'locks:' + k + '=' + v), ...(blocked ? ['blockedBindings=' + blocked] : []), ...failedPins, ...limitReasons];
    out.locks = { total: locks.length, held: Object.values(held).reduce((a, b) => a + b, 0), blockedBindings: blocked };
    return set(reasons.length ? 'open' : 'closed', reasons);
  }
  return out; // matrix-integrity: resolved after every other cell of the lane
}
function integrity(s, lane, requirements, reqId, fp) {
  const others = requirements.filter(r => r.id !== reqId).map(r => [r.id, r.lanes[lane].status]);
  const reasons = [...others.filter(([, st]) => st === 'open').map(([id]) => 'requirement-open:' + id),
    ...(!fp.tree.count ? ['tree-empty'] : []),
    ...['node', 'dotnet'].flatMap(k => { const r = fp.testReports[k];
      return !r ? ['test-report-missing:' + k] : [...(r.stale ? ['test-report-stale:' + k] : []), ...(r.failed !== 0 ? ['test-report-failed:' + k + '=' + r.failed] : [])]; }),
    ...(!fp.workerBuilds[lane] ? ['worker-build-missing:' + lane] : [])];
  const partial = others.filter(([, st]) => st === 'partial').map(([id]) => 'requirement-partial:' + id);
  Object.assign(s, { status: reasons.length ? 'open' : partial.length ? 'partial' : 'closed', reasons: [...reasons, ...partial, ...s.reasons] });
}

function resolve(options) {
  const root = path.resolve(options.root ?? workspaceRoot), env = options.env ?? process.env, pf = env.ProgramFiles ?? 'C:\\Program Files';
  return { root, base: path.join(root, '.local', 'debugger'), outDir: path.resolve(options.outDir ?? path.join(root, '.local', 'debugger', 'final-matrix')),
    sourcePath: options.sourcePath ?? DEFAULT_SOURCE, limitsPath: options.limitsPath ?? DEFAULT_LIMITS, readFile: options.readFile ?? fs.readFileSync,
    inventory: options.inventory ?? (() => lockInventory({ root })), seedEvidence: options.seedEvidence ?? SEED_EVIDENCE,
    studioDirs: options.studioDirs ?? { odc: env.ANVIL_ODC_STUDIO_DIR || path.join(pf, 'OutSystems', 'ODC Studio', 'ODC Studio'),
      o11: env.ANVIL_O11_STUDIO_DIR || path.join(pf, 'OutSystems', 'Service Studio 11', 'Service Studio') },
    write: options.write !== false, writeDoc: options.writeDoc === true, strictLimits: options.validateLimitsStrict !== false };
}
const display = (o, file) => inside(o.root, file) ? posix(path.relative(o.root, file)) : inside(here, file) ? 'platforms/odc/facade/' + posix(path.relative(here, file)) : path.basename(file);

function build(o) {
  let sourceBytes, limitBytes, src, lim;
  try { sourceBytes = o.readFile(o.sourcePath); src = JSON.parse(String(sourceBytes)); limitBytes = o.readFile(o.limitsPath); lim = JSON.parse(String(limitBytes)); }
  catch { return { ok: false, error: 'debug_matrix_source_unreadable' }; }
  const sv = validateSource(src); if (!sv.ok) return { ok: false, error: 'debug_matrix_source_invalid', errors: sv.errors };
  const lv = validateLimits(lim); if (!lv.ok && o.strictLimits) return { ok: false, error: 'debug_matrix_limits_invalid', errors: lv.errors };
  const ctx = { base: o.base, readFile: o.readFile }, reader = installedReader(o.readFile), installed = (lane, name) => reader(o.studioDirs[lane], name);
  const limits = verifyLimits(lim, ctx, installed);
  const typeCoverage = auditTypeCoverage({ root: o.root, audits: src.typeAudits, typeLimits: src.typeLimits, refusals: src.typeRefusals ?? [], limits, readFile: o.readFile });
  // Registry evidence: the seed index plus manifest pins carrying an evidenceKey; only verified entries count.
  const index = {};
  for (const [k, v] of Object.entries(o.seedEvidence)) if (verifyPin(v, ctx).ok) index[k] = v;
  for (const r of src.requirements) for (const lane of LANES) for (const s of r.lanes[lane].subCriteria) for (const p of s.pins)
    if (p.evidenceKey) { const v = check(p, ctx);
      if (v.ok && v.transportAttested) index[p.evidenceKey] = { lane, transport: p.transport, path: p.path, sha256: p.sha256, live: v.live }; else delete index[p.evidenceKey]; }
  const adapters = Object.fromEntries(LANES.map(lane => [lane, qualificationRows(lane, undefined, index).map(r => {
    if (r.interactive !== 'native-limit') return r;
    const l = Object.values(limits).find(x => x.lane === lane && x.refusalCode && x.refusalCode === r.refusalCode);
    return { ...r, limit: l ? { id: l.id, status: l.status } : null };
  })]));
  const inv = o.inventory();
  const inventory = { schema: inv.schema ?? null, root: inv.root ?? '.local/debugger', counts: inv.counts ?? null, classes: inv.classes ?? {},
    blockedBindings: inv.blockedBindings ?? [], locks: inv.locks ?? [] };
  const t = tree(o.root, o.readFile), { _newest, ...treeOut } = t;
  const fingerprint = { tree: treeOut, workerBuilds: workerBuilds(o.base, o.readFile),
    installed: src.fingerprint.installed.map(i => ({ lane: i.lane, name: i.name, ...installed(i.lane, i.name) })),
    odc: odcFingerprint(src.fingerprint.odc, ctx, installed), testReports: testReports(o.base, _newest, o.readFile) };
  const full = { ...ctx, limits, typeCoverage, adapters, inventory };
  const requirements = src.requirements.map(r => ({ id: r.id, title: r.title, lanes: Object.fromEntries(LANES.map(lane => {
    const subs = r.lanes[lane].subCriteria.map(s => evaluate(s, lane, full));
    return [lane, { status: null, subCriteria: subs }];
  })) }));
  const settle = (r, lane) => { const subs = r.lanes[lane].subCriteria; r.lanes[lane].status = worst(subs.map(s => ['native-limit', 'excluded'].includes(s.status) ? 'closed' : s.status)); };
  for (const r of requirements) for (const lane of LANES) if (!r.lanes[lane].subCriteria.some(s => s.kind === 'matrix-integrity')) settle(r, lane);
  for (const r of requirements) for (const lane of LANES) {
    const subs = r.lanes[lane].subCriteria.filter(s => s.kind === 'matrix-integrity');
    if (!subs.length) continue;
    r.lanes[lane].status = 'open'; // provisional for its own exclusion
    for (const s of subs) integrity(s, lane, requirements, r.id, fingerprint);
    settle(r, lane);
  }
  const summary = Object.fromEntries(LANES.map(lane => { const n = { closed: 0, partial: 0, open: 0 };
    for (const r of requirements) n[r.lanes[lane].status]++; return [lane, n]; }));
  const body = { schema: MATRIX_SCHEMA, readOnly: true, rule: 'closed: verified live:true MCP and CLI pins (file sha256 + predicates) whose files attest their surface, or a documented native limit/excluded scope with evidence; partial: one attested transport or a manifest-only transport; open: missing, changed, synthetic, failing or surface-contradicting pin, no live pin, or no evidence',
    source: { path: display(o, o.sourcePath), sha256: sha(sourceBytes) }, limitsSource: { path: display(o, o.limitsPath), sha256: sha(limitBytes) },
    fingerprint, summary, requirements, nativeLimits: Object.values(limits), typeCoverage, adapters, lockInventory: inventory };
  return { ok: true, body, git: gitHead(o.root, o.readFile) };
}

// ---- Markdown --------------------------------------------------------------------------------------------
const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const short = h => h ? h.slice(0, 12) + '…' : '-';
export function renderMarkdown(body, sha256) {
  const fp = body.fingerprint, L = [];
  L.push('# Matriz final do debugger headless O11/ODC (gerada)', '',
    '<!-- Gerado por platforms/odc/facade/debug-final-matrix.mjs (`ssam debug matrix`). Não editar à mão. -->', '',
    `- sha256 da matriz (JSON canônico, sem os campos de hash): \`${sha256}\``,
    `- Manifesto: \`${body.source.path}\` sha256 \`${body.source.sha256}\``,
    `- Limites nativos: \`${body.limitsSource.path}\` sha256 \`${body.limitsSource.sha256}\``,
    `- Árvore (${fp.tree.count} arquivos: facade debug*.mjs e kernel/debug/**): sha256 \`${fp.tree.sha256}\``);
  for (const k of ['node', 'dotnet']) { const r = fp.testReports[k];
    L.push(`- Relatório de testes ${k}: ` + (r ? `\`${r.path}\` sha256 \`${r.sha256}\`, ${r.passed ?? '?'} ok / ${r.failed ?? '?'} falhas, ${r.mtime}${r.stale ? ', **desatualizado (anterior à árvore)**' : ''}` : 'ausente')); }
  for (const lane of LANES) { const w = fp.workerBuilds[lane];
    L.push(`- Worker ${lane}: ` + (w ? `build \`${w.key}\`, SSAM.Debugger.dll sha256 \`${w.dllSha256 ?? '-'}\`, ${w.mtime} (${w.builds} builds)` : 'sem recibo de build')); }
  if (fp.odc) L.push(`- ODC: stage \`${fp.odc.stageKey}\`, ODC Studio ${fp.odc.studioVersion ?? 'não lido'}` +
    (fp.odc.fixture?.ok ? `, fixture ${fp.odc.fixture.module} r${fp.odc.fixture.revision} (stage ${fp.odc.fixture.stageMatches ? 'confere' : '**diverge**'})` : ', fixture não verificada') +
    (fp.odc.snapshot?.ok ? `, snapshot fonte \`${fp.odc.snapshot.sourceSha256}\`` : ''));
  if (fp.installed.length) { L.push('', '| Lane | Binário instalado | Versão | sha256 |', '|---|---|---|---|');
    for (const i of fp.installed) L.push(`| ${i.lane} | ${cell(i.name)} | ${i.found ? cell(i.fileVersion) : 'não encontrado'} | ${i.sha256 ? '`' + i.sha256 + '`' : '-'} |`); }
  L.push('', 'Regra: ' + body.rule + '.', '', '## Resumo', '', '| Requisito | O11 | ODC |', '|---|---|---|');
  for (const r of body.requirements) L.push(`| ${r.id}. ${cell(r.title)} | ${r.lanes.o11.status} | ${r.lanes.odc.status} |`);
  L.push(`| Total | ${LANES.map(l => Object.entries(body.summary[l]).map(([k, v]) => k + ' ' + v).join(', ')).join(' | ')} |`, '', '## Detalhe por requisito');
  for (const r of body.requirements) {
    L.push('', `### ${r.id}. ${r.title}`);
    for (const lane of LANES) {
      L.push('', `**${lane.toUpperCase()}: ${r.lanes[lane].status}**`, '');
      for (const s of r.lanes[lane].subCriteria) {
        L.push(`- \`${s.id}\` ${s.status} (${s.kind}): ${s.text}`);
        for (const p of s.pins) L.push(`  - ${p.transport ?? '-'} \`${p.path}\` sha256 \`${short(p.sha256)}\` ${p.ok ? 'verificado' : '**' + p.reason + '**'}` +
          (p.ok && p.transport && !p.transportAttested ? ', superfície não atestada pelo arquivo' : '') + (p.transport && !p.live ? ', não viva (histórica)' : '') +
          (p.operationId ? `, operação \`${p.operationId}\`` : '') + (p.sessionId ? `, sessão \`${p.sessionId}\`` : '') +
          (p.failed?.length ? `, predicados falhos ${p.failed.map(x => '`' + x + '`').join(' ')}` : '') +
          (p.profile ? `, perfil ${p.profile.name} ${p.profile.ok ? 'ok' : 'falhou (' + p.profile.failed.join(', ') + ')'}` +
            (p.profile.limits?.length ? `; limites ${p.profile.limits.join(', ')}` : '') + (p.profile.flags?.length ? `; sinalizado ${p.profile.flags.join(', ')}` : '') : ''));
        if (s.nativeLimits.length) L.push(`  - limites nativos: ${s.nativeLimits.map(l => '`' + l.id + '` ' + l.status).join('; ')}`);
        if (s.reasons.length) L.push(`  - motivos: ${s.reasons.map(x => '`' + x + '`').join(' ')}`);
      }
    }
  }
  L.push('', '## Limites nativos', '', '| Id | Lane | Status | Assembly / fonte | Tipo.membro | Evidência |', '|---|---|---|---|---|---|');
  for (const l of body.nativeLimits) L.push(`| \`${l.id}\` | ${l.lane} | ${l.status} | ${l.assembly ? cell(l.assembly.name + ' ' + l.assembly.fileVersion) + ' `' + short(l.assembly.sha256) + '`' +
    (l.installed ? (l.installed.found ? (l.installed.matches ? ' (instalado confere)' : ' (**instalado diverge**)') : ' (instalação não lida)') : '') : cell(l.url)} | ${cell(l.type ? l.type + '.' + l.member : '-')} | ` +
    `${l.evidence.map(e => '`' + e.path + '` ' + (e.ok ? 'ok' : e.reason)).join('; ') || '-'} |`);
  L.push('', '## Cobertura por tipo (input/local/output/return)', '', '| Tipo | O11 client | O11 server | ODC client | ODC server |', '|---|---|---|---|---|');
  const types = [...new Set(body.typeCoverage.cells.map(c => c.type))];
  for (const type of types) L.push(`| ${type} | ` + LANES.flatMap(lane => ['client', 'server'].map(rt => body.typeCoverage.cells.filter(c => c.lane === lane && c.runtime === rt && c.type === type)
    .map(c => c.role[0] + ':' + ({ closed: 'C', partial: 'P', open: 'o', 'native-limit': 'L', refused: 'R' })[c.status]).join(' '))).join(' | ') + ' |');
  L.push('', 'C = MCP e CLI vivos verificados e atestados pelo arquivo; P = uma superfície ou superfície não atestada; L = limite nativo com evidência; R = recusado pelo SDK com evidência; o = aberto.', '',
    '## Adaptadores (debug-adapter-registry)', '', '| Lane | Adaptador | Runtime | Interativo | Status | Evidência |', '|---|---|---|---|---|---|');
  for (const lane of LANES) for (const a of body.adapters[lane]) L.push(`| ${lane} | ${cell(a.label)} | ${a.runtime} | ${a.interactive} | ${a.status}${a.limit ? ' (' + a.limit.id + ' ' + a.limit.status + ')' : ''} | ` +
    `${a.evidence.map(e => e.transport + ' `' + e.path + '`').join('; ') || '-'} |`);
  const inv = body.lockInventory;
  L.push('', '## Inventário de locks', '', `Total ${inv.locks.length}; por classe: ${Object.entries(inv.counts?.byClass ?? {}).sort().map(([k, v]) => k + ' ' + v).join(', ') || '-'}.`, '',
    '| Lane | Módulo | Operação | Binding | Fontes |', '|---|---|---|---|---|');
  for (const b of inv.blockedBindings) L.push(`| ${b.lane} | ${cell(b.module ?? '-')} | ${cell(b.operationId ?? '-')} | \`${short(b.bindingHash)}\` | ${cell((b.sources ?? []).join(', '))} |`);
  return L.join('\n') + '\n';
}

// ---- generate / check / surfaces ---------------------------------------------------------------------------
export function generate(options = {}) {
  const o = resolve(options);
  // Only under .local/debugger: never into the hashed tree (kernel/debug/**, facade debug*.mjs) or anywhere else.
  if (!inside(o.base, o.outDir)) throw new Error('debug_matrix_out_dir_outside_local_debugger');
  const built = build(o); if (!built.ok) return built;
  const sha256 = sha(JSON.stringify(built.body)), markdown = renderMarkdown(built.body, sha256), markdownSha256 = sha(markdown);
  const matrix = { ...built.body, sha256, markdownSha256 }, json = JSON.stringify(matrix, null, 1) + '\n';
  const files = { matrix: posix(path.relative(o.root, path.join(o.outDir, 'matrix.json'))), markdown: posix(path.relative(o.root, path.join(o.outDir, 'matrix.md'))) };
  if (o.write) {
    fs.mkdirSync(o.outDir, { recursive: true });
    for (const [name, text] of [['matrix.json', json], ['matrix.md', markdown]]) {
      const target = path.join(o.outDir, name), temporary = target + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, text); fs.renameSync(temporary, target);
    }
    // The tracked document is written only when asked (live/integration step), never by default.
    if (o.writeDoc) fs.writeFileSync(path.join(o.root, ...DOC.split('/')), markdown);
  }
  return { ok: true, schema: MATRIX_SCHEMA, sha256, markdownSha256, json, markdown, matrix, files, summary: matrix.summary, git: built.git };
}
export function checkMatrix(options = {}) {
  const o = resolve({ ...options, write: false, writeDoc: false });
  const built = generate({ ...options, write: false, writeDoc: false });
  if (!built.ok) return { ok: false, op: 'check', error: built.error, errors: built.errors ?? [] };
  const drift = [], rel = file => posix(path.relative(o.root, file));
  const compare = (file, text, optional) => { let current; try { current = fs.readFileSync(file, 'utf8'); } catch { if (!optional) drift.push({ file: rel(file), reason: 'missing' }); return; }
    if (current !== text) drift.push({ file: rel(file), reason: 'changed' }); };
  compare(path.join(o.outDir, 'matrix.json'), built.json); compare(path.join(o.outDir, 'matrix.md'), built.markdown);
  // Once any pointer doc exists the generated doc is required, and every present pointer doc must carry the marker.
  const pointerDocs = POINTER_DOCS.map(doc => { try { return [doc, fs.readFileSync(path.join(o.root, ...doc.split('/')), 'utf8')]; } catch { return null; } }).filter(Boolean);
  compare(path.join(o.root, ...DOC.split('/')), built.markdown, !pointerDocs.length);
  for (const [doc, text] of pointerDocs) {
    const pins = [...text.matchAll(MARKER_RE)].map(m => m[1]);
    if (!pins.length) drift.push({ file: doc, reason: 'pointer-missing' });
    else if (pins.some(h => h !== built.markdownSha256)) drift.push({ file: doc, reason: 'stale-pointer' });
  }
  return { ok: drift.length === 0, op: 'check', schema: MATRIX_SCHEMA, sha256: built.sha256, markdownSha256: built.markdownSha256, drift, files: built.files, summary: built.summary, git: built.git };
}
export function docPointer(result) {
  if (!HEX64.test(result?.markdownSha256 ?? '') || !HEX64.test(result?.sha256 ?? '')) throw new Error('debug_matrix_pointer_result_invalid');
  return `<!-- ${MARKER}${result.markdownSha256} -->\nFinal matrix generated: [DEBUGGER-MATRIZ-FINAL.md](DEBUGGER-MATRIZ-FINAL.md), sha256 \`${result.markdownSha256}\` ` +
    `(JSON matrix \`${result.sha256}\`, \`.local/debugger/final-matrix/matrix.json\`). Regenerate with \`ssam debug matrix\`; \`ssam debug matrix --check\` exits with an error on any divergence.`;
}

export const matrixToolSchema = z.object({ op: z.enum(['generate', 'check']).optional() }).strict();
// Shared by the MCP tool and the CLI: same input, same files, same answer.
export async function debugMatrix(input = {}, options = {}) {
  for (const k of Object.keys(input ?? {})) if (k !== 'op') throw new Error('debug_matrix_field_invalid:' + k);
  const op = input?.op ?? 'generate';
  if (op === 'check') return checkMatrix(options);
  if (op !== 'generate') throw new Error('debug_matrix_op_invalid');
  const r = generate(options);
  if (!r.ok) return { ok: false, op, error: r.error, errors: r.errors ?? [] };
  const result = { ok: true, op, schema: r.schema, sha256: r.sha256, markdownSha256: r.markdownSha256, files: r.files, summary: r.summary, git: r.git };
  return { ...result, pointer: docPointer(result) };
}
export function parseMatrixCli(args) {
  if (args?.[0] !== 'matrix' || args.length > 2 || (args.length === 2 && args[1] !== '--check')) throw new Error('Usage: ssam debug matrix [--check]');
  return { op: args[1] === '--check' ? 'check' : 'generate' };
}
export async function runMatrixCli(args, { stdout = text => process.stdout.write(text), ...options } = {}) {
  const result = await debugMatrix(parseMatrixCli(args), options);
  stdout(JSON.stringify(result));
  return { exitCode: result.ok ? 0 : 1, result };
}
export function registerMatrixTool(server, execute, wrap) {
  server.registerTool('ssam_debug_matrix', {
    title: 'Generate or check the final debugger matrix',
    description: 'Read-only R19 matrix of the headless O11/ODC debugger, generated from the tracked manifest platforms/odc/facade/debug-matrix/matrix-source.json and native-limits.json. ' +
      'Every evidence pin is re-verified offline (file sha256 under .local/debugger, JSON-pointer predicates, ODC run/mount/role/settings profiles); a missing, changed or synthetic pin turns its cell open, one transport is partial, closed needs live MCP and CLI proofs or a documented native limit/excluded scope with evidence. ' +
      'Embeds adapter coverage (debug-adapter-registry), the lock inventory with blockedBindings, per-type coverage, tree hash, worker build receipts, installed Studio/DLL versions and the latest full test reports; git HEAD is reported beside the matrix, never hashed. ' +
      'op generate (default) writes only .local/debugger/final-matrix/matrix.json and matrix.md (derived output, no evidence, model or tenant change) and returns their sha256 and the doc pointer; op check writes nothing and reports drift (CLI: ssam debug matrix [--check], exit 1 on drift). ' +
      'Never opens DPAPI/vault records, never copies authorization words or setting values, never contacts a tenant.',
    inputSchema: matrixToolSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(execute));
}
