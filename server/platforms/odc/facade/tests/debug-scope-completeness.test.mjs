import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeCompleteness, rootCoverage, completenessBinding, scopeLeafReasons } from '../debug-scope-completeness.mjs';

// Server fixtures mirror NativeInspection.ReadEvaluated/Describe output.
const ctx = (over = {}) => ({ runtime: 'server', threadId: 'T1', eventId: '7', frame: 0, generation: 3,
  moduleKey: 'M'.repeat(22), functionKey: 'F'.repeat(22), nodeKey: 'N'.repeat(22), ...over });
const stop = { threadId: 'T1', eventId: '7' };
const described = (reference, path, value, over = {}) => ({ reference, path, category: 'local', type: 'Scalar', value,
  textOffset: 0, textLength: typeof value === 'string' ? value.length : null, nextTextOffset: null,
  valueComplete: true, nativeSummary: false, redacted: false, unavailable: false, undefined: false,
  trimmed: false, deferred: false, hasChildren: false, ...over });
const compound = (reference, path, type = 'Record', over = {}) => described(reference, path, null,
  { type, textLength: null, valueComplete: false, hasChildren: true, ...over });
const read = (reference, value, over = {}) => ({ ok: true, context: ctx(), reference, evaluationRevision: 1, changed: null,
  value, children: [], offset: 0, nextOffset: null, availableChildren: 0, nativeEvaluationDetail: 2,
  collectionCoverage: null, deferred: false, nativeTrimmed: false, redacted: false, ...over });
const root = (reference, name, category = 'local') => ({ reference, name, category, moduleKey: 'M'.repeat(22),
  functionKey: 'F'.repeat(22), variableKey: 'V'.repeat(22), source: 'published-model', sourceSha256: 'a'.repeat(64) });
const coverage = counts => ({ sourceSha256: 'a'.repeat(64), authority: 'installed-model-scope-and-watchability',
  modelScopeEnumerated: true, runtimeFrameBound: true, variableCounts: counts, runtimeValuesComplete: false });
const server = (scopeVariables, reads, counts = { local: scopeVariables.filter(v => v.category !== 'return').length }) =>
  scopeCompleteness({ lane: 'o11', runtime: 'server', stop, generation: 3, metadataCoverage: coverage(counts), scopeVariables, reads });
const reasons = result => result.incompleteLeaves.map(l => l.reason);

test('Record root fully read is treeComplete; a missing children page is page-pending', () => {
  const rec = read('r1', compound('r1', 'Rec'), { availableChildren: 2,
    children: [described('c1', 'Rec.A', '1'), described('c2', 'Rec.B', '"x"')] });
  const done = server([root('r1', 'Rec')], [rec]);
  assert.equal(done.ok, true); assert.equal(done.roots[0].treeComplete, true);
  assert.equal(done.runtimeValuesComplete, true); assert.equal(done.residualNativeLimitsOnly, false);
  assert.deepEqual(done.incompleteLeaves, []);
  const first = read('r1', compound('r1', 'Rec'), { availableChildren: 3, nextOffset: 2,
    children: [described('c1', 'Rec.A', '1'), described('c2', 'Rec.B', '"x"')] });
  const pending = server([root('r1', 'Rec')], [first]);
  assert.equal(pending.roots[0].treeComplete, false); assert.deepEqual(reasons(pending), ['page-pending']);
  assert.equal(pending.runtimeValuesComplete, false); assert.equal(pending.residualNativeLimitsOnly, false);
  const tail = read('r1', compound('r1', 'Rec'), { availableChildren: 3, offset: 2, children: [described('c3', 'Rec.C', '2')] });
  assert.equal(server([root('r1', 'Rec')], [first, tail]).runtimeValuesComplete, true);
  // A compound child needs its own native read; the parent page does not prove its leaves.
  const nested = read('r1', compound('r1', 'Rec'), { availableChildren: 1, children: [compound('c4', 'Rec.Inner')] });
  const unread = server([root('r1', 'Rec')], [nested]);
  assert.deepEqual(unread.incompleteLeaves.map(l => [l.reference, l.reason]), [['c4', 'not-read']]);
  const inner = read('c4', compound('c4', 'Rec.Inner'), { availableChildren: 1, children: [described('c5', 'Rec.Inner.X', '0')] });
  assert.equal(server([root('r1', 'Rec')], [nested, inner]).runtimeValuesComplete, true);
});

test('RecordList with 151 items and 150 enumerated by the container stays page-pending until the tail page', () => {
  const items = from => Array.from({ length: from[1] - from[0] }, (_, i) => described('i' + (from[0] + i), 'Rows.[' + (from[0] + i) + ']', String(from[0] + i)));
  const coverage151 = { declaredLength: 151, enumeratedItems: 150, complete: false, missingItems: 1, source: 'native-container-length-and-indexed-children' };
  const head = read('l1', compound('l1', 'Rows', 'RecordList'), { availableChildren: 152, nextOffset: 150, collectionCoverage: coverage151,
    children: [described('len', 'Rows.Length', '151'), ...items([0, 149])] });
  const pending = server([root('l1', 'Rows')], [head]);
  assert.deepEqual(reasons(pending), ['page-pending']); assert.equal(pending.runtimeValuesComplete, false);
  const tailPage = read('l1', compound('l1', 'Rows', 'RecordList'), { offset: 150, availableChildren: 152, collectionCoverage: coverage151,
    children: items([149, 151]) });
  const complete = server([root('l1', 'Rows')], [head, tailPage]);
  assert.equal(complete.runtimeValuesComplete, true); assert.equal(complete.roots[0].treeComplete, true);
  // A list whose native Length is unknown cannot prove its item count.
  const unknown = read('l1', compound('l1', 'Rows', 'RecordList'), { availableChildren: 1, children: [described('i0', 'Rows.[0]', '0')],
    collectionCoverage: { ...coverage151, declaredLength: null, missingItems: null } });
  assert.deepEqual(reasons(server([root('l1', 'Rows')], [unknown])), ['page-pending']);
});

test('native sentinels use native flags only; quoted Text that spells a sentinel stays complete data', () => {
  const unavailable = read('u1', described('u1', 'Missing', '-unavailable in current context-', { unavailable: true, valueComplete: false }));
  const r = server([root('u1', 'Missing')], [unavailable]);
  assert.deepEqual(reasons(r), ['native-unavailable-in-context']);
  assert.equal(r.runtimeValuesComplete, false); assert.equal(r.residualNativeLimitsOnly, true);
  assert.equal(r.nativeLimits[0].evidence.flag, 'unavailable');
  const quoted = read('q1', described('q1', 'Description', '"-undefined-"'));
  assert.equal(server([root('q1', 'Description')], [quoted]).runtimeValuesComplete, true);
  const undef = read('t1', described('t1', 'Timers.ProbeTimer', '-undefined-', { category: 'timer', undefined: true, valueComplete: false }));
  assert.deepEqual(reasons(server([{ ...root('t1', 'ProbeTimer', 'timer') }], [undef], { timer: 1 })), ['native-undefined']);
});

test('BinaryData summary is never complete; redaction is policy, not a native limit', () => {
  const binary = read('b1', described('b1', 'File', 'BinaryData (256 bytes)', { nativeSummary: true, valueComplete: false }));
  const b = server([root('b1', 'File')], [binary]);
  assert.deepEqual(reasons(b), ['native-binary-summary']); assert.equal(b.runtimeValuesComplete, false); assert.equal(b.residualNativeLimitsOnly, true);
  const redacted = read('p1', described('p1', 'Password', '[redacted]', { redacted: true, valueComplete: false }), { redacted: true });
  const p = server([root('p1', 'Password'), root('b1', 'File')], [redacted, binary]);
  assert.deepEqual(reasons(p).sort(), ['native-binary-summary', 'private-redacted']);
  assert.equal(p.runtimeValuesComplete, false); assert.equal(p.residualNativeLimitsOnly, false);
  assert.deepEqual(p.policyRedactions.map(x => [x.reference, x.privateReadObserved]), [['p1', false]]);
  // A private-read at the same stop is recorded but never turns into a public value.
  const privateRead = { ok: true, context: ctx(), reference: 'p1', evaluationRevision: 2, changed: null, valueComplete: false,
    privateValueReturnedPublicly: false, privatePayload: { sealed: 'opaque' } };
  const withPrivate = server([root('p1', 'Password')], [redacted, privateRead]);
  assert.equal(withPrivate.policyRedactions[0].privateReadObserved, true); assert.equal(withPrivate.runtimeValuesComplete, false);
  // A blocked compound (sensitive name) returns no children and stays redacted.
  const blocked = read('k1', compound('k1', 'Credentials'), { redacted: true });
  assert.deepEqual(reasons(server([root('k1', 'Credentials')], [blocked])), ['private-redacted']);
});

test('text pages, deferred, trimmed, unread and budget-omitted leaves are explicit', () => {
  const long = 'x'.repeat(9004);
  const page = (offset, next) => read('d1', described('d1', 'Description', long.slice(offset, next ?? long.length),
    { textOffset: offset, textLength: long.length, nextTextOffset: next, valueComplete: false }));
  assert.deepEqual(reasons(server([root('d1', 'Description')], [page(0, 4096)])), ['text-pending']);
  assert.deepEqual(reasons(server([root('d1', 'Description')], [page(0, 4096), page(8192, null)])), ['text-pending']);
  assert.equal(server([root('d1', 'Description')], [page(0, 4096), page(4096, 8192), page(8192, null)]).runtimeValuesComplete, true);
  const deferred = read('e1', compound('e1', 'Deep', 'Record', { deferred: true, hasChildren: true }), { deferred: true });
  const trimmed = read('f1', described('f1', 'Big', 'abc', { trimmed: true, valueComplete: false }));
  const omitted = { ok: true, context: ctx(), reference: 'g1', omitted: true, reason: 'transport_budget' };
  const r = server([root('e1', 'Deep'), root('f1', 'Big'), root('g1', 'Huge'), root('h1', 'Never')], [deferred, trimmed, omitted]);
  assert.deepEqual(reasons(r), ['deferred', 'trimmed', 'budget-omitted', 'not-read']);
  assert.equal(r.residualNativeLimitsOnly, false);
  for (const reason of reasons(r)) assert.ok(scopeLeafReasons.includes(reason));
});

test('reads from another stop or an older generation are refused, never mixed', () => {
  const ok = read('r1', described('r1', 'A', '1'));
  assert.throws(() => server([root('r1', 'A')], [{ ...ok, context: ctx({ generation: 2 }) }]), /debug_scope_completeness_stale_read/);
  assert.throws(() => server([root('r1', 'A')], [{ ...ok, context: ctx({ eventId: '8' }) }]), /debug_scope_completeness_stale_read/);
  assert.throws(() => server([root('r1', 'A')], [{ ...ok, context: ctx({ threadId: 'T2' }) }]), /debug_scope_completeness_stale_read/);
  assert.throws(() => server([root('r1', 'A')], [{ ok: true, context: ctx(), values: [{ ...ok, context: ctx({ generation: 4 }) }] }]), /stale_read/);
  assert.throws(() => server([root('r1', 'A')], [{ ...ok, context: undefined }]), /read_context_missing/);
  assert.throws(() => scopeCompleteness({ lane: 'o11', runtime: 'server', stop, generation: 3, metadataCoverage: coverage({ local: 1 }),
    scopeVariables: { context: ctx({ generation: 2 }), variables: [root('r1', 'A')] }, reads: [ok] }), /stale_scope/);
  const batch = server([root('r1', 'A'), root('r2', 'B')], [{ ok: true, context: ctx(), values: [ok, read('r2', described('r2', 'B', '2'))] }]);
  assert.equal(batch.runtimeValuesComplete, true);
});

test('root counts must equal the frame-bound metadataCoverage; unbound coverage refuses', () => {
  const ok = read('r1', described('r1', 'A', '1'));
  const mismatch = server([root('r1', 'A')], [ok], { local: 2 });
  assert.equal(mismatch.ok, false); assert.equal(mismatch.refused, 'debug_scope_completeness_metadata_coverage_mismatch');
  assert.equal(mismatch.runtimeValuesComplete, false); assert.equal(mismatch.residualNativeLimitsOnly, false);
  assert.equal(mismatch.roots, undefined);
  const other = server([root('r1', 'A')], [ok], { local: 1, session: 1 });
  assert.equal(other.runtimeValuesComplete, false);
  // The native return event adds an address that is not a model variable.
  const ret = { ...root('ret', 'Return value', 'return'), variableKey: null, source: 'native-return-event' };
  const withReturn = server([root('r1', 'A'), ret], [ok, read('ret', described('ret', '$return', '5', { category: 'return' }))], { local: 1 });
  assert.equal(withReturn.runtimeValuesComplete, true);
  const unbound = scopeCompleteness({ lane: 'o11', runtime: 'server', stop, generation: 3,
    metadataCoverage: { ...coverage({ local: 1 }), runtimeFrameBound: false }, scopeVariables: [root('r1', 'A')], reads: [ok] });
  assert.equal(unbound.refused, 'debug_scope_completeness_metadata_coverage_unbound'); assert.equal(unbound.runtimeValuesComplete, false);
  assert.throws(() => server([root('r1', 'A'), root('r1', 'A')], [ok], { local: 2 }), /scope_invalid/);
});

test('the result never carries runtime values', () => {
  const secret = read('r1', compound('r1', 'Rec'), { availableChildren: 1, children: [described('c1', 'Rec.Note', '"PRIVATE-VALUE-42"')] });
  const result = server([root('r1', 'Rec')], [secret]);
  assert.equal(result.runtimeValuesComplete, true); assert.equal(result.valuesReturned, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-VALUE-42'));
});

// Client fixtures mirror debug-native-client-inspection-core evaluate/children/slice output.
const cctx = (over = {}) => ({ sessionId: 's'.repeat(32), platform: 'o11', runtime: 'client', stop: 2, generation: 1, callContextId: 5, frame: 0, ...over });
const cvar = (ref, name, category = 'local') => ({ ref, name, category, nativePath: name, moduleKey: 'M'.repeat(22), sourceSha256: 'a'.repeat(64), ...cctx() });
const evaluate = (ref, value, over = {}) => {
  const nested = ['Record', 'RecordList'].includes(value?.type);
  return { ...cctx(), ref, evaluation: 1, changed: null, previousStop: null, changedSincePreviousStop: null, value,
    deferred: nested && value.value === null, expandable: nested, redacted: false, valueComplete: !nested, ...over };
};
const client = (scopeVariables, reads, counts = { local: scopeVariables.filter(v => v.category !== 'return').length }) =>
  scopeCompleteness({ lane: 'odc', runtime: 'client', stop: 2, generation: 1, metadataCoverage: coverage(counts), scopeVariables, reads });

test('client tree uses children continuations and per-child evaluations', () => {
  const vars = [cvar('a', 'Count'), cvar('b', 'Rec')];
  const reads = [evaluate('a', { type: 'Integer', value: 3 }), evaluate('b', { type: 'Record', value: { A: 1, B: 'x' } })];
  const pending = client(vars, reads);
  assert.deepEqual(pending.incompleteLeaves.map(l => [l.reference, l.reason]), [['b', 'page-pending']]);
  const children = { ...cctx(), ref: 'b', offset: 0, total: 2, nextOffset: null, redacted: false, evaluation: 2, valueSha256: 'c'.repeat(64),
    children: [{ ...cvar('b1', 'A'), nativePath: 'Rec.A', name: 'A' }, { ...cvar('b2', 'B'), nativePath: 'Rec.B', name: 'B' }], continuation: null };
  const partial = client(vars, [...reads, children, evaluate('b1', { type: 'Integer', value: 1 })]);
  assert.deepEqual(partial.incompleteLeaves.map(l => [l.reference, l.reason]), [['b2', 'not-read']]);
  const done = client(vars, [...reads, children, evaluate('b1', { type: 'Integer', value: 1 }), evaluate('b2', { type: 'Text', value: 'x' })]);
  assert.equal(done.runtimeValuesComplete, true);
  assert.throws(() => client(vars, [{ ...reads[0], generation: 0 }]), /stale_read/);
  assert.throws(() => client(vars, [{ ...reads[0], stop: 1 }]), /stale_read/);
});

test('client RecordList is complete only when index items match the native Length', () => {
  const vars = [cvar('l', 'List')];
  const item = (ref, name) => ({ ...cvar(ref, name), nativePath: 'List' + name, name });
  const page = items => ({ ...cctx(), ref: 'l', offset: 0, total: items.length, nextOffset: null, redacted: false, children: items, continuation: null });
  const lengthOnly = evaluate('l', { type: 'RecordList', value: { Length: { type: 'Integer', value: 2 } } });
  const cut = client(vars, [lengthOnly, page([item('n', 'Length')]), evaluate('n', { type: 'Integer', value: 2 })]);
  assert.deepEqual(cut.incompleteLeaves.map(l => [l.reason, l.detail?.declaredLength, l.detail?.pagedItems]), [['page-pending', 2, 0]]);
  const full = evaluate('l', { type: 'RecordList', value: { Length: { type: 'Integer', value: 2 }, '[0]': { type: 'Integer', value: 5 }, '[1]': { type: 'Integer', value: 6 } } });
  const items = [item('n', 'Length'), item('i0', '[0]'), item('i1', '[1]')];
  const done = client(vars, [full, page(items), evaluate('n', { type: 'Integer', value: 2 }), evaluate('i0', { type: 'Integer', value: 5 }), evaluate('i1', { type: 'Integer', value: 6 })]);
  assert.equal(done.runtimeValuesComplete, true);
  const noLength = evaluate('l', { type: 'RecordList', value: { '[0]': { type: 'Integer', value: 5 } } });
  assert.deepEqual(client(vars, [noLength, page([item('i0', '[0]')]), evaluate('i0', { type: 'Integer', value: 5 })]).incompleteLeaves.map(l => l.reason), ['page-pending']);
  // A children page without the container's own evaluation proves nothing.
  assert.deepEqual(client(vars, [page(items)]).incompleteLeaves.map(l => l.reason), ['not-read']);
});

test('client failures, binary summaries, budgets and redaction keep their reasons', () => {
  const vars = [cvar('a', 'Widget'), cvar('b', 'File'), cvar('c', 'Huge'), cvar('d', 'Token'), cvar('e', 'Deep')];
  const reads = [{ ...cctx(), values: [
    { ...cctx(), ref: 'a', ok: false, error: 'debug_native_client_evaluation_unavailable', unavailable: true, valueComplete: false },
    evaluate('b', { type: 'BinaryData', value: 256 }, { valueComplete: false, nativeSummary: true, limitation: 'native_binary_content_unavailable' }),
    { ...cctx(), ref: 'c', omitted: true, reason: 'transport_budget', continuation: { op: 'expand', ref: 'c' }, evaluation: 3 },
    evaluate('d', { type: 'Text', value: '[private]' }, { redacted: true, valueComplete: false }),
    evaluate('e', { type: 'Record', value: null }),
  ], evaluationFailures: 1 }];
  const r = client(vars, reads);
  assert.deepEqual(r.incompleteLeaves.map(l => l.reason),
    ['native-unavailable-in-context', 'native-binary-summary', 'budget-omitted', 'private-redacted', 'deferred']);
  assert.equal(r.residualNativeLimitsOnly, false);
  const slice = (offset, nextOffset) => ({ ...cctx(), ref: 'c', value: { type: 'Text', value: 'y' }, offset, total: 20000, nextOffset,
    unit: 'utf16-code-unit', redacted: false, valueComplete: offset === 0 && nextOffset === null, evaluation: 4, valueSha256: 'd'.repeat(64) });
  // A partly private compound is descended: redaction lands on its leaf only.
  const record = evaluate('r', { type: 'Record', value: { Name: 'n', Password: '[private]' } }, { redacted: true });
  const fields = { ...cctx(), ref: 'r', offset: 0, total: 2, nextOffset: null, redacted: true, continuation: null,
    children: [{ ...cvar('r1', 'Name'), name: 'Name' }, { ...cvar('r2', 'Password'), name: 'Password' }] };
  const partly = client([cvar('r', 'Account')], [record, fields, evaluate('r1', { type: 'Text', value: 'n' }),
    evaluate('r2', { type: 'Text', value: '[private]' }, { redacted: true, valueComplete: false })]);
  assert.deepEqual(partly.incompleteLeaves.map(l => [l.reference, l.reason]), [['r2', 'private-redacted']]);
  assert.deepEqual(client([cvar('r', 'Account')], [record]).incompleteLeaves.map(l => l.reason), ['private-redacted']);
  const sliced = client([cvar('c', 'Huge')], [reads[0].values[2], slice(0, 8192), slice(8192, 16384), slice(16384, null)]);
  assert.equal(sliced.runtimeValuesComplete, true);
  assert.deepEqual(client([cvar('c', 'Huge')], [reads[0].values[2], slice(0, 8192)]).incompleteLeaves.map(l => l.reason), ['text-pending']);
});

test('rootCoverage reports background valuesComplete from the same native evidence', () => {
  const ok = read('r1', described('r1', 'Tick', '1'));
  const all = rootCoverage([root('r1', 'Tick')], [ok]);
  assert.equal(all.valuesComplete, true); assert.equal(all.rootsRead, 1); assert.equal(all.rootsComplete, 1);
  const missing = rootCoverage([root('r1', 'Tick'), root('r2', 'StartedAt')], [ok]);
  assert.equal(missing.valuesComplete, false); assert.deepEqual(missing.incompleteLeaves.map(l => l.reason), ['not-read']);
  assert.equal(rootCoverage([], []).valuesComplete, false);
  assert.throws(() => rootCoverage([root('r1', 'Tick'), root('r2', 'B')], [ok, { ...read('r2', described('r2', 'B', '2')), context: ctx({ eventId: '9' }) }]), /stale_read/);
});

test('completenessBinding binds only a matching stop, generation and counts', () => {
  const ok = server([root('r1', 'A')], [read('r1', described('r1', 'A', '1'))]);
  const context = ctx();
  assert.equal(completenessBinding(ok, context, { local: 1 })?.runtimeValuesComplete, true);
  assert.equal(completenessBinding(ok, ctx({ generation: 4 }), { local: 1 }), null);
  assert.equal(completenessBinding(ok, ctx({ eventId: '8' }), { local: 1 }), null);
  assert.equal(completenessBinding(ok, context, { local: 1, input: 1 }), null);
  assert.equal(completenessBinding(undefined, context, { local: 1 }), null);
  assert.equal(completenessBinding({ ...ok, ok: false }, context, { local: 1 }), null);
});
