import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPortalBroker } from '../hosted/credential-agent.mjs';
import { publicPortalMetadata, PUBLIC_METADATA_NOTE } from '../hosted/portal-public-metadata.mjs';
import { boundedRead } from '../read-budget.mjs';

const host = 'tenant.outsystems.dev', origin = `https://${host}`;
const reply = (text, status = 200) => ({ status, arrayBuffer: async () => Buffer.from(text), body: { cancel: async () => {} } });
const assets = new Map([
  ['/monitoring/moduleservices/moduleversioninfo', '{"versionToken":"module1"}'],
  ['/monitoring/', '<script src="scripts/_osbundle-test.index.js"></script>'],
  ['/monitoring/scripts/_osbundle-test.index.js', 'screenName:"logs.logs",load:import("./logs.js")'],
  ['/monitoring/scripts/logs.js', 'x("screenservices/monitoring/logs/logs/DataActionGetFilter_Stages","api1")'],
]);

test('public API version survives a short private cookie without relaxing authenticated redaction', async () => {
  const privateCalls = [], publicCalls = [];
  const agent = { async call(_host, _service, _op, args) {
    privateCalls.push(args);
    // Baseline obtains assets through this redacted private channel.
    if (args.method === 'GET') return { status: 200, body: Buffer.from(assets.get(new URL(args.url).pathname).replaceAll('1', '[redacted]')).toString('base64') };
    const request = JSON.parse(Buffer.from(args.body, 'base64'));
    const changed = request.versionInfo.moduleVersion !== 'module1' || request.versionInfo.apiVersion !== 'api1';
    return { status: 200, body: Buffer.from(JSON.stringify({ versionInfo: { hasApiVersionChanged: changed }, data: { items: [], privateValue: '[redacted]' } })).toString('base64'), notes: ['Sensitive authentication values were removed from the response.'] };
  } };
  const broker = new AgentPortalBroker(agent, host, 'a'.repeat(64), { publicFetch: async (url, options) => {
    publicCalls.push({ url, options }); return reply(assets.get(new URL(url).pathname));
  } });
  const result = await broker.callScreenservice({ operationId: 'monitoring.stages' });
  assert.equal(result.data.privateValue, '[redacted]');
  assert.equal(privateCalls.length, 1); assert.equal(privateCalls[0].method, 'POST');
  assert.equal(publicCalls.length, 4);
  for (const {options} of publicCalls) assert.deepEqual(Object.keys(options).sort(), ['method', 'signal']);
  assert.ok(broker.privateNotes.includes(PUBLIC_METADATA_NOTE));
  assert.ok(broker.privateNotes.includes('Sensitive authentication values were removed from the response.'));
});

test('public metadata refuses other origins, private paths, encodings, fragments and writes before fetch', async () => {
  let calls = 0; const read = publicPortalMetadata(origin, { fetch: async () => { calls++; return reply('x'); } });
  for (const path of ['https://other.example/monitoring/', `${origin}/api/private`, `${origin}/monitoring/screenservices/action`, `${origin}/monitoring/%2e%2e/scripts/x.js`, `${origin}/monitoring/scripts/../x.js`, `${origin}/monitoring/#x`, `https://user@${host}/monitoring/`])
    await assert.rejects(read(path), { code: 'PORTAL_ORIGIN_DENIED' });
  await assert.rejects(read(`${origin}/monitoring/`, { method: 'POST' }), { code: 'PORTAL_ORIGIN_DENIED' });
  await assert.rejects(read(`${origin}/monitoring/`, { body: 'x' }), { code: 'PORTAL_ORIGIN_DENIED' });
  assert.equal(calls, 0);
});

test('unavailable public metadata fails closed without authenticated asset fallback or action POST', async () => {
  for (const status of [301, 302, 401, 403, 404]) {
    let privateCalls = 0, publicCalls = 0;
    const broker = new AgentPortalBroker({ call: async () => { privateCalls++; throw new Error('No fallback'); } }, host, null,
      { publicFetch: async () => { publicCalls++; return reply('', status); } });
    await assert.rejects(broker.callScreenservice({ operationId: 'monitoring.stages' }), { code: 'PORTAL_CONTRACT_CHANGED' });
    assert.equal(publicCalls, 1); assert.equal(privateCalls, 0);
  }
});

test('public metadata has size, UTF-8 and inherited deadline bounds', async () => {
  for (const bytes of [Buffer.alloc(4 * 1024 * 1024 + 1), Buffer.from([0xff])]) {
    const read = publicPortalMetadata(origin, { fetch: async () => ({ status: 200, arrayBuffer: async () => bytes }) });
    await assert.rejects(read(`${origin}/monitoring/`), { code: 'PORTAL_CONTRACT_CHANGED' });
  }
  const read = publicPortalMetadata(origin, { fetch: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) });
  const result = await boundedRead('public-metadata-deadline', () => read(`${origin}/monitoring/`), { timeoutMs: 10 });
  assert.equal(result.code, 'READ_DEADLINE_EXCEEDED');
});
