// Read-only Portal correlation, wake link and completion of one ODC Timer instance.
// The only identity is exact: sha256(Portal RequestKey | TraceId | SpanId) equal to the
// debugger's request-bound native fingerprint, and only when exactly one trace matches.
// Timer name, revision, app or time never correlate. Results carry hashes only. This uses
// the developer Portal session (separate from the app user), never wakes, never posts, and
// can run again later (reconcile) because Portal ingestion may lag past the debugger deadline.
import { createHash } from 'node:crypto';
import { keyToGuid } from './debug-odc-native-runtime.mjs';
import { PortalReadAdapter } from '../portal/runtime/portal-read.mjs';
import { createOdcTimerPortalAdapter, verifyTimerPortalAssets } from '../portal/runtime/timer-background.mjs';
import { Odc3PortalBroker } from '../portal/runtime/odc3-context.mjs';

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const SHA = /^[a-f0-9]{64}$/, GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, HEX32 = /^[a-f0-9]{32}$/i;
const PAGE = 100, PAGES = 5, MAX_TRACES = 25;
export const INSTANCE_SECONDS = 120;
const FIELDS = [['RequestKey', 'request-key'], ['TraceId', 'trace-id'], ['SpanId', 'span-id']];
const READS = new Set(['monitoring.traces', 'monitoring.logs', 'monitoring.trace', 'monitoring.traceLogs']);
class ReadFailure extends Error {}

// Exact form always; a GUID or hex32 native requestId also matches its own case forms (no other coercion).
function hashesOf(value, shape) {
  const forms = shape?.format === 'guid' && GUID.test(value) || shape?.format === 'hex32' && HEX32.test(value)
    ? [...new Set([value, value.toLowerCase(), value.toUpperCase()])] : [value];
  return forms.map(form => [sha(form), form === value ? 'exact' : shape.format + '-case']);
}
// The value-free requestId shape the kernel records on the request-bound ThreadEnd (interactive status events).
export function requestIdShapeOf(lines, fingerprint) {
  const row = (lines ?? []).find(line => line?.kind === 'thread-end' && line.nativeRequestIdSha256 === fingerprint && line.nativeRequestIdShape);
  const shape = row?.nativeRequestIdShape;
  return shape && ['guid', 'hex32', 'other'].includes(shape.format) ? { format: shape.format, lengthBucket: shape.lengthBucket ?? null } : null;
}
const fingerprintOf = thread => thread?.requestFingerprintConsistent === true && Array.isArray(thread.fingerprints) &&
  thread.fingerprints.length === 1 && SHA.test(thread.fingerprints[0]) ? thread.fingerprints[0] : null;

async function readOk(read, operationId, input) {
  if (!READS.has(operationId)) throw new ReadFailure('PORTAL_OPERATION_NOT_READ_ONLY');
  let answer; try { answer = await read(operationId, input); } catch { throw new ReadFailure('PORTAL_BROKER_FAILED'); }
  if (answer?.ok !== true) throw new ReadFailure(/^[A-Z_]{3,60}$/.test(answer?.error?.code ?? '') ? answer.error.code : 'PORTAL_BROKER_FAILED');
  return answer;
}
async function pages(read, operationId, input, rowsOf) {
  const rows = [];
  for (let page = 0; page < PAGES; page++) {
    const answer = await readOk(read, operationId, { ...input, limit: PAGE, offset: page * PAGE });
    rows.push(...rowsOf(answer));
    if (answer.nextPageAvailable !== true) return { rows, complete: true };
  }
  return { rows, complete: false };
}

export async function observeOdcTimerInstance({ read, identity, threadOutcome, requestIdShape = null, window, before = null, readState = null,
  deadlineAt = 0, pollMs = 5000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let polls = 0, candidateTraces = 0, identifiersObserved = 0, timerStateAfter = null;
  const result = (state, reason, extra = {}) => ({ schema: 'ssam-odc-timer-instance/1', state, reason, readOnly: true, rewake: false,
    correlationMethod: 'sha256(Portal RequestKey|TraceId|SpanId) == native request fingerprint, exactly one trace', nameOrTimeCorrelation: false,
    instanceCorrelationProved: false, executionCompleted: false, outcome: 'unproved', wakeOwnershipProved: false,
    matchedFingerprint: null, matchSources: [], correlatedTraceIdSha256: null, processingStatus: null, incompleteReasons: [],
    requestIdShape, candidateTraces, identifiersObserved, polls, timerStateBefore: before, timerStateAfter, ...extra });
  const fp = fingerprintOf(threadOutcome);
  if (!fp) return result('unproved', 'request_fingerprint_unavailable');
  if (!GUID.test(identity?.environmentKey ?? '') || !GUID.test(identity?.applicationKey ?? '') ||
      !Number.isFinite(Date.parse(window?.since)) || !Number.isFinite(Date.parse(window?.until))) return result('unproved', 'instance_scope_invalid');
  const scope = { environmentKey: identity.environmentKey };
  let last = 'no_candidate_traces', settled = null;
  for (;;) {
    polls++;
    try {
      // Portal windows must be positive; a read never asks for the future.
      const until = new Date(Math.max(Date.parse(window.since) + 1000, Math.min(Date.parse(window.until), now()))).toISOString();
      const span = { ...scope, applicationKey: identity.applicationKey, since: window.since, until };
      const search = await pages(read, 'monitoring.traces', span, answer => answer.traces ?? []);
      const traces = [...new Map(search.rows.filter(t => typeof t?.Id === 'string' && t.Id).map(t => [t.Id, t])).values()];
      candidateTraces = traces.length;
      // Bounded: every candidate is read, never a silent subset, so a match is unique or refused.
      if (!search.complete || traces.length > MAX_TRACES) return result('unproved', 'candidate_traces_exceed_bound');
      const logs = await pages(read, 'monitoring.logs', span, answer => answer.rows ?? []);
      if (!logs.complete) return result('unproved', 'candidate_logs_exceed_bound');
      const data = new Map(), matches = [];
      const seen = new Set(), add = (value, traceId, source) => {
        if (typeof value !== 'string' || !value || value.length > 200) return;
        if (!seen.has(value)) { seen.add(value); identifiersObserved = seen.size; }
        for (const [hash, form] of hashesOf(value, requestIdShape)) if (hash === fp) matches.push({ traceId: traceId || null, source, form });
      };
      for (const trace of traces) {
        const spans = await readOk(read, 'monitoring.trace', { ...scope, traceId: trace.Id, maxSpans: 1000 });
        const traceLogs = await readOk(read, 'monitoring.traceLogs', { ...scope, traceId: trace.Id, maxLogs: 100 });
        data.set(trace.Id, { spans, traceLogs });
        add(trace.Id, trace.Id, 'trace-search:trace-id');
        for (const row of spans.spans ?? []) for (const [field, kind] of FIELDS.slice(1)) add(row[field], trace.Id, 'span:' + kind);
        for (const row of traceLogs.rows ?? []) for (const [field, kind] of FIELDS) add(row[field], trace.Id, 'trace-log:' + kind);
      }
      for (const row of logs.rows) for (const [field, kind] of FIELDS) add(row[field], row.TraceId, 'log:' + kind);
      const matched = [...new Set(matches.map(m => m.traceId))];
      if (matched.length > 1) return result('ambiguous', 'request_identifier_matches_not_unique', { matchedTraces: matched.length });
      if (matched.length === 1 && matched[0] === null) last = 'matched_log_without_trace';
      else if (matched.length === 1 && !data.has(matched[0])) last = 'matched_trace_outside_window';
      else if (matched.length === 1) {
        const own = matches.filter(m => m.traceId === matched[0]);
        settled = conclude({ fp, threadOutcome, identity, trace: data.get(matched[0]), traceId: matched[0], data,
          match: { matchedFingerprint: fp, matchSources: [...new Set(own.map(m => m.source))].sort(), matchForm: own.some(m => m.form === 'exact') ? 'exact' : own[0].form } });
        // Processing is never final: keep polling until the deadline, then report pending.
        if (settled.outcome !== 'pending') break;
        last = 'trace_processing';
      } else last = traces.length ? 'request_identifier_not_matched' : 'no_candidate_traces';
    } catch (error) {
      if (!(error instanceof ReadFailure)) throw error;
      return result('unavailable', 'portal_read_failed', { portalError: error.message });
    }
    if (now() + pollMs > deadlineAt) break;
    await sleep(pollMs);
  }
  if (readState) { try { timerStateAfter = await readState(); } catch { timerStateAfter = null; } }
  return settled ? result('correlated', settled.reason, settled.facts) : result('unproved', last);
}

function conclude({ fp, threadOutcome, identity, trace, traceId, data, match }) {
  const spans = trace.spans.spans ?? [], status = trace.spans.processingStatus ?? null;
  const facts = { ...match, instanceCorrelationProved: true, correlatedTraceIdSha256: sha(traceId), processingStatus: status,
    incompleteReasons: [...(trace.spans.incompleteReasons ?? [])], spanCount: spans.length };
  const timers = spans.filter(s => s.SpanType === 'Timer');
  const timer = timers.length === 1 ? timers[0] : null;
  facts.wakeLink = wakeLink({ spans, timer, identity, traceId, data });
  facts.wakeOwnershipProved = facts.wakeLink.state === 'linked';
  facts.completion = { timerSpanStatus: timer?.Status ?? null, timerCleanupActivity: spans.some(s => s.SpanName === 'TimerCleanupActivity' && s.Status === 'Ok'),
    notifyManagerSuccess: spans.some(s => s.SpanName === 'NotifyManagerSuccess' && s.Status === 'Ok') };
  if (status === 'Processing') return { reason: 'trace_processing', outcome: 'pending', facts: { ...facts, outcome: 'pending' } };
  // The Timer span name only checks consistency inside the correlated trace; it never correlates.
  if (!timer) return { reason: 'timer_span_not_unique', facts };
  if (identity.timerName && timer.SpanName !== identity.timerName) return { reason: 'timer_span_mismatch', facts };
  if (/^error$/i.test(timer.Status ?? '')) return { reason: null, outcome: 'failed', facts: { ...facts, outcome: 'failed', executionCompleted: true } };
  if (timer.Status !== 'Ok' || !facts.completion.timerCleanupActivity || !facts.completion.notifyManagerSuccess) return { reason: 'completion_spans_missing', facts };
  if (!(threadOutcome.endedFingerprints ?? []).includes(fp)) return { reason: 'request_bound_thread_end_missing', facts };
  return { reason: null, outcome: 'completed', facts: { ...facts, outcome: 'completed', executionCompleted: true } };
}

// Wake link: the Timer trace's root span (earliest entry span without an in-trace parent; missing
// spans may detach inner branches) has a ParentSpanId that is a span of exactly one other candidate
// trace, at or under the wake caller's ServerAction span. Without that native span link: a native limit.
const nanos = s => /^\d{1,30}$/.test(s.StartTimeUnixNano ?? '') ? BigInt(s.StartTimeUnixNano) : null;
function wakeLink({ spans, timer, identity, traceId, data }) {
  if (!identity.callerName) return { state: 'absent', reason: 'no_app_caller' };
  if (!timer) return { state: 'absent', reason: 'timer_span_not_unique' };
  const ids = new Set(spans.map(s => s.SpanId)), tops = spans.filter(s => !s.ParentSpanId || !ids.has(s.ParentSpanId));
  const entries = tops.filter(s => s.IsEntrySpan === true && nanos(s) !== null).sort((a, b) => nanos(a) < nanos(b) ? -1 : nanos(a) > nanos(b) ? 1 : 0);
  const root = entries[0];
  if (!root) return { state: 'absent', reason: 'timer_root_span_unavailable' };
  if (!root.ParentSpanId) return { state: 'absent', nativeLimit: 'timer_root_span_has_no_cross_trace_parent' };
  const owners = [...data].filter(([id, other]) => id !== traceId && (other.spans.spans ?? []).some(s => s.SpanId === root.ParentSpanId));
  if (owners.length !== 1) return { state: 'absent', reason: owners.length ? 'parent_span_not_unique' : 'parent_span_outside_candidate_traces' };
  const [callerId, caller] = owners[0], callerSpans = new Map((caller.spans.spans ?? []).map(s => [s.SpanId, s]));
  for (let id = root.ParentSpanId, guard = 0; id && callerSpans.has(id) && guard < 1000; guard++) {
    const node = callerSpans.get(id);
    if (node.SpanType === 'ServerAction' && node.SpanName === identity.callerName) return { state: 'linked', callerTraceIdSha256: sha(callerId) };
    id = node.ParentSpanId;
  }
  return { state: 'absent', reason: 'caller_server_action_not_ancestor', callerTraceIdSha256: sha(callerId) };
}

// The runner keeps only a correlation on a fingerprint the trace bound; completion needs that ThreadEnd
// (a failed Timer span is final on its own). Mirrors the O11 Service Center correlator binding.
export function bindOdcTimerInstance(found, threadOutcome) {
  if (!found) return { state: 'unavailable', reason: 'portal_observer_unwired', instanceCorrelationProved: false, executionCompleted: false, wakeOwnershipProved: false };
  const bound = found.instanceCorrelationProved === true && threadOutcome?.requestFingerprintConsistent === true &&
    (threadOutcome.fingerprints ?? []).includes(found.matchedFingerprint);
  if (!bound) return { ...found, instanceCorrelationProved: false, executionCompleted: false, wakeOwnershipProved: false, outcome: found.outcome === 'pending' ? 'pending' : 'unproved',
    ...(found.instanceCorrelationProved === true ? { reason: 'fingerprint_not_in_trace' } : {}) };
  const completed = found.executionCompleted === true && (found.outcome === 'failed' ||
    found.outcome === 'completed' && (threadOutcome.endedFingerprints ?? []).includes(found.matchedFingerprint));
  return { ...found, executionCompleted: completed, ...(completed || found.outcome === 'pending' ? {} : { outcome: 'unproved' }) };
}

// Bound observer over a read-only Portal reader and an optional prepared Timer state reader.
export function createOdcTimerInstanceObserver({ read, identity, readState = null, release = null, pollMs, now, sleep }) {
  const reader = typeof read === 'function' ? read : (operationId, input) => read.execute({ operationId, input });
  const clock = { ...(pollMs ? { pollMs } : {}), ...(now ? { now } : {}), ...(sleep ? { sleep } : {}) };
  return { identity,
    async baseline() {
      if (!readState) return { available: true, state: null };
      try { return { available: true, state: await readState() }; } catch { return { available: false, reason: 'timer_state_unavailable' }; }
    },
    observe: ({ baseline, threadOutcome, requestIdShape, window, deadlineAt }) => observeOdcTimerInstance({ read: reader, identity, threadOutcome,
      requestIdShape, window, before: baseline?.state ?? null, readState, deadlineAt, ...clock }),
    release: async () => release ? release() : { released: true } };
}

// Production default for an app-caller wake: its own developer Portal session (vault credential, no
// Studio or browser cookies), the Timer prepared read-only through the original Portal contract.
// Only for an ODC cloud stage target; null otherwise. The session is released by release().
export function openOdcTimerInstance({ binding, sourceSha256, timer, callerName = null, root, broker: injected, verifyAssets = verifyTimerPortalAssets }) {
  if (!GUID.test(binding?.environmentKey ?? '') || !/^[a-z0-9.-]+\.outsystems\.dev$/.test(binding?.tenant ?? '') || !timer?.timerKey || !timer.name) return null;
  const origin = 'https://' + binding.tenant;
  const identity = { environmentKey: binding.environmentKey.toLowerCase(), applicationKey: keyToGuid(binding.moduleKey), timerName: timer.name, callerName };
  let broker = injected, adapter, plan, observer;
  const open = async () => {
    broker ??= new Odc3PortalBroker({ origin });
    if (broker.origin !== origin || broker.target !== 'odc3') throw new Error('debug_odc_timer_instance_portal_target_mismatch');
    if (!broker.authenticated) { await broker.initialize(); const auth = await broker.authenticate(); if (!auth?.ok || !broker.authenticated) throw new Error('debug_odc_timer_instance_portal_session_required'); }
    adapter = createOdcTimerPortalAdapter({ broker, root, verifyAssets });
    plan = await adapter.prepare({ trigger: 'odc-portal-timer-wake', environmentKey: identity.environmentKey, portalOrigin: origin, entryKey: timer.timerKey, name: timer.name,
      binding: { lane: 'odc', runtimeUrl: binding.runtimeUrl, module: binding.module, moduleKey: binding.moduleKey, revision: binding.revision, sourceSha256 } });
    observer = createOdcTimerInstanceObserver({ read: new PortalReadAdapter({ target: 'odc3', origin, broker, timeoutMs: 30000 }), identity,
      readState: async () => { const { applicationUserContext: _a, appUserIdentityProved: _b, rolesProved: _r, propagationProved: _p, requestOwnershipProved: _o, executionCompleted: _e, ...state } = await adapter.readState(plan); return state; } });
  };
  return { identity,
    async baseline() {
      try { if (!observer) await open(); } catch { return { available: false, reason: 'portal_session_unavailable' }; }
      return observer.baseline();
    },
    async observe(args) {
      if (!observer) return { state: 'unavailable', reason: 'portal_session_unavailable', instanceCorrelationProved: false, executionCompleted: false, wakeOwnershipProved: false };
      return observer.observe(args);
    },
    async release() {
      if (!broker) return { released: true };
      await broker.jar.removeAllCookies(); if (Array.isArray(broker.secrets)) broker.secrets.fill(''); broker.authenticated = false;
      return { released: true };
    } };
}

// Later, read-only recording through status/reconcile: the saved receipt supplies the answered wake,
// its window and the request-bound trace facts. Never re-wakes; an unanswered or uncertain wake refuses.
export async function reconcileOdcTimerInstance({ receipt, observer, deadlineAt = 0 }) {
  if (receipt?.triggerAnswered !== true || receipt.uncertain !== false || !receipt.instanceWindow || !receipt.backgroundTrace)
    return { state: 'refused', reason: 'answered_certain_wake_required', instanceCorrelationProved: false, executionCompleted: false, wakeOwnershipProved: false };
  const threadOutcome = receipt.backgroundTrace;
  const found = await observer.observe({ baseline: null, threadOutcome, requestIdShape: receipt.instanceRequestIdShape ?? null,
    window: receipt.instanceWindow, deadlineAt });
  return { ...bindOdcTimerInstance(found, threadOutcome), recordedLater: true };
}
