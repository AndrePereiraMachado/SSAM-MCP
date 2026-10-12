import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectO11RepublishNeutralization, o11RemoteDebugAbsenceCapability } from '../debug-o11-republish-reconcile.mjs';

const nativeHash = '3faf10952f058d32bc66d0d307ab3589c001daa43f3d72cd5b00744bbf7dd9f4';
const sourceHash = 'e8562a2850c7c0392aabe9fcbf3891bc699d31af9b4f9392e7a618379e6544fc';
function fixture() {
  const values = new Map(), pin = (name, value, sha256 = 'a'.repeat(64)) => { values.set(name, value); return { path: name, sha256 }; };
  const operationId = '4c7016f0a51445108b185fdcd0109586', publishedId = '11111111-2222-4333-8444-555555555555';
  const request = { operationId: publishedId, host: 'personal-2qqw9srv.outsystemscloud.com', module: 'Headless_UI',
    moduleKey: 'Mif02PxcH0K7KiABEHTwMg', applicationKey: 'gNS4vvu930yjPSk9Y3awUg', baseVersionId: 5811,
    baseSha256: sourceHash, candidateSha256: sourceHash, basePath: 'base.oml', candidatePath: 'candidate.oml',
    authorizationPath: 'auth.json', authorizationSha256: 'a'.repeat(64), message: 'SSAM Debug Republish Published' };
  const authorization = { ...request, scope: 'ssam-debug-republish-published', words: 'Autorizar somente a republicação 5811 em DEV' };
  const receipt = { ...request, state: 'published', started: true, completed: true, hasErrors: false, versionId: 5812 };
  const observed = { host: request.host, capturedAtUtc: '2026-10-04T23:00:00Z', modules: [{ Name: request.module,
    Key: request.moduleKey, ApplicationKey: request.applicationKey, VersionId: receipt.versionId, IsActive: true }] };
  const input = { operationId,
    nativeReceipt: pin('native.json', { schema: 'ssam-o11-metadata-correlation-receipt/1', startAttempted: true, startConfirmed: false,
      stopAttempted: true, stopConfirmed: false, startOrStopUncertain: true, markerRetained: true, appRequestsSentByProbe: 0 }, nativeHash),
    controllerReceipt: pin('controller.json', { schema: 'ssam-o11-metadata-controller-receipt/1', operationId, childExited: true }),
    publicationRequest: pin('request.json', request), publicationAuthorization: pin('auth.json', authorization),
    publicationReceipt: pin('publish.json', receipt), publishedObservation: pin('observed.json', observed),
    baseSnapshot: pin('base.oml', 'OML', request.baseSha256), candidateSnapshot: pin('candidate.oml', 'OML', request.candidateSha256),
    publishedSnapshot: pin('published.oml', 'OML', request.candidateSha256) };
  const reads = [], services = { now: () => Date.parse('2026-10-04T23:01:00Z'),
    read: pin => { reads.push(pin.path); return typeof values.get(pin.path) === 'string' ? values.get(pin.path) : JSON.stringify(values.get(pin.path)); } };
  return { input, request, receipt, authorization, observed, values, services, reads };
}

test('confirmed exact republish is recorded without claiming the unknown debugger session ended', () => {
  const f = fixture(), result = inspectO11RepublishNeutralization(f.input, f.services);
  assert.equal(result.publication.confirmed, true); assert.equal(result.publication.baseVersionId, 5811);
  assert.equal(result.publication.publishedVersionId, 5812); assert.equal(result.state, 'blocked');
  assert.equal(result.releaseAllowed, false); assert.equal(result.markerRetained, true); assert.equal(result.historicalUncertaintyPreserved, true);
  assert.equal(result.startCalls, 0); assert.equal(result.stopCalls, 0); assert.equal(result.networkRequests, 0); assert.equal(result.evidenceModified, false);
});

test('ping/inDebug/GetIsRunning/local trace and caller booleans cannot authorize guard release', () => {
  const f = fixture();
  const result = inspectO11RepublishNeutralization({ ...f.input, remoteObservation: { getIsRunning: false, inDebug: true,
    nativeSessionAbsent: true, pendingTraces: [], sessionQualification: 'production', workerExited: true } }, f.services);
  assert.equal(result.remoteSessionAbsenceProved, false); assert.equal(result.pendingRemoteTracesAbsenceProved, false);
  assert.equal(result.releaseAllowed, false); assert.equal(o11RemoteDebugAbsenceCapability().qualified, false);
});

test('reconciliation refuses a changed original receipt or another operation', () => {
  const f = fixture();
  assert.throws(() => inspectO11RepublishNeutralization({ ...f.input, operationId: 'another' }, f.services), /historical_binding_invalid/);
  assert.throws(() => inspectO11RepublishNeutralization({ ...f.input, nativeReceipt: { ...f.input.nativeReceipt, sha256: '0'.repeat(64) } }, f.services), /historical_binding_invalid/);
  f.values.get('native.json').stopConfirmed = true;
  assert.throws(() => inspectO11RepublishNeutralization(f.input, f.services), /historical_receipt_invalid/);
});

test('unconfirmed publication, changed source or another live revision cannot be adopted', () => {
  const f = fixture(); f.receipt.state = 'uncertain';
  assert.throws(() => inspectO11RepublishNeutralization(f.input, f.services), /publication_not_confirmed/);
  f.receipt.state = 'published'; f.request.candidateSha256 = 'c'.repeat(64);
  assert.throws(() => inspectO11RepublishNeutralization(f.input, f.services), /publication_request_mismatch/);
  f.request.candidateSha256 = f.request.baseSha256; f.observed.modules[0].VersionId = 5813;
  assert.throws(() => inspectO11RepublishNeutralization(f.input, f.services), /published_observation_mismatch/);
});

test('the native publication inventory must be fresh and contain exactly the active module', () => {
  const f = fixture(); f.observed.capturedAtUtc = '2026-10-04T22:00:00Z';
  assert.throws(() => inspectO11RepublishNeutralization(f.input, f.services), /published_observation_stale/);
  f.observed.capturedAtUtc = '2026-10-04T23:00:00Z'; f.observed.modules[0].IsActive = false;
  assert.throws(() => inspectO11RepublishNeutralization(f.input, f.services), /published_observation_mismatch/);
  f.observed.modules[0].IsActive = true; f.observed.modules.push({ ...f.observed.modules[0] });
  assert.throws(() => inspectO11RepublishNeutralization(f.input, f.services), /published_observation_mismatch/);
});

test('original publication authorization remains bound to scope and 5811', () => {
  const f = fixture(); f.authorization.baseVersionId = 5812;
  assert.throws(() => inspectO11RepublishNeutralization(f.input, f.services), /publication_authorization_mismatch/);
  f.authorization.baseVersionId = 5811; f.authorization.scope = 'ssam-debug-wrapper-create-remove';
  assert.throws(() => inspectO11RepublishNeutralization(f.input, f.services), /publication_authorization_mismatch/);
});
