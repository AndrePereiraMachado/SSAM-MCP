// The ODC bridge pipe on macOS (lib/odc-pipe-unix.mjs): one command at a time per pipe (BRIDGE_BUSY with nothing written,
// as Windows answers EBUSY), never a write to the instance that served the previous command (its inode), ENOENT and
// ECONNREFUSED tried again until connectMs, an instance that changes while connecting gets nothing. The socket file is a
// fake stat; the bytes go through a local pipe server standing for the bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createUnixPipe, resetUnixPipes, unixPipeName, UNIX_PATH_MAX } from '../lib/odc-pipe-unix.mjs';

const localName = () => (process.platform === 'win32' ? `\\\\.\\pipe\\ssam-bridge-test-${process.pid}-${Math.random().toString(16).slice(2)}`
  : path.join(os.tmpdir(), `ssam-bridge-${process.pid}-${Math.random().toString(16).slice(2)}.sock`));

// The bridge: one JSON line per connection, after delayMs.
async function fakeBridge({ delayMs = 0 } = {}) {
  const lines = [];
  const name = localName();
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end); lines.push(line);
      setTimeout(() => socket.end(JSON.stringify({ ok: true, line }) + '\n'), delayMs);
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(name, resolve));
  return { name, lines, close: () => new Promise(resolve => server.close(resolve)) };
}
// A fake clock: sleep advances it and runs onSleep (the test's view of the bridge recreating its socket).
function clock(onSleep = () => {}) {
  let t = 0; let sleeps = 0;
  return { now: () => t, sleep: async ms => { t += ms; sleeps++; onSleep(sleeps); await new Promise(resolve => setImmediate(resolve)); }, sleeps: () => sleeps };
}
const DIR = '/var/folders/ab/T/';
const FILE = DIR + unixPipeName('v97', 501);

test('a command goes to the Studio temp folder socket and the reply line comes back; the next one waits for a new instance', async () => {
  resetUnixPipes();
  const bridge = await fakeBridge();
  try {
    let identity = { ino: 1, birthtimeMs: 10 };
    const c = clock(n => { if (n === 3) identity = { ino: 2, birthtimeMs: 20 }; });
    const call = createUnixPipe({ folders: async pid => { assert.equal(pid, 501); return ['/tmp/', DIR]; } });
    const options = { stat: file => (file === FILE ? identity : undefined), connect: file => { assert.equal(file, FILE); return net.createConnection(bridge.name); }, now: c.now, sleep: c.sleep };
    assert.equal(await call(501, 'v97', ['status', 'brief'], options), JSON.stringify({ ok: true, line: 'status brief' }));
    assert.equal(c.sleeps(), 0);
    // Same inode as the instance that served the last command: wait until the bridge made a new one.
    assert.equal(await call(501, 'v97', ['auth-status'], options), JSON.stringify({ ok: true, line: 'auth-status' }));
    assert.equal(c.sleeps(), 3);
    assert.deepEqual(bridge.lines, ['status brief', 'auth-status']);
  } finally { await bridge.close(); }
});

test('no socket, or a socket nobody accepts on (ECONNREFUSED): tried again until connectMs, then BRIDGE_NOT_ATTACHED with nothing written', async () => {
  resetUnixPipes();
  const call = createUnixPipe({ folders: async () => [DIR] });
  const c = clock();
  await assert.rejects(call(501, 'v97', ['status'], { connectMs: 1000, stat: () => undefined, now: c.now, sleep: c.sleep }),
    e => e.code === 'BRIDGE_NOT_ATTACHED' && e.sent === false && /call studio_attach/.test(e.message));
  const refused = clock();
  let connects = 0;
  const refusing = () => { connects++; const socket = new EventEmitter(); socket.destroy = () => {}; socket.write = () => assert.fail('nothing is written'); setImmediate(() => socket.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))); return socket; };
  await assert.rejects(call(501, 'v97', ['status'], { connectMs: 1000, stat: () => ({ ino: 5 }), connect: refusing, now: refused.now, sleep: refused.sleep }),
    e => e.code === 'BRIDGE_NOT_ATTACHED' && e.sent === false);
  assert.ok(connects > 1, 'the connection was tried again');
});

test('one command at a time per pipe: a second command of this agent gets BRIDGE_BUSY after connectMs, with nothing written', async () => {
  resetUnixPipes();
  const bridge = await fakeBridge({ delayMs: 300 });
  try {
    const call = createUnixPipe({ folders: async () => [DIR] });
    const options = { stat: () => ({ ino: 9 }), connect: () => net.createConnection(bridge.name) };
    const first = call(501, 'v97', ['publish', 'agent:odc/lab/m.json'], options);
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(call(501, 'v97', ['status'], { ...options, connectMs: 100 }), e => e.code === 'BRIDGE_BUSY' && e.sent === false && /never repeat a write/.test(e.message));
    assert.match(await first, /publish/);
    assert.deepEqual(bridge.lines, ['publish agent:odc/lab/m.json']);
  } finally { await bridge.close(); }
});

test('an instance that changes while connecting gets nothing; the command goes to the new one', async () => {
  resetUnixPipes();
  const bridge = await fakeBridge();
  try {
    let stats = 0;
    // Before the first connect: inode 1; once connected the file is already inode 2 (the old instance closed).
    const stat = () => { stats++; return { ino: stats <= 1 ? 1 : 2 }; };
    let connections = 0;
    const c = clock();
    const call = createUnixPipe({ folders: async () => [DIR] });
    const reply = await call(501, 'v97', ['status'], { stat, connect: () => { connections++; return net.createConnection(bridge.name); }, now: c.now, sleep: c.sleep });
    assert.match(reply, /status/);
    assert.equal(connections, 2);
    assert.deepEqual(bridge.lines, ['status']);
  } finally { await bridge.close(); }
});

test('a reply that does not come is an unknown outcome (sent); a socket path macOS cannot open is refused before connecting', async () => {
  resetUnixPipes();
  const bridge = await fakeBridge({ delayMs: 2000 });
  try {
    const call = createUnixPipe({ folders: async () => [DIR] });
    await assert.rejects(call(501, 'v97', ['status'], { stat: () => ({ ino: 3 }), connect: () => net.createConnection(bridge.name), timeoutMs: 100 }),
      e => e.code === 'PIPE_REPLY_TIMEOUT' && e.sent === true);
  } finally { await bridge.close(); }
  const long = createUnixPipe({ folders: async () => ['/' + 'x'.repeat(UNIX_PATH_MAX) + '/'] });
  await assert.rejects(long(501, 'v97', ['status'], { stat: () => ({ ino: 1 }) }), e => e.code === 'PIPE_TRANSPORT' && e.sent === false && /cannot open it/.test(e.message));
});

// Review B1: on the last attempt the time left can be 1 ms, and a refusal that comes a little later lost the race against
// the connect timer (PIPE_CONNECT_TIMEOUT instead of BRIDGE_NOT_ATTACHED, 2 runs in 20). An attempt always gets a short
// floor of time, so the socket's own answer decides; a connect timeout (nothing written) is one more attempt, and at the
// end it is said as such, never as "not attached".
test('a refusal that comes after the last moment of connectMs is still a refusal: BRIDGE_NOT_ATTACHED, nothing written', async () => {
  resetUnixPipes();
  const call = createUnixPipe({ folders: async () => [DIR] });
  const c = clock();
  let connects = 0;
  const slowRefusal = () => { connects++; const socket = new EventEmitter(); socket.destroy = () => {}; socket.write = () => assert.fail('nothing is written');
    setTimeout(() => socket.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), 20); return socket; };
  await assert.rejects(call(501, 'v97', ['status'], { connectMs: 5, stat: () => ({ ino: 5 }), connect: slowRefusal, now: c.now, sleep: c.sleep }),
    e => { assert.equal(e.code, 'BRIDGE_NOT_ATTACHED', e.message); assert.equal(e.sent, false); return true; });
  assert.ok(connects >= 1);
});

test('a socket that never accepts: PIPE_CONNECT_TIMEOUT with nothing written once connectMs is over, never "not attached"', async () => {
  resetUnixPipes();
  const call = createUnixPipe({ folders: async () => [DIR] });
  const silent = () => { const socket = new EventEmitter(); socket.destroy = () => {}; socket.write = () => assert.fail('nothing is written'); return socket; };
  const started = Date.now();
  await assert.rejects(call(501, 'v97', ['status'], { connectMs: 300, stat: () => ({ ino: 6 }), connect: silent }),
    e => { assert.equal(e.code, 'PIPE_CONNECT_TIMEOUT', e.message); assert.equal(e.sent, false); assert.doesNotMatch(e.message, /call studio_attach/); return true; });
  assert.ok(Date.now() - started >= 280);
});
