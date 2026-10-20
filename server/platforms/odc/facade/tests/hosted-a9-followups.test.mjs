// servidor/fase4-26 a9 follow-ups (review C:\t\revisoes\vps-a9\REVISAO.md, M1 and M2), on the hosted session:
// - M2: a data file (or an OML) of the user's machine outside the agent folders was refused with "write <inbox>\<name> with the
//   Write tool (UTF-8)" (a model rewriting a CSV of 64 MiB: cut at 2000 lines, a partial load marked complete, leading zeros and
//   decimals changed) and, for a files list (o11_data request.files, studio_data_insert/update files), a continuation to
//   ssam_doctor. Now: copy the file as it is into the agent inbox, and the continuation is the SAME call with every such file
//   of that list as agent:inbox/<name>; after the copy, that call goes through;
// - M1: on ODC with the bridge v97 (no identifier in its read), a file load into an EMPTY entity was refused
//   DATA_READ_UNAVAILABLE with no next step. Now ONE refusal says the way that exists today: the first row of the file inline
//   (studio_data_insert {records}, the continuation, with the user's words), then the same load (nextCalls), whose keys find
//   that row unchanged; nothing is written by the refusal. The key refusal of an integer identifier no longer offers to
//   "reconnect through a bridge" no licensee has.
// Fake executor, agent and Studio data service (the exact read shape of the bridge v97); no Studio, process or socket.
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

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { o11Lane } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { createFacadeServer } = await import('../mcp.mjs');
const { outsideWorkspaceRefusal } = await import('../agent-paths.mjs');
const { jobTool } = await import('../job-runner.mjs');
const { failureOf, GUIDANCE_SCHEMA } = await import('../job-guidance.mjs');
const { fakeAnvil } = await import('./fixtures/fake-anvil.mjs');

const LANE = o11Lane.lane;
const PID = 5150, RELAY = 41579;
const AGENT_ROOT = 'C:\\SSAM-Agent';
const WORDS_MARKER = "<the user's own words>";
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-a9f-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

class FakeExecutor {
  constructor({ workspace, agentDir, record }) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.workspace = workspace; this.agentDir = agentDir; this.record = record; this.pulls = []; }
  relayPort() { return RELAY; }
  async call(kind) {
    if (kind === 'studio.processes') return { processes: [] };
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  o11Connection() { return this.record; }
  agentFile(agentPath) { return path.join(this.agentDir, ...agentPath.replace(/^agent:/, '').split('/')); }
  async pullFile(agentPath, { ifMissing = false } = {}) {
    const dest = path.join(this.workspace, ...agentPath.replace(/^agent:/, '').split('/'));
    if (this.pullError) throw this.pullError(dest);
    if (ifMissing && fs.existsSync(dest)) return dest;
    if (!fs.existsSync(this.agentFile(agentPath))) throw Object.assign(new Error('no such agent file'), { code: 'FILE_NOT_FOUND' });
    this.pulls.push(agentPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(this.agentFile(agentPath), dest);
    return dest;
  }
  async agentFileSha256(agentPath) { try { return sha(fs.readFileSync(this.agentFile(agentPath))); } catch { return null; } }
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
  const executor = new FakeExecutor({ workspace, agentDir, record: { ok: true, lane: 'o11', anvilLane: LANE, pid: PID, startedUtc: '2026-10-19T10:00:00.0000000Z',
    studioVersion: '11.55.92', port: RELAY, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-19T10:00:05.000Z', hosted: true } });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Synthetic ' + tokenId, lanes: ['odc', 'o11'], workspace, agentDir, agent, executor, o11: { lane: LANE }, close: async () => {} };
}
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const said = value => JSON.stringify(value).slice(0, 1200);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function assertNothingReal(text, workspace) {
  assert.doesNotMatch(text, new RegExp(escape(JSON.stringify(workspace).slice(1, -1)), 'i'), 'the real workspace path: ' + text.slice(0, 600));
  assert.ok(!text.includes(root.split(path.sep).at(-1)), 'the server folder: ' + text.slice(0, 600));
}

// ---- the O11 lane: o11_data over a fake CLI (schema, check, read-all)
function o11Cli() {
  const calls = [];
  const schema = { module: 'Load_CS', entities: [{ name: 'Item', identifier: 'Id', static: false, attributes: [
    { name: 'Id', type: 'Item Identifier', autoNumber: true }, { name: 'Name', type: 'Text' }, { name: 'Qty', type: 'Integer' }] }] };
  const runAnvil = async args => {
    const request = args.includes('--request') ? JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8')) : null;
    calls.push({ args, request });
    let data;
    if (args.includes('--schema')) data = { ...schema, moduleKey: 'module-load', entities: schema.entities.map(e => ({ ...e, key: 'entity-' + e.name })) };
    else if (args.includes('--check')) data = { ok: true, operations: request.batch.length, records: request.batch.reduce((n, o) => n + o.records.length, 0) };
    else data = { ok: true, results: (request.batch ?? [request]).map(op => (op.operation === 'read-all' ? { ok: true, records: [], complete: true } : { ok: true, ids: [] })) };
    return { ok: true, envelope: { ok: true, command: 'data', data }, wallMs: 1 };
  };
  return { calls, runAnvil };
}
async function o11Server(context, runAnvil) {
  const server = await runWithExecutor(context, () => createSsamServer({ o11: true, odc: false, deps: { runAnvil, callDeadlineMs: 600000 },
    hosted: { context, session: { agent, lanes: context.lanes } } }));
  const client = new Client({ name: 'hosted-a9f-o11', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async args => { const r = await client.callTool({ name: 'o11_data', arguments: args }, undefined, { timeout: 600000 });
    return { body: r.structuredContent ?? JSON.parse(r.content[0].text), text: r.content?.[0]?.text ?? '' }; };
  return { call, close: async () => { await client.close(); await server.close(); } };
}
// ---- the ODC lane: the Studio data service with the exact read shape of the bridge v97 (DataCommands.cs 2c8eb954...): no
// identifier, identifierAutoNumber nor indexes; the identifier is the first column of a row.
function v97Studio({ rows = [] } = {}) {
  const seen = [];
  const db = rows.map(r => ({ ...r }));
  const data = async args => {
    seen.push(args);
    if (args.op === 'read') {
      const offset = args.offset ?? 0, limit = args.limit ?? 100;
      const records = db.slice(offset, offset + limit);
      return { ok: true, module: 'M', entity: 'E', owner: 'own', moduleKey: 'module-m', entityKey: 'entity-e', tenant: 'synthetic.tenant', offset, limit, count: records.length,
        more: offset + records.length < db.length, attributes: ['Id:Long Integer', 'Name:Text', 'Age:Integer'], records, source: 'DataService.GetRecords (development database)' };
    }
    if (args.op === 'insert') {
      const reports = args.records.map((r, i) => { const id = String(100 + db.length); db.push({ Id: id, ...r }); return { recordId: id, clientRecordId: `new-${i + 1}`, status: 'Success' }; });
      return { ok: true, reports };
    }
    return { ok: false, error: 'unexpected op ' + args.op };
  };
  return { seen, db, data, writes: () => seen.filter(a => a.op !== 'read').length };
}
async function odcServer(context, data) {
  const server = await runWithExecutor(context, () => createSsamServer({ o11: false, odc: true,
    deps: { odcFacade: () => createFacadeServer({ env: { ...process.env, SSAM_ODC_OFFLINE: '1' }, deps: { studioData: data } }), callDeadlineMs: 600000 },
    hosted: { context, session: { agent, lanes: context.lanes } } }));
  const client = new Client({ name: 'hosted-a9f-odc', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    return { body: r.structuredContent ?? JSON.parse(r.content[0].text), text: r.content?.[0]?.text ?? '' }; };
  return { call, close: async () => { await client.close(); await server.close(); } };
}
const downloads = name => ['C:', 'Users', 'ana', 'Downloads', name].join('\\');

// ---- M2
test('M2: data files of the user\'s machine outside the agent folders: copy them as they are; the same call with agent:inbox/<name> goes through', async () => {
  const A = customer();
  const studio = v97Studio({ rows: [{ Id: '1', Name: 'existing', Age: '1' }] });
  const s = await odcServer(A, studio.data);
  try {
    const args = { module: 'M', entity: 'E', files: [downloads('clientes.csv'), downloads('pedidos.csv')], keys: ['Name'], dryRun: true };
    const refused = await s.call('studio_data_insert', args);
    assert.equal(refused.body.code, 'PATH_OUTSIDE_WORKSPACE', said(refused.body));
    assert.doesNotMatch(refused.text, /Write tool/, 'never rewrite a data file: ' + said(refused.body));
    assert.match(refused.body.fix, /^copy clientes\.csv and pedidos\.csv as they are into C:\\SSAM-Agent\\inbox\\/, said(refused.body));
    assert.match(refused.body.fix, /never rewrite/);
    assert.equal(refused.body.continuation?.tool, 'studio_data_insert', said(refused.body));
    assert.deepEqual(refused.body.continuation.arguments, { ...args, files: ['agent:inbox/clientes.csv', 'agent:inbox/pedidos.csv'] }, said(refused.body.continuation));
    assert.equal(studio.seen.length, 0, 'nothing reached the Studio');
    assertNothingReal(refused.text, A.workspace);
    // the copy, as the fix says, then the continuation as it came
    put(path.join(A.agentDir, 'inbox', 'clientes.csv'), 'Name,Age\nAna,30\n');
    put(path.join(A.agentDir, 'inbox', 'pedidos.csv'), 'Name,Age\nBia,31\n');
    const loaded = await s.call(refused.body.continuation.tool, refused.body.continuation.arguments);
    assert.equal(loaded.body.ok, true, said(loaded.body));
    assert.equal(loaded.body.inserted, 2, said(loaded.body));
  } finally { await s.close(); }
});

test('M2: o11_data request.files (a nested list) and its OML: the continuation is o11_data with each refused file as agent:inbox/<name>', async () => {
  const A = customer();
  put(path.join(A.workspace, 'o11', 'snapshots', 'Load_CS.oml'), 'synthetic offline schema fixture');
  const cli = o11Cli();
  const s = await o11Server(A, cli.runAnvil);
  try {
    const target = { host: 'dev.example.test', module: 'Load_CS', oml: 'ws:o11/snapshots/Load_CS.oml' };
    const args = { ...target, request: { operation: 'insert', entity: 'Item', files: ['agent:inbox/items.csv', downloads('clientes.csv')], keys: ['Name'], dryRun: true } };
    put(path.join(A.agentDir, 'inbox', 'items.csv'), 'Name,Qty\nA,1\n');
    const refused = await s.call(args);
    assert.equal(refused.body.code, 'PATH_OUTSIDE_WORKSPACE', said(refused.body));
    assert.match(refused.body.fix, /^copy clientes\.csv as it is into C:\\SSAM-Agent\\inbox\\clientes\.csv/, said(refused.body));
    assert.equal(refused.body.continuation?.tool, 'o11_data', said(refused.body));
    assert.deepEqual(refused.body.continuation.arguments, { ...args, request: { ...args.request, files: ['agent:inbox/items.csv', 'agent:inbox/clientes.csv'] } });
    put(path.join(A.agentDir, 'inbox', 'clientes.csv'), 'Name,Qty\nB,2\n');
    const loaded = await s.call(refused.body.continuation.arguments);
    assert.equal(loaded.body.ok, true, said(loaded.body));
    assert.equal(loaded.body.inserted, 2, said(loaded.body));
    // the OML of the user's machine: the same rule, at its own pointer
    const omlArgs = { ...target, oml: downloads('Load_CS.oml'), request: { operation: 'read', entity: 'Item' } };
    const oml = await s.call(omlArgs);
    assert.equal(oml.body.code, 'PATH_OUTSIDE_WORKSPACE', said(oml.body));
    assert.match(oml.body.fix, /^copy Load_CS\.oml as it is into C:\\SSAM-Agent\\inbox\\Load_CS\.oml/, said(oml.body));
    assert.deepEqual(oml.body.continuation?.arguments, { ...omlArgs, oml: 'agent:inbox/Load_CS.oml' }, said(oml.body));
    assertNothingReal(refused.text + oml.text, A.workspace);
  } finally { await s.close(); }
});

test('M2: the text of the refusal (agent-paths.mjs): a job goes inline first, a job file is copied too; a macOS agent copies with cp', () => {
  const job = outsideWorkspaceRefusal('C:\\Users\\x\\job.json', { agentRoot: AGENT_ROOT, tool: 'studio_deliver', args: { module: 'Shop' } });
  assert.match(job.fix, /^send the job itself inline/);
  assert.match(job.fix, /If the job already is a file: copy job\.json as it is into C:\\SSAM-Agent\\inbox\\job\.json/);
  assert.doesNotMatch(job.fix, /Write tool/);
  const mac = outsideWorkspaceRefusal('/Users/ana/Downloads/Quotes.oml', { agentRoot: '/Users/ana/SSAM-Agent', tool: 'studio_open', args: { module: 'Quotes' }, field: 'localOml' });
  assert.match(mac.fix, /^copy Quotes\.oml as it is into \/Users\/ana\/SSAM-Agent\/inbox\/Quotes\.oml \(cp; never rewrite/);
  assert.deepEqual(mac.continuation.arguments, { module: 'Quotes', localOml: 'agent:inbox/Quotes.oml' });
});

// ---- L1 (the same family: a refusal of the gate never says the real folder of the workspace)
test('L1: a copy from the agent that fails names its destination as ws:<rel>, never the real folder of the workspace', async () => {
  const A = customer();
  put(path.join(A.workspace, 'o11', 'snapshots', 'Load_CS.oml'), 'synthetic offline schema fixture');
  const cli = o11Cli();
  const so = await o11Server(A, cli.runAnvil);
  const sd = await odcServer(A, v97Studio().data);
  A.executor.pullError = dest => Object.assign(new Error("EACCES: permission denied, open '" + dest + "'"), { code: 'EACCES' });
  try {
    const target = { host: 'dev.example.test', module: 'Load_CS', oml: 'ws:o11/snapshots/Load_CS.oml' };
    for (const answer of [await so.call({ ...target, request: { operation: 'insert', entity: 'Item', files: ['agent:inbox/items.csv'], keys: ['Name'], dryRun: true } }),
      await sd.call('studio_data_insert', { module: 'M', entity: 'E', files: ['agent:inbox/items.csv'], keys: ['Name'], dryRun: true })]) {
      assert.equal(answer.body.code, 'EACCES', said(answer.body));
      assert.match(answer.body.error, /ws:inbox\/items\.csv/, said(answer.body));
      assertNothingReal(answer.text, A.workspace);
      assert.doesNotMatch(answer.text, /customers|tok_/, said(answer.body));
    }
  } finally { A.executor.pullError = null; await so.close(); await sd.close(); }
});

// ---- M1
test('M1: an empty ODC entity with the bridge v97: ONE refusal with the way that exists (the first row inline, then the same load); nothing written', async () => {
  const A = customer();
  put(path.join(A.agentDir, 'inbox', 'new.json'), '[{"Name":"fresh","Age":5},{"Name":"other","Age":6}]');
  const studio = v97Studio();
  const s = await odcServer(A, studio.data);
  try {
    const load = { module: 'M', entity: 'E', files: ['agent:inbox/new.json'], keys: ['Name'], operationId: '7a9a9a9a-aaaa-4000-8000-0000000000f1', authorize: 'Autorizo a carga de teste' };
    for (const dryRun of [true, false]) {
      const args = dryRun ? { module: 'M', entity: 'E', files: ['agent:inbox/new.json'], keys: ['Name'], dryRun: true } : load;
      const refused = await s.call('studio_data_insert', args);
      assert.equal(refused.body.ok, false, said(refused.body));
      assert.equal(studio.writes(), 0, 'nothing written');
      const problem = (refused.body.problems ?? []).find(p => p.pointer === '/identity');
      assert.ok(problem, said(refused.body));
      assert.match(problem.reason, /no rows/, said(problem));
      assert.match(problem.fix ?? '', /studio_data_insert/, said(problem));
      const c = refused.body.continuation;
      assert.equal(c?.tool, 'studio_data_insert', said(refused.body));
      assert.deepEqual(Object.keys(c.arguments).sort(), ['authorize', 'entity', 'module', 'records']);
      assert.equal(c.arguments.authorize, WORDS_MARKER);
      assert.equal(c.arguments.records.length, 1);
      assert.equal(c.arguments.records[0].Name, 'fresh');
      assert.equal(Number(c.arguments.records[0].Age), 5);
      const [again] = refused.body.nextCalls ?? [];
      assert.equal(again?.tool, 'studio_data_insert', said(refused.body));
      const { authorize, ...rest } = args;
      // (the file the gate already brought into the workspace, as every continuation of a load names it; round 2, review
      // a9-followups-line D: a write asks the owner's words again, with the marker, never without them)
      assert.deepEqual(again.arguments, { ...rest, files: ['ws:inbox/new.json'], ...(dryRun ? {} : { authorize: WORDS_MARKER }) }, 'the same load, without the user\'s words');
      assertNothingReal(refused.text, A.workspace);
    }
    // following it: the first row inline with the user's words, then the same load: its key finds that row unchanged
    const refused = await s.call('studio_data_insert', load);
    const first = await s.call('studio_data_insert', { ...refused.body.continuation.arguments, authorize: 'Autorizo inserir a primeira linha' });
    assert.notEqual(first.body.ok, false, said(first.body));
    assert.equal(studio.db.length, 1);
    const done = await s.call('studio_data_insert', { ...refused.body.nextCalls[0].arguments, authorize: 'Autorizo a carga de teste' });
    assert.equal(done.body.ok, true, said(done.body));
    assert.equal(done.body.inserted, 1, said(done.body));
    assert.equal(done.body.unchanged, 1, said(done.body));
    assert.deepEqual(studio.db.map(r => r.Name).sort(), ['fresh', 'other']);
  } finally { await s.close(); }
});

test('M1: the key refusal of an integer identifier the bridge v97 does not describe offers no bridge a licensee does not have', async () => {
  const A = customer();
  put(path.join(A.agentDir, 'inbox', 'new.json'), '[{"Id":"7","Name":"fresh","Age":5}]');
  const studio = v97Studio({ rows: [{ Id: '1', Name: 'existing', Age: '1' }] });
  const s = await odcServer(A, studio.data);
  try {
    const refused = await s.call('studio_data_insert', { module: 'M', entity: 'E', files: ['agent:inbox/new.json'], keys: ['Id'], dryRun: true });
    assert.equal(refused.body.code, 'DATA_LOAD_KEY_NOT_NATURAL', said(refused.body));
    assert.doesNotMatch(refused.text, /reconnect|bridge/i, said(refused.body));
    assert.match(refused.text, /declare stable business attributes as keys/);
    assert.equal(studio.writes(), 0);
  } finally { await s.close(); }
});

// ---- E1 and E2 of the product (fix/refusal-followups, merged here) on the hosted session: ssam_job of a customer, its job run
// by the customer's worker (the pool answers the kernel's refusal envelope), through the gate, the hub's exit, the licensee
// rule and the presenter.
const READING = 'd'.repeat(64);
const screen = filler => `<screen name="Login" k="w1">\n<div k="w2">Ola</div>\n${filler}</screen>`;
async function jobSession(context, problems, error) {
  const envelope = { ok: false, command: 'apply', elapsedMs: 5, code: problems[0].code, error, problems, stack: '   at Anvil.Core.ModelSession.Apply()' };
  const pool = { run: async () => ({ used: true, envelope }) };
  const guidance = async (lane, job, result) => ({ ...result, discovery: { schemaVersion: GUIDANCE_SCHEMA, available: false, lane, failure: failureOf(result), reason: 'discovery index unavailable' } });
  const deps = { callDeadlineMs: 600000, jobTool: input => jobTool(input, { env: {}, runAnvil: fakeAnvil({ apply: () => ({ exitCode: 1, envelope }) }), hostedWorkers: pool,
    prepareIntegrationJob: async () => ({}), guidance }) };
  const server = await runWithExecutor(context, () => createSsamServer({ o11: true, odc: false, deps, hosted: { context, session: { agent, lanes: context.lanes } } }));
  const client = new Client({ name: 'hosted-a9f-job', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    return { body: r.structuredContent ?? JSON.parse(r.content[0].text), text: r.content?.[0]?.text ?? '' }; };
  return { call, close: async () => { await client.close(); await server.close(); } };
}
const baseChanged = (capture, text) => ({ phase: 'apply', op: 0, pointer: '/basedOn', code: 'HTML_BASE_CHANGED', severity: 'error',
  message: 'Login is not the reading aaaaaaaaaaaa the edits were written on (now dddddddddddd), and that reading is not kept here',
  fix: 'write the edits again on the current text (basedOn.html ' + READING + '); it is current.text of this problem',
  current: { html: READING, text }, next: { basedOn: { capture, html: READING } } });

test('E1/E2 hosted: a licensee\'s ssam_job refusal brings the screen\'s text and the next basedOn as ws:, with no exception type of SSAM', async () => {
  const A = customer();
  const capture = path.join(A.workspace, 'o11', 'snapshots', 'Login.oml');
  const text = screen('');
  const s = await jobSession(A, [baseChanged(capture, text)], 'op #0 (html Login): KernelRefusalException: Login is not the reading aaaaaaaaaaaa <- InvalidOperationException: the reading is gone');
  try {
    const { body, text: raw } = await s.call('ssam_job', { lane: 'o11', job: { ops: [{ op: 'get', target: 'Screen:Login' }] } });
    assert.equal(body.ok, false, said(body));
    const [p] = body.problems ?? [];
    assert.equal(p?.current?.text, text, said(body));
    assert.deepEqual(p.next?.basedOn, { capture: 'ws:o11/snapshots/Login.oml', html: READING }, said(p));
    assert.doesNotMatch(raw, /[A-Za-z]Exception:/, said(body));
    assert.equal(body.discovery?.failure?.exception, undefined, said(body.discovery));
    assertNothingReal(raw, A.workspace);
  } finally { await s.close(); }
});

test('E1 hosted: a screen above the ceiling: the problem names the exact read of its text in the customer\'s workspace, and ssam_evidence returns it', async () => {
  const A = customer();
  const capture = path.join(A.workspace, 'o11', 'snapshots', 'Login.oml');
  const text = screen(Array.from({ length: 900 }, (_, i) => `<div k="w${100 + i}">Linha ${i} do relatorio de pedidos</div>\n`).join(''));
  const s = await jobSession(A, [baseChanged(capture, text)], 'op #0 (html Login): KernelRefusalException: Login is not the reading');
  try {
    const { body, text: raw } = await s.call('ssam_job', { lane: 'o11', job: { ops: [{ op: 'get', target: 'Screen:Login' }] } });
    assert.ok(Buffer.byteLength(raw) <= 30720, 'under the ceiling: ' + Buffer.byteLength(raw));
    const marker = body.problems?.[0]?.current?.text;
    assert.equal(marker?.omitted, true, said(body));
    assert.match(marker.read.arguments.file, /^ws:o11\//, said(marker));
    assertNothingReal(raw, A.workspace);
    let page = (await s.call(marker.read.tool, marker.read.arguments)).body, got = page.value;
    assert.equal(page.ok, true, said(page));
    while (page.next !== undefined) { page = (await s.call(marker.read.tool, { ...marker.read.arguments, offset: page.next })).body; assert.equal(page.ok, true, said(page)); got += page.value; }
    assert.equal(got, text, 'the exact text of the screen, from the customer\'s own kept answer');
  } finally { await s.close(); }
});
