// R6: the refusal of a disposable merge that did not preserve the candidate (MERGE_CONTENT_LOSS) carries the diff itself:
// differences, at most 20 {element, path, candidate, merged}, and summary {elements, differences, ignoredByCanon}, from the
// kernel proof's firstDifferences and summary (MergeContentProof), or built from the differences of an older engine. The
// error names the first ones with both values; the whole proof stays in the evidence file. Offline: plain objects.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentLossRefusal, CONTENT_LOSS_DIFFERENCES } from '../kernel-delivery.mjs';

const preview = contentProof => ({ path: 'C:/lab/1/merge-content-preview.oml', sha256: 'ab', accepted: false, isValid: true, newErrors: 0, hasConflicts: false, contentProof });

test('the kernel diff comes as it is: at most 20 entries, the summary and the canonical identity it applied', () => {
  const firstDifferences = Array.from({ length: 20 }, (_, i) => ({ element: 'ServerAction:Calc/AssignNode' + i, path: '(element)', candidate: 'present', merged: 'absent', address: 'k' + i, kind: 'IAssignNode' }));
  const refusal = contentLossRefusal(preview({ accepted: false, checked: 900, differences: Array.from({ length: 140 }, () => ({})), firstDifferences,
    summary: { elements: 24, differences: 140, missingElements: 20, unexpectedElements: 0, ignoredByCanon: 1306 }, canon: { reboundTotal: 25 } }), 'C:/lab/1/merge-order.json');
  assert.equal(refusal.differences.length, CONTENT_LOSS_DIFFERENCES);
  assert.deepEqual(refusal.differences[0], { element: 'ServerAction:Calc/AssignNode0', path: '(element)', candidate: 'present', merged: 'absent' });
  assert.deepEqual(refusal.summary, { elements: 24, differences: 140, ignoredByCanon: 1306, missingElements: 20, unexpectedElements: 0 });
  assert.match(refusal.error, /140 difference\(s\) between the candidate and the merged module in 24 element\(s\) \(1306 more were only the merge's own keys\): ServerAction:Calc\/AssignNode0 missing in the merged module;/);
  assert.match(refusal.error, /Nothing was merged\.$/);
  assert.equal(refusal.contentPreview.differencesTotal, 140);
  assert.deepEqual(refusal.contentPreview.canon, { reboundTotal: 25 });
  assert.equal(refusal.continuation.tool, 'ssam_evidence');
  assert.equal(refusal.continuation.arguments.pointer, '/contentPreview/contentProof/differences');
});

test('an older engine without firstDifferences still answers the diff, built from its differences', () => {
  const differences = Array.from({ length: 30 }, (_, i) => ({ element: 'MobileFlow:Main/MobileScreen:Options/IfWidget' + i, property: '$expression', expectedValue: 'A > ' + i, actualValue: 'A >= ' + i }));
  differences.push({ element: 'ServerAction:Save/EndNode', property: '$kind', missing: true, unexpected: false });
  const refusal = contentLossRefusal(preview({ accepted: false, checked: 10, differences }), 'merge-order.json');
  assert.equal(refusal.differences.length, 20);
  assert.deepEqual(refusal.differences[1], { element: 'MobileFlow:Main/MobileScreen:Options/IfWidget1', path: '$expression', candidate: 'A > 1', merged: 'A >= 1' });
  assert.deepEqual(refusal.summary, { elements: 31, differences: 31, ignoredByCanon: null });
  assert.match(refusal.error, /IfWidget0 \$expression: A > 0 -> A >= 0/);
  const missing = contentLossRefusal(preview({ accepted: false, differences: [differences.at(-1)] }), 'merge-order.json');
  assert.deepEqual(missing.differences, [{ element: 'ServerAction:Save/EndNode', path: '$kind', candidate: 'present', merged: 'absent' }]);
  assert.match(missing.error, /ServerAction:Save\/EndNode \$kind\. Nothing was merged\./);
});

test('a conflict or a new error is the reason, never a list of differences the proof did not find', () => {
  const conflicted = contentLossRefusal({ ...preview({ accepted: false, differences: [] }), hasConflicts: true }, 'merge-order.json');
  assert.match(conflicted.error, /the native merge has conflicts\. Nothing was merged\.$/);
  assert.deepEqual(conflicted.differences, []);
  const broken = contentLossRefusal({ ...preview({ accepted: true, differences: [] }), newErrors: 2 }, 'merge-order.json');
  assert.match(broken.error, /2 new error\(s\) after the native merge/);
});
