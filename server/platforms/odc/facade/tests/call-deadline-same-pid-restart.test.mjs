// CT-1 (review C:\t\revisoes\vps-a6-continuetask, fase4-26 75c8940c): a server restarted with the same pid (pid 7 in every
// start of the container image) finds the running records of the previous process. One rule decides for every reader
// (readTask and the listing, closeFacadeTask, the ssam_task close, the identical-call guard, continueTask): a running record
// of this pid runs only while this process runs its handler. One with another process start id, one of an older release
// without it, or one whose handler no longer runs here, is orphaned: ssam_task says so, its close works, and the identical
// call is refused until that close and runs once after it. Synthetic values only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createCallDeadline } from '../call-deadline.mjs';
import * as tasks from '../ssam-task.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = v => ({ content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v, ...(v.ok === false ? { isError: true } : {}) });
const value = a => a?.structuredContent;
const box = (t, tag) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-ct1-' + tag + '-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
async function ssamTask(t, dir) {
  const server = new McpServer({ name: 'ct1-ssam-task', version: '1.0.0' });
  tasks.registerSsamTask(server, { tasksDir: dir });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ct1-client', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return async args => (await client.callTool({ name: 'ssam_task', arguments: args })).structuredContent;
}
// A write that holds until the test opens it; it counts how many times its body runs.
function gatedWrite() {
  const state = { runs: 0, gates: [] };
  state.handler = async () => { state.runs++; await new Promise(resolve => state.gates.push(resolve)); return reply({ ok: true, published: true }); };
  state.open = () => { for (const open of state.gates.splice(0)) open(); };
  return state;
}
async function settle(run, answer) {
  for (let i = 0; i < 40 && value(answer)?.state === 'running'; i++) answer = await run(value(answer).continuation.arguments);
  return answer;
}

test('CT-1 the records of a detached write copied as they are into a fresh folder (a restart with the same pid): orphaned, closable, the identical call refused until the close and run once after it', async t => {
  const rootA = box(t, 'a'), rootB = box(t, 'b');
  const work = gatedWrite();
  const args = { module: 'SyntheticCT1' };
  const before = createCallDeadline({ root: rootA, timeoutMs: 50 }).wrap('o11_publish', work.handler);
  const first = value(await before(args));
  assert.equal(first.state, 'running', JSON.stringify(first));
  const id = first.task.id;
  const left = tasks.readTask(id, { dir: tasks.tasksDir(rootA) });
  assert.equal(left.state, 'running'); assert.equal(left.pid, process.pid);
  assert.equal(left.orphaned, undefined, 'the process that runs it never reads its own live record orphaned');
  const indexDir = path.join(tasks.tasksDir(rootA), '.index', 'calls');
  const index = JSON.parse(fs.readFileSync(path.join(indexDir, fs.readdirSync(indexDir)[0]), 'utf8'));
  assert.equal(tasks.closeFacadeTask(id, 'Synthetic reason', { dir: tasks.tasksDir(rootA) }).code, 'CLOSE_TASK_RUNNING', 'control: the live one never closes');

  // The restart: the same records and index in a folder no handler of this process runs.
  fs.cpSync(tasks.tasksDir(rootA), tasks.tasksDir(rootB), { recursive: true });
  const dir = tasks.tasksDir(rootB);
  const after = createCallDeadline({ root: rootB, timeoutMs: 200 }).wrap('o11_publish', work.handler);
  const call = await ssamTask(t, dir);
  const read = await call({ id });
  assert.equal(read.task?.orphaned, true, JSON.stringify(read).slice(0, 400));
  assert.deepEqual(read.continuation?.arguments, { id, close: { reason: '<reason>' } }); // the English marker since 16/10 (lane B)
  assert.equal(tasks.listTasks({ dir }).find(task => task.id === id)?.orphaned, true, 'the listing reads it the same way');
  const continued = value(await after({ continueTask: id }));
  assert.equal(continued.code, 'TASK_ORPHANED'); assert.equal(continued.close?.tool, 'ssam_task');
  for (let i = 0; i < 2; i++) {
    const refused = value(await after(args));
    assert.equal(refused.code, 'TASK_UNCERTAIN_PENDING', JSON.stringify(refused).slice(0, 300));
    assert.deepEqual(refused.task, { id, tool: 'o11_publish', orphaned: true });
    assert.deepEqual(refused.close?.arguments, { id, close: { reason: '<reason after reconciliation>' } }, 'the refusal names the close that works');
  }
  assert.equal(work.runs, 1, 'the identical call never runs before the close');
  const closed = await call({ id, close: { reason: 'Synthetic reconciliation' } });
  assert.equal(closed.ok, true, JSON.stringify(closed).slice(0, 300));
  assert.ok(tasks.readTask(id, { dir }).closedAt);
  const again = value(await after(args));
  assert.equal(again.state, 'running', JSON.stringify(again).slice(0, 300));
  assert.equal(work.runs, 2, 'after the close the identical call runs');
  const joined = value(await after(args));
  assert.equal(joined.joined, true); assert.equal(work.runs, 2, 'and only once');
  work.open();
  assert.equal(value(await settle(after, reply(again))).published, true);
  assert.equal(value(await settle(before, reply(first))).published, true);
  // What tells the restart apart without memory: the start id of the process, in the record and in its call index.
  assert.match(String(tasks.PROCESS_START_ID), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'the process has a start id');
  assert.equal(left.processStartId, tasks.PROCESS_START_ID, 'every record names the start of the process that wrote it');
  assert.deepEqual(index, { id, processStartId: tasks.PROCESS_START_ID }, 'the call index names it too');
});

test('CT-1 one rule for every reader: a running record of this pid runs only while this process runs its handler', async t => {
  const dir = path.join(box(t, 'rule'), 'tasks'); fs.mkdirSync(dir, { recursive: true });
  const write = fields => { const id = randomUUID(); fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, tool: 'odc_deploy', state: 'running',
    startedAt: new Date().toISOString(), isWrite: true, call: { lane: 'odc', argsSha256: 'synthetic-' + id }, ...fields })); return id; };
  const previous = write({ pid: process.pid, processStartId: 'a-previous-start' });
  const older = write({ pid: process.pid });
  const lost = write({ pid: process.pid, processStartId: tasks.PROCESS_START_ID }); // its handler ended here without its final write
  const gone = write({ pid: 2147483646, processStartId: 'another-process' });
  const starts = { previous: 'a-previous-start', older: undefined, lost: tasks.PROCESS_START_ID, gone: 'another-process' };
  for (const [name, id] of Object.entries({ previous, older, lost, gone })) {
    assert.equal(tasks.readTask(id, { dir }).orphaned, true, name);
    assert.equal(tasks.listTasks({ dir }).find(task => task.id === id).orphaned, true, name);
    const closed = tasks.closeFacadeTask(id, 'Synthetic reason', { dir });
    assert.equal(closed.ok, true, name + ' ' + JSON.stringify(closed));
    assert.equal(tasks.readTask(id, { dir }).processStartId, starts[name], name + ': the close keeps the start id of the record');
  }
  // A trackTask body this process runs (inside no deadline): never orphaned, never closed, until it ends.
  let release;
  const body = tasks.trackTask({ tool: 'odc_deploy', dir, summary: { module: 'SyntheticCT1' } }, () => new Promise(resolve => { release = () => resolve({ ok: true }); }));
  await sleep(20);
  const running = tasks.listTasks({ dir }).find(task => task.state === 'running' && !task.closedAt);
  assert.ok(running, 'the tracked record is written when its body starts');
  assert.equal(running.processStartId, tasks.PROCESS_START_ID);
  assert.equal(tasks.readTask(running.id, { dir }).orphaned, undefined);
  assert.equal(tasks.closeFacadeTask(running.id, 'Synthetic reason', { dir }).code, 'CLOSE_TASK_RUNNING');
  release(); await body;
  assert.equal(tasks.readTask(running.id, { dir }).state, 'ok');
});

test('CT-1 o11_deliver: the facade record of a delivery left running before it got the kernel taskId closes by its facade id', async t => {
  const rootA = box(t, 'deliver-a'), rootB = box(t, 'deliver-b');
  let release, runs = 0;
  const handler = async () => tasks.trackTask({ tool: 'o11_deliver', dir: tasks.tasksDir(rootA), summary: { module: 'SyntheticCT1' } }, async () => {
    runs++; await new Promise(resolve => { release = resolve; }); return { ok: true, result: 'delivered' };
  }).then(reply);
  const args = { job: { module: 'SyntheticCT1' } };
  const first = value(await createCallDeadline({ root: rootA, timeoutMs: 50 }).wrap('o11_deliver', handler)(args));
  const id = first.task.id;
  assert.equal(tasks.readTask(id, { dir: tasks.tasksDir(rootA) }).result?.taskId, undefined, 'no kernel taskId yet');
  fs.cpSync(tasks.tasksDir(rootA), tasks.tasksDir(rootB), { recursive: true });
  const dir = tasks.tasksDir(rootB);
  const call = await ssamTask(t, dir);
  const read = await call({ id });
  assert.equal(read.task.orphaned, true); assert.equal(read.task.tool, 'o11_deliver');
  const closed = await call({ id, close: { reason: 'Synthetic reconciliation' } });
  assert.equal(closed.ok, true, JSON.stringify(closed).slice(0, 300));
  const after = createCallDeadline({ root: rootB, timeoutMs: 200 }).wrap('o11_deliver', async () => { runs++; return reply({ ok: true, again: true }); });
  assert.equal(value(await after(args)).again, true, 'the closed delivery frees the identical call');
  assert.equal(runs, 2);
  release();
});
