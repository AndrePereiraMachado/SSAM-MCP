import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerGlobalHistory } from '../debug-server-global-history.mjs';

const M = 'M'.repeat(22), F = 'F'.repeat(22), V = 'V'.repeat(22), L = 'L'.repeat(22);
const ctx = (threadId, eventId, generation = 1, over = {}) => ({ runtime: 'server', threadId, eventId, frame: 0, generation,
  moduleKey: M, functionKey: F, nodeKey: 'N'.repeat(22), correlation: { nativeRequestIdSha256: null, nativeRequestIdProvenance: false }, ...over });
const scope = (context, variables) => ({ ok: true, context, scopeComplete: false, metadataBound: true, variables });
const variable = (reference, category, variableKey = V, name = 'Counter') => ({ reference, name, category, moduleKey: M, functionKey: F,
  variableKey, source: 'published-model', sourceSha256: 'a'.repeat(64) });
const described = (reference, path, value, category, over = {}) => ({ reference, path, category, type: 'Scalar', value,
  textOffset: 0, textLength: value?.length ?? null, nextTextOffset: null, valueComplete: true, nativeSummary: false, redacted: false,
  unavailable: false, undefined: false, trimmed: false, deferred: false, hasChildren: false, ...over });
const read = (context, reference, value, over = {}) => ({ ok: true, context, reference, evaluationRevision: 1, changed: null, value,
  children: [], offset: 0, nextOffset: null, availableChildren: 0, collectionCoverage: null, deferred: false, nativeTrimmed: false, redacted: false, ...over });

test('same thread across two stops: session value 0 then -17 is changed; unchanged is not', () => {
  const h = createServerGlobalHistory();
  const s1 = ctx('T1', '7');
  h.learnScope(scope(s1, [variable('s1', 'session')]));
  const first = h.annotate(read(s1, 's1', described('s1', 'Fixture.Counter', '0', 'session')));
  assert.equal(first.previousStop, null); assert.equal(first.changedSincePreviousStop, null);
  const s2 = ctx('T1', '9');
  h.learnScope(scope(s2, [variable('s2', 'session')]));
  const second = h.annotate(read(s2, 's2', described('s2', 'Fixture.Counter', '-17', 'session')));
  assert.equal(second.previousStop, '7'); assert.equal(second.changedSincePreviousStop, true);
  // A re-read in the same stop still compares with the previous stop.
  const again = h.annotate(read(s2, 's2', described('s2', 'Fixture.Counter', '-17', 'session'), { evaluationRevision: 2 }));
  assert.equal(again.previousStop, '7'); assert.equal(again.changedSincePreviousStop, true);
  const s3 = ctx('T1', '11');
  h.learnScope(scope(s3, [variable('s3', 'session')]));
  const third = h.annotate(read(s3, 's3', described('s3', 'Fixture.Counter', '-17', 'session')));
  assert.equal(third.previousStop, '9'); assert.equal(third.changedSincePreviousStop, false);
  // Native within-stop fields are preserved untouched.
  assert.equal(third.evaluationRevision, 1); assert.equal(third.changed, null);
});

test('another thread, locals and redacted values get no cross-stop claim', () => {
  const h = createServerGlobalHistory();
  const a = ctx('T1', '7'), b = ctx('T2', '8');
  h.learnScope(scope(a, [variable('s1', 'site'), variable('l1', 'local', L, 'Tick')]));
  h.annotate(read(a, 's1', described('s1', 'Fixture.Setting', '17', 'site')));
  h.annotate(read(a, 'l1', described('l1', 'Tick', '0', 'local')));
  h.learnScope(scope(b, [variable('s2', 'site'), variable('l2', 'local', L, 'Tick')]));
  const other = h.annotate(read(b, 's2', described('s2', 'Fixture.Setting', '29', 'site')));
  assert.equal(other.previousStop, null); assert.equal(other.changedSincePreviousStop, null);
  const local = h.annotate(read(b, 'l2', described('l2', 'Tick', '1', 'local')));
  assert.equal('previousStop' in local, false); assert.equal('changedSincePreviousStop' in local, false);
  const a2 = ctx('T1', '12');
  h.learnScope(scope(a2, [variable('s3', 'site'), variable('l3', 'local', L, 'Tick')]));
  const localAgain = h.annotate(read(a2, 'l3', described('l3', 'Tick', '5', 'local')));
  assert.equal('previousStop' in localAgain, false);
  const redacted = h.annotate(read(a2, 's3', described('s3', 'Fixture.Setting', '[redacted]', 'site', { redacted: true, valueComplete: false }),
    { redacted: true, changed: true }));
  assert.equal(redacted.previousStop, null); assert.equal(redacted.changedSincePreviousStop, null); assert.equal(redacted.changed, true);
  // The redacted display did not overwrite the last public fingerprint.
  const a3 = ctx('T1', '13');
  h.learnScope(scope(a3, [variable('s4', 'site')]));
  const after = h.annotate(read(a3, 's4', described('s4', 'Fixture.Setting', '17', 'site')));
  assert.equal(after.previousStop, '7'); assert.equal(after.changedSincePreviousStop, false);
});

test('read-many values, compound children and expanded child paths use the root identity', () => {
  const h = createServerGlobalHistory();
  const s1 = ctx('T1', '7');
  h.learnScope(scope(s1, [variable('r1', 'session', V, 'Profile'), variable('x1', 'setting', L, 'Limit')]));
  const record = described('r1', 'Fixture.Profile', null, 'session', { type: 'Record', value: null, textLength: null, valueComplete: false, hasChildren: true });
  const batch = h.annotate({ ok: true, context: s1, values: [
    read(s1, 'r1', record, { availableChildren: 1, children: [described('c1', 'Fixture.Profile.Age', '30', 'session')] }),
    read(s1, 'x1', described('x1', 'Fixture.Limit', '5', 'setting')),
  ] });
  assert.equal(batch.values[0].previousStop, null); assert.equal(batch.values[0].children[0].previousStop, null);
  const s2 = ctx('T1', '9');
  h.learnScope(scope(s2, [variable('r2', 'session', V, 'Profile'), variable('x2', 'setting', L, 'Limit')]));
  const next = h.annotate({ ok: true, context: s2, values: [
    read(s2, 'r2', { ...record, reference: 'r2' }, { availableChildren: 1, children: [described('c2', 'Fixture.Profile.Age', '31', 'session')] }),
    read(s2, 'x2', described('x2', 'Fixture.Limit', '5', 'setting')),
  ] });
  // A compound root has no described value; its children carry the comparison.
  assert.equal(next.values[0].previousStop, null); assert.equal(next.values[0].changedSincePreviousStop, null);
  assert.equal(next.values[0].children[0].previousStop, '7'); assert.equal(next.values[0].children[0].changedSincePreviousStop, true);
  assert.equal(next.values[1].changedSincePreviousStop, false);
  // An expanded child reference unseen before is mapped by its root path.
  const expanded = h.annotate(read(s2, 'c9', described('c9', 'Fixture.Profile.Age', '31', 'session')));
  assert.equal(expanded.previousStop, '7'); assert.equal(expanded.changedSincePreviousStop, true);
});

test('different native requests on a reused thread and ended threads are never compared', () => {
  const h = createServerGlobalHistory();
  const one = ctx('T1', '7', 1, { correlation: { nativeRequestIdSha256: 'a'.repeat(64), nativeRequestIdProvenance: true } });
  h.learnScope(scope(one, [variable('s1', 'session')]));
  h.annotate(read(one, 's1', described('s1', 'Fixture.Counter', '0', 'session')));
  const two = ctx('T1', '9', 1, { correlation: { nativeRequestIdSha256: 'b'.repeat(64), nativeRequestIdProvenance: true } });
  h.learnScope(scope(two, [variable('s2', 'session')]));
  assert.equal(h.annotate(read(two, 's2', described('s2', 'Fixture.Counter', '1', 'session'))).previousStop, null);
  h.threadEnded('T1');
  const three = ctx('T1', '11', 1, { correlation: { nativeRequestIdSha256: 'b'.repeat(64), nativeRequestIdProvenance: true } });
  h.learnScope(scope(three, [variable('s3', 'session')]));
  assert.equal(h.annotate(read(three, 's3', described('s3', 'Fixture.Counter', '1', 'session'))).previousStop, null);
  // Unknown references and failed results pass through without claims.
  assert.equal('previousStop' in h.annotate(read(three, 'zz', described('zz', 'Other', '1', 'local'))), false);
  assert.deepEqual(h.annotate({ ok: false, error: 'debug_stale_reference' }), { ok: false, error: 'debug_stale_reference' });
  // Diagnostics expose counts only, never paths or values.
  assert.deepEqual(h.inspect(), { entries: 1, references: 1 });
});
