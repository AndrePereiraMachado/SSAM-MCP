// servidor/fase4-26 (review C:\t\revisoes\vps-a6-continuetask of 75c8940c, probes P1-P3 of probes\ct-hosted.test.mjs): the
// CX12 continueTask path of the hosted server, through createSsamServer as each MCP session gets it.
// - CT-1: a restart of the container keeps the server pid (pid 7 in every start of the image). The running records the
//   previous process left in the customer's ws:o11/tasks read orphaned, close (ssam_task and ssam_doctor {task}), and the
//   identical call is refused until that close and runs once after it.
// - CT-2: two MCP sessions of the same token share the identical-call guard (the customer's task folder): the identical
//   write before the deadline joins the live call, and after a detached final not yet delivered it replays it; one
//   execution in each case, with or without a tracked handler. Another customer never joins (conf-isolamento).
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
const { runWithExecutor, prepareWorkspace, hostedContext } = await import('../executor.mjs');
const { o11Lane } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { hostedTools } = await import('../hosted/policy.mjs');
const { tasksDir, readTask, trackTask } = await import('../ssam-task.mjs');

const LANE = o11Lane.lane;
const PID = 5150, RELAY = 41555;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-ct-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
class FakeExecutor {
  constructor({ record = null, relay = null } = {}) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.record = record; this.relay = relay; }
  relayPort() { return this.relay; }
  async call(kind) {
    if (kind === 'studio.processes') return { processes: [] };
    if (kind === 'o11.bridge') return { reply: { success: true, data: {} } };
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  o11Connection() { return this.record; }
  async close() {}
}
const agent = { connected: () => true, protocolError() {},
  info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' },
    compatible: { odc: { ok: true }, o11: { ok: true } } }) };
// restartOf: a restart of the same customer keeps its token (F7: a hosted reader reads only its own caller's records); its
// copy of the workspace goes in its own folder.
function customer(restartOf = null) {
  const tokenId = restartOf ?? 'tok_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const workspace = restartOf ? path.join(root, 'restart-' + randomUUID().slice(0, 8), 'customers', tokenId) : path.join(root, 'customers', tokenId);
  prepareWorkspace(workspace);
  const executor = new FakeExecutor({ relay: RELAY, record: { ok: true, lane: 'o11', anvilLane: LANE, pid: PID, startedUtc: '2026-10-15T10:00:00.0000000Z',
    studioVersion: '11.55.92', port: RELAY, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-15T10:00:05.000Z', hosted: true } });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Synthetic ' + tokenId, lanes: ['odc', 'o11'], workspace, agent, executor, o11: { lane: LANE }, close: async () => {} };
}
const within = (context, fn) => runWithExecutor(context, fn);

// Three tools of this test only, served like server tools: a write that waits ms (or until its signal aborts), the same
// write tracked as the O11 deliveries are (trackTask records it when its body starts), and how many times each body ran.
const SLOW_W = 'zz_ct_slow_write', SLOW_T = 'zz_ct_tracked_write';
const runs = {};
const slowHandler = async ({ ms = 100, tag = 'x' } = {}, ctx) => {
  runs[tag] = (runs[tag] ?? 0) + 1;
  const signal = ctx?.mcpReq?.signal;
  const aborted = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(true); }, { once: true });
  });
  const value = { ok: true, tag, aborted, run: runs[tag], ranFor: hostedContext()?.tokenId ?? null };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
};
const trackedHandler = async (args = {}, ctx) => {
  let answer;
  await trackTask({ tool: SLOW_T, summary: { tag: args.tag }, dir: tasksDir() }, async () => { answer = await slowHandler(args, ctx); return answer.structuredContent; });
  return answer;
};
const testTools = () => ({ ...hostedTools(),
  [SLOW_W]: { class: 'server', lane: 'none', agent: 'never', paths: { in: [], out: [] }, reason: 'test only' },
  [SLOW_T]: { class: 'server', lane: 'none', agent: 'never', paths: { in: [], out: [] }, reason: 'test only' } });
async function hostedServer(context, { deps = {} } = {}) {
  const server = await within(context, () => createSsamServer({ o11: true, odc: false, deps,
    hosted: { context, session: { agent, lanes: context.lanes }, tools: testTools() } }));
  const schema = fromJsonSchema({ type: 'object', properties: { ms: { type: 'number' }, tag: { type: 'string' } }, additionalProperties: false });
  const write = { readOnlyHint: false, destructiveHint: false };
  server.registerTool(SLOW_W, { description: 'test write', inputSchema: schema, annotations: write }, slowHandler);
  server.registerTool(SLOW_T, { description: 'test tracked write', inputSchema: schema, annotations: write }, trackedHandler);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-continue-task', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { close: async () => { await client.close(); await server.close(); },
    call: async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); } };
}
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } return check(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tasksOf = context => within(context, () => tasksDir());
const text = value => JSON.stringify(value).slice(0, 400);
// The records of a customer's ws:o11/tasks copied as they are (records and .index) into another workspace: what a server
// started after a restart finds there, with this process's pid in them (the container keeps pid 7).
const copyTasks = (from, to) => { fs.mkdirSync(to, { recursive: true }); fs.cpSync(from, to, { recursive: true }); };

test('CT-1 a restart with the same pid: the running record of the previous server reads orphaned, closes (ssam_task, ssam_doctor), and the identical call runs once after the close', async () => {
  const A = customer();
  const sa = await hostedServer(A, { deps: { callDeadlineMs: 50 } });
  const first = await sa.call(SLOW_W, { ms: 4000, tag: 'p1' });
  const id = first.task.id;
  const live = await until(() => within(A, () => readTask(id)));
  assert.equal(live.state, 'running'); assert.equal(live.pid, process.pid); assert.equal(live.orphaned, undefined);
  const after = customer(A.tokenId), viaDoctor = customer(A.tokenId);
  copyTasks(await tasksOf(A), await tasksOf(after)); copyTasks(await tasksOf(A), await tasksOf(viaDoctor));
  const s = await hostedServer(after, { deps: { callDeadlineMs: 200 } });
  const d = await hostedServer(viaDoctor, { deps: { callDeadlineMs: 200 } });
  try {
    const read = await s.call('ssam_task', { id });
    assert.equal(read.task?.orphaned, true, text(read));
    assert.deepEqual(read.continuation?.arguments, { id, close: { reason: '<reason>' } }); // the English marker since 16/10
    const continued = await s.call(SLOW_W, { continueTask: id });
    assert.equal(continued.code, 'TASK_ORPHANED', text(continued)); assert.equal(continued.close?.tool, 'ssam_task');
    for (let i = 0; i < 2; i++) {
      const refused = await s.call(SLOW_W, { ms: 4000, tag: 'p1' });
      assert.equal(refused.code, 'TASK_UNCERTAIN_PENDING', text(refused));
      assert.equal(refused.task?.orphaned, true); assert.equal(refused.close?.tool, 'ssam_task');
    }
    assert.equal(runs.p1, 1, 'never run again before the close');
    const closed = await s.call('ssam_task', { id, close: { reason: 'Synthetic reconciliation' } });
    assert.equal(closed.ok, true, text(closed));
    const again = await s.call(SLOW_W, { ms: 4000, tag: 'p1' });
    assert.equal(again.state, 'running', text(again)); assert.equal(runs.p1, 2, 'the identical call runs after the close');
    const joined = await s.call(SLOW_W, { ms: 4000, tag: 'p1' });
    assert.equal(joined.joined, true, text(joined)); assert.equal(runs.p1, 2, 'once');
    // The same close through ssam_doctor {task} (the hosted doctor branch).
    const doctorRead = await d.call('ssam_doctor', { task: { id } });
    assert.equal(doctorRead.task?.orphaned, true, text(doctorRead));
    const doctorClose = await d.call('ssam_doctor', { task: { id, close: { reason: 'Synthetic reconciliation' } } });
    assert.equal(doctorClose.ok, true, text(doctorClose));
    const afterDoctor = await d.call(SLOW_W, { ms: 4000, tag: 'p1' });
    assert.equal(afterDoctor.state, 'running', text(afterDoctor)); assert.equal(runs.p1, 3);
    for (const [server, task] of [[s, again.task.id], [d, afterDoctor.task.id]]) await server.call('ssam_task', { id: task, stop: true });
  } finally {
    await sa.call('ssam_task', { id, stop: true });
    await sleep(50);
    await s.close(); await d.close(); await sa.close();
  }
});

for (const tool of [SLOW_W, SLOW_T]) {
  const tracked = tool === SLOW_T;
  test('CT-2 two sessions of the same token: the identical write before the deadline joins the live call, one execution' + (tracked ? ' (tracked)' : ''), async () => {
    const A = customer(), tag = tracked ? 'p2t' : 'p2';
    const s1 = await hostedServer(A, { deps: { callDeadlineMs: 3000 } });
    const s2 = await hostedServer(A, { deps: { callDeadlineMs: 3000 } });
    try {
      const one = s1.call(tool, { ms: 800, tag });
      await sleep(150);
      const two = await s2.call(tool, { ms: 800, tag });
      const first = await one;
      assert.equal(runs[tag], 1, text({ first, two }));
      assert.equal(two.joined, true, text(two)); assert.equal(two.run, 1); assert.equal(first.run, 1);
      assert.equal(two.ranFor, A.tokenId);
    } finally { await s1.close(); await s2.close(); }
  });

  test('CT-2 two sessions of the same token: the identical write after a detached final not yet delivered replays it, one execution' + (tracked ? ' (tracked)' : ''), async () => {
    const A = customer(), tag = tracked ? 'p3t' : 'p3';
    const s1 = await hostedServer(A, { deps: { callDeadlineMs: 50 } });
    const s2 = await hostedServer(A, { deps: { callDeadlineMs: 2000 } });
    try {
      const first = await s1.call(tool, { ms: 300, tag });
      assert.equal(first.state, 'running', text(first));
      const id = first.task.id;
      const done = await until(() => { const r = within(A, () => readTask(id)); return r?.state === 'ok' ? r : null; });
      assert.equal(done?.deliveries, 0);
      const replayed = await s2.call(tool, { ms: 300, tag });
      assert.equal(runs[tag], 1, text(replayed));
      assert.equal(replayed.resumedFrom, id, text(replayed)); assert.equal(replayed.run, 1);
      const continued = await s2.call(tool, { continueTask: id });
      assert.equal(continued.ok, true, text(continued)); assert.equal(continued.run, 1);
    } finally { await s1.close(); await s2.close(); }
  });
}

test('CT-2 another customer never joins nor replays the call of the first (the guard is the customer\'s folder)', async () => {
  const A = customer(), B = customer();
  const sa = await hostedServer(A, { deps: { callDeadlineMs: 3000 } });
  const sb = await hostedServer(B, { deps: { callDeadlineMs: 3000 } });
  try {
    const one = sa.call(SLOW_W, { ms: 600, tag: 'iso' });
    await sleep(150);
    const two = await sb.call(SLOW_W, { ms: 600, tag: 'iso' });
    const first = await one;
    assert.equal(two.joined, undefined); assert.equal(two.ranFor, B.tokenId); assert.equal(first.ranFor, A.tokenId);
    assert.equal(runs.iso, 2, 'each customer runs its own call');
  } finally { await sa.close(); await sb.close(); }
});
