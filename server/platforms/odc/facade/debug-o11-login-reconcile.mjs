// Reconcile only an answered InvalidLoginException before any business/debug call.
// Preserve the original reports and mutex; no authentication or app request is retried.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertLockNotRetained } from './debug-retained-locks.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error('debug_o11_login_reconcile_' + code); };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export function reconcileO11LoginRefusal(root, session, { isProcessAlive = processAlive } = {}) {
  const supplied = session?.runResult, operationId = supplied?.operationId, target = supplied?.target;
  assertLockNotRetained({ action: 'reconcile', operationId, host: target?.host, moduleKey: target?.moduleKey });
  if (session?.lane !== 'o11' || session.state !== 'uncertain' || session.nativeSessionId ||
      !uuid.test(session.sessionId ?? '') || !uuid.test(operationId ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(target?.host ?? '') ||
      !/^[A-Za-z0-9_+]{22}$/.test(target?.moduleKey ?? '') || session.pauses?.length !== 0) fail('not_eligible');
  const directory = path.join(root, '.local/debugger/native-runs/o11', target.host, operationId);
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('directory_invalid');
  const pins = [];
  const read = file => {
    const bytes = fs.readFileSync(file); pins.push({ path: file, sha256: sha(bytes) }); return JSON.parse(bytes);
  };
  const file = path.join(directory, 'receipt.json'), report = read(file);
  if (!same(report, supplied) || report.receiptPath !== file || report.schema !== 'ssam-o11-native-run/1' ||
      report.op !== 'run' || report.state !== 'failed-or-uncertain' || report.serverTrace || report.appUserAuthenticated ||
      report.results?.length !== 0 || report.uncertain !== true || report.lockRetained !== true ||
      report.credentialsReleased !== true || report.worker?.memoryCleared !== true ||
      report.worker?.loginUncertain !== false || report.worker?.requestUncertain !== false ||
      report.worker?.submitted !== 0 || report.worker?.answered !== 0) fail('run_evidence_invalid');
  const worker = read(path.join(directory, 'native-entry-receipt.json')), nativeId = worker.sessionId;
  if (worker.schema !== 'ssam-o11-native-entry-receipt/1' || !/^[a-f0-9]{32}$/.test(nativeId ?? '') ||
      worker.prepared !== true || worker.phase !== 'disposed' || worker.ok !== false ||
      worker.diagnostics?.phase !== 'original-login' || worker.diagnostics?.errorType !== 'InvalidLoginException' ||
      worker.authenticated !== false || worker.nativeCheckRegisteredPassed !== false || worker.rolesLoadedFromServer !== false ||
      worker.loginSubmitted !== true || worker.loginAnswered !== true || worker.loginSubmittedCount !== 1 || worker.loginAnsweredCount !== 1 ||
      worker.loginUncertain !== false || worker.requestUncertain !== false ||
      worker.requestSubmittedCount !== 0 || worker.requestAnsweredCount !== 0 ||
      worker.memoryCleared !== true || worker.nativeContextReferencesReleased !== true ||
      worker.privateInspectionCleanup?.completed !== true || worker.privateInspectionCleanup?.pending !== 0 ||
      !same(worker.sourceContract, report.sourceContract) ||
      Object.entries(target).some(([key, value]) => worker.target?.[key] !== value) ||
      worker.target?.publishedVersionId !== report.published?.versionId || worker.target?.sourceSha256 !== report.published?.sourceSha256)
    fail('login_evidence_invalid');
  if (fs.existsSync(path.join(root, '.local/debugger', nativeId)) ||
      fs.readdirSync(directory).some(name => name.includes('.post-'))) fail('request_or_debugger_observed');
  const contractFile = path.join(directory, 'native-entry-source.json');
  if (report.sourceContract?.path !== contractFile || sha(fs.readFileSync(contractFile)) !== report.sourceContract.sha256)
    fail('source_changed');
  pins.push({ path: contractFile, sha256: report.sourceContract.sha256 });
  const marker = read(path.join(directory, nativeId + '.login-attempt.json'));
  if (marker.sessionId !== nativeId || marker.kind !== 'login' || marker.sourceContractSha256 !== report.sourceContract.sha256)
    fail('login_marker_invalid');
  const lock = path.join(path.dirname(directory), target.moduleKey + '.lock');
  const archive = path.join(directory, 'reconciled-login-refusal.lock');
  const receiptPath = path.join(directory, 'login-refusal-reconciliation.json');
  let receipt;
  if (fs.existsSync(receiptPath)) {
    receipt = JSON.parse(fs.readFileSync(receiptPath));
    if (receipt.schema !== 'ssam-o11-login-refusal-reconciliation/1' || receipt.operationId !== operationId ||
        receipt.sessionId !== session.sessionId || receipt.originalLock !== lock || receipt.archive !== archive ||
        !same(receipt.pins, pins)) fail('reconciliation_changed');
  } else {
    const bytes = fs.readFileSync(lock), owner = JSON.parse(bytes);
    if (owner.operationId !== operationId || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail('mutex_owner_changed');
    if (isProcessAlive(owner.pid)) fail('owner_still_running');
    receipt = { schema: 'ssam-o11-login-refusal-reconciliation/1', operationId, sessionId: session.sessionId, nativeId,
      state: 'archiving-confirmed-login-refusal', at: new Date().toISOString(), pins,
      originalLock: lock, lockSha256: sha(bytes), ownerPid: owner.pid, archive, receiptPath,
      businessRequestsSubmitted: 0, nativeDebuggerStarted: false, loginSubmitted: 1, loginAnswered: 1,
      authenticated: false, nativeContextReleased: true, credentialsReleased: true, replayed: false };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  }
  const unchanged = () => { if (pins.some(pin => sha(fs.readFileSync(pin.path)) !== pin.sha256)) fail('evidence_changed'); };
  unchanged();
  if (!fs.existsSync(archive)) {
    const bytes = fs.readFileSync(lock), owner = JSON.parse(bytes);
    if (sha(bytes) !== receipt.lockSha256 || owner.operationId !== operationId || owner.pid !== receipt.ownerPid)
      fail('mutex_owner_changed');
    if (isProcessAlive(owner.pid)) fail('owner_still_running');
    fs.renameSync(lock, archive);
  }
  if (sha(fs.readFileSync(archive)) !== receipt.lockSha256) fail('archive_changed');
  unchanged();
  receipt = { ...receipt, ok: true, state: 'reconciled-login-refused', completedAt: receipt.completedAt ?? new Date().toISOString(),
    originalEvidencePreserved: true, mutexArchived: true };
  fs.writeFileSync(receiptPath + '.tmp', JSON.stringify(receipt, null, 2)); fs.renameSync(receiptPath + '.tmp', receiptPath);
  return receipt;
}
