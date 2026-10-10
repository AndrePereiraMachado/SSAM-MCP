// The Portal operation messages in the shape of the Studio's publish-log, offline. The fakes follow the catalogued
// schemas: deployments-api-v1 publish-operations/{key}/messages and deployment-operations/{key}/messages
// (StringMessageDetailsV1TaskProgressMessagePagedListResponse {page, results[MessageDetailsV1TaskProgressMessage]}) and
// build-operations-api-v1 build-operations/{key}/log-messages (BuildFeedbackDetailsResponse {results[BuildFeedbackDetails]}).
import test from 'node:test';
import assert from 'node:assert/strict';
import { elementCandidates, fixContinuation, logOf, normalizeMessage, portalMessages, stageOf, withOperationLog } from '../runtime/operation-log.mjs';

const ASSET = '33333333-3333-4333-8333-333333333333';
const publishMessages = { page: { offset: 0, limit: 50, total: 3 }, results: [
  { timestamp: '2026-10-04T15:00:01Z', type: 'PublishStarted', severity: 'Info', message: 'Publishing GameStore', additionalInfo: { stepId: 'Upload', assetKey: ASSET } },
  { timestamp: '2026-10-04T15:00:30Z', type: 'OS-BLD-40001', severity: 'Error', message: "Invalid SQL in 'GetTopSellers': column 'Pricee' does not exist", additionalInfo: { stepId: 'Compilation', assetKey: ASSET } },
  { timestamp: '2026-10-04T15:00:31Z', type: null, severity: 'Warning', message: 'Deprecated widget used', additionalInfo: null },
] };
const buildLog = { results: [
  { timestamp: '2026-10-04T15:00:30Z', type: 'compile', severity: 'Error', message: "Attribute 'Product.Pricee' does not exist", stepId: 'CodeGeneration', assetKey: ASSET, errorCode: 'OS-BLD-40002' },
] };

test('publish and build messages become {type, text, element, stage} with code, time and step', () => {
  const [info, error, warning] = portalMessages(publishMessages);
  assert.deepEqual(info, { type: 'info', text: 'Publishing GameStore', stage: 'upload', element: null, code: 'PublishStarted', at: '2026-10-04T15:00:01Z', stepId: 'Upload', assetKey: ASSET });
  assert.deepEqual(error, { type: 'error', text: "Invalid SQL in 'GetTopSellers': column 'Pricee' does not exist", stage: 'compilation',
    element: { name: 'GetTopSellers', key: null, kind: null, source: 'text' }, code: 'OS-BLD-40001', at: '2026-10-04T15:00:30Z', stepId: 'Compilation', assetKey: ASSET });
  assert.deepEqual(warning, { type: 'warning', text: 'Deprecated widget used', stage: 'unknown', element: null, at: '2026-10-04T15:00:31Z' });
  const [build] = portalMessages(buildLog);
  assert.equal(build.stage, 'generation'); assert.equal(build.code, 'OS-BLD-40002'); assert.equal(build.element.name, 'Product.Pricee');
  assert.deepEqual(portalMessages([{ message: 'done' }]), [{ type: 'info', text: 'done', stage: 'unknown', element: null }]);
  assert.equal(normalizeMessage({ message: '  ' }), null);
});

test('stages and element names follow the shared rules', () => {
  assert.deepEqual(['Upload', 'Validation', 'CodeGeneration', 'Compile', 'DatabaseUpgrade', 'Deploy', 'Weird-Step', null].map(stageOf),
    ['upload', 'validation', 'generation', 'compilation', 'database', 'deploy', 'weird-step', 'unknown']);
  assert.deepEqual(elementCandidates("The module's 'Checkout' screen and ‘Order.Total’ failed"), ['Checkout', 'Order.Total']);
  const log = logOf(portalMessages(publishMessages), 'FinishedWithError');
  assert.deepEqual(log.counts, { errors: 1, warnings: 1, infos: 1 });
  assert.deepEqual(log.stages, ['upload', 'compilation']);
  assert.match(log.summary, /^FinishedWithError: 1 error\(s\), 1 warning\(s\); first error: Invalid SQL/);
});

test('a failed publish/build/deployment status carries log and the fix; a running or other kind does not change', () => {
  const failed = withOperationLog({ ok: true, kind: 'publish', status: 'FinishedWithError', failed: true, terminal: true, messages: publishMessages });
  assert.equal(failed.log.messages.length, 3);
  assert.equal(failed.messages, publishMessages, 'the raw answer stays');
  assert.equal(failed.continuation.tool, 'ssam_discover', 'no module on the Portal side: the intent');
  assert.match(failed.continuation.why, /compilation.*GetTopSellers/);
  const withModule = fixContinuation({ module: 'GameStore', messages: failed.log.messages });
  assert.deepEqual(withModule.arguments, { lane: 'odc', target: 'GameStore', name: 'GetTopSellers' });
  const deploy = withOperationLog({ ok: true, kind: 'deployment', status: 'FinishedWithError', failed: true, messages: { results: [{ severity: 'Error', message: 'Stage QA has no configuration for setting ApiUrl' }] } });
  assert.match(deploy.continuation.why, /implante de novo/);
  const running = { ok: true, kind: 'publish', status: 'Running', failed: false, continuation: { tool: 'odc_operation_status' } };
  assert.equal(withOperationLog(running), running, 'no messages read: unchanged');
  const analysis = { ok: true, kind: 'code-analysis', messages: [] };
  assert.equal(withOperationLog(analysis), analysis);
  const unreadable = { ok: true, kind: 'publish', messages: { error: { code: 'X' } } };
  assert.equal(withOperationLog(unreadable), unreadable);
});
