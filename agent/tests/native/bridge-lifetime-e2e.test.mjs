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
const output = 'C:/t/vigia-auto/round2-e2e';
const hash = b => createHash('sha256').update(b).digest('hex');
// Same identity/status predicate as server/vigia-auto agent-hub.mjs compatibility().
const accepted = hello => hello.bridges?.some(r => r.lane === 'odc' && r.studioVersion === '1.7.30' && r.protocol === 'v100' && r.sequence === 1 && ['active', 'installed'].includes(r.status));
async function fixture(t, mode, badBind = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifetime-e2e-')); const marker = path.join(root, 'loaded.txt');
  const host = spawn(path.join(output, 'host/bin/Release/net10.0/ODCStudio.exe'), [], { windowsHide: true, env: { ...process.env, SSAM_E2E_MARKER: marker, SSAM_E2E_BAD_BIND: badBind ? '1' : '0' } });
  const exited = new Promise(resolve => host.once('exit', resolve));
  const info = await new Promise((resolve, reject) => { host.once('error', reject); host.stdout.once('data', b => resolve(JSON.parse(b))); });
  const keys = generateKeyPairSync('ed25519'); const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }); const thumbprint = 'A'.repeat(40);
  const pack = { id: 'old-package', lanes: ['odc'], odcBridge: 'v98', odcBuiltFor: '1.7.28', odcRuntime: 'net8.0' }; fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify(pack));
  const files = new Map([['bridge/ODC3.Bridge.v100.dll', fs.readFileSync(path.join(output, 'bridge/bin/Release/net10.0/ODC3.Bridge.v100.dll'))]]);
  for (const name of fs.readdirSync(path.join(output, 'v100/bin/Release/net10.0')).filter(n => /\.(dll|json)$/.test(n))) files.set('client/' + name, fs.readFileSync(path.join(output, 'v100/bin/Release/net10.0', name)));
  const manifest = JSON.stringify({ schema: 1, lane: 'odc', studioVersion: '1.7.30', protocol: 'v100', runtime: 'net10.0', sequence: 1, createdAt: '2026-10-28T00:00:00Z', authenticodeThumbprint: thumbprint,
    files: [...files].map(([name, bytes]) => ({ path: name, size: bytes.length, sha256: hash(bytes), signer: path.posix.basename(name).startsWith('Microsoft.') ? 'microsoft' : 'owner' })) });
  const offer = { lane: 'odc', studioVersion: '1.7.30', protocol: 'v100', manifest, signature: sign(null, Buffer.from(manifest), keys.privateKey).toString('base64') };
  const credential = 'ssam_agent_' + 'a'.repeat(43);
  const hub = await fakeHub({ credential, kernel: { odc: '1.7.30', odcBridge: 'v100' }, welcome: hello => ({ compatible: { odc: accepted(hello) ? { ok: true } : { ok: false, code: 'BRIDGE_UPDATE_REQUIRED', bridgeOffer: offer } } }) });
  for (const bytes of files.values()) hub.bridges.set('/agent/bridges/odc/1.7.30/v100/' + hash(bytes), bytes);
  const native = path.join(root, 'native'); fs.mkdirSync(native);
  for (const name of fs.readdirSync(path.resolve(import.meta.dirname, '../../native/Ssam.Agent/bin/Release/net10.0')).filter(n => /\.(dll|exe|json)$/.test(n)))
    fs.copyFileSync(path.resolve(import.meta.dirname, '../../native/Ssam.Agent/bin/Release/net10.0', name), path.join(native, name));
  let alive = true, unavailable = false, snapshotOverride, agent, child, nativeError = '';
  const row = { ...info, path: path.join(output, 'host/bin/Release/net10.0/ODCStudio.exe'), version: '1.7.30' };
  const queue = [], waiting = []; let buffered = '';
  if (mode === 'node') {
    agent = createAgent({ root, config: { server: hub.url, credential }, deps: { machine: null, locate: async lane => lane === 'odc' ? root : null, fileVersion: async () => '1.7.30', studioRuntime: async () => 'net10.0',
      processes: async image => { if (unavailable) throw new Error('Discovery unavailable'); return alive && image === 'ODCStudio.exe' ? [row] : []; },
      bridgeProcessSnapshot: async () => unavailable ? null : snapshotOverride !== undefined ? snapshotOverride : alive ? [row] : [],
      bridgeTrust: { anchors: { publicKey, thumbprint }, authenticode: async () => {}, seal: dir => lockBridgeSnapshot(root, dir, root) } } }); agent.run();
  } else {
    const variant = process.env.SSAM_REVIEW_BASE ? 'base' : 'head';
    child = spawn('dotnet', [`C:/t/vigia-auto/agent-r4-channel-${variant}/bin/Release/net10.0/NativeProtocol.Tests.dll`], { windowsHide: true });
    child.stderr.on('data', bytes => { nativeError += bytes; }); child.stdout.on('data', bytes => { buffered += bytes; let at; while ((at = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, at); buffered = buffered.slice(at + 1); if (line.trim()) { const data = JSON.parse(line); const waiter = waiting.shift(); if (waiter) waiter(data); else queue.push(data); } } });
    child.stdin.end(JSON.stringify({ root, server: hub.url + '/', credential, pack, publicKey, thumbprint, installed: { odc: { installed: { dir: path.join(output, 'host/bin/Release/net10.0'), version: '1.7.30', runtime: 'net10.0' } } } }));
  }
  const childExit = child ? new Promise(resolve => child.once('exit', resolve)) : null;
  t.after(async () => { alive = false; host.stdin.end(); await exited; try { if (agent) await agent.stop(); else { fs.writeFileSync(path.join(root, 'private/test-command.json'), JSON.stringify({ op: 'stop' })); await childExit; } } finally { await hub.close(); fs.rmSync(root, { recursive: true, force: true }); } });
  await hub.until(() => accepted(hub.hellos.at(-1) ?? {})).catch(error => {
    throw new Error(error.message + JSON.stringify({ hellos: hub.hellos.map(h => ({ bridges: h.bridges, studios: h.studios })), requests: hub.requests }));
  });
  await hub.until(() => hub.stream && hub.streamChannel === hub.channel);
  return { root, marker, info, hub, async attach() {
    if (agent) return agent.execute('odc.attach', { pid: info.pid });
    hub.send({ t: 'ping', seq: 400 }); await hub.until(() => hub.messages.some(m => m.t === 'pong' && m.seq === 400)).catch(error => { throw new Error(error.message + JSON.stringify({ nativeError, state: fs.readFileSync(path.join(root, 'private/agent.json'), 'utf8'), history: fs.readFileSync(path.join(root, 'private/agent.log'), 'utf8'), requests: hub.requests })); });
    hub.send({ t: 'call', id: 'attach', kind: 'odc.attach', params: { pid: info.pid } }); await hub.until(() => hub.results('attach').length).catch(error => { throw new Error(error.message + JSON.stringify({ messages: hub.messages, requests: hub.requests, hellos: hub.hellos.map(h => h.bridges) })); }); return hub.results('attach')[0];
  }, async stopHost() { alive = false; host.stdin.end(); await exited; }, async reconcile(rows, broken = false) {
    unavailable = broken; snapshotOverride = rows; const before = hub.hellos.length;
    if (agent) agent.channel.reconnect();
    else {
      const answer = new Promise(resolve => queue.length ? resolve(queue.shift()) : waiting.push(resolve)); fs.writeFileSync(path.join(root, 'private/test-command.json'), JSON.stringify({ op: 'reconcile', running: rows }));
      const result = await answer; assert.equal(result.error, undefined);
    }
    await hub.until(() => hub.hellos.length > before, 3000);
    await hub.until(() => hub.stream && hub.streamChannel === hub.channel, 3000);
    return hub.hellos.at(-1);
  }, snapshot() { const home = path.join(root, 'private/bridge-loads'); return path.join(home, fs.readdirSync(home).find(n => !n.endsWith('.json'))); } };
}
for (const mode of ['node', 'native']) {
  test(`R4.1 ${mode}: a real loaded bridge remains installed after its host exits`, { skip: !enabled, timeout: 20000 }, async t => {
    const f = await fixture(t, mode); const result = await f.attach(); assert.equal(result.ok, true); assert.ok(fs.existsSync(f.marker)); await f.stopHost();
    const hello = await f.reconcile([]); assert.equal(accepted(hello), true); assert.equal(hello.bridges[0].status, 'installed');
  });
  test(`R4.4 ${mode}: unavailable discovery never unlocks a real loaded DLL or takes the channel offline`, { skip: !enabled, timeout: 20000 }, async t => {
    const f = await fixture(t, mode); assert.equal((await f.attach()).ok, true); const snapshot = f.snapshot();
    await f.reconcile(null, true);
    await f.reconcile([]);
    await f.reconcile([{ pid: f.info.pid, startedUtc: f.info.startedUtc.replace(/(\.\d{6})\dZ$/, (_, microseconds) => microseconds + '0Z') }]);
    assert.ok(fs.existsSync(path.join(snapshot, 'client/ODC3.Bridge.Client.dll')));
    assert.throws(() => { const fd = fs.openSync(path.join(snapshot, 'bridge/ODC3.Bridge.v100.dll'), 'r+'); fs.closeSync(fd); });
  });
  test(`R4.5 ${mode}: a real loaded bridge keeps its complete snapshot after bind failure`, { skip: !enabled, timeout: 20000 }, async t => {
    const f = await fixture(t, mode, true); const result = await f.attach(); assert.equal(result.ok, false); assert.ok(fs.existsSync(f.marker));
    assert.equal(result.error.code, 'ODC_DATA_ROOT_FAILED'); assert.ok(!result.error.message.includes(f.root));
    const snapshot = f.snapshot(); for (const file of ['manifest.json', 'client/ODC3.Bridge.Client.dll', 'bridge/ODC3.Bridge.v100.dll']) assert.ok(fs.existsSync(path.join(snapshot, file)), file);
    assert.throws(() => { const fd = fs.openSync(path.join(snapshot, 'bridge/ODC3.Bridge.v100.dll'), 'r+'); fs.closeSync(fd); });
  });
}
