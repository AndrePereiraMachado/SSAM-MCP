import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
const base = process.env.SSAM_REVIEW_BASE;
const source = base ? path.join(base, 'agent') : path.resolve(import.meta.dirname, '../..');
const api = await import(pathToFileURL(path.join(source, 'agent/lib/bridge-updates.mjs')));
const harness = base ? 'C:/t/vigia-auto/agent-r5-trust-base/bin/Release/net10.0/NativeProtocol.Tests.dll' : path.resolve(import.meta.dirname, '../bridge-trust-harness/bin/Release/net10.0/NativeProtocol.Tests.dll');
async function native(input) {
  const p = spawn('dotnet', [harness], { windowsHide: true }); let stdout = '', stderr = '';
  p.stdout.on('data', x => stdout += x); p.stderr.on('data', x => stderr += x); p.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve, reject) => { p.on('exit', resolve); p.on('error', reject); });
  assert.equal(code, 0, stderr + stdout); return JSON.parse(stdout);
}
// 0.3.17 / 0.4.14-native: Authenticode classifies only Microsoft dependencies; the owner class is never accepted (the owner's
// files are proven by the Ed25519 manifest). c[5] is the signer class of the row (default microsoft).
const cases = [
  ['untrusted root', 0x800b0109, false], ['incomplete chain', 0x800b010a, false],
  ['expired without timestamp', 0x800b0101, false], ['offline revocation', 0x80092013, false],
  ['unknown trust failure', 0x800b0110, false], ['subject chain failure', 0x800b0004, false],
  ['subject policy failure', 0x800b0004, true, true], ['unsigned', 0x800b0100, true], ['bad digest', 0x80096010, true],
  ['valid signature of the owner class (no Authenticode pin any more)', 0, true, false, true, 'owner'], ['wrong Microsoft organization', 0, true, false, true, 'microsoft', { organization: 'Other' }], ['wrong Microsoft root', 0, true, false, true, 'microsoft', { root: 'other' }], ['missing code-signing EKU', 0, true, false, true, 'microsoft', { eku: false }], ['valid Microsoft', 0, false, false, true, 'microsoft']
];
const signerOf = c => c[5] ?? 'microsoft';
const rowFor = c => ({ hresult: c[1], valid: c[4] ?? false, policyFailure: c[3] ?? false, thumbprint: 'B'.repeat(40), signer: signerOf(c), ...c[6] });
const resultFor = c => ({ hresult: c[1], signatureValid: c[4] ?? false, policyFailure: c[3] ?? false, ok: c[4] === true && signerOf(c) === 'microsoft' && !c[6] });
for (const c of cases) for (const core of ['JS', 'native']) test(`R5.1 ${core} classifies ${c[0]}`, async () => {
  if (core === 'native') {
    const [result] = await native({ evidence: [rowFor(c)] }); assert.equal(result.definitive, c[2]); assert.equal(result.hresult, c[1]);
    assert.equal(result.ok, c[0] === 'valid Microsoft');
  } else {
    let error; try { await api.verifyAuthenticode('C:/test.dll', { platform: 'win32', runtimeRoot: 'C:/test', signer: signerOf(c), run: async () => ({ stdout: JSON.stringify(resultFor(c)) }) }); } catch (e) { error = e; }
    if (c[0] === 'valid Microsoft') assert.equal(error, undefined);
    else { assert.ok(error); assert.equal(error.signerRefused, c[2]); if (!c[2]) assert.match(error.message, /VERIFY_FAILED/); }
  }
});
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const bytes = Buffer.from('synthetic signed bridge'); const sha256 = createHash('sha256').update(bytes).digest('hex');
function offer(sequence) {
  // A Microsoft dependency in the offer: the file whose Authenticode result these tests drive.
  const m = { schema: 1, lane: 'odc', studioVersion: '1.7.30', protocol: 'v100', sequence, runtime: 'net10.0', createdAt: '2026-10-28T00:00:00Z', files: ['bridge/ODC3.Bridge.v100.dll', 'client/ODC3.Bridge.Client.dll', 'client/Microsoft.Diagnostics.NETCore.Client.dll'].map(path => ({ path, signer: /Microsoft\./.test(path) ? 'microsoft' : 'owner', size: bytes.length, sha256 })) };
  const manifest = JSON.stringify(m); return { lane: m.lane, studioVersion: m.studioVersion, protocol: m.protocol, manifest, signature: sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') };
}
for (const core of ['JS', 'native']) for (const mode of ['same', 'lower', 'definitive']) test(`R5.1 ${core} persists only definitive refusals: ${mode} sequence`, async t => {
  const retrySame = mode === 'same', definitive = mode === 'definitive', first = definitive ? cases.find(c => c[0] === 'unsigned') : cases[0];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-')); const server = http.createServer((req, res) => { assert.equal(req.headers.authorization, 'Bearer bridge-test-token'); res.end(bytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  let results;
  if (core === 'native') results = await native({ root, publicKey, server: `http://127.0.0.1:${server.address().port}/`, requests: [{ offer: offer(2), evidence: rowFor(first) }, { offer: offer(retrySame ? 2 : 1), evidence: rowFor(cases.at(-1)) }] });
  else {
    let evidence = resultFor(first);
    const store = api.createBridgeUpdates({ root, anchors: { publicKey }, request: async () => new Response(bytes), authenticode: (file, signer) => api.verifyAuthenticode(file, { platform: 'win32', runtimeRoot: root, signer, run: async () => ({ stdout: JSON.stringify(evidence) }) }) });
    const run = async sequence => ({ changed: await store.offers({ compatible: { odc: { bridgeOffer: offer(sequence) } } }, { odc: { installed: { version: '1.7.30', runtime: 'net10.0' } } }), reports: store.reports(), status: store.status(), wire: store.wireStatus(), state: fs.existsSync(path.join(root, 'private/bridge-state.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'private/bridge-state.json'))) : null });
    results = [await run(2)]; evidence = resultFor(cases.at(-1)); results.push(await run(retrySame ? 2 : 1)); await store.dispose();
  }
  if (definitive) {
    assert.equal(results[0].reports[0].status, 'refused'); assert.equal(results[0].reports[0].reason, 'SIGNER_REFUSED');
    assert.equal(results[0].state.watermarks['odc/1.7.30'].rejected, 2); assert.equal(results[1].changed, false); return;
  }
  assert.equal(results[0].wire, null); assert.equal(results[0].status.status, 'warning'); assert.deepEqual(results[0].reports, []); assert.equal(results[0].status.reason, 'VERIFY_FAILED');
  assert.equal(results[0].state?.watermarks?.['odc/1.7.30']?.rejected ?? 0, 0); assert.equal(results[1].changed, true); assert.equal(results[1].reports[0].status, 'installed');
});
const expired = path.join(os.homedir(), '.nuget/packages/microsoft.diagnostics.netcore.client/0.2.410101/lib/net6.0/Microsoft.Diagnostics.NETCore.Client.dll');
for (const core of ['JS', 'native']) test(`R5.1 ${core} cached chain failure remains a local warning after restart`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-cache-'));
  const server = http.createServer((req, res) => res.end(bytes)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  let result;
  if (core === 'native') result = (await native({ root, publicKey, server: `http://127.0.0.1:${server.address().port}/`, requests: [{ offer: offer(1), evidence: rowFor(cases.at(-1)) }, { select: true, evidence: rowFor(cases[0]) }] }))[1];
  else {
    const initial = api.createBridgeUpdates({ root, anchors: { publicKey }, request: async () => new Response(bytes), authenticode: async () => {} });
    assert.equal(await initial.offers({ compatible: { odc: { bridgeOffer: offer(1) } } }, { odc: { installed: { version: '1.7.30', runtime: 'net10.0' } } }), true); await initial.dispose();
    const reopened = api.createBridgeUpdates({ root, anchors: { publicKey }, authenticode: (file, signer) => api.verifyAuthenticode(file, { signer, platform: 'win32', runtimeRoot: root, run: async () => ({ stdout: JSON.stringify(resultFor(cases[0])) }) }) });
    assert.equal(await reopened.select('odc', '1.7.30', 'net10.0'), null);
    result = { reports: reopened.reports(), status: reopened.status(), wire: reopened.wireStatus() }; await reopened.dispose();
  }
  assert.equal(result.wire, null); assert.equal(result.status.status, 'warning'); assert.equal(result.status.reason, 'VERIFY_FAILED'); assert.equal(result.reports[0].status, 'installed');
});
for (const core of ['JS', 'native']) test(`R5.1 ${core} accepts expired Microsoft certificate with valid timestamp from NuGet 0.2.410101`, { skip: !fs.existsSync(expired) && 'Local NuGet Microsoft.Diagnostics.NETCore.Client 0.2.410101 net6.0 DLL is unavailable' }, async () => {
  const evidence = await native({ file: expired }); assert.equal(evidence.ok, true); assert.equal(evidence.hresult, 0); assert.ok(Date.parse(evidence.notAfterUtc) < Date.now(), 'fixture signing certificate must have expired');
  if (core === 'JS') await api.verifyAuthenticode(expired, { platform: 'win32', runtimeRoot: 'C:/test', signer: 'microsoft', run: async () => ({ stdout: JSON.stringify(evidence) }) });
});
test('R5.1 native real unsigned file remains definitively refused', async t => {
  const file = path.join(os.tmpdir(), `r5-unsigned-${process.pid}.dll`); fs.copyFileSync(harness, file); t.after(() => fs.rmSync(file, { force: true }));
  const result = await native({ file }); assert.equal(result.ok, false); assert.equal(result.hresult, 0x800b0100); assert.equal(result.definitive, true);
});
