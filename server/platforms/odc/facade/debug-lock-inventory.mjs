// Public read-only inventory of debugger mutexes (req 18): every .local/debugger/**/*.lock with its sha256,
// owner fields, the public receipts it was classified from (with sha256), a class, a reason and the
// reconciler that may archive it, plus the bindings refused today. It never writes, renames, deletes or
// acquires a lock, never opens a DPAPI/vault record (only *.lock and *.json are read), never checks or
// starts a process and never contacts a tenant. Candidates are only evidence classes: the named public
// reconciler re-verifies process, lease and pins before it archives the mutex by rename.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { BLOCKED_BINDINGS, bindingHash, blockedBinding } from './debug-o11-native-run.mjs';
import { cleanupRecordStatus } from './debug-odc-native-evidence.mjs';
import { retainedLock, classifyBackgroundReceipt } from './debug-retained-locks.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HEX64 = /^[a-f0-9]{64}$/, PLACEHOLDER = /^(?:d{64}|e{64})$/, SECRET = /token|secret|password|credential|bearer|cookie|authorization/i;
const posix = value => value.split(path.sep).join('/');
// Fixed historical operations (operationId or debugger sessionId prefixes), including the Quotes runs of two client apps.
export const NAMED_HISTORICAL = Object.freeze(['7c8e6cea', '40448a18', '9efecfdc', '4c7016f0', '4a7ce9f9', '34631630', '62cd7677', '10f00e0f',
  'a67c19f1', '60aa32e5', '49d23354', 'dabb6842', '49954464', 'd16668ff']);
export const LOCK_CLASSES = Object.freeze({
  'retained-by-decision': 'kept by user decision (debug-retained-locks.mjs); every archive, reconcile and neutralization refuses it',
  'archived-reconciled': 'mutex archived by a public reconciler (reconciled-* or *.reconciled.lock); originals preserved',
  'retained-unanswered-submission': 'a business request was submitted without an observed response; never replayed',
  'retained-named-historical': 'fixed named historical operation; kept with its reason',
  'retained-insufficient-evidence': 'public evidence is not enough for any reconciler; the missing evidence is listed',
  'candidate-<reconciler>': 'evidence matches the class of that public reconciler, which re-verifies before archiving by rename',
  'inert-delivery-lease': 'delivery run.lock next to a terminal result.json',
  'inert-synthetic': 'placeholder hash d{64}/e{64} under a synthetic-* path',
  'inert-legacy-harness': 'proofs/odc-client-server-host lock with actionSubmitted:false or a terminal receipt',
});
// Reconciler -> module. Availability is read from the facade, so planned reconcilers report false until they exist.
const RECONCILERS = Object.freeze({ 'o11-answered': 'debug-o11-answered-reconcile.mjs', 'o11-login-refusal': 'debug-o11-login-reconcile.mjs',
  'odc-producer-preflight': 'debug-odc-native-preflight-reconcile.mjs', 'o11-client-aborted': 'debug-o11-client-aborted-reconcile.mjs',
  'odc-client-aborted': 'debug-odc-client-aborted-reconcile.mjs', 'odc-zero-request-start-uncertain': 'debug-odc-not-started-reconcile.mjs' });
const ARCHIVES = Object.freeze({ 'reconciled-answered.lock': 'o11-answered', 'reconciled-login-refusal.lock': 'o11-login-refusal',
  'reconciled-static-read.lock': 'odc-producer-preflight', 'reconciled-local-prestart.lock': 'o11-local-prestart',
  'consumer-request-lock.reconciled.lock': 'odc-consumer-request' });
const PENDING_CHECKS = Object.freeze(['lock owner process absent', 'native worker and owned browser absent (CIM)', 'app-user lease absent in every store',
  'private inspection records removed in every store', 'pinned evidence unchanged at reconcile time']);
const available = name => { try { return fs.existsSync(new URL('./' + RECONCILERS[name], import.meta.url)); } catch { return false; } };

function reader(base) {
  const inside = file => { const relative = path.relative(base, path.resolve(file)); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
  return {
    inside,
    // JSON receipts only, confined to .local/debugger; the hash covers the exact bytes read.
    json(file) {
      if (!inside(file) || !/\.json$/i.test(file)) return null;
      let bytes; try { bytes = fs.readFileSync(file); } catch { return null; }
      let value = null; try { value = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { /* hashed, unparsed */ }
      return { value, receipt: { path: posix(path.relative(base, file)), sha256: sha(bytes) } };
    },
    exists: file => inside(file) && fs.existsSync(file),
    list(dir) { try { return inside(dir) || path.resolve(dir) === base ? fs.readdirSync(dir) : []; } catch { return []; } },
  };
}
function owner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value === null ? null : {};
  return Object.fromEntries(Object.entries(value).filter(([key, v]) => !['receiptPath', 'runDirectory'].includes(key) && !SECRET.test(key) &&
    (v === null || ['string', 'number', 'boolean'].includes(typeof v))));
}
const laneOfPath = rel => {
  const parts = rel.split('/');
  if (parts[0] === 'native-runs') return parts[1] === 'o11' ? 'o11' : 'odc';
  if (['native-background-bindings', 'native-endpoint-bindings'].includes(parts[0])) return 'odc';
  const hit = parts.find(p => /(?:^|-)(?:o11|odc)(?:-|$)/.test(p));
  return hit ? (/(?:^|-)o11(?:-|$)/.test(hit) ? 'o11' : 'odc') : null;
};
const named = ids => ids.filter(Boolean).map(id => String(id).replace(/-/g, '').slice(0, 8)).find(id => NAMED_HISTORICAL.includes(id)) ?? null;

// ---- evidence classes -------------------------------------------------------------------------------------
function o11Run(r, base, host, operationId) {
  const dir = path.join(base, 'native-runs', 'o11', host, operationId), receipts = [];
  const take = file => { const hit = r.json(file); if (hit) receipts.push(hit.receipt); return hit?.value ?? null; };
  const report = take(path.join(dir, 'receipt.json'));
  if (!report) return { receipts, report: null };
  const worker = take(path.join(dir, 'native-entry-receipt.json')), files = r.list(dir);
  const nativeId = worker?.sessionId ?? report.serverTrace?.sessionId ?? null;
  const native = report.serverTrace?.sessionId ? take(path.join(base, report.serverTrace.sessionId, 'receipt.json')) : null;
  return { receipts, report, worker, posts: files.filter(f => f.includes('.post-')).length,
    nativeDir: !!nativeId && r.exists(path.join(base, nativeId)), native };
}
function o11Class({ report, worker, posts, nativeDir, native }) {
  const w = report.worker ?? {};
  if (report.state === 'failed-or-uncertain' && !report.serverTrace && !report.appUserAuthenticated && report.results?.length === 0 &&
      report.credentialsReleased === true && w.submitted === 0 && w.answered === 0 && w.loginUncertain === false && w.requestUncertain === false &&
      worker?.diagnostics?.phase === 'original-login' && worker.diagnostics.errorType === 'InvalidLoginException' &&
      worker.loginSubmittedCount === 1 && worker.loginAnsweredCount === 1 && worker.requestSubmittedCount === 0 && worker.requestAnsweredCount === 0 &&
      worker.requestUncertain === false && worker.memoryCleared === true && posts === 0 && !nativeDir) return { reconciler: 'o11-login-refusal' };
  if (report.entryAbi?.kind === 'client-action' && !(report.entryAbi.endpoints?.length) && !report.entryAbi.endpoint && !report.serverTrace &&
      worker?.requestSubmittedCount === 0 && worker.requestUncertain === false && (w.submitted ?? 0) === 0 && w.requestUncertain !== true &&
      posts === 0 && !nativeDir) return { reconciler: 'o11-client-aborted' };
  const missing = [], submitted = worker?.requestSubmittedCount ?? w.submitted ?? 0, answered = worker?.requestAnsweredCount ?? w.answered ?? 0;
  const unanswered = submitted > answered || worker?.requestUncertain === true || w.requestUncertain === true || posts > answered;
  if (unanswered) missing.push('response of the submitted business request');
  // Background runs read through the kind alias table (a historical Timer wake is never re-labelled a BPT launch).
  const error = classifyBackgroundReceipt(report).canonicalError;
  if (typeof error === 'string' && /uncertain/.test(error)) missing.push('outcome of ' + error);
  if (report.serverTrace?.sessionId && native?.state !== 'stopped') missing.push('confirmed native debugger stop');
  if (worker && worker.memoryCleared !== true) missing.push('worker memory cleanup');
  return { unanswered, missing };
}
function odcRun(r, base, operationId) {
  const dir = path.join(base, 'native-runs', 'odc', operationId), hit = r.json(path.join(dir, 'receipt.json'));
  if (!hit?.value) return { receipts: hit ? [hit.receipt] : [], report: null };
  const cleanup = cleanupRecordStatus(dir);
  return { receipts: [hit.receipt], report: hit.value, cleanup: cleanup.ok ? cleanup : null,
    sessionDir: !!hit.value.sessionId && r.exists(path.join(base, hit.value.sessionId)) };
}
const COUNTERS = ['networkRequests', 'executeRequestSubmissions', 'negotiations', 'socketConnections', 'longPollingConnections', 'longPollingSendRequests'];
function odcClass({ report, cleanup, sessionDir }) {
  const t = report.cleanup?.receipt?.transport, quiet = !t || (t.uncertain !== true && (t.probes ?? []).length === 0 && COUNTERS.every(n => (t[n] ?? 0) === 0));
  const idle = report.results?.length === 0 && (report.requestEvidence?.length ?? 0) === 0 && (report.pendingRequests ?? 0) === 0 && report.credentialsReleased === true;
  const st = report.serverTrace;
  if (idle && t && quiet && COUNTERS.every(n => t[n] === 0) && report.cleanup?.completed === true && report.cleanup.receipt?.cleanupConfirmed === true &&
      st?.state === 'stop-uncertain' && st.transport?.startPhase === 'rest-start' && st.transport?.stopPhase === 'no-session-token' &&
      st.transport?.tokenObtained === false) return { reconciler: 'odc-zero-request-start-uncertain' };
  if (idle && quiet && report.error === 'debug_odc_native_worker_lost' && report.entry?.entryKind === 'client-action' && !st?.sessionId && !sessionDir)
    return { reconciler: 'odc-client-aborted' };
  const missing = [], submissions = t?.executeRequestSubmissions ?? 0;
  const unanswered = (report.pendingRequests ?? 0) > 0 || submissions > 0 && (t?.uncertain === true || (report.results ?? []).some(x => x?.uncertain === true));
  if (unanswered) missing.push('response of the submitted business request');
  if (cleanup && !cleanup.cleanupConfirmed) missing.push(cleanup.retryForbidden ? 'channel cleanup acceptance (sealed cleanup-accepted record); retry forbidden'
    : 'channel cleanup attempt record');
  if (st?.state === 'start-outcome-unknown') missing.push('native debugger start outcome');
  else if (st?.sessionId && st.stopped !== true && st.state !== 'stopped') missing.push('confirmed native debugger stop');
  if (typeof report.error === 'string' && report.error) missing.push('outcome of ' + report.error);
  return { unanswered, missing };
}
const cleanupText = cleanup => cleanup && cleanup.probes.length ? '; ' + cleanup.summary +
  cleanup.probes.filter(p => p.record).map(p => ' (' + (cleanup.probes.length > 1 ? p.probeId + ' ' : '') + p.record.stage + ' record sha256 ' + p.record.sha256 + ')').join('') : '';

function terminalDelivery(result) {
  return !!result && (result.stage === 'complete' && ['applied', 'unchanged'].includes(result.writeState) ||
    result.writeState === 'not-sent' && typeof result.error === 'string' && !!result.error);
}
function terminalHarness(receipt) {
  return !!receipt && receipt.actionUncertain === false && (receipt.actionSubmitted === false || receipt.phase === 'completed' && receipt.ok === true);
}

// ---- inventory --------------------------------------------------------------------------------------------
export function lockInventory({ root = workspaceRoot } = {}) {
  const base = path.resolve(root, '.local', 'debugger'), r = reader(base);
  let entries = [];
  try { entries = fs.readdirSync(base, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.lock')); } catch { entries = []; }
  const records = entries.map(e => {
    const file = path.join(e.parentPath ?? e.path, e.name), rel = posix(path.relative(base, file)), bytes = fs.readFileSync(file);
    let value = null; const text = bytes.toString('utf8').replace(/^﻿/, '').trim();
    if (text) { try { value = JSON.parse(text); } catch { value = undefined; } }
    return { file, rel, name: e.name, sha256: sha(bytes), value };
  });
  const runs = new Map(); // ODC debugger sessionId -> classified binding-lock run (for runtime target locks)
  const out = [], pending = [];
  for (const rec of records) {
    const lane = laneOfPath(rec.rel), v = rec.value && typeof rec.value === 'object' ? rec.value : {}, parts = rec.rel.split('/');
    const lock = { path: rec.rel, sha256: rec.sha256, lane: lane ?? 'unknown', kind: 'other', owner: owner(rec.value === undefined ? null : rec.value ?? {}),
      operationId: v.operationId ?? null, sessionId: v.sessionId ?? null, receipts: [], class: null, reason: null, reconciler: null,
      reconcilerAvailable: false, missingEvidence: [] };
    const set = (klass, reason, extra = {}) => Object.assign(lock, { class: klass, reason }, extra);
    if (rec.value === undefined) lock.missingEvidence.push('readable lock owner');
    if (rec.name.startsWith('reconciled-') || rec.name.endsWith('.reconciled.lock')) {
      lock.kind = 'archive';
      const dir = path.dirname(rec.file);
      for (const name of r.list(dir).filter(n => n.endsWith('-reconciliation.json')).sort()) { const hit = r.json(path.join(dir, name)); if (hit) lock.receipts.push(hit.receipt); }
      const schema = lock.receipts.length ? r.json(path.join(base, lock.receipts[0].path))?.value?.schema : null;
      const reconciler = ARCHIVES[rec.name] ?? (rec.name === 'reconciled-client-aborted.lock' && lane ? lane + '-client-aborted' : null) ??
        /^ssam-(.+)-reconciliation\/\d+$/.exec(schema ?? '')?.[1] ?? null;
      set('archived-reconciled', 'mutex archived' + (reconciler ? ' by ' + reconciler : '') + (lock.receipts.length ? '; reconciliation receipt preserved'
        : '; archived by name, no reconciliation receipt in the run directory'), { reconciler, reconcilerAvailable: !!reconciler && available(reconciler) });
    } else if (rec.name === 'run.lock') {
      lock.kind = 'delivery-lease';
      const hit = r.json(path.join(path.dirname(rec.file), 'result.json')); if (hit) lock.receipts.push(hit.receipt);
      if (terminalDelivery(hit?.value)) set('inert-delivery-lease', `delivery run lease next to a terminal result.json (stage ${hit.value.stage}, writeState ${hit.value.writeState})`);
      else { lock.missingEvidence.push('terminal delivery result'); set('retained-insufficient-evidence', 'delivery run lease without a terminal result.json'); }
    } else if (parts.some(p => p.startsWith('synthetic-')) && Object.values(v).some(x => typeof x === 'string' && PLACEHOLDER.test(x))) {
      lock.kind = 'operator'; set('inert-synthetic', 'synthetic fixture: placeholder hash under a synthetic-* path');
    } else if (rec.rel.startsWith('proofs/odc-client-server-host/')) {
      lock.kind = 'harness';
      const target = typeof v.receiptPath === 'string' ? v.receiptPath : typeof v.runDirectory === 'string' ? path.join(v.runDirectory, 'receipt.json') : null;
      const hit = target ? r.json(path.resolve(target)) : null; if (hit) lock.receipts.push(hit.receipt);
      if (v.actionSubmitted === false && v.actionUncertain !== true) set('inert-legacy-harness', 'legacy odc-client-server-host harness lock with actionSubmitted:false');
      else if (terminalHarness(hit?.value)) set('inert-legacy-harness', `legacy odc-client-server-host harness lock with a terminal receipt (phase ${hit.value.phase})`);
      else { lock.missingEvidence.push(target && !hit ? 'harness receipt inside .local/debugger' : 'terminal harness receipt'); set('retained-insufficient-evidence', 'legacy harness lock without terminal evidence'); }
    } else if (parts[0] === 'native-runs' && parts[1] === 'o11' && parts.length === 4 && /^[A-Za-z0-9_+]{22}\.lock$/.test(rec.name)) {
      lock.kind = 'o11-module'; lock.host = parts[2]; lock.moduleKey = rec.name.slice(0, -5);
      pending.push({ lock, set, run: v.operationId ? o11Run(r, base, parts[2], v.operationId) : { receipts: [], report: null } });
    } else if (parts[0] === 'native-runs' && parts.length === 2 && /^[a-f0-9]{64}(?:\.[a-z-]+)?\.lock$/.test(rec.name)) {
      lock.kind = 'odc-binding'; lock.bindingHash = rec.name.slice(0, 64);
      pending.push({ lock, set, run: v.operationId ? odcRun(r, base, v.operationId) : { receipts: [], report: null } });
    } else if (parts.length === 1 && /^[a-f0-9]{64}\.lock$/.test(rec.name)) {
      lock.kind = 'session-target'; lock.bindingHash = rec.name.slice(0, 64);
      pending.push({ lock, set, target: true });
    } else {
      const id = named([v.operationId, v.sessionId]), hit = typeof v.receiptPath === 'string' ? r.json(path.resolve(v.receiptPath)) : null;
      if (hit) lock.receipts.push(hit.receipt);
      if (typeof hit?.value?.phase === 'string' && /uncertain/.test(hit.value.phase)) lock.missingEvidence.push('outcome of receipt phase ' + hit.value.phase);
      const decision = retainedLock({ operationId: v.operationId, lockPath: rec.file });
      if (decision) set('retained-by-decision', decision.reason + ' (operation ' + decision.operationId + ')', { retainedDecision: { ...decision } });
      else if (id) set('retained-named-historical', 'fixed named historical operation ' + id + (v.phase ? ' (phase ' + v.phase + ')' : ''));
      else { lock.missingEvidence.push('public reconciler for this lock kind'); set('retained-insufficient-evidence', 'no public evidence class covers this lock'); }
    }
    out.push(lock);
  }
  // Run-bound mutexes: named first, then reconciler classes, then unanswered submissions, then insufficient evidence.
  const classify = ({ lock, set, run }) => {
    lock.receipts.push(...run.receipts);
    const report = run.report, odc = lock.kind !== 'o11-module';
    if (report && odc) {
      lock.module = report.binding?.module ?? null; lock.moduleKey = report.binding?.moduleKey ?? null; lock.host = report.binding?.tenant ?? null;
      if (run.cleanup) lock.cleanupStatus = run.cleanup;
      const bound = report.binding && sha('odc|' + report.binding.runtimeUrl + '|' + report.binding.moduleKey) === lock.bindingHash;
      if (!bound) lock.missingEvidence.push('run receipt bound to this lock');
      if (report.sessionId) runs.set(report.sessionId, { lock, report });
    } else if (report) lock.module = report.target?.module ?? null;
    const id = named([lock.operationId, lock.sessionId, report?.operationId]);
    const verdict = report ? (odc ? odcClass(run) : o11Class(run)) : null;
    if (report && !odc && report.target?.moduleKey !== lock.moduleKey) lock.missingEvidence.push('run receipt bound to this lock');
    // Classified by receipt.background.kind/schema, never by the error prefix.
    if (report?.background && typeof report.background === 'object') lock.background = classifyBackgroundReceipt(report);
    const decision = retainedLock({ operationId: lock.operationId ?? report?.operationId, host: lock.host, moduleKey: lock.moduleKey, lockPath: path.join(base, lock.path) });
    if (decision) {
      lock.missingEvidence.push(...(verdict?.missing ?? (report ? [] : ['run receipt'])));
      return set('retained-by-decision', decision.reason + ' (operation ' + decision.operationId + '); never archived, reconciled or neutralized',
        { retainedDecision: { ...decision } });
    }
    if (id) {
      lock.missingEvidence.push(...(verdict?.missing ?? (report ? [] : ['run receipt'])));
      return set('retained-named-historical', 'fixed named historical operation ' + id + cleanupText(run.cleanup));
    }
    if (!report) { lock.missingEvidence.push('run receipt'); return set('retained-insufficient-evidence', 'no run receipt for the lock owner'); }
    if (verdict.reconciler && !lock.missingEvidence.length) return set('candidate-' + verdict.reconciler,
      'evidence matches the ' + verdict.reconciler + ' class; the reconciler re-verifies before archiving by rename',
      { reconciler: verdict.reconciler, reconcilerAvailable: available(verdict.reconciler), pendingChecks: [...PENDING_CHECKS] });
    lock.missingEvidence.push(...(verdict.missing ?? []));
    if (verdict.unanswered) return set('retained-unanswered-submission', 'business request submitted without an observed response; never replayed' + cleanupText(run.cleanup));
    if (!lock.missingEvidence.length) lock.missingEvidence.push('public reconciler for this evidence class');
    return set('retained-insufficient-evidence', 'insufficient evidence: ' + lock.missingEvidence.join(', ') + cleanupText(run.cleanup));
  };
  pending.filter(p => !p.target).forEach(classify);
  for (const { lock, set } of pending.filter(p => p.target)) {
    const manifest = r.json(path.join(base, lock.sessionId ?? '-', 'manifest.json')), session = r.json(path.join(base, lock.sessionId ?? '-', 'receipt.json'));
    for (const hit of [manifest, session]) if (hit) lock.receipts.push(hit.receipt);
    const m = manifest?.value ?? {};
    if (['o11', 'odc'].includes(m.lane)) lock.lane = m.lane;
    Object.assign(lock, { host: m.tenant ?? null, module: m.module ?? null, moduleKey: m.moduleKey ?? null });
    let origin = null; try { origin = new URL(m.runtimeUrl).origin; } catch { /* missing manifest */ }
    if (!origin || sha(m.lane + '|' + origin + '|' + m.moduleKey) !== lock.bindingHash) lock.missingEvidence.push('debugger session manifest bound to this lock');
    const run = lock.sessionId ? runs.get(lock.sessionId) : null;
    if (run) { lock.operationId = run.report.operationId; lock.receipts.push(...run.lock.receipts.filter(x => !lock.receipts.some(y => y.path === x.path))); }
    else lock.operationId = records.find(x => x.value?.sessionId === lock.sessionId && x.value?.operationId)?.value.operationId ?? null;
    // A zero-request start-uncertain class is exactly stop-uncertain without a token; elsewhere that state is missing evidence.
    const unstopped = () => { if (session?.value && session.value.state !== 'stopped') lock.missingEvidence.push('confirmed native debugger stop (session state ' + session.value.state + ')'); };
    const id = named([lock.sessionId, lock.operationId]);
    if (id) { unstopped(); if (!run) lock.missingEvidence.push('run receipt referencing this debugger session'); set('retained-named-historical', 'fixed named historical operation ' + id + (run ? ' (debugger session of ' + run.lock.path + ')' : '')); continue; }
    if (!run) { unstopped(); lock.missingEvidence.push('run receipt referencing this debugger session'); set('retained-insufficient-evidence', 'debugger session target lock without a bound run'); continue; }
    const st = session?.value;
    const confirms = st?.state === 'stop-uncertain' && st.transport?.tokenObtained === false && st.transport?.startPhase === 'rest-start';
    if (run.lock.reconciler === 'odc-zero-request-start-uncertain' && !confirms) lock.missingEvidence.push('debugger session receipt proving no session token');
    if (run.lock.class.startsWith('candidate-') && !lock.missingEvidence.length) {
      set(run.lock.class, 'runtime target lock of ' + run.lock.path + '; ' + run.lock.reason,
        { reconciler: run.lock.reconciler, reconcilerAvailable: run.lock.reconcilerAvailable, pendingChecks: [...PENDING_CHECKS] });
    } else {
      if (run.lock.reconciler !== 'odc-zero-request-start-uncertain') unstopped();
      lock.missingEvidence.push(...run.lock.missingEvidence.filter(x => !lock.missingEvidence.includes(x)));
      if (!lock.missingEvidence.length) lock.missingEvidence.push('public reconciler for this evidence class');
      set(run.lock.class.startsWith('candidate-') ? 'retained-insufficient-evidence' : run.lock.class, 'runtime target lock of ' + run.lock.path + '; ' + run.lock.reason);
    }
  }
  out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { ok: true, schema: 'ssam-debugger-lock-inventory/1', readOnly: true, root: '.local/debugger', locks: out,
    blockedBindings: blocked(root, base, r, out), counts: counts(out), classes: LOCK_CLASSES };
}

function blocked(root, base, r, locks) {
  const merged = new Map();
  const add = (lane, host, moduleKey, module, operationId, hash, source, klass) => {
    const key = [lane, moduleKey ? host : 'hash', moduleKey ?? hash].join('|');
    const b = merged.get(key) ?? { lane, host: host ?? null, moduleKey: moduleKey ?? null, module: module ?? null, operationId: operationId ?? null,
      operationIds: [], bindingHash: hash ?? null, sources: [], classes: [] };
    b.module ??= module ?? null; b.operationId ??= operationId ?? null; b.bindingHash ??= hash ?? null;
    if (operationId && !b.operationIds.includes(operationId)) b.operationIds.push(operationId);
    if (!b.sources.includes(source)) b.sources.push(source);
    if (klass && !b.classes.includes(klass)) b.classes.push(klass);
    merged.set(key, b);
  };
  for (const l of locks.filter(l => ['o11-module', 'odc-binding', 'session-target'].includes(l.kind) && !/^(?:archived|inert)-/.test(l.class))) {
    const hash = l.kind === 'o11-module' ? bindingHash(l.host, l.moduleKey) : l.bindingHash;
    add(l.lane, l.host, l.moduleKey, l.module, l.operationId, hash, 'lock:' + l.path, l.class);
  }
  const dir = path.join(base, 'blocked-bindings');
  for (const name of r.list(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort()) {
    const v = r.json(path.join(dir, name))?.value ?? {}, hash = name.slice(0, 64);
    const lane = v.lane ?? (v.host && v.moduleKey && bindingHash(v.host, v.moduleKey) === hash ? 'o11' : 'odc');
    add(lane, v.host ?? v.tenant ?? null, v.moduleKey ?? null, v.module ?? null, v.operationId ?? null, hash, 'registry:blocked-bindings/' + name, null);
  }
  // Code-fixed bindings count only while blockedBinding() still refuses them (no verified neutralization).
  for (const b of BLOCKED_BINDINGS) if (blockedBinding(root, b.host, b.moduleKey)?.source === 'code')
    add('o11', b.host, b.moduleKey, b.module, b.operationId, bindingHash(b.host, b.moduleKey), 'code', null);
  return [...merged.values()].sort((a, b) => [a.lane, a.host ?? '', a.module ?? '', a.moduleKey ?? a.bindingHash ?? ''].join('|')
    .localeCompare([b.lane, b.host ?? '', b.module ?? '', b.moduleKey ?? b.bindingHash ?? ''].join('|')));
}
function counts(locks) {
  const byLane = { o11: 0, odc: 0, unknown: 0 }, byClass = {};
  for (const l of locks) { byLane[l.lane] = (byLane[l.lane] ?? 0) + 1; byClass[l.class] = (byClass[l.class] ?? 0) + 1; }
  return { total: locks.length, byLane, byClass };
}

// ssam_debug_run op 'locks' and CLI `ssam debug locks [--lane o11|odc]`.
export function debugLocks(input, { root = workspaceRoot } = {}) {
  if (input?.op !== 'locks') throw new Error('debug_locks_op_invalid');
  for (const key of Object.keys(input)) if (!['op', 'lane'].includes(key)) throw new Error('debug_locks_field_invalid:' + key);
  if (input.lane !== undefined && !['o11', 'odc'].includes(input.lane)) throw new Error('debug_locks_lane_invalid');
  const inventory = lockInventory({ root });
  if (!input.lane) return inventory;
  const locks = inventory.locks.filter(l => l.lane === input.lane);
  return { ...inventory, lane: input.lane, locks, blockedBindings: inventory.blockedBindings.filter(b => b.lane === input.lane), counts: counts(locks) };
}
export function parseLocksCli(args, lane) {
  if (args?.[0] !== 'locks' || args.length !== 1) throw new Error('Usage: ssam debug locks [--lane o11|odc]');
  return lane ? { op: 'locks', lane } : { op: 'locks' };
}
