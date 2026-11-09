// Agent 0.3.17: the Windows build is never Authenticode-signed. A bridge offer is accepted when its manifest verifies against
// the pinned Ed25519 key and every file matches the manifest sha256/size; Authenticode stays only on the Microsoft-signed
// dependencies. Replay/downgrade, paths and the failed state are as strict as before; an empty anchor says bridgeOffer false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createBridgeUpdates, verifyAuthenticode, authenticodeDisposition } from '../lib/bridge-updates.mjs';
import { helloCapabilities, NO_ANCHORS_REASON } from '../lib/agent.mjs';
import { BRIDGE_MANIFEST_PUBLIC_KEY } from '../lib/bridge-trust.mjs';

const keys = generateKeyPairSync('ed25519');
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const spki = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const installed = { odc: { installed: { version: '1.7.30.1234', runtime: 'net10.0' } } };
function offer({ sequence = 1, protocol = 'v101', microsoft = false, key = keys.privateKey, alter = m => m } = {}) {
  const files = { [`bridge/ODC3.Bridge.${protocol}.dll`]: Buffer.from('owner bridge ' + sequence), 'client/ODC3.Bridge.Client.dll': Buffer.from('owner client ' + sequence),
    ...(microsoft ? { 'client/Microsoft.Diagnostics.NETCore.Client.dll': Buffer.from('microsoft dependency') } : {}) };
  // No authenticodeThumbprint: a manifest of the Ed25519-only model.
  const m = alter({ schema: 1, lane: 'odc', studioVersion: '1.7.30', runtime: 'net10.0', protocol, sequence, createdAt: '2026-11-08T00:00:00Z',
    files: Object.entries(files).map(([name, bytes]) => ({ path: name, signer: /Microsoft\./.test(name) ? 'microsoft' : 'owner', sha256: digest(bytes), size: bytes.length })) });
  const manifest = JSON.stringify(m);
  return { files, value: { lane: 'odc', studioVersion: '1.7.30', protocol, manifest, signature: sign(null, Buffer.from(manifest), key).toString('base64') } };
}
function store(t, { publicKey = spki, authenticode, serve } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ed25519-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = []; const events = []; let files = {};
  const updates = createBridgeUpdates({ root, platform: 'win32', anchors: { publicKey }, seal: async () => ({ release() {} }), notify: e => events.push(e),
    authenticode: authenticode ?? (async (file, signer) => { calls.push({ file: path.basename(file), signer }); throw Object.assign(new Error('Authenticode signer does not match the pinned policy'), { signerRefused: true }); }),
    request: async route => { const bytes = (serve ?? (() => Object.values(files).find(b => route.endsWith(digest(b)))))(route, files); return bytes ? new Response(bytes) : new Response(null, { status: 404 }); } });
  return { root, updates, calls, events, install: async item => { files = item.files; return updates.offers({ compatible: { odc: { bridgeOffer: item.value } } }, installed); },
    dir: item => path.join(root, 'bridges/odc/1.7.30', item.value.protocol, String(JSON.parse(item.value.manifest).sequence)) };
}

test('Windows: a valid Ed25519 offer installs with no Authenticode check of the owner files (unsigned bridge)', async t => {
  const s = store(t); const item = offer();
  assert.equal(await s.install(item), true);
  assert.deepEqual(s.calls, [], 'the owner files are never sent to Authenticode');
  assert.ok(fs.existsSync(path.join(s.dir(item), 'manifest.json')));
  assert.equal((await s.updates.select('odc', '1.7.30.1234', 'net10.0')).protocol, 'v101', 'and it is selected after a reverification');
  assert.equal(s.updates.reports()[0].status, 'installed');
});

test('the pinned key may be given as the base64 SPKI the native core is built with, or as a PEM', async t => {
  for (const publicKey of [spki, pem]) { const s = store(t, { publicKey }); assert.equal(await s.install(offer()), true); }
});

test('a legacy manifest naming an authenticodeThumbprint is accepted on its signature alone (the field grants nothing)', async t => {
  const s = store(t); const item = offer({ alter: m => ({ ...m, authenticodeThumbprint: 'B'.repeat(40) }) });
  assert.equal(await s.install(item), true);
});

test('a tampered file (bytes or size) is refused, nothing is installed and the offer may come again', async t => {
  const s = store(t, { serve: (route, files) => { const bytes = Object.values(files).find(b => route.endsWith(digest(b))); return bytes && Buffer.from(bytes.toString().replace('owner', 'evil!')); } });
  const item = offer();
  assert.equal(await s.install(item), false);
  assert.equal(fs.existsSync(s.dir(item)), false);
  assert.match(s.events.at(-1).message, /refused|SHA-256|size/i);
  const short = store(t, { serve: (route, files) => Object.values(files).find(b => route.endsWith(digest(b)))?.subarray(1) });
  assert.equal(await short.install(item), false);
});

test('a manifest whose sha256 was changed after signing, or signed by another key, is refused before any download', async t => {
  let downloads = 0;
  const s = store(t, { serve: (route, files) => { downloads++; return Object.values(files).find(b => route.endsWith(digest(b))); } });
  const item = offer(); const m = JSON.parse(item.value.manifest); m.files[0].sha256 = digest(Buffer.from('evil'));
  assert.equal(await s.install({ ...item, value: { ...item.value, manifest: JSON.stringify(m) } }), false);
  assert.equal(await s.install(offer({ key: generateKeyPairSync('ed25519').privateKey })), false);
  assert.equal(downloads, 0);
  assert.match(s.events.at(-1).message, /signature/);
  assert.equal(fs.existsSync(path.join(s.root, 'bridges/odc/1.7.30')), false);
});

test('a replayed older sequence or a lower protocol is refused after a newer install; a same-identity rewrite too', async t => {
  const s = store(t);
  assert.equal(await s.install(offer({ sequence: 5 })), true);
  assert.equal(await s.install(offer({ sequence: 4 })), false);
  assert.match(s.events.at(-1).message, /replay|downgrade/);
  assert.equal(await s.install(offer({ sequence: 6, protocol: 'v100' })), false);
  assert.match(s.events.at(-1).message, /downgrade/);
  assert.equal(await s.install(offer({ sequence: 5, alter: m => ({ ...m, createdAt: '2026-11-09T00:00:00Z' }) })), false);
  assert.match(s.events.at(-1).message, /cannot be replaced/);
  assert.equal(fs.existsSync(path.join(s.root, 'bridges/odc/1.7.30/v101/4')), false);
});

test('a Microsoft dependency keeps its Authenticode check: refused when it fails, installed when it passes', async t => {
  const refused = store(t); const item = offer({ microsoft: true });
  assert.equal(await refused.install(item), false);
  assert.deepEqual(refused.calls, [{ file: 'Microsoft.Diagnostics.NETCore.Client.dll', signer: 'microsoft' }], 'only the Microsoft file is checked');
  assert.equal(refused.updates.reports()[0]?.reason, 'SIGNER_REFUSED');
  const checked = [];
  const accepted = store(t, { authenticode: async (file, signer) => { checked.push([path.basename(file), signer]); } });
  assert.equal(await accepted.install(offer({ microsoft: true })), true);
  assert.deepEqual(checked, [['Microsoft.Diagnostics.NETCore.Client.dll', 'microsoft']]);
  const entry = store(t); const disguised = offer({ alter: m => ({ ...m, files: m.files.map((f, i) => i === 0 ? { ...f, signer: 'microsoft' } : f) }) });
  assert.equal(await entry.install(disguised), false, 'an owner entrypoint can never claim to be a Microsoft file');
});

test('the Authenticode verifier accepts only the Microsoft class; the owner class is no longer a pin', async () => {
  const valid = { ok: true, signatureValid: true, hresult: 0 };
  assert.equal(authenticodeDisposition(valid, 'microsoft'), 'accepted');
  assert.equal(authenticodeDisposition(valid, 'owner'), 'refused');
  let ran = false;
  await assert.rejects(verifyAuthenticode('C:\\b.dll', { platform: 'win32', runtimeRoot: 'C:\\r', signer: 'owner', run: async () => { ran = true; return { stdout: JSON.stringify(valid) }; } }), /pinned policy/);
  assert.equal(ran, false);
  let args;
  await verifyAuthenticode('C:\\b.dll', { platform: 'win32', runtimeRoot: 'C:\\r', run: async (exe, a) => { args = a; return { stdout: JSON.stringify(valid) }; } });
  assert.deepEqual(args, ['authenticode', '--file', 'C:\\b.dll', '--signer', 'microsoft']);
});

test('empty anchor: the hello says bridgeOffer false and no offer is ever installed; macOS is unchanged', async t => {
  assert.equal(BRIDGE_MANIFEST_PUBLIC_KEY, '', 'the source carries no anchor: the build input gives it');
  assert.deepEqual(helloCapabilities('win32', {}), { bridgeOffer: false, bridgeOfferReason: NO_ANCHORS_REASON });
  assert.deepEqual(helloCapabilities('win32', {}, ''), { bridgeOffer: false, bridgeOfferReason: NO_ANCHORS_REASON });
  assert.deepEqual(helloCapabilities('win32', {}, spki), { bridgeOffer: true });
  assert.deepEqual(helloCapabilities('win32', { bridgeOffer: false }, spki), { bridgeOffer: false, bridgeOfferReason: NO_ANCHORS_REASON });
  assert.equal(helloCapabilities('darwin', {}, spki).bridgeOffer, false);
  assert.match(helloCapabilities('darwin', {}, spki).bridgeOfferReason, /macOS/);
  const s = store(t, { publicKey: '' }); const item = offer();
  assert.equal(await s.install(item), false);
  assert.match(s.events.at(-1).message, /not configured/);
  assert.equal(fs.existsSync(path.join(s.root, 'bridges')), false);
});

test('a link inside the bridge tree is refused and the bridge is not selected', { skip: process.platform !== 'win32' && 'junctions are a Windows check' }, async t => {
  const s = store(t); const item = offer();
  assert.equal(await s.install(item), true);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-outside-')); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'ODC3.Bridge.Client.dll'), 'evil');
  const client = path.join(s.dir(item), 'client');
  fs.rmSync(client, { recursive: true, force: true }); fs.symlinkSync(outside, client, 'junction');
  assert.equal(await s.updates.select('odc', '1.7.30.1234', 'net10.0'), null);
  assert.match(s.events.at(-1).message, /links|Unlisted|missing/i);
});
