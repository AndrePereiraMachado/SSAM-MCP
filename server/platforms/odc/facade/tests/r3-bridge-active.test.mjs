// A4 of the v101 review, both ends with the real code. The server asks by the package the agent carries (agent-executor.mjs
// bridgeVersionFor); only the agent knows which bridge is loaded in each Studio (bridge-updates protocolFor). A kernel that serves
// v101 and v98 must not leave a Studio that runs v101 without service.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';
import { createKinds } from '../../../../../agent/agent/lib/kinds.mjs';
import { createWorkspace, LAYOUT } from '../../../../../agent/agent/lib/workspace.mjs';

test.after(cleanupHostedDirs);
const PID = 4242;
function agent(t, { kernel, loaded }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-active-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of LAYOUT) fs.mkdirSync(path.join(root, folder), { recursive: true });
  const pack = { id: 'proof', lanes: ['odc'], odcBridge: 'v98' }, wire = [];
  const kinds = createKinds({ root, ws: createWorkspace(root), pack, kernel: () => kernel, platform: 'win32', deps: {
    processes: async () => [{ pid: PID, path: 'C:/Synthetic/ODCStudio.exe', version: '1.7.30.10980', startedUtc: '2026-10-30T00:00:00Z' }],
    bridgeUpdates: { protocolFor: () => loaded },
    pipeCall: async (pid, version, words) => { wire.push(version + ' ' + words[0]); return words[0] === 'agent-root' ? JSON.stringify({ ok: true, protocol: 1, root: path.join(root, 'odc') }) : JSON.stringify({ ok: true, bridge: version }); } } });
  return { kinds, wire, pack };
}
const server = (pack, kernel) => {
  const dirs = hostedDirs(os.tmpdir());
  return new AgentExecutor({ link: { info: () => ({ pack, kernel }), call: async () => { throw new Error('no call expected'); } }, workspace: dirs.workspace, relayAuthorityDir: path.join(dirs.workspace, 'authority') });
};
const BOTH = { odc: '1.7.30', odcBridge: 'v101', odcBridgeAccepted: ['v98'] };

test('a Studio running v101 on a kernel that serves v101 and v98: the server asks v98, the agent answers on v101', async t => {
  const a = agent(t, { kernel: BOTH, loaded: 'v101' });
  const asked = server(a.pack, BOTH).bridgeVersionFor({ pid: PID, version: null, args: ['status'] });
  assert.equal(asked.version, 'v98');
  const answer = await a.kinds.execute('odc.pipe', { pid: PID, version: asked.version, args: ['status'] });
  assert.equal(JSON.parse(answer.line).bridge, 'v101');
  assert.deepEqual(a.wire, ['v101 agent-root', 'v101 status']);
});

test('a Studio with the pack bridge is answered on it, as before', async t => {
  const a = agent(t, { kernel: BOTH, loaded: 'v98' });
  const asked = server(a.pack, BOTH).bridgeVersionFor({ pid: PID, version: null, args: ['status'] });
  await a.kinds.execute('odc.pipe', { pid: PID, version: asked.version, args: ['status'] });
  assert.deepEqual(a.wire, ['v98 agent-root', 'v98 status']);
});

test('a bridge the kernel does not serve is refused and nothing reaches the pipe', async t => {
  const onlyNew = agent(t, { kernel: { odc: '1.7.30', odcBridge: 'v101' }, loaded: 'v98' });
  await assert.rejects(onlyNew.kinds.execute('odc.pipe', { pid: PID, version: 'v101', args: ['status'] }), e => e.code === 'BRIDGE_VERSION_MISMATCH');
  assert.deepEqual(onlyNew.wire, []);
  const unknown = agent(t, { kernel: BOTH, loaded: 'v101' });
  await assert.rejects(unknown.kinds.execute('odc.pipe', { pid: PID, version: 'v34', args: ['status'] }), e => e.code === 'BRIDGE_VERSION_MISMATCH');
  assert.deepEqual(unknown.wire, []);
});

// The first real offer (31/10): the hub read o11BridgeAccepted from the kernel, and startupKernel never handed it over.
test('a kernel.json that accepts an O11 bridge reaches the hub, or no O11 bridge is ever offered', async t => {
  const { startupKernel } = await import('../ssam.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-o11-accepted-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify({ o11: '11.55.94', odc: '1.7.30', odcBridge: 'v101', odcBridgeAccepted: ['v102'], o11BridgeAccepted: ['d1'] }));
  const { kernel } = await startupKernel({ dir, fileVersion: async () => null, log: () => {} });
  assert.deepEqual(kernel.o11BridgeAccepted, ['d1']);
  assert.deepEqual(kernel.odcBridgeAccepted, ['v102']);
});
