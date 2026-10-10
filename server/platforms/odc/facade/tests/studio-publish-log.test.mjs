// Publish errors of the ODC Studio, offline: the bridge is a fake whose answers have the shape of the v35 bridge's
// publish-log (PublishLogCommands.cs) and of its publish --wait refusal (publishLog). No Studio, pipe or tenant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishRefusal, publishWithLog, shapePublishLog, studioPublishLog } from '../studio-publish-log.mjs';
import { isWrite } from '../studio-write-lock.mjs';

const KEY = 'Rx5hKQ0bZEm7TQ3f0vVd1A';
// What `publish-log GameStore` answers after a publication the person started in the Studio failed in compilation.
const failedLog = (over = {}) => ({
  ok: true, module: 'GameStore', moduleKey: 'gZ5lM8k1H0qkC4z1lJ0p8w', host: 'personal-test.outsystems.dev', found: true, fromCache: false, source: 'ServerMessagesPane',
  lastPublish: {
    operation: 'Publish', serverOperationId: 7, state: 'CompletedWithFailure', innerState: 'Compiling', running: false, completed: true, succeeded: false, failed: true,
    publicationKey: '9d7c2f8e-5d2b-4f7e-9a51-0b6f3c1a2e44', revision: 12, lastUploadAt: '2026-10-04T15:01:02.000Z', lastUploadUser: 'dev@example.test', durationSeconds: 41.5,
    ssamDispatchedAt: null, summary: "CompletedWithFailure: 1 error(s), 1 warning(s); first error: Invalid SQL in 'GetTopSellers': column 'Pricee' does not exist",
    stages: ['upload', 'compilation'], lastStage: 'compilation', counts: { errors: 1, warnings: 1, infos: 0 },
    messages: [
      { type: 'warning', text: "Unused screen 'OldHome'", detail: null, stage: 'compilation', element: { name: 'OldHome', key: null, kind: null, source: 'text' }, code: null },
      { type: 'error', text: "Invalid SQL in 'GetTopSellers': column 'Pricee' does not exist", detail: null, stage: 'compilation', element: { name: 'GetTopSellers', key: KEY, kind: 'ServerAction', source: 'model' }, code: null },
    ],
    ...over,
  },
});

test('publish-log: a failed publication answers every message and the read of the element to fix', () => {
  const out = shapePublishLog(failedLog());
  assert.equal(out.lastPublish.messages.length, 2);
  assert.deepEqual(out.continuation.tool, 'studio_inspect');
  assert.deepEqual(out.continuation.arguments, { target: 'GameStore', path: '@' + KEY, depth: 3 });
  assert.match(out.continuation.why, /compilation.*Invalid SQL in 'GetTopSellers'.*GetTopSellers \(ServerAction\).*studio_deliver.*palavras do usuário/s);
  // The publication key the Studio polled gives the same messages from the Portal, with stepId and time.
  assert.deepEqual(out.serverLog.arguments, { kind: 'publish', operationKey: '9d7c2f8e-5d2b-4f7e-9a51-0b6f3c1a2e44', messages: true });
  assert.equal(out.serverLog.tool, 'odc_operation_status');
});

test('publish-log: element by name only -> ssam_map; no element -> ssam_discover; success -> no continuation', () => {
  const byName = failedLog(); byName.lastPublish.messages[1].element = { name: 'GetTopSellers', key: null, kind: null, source: 'text' };
  assert.deepEqual(shapePublishLog(byName).continuation.arguments, { lane: 'odc', target: 'GameStore', name: 'GetTopSellers' });
  const bare = failedLog(); bare.lastPublish.messages = [{ type: 'error', text: 'Generation failed', detail: null, stage: 'unknown', element: null, code: null }];
  const discover = shapePublishLog(bare).continuation;
  assert.equal(discover.tool, 'ssam_discover');
  assert.deepEqual(discover.arguments, { intent: 'corrigir erro de publicação ODC: Generation failed', lane: 'odc' });
  const ok = shapePublishLog(failedLog({ state: 'CompletedWithSuccessNotOpenedInBrowser', failed: false, succeeded: true, messages: [], counts: { errors: 0, warnings: 0, infos: 0 } }));
  assert.equal(ok.continuation, undefined);
});

test('publish-log: running -> wait; nothing in this Studio -> the Portal publish operations; refusals pass through', () => {
  const running = shapePublishLog(failedLog({ running: true, completed: false, failed: false, state: 'Running', messages: [] }));
  assert.deepEqual(running.continuation.arguments, { condition: 'published', module: 'GameStore' });
  const none = shapePublishLog({ ok: true, module: 'GameStore', moduleKey: 'k', found: false, source: 'ServerMessagesPane', note: 'No publication' });
  assert.equal(none.continuation.tool, 'odc_read');
  assert.equal(none.continuation.arguments.operationId, 'deployments-api-v1:get:/publish-operations');
  const refused = { ok: false, error: 'Expected exactly one open X; found 0.' };
  assert.equal(shapePublishLog(refused), refused);
});

test('studio_command publish-log relays to the bridge with the module and --no-resolve, read-only for the write lock', async () => {
  const calls = [];
  const studio = async (args, pid) => { calls.push([args, pid]); return failedLog(); };
  const out = await studioPublishLog(['GameStore', '--no-resolve'], 4242, { studio });
  assert.deepEqual(calls, [[['publish-log', 'GameStore', '--no-resolve'], 4242]]);
  assert.equal(out.continuation.tool, 'studio_inspect');
  assert.equal(isWrite('studio_command', { command: 'publish-log' }), false);
  assert.equal(isWrite('studio_command', { command: 'stop' }), true);
});

test('studio_publish refused after the dispatch carries the publish log (bridge v35 publishLog)', async () => {
  const calls = [];
  const bridgeRefusal = { ok: false, outcome: 'uncertain', gate: 'none', error: 'Publication of GameStore ended in state CompletedWithFailure with 1 error(s) and 1 warning(s). Publication did not complete with success; publishLog carries every message of the Studio messages pane (type, text, element, stage).',
    dialogsClosed: [], publishLog: failedLog() };
  const studio = async args => { calls.push(args); return bridgeRefusal; };
  const out = await publishWithLog({ manifest: 'lab/x/manifest.json', wait: true, minutes: 10 }, { studio, moduleOf: () => 'GameStore' });
  assert.deepEqual(calls, [['publish', 'lab/x/manifest.json', '--wait', '10']], 'one call: the log came with the refusal');
  assert.equal(out.ok, false); assert.equal(out.code, 'PUBLISH_FAILED'); assert.equal(out.outcome, 'uncertain');
  assert.equal(out.publishLog.module, 'GameStore');
  assert.equal(out.publishLog.messages.length, 2);
  assert.equal(out.publishLog.messages[1].element.key, KEY);
  assert.match(out.summary, /1 error\(s\)/);
  assert.equal(out.continuation.tool, 'studio_inspect');
});

test('studio_publish: an older bridge without publishLog gets one publish-log; a refusal before the dispatch is unchanged', async () => {
  const calls = [];
  const studio = async args => { calls.push(args); return args[0] === 'publish' ? { ok: false, error: 'System.InvalidOperationException: Publication of GameStore ended in state CompletedWithFailure. x' } : failedLog(); };
  const out = await publishWithLog({ manifest: 'm.json', wait: true, minutes: 5 }, { studio, moduleOf: () => 'GameStore' });
  assert.deepEqual(calls.map(c => c[0]), ['publish', 'publish-log']);
  assert.deepEqual(calls[1], ['publish-log', 'GameStore']);
  assert.equal(out.code, 'PUBLISH_FAILED'); assert.equal(out.publishLog.counts.errors, 1);
  const before = { ok: false, error: 'publish requires manifest.publishAuthorization with the user\'s explicit authorization text.' };
  const untouched = await publishWithLog({ manifest: 'm.json' }, { studio: async () => before, moduleOf: () => 'GameStore' });
  assert.equal(untouched, before);
  const running = publishRefusal({ ok: false, error: 'Publication of GameStore is still running after 10 min; use publish-log' }, failedLog({ running: true, state: 'Running', failed: false }));
  assert.equal(running.code, 'PUBLISH_RUNNING'); assert.equal(running.continuation.tool, 'studio_wait');
  const success = { ok: true, completed: true };
  assert.equal(await publishWithLog({ manifest: 'm.json' }, { studio: async () => success }), success);
});
