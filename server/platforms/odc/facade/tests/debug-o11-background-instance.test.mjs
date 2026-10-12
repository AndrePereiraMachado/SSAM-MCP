import { foreignImport, gatedTest } from './fixtures/debug-foreign-gate.mjs';
// Port D7: timer-observation pending in the consolidation; the tests that reach it skip by name (fixtures/debug-foreign-gate.mjs).
const test = gatedTest();
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { backgroundThreadOutcome } from '../debug-background-correlation.mjs';
const { observeO11TimerInstance, timerInstanceBaseline, requestKeysOfRow, createO11TimerInstanceObserver } = await foreignImport('../debug-o11-background-instance.mjs', import.meta.url, 'timer-observation');

const sha = v => createHash('sha256').update(v).digest('hex');
const identity = { host: 'sc.example.test', moduleId: '577', name: 'Tick', module: 'Jobs' };
const target = 'https://sc.example.test/ServiceCenter/eSpace_Timer_Edit.aspx?Cyclic_Job_Key=key1';
const SC = 'https://sc.example.test/ServiceCenter/';
const KEY = 'c0ffee00-1111-4222-8333-444455556666', OTHER = 'deadbeef-1111-4222-8333-444455556666', ERROR = '1d8546e2-005b-4159-b3d9-adf9fe1c14bb';
const F = 'F'.repeat(22);
const grouped = key => ({ name: 'Request', href: SC + 'GroupedRequest_Logs.aspx?RequestKey=' + key });
const timerRow = ({ time = '2026-10-11 10:00:01', key, error = false } = {}) => ({
  fields: { 'Time of Log': time, Timer: 'Tick', Duration: '1s', Server: 'server1' },
  links: [{ href: target + '&EspaceId=577' }, { name: 'Jobs', href: SC + 'eSpace_Edit.aspx?EspaceId=577' },
    ...(key ? [grouped(key)] : []), ...(error ? [{ name: 'Error', href: SC + 'Show_Error.aspx?Error_Id=' + ERROR }] : [])] });
const logRow = (key, message = 'Timer Tick ran') => ({ fields: { Time: '2026-10-11 10:00:01', Module: 'Jobs', Message: message }, links: key ? [grouped(key)] : [] });
const outcome = (fingerprint = sha(KEY), ended = true) => backgroundThreadOutcome([
  { threadId: 'T', eventId: '5', functionKey: F, nativeRequestIdSha256: fingerprint },
  ...(ended ? [{ kind: 'thread-end', threadId: 'T', eventId: '9', nativeRequestIdSha256: fingerprint }] : [])], F);
const detail = (key = KEY) => ({ errorId: ERROR, truncated: false, source: SC + 'Show_Error.aspx?Error_Id=' + ERROR, observedAt: 'now',
  detail: `Id\n${ERROR}\nTime of Log\n2026-10-11 10:00:01\nModule\nJobs\nServer\nserver1\nRequest Key\n${key}\nMessage\nTimer Tick error (inside action 'Run'). Timer duration = 0 secs:synthetic [retry 1 of 3 scheduled]` });

function fake({ timer = [[], [timerRow()]], general = [logRow(KEY)], error = [], trace = [{ fields: { 'Event Type': 'General', Message: 'ok' } }], errorDetail = detail() } = {}) {
  const calls = []; let polls = 0, clock = 1000;
  const client = {
    logs: async (kind, limit, filters) => { calls.push([kind, filters]);
      const rows = kind === 'timer' ? timer[Math.min(polls++, timer.length - 1)] : kind === 'general' ? general : error;
      return { complete: true, truncated: false, rows: structuredClone(rows), observedAt: 'now' }; },
    trace: async key => { calls.push(['trace', key]); return { requestKey: key, logs: { rows: trace, complete: true } }; },
    errorDetail: async id => { calls.push(['error-detail', id]); return errorDetail; },
    post: () => { throw Error('read-only observer must never write'); },
  };
  const clockOptions = { now: () => clock, sleep: async ms => { clock += ms; }, pollMs: 1000 };
  return { client, calls, clockOptions, deadline: () => clock + 5000 };
}
async function observe(f, threadOutcome = outcome()) {
  const baseline = await timerInstanceBaseline({ client: f.client, identity, target });
  return observeO11TimerInstance({ client: f.client, identity, target, baseline, threadOutcome, deadlineAt: f.deadline(), ...f.clockOptions });
}

test('exact sha256(RequestKey) match plus one new exact row gives correlated/completed', async () => {
  const f = fake(), result = await observe(f);
  assert.equal(result.state, 'correlated'); assert.equal(result.instanceCorrelationProved, true);
  assert.equal(result.outcome, 'completed'); assert.equal(result.executionCompleted, true);
  assert.equal(result.newExactRows, 1); assert.equal(result.requestKeySha256, sha(KEY)); assert.equal(result.matchedFingerprint, sha(KEY));
  assert.equal(result.errorBound, false); assert.equal(result.nameOrTimeCorrelation, false);
  assert.deepEqual(f.calls.filter(c => c[0] === 'trace'), [['trace', KEY]]);
  assert.deepEqual(f.calls.find(c => c[0] === 'timer')[1], { timer: 'Tick' });
  assert.deepEqual(f.calls.find(c => c[0] === 'general')[1], { module: 'Jobs' });
});

test('name or time alone never correlates', async () => {
  // Same timer name and time, but the only RequestKey belongs to another request.
  const other = await observe(fake({ general: [logRow(OTHER, 'Timer Tick ran at 10:00:01')], timer: [[], [timerRow({ key: OTHER })]] }));
  assert.equal(other.instanceCorrelationProved, false); assert.equal(other.reason, 'request_key_not_matched');
  assert.equal(other.executionCompleted, false); assert.equal(other.outcome, 'unproved'); assert.equal(other.newExactTimerRowObserved, true); assert.equal(other.executionObserved, undefined);
  // A request-bound debugger fingerprint is required: frames without one cannot correlate by timing.
  const unbound = await observe(fake(), backgroundThreadOutcome([{ threadId: 'T', eventId: '5', functionKey: F }, { kind: 'thread-end', threadId: 'T', eventId: '9' }], F));
  assert.equal(unbound.instanceCorrelationProved, false); assert.equal(unbound.reason, 'request_fingerprint_unavailable');
});

test('two new exact rows or two different keys on the matched row are ambiguous', async () => {
  const two = await observe(fake({ timer: [[], [timerRow(), timerRow({ time: '2026-10-11 10:00:02' })]] }));
  assert.equal(two.state, 'ambiguous'); assert.equal(two.instanceCorrelationProved, false); assert.equal(two.reason, 'new_exact_rows_not_unique');
  const mismatch = await observe(fake({ timer: [[], [timerRow({ key: OTHER })]] }));
  assert.equal(mismatch.instanceCorrelationProved, false); assert.equal(mismatch.reason, 'timer_row_request_key_mismatch');
});

test('an error bound to the RequestKey gives failed with retryScheduled', async () => {
  const f = fake({ timer: [[], [timerRow({ error: true })]], error: [logRow(KEY, 'Timer Tick error')] });
  const result = await observe(f);
  assert.equal(result.state, 'correlated'); assert.equal(result.instanceCorrelationProved, true);
  assert.equal(result.outcome, 'failed'); assert.equal(result.errorBound, true); assert.equal(result.retryScheduled, true);
  assert.equal(result.retriesExhausted, false); assert.equal(result.executionCompleted, true);
  // An error link on the row whose detail names another request is never bound to ours, and blocks completion.
  const foreign = await observe(fake({ timer: [[], [timerRow({ error: true })]], errorDetail: detail(OTHER) }));
  assert.equal(foreign.instanceCorrelationProved, true); assert.equal(foreign.outcome, 'unproved');
  assert.equal(foreign.reason, 'row_has_error_link'); assert.equal(foreign.executionCompleted, false);
});

test('a missing RequestKey is refused with request_key_unavailable', async () => {
  const result = await observe(fake({ general: [logRow(null)], error: [] }));
  assert.equal(result.state, 'refused'); assert.equal(result.reason, 'request_key_unavailable');
  assert.equal(result.error, 'debug_native_background_timer_request_key_unavailable'); assert.equal(result.instanceCorrelationProved, false);
});

test('completed needs a ThreadEnd with the matched fingerprint; a complete baseline is required first', async () => {
  const noEnd = await observe(fake(), outcome(sha(KEY), false));
  assert.equal(noEnd.instanceCorrelationProved, true); assert.equal(noEnd.outcome, 'unproved');
  assert.equal(noEnd.reason, 'request_bound_thread_end_missing'); assert.equal(noEnd.executionCompleted, false);
  const f = fake();
  const result = await observeO11TimerInstance({ client: f.client, identity, target, baseline: { available: false, reason: 'incomplete-log-list' },
    threadOutcome: outcome(), deadlineAt: f.deadline(), ...f.clockOptions });
  assert.equal(result.reason, 'baseline_unavailable'); assert.equal(f.calls.length, 0);
  // No new exact row before the deadline stays unproved without reading other logs.
  const idle = fake({ timer: [[]] }), quiet = await observe(idle);
  assert.equal(quiet.reason, 'no_new_exact_row'); assert.equal(quiet.newExactTimerRowObserved, false);
  assert.ok(quiet.polls > 1); assert.equal(idle.calls.some(c => c[0] === 'general'), false);
});

test('public output carries hashes only', async () => {
  for (const f of [fake(), fake({ timer: [[], [timerRow({ error: true })]], error: [logRow(KEY)] })]) {
    const text = JSON.stringify(await observe(f));
    assert.doesNotMatch(text, new RegExp(KEY)); assert.doesNotMatch(text, new RegExp(ERROR));
    assert.match(text, new RegExp(sha(KEY)));
  }
});

test('RequestKey link parsing for General and Error rows binds the Service Center host', () => {
  assert.deepEqual(requestKeysOfRow(logRow(KEY), identity.host), [KEY]);
  const errorRow = { fields: { Message: 'x' }, links: [{ href: SC + 'Show_Error.aspx?Error_Id=' + ERROR }, grouped(KEY)] };
  assert.deepEqual(requestKeysOfRow(errorRow, identity.host), [KEY]);
  assert.deepEqual(requestKeysOfRow({ fields: { 'Request Key': KEY }, links: [] }, identity.host), [KEY]);
  assert.deepEqual(requestKeysOfRow({ links: [{ href: 'https://foreign.test/ServiceCenter/GroupedRequest_Logs.aspx?RequestKey=' + KEY }] }, identity.host), []);
  assert.deepEqual(requestKeysOfRow({ links: [{ href: SC + 'GroupedRequest_Logs.aspx?RequestKey=bad key!' }] }, identity.host), []);
  assert.deepEqual(requestKeysOfRow({ links: [{ href: 'not a url' }] }, identity.host), []);
});

test('observer factory validates the Service Center identity before any read', async () => {
  const f = fake();
  assert.throws(() => createO11TimerInstanceObserver({ client: f.client, identity: { ...identity, host: 'other.test' }, target }), /identity_invalid/);
  assert.throws(() => createO11TimerInstanceObserver({ client: f.client, identity: { ...identity, moduleId: 'x' }, target }), /identity_invalid/);
  const observer = createO11TimerInstanceObserver({ client: f.client, identity, target, ...f.clockOptions });
  const baseline = await observer.baseline();
  assert.equal(baseline.available, true);
  const result = await observer.observe({ baseline, threadOutcome: outcome(), deadlineAt: f.deadline() });
  assert.equal(result.outcome, 'completed'); assert.equal(f.calls.length > 0, true);
});
