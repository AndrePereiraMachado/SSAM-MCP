// The quality recorder of the hosted server (docs/QUALIDADE.md; design ssam-quality/1 sections 2 and 3.2): the hooks
// http-server.mjs calls, the per-session state (call index, arrivals, calls in flight, the last answer that left) and
// the writer of <dir>/quality-YYYYMMDD.jsonl (UTC day of the line's time, mode 0600, one append per line, like the
// audit). Every line is built by quality-record.mjs, passed through sanitizeQualityLine (native ids of the kernel's
// verify catalogs, the hosted tool names; codes and rules only from the contract's registries) and fitLine (4096 bytes):
// codes, counts, times, the token id and the customer label only. Only the hosted mode creates a recorder (ssam.mjs runServed, unless SSAM_QUALITY=0); every hook is called
// inside try/catch and never changes a request, an answer or the audit. A failure is logged as
// {event:"quality-failed", stage, error} at most once a minute per stage (summary, write, span).
import fs from 'node:fs';
import path from 'node:path';
import * as meter from './quality-meter.mjs';
import { sanitizeQualityLine, fitLine, agentVerbOf } from './quality-line.mjs';
import { summarizeMessage, buildCallLine, buildSessionLine, argsSummary, opOf, laneOf, clientFamily, timesFromSpans, categoryOf, frameOf } from './quality-record.mjs';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const idKey = id => JSON.stringify(id);
const toolCalls = body => [body].flat().filter(m => m?.method === 'tools/call' && m.id !== undefined && m.id !== null);
const FAILURE_LOG_MS = 60000;

// dir: the server folder (tokens.json, audit-*.jsonl); log: the server's event log; nativeIds: Set of the native verify
// ids (loadNativeIds); tools: the hosted tool names (keys of hosted/tools.json); lanes: {tool: catalog lane};
// now: the clock of the line times (the audit's); clock: epoch ms of arrivals, answers and spans (Date.now).
export function createQualityRecorder({ dir, log = () => {}, nativeIds = new Set(), tools = [], lanes = {}, now = () => new Date(), clock = () => Date.now() } = {}) {
  if (!dir) throw new Error('dir is required');
  const toolSet = new Set(tools);
  meter.configure({ active: true, nativeIds });
  const byObject = new WeakMap(); // http-server session object -> state
  const byId = new Map();         // mcp-session-id -> state
  const lastFailure = new Map();  // stage -> epoch ms

  function failed(stage, error) {
    const at = clock();
    if (at - (lastFailure.get(stage) ?? -Infinity) < FAILURE_LOG_MS) return;
    lastFailure.set(stage, at);
    // The fs code (EACCES, ENOSPC...) or a code of this module; never a message or a path.
    const value = typeof error === 'string' ? error : error?.code;
    const code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(value) ? value : 'ERROR';
    try { log({ event: 'quality-failed', stage, error: code }); } catch { /* the log never stops a call */ }
  }
  function write(line) {
    let text;
    try {
      const clean = sanitizeQualityLine(line, { nativeIds, tools: toolSet });
      if (!clean) { failed('summary', 'FRAME_INVALID'); return false; }
      text = fitLine(clean, { nativeIds });
    } catch (error) { failed('summary', error); return false; }
    try {
      const file = path.join(dir, 'quality-' + JSON.parse(text).time.slice(0, 10).replaceAll('-', '') + '.jsonl');
      fs.appendFileSync(file, text + '\n', { mode: 0o600 });
      return true;
    } catch (error) { failed('write', error); return false; }
  }
  function stateOf(session) {
    let state = byObject.get(session);
    if (!state) {
      state = { id: null, tokenId: session?.tokenId ?? null, customer: session?.customer ?? null, openedAt: null, client: 'unknown', calls: 0,
        lastAnswerAt: null, arrivals: new Map(), pending: new Map() };
      byObject.set(session, state);
    }
    return state;
  }

  return {
    // relay(): the arrival of each tools/call of a POST (handle() took the time on entry) and the body size of a POST that
    // carried exactly one JSON-RPC message.
    arrived(session, parsedBody, arrivedAt, bodyBytes) {
      const list = toolCalls(parsedBody);
      if (!list.length) return;
      const state = stateOf(session);
      const single = !Array.isArray(parsedBody) || parsedBody.length === 1;
      for (const m of list) state.arrivals.set(idKey(m.id), { at: arrivedAt, bytes: single && Number.isInteger(bodyBytes) ? bodyBytes : null });
    },
    // relay() flushed(): the moment the POST of a tools/call answer left (the latest of this and the hand-over is the
    // session's last answer).
    flushed(session, parsedBody) {
      if (!toolCalls(parsedBody).length) return;
      const state = byObject.get(session);
      if (state && state.calls > 0) state.lastAnswerAt = Math.max(state.lastAnswerAt ?? 0, clock());
    },
    sessionOpened(sid, session, clientName) {
      const state = stateOf(session);
      state.id = sid; state.tokenId = session.tokenId; state.customer = session.customer ?? null;
      state.openedAt = clock(); state.client = clientFamily(clientName);
      byId.set(sid, state);
      write(buildSessionLine({ event: 'opened', time: now(), tokenId: state.tokenId, customer: state.customer, sessionId: sid, client: state.client }));
    },
    sessionClosed(sid, session, reason) {
      const state = byId.get(sid) ?? byObject.get(session);
      byId.delete(sid);
      if (!state) return;
      for (const call of state.pending.values()) meter.endCall(call.key);
      state.pending.clear(); state.arrivals.clear();
      write(buildSessionLine({ event: 'closed', time: now(), tokenId: state.tokenId, customer: state.customer, sessionId: sid, client: state.client,
        reason, calls: state.calls, openMs: state.openedAt === null ? 0 : clock() - state.openedAt }));
    },
    // transport.onmessage, a tools/call with an id: its index, the calls in flight, the gap since the last answer, the form
    // of its arguments; the meter opens its span list under the key ssam.mjs `shaped` runs it with.
    callStarted(sid, message) {
      const state = byId.get(sid);
      if (!state || message?.id === undefined || message.id === null) return;
      const id = idKey(message.id);
      const arrival = state.arrivals.get(id);
      state.arrivals.delete(id);
      const at = arrival?.at ?? clock();
      const params = isObj(message.params) ? message.params : {};
      const tool = typeof params.name === 'string' ? params.name : '?';
      const args = isObj(params.arguments) ? params.arguments : {};
      const key = sid + '\u0000' + id;
      const call = { index: ++state.calls, key, tool, op: opOf(tool, args), lane: laneOf(args, lanes[tool]), args: argsSummary(args, { bytes: arrival?.bytes ?? null }),
        gapMs: state.lastAnswerAt === null ? null : Math.max(0, at - state.lastAnswerAt), inFlight: Math.min(64, state.pending.size), arrival: at };
      state.pending.set(id, call);
      meter.beginCall(state.tokenId, key, at);
    },
    // notifications/cancelled: the call gets no answer and writes no line (its number stays skipped).
    callCancelled(sid, requestId) {
      const state = byId.get(sid);
      const call = state?.pending.get(idKey(requestId));
      if (!call) return;
      state.pending.delete(idKey(requestId));
      meter.endCall(call.key);
    },
    // transport.send, right after the audit line: the line of the call, with the audit's instant, ms and outcome.
    callAnswered(sid, message, { ms, outcome, time = now() } = {}) {
      const state = byId.get(sid);
      const call = state?.pending.get(idKey(message?.id));
      if (!call) return;
      state.pending.delete(idKey(message.id));
      const answeredAt = clock();
      state.lastAnswerAt = Math.max(state.lastAnswerAt ?? 0, answeredAt);
      const spans = meter.endCall(call.key, answeredAt);
      const noted = meter.takeAnswer(call.key);
      const base = { time, tokenId: state.tokenId, customer: state.customer, sessionId: sid, call: call.index, tool: toolSet.has(call.tool) ? call.tool : '?',
        op: call.op, lane: call.lane, ms, gapMs: call.gapMs, inFlight: call.inFlight, ok: outcome?.ok === true, code: outcome?.ok === true ? null : outcome?.error ?? 'TOOL_ERROR' };
      let line;
      try {
        const { protocol, summary, chars, paged } = summarizeMessage(call.tool, null, message, { noted, nativeIds });
        const times = spans ? timesFromSpans(spans.spans, { ms, queue: summary.queue ?? null, window: [Math.min(spans.beginMs, answeredAt - ms), answeredAt], approx: spans.approx, shared: spans.shared })
          : timesFromSpans([], { ms, queue: summary.queue ?? null });
        line = buildCallLine({ ...base, protocol, summary, times, args: call.args, chars, paged });
      } catch (error) {
        failed('summary', error);
        line = { ...frameOf({ kind: 'call', time, tokenId: base.tokenId, customer: base.customer, sessionId: sid }), call: base.call, tool: base.tool, op: base.op, lane: base.lane,
          ms: Math.round(ms), gapMs: base.gapMs, inFlight: base.inFlight, ok: base.ok, code: base.code, class: base.ok ? 'ok' : 'failed', step: null, deliv: null,
          answer: { chars: 0, paged: false, scan: 'error' } };
      }
      write(line);
    },
    // agent-hub.mjs onCallSettled: one settled agent call as a span of the call that made it (2.7). The verb only from its
    // kind's closed list (the hub already sends no other; a span of an unlisted verb keeps its kind and its time).
    agentSpan(span) {
      try {
        if (!isObj(span) || typeof span.tokenId !== 'string') return;
        const verb = agentVerbOf(span.kind, span.verb);
        meter.addSpan(span.tokenId, { cat: categoryOf(span.kind, verb) ?? 'studio', label: span.kind + (verb ? ':' + verb : ''), startMs: span.startMs, ms: span.ms,
          ok: span.ok !== false, ...(Number.isFinite(span.bytes) && span.bytes > 0 ? { bytes: span.bytes } : {}), callKey: span.callKey ?? null });
      } catch (error) { failed('span', error); }
    },
    // Tests: the open state.
    sessions: () => byId.size,
  };
}
