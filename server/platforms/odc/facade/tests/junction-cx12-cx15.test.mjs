// Junction CX12 (long calls) x CX15 (destructive operations): the M6 adjustments 5, 6 and 8 proven on the CX12 deadline.
// Times are scaled: the deadline of the test (timeoutMs 100) stands for the 25 s of CALL_DEADLINE_MS and the cancellation at
// 150 ms for the one at 30 s. The engine is synthetic: it reads its handler signal before each send, as the CX15 engines do
// (withSignal/currentSignal, service-center delete, data-delete-gate, destructive-preview).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCallDeadline } from '../call-deadline.mjs';
import { registerSsamTask, tasksDir } from '../ssam-task.mjs';
import { classifyTool, isStudioWrite } from '../tool-classification.mjs';
import { cancelledAnswer } from '../mcp.mjs';
import { relayFailure } from '../ssam.mjs';

const reply = v => ({ content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v, ...(v.ok === false ? { isError: true } : {}) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PREVIEW = '00000000-0000-4000-8000-0000000000c5';
const TOKEN = PREVIEW + '.00000000000000c5'; // the token form parseToken reads (previewId.16 hex), synthetic
const EXECUTION = { action: 'delete', host: 'personal-0000test.outsystemscloud.com', applications: ['ZZSynthA', 'ZZSynthB', 'ZZSynthC', 'ZZSynthD', 'ZZSynthE', 'ZZSynthF', 'ZZSynthG', 'ZZSynthH'], confirmationToken: TOKEN };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-cx15-junction-'));
  const destructiveRoot = path.join(root, 'destructive');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deadline = createCallDeadline({ root, timeoutMs: 100 });
  let task;
  registerSsamTask({ registerTool: (_, __, fn) => { task = fn; } }, { root, destructiveRoot });
  return { root, deadline, ssamTask: args => task(args, {}) };
}
// A synthetic destructive engine: one send per item, the signal read before each send.
function engine(sends, { pace = 30 } = {}) {
  return async (args, ctx) => {
    const signal = ctx?.mcpReq?.signal;
    for (const name of args.applications) {
      if (signal?.aborted) return reply({ ok: false, code: 'CANCELLED', outcome: sends.length ? 'partial' : 'not-sent', sent: sends.length });
      sends.push({ name, at: Date.now() });
      await sleep(pace);
    }
    return reply({ ok: true, deleted: sends.length });
  };
}

test('M6-5: a destructive execution cancelled after the deadline (scaled 30 s) sends nothing after ssam_task {id:<previewId>, stop:true}', async t => {
  const { deadline, ssamTask } = setup(t);
  assert.equal(classifyTool('o11_service_center_write', EXECUTION).isWrite, true);
  assert.equal(isStudioWrite('o11_service_center_write', EXECUTION), true, 'the execution queues');
  const sends = [];
  const run = deadline.wrap('o11_service_center_write', engine(sends));
  const first = await run(structuredClone(EXECUTION), { mcpReq: { signal: new AbortController().signal } });
  const running = first.structuredContent;
  assert.equal(running.state, 'running', 'detached at the (scaled) 25 s deadline');
  // M6-6: the running answer names the record of the operation.
  assert.deepEqual(running.destructiveRecord?.arguments, { id: PREVIEW });
  // At the (scaled) 30 s the client cancels its continuation wait: the work keeps running (CX12: cancelling the wait never
  // stops the work); the CX15 cancelled answer names the stop route instead of promising it.
  await sleep(50);
  const c = new AbortController();
  const waiting = run({ continueTask: running.task.id }, { mcpReq: { signal: c.signal } });
  await sleep(10); c.abort();
  await assert.rejects(waiting, e => e.code === 'CANCELLED');
  const named = cancelledAnswer(EXECUTION);
  assert.match(named.error, /stop:true/); assert.deepEqual(named.stop.arguments, { id: PREVIEW, stop: true });
  const relayed = relayFailure(new Error('x'), { tool: 'o11_service_center_write', args: EXECUTION, signal: { aborted: true } });
  assert.match(relayed.error, /stop:true/); assert.deepEqual(relayed.stop.arguments, { id: PREVIEW, stop: true });
  const before = sends.length;
  assert.ok(before > 0 && before < EXECUTION.applications.length, 'still sending when the stop arrives (' + before + ')');
  const stopped = (await ssamTask({ id: PREVIEW, stop: true })).structuredContent;
  assert.equal(stopped.ok, true, JSON.stringify(stopped)); assert.equal(stopped.state, 'stop-requested');
  assert.equal(stopped.task.id, running.task.id);
  const stopAt = Date.now();
  await sleep(150);
  assert.equal(sends.filter(s => s.at > stopAt).length, 0, '0 sends after the stop');
  const final = (await run({ continueTask: running.task.id })).structuredContent;
  assert.equal(final.code, 'CANCELLED'); assert.equal(final.sent, sends.length);
  // A previewId with nothing running and no record: the stop says so, never a silent ok.
  const none = (await ssamTask({ id: PREVIEW, stop: true })).structuredContent;
  assert.equal(none.ok, false);
});

test('M6-8: a finished uncertain destructive execution never answers TASK_UNCERTAIN_PENDING: the repeat reaches the gate, whose record decides', async t => {
  const { deadline } = setup(t);
  let calls = 0;
  const run = deadline.wrap('o11_service_center_write', async () => {
    calls++;
    return calls === 1 ? reply({ ok: false, outcome: 'uncertain', code: 'SC_OUTCOME_UNKNOWN' })
      : reply({ ok: false, code: 'CONFIRMATION_ALREADY_USED', outcome: 'not-sent' });
  });
  const lost = (await run(structuredClone(EXECUTION))).structuredContent;
  assert.equal(lost.outcome, 'uncertain');
  const again = (await run(structuredClone(EXECUTION))).structuredContent;
  assert.equal(again.code, 'CONFIRMATION_ALREADY_USED', 'the CX15 record answers the repeat');
  assert.equal(calls, 2);
  // A plain (non-destructive) write keeps the CX12 guard.
  let writes = 0;
  const publish = deadline.wrap('o11_publish', async () => { writes++; return reply({ ok: false, outcome: 'uncertain' }); });
  await publish({ module: 'ZZSynth' });
  const guarded = (await publish({ module: 'ZZSynth' })).structuredContent;
  assert.equal(guarded.code, 'TASK_UNCERTAIN_PENDING'); assert.equal(writes, 1);
});

test('M6-8: a CX12 close never stops nor releases a live destructive execution', async t => {
  const { deadline, ssamTask } = setup(t);
  const sends = [];
  const run = deadline.wrap('o11_service_center_write', engine(sends, { pace: 20 }));
  const first = (await run(structuredClone(EXECUTION))).structuredContent;
  assert.equal(first.state, 'running');
  const byTask = (await ssamTask({ id: first.task.id, close: { reason: 'synthetic' } })).structuredContent;
  assert.equal(byTask.code, 'CLOSE_TASK_RUNNING');
  const byOperation = (await ssamTask({ id: PREVIEW, close: { reason: 'synthetic' } })).structuredContent;
  assert.equal(byOperation.ok, false);
  const final = (await run({ continueTask: first.task.id })).structuredContent;
  for (let i = 0; i < 20 && final.state === 'running'; i++) await sleep(50);
  await sleep(200);
  assert.equal(sends.length, EXECUTION.applications.length, 'the close stopped nothing');
});

test('M6-1/2: previews and refused passthrough lines are reads outside the Studio queue; executions are writes in it', () => {
  const preview = { action: 'delete', host: 'h', applications: ['ZZSynthA'] };
  assert.equal(classifyTool('o11_service_center_write', preview).isWrite, false);
  assert.equal(isStudioWrite('o11_service_center_write', preview), false);
  assert.equal(isStudioWrite('o11_service_center_write', { ...preview, confirmationToken: '  ' }), false);
  assert.equal(classifyTool('studio_command', { command: 'data-delete', args: ['M', 'E', '1'] }).isWrite, false);
  assert.equal(isStudioWrite('studio_command', { command: 'data-delete', args: ['M', 'E', '1'] }), false);
  assert.equal(isStudioWrite('studio_command', { command: 'module-info' }), true, 'a plain passthrough stays a write');
  assert.equal(classifyTool('odc_portal_write', { operationId: 'no-such-operation' }).isWrite, true, 'unknown Portal write: a mutation');
  assert.equal(isStudioWrite('o11_service_center_write', { action: 'verify', confirmationToken: TOKEN }), false, 'a token on verify changes nothing');
  assert.equal(tasksDir(os.tmpdir()).length > 0, true);
});
