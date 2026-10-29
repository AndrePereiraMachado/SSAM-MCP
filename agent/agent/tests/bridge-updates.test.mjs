import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createBridgeUpdates, verifyAuthenticode } from '../lib/bridge-updates.mjs';
import { createAgent, readPack } from '../lib/agent.mjs';
import { createKinds } from '../lib/kinds.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { fakeBridge } from './fixtures/fake-bridge.mjs';
import { freePort } from './fixtures/ports.mjs';
import { studioRuntime, runtimeOf } from '../lib/studio-runtime.mjs';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { makeRoot, CREDENTIAL } from './fixtures/agent-root.mjs';

const keys = generateKeyPairSync('ed25519');
const anchors = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), thumbprint: 'A'.repeat(40) };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const installed = { version: '1.7.30.1234', runtime: 'net10.0' };
function offer(protocol = 'v101', options = {}) {
  const bytes = Buffer.from('signed test binary ' + protocol);
  const manifest = JSON.stringify({ schema: 1, lane: 'odc', studioVersion: '1.7.30', runtime: 'net10.0', protocol,
    sequence: Number(protocol.slice(1)),
    createdAt: '2026-10-28T00:00:00Z', authenticodeThumbprint: anchors.thumbprint,
    files: [{ path: `bridge/ODC3.Bridge.${protocol}.dll`, signer: 'owner', sha256: digest(bytes), size: bytes.length }, { path: 'client/ODC3.Bridge.Client.dll', signer: 'owner', sha256: digest(bytes), size: bytes.length }], ...options });
  return { value: { lane: 'odc', studioVersion: '1.7.30', protocol, manifest, signature: sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') }, bytes };
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  let item = offer();
  const store = createBridgeUpdates({ root, anchors, authenticode: async () => {}, seal: async () => ({ release() {} }), request: async () => new Response(item.bytes), notify: e => events.push(e), ...extra });
  return { root, store, events, set: value => { item = value; }, install: (value = item.value) => store.offers({ compatible: { odc: { bridgeOffer: value } } }, { odc: { installed } }) };
}
test('valid offer verifies, installs atomically, preserves previous bridge and selects exact runtime', async t => {
  const f = fixture(t);
  assert.equal(await f.install(), true);
  assert.equal((await f.store.select('odc', installed.version, 'net10.0')).protocol, 'v101');
  assert.equal(await f.store.select('odc', installed.version, 'net8.0'), null);
  assert.equal(await f.store.select('odc', '1.7.29', 'net10.0'), null);
  const next = offer('v102'); f.set(next); await f.install();
  assert.ok(fs.existsSync(path.join(f.root, 'bridges/odc/1.7.30/v101/101/manifest.json')));
  const selected = await f.store.select('odc', installed.version, installed.runtime);
  const context = { pid: 1, startedUtc: 'S', attempted: true, bridgeFailure: true };
  f.store.rejectLoad(selected, 'test load failure', context);
  assert.equal((await f.store.select('odc', installed.version, installed.runtime, context)).protocol, 'v101');
  const restarted = createBridgeUpdates({ root: f.root, anchors, authenticode: async () => {} });
  assert.equal((await restarted.select('odc', installed.version, installed.runtime, context)).protocol, 'v101');
  const old = offer('v100'); f.set(old);
  assert.equal(await f.install(), false);
  assert.match(f.events.at(-1).message, /downgrade/);
  assert.equal(fs.existsSync(path.join(f.root, 'bridges/odc/1.7.30/v100')), false);
});
for (const scenario of ['signature', 'sha256', 'missing Authenticode', 'wrong Authenticode', 'interrupted', 'path', 'identity', 'unconfigured']) {
  test('offer refuses ' + scenario + ' without installing or executing files', async t => {
    let checks = 0;
    const f = fixture(t, { authenticode: async () => { checks++; if (scenario.includes('Authenticode')) throw new Error(scenario); } });
    let item = offer();
    if (scenario === 'signature') item.value.signature = Buffer.alloc(64).toString('base64');
    if (scenario === 'sha256') item.bytes = Buffer.alloc(item.bytes.length);
    if (scenario === 'path') item = offer('v101', { files: [{ path: '../escape.dll', signer: 'owner', sha256: digest(item.bytes), size: item.bytes.length }] });
    if (scenario === 'identity') item.value.studioVersion = '1.7.29';
    f.set(item);
    let store = f.store;
    if (scenario === 'interrupted') store = createBridgeUpdates({ root: f.root, anchors, authenticode: async () => {}, request: async () => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('x')); c.error(new Error('interrupted')); } })) });
    if (scenario === 'unconfigured') store = createBridgeUpdates({ root: f.root });
    assert.equal(await store.offers({ compatible: { odc: { bridgeOffer: item.value } } }, { odc: { installed } }), false);
    assert.equal(fs.existsSync(path.join(f.root, 'bridges/odc/1.7.30/v101/101')), false);
    if (['signature', 'sha256', 'path', 'identity', 'unconfigured'].includes(scenario)) assert.equal(checks, 0);
  });
}
test('cached bridge is reverified before selection and unlisted dependency is refused', async t => {
  const f = fixture(t); await f.install();
  fs.writeFileSync(path.join(f.root, 'bridges/odc/1.7.30/v101/101/bridge/evil.dll'), 'evil');
  assert.equal(await f.store.select('odc', installed.version, installed.runtime), null);
  assert.match(f.events.at(-1).message, /Unlisted/);
});
test('an interrupted download can recover on the next hello without restarting', async t => {
  const f = fixture(t);
  const item = offer(); f.set({ ...item, bytes: Buffer.alloc(item.bytes.length) });
  assert.equal(await f.install(), false);
  f.set(item); assert.equal(await f.install(), true);
  assert.equal((await f.store.select('odc', installed.version, installed.runtime)).protocol, 'v101');
});
test('Windows Authenticode demands Valid, embedded Authenticode and pinned signer; Mac updates fail closed', async () => {
  let args;
  await verifyAuthenticode('C:\\safe\\bridge.dll', anchors.thumbprint, { platform: 'win32', runtimeRoot: 'C:\\app', run: async (exe, a) => { args = a; return { stdout: JSON.stringify({ ok: true, thumbprint: anchors.thumbprint }) }; } });
  assert.deepEqual(args, ['authenticode', '--file', 'C:\\safe\\bridge.dll', '--signer', 'owner']);
  await assert.rejects(verifyAuthenticode('C:\\safe\\bridge.dll', anchors.thumbprint, { platform: 'win32', runtimeRoot: 'C:\\app', run: async () => ({ stdout: JSON.stringify({ ok: false, thumbprint: anchors.thumbprint }) }) }), /pinned policy/);
  await assert.rejects(verifyAuthenticode('C:\\safe\\bridge.dll', anchors.thumbprint, { platform: 'win32', runtimeRoot: 'C:\\app', run: async () => ({ stdout: JSON.stringify({ ok: true, thumbprint: 'B'.repeat(40) }) }) }), /pinned policy/);
  assert.ok(!args.some(arg => /powershell/i.test(arg)));
  await assert.rejects(verifyAuthenticode('test.dll', anchors.thumbprint, { platform: 'win32', runtimeRoot: 'C:\\app', run: async () => ({ stdout: JSON.stringify({ ok: false, thumbprint: 'B'.repeat(40) }) }) }), /pinned/);
  await assert.rejects(verifyAuthenticode('/test.dll', anchors.thumbprint, { platform: 'darwin', runtimeRoot: '/app' }), /disabled/);
});
test('runtimeconfig selects the Studio runtime and fails closed for unreadable config', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-runtime-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(await studioRuntime(dir, 'odc', { platform: 'win32' }), null);
  fs.writeFileSync(path.join(dir, 'ODCStudio.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { tfm: 'net10.0' } }));
  assert.equal(await studioRuntime(path.join(dir, 'ODCStudio.exe'), 'odc', { platform: 'win32' }), 'net10.0');
  assert.equal(runtimeOf({ runtimeOptions: { framework: { version: '8.0.1' } } }), 'net8.0');
});
test('signed flat O11 artifact selects the new runtime and preserves the hash handshake', async t => {
  const root = makeRoot(); let bridge;
  t.after(async () => { await bridge?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const contents = { 'hook/Anvil.RuntimeHook.Agent.dll': Buffer.from('signed hook'), 'bridge/Anvil.Bridge.dll': Buffer.from('signed bridge') };
  const m = { schema: 1, lane: 'o11', studioVersion: '11.55.94', runtime: 'net10.0', protocol: 'd1', sequence: 1, createdAt: '2026-10-28T00:00:00Z', authenticodeThumbprint: anchors.thumbprint,
    files: Object.entries(contents).map(([name, bytes]) => ({ path: name, signer: 'owner', sha256: digest(bytes), size: bytes.length })) };
  const manifest = JSON.stringify(m);
  const signed = { lane: m.lane, studioVersion: m.studioVersion, protocol: m.protocol, manifest, signature: sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') };
  const updates = createBridgeUpdates({ root, anchors, authenticode: async () => {}, seal: async () => ({ release() {} }), request: async route => new Response(Object.values(contents).find(b => route.endsWith(digest(b)))) });
  assert.equal(await updates.offers({ compatible: { o11: { bridgeOffer: signed } } }, { o11: { installed: { version: '11.55.94.1', runtime: 'net10.0' } } }), true);
  const port = await freePort(); const pid = 6500; let attached = 0;
  const kinds = createKinds({ root, pack: readPack(root), ws: createWorkspace(root), kernel: () => ({ o11: '11.55.94' }), o11Port: port,
    deps: { processes: async () => [{ pid, path: path.join(root, 'ServiceStudio.exe'), version: '11.55.94.1' }],
      fileVersion: async () => '11.55.94.1', studioRuntime: async () => 'net10.0', bridgeUpdates: updates,
      describe: async () => ({ pid, startedUtc: '2026-10-28T00:00:00.0000000Z', diagnosticsAvailable: true }),
      attachO11: async (number, started, hook) => {
        attached++;
        const config = JSON.parse(fs.readFileSync(hook + '.json', 'utf8'));
        assert.ok(config.bridgePath.startsWith(path.join(root, 'private/bridge-loads')));
        assert.equal(digest(fs.readFileSync(hook)), digest(contents['hook/Anvil.RuntimeHook.Agent.dll']));
        fs.writeFileSync(path.join(root, 'private/authority/bridge.key'), 'test-key');
        bridge = await fakeBridge(request => request.method === 'ping' ? { success: true, data: { bridge: 'anvil', pid } }
          : request.method === 'bridge_manifest' ? { success: true, data: { flavor: 'thin', protocolVersion: 2, authentication: true, bridgeSha256: digest(contents['bridge/Anvil.Bridge.dll']) } }
            : { success: true, data: { alive: true } }, { port });
      } } });
  const record = await kinds.execute('o11.connect', { pid });
  assert.equal(record.ok, true); assert.equal(attached, 1);
  assert.equal((await kinds.execute('o11.connect', { pid })).reused, true);
  assert.equal(attached, 1);
});
test('authenticated fake server installs and reconnects once, reporting effective protocol and fallback', async t => {
  const root = makeRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = path.join(root, 'odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.dll');
  fs.mkdirSync(path.dirname(client), { recursive: true }); fs.writeFileSync(client, 'test client');
  const item = offer();
  const hub = await fakeHub({ credential: CREDENTIAL, kernel: { odc: '1.7.30', odcBridge: 'v101' }, welcome: { compatible: { odc: { bridgeOffer: item.value } } } });
  const m = JSON.parse(item.value.manifest);
  hub.bridges.set('/agent/bridges/odc/1.7.30/v101/' + m.files[0].sha256, item.bytes);
  const events = [];
  const agent = createAgent({ root, config: { server: hub.url, credential: CREDENTIAL }, log: (event, detail) => events.push({ event, ...detail }),
    deps: { locate: async lane => lane === 'odc' ? root : null, fileVersion: async () => installed.version, studioRuntime: async () => 'net10.0',
      processes: async image => image === 'ODCStudio.exe' ? [{ pid: 1234, startedUtc: 'S', path: path.join(root, 'ODCStudio.exe'), version: installed.version }] : [],
      machine: null, bridgeTrust: { anchors, authenticode: async () => {}, seal: async () => ({ release() {} }) }, attachOdc: async () => { throw Object.assign(new Error('cannot load'), { executed: null, attachAttempted: true, bridgeLoadFailure: true }); },
      setTimeout: (fn, ms) => setTimeout(fn, ms > 10000 ? ms : Math.min(ms, 10)) } });
  t.after(async () => { await agent.stop(); await hub.close(); });
  agent.run();
  await hub.until(() => hub.hellos.length >= 2 && hub.hellos.at(-1).bridges.some(b => b.status === 'installed'));
  assert.equal(hub.hellos[1].pack.odcBridge, 'v35');
  assert.equal(hub.hellos[1].capabilities.bridgeOffer, true);
  assert.equal(hub.hellos[1].bridges[0].protocol, 'v101');
  assert.match(events.find(e => e.status === 'installed').message, /^Updated the odc bridge for ODC Studio 1.7.30$/);
  const result = await agent.execute('odc.attach', { pid: 1234 });
  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'cannot load');
  await hub.until(() => hub.hellos.at(-1).bridges.some(b => b.status === 'failed'));
  assert.equal(hub.hellos.at(-1).pack.odcBridge, 'v35');
  assert.equal(hub.hellos.at(-1).bridgeUpdate.status, 'fallback');
});
