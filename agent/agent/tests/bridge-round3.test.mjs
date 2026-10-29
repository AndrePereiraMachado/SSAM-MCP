import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const code = process.env.SSAM_REVIEW_BASE ? path.join(process.env.SSAM_REVIEW_BASE, 'agent') : path.resolve(import.meta.dirname, '../..');
const { createBridgeUpdates } = await import(pathToFileURL(path.join(code, 'agent/lib/bridge-updates.mjs')));
const { attachOdc } = await import(pathToFileURL(path.join(code, 'agent/lib/odc-attach.mjs')));
const { createKinds } = await import(pathToFileURL(path.join(code, 'agent/lib/kinds.mjs')));
const { createWorkspace } = await import(pathToFileURL(path.join(code, 'agent/lib/workspace.mjs')));
const { assertBridgeTrust } = await import(pathToFileURL(path.join(code, 'scripts/bridge-trust-gate.mjs')));
const keys = generateKeyPairSync('ed25519');
const anchors = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), thumbprint: 'A'.repeat(40) };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const context = { pid: 123, startedUtc: '2026-10-28T00:00:00Z' };
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-')); let current; let seals = 0; let checks = 0;
  const store = createBridgeUpdates({ root, anchors, authenticode: async () => { checks++; },
    seal: async () => { seals++; return { release() {} }; }, request: async route => new Response(current.files.find(f => route.endsWith(digest(f.bytes))).bytes), ...extra });
  t.after(async () => { await store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  function artifact(sequence = 1, change = () => {}) {
    const files = ['bridge/ODC3.Bridge.v100.dll', 'client/ODC3.Bridge.Client.dll', 'client/Microsoft.Dependency.dll'].map((name, i) => ({ path: name, bytes: Buffer.from('file-' + i + '-' + sequence), signer: i === 2 ? 'microsoft' : 'owner' }));
    change(files);
    const m = { schema: 1, lane: 'odc', studioVersion: '1.7.30', protocol: 'v100', runtime: 'net10.0', sequence, createdAt: '2026-10-28T00:00:00Z', authenticodeThumbprint: anchors.thumbprint,
      files: files.map(({ bytes, ...f }) => ({ ...f, size: bytes.length, sha256: digest(bytes) })) };
    const manifest = JSON.stringify(m); current = { files, m };
    return { ...m, manifest, signature: sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') };
  }
  async function install(offer = artifact()) { return store.offers({ compatible: { odc: { bridgeOffer: offer } } }, { odc: { installed: { version: '1.7.30', runtime: 'net10.0' } } }); }
  const select = () => store.select('odc', '1.7.30', 'net10.0', context);
  return { root, store, artifact, install, select, seals: () => seals, checks: () => checks };
}
for (const invalid of ['missing', 'other', 'entrypoint']) test('R3.1 manifest refuses signer ' + invalid, async t => {
  const f = fixture(t); const offer = f.artifact(1, files => { if (invalid === 'missing') delete files[0].signer; else files[0].signer = invalid === 'entrypoint' ? 'microsoft' : 'third-party'; });
  assert.equal(await f.install(offer), false); assert.equal(f.checks(), 0);
});
test('R3.1 native verifier accepts real Microsoft provider chains without PowerShell', async () => {
  const executable = path.join(code, 'native/Ssam.Agent/bin/Release/net10.0/ssam-agent.exe');
  const result = await run(executable, ['authenticode', '--file', 'C:/t/vigia-auto/round2-e2e/v100/bin/Release/net10.0/Microsoft.Diagnostics.NETCore.Client.dll', '--signer', 'microsoft']);
  assert.equal(JSON.parse(result.stdout).ok, true);
});
test('R3.2 DiagnosticsClient rejected startup-hook arguments identify a bridge load failure', async () => {
  const error = Object.assign(new Error('client failed'), { stderr: 'Microsoft.Diagnostics.NETCore.Client.UnsupportedCommandException: ApplyStartupHookAsync failed - Invalid command argument.' });
  await assert.rejects(attachOdc({ pid: 1, client: 'c', bridge: 'b' }, { run: async () => { throw error; } }), e => e.attachAttempted === true && e.bridgeLoadFailure === true);
});
test('R3.3 repeated preparation reuses one snapshot and lock; failed preparation leaves no folder', async t => {
  const f = fixture(t); await f.install(); const selected = await f.select();
  const copies = await Promise.all(Array.from({ length: 8 }, () => f.store.prepareAttach(selected, context)));
  assert.equal(new Set(copies.map(x => x.root)).size, 1); assert.equal(f.seals(), 1);
  await copies[0].release();
  fs.writeFileSync(path.join(selected.root, selected.files[0].path), 'bad');
  await assert.rejects(f.store.prepareAttach(selected, context));
  assert.equal(fs.readdirSync(path.join(f.root, 'private/bridge-loads')).filter(n => fs.statSync(path.join(f.root, 'private/bridge-loads', n)).isDirectory()).length, 0);
});
test('R3.3 active identity is remembered and dead instances are pruned', async t => {
  const f = fixture(t); await f.install(); const selected = await f.select();
  await f.store.prepareAttach(selected, context); f.store.markActive(selected, context);
  assert.equal(f.store.isActive?.(selected, context), true);
  f.store.rejectLoad(selected, 'failed instance', { ...context, attempted: true, bridgeFailure: true });
  assert.ok(f.store.reports().some(r => r.status === 'failed'));
  await f.store.reconcile([], { odc: { installed: { version: '1.7.30' } } });
  assert.equal(f.store.isActive(selected, context), false); assert.equal(f.store.reports().length, 0);
});
test('R3.3 repeated and concurrent ODC attaches issue one load and preserve one snapshot', async t => {
  const f = fixture(t); await f.install(); let loads = 0;
  const kinds = createKinds({ root: f.root, pack: { lanes: ['odc'], odcBridge: 'v98' }, ws: createWorkspace(f.root), kernel: () => ({ odc: '1.7.30' }),
    deps: { processes: async () => [{ ...context, path: path.join(f.root, 'ODCStudio.exe'), version: '1.7.30' }], studioRuntime: async () => 'net10.0', bridgeUpdates: f.store,
      attachOdc: async () => { loads++; await new Promise(r => setTimeout(r, 10)); return { ok: true, attached: true }; },
      pipeCall: async () => JSON.stringify({ ok: true, protocol: 1, root: path.join(f.root, 'odc') }) } });
  await Promise.all(Array.from({ length: 6 }, () => kinds.execute('odc.attach', { pid: context.pid })));
  await kinds.execute('odc.attach', { pid: context.pid }); assert.equal(loads, 1); assert.equal(f.seals(), 1);
});
test('R3.4 refused offers report codes, bound history, and never invent sequence zero', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 19; i++) await f.install(f.artifact(i, files => { delete files[0].signer; }));
  const rows = f.store.reports(); assert.equal(rows.length, 16);
  assert.equal(rows[0].sequence, 19); assert.ok(rows.every(r => r.status === 'refused' && /^[A-Z_]{1,64}$/.test(r.reason) && r.sequence > 0));
  await f.install(f.artifact(20)); const selected = await f.select();
  f.store.rejectLoad(selected, 'failure at C:\\private\\secret.dll', { ...context, attempted: true, bridgeFailure: true });
  assert.ok(f.store.reports().every(r => r.sequence > 0 && /^[A-Z_]{1,64}$/.test(r.reason)));
  await f.install(f.artifact(22, files => { delete files[0].signer; }));
  assert.equal(await f.install(f.artifact(21)), false, 'A signed signer refusal preserves the high-water sequence');
});
test('R3.5 release gate compares the executable and Microsoft roots', () => {
  const options = { publicKey: anchors.publicKey, nativeKey: anchors.publicKey, thumbprint: anchors.thumbprint, nativeThumbprint: anchors.thumbprint,
    nativeExecutable: 'stale.exe', run: () => JSON.stringify({ spkiSha256: 'wrong', thumbprint: anchors.thumbprint, microsoftRoots: [] }) };
  assert.throws(() => assertBridgeTrust(options), /differ/);
});
test('R3.4 hello update metadata contains no free text or paths', async t => {
  const f = fixture(t); await f.install();
  assert.deepEqual(f.store.wireStatus(), { status: 'installed', lane: 'odc' });
});
test('R3.6 generic ODC bridge entrypoint is refused', async t => {
  const f = fixture(t); assert.equal(await f.install(f.artifact(1, files => { files[0].path = 'bridge/ODC3.Bridge.dll'; })), false);
});
