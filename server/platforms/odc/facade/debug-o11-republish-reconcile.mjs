// Read-only reconciliation of the original 4c debugger incident after an exact
// republish. A publication receipt proves a publication, not the disappearance
// of an unknown remote debug session. This module never removes a guard/marker,
// starts/stops a debugger, invokes an application, or changes a prior receipt.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { assertLockNotRetained } from './debug-retained-locks.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error('debug_o11_republish_reconcile_' + code); };
const OLD = Object.freeze({ operationId: '4c7016f0a51445108b185fdcd0109586',
  host: 'personal-2qqw9srv.outsystemscloud.com', module: 'Headless_UI', moduleKey: 'Mif02PxcH0K7KiABEHTwMg',
  applicationKey: 'gNS4vvu930yjPSk9Y3awUg', sourceSha256: 'e8562a2850c7c0392aabe9fcbf3891bc699d31af9b4f9392e7a618379e6544fc',
  baseVersionId: 5811, nativeReceiptSha256: '3faf10952f058d32bc66d0d307ab3589c001daa43f3d72cd5b00744bbf7dd9f4' });

function pinned(pin, limit = 1024 * 1024) {
  if (typeof pin?.path !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '')) fail('pin_invalid');
  const bytes = fs.readFileSync(pin.path);
  if (bytes.length > limit || hash(bytes) !== pin.sha256) fail('source_changed');
  return bytes;
}
function json(pin, read) {
  try { return JSON.parse(read(pin)); } catch (error) {
    if (/^debug_o11_republish_reconcile_/.test(error.message ?? '')) throw error;
    fail('evidence_unavailable');
  }
}

// Remote proof sources deliberately have no production-qualified member yet.
// GetIsRunning has no session argument and its server semantics are unproved;
// inDebug describes compilation, while ssam_debug status describes local state.
export function o11RemoteDebugAbsenceCapability() {
  return { qualified: false, error: 'debug_o11_remote_session_absence_unqualified',
    sessionTokenAvailable: false, remoteSessionEnumerationAvailable: false,
    pendingRemoteTraceEnumerationAvailable: false,
    inadmissibleProofs: ['publish-completed', 'module-version-changed', 'GetIsRunning', 'inDebug', 'ping',
      'local-status', 'worker-exited', 'elapsed-time', 'empty-local-trace'] };
}

// The caller supplies only hash-pinned evidence already acquired by the native
// publish/read paths. No caller-provided boolean can release the historical lock.
export function inspectO11RepublishNeutralization(input, { read = pinned, now = Date.now } = {}) {
  assertLockNotRetained({ action: 'neutralize', operationId: input?.operationId, host: input?.host, moduleKey: input?.moduleKey });
  if (input?.operationId !== OLD.operationId || input.nativeReceipt?.sha256 !== OLD.nativeReceiptSha256) fail('historical_binding_invalid');
  const native = json(input.nativeReceipt, read), controller = json(input.controllerReceipt, read);
  if (native.schema !== 'ssam-o11-metadata-correlation-receipt/1' || native.startAttempted !== true ||
      native.startConfirmed !== false || native.stopAttempted !== true || native.stopConfirmed !== false ||
      native.startOrStopUncertain !== true || native.markerRetained !== true || native.appRequestsSentByProbe !== 0 ||
      controller.schema !== 'ssam-o11-metadata-controller-receipt/1' || controller.operationId !== OLD.operationId) fail('historical_receipt_invalid');
  const request = json(input.publicationRequest, read), receipt = json(input.publicationReceipt, read), authorization = json(input.publicationAuthorization, read);
  if (request.host !== OLD.host || request.module !== OLD.module || request.moduleKey !== OLD.moduleKey || request.applicationKey !== OLD.applicationKey ||
      request.baseVersionId !== OLD.baseVersionId || request.message !== 'SSAM Debug Republish Published' ||
      request.baseSha256 !== request.candidateSha256 || request.baseSha256 !== OLD.sourceSha256 ||
      request.authorizationSha256 !== input.publicationAuthorization.sha256 || request.authorizationPath !== input.publicationAuthorization.path ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.operationId ?? '')) fail('publication_request_mismatch');
  if (authorization.operationId !== request.operationId || authorization.host !== request.host || authorization.moduleKey !== request.moduleKey ||
      authorization.candidateSha256 !== request.candidateSha256 || authorization.baseVersionId !== request.baseVersionId ||
      authorization.scope !== 'ssam-debug-republish-published' || typeof authorization.words !== 'string' || !authorization.words.trim()) fail('publication_authorization_mismatch');
  if (receipt.operationId !== request.operationId || receipt.host !== request.host || receipt.module !== request.module ||
      receipt.moduleKey !== request.moduleKey || receipt.applicationKey !== request.applicationKey ||
      receipt.candidateSha256 !== request.candidateSha256 || receipt.baseVersionId !== request.baseVersionId ||
      receipt.state !== 'published' || receipt.started !== true || receipt.completed !== true || receipt.hasErrors !== false ||
      !Number.isSafeInteger(receipt.versionId) || receipt.versionId <= request.baseVersionId) fail('publication_not_confirmed');
  // Read the actual original and post-publication OML bytes, not just a receipt
  // claiming the two hashes are equal. The observed native inventory must still
  // identify that newly published version in this exact environment.
  if (input.baseSnapshot?.path !== request.basePath || input.baseSnapshot.sha256 !== request.baseSha256 ||
      input.candidateSnapshot?.path !== request.candidatePath || input.candidateSnapshot.sha256 !== request.candidateSha256 ||
      input.publishedSnapshot?.sha256 !== request.candidateSha256) fail('snapshot_binding_mismatch');
  for (const pin of [input.baseSnapshot, input.candidateSnapshot, input.publishedSnapshot]) read(pin, 100 * 1024 * 1024);
  // This is createO11Lifecycle.snapshot().proof (native inventory.json), not a
  // synthesized "session cleared" observation. The current module revision is
  // useful publication evidence only; it says nothing about debugger threads.
  const observed = json(input.publishedObservation, read);
  const captured = Date.parse(observed.capturedAtUtc ?? ''), time = now();
  if (!Number.isFinite(time) || !Number.isFinite(captured) || captured > time + 30000 || captured < time - 900000) fail('published_observation_stale');
  const matching = Array.isArray(observed.modules) ? observed.modules.filter(row => row.Key === request.moduleKey) : [];
  if (observed.host !== request.host || matching.length !== 1 || matching[0].Name !== request.module ||
      matching[0].ApplicationKey !== request.applicationKey || matching[0].VersionId !== receipt.versionId || matching[0].IsActive !== true)
    fail('published_observation_mismatch');
  // Re-read every pin after validation, so an edit during the assessment cannot
  // be hidden behind an earlier successful check. Originals are never written.
  for (const pin of [input.nativeReceipt, input.controllerReceipt, input.publicationRequest, input.publicationReceipt,
    input.publicationAuthorization, input.publishedObservation]) read(pin);
  for (const pin of [input.baseSnapshot, input.candidateSnapshot, input.publishedSnapshot]) read(pin, 100 * 1024 * 1024);
  const remote = o11RemoteDebugAbsenceCapability();
  return { schema: 'ssam-o11-republish-debug-neutralization/1', operationId: OLD.operationId,
    binding: { host: OLD.host, module: OLD.module, moduleKey: OLD.moduleKey },
    originalNativeStartConfirmed: false, originalNativeStopConfirmed: false, historicalUncertaintyPreserved: true,
    publication: { operationId: receipt.operationId, confirmed: true, baseVersionId: request.baseVersionId,
      publishedVersionId: receipt.versionId, sourceSha256: request.candidateSha256, originalBytesPreserved: true },
    historicalReceiptSha256: input.nativeReceipt.sha256, publicationReceiptSha256: input.publicationReceipt.sha256,
    observedPublishedVersionId: matching[0].VersionId, remoteSessionAbsenceProved: false, pendingRemoteTracesAbsenceProved: false,
    remote, state: 'blocked', ok: false, neutralized: false, releaseAllowed: false,
    markerRetained: true, evidenceModified: false, networkRequests: 0, startCalls: 0, stopCalls: 0,
    error: remote.error,
    nextEvidenceRequired: 'Qualify a native observation of active debugger state for the same host and entry module, including what it proves about pending debugger work. A new publication alone does not establish that state.' };
}
