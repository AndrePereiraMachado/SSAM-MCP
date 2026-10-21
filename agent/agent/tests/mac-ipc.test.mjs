// The .NET diagnostic IPC of lib/dotnet-ipc.mjs: the wire format (header, strings, ProcessInfo2), the replies (OK, error
// with its HRESULT) and the transport failures, against a fake runtime listening on a local pipe (a named pipe on
// Windows, a Unix socket elsewhere). The proof against a REAL .NET process is C:\t\agent-mac\prova-ipc (RESULTADO.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { encodeString, encodeMessage, decodeHeader, readString, decodeProcessInfo2, processInfo2, applyStartupHook, ipcRequest, unixEndpoints,
  runtimeMajor, hresultText, windowsEndpoint, MAGIC, IpcError } from '../lib/dotnet-ipc.mjs';

const endpointName = () => (process.platform === 'win32' ? `\\\\.\\pipe\\ssam-ipc-test-${process.pid}-${Math.random().toString(16).slice(2)}`
  : path.join(os.tmpdir(), `ssam-ipc-${process.pid}-${Math.random().toString(16).slice(2)}.sock`));

// A fake runtime: answer(request) -> Buffer to write (or null: close without a reply).
async function fakeRuntime(answer) {
  const requests = [];
  const name = endpointName();
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 20) return;
      const size = buffer.readUInt16LE(14);
      if (buffer.length < size) return;
      const request = { magic: buffer.subarray(0, 14).toString('latin1'), size, set: buffer[16], id: buffer[17], reserved: buffer.readUInt16LE(18), payload: buffer.subarray(20, size) };
      requests.push(request);
      const reply = answer(request);
      if (reply) socket.end(reply); else socket.destroy();
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(name, resolve));
  return { name, requests, close: () => new Promise(resolve => server.close(resolve)) };
}
const ok = (payload = Buffer.alloc(0)) => encodeMessage(0xff, 0x00, payload);
const error = hresult => { const b = Buffer.alloc(4); b.writeInt32LE(hresult | 0, 0); return encodeMessage(0xff, 0xff, b); };
const int32 = value => { const b = Buffer.alloc(4); b.writeInt32LE(value, 0); return b; };
const utf16 = text => Buffer.from(text, 'utf16le');

test('wire format: the 20-byte header, strings as a count of UTF-16 units with their NUL, null strings as a zero count', () => {
  const header = encodeMessage(0x04, 0x07, Buffer.from([1, 2]));
  assert.equal(header.length, 22);
  assert.deepEqual(header.subarray(0, 14), MAGIC);
  assert.equal(header.readUInt16LE(14), 22); assert.equal(header[16], 0x04); assert.equal(header[17], 0x07); assert.equal(header.readUInt16LE(18), 0);
  assert.deepEqual(encodeString('ab'), Buffer.from([3, 0, 0, 0, 0x61, 0, 0x62, 0, 0, 0]));
  assert.deepEqual(encodeString(null), Buffer.alloc(4));
  assert.deepEqual(readString(encodeString('Ã©x'), 0), { value: 'Ã©x', next: 4 + 8 });
  assert.deepEqual(readString(Buffer.alloc(4), 0), { value: null, next: 4 });
  assert.throws(() => readString(Buffer.from([9, 0, 0, 0, 0x61, 0]), 0), /cut/);
  assert.throws(() => decodeHeader(Buffer.alloc(20)), error => error instanceof IpcError && error.code === 'IPC_BAD_REPLY');
  assert.throws(() => encodeMessage(4, 7, Buffer.alloc(70000)), /does not fit/);
  assert.equal(windowsEndpoint(42), '\\\\.\\pipe\\dotnet-diagnostic-42');
  assert.equal(runtimeMajor('8.0.31+1219a42122cf5190c7f512850557e38c422430dc'), 8);
  assert.equal(runtimeMajor('10.0.12'), 10); assert.equal(runtimeMajor(null), null);
  assert.equal(hresultText(0x80131385 | 0), '0x80131385 (DS_IPC_E_UNKNOWN_COMMAND)');
});

test('ProcessInfo2: the request has no payload; the reply gives the pid, the command line, OS, architecture, entry assembly and runtime', async () => {
  const payload = Buffer.concat([(() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(4242n); return b; })(), Buffer.alloc(16, 7),
    encodeString('/Applications/ODC Studio.app/Contents/MacOS/ODC Studio'), encodeString('MacOS'), encodeString('arm64'), encodeString('ODCStudio'), encodeString('8.0.31+abc')]);
  const runtime = await fakeRuntime(() => ok(payload));
  try {
    const info = await processInfo2(runtime.name);
    assert.deepEqual(info, { pid: 4242, cookie: '07'.repeat(16), commandLine: '/Applications/ODC Studio.app/Contents/MacOS/ODC Studio', os: 'MacOS', arch: 'arm64', entrypoint: 'ODCStudio', clrVersion: '8.0.31+abc' });
    assert.deepEqual(runtime.requests.map(r => [r.magic, r.size, r.set, r.id, r.reserved, r.payload.length]), [['DOTNET_IPC_V1\0', 20, 4, 4, 0, 0]]);
    assert.equal(decodeProcessInfo2(payload).arch, 'arm64');
  } finally { await runtime.close(); }
});

test('ApplyStartupHook: the path as a string; OK with HRESULT 0 applies; an error reply or a failing HRESULT is IPC_REFUSED with its code', async () => {
  const replies = [ok(int32(0)), ok(), error(0x80131385), ok(int32(0x80070057 | 0))];
  const runtime = await fakeRuntime(() => replies.shift());
  try {
    assert.deepEqual(await applyStartupHook(runtime.name, '/Users/ana/SSAM-Agent/odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.dll'), { applied: true });
    assert.deepEqual(await applyStartupHook(runtime.name, 'x.dll'), { applied: true });
    await assert.rejects(applyStartupHook(runtime.name, 'x.dll'), e => e.code === 'IPC_REFUSED' && e.sent === true && /DS_IPC_E_UNKNOWN_COMMAND/.test(e.message));
    await assert.rejects(applyStartupHook(runtime.name, 'x.dll'), e => e.code === 'IPC_REFUSED' && e.hresult === (0x80070057 | 0) && /E_INVALIDARG/.test(e.message));
    const first = runtime.requests[0];
    assert.deepEqual([first.set, first.id], [4, 7]);
    const count = first.payload.readUInt32LE(0);
    assert.equal(first.payload.subarray(4).toString('utf16le'), '/Users/ana/SSAM-Agent/odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.dll\0');
    assert.equal(count * 2, first.payload.length - 4);
    assert.deepEqual(first.payload.subarray(4, 8), utf16('/U'));
  } finally { await runtime.close(); }
});

test('transport: no endpoint is IPC_ABSENT with nothing sent; a close without reply or a silent runtime is an unknown outcome (sent)', async () => {
  await assert.rejects(ipcRequest(endpointName(), encodeMessage(4, 4)), e => e.code === 'IPC_ABSENT' && e.sent === false);
  const closing = await fakeRuntime(() => null);
  try { await assert.rejects(processInfo2(closing.name), e => e.sent === true && ['IPC_NO_REPLY', 'IPC_TRANSPORT'].includes(e.code)); }
  finally { await closing.close(); }
  const silent = await fakeRuntime(() => Buffer.alloc(0));
  try { await assert.rejects(processInfo2(silent.name, { timeoutMs: 200 }), e => e.sent === true && ['IPC_TIMEOUT', 'IPC_NO_REPLY'].includes(e.code)); }
  finally { await silent.close(); }
  const garbage = await fakeRuntime(() => Buffer.alloc(24, 1));
  try { await assert.rejects(processInfo2(garbage.name), e => e.code === 'IPC_BAD_REPLY'); }
  finally { await garbage.close(); }
});

test('Unix endpoints: the sockets of one pid in the given folders, newest first, with the start key; other pids and missing folders are skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-diag-'));
  try {
    const put = (name, ms) => { const f = path.join(dir, name); fs.writeFileSync(f, ''); fs.utimesSync(f, ms / 1000, ms / 1000); };
    put('dotnet-diagnostic-123-1700000000-socket', 1700000000000);
    put('dotnet-diagnostic-123-1700000500-socket', 1700000500000);
    put('dotnet-diagnostic-1234-1700000600-socket', 1700000600000);
    put('CoreFxPipe_ODC3-Bridge-v97-123', 1700000700000);
    const found = unixEndpoints(123, [dir, path.join(dir, 'missing'), dir]);
    assert.deepEqual(found.map(e => [path.posix.basename(e.path), e.key]), [['dotnet-diagnostic-123-1700000500-socket', '1700000500'], ['dotnet-diagnostic-123-1700000000-socket', '1700000000']]);
    assert.ok(found[0].dir.endsWith('/'));
    assert.deepEqual(unixEndpoints(999, [dir]), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
