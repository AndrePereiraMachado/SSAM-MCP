import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessO11NativeNeutralization, hasO11NativeNeutralization, o11NeutralizationBindingHash, O11_NEUTRALIZATION_REPORT_SHA256 } from '../debug-o11-native-neutralization.mjs';
import { blockedBinding, rejectUncertainCallPath } from '../debug-o11-native-run.mjs';

function fixture() {
  const values = new Map();
  const pin = (name, value, sha256 = 'a'.repeat(64)) => { const file = path.resolve('fixture', name); values.set(file, value); return { path: file, sha256 }; };
  const host = 'personal-2qqw9srv.outsystemscloud.com', moduleKey = 'Mif02PxcH0K7KiABEHTwMg', app = 'gNS4vvu930yjPSk9Y3awUg';
  const source = 'e8562a2850c7c0392aabe9fcbf3891bc699d31af9b4f9392e7a618379e6544fc';
  const operationId = '4c7016f0a51445108b185fdcd0109586', pubId = '11111111-2222-4333-8444-555555555555';
  const q = { schema: 'ssam-o11-running-qualification/1', operationId: 'feca2954-2f0a-4c96-8ced-5b2dc5f40615', completedAtUtc: '2026-10-04T23:26:02Z',
    qualified: true, uncertain: false, startAttempted: true, startConfirmed: true, stopAttempted: true, stopConfirmed: true, readyVersionId: 5808, readyNativeHashPresent: true,
    before: { headless_CS: false, headless_UI: false }, during: { headless_CS: true, headless_UI: false }, after: { headless_CS: false, headless_UI: false },
    appRequests: 0, breakpoints: 0, evaluateCalls: 0, continueCalls: 0, killCalls: 0 };
  const qPin = pin('qualification-native.json', q, '9a230d52f4bd7ec3014ccd6b8b4fea1289cbddd92213451a44a5718b6a26a57b');
  const controller = { schema: 'ssam-o11-running-qualification-controller/1', operationId: q.operationId, state: 'qualified', target: {
    host, module: 'Headless_CS', moduleKey: 'Kawk_WFx5USxo7qFAB0lCQ', applicationKey: app }, appRequests: 0, appUserRequested: false, childExited: true, exitCode: 0,
    nativeReceiptSha256: qPin.sha256, hostDllSha256: '918896c3b7765504f343a6c43378df1090da2c86772b434a753eb1a2c9d462a7', native: q, completedAtUtc: q.completedAtUtc };
  const auth = { operationId: pubId, host, moduleKey, candidateSha256: source, baseVersionId: 5811, scope: 'ssam-debug-republish-published', words: 'fixture authorization' };
  const authPin = pin('authorization.json', auth), base = pin('base.oml', 'synthetic OML bytes', source);
  const request = { operationId: pubId, host, module: 'Headless_UI', moduleKey, applicationKey: app, message: 'SSAM Debug Republish Published',
    baseVersionId: 5811, baseSha256: source, candidateSha256: source, basePath: base.path, candidatePath: base.path, authorizationPath: authPin.path, authorizationSha256: authPin.sha256 };
  const publish = { ...request, state: 'uncertain', versionId: 0, completed: false, digest: 'd'.repeat(64) };
  const check = { ok: true, operationId: pubId, source: 'IServiceCenter.CheckPublishAsync via EnvironmentOperations.publish-check(readOnly)', sourceSha256: source,
    requestSha256: 'a'.repeat(64), target: { host, module: 'Headless_UI', moduleKey, applicationKey: app },
    outcome: { Completed: true, HasErrors: false, VersionId: 5811, ESpaceId: 436, Key: moduleKey }, publishSends: 0, appExecutions: 0, capturedAtUtc: '2026-10-04T23:22:32Z' };
  const sc = { schema: 'ssam-service-center-publication-observation/1', provenance: 'cua-read-only-dom', host, module: 'Headless_UI', moduleId: 436,
    url: 'https://' + host + '/ServiceCenter/eSpace_Edit.aspx?EspaceId=436', label: 'Last Published', lastPublishedDisplay: '2026-10-04 23:12:29',
    nativePublishedVersion: 5811, nativeSourceSha256: source, status: 'The Module is OK. No messages to show.', publicationRepeated: false, timezoneExplicit: false, capturedAtUtc: '2026-10-04T23:22:35Z' };
  const old = { schema: 'ssam-o11-metadata-correlation-receipt/1', startAttempted: true, startConfirmed: false, stopAttempted: true, stopConfirmed: false,
    startOrStopUncertain: true, markerRetained: true, appRequestsSentByProbe: 0 };
  const input = { lane: 'o11', host, moduleKey, operationId,
    nativeReceipt: pin('original-native.json', old, '3faf10952f058d32bc66d0d307ab3589c001daa43f3d72cd5b00744bbf7dd9f4'),
    controllerReceipt: pin('original-controller.json', { schema: 'ssam-o11-metadata-controller-receipt/1', operationId }),
    publicationRequest: pin('request.json', request), publicationAuthorization: authPin, publicationReceipt: pin('publication.json', publish), publishedSnapshot: base,
    publishedObservation: pin('inventory.json', { host, capturedAtUtc: '2026-10-04T23:31:00Z', modules: [{ Name: 'Headless_UI', Key: moduleKey, ApplicationKey: app, VersionId: 5811, IsActive: true }] }),
    nativePublishCheck: pin('check.json', check), serviceCenterObservation: pin('sc.json', sc), qualificationController: pin('qualification-controller.json', controller), qualificationNative: qPin };
  // Synthetic IO isolates validation; real evidence bytes/OML never enter tests.
  const read = pin => { if (!values.has(pin.path)) throw Error('missing_fixture'); const value = values.get(pin.path); return typeof value === 'string' ? value : JSON.stringify(value); };
  const services = { read, now: () => Date.parse('2026-10-04T23:31:10Z') };
  return { input, values, services, read, old, q, controller, check, sc, request, publish };
}

test('qualified native state permits new operations while keeping old and publication uncertainty', () => {
  const f = fixture(), before = JSON.stringify(f.old), report = assessO11NativeNeutralization(f.input, f.services);
  assert.equal(report.nativeDebuggerInactive, true); assert.equal(report.newBindingOperationsAllowed, true);
  assert.equal(report.oldOperationReplayAllowed, false); assert.equal(report.originalStartStopStillHistoricallyUncertain, true);
  assert.equal(report.publication.desiredPublishedStateConfirmed, true); assert.equal(report.publication.publicationOperationIdentityProved, false);
  assert.equal(report.publication.publicationLockReleaseAllowed, false); assert.equal(report.debuggerObservation.pendingTraceEnumerationClaimed, false);
  assert.equal(JSON.stringify(f.old), before); assert.equal(f.publish.state, 'uncertain'); assert.equal(report.writes, 0);
});

test('wrong lane/host/module/old operation and altered original pin are refused', () => {
  const f = fixture();
  for (const patch of [{ lane: 'odc' }, { host: 'another.example.test' }, { moduleKey: 'Kawk_WFx5USxo7qFAB0lCQ' }, { operationId: 'another' },
    { nativeReceipt: { ...f.input.nativeReceipt, sha256: '0'.repeat(64) } }]) assert.throws(() => assessO11NativeNeutralization({ ...f.input, ...patch }, f.services), /historical_binding_invalid/);
  f.old.stopConfirmed = true; assert.throws(() => assessO11NativeNeutralization(f.input, f.services), /historical_receipt_invalid/);
});

test('same published head alone and a non-qualifying transition cannot release a binding', () => {
  const f = fixture(); f.check.outcome.Completed = false;
  assert.throws(() => assessO11NativeNeutralization(f.input, f.services), /native_publish_check_invalid/);
  f.check.outcome.Completed = true; f.sc.status = 'Publication in progress';
  assert.throws(() => assessO11NativeNeutralization(f.input, f.services), /service_center_observation_invalid/);
  f.sc.status = 'The Module is OK. No messages to show.'; f.q.after.headless_UI = true;
  assert.throws(() => assessO11NativeNeutralization(f.input, f.services), /qualification_invalid/);
});

test('registered approved assessment is rechecked historically; changed evidence fails closed', () => {
  const f = fixture(), report = assessO11NativeNeutralization(f.input, f.services);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-neutralization-'));
  try {
    const directory = path.join(root, '.local/debugger/reconciled-bindings'); fs.mkdirSync(directory, { recursive: true });
    const reportPin = { path: path.join(root, '.local/report.json'), sha256: O11_NEUTRALIZATION_REPORT_SHA256 }; f.values.set(reportPin.path, report);
    const registration = { schema: 'ssam-o11-neutralization-registration/1', ...Object.fromEntries(['lane', 'host', 'moduleKey', 'operationId'].map(n => [n, f.input[n]])), report: reportPin };
    const file = path.join(directory, o11NeutralizationBindingHash(f.input.host, f.input.moduleKey) + '.json'); fs.writeFileSync(file, JSON.stringify(registration));
    assert.equal(hasO11NativeNeutralization(root, f.input, { read: f.read }), true);
    f.check.outcome.HasErrors = true; assert.equal(hasO11NativeNeutralization(root, f.input, { read: f.read }), false); f.check.outcome.HasErrors = false;
    registration.lane = 'odc'; fs.writeFileSync(file, JSON.stringify(registration)); assert.equal(hasO11NativeNeutralization(root, f.input, { read: f.read }), false);
    assert.equal(blockedBinding(root, f.input.host, f.input.moduleKey).operationId, f.input.operationId);
    const node = { id: 'entry', moduleKey: f.input.moduleKey, startNodeKey: 'LiCk5pmr6Ueb45499t9tNw' };
    assert.throws(() => rejectUncertainCallPath({ nodes: new Map([['entry', node]]), callees: new Map() }, 'entry', f.input.host, root), /crosses_uncertain_breakpoint/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
