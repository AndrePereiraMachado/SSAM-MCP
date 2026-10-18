import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as tasks from '../ssam-task.mjs';
import { WORDS_MARKER } from '../next-steps.mjs';
import { WORDS as ENGLISH_WORDS_MARKER } from '../continuations.mjs';
const kernelId = 'a'.repeat(32);
function folder(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-index-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function record(dir, fields = {}) { return tasks.mergeTask(dir, { id: randomUUID(), tool: 'o11_deliver', state: 'uncertain', call: { argsSha256: 'b'.repeat(64), lane: 'o11' }, isWrite: true, result: { ok: false, outcome: 'uncertain', taskId: kernelId }, ...fields }); }
test('R3-3 successful proof close releases matching facade records and only those', async t => {
  const dir = folder(t), first = record(dir), other = record(dir, { result: { taskId: 'c'.repeat(32) } });
  const handlers = new Map();
  tasks.registerSsamTask({ registerTool: (name, config, handler) => handlers.set(name, handler) }, { tasksDir: dir, close: async () => ({ ok: true, closed: true, writeState: 'not-applied' }) });
  const answer = await handlers.get('ssam_task')({ id: kernelId, close: { reason: 'Synthetic proof confirmed' } });
  assert.equal(answer.structuredContent.ok, true);
  assert.ok(tasks.readTask(first.id, { dir }).closedAt);
  assert.equal(tasks.readTask(other.id, { dir }).closedAt, undefined);
});
test('R3-4 records keep only brief scrubbed results and compact listing', t => {
  const dir = folder(t);
  for (let i = 0; i < 20; i++) record(dir, { result: { ok: false, taskId: kernelId, code: 'SYNTHETIC_REFUSAL', problems: Array.from({ length: 300 }, (_, j) => ({ code: 'P'+j, pointer: '/ops/'+j, message: 'synthetic '.repeat(100) })), rows: 'synthetic '.repeat(4000) }, callResult: { ok: true, result: { rows: 'synthetic '.repeat(4000) } } });
  const listed = tasks.listTasks({ dir });
  assert.equal(listed.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, tasks: listed })) < 40960);
  assert.ok(fs.statSync(path.join(dir, listed[0].id+'.json')).size < 4096);
});
test('R3-4 call guard index reads a constant number of files without enumerating records', t => {
  const dir = folder(t), item = record(dir);
  assert.equal(typeof tasks.findCallTask, 'function');
  const read = fs.readFileSync, list = fs.readdirSync; let reads = 0;
  fs.readFileSync = (...args) => { reads++; return read(...args); };
  fs.readdirSync = () => { throw new Error('Guard must not enumerate'); };
  try { assert.equal(tasks.findCallTask(dir, item.tool, item.call.argsSha256).id, item.id); assert.ok(reads <= 2); }
  finally { fs.readFileSync = read; fs.readdirSync = list; }
});
test('R3-4 legacy migration preserves unresolved and undelivered cancelled writes once', t => {
  const dir = folder(t);
  const states = [ { state: 'uncertain' }, { state: 'ok', cancelled: true, deliveries: 0 }, { state: 'failed', cancelled: true, deliveries: 0 },
    { state: 'ok', cancelled: true, deliveries: 1 }, { state: 'uncertain', closedAt: '2026-10-15T00:00:00Z' } ];
  const records = states.map((fields, i) => ({ id: randomUUID(), tool: 'o11_deliver', isWrite: true, call: { argsSha256: String(i).repeat(64) }, ...fields }));
  for (const item of records) fs.writeFileSync(path.join(dir, item.id+'.json'), JSON.stringify(item));
  tasks.ensureTaskIndexes(dir);
  for (let i = 0; i < records.length; i++) assert.equal(tasks.findCallTask(dir, records[i].tool, records[i].call.argsSha256)?.id, i < 3 ? records[i].id : undefined);
  const list = fs.readdirSync; fs.readdirSync = () => { throw new Error('Migration cannot enumerate twice'); };
  try { tasks.ensureTaskIndexes(dir); } finally { fs.readdirSync = list; }
});
test('R3-4 brief reduction is idempotent and JSON answer text uses the same scrub', t => {
  const source = { ok: false, contract: { summary: 'Synthetic contract summary '.repeat(20), fullPayload: 'synthetic '.repeat(4000) }, problems: Array.from({ length: 20 }, (_, i) => ({ code: 'P'+i, pointer: '/ops/'+i })), authorization: 'SYNTHETIC_FIELD', nested: { credentials: 'SYNTHETIC_FIELD', keep: 7 } };
  const brief = tasks.briefResult(source);
  assert.equal(brief.contract, source.contract.summary.slice(0, 300));
  assert.deepEqual(tasks.briefResult(brief), brief); assert.equal(brief.problemsTotal, 20);
  const alreadyBrief = tasks.briefResult({ ok: false, contract: 'Synthetic already brief contract' });
  assert.equal(alreadyBrief.contract, 'Synthetic already brief contract');
  assert.deepEqual(tasks.briefResult(alreadyBrief), alreadyBrief);
  const dir = folder(t), persisted = record(dir, { result: brief, callResult: brief });
  assert.equal(persisted.result.contract, brief.contract);
  assert.equal(tasks.readTask(persisted.id, { dir }).callResult.contract, brief.contract);
  const clean = tasks.sanitizeAnswer({ structuredContent: source, content: [{ type: 'text', text: JSON.stringify(source) }] });
  assert.equal(clean.structuredContent.authorization, undefined); assert.equal(clean.structuredContent.nested.credentials, undefined);
  assert.equal(JSON.parse(clean.content[0].text).nested.keep, 7);
});
test('R3-4 persisted continuations preserve trusted placeholders without keeping synthetic secret fields', () => {
  for (const marker of [WORDS_MARKER, ENGLISH_WORDS_MARKER]) {
    const source = { ok: false, continuation: { tool: 'o11_deliver', arguments: { authorize: marker } },
      authorize: 'SYNTHETIC_FIELD', nested: { credentials: 'SYNTHETIC_FIELD' } };
    const clean = tasks.sanitizeAnswer({ structuredContent: source, content: [{ type: 'text', text: JSON.stringify(source) }] });
    assert.equal(clean.structuredContent.continuation.arguments.authorize, marker);
    assert.equal(JSON.parse(clean.content[0].text).continuation.arguments.authorize, marker);
    assert.equal(clean.structuredContent.authorize, undefined);
    assert.equal(clean.structuredContent.nested.credentials, undefined);
    assert.equal(tasks.scrub(source).continuation.arguments.authorize, undefined, 'record scrub remains strict');
  }
});
