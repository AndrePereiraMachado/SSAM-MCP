import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { makeRoot, CREDENTIAL } from './fixtures/agent-root.mjs';
import { fakeBridge } from './fixtures/fake-bridge.mjs';
import { freePort } from './fixtures/ports.mjs';

// The same assertions run against the reviewed commit without changing its sources.
const code = process.env.SSAM_REVIEW_BASE ? path.join(process.env.SSAM_REVIEW_BASE, 'agent') : path.resolve(import.meta.dirname, '..', '..');
const load = relative => import(pathToFileURL(path.join(code, relative)).href);
const { createBridgeUpdates, verifyAuthenticode } = await load('agent/lib/bridge-updates.mjs');
const { createAgent, readPack } = await load('agent/lib/agent.mjs');
const { createKinds } = await load('agent/lib/kinds.mjs');
const { createWorkspace } = await load('agent/lib/workspace.mjs');
const keys = generateKeyPairSync('ed25519');
const anchors = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), thumbprint: 'A'.repeat(40) };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const installed = { version: '1.7.30', runtime: 'net10.0' };
const processIdentity = { pid: 1234, startedUtc: '2026-10-28T00:00:00Z' };
function artifact(sequence = 1, lane = 'odc', protocol = lane === 'odc' ? 'v100' : 'd1') {
  const files = lane === 'odc' ? { [`bridge/ODC3.Bridge.${protocol}.dll`]: Buffer.from('bridge ' + sequence), 'client/ODC3.Bridge.Client.dll': Buffer.from('client ' + sequence) }
    : { 'bridge/Anvil.Bridge.dll': Buffer.from('bridge ' + sequence), 'hook/Anvil.RuntimeHook.Agent.dll': Buffer.from('hook ' + sequence) };
  const manifest = JSON.stringify({ schema: 1, lane, studioVersion: lane === 'odc' ? '1.7.30' : '11.55.94', runtime: 'net10.0', protocol, sequence,
    createdAt: '2026-10-28T00:00:00Z', authenticodeThumbprint: anchors.thumbprint,
    files: Object.entries(files).map(([name, bytes]) => ({ path: name, size: bytes.length, signer: 'owner', sha256: hash(bytes) })) });
  return { files, offer: { lane, studioVersion: lane === 'odc' ? '1.7.30' : '11.55.94', protocol, manifest, signature: sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') } };
}
function fixture(t, options = {}) {
  const root = makeRoot({ odcBridge: 'v98' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let item = artifact(); let checks = 0;
  const storeOptions = { root, anchors, authenticode: async () => { checks++; }, seal: async () => ({ release() {} }),
    request: async route => new Response(Object.values(item.files).find(bytes => route.endsWith(hash(bytes)))), ...options };
  const store = createBridgeUpdates(storeOptions);
  return { root, store, storeOptions, checks: () => checks, set: value => { item = value; }, install: () => store.offers({ compatible: { [item.offer.lane]: { bridgeOffer: item.offer } } }, { [item.offer.lane]: { installed: { ...installed, version: item.offer.studioVersion } } }) };
}
test('R2.1 downloaded ODC client comes from the same verified artifact', async t => {
  const f = fixture(t); await f.install();
  const packaged = path.join(f.root, 'odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.dll');
  fs.mkdirSync(path.dirname(packaged), { recursive: true }); fs.writeFileSync(packaged, 'packaged v98 client');
  let selectedClient;
  const kinds = createKinds({ root: f.root, pack: readPack(f.root), ws: createWorkspace(f.root), kernel: () => ({ odc: installed.version }),
    deps: { processes: async () => [{ ...processIdentity, path: path.join(f.root, 'ODCStudio.exe'), version: installed.version }], studioRuntime: async () => installed.runtime,
      bridgeUpdates: f.store, attachOdc: async ({ client, bridge }) => { selectedClient = client; assert.equal(path.dirname(path.dirname(client)), path.dirname(path.dirname(bridge))); return { ok: true, attached: true }; },
      pipeCall: async () => JSON.stringify({ ok: true, protocol: 1, root: path.join(f.root, 'odc') }) } });
  await kinds.execute('odc.attach', { pid: processIdentity.pid });
  assert.notEqual(selectedClient, packaged);
});
test('R2.2 transient errors never quarantine; attempted bridge failures expire with the Studio instance', async t => {
  const f = fixture(t); await f.install(); const selected = await f.store.select('odc', installed.version, installed.runtime, processIdentity);
  f.store.rejectLoad(selected, 'port occupied', { ...processIdentity, attempted: false, bridgeFailure: false });
  assert.ok(await f.store.select('odc', installed.version, installed.runtime, processIdentity));
  f.store.rejectLoad(selected, 'hook load failed', { ...processIdentity, attempted: true, bridgeFailure: true });
  assert.equal(await f.store.select('odc', installed.version, installed.runtime, processIdentity), null);
  assert.ok(await f.store.select('odc', installed.version, installed.runtime, { ...processIdentity, startedUtc: '2026-10-28T01:00:00Z' }));
});
test('R2.3 downloaded O11 hook is d1', async t => {
  const f = fixture(t); f.set(artifact(1, 'o11')); assert.equal(await f.install(), true);
  assert.equal((await f.store.select('o11', '11.55.94', 'net10.0')).protocol, 'd1');
});
test('R2.4 repeated selection caches verification but attach rechecks the copy', async t => {
  const f = fixture(t); await f.install(); const count = f.checks();
  const selected = await f.store.select('odc', installed.version, installed.runtime, processIdentity);
  await f.store.select('odc', installed.version, installed.runtime, processIdentity);
  assert.equal(f.checks(), count);
  const lease = await f.store.prepareAttach(selected, processIdentity);
  assert.ok(f.checks() > count); lease.release();
});
test('R2.5 signed sequence survives bridge cleanup and permits a corrected same-protocol build', async t => {
  const f = fixture(t); await f.install(); f.set(artifact(2)); assert.equal(await f.install(), true);
  fs.rmSync(path.join(f.root, 'bridges'), { recursive: true, force: true });
  f.set(artifact(1)); assert.equal(await f.install(), false);
});
test('R2.5 package has priority when its Studio and runtime match', async t => {
  const f = fixture(t, { pack: { odcBridge: 'v110', odcBuiltFor: installed.version, odcRuntime: installed.runtime } });
  await f.install(); assert.equal(await f.store.select('odc', installed.version, installed.runtime), null);
});
test('R2.6 Authenticode ignores poisoned SystemRoot and PSModulePath', async () => {
  const before = { SystemRoot: process.env.SystemRoot, PSModulePath: process.env.PSModulePath };
  process.env.SystemRoot = 'Z:\\poison'; process.env.PSModulePath = 'Z:\\modules';
  const calls = [];
  try {
    await verifyAuthenticode('C:\\bridge.dll', anchors.thumbprint, { platform: 'win32', runtimeRoot: 'C:\\runtime', run: async (exe, args, options) => {
      calls.push({ exe, args, options }); return { stdout: JSON.stringify({ ok: true, signatureValid: true, hresult: 0, thumbprint: anchors.thumbprint }) };
    } });
    const check = calls.at(-1); assert.equal(path.win32.normalize(check.exe), 'C:\\runtime\\native\\ssam-agent.exe');
    assert.deepEqual(check.args, ['authenticode', '--file', 'C:\\bridge.dll', '--signer', 'owner']);
    assert.ok(!check.exe.includes('poison')); assert.equal(calls.length, 1);
  } finally { for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});
test('R2.7 attach uses a verified private snapshot, never the writable download', async t => {
  const f = fixture(t); await f.install(); const selected = await f.store.select('odc', installed.version, installed.runtime);
  const lease = await f.store.prepareAttach(selected, processIdentity);
  assert.notEqual(lease.root, selected.root);
  const entry = selected.files[0].path;
  fs.writeFileSync(path.join(selected.root, entry), 'modified download');
  assert.notEqual(fs.readFileSync(path.join(lease.root, entry), 'utf8'), 'modified download'); lease.release();
});
test('R2.8 a slow bridge download does not delay the channel stream', async t => {
  const root = makeRoot(); const item = artifact(); const m = JSON.parse(item.offer.manifest);
  const hub = await fakeHub({ credential: CREDENTIAL, welcome: { compatible: { odc: { bridgeOffer: item.offer } } } });
  for (const file of m.files) hub.bridges.set('/agent/bridges/odc/1.7.30/v100/' + file.sha256, item.files[file.path]);
  let release; const held = new Promise(resolve => { release = resolve; }); let downloading = false;
  const agent = createAgent({ root, config: { credential: CREDENTIAL, server: hub.url }, deps: { machine: null,
    locate: async lane => lane === 'odc' ? root : null, fileVersion: async () => installed.version, processes: async () => [], studioRuntime: async () => installed.runtime,
    fetch: async (url, init) => { if (url.includes('/agent/bridges/')) { downloading = true; await held; } return fetch(url, init); }, bridgeTrust: { anchors, authenticode: async () => {} } } });
  t.after(async () => { release(); await agent.stop(); await hub.close(); fs.rmSync(root, { recursive: true, force: true }); });
  agent.run(); await hub.until(() => downloading); await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(hub.streams > 0);
});
test('R2.9 Mac disables unsupported offers with a reason in hello', async t => {
  const root = makeRoot(); const hub = await fakeHub({ credential: CREDENTIAL });
  const agent = createAgent({ root, config: { credential: CREDENTIAL, server: hub.url }, deps: { platform: 'darwin', machine: null, locate: async () => null, processes: async () => [] } });
  t.after(async () => { await agent.stop(); await hub.close(); fs.rmSync(root, { recursive: true, force: true }); });
  agent.run(); await hub.until(() => hub.hellos.length > 0);
  assert.equal(hub.hellos[0].capabilities.bridgeOffer, false); assert.match(hub.hellos[0].capabilities.bridgeOfferReason, /macOS/);
});
test('R2.10 application release gate rejects empty or differing trust anchors', async () => {
  const { assertBridgeTrust } = await load('scripts/bridge-trust-gate.mjs');
  assert.throws(() => assertBridgeTrust({ publicKey: '', thumbprint: '', nativeKey: '', nativeThumbprint: '' }), /anchors/);
  assert.throws(() => assertBridgeTrust({ publicKey: anchors.publicKey, thumbprint: anchors.thumbprint, nativeKey: anchors.publicKey, nativeThumbprint: 'B'.repeat(40) }), /differ/);
  assert.doesNotThrow(() => assertBridgeTrust({ publicKey: anchors.publicKey, thumbprint: anchors.thumbprint, nativeKey: anchors.publicKey, nativeThumbprint: anchors.thumbprint }));
});
test('R2.11 installed and failed reports survive an agent restart', async t => {
  const f = fixture(t); await f.install(); const selected = await f.store.select('odc', installed.version, installed.runtime, processIdentity);
  f.store.rejectLoad(selected, 'hook load failed', { ...processIdentity, attempted: true, bridgeFailure: true });
  const restarted = createBridgeUpdates(f.storeOptions);
  const records = restarted.reports(); assert.ok(Array.isArray(records));
  assert.ok(records.some(r => r.sequence === 1 && r.status === 'failed' && r.reason === 'FALLBACK_BUNDLED'));
});
test('R2.2 two concurrent O11 connects do not quarantine the verified bridge', async t => {
  const f = fixture(t); f.set(artifact(1, 'o11')); assert.equal(await f.install(), true);
  const port = await freePort(); let bridge; let entered; let release;
  const started = new Promise(resolve => { entered = resolve; }); const hold = new Promise(resolve => { release = resolve; });
  const bridgeBytes = artifact(1, 'o11').files['bridge/Anvil.Bridge.dll'];
  t.after(async () => { release(); await bridge?.close(); });
  const target = { pid: 4567, startedUtc: '2026-10-28T00:00:00.0000000Z', version: '11.55.94', path: path.join(f.root, 'ServiceStudio.exe') };
  const kinds = createKinds({ root: f.root, ws: createWorkspace(f.root), pack: readPack(f.root), kernel: () => ({ o11: '11.55.94' }), o11Port: port,
    deps: { processes: async () => [target], studioRuntime: async () => 'net10.0', bridgeUpdates: f.store,
      describe: async () => ({ ...target, diagnosticsAvailable: true }), attachO11: async () => {
        entered(); await hold; fs.writeFileSync(path.join(f.root, 'private/authority/bridge.key'), 'test-key');
        bridge = await fakeBridge(request => request.method === 'ping' ? { success: true, data: { bridge: 'anvil', pid: target.pid } }
          : request.method === 'bridge_manifest' ? { success: true, data: { flavor: 'thin', protocolVersion: 2, authentication: true, bridgeSha256: hash(bridgeBytes) } }
            : { success: true, data: { alive: true } }, { port });
      } } });
  const first = kinds.execute('o11.connect', { pid: target.pid }); await started;
  await assert.rejects(kinds.execute('o11.connect', { pid: target.pid }), /Another connection attempt/);
  assert.ok(await f.store.select('o11', target.version, 'net10.0', target));
  assert.ok(!f.store.reports().some(r => r.status === 'failed'));
  release(); assert.equal((await first).ok, true);
});
test('R2.4 pipe only checks its active protocol without cryptographic verification', async t => {
  const f = fixture(t); await f.install(); const target = { ...processIdentity, version: installed.version, path: path.join(f.root, 'ODCStudio.exe') };
  const selected = await f.store.select('odc', installed.version, installed.runtime, target); f.store.markActive(selected, target); const before = f.checks();
  const kinds = createKinds({ root: f.root, pack: readPack(f.root), ws: createWorkspace(f.root), kernel: () => ({ odc: installed.version }), deps: {
    processes: async () => [target], bridgeUpdates: f.store, studioRuntime: async () => { throw new Error('Pipe must not read runtime metadata'); },
    pipeCall: async (pid, version, words) => JSON.stringify(words[0] === 'agent-root' ? { ok: true, protocol: 1, root: path.join(f.root, 'odc') } : { ok: true }) } });
  await kinds.execute('odc.pipe', { pid: target.pid, version: 'v100', args: ['status'] }); assert.equal(f.checks(), before);
});
test('R2.4 active protocols remain bound to each Studio process', async t => {
  const f = fixture(t); await f.install(); const bridge = await f.store.select('odc', installed.version, installed.runtime);
  const second = { pid: 4567, startedUtc: 'other-process' }; f.store.markActive(bridge, processIdentity); f.store.markActive(bridge, second);
  assert.equal(f.store.protocolFor('odc', installed.version, processIdentity), 'v100');
  assert.equal(f.store.protocolFor('odc', installed.version, second), 'v100');
});
test('R2.2 data-root binding failure never quarantines a loaded bridge', async t => {
  const f = fixture(t); await f.install();
  const client = path.join(f.root, 'odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.dll');
  fs.mkdirSync(path.dirname(client), { recursive: true }); fs.writeFileSync(client, 'packaged client');
  const target = { ...processIdentity, version: installed.version, path: path.join(f.root, 'ODCStudio.exe') };
  const kinds = createKinds({ root: f.root, pack: readPack(f.root), ws: createWorkspace(f.root), kernel: () => ({ odc: installed.version }), deps: {
    processes: async () => [target], bridgeUpdates: f.store, studioRuntime: async () => installed.runtime,
    attachOdc: async () => ({ ok: true, attached: true }), pipeCall: async () => { throw new Error('temporary pipe failure'); } } });
  await assert.rejects(kinds.execute('odc.attach', { pid: target.pid }), /data directory/);
  assert.ok(await f.store.select('odc', installed.version, installed.runtime, target));
});
test('R2.2 a higher signed sequence is eligible while the old identity is blocked', async t => {
  const f = fixture(t); await f.install();
  const bridge = await f.store.select('odc', installed.version, installed.runtime, processIdentity);
  f.store.rejectLoad(bridge, 'load failed', { ...processIdentity, attempted: true, bridgeFailure: true });
  f.set(artifact(2)); assert.equal(await f.install(), true);
  assert.equal((await f.store.select('odc', installed.version, installed.runtime, processIdentity)).sequence, 2);
});
test('R2.4 changed size or mtime invalidates the verification cache', async t => {
  const f = fixture(t); await f.install(); const bridge = await f.store.select('odc', installed.version, installed.runtime);
  const before = f.checks(); const file = path.join(bridge.root, bridge.files[0].path); const stamp = new Date(Date.now() + 10000);
  fs.utimesSync(file, stamp, stamp); assert.ok(await f.store.select('odc', installed.version, installed.runtime));
  assert.ok(f.checks() > before);
  fs.writeFileSync(file, 'tampered'); assert.equal(await f.store.select('odc', installed.version, installed.runtime), null);
});
