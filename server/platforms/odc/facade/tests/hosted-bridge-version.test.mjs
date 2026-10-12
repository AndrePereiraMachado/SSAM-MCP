// SSAM-MCP (2026-10-10): the ODC bridge version a hosted server asks the agent's pipe for when its own tree has no built
// bridge (the Linux image of server/Dockerfile: .dockerignore leaves studio/bridge out, so lib.mjs bridgeVersion() is
// null). The kernel's odcBridge (kernel.json) is asked for; odc.attach (no version) is unchanged. Fake AgentLink info.
// 24th release of the line: the server's bridge is v96 and the packs of v48 and v45 stay accepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
function executorWith(info) {
  const dirs = hostedDirs(os.tmpdir());
  return new AgentExecutor({ link: { info: () => info, call: async () => { throw new Error('no call expected'); } }, workspace: dirs.workspace, relayAuthorityDir: path.join(dirs.workspace, 'state', 'relay-authority') });
}

test('a pipe with version null asks for the kernel odcBridge (server without a built bridge)', () => {
  const executor = executorWith({ pack: { odcBridge: 'v96' }, kernel: { odcBridge: 'v96' } });
  assert.deepEqual(executor.bridgeVersionFor({ pid: 1, version: null, args: ['status'] }), { pid: 1, version: 'v96', args: ['status'] });
});

test('version null with an older accepted pack asks for the pack version, as a pinned version does', () => {
  const executor = executorWith({ pack: { odcBridge: 'v48' }, kernel: { odcBridge: 'v96', odcBridgeAccepted: ['v48', 'v45'] } });
  assert.equal(executor.bridgeVersionFor({ pid: 1, version: null, args: ['status'] }).version, 'v48');
});

test('without a kernel odcBridge, version null stays null (the agent refuses, nothing guessed)', () => {
  const executor = executorWith({ pack: { odcBridge: 'v96' }, kernel: { odcBridge: null } });
  assert.equal(executor.bridgeVersionFor({ pid: 1, version: null, args: ['status'] }).version, null);
});

test('odc.attach params (no version) and a server that names its version are unchanged', () => {
  const executor = executorWith({ pack: { odcBridge: 'v96' }, kernel: { odcBridge: 'v96' } });
  assert.deepEqual(executor.bridgeVersionFor({ pid: 1 }), { pid: 1 });
  assert.deepEqual(executor.bridgeVersionFor({ pid: 1, version: 'v96', args: ['status'] }), { pid: 1, version: 'v96', args: ['status'] });
});
