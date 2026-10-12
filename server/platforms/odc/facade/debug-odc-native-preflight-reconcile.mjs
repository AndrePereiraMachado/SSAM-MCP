// Narrow reconciliation of the former producer preflight classification bug.
// Never applies to a submitted action or a native debugger start. Preserve all
// original receipts and archive this operation's mutex with an additive receipt.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { qualifyClientLocalHistory } from './debug-odc-native-client-local.mjs';
const sha = data => createHash('sha256').update(data).digest('hex');
const fail = code => { throw new Error('debug_odc_preflight_reconcile_' + code); };
export function reconcileOdcProducerPreflight(root, session) {
  const operationId = session?.runResult?.operationId;
  if (session?.lane !== 'odc' || session.state !== 'uncertain' || !/^[a-f0-9-]{36}$/.test(operationId ?? '')) fail('not_eligible');
  const directory = path.join(root, '.local/debugger/native-runs/odc', operationId), file = path.join(directory, 'receipt.json');
  const bytes = fs.readFileSync(file), report = JSON.parse(bytes);
  if (JSON.stringify(report) !== JSON.stringify(session.runResult) || report.operationId !== operationId ||
      report.schema !== 'ssam-odc-native-run/1' || report.error !== 'debug_odc_producer_redaction_binding_invalid' ||
      report.serverTrace?.state !== 'start-outcome-unknown' || report.serverTrace.sessionId || report.state !== 'uncertain' ||
      report.results?.length !== 0 || (report.requestEvidence?.length ?? 0) !== 0 || (report.pendingRequests ?? 0) !== 0 ||
      report.credentialsReleased !== true || report.cleanup?.completed !== true || report.cleanup.receipt?.cleanupConfirmed !== true ||
      report.cleanup.receipt.authenticationSyncUncertain !== false || report.cleanup.receipt.nativeResponses?.length !== 0 ||
      report.independentStaticRead?.historyUnchangedAfterRun !== true || report.lockRetained !== true ||
      !/^[a-f0-9]{32}$/.test(report.sessionId ?? '') || !report.finishedAt) fail('not_eligible');
  const transport = report.cleanup.receipt.transport;
  if (!transport || transport.uncertain !== false || transport.probes?.length !== 0 ||
      ['networkRequests', 'executeRequestSubmissions', 'negotiations', 'socketConnections', 'longPollingConnections',
        'longPollingSendRequests'].some(name => transport[name] !== 0)) fail('request_or_channel_observed');
  if (fs.existsSync(path.join(root, '.local/debugger', report.sessionId))) fail('native_session_observed');
  const prior = report.independentStaticRead;
  qualifyClientLocalHistory(root, report.binding, { operationId: prior.operationId, receiptSha256: prior.receiptSha256,
    debugReceiptSha256: prior.debugReceiptSha256, manifestSha256: prior.manifestSha256 });
  const bindingHash = sha('odc|' + report.binding.runtimeUrl + '|' + report.binding.moduleKey);
  const lock = path.join(root, '.local/debugger/native-runs', bindingHash + '.static-read.lock');
  const archive = path.join(directory, 'reconciled-static-read.lock');
  const receiptPath = path.join(directory, 'producer-preflight-reconciliation.json');
  let receipt;
  if (fs.existsSync(receiptPath)) {
    receipt = JSON.parse(fs.readFileSync(receiptPath));
    if (receipt.operationId !== operationId || receipt.originalReceiptSha256 !== sha(bytes) || receipt.archive !== archive ||
        receipt.originalLock !== lock) fail('reconciliation_changed');
  } else {
    const lockBytes = fs.readFileSync(lock), owner = JSON.parse(lockBytes);
    if (owner.operationId !== operationId || owner.sessionId !== report.sessionId) fail('mutex_owner_changed');
    receipt = { schema: 'ssam-odc-producer-preflight-reconciliation/1', operationId, sessionId: report.sessionId,
      state: 'archiving-confirmed-unused-mutex', at: new Date().toISOString(), originalReceiptSha256: sha(bytes),
      originalLock: lock, lockSha256: sha(lockBytes), archive, receiptPath, businessRequestsSubmitted: 0,
      nativeDebuggerStarted: false, authenticationCleaned: true, historicalOutcomeReconciled: false };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  }
  if (!fs.existsSync(archive)) {
    const lockBytes = fs.readFileSync(lock), owner = JSON.parse(lockBytes);
    if (sha(lockBytes) !== receipt.lockSha256 || owner.operationId !== operationId || owner.sessionId !== report.sessionId) fail('mutex_owner_changed');
    fs.renameSync(lock, archive);
  }
  if (sha(fs.readFileSync(archive)) !== receipt.lockSha256) fail('archive_changed');
  receipt = { ...receipt, ok: true, state: 'reconciled-not-started', completedAt: new Date().toISOString(),
    originalReceiptPreserved: sha(fs.readFileSync(file)) === receipt.originalReceiptSha256, mutexArchived: true };
  if (!receipt.originalReceiptPreserved) fail('receipt_changed');
  fs.writeFileSync(receiptPath + '.tmp', JSON.stringify(receipt, null, 2)); fs.renameSync(receiptPath + '.tmp', receiptPath);
  return receipt;
}
