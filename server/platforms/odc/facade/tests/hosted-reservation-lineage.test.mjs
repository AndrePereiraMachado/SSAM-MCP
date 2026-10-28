import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverOutcome } from '../o11-cycle.mjs';
import { withStudioWriteLock } from '../studio-write-lock.mjs';

const id = 'a'.repeat(32);
const durable = value => {
  const payload = JSON.stringify(value);
  return JSON.stringify({ format: 1, sha256: createHash('sha256').update(payload).digest('hex'), payload });
};
const readDurable = file => JSON.parse(JSON.parse(fs.readFileSync(file, 'utf8')).payload);
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reservation-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kernel = path.join(root, 'kernel'), work = path.join(kernel, '.local', 'work'), authority = path.join(root, 'authority');
  const job = path.join(root, 'job.json'), other = path.join(root, 'other.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'get', target: 'ServerAction:Read' }] }));
  fs.writeFileSync(other, JSON.stringify({ ops: [{ op: 'get', target: 'ServerAction:Write' }] }));
  const task = { taskId: id, module: 'Orders', moduleKey: 'key1', request: { JobPath: job }, delivered: false,
    writeState: 'applied', stage: 'checks', validation: { newErrors: 0 }, error: 'Snapshot was not sent', failures: [{ stage: 'checks', error: 'PATH_OUTSIDE_WORKSPACE' }] };
  fs.mkdirSync(path.join(work, 'deliver', id), { recursive: true });
  fs.writeFileSync(path.join(work, 'deliver', id, 'task.json'), durable(task));
  const reservations = path.join(authority, 'reservations'); fs.mkdirSync(reservations, { recursive: true });
  const reservation = path.join(reservations, 'module.json');
  fs.writeFileSync(reservation, durable({ owner: id, moduleKey: 'key1', since: '2026-10-01T00:00:00Z' }));
  const deps = { o11Root: kernel, o11Lane: 'ss4', queueMs: 1000, env: { ANVIL_AUTHORITY_DIR: authority, SSAM_RESERVATION_QUEUE_MS: '90' } };
  return { root, work, job, other, task, reservation, deps };
}
const answer = (box, input, state) => deliverOutcome({ envelope: { data: state } }, { trackId: 'track', work: box.work, job: input.job, input });

test('a tool failure after the applied merge resumes the same task without recreating the job', t => {
  const box = setup(t), result = answer(box, { module: 'Orders', job: box.job }, box.task);
  assert.equal(result.merged, true);
  assert.equal(result.continuation?.tool, 'o11_deliver');
  assert.deepEqual(result.continuation?.arguments, { resume: id });
});

test('a reservation from another job in the same session never offers closePrevious or resume', t => {
  const box = setup(t);
  const result = answer(box, { module: 'Orders', job: box.other }, { taskId: 'b'.repeat(32), code: 'MODULE_RESERVED', writeState: 'not-sent', error: 'resume task ' + id });
  assert.equal(result.continuation?.tool, 'ssam_task');
  assert.deepEqual(result.continuation?.arguments, { id });
});

test('a failed job check is not classified as an infrastructure failure', t => {
  const box = setup(t);
  const result = answer(box, { module: 'Orders', job: box.job }, { ...box.task,
    error: 'Required element is missing', failures: [{ stage: 'checks', error: 'Required element is missing' }] });
  assert.equal(result.continuation?.tool, 'ssam_task');
  assert.deepEqual(result.continuation?.arguments, { id });
});

test('the same job and a correction based on its job retain the close-and-deliver continuation', t => {
  const box = setup(t);
  for (const input of [{ module: 'Orders', job: box.job }, { module: 'Orders', job: box.other, basedOn: { job: box.job } }]) {
    const result = answer(box, input, { taskId: 'b'.repeat(32), code: 'MODULE_RESERVED', writeState: 'not-sent', error: 'resume task ' + id });
    assert.equal(result.continuation?.arguments.closePrevious, id);
  }
});

test('every delivery failure without a kernel answer has a read continuation', t => {
  const box = setup(t);
  const result = deliverOutcome({ envelope: { error: 'Process could not start' } }, { trackId: 'track', work: box.work, job: box.other });
  assert.equal(result.continuation?.tool, 'ssam_task');
  assert.deepEqual(result.continuation?.arguments, { id: 'track' });
});

test('the module guard waits for a durable reservation to be released before running', async t => {
  const box = setup(t); let ran = false;
  // Success under concurrent suite load needs scheduling margin; the separate deadline test keeps its 90 ms limit.
  box.deps.env.SSAM_RESERVATION_QUEUE_MS = '500';
  const timer = setTimeout(() => fs.writeFileSync(box.reservation, durable({ owner: null })), 35);
  t.after(() => clearTimeout(timer));
  const result = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Orders', job: box.other }, phased: true, deps: box.deps }, () => {
    ran = true; assert.equal(readDurable(box.reservation).owner, null); return { ok: true };
  });
  assert.equal(ran, true); assert.equal(result.ok, true);
  assert.ok(result.queue?.waitedMs >= 25); assert.equal(result.queue.position, 1);
});

test('the module guard deadline reports owner and position and never runs the waiting job', async t => {
  const box = setup(t); let ran = false;
  const result = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Orders', job: box.other }, phased: true, deps: box.deps }, () => { ran = true; });
  assert.equal(ran, false); assert.equal(result.code, 'MODULE_RESERVED');
  assert.equal(result.holder.taskId, id); assert.equal(result.position, 1); assert.equal(result.queueMs, 90);
  assert.deepEqual(result.continuation.arguments, { id });
});

test('a reservation waiter never prevents the holder from resuming or closing', async t => {
  const box = setup(t);
  const waiting = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Orders', job: box.other }, phased: true, deps: box.deps }, () => ({ ok: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  await withStudioWriteLock({ tool: 'o11_deliver', args: { resume: id }, phased: true, deps: box.deps }, () => {
    fs.writeFileSync(box.reservation, durable({ owner: null })); return { ok: true };
  });
  assert.equal((await waiting).ok, true);
});

async function ownerPassesReservationWaiters(t, count, ownerArguments) {
  const box = setup(t);
  box.deps.env.SSAM_RESERVATION_QUEUE_MS = '500';
  const finished = Array(count).fill(false);
  const waiters = Array.from({ length: count }, (_, index) => withStudioWriteLock({
    tool: 'o11_deliver', args: { module: 'Orders', job: box.other }, phased: true, deps: box.deps,
  }, () => ({ ok: true })).then(result => { finished[index] = true; return result; }));
  await new Promise(resolve => setTimeout(resolve, 20));
  let ownerRanBeforeWaitersEnded = false;
  const owner = await withStudioWriteLock({ tool: 'o11_deliver', args: ownerArguments(box), phased: true, deps: box.deps }, () => {
    ownerRanBeforeWaitersEnded = finished.every(done => !done);
    fs.writeFileSync(box.reservation, durable({ owner: null }));
    return { ok: true };
  });
  const results = await Promise.all(waiters);
  assert.equal(owner.ok, true);
  assert.equal(ownerRanBeforeWaitersEnded, true, 'the owner runs before any reservation waiter exhausts its deadline');
  assert.ok(results.every(result => result.ok === true), 'every waiter runs after the owner releases the reservation');
}

test('a module closePrevious delivery passes another lineage waiting for its reservation', async t => {
  await ownerPassesReservationWaiters(t, 1, box => ({ module: 'Orders', job: box.other, closePrevious: id }));
});

test('a module patch with basedOn taskId passes another lineage waiting for its reservation', async t => {
  await ownerPassesReservationWaiters(t, 1, () => ({ module: 'Orders', basedOn: { taskId: id },
    patch: [{ op: 'replace', path: '/ops/0/target', value: 'ServerAction:Corrected' }] }));
});

test('the module owner passes all three foreign reservation waiters', async t => {
  await ownerPassesReservationWaiters(t, 3, box => ({ module: 'Orders', job: box.other, closePrevious: id }));
});

test('a reservation deadline runs nothing and holds no module guard while waiting', async t => {
  const box = setup(t); let ran = false;
  const waiting = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Orders', job: box.other }, phased: true,
    deps: box.deps }, () => { ran = true; return { ok: true }; });
  await new Promise(resolve => setTimeout(resolve, 20));
  const locks = path.join(box.deps.o11Root, '.local', 'locks');
  const guards = fs.existsSync(locks) ? fs.readdirSync(locks).filter(name => name.endsWith('.guard')) : [];
  const result = await waiting;
  assert.deepEqual(guards, [], 'waiting for a reservation never owns the module guard');
  assert.equal(ran, false); assert.equal(result.code, 'MODULE_RESERVED');
  assert.equal(result.holder.taskId, id); assert.equal(result.position, 1); assert.equal(result.queueMs, 90);
});

const assertOwnershipGuidance = continuation => {
  assert.match(continuation.why, /If that task is yours/);
  assert.ok(continuation.why.includes('basedOn {taskId: ' + id + '}'), 'the guidance names the holder task');
  assert.match(continuation.why, /patch/);
};

test('the reservation wait explains how the owner establishes its job lineage', async t => {
  const box = setup(t);
  const result = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Orders', job: box.other }, phased: true,
    deps: box.deps }, () => assert.fail('a foreign delivery cannot run'));
  assertOwnershipGuidance(result.continuation);
});

test('the cycle reservation refusal explains how the owner establishes its job lineage', t => {
  const box = setup(t);
  const result = answer(box, { module: 'Orders', job: box.other }, { taskId: 'b'.repeat(32), code: 'MODULE_RESERVED',
    writeState: 'not-sent', error: 'resume task ' + id });
  assertOwnershipGuidance(result.continuation);
});
