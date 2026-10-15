import { foreignImport, gatedTest } from './fixtures/debug-foreign-gate.mjs';
// Port D7: timer-background pending in the consolidation; the tests that reach it skip by name (fixtures/debug-foreign-gate.mjs).
const test = gatedTest();
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeTraceResult } from '../../portal/runtime/trace-result.mjs';
import { guidToKey, keyToGuid } from '../debug-odc-native-runtime.mjs';
const { TIMER_PORTAL_CONTRACT } = await foreignImport('../../portal/runtime/timer-background.mjs', import.meta.url, 'timer-background');
const { observeOdcTimerInstance, bindOdcTimerInstance, requestIdShapeOf, createOdcTimerInstanceObserver, openOdcTimerInstance, reconcileOdcTimerInstance } = await foreignImport('../debug-odc-background-instance.mjs', import.meta.url, 'timer-background');

// Spans and logs sanitized from the historical ODC Timer trace (FinishedWithMissingSpans, 48 spans).
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-odc-timer-instance-trace.json', import.meta.url)));
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const STAGE = '22222222-2222-4333-8444-555555555555', APP = fixture.applicationKey, TRACE = fixture.traceId;
const REQUEST = '7d3f9a10-4b2c-4e8f-9a61-0c5d2e7b1f34';
const window = { since: '2026-10-05T17:58:00.000Z', until: '2026-10-05T18:00:00.000Z' };
const identity = { environmentKey: STAGE, applicationKey: APP, timerName: 'NightlyProbe' };
const outcome = (fp, ended = [fp]) => ({ requestFingerprintConsistent: true, fingerprints: [fp], endedFingerprints: ended, requestBound: ended.includes(fp) });
const span = (TraceId, SpanId, ParentSpanId, SpanName, extra = {}) => ({ ApplicationKey: APP, TraceId, SpanId, ParentSpanId, SpanName, SpanType: '',
  Status: 'Ok', SpanKind: 'SpanKindInternal', StartTime: '2026-10-05T17:58:49.000Z', EndTime: '2026-10-05T17:58:49.500Z',
  StartTimeUnixNano: '1791223129000000000', EndTimeUnixNano: '1791223129500000000', Duration: '500', LowCode: false, IsEntrySpan: false, ...extra });
// A Portal shaped like PortalReadAdapter results; the trace route normalizes the native wire.
function portal({ traces = [{ ...fixture.summary }], spans = { [TRACE]: fixture.spans }, status = { [TRACE]: fixture.processingStatus },
  traceLogs = { [TRACE]: fixture.traceLogs }, logs = [], fail = null } = {}) {
  const calls = [];
  const read = async (operationId, input) => {
    calls.push({ operationId, input });
    if (fail === operationId) return { ok: false, error: { code: 'PORTAL_TIMEOUT' } };
    if (operationId === 'monitoring.traces') return { ok: true, traces, nextPageAvailable: false, returnedCount: traces.length };
    if (operationId === 'monitoring.logs') return { ok: true, rows: logs, nextPageAvailable: false };
    if (operationId === 'monitoring.trace') return { ok: true, ...normalizeTraceResult({ SpansList: { traceProcessingStatus: status[input.traceId] ?? 'Finished',
      MON_SpanItemList: { List: spans[input.traceId] ?? [] } } }, { traceId: input.traceId, maxSpans: input.maxSpans }) };
    if (operationId === 'monitoring.traceLogs') return { ok: true, rows: traceLogs[input.traceId] ?? [], traceId: input.traceId };
    throw new Error('unexpected operation ' + operationId);
  };
  return { read, calls };
}
const withRequestKey = (rows = fixture.traceLogs) => rows.map((row, i) => i === 0 ? { ...row, RequestKey: REQUEST } : row);
const observe = (p, options) => observeOdcTimerInstance({ read: p.read, identity, window, deadlineAt: 0, ...options });

test('exact fingerprint of a Portal RequestKey correlates and keeps FinishedWithMissingSpans reasons', async () => {
  const p = portal({ traceLogs: { [TRACE]: withRequestKey() } }), fp = sha(REQUEST);
  const r = await observe(p, { threadOutcome: outcome(fp) });
  assert.equal(r.state, 'correlated'); assert.equal(r.instanceCorrelationProved, true); assert.equal(r.matchedFingerprint, fp);
  assert.deepEqual(r.matchSources, ['trace-log:request-key']); assert.equal(r.correlatedTraceIdSha256, sha(TRACE));
  assert.equal(r.processingStatus, 'FinishedWithMissingSpans');
  assert.deepEqual(r.incompleteReasons, ['server_missing_spans', 'missing_parent_spans']);
  // Timer span OK + TimerCleanupActivity + NotifyManagerSuccess and a ThreadEnd of the same request.
  assert.equal(r.outcome, 'completed'); assert.equal(r.executionCompleted, true);
  assert.deepEqual(r.completion, { timerSpanStatus: 'Ok', timerCleanupActivity: true, notifyManagerSuccess: true });
  assert.equal(r.nameOrTimeCorrelation, false); assert.equal(r.readOnly, true); assert.equal(r.rewake, false);
  // Hashes only: neither the RequestKey nor the raw trace id leaves the correlator.
  assert.doesNotMatch(JSON.stringify(r), new RegExp(REQUEST + '|' + TRACE));
  assert.deepEqual([...new Set(p.calls.map(c => c.operationId))].sort(), ['monitoring.logs', 'monitoring.trace', 'monitoring.traceLogs', 'monitoring.traces']);
  assert.ok(p.calls.every(c => c.input.environmentKey === STAGE));
  // Without the request-bound ThreadEnd the instance stays correlated but not completed.
  const loose = await observe(portal({ traceLogs: { [TRACE]: withRequestKey() } }), { threadOutcome: outcome(fp, []) });
  assert.equal(loose.instanceCorrelationProved, true); assert.equal(loose.executionCompleted, false);
  assert.equal(loose.reason, 'request_bound_thread_end_missing'); assert.equal(loose.outcome, 'unproved');
});

test('a trace id or span id matches exactly; the native requestId shape admits only its own case forms', async () => {
  const byTrace = await observe(portal(), { threadOutcome: outcome(sha(TRACE)) });
  assert.equal(byTrace.instanceCorrelationProved, true); assert.ok(byTrace.matchSources.includes('trace-search:trace-id'));
  const timerSpan = fixture.spans.find(s => s.SpanType === 'Timer').SpanId;
  const bySpan = await observe(portal(), { threadOutcome: outcome(sha(timerSpan)) });
  assert.equal(bySpan.instanceCorrelationProved, true); assert.deepEqual(bySpan.matchSources, ['span:span-id']);
  const upper = sha(REQUEST.toUpperCase()), p = () => portal({ traceLogs: { [TRACE]: withRequestKey() } });
  assert.equal((await observe(p(), { threadOutcome: outcome(upper) })).instanceCorrelationProved, false);
  const guid = await observe(p(), { threadOutcome: outcome(upper), requestIdShape: { format: 'guid', lengthBucket: '33-36' } });
  assert.equal(guid.instanceCorrelationProved, true); assert.equal(guid.matchForm, 'guid-case');
  assert.deepEqual(requestIdShapeOf([{ kind: 'thread-end', nativeRequestIdSha256: upper, nativeRequestIdShape: { format: 'guid', lengthBucket: '33-36', present: true } }], upper),
    { format: 'guid', lengthBucket: '33-36' });
  assert.equal(requestIdShapeOf([{ kind: 'thread-end', nativeRequestIdSha256: 'b'.repeat(64), nativeRequestIdShape: { format: 'guid' } }], upper), null);
});

test('Timer name, app and time inside the window never correlate', async () => {
  const p = portal({ traceLogs: { [TRACE]: withRequestKey() } });
  const r = await observe(p, { threadOutcome: outcome(sha('another request')) });
  assert.equal(r.state, 'unproved'); assert.equal(r.reason, 'request_identifier_not_matched');
  assert.equal(r.instanceCorrelationProved, false); assert.equal(r.executionCompleted, false); assert.equal(r.nameOrTimeCorrelation, false);
  assert.equal(r.identifiersObserved, 50); assert.equal(r.candidateTraces, 1);
  // Without one consistent request fingerprint the Portal is not even read.
  const none = portal();
  for (const thread of [null, { requestFingerprintConsistent: false, fingerprints: ['a'.repeat(64)] }, { requestFingerprintConsistent: true, fingerprints: ['a'.repeat(64), 'b'.repeat(64)] }]) {
    const u = await observe(none, { threadOutcome: thread });
    assert.equal(u.reason, 'request_fingerprint_unavailable'); assert.equal(u.instanceCorrelationProved, false);
  }
  assert.equal(none.calls.length, 0);
});

test('the same identifier in two traces is ambiguous, never a correlation', async () => {
  const other = 'f'.repeat(32), copy = fixture.spans.map(s => ({ ...s, TraceId: other }));
  const p = portal({ traces: [{ ...fixture.summary }, { ...fixture.summary, Id: other }], spans: { [TRACE]: fixture.spans, [other]: copy },
    status: { [TRACE]: 'Finished', [other]: 'Finished' },
    traceLogs: { [TRACE]: withRequestKey(), [other]: withRequestKey(fixture.traceLogs.map(r => ({ ...r, TraceId: other }))) } });
  const r = await observe(p, { threadOutcome: outcome(sha(REQUEST)) });
  assert.equal(r.state, 'ambiguous'); assert.equal(r.reason, 'request_identifier_matches_not_unique');
  assert.equal(r.instanceCorrelationProved, false); assert.equal(r.executionCompleted, false); assert.equal(r.matchedTraces, 2);
});

test('error status gives failed; Processing gives pending, never completed', async () => {
  const failing = fixture.spans.map(s => s.SpanType === 'Timer' ? { ...s, Status: 'Error', StatusLabel: 'Error' } : s);
  const f = await observe(portal({ spans: { [TRACE]: failing }, traceLogs: { [TRACE]: withRequestKey() } }), { threadOutcome: outcome(sha(REQUEST)) });
  assert.equal(f.instanceCorrelationProved, true); assert.equal(f.outcome, 'failed'); assert.equal(f.executionCompleted, true);
  assert.equal(f.completion.timerSpanStatus, 'Error');
  const pending = await observe(portal({ status: { [TRACE]: 'Processing' }, traceLogs: { [TRACE]: withRequestKey() } }), { threadOutcome: outcome(sha(REQUEST)) });
  assert.equal(pending.instanceCorrelationProved, true); assert.equal(pending.outcome, 'pending'); assert.equal(pending.executionCompleted, false);
  assert.equal(pending.processingStatus, 'Processing'); assert.ok(pending.incompleteReasons.includes('server_processing'));
  const noCleanup = fixture.spans.filter(s => s.SpanName !== 'TimerCleanupActivity');
  const partial = await observe(portal({ spans: { [TRACE]: noCleanup }, traceLogs: { [TRACE]: withRequestKey() } }), { threadOutcome: outcome(sha(REQUEST)) });
  assert.equal(partial.executionCompleted, false); assert.equal(partial.reason, 'completion_spans_missing');
});

test('Timer root ParentSpanId inside the wake caller trace proves the wake link; otherwise a native limit', async () => {
  const caller = 'c'.repeat(32), link = '0123456789abcdef', root = fixture.spans.find(s => s.IsEntrySpan && !s.ParentSpanId).SpanId;
  const linked = fixture.spans.map(s => s.SpanId === root ? { ...s, ParentSpanId: link } : s);
  const callerSpans = [span(caller, 'aaaaaaaaaaaaaaaa', '', 'POST /screenservices/App/Probe/ActionRunManualTimerProbe', { SpanKind: 'SpanKindServer', IsEntrySpan: true }),
    span(caller, 'bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa', 'WakeManualTimer', { SpanType: 'ServerAction', LowCode: true }),
    span(caller, link, 'bbbbbbbbbbbbbbbb', 'WakeTimer')];
  const make = (spansOfCaller = callerSpans) => portal({ traces: [{ ...fixture.summary }, { ...fixture.summary, Id: caller, EntrySpanType: 'ServerAction' }],
    spans: { [TRACE]: linked, [caller]: spansOfCaller }, status: { [TRACE]: 'FinishedWithMissingSpans', [caller]: 'Finished' },
    traceLogs: { [TRACE]: withRequestKey(), [caller]: [] } });
  const r = await observe(make(), { identity: { ...identity, callerName: 'WakeManualTimer' }, threadOutcome: outcome(sha(REQUEST)) });
  assert.equal(r.instanceCorrelationProved, true); assert.equal(r.wakeOwnershipProved, true);
  assert.equal(r.wakeLink.state, 'linked'); assert.equal(r.wakeLink.callerTraceIdSha256, sha(caller));
  // Another caller action, a parent outside any caller trace, or no app caller: never ownership.
  const wrong = await observe(make(), { identity: { ...identity, callerName: 'OtherAction' }, threadOutcome: outcome(sha(REQUEST)) });
  assert.equal(wrong.wakeOwnershipProved, false); assert.equal(wrong.wakeLink.reason, 'caller_server_action_not_ancestor');
  const historical = await observe(portal({ traceLogs: { [TRACE]: withRequestKey() } }), { identity: { ...identity, callerName: 'WakeManualTimer' }, threadOutcome: outcome(sha(REQUEST)) });
  assert.equal(historical.wakeOwnershipProved, false); assert.equal(historical.wakeLink.nativeLimit, 'timer_root_span_has_no_cross_trace_parent');
  const portalWake = await observe(make(), { threadOutcome: outcome(sha(REQUEST)) });
  assert.equal(portalWake.wakeOwnershipProved, false); assert.equal(portalWake.wakeLink.reason, 'no_app_caller');
});

test('Portal read failures and bounds stay explicit; ingestion lag polls only until the deadline', async () => {
  const failed = await observe(portal({ fail: 'monitoring.traces' }), { threadOutcome: outcome(sha(REQUEST)) });
  assert.equal(failed.state, 'unavailable'); assert.equal(failed.reason, 'portal_read_failed'); assert.equal(failed.portalError, 'PORTAL_TIMEOUT');
  const many = Array.from({ length: 26 }, (_, i) => ({ ...fixture.summary, Id: i.toString(16).padStart(32, '0') }));
  const bounded = await observe(portal({ traces: many }), { threadOutcome: outcome(sha(REQUEST)) });
  assert.equal(bounded.reason, 'candidate_traces_exceed_bound'); assert.equal(bounded.instanceCorrelationProved, false);
  let clock = 1000, slept = 0;
  const lag = portal({ traces: [] });
  const r = await observeOdcTimerInstance({ read: lag.read, identity, window, threadOutcome: outcome(sha(REQUEST)), deadlineAt: 15000, pollMs: 5000,
    now: () => clock, sleep: async ms => { slept++; clock += ms; } });
  assert.equal(r.polls, 3); assert.equal(slept, 2); assert.equal(r.reason, 'no_candidate_traces'); assert.equal(r.instanceCorrelationProved, false);
});

test('the runner binding accepts only a fingerprint the trace bound; completion needs its ThreadEnd', () => {
  const fp = 'a'.repeat(64), found = { state: 'correlated', instanceCorrelationProved: true, matchedFingerprint: fp, executionCompleted: true, outcome: 'completed', wakeOwnershipProved: true };
  assert.equal(bindOdcTimerInstance(found, outcome(fp)).executionCompleted, true);
  const foreign = bindOdcTimerInstance(found, outcome('b'.repeat(64)));
  assert.equal(foreign.instanceCorrelationProved, false); assert.equal(foreign.reason, 'fingerprint_not_in_trace'); assert.equal(foreign.wakeOwnershipProved, false);
  const unended = bindOdcTimerInstance(found, outcome(fp, []));
  assert.equal(unended.instanceCorrelationProved, true); assert.equal(unended.executionCompleted, false); assert.equal(unended.outcome, 'unproved');
  assert.equal(bindOdcTimerInstance({ ...found, outcome: 'failed' }, outcome(fp, [])).executionCompleted, true);
  assert.equal(bindOdcTimerInstance(null, outcome(fp)).state, 'unavailable');
});

test('observer reads Timer state before and after through the prepared adapter and reconciles a receipt read-only', async () => {
  const states = [{ isRunning: false, lastRunStartedOn: '1' }, { isRunning: false, lastRunStartedOn: '2' }];
  const p = portal({ traceLogs: { [TRACE]: withRequestKey() } });
  const observer = createOdcTimerInstanceObserver({ read: p.read, identity, readState: async () => states.shift() });
  const baseline = await observer.baseline();
  assert.equal(baseline.available, true);
  const r = await observer.observe({ baseline, threadOutcome: outcome(sha(REQUEST)), window, deadlineAt: 0 });
  assert.deepEqual(r.timerStateBefore, { isRunning: false, lastRunStartedOn: '1' }); assert.deepEqual(r.timerStateAfter, { isRunning: false, lastRunStartedOn: '2' });
  assert.equal(r.executionCompleted, true);
  const receipt = { triggerAnswered: true, uncertain: false, instanceWindow: window,
    backgroundTrace: { ...outcome(sha(REQUEST)) }, instanceIdentity: identity };
  const later = await reconcileOdcTimerInstance({ receipt, observer: createOdcTimerInstanceObserver({ read: portal({ traceLogs: { [TRACE]: withRequestKey() } }).read, identity }) });
  assert.equal(later.instanceCorrelationProved, true); assert.equal(later.recordedLater, true);
  for (const bad of [{ ...receipt, triggerAnswered: false }, { ...receipt, uncertain: true }])
    assert.equal((await reconcileOdcTimerInstance({ receipt: bad, observer })).state, 'refused');
});

test('default observer opens its own developer Portal session, prepares the Timer read-only and releases it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-instance-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const moduleKey = guidToKey('44444444-2222-4333-8444-555555555555'), timerKey = guidToKey('55555555-2222-4333-8444-555555555555');
  const binding = { tenant: 'fixture.outsystems.dev', environmentKey: STAGE, module: 'Store', moduleKey, revision: 42, runtimeUrl: 'https://fixture-dev.outsystems.app/Store/' };
  const requests = [], state = { isRunning: false, isPendingRun: false, lastRunDuration: 0, currentStartedOn: '1900-01-01T00:00:00',
    lastRunStartedOn: '1900-01-01T00:00:00', lastRunFinishedOn: '1900-01-01T00:00:00', nextRunStartsOn: '1900-01-01T00:00:00' };
  const broker = { target: 'odc3', origin: 'https://fixture.outsystems.dev', authenticated: false,
    credentialRegistry: { reset: () => requests.push('credentials-reset') },
    jar: { removeAllCookies: async () => { requests.push('cookies-removed'); } },
    initialize: async () => {}, authenticate: async () => { broker.authenticated = true; return { ok: true }; },
    metadata: { resolve: async (m, v, a) => ({ action: a, apiVersion: TIMER_PORTAL_CONTRACT.actions[a.split('/').at(-1)], moduleVersion: 'v1' }) },
    action: async (m, v, a) => { requests.push(a.split('/').at(-1));
      if (a.endsWith('GetApplicationStages')) return { data: { EnvironmentsApplicationVersion: [{ Environment: { Key: STAGE, PortfolioKey: '33333333-2222-4333-8444-555555555555' },
        IsDevEnv: true, DeployedAssetVersion: { AssetKey: keyToGuid(moduleKey), EnvironmentKey: STAGE, Revision: 42, Url: binding.runtimeUrl } }] } };
      if (a.endsWith('CheckLatestDeployment')) return { data: { HasOngoingDeployments: false } };
      if (a.endsWith('GetTimerInfo')) return { data: { NotFound: false, TimerInfo: { Timer: { Key: keyToGuid(timerKey), Name: 'Nightly' } } } };
      return { data: { TimerRunInformation: state, CurrentDuration: 0 } }; },
    request: async () => { throw new Error('no POST may be sent by the observer'); },
    readScreenservice: async () => { throw new Error('unexpected read'); } };
  const observer = openOdcTimerInstance({ binding, sourceSha256: 'a'.repeat(64), timer: { timerKey, name: 'Nightly' }, callerName: 'WakeCaller', root,
    broker, verifyAssets: async () => {} });
  assert.deepEqual(observer.identity, { environmentKey: STAGE, applicationKey: keyToGuid(moduleKey), timerName: 'Nightly', callerName: 'WakeCaller' });
  const baseline = await observer.baseline();
  assert.equal(baseline.available, true); assert.equal(baseline.state.isRunning, false);
  assert.equal(requests.includes('ActionWakeTimer_Wrapper'), false);
  assert.deepEqual(await observer.release(), { released: true }); assert.equal(broker.authenticated, false);
  assert.ok(requests.includes('credentials-reset'));
  assert.ok(requests.includes('cookies-removed'));
  // Non-ODC-cloud targets never open a Portal session.
  assert.equal(openOdcTimerInstance({ binding: { ...binding, environmentKey: 'dev' }, sourceSha256: 'a'.repeat(64), timer: { timerKey, name: 'Nightly' }, root }), null);
});

test('observer inputs satisfy the real read-only PortalReadAdapter contract (fake broker, no network)', async () => {
  const origin = 'https://fixture.outsystems.dev', seen = [];
  const page = total => ({ Limit: '100', Offset: '0', NextPageOffset: '0', TotalPages: '0', TotalResults: String(total) });
  const broker = { target: 'odc3', origin, authenticated: true, nativeTraceContext: true,
    readScreenservice: async request => {
      seen.push(request.operationId); assert.equal(request.readOnly, true);
      const data = request.operationId === 'monitoring.traces' ? { Traces: { List: [{ ...fixture.summary, OriginAssetKey: APP }] }, Page: page(1) }
        : request.operationId === 'monitoring.logs' ? { LogsList: { List: [] }, LogSearch_Page: { Limit: 0, Offset: 0, NextPageOffset: 0, TotalPages: 0, TotalResults: 0 } }
        : request.operationId === 'monitoring.trace' ? { SpansList: { traceProcessingStatus: fixture.processingStatus, MON_SpanItemList: { List: fixture.spans } } }
        : { RelatedLogList: { List: withRequestKey() } };
      return { target: 'odc3', origin, body: { data } };
    } };
  const { PortalReadAdapter } = await import('../../portal/runtime/portal-read.mjs');
  const observer = createOdcTimerInstanceObserver({ read: new PortalReadAdapter({ target: 'odc3', origin, broker }), identity });
  const r = await observer.observe({ baseline: null, threadOutcome: outcome(sha(REQUEST)), window, deadlineAt: 0 });
  assert.equal(r.state, 'correlated', JSON.stringify(r)); assert.equal(r.executionCompleted, true); assert.deepEqual(r.matchSources, ['trace-log:request-key']);
  assert.deepEqual(seen, ['monitoring.traces', 'monitoring.logs', 'monitoring.trace', 'monitoring.traceLogs']);
});
