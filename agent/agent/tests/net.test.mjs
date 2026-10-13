// fase4-24 (docs/FASE2-AGENTE.md 2.9): the agent's connections to its server. Production test of 2026-10-11: two result
// parts of 60 KB and 75 KB took 26.8 s and 48.3 s while the owner's public IP changed behind a carrier-grade NAT, the same
// sizes 0.2 s a minute later. Here a TCP relay turns connections into black holes (bytes accepted and dropped, nothing
// back, no reset): a part finishes in about its own deadline on a fresh connection, never twice on the server, with the
// sha256 checks unchanged; idle pooled connections are not reused after 2 s; every connection gets TCP keep-alive probes;
// the hello gives up after 15 s. Fakes only: a part server, a relay, a forward proxy and the fake hub.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createHttp, deadlineMs, IDLE_REUSE_MS, KEEPALIVE_PROBE_MS } from '../lib/net.mjs';
import { uploadBlob, downloadBlob, partTimeoutMs, PART_MS, PART_BYTES, newTransfer } from '../lib/blobs.mjs';
import { createAgent } from '../lib/agent.mjs';
import { HELLO_MS, STREAM_HEADERS_MS, messagesTimeoutMs } from '../lib/channel.mjs';
import { listenInRange } from './fixtures/ports.mjs';
import { faultyLink } from './fixtures/faulty-link.mjs';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { makeRoot, removeRoot, CREDENTIAL } from './fixtures/agent-root.mjs';

const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readBody = req => new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

// The part routes of the hub (agent-hub.mjs putPart/getPart) as far as these tests need: a part already kept with the same
// sha256 is answered 204 again and not kept twice; holdPuts/holdGets read a request and never answer it (holdPuts after
// keeping the part: the answer is what gets lost).
async function partServer() {
  const s = { puts: 0, gets: 0, kept: 0, parts: new Map(), downloads: new Map(), ports: [], holdPuts: 0, holdGets: 0 };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    s.ports.push(req.socket.remotePort);
    if (req.url === '/ping' || req.url === '/hold') { if (req.url === '/ping') res.end('pong'); return; }
    const m = /^\/agent\/v1\/blobs\/([0-9a-f]{32})\/(\d+)$/.exec(req.url);
    if (!m) { res.writeHead(404).end(); return; }
    const key = m[1] + '/' + m[2];
    if (req.method === 'PUT') {
      s.puts++;
      if (sha(body) !== req.headers['x-ssam-part-sha256']) { res.writeHead(400).end(); return; }
      const known = s.parts.get(key);
      if (known && known.sha !== req.headers['x-ssam-part-sha256']) { res.writeHead(409).end(); return; }
      if (!known) { s.parts.set(key, { sha: sha(body), body }); s.kept++; }
      if (s.holdPuts > 0) { s.holdPuts--; return; }
      res.writeHead(204).end();
      return;
    }
    s.gets++;
    if (s.holdGets > 0) { s.holdGets--; return; }
    const download = s.downloads.get(m[1]);
    if (!download) { res.writeHead(404).end(); return; }
    const part = download.buffer.subarray(Number(m[2]) * download.partBytes, (Number(m[2]) + 1) * download.partBytes);
    res.writeHead(200, { 'x-ssam-part-sha256': sha(part) }).end(part);
  });
  const port = await listenInRange(server);
  s.port = port;
  s.url = 'http://127.0.0.1:' + port;
  s.assembled = ref => Buffer.concat(Array.from({ length: ref.parts }, (_, i) => s.parts.get(ref.transfer + '/' + i)?.body ?? Buffer.alloc(0)));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return s;
}

// put/get over a transport exactly as channel.blobPut/blobGet do it (deadline in a signal, fresh passed through).
const putVia = (transport, base) => async (transfer, index, body, headers, { timeoutMs, fresh } = {}) => {
  const reply = await transport.fetch(`${base}/agent/v1/blobs/${transfer}/${index}`, { method: 'PUT', body, headers, signal: AbortSignal.timeout(timeoutMs), fresh });
  await reply.arrayBuffer();
  return reply.status;
};
const getVia = (transport, base) => async (transfer, index, { timeoutMs, fresh } = {}) => {
  const reply = await transport.fetch(`${base}/agent/v1/blobs/${transfer}/${index}`, { signal: AbortSignal.timeout(timeoutMs), fresh });
  return { status: reply.status, body: Buffer.from(await reply.arrayBuffer()), partSha: reply.headers.get('x-ssam-part-sha256') };
};
function transportFor(options) { const t = createHttp(options); cleanups.push(() => t.close()); return t; }
async function linkTo(port) { const link = await faultyLink(port); cleanups.push(() => link.close()); return link; }

test('the deadlines: a part 10 s plus 1 s per 64 KiB (the C03 rule of the messages), the hello 15 s like the stream headers', () => {
  assert.equal(PART_MS, 10000);
  assert.equal(partTimeoutMs(60 * 1024), 11000, 'the 60 KB part of the production test');
  assert.equal(partTimeoutMs(75 * 1024), 12000, 'the 75 KB part');
  assert.equal(partTimeoutMs(PART_BYTES), 74000, 'a full 4 MiB part (it waited 120 s before)');
  assert.equal(partTimeoutMs(200 * 1024), messagesTimeoutMs(200 * 1024), 'same rule as a POST of messages');
  assert.equal(deadlineMs(0, 300), 300);
  assert.equal(HELLO_MS, 15000);
  assert.equal(HELLO_MS, STREAM_HEADERS_MS);
  assert.equal(IDLE_REUSE_MS, 2000);
  assert.equal(KEEPALIVE_PROBE_MS, 5000);
});

test('a part on a pooled connection that went dead (new public IP) goes again on a fresh connection in about its deadline', async () => {
  const server = await partServer();
  const link = await linkTo(server.port);
  const transport = transportFor({ idleMs: 5000 });
  // A request a moment ago left its connection in the pool; then the path dies.
  assert.equal(await (await transport.fetch(link.url + '/ping')).text(), 'pong');
  assert.equal(link.connections, 1);
  link.cut();
  const data = randomBytes(60000);
  const events = [];
  const started = Date.now();
  const ref = await uploadBlob(data, { put: putVia(transport, link.url), partMs: 200, log: (event, fields) => events.push({ event, ...fields }) });
  const took = Date.now() - started;
  const deadline = partTimeoutMs(data.length, 200);
  assert.equal(deadline, 1200);
  assert.ok(took >= deadline - 50 && took < deadline + 1500, `took ${took} ms for a deadline of ${deadline} ms (production: 26.8 s and 48.3 s)`);
  assert.equal(link.connections, 2, 'the retry opened a connection of its own');
  assert.equal(server.puts, 1, 'the stalled request never reached the server');
  assert.equal(server.kept, 1);
  assert.deepEqual(server.assembled(ref), data);
  assert.equal(ref.sha256, sha(data));
  assert.deepEqual(events.map(e => [e.event, e.direction, e.attempt, e.fresh, e.reason]), [['blob-retry', 'up', 1, true, 'no answer in 1200 ms']]);
});

test('the server kept the part but its answer never came: the retry on a fresh connection gets 204 and the part is kept once', async () => {
  const server = await partServer();
  const transport = transportFor();
  server.holdPuts = 1;
  const data = randomBytes(75000);
  const started = Date.now();
  const ref = await uploadBlob(data, { put: putVia(transport, server.url), partMs: 200 });
  const took = Date.now() - started;
  assert.ok(took >= 1150 && took < 1200 + 1500, `took ${took} ms`);
  assert.equal(server.puts, 2);
  assert.equal(server.kept, 1, 'no duplicate part on the server');
  assert.notEqual(server.ports[0], server.ports[1], 'the second PUT came on another connection');
  assert.deepEqual(server.assembled(ref), data);
});

test('several parts: only the one that stalled waits; the hash of each part and of the whole file still decide', async () => {
  const server = await partServer();
  const link = await linkTo(server.port);
  const transport = transportFor({ idleMs: 5000 });
  const data = randomBytes(2500);
  // Part 0 goes through; then every open connection dies; part 1 stalls and goes again on a connection of its own (closed
  // after it); part 2 opens a new pooled one.
  let index = 0;
  const put = putVia(transport, link.url);
  const ref = await uploadBlob(data, { partBytes: 1000, partMs: 200, put: async (...args) => { if (args[1] === 1 && index++ === 0) link.cut(); return put(...args); } });
  assert.equal(ref.parts, 3);
  assert.equal(server.kept, 3);
  assert.deepEqual(server.assembled(ref), data);
  assert.equal(link.connections, 3);
  // A part the server refuses on its hash is a status, not a dead connection: asked again on the pool, then refused.
  const refused = transportFor();
  await assert.rejects(uploadBlob(randomBytes(10), { partMs: 200, sleep: async () => {},
    put: async (t, i, body, headers, options) => putVia(refused, server.url)(t, i, body, { ...headers, 'x-ssam-part-sha256': '0'.repeat(64) }, options) }),
  e => e.code === 'BLOB_TRANSFER_FAILED' && /HTTP 400/.test(e.message));
  assert.equal(refused.opened(), 1, 'a refused part is not a reason for a new connection');
});

test('a download part on a dead connection is asked again fresh; the part and the file are still checked against their sha256', async () => {
  const server = await partServer();
  const link = await linkTo(server.port);
  const transport = transportFor({ idleMs: 5000 });
  const data = randomBytes(70000);
  const transfer = newTransfer();
  server.downloads.set(transfer, { buffer: data, partBytes: PART_BYTES });
  const ref = { transfer, sha256: sha(data), size: data.length, parts: 1, partBytes: PART_BYTES };
  await (await transport.fetch(link.url + '/ping')).text();
  link.cut();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-net-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const started = Date.now();
  assert.deepEqual(await downloadBlob(ref, path.join(dir, 'in.bin'), { get: getVia(transport, link.url), partMs: 200 }), { sha256: ref.sha256, size: data.length });
  const took = Date.now() - started;
  assert.ok(took >= 1150 && took < 1200 + 1500, `took ${took} ms`);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'in.bin')), data);
  // A wrong sha256 is still a hash mismatch, whatever the connection did.
  await assert.rejects(downloadBlob({ ...ref, sha256: '0'.repeat(64) }, path.join(dir, 'bad.bin'), { get: getVia(transport, link.url), partMs: 200 }),
    e => e.code === 'BLOB_HASH_MISMATCH');
  assert.equal(fs.existsSync(path.join(dir, 'bad.bin')), false);
});

test('a pooled connection idle longer than idleMs is closed and never reused; one idle less is reused', async () => {
  const server = await partServer();
  const link = await linkTo(server.port);
  const transport = transportFor({ idleMs: 150 });
  await (await transport.fetch(link.url + '/ping')).text();
  await (await transport.fetch(link.url + '/ping')).text();
  assert.equal(link.connections, 1, 'reused at once');
  await sleep(400);
  await (await transport.fetch(link.url + '/ping')).text();
  assert.equal(link.connections, 2, 'not reused after idling');
  // fresh: a connection of its own each time, closed after the answer.
  await (await transport.fetch(link.url + '/ping', { fresh: true })).text();
  await (await transport.fetch(link.url + '/ping', { fresh: true })).text();
  assert.equal(link.connections, 4);
});

test('a failed request drops the other idle pooled connections: the next request does not pick another dead one', async () => {
  const server = await partServer();
  const link = await linkTo(server.port);
  const transport = transportFor({ idleMs: 5000 });
  // Two connections in the pool.
  await Promise.all([1, 2].map(async () => (await transport.fetch(link.url + '/ping')).text()));
  assert.equal(link.connections, 2);
  link.cut();
  await assert.rejects(transport.fetch(link.url + '/ping', { signal: AbortSignal.timeout(200) }));
  const started = Date.now();
  assert.equal(await (await transport.fetch(link.url + '/ping', { signal: AbortSignal.timeout(2000) })).text(), 'pong');
  assert.ok(Date.now() - started < 1000, 'answered on a new connection, not stalled on the other dead one');
  assert.equal(link.connections, 3);
});

test('every connection gets TCP keep-alive probes', async () => {
  const server = await partServer();
  const calls = [];
  const original = net.Socket.prototype.setKeepAlive;
  net.Socket.prototype.setKeepAlive = function (...args) { calls.push(args); return original.apply(this, args); };
  try {
    const transport = transportFor({ probeMs: 7000 });
    await (await transport.fetch(server.url + '/ping')).text();
    await (await transport.fetch(server.url + '/ping', { fresh: true })).text();
  } finally { net.Socket.prototype.setKeepAlive = original; }
  assert.ok(calls.filter(([on, delay]) => on === true && delay === 7000).length >= 2, JSON.stringify(calls));
});

test('the proxy of the environment (proxyEnv, what --use-env-proxy gives the runtime) carries the requests', async () => {
  const server = await partServer();
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    const upstream = http.request(req.url, { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  const port = await listenInRange(proxy);
  cleanups.push(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const transport = transportFor({ proxyEnv: { HTTP_PROXY: 'http://127.0.0.1:' + port } });
  assert.equal(await (await transport.fetch(server.url + '/ping')).text(), 'pong');
  const data = randomBytes(3000);
  const ref = await uploadBlob(data, { put: putVia(transport, server.url), partMs: 200 });
  assert.deepEqual(server.assembled(ref), data);
  assert.equal(seen[0], 'GET ' + server.url + '/ping');
  assert.ok(seen.some(line => line.startsWith('PUT ' + server.url + '/agent/v1/blobs/')));
});

// The agent end to end against the fake hub (real channel, real net.mjs).
const fast = (fn, ms) => setTimeout(fn, ms >= 45000 ? ms : Math.min(ms, 25));
function agentWith(root, hub, deps = {}) {
  const events = [];
  const agent = createAgent({ root, config: { server: hub.url, credential: CREDENTIAL }, log: (event, fields) => events.push({ event, ...fields }),
    deps: { processes: async () => [], fileVersion: async () => null, locate: async () => null, setTimeout: fast, ...deps } });
  cleanups.push(() => agent.stop());
  return { agent, events };
}

test('agent: a result part the hub never answers goes again on a fresh connection and the result arrives', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL, welcome: { inlineMaxBytes: 2048 } });
  cleanups.push(async () => { await hub.close(); removeRoot(root); });
  const many = Array.from({ length: 60 }, (_, i) => ({ pid: 1000 + i * 4, path: 'C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio\\ODCStudio.exe', version: '1.7.28.4021' }));
  const { agent, events } = agentWith(root, hub, { processes: async () => many, partMs: 200 });
  const running = agent.run();
  await hub.until(() => hub.streams === 1);
  hub.holdPuts = 1;
  const started = Date.now();
  hub.send({ t: 'call', id: 'big', kind: 'studio.processes', params: { image: 'ODCStudio.exe' }, deadline: Date.now() + 60000 });
  await hub.until(() => hub.results('big').length === 1, 10000);
  const took = Date.now() - started;
  const [result] = hub.results('big');
  assert.deepEqual(JSON.parse(hub.assembled(result.valueBlob).toString('utf8')), { processes: many });
  assert.equal(hub.blobPuts, 2);
  assert.notEqual(hub.blobSockets[0], hub.blobSockets[1], 'the second PUT came on another connection');
  assert.ok(took < 4000, `took ${took} ms`);
  const retry = events.find(e => e.event === 'blob-retry');
  assert.equal(retry.direction, 'up'); assert.equal(retry.fresh, true); assert.match(retry.reason, /^no answer in \d+ ms$/);
  await agent.stop(); await running;
});

test('agent: a file.put part the hub never answers is asked again fresh and the file is written whole', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL, welcome: { partBytes: 1000 } });
  cleanups.push(async () => { await hub.close(); removeRoot(root); });
  const { agent } = agentWith(root, hub, { partMs: 200 });
  const running = agent.run();
  await hub.until(() => hub.streams === 1);
  const data = randomBytes(2500);
  const ref = hub.putBlob(data, 1000);
  hub.holdGets = 1;
  hub.send({ t: 'call', id: 'put', kind: 'file.put', params: { path: 'agent:odc/lab/in/data.bin', blob: ref }, deadline: Date.now() + 60000 });
  await hub.until(() => hub.results('put').length === 1, 10000);
  assert.equal(hub.results('put')[0].ok, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'odc', 'lab', 'in', 'data.bin')), data);
  assert.equal(hub.blobGets, 4, '3 parts, the first asked twice');
  await agent.stop(); await running;
});

test('agent: a hello without an answer gives up at its deadline and the next one connects', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  cleanups.push(async () => { await hub.close(); removeRoot(root); });
  hub.holdHellos = 1;
  const { agent, events } = agentWith(root, hub, { channel: { helloMs: 200 } });
  const started = Date.now();
  const running = agent.run();
  await hub.until(() => hub.streams === 1, 5000);
  assert.equal(hub.heldHellos, 1);
  assert.ok(Date.now() - started < 3000);
  assert.ok(events.some(e => e.event === 'hello-failed'));
  await agent.stop(); await running;
});
