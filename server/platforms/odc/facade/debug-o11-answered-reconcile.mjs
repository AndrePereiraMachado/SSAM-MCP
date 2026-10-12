// Recover durable completion evidence after coordinator loss. Never invoke or stop a run.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { debugStoreInventory } from './debug-state-root.mjs';
import { assertLockNotRetained } from './debug-retained-locks.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = code => { throw new Error('debug_o11_answered_reconcile_' + code); };
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
export function reconcileO11Answered(root, session, {
  isProcessAlive = processAlive,
  // App-user leases: the new root plus every legacy copy (debug-state-root.mjs), read only here.
  vaultRoot, legacyRoots, env = process.env,
} = {}) {
  const nativeId = session?.nativeSessionId;
  if (session?.lane !== 'o11' || !uuid.test(session.sessionId ?? '') ||
      !/^[a-f0-9]{32}$/.test(nativeId ?? '') || !['ending', 'uncertain'].includes(session.state) ||
      session.pauses?.length !== 0) fail('not_eligible');
  const realRoot = fs.realpathSync(root), pins = [];
  const read = file => {
    const relative = path.relative(realRoot, fs.realpathSync(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('path_invalid');
    const bytes = fs.readFileSync(file); pins.push({ path: file, sha256: sha(bytes) }); return JSON.parse(bytes);
  };
  const publicFile = path.join(root, '.local/debugger/server-sessions', session.sessionId + '.json');
  if (!same(read(publicFile), session)) fail('session_changed');
  const base = path.join(root, '.local/debugger/native-runs/o11'), matches = [];
  for (const host of fs.readdirSync(base, { withFileTypes: true }).filter(x => x.isDirectory())) {
    for (const entry of fs.readdirSync(path.join(base, host.name), { withFileTypes: true })) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      const file = path.join(base, host.name, entry.name, 'native-entry-receipt.json');
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).sessionId === nativeId) matches.push(file);
    }
  }
  if (matches.length !== 1) fail('run_not_unique');
  const directory = path.dirname(matches[0]), worker = read(matches[0]);
  const report = read(path.join(directory, 'receipt.json')), target = report.target, operationId = report.operationId;
  // A lock retained by user decision is never archived, before any evidence check or write.
  for (const id of [operationId, path.basename(directory)]) assertLockNotRetained({ action: 'archive', operationId: id, host: target?.host,
    moduleKey: target?.moduleKey, lockPath: path.join(path.dirname(directory), (target?.moduleKey ?? '') + '.lock') });
  if (!uuid.test(operationId ?? '') || path.basename(directory) !== operationId ||
      target?.host !== path.basename(path.dirname(directory)) || !/^[A-Za-z0-9_+]{22}$/.test(target?.moduleKey ?? '') ||
      report.schema !== 'ssam-o11-native-run/1' || report.op !== 'run' || report.state !== 'invoking' ||
      report.results?.length !== 0 || report.appUserAuthenticated !== true || report.serverTrace?.sessionId !== nativeId ||
      report.receiptPath !== path.join(directory, 'receipt.json')) fail('run_evidence_invalid');
  const count = worker.requestSubmittedCount;
  if (worker.schema !== 'ssam-o11-native-entry-receipt/1' || worker.phase !== 'disposed' || worker.ok !== true ||
      worker.prepared !== true || worker.authenticated !== true || worker.nativeScreenPermissionsPassed !== true ||
      worker.loginSubmittedCount !== 1 || worker.loginAnsweredCount !== 1 || worker.loginUncertain !== false ||
      !Number.isSafeInteger(count) || count < 1 || worker.requestAnsweredCount !== count || worker.requestUncertain !== false ||
      worker.requestEnvelopeVerified !== true || worker.memoryCleared !== true || worker.nativeContextReferencesReleased !== true ||
      worker.privateInspectionCleanup?.completed !== true || worker.privateInspectionCleanup?.pending !== 0 ||
      !same(worker.sourceContract, report.sourceContract) ||
      Object.entries(target).some(([key, value]) => worker.target?.[key] !== value) ||
      worker.target?.publishedVersionId !== report.published?.versionId || worker.target?.sourceSha256 !== report.published?.sourceSha256 ||
      worker.scenarios?.length !== report.scenarios?.length ||
      worker.scenarios.some((s, i) => s.name !== report.scenarios[i].name || s.ok !== true || s.uncertain !== false ||
        !Number.isSafeInteger(s.submitted) || s.submitted < 1 || s.submitted !== s.answered) ||
      worker.scenarios.reduce((n, s) => n + s.submitted, 0) !== count ||
      worker.lastEntryResponse?.status !== 200 || worker.lastEntryResponse?.nativeEnvelopeAccepted !== true) fail('response_or_cleanup_invalid');
  const sourceFile = path.join(directory, 'native-entry-source.json');
  read(sourceFile);
  if (report.sourceContract?.path !== sourceFile || pins.at(-1).sha256 !== report.sourceContract.sha256) fail('source_changed');
  const markers = fs.readdirSync(directory).filter(name => name.startsWith(nativeId + '.post-'));
  if (markers.length !== count) fail('submission_markers_invalid');
  for (let seq = 1; seq <= count; seq++) {
    const marker = read(path.join(directory, `${nativeId}.post-${seq}.json`));
    if (marker.sessionId !== nativeId || marker.seq !== seq || !worker.scenarios.some(s => s.name === marker.scenario)) fail('submission_marker_invalid');
  }
  const native = read(path.join(root, '.local/debugger', nativeId, 'receipt.json'));
  if (native.ok !== true || native.sessionId !== nativeId || native.lane !== 'o11' || native.module !== target.module ||
      native.state !== 'stopped' || native.error || native.stopError || native.startError ||
      native.transport?.tokenObtained !== true || native.transport?.stopPhase !== 'stopped' ||
      !native.events?.some(e => e.kind === 'stopped') || native.pauses?.length !== 0 ||
      !Number.isSafeInteger(native.processId) || native.processId <= 0 || isProcessAlive(native.processId)) fail('native_not_stopped');
  const lock = path.join(path.dirname(directory), target.moduleKey + '.lock');
  const archive = path.join(directory, 'reconciled-answered.lock');
  const receiptPath = path.join(directory, 'answered-reconciliation.json');
  const unchanged = () => { if (pins.some(p => sha(fs.readFileSync(p.path)) !== p.sha256)) fail('evidence_changed'); };
  // Fail closed if any lease remains in any store or a store cannot be read. No decryption, deletion, or
  // saved-profile access. The vault writes leases directly as <ref>.dpapi / <ref>.tmp; account subdirectories
  // are unrelated and never opened. A blocked attempt archives nothing and leaves an additive receipt.
  const leases = () => {
    try { return debugStoreInventory('app-user', { env, stateRoot: vaultRoot, legacyRoots }); }
    catch { fail('lease_release_unproved'); }
  };
  const blocked = inventory => {
    const file = path.join(directory, 'answered-reconciliation.blocked-' + Date.now() + '.json');
    const result = { schema: 'ssam-o11-answered-reconciliation/1', ok: false, state: 'credential-lease-unreleased', operationId,
      sessionId: session.sessionId, nativeId, at: new Date().toISOString(), pins, originalLock: lock, archive,
      credentialsReleased: false, credentialEvidence: 'lease-entries-or-unreadable-store', stateRoot: inventory.stateRoot,
      legacyInventory: inventory.legacyInventory, pending: inventory.pending, mutexArchived: false, replayed: false, receiptPath: file };
    fs.writeFileSync(file, JSON.stringify(result, null, 2), { flag: 'wx' });
    return result;
  };
  let receipt;
  if (fs.existsSync(receiptPath)) {
    receipt = JSON.parse(fs.readFileSync(receiptPath));
    if (receipt.schema !== 'ssam-o11-answered-reconciliation/1' || receipt.operationId !== operationId ||
        receipt.sessionId !== session.sessionId || receipt.originalLock !== lock || receipt.archive !== archive ||
        !same(receipt.pins, pins)) fail('reconciliation_changed');
    if (receipt.ok === true && fs.existsSync(archive) && sha(fs.readFileSync(archive)) === receipt.lockSha256) return receipt;
  } else {
    const bytes = fs.readFileSync(lock), owner = JSON.parse(bytes);
    if (owner.operationId !== operationId || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || isProcessAlive(owner.pid)) fail('owner_not_stopped');
    const inventory = leases();
    if (!inventory.empty) return blocked(inventory);
    receipt = { schema: 'ssam-o11-answered-reconciliation/1', operationId, sessionId: session.sessionId, nativeId,
      state: 'archiving-confirmed-answered', at: new Date().toISOString(), pins, originalLock: lock, archive, receiptPath,
      lockSha256: sha(bytes), ownerPid: owner.pid, submitted: count, answered: count, nativeStopped: true,
      credentialsReleased: true, credentialEvidence: 'no-files-in-any-private-lease-store', nativeContextReleased: true,
      stateRoot: inventory.stateRoot, legacyInventory: inventory.legacyInventory,
      replayed: false, valuesComplete: false, traceComplete: false };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  }
  unchanged();
  const inventory = leases();
  if (!inventory.empty) return blocked(inventory);
  if (!fs.existsSync(archive)) {
    const bytes = fs.readFileSync(lock), owner = JSON.parse(bytes);
    if (sha(bytes) !== receipt.lockSha256 || owner.operationId !== operationId || owner.pid !== receipt.ownerPid || isProcessAlive(owner.pid)) fail('mutex_owner_changed');
    fs.renameSync(lock, archive);
  }
  if (sha(fs.readFileSync(archive)) !== receipt.lockSha256) fail('archive_changed');
  unchanged();
  receipt = { ...receipt, ok: true, state: 'reconciled-answered', completedAt: new Date().toISOString(),
    stateRoot: inventory.stateRoot, legacyInventory: inventory.legacyInventory, originalEvidencePreserved: true, mutexArchived: true };
  fs.writeFileSync(receiptPath + '.tmp', JSON.stringify(receipt, null, 2)); fs.renameSync(receiptPath + '.tmp', receiptPath);
  return receipt;
}
