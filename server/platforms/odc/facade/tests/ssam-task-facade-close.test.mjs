import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as tasks from '../ssam-task.mjs';
const id = '11111111-2222-4333-8444-555555555555';
function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-close-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function record(dir, fields = {}) {
  return tasks.mergeTask(dir, { id, tool: 'odc_deploy', pid: process.pid, state: 'uncertain', cancelled: true,
    summary: { module: 'SyntheticModule', operationId: 'synthetic-operation' }, call: { lane: 'odc', argsSha256: 'synthetic-hash' },
    result: { ok: false, outcome: 'uncertain' }, ...fields });
}
async function clientFor(t, dir, deps = {}) {
  const server = new McpServer({ name: 'facade-close-test', version: '1.0.0' });
  tasks.registerSsamTask(server, { tasksDir: dir, ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'facade-close-client', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return async arguments_ => (await client.callTool({ name: 'ssam_task', arguments: arguments_ })).structuredContent;
}
test('uncertain facade UUID names its close and closes without a kernel task or kernel close', async t => {
  const dir = folder(t); const before = record(dir);
  const call = await clientFor(t, dir);
  const reading = await call({ id });
  assert.deepEqual(reading.continuation?.arguments, { id, close: { reason: '<reason>' } });
  const answer = await call({ id, close: { reason: 'Synthetic reconciliation completed' } });
  assert.equal(answer.ok, true);
  const after = tasks.readTask(id, { dir });
  assert.ok(Number.isFinite(Date.parse(after.closedAt)));
  assert.equal(after.closeReason, 'Synthetic reconciliation completed');
  for (const key of ['state', 'summary', 'call', 'result', 'cancelled']) assert.deepEqual(after[key], before[key]);
  assert.equal((await call({ id })).continuation, undefined);
});
test('closeFacadeTask rejects live running and definitive records, closes orphaned running and validates reason', async t => {
  const dir = folder(t);
  assert.equal(typeof tasks.closeFacadeTask, 'function');
  // CT-1: a running record of this process is live only while this process runs its handler (here a trackTask body); one
  // that no handler here runs is orphaned (call-deadline-same-pid-restart.test.mjs).
  let release;
  const body = tasks.trackTask({ id, tool: 'odc_deploy', dir }, () => new Promise(resolve => { release = () => resolve({ ok: true }); }));
  assert.equal(tasks.readTask(id, { dir }).state, 'running');
  assert.equal(tasks.closeFacadeTask(id, 'Synthetic reason', { dir }).code, 'CLOSE_TASK_RUNNING');
  assert.equal(tasks.readTask(id, { dir }).closedAt, undefined);
  release(); await body;
  record(dir, { state: 'failed' });
  assert.equal(tasks.closeFacadeTask(id, 'Synthetic reason', { dir }).code, 'CLOSE_TASK_NOT_UNCERTAIN');
  record(dir, { state: 'running', pid: 2147483646 });
  assert.equal(tasks.closeFacadeTask(id, 'Synthetic reason', { dir }).ok, true);
  assert.ok(tasks.readTask(id, { dir }).closedAt);
  assert.equal(tasks.closeFacadeTask(id, ' ', { dir }).code, 'BAD_ARGS');
});
test('a facade UUID with a kernel taskId still closes through the existing proof-based kernel route', async t => {
  const dir = folder(t); const kernelId = 'a'.repeat(32);
  record(dir, { result: { ok: false, outcome: 'uncertain', taskId: kernelId } });
  const calls = [];
  const call = await clientFor(t, dir, { close: async (...args) => { calls.push(args); return { ok: false, code: 'CLOSE_PROOF_REQUIRED' }; } });
  assert.equal((await call({ id, close: { reason: 'Synthetic reason' } })).code, 'CLOSE_PROOF_REQUIRED');
  assert.equal(calls[0][0], kernelId); assert.equal(calls[0][1], 'Synthetic reason');
  assert.equal(tasks.readTask(id, { dir }).closedAt, undefined);
});
test('nested tracker final merge preserves cancellation evidence', async t => {
  const dir = folder(t);
  await tasks.trackTask({ id, tool: 'odc_deploy', summary: { module: 'SyntheticModule' }, dir }, async task => {
    tasks.mergeTask(dir, { id: task.id, cancelled: true });
    return { ok: true };
  });
  const final = tasks.readTask(id, { dir });
  assert.equal(final.cancelled, true); assert.equal(final.state, 'ok');
  assert.deepEqual(final.summary, { module: 'SyntheticModule' });
});
test('direct facade close cannot bypass a kernel task proof', t => {
  const dir = folder(t);
  record(dir, { result: { ok: false, outcome: 'uncertain', taskId: 'a'.repeat(32) } });
  assert.equal(tasks.closeFacadeTask(id, 'Synthetic reason', { dir }).code, 'CLOSE_KERNEL_REQUIRED');
  assert.equal(tasks.readTask(id, { dir }).closedAt, undefined);
});
