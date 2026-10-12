import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { privateContext, withPrivateSessionHandoff } from '../runtime/private-session-pipe.mjs';

const scope = { host: 'example.outsystems.dev', principal: 'user@example.test', requestSha256: 'a'.repeat(64), cookie: 'session=private-test-value', csrf: 'private-csrf' };
test('context is request-scoped, short-lived and rejects header injection without echoing secrets', () => {
  const bytes = privateContext(scope, new Date('2026-10-08T18:00:00Z'));
  const context = JSON.parse(bytes);
  assert.equal(context.expiresAt, '2026-10-08T18:00:30.000Z');
  assert.equal(context.requestSha256, scope.requestSha256);
  for (const patch of [{ cookie: 'secret\r\nInjected: value' }, { host: 'https://other.test' }, { requestSha256: '' }, { csrf: 'x'.repeat(4097) }]) {
    assert.throws(() => privateContext({ ...scope, ...patch }), e => e.code === 'PRIVATE_CONTEXT_UNAVAILABLE' && !e.message.includes('secret'));
  }
});

test('real local pipe sends exactly one framed context, invokes bridge once and clears retained buffer', { skip: process.platform !== 'win32' }, async () => {
  let invocations = 0, retained;
  const result = await withPrivateSessionHandoff(scope, async id => {
    invocations++;
    const server = net.createServer();
    try {
      const received = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.once('connection', socket => {
          const chunks = [];
          socket.on('data', part => chunks.push(part));
          socket.on('end', () => resolve(Buffer.concat(chunks)));
          socket.on('error', reject);
        });
      });
      server.listen('\\\\.\\pipe\\SSAM-PrivateHttp-' + id);
      const framed = await received;
      assert.equal(framed.readInt32LE(), framed.length - 4);
      assert.equal(JSON.parse(framed.subarray(4)).cookie, scope.cookie);
      return { ok: true, sent: true };
    } finally { await new Promise(resolve => server.close(resolve)); }
  }, { connect: pipe => {
    const socket = net.createConnection(pipe);
    const end = socket.end.bind(socket);
    socket.end = (bytes, callback) => { retained = bytes; return end(bytes, callback); };
    return socket;
  }});
  assert.equal(invocations, 1);
  assert.equal(result.ok, true);
  assert.ok(retained.every(byte => byte === 0));
});

const unavailable = () => {
  const socket = new EventEmitter();
  socket.setTimeout = () => socket;
  socket.destroy = () => {};
  queueMicrotask(() => socket.emit('error', Object.assign(new Error('private detail'), { code: 'ENOENT' })));
  return socket;
};
test('failed delivery preserves authoritative refusal and never invokes the bridge again', async () => {
  let invocations = 0;
  const result = await withPrivateSessionHandoff(scope, async () => {
    invocations++; return { ok: false, code: 'HEADLESS_AUTH_UNAVAILABLE', sent: false };
  }, { platform: 'win32', connect: unavailable, timeoutMs: 30 });
  assert.equal(invocations, 1);
  assert.equal(result.sent, false);
});
test('success without context acknowledgement remains uncertain and cannot be replayed', async () => {
  await assert.rejects(withPrivateSessionHandoff(scope, async () => ({ ok: true }), {
    platform: 'win32', connect: unavailable, timeoutMs: 30,
  }), e => e.code === 'PRIVATE_CONTEXT_OUTCOME_UNCERTAIN' && e.sent === true);
});
test('transport does not swallow an uncertain bridge failure', async () => {
  const failure = Object.assign(new Error('Bridge connection lost'), { sent: true });
  await assert.rejects(withPrivateSessionHandoff(scope, async () => { throw failure; }, {
    platform: 'win32', connect: unavailable, timeoutMs: 30,
  }), e => e === failure);
});
