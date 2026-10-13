// The process-wide meter of the quality record (docs/QUALIDADE.md; design ssam-quality/1 sections 2.7 and 3.5): which
// tool call is running (an AsyncLocalStorage entered by ssam.mjs `shaped`), the open calls of each token and the spans
// attributed to them, the kernel runs in progress, and the answer summaries noted before paging. Memory only; nothing
// here writes a file or keeps an answer (a noted answer is summarized at once and only the summary stays).
//   withCall(key, fn) -> fn()          the call key for everything fn awaits or schedules
//   currentCall() -> key | null
//   beginCall(tokenId, key, startMs)   opens the call's span list (http-server callStarted)
//   endCall(key, endMs) -> {spans, shared, approx} | null   closes it; a span reported later is dropped
//   addSpan(tokenId, span)             attribution rules 1-3 (agent spans via the hub's onCallSettled, kernel spans)
//   kernelStart({lane, via}) -> end({via?, ok?, ran?})   token from hostedContext(), call from currentCall(); no-op outside
//   noteAnswer(key, tool, args, result) / takeAnswer(key)
//   configure({nativeIds, now, active}), reset()   (the recorder turns it on; tests)
// Off by default: until a recorder turns it on (hosted mode, SSAM_QUALITY not 0) every entry point is a no-op.
// Attribution (2.7): a span with the key of an open call goes to that call only; a span without one (the O11 kernel's
// bridge calls arrive through the relay socket) goes to the calls of its token whose kernel run was in progress when it
// started; else to every call of the token open when it started. A span given to more than one call marks each `shared`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { hostedContext } from './executor.mjs';
import { summarizeAnswer } from './quality-record.mjs';

export const LIMITS = Object.freeze({ spansPerCall: 1024, callsPerToken: 64, notes: 1024, maxAgeMs: 2 * 60 * 60 * 1000 });

const storage = new AsyncLocalStorage();
let calls = new Map();   // key -> {key, tokenId, beginMs, at, spans, overflow, approx, shared}
let tokens = new Map();  // tokenId -> {calls: Set<key>, runs: [{callKey, startMs, endMs}]}
let notes = new Map();   // key -> {summary, at}
let nativeIds = null;
let clock = () => Date.now();
// Off until a recorder turns it on (hosted mode with the record on): every entry point is then a no-op, so local mode, stdio,
// the CLI and SSAM_QUALITY=0 keep nothing.
let active = false;
export const isActive = () => active;

export function configure({ nativeIds: ids, now, active: on } = {}) {
  if (typeof on === 'boolean') active = on;
  if (ids !== undefined) nativeIds = ids;
  if (typeof now === 'function') clock = now;
}
export function reset() { calls = new Map(); tokens = new Map(); notes = new Map(); nativeIds = null; clock = () => Date.now(); active = false; }

export const withCall = (key, fn) => storage.run(key, fn);
export const currentCall = () => storage.getStore() ?? null;

const tokenOf = tokenId => { let t = tokens.get(tokenId); if (!t) tokens.set(tokenId, t = { calls: new Set(), runs: [] }); return t; };
function forget(key) {
  const call = calls.get(key);
  if (!call) return null;
  calls.delete(key);
  const t = tokens.get(call.tokenId);
  if (t) {
    t.calls.delete(key);
    t.runs = t.runs.filter(r => r.callKey !== key);
    if (!t.calls.size && !t.runs.length) tokens.delete(call.tokenId);
  }
  return call;
}
// Anything older than maxAgeMs (a call whose answer never left, a note never taken) goes on the next call.
function sweep(at) {
  for (const [key, call] of calls) if (at - call.at > LIMITS.maxAgeMs) forget(key);
  for (const [key, note] of notes) if (at - note.at > LIMITS.maxAgeMs) notes.delete(key);
}

export function beginCall(tokenId, key, startMs = clock()) {
  if (!active || typeof tokenId !== 'string' || typeof key !== 'string') return;
  const at = clock();
  sweep(at);
  forget(key);
  const t = tokenOf(tokenId);
  // At most callsPerToken open calls: the oldest leaves (its line is written without spans).
  while (t.calls.size >= LIMITS.callsPerToken) forget(t.calls.values().next().value);
  calls.set(key, { key, tokenId, beginMs: startMs, at, spans: [], overflow: new Map(), approx: false, shared: false });
  tokenOf(tokenId).calls.add(key);
}

// Closes a call: its spans (the kept ones, then one aggregated entry per label for those above spansPerCall).
export function endCall(key, endMs = clock()) {
  const call = forget(key);
  if (!call) return null;
  return { spans: [...call.spans, ...call.overflow.values()], shared: call.shared, approx: call.approx, beginMs: call.beginMs, endMs };
}

function give(call, span) {
  if (call.spans.length < LIMITS.spansPerCall) { call.spans.push(span); return; }
  call.approx = true;
  const id = span.cat + '|' + span.label + '|' + (span.via ?? '');
  const e = call.overflow.get(id) ?? { cat: span.cat, label: span.label, startMs: span.startMs, ms: 0, n: 0, failed: 0, bytes: 0, ...(span.via ? { via: span.via } : {}) };
  e.ms += span.ms; e.n++; if (span.ok === false) e.failed++; if (Number.isFinite(span.bytes)) e.bytes += span.bytes;
  call.overflow.set(id, e);
}

// span: {cat, label, startMs, ms, ok, bytes?, via?, callKey?}. Returns the keys of the calls it went to.
export function addSpan(tokenId, span) {
  if (!active || !span || typeof span !== 'object' || !Number.isFinite(span.startMs) || !Number.isFinite(span.ms)) return [];
  const { callKey = null, ...rest } = span;
  const clean = { ...rest, ms: Math.max(0, span.ms) };
  let targets;
  if (callKey !== null && callKey !== undefined) {
    // Rule 1: the call that made it, while it is open (a span reported after its call ended is dropped).
    const call = calls.get(callKey);
    targets = call && (tokenId == null || call.tokenId === tokenId) ? [call] : [];
  } else {
    const t = tokens.get(tokenId);
    if (!t) return [];
    // Rule 2: the calls of the token whose kernel run was in progress when the span started.
    const running = new Set(t.runs.filter(r => r.startMs <= span.startMs && (r.endMs === null || r.endMs >= span.startMs)).map(r => r.callKey));
    targets = [...running].map(k => calls.get(k)).filter(Boolean);
    // Rule 3: every call of the token open when it started.
    if (!targets.length) targets = [...t.calls].map(k => calls.get(k)).filter(c => c && c.beginMs <= span.startMs);
  }
  if (targets.length > 1) for (const call of targets) call.shared = true;
  for (const call of targets) give(call, clean);
  return targets.map(c => c.key);
}

// One kernel run at its leaf (2.7): call right before the run, end() right after it (in finally), exactly once. end
// takes the way it really ran ({via}), ok, and ran:false for a worker that ran nothing (its cold fallback is the span).
const NOOP = Object.freeze(Object.assign(() => {}, { noop: true }));
export function kernelStart({ lane = null, via = 'cold' } = {}) {
  if (!active) return NOOP;
  let context = null;
  try { context = hostedContext(); } catch { context = null; }
  const tokenId = context?.tokenId;
  if (typeof tokenId !== 'string') return NOOP;
  const callKey = currentCall();
  const startMs = clock();
  const run = callKey !== null && calls.has(callKey) ? { callKey, startMs, endMs: null } : null;
  if (run) tokenOf(tokenId).runs.push(run);
  let done = false;
  return function end({ via: how = via, ok = true, ran = true } = {}) {
    if (done) return;
    done = true;
    const endMs = clock();
    if (run) { run.endMs = endMs; if (!ran) { const t = tokens.get(tokenId); if (t) t.runs = t.runs.filter(r => r !== run); } }
    if (!ran) return;
    addSpan(tokenId, { cat: 'kernel', label: 'kernel', startMs, ms: endMs - startMs, ok: ok !== false, via: how, ...(lane ? { lane } : {}), callKey });
  };
}

// The shaped answer before paging (D5), summarized now; only the summary stays, until taken or 2 h.
export function noteAnswer(key, tool, args, result) {
  if (!active || typeof key !== 'string') return;
  const at = clock();
  notes.delete(key);
  while (notes.size >= LIMITS.notes) notes.delete(notes.keys().next().value);
  notes.set(key, { summary: summarizeAnswer(tool, args, result, { scan: 'full', nativeIds }), at });
}
export function takeAnswer(key) {
  const note = notes.get(key);
  if (!note) return null;
  notes.delete(key);
  return note.summary;
}

// Tests: the sizes of the registry.
export const sizes = () => ({ calls: calls.size, tokens: tokens.size, notes: notes.size, runs: [...tokens.values()].reduce((s, t) => s + t.runs.length, 0) });
