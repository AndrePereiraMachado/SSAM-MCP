import './fixtures/isolated-profile.mjs';
// Owner decision (2026-10-18): deliveries and creations have no time limit. A call of that family (tool-classification.mjs
// runsToEnd; ssam.mjs marks the live call with call-deadline.mjs markRunsToEnd) answers when its work ends, in the same call.
// Reads and the other writes keep the call deadline and continueTask, as before. Times are scaled: the deadline of a test
// (timeoutMs 100) stands for the 25 s of CALL_DEADLINE_MS, and a delivery of 720 ms for one of 3 minutes (7.2 deadlines).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCallDeadline, markRunsToEnd } from '../call-deadline.mjs';
import { readTask, tasksDir } from '../ssam-task.mjs';
import { runsToEnd, isStudioWrite, isMutation } from '../tool-classification.mjs';
import { CREATING, ENVIRONMENT_WRITES } from '../o11-environment.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const value = result => result?.structuredContent ?? JSON.parse(result.content[0].text);
const DEADLINE = 100, THREE_MINUTES = 720;
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-to-end-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// A delivery of the family: its handler marks the live call, as ssam.mjs does for every served call of the family.
function delivery(ms, { mark = true } = {}) {
  const state = { runs: 0, aborted: false, finished: false };
  const handler = async (_, ctx) => {
    if (mark) markRunsToEnd();
    state.runs++;
    ctx?.mcpReq?.signal?.addEventListener('abort', () => { state.aborted = true; }, { once: true });
    await sleep(ms);
    state.finished = true;
    return reply({ ok: true, result: 'delivered', runs: state.runs });
  };
  return { state, handler };
}
const open = () => { const controller = new AbortController(); return { controller, ctx: { mcpReq: { signal: controller.signal } } }; };

test('the family: every write whose operation delivers, publishes, deploys, generates a package or creates, and nothing else', () => {
  const inside = [
    // effect named by the tool or the operation it selects
    ['o11_deliver', { module: 'Orders', job: 'C:/synthetic/job.json' }], ['o11_deliver', { resume: 'a'.repeat(32) }],
    ['o11_publish', { module: 'Orders' }], ['o11_publish', { module: 'Orders', consumers: true }],
    ['studio_deliver', { module: 'Orders' }], ['studio_deliver', { module: 'Orders', until: 'merge' }], ['studio_deliver', { module: 'Orders', until: 'publish' }],
    ['studio_merge', {}], ['studio_publish', {}], ['studio_create', {}], ['studio_refresh_references', {}],
    ['studio_create_app', { kind: 'Reactive', name: 'Synthetic' }], ['studio_create_app', { action: 'create', kind: 'Library', name: 'Synthetic' }],
    ...CREATING.map(action => ['o11_environment', { action }]), ['o11_environment', { action: 'refresh-refs' }],
    ['o11_studio', { command: 'refresh-references' }],
    ['o11_extension', { action: 'publish' }],
    ['odc_external_library', { action: 'deploy' }],
    ['o11_service_center_write', { action: 'solution-publish', execute: true }], ['o11_service_center_write', { action: 'extension-publish', execute: true }],
    ['o11_service_center_write', { action: 'solution-create', execute: true }],
    // effect declared by the code that runs the operation (Integradora, 2026-10-18, A3 and B7)
    ['continue', {}], // the O11 app session resumes the accepted delivery (kernel deliver --resume)
    ['o11_access', { action: 'apply' }], // one ordinary deliver per owner module (o11-access.mjs)
    ['o11_environment', { action: 'set-user-provider' }], // changes the module and publishes it (o11-environment.mjs)
    ['o11_service_center_write', { action: 'apply-settings', execute: true }], // the Service Center redeploys the application
    ['ssam_debug_run', { op: 'run' }], // publishes the debug wrapper it runs through
    // the tenant: a job that changes its assets (effects.mjs effect "mutation-job"), whichever tool sends it
    ['odc_deploy', { assetKey: 'a', environmentKey: 'e' }], ['odc_deploy', { operation: 'Deploy' }], ['odc_deploy', { operation: 'ApplyConfigs' }],
    ['odc_write', { operationId: 'deployments-api-v1:post:/deployment-operations', body: { operation: 'Deploy' } }],
    ['odc_write', { operationId: 'deployments-api-v1:post:/publish-operations' }],
    ['odc_write', { operationId: 'build-operations-api-v1:post:/build-operations' }],
    ['odc_write', { operationId: 'native-application-orchestration-service-api-v1:post:/build-operations' }],
    ['odc_write', { operationId: 'external-library-generation-api-v1:post:/generation-operations' }],
    ['odc_write', { operationId: 'user-access-management-api-v1:post:/users/bulk' }],
  ];
  const outside = [
    // reads, among them the read operations of the family's own tools
    ['studio_deliver', { until: 'snapshot' }], ['studio_deliver', { until: 'build' }], ['studio_deliver', { until: 'check-base' }], ['studio_deliver', { until: 'preview' }],
    ['studio_create_app', { action: 'templates' }], ['o11_environment', { action: 'inventory' }], ['o11_environment', { action: 'templates' }],
    ['o11_studio', { command: 'status' }], ['o11_studio', { command: 'publish-log' }], ['o11_service_center_write', { action: 'solution-publish', execute: false }],
    ['o11_extension', { action: 'read' }], ['odc_external_library', { action: 'build' }], ['odc_external_library', { action: 'status' }],
    ['o11_access', { action: 'plan' }], ['o11_access', { action: 'verify' }], ['ssam_debug_run', { op: 'status' }],
    ['ssam_map', { target: 'Orders' }], ['ssam_discover', { intent: 'publish' }], ['studio_status', {}], ['o11_inspect', { module: 'Orders' }], ['ssam_task', { id: 'a'.repeat(32) }],
    // the other writes: open/close, dialogs, sign-in, waits, data rows, grants, settings, closing a task
    ['o11_studio', { command: 'open-module', args: { module: 'Orders' } }], ['o11_studio', { command: 'dismiss-dialog' }], ['o11_studio', { command: 'login' }],
    ['o11_studio', { command: 'wait', args: { condition: 'idle' } }], ['o11_environment', { action: 'update-app' }],
    ['studio_open', {}], ['studio_close', {}], ['studio_dismiss_dialog', {}], ['studio_data_insert', {}], ['studio_data_update', {}],
    ['o11_data', { request: { operation: 'insert' } }], ['ssam_task', { id: 'a'.repeat(32), close: { reason: 'synthetic' } }],
    ['o11_service_center_write', { action: 'timer-run', execute: true }], ['o11_service_center_session', { action: 'sign-in' }],
    ['ssam_debug_run', { op: 'prepare' }],
    // destructive executions keep their deadline and their record (CX15), and their previews are reads
    ['o11_environment', { action: 'delete-app', confirmationToken: 'synthetic.token' }], ['o11_environment', { action: 'delete-app' }],
    ['o11_extension', { action: 'delete', confirmationToken: 'synthetic.token' }], ['odc_external_library', { action: 'discard' }],
    ['o11_service_center_write', { action: 'module-delete', confirmationToken: 'synthetic.token' }],
    // a tool that delivers through another tool's handler is not in the family by itself: the nested delivery marks it
    ['ssam_code', { action: 'write', lane: 'o11' }],
    // an undeployment is destructive (CX15): its preview is a read and its execution keeps its deadline and record
    ['odc_deploy', { operation: 'Undeploy' }], ['odc_deploy', { operation: 'Undeploy', confirmationToken: 'synthetic.token' }],
    ['odc_write', { operationId: 'deployments-api-v1:post:/deployment-operations', body: { operation: 'Undeploy' } }],
    // the other Portal writes, the jobs that change no asset (an analysis) and the reads that follow a deployment
    ['odc_write', { operationId: 'user-access-management-api-v1:post:/users' }], ['odc_write', { operationId: 'code-quality-api-v1:post:/code-analyses' }],
    ['odc_portal_write', { operationId: 'timers.run' }], ['odc_configurations', { action: 'set' }], ['odc_operation_status', { kind: 'deployment', waitSeconds: 300 }],
    // a passthrough bridge line names no operation of the family (studio_publish, studio_merge... do)
    ['studio_command', { command: 'publish-status' }], ['studio_command', { command: 'merge --candidate C:/synthetic/candidate.oml' }],
  ];
  const wrong = [...inside.filter(([name, args]) => runsToEnd(name, args) !== true).map(c => 'inside: ' + JSON.stringify(c)),
    ...outside.filter(([name, args]) => runsToEnd(name, args) !== false).map(c => 'outside: ' + JSON.stringify(c))];
  assert.deepEqual(wrong, []);
  // the family is a part of the write classification (CX12), never wider
  for (const [name, args] of inside) assert.equal(isMutation(name, args), true, name);
  // the O11 environment: its creating actions (o11-environment.mjs CREATING), the reference refresh and the user provider
  const token = action => (action === 'delete-app' ? { confirmationToken: 'synthetic.token' } : {});
  assert.deepEqual(ENVIRONMENT_WRITES.filter(action => runsToEnd('o11_environment', { action, ...token(action) })).sort(), [...CREATING, 'refresh-refs', 'set-user-provider'].sort());
  // unknown input never throws
  assert.equal(runsToEnd('o11_deliver', null), true); assert.equal(runsToEnd('unknown_tool', undefined), false);
});

test('a 3-minute delivery answers its final result in the original call; past the deadline its task is evidence for ssam_task', async t => {
  const root = sandbox(t);
  const deadline = createCallDeadline({ root, timeoutMs: DEADLINE });
  const { state, handler } = delivery(THREE_MINUTES);
  const run = deadline.wrap('o11_deliver', handler);
  const started = performance.now();
  const pending = run({ module: 'Orders', job: 'C:/synthetic/job.json' }, open().ctx);
  await sleep(DEADLINE * 3);
  // past the deadline the call is kept, not answered: its task is on disk as running and listed as a running task
  const [kept] = deadline.runningTasks();
  assert.ok(kept, 'the kept call is a running task of this deadline');
  assert.equal(readTask(kept.id, { dir: tasksDir(root) })?.state, 'running');
  assert.equal(readTask(kept.id, { dir: tasksDir(root) })?.orphaned, undefined);
  const final = await pending;
  assert.ok(performance.now() - started >= THREE_MINUTES - 5, 'the call waited for the work');
  assert.deepEqual(value(final), { ok: true, result: 'delivered', runs: 1 });
  assert.equal(value(final).state, undefined);
  assert.equal(state.runs, 1);
  const record = readTask(kept.id, { dir: tasksDir(root) });
  assert.equal(record.state, 'ok'); assert.equal(record.deliveries, 1);
  assert.deepEqual(deadline.runningTasks(), []); assert.equal(deadline.runningCount(), 0);
});

test('an identical call while a delivery runs joins it, before and after the deadline, and never runs it again', async t => {
  const deadline = createCallDeadline({ root: sandbox(t), timeoutMs: DEADLINE });
  const { state, handler } = delivery(THREE_MINUTES);
  const run = deadline.wrap('studio_deliver', handler);
  const args = { module: 'Orders', job: { ops: [] } };
  const original = run(args, open().ctx);
  await sleep(DEADLINE / 2);
  const early = run(args, open().ctx);
  await sleep(DEADLINE * 2);
  const late = run(args, open().ctx);
  const [first, second, third] = await Promise.all([original, early, late]);
  assert.equal(state.runs, 1);
  assert.deepEqual(value(first), { ok: true, result: 'delivered', runs: 1 });
  // a repeat that joins a run-to-end call names its task (A5: ssam_task {id, stop:true} stops it)
  for (const joined of [second, third]) assert.deepEqual(value(joined), { ok: true, result: 'delivered', runs: 1, joined: true, joinedTask: value(joined).joinedTask });
  assert.match(String(value(second).joinedTask), /^[0-9a-f-]{36}$/); assert.equal(value(third).joinedTask, value(second).joinedTask);
});

test('the client gives up after the deadline: the work goes on in the server and the identical repeat gets the result of the same task', async t => {
  const root = sandbox(t);
  const deadline = createCallDeadline({ root, timeoutMs: DEADLINE });
  const { state, handler } = delivery(THREE_MINUTES);
  const run = deadline.wrap('o11_deliver', handler);
  const args = { module: 'Orders', job: 'C:/synthetic/job.json' };
  const { controller, ctx } = open();
  const original = run(args, ctx).then(result => ({ result }), error => ({ error }));
  await sleep(DEADLINE * 3);
  controller.abort('client request timeout'); // what an MCP client sends at its own timeout (notifications/cancelled)
  assert.equal((await original).error?.code, 'CANCELLED');
  assert.equal(state.aborted, false, 'the cancellation of a kept call never reaches the work');
  const [kept] = deadline.runningTasks();
  assert.equal(readTask(kept.id, { dir: tasksDir(root) }).state, 'running');
  const during = await run(args, open().ctx);
  assert.equal(state.finished, true);
  assert.deepEqual(value(during), { ok: true, result: 'delivered', runs: 1, joined: true, joinedTask: kept.id });
  assert.equal(state.runs, 1);
  assert.equal(state.aborted, false);
  // once its final answer reached a caller, the task's record says so (CX12: a later identical call is a new operation)
  assert.equal(readTask(kept.id, { dir: tasksDir(root) }).state, 'ok');
  assert.equal(readTask(kept.id, { dir: tasksDir(root) }).deliveries, 1);
});

test('a repeat after the client gave up and the work ended gets the same final answer', async t => {
  const deadline = createCallDeadline({ root: sandbox(t), timeoutMs: DEADLINE });
  const { state, handler } = delivery(DEADLINE * 3);
  const run = deadline.wrap('studio_create_app', handler);
  const args = { kind: 'Reactive', name: 'Synthetic' };
  const { controller, ctx } = open();
  const original = run(args, ctx).catch(error => error);
  await sleep(DEADLINE * 2);
  controller.abort('client request timeout');
  assert.equal((await original).code, 'CANCELLED');
  await sleep(DEADLINE * 2);
  assert.equal(state.finished, true);
  assert.deepEqual(value(await run(args, open().ctx)), { ok: true, result: 'delivered', runs: 1 });
  assert.equal(state.runs, 1);
});

test('a cancellation before the deadline still reaches the handler of a delivery (unchanged)', async t => {
  const deadline = createCallDeadline({ root: sandbox(t), timeoutMs: DEADLINE });
  const { state, handler } = delivery(DEADLINE * 3);
  const run = deadline.wrap('o11_deliver', handler);
  const { controller, ctx } = open();
  const pending = run({ module: 'Orders' }, ctx).catch(error => error);
  await sleep(DEADLINE / 4);
  controller.abort('user escape');
  assert.equal((await pending).code, 'CANCELLED');
  assert.equal(state.aborted, true);
});

test('continueTask and ssam_task keep working for a delivery task in progress (compatibility)', async t => {
  const root = sandbox(t);
  const deadline = createCallDeadline({ root, timeoutMs: DEADLINE });
  const { state, handler } = delivery(DEADLINE * 5);
  const run = deadline.wrap('o11_publish', handler);
  const original = run({ module: 'Orders' }, open().ctx);
  await sleep(DEADLINE * 2);
  const [kept] = deadline.runningTasks();
  assert.deepEqual(kept.continuation.arguments, { continueTask: kept.id });
  // a continuation of the task waits up to the deadline and answers running while the work goes on
  const waiting = value(await run(kept.continuation.arguments, open().ctx));
  assert.equal(waiting.state, 'running'); assert.equal(waiting.task.id, kept.id);
  assert.equal(readTask(kept.id, { dir: tasksDir(root) }).state, 'running');
  // and the final answer once it ends, the same one the original call gets
  let final = await run(kept.continuation.arguments, open().ctx);
  while (value(final).state === 'running') final = await run(kept.continuation.arguments, open().ctx);
  assert.deepEqual(value(final), { ok: true, result: 'delivered', runs: 1 });
  assert.deepEqual(value(await original), { ok: true, result: 'delivered', runs: 1 });
  assert.equal(state.runs, 1);
});

test('a read and any call without the mark keep the deadline and continueTask (unchanged)', async t => {
  const deadline = createCallDeadline({ root: sandbox(t), timeoutMs: DEADLINE });
  for (const tool of ['studio_status', 'o11_publish']) {
    const { state, handler } = delivery(DEADLINE * 3, { mark: false });
    const run = deadline.wrap(tool, handler);
    const first = value(await run({ module: 'Orders' }, open().ctx));
    assert.equal(first.state, 'running', tool);
    assert.equal(first.continuation.tool, tool);
    let final = await run(first.continuation.arguments, open().ctx);
    while (value(final).state === 'running') final = await run(first.continuation.arguments, open().ctx);
    assert.equal(value(final).ok, true); assert.equal(state.runs, 1);
  }
});

test('a delivery nested in another call marks the call it runs inside (ssam_code write through the lane delivery tool)', async t => {
  const deadline = createCallDeadline({ root: sandbox(t), timeoutMs: DEADLINE });
  const inner = delivery(DEADLINE * 4);
  const run = deadline.wrap('ssam_code', async (args, ctx) => {
    await sleep(DEADLINE / 4); // the compilation of the text forms before the delivery
    return inner.handler(args, ctx);
  });
  const final = value(await run({ action: 'write', lane: 'o11', module: 'Orders' }, open().ctx));
  assert.deepEqual(final, { ok: true, result: 'delivered', runs: 1 });
});

test('the progress of a kept delivery keeps reaching the original request while it waits', async t => {
  const deadline = createCallDeadline({ root: sandbox(t), timeoutMs: DEADLINE });
  const seen = [];
  const run = deadline.wrap('studio_deliver', async (_, ctx) => {
    markRunsToEnd();
    for (let i = 1; i <= 5; i++) { await sleep(DEADLINE / 2); await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progress: i } }); }
    return reply({ ok: true, result: 'delivered' });
  });
  const ctx = { mcpReq: { signal: new AbortController().signal, notify: n => { seen.push(n.params.progress); return Promise.resolve(); } } };
  assert.deepEqual(value(await run({ module: 'Orders' }, ctx)), { ok: true, result: 'delivered' });
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});
