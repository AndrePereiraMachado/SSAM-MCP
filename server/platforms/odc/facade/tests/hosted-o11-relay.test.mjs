// hosted/o11-relay.mjs through the AgentExecutor (docs/FASE2-AGENTE.md 4.6, 10.7): a client shaped like the kernel's
// BridgeClient (one JSON line {method, params, authorization} per connection: bridgeRequest of o11-bridge.mjs) reaches
// THIS customer's agent only with THIS customer's relay key. Fake AgentLink; loopback ports only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { bridgeRequest } from '../o11-bridge.mjs';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { REFUSED_KEY } from '../hosted/o11-relay.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs, coded } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function customer(t, bridge) {
  const dirs = hostedDirs(os.tmpdir());
  const key = randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dirs.workspace, 'state', 'relay-authority', 'bridge.key'), key);
  const events = [];
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, handlers: { 'o11.bridge': bridge } });
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, o11: { studioDir: 'C:\\Kernel', lane: 'ss4' }, log: event => events.push(event) });
  await executor.start();
  t.after(() => executor.close());
  return { ...dirs, key, link, executor, events, port: executor.relayPort() };
}
const request = (port, authorization, method = 'ping', params = {}, options = {}) => bridgeRequest({ port, authorization }, method, params, options);
// The kernel's BridgeClient drops its connection when its read timeout passes. bridgeRequest no longer does (UI freeze of
// 2026-10-08, pattern 4: it keeps listening for the late answer of its flight), so the client that gives up is this one.
const givingUp = (port, authorization, method, params, timeoutMs) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '127.0.0.1', port }, () => socket.write(JSON.stringify({ method, params, authorization }) + '\n'));
  const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error('timed out'), { code: 'BRIDGE_TIMEOUT' })); }, timeoutMs);
  socket.on('data', chunk => { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(chunk.toString('utf8'))); });
  socket.on('error', error => { clearTimeout(timer); reject(error); });
});

test('a BridgeClient-shaped client with this customer\'s relay key is forwarded to this customer\'s agent', async t => {
  const c = await customer(t, params => ({ reply: { success: true, data: { pid: 6001, echo: params.method } } }));
  const reply = await request(c.port, c.key, 'get_active_module', { any: 1 });
  assert.deepEqual(reply, { success: true, data: { pid: 6001, echo: 'get_active_module' } });
  assert.deepEqual(c.link.calls.map(x => x.params), [{ method: 'get_active_module', params: { any: 1 } }], 'no authorization and no port travel');
});

test('the server controller key and another customer\'s relay key are refused, and nothing reaches the agent', async t => {
  const a = await customer(t, () => ({ reply: { success: true } }));
  const b = await customer(t, () => ({ reply: { success: true } }));
  for (const key of ['the-server-controller-key', b.key, '', undefined]) {
    const reply = await request(a.port, key);
    assert.deepEqual(reply, { success: false, executed: false, error: REFUSED_KEY });
  }
  assert.equal(a.link.calls.length, 0);
  assert.equal(b.link.calls.length, 0);
  assert.deepEqual(await request(b.port, b.key), { success: true });
});

test('a disconnected agent answers executed:false', async t => {
  const c = await customer(t, () => ({ reply: { success: true } }));
  c.link.disconnect();
  const reply = await request(c.port, c.key, 'publish', {});
  assert.equal(reply.success, false);
  assert.equal(reply.executed, false);
  assert.match(reply.error, /^AGENT_NOT_CONNECTED: /);
});

test('a drop after delivery closes the socket with no reply (an unknown outcome for the kernel)', async t => {
  const c = await customer(t, () => { throw coded('AGENT_DISCONNECTED', 'channel lost after accepted', { executed: null, delivered: true }); });
  await assert.rejects(request(c.port, c.key, 'merge_from_oml', {}), e => ['BRIDGE_NO_REPLY', 'BRIDGE_TRANSPORT'].includes(e.code) && e.executed !== false);
  assert.ok(c.events.some(e => e.event === 'relay-unknown' && e.method === 'merge_from_oml'));
});

test('the relay log names a method only from the agent\'s closed list, never a verb-shaped free word', async t => {
  const c = await customer(t, () => { throw coded('AGENT_DISCONNECTED', 'channel lost after accepted', { executed: null, delivered: true }); });
  await assert.rejects(request(c.port, c.key, 'sntl_method', {}), e => ['BRIDGE_NO_REPLY', 'BRIDGE_TRANSPORT'].includes(e.code));
  const unknown = c.events.filter(e => e.event === 'relay-unknown');
  assert.deepEqual(unknown.map(e => e.method), [null]);
  assert.ok(!JSON.stringify(c.events).includes('sntl'), JSON.stringify(c.events));
});

test('a client whose read timeout is shorter than a slow agent gets no reply, and the late reply is logged as relay-late', async t => {
  const c = await customer(t, async () => { await delay(400); return { reply: { success: true, data: { late: true } } }; });
  await assert.rejects(givingUp(c.port, c.key, 'snapshot_module', {}, 100), e => e.code === 'BRIDGE_TIMEOUT');
  for (let i = 0; i < 50 && !c.events.some(e => e.event === 'relay-late'); i++) await delay(20);
  assert.ok(c.events.some(e => e.event === 'relay-late' && e.method === 'snapshot_module'), JSON.stringify(c.events));
});
