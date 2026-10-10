// Atritos 3, lane wp (the OML writer pool): the build pool (build-pool.mjs). Slots shared by the processes of a machine
// through slot files, a private TEMP per slot, a FIFO queue fair between customers, queue {position, waitedMs} for a
// build that waited, BUILD_QUEUE_TIMEOUT only after the bounded wait, and no queue for a build inside the apply phase.
// Temporary folders only.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBuildPool, buildWorkers, buildQueueMs, BuildQueueRefused, BUILD_QUEUE_TIMEOUT_CODE, pooledBuild, slotWorkerPort, SLOT_SCHEMA } from '../build-pool.mjs';
import { withStudioWriteLock, enterApplyPhase } from '../studio-write-lock.mjs';

const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'pa3-wp-pool-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('wp pool: SSAM_BUILD_WORKERS sizes the pool, else min(4, cores - 1), at least 1; the queue limit', () => {
  assert.equal(buildWorkers({ SSAM_BUILD_WORKERS: '6' }, 2), 6);
  assert.equal(buildWorkers({}, 16), 4);
  assert.equal(buildWorkers({}, 3), 2);
  assert.equal(buildWorkers({}, 1), 1);
  assert.equal(buildWorkers({ SSAM_BUILD_WORKERS: '0' }, 8), 4, 'an invalid value keeps the default');
  assert.equal(buildQueueMs({ SSAM_BUILD_QUEUE_MS: '5000' }), 5000);
  assert.equal(buildQueueMs({ SSAM_WRITE_QUEUE_MS: '7000' }), 7000);
  assert.equal(buildQueueMs({}), 240000);
});

test('wp pool: fairness between customers: a customer with three builds queued does not hold back the other one', async () => {
  const pool = createBuildPool({ dir: tmp(), size: 1, queueMs: 10000 });
  const order = [];
  const gate = deferred(); const first = deferred();
  const build = (customer, name, hold) => pool.run({ customer }, async () => { order.push(name); if (hold) { first.resolve(); await hold; } else await sleep(5); return name; });
  const runs = [build('A', 'A1', gate.promise)];
  await first.promise;
  runs.push(build('A', 'A2'));
  await sleep(5);
  runs.push(build('A', 'A3'));
  await sleep(5);
  runs.push(build('B', 'B1'));
  await sleep(20);
  gate.resolve();
  assert.deepEqual(await Promise.all(runs), ['A1', 'A2', 'A3', 'B1']);
  assert.deepEqual(order, ['A1', 'B1', 'A2', 'A3'], 'B runs second, not fourth');
});

test('wp pool: a build that waited is told queue {position, waitedMs}; each slot has its own TEMP', async () => {
  const dir = tmp();
  const pool = createBuildPool({ dir, size: 2, queueMs: 10000 });
  const gate = deferred(); const both = deferred(); let started = 0;
  const slots = [];
  const hold = () => pool.run({ customer: 'c' }, async slot => { slots.push(slot); if (++started === 2) both.resolve(); await gate.promise; return slot.index; });
  const a = hold(); const b = hold();
  await both.promise;
  assert.notEqual(slots[0].tmp, slots[1].tmp);
  for (const slot of slots) { assert.ok(fs.existsSync(slot.tmp)); assert.deepEqual(slot.env, { TEMP: slot.tmp, TMP: slot.tmp }); }
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'slot-0.lock'), 'utf8'));
  assert.deepEqual([record.schema, record.pid], [SLOT_SCHEMA, process.pid]);
  assert.equal(JSON.stringify(record).includes('"c"'), false, 'the customer is kept as a hash');
  let told = null;
  const third = pool.run({ customer: 'c', onQueued: q => { told = q; } }, async (slot, queue) => ({ slot: slot.index, queue }));
  await sleep(40);
  gate.resolve();
  await Promise.all([a, b]);
  const value = await third;
  assert.equal(told.position, 1);
  assert.ok(told.waitedMs >= 30, JSON.stringify(told));
  assert.deepEqual(value.queue, told);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.lock')), [], 'every slot released');
});

test('wp pool: only a wait that runs out refuses, BUILD_QUEUE_TIMEOUT with position, waitedMs, queueMs and a continuation', async () => {
  const pool = createBuildPool({ dir: tmp(), size: 1, queueMs: 60 });
  const gate = deferred(); const running = deferred();
  const busy = pool.run({ customer: 'a' }, async () => { running.resolve(); await gate.promise; return 'done'; });
  await running.promise;
  let ran = false;
  await assert.rejects(pool.run({ customer: 'b' }, async () => { ran = true; }), error => {
    assert.ok(error instanceof BuildQueueRefused);
    const r = error.refusal;
    assert.deepEqual([r.ok, r.code, r.outcome, r.waitedFor, r.position, r.queueMs, r.workers], [false, BUILD_QUEUE_TIMEOUT_CODE, 'not-sent', 'pool', 1, 60, 1]);
    assert.ok(r.waitedMs >= 60);
    assert.equal(r.continuation.tool, 'ssam_doctor');
    return true;
  });
  assert.equal(ran, false);
  gate.resolve(); assert.equal(await busy, 'done');
});

test('wp pool: a slot held by a live process of the machine is waited for; a dead one is taken over', async () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  const foreign = { schema: SLOT_SCHEMA, pid: 424242, startedAt: new Date().toISOString(), customer: 'x', token: 't' };
  fs.writeFileSync(path.join(dir, 'slot-0.lock'), JSON.stringify(foreign));
  let alive = true;
  const pool = createBuildPool({ dir, size: 1, queueMs: 2000, alive: () => alive });
  let told = null;
  const run = pool.run({ customer: 'c', onQueued: q => { told = q; } }, async slot => slot.index);
  await sleep(60);
  assert.equal(told, null, 'still waiting for the live foreign slot');
  alive = false;
  assert.equal(await run, 0);
  assert.ok(told.waitedMs >= 50);
});

test('wp pool: a build inside the apply phase never queues; in the build phase the wait goes to the call phases', async () => {
  const root = tmp();
  const deps = { o11Root: path.join(root, 'kernel'), odcRoot: path.join(root, 'odc'), o11Lane: 'ss4', connection: () => null };
  const pool = createBuildPool({ dir: path.join(root, 'pool'), size: 1, queueMs: 5000 });
  const gate = deferred(); const occupied = deferred();
  const other = pool.run({ customer: 'x' }, async () => { occupied.resolve(); await gate.promise; });
  await occupied.promise;
  const answer = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [] }, lane: 'o11', deps, phased: true }, async () => {
    await enterApplyPhase();
    const slot = await pooledBuild({ pool, customer: 'y', privateDir: path.join(root, 'private') }, async s => s);
    return { ok: true, slot };
  });
  assert.equal(answer.slot.index, null, 'ran at once in a private folder');
  assert.ok(answer.slot.tmp.startsWith(path.join(root, 'private')));
  const queued = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'B', job: [] }, lane: 'o11', deps, phased: true }, async () =>
    ({ ok: true, slot: await pooledBuild({ pool, customer: 'y' }, async s => s.index) }));
  await sleep(50);
  gate.resolve(); await other;
  const value = await queued;
  assert.equal(value.slot, 0);
  assert.equal(value.phases, undefined, 'no build noted: no phases');
});

test('wp pool: slot i of a resident worker listens on base + i * poolStep', () => {
  const workspace = tmp();
  fs.writeFileSync(path.join(workspace, '.ssam-workspace.json'), JSON.stringify({ workers: { o11ss4: 16517, poolStep: 100 } }));
  assert.equal(slotWorkerPort(16517, 0, { workspace }), 16517);
  assert.equal(slotWorkerPort(16517, 3, { workspace }), 16817);
  assert.equal(slotWorkerPort(4517, 2, { workspace: tmp() }), 4537, 'without the file: step 10');
});
