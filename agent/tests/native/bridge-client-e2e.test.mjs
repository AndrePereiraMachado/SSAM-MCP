import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fakeHub } from '../../agent/tests/fixtures/fake-hub.mjs';
import { lockBridgeSnapshot } from '../../agent/lib/bridge-lock.mjs';

const enabled = process.env.SSAM_CLIENT_E2E === '1';
const code = process.env.SSAM_REVIEW_BASE ? path.join(process.env.SSAM_REVIEW_BASE, 'agent') : path.resolve(import.meta.dirname, '../..');
const { createAgent } = await import(pathToFileURL(path.join(code, 'agent/lib/agent.mjs')));
const { attachOdc } = await import(pathToFileURL(path.join(code, 'agent/lib/odc-attach.mjs')));
const outputs = process.env.SSAM_E2E_OUTPUT ?? 'C:/t/vigia-auto/round2-e2e';
test('R3.2 real client classifies an invalid DLL as an attempted bridge failure', { skip: !enabled, timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invalid-hook-'));
  const host = spawn(path.join(outputs, 'host/bin/Release/net10.0/ODCStudio.exe'), [], { windowsHide: true });
  const stopped = new Promise(resolve => host.once('exit', resolve));
  t.after(async () => { host.stdin.end(); await stopped; fs.rmSync(root, { recursive: true, force: true }); });
  const info = await new Promise((resolve, reject) => { host.once('error', reject); host.stdout.once('data', bytes => resolve(JSON.parse(bytes))); });
  const file = path.join(root, 'ODC3.Bridge.v100.dll'); fs.writeFileSync(file, Buffer.alloc(4096, 65));
  await assert.rejects(attachOdc({ pid: info.pid, client: path.join(outputs, 'v100/bin/Release/net10.0/ODC3.Bridge.Client.dll'), bridge: file }), e => e.attachAttempted === true && e.bridgeLoadFailure === true);
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const mode of ['node', 'native']) test(`R2.1 ${mode}: real production client v100 loads a v100 bridge when the package client is v98`, { skip: !enabled, timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-e2e-'));
  const marker = path.join(root, 'loaded.txt');
  const host = spawn(path.join(outputs, 'host/bin/Release/net10.0/ODCStudio.exe'), [], { windowsHide: true, env: { ...process.env, SSAM_E2E_MARKER: marker } });
  const hostExit = new Promise(resolve => host.once('exit', resolve));
  const info = await new Promise((resolve, reject) => { host.once('error', reject); host.stdout.once('data', bytes => resolve(JSON.parse(bytes.toString()))); });
  const keys = generateKeyPairSync('ed25519');
  const anchors = { publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }), thumbprint: 'A'.repeat(40) };
  const pack = { id: 'v98-package', lanes: ['odc'], odcBridge: 'v98', odcBuiltFor: '1.7.28', odcRuntime: 'net8.0' };
  fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify(pack));
  const packaged = path.join(root, 'odc/studio/bridge/client/bin/Release/net10.0'); fs.mkdirSync(packaged, { recursive: true });
  for (const name of fs.readdirSync(path.join(outputs, 'v98/bin/Release/net10.0'))) fs.copyFileSync(path.join(outputs, 'v98/bin/Release/net10.0', name), path.join(packaged, name));
  const files = new Map(); files.set('bridge/ODC3.Bridge.v100.dll', fs.readFileSync(path.join(outputs, 'bridge/bin/Release/net10.0/ODC3.Bridge.v100.dll')));
  for (const name of fs.readdirSync(path.join(outputs, 'v100/bin/Release/net10.0')).filter(n => /\.(dll|json)$/.test(n))) files.set('client/' + name, fs.readFileSync(path.join(outputs, 'v100/bin/Release/net10.0', name)));
  const manifest = JSON.stringify({ schema: 1, lane: 'odc', studioVersion: '1.7.30', runtime: 'net10.0', protocol: 'v100', sequence: 1, createdAt: '2026-10-28T00:00:00Z', authenticodeThumbprint: anchors.thumbprint,
    files: [...files].map(([name, bytes]) => ({ path: name, size: bytes.length, signer: 'owner', sha256: hash(bytes) })) });
  const offer = { lane: 'odc', studioVersion: '1.7.30', protocol: 'v100', manifest, signature: sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') };
  const credential = 'ssam_agent_' + 'a'.repeat(43);
  const hub = await fakeHub({ credential, kernel: { odc: '1.7.30', odcBridge: 'v100' }, welcome: { compatible: { odc: { bridgeOffer: offer } } } });
  for (const bytes of files.values()) hub.bridges.set('/agent/bridges/odc/1.7.30/v100/' + hash(bytes), bytes);
  const native = path.join(root, 'native'); fs.mkdirSync(native);
  const nativeBuild = path.resolve(import.meta.dirname, '../../native/Ssam.Agent/bin/Release/net10.0');
  for (const name of fs.readdirSync(nativeBuild).filter(n => /\.(exe|dll|json)$/.test(n))) fs.copyFileSync(path.join(nativeBuild, name), path.join(native, name));
  let updated = false;
  const nodeAgent = mode === 'node' ? createAgent({ root, config: { server: hub.url, credential }, log: (event, detail) => { if (detail?.status === 'installed') updated = true; }, deps: {
    machine: null, locate: async lane => lane === 'odc' ? root : null, fileVersion: async () => '1.7.30', studioRuntime: async () => 'net10.0',
    processes: async image => image === 'ODCStudio.exe' ? [{ ...info, version: '1.7.30', path: path.join(outputs, 'host/bin/Release/net10.0/ODCStudio.exe') }] : [],
    bridgeTrust: { anchors, authenticode: async () => {}, seal: dir => lockBridgeSnapshot(root, dir, root) } } }) : null;
  let nativeExit; let nativeError = '';
  const agent = nodeAgent ?? {
    run() {
      const folder = process.env.SSAM_REVIEW_BASE ? 'native-base' : 'native-head';
      const child = spawn('dotnet', [path.join(outputs, folder, 'bin/Release/net10.0/NativeProtocol.Tests.dll')], { windowsHide: true });
      child.stdout.resume(); child.stderr.on('data', bytes => { nativeError += bytes; }); nativeExit = new Promise(resolve => child.on('exit', resolve));
      child.stdin.end(JSON.stringify({ root, server: hub.url + '/', credential, pack, publicKey: anchors.publicKey, thumbprint: anchors.thumbprint,
        installed: { odc: { installed: { dir: path.join(outputs, 'host/bin/Release/net10.0'), version: '1.7.30', runtime: 'net10.0' } } } }));
    },
    async execute(kind, params) { await hub.until(() => hub.stream && hub.streamChannel === hub.channel); hub.send({ t: 'call', id: 'real-client', kind, params }); await hub.until(() => hub.results('real-client').length > 0); return hub.results('real-client')[0]; },
    async stop() { if (hub.stream) hub.send({ t: 'close', reason: 'replaced' }); await nativeExit; },
  };
  t.after(async () => { try { await agent.stop(); } finally { await hub.close(); host.stdin.end(); await hostExit; fs.rmSync(root, { recursive: true, force: true }); } });
  agent.run(); await hub.until(() => updated || hub.hellos.some(h => Array.isArray(h.bridges) ? h.bridges.some(b => b.status === 'installed') : h.bridges?.odc)).catch(error => {
    let state = ''; try { state = fs.readFileSync(path.join(root, 'private/bridge-update.json'), 'utf8'); } catch { }
    throw new Error(error.message + JSON.stringify({ nativeError, state, hellos: hub.hellos, requests: hub.requests }));
  });
  const result = await agent.execute('odc.attach', { pid: info.pid }).catch(error => { throw new Error(error.message + JSON.stringify({ nativeError, hellos: hub.hellos, messages: hub.messages, requests: hub.requests })); });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.value.attached, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'loaded v100');
});
