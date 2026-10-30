import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitAnswer } from '../answer-size.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';

const bytes = v => Buffer.byteLength(JSON.stringify(v));
const ceiling = 9216;
const rootOf = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-answers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const calls = value => {
  const found = [];
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (v.tool === 'ssam_evidence') found.push(v);
    for (const child of Object.values(v)) walk(child);
  };
  walk(value);
  return found;
};
test('R1: 120 repeated messages remain individually represented with one list recovery', t => {
  const root = rootOf(t);
  const messages = Array.from({ length: 120 }, (_, i) => ({ code: 'INVALID', element: `Element${i}`, message: 'The assigned value has the wrong type. '.repeat(15) }));
  const full = { ok: false, code: 'VALIDATION_FAILED', messages };
  const result = fitAnswer('future_validate', {}, full, { root });
  assert.ok(bytes(result) <= ceiling);
  assert.equal(result.messages.length + (result.messagesLeft ?? 0), 120);
  assert.ok(result.messages.every(x => x.message && (x.element || x.at)));
  assert.equal(calls(result).length, 1);
  assert.equal(result.omitted.arguments.pointer, '/messages');
  assert.equal(result.omitted.arguments.offset, undefined, 'the recovery includes full text of compacted visible items');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.omitted.arguments.file, 'utf8')), full);
  assert.deepEqual(Object.keys(result).slice(0, 3), ['ok', 'code', 'messages']);
  assert.equal(fitAnswer('future_validate', {}, result, { root }), result);
});
test('R1: forty problems are not grouped and precede a large refusal envelope', t => {
  const root = rootOf(t);
  const problems = Array.from({ length: 40 }, (_, i) => ({ code: 'TYPE_INVALID', pointer: `/actions/A${i}`, message: 'The value cannot be assigned to this input. '.repeat(20) }));
  const result = fitAnswer('o11_deliver', {}, { trace: 'x'.repeat(40000), ok: false, code: 'REFUSED', problems, continuation: { tool: 'ssam_discover', arguments: { intent: 'fix types' } } }, { root });
  assert.ok(bytes(result) <= ceiling);
  assert.equal(result.problems.length + (result.problemsLeft ?? 0), 40);
  assert.equal(result.grouped, undefined);
  assert.ok(Object.keys(result).indexOf('problems') < Object.keys(result).indexOf('continuation'));
  assert.equal(calls(result).filter(c => /^\/problems\//.test(c.arguments.pointer)).length, 0);
});
test('R1: scalar identities stay inline beside grouped large subtrees', t => {
  const root = rootOf(t);
  const full = { ok: true, jobSha256: 'a'.repeat(64), id: 'job-42', count: 12, verifyRan: false,
    payload: { ok: true, sha256: 'b'.repeat(64), data: 'x'.repeat(40000) }, notes: 'y'.repeat(40000) };
  const result = fitAnswer('future_tool', {}, full, { root });
  assert.ok(bytes(result) <= ceiling);
  for (const key of ['ok', 'jobSha256', 'id', 'count', 'verifyRan']) assert.equal(result[key], full[key]);
  assert.equal(result.payload.sha256, full.payload.sha256);
  assert.ok(calls(result).every(c => !/\/(ok|jobSha256|id|count|verifyRan|sha256)$/.test(c.arguments.pointer)));
});
test('R1: short message text is never deduplicated as prose in any tool family', t => {
  const root = rootOf(t);
  const message = 'This validation message must be retained for each affected element.';
  for (const tool of ['o11_studio', 'ssam_map', 'ssam_reference', 'future_tool']) {
    const full = { ok: true, messages: [{ message, element: 'A' }, { message, element: 'B' }] };
    assert.deepEqual(fitAnswer(tool, {}, full, { root }).messages, full.messages);
  }
  const input = { description: 'Validation completed.', messages: [{ message, element: 'A' }], code: 'DONE', ok: true };
  const ordered = fitAnswer('future_tool', {}, input, { root });
  assert.deepEqual(Object.keys(ordered).slice(0,3), ['ok', 'code', 'messages']);
  assert.equal(fitAnswer('future_tool', {}, ordered, { root }), ordered);
});
test('R1: the one ready list continuation is accepted by the evidence reader', async t => {
  const root = rootOf(t);
  const errors = Array.from({ length: 120 }, (_, i) => ({ code: `E${i}`, element: `Element${i}`, message: 'Invalid value. '.repeat(40) }));
  const result = fitAnswer('future_tool', {}, { ok: true, errors }, { root });
  assert.equal(calls(result).length, 1);
  const reader = createEvidenceReader({ roots: [root] });
  const answer = await reader.read(result.omitted.arguments);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.ok(answer.items?.length || answer.value?.length, JSON.stringify(answer));
});
test('R1: nested diagnostic lists and equivalent field names retain their messages', t => {
  const root = rootOf(t);
  for (const key of ['newErrors', 'validationWarnings', 'diagnostics']) {
    const entries = Array.from({ length: 100 }, (_, i) => ({ code: `E${i}`, element: `Node${i}`, message: 'The input requires a value. '.repeat(80) }));
    const result = fitAnswer('future_tool', {}, { ok: true, result: { [key]: entries, id: 'result-1' } }, { root });
    assert.ok(bytes(result) <= ceiling);
    assert.equal(result.result.id, 'result-1');
    assert.equal(result.result[key].length + (result.result[key + 'Left'] ?? 0), 100);
    assert.ok(result.result[key].every(entry => entry.message), 'every occurrence keeps its message');
    assert.equal(calls(result).length, 1);
    assert.equal(result.omitted.arguments.pointer, `/result/${key}`);
  }
  const messages = Array.from({ length: 120 }, (_, i) => ({ code: `E${i}`, message: 'A validation message. '.repeat(40) }));
  const phases = fitAnswer('future_tool', {}, { ok: true, phases: [{ name: 'validation', errors: messages, detail: 'detail '.repeat(5000) }] }, { root });
  assert.ok(bytes(phases) <= ceiling);
  assert.equal(phases.phases[0].errors.length + (phases.phases[0].errorsLeft ?? 0), 120);
  assert.ok(phases.phases[0].errors.every(entry => entry.message));
  assert.equal(phases.omitted.arguments.pointer, '/phases/0/errors');
});
test('R1: oversized continuation documents respect the configured ceiling', t => {
  const root = rootOf(t);
  const result = fitAnswer('future_tool', {}, { ok: false, code: 'REFUSED', problems: [{ code: 'INVALID', message: 'Correct the value.' }],
    continuation: { tool: 'future_tool', arguments: { id: 'job-1', source: 'source line\n'.repeat(5000) } } }, { root, visibleBytes: 4096 });
  assert.ok(bytes(result) <= 4096);
  assert.equal(result.continuation.omitted, true);
  assert.equal(result.continuation.read.tool, 'ssam_evidence');
  assert.equal(result.problems.length, 1);
  assert.equal(result.continuation.read.arguments.pointer, '/continuation');
});
test('R1: a legacy oversized fitted envelope is brought below the ceiling', t => {
  const root = rootOf(t);
  const full = { ok: true, notes: 'long detail '.repeat(2000), omitted: { tool: 'ssam_evidence', arguments: { file: 'previous.json', pointer: '/messages' } } };
  const result = fitAnswer('future_tool', {}, full, { root });
  assert.ok(bytes(result) <= ceiling);
  assert.equal(fitAnswer('future_tool', {}, result, { root }), result);
});
test('R1: many large sibling documents share one bounded recovery call', t => {
  const root = rootOf(t);
  const full = { ok: true, id: 'identity', ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`document${i}`, 'long text '.repeat(100)])) };
  const result = fitAnswer('future_tool', {}, full, { root });
  assert.ok(bytes(result) <= ceiling);
  assert.equal(result.id, full.id);
  assert.equal(calls(result).length, 1);
  assert.equal(result.omitted.arguments.pointer, '');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.omitted.arguments.file, 'utf8')), full);
});
test('R1: packet and verbatim readers do not bypass the refusal ceiling', t => {
  const root = rootOf(t);
  const full = { ok: false, code: 'REFUSED', problems: Array.from({ length: 120 }, (_, i) => ({ code: 'INVALID', element: `Item${i}`, message: 'The value must be corrected. '.repeat(50) })) };
  for (const [tool, args] of [['ssam_discover', { packet: true }], ['ssam_evidence', {}]]) {
    const result = fitAnswer(tool, args, full, { root });
    assert.ok(bytes(result) <= ceiling);
    assert.equal(result.problems.length + (result.problemsLeft ?? 0), 120);
    assert.equal(calls(result).length, 1);
  }
});
