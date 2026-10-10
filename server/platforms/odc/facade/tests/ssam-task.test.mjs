// trackTask and ssam_task: one file per task in a temporary folder, read back by a real McpServer over InMemoryTransport.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { trackTask, readTask, listTasks, stateOf, registerSsamTask, tasksDir } from '../ssam-task.mjs';

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-task-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-02T09:00:00.000Z');
  return { dir, now: () => new Date(clock += 1000) };
}

test('a task is recorded as running while it runs, then with its state, times and a short result', async t => {
  const { dir, now } = folder(t);
  let seen;
  const value = await trackTask({ tool: 'o11_deliver', summary: { module: 'Orders', authorize: 'sim pode', nested: { words: 'x', keep: 1 } }, dir, now }, async task => {
    seen = JSON.parse(fs.readFileSync(path.join(dir, task.id + '.json'), 'utf8'));
    return { ok: true, result: 'entregue', huge: 'y'.repeat(10000) };
  });
  assert.deepEqual(value.result, 'entregue');
  assert.equal(seen.state, 'running'); assert.equal(seen.pid, process.pid); assert.equal(seen.endedAt, undefined);
  const [task] = listTasks({ dir });
  assert.equal(task.state, 'ok'); assert.equal(task.tool, 'o11_deliver');
  assert.deepEqual(task.summary, { module: 'Orders', nested: { keep: 1 } }, 'words never reach the file');
  assert.deepEqual(task.result, { ok: true, result: 'entregue' });
  assert.ok(Date.parse(task.endedAt) > Date.parse(task.startedAt));
  assert.ok(!fs.readFileSync(path.join(dir, task.id + '.json'), 'utf8').includes('sim pode'));
});

test('states: refusal and exception are failed, outcome uncertain is uncertain; errors are cut short', async t => {
  const { dir, now } = folder(t);
  assert.equal(stateOf({ ok: true }), 'ok'); assert.equal(stateOf({ ok: false, outcome: 'uncertain' }), 'uncertain'); assert.equal(stateOf(undefined), 'failed');
  const thrown = await trackTask({ tool: 't', dir, now }, async () => { throw new Error('boom'); });
  assert.deepEqual(thrown, { ok: false, error: 'boom' });
  await trackTask({ tool: 't', dir, now }, async () => ({ ok: false, outcome: 'uncertain', code: 'DELIVERY_UNCERTAIN', taskId: 'a'.repeat(32), error: 'e'.repeat(1000) }));
  const [uncertain, failed] = listTasks({ dir });
  assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.result.error.length, 300); assert.equal(uncertain.result.taskId, 'a'.repeat(32));
  assert.equal(failed.state, 'failed'); assert.equal(failed.result.error, 'boom');
});

test('another process reads the files: a running task of a gone process is flagged orphaned; bad ids read nothing', t => {
  const { dir } = folder(t);
  const id = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, tool: 'o11_deliver', pid: 2147483646, state: 'running', startedAt: '2026-10-02T08:00:00.000Z' }));
  assert.equal(readTask(id, { dir }).orphaned, true);
  assert.equal(readTask('../' + id, { dir }), null);
  assert.equal(readTask('nope', { dir }), null);
  assert.deepEqual(listTasks({ dir: path.join(dir, 'absent') }), []);
  assert.equal(tasksDir('C:\\anvil'), path.join('C:\\anvil', '.local', 'tasks'));
});

test('the ssam_task tool lists at most 20, newest first, and reads one', async t => {
  const { dir, now } = folder(t);
  for (let i = 0; i < 23; i++) await trackTask({ tool: 'o11_deliver', summary: { module: 'M' + i }, dir, now }, async () => ({ ok: i % 2 === 0 }));
  const server = new McpServer({ name: 'ssam-task-test', version: '1.0.0' });
  registerSsamTask(server, { tasksDir: dir });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ssam-task-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(x => x.name === 'ssam_task');
  // close {reason} with id closes a delivery task (C15): the tool is not read-only; reading never repeats anything.
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id', 'close']);
  const list = (await client.callTool({ name: 'ssam_task', arguments: {} })).structuredContent;
  assert.equal(list.tasks.length, 20);
  assert.equal(list.tasks[0].summary.module, 'M22'); assert.equal(list.tasks[19].summary.module, 'M3');
  const one = await client.callTool({ name: 'ssam_task', arguments: { id: list.tasks[0].id } });
  assert.equal(one.isError, undefined); assert.equal(one.structuredContent.task.state, 'ok');
  const missing = await client.callTool({ name: 'ssam_task', arguments: { id: '00000000-0000-4000-8000-000000000000' } });
  assert.equal(missing.isError, true); assert.equal(missing.structuredContent.code, 'TASK_NOT_FOUND');
});
