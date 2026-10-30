import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, removeRoot } from './fixtures/agent-root.mjs';
import { connectO11, connector } from '../lib/o11-connect.mjs';
import { createKinds } from '../lib/kinds.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { readPack } from '../lib/agent.mjs';

test('separate installation: ODC binaries are loaded from runtimeRoot; file access stays under data', async () => {
  const root = makeRoot(); const runtimeRoot = makeRoot({ odcBridge: 'v98' });
  try {
    const client = path.join(runtimeRoot, 'odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.dll');
    const bridge = path.join(runtimeRoot, 'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v98.dll');
    for (const file of [client, bridge]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); }
    let attached; let binding;
    const ws = createWorkspace(root);
    const kinds = createKinds({ root, runtimeRoot, ws, pack: readPack(runtimeRoot), kernel: () => ({ odc: '1.7.28' }),
      deps: { processes: async () => [{ pid: 6000, version: '1.7.28' }],
        pipeCall: async (_pid, _version, args) => { binding = args; return JSON.stringify({ ok: true, protocol: 1, root: path.join(root, 'odc') }); },
        attachOdc: async input => { attached = input; return { ok: true, attached: true }; } } });
    await kinds.execute('odc.attach', { pid: 6000 });
    assert.deepEqual(attached, { pid: 6000, client, bridge });
    assert.deepEqual(binding, ['agent-root', JSON.stringify({ root: path.join(root, 'odc') })]);
    assert.throws(() => ws.checkAbsolute(bridge), /outside/);
    assert.throws(() => ws.resolve('agent:odc/studio/bridge/bin/x.dll'), /outside/);
    assert.equal(fs.existsSync(path.join(root, 'odc/studio')), false);
  } finally { removeRoot(root); removeRoot(runtimeRoot); }
});

test('separate installation: O11 connector and bridge come from runtimeRoot; exchange and authority stay in data', async () => {
  const root = makeRoot(); const runtimeRoot = makeRoot();
  try {
    const sourceHook = path.join(runtimeRoot, 'bin/o11/hook/Anvil.RuntimeHook.Agent.dll');
    fs.mkdirSync(path.dirname(sourceHook), { recursive: true }); fs.writeFileSync(sourceHook, 'fixture');
    let command;
    await connector(runtimeRoot, { run: async (...args) => { command = args; return { stdout: '{"ok":true}' }; } })(['describe', 6000]);
    assert.equal(command[1][0], path.join(runtimeRoot, 'bin/o11/connect/Anvil.Connect.dll'));
    let attached = false; let config;
    await connectO11({ root, runtimeRoot, pid: 6000, port: 4516, pack: readPack(runtimeRoot),
      describe: async pid => ({ pid, startedUtc: '2026-10-27T12:00:00Z', diagnosticsAvailable: true }),
      probe: async () => attached ? { connected: true, pid: 6000, manifest: {} } : { connected: false, occupied: false },
      attach: async (_pid, _start, hook) => {
        assert.ok(hook.startsWith(path.join(root, 'private/runtime-connect')));
        config = JSON.parse(fs.readFileSync(hook + '.json'));
        fs.writeFileSync(path.join(root, 'private/authority/bridge.key'), 'fixture-key'); attached = true;
      },
      request: async () => ({ success: true, data: { alive: true } }) });
    assert.equal(config.bridgePath, path.join(runtimeRoot, 'bin/o11/bridge/Anvil.Bridge.dll'));
    assert.equal(config.authorityDir, path.join(root, 'private/authority'));
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'private/o11-connection.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'private/o11-connection.json')), true);
  } finally { removeRoot(root); removeRoot(runtimeRoot); }
});

test('ODC data-root binding is internal, required before dispatch, and failure prevents the command', async () => {
  const root = makeRoot({ odcBridge: 'v98' });
  try {
    const seen = [];
    const kinds = createKinds({ root, ws: createWorkspace(root), pack: readPack(root), kernel: () => ({ odc: '1.7.28' }),
      deps: { processes: async () => [{ pid: 6000, version: '1.7.28' }], pipeCall: async (_pid, _version, args) => {
        seen.push(args); return '{"ok":false,"error":"AGENT_ROOT_LOCKED"}';
      } } });
    await assert.rejects(kinds.execute('odc.pipe', { pid: 6000, version: 'v98', args: ['agent-root', '{}'] }), e => e.code === 'COMMAND_NOT_ALLOWED');
    assert.equal(seen.length, 0);
    await assert.rejects(kinds.execute('odc.pipe', { pid: 6000, version: 'v98', args: ['snapshot', 'Example'] }), e => e.code === 'ODC_DATA_ROOT_FAILED' && e.executed === false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'agent-root');
  } finally { removeRoot(root); }
});

test('an old ODC bridge cannot be attached from a separate installation', async () => {
  const root = makeRoot(); const runtimeRoot = makeRoot();
  try {
    let attached = false;
    const kinds = createKinds({ root, runtimeRoot, ws: createWorkspace(root), pack: readPack(runtimeRoot), kernel: () => ({ odc: '1.7.28' }),
      deps: { processes: async () => [{ pid: 6000, version: '1.7.28' }], attachOdc: async () => { attached = true; } } });
    await assert.rejects(kinds.execute('odc.attach', { pid: 6000 }), e => e.code === 'BRIDGE_VERSION_MISMATCH' && e.executed === false);
    assert.equal(attached, false);
  } finally { removeRoot(root); removeRoot(runtimeRoot); }
});
