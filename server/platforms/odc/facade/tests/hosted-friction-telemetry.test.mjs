// The telemetry of a hosted customer (fase4-28 R1, review item F5): the store that records the calls of the served mode
// and every reader of it (ssam_friction issues and delivery-kpi) take their folders from one resolver
// (friction-store.mjs frictionPaths), by backend and by lane. With SSAM_BACKEND_NAME set (the production servers) the
// index is written per backend and the KPI read only index/; the kernel's receipts were looked for in
// <ws>/kernel/.local/work/deliver while a customer's kernel writes them in <ws>/o11/work/deliver; and every failure of
// the hosted handler answered "use issues or task with an explicit taskId". Here the served wiring of ssam.mjs records a
// delivery and answers the views, with and without SSAM_BACKEND_NAME.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ssam from '../ssam.mjs';
import * as frictionStore from '../../../../facade/friction-store.mjs';
import * as boundary from '../../../../facade/friction-boundary.mjs';

delete process.env.SSAM_FRICTION_DIR;
const TASK = '0123456789abcdef0123456789abcdef';
// (read through the namespaces, so the same file shows what the served wiring of a line without them does)
const storeOptions = ssam.customerFrictionStoreOptions ?? (ws => ({ root: ws, directory: ssam.customerFrictionDirectory(ws) }));
const handlerOf = ssam.frictionToolHandler ?? ((b, store) => async (input = {}) => {
  try { const value = b.readQueue(store, input); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }
  catch { return { isError: true, content: [{ type: 'text', text: 'Invalid friction query; use issues or task with an explicit taskId.' }] }; }
});
const observerOf = ssam.servedFrictionObserver ?? (({ frictionStore: fs_, meta }) => store => params => {
  const lane = fs_.laneName(params.arguments?.lane);
  const op = store.begin({ ...meta, interface: 'mcp', operation: fs_.operationName(params.name), lane: lane === 'unknown' ? 'o11' : lane, correlationSource: 'absent' });
  return { finish: message => op.finish(message.result ?? message.error, { protocolError: !!message.error }) };
});
const answerOf = result => result.structuredContent ?? JSON.parse(result.content[0].text);

function withBackend(name, fn) {
  const saved = process.env.SSAM_BACKEND_NAME;
  if (name === undefined) delete process.env.SSAM_BACKEND_NAME; else process.env.SSAM_BACKEND_NAME = name;
  return Promise.resolve().then(fn).finally(() => { if (saved === undefined) delete process.env.SSAM_BACKEND_NAME; else process.env.SSAM_BACKEND_NAME = saved; });
}
// A customer's workspace with one o11_deliver recorded by the served observer and its kernel receipt where the customer's
// kernel writes it (the O11 lane work folder of the workspace).
function customer(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-hosted-friction-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const store = frictionStore.createStore({ ...storeOptions(workspace), warning: () => {} });
  const observe = observerOf({ frictionStore, meta: { sessionId: '44444444-4444-4444-8444-444444444444', lane: 'unknown' } })(store);
  const call = observe({ name: 'o11_deliver', arguments: { lane: 'o11', module: 'Orders_CS', job: 'ws:o11/jobs/a.json', authorize: 'the words' } });
  const value = { ok: true, result: 'delivered', module: 'Orders_CS', taskId: TASK };
  call.finish({ result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } });
  const now = Date.now();
  const receipt = path.join(workspace, 'o11', 'work', 'deliver', TASK, 'result.json');
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify({ delivered: true, history: [{ stage: 'registered', time: new Date(now - 30000).toISOString() }, { stage: 'complete', time: new Date(now - 1000).toISOString() }] }));
  return { workspace, handler: handlerOf(boundary, store) };
}

for (const backend of [undefined, 'o11-11.55.93-odc-1.7.29']) {
  const named = backend ? 'with SSAM_BACKEND_NAME=' + backend : 'without SSAM_BACKEND_NAME';
  test('hosted ssam_friction ' + named + ': delivery-kpi and issues see the delivery the served observer recorded and its kernel receipt', t => withBackend(backend, async () => {
    const c = customer(t);
    const kpi = answerOf(await c.handler({ view: 'delivery-kpi' }));
    assert.equal(kpi.ok, true, JSON.stringify(kpi));
    assert.ok(kpi.sources.indexFiles >= 1, 'the index the store wrote: ' + JSON.stringify(kpi.sources));
    assert.equal(kpi.logical, 1, 'one logical delivery');
    assert.deepEqual(kpi.sources.receipts, { read: 1, damaged: 0, outside: 0 }, 'the receipt in the customer\'s O11 lane work folder');
    const issues = answerOf(await c.handler({ view: 'issues' }));
    assert.notEqual(issues.ok, false, JSON.stringify(issues));
    assert.equal(issues.health?.source, 'index');
    if (backend) assert.ok(fs.existsSync(path.join(c.workspace, '.local', 'friction', 'index', 'versions', backend)), 'written in this backend\'s index');
  }));
}

test('a hosted friction query that is not valid says why and lists the fields of each view, never a generic text', t => withBackend('o11-11.55.93-odc-1.7.29', async () => {
  const c = customer(t);
  const refused = await c.handler({ view: 'issues', since: '2026-10-01' });
  assert.equal(refused.isError, true);
  const value = answerOf(refused);
  assert.equal(value.code, 'FRICTION_QUERY_INVALID');
  assert.match(value.error, /\bsince is not a field of view issues\b/);
  assert.deepEqual(value.views?.['delivery-kpi'], ['view', 'since', 'until', 'lane']);
  assert.ok(value.views.issues.includes('taskId'));
  const kpi = answerOf(await c.handler({ view: 'delivery-kpi', since: 'yesterday' }));
  assert.match(kpi.error, /^Invalid delivery-kpi query: since\/until/);
}));

test('the stdio relay and the served mode answer one refusal (friction-boundary.mjs frictionRefusal)', () => {
  assert.equal(typeof boundary.frictionRefusal, 'function');
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'facade', 'friction-boundary.mjs'), 'utf8');
  assert.doesNotMatch(source, /Invalid friction query; use/, 'no generic refusal left in the relay');
  const failure = boundary.frictionRefusal(new Error('EACCES: permission denied'));
  assert.equal(failure.error, 'The friction queue could not answer this query: EACCES: permission denied');
});

test('hosted ODC receipts use the same lane resolver and measured timestamps', t => withBackend('telemetry-odc', async () => {
  const c = customer(t);
  const dir = path.join(c.workspace, 'odc', 'lab', '01-change');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'deliver-result.json'), JSON.stringify({ ok: true, merged: true,
    startedAt: new Date(Date.now() - 2000).toISOString(), completedAt: new Date().toISOString() }));
  const result = answerOf(await c.handler({ view: 'delivery-kpi', lane: 'odc' }));
  assert.equal(result.sources.receipts.read, 2, 'both native receipt layouts are read');
  assert.equal(result.sources.receipts.damaged, 0);
}));
