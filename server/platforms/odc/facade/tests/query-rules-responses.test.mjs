// Data-access rules of 2026-10-09 (kernel QueryInLoopRule/AggregateConsolidationRule): the HIGH warnings never block a
// delivery (A03) but are always shown. Source helpers expose them first in warnings and on their own in highWarnings;
// the shared output policy removes that duplication in final MCP answers. These tests exercise the unchanged sources:
// compactDelivery, warningFields/taskWarnings and ssam_job/o11_job summary. Pure: no Studio, no CLI.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDelivery, shapeToolResult } from '../responses.mjs';
import { warningFields, taskWarnings, highWarningsOf } from '../delivery-warnings.mjs';
import { interpretKernelResult } from '../kernel-delivery.mjs';
import { summarize } from '../job-runner.mjs';

// What the kernel apply carries (ModelSession receipt field highWarnings).
const kernelHigh = [{ code: 'AGGREGATES_MERGEABLE', severity: 'high', op: 1, owner: 'QrSummary',
  message: 'GetOrder, GetOrderLines in \'QrSummary\' read related entities (QrLine.OrderId -> QrOrder) and are used together: one aggregate with a join would do',
  fix: 'replace them with the single aggregate of `suggestion`', suggestion: { get: 'QrOrder', sources: ['QrLine'] } }];
const verify = { id: 'UnusedElement', path: 'M / X', detail: 'not used', fix: 'Remova o elemento ou use-o.' };

test('the HIGH warnings come first and on their own field', () => {
  const [high] = highWarningsOf(kernelHigh);
  assert.equal(high.id, 'AGGREGATES_MERGEABLE');
  assert.equal(high.severity, 'high');
  assert.equal(high.path, 'QrSummary');
  assert.deepEqual(high.suggestion, { get: 'QrOrder', sources: ['QrLine'] });
  const fields = warningFields([verify, high]);
  assert.equal(fields.warnings[0].id, 'AGGREGATES_MERGEABLE');
  assert.deepEqual(fields.highWarnings, [high]);
  assert.deepEqual(warningFields([verify]), { warnings: [verify] });
});

test('compactDelivery keeps highWarnings on a delivered change and on a refusal', () => {
  const highWarnings = highWarningsOf(kernelHigh);
  const delivered = compactDelivery('studio_deliver', {}, { ok: true, merged: true, strictlyEqual: true, manifest: 'm.json', steps: [1], highWarnings, warnings: highWarnings });
  assert.deepEqual(delivered.highWarnings, highWarnings);
  const refused = compactDelivery('studio_deliver', {}, { ok: false, failed: 'build', error: 'x', highWarnings, warnings: highWarnings });
  assert.deepEqual(refused.highWarnings, highWarnings);
  // Through the MCP shaper too.
  const answer = { ok: true, merged: true, strictlyEqual: true, manifest: 'm.json', highWarnings };
  const shaped = shapeToolResult('studio_deliver', {}, { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer });
  assert.deepEqual(JSON.parse(shaped.content[0].text).highWarnings, highWarnings);
});

test('the ODC kernel result and the O11 task put the HIGH warnings first', () => {
  const read = interpretKernelResult({ ok: false, error: 'refused', data: { highWarnings: kernelHigh, validation: { verdicts: [] } } }, { output: 'C:/t/out' });
  assert.equal(read.warnings[0].severity, 'high');
  // The O11 task (Delivery.cs) already writes them first in warnings, in the I9 shape with severity high.
  const state = { warnings: [{ id: 'QUERY_IN_LOOP', severity: 'high', path: 'QrLegacy / ForEach1 / GetLines', detail: 'legacy', fix: 'move it', op: 0 }, verify] };
  const fields = warningFields(taskWarnings(state));
  assert.equal(fields.highWarnings.length, 1);
  assert.equal(fields.highWarnings[0].op, 0);
  // Before the task recorded them, the apply's own list.
  assert.equal(taskWarnings({ apply: { highWarnings: kernelHigh } })[0].id, 'AGGREGATES_MERGEABLE');
});

test('the job summary names the HIGH warnings, success or refusal', () => {
  const saved = { ok: true, via: 'worker', wallMs: 10, data: { accepted: true, isValid: true, ops: 2, highWarnings: kernelHigh } };
  const ok = summarize({ lane: 'o11', job: 'j.json', out: 'j.oml', resultFile: 'j.result.json', saved });
  assert.equal(ok.highWarnings[0].id, 'AGGREGATES_MERGEABLE');
  const refused = summarize({ lane: 'odc', job: 'j.json', out: 'j.oml', resultFile: 'j.result.json', saved: { ...saved, data: { ...saved.data, accepted: false } } });
  assert.equal(refused.highWarnings.length, 1);
  assert.equal(summarize({ lane: 'o11', job: 'j.json', out: 'j.oml', resultFile: 'r', saved: { ok: true, data: { accepted: true } } }).highWarnings, undefined);
});
