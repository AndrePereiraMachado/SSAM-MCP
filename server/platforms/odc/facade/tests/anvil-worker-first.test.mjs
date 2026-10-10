import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerFirstRunner } from '../anvil-worker.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const fakeWorker = reply => { const calls = []; return { calls, run: async (argv, options) => { calls.push({ argv, options }); return typeof reply === 'function' ? reply(argv) : reply; } }; };

test('a CLI command goes to the resident worker when it serves, with the caller timeout', async () => {
  const cold = fakeAnvil({ deliver: () => ({ ok: true, data: { delivered: true } }) });
  const worker = fakeWorker({ used: true, envelope: { ok: true, command: 'deliver', data: { delivered: true } } });
  const run = createWorkerFirstRunner({ cold, worker, env: {} });
  const result = await run(['deliver', '--module', 'M'], { timeoutMs: 3600000 });
  assert.equal(result.ok, true); assert.equal(result.via, 'worker'); assert.deepEqual(result.envelope.data, { delivered: true });
  assert.deepEqual(worker.calls[0], { argv: ['deliver', '--module', 'M'], options: { timeoutMs: 3600000 } });
  assert.equal(cold.calls.length, 0);
});

test('nothing executed on the worker runs cold; app-session, stdin input and another assembly are always cold', async () => {
  const cold = fakeAnvil({ inventory: () => ({ ok: true, data: { modules: [] } }), 'app-session': () => ({ ok: true, data: {} }), api: () => ({ ok: true, data: {} }) });
  const worker = fakeWorker({ used: false, note: 'the worker serves another Studio; ran cold' });
  const run = createWorkerFirstRunner({ cold, worker, env: {} });
  const r = await run(['inventory']);
  assert.equal(r.ok, true); assert.equal(r.workerNote, 'the worker serves another Studio; ran cold');
  await run(['app-session', '--action', 'context'], { input: { task_id: 't' } });
  await run(['api', '--op', 'verbs'], { cli: 'C:\\x\\anvil-odc.dll' });
  assert.equal(worker.calls.length, 1); assert.deepEqual(cold.calls.map(c => c.args[0]), ['inventory', 'app-session', 'api']);
});

test('a request written to the worker with no reply is an unknown outcome, reported as timedOut and never replayed cold', async () => {
  const cold = fakeAnvil({ deliver: () => ({ ok: true, data: { delivered: true } }) });
  const worker = fakeWorker({ used: true, unknown: true, code: 'WORKER_OUTCOME_UNKNOWN', error: 'worker connection failed after submission' });
  const run = createWorkerFirstRunner({ cold, worker, env: {} });
  const r = await run(['deliver', '--module', 'M']);
  assert.equal(r.ok, false); assert.equal(r.timedOut, true); assert.equal(r.unknown, true); assert.equal(r.envelope, null);
  assert.equal(cold.calls.length, 0);
});

test('a worker refusal that ran nothing (another controller key) runs the same command cold, once', async () => {
  const cold = fakeAnvil({ deliver: () => ({ ok: true, data: { delivered: true } }) });
  const worker = fakeWorker({ used: true, envelope: { ok: false, command: 'deliver', error: 'Worker operation requires the trusted Hybrid controller', executed: false } });
  const run = createWorkerFirstRunner({ cold, worker, env: {} });
  const r = await run(['deliver', '--module', 'M']);
  assert.equal(r.ok, true); assert.deepEqual(r.envelope.data, { delivered: true });
  assert.match(r.workerNote, /did not run the request \(Worker operation requires the trusted Hybrid controller\); ran cold/);
  assert.equal(worker.calls.length, 1); assert.equal(cold.calls.length, 1);
  // A refusal the worker did run is its answer and is never repeated cold.
  const ran = fakeWorker({ used: true, envelope: { ok: false, command: 'deliver', error: 'merge kept for review' } });
  const kept = await createWorkerFirstRunner({ cold, worker: ran, env: {} })(['deliver', '--module', 'M']);
  assert.equal(kept.ok, false); assert.equal(kept.via, 'worker'); assert.equal(cold.calls.length, 1);
});

test('ANVIL_WORKER=0 keeps every command cold', async () => {
  const cold = fakeAnvil({ inventory: () => ({ ok: true, data: {} }) });
  const run = createWorkerFirstRunner({ cold, env: { ANVIL_WORKER: '0' } });
  assert.equal((await run(['inventory'])).ok, true);
  assert.equal(cold.calls.length, 1);
});
