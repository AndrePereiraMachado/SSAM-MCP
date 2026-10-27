// servidor/fase4-26 (C:\t\vps-a6\PLANO.md section 3): what the night's marco-a5 (integracao/marco-a5 8ca7c576: CX12 call
// deadline and ssam_task, CX14 bridge stall probes and pending-operation fence, CX15 destructive store, CX16 UI precheck and
// html element edits) adds, kept per customer on a hosted server. One test per finding of the plan:
// - A1: the CX14 kernel probes check the pid of the customer's Studio on the server: off hosted (ANVIL_BRIDGE_PROBE_MS=0).
// - A2: the CX15 destructive store (previews, operations, backups, seen words) is the customer's (<ws>/state/destructive,
//   clientId = the token); a served call without its context is refused, never the default root.
// - A3: ssam_doctor {task} and the ssam_task of an ODC-only server read the customer's ws:o11/tasks.
// - B: the answer of a detached task is kept in the customer's ws:o11/answers, never in <anvilRoot>/.local/answers.
// - C: the call deadline runs in the customer's context; a continueTask of customer A sent by customer B is TASK_NOT_FOUND.
// - M2: a job reads a kept reading (html, data text, flow: the module index is shared by every customer and addressed by
//   hashes) only of its own base capture (ANVIL_KEPT_READINGS=own for the kernel; the kernel side is KeptReadingRuleTests).
// - M3: a continueTask of a task still running in another session of the same customer waits, never TASK_ORPHANED.
// - M4: the pending-operation fence never reads the customer's Studio pid on the server as dead.
// - M5: the CX16 UI precheck is off hosted, whatever the server's SSAM_UI_PRECHECK says.
// - D: the CX14 manifest read of the O11 bridge goes through the executor seam hosted, never a socket of the server.
// Fake executor and agent; no Studio, no process, no socket.
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
import { callerKey } from '../correlation.mjs';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
const spawned = [];
const connections = [];
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  spawned.push({ file, args: [...(args ?? [])] });
  const child = new EventEmitter(); child.stdin = { end() {} }; child.unref = () => {}; child.kill = () => {}; child.pid = 0;
  setImmediate(() => callback?.(new Error('no child process in hosted tests'), '', ''));
  return child;
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));
cp.spawn = (file, args) => { spawned.push({ file, args, spawn: true }); throw new Error('spawn is not allowed in hosted tests'); };
net.createConnection = (...args) => { connections.push(args); throw new Error('no TCP or pipe connection in hosted tests'); };
syncBuiltinESMExports();

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace, hostedSpawnEnv, hostedContext, setDefaultExecutor, DenyExecutor } = await import('../executor.mjs');
const { anvilRoot, o11Lane } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { hostedTools } = await import('../hosted/policy.mjs');
const { tasksDir, mergeTask } = await import('../ssam-task.mjs');
const destructive = await import('../destructive-operations.mjs');
const { createCallDeadline } = await import('../call-deadline.mjs');
const { watchPendingOperation } = await import('../studio-pending-operation.mjs');
const { startUiPrecheck } = await import('../ui-precheck.mjs');
const { o11Bridge, bridgeTarget } = await import('../o11-bridge.mjs');

const LANE = o11Lane.lane;
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const listing = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const DEAD_PID = 2147480000; // no process of this server has it: processAlive answers false
class FakeExecutor {
  constructor({ record = null, relay = null } = {}) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.calls = []; this.record = record; this.relay = relay; }
  relayPort() { return this.relay; }
  async call(kind, params = {}) {
    this.calls.push({ kind, params: structuredClone({ ...params, signal: undefined }) });
    if (kind === 'studio.processes') return { processes: [] };
    if (kind === 'o11.bridge') {
      if (params.method === 'bridge_manifest') return { reply: { success: true, data: { protocolVersion: 2, capabilities: ['merge_from_oml:module_key'] } } };
      return { reply: { success: true, data: {} } };
    }
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  o11Connection() { return this.record; }
  async close() {}
}
const agent = { connected: () => true, protocolError() {},
  info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' },
    compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function hosted({ pid = 5150 } = {}) {
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(temp('ssam-a6-'), 'customers', tokenId);
  prepareWorkspace(workspace);
  const relay = 41000 + Math.floor(Math.random() * 8000);
  const executor = new FakeExecutor({ relay, record: { ok: true, lane: 'o11', anvilLane: LANE, pid, startedUtc: '2026-10-15T10:00:00.0000000Z',
    studioVersion: '11.55.92', port: relay, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-15T10:00:05.000Z', hosted: true } });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Customer ' + tokenId, lanes: ['odc', 'o11'], workspace, agent, executor, o11: { lane: LANE }, close: async () => {} };
}
const within = (context, fn) => runWithExecutor(context, fn);
// A tool of this test only, served by the hosted server like a server tool; it sleeps and says in whose context it ran.
const SLOW = 'zz_test_slow';
const slowTools = () => ({ ...hostedTools(), [SLOW]: { class: 'server', lane: 'none', agent: 'never', paths: { in: [], out: [] }, reason: 'test only' } });
async function hostedServer(context, { o11 = true, odc = false, deps = {}, slowMs = null } = {}) {
  const server = await within(context, () => createSsamServer({ o11, odc, deps,
    hosted: { context, session: { agent, lanes: context.lanes }, ...(slowMs != null ? { tools: slowTools() } : {}) } }));
  if (slowMs != null) {
    const { fromJsonSchema } = await import('@modelcontextprotocol/server');
    server.registerTool(SLOW, { description: 'test', inputSchema: fromJsonSchema({ type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false }),
      annotations: { readOnlyHint: true } }, async () => {
      await new Promise(resolve => setTimeout(resolve, slowMs));
      const value = { ok: true, ranFor: hostedContext()?.tokenId ?? null, marker: 'slow-' + context.tokenId };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    });
  }
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-marco-a6-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { close: async () => { await client.close(); await server.close(); },
    call: async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); } };
}
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } return check(); };

test('A1: every hosted O11 kernel process (cold and the customer\'s worker) runs with the CX14 bridge probes off', async () => {
  const context = hosted();
  const env = within(context, () => hostedSpawnEnv('o11').env);
  assert.equal(env.ANVIL_BRIDGE_PROBE_MS, '0', 'the probes check the Studio pid on the server: off until an agent package carries CX14');
  assert.equal(env.ANVIL_BRIDGE_FLAVOR, 'thin');
});

test('M2: every hosted kernel process reads a kept html reading only for its job\'s own base capture (ANVIL_KEPT_READINGS=own)', async () => {
  const context = hosted();
  for (const lane of ['o11', 'odc']) assert.equal(within(context, () => hostedSpawnEnv(lane).env.ANVIL_KEPT_READINGS), 'own', lane);
  // The shared processes of the served mode (the resident ODC worker and builder, started outside any customer) get the same
  // rule from the server's own environment (ssam.mjs runServed: hostedServerEnv).
  const { hostedServerEnv } = await import('../ssam.mjs');
  const env = {};
  hostedServerEnv(env);
  assert.equal(env.ANVIL_KEPT_READINGS, 'own');
  assert.equal(env.ANVIL_BRIDGE_PROBE_MS, '0');
  const source = fs.readFileSync(new URL('../ssam.mjs', import.meta.url), 'utf8');
  const served = source.slice(source.indexOf('export async function runServed'), source.indexOf('export async function qualityRecorder'));
  assert.ok(served.indexOf('hostedServerEnv(process.env)') > served.indexOf('if (options.localStudios)'), 'the hosted branch of runServed sets it');
  assert.ok(served.indexOf('hostedServerEnv(process.env)') < served.indexOf('scheduleWarm('), 'before the warm-up starts the shared processes');
});

test('A2: the CX15 destructive store is the customer\'s: B never lists or reads A\'s previews and records; nothing in the default root', async () => {
  const a = hosted(), b = hosted();
  const defaultRoot = destructive.destructiveRoot();
  const before = listing(path.join(defaultRoot, 'previews'));
  const preview = within(a, () => destructive.createPreview({ tool: 'o11_data', lane: 'o11', host: 'h.example', operation: 'delete',
    selection: { entity: 'E', ids: ['1'] }, items: [{ kind: 'record', key: '1', name: 'E 1' }], ownerRequest: 'apague o registro 1 de E' }));
  assert.ok(fs.existsSync(path.join(a.workspace, 'state', 'destructive', 'previews', String(preview.previewId).toLowerCase() + '.json')), 'in A\'s workspace');
  assert.deepEqual(listing(path.join(defaultRoot, 'previews')), before, 'nothing in the default root of the server');
  const stored = within(a, () => destructive.readPreview(preview.previewId));
  assert.equal(stored?.previewId, preview.previewId);
  assert.equal(stored.clientId, a.tokenId, 'the preview names the customer\'s token');
  const record = within(a, () => destructive.beginOperation({ preview: stored, words: 'apague o registro 1 de E' }));
  within(a, () => destructive.endOperation(record, 'refused'));
  assert.equal(within(b, () => destructive.readPreview(preview.previewId)), null, 'B never reads A\'s preview');
  assert.equal(within(b, () => destructive.readOperation(preview.operationId)), null, 'B never reads A\'s record');
  assert.deepEqual(within(b, () => destructive.listOperations({ limit: 10 })), [], 'B lists none of A\'s operations');
  assert.equal(within(a, () => destructive.listOperations({ limit: 10 })).length, 1);
  // Through ssam_task of the hosted servers.
  const sa = await hostedServer(a), sb = await hostedServer(b);
  try {
    assert.equal((await sa.call('ssam_task', {})).destructive.length, 1);
    assert.deepEqual((await sb.call('ssam_task', {})).destructive, []);
    const readByB = await sb.call('ssam_task', { id: preview.operationId });
    assert.notEqual(readByB.ok, true, JSON.stringify(readByB).slice(0, 300));
    assert.equal(JSON.stringify(readByB).includes(preview.previewId), false, 'nothing of A\'s preview in B\'s answer');
  } finally { await sa.close(); await sb.close(); }
  // A served process without a context is refused, never answered from the default root.
  const previous = setDefaultExecutor(new DenyExecutor());
  try {
    assert.throws(() => destructive.createPreview({ tool: 'o11_data', host: 'h.example', operation: 'delete', items: [] }), error => error.code === 'HOSTED_CONTEXT_LOST');
    assert.throws(() => destructive.readOperation(preview.operationId), error => error.code === 'HOSTED_CONTEXT_LOST');
    assert.deepEqual(destructive.listOperations({ limit: 10 }), [], 'the listing reads no folder (its read failure answers an empty list)');
    assert.deepEqual(listing(path.join(defaultRoot, 'previews')), before, 'still nothing in the default root');
  } finally { setDefaultExecutor(previous); }
});

test('A3: ssam_doctor {task} and the ssam_task of an ODC-only hosted server read the customer\'s ws:o11/tasks, never <anvilRoot>/.local/tasks', async () => {
  const a = hosted(), b = hosted();
  const id = randomUUID();
  const shared = path.join(anvilRoot, '.local', 'tasks');
  const before = listing(shared);
  // F7: a hosted call stamps its caller on the record (correlation.mjs traceFields); a reader sees only its own caller's.
  within(a, () => mergeTask(tasksDir(), { id, tool: 'o11_deliver', pid: process.pid, startedAt: new Date().toISOString(), state: 'uncertain', isWrite: true, call: { lane: 'o11' }, correlationId: randomUUID(), callerKey: callerKey(a.tokenId) }));
  assert.ok(fs.existsSync(path.join(a.workspace, 'o11', 'tasks')), 'the record is in A\'s workspace');
  const sa = await hostedServer(a), sb = await hostedServer(b);
  const oa = await hostedServer(a, { o11: false }), ob = await hostedServer(b, { o11: false });
  try {
    const mine = await sa.call('ssam_doctor', { task: { id } });
    assert.equal(mine.ok, true, JSON.stringify(mine).slice(0, 400));
    assert.equal(mine.task?.id, id);
    assert.equal((await sb.call('ssam_doctor', { task: { id } })).code, 'TASK_NOT_FOUND');
    const odcOnly = await oa.call('ssam_task', { id });
    assert.equal(odcOnly.task?.id ?? odcOnly.id, id, JSON.stringify(odcOnly).slice(0, 400));
    const odcOther = await ob.call('ssam_task', { id });
    assert.notEqual(odcOther.ok, true, JSON.stringify(odcOther).slice(0, 300));
  } finally { await sa.close(); await sb.close(); await oa.close(); await ob.close(); }
  assert.deepEqual(listing(shared), before, 'nothing written in the server\'s shared task folder');
});

test('B and C: a detached call runs in the customer\'s context, keeps its answer in ws:o11/answers, and another customer cannot continue it', async () => {
  const a = hosted(), b = hosted();
  const shared = path.join(anvilRoot, '.local', 'answers');
  const before = listing(shared);
  const sa = await hostedServer(a, { deps: { callDeadlineMs: 50 }, slowMs: 400 });
  const sb = await hostedServer(b, { deps: { callDeadlineMs: 50 }, slowMs: 400 });
  try {
    const first = await sa.call(SLOW, { n: 1 });
    assert.equal(first.state, 'running', JSON.stringify(first).slice(0, 300));
    const id = first.task.id;
    assert.equal(first.continuation.arguments.continueTask, id);
    // C: customer B continues A's task: it is not B's.
    const stolen = await sb.call(SLOW, { continueTask: id });
    assert.equal(stolen.code, 'TASK_NOT_FOUND', JSON.stringify(stolen).slice(0, 300));
    assert.equal(JSON.stringify(stolen).includes('slow-' + a.tokenId), false);
    // A continues its own and gets the answer of the handler, which ran for A.
    const done = await until(async () => { const v = await sa.call(SLOW, { continueTask: id }); return v.state === 'running' ? null : v; });
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 300));
    assert.equal(done.ranFor, a.tokenId);
    // B: the answer of the detached task is kept in A's ws:o11/answers, never in the server's shared folder.
    const kept = listing(path.join(a.workspace, 'o11', 'answers'));
    assert.ok(kept.length >= 1, 'kept in A\'s workspace');
    assert.deepEqual(listing(shared), before, 'nothing new in <anvilRoot>/.local/answers');
    const task = await sa.call('ssam_task', { id });
    const text = JSON.stringify(task);
    assert.equal(text.includes(anvilRoot), false, 'no path of the server in ssam_task {id}');
    assert.deepEqual(listing(path.join(b.workspace, 'o11', 'answers')), []);
  } finally { await sa.close(); await sb.close(); }
});

test('C: the call deadline itself runs in the customer\'s context (an orphaned delivery reads the kernel task of A\'s workspace)', async () => {
  const a = hosted();
  const id = randomUUID(), kernelId = randomUUID().replace(/-/g, '');
  within(a, () => {
    mergeTask(tasksDir(), { id, tool: 'o11_deliver', pid: process.pid, startedAt: new Date().toISOString(), state: 'running', orphaned: true, isWrite: true,
      call: { lane: 'o11' }, result: { taskId: kernelId } });
    const folder = path.join(a.workspace, 'o11', 'work', 'deliver', kernelId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'task.json'), JSON.stringify({ taskId: kernelId, stage: 'merge', updatedAt: new Date().toISOString() }));
  });
  const sa = await hostedServer(a);
  try {
    const value = await sa.call('o11_deliver', { continueTask: id });
    assert.equal(value.code, 'TASK_ORPHANED', JSON.stringify(value).slice(0, 400));
    assert.equal(value.continuation?.tool, 'o11_deliver', 'the kernel task of A\'s workspace was found: ' + JSON.stringify(value.continuation));
    assert.equal(value.continuation.arguments.resume, kernelId);
  } finally { await sa.close(); }
});

test('M3: a continueTask of a task still running in another session of the same customer waits for it, never TASK_ORPHANED', async () => {
  const dir = temp('ssam-a6-tasks-');
  let finish;
  const handler = () => new Promise(resolve => { finish = () => resolve({ content: [{ type: 'text', text: '{"ok":true,"done":1}' }], structuredContent: { ok: true, done: 1 } }); });
  const first = createCallDeadline({ root: temp('ssam-a6-root-'), dir, timeoutMs: 40 });
  const second = createCallDeadline({ root: temp('ssam-a6-root-'), dir, timeoutMs: 40 });
  const tool = 'o11_inspect';
  const started = await first.wrap(tool, handler)({ lane: 'o11', n: 1 }, {});
  const id = started.structuredContent?.task?.id;
  assert.ok(id, JSON.stringify(started).slice(0, 300));
  const waiting = await second.wrap(tool, handler)({ continueTask: id }, {});
  assert.notEqual(waiting.structuredContent?.code, 'TASK_ORPHANED', JSON.stringify(waiting).slice(0, 300));
  assert.equal(waiting.structuredContent?.state, 'running');
  finish();
  const end = await until(async () => { const v = await second.wrap(tool, handler)({ continueTask: id }, {}); return v.structuredContent?.state === 'running' ? null : v; });
  assert.equal(end.structuredContent?.done, 1, JSON.stringify(end).slice(0, 300));
});

test('M4: hosted, the pending-operation fence never takes the customer\'s Studio pid on the server for a dead Studio', async () => {
  const context = hosted({ pid: DEAD_PID });
  let reads = 0;
  const client = { ok: async verb => { reads++; return verb === 'merge_status' ? { state: 'running' } : verb === 'windows' ? { windows: [] } : {}; } };
  const release = within(context, () => watchPendingOperation({ lane: LANE, record: context.executor.record, method: 'merge_from_oml', operationId: 'op-1',
    moduleKey: 'k', bridge: () => client, settleMs: 10, capMs: 60000 }));
  try {
    await until(() => reads > 0, 2000);
    assert.ok(reads > 0, 'the fence kept reading the Studio through the agent instead of releasing on a pid of the server');
  } finally { release(); }
});

test('M5: hosted, the CX16 UI precheck is off whatever the server\'s SSAM_UI_PRECHECK says; locally it still starts', async () => {
  const dir = temp('ssam-a6-precheck-');
  const base = path.join(dir, 'base.oml'); fs.writeFileSync(base, 'base');
  const job = { ops: [{ op: 'html', data: { screen: 'S', basedOn: { capture: 'a', html: 'b' }, edit: ['<div k="w1"></div>'] } }] };
  const request = () => ({ lane: 'o11', module: 'M', document: job, mode: 'deliver', base, input: {} });
  const deps = () => ({ env: { SSAM_UI_PRECHECK: '1' }, local: path.join(dir, 'local'), runAnvil: async () => { throw new Error('no kernel in this test'); } });
  const context = hosted();
  assert.equal(await within(context, () => startUiPrecheck(request(), deps())), null, 'hosted: no precheck');
  assert.deepEqual(listing(path.join(dir, 'local')), [], 'hosted: nothing written');
  const local = await startUiPrecheck(request(), deps());
  assert.notEqual(local, null, 'local: the precheck starts as before');
  if (local?.pending) await local.pending;
});

test('D: hosted, the manifest of the O11 bridge is read through the executor seam (o11.bridge), never a socket of the server', async () => {
  const context = hosted();
  const before = connections.length;
  const read = await within(context, () => o11Bridge(bridgeTarget()).manifest({ timeoutMs: 1000 }));
  assert.equal(read.ok, true, JSON.stringify(read).slice(0, 300));
  assert.deepEqual(read.capabilities, ['merge_from_oml:module_key']);
  assert.equal(connections.length, before, 'no socket from the server');
  assert.ok(context.executor.calls.some(c => c.kind === 'o11.bridge' && c.params.method === 'bridge_manifest'));
});

test('the stopgap covers CX15: every tool and verb of DESTRUCTIVE_TOOLS, preview and execution (confirmationToken, ownerRequest), is refused hosted', async () => {
  const { hostedDestructive } = await import('../hosted/destructive.mjs');
  const TOKEN = 'ssam-confirm-' + randomUUID(); // any text: the stopgap refuses by tool and action, token or not
  const { DEPLOY: deploy } = await import('../../portal/runtime/effects.mjs');
  const callsOf = entry => {
    if (entry.tool === 'o11_data') return [{ host: 'h', module: 'M', oml: 'ws:o11/m.oml', request: { operation: 'delete', entity: 'E', ids: ['1'] } }];
    if (entry.tool === 'studio_command') return [...entry.verbs].map(command => ({ command }));
    if (entry.tool === 'odc_write') return [{ operationId: 'asset-repository-api-v1:delete:/assets/{assetKey}' }, { operationId: deploy, body: { operation: 'Undeploy' } }];
    if (entry.tool === 'odc_portal_write') return [{ operationId: 'connections.delete', input: {} }];
    if (!entry.verbs) return [{}];
    return entry.verbs.map(verb => ({ [entry.field]: verb }));
  };
  const seen = [];
  for (const entry of destructive.DESTRUCTIVE_TOOLS) {
    for (const args of callsOf(entry)) {
      const executions = entry.tool === 'o11_data' ? [{ ...args, request: { ...args.request, confirmationToken: TOKEN, ownerRequest: 'apague 1 registro de E' } }]
        : [{ ...args, confirmationToken: TOKEN, ownerRequest: 'apague isto', words: 'apague isto', authorize: 'apague isto' }];
      for (const call of [args, ...executions]) {
        assert.equal(hostedDestructive(entry.tool, call), true, entry.tool + ' ' + JSON.stringify(call));
        seen.push(entry.tool);
      }
    }
  }
  assert.deepEqual([...new Set(seen)].sort(), destructive.DESTRUCTIVE_TOOLS.map(e => e.tool).sort());
  assert.equal(destructive.DESTRUCTIVE_TOOLS.length, 13);
  // End to end: a preview and an execution of studio_data_delete and o11_data through the hosted server: refused before
  // anything runs, nothing reaches the customer's machine and nothing is written in the customer's destructive store.
  const context = hosted();
  const server = await hostedServer(context, { odc: true });
  try {
    for (const [name, args] of [
      ['studio_data_delete', { module: 'M', entity: 'E', ids: ['1'] }],
      ['studio_data_delete', { module: 'M', entity: 'E', confirmationToken: TOKEN, authorize: 'apague 1 registro de E' }],
      ['o11_data', { host: 'h', module: 'M', oml: 'ws:o11/m.oml', request: { operation: 'delete', entity: 'E', ids: ['1'] } }],
      ['o11_data', { host: 'h', module: 'M', oml: 'ws:o11/m.oml', request: { operation: 'delete', entity: 'E', ids: ['1'], confirmationToken: TOKEN, ownerRequest: 'apague 1 registro de E' } }],
    ]) {
      const value = await server.call(name, args);
      assert.equal(value.cause, 'DESTRUCTIVE_HOSTED_OFF', name + ' ' + JSON.stringify(value).slice(0, 300));
    }
  } finally { await server.close(); }
  assert.deepEqual(context.executor.calls.filter(c => c.kind !== 'studio.processes'), [], 'nothing reached the customer\'s machine');
  assert.deepEqual(listing(path.join(context.workspace, 'state', 'destructive')), [], 'nothing in the customer\'s destructive store');
});
