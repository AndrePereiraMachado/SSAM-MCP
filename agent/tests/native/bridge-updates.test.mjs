// Build tests/bridge-updates-harness once, then run this file sequentially with the other native suites.
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
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const thumbprint = 'A'.repeat(40);
const hash = b => createHash('sha256').update(b).digest('hex');
const message = Buffer.from('exact signed bytes\n');
async function run(input) {
  const child = spawn('dotnet', [dll], { windowsHide: true }); let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  child.stdin.end(JSON.stringify({ publicKey, thumbprint, ...input }));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, stderr + stdout);
  return JSON.parse(stdout);
}
test('native Ed25519 matches generated Node signatures and rejects corruption, wrong keys and noncanonical S', async () => {
  const signature = sign(null, message, keys.privateKey);
  const corrupt = Buffer.from(signature); corrupt[0] ^= 1;
  const noncanonical = Buffer.from(signature); noncanonical.fill(255, 32);
  const wrong = sign(null, message, generateKeyPairSync('ed25519').privateKey);
  const checks = [signature, corrupt, noncanonical, wrong].map(s => ({ message: message.toString('base64'), signature: s.toString('base64') }));
  assert.deepEqual(await run({ verify: checks }), [true, false, false, false]);
});
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bridge-'));
  const files = new Map(); let gets = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer bridge-test-token') { res.writeHead(401).end(); return; }
    gets++;
    const bytes = files.get(req.url);
    if (!bytes) { res.writeHead(404).end(); return; }
    if (bytes === 'interrupt') { res.writeHead(200, { 'content-length': 10000 }); res.write('partial'); res.destroy(); return; }
    res.writeHead(200, { 'content-length': bytes.length }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  function offer(protocol, alter = {}) {
    const bytes = Buffer.from('test bridge ' + protocol);
    const manifest = JSON.stringify({ schema: 1, lane: 'odc', studioVersion: '1.7.30', runtime: 'net10.0', protocol, sequence: Number(protocol.slice(1)),
      createdAt: '2026-10-28T00:00:00Z', authenticodeThumbprint: thumbprint, files: [{ path: 'bridge/ODC3.Bridge.' + protocol + '.dll', size: bytes.length, sha256: hash(bytes) },
        { path: 'client/ODC3.Bridge.Client.dll', size: bytes.length, sha256: hash(bytes) }], ...alter });
    files.set('/agent/bridges/odc/1.7.30/' + protocol + '/' + hash(bytes), bytes);
    return { lane: 'odc', studioVersion: '1.7.30', protocol, manifest, signature: sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') };
  }
  return { root, offer, files, gets: () => gets, run: input => run({ root, server: 'http://127.0.0.1:' + server.address().port + '/', ...input }) };
}
test('native authenticated install, exact runtime, retained fallback and downgrade protection', async t => {
  const f = await fixture(t);
  const older = f.offer('v101'), newer = f.offer('v102'), downgrade = f.offer('v100');
  const results = await f.run({ requests: [{ offer: older }, { offer: newer }, { runtime: 'net8.0' }, {}, { failLoad: true }, {}, { offer: downgrade }] });
  assert.equal(results[0].changed, true); assert.equal(results[1].changed, true);
  assert.equal(results[2].selected, null); assert.equal(results[3].selected, 'v102');
  assert.equal(results[5].selected, 'v101'); assert.equal(results[6].changed, false);
  assert.match(results[6].status.message, /downgrade/);
  assert.equal(f.gets(), 4);
  const restarted = await f.run({ requests: [{}] }); assert.equal(restarted[0].selected, 'v101');
});
for (const scenario of ['signature', 'hash', 'certificate', 'interrupt', 'path']) test('native refuses ' + scenario, async t => {
  const f = await fixture(t); const offer = f.offer('v101');
  if (scenario === 'signature') offer.signature = Buffer.alloc(64).toString('base64');
  if (scenario === 'hash') for (const [key, bytes] of f.files) f.files.set(key, Buffer.alloc(bytes.length));
  if (scenario === 'interrupt') for (const key of f.files.keys()) f.files.set(key, 'interrupt');
  if (scenario === 'path') {
    const m = JSON.parse(offer.manifest); m.files[0].path = '../bridge.dll'; offer.manifest = JSON.stringify(m);
    offer.signature = sign(null, Buffer.from(offer.manifest), keys.privateKey).toString('base64');
  }
  const result = await f.run({ authenticode: scenario !== 'certificate', requests: [{ offer }, {}] });
  assert.equal(result[0].changed, false); assert.equal(result[1].selected, null);
  assert.equal(fs.existsSync(path.join(f.root, 'bridges/odc/1.7.30/v101/101')), false);
});
test('native channel reconnects with the installed bridge and retains the original package id', async t => {
  const f = await fixture(t); const offer = f.offer('v101');
  const hub = await fakeHub({ credential: 'bridge-test-token', welcome: { compatible: { odc: { bridgeOffer: offer } } } });
  hub.holdBridges = true;
  t.after(() => hub.close());
  for (const [route, bytes] of f.files) hub.bridges.set(route, bytes);
  fs.writeFileSync(path.join(f.root, 'ODCStudio.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { tfm: 'net10.0' } }));
  const result = run({ root: f.root, server: hub.url + '/', channel: true, installed: { odc: { installed: { dir: f.root, version: '1.7.30.1' } } } });
  await hub.until(() => hub.bridgeWaiters.length > 0);
  await hub.until(() => hub.streams > 0, 1000);
  hub.releaseBridges();
  await hub.until(() => hub.hellos.length >= 2 && hub.hellos.at(-1).bridges.some(b => b.status === 'installed') && hub.stream && hub.streamChannel === hub.channel);
  assert.equal(hub.hellos[0].capabilities.bridgeOffer, true);
  assert.equal(hub.hellos[1].pack.odcBridge, 'v98');
  assert.equal(hub.hellos[1].pack.id, 'bridge-test');
  assert.equal(hub.hellos[1].bridges[0].protocol, 'v101');
  for (const end = Date.now() + 5000; ; await new Promise(resolve => setTimeout(resolve, 5))) {
    try { if (JSON.parse(fs.readFileSync(path.join(f.root, 'private/agent.json'), 'utf8')).state === 'connected') break; } catch { }
    assert.ok(Date.now() < end, 'The replacement stream must become connected');
  }
  hub.send({ t: 'ping', seq: 7 });
  await hub.until(() => hub.messages.some(m => m.t === 'pong' && m.seq === 7));
  hub.send({ t: 'close', reason: 'replaced' });
  assert.equal((await result).exitCode, 3, JSON.stringify({ hellos: hub.hellos.length, streams: hub.streams, requests: hub.requests }));
});
test('R2 native verification cache and locked attach snapshot', async t => {
  const f = await fixture(t); const offer = f.offer('v101');
  const result = await f.run({ requests: [{ offer }, {}, {}, { prepare: true }] });
  assert.equal(result[1].checks, result[0].checks); assert.equal(result[2].checks, result[0].checks);
  assert.ok(result[3].checks > result[2].checks); assert.equal(result[3].protectedCopy, true);
});
test('R2 native sequence and telemetry survive cleanup and process restart', async t => {
  const f = await fixture(t); const first = f.offer('v101', { sequence: 1 }), second = f.offer('v101', { sequence: 2 });
  const result = await f.run({ requests: [{ offer: first }, { offer: second }, { failLoad: true }, {}, { startedUtc: 'restarted' }] });
  assert.equal(result[1].changed, true); assert.equal(result[3].sequence, 1); assert.equal(result[4].sequence, 2);
  fs.rmSync(path.join(f.root, 'bridges'), { recursive: true, force: true });
  const replay = await f.run({ requests: [{ offer: first }, {}] });
  assert.equal(replay[0].changed, false); assert.ok(replay[1].reports.some(r => r.sequence === 2));
});
test('R2 native transient failures do not quarantine and the package wins', async t => {
  const f = await fixture(t); const offer = f.offer('v101');
  const result = await f.run({ requests: [{ offer }, { failLoad: true, attempted: false, bridgeFailure: false }, {}] });
  assert.equal(result[2].selected, 'v101'); assert.ok(!result[2].reports.some(r => r.status === 'failed'));
  const preferred = await f.run({ pack: { odcBridge: 'v110', odcBuiltFor: '1.7.30', odcRuntime: 'net10.0' }, requests: [{}] });
  assert.equal(preferred[0].selected, null);
});
