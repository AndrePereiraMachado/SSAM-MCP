// Reconciles only the historical 4c debugger binding from immutable evidence.
// It never changes original receipts, starts/stops a debugger or alters the
// separate uncertain publication lock. Registration is a separate local step.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertLockNotRetained, retainedLock } from './debug-retained-locks.mjs';

const H = b => createHash('sha256').update(b).digest('hex');
const fail = code => { throw new Error('debug_o11_neutralization_' + code); };
const OLD = Object.freeze({ lane: 'o11', host: 'personal-2qqw9srv.outsystemscloud.com', module: 'Headless_UI',
  moduleKey: 'Mif02PxcH0K7KiABEHTwMg', applicationKey: 'gNS4vvu930yjPSk9Y3awUg', operationId: '4c7016f0a51445108b185fdcd0109586',
  versionId: 5811, moduleId: 436, sourceSha256: 'e8562a2850c7c0392aabe9fcbf3891bc699d31af9b4f9392e7a618379e6544fc',
  originalReceiptSha256: '3faf10952f058d32bc66d0d307ab3589c001daa43f3d72cd5b00744bbf7dd9f4',
  qualificationReceiptSha256: '9a230d52f4bd7ec3014ccd6b8b4fea1289cbddd92213451a44a5718b6a26a57b',
  qualificationHostSha256: '918896c3b7765504f343a6c43378df1090da2c86772b434a753eb1a2c9d462a7' });
export const O11_NEUTRALIZED_OPERATION = OLD.operationId;
// Approved immutable assessment, produced from the controlled native proof on
// 2026-10-04. Another report requires a separately reviewed qualification.
export const O11_NEUTRALIZATION_REPORT_SHA256 = '6a30a9a8c9d9fa286b6841333fb6520ba825e4eade8a497d72a0693134db9be8';
export const o11NeutralizationBindingHash = (host, key) => H('o11|https://' + host.toLowerCase() + '|' + key);
const fields = ['nativeReceipt', 'controllerReceipt', 'publicationRequest', 'publicationAuthorization', 'publicationReceipt',
  'publishedObservation', 'nativePublishCheck', 'serviceCenterObservation', 'qualificationController', 'qualificationNative'];
function pinRead(pin, max = 1024 * 1024) {
  if (!pin || !path.isAbsolute(pin.path ?? '') || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '')) fail('pin_invalid');
  const bytes = fs.readFileSync(pin.path);
  if (bytes.length > max || H(bytes) !== pin.sha256) fail('evidence_changed');
  return bytes;
}
function fresh(value, now) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now + 30000 || time < now - 900000) fail('observation_stale');
  return time;
}

export function assessO11NativeNeutralization(input, { read = pinRead, now = Date.now } = {}) {
  assertLockNotRetained({ action: 'neutralize', operationId: input?.operationId, host: input?.host, moduleKey: input?.moduleKey });
  const assessedAt = now();
  if (input?.lane !== OLD.lane || input.host !== OLD.host || input.moduleKey !== OLD.moduleKey || input.operationId !== OLD.operationId ||
      input.nativeReceipt?.sha256 !== OLD.originalReceiptSha256 || input.qualificationNative?.sha256 !== OLD.qualificationReceiptSha256) fail('historical_binding_invalid');
  const all = Object.fromEntries(fields.map(name => { try { return [name, JSON.parse(read(input[name]))]; } catch (e) { if (e.message?.startsWith('debug_o11_')) throw e; fail('evidence_invalid'); } }));
  const { nativeReceipt: old, controllerReceipt: prior, publicationRequest: request, publicationAuthorization: auth, publicationReceipt: publish,
    publishedObservation: live, nativePublishCheck: check, serviceCenterObservation: sc, qualificationController: controller, qualificationNative: q } = all;
  if (old.schema !== 'ssam-o11-metadata-correlation-receipt/1' || old.startAttempted !== true || old.startConfirmed !== false || old.stopAttempted !== true ||
      old.stopConfirmed !== false || old.startOrStopUncertain !== true || old.markerRetained !== true || old.appRequestsSentByProbe !== 0 ||
      prior.schema !== 'ssam-o11-metadata-controller-receipt/1' || prior.operationId !== OLD.operationId) fail('historical_receipt_invalid');
  if (request.host !== OLD.host || request.module !== OLD.module || request.moduleKey !== OLD.moduleKey || request.applicationKey !== OLD.applicationKey ||
      request.message !== 'SSAM Debug Republish Published' || request.baseVersionId !== OLD.versionId || request.baseSha256 !== OLD.sourceSha256 ||
      request.candidateSha256 !== OLD.sourceSha256 || request.authorizationPath !== input.publicationAuthorization.path || request.authorizationSha256 !== input.publicationAuthorization.sha256 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.operationId ?? '')) fail('publication_request_invalid');
  if (auth.operationId !== request.operationId || auth.host !== OLD.host || auth.moduleKey !== OLD.moduleKey || auth.candidateSha256 !== OLD.sourceSha256 ||
      auth.baseVersionId !== OLD.versionId || auth.scope !== 'ssam-debug-republish-published' || typeof auth.words !== 'string' || !auth.words.trim()) fail('authorization_invalid');
  // Keep the publication's uncertain causal attribution. This report records
  // the desired state through independent observations, never a fabricated ack.
  if (publish.operationId !== request.operationId || publish.host !== OLD.host || publish.moduleKey !== OLD.moduleKey || publish.applicationKey !== OLD.applicationKey ||
      publish.baseVersionId !== OLD.versionId || publish.candidateSha256 !== OLD.sourceSha256 || publish.state !== 'uncertain' ||
      publish.versionId !== 0 || publish.completed !== false || !/^[a-f0-9]{64}$/.test(publish.digest ?? '')) fail('publication_receipt_invalid');
  if (input.publishedSnapshot?.sha256 !== OLD.sourceSha256) fail('published_source_invalid');
  for (const pin of [{ path: request.basePath, sha256: OLD.sourceSha256 }, { path: request.candidatePath, sha256: OLD.sourceSha256 }, input.publishedSnapshot]) read(pin, 100 * 1024 * 1024);
  fresh(live.capturedAtUtc, assessedAt);
  const modules = live.modules?.filter(m => m.Key === OLD.moduleKey) ?? [];
  if (live.host !== OLD.host || modules.length !== 1 || modules[0].Name !== OLD.module || modules[0].ApplicationKey !== OLD.applicationKey ||
      modules[0].VersionId !== OLD.versionId || modules[0].IsActive !== true) fail('published_binding_invalid');
  fresh(check.capturedAtUtc, assessedAt);
  if (check.ok !== true || check.operationId !== request.operationId || check.source !== 'IServiceCenter.CheckPublishAsync via EnvironmentOperations.publish-check(readOnly)' ||
      check.sourceSha256 !== OLD.sourceSha256 || check.requestSha256 !== input.publicationRequest.sha256 || check.target?.host !== OLD.host ||
      check.target?.moduleKey !== OLD.moduleKey || check.target?.applicationKey !== OLD.applicationKey || check.target?.module !== OLD.module ||
      check.outcome?.Completed !== true || check.outcome.HasErrors !== false || check.outcome.VersionId !== OLD.versionId || check.outcome.ESpaceId !== OLD.moduleId ||
      check.outcome.Key !== OLD.moduleKey || check.publishSends !== 0 || check.appExecutions !== 0) fail('native_publish_check_invalid');
  fresh(sc.capturedAtUtc, assessedAt);
  if (sc.schema !== 'ssam-service-center-publication-observation/1' || sc.provenance !== 'cua-read-only-dom' || sc.host !== OLD.host || sc.module !== OLD.module ||
      sc.moduleId !== OLD.moduleId || sc.url !== 'https://' + OLD.host + '/ServiceCenter/eSpace_Edit.aspx?EspaceId=' + OLD.moduleId || sc.label !== 'Last Published' ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sc.lastPublishedDisplay ?? '') || sc.nativePublishedVersion !== OLD.versionId ||
      sc.nativeSourceSha256 !== OLD.sourceSha256 || sc.status !== 'The Module is OK. No messages to show.' || sc.publicationRepeated !== false) fail('service_center_observation_invalid');
  fresh(controller.completedAtUtc, assessedAt); fresh(q.completedAtUtc, assessedAt);
  if (controller.schema !== 'ssam-o11-running-qualification-controller/1' || controller.state !== 'qualified' || controller.target?.host !== OLD.host ||
      controller.target?.module !== 'Headless_CS' || controller.target.moduleKey !== 'Kawk_WFx5USxo7qFAB0lCQ' || controller.target.applicationKey !== OLD.applicationKey ||
      controller.appRequests !== 0 || controller.appUserRequested !== false || controller.childExited !== true || controller.exitCode !== 0 ||
      controller.nativeReceiptSha256 !== input.qualificationNative.sha256 || controller.hostDllSha256 !== OLD.qualificationHostSha256 ||
      JSON.stringify(controller.native) !== JSON.stringify(q)) fail('qualification_controller_invalid');
  if (q.schema !== 'ssam-o11-running-qualification/1' || q.operationId !== controller.operationId || q.qualified !== true || q.uncertain !== false ||
      q.startAttempted !== true || q.startConfirmed !== true || q.stopAttempted !== true || q.stopConfirmed !== true || q.readyVersionId !== 5808 || !q.readyNativeHashPresent ||
      q.before?.headless_CS !== false || q.before?.headless_UI !== false || q.during?.headless_CS !== true || q.during?.headless_UI !== false ||
      q.after?.headless_CS !== false || q.after?.headless_UI !== false || q.appRequests !== 0 || q.breakpoints !== 0 || q.evaluateCalls !== 0 || q.continueCalls !== 0 || q.killCalls !== 0) fail('qualification_invalid');
  for (const name of fields) read(input[name]);
  read(input.publishedSnapshot, 100 * 1024 * 1024);
  return { schema: 'ssam-o11-historical-debug-neutralization/1', assessedAtUtc: new Date(assessedAt).toISOString(),
    lane: OLD.lane, host: OLD.host, module: OLD.module, moduleKey: OLD.moduleKey, operationId: OLD.operationId,
    nativeDebuggerInactive: true, nativeStateQualification: 'controlled-module-session-false-true-false',
    originalReceiptPreserved: true, originalStartStopStillHistoricallyUncertain: true, oldOperationReplayAllowed: false,
    newBindingOperationsAllowed: true, independentRegistryBlocksOverridden: false,
    publication: { operationId: request.operationId, digest: publish.digest, desiredPublishedStateConfirmed: true,
      publicationOperationIdentityProved: false, publicationLockReleaseAllowed: false, publishedVersionId: OLD.versionId,
      sourceSha256: OLD.sourceSha256, lastPublishedDisplay: sc.lastPublishedDisplay, timestampTimezoneExplicit: sc.timezoneExplicit === true,
      provenance: ['native-published-source', 'native-CheckPublish-completed', 'ServiceCenter-original-DOM'] },
    debuggerObservation: { observedAtUtc: q.completedAtUtc, value: false, module: OLD.module,
      qualificationOperationId: q.operationId, pendingTraceEnumerationClaimed: false, originalProbeAppRequests: 0 },
    evidence: input, writes: 0, remoteCalls: 0 };
}

// Every lookup verifies the report and its evidence again. Elapsed time does not
// undo a historical neutralization; a NEW uncertain operation has its own guard.
export function hasO11NativeNeutralization(root, binding, { read = pinRead } = {}) {
  // A retained lock is never reported as neutralized.
  if (retainedLock({ operationId: binding?.operationId, host: binding?.host, moduleKey: binding?.moduleKey })) return false;
  if (binding?.lane !== 'o11' || binding.host !== OLD.host || binding.moduleKey !== OLD.moduleKey || binding.operationId !== OLD.operationId) return false;
  try {
    const file = path.join(root, '.local/debugger/reconciled-bindings', o11NeutralizationBindingHash(binding.host, binding.moduleKey) + '.json');
    const registration = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (registration.schema !== 'ssam-o11-neutralization-registration/1' || registration.lane !== 'o11' || registration.host !== OLD.host ||
        registration.moduleKey !== OLD.moduleKey || registration.operationId !== OLD.operationId || registration.report?.sha256 !== O11_NEUTRALIZATION_REPORT_SHA256) return false;
    const report = JSON.parse(read(registration.report));
    const time = Date.parse(report.assessedAtUtc);
    if (!Number.isFinite(time) || time > Date.now() + 30000) return false;
    const recomputed = assessO11NativeNeutralization(report.evidence, { read, now: () => time });
    return JSON.stringify(recomputed) === JSON.stringify(report);
  } catch { return false; }
}
