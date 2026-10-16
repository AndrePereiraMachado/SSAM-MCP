import './fixtures/isolated-profile.mjs';
// CX15 r3 (CT-2, common part): ssam_task of a preview whose execution has not opened its record never says a bare
// "executed:false". An engine that reads again and simulates before its record (the O11 Service Center engine) marks the
// execution as requested at its start (operations\<operationId>.requested); while its process lives, ssam_task answers
// execution-requested, executed "unknown"; once that process is gone without a record, it sent nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as destructive from '../destructive-operations.mjs';
import { registerSsamTask } from '../ssam-task.mjs';

const HOST = 'personal-0000r3win.outsystemscloud.com';
const T0 = Date.parse('2026-10-15T12:00:00Z');
function harness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r3-window-'));
  const root = path.join(base, 'destructive');
  let handler = null;
  registerSsamTask({ registerTool: (name, config, h) => { handler = h; } }, { tasksDir: path.join(base, 'tasks'), destructiveRoot: root });
  const call = async (args = {}) => (await handler(args, {})).structuredContent;
  const block = destructive.createPreview({ tool: 'o11_service_center_write', lane: 'o11', host: HOST, operation: 'delete',
    items: ['ZZSynth A', 'ZZSynth B', 'ZZSynth C'].map((name, i) => ({ kind: 'application', key: 'k' + i, name })), now: T0, root });
  return { root, call, block, preview: destructive.readPreview(block.previewId, { root }) };
}
const answerOf = value => value.destructiveOperation ?? value.preview ?? value;

test('CT-2: ssam_task of a preview without a record never says a bare executed:false (a call with the token may be starting)', async () => {
  const h = harness();
  const read = answerOf(await h.call({ id: h.block.operationId }));
  assert.equal(read.state, 'previewed');
  assert.match(JSON.stringify(read), /may be starting/i, 'executed:false comes with the caveat that a call with the token may be starting');
});

test('CT-2: an execution marked as requested reads execution-requested (executed unknown) while its process lives, from both ids', async () => {
  const h = harness();
  assert.equal(typeof destructive.noteExecutionRequested, 'function', 'destructive-operations exports noteExecutionRequested');
  const mark = destructive.noteExecutionRequested(h.preview, { now: T0 + 6000, root: h.root });
  for (const id of [h.block.operationId, h.block.previewId]) {
    const read = answerOf(await h.call({ id }));
    assert.equal(read.state, 'execution-requested');
    assert.equal(read.executed, 'unknown');
    assert.equal(read.pid, process.pid);
    assert.match(read.note, /never tell the owner nothing happened/);
  }
  // ssam_task {} lists it too (never an empty list while the execution reads the list again).
  const listed = (await h.call({})).destructive;
  assert.deepEqual(listed.map(o => [o.operationId, o.state, o.executed, o.pid]), [[h.block.operationId, 'execution-requested', 'unknown', process.pid]]);
  mark.done();
  assert.deepEqual((await h.call({})).destructive, [], 'done(): nothing listed (no record, no marker)');
  const after = answerOf(await h.call({ id: h.block.operationId }));
  assert.equal(after.state, 'previewed');
  assert.ok(!fs.existsSync(destructive.requestedFile(h.block.operationId, { root: h.root })), 'done() removes the marker');
});

test('CT-2: a marker left by a process that is gone says that process sent nothing (no record, no send)', async () => {
  const h = harness();
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  destructive.noteExecutionRequested(h.preview, { now: T0 + 6000, root: h.root, pid: dead });
  const read = answerOf(await h.call({ id: h.block.operationId }));
  assert.deepEqual([read.state, read.executed, read.requestGone, read.pid], ['previewed', false, true, dead]);
  assert.match(read.note, /sent nothing/);
});
