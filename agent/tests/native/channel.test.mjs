// The same suite runs against the managed development build and the actual AOT executable.
// SSAM_NATIVE_EXE must name a published binary to qualify Native AOT, never a Node wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeHub } from '../../agent/tests/fixtures/fake-hub.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));
const dll = path.join(app, 'native/Ssam.Agent/bin/Release/net10.0/ssam-agent.dll');
const credential = 'ssam_native_qualification';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, configure = () => {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-test-'));
  const hub = await fakeHub({ credential, ...options });
  configure(hub);
  let bridgeCalls = 0;
  const sockets = new Set();
  const bridge = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let text = '';
    socket.on('data', chunk => {
      text += chunk;
      if (!text.includes('\n')) return;
      assert.deepEqual(JSON.parse(text.trim()), { method: 'ping', params: {} });
      bridgeCalls++;
      socket.end('{"success":true,"nativeWire":true}\n');
    });
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const args = ['qualify', '--root', root, '--server', hub.url, '--bridge-port', String(bridge.address().port)];
  const proc = process.env.SSAM_NATIVE_EXE
    ? spawn(process.env.SSAM_NATIVE_EXE, args, { windowsHide: true })
    : spawn('dotnet', [dll, ...args], { windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', c => { stderr += c; });
  proc.stdin.end(credential + '\n');
  const exit = new Promise((resolve, reject) => { proc.once('error', reject); proc.once('exit', code => resolve(code)); });
  t.after(async () => {
    proc.kill();
    await exit;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => bridge.close(resolve));
    await hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, hub, proc, exit, calls: () => bridgeCalls, stderr: () => stderr };
}

test('native channel: reconnect, deduplicate local execution, separate pong and graceful stop', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.hub.until(() => f.hub.streams === 1);
  assert.equal(f.hub.hellos[0].agent.root, f.root);
  assert.deepEqual(f.hub.hellos[0].agent.kinds, ['qualification.bridge', 'file.put', 'file.get', 'file.list', 'file.sync']);
  f.hub.holdPosts = 1;
  const call = { t: 'call', id: 'once', kind: 'qualification.bridge', params: {} };
  f.hub.stream.write(JSON.stringify(call) + '\n');
  await f.hub.until(() => f.hub.held.length === 1);
  f.hub.stream.write(JSON.stringify(call) + '\n');
  f.hub.stream.write('{"t":"ping","seq":9}\n');
  await f.hub.until(() => f.hub.messages.some(m => m.t === 'pong' && m.seq === 9));
  f.hub.stream.destroy();
  await f.hub.until(() => f.hub.streams >= 2);
  assert.equal(f.hub.hellos[0].instance, f.hub.hellos[1].instance);
  f.hub.stream.write(JSON.stringify(call) + '\n');
  f.hub.held.splice(0).forEach(resolve => resolve());
  await f.hub.until(() => f.hub.results('once').length > 0);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.hub.results('once')[0].value, { success: true, nativeWire: true });
  fs.writeFileSync(path.join(f.root, 'private/agent.stop'), 'stop');
  assert.equal(await f.exit, 0, f.stderr());
  assert.equal(f.hub.deletes, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'private/agent.json'))).state, 'stopped');
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['inbox', 'o11', 'odc', 'private']);
});

for (const [status, expected] of [[401, 2], [403, 2], [409, 4]]) {
  test(`native channel: HTTP ${status} exits permanently with ${expected}`, { timeout: 15000 }, async t => {
    const f = await fixture(t, hub => hub.helloStatus.push(status));
    assert.equal(await f.exit, expected, f.stderr());
    assert.equal(f.hub.hellos.length, 1);
    assert.equal(f.hub.streams, 0);
  });
}

test('native channel: replacement and unsupported kind do not execute a bridge', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.hub.until(() => f.hub.streams === 1);
  f.hub.stream.write('{"t":"call","id":"denied","kind":"shell","params":{}}\n');
  await f.hub.until(() => f.hub.results('denied').length > 0);
  assert.equal(f.hub.results('denied')[0].error.executed, false);
  assert.equal(f.calls(), 0);
  f.hub.stream.write('{"t":"close","reason":"replaced"}\n');
  assert.equal(await f.exit, 3, f.stderr());
});

test('native channel: an oversized complete line reconnects without parsing it', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.hub.until(() => f.hub.streams === 1);
  f.hub.stream.write('x'.repeat(1048577) + '\n');
  await f.hub.until(() => f.hub.streams >= 2);
  assert.equal(f.calls(), 0);
  fs.writeFileSync(path.join(f.root, 'private/agent.stop'), 'stop');
  assert.equal(await f.exit, 0, f.stderr());
});

test('native files: chunked transfer, hashes, skip, manifests, sync and path refusals', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.hub.until(() => f.hub.streams === 1);
  let serial = 0;
  const call = async (kind, params, paramsBlob) => {
    const id = 'file-' + ++serial;
    f.hub.send({ t: 'call', id, kind, params, paramsBlob });
    await f.hub.until(() => f.hub.results(id).length > 0);
    return f.hub.results(id)[0];
  };
  const content = Buffer.from('native chunk data\n'.repeat(6000));
  const blob = f.hub.putBlob(content, 4096);
  const target = 'agent:o11/example.bin';
  let answer = await call('file.put', { path: target, blob });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.value.skipped, false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'o11/example.bin')), content);
  const reads = f.hub.blobGets;
  answer = await call('file.put', { path: target, blob });
  assert.equal(answer.value.skipped, true);
  assert.equal(f.hub.blobGets, reads);
  f.hub.corruptPuts = 1;
  answer = await call('file.get', { path: target });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(f.hub.assembled(answer.value.blob), content);

  answer = await call('file.put', { path: 'agent:private/credential', blob });
  assert.equal(answer.error.code, 'PATH_FORBIDDEN');
  assert.equal(answer.error.executed, false);
  answer = await call('file.sync', { files: [{ path: target, ifMissing: true }, { path: 'agent:inbox/refused', blob },
    { path: 'agent:o11/another.bin', blob }] });
  assert.equal(answer.value.results[0].present, true);
  assert.equal(answer.value.results[1].error.code, 'PATH_FORBIDDEN');
  assert.equal(answer.value.results[2].skipped, false);
  answer = await call('file.sync', { files: [{ path: target, blob }, { path: target.toUpperCase(), blob }] });
  assert.equal(answer.error.code, 'PARAMS_INVALID');

  const manifest = { basePath: target, evidenceDir: 'agent:o11/evidence', note: 'untouched' };
  answer = await call('file.put', { path: 'agent:odc/lab/manifest.json', json: 'agent-paths', blob: f.hub.putBlob(Buffer.from(JSON.stringify(manifest))) });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'odc/lab/manifest.json'))).basePath, path.join(f.root, 'o11/example.bin'));
  answer = await call('file.get', { path: 'agent:odc/lab/manifest.json', json: 'agent-paths' });
  assert.deepEqual(JSON.parse(f.hub.assembled(answer.value.blob)), manifest);
  const parameters = f.hub.putBlob(Buffer.from(JSON.stringify({ path: 'agent:o11', max: 1 })));
  answer = await call('file.list', undefined, parameters);
  assert.equal(answer.value.entries.length, 1);
  assert.equal(answer.value.truncated, true);

  const corrupt = f.hub.putBlob(Buffer.from('bad replacement'));
  f.hub.corruptParts.add(corrupt.transfer + '/0');
  answer = await call('file.put', { path: target, blob: corrupt });
  assert.equal(answer.error.code, 'BLOB_HASH_MISMATCH');
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'o11/example.bin')), content);
  assert.equal(fs.readdirSync(path.join(f.root, 'o11')).some(name => name.endsWith('.ssam-tmp')), false);
});

test('native files: large result uses a verified valueBlob', { timeout: 15000 }, async t => {
  const f = await fixture(t, () => {}, { welcome: { inlineMaxBytes: 128 } });
  await f.hub.until(() => f.hub.streams === 1);
  fs.writeFileSync(path.join(f.root, 'o11', 'a-long-filename-for-a-large-listing-result.bin'), 'data');
  f.hub.send({ t: 'call', id: 'large', kind: 'file.list', params: { path: 'agent:o11' } });
  await f.hub.until(() => f.hub.results('large').length > 0);
  const answer = f.hub.results('large')[0];
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.ok(answer.valueBlob);
  assert.equal(JSON.parse(f.hub.assembled(answer.valueBlob)).entries.length, 1);
});
