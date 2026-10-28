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
    const manifest = JSON.stringify({ schema: 1, lane: 'odc', studioVersion: '1.7.30', runtime: 'net10.0', protocol,
      createdAt: '2026-10-28T00:00:00Z', authenticodeThumbprint: thumbprint, files: [{ path: 'bridge/ODC3.Bridge.' + protocol + '.dll', size: bytes.length, sha256: hash(bytes) }], ...alter });
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
  assert.equal(f.gets(), 2);
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
  assert.equal(fs.existsSync(path.join(f.root, 'bridges/odc/1.7.30/v101')), false);
});
