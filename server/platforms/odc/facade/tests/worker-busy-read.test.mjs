import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { runOnWorker, createWorkerClient, createWorkerFirstRunner } from '../anvil-worker.mjs';
import { createSsamServer } from '../ssam.mjs';
import { fakeWorker } from './fixtures/jobs-fake-worker.mjs';

const busy = { busy: true, queued: 0, currentCommand: 'deliver', runningMs: 1234 };
const envelope = { ok: true, command: 'data', data: { records: [] } };
const targetOf = fake => ({ port: fake.port, key: () => null, timeoutMs: 500 });

test('avoidBusy uses the status already read: busy or queued goes cold without submitting or another ping', async t => {
  const fake = await fakeWorker(); t.after(() => fake.close());
  for (const status of [busy, { ...busy, busy: false, queued: 2 }]) {
    let ensured = 0;
    const result = await runOnWorker(['data'], targetOf(fake), { ensure: async () => { ensured++; return { status }; }, avoidBusy: true });
    assert.equal(result.used, false);
    assert.match(result.note, /resident worker was busy with deliver for 1234 ms; this read ran cold/);
    assert.equal(ensured, 1);
  }
  assert.equal(fake.seen.length, 0, 'the ensure status is sufficient; nothing else reaches the worker');
});

test('a write still submits to a busy worker and a read submits to an idle worker', async t => {
  const fake = await fakeWorker(); t.after(() => fake.close());
  const write = await runOnWorker(['deliver'], targetOf(fake), { ensure: async () => ({ status: busy }) });
  const read = await runOnWorker(['data'], targetOf(fake), { ensure: async () => ({ status: { busy: false, queued: 0 } }), avoidBusy: true });
  assert.equal(write.used, true); assert.equal(read.used, true);
  assert.deepEqual(fake.seen.map(r => r.args[0]), ['deliver', 'data']);
});

test('the worker client carries avoidBusy through to runOnWorker', async t => {
  const fake = await fakeWorker(); t.after(() => fake.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-worker-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = createWorkerClient('o11', { root, env: { USERPROFILE: root, HOME: root, ANVIL_AUTHORITY_DIR: path.join(root, 'authority'), ANVIL_WORKER: '1', ANVIL_WORKER_PORT: String(fake.port) } }, { ensure: async () => ({ status: busy }) });
  assert.equal((await client.run(['data'], { avoidBusy: true })).used, false);
  assert.equal(fake.seen.length, 0);
  assert.equal((await client.run(['deliver'])).used, true);
});

test('read and recovery bypass a busy worker via the client and keep its workerNote; writes stay on the worker', async () => {
  const calls = []; const coldCalls = [];
  const note = 'the resident worker was busy with deliver for 1234 ms; this read ran cold';
  const worker = { run: async (args, options) => { calls.push({ args, options }); return options.avoidBusy ? { used: false, note } : { used: true, envelope }; } };
  const cold = async (args, options) => { coldCalls.push({ args, options }); return { ok: true, envelope, via: 'cold' }; };
  const run = createWorkerFirstRunner({ worker, cold });
  for (const options of [{ read: true }, { recovery: true }]) {
    const before = Date.now(); const result = await run(['data'], options);
    assert.equal(result.via, 'cold'); assert.equal(result.workerNote, note);
    assert.ok(Date.now() - before < 500);
  }
  assert.equal((await run(['deliver'])).via, 'worker');
  assert.deepEqual(calls.map(c => c.options.avoidBusy), [true, true, undefined]);
  assert.equal(coldCalls.length, 2);
});

test('an idle worker serves reads and exposes a queue race as workerQueuedMs', async () => {
  const worker = { run: async (_, options) => { assert.equal(options.avoidBusy, true); return { used: true, envelope: { ...envelope, queuedMs: 17 } }; } };
  const run = createWorkerFirstRunner({ worker, cold: () => { throw new Error('must stay on idle worker'); } });
  const result = await run(['data'], { read: true });
  assert.equal(result.via, 'worker'); assert.equal(result.workerQueuedMs, 17);
  assert.equal(result.envelope.queuedMs, 17);
});

test('o11_data marks read/read-all and all-read batches, while insert and mixed batches remain writes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-busy-data-'));
  const calls = [];
  const server = await createSsamServer({ odc: false, deps: { runAnvil: async (args, options) => { calls.push({ args, options }); return { ok: true, envelope }; },
    dataRoot: root, answersRoot: root, lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'worker-busy-data', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const read = { operation: 'read', entity: 'Order' };
  const insert = { operation: 'insert', entity: 'Order', operationId: '7a1c4e1e-1111-4111-8111-111111111111', records: [{ Number: '1' }] };
  for (const request of [read, { operation: 'read-all', entity: 'Order' }, { batch: [read] }, { ...insert, authorization: 'gravar pedido de teste' }, { authorization: 'gravar pedido de teste', batch: [read, insert] }]) {
    const result = await client.callTool({ name: 'o11_data', arguments: { host: 'dev.example.test', module: 'Orders_CS', oml: 'C:\\captures\\Orders_CS.oml', request } });
    assert.notEqual(result.isError, true, result.content[0].text);
  }
  assert.deepEqual(calls.map(c => c.options?.read), [true, true, true, false, false]);
});

test('environment and reference callers carry read flags for documented reads', async t => {
  const { tempKernel, linked, envelopes } = await import('./fixtures/o11env-kernel.mjs');
  const { fakeAnvil } = await import('./fixtures/fake-anvil.mjs');
  const { registerO11Environment, downloadModule, refreshInventory } = await import('../o11-environment.mjs');
  const { registerSsamReference } = await import('../ssam-reference.mjs');
  const kernel = tempKernel({ cli: true });
  const environment = fakeAnvil(envelopes);
  const envDeps = { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: environment, assertSelected: async () => {} };
  const envMcp = await linked(registerO11Environment, envDeps);
  const refs = [];
  const refMcp = await linked(registerSsamReference, { ...envDeps, runAnvil: async (args, options) => { refs.push({ args, options }); return { ok: true, envelope: { ok: true, data: { name: 'AddDays' } } }; } });
  t.after(async () => { await envMcp.close(); await refMcp.close(); kernel.cleanup(); });
  assert.equal((await envMcp.call('o11_environment', { action: 'inventory' })).ok, true);
  await downloadModule({ module: 'Demo_CS' }, envDeps);
  await refreshInventory({}, envDeps);
  assert.ok(environment.calls.length >= 3);
  assert.ok(environment.calls.every(c => c.options.read === true));
  await refMcp.call('ssam_reference', { lane: 'o11', kind: 'api', query: { op: 'logic' } });
  await refMcp.call('ssam_reference', { lane: 'o11', kind: 'functions', query: { names: ['AddDays', 'AddMonths'] } });
  assert.ok(refs.length >= 2);
  assert.ok(refs.every(c => c.options.read === true));
});

test('users lookup and access plan/verify carry read flags', async t => {
  const { tempKernel, linked } = await import('./fixtures/o11env-kernel.mjs');
  const { registerO11Access } = await import('../o11-access.mjs');
  const kernel = tempKernel({ cli: true }); const calls = [];
  const mcp = await linked(registerO11Access, { root: kernel.root, lane: 'ss4', env: kernel.env, assertSelected: async () => {},
    runAnvil: async (args, options) => { calls.push({ args, options }); return { ok: true, envelope: { ok: true, data: { ok: true, users: [] } } }; } });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  fs.writeFileSync(path.join(kernel.root, 'roles.json'), '{}');
  await mcp.call('o11_access', { action: 'users' });
  await mcp.call('o11_access', { action: 'plan', manifestPath: path.join(kernel.root, 'roles.json') });
  await mcp.call('o11_access', { action: 'verify' });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.options.read === true));
});
