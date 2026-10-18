// The agent 0.2.0 of servidor/fase4: C03 (a stuck POST never holds the pong, a POST of messages gives up, a stream without
// response headers is dropped and the Hello is said again at once), C26 (the Hello carries the agent's folder), C14
// (file.sync, the listing without PowerShell for known pids) and the query-test command of the ODC bridge v45. Fakes only:
// a fake hub, a fake named pipe, fake process lists.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createAgent, readPack, AGENT_VERSION } from '../lib/agent.mjs';
import { createKinds, KINDS } from '../lib/kinds.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { messagesTimeoutMs, MESSAGES_MS, STREAM_HEADERS_MS } from '../lib/channel.mjs';
import { listProcesses, parseTasklist } from '../lib/studios.mjs';
import { pipeName } from '../lib/odc-pipe.mjs';
import { PART_BYTES } from '../lib/blobs.mjs';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { makeRoot, removeRoot, CREDENTIAL } from './fixtures/agent-root.mjs';

const PROCESSES = { 'ODCStudio.exe': [{ pid: 4120, path: 'C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio\\ODCStudio.exe', version: '1.7.28.4021' }] };
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fast = (fn, ms) => setTimeout(fn, ms >= 45000 ? ms : Math.min(ms, 25));
const live = new Set();
afterEach(async () => { for (const agent of live) await agent.stop(); live.clear(); });
function agentFor(root, hub, deps = {}) {
  const agent = createAgent({ root, config: { server: hub.url, credential: CREDENTIAL },
    deps: { processes: async image => PROCESSES[image] ?? [], fileVersion: async () => null, locate: async () => null, setTimeout: fast, sleep: async () => {}, ...deps } });
  live.add(agent);
  return agent;
}

test('the timings of C03: a POST of messages gives up after 10 s plus 1 s per 64 KiB, the stream headers after 15 s, both under the hub dead timer', () => {
  assert.equal(MESSAGES_MS, 10000);
  assert.equal(STREAM_HEADERS_MS, 15000);
  assert.equal(messagesTimeoutMs(200), 11000);
  assert.equal(messagesTimeoutMs(1048576), 26000, 'a full batch');
  assert.ok(messagesTimeoutMs(1048576) < 45000, 'under the 45 s dead timer of the hub');
});

test('C03: a pong goes in a POST of its own while a batch POST is stuck; the Hello says the agent folder and its kinds (C26, C14)', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    const agent = agentFor(root, hub);
    const running = agent.run();
    await hub.until(() => hub.streams === 1);
    const [hello] = hub.hellos;
    assert.equal(hello.agent.version, AGENT_VERSION);
    assert.equal(AGENT_VERSION, '0.3.2'); // the English agent with the O11 bridge of a8 (Manage Dependencies by code); 0.3.1: sc_http, reference-producers, net.probe
    assert.equal(hello.agent.root, path.resolve(root));
    assert.deepEqual(hello.agent.kinds, [...KINDS]);
    assert.ok(KINDS.includes('file.sync'));
    // The batch with `accepted` of a call is stuck in flight; the hub's ping is answered by a pong in another POST.
    hub.holdPosts = 1;
    hub.send({ t: 'call', id: 'stuck', kind: 'studio.processes', params: { image: 'ODCStudio.exe' }, deadline: Date.now() + 60000 });
    await hub.until(() => hub.held.length === 1);
    hub.send({ t: 'ping', seq: 41, at: Date.now() });
    await hub.until(() => hub.messages.some(m => m.t === 'pong' && m.seq === 41), 3000);
    assert.equal(hub.held.length, 1, 'the pong passed while the batch was still held');
    hub.release();
    await hub.until(() => hub.results('stuck').length === 1);
    await agent.stop(); await running;
  } finally { await hub.close(); removeRoot(root); }
});

test('C03: a stuck POST of messages is given up after messagesMs and the batch goes again', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    const agent = agentFor(root, hub, { channel: { messagesMs: 300 } });
    const running = agent.run();
    await hub.until(() => hub.streams === 1);
    hub.holdPosts = 1;
    const started = Date.now();
    hub.send({ t: 'call', id: 'again', kind: 'studio.processes', params: { image: 'ODCStudio.exe' }, deadline: Date.now() + 60000 });
    await hub.until(() => hub.results('again').length === 1, 5000);
    assert.ok(Date.now() - started < 4000, 'the result did not wait for the stuck POST');
    assert.equal(hub.held.length, 1, 'the first POST is still stuck on the hub side');
    hub.release();
    await agent.stop(); await running;
  } finally { await hub.close(); removeRoot(root); }
});

test('C03: a stream that gets no response headers is dropped after streamHeadersMs and the Hello is said again at once', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    hub.holdStreams = 1;
    const agent = agentFor(root, hub, { channel: { streamHeadersMs: 200 }, setTimeout: (fn, ms) => setTimeout(fn, ms >= 45000 ? ms : Math.min(ms, 5000)) });
    const started = Date.now();
    const running = agent.run();
    await hub.until(() => hub.streams === 1, 4000);
    assert.equal(hub.heldStreams, 1);
    assert.equal(hub.hellos.length, 2, 'a second Hello right after the stream that did not open');
    assert.ok(Date.now() - started < 900, 'no backoff before the second Hello');
    await agent.stop(); await running;
  } finally { await hub.close(); removeRoot(root); }
});

function memoryBlobs() {
  const store = new Map();
  const blobs = {
    store, downloads: 0,
    offer(buffer) {
      const ref = { transfer: randomBytes(16).toString('hex'), sha256: sha(buffer), size: buffer.length, parts: Math.max(1, Math.ceil(buffer.length / PART_BYTES)), partBytes: PART_BYTES };
      store.set(ref.transfer, buffer);
      return ref;
    },
    async download(ref, dest) { blobs.downloads++; fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, store.get(ref.transfer)); return { sha256: ref.sha256, size: ref.size }; },
    async upload(source) { return blobs.offer(Buffer.isBuffer(source) ? source : fs.readFileSync(source)); },
  };
  return blobs;
}

test('C14: file.sync writes several files in one call, keeps what the agent has with ifMissing and answers each refusal on its own entry', async () => {
  const root = makeRoot();
  try {
    const blobs = memoryBlobs();
    const kinds = createKinds({ root, ws: createWorkspace(root), pack: readPack(root), kernel: () => ({ odc: '1.7.28', odcBridge: 'v35' }), blobs, limits: () => ({}), deps: {} });
    fs.mkdirSync(path.join(root, 'odc', 'lab', 'j'), { recursive: true });
    fs.writeFileSync(path.join(root, 'odc', 'lab', 'j', 'receipt.json'), 'the bridge wrote this');
    const same = Buffer.from('same');
    fs.writeFileSync(path.join(root, 'odc', 'lab', 'j', 'same.txt'), same);
    const { results } = await kinds.execute('file.sync', { files: [
      { path: 'agent:odc/lab/j/candidate.oml', blob: blobs.offer(Buffer.from('candidate')) },
      { path: 'agent:odc/lab/j/receipt.json', blob: blobs.offer(Buffer.from('server copy')), ifMissing: true },
      { path: 'agent:odc/lab/j/same.txt', blob: blobs.offer(same) },
      { path: 'agent:private/credential', blob: blobs.offer(Buffer.from('x')) },
    ] });
    assert.deepEqual(results.map(r => r.skipped ?? r.error?.code), [false, true, true, 'PATH_FORBIDDEN']);
    assert.equal(fs.readFileSync(path.join(root, 'odc', 'lab', 'j', 'candidate.oml'), 'utf8'), 'candidate');
    assert.equal(fs.readFileSync(path.join(root, 'odc', 'lab', 'j', 'receipt.json'), 'utf8'), 'the bridge wrote this', 'ifMissing keeps the bridge file');
    assert.equal(blobs.downloads, 1, 'only the missing file was downloaded');
    await assert.rejects(kinds.execute('file.sync', { files: [{ path: 'agent:odc/lab/a', blob: blobs.offer(same) }, { path: 'agent:odc/LAB/a', blob: blobs.offer(same) }] }),
      error => error.code === 'PARAMS_INVALID' && /named twice/.test(error.message));
    await assert.rejects(kinds.execute('file.sync', { files: [] }), error => error.code === 'PARAMS_INVALID');
  } finally { removeRoot(root); }
});

test('the query-test command of the ODC bridge v45 passes with its capture as an agent path, confined like any bridge path', async () => {
  const root = makeRoot();
  const pid = 4300000 + Math.floor(Math.random() * 90000) * 4;
  const lines = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => { buffer += chunk; const i = buffer.indexOf('\n'); if (i < 0) return; lines.push(buffer.slice(0, i)); socket.end(JSON.stringify({ ok: true }) + '\n'); });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(pipeName('v35', pid), resolve));
  try {
    const kinds = createKinds({ root, ws: createWorkspace(root), pack: readPack(root), kernel: () => ({ odc: '1.7.28', odcBridge: 'v35' }), blobs: memoryBlobs(), limits: () => ({}),
      deps: { processes: async () => [{ pid, path: 'C:\\ODC\\ODCStudio.exe', version: '1.7.28.1' }], fileVersion: async () => null } });
    fs.writeFileSync(path.join(root, 'odc', 'snapshots', 'A.oml'), 'oml');
    const request = { op: 'describe', lane: 'odc', source: 'agent:odc/snapshots/A.oml', query: '@q' };
    await kinds.execute('odc.pipe', { pid, version: 'v35', args: ['query-test', JSON.stringify(request)] });
    const sent = JSON.parse(lines[0].slice('query-test '.length));
    assert.equal(sent.source, path.join(root, 'odc', 'snapshots', 'A.oml'));
    await assert.rejects(kinds.execute('odc.pipe', { pid, version: 'v35', args: ['query-test', JSON.stringify({ ...request, source: 'C:\\Windows\\x.oml' })] }),
      error => error.code === 'PATH_NOT_AGENT');
  } finally { await new Promise(resolve => server.close(resolve)); removeRoot(root); }
});

test('C14: the process listing takes pids from tasklist and describes (PowerShell) only the pids it has not seen', async () => {
  assert.deepEqual(parseTasklist('"ODCStudio.exe","4120","Console","1","500 K"\r\n"ODCStudio.exe","4188","Console","1","9 K"\r\n"x.exe","1","C","1","1 K"\r\n', 'ODCStudio.exe'), [4120, 4188]);
  assert.deepEqual(parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n', 'ODCStudio.exe'), []);
  const described = [];
  let listing = '"ODCStudio.exe","4120","Console","1","500 K"\r\n';
  const options = { tasklist: async () => ({ stdout: listing }), describe: async (image, pids) => { described.push([...pids]); return pids.map(pid => ({ pid, path: 'C:\\ODC\\ODCStudio.exe', version: '1.7.28.' + pid })); } };
  assert.deepEqual(await listProcesses('ODCStudio.exe', options), [{ pid: 4120, path: 'C:\\ODC\\ODCStudio.exe', version: '1.7.28.4120' }]);
  assert.deepEqual(await listProcesses('ODCStudio.exe', options), [{ pid: 4120, path: 'C:\\ODC\\ODCStudio.exe', version: '1.7.28.4120' }]);
  assert.deepEqual(described, [[4120]], 'a known pid is not described again');
  listing = '"ODCStudio.exe","4188","Console","1","500 K"\r\n';
  await listProcesses('ODCStudio.exe', options);
  listing = '"ODCStudio.exe","4120","Console","1","500 K"\r\n';
  await listProcesses('ODCStudio.exe', options);
  assert.deepEqual(described, [[4120], [4188], [4120]], 'a pid that left the listing is described again when it comes back');
  assert.deepEqual(await listProcesses('notepad.exe', options), []);
  assert.deepEqual(await listProcesses('ODCStudio.exe', { tasklist: async () => { throw new Error('no tasklist'); } }), []);
});
