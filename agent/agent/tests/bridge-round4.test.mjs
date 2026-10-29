import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { fakeBridge } from './fixtures/fake-bridge.mjs';
import { freePort } from './fixtures/ports.mjs';
const code = process.env.SSAM_REVIEW_BASE ? path.join(process.env.SSAM_REVIEW_BASE, 'agent') : path.resolve(import.meta.dirname, '../..');
const load = file => import(pathToFileURL(path.join(code, file)));
const { createBridgeUpdates } = await load('agent/lib/bridge-updates.mjs');
const { createAgent } = await load('agent/lib/agent.mjs');
const { createKinds } = await load('agent/lib/kinds.mjs');
const { createWorkspace } = await load('agent/lib/workspace.mjs');
const hash = b => createHash('sha256').update(b).digest('hex');
const keys = generateKeyPairSync('ed25519');
const anchors = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), thumbprint: 'A'.repeat(40) };
const context = { pid: 2000000000, startedUtc: '2026-10-28T10:00:16.9925336Z' };
const cim = { ...context, startedUtc: '2026-10-28T10:00:16.9925330Z' };
const installed = { odc: { installed: { version: '1.7.30', runtime: 'net10.0' } } };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-')); let locks = 0;
  const bytes = Buffer.from('signed fixture');
  const m = { schema: 1, lane: 'odc', studioVersion: '1.7.30', runtime: 'net10.0', protocol: 'v100', sequence: 1, createdAt: '2026-10-28T00:00:00Z', authenticodeThumbprint: anchors.thumbprint,
    files: ['bridge/ODC3.Bridge.v100.dll', 'client/ODC3.Bridge.Client.dll'].map(p => ({ path: p, signer: 'owner', size: bytes.length, sha256: hash(bytes) })) };
  const offer = value => { const manifest = JSON.stringify(value); return { ...value, manifest, signature: sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') }; };
  const options = { root, anchors, authenticode: async () => {}, request: async () => new Response(bytes), seal: async () => { locks++; return { release() { locks--; }, alive: () => true }; } };
  let store = createBridgeUpdates(options);
  t.after(async () => { await store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, m, offer, options, get store() { return store; }, locks: () => locks,
    async restart() { await store.dispose(); store = createBridgeUpdates(options); },
    install: (value = offer(m), studios = installed) => store.offers({ compatible: { odc: { bridgeOffer: value } } }, studios),
    select: (c = context) => store.select('odc', '1.7.30', 'net10.0', c) };
}
test('R4.1 closing a Studio restores installed telemetry and reoffers repair missing telemetry', async t => {
  const f = fixture(t); await f.install(); const selected = await f.select(); f.store.markActive(selected, context);
  await f.store.reconcile([], installed);
  assert.equal(f.store.reports()[0]?.status, 'installed');
  const file = path.join(f.root, 'private/bridge-state.json'); const state = JSON.parse(fs.readFileSync(file)); state.reports = {}; fs.writeFileSync(file, JSON.stringify(state));
  await f.restart(); assert.equal(await f.install(), true); assert.equal(f.store.reports()[0].status, 'installed');
});
test('R4.1 startup recovers installed telemetry from the verified artifact', async t => {
  const f = fixture(t); await f.install(); const file = path.join(f.root, 'private/bridge-state.json');
  const state = JSON.parse(fs.readFileSync(file)); state.reports = {}; fs.writeFileSync(file, JSON.stringify(state)); await f.restart();
  await f.store.initialize?.(installed); assert.equal(f.store.reports()[0]?.status, 'installed');
});
test('R4.2 transient runtime refusal preserves an installed identity', async t => {
  const f = fixture(t); await f.install(); const previous = f.store.reports();
  await f.install(f.offer(f.m), { odc: { installed: { version: '1.7.30', runtime: null } } });
  assert.deepEqual(f.store.reports(), previous);
});
test('R4.2 unauthenticated and interrupted offers never create persistent refusals', async t => {
  const f = fixture(t); const wrong = f.offer(f.m); wrong.signature = Buffer.alloc(64).toString('base64');
  await f.install(wrong); assert.deepEqual(f.store.reports(), []);
  const interrupted = createBridgeUpdates({ ...f.options, request: async () => { throw new Error('interrupted'); } });
  await interrupted.offers({ compatible: { odc: { bridgeOffer: f.offer(f.m) } } }, installed);
  assert.deepEqual(interrupted.reports(), []); await interrupted.dispose();
});
test('R4.2 even an authenticated signer refusal cannot overwrite active telemetry', async t => {
  const f = fixture(t); await f.install(); f.store.markActive(await f.select(), context); const previous = f.store.reports();
  const m = structuredClone(f.m); m.files[0].signer = 'microsoft'; await f.install(f.offer(m));
  assert.deepEqual(f.store.reports(), previous);
});
test('R4.3 microseconds identify the same active, blocked and leased Studio instance', async t => {
  const f = fixture(t); await f.install(); const selected = await f.select(); const lease = await f.store.prepareAttach(selected, context);
  f.store.markActive(selected, context); await f.store.reconcile([cim], installed);
  assert.equal(f.locks(), 1); assert.ok(fs.existsSync(lease.root)); assert.equal(f.store.protocolFor('odc', '1.7.30', cim), 'v100');
  assert.equal(f.store.isActive(selected, cim), true);
  f.store.rejectLoad(selected, 'failed', { ...context, attempted: true, bridgeFailure: true }); assert.equal(await f.select(cim), null);
});
test('R4.4 unavailable or partial enumeration preserves the lease and cannot throw', async t => {
  const f = fixture(t); await f.install(); const lease = await f.store.prepareAttach(await f.select(), context); f.store.markActive(await f.select(), context);
  await assert.doesNotReject(f.store.reconcile(null, installed)); await assert.doesNotReject(f.store.reconcile([{ pid: context.pid }], installed));
  assert.equal(f.locks(), 1); assert.ok(fs.existsSync(lease.root));
});
test('R4.4 corrupt bridge state cannot keep the authenticated channel offline', async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'private/bridge-loads'), { recursive: true }); fs.writeFileSync(path.join(f.root, 'private/bridge-state.json'), '{corrupt');
  const credential = 'ssam_agent_' + 'a'.repeat(43); const hub = await fakeHub({ credential });
  const agent = createAgent({ root: f.root, config: { server: hub.url, credential }, deps: { machine: null, locate: async () => null, processes: async () => [] } });
  t.after(async () => { await agent.stop(); await hub.close(); }); agent.run(); await hub.until(() => hub.streams > 0, 2000);
  assert.equal(fs.readFileSync(path.join(f.root, 'private/bridge-state.json'), 'utf8'), '{corrupt');
});
test('R4.5 a post-load bind failure retains the complete locked copy and its original error', async t => {
  const f = fixture(t); await f.install(); let loaded = 0;
  const kinds = createKinds({ root: f.root, pack: { lanes: ['odc'], odcBridge: 'v98' }, ws: createWorkspace(f.root), kernel: () => ({ odc: '1.7.30' }),
    deps: { processes: async () => [{ ...context, path: path.join(f.root, 'ODCStudio.exe'), version: '1.7.30' }], studioRuntime: async () => 'net10.0', bridgeUpdates: f.store,
      attachOdc: async () => { loaded++; return { ok: true, attached: true }; }, pipeCall: async () => { throw new Error('pipe not ready'); } } });
  await assert.rejects(kinds.execute('odc.attach', { pid: context.pid }), e => e.code === 'ODC_DATA_ROOT_FAILED' && /did not confirm/.test(e.message) && !e.message.includes(f.root)); assert.equal(loaded, 1); assert.equal(f.locks(), 1);
  const directory = path.join(f.root, 'private/bridge-loads'); const snapshot = fs.readdirSync(directory).find(n => !n.endsWith('.json'));
  assert.ok(fs.existsSync(path.join(directory, snapshot, 'client/ODC3.Bridge.Client.dll')));
});
for (const phase of ['key', 'ui_alive', 'unconfirmed']) test('R4.5 O11 retains an attempted hook after ' + phase + ' failure', async t => {
  const f = fixture(t); const bytes = Buffer.from('signed O11 fixture'); let bridge, hook, elapsed = 0;
  const m = { ...f.m, lane: 'o11', studioVersion: '11.55.94', protocol: 'd1', files: ['hook/Anvil.RuntimeHook.Agent.dll', 'bridge/Anvil.Bridge.dll'].map(p => ({ path: p, signer: 'owner', sha256: hash(bytes), size: bytes.length })) };
  const updates = createBridgeUpdates({ ...f.options, request: async () => new Response(bytes) });
  t.after(async () => { await bridge?.close(); await updates.dispose(); });
  await updates.offers({ compatible: { o11: { bridgeOffer: f.offer(m) } } }, { o11: { installed: { version: '11.55.94', runtime: 'net10.0' } } });
  const port = await freePort();
  const kinds = createKinds({ root: f.root, pack: { lanes: ['o11'], o11BuiltFor: '11.55.94', o11Hook: 'dev' }, ws: createWorkspace(f.root), kernel: () => ({ o11: '11.55.94' }), o11Port: port,
    deps: { processes: async () => [{ ...cim, path: path.join(f.root, 'ServiceStudio.exe'), version: '11.55.94' }], studioRuntime: async () => 'net10.0', bridgeUpdates: updates,
      describe: async () => ({ ...context, diagnosticsAvailable: true }), sleep: async ms => { elapsed += ms; }, now: () => elapsed,
      attachO11: async (pid, started, file) => {
        hook = file;
        if (phase === 'unconfirmed') return;
        if (phase !== 'key') { fs.mkdirSync(path.join(f.root, 'private/authority'), { recursive: true }); fs.writeFileSync(path.join(f.root, 'private/authority/bridge.key'), 'key'); }
        bridge = await fakeBridge(request => request.method === 'ping' ? { success: true, data: { bridge: 'anvil', pid } }
          : request.method === 'bridge_manifest' ? { success: true, data: { flavor: 'thin', protocolVersion: 2, authentication: true, bridgeSha256: hash(bytes) } }
            : { success: false, error: 'busy' }, { port });
      } } });
  await assert.rejects(kinds.execute('o11.connect', { pid: context.pid }));
  assert.equal(f.locks(), 1); assert.ok(fs.existsSync(hook + '.json')); await updates.reconcile([cim]); assert.equal(f.locks(), 1);
});
test('R4.6 installed reports alone do not schedule process scans', async t => {
  const f = fixture(t); await f.install(); assert.equal(f.store.needsReconcile(), false);
});
test('R4.6 one cached native snapshot covers both Studios and rejects incomplete results', async () => {
  const { createStudioSnapshot } = await load('agent/lib/studio-snapshot.mjs'); let calls = 0; let time = 0;
  const snapshot = createStudioSnapshot({ runtimeRoot: 'C:/app', now: () => time, run: async (exe, args) => { calls++; assert.deepEqual(args, ['studio-instances']); return { stdout: JSON.stringify({ complete: calls === 1, processes: [context] }) }; } });
  assert.deepEqual(await snapshot(), [context]); await snapshot(); assert.equal(calls, 1); time = 1001; assert.equal(await snapshot(), null);
});
test('R4.7 documents metadata-preserving overwrites and the attach verification boundary', () => {
  const text = fs.readFileSync(path.join(code, 'docs/AUTO-BRIDGES.md'), 'utf8');
  assert.match(text, /in-place overwrite can preserve size, mtime and file id/);
  assert.match(text, /full verification of the locked copy at attach/);
});
