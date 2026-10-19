// servidor/fase4-26 a9 (the marco-a6 candidate on the hosted line): "nothing internal" with the path family of the guard
// (exposure.mjs, marco-a6: a whole value that is a path of the server reaches a licensee only as a handle or as the path the
// caller sent) on a hosted server, where the licensee's handle root is the customer's own workspace and the gate's presenter
// shows each workspace file as ws:<rel> (review C:\t\revisoes\marco-a6\REVISAO.md, B1):
// - a file of the customer's workspace comes back as ws:<rel> in ANY key (studio_snapshot path, a delivery's snapshot,
//   manifest, receipt, evidence, checks, a test's mine...), never <server>: the next call takes it back; a file of the
//   workspace outside odc/, o11/ and inbox/ (state/...) is <server>;
// - a path of another customer (customers/<tok>/...), of the server's data (/data/server/...) or of its code (/app/...) is
//   <server> in every key, records (updatePreview.rows[].file of CX13) included, on this machine and in the Linux image;
// - updatePreview.rows[].file of a CX13 load is the customer's file as ws:<rel>, never the real folder on the server;
// - the refusal of a path outside the workspace (the gate's PATH_OUTSIDE_WORKSPACE, a job's path, and the call deadline's
//   DELIVERY_STILL_RUNNING with the cause "outside") is generic English: no real path, no other customer's token or name.
// Fake executor and agent; no Studio, no process, no socket. Synthetic values only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { servedBytesStore } from '../served-bytes.mjs';

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
const { o11Lane, anvilRoot } = await import('../workspace.mjs');
const { createSsamServer, registerServedTool } = await import('../ssam.mjs');
const policy = await import('../hosted/policy.mjs');

const LANE = o11Lane.lane;
const PID = 5150, RELAY = 41559;
const AGENT_ROOT = 'C:\\SSAM-Agent';
const DEADLINE = 100;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-a9x-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

class FakeExecutor {
  constructor({ record }) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.record = record; this.calls = []; }
  relayPort() { return RELAY; }
  o11Connection() { return this.record; }
  async call(kind) { this.calls.push(kind); if (kind === 'studio.processes') return { processes: [] }; throw Object.assign(new Error('unexpected ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); }
  async pullFile() { throw Object.assign(new Error('no pull in this test'), { code: 'FILE_NOT_FOUND' }); }
  async agentFileSha256() { return null; }
  async close() {}
}
const agent = { connected: () => true, protocolError() {},
  info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', agentRoot: AGENT_ROOT, kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' },
    compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function customer() {
  const tokenId = 'tok_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const workspace = path.join(root, 'customers', tokenId);
  prepareWorkspace(workspace);
  const executor = new FakeExecutor({ record: { ok: true, lane: 'o11', anvilLane: LANE, pid: PID, startedUtc: '2026-10-19T10:00:00.0000000Z',
    studioVersion: '11.55.92', port: RELAY, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-19T10:00:05.000Z', hosted: true } });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Synthetic ' + tokenId, lanes: ['odc', 'o11'], workspace, agent, executor, o11: { lane: LANE }, close: async () => {} };
}

// The layout of the Linux image, as the presenter of the hosted server sees it there (hosted-marco-a7-phase4).
const IMAGE_ENV = { SSAM_SERVER_DIR: '/data/server', SSAM_FRICTION_DIR: '/data/friction', ANVIL_STUDIO_DIR: '/studio/o11', ANVIL_ODC_STUDIO_DIR: '/studio/odc',
  ANVIL_ODC_FEATURES_DIR: '/data/odc-features', SSAM_MODULE_INDEX_ROOT: '/data/cache/module-index', SSAM_READER_CACHE_ROOT: '/data/cache/readers' };
const IMAGE_WS = '/data/server/customers/tok_aaaaaaaaaaaa';
const imageLayout = () => ({ workspace: IMAGE_WS, pathApi: path.posix,
  serverRoots: [...policy.serverRoots({ env: IMAGE_ENV, code: '/app', home: '/tmp', tmp: '/tmp' }), '/home'] });

const SYNTHETIC = 'zz_a9_answer', DELIVER = 'zz_a9_deliver';
const runs = [];
const deliverHandler = async ({ module, job, ms = 300 } = {}) => {
  const read = JSON.parse(fs.readFileSync(job, 'utf8'));
  runs.push(read.ops[0]);
  await sleep(ms);
  const value = { ok: true, result: 'delivered', module: path.basename(String(module)), job: read.ops[0] };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
};
const testTools = () => ({ ...policy.hostedTools(),
  [SYNTHETIC]: { class: 'server', lane: 'none', agent: 'never', paths: { in: [], out: [] }, reason: 'test only' },
  [DELIVER]: { class: 'server', lane: 'o11', agent: 'never', paths: { in: ['/job'], out: [] }, reason: 'test only' } });
// A hosted session of one customer (the served registration: the licensee's rule, then the gate, then the deadline).
async function session(context, { presentation = null, synthetic = null } = {}) {
  const store = servedBytesStore({ dir: fs.mkdtempSync(path.join(root, 'day-')) });
  const hosted = { context, session: { agent, lanes: context.lanes }, exposure: { store }, tools: testTools(), ...(presentation ? { presentation } : {}) };
  const server = await runWithExecutor(context, () => createSsamServer({ o11: true, odc: false, deps: { callDeadlineMs: DEADLINE }, hosted }));
  if (synthetic) registerServedTool(server, SYNTHETIC, { description: 'Synthetic answer (test only).' }, async () => ({ content: [{ type: 'text', text: JSON.stringify(synthetic) }], structuredContent: synthetic }));
  const schema = fromJsonSchema({ type: 'object', properties: { module: { type: 'string' }, job: { type: 'string' }, ms: { type: 'number' } }, additionalProperties: false });
  server.registerTool(DELIVER, { description: 'test delivery', inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: false } }, deliverHandler);
  const client = new Client({ name: 'hosted-a9-exposure', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const once = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    return { body: r.structuredContent ?? JSON.parse(r.content[0].text), text: r.content?.[0]?.text ?? '' }; };
  return { once, close: async () => { await client.close(); await server.close(); } };
}
const said = value => JSON.stringify(value).slice(0, 900);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Nothing of the server's layout, of the real workspace or of another customer in a text.
function assertNothingReal(text, { workspace = null, others = [] } = {}) {
  // the agent folder of the user's own machine (C26: where to write the file) is no path of the server
  text = text.split(JSON.stringify(AGENT_ROOT).slice(1, -1)).join('<agent folder>');
  if (workspace) assert.doesNotMatch(text, new RegExp(escape(JSON.stringify(workspace).slice(1, -1)), 'i'), 'the real workspace path: ' + text.slice(0, 600));
  for (const other of others) assert.ok(!text.includes(other), 'another customer (' + other + '): ' + text.slice(0, 600));
  assert.doesNotMatch(text, /customers[\\/]|\/data\/|\/app\/|[A-Za-z]:\\\\/, 'a real path: ' + text.slice(0, 600));
}

test('B1 on the hosted line: a file of the customer\'s workspace comes back as ws:<rel> in any key; state/, another customer and the server are <server>', async () => {
  const A = customer(), other = customer();
  const ws = (...parts) => path.join(A.workspace, ...parts);
  const snapshot = ws('odc', 'snapshots', 'Orders-abc.oml');
  const value = { ok: true,
    path: snapshot, snapshot, report: { snapshot: { path: snapshot } },
    manifest: ws('odc', 'lab', 'd1', 'manifest.json'), receipt: ws('o11', 'journal', 'receipt.json'), evidence: ws('odc', 'lab', 'd1', 'evidence.json'),
    checks: [ws('o11', 'jobs', 'a.json'), ws('o11', 'jobs', 'b.json')], mine: ws('o11', 'jobs', 'z.json'),
    files: [{ path: ws('inbox', 'customers.csv'), sha256: 'ab'.repeat(32) }],
    updatePreview: { previewSha256: 'cd'.repeat(32), rows: [{ file: ws('inbox', 'customers.csv'), row: 2, globalRow: 1, id: '7', changes: { Name: { from: 'a', to: 'b' } } }] },
    hidden: ws('state', 'destructive', 'previews', 'x.json'),
    otherCustomer: path.join(other.workspace, 'o11', 'jobs', 'a.json'), otherRows: { rows: [{ file: path.join(other.workspace, 'inbox', 'b.csv') }] },
    serverCode: path.join(anvilRoot, '.local', 'cli', 'anvil.dll') };
  const s = await session(A, { synthetic: value });
  try {
    const { body, text } = await s.once(SYNTHETIC, {});
    const shown = said(body);
    for (const key of ['path', 'snapshot']) assert.equal(body[key], 'ws:odc/snapshots/Orders-abc.oml', key + ': ' + shown);
    assert.equal(body.report.snapshot.path, 'ws:odc/snapshots/Orders-abc.oml', shown);
    assert.equal(body.manifest, 'ws:odc/lab/d1/manifest.json', shown);
    assert.equal(body.receipt, 'ws:o11/journal/receipt.json', shown);
    assert.equal(body.evidence, 'ws:odc/lab/d1/evidence.json', shown);
    assert.deepEqual(body.checks, ['ws:o11/jobs/a.json', 'ws:o11/jobs/b.json'], shown);
    assert.equal(body.mine, 'ws:o11/jobs/z.json', shown);
    assert.equal(body.files[0].path, 'ws:inbox/customers.csv', shown);
    assert.equal(body.updatePreview.rows[0].file, 'ws:inbox/customers.csv', 'CX13: the customer\'s file, never the server folder: ' + shown);
    assert.equal(body.hidden, '<server>', shown);
    assert.equal(body.otherCustomer, '<server>', shown);
    assert.equal(body.otherRows.rows[0].file, '<server>', shown);
    assert.equal(body.serverCode, '<server>', shown);
    assertNothingReal(text, { workspace: A.workspace, others: [other.tokenId] });
  } finally { await s.close(); }
});

test('the Linux image: customers/<tok>, /data/server and /app are <server> in every key, records included; the customer\'s own file in a CX13 preview is ws:', async () => {
  const A = customer();
  const value = { ok: true,
    path: '/data/server/customers/tok_bbbbbbbbbbbb/o11/jobs/a.json', mine: '/data/server/state/day.json', manifest: '/app/kernel/.local/cli/anvil.dll',
    checks: ['/studio/o11/ServiceStudio.dll', '/data/cache/module-index/x.json'],
    updatePreview: { rows: [{ file: IMAGE_WS + '/inbox/customers.csv', row: 2 }, { file: '/data/server/customers/tok_bbbbbbbbbbbb/inbox/b.csv', row: 3 }] },
    error: 'could not read /data/server/customers/tok_bbbbbbbbbbbb/inbox/b.csv nor /app/x.json.' };
  const s = await session(A, { presentation: imageLayout(), synthetic: value });
  try {
    const { body, text } = await s.once(SYNTHETIC, {});
    const shown = said(body);
    for (const key of ['path', 'mine', 'manifest']) assert.equal(body[key], '<server>', key + ': ' + shown);
    assert.ok(body.checks === undefined || body.checks.every(v => v === '<server>'), shown);
    assert.equal(body.updatePreview.rows[0].file, 'ws:inbox/customers.csv', shown);
    assert.equal(body.updatePreview.rows[1].file, '<server>', shown);
    assert.equal(body.error, 'could not read <server> nor <server>.', shown);
    assert.ok(!text.includes('tok_bbbbbbbbbbbb') && !text.includes(IMAGE_WS), text);
    assertNothingReal(text, { workspace: A.workspace });
  } finally { await s.close(); }
});

test('the refusal of a path outside the workspace is generic English: no real path, no other customer (the gate and a job\'s path)', async () => {
  const A = customer(), other = customer();
  const otherFile = path.join(other.workspace, 'o11', 'jobs', 'secret.json');
  fs.mkdirSync(path.dirname(otherFile), { recursive: true }); fs.writeFileSync(otherFile, JSON.stringify({ ops: [] }));
  const cases = [
    ['ssam_evidence', { file: otherFile }],
    ['ssam_evidence', { file: other.workspace }],
    ['ssam_evidence', { file: '/data/server/customers/' + other.tokenId }],
    ['o11_job', { job: { ops: [] }, base: otherFile }],
    ['o11_job', { job: { ops: [{ op: 'html', parent: '$s', file: path.join(other.workspace, 'inbox', 'frag.html') }] } }],
    ['ssam_reference', { lane: 'o11', kind: 'check-job', query: path.join(other.workspace, 'o11', 'jobs', 'secret.json') }],
  ];
  for (const layout of [null, imageLayout()]) {
    const s = await session(A, { presentation: layout });
    try {
      for (const [name, args] of cases) {
        const { body, text } = await s.once(name, args);
        const what = (layout ? 'image ' : 'machine ') + name + ' ' + said(args) + ' -> ' + said(body);
        assert.equal(body.code, 'PATH_OUTSIDE_WORKSPACE', what);
        assert.match(body.error, /outside your own workspace/, what);
        assertNothingReal(text, { workspace: A.workspace, others: [other.tokenId, other.customer] });
        assert.ok(!text.includes(A.tokenId), 'not even the caller\'s own token: ' + what);
        assert.doesNotMatch(text, /[\u00c0-\u024f]|\b(?:caminho|pasta|arquivo|nada)\b/i, 'English only: ' + what);
      }
    } finally { await s.close(); }
  }
});

test('the call deadline\'s refusal for a file outside the workspace (DELIVERY_STILL_RUNNING, cause outside) is generic English too', async () => {
  const A = customer(), B = customer();
  const secret = path.join(A.workspace, 'o11', 'jobs', 'secret.json');
  fs.mkdirSync(path.dirname(secret), { recursive: true }); fs.writeFileSync(secret, JSON.stringify({ ops: ['A1'] }));
  const own = path.join(B.workspace, 'o11', 'jobs', 'b.json');
  fs.mkdirSync(path.dirname(own), { recursive: true }); fs.writeFileSync(own, JSON.stringify({ ops: ['B'] }));
  const b1 = await session(B), b2 = await session(B);
  try {
    const args = { module: secret, job: 'ws:o11/jobs/b.json', ms: 900 };
    const first = b1.once(DELIVER, args);
    await sleep(DEADLINE * 2.5);
    const { body, text } = await b2.once(DELIVER, args);
    await first;
    assert.equal(body.code, 'DELIVERY_STILL_RUNNING', said(body));
    assert.match(body.error, /outside your own workspace/, said(body));
    assertNothingReal(text, { workspace: B.workspace, others: [A.tokenId, A.customer] });
    assert.ok(!text.includes(B.tokenId), said(body));
  } finally { await b1.close(); await b2.close(); }
});
