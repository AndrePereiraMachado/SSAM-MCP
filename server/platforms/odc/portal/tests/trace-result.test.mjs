import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTraceResult } from '../runtime/trace-result.mjs';
import { redact } from '../runtime/errors.mjs';

const span = (id, parent = '', changes = {}) => ({ TraceId: 'trace-1', SpanId: id, ParentSpanId: parent,
  SpanName: id, StartTimeUnixNano: '1720000000000000001', EndTimeUnixNano: '1720000000000000011', ...changes });
const result = (rows, status = 'Finished') => ({ SpansList: { traceProcessingStatus: status, MON_SpanItemList: { List: rows } }, ExceptionMessage: '' });
const options = { traceId: 'trace-1', maxSpans: 1000 };

test('trace spans produce parent hierarchy and exact nanosecond timeline without Number precision loss', () => {
  const actual = normalizeTraceResult(result([span('child', 'root', { StartTimeUnixNano: '1720000000000000003' }), span('root')]), options);
  assert.equal(actual.complete, true);
  assert.deepEqual(actual.hierarchy.roots, ['root']);
  assert.deepEqual(actual.hierarchy.edges, [{ parentSpanId: 'root', spanId: 'child' }]);
  assert.equal(actual.timeline[1].offsetNanoseconds, '2');
  assert.equal(actual.timeline[1].durationNanoseconds, '8');
  assert.equal(actual.serverClaimsComplete, true);
});

test('server processing or missing-span states never appear complete', () => {
  for (const status of ['Processing', 'FinishedWithMissingSpans', 'FinishedWithMissingRootSpan', '', 'FutureState']) {
    const actual = normalizeTraceResult(result([span('root')], status), options);
    assert.equal(actual.complete, false); assert.equal(actual.serverClaimsComplete, false);
    assert.ok(actual.incompleteReasons.length);
  }
});

test('duplicate, missing parent/root and cyclic graphs remain bounded and explicitly incomplete', () => {
  const duplicate = normalizeTraceResult(result([span('root'), span('root')]), options);
  assert.equal(duplicate.returnedSpanCount, 1); assert.ok(duplicate.incompleteReasons.includes('duplicate_span_ids'));
  const missing = normalizeTraceResult(result([span('child', 'absent')]), options);
  assert.ok(missing.incompleteReasons.includes('missing_parent_spans')); assert.ok(missing.incompleteReasons.includes('missing_root_span'));
  const cycle = normalizeTraceResult(result([span('root'), span('a', 'b'), span('b', 'a')]), options);
  assert.deepEqual(cycle.hierarchy.cyclicSpanIds.sort(), ['a', 'b']); assert.equal(cycle.complete, false);
});

test('local span limit and malformed timing are visible rather than silently complete', () => {
  const limited = normalizeTraceResult(result([span('root'), span('child', 'root')]), { ...options, maxSpans: 1 });
  assert.equal(limited.truncated, true); assert.equal(limited.receivedSpanCount, 2); assert.equal(limited.complete, false);
  const bad = normalizeTraceResult(result([span('root', '', { EndTimeUnixNano: '1' })]), options);
  assert.equal(bad.timeline.length, 0); assert.ok(bad.incompleteReasons.includes('invalid_or_missing_timing'));
});

test('trace projection omits arbitrary attributes, URLs, user identifiers and credential-bearing text', () => {
  const actual = normalizeTraceResult(result([span('root', '', { Attributes: { Password: 'private' }, UserId: 'person', UserName: 'name',
    Url: 'https://example.invalid/?token=secret', Extra: 'private', StatusMessage: 'Bearer abc.def.ghi' })]), options);
  for (const field of ['Attributes', 'UserId', 'UserName', 'Url', 'Extra']) assert.equal(actual.spans[0][field], undefined);
  assert.equal(actual.spans[0].StatusMessage, 'Bearer abc.def.ghi');
  assert.ok(!JSON.stringify(redact(actual)).includes('abc.def.ghi'));
});

test('foreign trace, malformed contract and unsafe limits fail without returning payload values', () => {
  assert.throws(() => normalizeTraceResult(result([span('root', '', { TraceId: 'foreign-secret' })]), options), { code: 'PORTAL_BROKER_SCOPE_MISMATCH' });
  assert.throws(() => normalizeTraceResult({ SpansList: [] }, options), { code: 'PORTAL_CONTRACT_CHANGED' });
  assert.throws(() => normalizeTraceResult(result([span('root')]), { ...options, maxSpans: 1001 }), { code: 'INPUT_INVALID' });
  assert.throws(() => normalizeTraceResult({ ExceptionMessage: 'confidential error' }, options), { code: 'PORTAL_RESPONSE_INVALID' });
});
