// One O11 thin bridge per Service Studio version in one pack (pack.json o11Builds, agent 0.3.7): the agent reports, in the
// hello, the build of the Service Studio installed on the machine, and o11.connect loads that build's file with that build's
// sha256 in the handshake. Proven for 11.55.94, 11.55.93 and 11.55.92 against the kernel of each backend of the server
// window (server/deploy/coolify/r1-kernels.json), with the real hub rule (agent-hub.mjs compatibility): no AGENT_PACK_MISMATCH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { o11Builds, o11PackFor, o11BridgeFile, DEFAULT_O11_BRIDGE } from '../lib/o11-builds.mjs';
import { createAgent, readPack, helloCapabilities, NO_ANCHORS_REASON } from '../lib/agent.mjs';
import { createKinds } from '../lib/kinds.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { bundledBridgeSupports } from '../lib/studio-runtime.mjs';
import { fakeBridge } from './fixtures/fake-bridge.mjs';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { freePort } from './fixtures/ports.mjs';
import { makeRoot, removeRoot, CREDENTIAL } from './fixtures/agent-root.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const VERSIONS = [['11.55.94', 'net10.0', DEFAULT_O11_BRIDGE], ['11.55.93', 'net8.0', 'bin/o11/bridges/11.55.93/Anvil.Bridge.dll'], ['11.55.92', 'net8.0', 'bin/o11/bridges/11.55.92/Anvil.Bridge.dll']];
const STARTED = '2026-11-02T05:00:00.0000000Z';

// A pack root with the three bridges on disk and in pack.json (files + o11Builds), the default (first) also in o11BuiltFor.
function multiRoot({ hook = 'dev', extra = {} } = {}) {
  const root = makeRoot({ o11BuiltFor: '11.55.94' });
  const files = [];
  const builds = VERSIONS.map(([version, runtime, rel]) => {
    const bytes = 'thin bridge for ' + version;
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), bytes);
    files.push({ path: rel, size: bytes.length, sha256: sha(bytes) });
    return { version, runtime, path: rel, sha256: sha(bytes) };
  });
  fs.mkdirSync(path.join(root, 'bin', 'o11', 'hook'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'o11', 'hook', 'Anvil.RuntimeHook.Agent.dll'), 'hook');
  const pack = JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8'));
  Object.assign(pack, { o11Hook: hook, o11Bridge: { path: DEFAULT_O11_BRIDGE, sha256: builds[0].sha256 }, o11Builds: builds, files }, extra);
  fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify(pack));
  return { root, builds };
}

test('o11Builds: only builds the integrity list confirms, under bin/o11/, one per version, in pack order', () => {
  const good = 'a'.repeat(64);
  const pack = { files: [{ path: 'bin/o11/bridge/Anvil.Bridge.dll', sha256: good }, { path: 'bin/o11/bridges/11.55.93/Anvil.Bridge.dll', sha256: good }], o11Builds: [
    { version: '11.55.94', path: 'bin/o11/bridge/Anvil.Bridge.dll', sha256: good, runtime: 'net10.0' },
    { version: '11.55.94', path: 'bin/o11/bridges/11.55.93/Anvil.Bridge.dll', sha256: good },
    { version: '11.55.93', path: 'bin/o11/bridges/11.55.93/Anvil.Bridge.dll', sha256: 'b'.repeat(64) },
    { version: '11.55.92', path: 'agent/lib/x.dll', sha256: good },
    { version: '11.55.91', path: '../bin/o11/bridge/Anvil.Bridge.dll', sha256: good },
    { version: '11.55', path: 'bin/o11/bridge/Anvil.Bridge.dll', sha256: good }] };
  assert.deepEqual(o11Builds(pack), [{ version: '11.55.94', path: 'bin/o11/bridge/Anvil.Bridge.dll', sha256: good, runtime: 'net10.0' }]);
  assert.deepEqual(o11Builds({ o11BuiltFor: '11.55.94' }), []);
});

test('o11PackFor: the build of each served Service Studio; another version or the h1 hook leave the pack as it is', () => {
  const { root, builds } = multiRoot();
  try {
    const pack = readPack(root);
    for (const [i, [version, runtime, rel]] of VERSIONS.entries()) {
      const view = o11PackFor(pack, version + '.65000');
      assert.equal(view.o11BuiltFor, version); assert.equal(view.o11Runtime, runtime);
      assert.deepEqual([view.o11Bridge.path, view.o11Bridge.sha256], [rel, builds[i].sha256]);
      assert.equal(o11BridgeFile(root, view), path.join(root, ...rel.split('/')));
    }
    assert.equal(o11PackFor(pack, '11.55.91.1'), pack);
    assert.equal(o11PackFor(pack, null), pack);
    const h1 = { ...pack, o11Hook: 'h1' };
    assert.equal(o11PackFor(h1, '11.55.93'), h1);
    assert.equal(o11BridgeFile(root, { o11Bridge: { path: 'studio/o11/bridge/b1/Anvil.Bridge.dll' } }), path.join(root, 'bin', 'o11', 'bridge', 'Anvil.Bridge.dll'));
  } finally { removeRoot(root); }
});

test('readPack drops a build whose file the integrity list does not confirm (changed after packing)', () => {
  const { root } = multiRoot();
  try {
    const file = path.join(root, 'pack.json');
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    pack.files[1].sha256 = 'c'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(pack));
    assert.deepEqual(readPack(root).o11Builds.map(b => b.version), ['11.55.94', '11.55.92']);
    assert.equal(o11PackFor(readPack(root), '11.55.93').o11BuiltFor, '11.55.94', 'no build: the default bridge and the rule of before');
  } finally { removeRoot(root); }
});

test('bundled bridge support: each Studio is judged by its own build and runtime', () => {
  const { root } = multiRoot();
  try {
    const pack = readPack(root);
    assert.equal(bundledBridgeSupports(pack, root, 'o11', '11.55.94.65328', 'net10.0'), true);
    assert.equal(bundledBridgeSupports(pack, root, 'o11', '11.55.93.65289', 'net8.0'), true);
    assert.equal(bundledBridgeSupports(pack, root, 'o11', '11.55.92.65269', 'net8.0'), true);
    assert.equal(bundledBridgeSupports(pack, root, 'o11', '11.55.93.65289', 'net10.0'), false);
    assert.equal(bundledBridgeSupports(pack, root, 'o11', '11.55.91.1', 'net8.0'), false);
  } finally { removeRoot(root); }
});

// o11.connect against the kernel of one backend (no servedVersions: the strict rule of before), with a fake thin bridge
// that reports the sha256 of the file the hook configuration names.
async function connectOn(version, kernelO11) {
  const { root } = multiRoot();
  const port = await freePort();
  let bridge = null, hookConfig = null;
  const deps = {
    processes: async image => (image === 'ServiceStudio.exe' ? [{ pid: 6100, path: 'C:\\SS\\ServiceStudio.exe', version }] : []),
    fileVersion: async () => null, sleep: async () => {},
    describe: async pid => ({ ok: true, pid, startedUtc: STARTED, version, diagnosticsAvailable: true, bridgePath: bridge ? 'x' : null, corePath: null }),
    attachO11: async (pid, started, hook) => {
      hookConfig = JSON.parse(fs.readFileSync(hook + '.json', 'utf8'));
      const loaded = sha(fs.readFileSync(hookConfig.bridgePath));
      fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'fresh-key');
      bridge = await fakeBridge(request => {
        if (request.method === 'ping') return { success: true, data: { bridge: 'anvil', flavor: 'thin', pid: 6100, version: '1.0' } };
        if (request.method === 'bridge_manifest') return { success: true, data: { bridge: 'anvil', flavor: 'thin', protocolVersion: 2, authentication: true, bridgeSha256: loaded } };
        if (request.method === 'ui_alive') return { success: true, data: { alive: true } };
        return { success: false };
      }, { port });
      return { ok: true, hookRequested: true };
    },
  };
  const kinds = createKinds({ root, ws: createWorkspace(root), pack: readPack(root), kernel: () => ({ o11: kernelO11, odc: '1.7.30', odcBridge: 'v106' }), limits: () => ({}), deps, o11Port: port });
  try { return { record: await kinds.execute('o11.connect', {}), hookConfig, root }; }
  finally { if (bridge) await bridge.close(); removeRoot(root); }
}

for (const [version, , rel] of VERSIONS) {
  test(`o11.connect on Service Studio ${version}: loads the ${version} build, handshake ok, no warning`, async () => {
    const { record, hookConfig, root } = await connectOn(version + '.65000', version);
    assert.equal(record.ok, true); assert.equal(record.connected, true);
    assert.equal(record.warning, undefined);
    assert.equal(hookConfig.bridgePath, path.join(root, ...rel.split('/')));
    assert.equal(record.bridgeSha256, sha('thin bridge for ' + version));
  });
}

test('o11.connect on a Service Studio the pack has no build for keeps the rule of before (STUDIO_VERSION_MISMATCH)', async () => {
  await assert.rejects(connectOn('11.55.91.1', '11.55.91'), error => error.code === 'STUDIO_VERSION_MISMATCH' && /built for 11\.55\.94/.test(error.message));
});

// The hello of a real agent on each Service Studio, judged by the real hub against each backend's kernel of the window.
async function helloOn(version, packExtra = {}) {
  const { root } = multiRoot({ extra: packExtra });
  const hub = await fakeHub({ credential: CREDENTIAL, kernel: { o11: version.split('.').slice(0, 3).join('.'), odc: '1.7.30', odcBridge: 'v106' } });
  const agent = createAgent({ root, config: { server: hub.url, credential: CREDENTIAL }, log: () => {},
    deps: { locate: async lane => (lane === 'o11' ? root : null), fileVersion: async () => version, studioRuntime: async () => null,
      processes: async () => [], machine: null } });
  try {
    agent.run();
    await hub.until(() => hub.hellos.length >= 1);
    return hub.hellos[0];
  } finally { await agent.stop(); await hub.close(); removeRoot(root); }
}

test('hello: pack.o11BuiltFor is the build of the installed Service Studio, and the real hub accepts it on each backend of the window', async () => {
  const hubModule = await import(pathToFileURL(path.resolve(here, '../../../server/platforms/odc/facade/agent-hub.mjs')).href);
  const window = JSON.parse(fs.readFileSync(path.resolve(here, '../../../server/deploy/coolify/r1-kernels.json'), 'utf8'));
  const backends = Object.fromEntries(Object.values(window).map(k => [k.o11, k]));
  for (const [version] of VERSIONS) {
    const hello = await helloOn(version + '.65000');
    assert.equal(hello.pack.o11BuiltFor, version);
    assert.deepEqual(hello.pack.o11Builds, VERSIONS.map(v => v[0]));
    const kernel = backends[version];
    assert.ok(kernel, 'the window has a backend for ' + version);
    const own = hubModule.compatibility(hello, kernel, ['o11']).o11;
    assert.equal(own.ok, true, JSON.stringify(own));
    // the pack of before (one bridge, 11.55.94) on the same backend: refused, as in production today, except on 11.55.94
    const before = hubModule.compatibility({ ...hello, pack: { ...hello.pack, o11BuiltFor: '11.55.94', o11Builds: undefined } }, kernel, ['o11']).o11;
    assert.equal(before.code === 'AGENT_PACK_MISMATCH', version !== '11.55.94', JSON.stringify(before));
  }
});

test('hello: a pack built without the trust anchors (bridgeOffer false) never asks for bridge offers, on any platform', async () => {
  assert.deepEqual(helloCapabilities('win32', { bridgeOffer: false }), { bridgeOffer: false, bridgeOfferReason: NO_ANCHORS_REASON });
  assert.deepEqual(helloCapabilities('darwin', { bridgeOffer: false }), { bridgeOffer: false, bridgeOfferReason: NO_ANCHORS_REASON });
  // 0.3.17: an agent with an empty Ed25519 anchor (the source default) never asks either; with the key it does.
  assert.deepEqual(helloCapabilities('win32', {}), { bridgeOffer: false, bridgeOfferReason: NO_ANCHORS_REASON });
  assert.deepEqual(helloCapabilities('win32', {}, 'MCowBQYDK2VwAyEA' + 'A'.repeat(43) + '='), { bridgeOffer: true });
  const hello = await helloOn('11.55.93.65289', { bridgeOffer: false });
  assert.equal(hello.capabilities.bridgeOffer, false);
  assert.match(hello.capabilities.bridgeOfferReason, /without the bridge trust anchors/);
});

test('review B1: a pack with no integrity list has no valid O11 build (refused closed); readPack keeps the checked ones', () => {
  const good = 'a'.repeat(64);
  const builds = [{ version: '11.55.93', path: 'bin/o11/bridges/11.55.93/Anvil.Bridge.dll', sha256: good }];
  assert.deepEqual(o11Builds({ o11Builds: builds }), []);
  assert.deepEqual(o11Builds({ o11Builds: builds, files: [] }), []);
  const { root } = multiRoot();
  try {
    const pack = readPack(root);
    assert.deepEqual(o11Builds(pack).map(b => b.version), ['11.55.94', '11.55.93', '11.55.92'], 'readPack checked them against files');
    assert.deepEqual(o11Builds({ ...pack }).map(b => b.version), ['11.55.94', '11.55.93', '11.55.92'], 'a spread keeps the check');
    assert.deepEqual(o11Builds(JSON.parse(JSON.stringify(pack))), [], 'a copy through JSON does not');
  } finally { removeRoot(root); }
});

test('review B3: the hello reports the build of the Service Studio this agent is connected to, not only the installed one', async () => {
  const { root } = multiRoot();
  const hub = await fakeHub({ credential: CREDENTIAL, kernel: { o11: '11.55.93', odc: '1.7.30', odcBridge: 'v106' } });
  // installed: 11.55.94; connected (the attached, running Studio): 11.55.93
  fs.writeFileSync(path.join(root, 'private', 'o11-connection.json'), JSON.stringify({ pid: 7100, port: 4516, startedUtc: STARTED, studioVersion: '11.55.93.65289' }));
  const agent = createAgent({ root, config: { server: hub.url, credential: CREDENTIAL }, log: () => {},
    deps: { locate: async lane => (lane === 'o11' ? root : null), fileVersion: async () => '11.55.94.65328', studioRuntime: async () => null,
      processes: async image => (image === 'ServiceStudio.exe' ? [{ pid: 7100, path: 'C:\SS\ServiceStudio.exe', version: '11.55.93.65289' }] : []), machine: null } });
  try {
    agent.run();
    await hub.until(() => hub.hellos.length >= 1);
    assert.equal(hub.hellos[0].pack.o11BuiltFor, '11.55.93');
    assert.equal(hub.hellos[0].o11Connection.studioVersion, '11.55.93.65289');
  } finally { await agent.stop(); await hub.close(); removeRoot(root); }
});
