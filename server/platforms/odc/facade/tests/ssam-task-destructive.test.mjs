import './fixtures/isolated-profile.mjs';
// CX15 W3: ssam_task reads the records of the destructive operations: without id the 10 most recent with their counts and
// names; with the operationId (or the previewId of its preview) item by item; a running one of a dead process is orphaned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerSsamTask } from '../ssam-task.mjs';
import { beginOperation, createPreview, endOperation, markItem, readPreview } from '../destructive-operations.mjs';

const HOST = 'personal-0000test.outsystemscloud.com';
const T0 = Date.parse('2026-10-15T12:00:00Z');
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15-task-'));
  const tasksDir = path.join(root, 'tasks');
  let handler = null; let description = '';
  registerSsamTask({ registerTool: (name, config, h) => { handler = h; description = config.description; } }, { tasksDir, destructiveRoot: path.join(root, 'destructive') });
  const call = async (args = {}) => (await handler(args, {})).structuredContent;
  const operation = (names, { pid, at = T0 } = {}) => {
    const block = createPreview({ tool: 'o11_service_center_write', lane: 'o11', host: HOST, operation: 'delete', items: names.map((name, i) => ({ kind: 'application', key: 'k' + i + name, name })),
      now: at, root: path.join(root, 'destructive') });
    return { block, record: beginOperation({ preview: readPreview(block.previewId, { root: path.join(root, 'destructive') }), now: at + 6000, root: path.join(root, 'destructive'), ...(pid ? { pid } : {}) }) };
  };
  return { root: path.join(root, 'destructive'), call, operation, description: () => description };
}

test('ssam_task {} lists the destructive operations with counts and the names of what was deleted and what was not started', async () => {
  const h = harness();
  const { block, record } = operation4(h);
  const list = await h.call({});
  assert.equal(list.ok, true);
  assert.deepEqual(list.tasks, []);
  const [op] = list.destructive;
  assert.deepEqual([op.operationId, op.previewId, op.tool, op.host, op.state, op.cancelled], [block.operationId, block.previewId, 'o11_service_center_write', HOST, 'cancelled', true]);
  assert.deepEqual([op.counts, op.deleted, op.notStarted], [{ deleted: 2, notStarted: 2 }, ['ZZC A', 'ZZC B'], ['ZZC C', 'ZZC D']]);
  assert.equal(record.items.length, 4);
  assert.match(h.description(), /Destructive operations/);
  assert.match(h.description(), /before telling the owner anything after an interruption, CANCELLED or "rejected"/);
});

test('ssam_task {id} by operationId and by previewId answers item by item', async () => {
  const h = harness();
  const { block } = operation4(h);
  const byOperation = await h.call({ id: block.operationId });
  const byPreview = await h.call({ id: block.previewId });
  assert.deepEqual(byOperation, byPreview);
  assert.deepEqual(byOperation.destructiveOperation.items.map(i => [i.name, i.state]), [['ZZC A', 'deleted'], ['ZZC B', 'deleted'], ['ZZC C', 'not-started'], ['ZZC D', 'not-started']]);
  const unknown = await h.call({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
  assert.equal(unknown.code, 'TASK_NOT_FOUND');
});

test('a running operation of a process that is gone reads orphaned; its item caught sending reads uncertain', async () => {
  const h = harness();
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const { block, record } = h.operation(['ZZC A', 'ZZC B'], { pid: dead });
  markItem(record, record.items[0], { state: 'sending' }, { now: T0 + 7000, root: h.root });
  const read = (await h.call({ id: block.operationId })).destructiveOperation;
  assert.deepEqual([read.state, read.orphaned, read.items.map(i => i.state)], ['running', true, ['uncertain', 'not-started']]);
  const listed = (await h.call({})).destructive[0];
  assert.deepEqual([listed.orphaned, listed.counts], [true, { uncertain: 1, notStarted: 1 }]);
});

function operation4(h) {
  const { block, record } = h.operation(['ZZC A', 'ZZC B', 'ZZC C', 'ZZC D']);
  for (const item of record.items.slice(0, 2)) markItem(record, item, { state: 'deleted' }, { now: T0 + 7000, root: h.root });
  endOperation(record, 'cancelled', { now: T0 + 8000, root: h.root, cancelledAt: new Date(T0 + 8000).toISOString() });
  return { block, record };
}
