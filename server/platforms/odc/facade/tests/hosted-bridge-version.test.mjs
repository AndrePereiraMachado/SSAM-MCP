// SSAM-MCP (2026-10-10): the ODC bridge version a hosted server asks the agent's pipe for when its own tree has no built
// bridge (the Linux image of server/Dockerfile: .dockerignore leaves studio/bridge out, so lib.mjs bridgeVersion() is
// null). The kernel's odcBridge (kernel.json) is asked for; odc.attach (no version) is unchanged. Fake AgentLink info.
// 24th release of the line: the server's bridge is v96 and the packs of v48 and v45 stay accepted. ODC Studio 1.7.28: the
// server's bridge is v97 (built against 1.7.28) and the packs of v96, v48 and v45 stay accepted.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { AgentExecutor, bridgeApiBreak, ODC_BRIDGE_API_BREAKS } from '../hosted/agent-executor.mjs';
import { hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
function executorWith(info) {
  const dirs = hostedDirs(os.tmpdir());
  return new AgentExecutor({ link: { info: () => info, call: async () => { throw new Error('no call expected'); } }, workspace: dirs.workspace, relayAuthorityDir: path.join(dirs.workspace, 'state', 'relay-authority') });
}

test('a pipe with version null asks for the kernel odcBridge (server without a built bridge)', () => {
  const executor = executorWith({ pack: { odcBridge: 'v97' }, kernel: { odcBridge: 'v97' } });
  assert.deepEqual(executor.bridgeVersionFor({ pid: 1, version: null, args: ['status'] }), { pid: 1, version: 'v97', args: ['status'] });
});

test('version null with an older accepted pack asks for the pack version, as a pinned version does', () => {
  const executor = executorWith({ pack: { odcBridge: 'v96' }, kernel: { odcBridge: 'v97', odcBridgeAccepted: ['v96', 'v48', 'v45'] } });
  assert.equal(executor.bridgeVersionFor({ pid: 1, version: null, args: ['status'] }).version, 'v96');
});

test('without a kernel odcBridge, version null stays null (the agent refuses, nothing guessed)', () => {
  const executor = executorWith({ pack: { odcBridge: 'v97' }, kernel: { odcBridge: null } });
  assert.equal(executor.bridgeVersionFor({ pid: 1, version: null, args: ['status'] }).version, null);
});

test('odc.attach params (no version) and a server that names its version are unchanged', () => {
  const executor = executorWith({ pack: { odcBridge: 'v97' }, kernel: { odcBridge: 'v97' } });
  assert.deepEqual(executor.bridgeVersionFor({ pid: 1 }), { pid: 1 });
  assert.deepEqual(executor.bridgeVersionFor({ pid: 1, version: 'v97', args: ['status'] }), { pid: 1, version: 'v97', args: ['status'] });
});

// ODC Studio 1.7.28 changed IReferencesManagerService.RefreshSpecificReferencesByKey (a sixth optional parameter): a
// bridge compiled against 1.7.27 (every one below v97) cannot run refresh-references --producer in a 1.7.28 Studio.
test('bridgeApiBreak: only refresh-references --producer, only a bridge below v97, only in an ODC Studio 1.7.28 or newer', () => {
  const library = ['refresh-references', 'Consumer', '--producer', 'Library'];
  assert.equal(bridgeApiBreak({ version: 'v96', args: library }, '1.7.28.10850')?.member, 'IReferencesManagerService.RefreshSpecificReferencesByKey');
  assert.equal(bridgeApiBreak({ version: 'v48', args: library }, '1.7.29.1')?.command, 'refresh-references');
  assert.equal(bridgeApiBreak({ version: 'v97', args: library }, '1.7.28.10850'), null);
  assert.equal(bridgeApiBreak({ version: 'v96', args: library }, '1.7.27.10846'), null);
  assert.equal(bridgeApiBreak({ version: 'v96', args: ['refresh-references', 'Consumer'] }, '1.7.28.10850'), null);
  assert.equal(bridgeApiBreak({ version: 'v96', args: ['status'] }, '1.7.28.10850'), null);
  assert.equal(bridgeApiBreak({ version: null, args: library }, '1.7.28.10850'), null);
  assert.equal(bridgeApiBreak({ version: 'v96', args: library }, null), null);
  assert.deepEqual(ODC_BRIDGE_API_BREAKS.map(b => [b.studio, b.firstBridge, b.command, b.flag]), [['1.7.28', 97, 'refresh-references', '--producer']]);
});

test('an accepted v96 pack in an ODC Studio 1.7.28: refresh-references --producer is refused before anything is sent; v97 goes to the agent', async () => {
  const studios = { odc: { installed: { dir: 'C:\\ODC', version: '1.7.28.10850' } } };
  const kernel = { odc: '1.7.28', odcBridge: 'v97', odcBridgeAccepted: ['v96', 'v48', 'v45'] };
  const args = ['refresh-references', 'Consumer', '--producer', 'Library'];
  const old = executorWith({ pack: { odcBridge: 'v96' }, kernel, studios });
  await assert.rejects(old.call('odc.pipe', { pid: 1, version: null, args }), e => e.code === 'STUDIO_BRIDGE_OUTDATED' && e.sent === false
    && e.executed === false && /ODC bridge v96/.test(e.message) && /1\.7\.28\.10850/.test(e.message) && /Nothing was sent/.test(e.message));
  // the same pack without --producer (Check for dependency updates) is not refused here: it reaches the agent link
  await assert.rejects(old.call('odc.pipe', { pid: 1, version: null, args: ['refresh-references', 'Consumer'] }), e => e.code !== 'STUDIO_BRIDGE_OUTDATED');
  const current = executorWith({ pack: { odcBridge: 'v97' }, kernel, studios });
  await assert.rejects(current.call('odc.pipe', { pid: 1, version: null, args }), e => e.code !== 'STUDIO_BRIDGE_OUTDATED' && /no call expected/.test(e.message));
  // no Studio version reported: the server kernel's ODC Studio (the hub requires the customer's to match it)
  const unreported = executorWith({ pack: { odcBridge: 'v96' }, kernel });
  await assert.rejects(unreported.call('odc.pipe', { pid: 1, version: null, args }), e => e.code === 'STUDIO_BRIDGE_OUTDATED');
});
