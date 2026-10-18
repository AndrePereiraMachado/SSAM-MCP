// UI-Mockup (2026-10-11): the friction queue answers inside the MCP launcher, synchronously, on the line of the client's
// requests. In the FarmaVirtual session (2026-10-10) one ssam_friction {view:"report"} read every file of
// .local/friction/operations (37,666 files) to link the session's last operations: the launcher stopped for 8 min 11 s
// (20:27:28 -> 20:35:39), no call of that session reached the server meanwhile, and the next delivery entered 33.8 s
// after the client sent it. A read of the relay is bounded by what it names (the tail of the index, the operations it
// links or the task holds), never by the size of the queue. Synthetic queue folders; fs is watched, not replaced.
import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from '../facade/friction-store.mjs';
import { observeMcp } from '../facade/friction-boundary.mjs';

delete process.env.SSAM_FRICTION_DIR;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-sem-varredura-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const GAP = { kind: 'gap', tool: 'ssam_reference', intent: 'port a local HTML prototype', attempted: 'ssam_discover and the html contracts' };
const RECEIPT = 'd'.repeat(64);

// A queue with operations of two sessions interleaved, a task, a receipt and one start without an end.
function queue(t, options = {}) {
  const directory = temp(t); let now = Date.parse('2026-10-10T20:00:00Z');
  const store = createStore({ directory, warning: () => {}, clock: () => (now += 1000), ...options });
  const mine = randomUUID(), other = randomUUID();
  for (let i = 0; i < 30; i++) {
    store.begin({ interface: 'mcp', operation: 'map', lane: 'o11', sessionId: other }).finish({ ok: true });
    const op = store.begin({ interface: 'mcp', operation: i % 2 ? 'reference' : 'discover', lane: 'o11', sessionId: mine, ...(i >= 26 ? { taskId: 'task-ui' } : {}) });
    if (i === 27) op.finish({ ok: false, code: 'PREFLIGHT_REFUSED' }, { evidence: { sha256: RECEIPT } });
    else if (i !== 29) op.finish({ ok: true });
  }
  return { directory, store, mine, other };
}
// What the code under test reads under operations/: the listings and the files.
function watch(t, directory) {
  const operations = path.join(directory, 'operations');
  const seen = { listed: 0, read: [] };
  const inside = p => typeof p === 'string' && path.resolve(p).startsWith(operations);
  const readdir = fs.readdirSync, readFile = fs.readFileSync;
  t.mock.method(fs, 'readdirSync', function (p, ...rest) { if (inside(p)) seen.listed++; return readdir.call(this, p, ...rest); });
  t.mock.method(fs, 'readFileSync', function (p, ...rest) { if (inside(p)) seen.read.push(path.basename(p)); return readFile.call(this, p, ...rest); });
  return seen;
}

test('a report links the last operations of its session from the tail of the index, never by listing operations', t => {
  const { directory, store, mine } = queue(t);
  const expected = store.snapshot().operations.filter(e => e.sessionId === mine).slice(-5);
  const seen = watch(t, directory);
  const written = store.report(GAP, { sessionId: mine, profile: 'operational' });
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal(seen.listed, 0, 'the operations folder is never listed');
  assert.ok(seen.read.length <= 5, `at most the files of the linked operations (read ${seen.read.length})`);
  t.mock.restoreAll();
  const record = JSON.parse(fs.readFileSync(written.file, 'utf8'));
  assert.deepEqual(record.recent.map(r => [r.operationId, r.operation, r.outcome, r.code]), expected.map(e => [e.operationId, e.operation, e.outcome, e.code ?? null]),
    'the same five operations, in the same order, as the scan gave');
  assert.equal(record.recent.find(r => r.code === 'PREFLIGHT_REFUSED').receiptSha256, RECEIPT, 'the receipt of a linked operation stays');
  assert.equal(record.recent.at(-1).outcome, 'incomplete', 'a start without an end is linked as incomplete');
});

test('the task view and a verified transition read only the operations they name', t => {
  const { directory, store } = queue(t);
  const before = store.task({ taskId: 'task-ui' });
  const failing = store.issues().issues.find(i => i.code === 'PREFLIGHT_REFUSED');
  const seen = watch(t, directory);
  const task = store.task({ taskId: 'task-ui' });
  assert.equal(seen.listed, 0, 'task never lists the operations folder');
  assert.equal(task.operationCount, 4);
  assert.equal(seen.read.length, 5, 'the file of each operation of the task (the incomplete one: its missing end, then its start)');
  const { health: h1, ...rest1 } = task, { health: h0, ...rest0 } = before;
  assert.deepEqual(rest1, rest0, 'the same answer the scan gave');
  // corrected -> verified: the proof operation is read by its id.
  let state = store.transition({ issueId: failing.id, status: 'investigating' }).state;
  state = store.transition({ issueId: failing.id, status: 'corrected', expectedRevision: state.revision, proof: { sha256: 'b'.repeat(64), versionSha256: 'c'.repeat(64) } }).state;
  seen.listed = 0;
  assert.throws(() => store.transition({ issueId: failing.id, status: 'verified', expectedRevision: state.revision,
    proof: { sha256: 'b'.repeat(64), versionSha256: 'c'.repeat(64), operationId: randomUUID() } }), /later successful/);
  assert.equal(seen.listed, 0, 'a verified transition never lists the operations folder');
});

test('the MCP boundary answers from the index it has and never rebuilds it from the operations folder', t => {
  const { directory, mine } = queue(t);
  fs.rmSync(path.join(directory, 'index', '.complete'));
  process.env.SSAM_FRICTION_DIR = directory; t.after(() => { delete process.env.SSAM_FRICTION_DIR; });
  const received = [];
  const observer = observeMcp({ root, entry: 'ssam', args: ['mcp'], meta: { sessionId: mine, profile: 'operational' }, toServer: () => {}, toClient: s => received.push(s) });
  t.after(() => observer.close());
  const seen = watch(t, directory);
  const answer = n => received.flatMap(s => s.split('\n')).filter(Boolean).map(l => JSON.parse(l)).find(m => m.id === n)?.result?.structuredContent;
  observer.request.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ssam_friction', arguments: { view: 'issues' } } }) + '\n');
  observer.request.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ssam_friction', arguments: { view: 'report', ...GAP } } }) + '\n');
  observer.request.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ssam_map', arguments: { lane: 'o11' } } }) + '\n');
  const issues = answer(1), report = answer(2);
  assert.equal(issues.ok, true); assert.equal(issues.health.indexComplete, false, 'it says the index is incomplete');
  assert.ok(issues.issues.some(i => i.code === 'PREFLIGHT_REFUSED'), 'the issues of the index are there');
  assert.equal(report.ok, true); assert.equal(report.linkedOperations, 5);
  assert.equal(seen.listed, 0, 'no listing of the operations folder on the relay');
  assert.ok(fs.existsSync(path.join(directory, 'index', '.complete')) === false, 'the relay does not rebuild the index');
  // The CLI and a direct store still rebuild it, once.
  const cli = createStore({ directory, warning: () => {} });
  assert.equal(cli.issues().health.indexComplete, true);
  assert.ok(fs.existsSync(path.join(directory, 'index', '.complete')));
});
