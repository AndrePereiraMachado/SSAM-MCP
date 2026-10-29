import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const thumbprint = 'A'.repeat(40);
const bytes = Buffer.from('verified test bridge'); const hash = createHash('sha256').update(bytes).digest('hex');
const context = { pid: 2000000000, startedUtc: '2026-10-28T10:00:16.9925336Z' };
const cim = { ...context, startedUtc: '2026-10-28T10:00:16.9925330Z' };
async function fixture(t, corrupt = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-r4-'));
  if (corrupt) { fs.mkdirSync(path.join(root, 'private/bridge-loads'), { recursive: true }); fs.writeFileSync(path.join(root, 'private/bridge-state.json'), '{corrupt'); }
  const server = http.createServer((req, res) => { assert.equal(req.headers.authorization, 'Bearer bridge-test-token'); res.writeHead(200, { 'content-length': bytes.length }).end(bytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const m = { schema: 1, lane: 'odc', studioVersion: '1.7.30', protocol: 'v100', runtime: 'net10.0', sequence: 1, createdAt: '2026-10-28T00:00:00Z', authenticodeThumbprint: thumbprint,
    files: ['bridge/ODC3.Bridge.v100.dll', 'client/ODC3.Bridge.Client.dll'].map(p => ({ path: p, signer: 'owner', size: bytes.length, sha256: hash })) };
  const manifest = JSON.stringify(m), offer = { ...m, manifest, signature: sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') };
  return { offer, async run(actions) {
    const dll = process.env.SSAM_REVIEW_BASE ? 'C:/t/vigia-auto/agent-r4-native-base/bin/Release/net10.0/NativeProtocol.Tests.dll' : path.resolve(import.meta.dirname, '../bridge-lifetime-harness/bin/Release/net10.0/NativeProtocol.Tests.dll');
    const child = spawn('dotnet', [dll], { windowsHide: true }); let output = '', error = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { error += b; });
    child.stdin.end(JSON.stringify({ root, publicKey, thumbprint, server: 'http://127.0.0.1:' + server.address().port + '/', actions }));
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); assert.equal(code, 0, error + output); return JSON.parse(output);
  } };
}
test('R4.1 native exited instances remain installed and a repeated offer repairs telemetry', async t => {
  const f = await fixture(t); const r = await f.run([{ op: 'offer', offer: f.offer }, { op: 'select' }, { op: 'active' }, { op: 'reconcile', running: [] }, { op: 'restart-without-report' }, { op: 'offer', offer: f.offer }]);
  assert.equal(r[3].reports[0]?.status, 'installed'); assert.equal(r[5].changed, true); assert.equal(r[5].reports[0].status, 'installed');
});
test('R4.2 native transient and unsigned refusals cannot replace installation telemetry', async t => {
  const f = await fixture(t); const bad = { ...f.offer, signature: Buffer.alloc(64).toString('base64') };
  const r = await f.run([{ op: 'offer', offer: f.offer }, { op: 'offer', offer: f.offer, runtimeNull: true }, { op: 'offer', offer: bad }]);
  assert.equal(r[1].reports[0]?.status, 'installed'); assert.deepEqual(r[2].reports, r[0].reports);
});
test('R4.3 native lifetime comparison keeps microsecond-equivalent identities', async t => {
  const f = await fixture(t); const r = await f.run([{ op: 'offer', offer: f.offer }, { op: 'select' }, { op: 'prepare' }, { op: 'active' }, { op: 'reconcile', running: [cim] }, { op: 'failed' }, { op: 'select', context: cim }]);
  assert.equal(r[4].locked, true); assert.equal(r[4].reports[0]?.status, 'active'); assert.equal(r[6].selected, null);
});
test('R4.4 native corrupt state and unavailable process snapshots never throw', async t => {
  const corrupt = await fixture(t, true); assert.equal((await corrupt.run([{ op: 'reconcile', running: [] }]))[0].error, undefined);
  const f = await fixture(t); const r = await f.run([{ op: 'offer', offer: f.offer }, { op: 'select' }, { op: 'prepare' }, { op: 'active' }, { op: 'reconcile', running: null }, { op: 'reconcile', running: [{ pid: context.pid }] }]);
  assert.equal(r[4].error, undefined); assert.equal(r[5].error, undefined); assert.equal(r[5].locked, true);
});
test('R4.4 native locked-file cleanup preserves its index and retries', async t => {
  const f = await fixture(t); const r = await f.run([{ op: 'offer', offer: f.offer }, { op: 'select' }, { op: 'prepare' }, { op: 'hold' }, { op: 'reconcile', running: [] }, { op: 'unhold' }, { op: 'reconcile', running: [] }]);
  assert.equal(r[4].error, undefined); assert.equal(r[4].index, true); assert.equal(r[6].directory, false);
});
test('R4.5 native attempted loads retain their protected snapshot on disposal', async t => {
  const f = await fixture(t); const r = await f.run([{ op: 'offer', offer: f.offer }, { op: 'select' }, { op: 'prepare' }, { op: 'retain' }, { op: 'dispose-lease' }]);
  assert.equal(r[4].directory, true); assert.equal(r[4].locked, true);
});
test('R4.6 native installation reports alone do not request a process sweep', async t => {
  const f = await fixture(t); assert.equal((await f.run([{ op: 'offer', offer: f.offer }]))[0].needs, false);
});
