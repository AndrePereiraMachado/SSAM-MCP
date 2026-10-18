// Atritos 3, lane fa, C37: the continuation of a module reservation points to an id ssam_task knows. A reservation held by
// a kernel delivery that is still running sends the doctor to ssam_task {id: <kernel taskId>}; the facade records that id
// only at the end of the delivery (and a delivery run by the CLI has no record), so ssam_task answered TASK_NOT_FOUND
// (replay of 2026-10-06). Now a 32-hex id without a facade record is read from the kernel's own task folder. Sandbox only.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerSsamTask } from '../ssam-task.mjs';
import { classifyReservation } from '../ssam.mjs';

function sandbox() {
  const box = fs.mkdtempSync(path.join(isolatedProfile, 'pa3-task-'));
  const root = path.join(box, 'kernel'), work = path.join(root, '.local', 'work'), authority = path.join(box, 'authority'), tasks = path.join(root, '.local', 'tasks');
  for (const dir of [work, path.join(authority, 'reservations'), tasks]) fs.mkdirSync(dir, { recursive: true });
  const kernelTask = (id, state) => { fs.mkdirSync(path.join(work, 'deliver', id), { recursive: true }); fs.writeFileSync(path.join(work, 'deliver', id, 'task.json'), JSON.stringify(state)); };
  let handler;
  registerSsamTask({ registerTool: (name, config, fn) => { handler = fn; } }, { tasksDir: tasks, root, works: [work] });
  const ask = async args => (await handler(args, {})).structuredContent;
  return { box, root, work, authority, tasks, kernelTask, ask };
}

test('C37: the reservation of a running kernel delivery leads to an ssam_task answer, never TASK_NOT_FOUND', async () => {
  const s = sandbox();
  const id = 'a471638c'.padEnd(32, '0');
  s.kernelTask(id, { writeState: 'not-sent', stage: 'build', updatedAt: '2026-10-06T05:49:00Z', request: { JobPath: 'C:\\x\\job.json' } });
  // The facade record of that o11_deliver: running, no result yet.
  fs.writeFileSync(path.join(s.tasks, '11111111-2222-4333-8444-555555555555.json'), JSON.stringify({ id: '11111111-2222-4333-8444-555555555555', tool: 'o11_deliver',
    summary: {}, pid: process.pid, startedAt: new Date().toISOString(), state: 'running' }));
  const reservation = path.join(s.authority, 'reservations', 'f'.repeat(64) + '.json');
  const payload = { owner: id, environment: 'env.example.test', moduleKey: 'K', root: s.root };
  const classified = classifyReservation(payload, reservation, { root: s.root, works: [s.work], authority: s.authority, alive: () => true });
  assert.equal(classified.state, 'active');
  assert.deepEqual(classified.next.arguments, { id });
  const answer = await s.ask(classified.next.arguments);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.kernelTask, { id, writeState: 'not-sent', stage: 'build', updatedAt: '2026-10-06T05:49:00Z', closeState: 'unsettled' });
  assert.deepEqual(answer.continuation.arguments, { resume: id });
  assert.equal(answer.continuation.tool, 'o11_deliver');
});

test('C37: the next call follows the close state of the kernel task; an unknown id is still TASK_NOT_FOUND', async () => {
  const s = sandbox();
  const refused = 'b'.repeat(32), uncertain = 'c'.repeat(32), delivered = 'd'.repeat(32);
  s.kernelTask(refused, { writeState: 'not-sent', stage: 'validation', error: 'TrueChange errors', updatedAt: '2026-10-06T05:50:00Z' });
  s.kernelTask(uncertain, { writeState: 'intent', stage: 'merge', updatedAt: '2026-10-06T05:51:00Z' });
  s.kernelTask(delivered, { writeState: 'applied', stage: 'done', delivered: true, updatedAt: '2026-10-06T05:52:00Z' });
  const closing = await s.ask({ id: refused.toUpperCase() });
  assert.equal(closing.kernelTask.closeState, 'refused');
  assert.deepEqual(closing.continuation.arguments, { id: refused, close: { reason: '<reason>' } });
  assert.deepEqual((await s.ask({ id: uncertain })).continuation.arguments, { resume: uncertain });
  const done = await s.ask({ id: delivered });
  assert.equal(done.ok, true); assert.equal(done.kernelTask.closeState, 'delivered'); assert.equal(done.continuation, undefined); assert.match(done.note, /ssam_doctor/);
  const missing = await s.ask({ id: 'e'.repeat(32) });
  assert.equal(missing.ok, false); assert.equal(missing.code, 'TASK_NOT_FOUND');
});
