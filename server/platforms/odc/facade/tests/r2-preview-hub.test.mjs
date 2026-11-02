// fase4-28 r2-preview: the hub side of screen.render (DESENHO-PREVIEW-UPLOAD 2.3 and 4.2) over the real hub by HTTP/NDJSON:
// the kind at the end of CALL_KINDS (supports() of an agent without kinds unchanged), the "only if the Hello lists it" gate
// as one set, parameters above 512 KiB as a paramsBlob, a value as a valueBlob, and the deadline on the line of a call the
// hub writes again after a reconnection (the agent reads that deadline; the hub waits one reconnectGraceMs more).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as hubModule from '../agent-hub.mjs';
import { startHub, scriptedAgent, BASE_KINDS, waitFor } from './fixtures/render-hub.mjs';

test('screen.render and then o11.users are the last call kinds; the nine of protocol 1 are unchanged; the Hello-only gate is one set', () => {
  assert.deepEqual(hubModule.CALL_KINDS.slice(-5), ['screen.render', 'o11.users', 'o11.xif', 'credential.session', 'document.fetch']); // F4: o11.xif; r40a: credential.session; r40: document.fetch last
  assert.deepEqual(hubModule.CALL_KINDS.slice(0, 9), ['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected', 'file.put', 'file.get', 'file.list']);
  assert.ok(hubModule.HELLO_ONLY_KINDS instanceof Set, 'HELLO_ONLY_KINDS is a Set');
  // fase4-28/r2: R2-G's file.upload is the set's other entry (one gate for both Hello-only kinds).
  assert.deepEqual([...hubModule.HELLO_ONLY_KINDS], ['file.upload', 'screen.render', 'o11.users', 'o11.xif', 'credential.session', 'document.fetch']);
});

test('an agent whose Hello does not list screen.render never receives the call (KIND_NOT_ALLOWED, nothing written)', async t => {
  const hub = await startHub(); t.after(() => hub.close());
  for (const kinds of [BASE_KINDS, null]) {
    const agent = scriptedAgent(hub.base, hub.token.agentCredential, { kinds });
    await agent.connect(); t.after(() => agent.close());
    const link = hub.link();
    assert.equal(link.supports('screen.render'), false);
    await assert.rejects(link.call('screen.render', { schema: 'ssam-render-request/1' }), error => error.code === 'KIND_NOT_ALLOWED' && /does not advertise screen\.render/.test(error.message));
    await new Promise(r => setTimeout(r, 100));
    assert.equal(agent.calls.length, 0, 'no call line reached the agent');
    agent.close();
  }
});

test('a capable agent receives screen.render; parameters above 512 KiB arrive as a paramsBlob; the facts come back as a valueBlob', async t => {
  const hub = await startHub(); t.after(() => hub.close());
  const facts = { schema: 'ssam-render-facts/1', big: 'f'.repeat(700 * 1024) };
  let received = null;
  const agent = scriptedAgent(hub.base, hub.token.agentCredential, { answer: (call, params) => { received = { call, params }; return { valueBlob: facts }; } });
  await agent.connect(); t.after(() => agent.close());
  const link = hub.link();
  assert.equal(link.supports('screen.render'), true);
  const params = { schema: 'ssam-render-request/1', documents: [{ id: 's1', html: '<!doctype html><p>' + 'x'.repeat(600 * 1024) + '</p>' }] };
  const value = await link.call('screen.render', params, { timeoutMs: 20000 });
  assert.deepEqual(value, facts);
  assert.ok(received.call.paramsBlob, 'the call carried a paramsBlob');
  assert.equal(received.call.params, undefined);
  assert.deepEqual(received.params, params);
  assert.ok(Number.isFinite(received.call.deadline), 'the call line has a deadline');
});

test('a call written again after a reconnection carries the deadline the hub waits for now (grace included)', async t => {
  const hub = await startHub({ limits: { acceptMs: 200, reconnectGraceMs: 4000 } }); t.after(() => hub.close());
  const agent = scriptedAgent(hub.base, hub.token.agentCredential, { accept: false });
  await agent.connect(); t.after(() => agent.close());
  const link = hub.link();
  const pending = link.call('studio.processes', { image: 'ServiceStudio.exe' }, { timeoutMs: 3000 });
  pending.catch(() => {});
  await waitFor(() => agent.calls.length === 1);
  const first = agent.calls[0];
  // Not accepted in acceptMs: the hub closes the stream, grants one reconnectGraceMs and writes the call again on resume.
  await waitFor(() => !link.connected(), 3000);
  await agent.connect();
  await waitFor(() => agent.calls.length === 2, 3000);
  const again = agent.calls[1];
  assert.equal(again.id, first.id, 'the same call');
  assert.equal(again.deadline - first.deadline, 4000, 'the line says the deadline after the grace');
});
