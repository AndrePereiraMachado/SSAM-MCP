// o11.connect against the server's version window (servedVersions of the hello reply): a pack bridge built for one served
// Service Studio version connects to another served one with a warning; outside the window, or without a window from the
// server, the built-for version must match as before. describe/attach are fakes and the "bridge" is a loopback test server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createKinds } from '../lib/kinds.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { readPack } from '../lib/agent.mjs';
import { fakeBridge } from './fixtures/fake-bridge.mjs';
import { freePort } from './fixtures/ports.mjs';
import { makeRoot, removeRoot } from './fixtures/agent-root.mjs';

const STARTED = '2026-10-21T10:00:00.0000000Z';
const WINDOW = { odc: '1.7.29', o11: '11.55.93', odcBridge: 'v97', servedVersions: { odc: ['1.7.28', '1.7.29'], o11: ['11.55.92', '11.55.93'] } };
const refused = (promise, code, text) => assert.rejects(promise, error => {
  assert.equal(error.code, code, error.message); assert.equal(error.executed, false);
  if (text) assert.match(error.message, text);
  return true;
});

function kindsFor(root, kernel, deps = {}) {
  return createKinds({ root, ws: createWorkspace(root), pack: readPack(root), kernel: () => kernel, limits: () => ({}),
    deps: { processes: async () => [], fileVersion: async () => null, sleep: async () => {}, ...deps }, o11Port: deps.o11Port ?? 4516 });
}
const studio = version => async image => (image === 'ServiceStudio.exe' ? [{ pid: 6000, path: 'C:\\SS\\ServiceStudio.exe', version }] : []);

// A connect that reaches the fake thin bridge: the hook file, describe and an attach that starts the bridge.
async function connectable(root, port, version) {
  let bridge = null;
  fs.mkdirSync(path.join(root, 'bin', 'o11', 'hook'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'o11', 'hook', 'Anvil.RuntimeHook.Agent.dll'), 'hook');
  const deps = {
    o11Port: port, processes: studio(version),
    describe: async pid => ({ ok: true, pid, startedUtc: STARTED, version, diagnosticsAvailable: true, bridgePath: bridge ? 'x' : null, corePath: null }),
    attachO11: async () => {
      fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'fresh-key');
      bridge = await fakeBridge(request => {
        if (request.method === 'ping') return { success: true, data: { bridge: 'anvil', flavor: 'thin', pid: 6000, version: '1.0' } };
        if (request.method === 'bridge_manifest') return { success: true, data: { bridge: 'anvil', flavor: 'thin', protocolVersion: 2, authentication: true } };
        if (request.method === 'ui_alive') return { success: true, data: { alive: true } };
        return { success: false };
      }, { port });
      return { ok: true, hookRequested: true };
    },
  };
  return { deps, close: async () => { if (bridge) await bridge.close(); } };
}

test('o11 window: a bridge built for a served version connects to another served Service Studio, with a warning', async () => {
  const root = makeRoot({ o11BuiltFor: '11.55.92' });
  const port = await freePort();
  const fake = await connectable(root, port, '11.55.93.65333');
  try {
    const record = await kindsFor(root, WINDOW, fake.deps).execute('o11.connect', {});
    assert.equal(record.ok, true); assert.equal(record.connected, true); assert.equal(record.studioVersion, '11.55.93.65333');
    assert.equal(record.warning?.code, 'O11_BRIDGE_BUILT_FOR_DIFFERS');
    assert.equal(record.warning.builtFor, '11.55.92'); assert.equal(record.warning.studio, '11.55.93.65333');
    assert.match(record.warning.message, /built for Service Studio 11\.55\.92 and is loaded into Service Studio 11\.55\.93\.65333/);
    assert.doesNotMatch(record.warning.message, /[À-ú]/, 'English only');
    // the record kept on disk (and sent to the server) carries the warning too
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'private', 'o11-connection.json'), 'utf8')).warning, record.warning);
  } finally { await fake.close(); removeRoot(root); }
});

test('o11 window: the same version as the pack connects with no warning', async () => {
  const root = makeRoot({ o11BuiltFor: '11.55.93' });
  const port = await freePort();
  const fake = await connectable(root, port, '11.55.93.65333');
  try {
    const record = await kindsFor(root, WINDOW, fake.deps).execute('o11.connect', {});
    assert.equal(record.connected, true);
    assert.equal(record.warning, undefined);
  } finally { await fake.close(); removeRoot(root); }
});

test('o11 window: a pack bridge built for a version outside the window is refused and names the window', async () => {
  const root = makeRoot({ o11BuiltFor: '11.55.90' });
  let attached = false;
  try {
    const kinds = kindsFor(root, WINDOW, { processes: studio('11.55.93.65333'), attachO11: async () => { attached = true; } });
    await refused(kinds.execute('o11.connect', {}), 'STUDIO_VERSION_MISMATCH', /built for 11\.55\.90.*serves Service Studio 11\.55\.92, 11\.55\.93/);
    assert.equal(attached, false, 'nothing attached');
  } finally { removeRoot(root); }
});

test('o11 window: a server that sends no window keeps the exact built-for rule', async () => {
  const root = makeRoot({ o11BuiltFor: '11.55.92' });
  let attached = false;
  try {
    const kinds = kindsFor(root, { odc: '1.7.29', o11: '11.55.93', odcBridge: 'v97' }, { processes: studio('11.55.93.65333'), attachO11: async () => { attached = true; } });
    await refused(kinds.execute('o11.connect', {}), 'STUDIO_VERSION_MISMATCH', /built for 11\.55\.92/);
    assert.equal(attached, false);
  } finally { removeRoot(root); }
});

test('o11 window: a Service Studio newer than the whole window connects with a warning (the server serves it on its newest pair)', async () => {
  const root = makeRoot({ o11BuiltFor: '11.55.92' });
  const port = await freePort();
  const fake = await connectable(root, port, '11.55.94.70000');
  try {
    const record = await kindsFor(root, WINDOW, fake.deps).execute('o11.connect', {});
    assert.equal(record.connected, true);
    assert.equal(record.warning?.code, 'O11_BRIDGE_BUILT_FOR_DIFFERS');
    assert.match(record.warning.message, /newer than the versions the server serves \(11\.55\.92, 11\.55\.93\)/);
  } finally { await fake.close(); removeRoot(root); }
});

test('o11 window: a Service Studio older than the window is refused before anything is attached', async () => {
  const root = makeRoot({ o11BuiltFor: '11.55.92' });
  let attached = false;
  try {
    const kinds = kindsFor(root, WINDOW, { processes: studio('11.55.91.65000'), attachO11: async () => { attached = true; } });
    await refused(kinds.execute('o11.connect', {}), 'STUDIO_VERSION_MISMATCH');
    assert.equal(attached, false);
  } finally { removeRoot(root); }
});
