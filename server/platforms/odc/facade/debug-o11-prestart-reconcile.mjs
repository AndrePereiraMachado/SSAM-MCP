// Public reconcile of an O11 run confirmed not started (req 18): the server-trace start threw before any worker,
// login, native session token or remote call, as in 36886778. The module mutex is archived by rename only; nothing
// is invoked, replayed or deleted. verifyO11PrestartArchive re-checks an existing archive read only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { debugStoreInventory } from './debug-state-root.mjs';
import { observeO11ClientProcesses } from './debug-o11-client-process-observation.mjs';
import { freshProcessAbsence } from './debug-o11-client-orphan-observation.mjs';
import { assertLockNotRetained } from './debug-retained-locks.mjs';
const SCHEMA = 'ssam-o11-prestart-reconciliation/1', PRIVATE_SCHEMA = 'ssam-o11-local-prestart-reconciliation/1';
const START_ERROR = 'debug_o11_native_server_trace_start_uncertain', CLASS = 'confirmed-not-started';
const WORKER_FILES = ['native-entry-receipt.json', 'native-entry-preparation.json', 'native-entry-process-receipt.json'];
// Native debugger sessions of the same module binding created between the session start and the run receipt.
const SKEW = 5000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const fail = code => { throw new Error('debug_o11_prestart_reconcile_' + code); };
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
const inside = (parent, file) => { const r = path.relative(parent, file); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
// Evidence-only checks shared by reconcile and verify. Each returns [id, passed, failure code, detail].
function prestartChecks(root, report, directory, session, read) {
  const base = path.join(root, '.local/debugger'), server = report?.tracePlan?.server, names = fs.readdirSync(directory), checks = [];
  const add = (id, passed, code, detail) => { checks.push({ id, passed: passed === true, code, ...(detail ? { detail } : {}) }); return passed === true; };
  add('session-matches-run', session?.lane === 'o11' && session.state === 'uncertain' && !session.nativeSessionId &&
    Array.isArray(session.pauses) && session.pauses.length === 0 && same(session.runResult, report), 'run_result_changed');
  add('run-not-started', report?.schema === 'ssam-o11-native-run/1' && report.op === 'run' && report.receiptPath === path.join(directory, 'receipt.json') &&
    Array.isArray(report.results) && report.results.length === 0 && !report.serverTrace && report.worker === undefined &&
    report.uncertain === true && report.lockRetained === true && report.error === START_ERROR && server?.moduleKey === report.target?.moduleKey &&
    Array.isArray(server?.nodeKeys) && report.sourceContract?.path === path.join(directory, path.basename(report.sourceContract?.path ?? '')) &&
    sha(read(report.sourceContract.path, false)) === report.sourceContract.sha256, 'run_evidence_invalid');
  add('no-worker-or-request', !names.some(n => WORKER_FILES.includes(n) || n.endsWith('.login-attempt.json') || n.includes('.post-')), 'worker_observed');
  add('no-credential-acquired', report?.appUserAuthenticated !== true && report?.needs?.contextMode === 'anonymous' &&
    report.needs.appUser === null && !names.some(n => n.endsWith('.login-attempt.json')), 'credential_acquired');
  const lower = Date.parse(session?.createdAt) - SKEW, upper = fs.statSync(path.join(directory, 'receipt.json')).mtimeMs + SKEW, candidates = [];
  let tokenless = Number.isFinite(lower), remoteFree = true;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const manifestFile = path.join(base, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestFile)) continue;
    let manifest; try { manifest = JSON.parse(fs.readFileSync(manifestFile)); } catch { tokenless = false; continue; }
    if (manifest.lane !== 'o11' || manifest.tenant !== report.target?.host || manifest.moduleKey !== server?.moduleKey || manifest.runtimeUrl !== server?.runtimeUrl) continue;
    const stat = fs.statSync(manifestFile), born = stat.birthtimeMs || stat.mtimeMs;
    if (!(born >= lower && born <= upper)) continue;
    candidates.push(entry.name); read(manifestFile);
    const receiptFile = path.join(base, entry.name, 'receipt.json');
    const native = fs.existsSync(receiptFile) ? read(receiptFile) : null;
    if (native?.sessionId !== entry.name || native.state !== 'not-started' || native.ok !== false || native.transport?.tokenObtained === true ||
        native.events?.length || native.processId || native.pauses?.length || typeof manifest.lock !== 'string' || fs.existsSync(manifest.lock)) tokenless = false;
    if (native?.transport !== undefined) remoteFree = false;
  }
  add('no-native-session-token', tokenless, 'native_session_token', 'every native session of this module binding created in the run window is not-started, without token, process or lock');
  add('zero-remote-calls', remoteFree && checks.filter(c => ['run-not-started', 'no-worker-or-request', 'no-native-session-token'].includes(c.id))
    .every(c => c.passed), 'remote_call_observed', 'no worker, no server trace and no native transport phase');
  return { checks, candidates };
}
// Which public reconciler applies to a persisted O11 server session; read only.
export function classifyO11ServerReconcile(root, session) {
  if (session?.nativeSessionId) return 'answered';
  try {
    const report = session?.runResult, host = report?.target?.host;
    if (uuid.test(report?.operationId ?? '') && HOST.test(host ?? '') && report.error === START_ERROR && !report.serverTrace &&
        report.worker === undefined && report.results?.length === 0) {
      const names = fs.readdirSync(path.join(root, '.local/debugger/native-runs/o11', host, report.operationId));
      if (!names.some(n => WORKER_FILES.includes(n) || n.endsWith('.login-attempt.json') || n.includes('.post-'))) return CLASS;
    }
  } catch { /* unclassified evidence falls to the login-refusal reconciler, which refuses it */ }
  return 'login-refusal';
}
// ssam_debug_server reconcile for O11 (debug-server-session.mjs): dispatch by evidence class.
export async function reconcileO11ServerByEvidence(root, session, { answered, loginRefusal, prestart } = {}) {
  const evidenceClass = classifyO11ServerReconcile(root, session);
  if (evidenceClass === 'answered') return (answered ?? (await import('./debug-o11-answered-reconcile.mjs')).reconcileO11Answered)(root, session);
  if (evidenceClass === CLASS) return (prestart ?? reconcileO11Prestart)(root, session);
  return (loginRefusal ?? (await import('./debug-o11-login-reconcile.mjs')).reconcileO11LoginRefusal)(root, session);
}
export async function reconcileO11Prestart(root, session, {
  observeProcesses = observeO11ClientProcesses, isProcessAlive = processAlive,
  vaultRoot, legacyRoots, env = process.env, clock = Date.now,
} = {}) {
  const report = session?.runResult, target = report?.target, operationId = report?.operationId;
  assertLockNotRetained({ action: 'archive', operationId, host: target?.host, moduleKey: target?.moduleKey });
  if (session?.lane !== 'o11' || session.state !== 'uncertain' || session.nativeSessionId || !uuid.test(session.sessionId ?? '') ||
      !uuid.test(operationId ?? '') || !HOST.test(target?.host ?? '') || !/^[A-Za-z0-9_+]{22}$/.test(target?.moduleKey ?? '')) fail('not_eligible');
  const realRoot = fs.realpathSync(root), pins = [];
  const read = (file, json = true) => {
    if (!fs.existsSync(file)) fail('evidence_missing');
    if (!inside(realRoot, fs.realpathSync(file))) fail('path_invalid');
    const bytes = fs.readFileSync(file); pins.push({ path: file, sha256: sha(bytes) }); return json ? JSON.parse(bytes) : bytes;
  };
  if (!same(read(path.join(root, '.local/debugger/server-sessions', session.sessionId + '.json')), session)) fail('session_changed');
  const directory = path.join(root, '.local/debugger/native-runs/o11', target.host, operationId);
  if (fs.existsSync(path.join(directory, 'local-prestart-reconciliation.json'))) fail('archived_privately_use_verify');
  if (!same(read(path.join(directory, 'receipt.json')), report)) fail('run_result_changed');
  const { checks, candidates } = prestartChecks(root, report, directory, session, read);
  for (const c of checks) if (!c.passed) fail(c.code);
  const lock = path.join(path.dirname(directory), target.moduleKey + '.lock');
  const archive = path.join(directory, 'reconciled-prestart.lock'), receiptPath = path.join(directory, 'prestart-reconciliation.json');
  const unchanged = () => { if (pins.some(p => sha(fs.readFileSync(p.path)) !== p.sha256)) fail('evidence_changed'); };
  let receipt = null;
  if (fs.existsSync(receiptPath)) {
    receipt = JSON.parse(fs.readFileSync(receiptPath));
    if (receipt.schema !== SCHEMA || receipt.operationId !== operationId || receipt.sessionId !== session.sessionId ||
        receipt.originalLock !== lock || receipt.archive !== archive || !same(receipt.pins, pins)) fail('reconciliation_changed');
    if (receipt.ok === true && fs.existsSync(archive) && sha(fs.readFileSync(archive)) === receipt.lockSha256) { unchanged(); return receipt; }
  }
  let lockBytes, ownerPid;
  if (fs.existsSync(archive)) { if (!receipt) fail('archive_unbound'); ownerPid = receipt.ownerPid; }
  else {
    if (!fs.existsSync(lock)) fail('mutex_missing');
    lockBytes = fs.readFileSync(lock); const owner = JSON.parse(lockBytes);
    if (owner.operationId !== operationId || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        receipt && (sha(lockBytes) !== receipt.lockSha256 || owner.pid !== receipt.ownerPid)) fail('mutex_owner_changed');
    if (isProcessAlive(owner.pid)) fail('owner_not_stopped');
    ownerPid = owner.pid;
  }
  const criteria = checks.map(({ code, ...c }) => c);
  criteria.push({ id: 'mutex-owner-stopped', passed: true });
  let processEvidence;
  try { processEvidence = await observeProcesses(ownerPid); } catch { processEvidence = { workerStopped: false, source: 'unavailable' }; }
  criteria.push({ id: 'worker-absent-now', passed: freshProcessAbsence(processEvidence, ownerPid, clock()) });
  let leases;
  try { leases = debugStoreInventory('app-user', { env, stateRoot: vaultRoot, legacyRoots }); }
  catch { leases = { stateRoot: vaultRoot ?? null, legacyInventory: [], empty: false, pending: ['store:state'] }; }
  criteria.push({ id: 'app-user-leases-absent', passed: leases.empty === true, ...(leases.empty ? {} : { pending: leases.pending }) });
  unchanged();
  const allCriteriaPassed = criteria.every(c => c.passed);
  const evidence = { schema: SCHEMA, evidenceClass: CLASS, operationId, sessionId: session.sessionId, pins, criteria, allCriteriaPassed,
    nativeCandidates: candidates, originalLock: lock, archive, remoteCalls: 0, businessRequestsSubmitted: 0, nativeWorkerStarted: false,
    nativeDebuggerStarted: false, nativeSessionTokenObtained: false, appUserCredentialsAcquired: false, processEvidence,
    stateRoot: leases.stateRoot, legacyInventory: leases.legacyInventory, executionOutcome: 'not-started', executionComplete: false, replayed: false };
  if (!allCriteriaPassed) {
    const blocked = { ...evidence, ok: false, state: 'prestart-unproved', at: new Date(clock()).toISOString(), mutexArchived: false,
      receiptPath: path.join(directory, 'prestart-reconciliation.blocked-' + Date.now() + '.json') };
    fs.writeFileSync(blocked.receiptPath, JSON.stringify(blocked, null, 2), { flag: 'wx' });
    return blocked;
  }
  if (!receipt) {
    receipt = { ...evidence, state: 'archiving-not-started', at: new Date(clock()).toISOString(), receiptPath, lockSha256: sha(lockBytes), ownerPid };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  }
  unchanged();
  if (!fs.existsSync(archive)) {
    const bytes = fs.readFileSync(lock), owner = JSON.parse(bytes);
    if (sha(bytes) !== receipt.lockSha256 || owner.operationId !== operationId || owner.pid !== receipt.ownerPid || isProcessAlive(owner.pid))
      fail('mutex_owner_changed');
    fs.renameSync(lock, archive);
  }
  if (sha(fs.readFileSync(archive)) !== receipt.lockSha256) fail('archive_changed');
  unchanged();
  receipt = JSON.parse(JSON.stringify({ ...receipt, criteria, processEvidence, stateRoot: leases.stateRoot, legacyInventory: leases.legacyInventory,
    ok: true, state: 'reconciled-not-started', completedAt: new Date(clock()).toISOString(), originalEvidencePreserved: true, mutexArchived: true }));
  fs.writeFileSync(receiptPath + '.tmp', JSON.stringify(receipt, null, 2)); fs.renameSync(receiptPath + '.tmp', receiptPath);
  return receipt;
}
// Read-only re-check of an existing archive (public or the private 36886778 one): no write, no rename, no request.
export async function verifyO11PrestartArchive(root, { host, operationId } = {}, {
  observeProcesses = observeO11ClientProcesses, isProcessAlive = processAlive,
  vaultRoot, legacyRoots, env = process.env, clock = Date.now,
} = {}) {
  assertLockNotRetained({ action: 'reconcile', operationId, host });
  if (!HOST.test(host ?? '') || !uuid.test(operationId ?? '')) fail('not_eligible');
  const base = path.join(root, '.local/debugger'), directory = path.join(base, 'native-runs/o11', host, operationId);
  const files = [path.join(directory, 'prestart-reconciliation.json'), path.join(directory, 'local-prestart-reconciliation.json')];
  const archiveFile = files.find(file => fs.existsSync(file));
  if (!archiveFile) fail('archive_not_found');
  const realRoot = fs.realpathSync(root), archiveBytes = fs.readFileSync(archiveFile), receipt = JSON.parse(archiveBytes), criteria = [];
  const read = (file, json = true) => {
    if (!fs.existsSync(file) || !inside(realRoot, fs.realpathSync(file))) fail('evidence_missing');
    const bytes = fs.readFileSync(file); return json ? JSON.parse(bytes) : bytes;
  };
  const check = (id, fn, extra = {}) => {
    let passed = false, detail;
    try { const value = fn(); passed = value === true; if (typeof value === 'string') detail = value; } catch (error) { detail = error.message; }
    criteria.push({ id, passed, ...(detail ? { detail } : {}), ...extra });
  };
  const isPublic = receipt.schema === SCHEMA;
  let report = null, session = null, candidates = [];
  try { report = read(path.join(directory, 'receipt.json')); } catch { /* reported by the criteria below */ }
  check('archive-receipt', () => (isPublic ? receipt.ok === true && receipt.evidenceClass === CLASS : receipt.schema === PRIVATE_SCHEMA && receipt.classification === CLASS) &&
    receipt.operationId === operationId && receipt.state === 'reconciled-not-started' && receipt.mutexArchived === true &&
    typeof receipt.archive === 'string' && path.dirname(receipt.archive) === directory);
  check('original-evidence-unchanged', () => {
    const pins = isPublic ? receipt.pins.map(p => [p.path, p.sha256]) : Object.values(receipt.originalEvidence ?? {}).map(([rel, hash]) => [path.resolve(base, rel), hash]);
    if (!pins.length) return 'no pinned evidence';
    for (const [file, hash] of pins) if (!inside(base, file) || sha(read(file, false)) !== hash) return 'changed: ' + path.relative(base, file);
    return true;
  });
  check('archive-lock-intact', () => { const bytes = read(receipt.archive, false), owner = JSON.parse(bytes);
    return sha(bytes) === receipt.lockSha256 && owner.operationId === operationId && Number.isSafeInteger(owner.pid) && owner.pid > 0; });
  check('original-lock-released', () => {
    if (receipt.originalLock !== path.join(path.dirname(directory), report?.target?.moduleKey + '.lock')) return 'original lock path does not match the run binding';
    if (!fs.existsSync(receipt.originalLock)) return true;
    return JSON.parse(fs.readFileSync(receipt.originalLock)).operationId !== operationId || 'lock held by the same operation';
  });
  const sessionFile = isPublic ? path.join(base, 'server-sessions', receipt.sessionId + '.json')
    : receipt.originalEvidence?.public?.[0] && path.resolve(base, receipt.originalEvidence.public[0]);
  try { session = read(sessionFile); } catch { /* session-matches-run fails */ }
  try {
    const result = prestartChecks(root, report, directory, session, read); candidates = result.candidates;
    for (const { code, ...c } of result.checks) criteria.push(c);
  } catch (error) { criteria.push({ id: 'run-not-started', passed: false, detail: error.message }); }
  check('native-session-candidate-consistent', () => isPublic ? same(receipt.nativeCandidates, candidates)
    : (!receipt.nativeSessionId || candidates.includes(receipt.nativeSessionId)),
  { inferred: true, note: 'binding inferred from the module binding and the run time window; the operation evidence does not reference the native session' });
  let ownerPid = receipt.ownerPid;
  try { ownerPid = JSON.parse(read(receipt.archive, false)).pid; } catch { /* archive-lock-intact already failed */ }
  let processEvidence;
  try { processEvidence = await observeProcesses(ownerPid); } catch { processEvidence = { workerStopped: false, source: 'unavailable' }; }
  check('worker-absent-now', () => freshProcessAbsence(processEvidence, ownerPid, clock()) && !isProcessAlive(ownerPid));
  let leases;
  try { leases = debugStoreInventory('app-user', { env, stateRoot: vaultRoot, legacyRoots }); } catch { leases = { empty: false, pending: ['store:state'] }; }
  check('app-user-leases-absent', () => leases.empty === true || 'pending ' + leases.pending.join(','));
  return { schema: 'ssam-o11-prestart-archive-verification/1', mode: 'verify', readOnly: true, wrote: false, host, operationId,
    at: new Date(clock()).toISOString(), archiveReceipt: { path: archiveFile, sha256: sha(archiveBytes), schema: receipt.schema },
    evidenceClass: isPublic ? receipt.evidenceClass : receipt.classification, nativeCandidates: candidates, processEvidence,
    criteria, allCriteriaPassed: criteria.every(c => c.passed), archiveClaimedAllCriteriaPassed: receipt.allCriteriaPassed === true,
    replayed: false, executionComplete: false };
}
