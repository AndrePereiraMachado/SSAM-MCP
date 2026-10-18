import './fixtures/isolated-profile.mjs';
// Round 5 of fix/no-internals (re-review C:\t\revisoes\no-internals-4\REVISAO.md; decisions D12 and D14 of the Integradora,
// 17/10): a call that detaches is admitted once, for the callers it was admitted for, and its decision lives as long as it.
// - D12 (MEDIUM 1): the bytes a reference call reserves stay reserved while it is pending (its first answer is "running")
//   and are released only after the continuation that delivers its final answer has recorded its bytes; a call that is
//   never continued keeps them for the rest of the day;
// - D14 (LOW 1): a continuation by another caller is decided as a new call (the reference day holds), served and counted
//   for that caller under its day;
// - the decision ends with the call: it is removed when the final answer reaches its caller, or when it expires; a later
//   continuation is a new call, decided on whose answer the kept file holds (its origin record; none: refused, D13).
// Round 6 (D15): a continuation that never reached the call (an extra field, another tool) leaves the decision and the
// reservation as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { servedBytesStore } from '../served-bytes.mjs';
import { LICENSEE_REFERENCE } from '../ssam-reference.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll'));
const skip = !cliBuilt && 'the O11 lane CLI is not built in this checkout';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-detached-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const brief = body => JSON.stringify(body).slice(0, 300);

// A licensee's server whose answers and tasks live in root (its own task folder, so the decisions of this file are its own).
async function session(caller, { store, root, dayBytes, callDeadlineMs } = {}) {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ profile: 'all', deps: { answersRoot: root, tasksDir: path.join(root, '.local', 'tasks'), ...(callDeadlineMs ? { callDeadlineMs } : {}),
    exposure: { profile: 'licensee', caller: () => caller, store, ...(dayBytes ? { dayBytes } : {}) } } });
  const client = new Client({ name: 'no-internals-detached', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  // a call the deadline detached is followed with continueTask to its final answer
  const follow = async body => {
    for (let i = 0; i < 240; i++) {
      const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
      if (!next) break;
      await sleep(250);
      body = await once(next.tool, next.arguments);
    }
    return body;
  };
  const call = async (name, args) => follow(await once(name, args));
  return { once, call, follow, close: async () => { await client.close(); await server.close(); } };
}
const folder = label => fs.mkdtempSync(path.join(tmp, label + '-'));
const storeIn = root => servedBytesStore({ dir: path.join(root, 'day') });
const recordedOf = (store, caller) => store.day().callers?.[caller]?.ssam_reference?.bytes ?? 0;
const callsOf = (store, caller) => store.day().callers?.[caller]?.ssam_reference?.calls ?? 0;
const taskRecord = (root, id) => { try { return JSON.parse(fs.readFileSync(path.join(root, '.local', 'tasks', id + '.json'), 'utf8')); } catch { return null; } };
const ended = async (root, id) => { for (let i = 0; i < 480; i++) { const task = taskRecord(root, id); if (task && task.state !== 'running') return task; await sleep(250); } return taskRecord(root, id); };
const dayShut = async s => {
  await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
  assert.equal((await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' })).code, 'REFERENCE_DAY_LIMIT', 'the caller read its day');
};

// ---- D12: the reservation of a detached call
test('live: a detached reference call holds its reservation until its final answer; a second call meanwhile is past the day (D12)', { skip, timeout: 900000 }, async () => {
  const root = folder('d12'), store = storeIn(root), caller = 'd12-' + process.pid;
  const s = await session(caller, { store, root, dayBytes: 3000, callDeadlineMs: 1 });
  try {
    const first = await s.once('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    assert.equal(first.state, 'running', 'the call detached (deadline 1 ms): ' + brief(first));
    const second = await s.once('ssam_reference', { lane: 'o11', kind: 'functions', query: 'GetUserId' });
    assert.equal(second.code, 'REFERENCE_DAY_LIMIT', 'a second call while the first is pending: ' + brief(second));
    const final = await s.follow(first);
    assert.equal(final.ok, true, 'the continuation of the admitted call is served: ' + brief(final));
    assert.equal(store.usage(caller, ['ssam_reference']), recordedOf(store, caller), 'after its final answer the reservation is released: the day holds what was served');
  } finally { await s.close(); }
});
test('live: a detached reference call that is never continued keeps its reservation for the day (D12)', { skip, timeout: 900000 }, async () => {
  const root = folder('d12n'), store = storeIn(root), caller = 'd12n-' + process.pid;
  const s = await session(caller, { store, root, dayBytes: 3000, callDeadlineMs: 1 });
  try {
    const first = await s.once('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    assert.equal(first.state, 'running', 'the call detached (deadline 1 ms): ' + brief(first));
    const task = await ended(root, first.task.id);
    assert.ok(task && task.state !== 'running', 'the handler ended on its own: ' + brief(task));
    assert.ok(store.usage(caller, ['ssam_reference']) >= LICENSEE_REFERENCE.callBytes, 'the reservation is still held: ' + store.usage(caller, ['ssam_reference']));
    assert.equal((await s.once('ssam_reference', { lane: 'o11', kind: 'functions', query: 'GetUserId' })).code, 'REFERENCE_DAY_LIMIT');
  } finally { await s.close(); }
});

// ---- round 6, D15 (re-review C:\t\revisoes\no-internals-5\REVISAO.md, LOW 1): a wrong continuation (an extra field, the
// name of another tool) is refused as itself and changes nothing: the reservation stays held, the decision stays, a second
// call is still past the day and the right continuation that follows is served (D9)
test('live: a wrong continuation keeps the reservation and the decision; the right one that follows is served (D15)', { skip, timeout: 900000 }, async () => {
  const root = folder('d15'), store = storeIn(root), caller = 'd15-' + process.pid;
  const s = await session(caller, { store, root, dayBytes: 3000, callDeadlineMs: 1 });
  try {
    const first = await s.once('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    assert.equal(first.state, 'running', 'the call detached (deadline 1 ms): ' + brief(first));
    const id = first.task.id;
    const decision = path.join(root, '.local', 'tasks', '.exposure', id + '.json');
    // every facet is read, then judged together, so a failure names each one
    const problems = [];
    const wrong = [await s.once('ssam_reference', { continueTask: id, junk: 1 }), await s.once('ssam_evidence', { continueTask: id })];
    if (wrong[0].code !== 'INPUT_INVALID') problems.push('an extra field: ' + brief(wrong[0]));
    if (wrong[1].code !== 'TASK_TOOL_MISMATCH') problems.push('another tool: ' + brief(wrong[1]));
    if (!fs.existsSync(decision)) problems.push('the decision was ended by a wrong continuation');
    const used = store.usage(caller, ['ssam_reference']);
    if (used < LICENSEE_REFERENCE.callBytes) problems.push('the reservation was released by a wrong continuation (usage ' + used + ')');
    const second = await s.once('ssam_reference', { lane: 'o11', kind: 'functions', query: 'GetUserId' });
    if (second.code !== 'REFERENCE_DAY_LIMIT') problems.push('a second call while the first is pending: ' + brief(second));
    const final = await s.follow(first);
    if (final.ok !== true) problems.push('the right continuation: ' + brief(final));
    assert.deepEqual(problems, []);
    assert.equal(store.usage(caller, ['ssam_reference']), recordedOf(store, caller), 'after its final answer the reservation is released: the day holds what was served');
    assert.equal(fs.existsSync(decision), false, 'the decision ends with the final answer');
  } finally { await s.close(); }
});

// ---- D14: a continuation by another caller
test('live: a continuation by another caller is a new call: past its day refused, under it served and counted for it (D14)', { skip, timeout: 900000 }, async () => {
  const root = folder('d14'), store = storeIn(root), t = process.pid;
  const a = await session('d14a-' + t, { store, root, callDeadlineMs: 1 });
  const c = await session('d14c-' + t, { store, root, dayBytes: 3000 });
  const d = await session('d14d-' + t, { store, root });
  try {
    const first = await a.once('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'session' });
    assert.equal(first.state, 'running', 'the call detached (deadline 1 ms): ' + brief(first));
    await dayShut(c);
    const cross = await c.once('ssam_reference', { continueTask: first.task.id });
    assert.equal(cross.code, 'REFERENCE_DAY_LIMIT', 'another caller past its day: ' + brief(cross));
    const calls = callsOf(store, 'd14d-' + t);
    const other = await d.follow(await d.once('ssam_reference', { continueTask: first.task.id }));
    assert.equal(other.ok, true, 'another caller under its day: ' + brief(other));
    assert.ok(callsOf(store, 'd14d-' + t) > calls, 'counted for that caller');
    const own = await a.follow(first);
    assert.equal(own.ok, true, 'the caller the call was admitted for: ' + brief(own));
  } finally { await a.close(); await c.close(); await d.close(); }
});

// ---- the decision lives as long as the call
test('live: the decision of a detached call ends with its final answer or expires; a later continuation is a new call', { skip, timeout: 900000 }, async () => {
  const root = folder('life'), store = storeIn(root), caller = 'life-' + process.pid;
  const decisions = path.join(root, '.local', 'tasks', '.exposure');
  fs.mkdirSync(decisions, { recursive: true });
  // the decision of an older call, never continued: expired after a day
  const stale = path.join(decisions, randomUUID() + '.json');
  fs.writeFileSync(stale, JSON.stringify({ metered: 'ssam_reference', args: { kind: 'recipe' }, origin: null }));
  const old = new Date(Date.now() - 3 * 86400000);
  fs.utimesSync(stale, old, old);
  const s = await session(caller, { store, root, dayBytes: 500, callDeadlineMs: 1 });
  let fresh = null;
  try {
    const first = await s.once('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    assert.equal(first.state, 'running', 'the call detached (deadline 1 ms): ' + brief(first));
    const own = path.join(decisions, first.task.id + '.json');
    assert.ok(fs.existsSync(own), 'the decision is kept while the call is pending');
    assert.equal(fs.existsSync(stale), false, 'an expired decision is removed');
    const final = await s.follow(first);
    assert.equal(final.ok, true, brief(final));
    assert.equal(fs.existsSync(own), false, 'the decision ends with the final answer');
    // a later continuation is a new call: past the day (500 B) it is refused, nothing read
    const again = await s.once('ssam_reference', { continueTask: first.task.id });
    assert.equal(again.code, 'REFERENCE_DAY_LIMIT', 'a re-read after the end: ' + brief(again));
    // decided on whose answer the kept file holds: without a valid origin record, refused (D13)
    const task = taskRecord(root, first.task.id);
    const record = String(task?.answer?.file ?? '').replace(/\.json$/i, '') + '.origin';
    assert.ok(fs.existsSync(record), 'the kept final answer has its origin record: ' + brief(task));
    fs.unlinkSync(record);
    fresh = await session('life2-' + process.pid, { store, root });
    const unknown = await fresh.once('ssam_reference', { continueTask: first.task.id });
    assert.equal(unknown.code, 'ANSWER_ORIGIN_UNKNOWN', 'a kept answer whose origin is unknown: ' + brief(unknown));
  } finally { await s.close(); await fresh?.close(); }
});
