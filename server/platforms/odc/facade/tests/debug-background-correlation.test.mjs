import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundThreadOutcome, backgroundValuesCoverage } from '../debug-background-correlation.mjs';

const F = 'F'.repeat(22), A = 'a'.repeat(64), B = 'b'.repeat(64);
const frame = (threadId, eventId, fingerprint, over = {}) => ({ threadId, eventId, functionKey: F,
  ...(fingerprint ? { nativeRequestIdSha256: fingerprint } : {}), ...over });
const end = (threadId, eventId, fingerprint) => ({ kind: 'thread-end', threadId, eventId, ...(fingerprint ? { nativeRequestIdSha256: fingerprint } : {}) });

test('ThreadEnd attests only the same (threadId, request fingerprint) with a later eventId', () => {
  const bound = backgroundThreadOutcome([frame('T', '5', A), frame('T', '7', A), end('T', '9', A)], F);
  assert.equal(bound.traceVerified, true); assert.equal(bound.requestBound, true);
  assert.equal(bound.requestFingerprintConsistent, true); assert.deepEqual(bound.fingerprints, [A]);
  assert.deepEqual(bound.endedFingerprints, [A]); assert.equal(bound.unmatchedEnds, 0);
  assert.equal(bound.executionCompleted, false, 'a native ThreadEnd carries no outcome');
});

test('a reused threadId with a different fingerprint never attests the end', () => {
  const reused = backgroundThreadOutcome([frame('T', '5', A), end('T', '9', B)], F);
  assert.equal(reused.traceVerified, false); assert.equal(reused.requestBound, false);
  assert.equal(reused.observedThreadEnds, 0); assert.equal(reused.unmatchedEnds, 1);
  // The second request on the same thread still matches its own end.
  const both = backgroundThreadOutcome([frame('T', '5', A), end('T', '6', A), frame('T', '8', B), end('T', '9', B)], F);
  assert.equal(both.requestFingerprintConsistent, false); assert.equal(both.requestBound, false);
  assert.deepEqual(both.endedFingerprints.sort(), [A, B]); assert.equal(both.unmatchedEnds, 0);
});

test('a missing fingerprint gives traceVerified but requestBound=false', () => {
  for (const lines of [[frame('T', '5'), end('T', '9', A)], [frame('T', '5', A), end('T', '9')], [frame('T'), end('T')]]) {
    const result = backgroundThreadOutcome(lines, F);
    assert.equal(result.traceVerified, true); assert.equal(result.requestBound, false); assert.equal(result.requestBoundThreadEnds, 0);
  }
  // Provenance false is not a fingerprint.
  const unproved = backgroundThreadOutcome([frame('T', '5', A, { nativeRequestIdProvenance: false }), end('T', '9', A)], F);
  assert.equal(unproved.requestBound, false); assert.deepEqual(unproved.fingerprints, []);
});

test('an end before the last frame eventId is refused, also without fingerprints', () => {
  const early = backgroundThreadOutcome([frame('T', '5', A), frame('T', '12', A), end('T', '9', A)], F);
  assert.equal(early.traceVerified, false); assert.equal(early.requestBound, false); assert.equal(early.unmatchedEnds, 1);
  assert.equal(backgroundThreadOutcome([frame('T', '12'), end('T', '9')], F).traceVerified, false);
  // A bound end needs comparable native event ids.
  const unordered = backgroundThreadOutcome([frame('T', undefined, A), end('T', '9', A)], F);
  assert.equal(unordered.requestBound, false); assert.equal(unordered.traceVerified, false);
});

test('other functions and other threads never contribute frames or ends', () => {
  const result = backgroundThreadOutcome([frame('T', '5', A, { functionKey: 'G'.repeat(22) }), end('T', '9', A), end('U', '9', A)], F);
  assert.equal(result.captured, false); assert.equal(result.traceVerified, false); assert.equal(result.unmatchedEnds, 0);
  assert.throws(() => backgroundThreadOutcome(null, F), /lines_invalid/);
});

// Server scope reads mirror NativeInspection.ReadEvaluated/Describe output.
const ctx = (eventId = '7') => ({ runtime: 'server', threadId: 'T', eventId, generation: 1 });
const variable = (reference, name, category = 'local') => ({ reference, name, category });
const value = (reference, path, over = {}) => ({ reference, path, category: 'local', type: 'Scalar', value: '1', textOffset: 0, textLength: 1,
  nextTextOffset: null, valueComplete: true, nativeSummary: false, redacted: false, unavailable: false, undefined: false,
  trimmed: false, deferred: false, hasChildren: false, ...over });
const read = (reference, v, eventId = '7', over = {}) => ({ ok: true, context: ctx(eventId), reference, value: v, children: [], offset: 0,
  nextOffset: null, availableChildren: 0, deferred: false, nativeTrimmed: false, redacted: false, ...over });

test('background values coverage is computed per root from native reads, never forced', () => {
  const scope = [variable('r1', 'Count'), variable('r2', 'Timers.Nightly', 'site'), variable('r3', 'Secret')];
  const first = { scopeVariables: scope, reads: [read('r1', value('r1', 'Count', { valueComplete: false, value: null, textLength: null, unavailable: false, undefined: false })),
    read('r2', value('r2', 'Timers.Nightly', { valueComplete: false, undefined: true, value: '-undefined-' })),
    read('r3', value('r3', 'Secret', { redacted: true, valueComplete: false }))] };
  const second = { scopeVariables: scope, reads: [read('r1', value('r1', 'Count'), '9')] };
  const coverage = backgroundValuesCoverage({ modelRoots: ['Count', 'Secret'], stops: [first, second] });
  assert.equal(coverage.valuesComplete, false);
  assert.deepEqual(coverage.roots.map(r => [r.name, r.state]), [['Count', 'complete'], ['Secret', 'redacted'], ['Timers.Nightly', 'native-unavailable']]);
  assert.deepEqual(coverage.nativeUnavailableRoots.map(r => r.name), ['Timers.Nightly']);
  assert.deepEqual(coverage.nativeUnavailableRoots[0].evidence, [{ reason: 'native-undefined', flag: 'undefined' }]);
  assert.deepEqual(coverage.redactedRoots.map(r => r.name), ['Secret']);
  assert.equal(coverage.valuesReturned, false);
  assert.doesNotMatch(JSON.stringify(coverage), /-undefined-/);
});

test('every root read complete at least once publishes valuesComplete; missing or omitted roots keep it false', () => {
  const scope = [variable('r1', 'Count'), variable('r2', 'Name')];
  const stops = [{ scopeVariables: scope, reads: [read('r1', value('r1', 'Count'))] },
    { scopeVariables: scope, reads: [read('r2', value('r2', 'Name'), '9')] }];
  assert.equal(backgroundValuesCoverage({ modelRoots: ['Count', 'Name'], stops }).valuesComplete, true);
  assert.equal(backgroundValuesCoverage({ modelRoots: ['Count', 'Name'], stops, omittedRoots: 1 }).valuesComplete, false);
  const missing = backgroundValuesCoverage({ modelRoots: ['Count', 'Name', 'Other'], stops });
  assert.equal(missing.valuesComplete, false); assert.equal(missing.roots.find(r => r.name === 'Other').state, 'not-enumerated');
  assert.equal(backgroundValuesCoverage({ modelRoots: ['Count'], stops: [] }).valuesComplete, false);
  // A stale read inside one stop invalidates that stop only.
  const stale = backgroundValuesCoverage({ modelRoots: ['Count'], stops: [{ scopeVariables: [variable('r1', 'Count'), variable('r2', 'B')],
    reads: [read('r1', value('r1', 'Count')), read('r2', value('r2', 'B'), '8')] }] });
  assert.equal(stale.valuesComplete, false); assert.equal(stale.invalidStops, 1);
});
