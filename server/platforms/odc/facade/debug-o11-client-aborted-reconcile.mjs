// Public reconcile of an O11 client run aborted with zero server submissions (req 18): ddeea880/e4e5e76e/6418f105.
// It archives the module mutex by rename only. Nothing is invoked, replayed, stopped or deleted, and the action
// response is never invented: the interrupted scenario stays 'aborted-unconfirmed'.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { debugStoreInventory } from './debug-state-root.mjs';
import { observeO11ClientProcesses } from './debug-o11-client-process-observation.mjs';
import { freshProcessAbsence } from './debug-o11-client-orphan-observation.mjs';
import { assertLockNotRetained } from './debug-retained-locks.mjs';
const SCHEMA = 'ssam-o11-client-aborted-reconciliation/1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = code => { throw new Error('debug_o11_client_aborted_reconcile_' + code); };
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
// A private cleanup under the store rule names its state root and every legacy store, and leaves no store pending.
const storeRule = c => c?.completed === true && c.pending === 0 && typeof c.stateRoot === 'string' &&
  Array.isArray(c.legacyInventory) && (c.pendingStores ?? []).length === 0;
function runFile(root, operationId) {
  const base = path.join(root, '.local/debugger/native-runs/o11');
  const matches = fs.existsSync(base) ? fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory())
    .map(e => path.join(base, e.name, operationId, 'receipt.json')).filter(file => fs.existsSync(file)) : [];
  if (matches.length !== 1) fail('run_not_unique');
  return matches[0];
}
// The completed public receipt of an operation, or null. Read only.
export function clientAbortedReceipt(root, operationId) {
  if (!uuid.test(operationId ?? '')) return null;
  let file;
  try { file = path.join(path.dirname(runFile(root, operationId)), 'client-aborted-reconciliation.json'); } catch { return null; }
  if (!fs.existsSync(file)) return null;
  const receipt = JSON.parse(fs.readFileSync(file));
  return receipt.schema === SCHEMA && receipt.ok === true && receipt.operationId === operationId ? receipt : null;
}
export async function reconcileO11ClientAborted(root, session, operationId, {
  // 'ending': the store-rule private reconcile left exactly ['execution-outcome'] (debug-client-private-reconcile.mjs).
  privateReceipt, observation,
  observeProcesses = observeO11ClientProcesses, isProcessAlive = processAlive,
  // App-user leases and private inspection records: the new root plus every legacy copy (debug-state-root.mjs), counted only.
  vaultRoot, legacyRoots, invokeRoot, invokeLegacyRoots, env = process.env, clock = Date.now, dryRun = false,
} = {}) {
  const state = session?.state, ran = session?.runResult;
  assertLockNotRetained({ action: 'archive', operationId, host: ran?.target?.host ?? ran?.binding?.host, moduleKey: ran?.target?.moduleKey ?? ran?.binding?.moduleKey });
  if (session?.lane !== 'o11' || session.runtime !== 'client' || !uuid.test(session.sessionId ?? '') || !uuid.test(operationId ?? '') ||
      !(state === 'ending' && session.pause || state === 'uncertain' && session.runResult?.operationId === operationId) ||
      session.pause && !(Date.parse(session.pause.expiresAt) <= clock())) fail('not_eligible');
  const realRoot = fs.realpathSync(root), pins = [];
  const read = (file, json = true) => {
    if (typeof file !== 'string' || !fs.existsSync(file)) fail('evidence_missing');
    const relative = path.relative(realRoot, fs.realpathSync(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('path_invalid');
    const bytes = fs.readFileSync(file); pins.push({ path: file, sha256: sha(bytes) }); return json ? JSON.parse(bytes) : bytes;
  };
  if (!same(read(path.join(root, '.local/debugger/client-sessions', session.sessionId + '.json')), session)) fail('session_changed');
  let cleanup = null;
  if (privateReceipt !== undefined || state === 'ending') {
    const p = privateReceipt;
    if (p?.schema !== 'ssam-client-private-reconciliation/1' || p.sessionId !== session.sessionId || p.operationId !== operationId ||
        p.state !== 'requires-reconciliation' || !storeRule(p.privateCleanup) || !same(p.pending, ['execution-outcome']) ||
        p.workerStopped !== true || p.credentialsReleased !== true || typeof p.receiptPath !== 'string' || !fs.existsSync(p.receiptPath))
      fail('private_cleanup_unconfirmed');
    const stored = read(p.receiptPath);
    if (stored.sessionId !== session.sessionId || stored.operationId !== operationId || !same(stored.privateCleanup, p.privateCleanup))
      fail('private_cleanup_unconfirmed');
    cleanup = { source: 'private-reconciliation', completed: true, receiptPath: p.receiptPath,
      stateRoot: p.privateCleanup.stateRoot, legacyInventory: p.privateCleanup.legacyInventory };
  }
  const file = runFile(root, operationId), directory = path.dirname(file), run = read(file), target = run.target;
  if (state === 'uncertain' && !same(run, session.runResult)) fail('run_result_changed');
  const results = run.results, scenarios = run.scenarios, notSent = run.notSent ?? [];
  // No server trace, no endpoint: a client action whose only server traffic would be counted by the worker below.
  if (run.schema !== 'ssam-o11-native-run/1' || run.operationId !== operationId || run.op !== 'run' || run.receiptPath !== file ||
      target?.host !== path.basename(path.dirname(directory)) || !/^[A-Za-z0-9_+]{22}$/.test(target?.moduleKey ?? '') ||
      run.serverTrace || run.needs?.serverTrace != null || run.tracePlan?.server != null ||
      !Array.isArray(run.entryAbi?.endpoints) || run.entryAbi.endpoints.length !== 0 ||
      !Array.isArray(results) || !Array.isArray(scenarios) || !Array.isArray(notSent) ||
      run.worker !== undefined && (run.worker?.submitted !== 0 || run.worker.answered !== 0 ||
        run.worker.requestUncertain !== false || run.worker.loginUncertain !== false)) fail('run_evidence_invalid');
  const named = name => scenarios.some(s => s?.name === name);
  const answered = [], interrupted = [];
  for (const r of results) {
    if (!named(r?.name) || notSent.includes(r.name)) fail('scenario_outcome_invalid');
    if (r.ok === true && r.uncertain === false && r.requests?.submitted === 0 && r.requests?.answered === 0) answered.push({ name: r.name, requests: r.requests });
    else if (r.ok === false && r.uncertain === true) interrupted.push(r.name);
    else fail('scenario_outcome_invalid');
  }
  if (notSent.some(name => !named(name))) fail('scenario_outcome_invalid');
  for (const s of scenarios) if (!results.some(r => r.name === s.name) && !notSent.includes(s.name)) interrupted.push(s.name);
  const worker = read(path.join(directory, 'native-entry-receipt.json')), nativeId = worker.sessionId;
  if (worker.schema !== 'ssam-o11-native-entry-receipt/1' || !/^[a-f0-9]{32}$/.test(nativeId ?? '') ||
      worker.requestSubmittedCount !== 0 || worker.requestAnsweredCount !== 0 || worker.requestUncertain !== false ||
      worker.loginUncertain !== false || !Number.isSafeInteger(worker.loginSubmittedCount) || worker.loginSubmittedCount > 1 ||
      worker.loginAnsweredCount !== worker.loginSubmittedCount || worker.entry?.endpoint !== null ||
      !same(worker.sourceContract, run.sourceContract) || Object.entries(target).some(([key, value]) => worker.target?.[key] !== value) ||
      worker.target?.publishedVersionId !== run.published?.versionId || worker.target?.sourceSha256 !== run.published?.sourceSha256 ||
      !Array.isArray(worker.scenarios) || worker.scenarios.some(s => s?.submitted !== 0 || s.answered !== 0 || s.uncertain !== false))
    fail('request_evidence_invalid');
  if (run.sourceContract?.path !== path.join(directory, 'native-entry-source.json')) fail('source_changed');
  read(run.sourceContract.path, false);
  if (pins.at(-1).sha256 !== run.sourceContract.sha256) fail('source_changed');
  for (const name of ['native-entry-preparation.json', 'native-entry-process-receipt.json', nativeId + '.login-attempt.json'])
    if (fs.existsSync(path.join(directory, name))) read(path.join(directory, name), false);
  if (fs.readdirSync(directory).some(name => name.includes('.post-'))) fail('submission_observed');
  if (fs.existsSync(path.join(root, '.local/debugger', nativeId))) fail('native_debugger_observed');
  const lock = path.join(path.dirname(directory), target.moduleKey + '.lock');
  const archive = path.join(directory, 'reconciled-client-aborted.lock'), receiptPath = path.join(directory, 'client-aborted-reconciliation.json');
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
  // Current evidence, never trusted from an older receipt: CIM absence, leases and private records in every store.
  const pending = [];
  let processEvidence = observation?.processEvidence;
  if (!freshProcessAbsence(processEvidence, ownerPid, clock())) {
    try { processEvidence = await observeProcesses(ownerPid); }
    catch { processEvidence = { workerStopped: false, source: 'unavailable', nativeDisposalConfirmed: false }; }
  }
  const workerStopped = freshProcessAbsence(processEvidence, ownerPid, clock());
  if (!workerStopped) pending.push('worker-termination-evidence');
  let leases;
  try { leases = debugStoreInventory('app-user', { env, stateRoot: vaultRoot, legacyRoots }); }
  catch { leases = { stateRoot: vaultRoot ?? null, legacyInventory: [], empty: false, pending: ['store:state'] }; }
  if (!leases.empty) pending.push('app-user-credential-release', ...leases.pending);
  if (!cleanup) {
    const stop = session.stopEvidence?.privateInspectionCleanup;
    if (storeRule(stop)) cleanup = { source: 'stop-evidence', completed: true, stateRoot: stop.stateRoot, legacyInventory: stop.legacyInventory };
    else {
      // A terminal session keeps no native pause id to match records by, so a cleanup recorded before the store
      // rule counts only when no store (new root or legacy copy) holds any private inspection record at all.
      let records;
      try { records = debugStoreInventory('invoke', { env, stateRoot: invokeRoot, legacyRoots: invokeLegacyRoots }); }
      catch { records = { stateRoot: invokeRoot ?? null, legacyInventory: [], empty: false, pending: ['store:state'] }; }
      if (records.empty) cleanup = { source: 'store-inventory-empty', completed: true, stateRoot: records.stateRoot, legacyInventory: records.legacyInventory };
      else pending.push('private-inspection-cleanup', ...records.pending.map(p => 'private-inspection:' + p));
    }
  }
  unchanged();
  const evidence = { schema: SCHEMA, operationId, sessionId: session.sessionId, sessionState: state, nativeId, pins, originalLock: lock, archive,
    businessRequestsSubmitted: 0, businessRequestsAnswered: 0, loginAnswered: worker.loginAnswered === true && worker.loginAnsweredCount === 1,
    executionOutcome: 'aborted-unconfirmed', executionComplete: false,
    answeredScenarios: answered, interruptedScenarios: interrupted, notSentScenarios: notSent,
    processEvidence, workerStopped, nativeDebuggerStarted: false, serverSessionObserved: false,
    credentialsReleased: leases.empty === true, credentialEvidence: 'no-files-in-any-app-user-lease-store',
    stateRoot: leases.stateRoot, legacyInventory: leases.legacyInventory, privateCleanup: cleanup ?? { completed: false },
    replayed: false, valuesComplete: false, lifecycleProved: false };
  if (pending.length) {
    const blocked = { ...evidence, ok: false, state: 'client-aborted-unproved', at: new Date(clock()).toISOString(), pending,
      mutexArchived: false, mutexReleased: false };
    if (dryRun) return { ...blocked, dryRun: true, wouldArchive: false, receiptPath: null };
    blocked.receiptPath = path.join(directory, 'client-aborted-reconciliation.blocked-' + Date.now() + '.json');
    fs.writeFileSync(blocked.receiptPath, JSON.stringify(blocked, null, 2), { flag: 'wx' });
    return blocked;
  }
  if (dryRun) return { ...evidence, ok: true, dryRun: true, wouldArchive: true, state: 'eligible', pending: [],
    mutexArchived: false, mutexReleased: false, receiptPath: null };
  if (!receipt) {
    receipt = { ...evidence, state: 'archiving-client-aborted', at: new Date(clock()).toISOString(), receiptPath,
      lockSha256: sha(lockBytes), ownerPid };
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
  receipt = JSON.parse(JSON.stringify({ ...receipt, processEvidence, workerStopped, stateRoot: leases.stateRoot, legacyInventory: leases.legacyInventory,
    privateCleanup: cleanup, ok: true, state: 'reconciled-client-aborted', completedAt: new Date(clock()).toISOString(), pending: [],
    originalEvidencePreserved: true, mutexArchived: true, mutexReleased: true }));
  fs.writeFileSync(receiptPath + '.tmp', JSON.stringify(receipt, null, 2)); fs.renameSync(receiptPath + '.tmp', receiptPath);
  return receipt;
}
