// F7 (traceability per session; owner audit of a Traditional migration, 22/10, items 22-25): ONE correlation id per session,
// ONE operation id per call, carried on every record of the call, so a delivery is found by its id in every store and a
// session reads its own records by default.
// - positive: one delivery (launcher observer -> served call -> facade task -> kernel runner -> kernel task, journal, access
//   restore, friction operation and report) is found by its operationId and by its kernel task id in all four stores
//   (friction queue, facade tasks, kernel task, friction reports) and in the journal through ssam_evidence;
// - negative: another session's records are never returned by default (ssam_task, ssam_friction, ssam_evidence), only with
//   an explicit session option; hosted, another caller's records are never returned, with any option; a session option of
//   another shape is refused with the element named and one next call; a client cannot choose the operation id;
// - generated sweeps: every tool the server serves that records operations (derived from the live tool list and the
//   tool classification) stamps the ids through the one call scope; every JSON line the facade appends goes through the
//   one traced writer (derived from the facade sources); the kernel trace arguments go to deliver only;
// - the per-session timeline: start, end, tool time, queue wait and the gap between operations add up.
// Fakes only: no Studio, no kernel process, no environment.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCallDeadline } from '../call-deadline.mjs';
import { trackTask, registerSsamTask, kernelTaskAnswer, listTasks } from '../ssam-task.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { createWorkerFirstRunner } from '../anvil-worker.mjs';
import { appendJsonLine, callerKey, currentTrace, withTraceArgs, sessionScope, operationIdOf, callScope } from '../correlation.mjs';
import { accessRestoreAfter, restoresDir } from '../o11-access.mjs';
import { findKernelTask } from '../o11-cycle.mjs';
import { isMutation } from '../tool-classification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..', '..', '..', '..');
const { createStore } = await import(pathToFileURL(path.join(workspace, 'facade', 'friction-store.mjs')).href);
const { observeMcp, readQueue, boundaryMetadata } = await import(pathToFileURL(path.join(workspace, 'facade', 'friction-boundary.mjs')).href);

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { root, friction: path.join(root, 'friction'), tasks: path.join(root, 'tasks'), work: path.join(root, 'work'), local: path.join(root, 'local') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return dirs;
}
const valueOf = answer => answer?.structuredContent ?? JSON.parse(answer.content[0].text);
// A kernel that records the trace as Anvil.Cli DeliverCmd does (DeliveryTraceTests prove the kernel itself).
function fakeKernel(work, seen = []) {
  return async args => {
    seen.push(args);
    const at = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
    const id = randomUUID().replace(/-/g, '');
    const trace = at('--correlation-id') ? { correlationId: at('--correlation-id'), operationId: at('--call-id') } : null;
    const state = { taskId: id, module: at('--module'), writeState: 'applied', stage: 'delivered', updatedAt: new Date().toISOString(),
      ...(trace ? { correlationId: trace.correlationId, trace, traces: [{ ...trace, run: 'create' }] } : {}) };
    fs.mkdirSync(path.join(work, 'deliver', id), { recursive: true });
    fs.writeFileSync(path.join(work, 'deliver', id, 'task.json'), JSON.stringify(state));
    return { ok: true, exitCode: 0, envelope: { ok: true, data: { taskId: id } } };
  };
}
// The served o11_deliver of these tests: a tracked task, the kernel through the real runner layer, its journal line and,
// for a temporary access job, the T12 restore entry.
function deliverTool(dirs, seen) {
  const runAnvil = createWorkerFirstRunner({ cold: fakeKernel(dirs.work, seen), env: { ...process.env, ANVIL_WORKER: '0' } });
  return async args => trackTask({ tool: 'o11_deliver', summary: { module: args.module }, dir: dirs.tasks }, async task => {
    const run = await runAnvil(['deliver', '--module', args.module, '--job', 'job.json', '--work', dirs.work, '--port', '4516']);
    const taskId = run.envelope.data.taskId;
    fs.mkdirSync(path.join(dirs.local, 'journal'), { recursive: true });
    appendJsonLine(path.join(dirs.local, 'journal', 'o11_deliver.jsonl'), { at: new Date().toISOString(), event: 'end', task: task.id, kernelTaskId: taskId });
    const apply = { accessChanges: [{ screen: 'Home', key: 'ScreenHome0001', property: 'Roles', from: [], to: ['@R'] }], accessRestore: { ops: [{ op: 'set', target: '@ScreenHome0001', prop: 'Roles', value: [], ifCurrent: ['@R'] }] } };
    const value = { ok: true, result: 'delivered', taskId, module: args.module };
    return accessRestoreAfter(value, { local: dirs.local, module: args.module, job: { temporary: { restore: true }, ops: [] }, kernelState: { taskId, environment: 'dev.example.test', apply } });
  });
}
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
// One session: the launcher's observer in front of a served child (its call deadline, its ssam_task and ssam_evidence).
function session(dirs, { correlationId = randomUUID(), caller = null, store = createStore({ directory: dirs.friction }) } = {}) {
  const env = { ...process.env, SSAM_RELAY_CHILD: '1', SSAM_CORRELATION_ID: correlationId };
  const deadline = createCallDeadline({ root: dirs.root, dir: dirs.tasks, env, caller: caller ? () => caller : null });
  const tools = {};
  registerSsamTask({ registerTool: (name, config, handler) => { tools[name] = handler; } }, { tasksDir: dirs.tasks, works: [dirs.work], destructiveRoot: dirs.root });
  const reader = createEvidenceReader({ roots: [dirs.root] });
  const seen = [];
  const served = {
    o11_deliver: deadline.wrap('o11_deliver', async args => reply(await deliverTool(dirs, seen)(args)), { annotations: { readOnlyHint: false, destructiveHint: false } }),
    ssam_task: deadline.wrap('ssam_task', tools.ssam_task, { annotations: { readOnlyHint: true } }),
    ssam_evidence: deadline.wrap('ssam_evidence', async args => reply(reader.read(args)), { annotations: { readOnlyHint: true } }),
  };
  const meta = { ...boundaryMetadata(dirs.root, 'ssam', ['mcp'], {}), sessionId: correlationId, ...(caller ? { callerKey: callerKey(caller) } : {}) };
  let nextId = 1; const forwarded = [];
  const observer = observeMcp({ root: dirs.root, entry: 'ssam', args: ['mcp'], store, meta, toServer: line => forwarded.push(JSON.parse(line)), toClient: () => {} });
  // A client call: through the observer (which records it and stamps the operation id), served, answered back through it.
  async function call(name, args = {}, clientMeta = undefined, id = nextId++) {
    const line = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(clientMeta ? { _meta: clientMeta } : {}) } }) + '\n';
    observer.request.write(line);
    const sent = forwarded.at(-1);
    assert.equal(JSON.stringify(sent) + '\n', line, 'the observer forwards the request bytes unchanged');
    // The SDK's request context of the served call: the request id (and, hosted, the transport's session).
    const answer = await served[name](args, { mcpReq: { id: sent.id, _meta: sent.params._meta } });
    observer.response.write(JSON.stringify({ jsonrpc: '2.0', id, result: answer }) + '\n');
    return { value: valueOf(answer), operationId: operationIdOf(correlationId, id) };
  }
  const friction = args => readQueue(store, args, { sessionId: correlationId, profile: 'operational', callerKey: caller ? callerKey(caller) : null });
  return { correlationId, call, friction, store, seen, forwarded, report: input => store.report(input, { sessionId: correlationId, callerKey: caller ? callerKey(caller) : null }) };
}

test('positive: one delivery is found by its operationId and by its kernel task id in every store', async t => {
  const dirs = sandbox(t);
  const s = session(dirs);
  const { value, operationId } = await s.call('o11_deliver', { module: 'LoanPortal_TW' });
  assert.equal(value.result, 'delivered');
  const kernelTaskId = value.taskId;
  assert.match(operationId, /^[0-9a-f-]{36}$/);
  // The kernel runner carried the trace to the kernel: the kernel task names the session and the call.
  assert.deepEqual(s.seen[0].slice(-4), ['--correlation-id', s.correlationId, '--call-id', operationId]);
  const kernelTask = findKernelTask(dirs.work, { taskId: kernelTaskId });
  assert.equal(kernelTask.correlationId, s.correlationId);
  assert.equal(kernelTask.trace.operationId, operationId);
  const kernelAnswer = await kernelTaskAnswer(kernelTaskId, { works: [dirs.work], findTask: findKernelTask, closeStateOf: () => 'delivered' });
  assert.equal(kernelAnswer.kernelTask.operationId, operationId);
  assert.equal(kernelAnswer.kernelTask.correlationId, s.correlationId);
  s.report({ kind: 'gap', tool: 'o11_deliver', intent: 'migrate a screen', attempted: 'one job' });
  for (const id of [operationId, kernelTaskId]) {
    // 1. the friction queue
    const ops = s.friction({ view: 'task', taskId: id });
    assert.equal(ops.operationCount, 1, 'friction by ' + id);
    assert.equal(ops.operations[0].operationId, operationId);
    assert.equal(ops.operations[0].correlationId, s.correlationId);
    assert.equal(ops.operations[0].kernelTaskId, kernelTaskId);
    // 2. the facade tasks
    const { value: task } = await s.call('ssam_task', { id });
    assert.equal(task.ok, true, 'ssam_task by ' + id + ': ' + JSON.stringify(task).slice(0, 200));
    assert.equal(task.task.operationId, operationId);
    assert.equal(task.task.correlationId, s.correlationId);
    assert.equal(task.task.result.taskId, kernelTaskId);
    // 3. the friction report links the delivery
    assert.equal(s.store.reports({ taskId: id }).total, 1, 'report by ' + id);
  }
  // 4. the kernel task by its own id is the same delivery (above); the journal and the access restore carry the same ids.
  const journal = path.join(dirs.local, 'journal', 'o11_deliver.jsonl');
  const { value: rows } = await s.call('ssam_evidence', { file: journal, where: 'operationId=' + operationId });
  assert.equal(rows.total ?? rows.items?.length, 1, JSON.stringify(rows).slice(0, 300));
  const restore = JSON.parse(fs.readFileSync(path.join(restoresDir(dirs.local), kernelTaskId + '.json'), 'utf8'));
  assert.equal(restore.correlationId, s.correlationId, 'T12: the restore journal carries the correlation id');
  assert.equal(restore.operationId, operationId);
  // The session's correlation id names its records too.
  const bySession = await s.call('ssam_task', { id: s.correlationId });
  assert.ok(bySession.value.tasks.some(t => t.operationId === operationId));
  assert.equal(s.friction({ view: 'task', taskId: s.correlationId }).operationCount >= 2, true);
});

test('negative: another session\'s records are never returned by default, only with an explicit session option', async t => {
  const dirs = sandbox(t);
  const store = createStore({ directory: dirs.friction });
  const a = session(dirs, { store }), b = session(dirs, { store });
  const fromA = await a.call('o11_deliver', { module: 'A' });
  const fromB = await b.call('o11_deliver', { module: 'B' });
  // ssam_task: the recent tasks of this session only, with the count of the others; "all" or B's id widens it.
  const own = (await a.call('ssam_task', {})).value;
  assert.equal(own.session, a.correlationId);
  assert.deepEqual(own.tasks.map(t => t.summary.module), ['A']);
  assert.equal(own.otherSessions, 1);
  assert.deepEqual((await a.call('ssam_task', { session: 'all' })).value.tasks.map(t => t.summary.module).sort(), ['A', 'B']);
  assert.deepEqual((await a.call('ssam_task', { session: b.correlationId })).value.tasks.map(t => t.summary.module), ['B']);
  // ssam_friction: failures of both sessions; the queue answers this session's by default.
  for (const op of [a.store.begin({ sessionId: a.correlationId, operation: 'job', lane: 'o11', interface: 'mcp' }), a.store.begin({ sessionId: b.correlationId, operation: 'job', lane: 'o11', interface: 'mcp' })])
    op.finish({ ok: false, code: 'VALIDATION_REFUSED' });
  const issues = a.friction({ view: 'issues' });
  assert.equal(issues.session, a.correlationId);
  assert.equal(issues.issues.reduce((n, i) => n + i.count, 0), 1);
  assert.equal(issues.otherSessions, 1);
  assert.equal(a.friction({ view: 'issues', session: 'all' }).issues.reduce((n, i) => n + i.count, 0), 2);
  // ssam_friction timeline: only this session's operations.
  const line = a.friction({ view: 'timeline' });
  assert.ok(line.operations.length >= 1 && line.operations.every(o => o.operationId !== fromB.operationId));
  // ssam_evidence of a journal both wrote: this session's rows by default.
  const journal = path.join(dirs.local, 'journal', 'o11_deliver.jsonl');
  const mine = (await a.call('ssam_evidence', { file: journal, max: 50 })).value;
  assert.equal(mine.total ?? mine.items.length, 1, JSON.stringify(mine).slice(0, 300));
  assert.equal(mine.otherSessions, 1);
  const every = (await a.call('ssam_evidence', { file: journal, max: 50, session: 'all' })).value;
  assert.equal(every.total ?? every.items.length, 2);
  // An explicit id of another session's task stays an explicit choice (the same tenant and user).
  assert.equal((await a.call('ssam_task', { id: fromB.operationId })).value.task.correlationId, b.correlationId);
  // A session option of another shape: refused, the element named, one next call (all three tools).
  for (const [name, refused] of [['ssam_task', (await a.call('ssam_task', { session: 'yesterday' })).value], ['ssam_evidence', (await a.call('ssam_evidence', { file: journal, session: 'yesterday' })).value],
    ['ssam_friction', a.friction({ view: 'issues', session: 'yesterday' })]]) {
    assert.equal(refused.ok, false, name); assert.equal(refused.code, 'SESSION_INVALID', name);
    assert.match(refused.error, /session takes .*"all".*correlationId.*"yesterday"/, name);
    assert.ok(refused.continuation?.tool, name);
  }
  assert.ok(fromA.operationId !== fromB.operationId);
});

test('negative: hosted, another caller\'s records are never returned, with any session option', async t => {
  const dirs = sandbox(t);
  const store = createStore({ directory: dirs.friction });
  const a = session(dirs, { store, caller: 'tenant-user-a' }), b = session(dirs, { store, caller: 'tenant-user-b' });
  await a.call('o11_deliver', { module: 'A' });
  const fromB = await b.call('o11_deliver', { module: 'B' });
  for (const option of [undefined, 'all', b.correlationId]) {
    const listed = (await a.call('ssam_task', option ? { session: option } : {})).value;
    assert.ok(listed.tasks.every(t => t.summary.module === 'A'), 'ssam_task session=' + option);
    // otherSessions counts only the caller's own records of other sessions (its own delivery when B's session is asked):
    // nothing says another caller has records.
    assert.equal(listed.otherSessions ?? 0, option === b.correlationId ? 1 : 0, 'session=' + option);
    assert.equal(a.friction({ view: 'task', taskId: fromB.operationId, ...(option ? { session: option } : {}) }).operationCount, 0, 'friction session=' + option);
    assert.ok(a.friction({ view: 'timeline', ...(option ? { session: option } : {}) }).operations.every(o => o.operationId !== fromB.operationId));
    const rows = (await a.call('ssam_evidence', { file: path.join(dirs.local, 'journal', 'o11_deliver.jsonl'), max: 50, ...(option ? { session: option } : {}) })).value;
    assert.ok(!JSON.stringify(rows).includes(callerKey('tenant-user-b')), 'evidence session=' + option);
    // Its own rows: this session and "all"; B's session id holds none of A's (and B's stay hidden).
    assert.equal(JSON.stringify(rows).includes(callerKey('tenant-user-a')), option !== b.correlationId, 'the caller reads its own rows, session=' + option + ': ' + JSON.stringify(rows).slice(0, 200));
  }
  assert.equal((await a.call('ssam_task', { id: fromB.operationId })).value.code, 'TASK_NOT_FOUND', 'an id of another caller is not found');
  const bTask = listTasks({ dir: dirs.tasks }).find(t => t.summary.module === 'B');
  assert.equal((await a.call('ssam_task', { id: bTask.id })).value.code, 'TASK_NOT_FOUND');
  const refused = (await a.call('ssam_evidence', { file: path.join(dirs.tasks, bTask.id + '.json') })).value;
  assert.equal(refused.code, 'EVIDENCE_NOT_FOUND');
  // The records carry the caller's key, never the caller id.
  assert.ok(!fs.readFileSync(path.join(dirs.tasks, bTask.id + '.json'), 'utf8').includes('tenant-user-b'));
  assert.equal(bTask.callerKey, callerKey('tenant-user-b'));
});

test('negative: both sides derive the same operation id from the session and the request id; a client meta never sets it; a reused request id gets a new friction id', async t => {
  const dirs = sandbox(t);
  const s = session(dirs);
  const chosen = randomUUID();
  const { operationId, value } = await s.call('o11_deliver', { module: 'M' }, { 'ssam/operationId': chosen, 'other/key': 1 });
  assert.notEqual(operationId, chosen);
  const ops = s.friction({ view: 'task', taskId: value.taskId });
  assert.equal(ops.operations[0].operationId, operationId, 'the friction record and the served call name the call alike');
  assert.equal((await s.call('ssam_task', { id: operationId })).value.task.operationId, operationId);
  assert.equal((await s.call('ssam_task', { id: chosen })).value.code, 'TASK_NOT_FOUND', 'the client meta named nothing');
  // Another session with the same request id is another operation.
  assert.notEqual(operationIdOf(randomUUID(), 1), operationIdOf(s.correlationId, 1));
  // A request id reused in the same session (a protocol error): the friction queue keeps both, under different ids.
  const first = s.store.begin({ interface: 'mcp', sessionId: s.correlationId, requestId: 'r-1', operation: 'map' });
  const second = s.store.begin({ interface: 'mcp', sessionId: s.correlationId, requestId: 'r-1', operation: 'map' });
  assert.equal(first.operationId, operationIdOf(s.correlationId, 'r-1'));
  assert.notEqual(second.operationId, first.operationId);
  // Outside a request (no id), a new id per call.
  const outside = createCallDeadline({ root: dirs.root, dir: dirs.tasks });
  let seen;
  await outside.wrap('ssam_doctor', async () => { seen = currentTrace(); return reply({ ok: true }); }, { annotations: { readOnlyHint: true } })({}, {});
  assert.match(seen.operationId, /^[0-9a-f-]{36}$/);
});

test('generated sweep: every served tool that records operations stamps the session and the call through the one call scope', async t => {
  const dirs = sandbox(t);
  const { createSsamServer } = await import('../ssam.mjs');
  const server = await createSsamServer({ profile: 'all', deps: { tasksDir: dirs.tasks } });
  t.after(() => server.close());
  // The tools that record operations: every write of the classification (a task, a journal, a receipt), from the live list.
  const writers = server.ssamTools.map(tool => tool.name).filter(name => isMutation(name, {}));
  assert.ok(writers.length >= 20, 'the sweep covers the write tools: ' + writers.length);
  const correlationId = randomUUID();
  const deadline = createCallDeadline({ root: dirs.root, dir: dirs.tasks, env: { ...process.env, SSAM_RELAY_CHILD: '1', SSAM_CORRELATION_ID: correlationId } });
  const journal = path.join(dirs.local, 'sweep.jsonl');
  const missing = [];
  let requestId = 0;
  for (const name of writers) {
    const id = ++requestId, operationId = operationIdOf(correlationId, id);
    let taskFile;
    await deadline.wrap(name, async () => trackTask({ tool: name, dir: dirs.tasks }, async task => {
      appendJsonLine(journal, { tool: name });
      taskFile = path.join(dirs.tasks, task.id + '.json');
      return reply({ ok: true });
    }), {})({}, { mcpReq: { id } });
    const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    const row = fs.readFileSync(journal, 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
    if (task.correlationId !== correlationId || task.operationId !== operationId || row.correlationId !== correlationId || row.operationId !== operationId || row.tool !== name) missing.push(name);
  }
  assert.deepEqual(missing, [], 'every write tool stamps both ids on its task and its journal line');
});

const SERVER_LOGS = ['http-server.mjs', 'agent-hub.mjs', 'quality-recorder.mjs'];
test('generated sweep: every JSON line the facade appends goes through the one traced writer', () => {
  const facade = path.resolve(here, '..');
  const offenders = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!['tests', 'node_modules'].includes(entry.name)) walk(path.join(dir, entry.name)); continue; }
      if (!entry.name.endsWith('.mjs') || entry.name === 'correlation.mjs') continue;
      // The server line's own logs are not records of a call: the hosted audit and event log (http-server.mjs), the owner's
      // access alerts (agent-hub.mjs) and the quality recorder's sanitized, size-fitted lines (quality-recorder.mjs).
      if (dir === facade && SERVER_LOGS.includes(entry.name)) continue;
      const text = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      if (/\bappendFileSync\s*\(/.test(text)) offenders.push(path.relative(facade, path.join(dir, entry.name)));
    }
  };
  walk(facade);
  assert.deepEqual(offenders, [], 'a record line written outside appendJsonLine carries no trace');
  // The kernel trace arguments go to deliver only: every other kernel verb keeps its exact argv.
  for (const verb of ['inspect', 'apply', 'check-job', 'access', 'data', 'publish-oml', 'references'])
    assert.deepEqual(withTraceArgs([verb, '--x', 'y'], { correlationId: randomUUID(), operationId: randomUUID() }), [verb, '--x', 'y']);
  const trace = { correlationId: randomUUID(), operationId: randomUUID() };
  const once = withTraceArgs(['deliver', '--resume', 'a'.repeat(32)], trace);
  assert.deepEqual(withTraceArgs(once, trace), once, 'added once');
});

test('timeline: each operation with start, end, tool time, queue wait and the gap since the previous one; the totals add up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-timeline-'));
  let clock = Date.parse('2026-10-22T23:00:00.000Z');
  const store = createStore({ directory: dir, clock: () => clock });
  const sessionId = randomUUID();
  const run = (ms, value, gap) => { clock += gap; const op = store.begin({ sessionId, operation: 'deliver', lane: 'o11', interface: 'mcp' }); clock += ms; op.finish(value); };
  run(1000, { ok: true }, 0);
  run(4000, { ok: true, queue: { position: 1, waitedMs: 2500 } }, 30000);
  run(500, { ok: false, code: 'VALIDATION_REFUSED' }, 12000);
  const line = readQueue(store, { view: 'timeline' }, { sessionId, profile: 'operational' });
  assert.equal(line.ok, true);
  assert.equal(line.totals.operations, 3);
  assert.deepEqual(line.operations.map(o => o.gapMs), [null, 30000, 12000]);
  assert.deepEqual(line.operations.map(o => o.waitMs), [0, 2500, 0]);
  assert.equal(line.totals.waitMs, 2500);
  assert.equal(line.totals.gapMs, 42000);
  assert.equal(line.totals.spanMs, 1000 + 30000 + 4000 + 12000 + 500);
  assert.equal(line.totals.toolCoveredMs, 5500);
  assert.ok(line.operations.every(o => o.startedAt && o.endedAt && Number.isFinite(o.toolMs)));
  assert.equal(line.operations[2].code, 'VALIDATION_REFUSED');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the session option is one rule: this session, "all", a correlation id; hosted keys never hold the caller id', () => {
  const trace = { correlationId: randomUUID(), callerKey: callerKey('someone@example.test') };
  assert.deepEqual(sessionScope(undefined, trace), { ok: true, mode: 'this', id: trace.correlationId, callerKey: trace.callerKey });
  assert.equal(sessionScope('all', trace).mode, 'all');
  const other = randomUUID().toUpperCase();
  assert.equal(sessionScope(other, trace).id, other.toLowerCase());
  assert.equal(sessionScope('x', trace).code, 'SESSION_INVALID');
  assert.ok(!trace.callerKey.includes('someone'));
  assert.equal(callerKey('someone@example.test'), trace.callerKey, 'stable');
  // Outside any call, the process session (a CLI child: the launcher's id).
  assert.equal(callScope.getStore(), undefined);
  assert.match(currentTrace().correlationId, /^[0-9a-f-]{36}$/);
});
