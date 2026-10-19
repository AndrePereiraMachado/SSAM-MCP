// servidor/fase4-26 a8 phase 7 (review C:\t\revisoes\vps-a8\REVISAO.md, M1): hosted, the call deadline reads (and hashes)
// only files INSIDE the customer's own workspace, never one of the server or of another customer:
// - an absolute path outside the workspace (any field: one the gate does not confine, a string of an inline job, a path a
//   workspace JSON names) is never opened, stat'ed or hashed. One that names a file (a name with an extension, the shape the
//   product already reads as a file) gives no print ("cannot verify": no join and no replay by content, the gate answers the
//   call); any other absolute-looking text (a JSON pointer of a patch, a route) is text, as it was when it named no file;
// - a file inside the workspace is read as before, but asynchronously (a stream: the event loop never stops for it), with a
//   ceiling per file (256 MiB), per call (512 MiB) and for a JSON whose paths are read (16 MiB, the gate's own job ceiling):
//   over one, no print ("size").
// The review's repros REV-5 (zz-rev-oracle), REV-6 (zz-rev-read) and REV-7 (zz-rev-real) are the first three tests, with the
// rule they break as the assertion. Fake executor and agent; no Studio, no process, no socket. Times are scaled: the deadline
// (100 ms) stands for the 25 s. Synthetic values only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  const child = new EventEmitter(); child.stdin = { end() {} }; child.unref = () => {}; child.kill = () => {}; child.pid = 0;
  setImmediate(() => callback?.(new Error('no child process in hosted tests'), '', ''));
  return child;
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));
cp.spawn = () => { throw new Error('spawn is not allowed in hosted tests'); };
net.createConnection = () => { throw new Error('no TCP or pipe connection in hosted tests'); };
syncBuiltinESMExports();

const { InMemoryTransport, fromJsonSchema } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { o11Lane } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { hostedTools } = await import('../hosted/policy.mjs');

const LANE = o11Lane.lane;
const PID = 5150, RELAY = 41556;
const AGENT_ROOT = 'C:\\SSAM-Agent';
const DEADLINE = 100;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-a8i-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

class FakeExecutor {
  constructor({ workspace, agentDir, record }) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.workspace = workspace; this.agentDir = agentDir; this.record = record; this.pulls = []; this.lists = []; }
  relayPort() { return RELAY; }
  async call(kind) {
    if (kind === 'studio.processes') return { processes: [] };
    if (kind === 'o11.bridge') return { reply: { success: true, data: {} } };
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  o11Connection() { return this.record; }
  agentFile(agentPath) { return path.join(this.agentDir, ...agentPath.replace(/^agent:/, '').split('/')); }
  async pullFile(agentPath) { this.pulls.push(agentPath); throw Object.assign(new Error('no pull in this test'), { code: 'FILE_NOT_FOUND' }); }
  async agentFileSha256(agentPath) { this.lists.push(agentPath); try { return sha(fs.readFileSync(this.agentFile(agentPath))); } catch { return null; } }
  async close() {}
}
const agent = { connected: () => true, protocolError() {},
  info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', agentRoot: AGENT_ROOT, kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' },
    compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function customer() {
  const tokenId = 'tok_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const workspace = path.join(root, 'customers', tokenId);
  prepareWorkspace(workspace);
  const agentDir = path.join(root, 'agent-' + tokenId);
  fs.mkdirSync(path.join(agentDir, 'inbox'), { recursive: true });
  const executor = new FakeExecutor({ workspace, agentDir, record: { ok: true, lane: 'o11', anvilLane: LANE, pid: PID, startedUtc: '2026-10-18T10:00:00.0000000Z',
    studioVersion: '11.55.92', port: RELAY, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-18T10:00:05.000Z', hosted: true } });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Synthetic ' + tokenId, lanes: ['odc', 'o11'], workspace, agentDir, agent, executor, o11: { lane: LANE }, close: async () => {} };
}

// A delivery of this test only (its name says what it does: tool-classification.mjs, a write whose verb is deliver runs to its
// end); its hosted classification takes /job as an input path, like o11_deliver's, and nothing else: `module` is a field the
// gate does not confine.
const DELIVER = 'zz_a8_deliver';
const runs = [];
const deliverHandler = async ({ module, job, ms = 300 } = {}) => {
  const read = JSON.parse(fs.readFileSync(job, 'utf8'));
  runs.push(path.basename(String(module)) + ':' + read.ops[0]);
  await sleep(ms);
  const value = { ok: true, result: 'delivered', module: path.basename(String(module)), job: read.ops[0] };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
};
const testTools = () => ({ ...hostedTools(), [DELIVER]: { class: 'server', lane: 'o11', agent: 'never', paths: { in: ['/job'], out: [] }, reason: 'test only' } });
async function hostedServer(context) {
  const server = await runWithExecutor(context, () => createSsamServer({ o11: true, odc: false, deps: { callDeadlineMs: DEADLINE },
    hosted: { context, session: { agent, lanes: context.lanes }, tools: testTools() } }));
  const schema = fromJsonSchema({ type: 'object', properties: { module: { type: 'string' }, job: { type: 'string' }, ms: { type: 'number' } }, additionalProperties: false });
  server.registerTool(DELIVER, { description: 'test delivery', inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: false } }, deliverHandler);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-marco-a8-inside', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { inputsOf: (name, args) => runWithExecutor(context, () => server.ssamInputsOf(name, args)), close: async () => { await client.close(); await server.close(); },
    call: async (name, args, options = {}) => { const r = await client.callTool({ name, arguments: args }, { timeout: 60000, ...options }); return r.structuredContent ?? JSON.parse(r.content[0].text); } };
}
const text = value => JSON.stringify(value).slice(0, 500);
const writeJob = (file, op) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ops: [op] })); };

// Every read-side file-system call of this process that names a path under one of the folders (stat, open, read, exists,
// realpath, a stream), while the spy is on. Writes are not watched: the test itself writes A's file.
function fsSpy(folders) {
  const key = p => { const resolved = path.resolve(String(p)); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const watched = folders.map(key);
  const seen = [];
  const note = p => { if (typeof p !== 'string' && !(p instanceof URL)) return; const k = key(p instanceof URL ? p.pathname : p); if (watched.some(w => k === w || k.startsWith(w + path.sep))) seen.push(k); };
  const undo = [];
  const wrap = (holder, name) => {
    const original = holder[name];
    if (typeof original !== 'function') return;
    const wrapped = function (p, ...rest) { note(p); return original.call(this, p, ...rest); };
    Object.assign(wrapped, original);
    holder[name] = wrapped; undo.push(() => { holder[name] = original; });
  };
  wrap(fs.realpathSync, 'native');
  for (const name of ['statSync', 'lstatSync', 'readFileSync', 'existsSync', 'openSync', 'createReadStream', 'accessSync', 'realpathSync']) wrap(fs, name);
  for (const name of ['stat', 'lstat', 'readFile', 'open', 'access', 'realpath']) wrap(fs.promises, name);
  return { seen, off: () => { for (const step of undo.reverse()) step(); } };
}

test('REV-5: a path of another customer\'s file in a field the gate does not confine is never read: B gets the same answers whether A\'s file changes or not', async () => {
  const A = customer(), B = customer();
  const secret = path.join(A.workspace, 'o11', 'jobs', 'secret.json');
  writeJob(secret, 'A1');
  writeJob(path.join(B.workspace, 'o11', 'jobs', 'b.json'), 'B');
  const b1 = await hostedServer(B), b2 = await hostedServer(B);
  const spy = fsSpy([A.workspace]);
  try {
    const args = { module: secret, job: 'ws:o11/jobs/b.json', ms: 900 };
    const inputs = await b1.inputsOf(DELIVER, args);
    assert.equal(inputs?.print, null, 'a file outside the workspace gives no print: ' + text(inputs));
    assert.equal(inputs?.unreadable, 'outside');
    const answers = [];
    for (const change of [false, true]) {
      const first = b1.call(DELIVER, args);
      await sleep(DEADLINE * 2.5);
      if (change) writeJob(secret, 'A2'); // customer A's own file changes while B's delivery runs
      const repeat = await b2.call(DELIVER, args);
      const done = await first;
      const after = await b2.call(DELIVER, args); // the identical call after the end, within the replay window
      answers.push({ repeat: { code: repeat.code ?? null, joined: repeat.joined ?? null, cannotRead: /outside/.test(String(repeat.error ?? '')) },
        done: done.job, after: { job: after.job, resumedFrom: after.resumedFrom ?? null } });
    }
    assert.deepEqual(answers[0], answers[1], 'B cannot tell whether A\'s file changed: ' + text(answers));
    assert.deepEqual(answers[0].repeat, { code: 'DELIVERY_STILL_RUNNING', joined: null, cannotRead: true }, text(answers));
    assert.equal(answers[0].after.resumedFrom, null, 'no replay by a content the server did not read');
    assert.deepEqual(spy.seen, [], 'nothing under A\'s workspace was stat\'ed, opened or read: ' + text(spy.seen));
  } finally { spy.off(); await b1.close(); await b2.close(); }
});

test('REV-6: a workspace job that names files of the server is no reason to read them: no print, nothing opened, the event loop never waits', async () => {
  const B = customer();
  const server = path.join(root, 'server-files');
  fs.mkdirSync(server, { recursive: true });
  const named = [];
  for (let i = 0; i < 6; i++) { const file = path.join(server, 'Studio.Part' + i + '.dll'); fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024, i)); named.push(file); }
  fs.mkdirSync(path.join(B.workspace, 'o11', 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(B.workspace, 'o11', 'jobs', 'many.json'), JSON.stringify({ ops: ['X'], notes: named }));
  const s = await hostedServer(B);
  const spy = fsSpy([server]);
  try {
    const started = Date.now();
    const inputs = await s.inputsOf(DELIVER, { module: 'Many', job: 'ws:o11/jobs/many.json' });
    assert.equal(inputs?.print, null, text(inputs));
    assert.equal(inputs?.unreadable, 'outside');
    assert.deepEqual(spy.seen, [], 'no file of the server was opened: ' + text(spy.seen));
    assert.ok(Date.now() - started < 2000);
  } finally { spy.off(); await s.close(); }
});

test('REV-7: the real o11_deliver: a path of another customer\'s file inside an inline job string gives no print and is never read; a JSON pointer or a route stays text', async () => {
  const A = customer(), B = customer();
  const secret = path.join(A.workspace, 'o11', 'jobs', 'secret.json');
  writeJob(secret, 'A1');
  const s = await hostedServer(B);
  const spy = fsSpy([A.workspace]);
  try {
    const job = description => ({ ops: [{ op: 'spec', data: { entities: [{ name: 'E', description }] } }] });
    const p1 = await s.inputsOf('o11_deliver', { module: 'M', job: job(secret) });
    writeJob(secret, 'A2');
    const p2 = await s.inputsOf('o11_deliver', { module: 'M', job: job(secret) });
    assert.equal(p1?.print, null, text(p1)); assert.equal(p2?.print, null);
    assert.equal(p1?.unreadable, 'outside');
    assert.deepEqual(spy.seen, [], text(spy.seen));
    // text that is no file name: one print, the same on every call (the slot alone)
    for (const value of ['/entities/0/attributes/1/name', '/api/orders/{id}', '/']) {
      const a = await s.inputsOf('o11_deliver', { module: 'M', job: job(value) });
      const b = await s.inputsOf('o11_deliver', { module: 'M', job: job(value) });
      assert.match(String(a?.print), /^[0-9a-f]{64}$/, value + ': ' + text(a)); assert.equal(a.print, b.print);
    }
  } finally { spy.off(); await s.close(); }
});

test('a file inside the customer\'s own workspace is still read: the same content joins the running delivery, other content is DELIVERY_STILL_RUNNING (changed)', async () => {
  const B = customer();
  const own = path.join(B.workspace, 'o11', 'jobs', 'own.json');
  writeJob(own, 'O1');
  writeJob(path.join(B.workspace, 'o11', 'jobs', 'own-job.json'), 'J');
  writeJob(path.join(B.workspace, 'o11', 'jobs', 'own-job2.json'), 'K');
  const b1 = await hostedServer(B), b2 = await hostedServer(B);
  try {
    const args = { module: own, job: 'ws:o11/jobs/own-job.json', ms: 700 };
    const before = await b1.inputsOf(DELIVER, args);
    assert.match(String(before?.print), /^[0-9a-f]{64}$/, text(before));
    const first = b1.call(DELIVER, args);
    await sleep(DEADLINE * 2.5);
    const joined = await b2.call(DELIVER, args);
    assert.equal(joined.joined, true, text(joined));
    await first;
    const other = { ...args, job: 'ws:o11/jobs/own-job2.json' };
    const second = b1.call(DELIVER, other);
    await sleep(DEADLINE * 2.5);
    writeJob(own, 'O2'); // the own file the call names changes while it runs
    const changed = await b2.call(DELIVER, other);
    assert.equal(changed.code, 'DELIVERY_STILL_RUNNING', text(changed)); assert.match(changed.error, /changed/);
    assert.doesNotMatch(changed.error, /outside|cannot read/);
    await second;
    assert.notEqual((await b1.inputsOf(DELIVER, args)).print, before.print, 'the content of the own file is in the print');
  } finally { await b1.close(); await b2.close(); }
});

test('a large file of the customer\'s own workspace is hashed without stopping the event loop', async () => {
  const B = customer();
  const big = path.join(B.workspace, 'o11', 'snapshots', 'Big.oml');
  fs.mkdirSync(path.dirname(big), { recursive: true });
  fs.writeFileSync(big, Buffer.alloc(160 * 1024 * 1024, 3));
  writeJob(path.join(B.workspace, 'o11', 'jobs', 'big-job.json'), 'J');
  const s = await hostedServer(B);
  try {
    let lag = 0, last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); lag = Math.max(lag, now - last - 5); last = now; }, 5);
    const inputs = await s.inputsOf(DELIVER, { module: big, job: 'ws:o11/jobs/big-job.json' });
    await sleep(20); clearInterval(timer);
    assert.match(String(inputs?.print), /^[0-9a-f]{64}$/, text(inputs));
    assert.ok(lag < 100, 'the event loop waited ' + lag + ' ms for 160 MiB');
  } finally { fs.rmSync(big, { force: true }); await s.close(); }
});

test('replayPrintInside: the ceilings per file, per call and for a JSON it reads; an outside file name is never stat\'ed; on a POSIX server a pointer is text', async () => {
  const store = await import('../replay-store.mjs');
  assert.equal(typeof store.replayPrintInside, 'function', 'the hosted print');
  const { MAX_JOB_BYTES } = await import('../hosted/job-paths.mjs');
  assert.equal(store.HOSTED_MAX_FILE_BYTES, 256 * 1024 * 1024);
  assert.equal(store.HOSTED_MAX_CALL_BYTES, 512 * 1024 * 1024);
  assert.equal(store.HOSTED_MAX_JSON_BYTES, MAX_JOB_BYTES, 'a JSON the deadline reads whole is at most what the gate reads');
  const ws = path.join(root, 'unit-ws');
  fs.mkdirSync(ws, { recursive: true });
  const inside = file => { const rel = path.relative(ws, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const a = path.join(ws, 'a.bin'), b = path.join(ws, 'b.bin'), j = path.join(ws, 'j.json');
  fs.writeFileSync(a, Buffer.alloc(3000, 1)); fs.writeFileSync(b, Buffer.alloc(3000, 2)); fs.writeFileSync(j, JSON.stringify({ x: a }));
  const slot = args => store.replaySlot('o11_deliver', args);
  const print = (args, options = {}) => store.replayPrintInside(slot(args), { inside, ...options });
  assert.match(String((await print({ module: a, job: b })).print), /^[0-9a-f]{64}$/);
  assert.deepEqual(await print({ module: a }, { maxFileBytes: 2999 }), { print: null, unreadable: 'size' }, 'per file');
  assert.deepEqual(await print({ module: a, job: b }, { maxCallBytes: 5999 }), { print: null, unreadable: 'size' }, 'per call');
  assert.deepEqual(await print({ job: j }, { maxJsonBytes: 5 }), { print: null, unreadable: 'size' }, 'a JSON it reads');
  const viaJson = (await print({ job: j })).print;
  fs.writeFileSync(a, Buffer.alloc(3000, 9));
  assert.notEqual((await print({ job: j })).print, viaJson, 'a path the workspace JSON names is read too');
  // the same sync rule for the product: unchanged
  assert.match(String(store.replayPrint(slot({ module: a }))), /^[0-9a-f]{64}$/);
  // POSIX server: an outside file name is never stat'ed; a pointer and a route are text
  const spy = fsSpy([path.resolve('/data')]);
  try {
    assert.deepEqual(await print({ module: '/data/server/state/day.json' }, { platform: 'linux' }), { print: null, unreadable: 'outside' });
    for (const value of ['/actions/GetOrders/steps/0/name', '/api/v1/orders', '/']) assert.match(String((await print({ patch: [{ path: value }] }, { platform: 'linux' })).print), /^[0-9a-f]{64}$/, value);
    assert.deepEqual(spy.seen, []);
  } finally { spy.off(); }
});
