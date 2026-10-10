import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { pipeCall, pipeName, replyTimeoutMs } from '../odc-pipe.mjs';
import { client } from '../lib.mjs';

// A fake ODC bridge on a unique named pipe (never a Studio): one reply line per command line.
async function fakePipe(handler) {
  const version = 'vtest' + randomUUID().slice(0, 8); const pid = 900000 + Math.floor(Math.random() * 90000);
  const seen = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk.toString('utf8'); const i = buffer.indexOf('\n'); if (i < 0) return;
      const line = buffer.slice(0, i); seen.push(line);
      const reply = await handler(line);
      if (reply !== undefined) socket.write(reply + '\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(pipeName(version, pid), resolve));
  return { version, pid, seen, close: () => new Promise(resolve => server.close(resolve)) };
}

test('a command line goes to ODC3-Bridge-<version>-<pid> and one JSON line comes back, without a dotnet process', async () => {
  const pipe = await fakePipe(line => JSON.stringify({ ok: true, echo: line, text: 'ação' }));
  try {
    const text = await pipeCall(pipe.pid, pipe.version, ['snapshot', 'My Module']);
    assert.deepEqual(JSON.parse(text), { ok: true, echo: 'snapshot My Module', text: 'ação' });
    assert.deepEqual(pipe.seen, ['snapshot My Module']);
  } finally { await pipe.close(); }
});

test('no pipe within the connect window means no bridge attached: a coded refusal, nothing sent', async () => {
  const started = Date.now();
  await assert.rejects(pipeCall(1, 'vnone' + randomUUID().slice(0, 6), ['status'], { connectMs: 300 }), e => e.code === 'BRIDGE_NOT_ATTACHED' && e.sent === false && /studio_attach/.test(e.message));
  assert.ok(Date.now() - started >= 250, 'it waited for the pipe, as the .NET client ConnectAsync does');
});

// The bridge serves one pipe instance at a time: between two commands (and while one runs) the pipe is absent for a
// moment. A call in that window waits for the pipe instead of reporting a missing bridge.
test('a pipe that appears during the connect window is used: the call waits for it, as the .NET client did', async () => {
  const version = 'vlate' + randomUUID().slice(0, 8); const pid = 900000 + Math.floor(Math.random() * 90000);
  let server;
  const later = new Promise(resolve => setTimeout(() => {
    server = net.createServer(socket => socket.on('data', () => socket.end('{"ok":true,"late":true}\n')));
    server.listen(pipeName(version, pid), resolve);
  }, 200));
  try {
    const text = await pipeCall(pid, version, ['status', 'brief'], { connectMs: 3000 });
    assert.deepEqual(JSON.parse(text), { ok: true, late: true });
  } finally { await later; await new Promise(resolve => server.close(resolve)); }
});

test('a reply that never comes is an unknown outcome after the write', async () => {
  const pipe = await fakePipe(() => undefined);
  try { await assert.rejects(pipeCall(pipe.pid, pipe.version, ['merge', 'm.json'], { timeoutMs: 150 }), e => e.code === 'PIPE_REPLY_TIMEOUT' && e.sent === true); }
  finally { await pipe.close(); }
});

test('reply timeouts follow the bridge waits', () => {
  assert.equal(replyTimeoutMs(['status', 'brief']), 600000);
  assert.equal(replyTimeoutMs(['wait', 'published', 'M', '1800']), 1860000);
  assert.equal(replyTimeoutMs(['publish', 'm.json', '--wait', '30']), 1860000);
});

test('lib client relays through the pipe for every command but attach, and SSAM_ODC_PIPE=0 keeps the .NET client', async () => {
  const calls = [];
  const call = async (pid, version, args) => { calls.push({ pid, version, args }); return '{"ok":true}'; };
  // The pipe path needs the bridge version; without a built bridge the facade falls back to the .NET client.
  const withVersion = await client(42, ['status', 'brief'], { env: {}, call }).catch(error => ({ fallback: error.message }));
  if (calls.length) { assert.deepEqual(withVersion, { ok: true }); assert.deepEqual(calls[0].args, ['status', 'brief']); }
  else assert.match(withVersion.fallback, /not built|ODC3\.Bridge\.Client/i);
  calls.length = 0;
  await client(42, ['status'], { env: { SSAM_ODC_PIPE: '0' }, call }).catch(() => {});
  await client(42, ['attach', 'x.dll'], { env: {}, call }).catch(() => {});
  assert.equal(calls.length, 0);
});
