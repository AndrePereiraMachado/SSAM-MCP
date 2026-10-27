import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryOutcome, deliverOutcome } from '../o11-cycle.mjs';

test('a refused disposable merge is not a live merge and exposes its complete evidence', () => {
  // The kernel's code decides (Delivery.cs MERGE_CONTENT_PREVIEW_REFUSED), never the proof flag alone (review of 3ab12209, H1).
  const state = { code: 'MERGE_CONTENT_PREVIEW_REFUSED', delivered: true, writeState: 'not-sent', mergeContentPreview: { accepted: false,
    contentProof: { accepted: false, differences: Array.from({ length: 25 }, (_, i) => ({ objectKey: String(i), property: '$parent' })) } } };
  assert.equal(deliveryOutcome(state), 'refused');
  const value = deliverOutcome({ envelope: { data: state } }, { work: '.', job: null });
  assert.equal(value.code, 'MERGE_CONTENT_PREVIEW_REFUSED');
  assert.equal(value.merged, false);
  assert.equal(value.mergeContentPreview.contentProof.differences.length, 20);
  assert.equal(value.mergeContentPreview.contentProof.differencesTotal, 25);
  assert.equal(value.continuation.arguments.pointer, '/mergeContentPreview');
  assert.equal(deliveryOutcome({ ...state, code: undefined, delivered: false, writeState: 'unknown' }), 'uncertain', 'a stale preview does not reconcile a live write');
});

test('a failed integrity proof overrides even a contradictory delivered flag and points to read-only evidence', () => {
  const state = { code: 'MERGE_CONTENT_MISMATCH', delivered: true, writeState: 'applied', contentProof: { accepted: false,
    differences: Array.from({ length: 25 }, (_, i) => ({ objectKey: String(i), property: 'DataSource' })) } };
  assert.equal(deliveryOutcome(state), 'refused');
  const value = deliverOutcome({ envelope: { data: state } }, { work: '.', job: null });
  assert.equal(value.ok, false);
  assert.equal(value.code, 'MERGE_CONTENT_MISMATCH');
  assert.equal(value.merged, true);
  assert.equal(value.contentProof.differences.length, 20);
  assert.equal(value.contentProof.differencesTotal, 25);
  assert.equal(value.continuation.tool, 'ssam_evidence');
  assert.equal(value.continuation.arguments.pointer, '/contentProof');
});

test('a successful integrity proof survives the compact delivery receipt', () => {
  const proof = { accepted: true, checked: 9, differences: [] };
  const value = deliverOutcome({ envelope: { data: { delivered: true, contentProof: proof,
    mergeContentPreview: { accepted: true, path: 'preview.oml', sha256: 'abc', contentProof: proof } } } }, { work: '.', job: null });
  assert.equal(value.ok, true);
  // The verdict and counts, with the evidence pointer to the whole proof (review of 3ab12209, L4).
  assert.equal(value.contentProof.accepted, true); assert.equal(value.contentProof.checked, 9); assert.equal(value.contentProof.differencesTotal, 0);
  assert.equal(value.contentProof.evidence.arguments.pointer, '/contentProof');
  assert.equal(value.mergeContentPreview.accepted, true);
  assert.equal(value.mergeContentPreview.checked, 9);
  assert.equal(value.mergeContentPreview.evidence.arguments.pointer, '/mergeContentPreview');
});

test('a truncated rollback error always links the complete task receipt', () => {
  const state = { delivered: false, code: 'MERGE_ROLLED_BACK', work: 'C:/audit/task', writeState: 'not-applied', error: 'native cause '.repeat(150) };
  const value = deliverOutcome({ envelope: { data: state } }, { work: '.', job: null });
  assert.ok(value.error.length < state.error.length);
  assert.equal(value.evidence.tool, 'ssam_evidence');
  assert.match(value.evidence.arguments.file, /result\.json$/);
});
