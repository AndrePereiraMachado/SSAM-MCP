// servidor/fase4-26 a8 (fix/delivery-no-deadline rounds 3c and 3d on the hosted line; C:\t\no-deadline\RESULTADO.md, "O que a
// linha do servidor precisa levar"): deliveries and creations run to their end hosted too, and the call deadline, which wraps
// the hosted gate, reads what a run-to-end call names AS THE GATE READS IT (hosted/policy.mjs replayInputs, ssam.mjs
// inputsOf), never as sent:
// - ws: and a relative path are the workspace file the gate hands the tool: the same content joins the live call, other
//   content is one DELIVERY_STILL_RUNNING ("changed"); one run each;
// - agent: (and a path of the agent's machine under its root, C26) is named by the sha256 the agent lists for that one file:
//   the same join and refusal, and the deadline never brings nor writes the file (a running delivery keeps its copy);
// - an agent that cannot list the file gives no print: a repeat is refused, never joined blindly; the call itself runs;
// - a call the gate refuses before the agent (a tool unavailable hosted, deleting, the prototype op...) is never looked at: no
//   agent call; ssam_code write (case f, served since a8 phase 6) is read as a delivery: its files by the gate's rules;
// - the replays and their kept answers are the customer's (ws:o11/tasks/.replays, ws:o11/answers with the origin record in
//   <ws>/state/answer-origins): another session of the same token replays the same content (resumedFrom), another customer
//   runs it; nothing lands in the server's own .local/tasks or .local/answers.
// Fake executor and agent; no Studio, no process, no socket. Times are scaled: the deadline (100 ms) stands for the 25 s.
// Synthetic values only.
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
const { o11Lane, anvilRoot } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { hostedTools } = await import('../hosted/policy.mjs');

const LANE = o11Lane.lane;
const PID = 5150, RELAY = 41556;
const AGENT_ROOT = 'C:\\SSAM-Agent';
const DEADLINE = 100;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-a8-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

// The customer's machine: its agent folder (<root>/agent-<token>) and what the server asked of it. pullFile is the gate's
// file.get (agent:inbox always brought, agent:odc|o11 when missing); agentFileSha256 is the listing of one file (file.list).
class FakeExecutor {
  constructor({ workspace, agentDir, record }) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.workspace = workspace; this.agentDir = agentDir; this.record = record; this.pulls = []; this.lists = []; this.listFails = false; }
  relayPort() { return RELAY; }
  async call(kind) {
    if (kind === 'studio.processes') return { processes: [] };
    if (kind === 'o11.bridge') return { reply: { success: true, data: {} } };
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  o11Connection() { return this.record; }
  agentFile(agentPath) { return path.join(this.agentDir, ...agentPath.replace(/^agent:/, '').split('/')); }
  async pullFile(agentPath, { ifMissing = false } = {}) {
    const dest = path.join(this.workspace, ...agentPath.replace(/^agent:/, '').split('/'));
    if (ifMissing && fs.existsSync(dest)) return dest;
    if (!fs.existsSync(this.agentFile(agentPath))) throw Object.assign(new Error('no such agent file'), { code: 'FILE_NOT_FOUND' });
    this.pulls.push(agentPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(this.agentFile(agentPath), dest);
    return dest;
  }
  async agentFileSha256(agentPath) {
    this.lists.push(agentPath);
    if (this.listFails) throw Object.assign(new Error('the agent did not answer'), { code: 'AGENT_TIMEOUT' });
    try { return sha(fs.readFileSync(this.agentFile(agentPath))); } catch { return null; }
  }
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

// A delivery of this test only, served like the lane's delivery tools: it reads its job (the path the gate resolved), holds
// for ms and answers delivered; its name says what it does (tool-classification.mjs: a write whose verb is deliver runs to
// its end). Its hosted classification takes /job as an input path, like o11_deliver's.
const DELIVER = 'zz_a8_deliver', PUBLISH = 'zz_a8_publish'; // a publication: no replay (round 3b)
const runs = [];
const deliverHandler = async ({ module, job, ms = 300 } = {}) => {
  const read = JSON.parse(fs.readFileSync(job, 'utf8'));
  runs.push(module + ':' + read.ops[0]);
  await sleep(ms);
  const value = { ok: true, result: 'delivered', module, job: read.ops[0] };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
};
const testTools = () => ({ ...hostedTools(), [DELIVER]: { class: 'server', lane: 'o11', agent: 'never', paths: { in: ['/job'], out: [] }, reason: 'test only' },
  [PUBLISH]: { class: 'server', lane: 'o11', agent: 'never', paths: { in: ['/job'], out: [] }, reason: 'test only' } });
async function hostedServer(context) {
  const server = await runWithExecutor(context, () => createSsamServer({ o11: true, odc: false, deps: { callDeadlineMs: DEADLINE },
    hosted: { context, session: { agent, lanes: context.lanes }, tools: testTools() } }));
  const schema = fromJsonSchema({ type: 'object', properties: { module: { type: 'string' }, job: { type: 'string' }, ms: { type: 'number' } }, additionalProperties: false });
  server.registerTool(DELIVER, { description: 'test delivery', inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: false } }, deliverHandler);
  server.registerTool(PUBLISH, { description: 'test publication', inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: false } }, deliverHandler);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-marco-a8', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { inputsOf: (name, args) => server.ssamInputsOf(name, args), close: async () => { await client.close(); await server.close(); },
    call: async (name, args, options = {}) => { const r = await client.callTool({ name, arguments: args }, { timeout: 60000, ...options }); return r.structuredContent ?? JSON.parse(r.content[0].text); } };
}
const text = value => JSON.stringify(value).slice(0, 500);
const writeJob = (file, op) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ops: [op] })); };
const runsOf = module => runs.filter(r => r.startsWith(module + ':'));
// Every file under a folder (relative), or [] when it does not exist.
const filesUnder = dir => { try { return fs.readdirSync(dir, { recursive: true }).map(String).filter(f => fs.statSync(path.join(dir, f)).isFile()).sort(); } catch { return []; } };

test('ws: and a relative path read as the gate reads them: the same content joins the live delivery, other content is one DELIVERY_STILL_RUNNING (changed); one run each', async () => {
  const A = customer();
  const s = await hostedServer(A);
  try {
    const file = path.join(A.workspace, 'o11', 'jobs', 'job.json');
    writeJob(file, 'X');
    for (const [module, job] of [['WsJoin', 'ws:o11/jobs/job.json'], ['RelJoin', 'jobs/job.json']]) {
      const first = s.call(DELIVER, { module, job, ms: 700 });
      await sleep(DEADLINE * 2.5); // past the deadline: kept, not answered
      const joined = await s.call(DELIVER, { module, job, ms: 700 });
      assert.equal(joined.joined, true, module + ': ' + text(joined));
      assert.equal(joined.job, 'X');
      assert.equal((await first).job, 'X');
      assert.deepEqual(runsOf(module), [module + ':X'], module + ': the joined repeat started nothing');
    }
    writeJob(file, 'Y');
    const first = s.call(DELIVER, { module: 'WsChanged', job: 'ws:o11/jobs/job.json', ms: 700 });
    await sleep(DEADLINE * 2.5);
    writeJob(file, 'Z'); // the job file changes while the first delivery runs
    const changed = await s.call(DELIVER, { module: 'WsChanged', job: 'ws:o11/jobs/job.json', ms: 700 });
    assert.equal(changed.code, 'DELIVERY_STILL_RUNNING', text(changed));
    assert.match(changed.error, /changed/, text(changed));
    assert.doesNotMatch(changed.error, /cannot read/);
    assert.equal((await first).job, 'Y');
    assert.deepEqual(runsOf('WsChanged'), ['WsChanged:Y'], 'the refused repeat started nothing');
  } finally { await s.close(); }
});

test('agent: and a path of the agent machine (C26) are named by the sha256 the agent lists: the same content joins, other content is one refusal, and the deadline never brings nor writes the file', async () => {
  const A = customer();
  const s = await hostedServer(A);
  try {
    const onAgent = path.join(A.agentDir, 'inbox', 'job.json');
    const copy = path.join(A.workspace, 'inbox', 'job.json');
    writeJob(onAgent, 'P');
    for (const [module, job] of [['AgentJoin', 'agent:inbox/job.json'], ['MachineJoin', AGENT_ROOT + '\\inbox\\job.json']]) {
      const pullsBefore = A.executor.pulls.length;
      const first = s.call(DELIVER, { module, job, ms: 700 });
      await sleep(DEADLINE * 2.5);
      const joined = await s.call(DELIVER, { module, job, ms: 700 });
      assert.equal(joined.joined, true, module + ': ' + text(joined));
      assert.equal((await first).job, 'P');
      assert.deepEqual(runsOf(module), [module + ':P']);
      assert.equal(A.executor.pulls.length - pullsBefore, 1, module + ': only the gate of the first call brought the file');
    }
    assert.ok(A.executor.lists.length >= 4, 'the deadline listed the agent file for each call: ' + A.executor.lists.length);
    writeJob(onAgent, 'Q');
    for (const [module, job] of [['AgentChanged', 'agent:inbox/job.json'], ['MachineChanged', AGENT_ROOT + '\\inbox\\job.json']]) {
      writeJob(onAgent, 'Q');
      const pullsBefore = A.executor.pulls.length;
      const first = s.call(DELIVER, { module, job, ms: 700 });
      await sleep(DEADLINE * 2.5);
      writeJob(onAgent, 'R'); // the user rewrites the file on the agent while the first delivery runs
      const changed = await s.call(DELIVER, { module, job, ms: 700 });
      assert.equal(changed.code, 'DELIVERY_STILL_RUNNING', module + ': ' + text(changed));
      assert.match(changed.error, /changed/, module + ': ' + text(changed));
      assert.equal(fs.readFileSync(copy, 'utf8'), JSON.stringify({ ops: ['Q'] }), module + ': the workspace copy the running delivery reads was not replaced');
      assert.equal(A.executor.pulls.length - pullsBefore, 1, module + ': the refused repeat brought nothing');
      assert.equal((await first).job, 'Q');
      assert.deepEqual(runsOf(module), [module + ':Q']);
    }
  } finally { await s.close(); }
});

test('an agent that cannot list the file gives no print: the call runs, a repeat while it runs is refused (cannot read), never joined blindly', async () => {
  const A = customer();
  const s = await hostedServer(A);
  try {
    writeJob(path.join(A.agentDir, 'inbox', 'quiet.json'), 'S');
    A.executor.listFails = true;
    const first = s.call(DELIVER, { module: 'Quiet', job: 'agent:inbox/quiet.json', ms: 700 });
    await sleep(DEADLINE * 2.5);
    const refused = await s.call(DELIVER, { module: 'Quiet', job: 'agent:inbox/quiet.json', ms: 700 });
    assert.equal(refused.code, 'DELIVERY_STILL_RUNNING', text(refused));
    assert.match(refused.error, /cannot read/);
    assert.equal(refused.joined, undefined);
    assert.equal((await first).job, 'S', 'the call itself ran: the deadline\'s inputs never fail a call');
    assert.deepEqual(runsOf('Quiet'), ['Quiet:S']);
  } finally { A.executor.listFails = false; await s.close(); }
});

// Case f since ssam_code is served hosted (a8 phase 6, fase4-26/a8-ssam-code): ssam_code write is a call a delivery runs inside
// (tool-classification.mjs nestsDelivery), so the deadline reads its files as the gate does (/files/*, /basedOn/job of
// hosted/tools.json): agent: and the agent machine's path by the sha256 the agent lists. Two identical calls are one print (the
// second joins the first), a file rewritten on the agent is another print (DELIVERY_STILL_RUNNING "changed"), and nothing is
// brought by the deadline. The join itself is the product's (call-deadline tests); the e2e (step 9k) runs it whole.
test('case f: ssam_code write {files} with agent: inputs is read as the gate reads it: the same files are one print, a changed file another; the deadline brings nothing', async () => {
  const A = customer();
  const s = await hostedServer(A);
  try {
    const onAgent = path.join(A.agentDir, 'inbox', 'part.logic');
    fs.writeFileSync(onAgent, 'server action CaseF\n  out Result: Integer\n  assign Result = 1\n  end\n');
    const args = { action: 'write', lane: 'o11', module: 'CaseF', files: ['agent:inbox/part.logic', AGENT_ROOT + '\\inbox\\part.logic'], authorize: 'deliver CaseF' };
    const [one, two] = await Promise.all([s.inputsOf('ssam_code', args), s.inputsOf('ssam_code', args)]);
    assert.ok(one?.print, 'a print for a served ssam_code write: ' + text(one));
    assert.equal(two.print, one.print, 'two identical calls are one print (the second joins the first)');
    fs.writeFileSync(onAgent, 'server action CaseF\n  out Result: Integer\n  assign Result = 2\n  end\n');
    const changed = await s.inputsOf('ssam_code', args);
    assert.ok(changed?.print && changed.print !== one.print, 'a file rewritten on the agent is another print (DELIVERY_STILL_RUNNING "changed")');
    assert.deepEqual([...new Set(A.executor.lists)], ['agent:inbox/part.logic'], 'both forms are the one agent file, listed: ' + A.executor.lists.join(', '));
    assert.deepEqual(A.executor.pulls, [], 'the deadline brought nothing');
    // check, grammar and read are no delivery: no print, nothing listed
    const listed = A.executor.lists.length;
    for (const action of ['check', 'grammar', 'read']) assert.equal(await s.inputsOf('ssam_code', { ...args, action }), undefined, action);
    assert.equal(A.executor.lists.length, listed);
  } finally { await s.close(); }
});

test('cases a, d and e of the hosted list: a job rewritten in the inbox runs again after the end; a publication runs again; an Esc before the deadline then the identical call is one run', async () => {
  const A = customer();
  const s = await hostedServer(A);
  try {
    const onAgent = path.join(A.agentDir, 'inbox', 'case.json');
    // (a) the job rewritten on the agent after the end of a kept delivery: the identical call delivers the new content
    writeJob(onAgent, 'A1');
    assert.equal((await s.call(DELIVER, { module: 'CaseA', job: 'agent:inbox/case.json', ms: 400 })).job, 'A1');
    writeJob(onAgent, 'A2');
    const rewritten = await s.call(DELIVER, { module: 'CaseA', job: 'agent:inbox/case.json', ms: 400 });
    assert.equal(rewritten.job, 'A2', text(rewritten)); assert.equal(rewritten.resumedFrom, undefined);
    assert.deepEqual(runsOf('CaseA'), ['CaseA:A1', 'CaseA:A2']);
    // (d) a publication (what the Studio holds, no print covers it) kept past the deadline runs again on the identical call
    writeJob(onAgent, 'D1');
    assert.equal((await s.call(PUBLISH, { module: 'CaseD', job: 'agent:inbox/case.json', ms: 400 })).job, 'D1');
    const republished = await s.call(PUBLISH, { module: 'CaseD', job: 'agent:inbox/case.json', ms: 400 });
    assert.equal(republished.resumedFrom, undefined, text(republished));
    assert.deepEqual(runsOf('CaseD'), ['CaseD:D1', 'CaseD:D1'], 'published twice');
    // (e) the client gives up before the deadline (Esc); the delivery ends ok; the identical call gets that answer, one run
    writeJob(onAgent, 'E1');
    const controller = new AbortController();
    const gaveUp = s.call(DELIVER, { module: 'CaseE', job: 'agent:inbox/case.json', ms: 400 }, { signal: controller.signal }).then(() => 'answered', () => 'cancelled');
    await sleep(DEADLINE / 2);
    controller.abort();
    assert.equal(await gaveUp, 'cancelled');
    await sleep(600); // the delivery ran on and ended
    const after = await s.call(DELIVER, { module: 'CaseE', job: 'agent:inbox/case.json', ms: 400 });
    assert.equal(after.job, 'E1', text(after));
    assert.deepEqual(runsOf('CaseE'), ['CaseE:E1'], 'the work of the cancelled call applied once and its answer came back');
  } finally { await s.close(); }
});

test('the replays and their kept answers are the customer\'s: another session of the same token replays the same content, another customer runs it, nothing in the server\'s own folders', async () => {
  const serverTasks = path.join(anvilRoot, '.local', 'tasks'), serverAnswers = path.join(anvilRoot, '.local', 'answers');
  const before = { tasks: filesUnder(serverTasks), answers: filesUnder(serverAnswers) };
  const A = customer(), B = customer();
  const job = 'ws:o11/jobs/replay.json';
  writeJob(path.join(A.workspace, 'o11', 'jobs', 'replay.json'), 'K');
  writeJob(path.join(B.workspace, 'o11', 'jobs', 'replay.json'), 'K');
  const a1 = await hostedServer(A), a2 = await hostedServer(A), b1 = await hostedServer(B);
  try {
    const first = await a1.call(DELIVER, { module: 'Replay', job, ms: 400 }); // kept past the deadline, answered at its end
    assert.equal(first.job, 'K', text(first));
    const replays = path.join(A.workspace, 'o11', 'tasks', '.replays');
    const entries = filesUnder(replays).filter(f => f.endsWith('.json'));
    assert.equal(entries.length, 1, 'the replay of the kept delivery is in the customer\'s ws:o11/tasks: ' + entries.join(', '));
    const entry = JSON.parse(fs.readFileSync(path.join(replays, entries[0]), 'utf8'));
    const answers = path.join(A.workspace, 'o11', 'answers');
    assert.equal(path.dirname(path.resolve(entry.answer.file)), path.resolve(answers), 'its kept answer is in the customer\'s ws:o11/answers');
    assert.ok(fs.existsSync(path.join(A.workspace, 'state', 'answer-origins', path.basename(entry.answer.file).replace(/\.json$/i, '') + '.origin'))
      || filesUnder(path.join(A.workspace, 'state', 'answer-origins')).length > 0, 'with its origin record in <ws>/state/answer-origins');
    const again = await a2.call(DELIVER, { module: 'Replay', job, ms: 400 }); // another MCP session of the same token
    assert.equal(again.job, 'K');
    assert.match(String(again.resumedFrom), /^[0-9a-f-]{36}$/, 'the same content: the kept answer, ' + text(again));
    assert.deepEqual(runsOf('Replay'), ['Replay:K'], 'one run for customer A');
    const other = await b1.call(DELIVER, { module: 'Replay', job, ms: 400 });
    assert.equal(other.job, 'K');
    assert.equal(other.resumedFrom, undefined, 'another customer never gets A\'s answer: ' + text(other));
    assert.deepEqual(runsOf('Replay'), ['Replay:K', 'Replay:K'], 'B ran its own delivery');
    const leaked = JSON.stringify(again) + JSON.stringify(other);
    for (const folder of [A.workspace, B.workspace, root, anvilRoot]) assert.ok(!leaked.includes(folder) && !leaked.includes(folder.replace(/\\/g, '/')), 'no server folder in an answer');
  } finally { await a1.close(); await a2.close(); await b1.close(); }
  assert.deepEqual(filesUnder(serverTasks).filter(f => !before.tasks.includes(f)), [], 'nothing new in the server\'s .local/tasks');
  assert.deepEqual(filesUnder(serverAnswers).filter(f => !before.answers.includes(f)), [], 'nothing new in the server\'s .local/answers');
});

// The agent's side of agentFileSha256: the real file.list kind of the agent package (agent/lib/kinds.mjs, unchanged), one file
// listed with the sha256 the agent computes on the user's machine; a folder, a missing file and a forbidden path give null;
// nothing is brought (no file.get) and nothing is written in the workspace.
test('agentFileSha256 over the real agent kinds: one file and its sha256; a folder, a missing file or a forbidden path is null; nothing brought', async () => {
  const { createKinds } = await import('../../../../agent/lib/kinds.mjs');
  const { createWorkspace } = await import('../../../../agent/lib/workspace.mjs');
  const { readPack } = await import('../../../../agent/lib/agent.mjs');
  const { makeRoot, removeRoot } = await import('../../../../agent/tests/fixtures/agent-root.mjs');
  const { AgentExecutor } = await import('../hosted/agent-executor.mjs');
  const agentRoot = makeRoot();
  const workspace = path.join(root, 'sha-ws-' + randomUUID().slice(0, 8));
  prepareWorkspace(workspace);
  try {
    const kinds = createKinds({ root: agentRoot, ws: createWorkspace(agentRoot), pack: readPack(agentRoot), kernel: () => null, limits: () => ({}),
      blobs: { offer() { throw new Error('nothing is offered'); }, async download() { throw new Error('nothing is brought'); }, async upload() { throw new Error('nothing is sent'); } },
      deps: { processes: async () => [], fileVersion: async () => null } });
    const kindsCalled = [];
    const link = { connected: () => true, info: () => ({ agentRoot }), protocolError() {}, supports: () => false,
      call: async (kind, params) => { kindsCalled.push(kind); return kinds.execute(kind, params); } };
    const executor = new AgentExecutor({ link, workspace, relayAuthorityDir: path.join(workspace, 'state', 'relay-authority'), o11: { lane: LANE } });
    fs.writeFileSync(path.join(agentRoot, 'inbox', 'job.json'), '{"ops":["X"]}');
    fs.mkdirSync(path.join(agentRoot, 'inbox', 'folder'), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, 'inbox', 'folder', 'a.json'), '{}');
    assert.equal(await executor.agentFileSha256('agent:inbox/job.json'), sha(Buffer.from('{"ops":["X"]}')));
    assert.equal(await executor.agentFileSha256('agent:inbox/folder'), null, 'a folder is no file');
    assert.equal(await executor.agentFileSha256('agent:inbox/missing.json'), null);
    assert.equal(await executor.agentFileSha256('agent:private/credential'), null, 'a path the agent refuses');
    assert.ok(kindsCalled.every(kind => kind === 'file.list'), 'only file.list: ' + kindsCalled.join(', '));
    assert.equal(fs.existsSync(path.join(workspace, 'inbox', 'job.json')), false, 'nothing written in the workspace');
  } finally { removeRoot(agentRoot); }
});

// The deadline's inputs ask the agent nothing for a call the gate refuses before the agent and any path (hosted-destructive
// NEW-1: nothing pulled, no kind): T2 deleting (o11_access apply, grants only too), the prototype op, a pending generator, a lane
// outside the token, a lane the image refused, a tool unavailable hosted. a8 phase 6: ssam_code is served, and the gate refuses
// its prototype op, its pending generators and its patch "verified" before the agent too (the checks fase4-26/a8-ssam-code
// gave the gate); the deadline reads the same checks, never a copy of them that a new check of the gate leaves behind. A call
// the gate lets through is read (one listing of its agent: file).
test('replayInputs asks the agent nothing for a call the gate refuses first; a call it lets through has its agent: file listed', async () => {
  const { replayInputs } = await import('../hosted/policy.mjs');
  const A = customer();
  writeJob(path.join(A.agentDir, 'inbox', 'g.json'), 'G');
  const tools = { ...hostedTools(), zz_a8_unavailable: { class: 'unavailable', lane: 'o11', agent: 'never', paths: { in: ['/job'], out: [] }, reason: 'test only' } };
  const code = { action: 'write', lane: 'o11', module: 'M', files: ['agent:inbox/g.json'] };
  const refused = [
    ['o11_access', { action: 'apply', manifestPath: 'agent:inbox/g.json', words: 'synthetic words' }, {}],
    ['o11_deliver', { module: 'M', job: { ops: [{ op: 'prototype', data: { source: 'agent:inbox/g.json' } }] }, producers: { P: 'agent:inbox/g.json' } }, {}],
    ['o11_deliver', { module: 'M', job: { ops: [{ op: 'entity-actions', data: { entities: 'all' } }] }, producers: { P: 'agent:inbox/g.json' } }, {}],
    ['o11_deliver', { module: 'M', job: { ops: [] }, producers: { P: 'agent:inbox/g.json' } }, { lanes: ['odc'] }],
    ['o11_deliver', { module: 'M', job: { ops: [] }, producers: { P: 'agent:inbox/g.json' } }, { kernelRefused: { o11: { reason: 'synthetic' } } }],
    ['zz_a8_unavailable', { job: 'agent:inbox/g.json' }, { tools }],
    ['ssam_code', { ...code, ops: [{ op: 'prototype', data: { source: 'agent:inbox/g.json' } }] }, {}],
    ['ssam_code', { ...code, ops: [{ op: 'rest-consume', data: { name: 'X', methods: [{ name: 'P', url: 'http://127.0.0.1:9/x' }] } }] }, {}],
    ['ssam_code', { action: 'write', lane: 'o11', module: 'M', basedOn: { job: 'agent:inbox/g.json', sha256: 'a'.repeat(64) }, patch: 'verified' }, {}],
    ['ssam_code', code, { lanes: ['odc'] }],
    ['ssam_code', code, { kernelRefused: { o11: { reason: 'synthetic' } } }],
  ];
  for (const [name, args, options] of refused) {
    const before = A.executor.lists.length;
    const out = await replayInputs(name, args, A, { agentRoot: AGENT_ROOT, lanes: A.lanes, ...options });
    assert.equal(A.executor.lists.length, before, name + ' ' + JSON.stringify(args).slice(0, 120) + ' ' + JSON.stringify(options) + ': the agent was asked nothing');
    assert.deepEqual(out, args, name + ': the arguments as they came (no print: the gate answers the call)');
  }
  const through = await replayInputs('o11_deliver', { module: 'M', job: { ops: [] }, producers: { P: 'agent:inbox/g.json' } }, A, { agentRoot: AGENT_ROOT, lanes: A.lanes });
  assert.match(String(through.producers.P), /^agent-content:sha256:[0-9a-f]{64}$/, JSON.stringify(through));
  const codeThrough = await replayInputs('ssam_code', code, A, { agentRoot: AGENT_ROOT, lanes: A.lanes });
  assert.match(String(codeThrough.files[0]), /^agent-content:sha256:[0-9a-f]{64}$/, 'a served ssam_code write has its file listed: ' + JSON.stringify(codeThrough));
  assert.deepEqual(A.executor.lists, ['agent:inbox/g.json', 'agent:inbox/g.json']);
  assert.deepEqual(A.executor.pulls, [], 'never brought');
});

// One rule (a8 phase 6): the gate and the deadline's inputs judge "refused before the agent" by the same function, so the
// two never disagree on any call (the review of a8 phase 5 named the copy a risk; the ssam_code merge proved it).
test('refusedBeforePaths is exactly the gate refusing before the agent: the same verdict on every call of the list', async () => {
  const { refusedBeforePaths, wrapHostedTool } = await import('../hosted/policy.mjs');
  const A = customer();
  const calls = [
    ['ssam_code', { action: 'write', lane: 'o11', module: 'M', ops: [{ op: 'prototype', data: { source: 'ws:inbox/p' } }] }],
    ['ssam_code', { action: 'check', lane: 'odc', module: 'M', ops: [{ op: 'rest-consume', data: { name: 'X', methods: [{ name: 'P', url: 'http://127.0.0.1:9/x' }] } }] }],
    ['ssam_code', { action: 'write', lane: 'o11', module: 'M', basedOn: { job: 'ws:o11/jobs/j.json', sha256: 'a'.repeat(64) }, patch: 'verified' }],
    ['ssam_code', { action: 'grammar', lane: 'o11' }],
    ['o11_deliver', { module: 'M', job: { ops: [{ op: 'prototype', data: { source: 'ws:inbox/p' } }] } }],
    ['o11_deliver', { module: 'M', job: '{not json' }],
    ['o11_deliver', { module: 'M', job: { ops: [] } }],
    ['studio_data_delete', { entity: 'E', ids: [1] }],
    ['ssam_debug', {}],
  ];
  for (const [name, args] of calls) {
    let handlerRan = false;
    const gated = wrapHostedTool(name, { inputSchema: {} }, async () => { handlerRan = true; return { content: [{ type: 'text', text: '{}' }] }; },
      { context: { ...A, executor: { ...A.executor, o11Connection: () => null, quota: { full: () => false } }, agent: { connected: () => false, info: () => null } }, lanes: A.lanes });
    const answer = (await gated(args, {})).structuredContent ?? {};
    // Refused before the agent: a refusal whose code is not the agent's (the fake agent is never connected).
    const gateFirst = !handlerRan && answer.ok === false && !['AGENT_NOT_CONNECTED', 'O11_NOT_CONNECTED'].includes(answer.code);
    assert.equal(refusedBeforePaths(name, args, { lanes: A.lanes }), gateFirst, name + ' ' + JSON.stringify(args).slice(0, 100) + ': gate ' + JSON.stringify(answer).slice(0, 160));
  }
});