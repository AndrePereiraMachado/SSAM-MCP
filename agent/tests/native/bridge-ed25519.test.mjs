// 0.4.14-native: the native core accepts a bridge offer on Windows when its manifest verifies against the pinned Ed25519 key
// and every file matches the manifest sha256/size, with no Authenticode check of the owner files; Microsoft dependencies keep
// theirs. Replay/downgrade stay refused, and an empty anchor says bridgeOffer false. Build tests/bridge-updates-harness first
// (it references native/Ssam.Agent), then run this file with the other native suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fakeHub } from '../../agent/tests/fixtures/fake-hub.mjs';

const dll = fileURLToPath(new URL('../bridge-updates-harness/bin/Release/net10.0/NativeProtocol.Tests.dll', import.meta.url));
const keys = generateKeyPairSync('ed25519');
const spki = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const hash = b => createHash('sha256').update(b).digest('hex');
function harness(input, { exit = 0 } = {}) {
  const child = spawn('dotnet', [dll], { windowsHide: true }); let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  // "thumbprint" is what a harness before 0.4.14-native required; the current one ignores it.
  child.stdin.end(JSON.stringify({ publicKey: spki, thumbprint: 'A'.repeat(40), ...input }));
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { try { assert.equal(code, exit, stderr + stdout); resolve(JSON.parse(stdout)); } catch (e) { reject(e); } }); });
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-ed25519-'));
  const files = new Map(); let tamper = false;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer bridge-test-token') { res.writeHead(401).end(); return; }
    const bytes = files.get(req.url); if (!bytes) { res.writeHead(404).end(); return; }
    const body = tamper ? Buffer.from(bytes.toString().replace('owner', 'evil!')) : bytes;
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  function offer({ sequence = 1, protocol = 'v101', microsoft = false, key = keys.privateKey, thumbprint } = {}) {
    const items = [['bridge/ODC3.Bridge.' + protocol + '.dll', 'owner'], ['client/ODC3.Bridge.Client.dll', 'owner'], ...(microsoft ? [['client/Microsoft.Diagnostics.NETCore.Client.dll', 'microsoft']] : [])]
      .map(([name, signer]) => ({ name, signer, bytes: Buffer.from(signer + ' ' + name + ' ' + sequence) }));
    for (const item of items) files.set('/agent/bridges/odc/1.7.30/' + protocol + '/' + hash(item.bytes), item.bytes);
    const manifest = JSON.stringify({ schema: 1, lane: 'odc', studioVersion: '1.7.30', runtime: 'net10.0', protocol, sequence, createdAt: '2026-11-08T00:00:00Z',
      ...(thumbprint ? { authenticodeThumbprint: thumbprint } : {}), files: items.map(i => ({ path: i.name, size: i.bytes.length, signer: i.signer, sha256: hash(i.bytes) })) });
    return { lane: 'odc', studioVersion: '1.7.30', protocol, manifest, signature: sign(null, Buffer.from(manifest), key).toString('base64') };
  }
  return { root, offer, tamper: value => { tamper = value; }, run: input => harness({ root, server: 'http://127.0.0.1:' + server.address().port + '/', ...input }) };
}

test('native: a valid Ed25519 offer installs on Windows with no Authenticode check of the owner files', async t => {
  const f = await fixture(t);
  // authenticode false: the test check refuses every file it is given, so the offer installs only if no owner file is checked.
  const results = await f.run({ authenticode: false, requests: [{ offer: f.offer() }, {}] });
  assert.equal(results[0].changed, true); assert.equal(results[0].checks, 0);
  assert.equal(results[1].selected, 'v101');
  assert.equal(results[0].reports[0].status, 'installed');
  const legacy = await f.run({ authenticode: false, requests: [{ offer: f.offer({ sequence: 2, thumbprint: 'C'.repeat(40) }) }] });
  assert.equal(legacy[0].changed, true, 'a legacy authenticodeThumbprint grants nothing and blocks nothing');
});

test('native: a tampered file or a manifest signed by another key is refused; nothing is installed', async t => {
  const f = await fixture(t); f.tamper(true);
  const tampered = await f.run({ requests: [{ offer: f.offer() }, {}] });
  assert.equal(tampered[0].changed, false); assert.equal(tampered[1].selected, null);
  assert.match(tampered[0].status.message, /SHA-256|size/);
  f.tamper(false);
  const wrongKey = await f.run({ requests: [{ offer: f.offer({ key: generateKeyPairSync('ed25519').privateKey }) }] });
  assert.equal(wrongKey[0].changed, false); assert.match(wrongKey[0].status.message, /signature/);
  const edited = f.offer(); const m = JSON.parse(edited.manifest); m.files[0].sha256 = hash(Buffer.from('evil')); edited.manifest = JSON.stringify(m);
  assert.equal((await f.run({ requests: [{ offer: edited }] }))[0].changed, false, 'a sha256 changed after signing breaks the signature');
  assert.equal(fs.existsSync(path.join(f.root, 'bridges/odc/1.7.30/v101/1')), false);
});

test('native: a replayed older sequence or a lower protocol is refused after a newer install', async t => {
  const f = await fixture(t);
  const results = await f.run({ authenticode: false, requests: [{ offer: f.offer({ sequence: 5 }) }, { offer: f.offer({ sequence: 4 }) }, { offer: f.offer({ sequence: 6, protocol: 'v100' }) }] });
  assert.equal(results[0].changed, true);
  assert.equal(results[1].changed, false); assert.match(results[1].status.message, /replay|downgrade/);
  assert.equal(results[2].changed, false); assert.match(results[2].status.message, /downgrade/);
  assert.equal(fs.existsSync(path.join(f.root, 'bridges/odc/1.7.30/v101/4')), false);
});

test('native: a Microsoft dependency keeps its Authenticode check', async t => {
  const f = await fixture(t);
  const refused = await f.run({ authenticode: false, requests: [{ offer: f.offer({ microsoft: true }) }] });
  assert.equal(refused[0].changed, false); assert.equal(refused[0].checks, 1, 'exactly the Microsoft file is checked');
  const accepted = await f.run({ requests: [{ offer: f.offer({ microsoft: true, sequence: 2 }) }] });
  assert.equal(accepted[0].changed, true); assert.equal(accepted[0].checks, 1);
});

test('native: an empty anchor refuses every offer and the hello says bridgeOffer false', async t => {
  const f = await fixture(t);
  const none = await f.run({ publicKey: '', requests: [{ offer: f.offer() }] });
  assert.equal(none[0].changed, false); assert.match(none[0].status.message, /not configured/);
  for (const [publicKey, expected] of [['', false], [spki, true]]) {
    const hub = await fakeHub({ credential: 'bridge-test-token' });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-ed25519-channel-'));
    try {
      const run = harness({ root, server: hub.url + '/', publicKey, channel: true, installed: {} });
      await hub.until(() => hub.hellos.length >= 1);
      assert.equal(hub.hellos[0].capabilities.bridgeOffer, expected);
      if (!expected) assert.match(hub.hellos[0].capabilities.bridgeOfferReason, /without the bridge trust anchors/);
      await hub.until(() => hub.stream);
      hub.send({ t: 'close', reason: 'replaced' });
      assert.equal((await run).exitCode, 3);
    } finally { await hub.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
