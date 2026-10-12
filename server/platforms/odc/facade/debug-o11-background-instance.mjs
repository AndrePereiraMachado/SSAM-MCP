// Read-only Service Center correlation and completion of one O11 Timer instance.
// The only identity is exact: sha256(Service Center RequestKey) equal to the
// debugger's request-bound native fingerprint. Timer name, log time or module
// alone never correlate. Public results carry hashes only, never the RequestKey
// or error ids. Nothing here writes, re-wakes or resends Run Now.
import { createHash } from 'node:crypto';
import { timerLogSnapshot, compareTimerLogs, observeTimerErrors } from './service-center/timer-observation.mjs';

const fail = code => { throw new Error('debug_native_background_timer_instance_' + code); };
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const SHA = /^[a-f0-9]{64}$/, KEY = /^[A-Za-z0-9_-]{8,100}$/, GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LOG_LIMIT = 200, TIMER_LOG_LIMIT = 1000;

// RequestKey from a Service Center log row: the GroupedRequest_Logs link on the same
// host, or a detail field. Untrusted links never become requests here.
export function requestKeysOfRow(row, host) {
  const keys = new Set();
  for (const link of row?.links ?? []) {
    try {
      const url = new URL(link.href);
      if (url.protocol !== 'https:' || url.hostname !== host || url.pathname.toLowerCase() !== '/servicecenter/groupedrequest_logs.aspx') continue;
      const value = url.searchParams.get('RequestKey');
      if (KEY.test(value ?? '')) keys.add(value);
    } catch { /* malformed link: no key */ }
  }
  for (const name of ['Request Key', 'RequestKey']) {
    const value = typeof row?.fields?.[name] === 'string' ? row.fields[name].trim() : '';
    if (KEY.test(value)) keys.add(value);
  }
  return [...keys];
}
// A GUID is one identifier in either case; any other key is compared byte for byte.
const hashesOf = key => GUID.test(key) ? [...new Set([key, key.toLowerCase(), key.toUpperCase()])].map(form => [sha(form), form === key ? 'exact' : 'guid-case']) : [[sha(key), 'exact']];

function identityOf({ identity, target }) {
  let url;
  try { url = new URL(target); } catch { fail('identity_invalid'); }
  if (!identity || url.protocol !== 'https:' || url.hostname !== identity.host || !/^[1-9]\d{0,9}$/.test(String(identity.moduleId ?? '')) ||
      !/^[A-Za-z_]\w*$/.test(identity.name ?? '') || identity.module !== undefined && !/^[A-Za-z_][\w.]*$/.test(identity.module)) fail('identity_invalid');
  return { host: identity.host, moduleId: String(identity.moduleId), name: identity.name, ...(identity.module ? { module: identity.module } : {}) };
}

export async function timerInstanceBaseline({ client, identity, target }) {
  const id = identityOf({ identity, target });
  return timerLogSnapshot(await client.logs('timer', TIMER_LOG_LIMIT, { timer: id.name }), id, target);
}

export async function observeO11TimerInstance({ client, identity, target, baseline, threadOutcome, deadlineAt,
  pollMs = 3000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const id = identityOf({ identity, target });
  let polls = 0, newExactTimerRowObserved = null, newExactRows = 0, keysObserved = 0;
  const result = (state, reason, extra = {}) => ({ schema: 'ssam-o11-timer-instance/1', state, reason, readOnly: true,
    correlationMethod: 'sha256(Service Center RequestKey) == native request fingerprint', nameOrTimeCorrelation: false,
    instanceCorrelationProved: false, newExactTimerRowObserved, executionCompleted: false, outcome: 'unproved', newExactRows, requestKeysObserved: keysObserved,
    polls, requestKeySha256: null, matchedFingerprint: null, errorBound: null, wakeOwnershipProved: false, ...extra });
  if (!baseline?.available) return result('unproved', 'baseline_unavailable', { baselineReason: baseline?.reason ?? null });
  // Only a request fingerprint present on every target frame can identify the request.
  const fingerprints = new Set(threadOutcome?.requestFingerprintConsistent === true ? (threadOutcome.fingerprints ?? []).filter(f => SHA.test(f)) : []);
  if (fingerprints.size !== 1) return result('unproved', 'request_fingerprint_unavailable');
  const filters = id.module ? { module: id.module } : {};
  let last = 'no_new_exact_row';
  for (;;) {
    polls++;
    const listing = await client.logs('timer', TIMER_LOG_LIMIT, { timer: id.name });
    const comparison = compareTimerLogs(baseline, timerLogSnapshot(listing, id, target));
    newExactTimerRowObserved = comparison.executionObserved;
    if (comparison.executionObserved === true) {
      newExactRows = comparison.newRuns.length;
      if (newExactRows > 1) return result('ambiguous', 'new_exact_rows_not_unique');
      const run = comparison.newRuns[0];
      // Keys of the raw row behind the new run, matched by the same stable row fingerprint.
      const rowKeys = new Set((listing.rows ?? []).filter(row => timerLogSnapshot({ complete: true, rows: [row] }, id, target).runs?.[0]?.fingerprint === run.fingerprint)
        .flatMap(row => requestKeysOfRow(row, id.host)));
      const general = await client.logs('general', LOG_LIMIT, filters), errors = await client.logs('error', LOG_LIMIT, filters);
      const candidates = new Map();
      const add = (rows, source) => { for (const row of rows ?? []) for (const key of requestKeysOfRow(row, id.host)) {
        const entry = candidates.get(key) ?? { key, sources: new Set() }; entry.sources.add(source); candidates.set(key, entry); } };
      add([...rowKeys].map(key => ({ fields: { 'Request Key': key } })), 'timer-log'); add(general.rows, 'general-log'); add(errors.rows, 'error-log');
      keysObserved = candidates.size;
      const matches = [...candidates.values()].flatMap(entry => hashesOf(entry.key).filter(([hash]) => fingerprints.has(hash)).slice(0, 1)
        .map(([hash, form]) => ({ ...entry, hash, form })));
      if (matches.length > 1) return result('ambiguous', 'request_key_matches_not_unique');
      if (matches.length === 1) {
        const match = matches[0];
        if (rowKeys.size && !rowKeys.has(match.key)) return result('unproved', 'timer_row_request_key_mismatch');
        return conclude({ client, id, comparison, run, match, threadOutcome, errorRows: errors.rows ?? [], result });
      }
      last = candidates.size ? 'request_key_not_matched' : 'request_key_unavailable';
    } else last = comparison.reason && comparison.executionObserved === null ? comparison.reason : 'no_new_exact_row';
    if (now() + pollMs > deadlineAt) break;
    await sleep(pollMs);
  }
  if (last === 'request_key_unavailable')
    return result('refused', last, { error: 'debug_native_background_timer_request_key_unavailable' });
  return result('unproved', last);
}

async function conclude({ client, id, comparison, run, match, threadOutcome, errorRows, result }) {
  const correlated = { instanceCorrelationProved: true, requestKeySha256: sha(match.key), matchedFingerprint: match.hash, matchForm: match.form,
    correlationSources: [...match.sources].sort() };
  let trace;
  try { trace = await client.trace(match.key); } catch { return result('correlated', 'request_trace_unavailable', correlated); }
  const errors = await observeTimerErrors(comparison, id, errorId => client.errorDetail(errorId));
  const failure = errors.errorObservations.find(o => o.outcome === 'failed' && o.requestKey === match.key);
  const traceErrors = (trace?.logs?.rows ?? []).filter(row => /error/i.test(row?.fields?.['Event Type'] ?? '')).length;
  const errorLogRows = errorRows.filter(row => requestKeysOfRow(row, id.host).includes(match.key)).length;
  const bindings = [...(failure ? [{ source: 'timer-error-detail', errorIdSha256: sha(failure.errorId) }] : []),
    ...(errorLogRows ? [{ source: 'error-log', rows: errorLogRows }] : []), ...(traceErrors ? [{ source: 'request-log', events: traceErrors }] : [])];
  const facts = { ...correlated, errorBound: bindings.length > 0, errorBindings: bindings,
    requestLog: { events: trace?.logs?.rows?.length ?? 0, complete: trace?.logs?.complete === true, errorEvents: traceErrors } };
  if (bindings.length) return result('correlated', 'error_bound_to_request', { ...facts, outcome: 'failed', executionCompleted: true,
    retryScheduled: failure?.retryScheduled ?? null, retriesExhausted: failure?.retriesExhausted ?? null });
  // Completion needs the clean exact row, a complete request log and a ThreadEnd of the same request.
  const reason = run.hasErrorLink ? 'row_has_error_link' : !errors.errorDetailsComplete ? 'error_details_incomplete'
    : trace?.logs?.complete !== true ? 'request_log_incomplete'
    : !(threadOutcome.endedFingerprints ?? []).includes(match.hash) ? 'request_bound_thread_end_missing' : null;
  if (reason) return result('correlated', reason, facts);
  return result('correlated', null, { ...facts, outcome: 'completed', executionCompleted: true });
}

// Bound observer: the entry wiring supplies a read-only Service Center client and the
// Timer identity (inventory ModuleId, Timer name, Service Center timer page URL).
export function createO11TimerInstanceObserver({ client, identity, target, pollMs, now, sleep }) {
  identityOf({ identity, target });
  if (typeof client?.logs !== 'function' || typeof client.trace !== 'function' || typeof client.errorDetail !== 'function') fail('client_invalid');
  const clock = { ...(pollMs ? { pollMs } : {}), ...(now ? { now } : {}), ...(sleep ? { sleep } : {}) };
  return {
    baseline: () => timerInstanceBaseline({ client, identity, target }),
    observe: ({ baseline, threadOutcome, deadlineAt }) => observeO11TimerInstance({ client, identity, target, baseline, threadOutcome, deadlineAt, ...clock }),
  };
}
