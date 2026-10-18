// CT-2 (review C:\t\revisoes\vps-a6-continuetask, fase4-26 75c8940c): the identical-call guard is the process's, per task
// folder. Two deadlines on one folder (two MCP sessions of one customer hosted; the bootstrap deadline and the server's own
// locally) join the same live call and replay the same undelivered final under the same 10-minute rule, with or without a
// tracked handler (trackTask, as the O11 deliveries do). Deadlines on two folders (two customers) never see each other's
// calls. Synthetic values only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCallDeadline } from '../call-deadline.mjs';
import { readTask, tasksDir, trackTask } from '../ssam-task.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = v => ({ content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v, ...(v.ok === false ? { isError: true } : {}) });
const value = a => a?.structuredContent;
const box = (t, tag) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-ct2-' + tag + '-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = check(); if (v) return v; await sleep(20); } return check(); };
// A write that takes ms and counts how many times its body runs; tracked, it records its task as o11_deliver does.
function slowWrite(root, { tracked = false } = {}) {
  const state = { runs: 0 };
  const body = async ms => { state.runs++; await sleep(ms); return { ok: true, run: state.runs }; };
  state.handler = async ({ ms = 300 } = {}) => reply(tracked ? await trackTask({ tool: 'o11_publish', dir: tasksDir(root), summary: { module: 'SyntheticCT2' } }, () => body(ms)) : await body(ms));
  return state;
}

for (const tracked of [false, true]) {
  const variant = tracked ? ' (tracked handler)' : '';
  test('CT-2 the identical write on another deadline of the same folder joins the live call: one execution' + variant, async t => {
    const root = box(t, 'join');
    const work = slowWrite(root, { tracked });
    const one = createCallDeadline({ root, timeoutMs: 3000 }).wrap('o11_publish', work.handler);
    const two = createCallDeadline({ root, timeoutMs: 3000 }).wrap('o11_publish', work.handler);
    const args = { module: 'SyntheticCT2', ms: 600 };
    const first = one(args);
    await sleep(150);
    const second = value(await two(args));
    assert.equal(work.runs, 1, 'the second session never runs the same write again: ' + JSON.stringify(second).slice(0, 300));
    assert.equal(second.joined, true); assert.equal(second.ok, true);
    assert.equal(value(await first).ok, true);
  });

  test('CT-2 the identical write after a detached final not yet delivered replays it on another deadline of the same folder: one execution' + variant, async t => {
    const root = box(t, 'replay');
    const work = slowWrite(root, { tracked });
    const one = createCallDeadline({ root, timeoutMs: 50 }).wrap('o11_publish', work.handler);
    const two = createCallDeadline({ root, timeoutMs: 2000 }).wrap('o11_publish', work.handler);
    const args = { module: 'SyntheticCT2', ms: 250 };
    const first = value(await one(args));
    assert.equal(first.state, 'running');
    const done = await until(() => { const r = readTask(first.task.id, { dir: tasksDir(root) }); return r?.state === 'ok' ? r : null; });
    assert.equal(done?.deliveries, 0, 'the final is saved and not delivered yet');
    const replayed = value(await two(args));
    assert.equal(work.runs, 1, 'the second session never runs the same write again: ' + JSON.stringify(replayed).slice(0, 300));
    assert.equal(replayed.resumedFrom, first.task.id); assert.equal(replayed.ok, true);
    // The original continuation still answers the same final, and the next identical call (delivered) is a new operation.
    assert.equal(value(await one({ continueTask: first.task.id })).ok, true);
    assert.equal(value(await two(args)).ok, true); assert.equal(work.runs, 2);
  });
}

test('CT-2 two folders (two customers) never join or replay each other\'s call', async t => {
  const rootA = box(t, 'a'), rootB = box(t, 'b');
  const work = slowWrite(rootA);
  const a = createCallDeadline({ root: rootA, timeoutMs: 3000 }).wrap('o11_publish', work.handler);
  const b = createCallDeadline({ root: rootB, timeoutMs: 3000 }).wrap('o11_publish', work.handler);
  const args = { module: 'SyntheticCT2', ms: 400 };
  const first = a(args);
  await sleep(100);
  const other = value(await b(args));
  assert.equal(other.joined, undefined); assert.equal(other.resumedFrom, undefined);
  assert.equal(work.runs, 2, 'each folder runs its own call');
  await first;
  // A detached final of A is never replayed to B.
  const detachedA = createCallDeadline({ root: rootA, timeoutMs: 50 }).wrap('o11_publish', work.handler);
  const started = value(await detachedA({ module: 'SyntheticCT2', ms: 150 }));
  await until(() => readTask(started.task.id, { dir: tasksDir(rootA) })?.state === 'ok');
  const fromB = value(await b({ module: 'SyntheticCT2', ms: 150 }));
  assert.equal(fromB.resumedFrom, undefined); assert.equal(work.runs, 4);
  assert.equal(readTask(started.task.id, { dir: tasksDir(rootB) }), null, 'B never sees the record of A');
});

test('CT-2 a nested identical call through another deadline of the same folder never waits for itself', async t => {
  const root = box(t, 'nested');
  let inner = 0;
  const two = createCallDeadline({ root, timeoutMs: 2000 }).wrap('o11_publish', async () => { inner++; return reply({ ok: true, inner: true }); });
  const one = createCallDeadline({ root, timeoutMs: 2000 }).wrap('o11_publish', async args => reply({ ok: true, outer: true, nested: value(await two(args)) }));
  const args = { module: 'SyntheticCT2Nested' };
  const answer = await Promise.race([one(args), sleep(1500).then(() => 'timed out')]);
  assert.notEqual(answer, 'timed out', 'the nested call joined its own outer call');
  assert.equal(value(answer).nested.inner, true); assert.equal(inner, 1);
});

test('CT-2 the detached count and the running list stay with the deadline that started the call', async t => {
  const root = box(t, 'owner');
  const work = slowWrite(root);
  const firstDeadline = createCallDeadline({ root, timeoutMs: 50 });
  const secondDeadline = createCallDeadline({ root, timeoutMs: 50 });
  const one = firstDeadline.wrap('o11_publish', work.handler), two = secondDeadline.wrap('o11_publish', work.handler);
  const args = { module: 'SyntheticCT2', ms: 400 };
  const first = value(await one(args));
  const joined = value(await two(args));
  assert.equal(joined.state, 'running'); assert.equal(joined.joined, true); assert.equal(joined.task.id, first.task.id);
  assert.deepEqual([firstDeadline.runningCount(), secondDeadline.runningCount()], [1, 0]);
  assert.deepEqual(firstDeadline.runningTasks().map(task => task.id), [first.task.id]);
  assert.deepEqual(secondDeadline.runningTasks(), []);
  await until(() => readTask(first.task.id, { dir: tasksDir(root) })?.state === 'ok');
  await sleep(20);
  assert.deepEqual([firstDeadline.runningCount(), secondDeadline.runningCount()], [0, 0]);
  assert.equal(work.runs, 1);
});
