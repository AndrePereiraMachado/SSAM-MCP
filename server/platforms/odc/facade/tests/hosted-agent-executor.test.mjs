// hosted/agent-executor.mjs (docs/FASE2-AGENTE.md 4.2, 4.3, 4.7): the error contract (never delivered vs delivered with
// an unknown outcome, per kind) and the O11 connection record synthesized for the server's O11 modules. Fake AgentLink.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PipeError } from '../odc-pipe.mjs';
import { BridgeError } from '../o11-bridge.mjs';
import { AgentExecutor, AGENT_KINDS } from '../hosted/agent-executor.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs, coded } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
function setup(handlers = {}) {
  const dirs = hostedDirs(os.tmpdir());
  fs.writeFileSync(path.join(dirs.workspace, 'state', 'relay-authority', 'bridge.key'), randomBytes(32).toString('base64url'));
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, handlers });
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, relayAuthorityDir: path.join(dirs.workspace, 'state', 'relay-authority'),
    o11: { studioDir: 'C:\\Users\\owner\\OutSystems\\Service Studio 11 - Anvil 4516\\Service Studio', lane: 'ss4' } });
  return { ...dirs, link, executor };
}
const lost = code => () => { throw coded(code, code + ': the call was delivered and no result came', { executed: null, delivered: true }); };

test('odc.pipe: not delivered is PipeError sent:false; delivered without a result is PipeError sent:true', async () => {
  const h = setup({ 'odc.pipe': lost('AGENT_DISCONNECTED') });
  await assert.rejects(h.executor.call('odc.pipe', { pid: 1, version: 'v35', args: ['merge-status'] }),
    e => e instanceof PipeError && e.code === 'AGENT_DISCONNECTED' && e.sent === true);
  h.link.disconnect();
  await assert.rejects(h.executor.call('odc.pipe', { pid: 1, version: 'v35', args: ['status', 'brief'] }),
    e => e instanceof PipeError && e.code === 'AGENT_NOT_CONNECTED' && e.sent === false);
  // An error the agent reports with the transport's own sent flag keeps it.
  const g = setup({ 'odc.pipe': () => { throw Object.assign(coded('PIPE_ABSENT', 'no pipe', { executed: undefined, delivered: true }), { sent: false }); } });
  await assert.rejects(g.executor.call('odc.pipe', { pid: 1, version: 'v35', args: ['status'] }), e => e.code === 'PIPE_ABSENT' && e.sent === false);
});

test('o11.bridge: not delivered is BridgeError executed:false; delivered without a result is executed:undefined', async () => {
  const h = setup({ 'o11.bridge': lost('AGENT_TIMEOUT') });
  await assert.rejects(h.executor.call('o11.bridge', { method: 'merge_status', params: {} }),
    e => e instanceof BridgeError && e.code === 'AGENT_TIMEOUT' && e.executed === undefined && e.method === 'merge_status');
  h.link.disconnect();
  await assert.rejects(h.executor.call('o11.bridge', { method: 'ping', params: {} }),
    e => e instanceof BridgeError && e.code === 'AGENT_NOT_CONNECTED' && e.executed === false);
});

test('the other kinds: Error with code and executed false (not delivered) or null (unknown); file.* never pass', async () => {
  const h = setup({ 'odc.attach': lost('AGENT_REVOKED'), 'studio.processes': () => ({ processes: [{ pid: 4120, path: 'C:\\x\\ODCStudio.exe', version: '1.7.27.4021' }] }) });
  assert.deepEqual(await h.executor.call('studio.processes', { image: 'ODCStudio.exe' }), { processes: [{ pid: 4120, path: 'C:\\x\\ODCStudio.exe', version: '1.7.27.4021' }] });
  await assert.rejects(h.executor.call('odc.attach', { pid: 4120 }), e => e.code === 'AGENT_REVOKED' && e.executed === null);
  for (const kind of ['file.get', 'file.put', 'file.list', 'agent.info', 'studio.locate'])
    await assert.rejects(h.executor.call(kind, {}), e => e.code === 'KIND_NOT_ALLOWED' && e.executed === false);
  h.link.disconnect();
  await assert.rejects(h.executor.call('o11.selected', {}), e => e.code === 'AGENT_NOT_CONNECTED' && e.executed === false);
  assert.deepEqual(AGENT_KINDS, ['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected']);
  assert.ok(h.link.calls.every(c => c.options.timeoutMs > 0), 'every call carries its deadline');
});

test('o11Connection is synthesized with the relay port, the kernel Studio and <ws>/state/relay-authority; null without an agent connection', async t => {
  const h = setup({
    'o11.connect': () => ({ ok: true, lane: 'o11', connected: true, reused: false, pid: 7001, startedUtc: '2026-10-04T10:00:00Z', studioVersion: '11.55.91.65012', port: 4516, connectedAt: '2026-10-04T10:00:05Z' }),
    'o11.selected': () => ({ connected: false }),
  });
  assert.equal(h.executor.o11Connection(), null, 'no relay and no record');
  await h.executor.start();
  t.after(() => h.executor.close());
  assert.ok(Number.isInteger(h.executor.relayPort()) && h.executor.relayPort() > 0);
  assert.equal(h.executor.o11Connection(), null, 'the agent has no Service Studio connected');
  h.link.setInfo({ o11Connection: { pid: 6001, startedUtc: '2026-10-04T09:00:00Z', port: 4516, studioVersion: '11.55.91.65012' } });
  assert.deepEqual(h.executor.o11Connection(), { ok: true, lane: 'o11', anvilLane: 'ss4', pid: 6001, startedUtc: '2026-10-04T09:00:00Z',
    studioVersion: '11.55.91.65012', port: h.executor.relayPort(), studioDir: 'C:\\Users\\owner\\OutSystems\\Service Studio 11 - Anvil 4516\\Service Studio',
    authorityDir: path.join(h.workspace, 'state', 'relay-authority'), connectedAt: null, hosted: true });
  assert.notEqual(h.executor.o11Connection().port, 4516, 'never the agent\'s own port');
  await h.executor.call('o11.connect', {});
  assert.equal(h.executor.o11Connection().pid, 7001, 'the record of the last o11.connect');
  h.link.disconnect();
  assert.equal(h.executor.o11Connection(), null, 'null without an agent connection');
  h.link.reconnect();
  await h.executor.call('o11.selected', {});
  assert.equal(h.executor.o11Connection(), null, 'o11.selected connected:false clears the record');
  h.link.setInfo({ o11Connection: { pid: 8001, startedUtc: 'x', port: 4516, studioVersion: '11.55.91.1' } });
  assert.equal(h.executor.o11Connection().pid, 8001, 'a newer report of the agent wins');
});

test('the executor is hosted, with an id of its own per instance, and closes its relay', async () => {
  const h = setup();
  const other = new AgentExecutor({ link: h.link, workspace: h.workspace, o11: {} });
  assert.equal(h.executor.hosted, true);
  assert.notEqual(h.executor.id, other.id);
  assert.match(h.executor.id, /^agent:tok_test:/);
  await h.executor.start();
  const port = h.executor.relayPort();
  await h.executor.close();
  assert.equal(h.executor.relayPort(), null);
  assert.ok(port > 0);
});
