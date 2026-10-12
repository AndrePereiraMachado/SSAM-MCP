// Quality aggregates of the hosted server's ssam-quality/1 lines (DESIGN-QUALIDADE 4.2, 4.3): per local day and token,
// the calls, failures, refusal problems by code, engine normalizations by rule, phase times per tool, idle gaps, the
// delivery chains of each MCP session (calls up to "entregue", model turns, refusals before success, what each refusal
// code cost) and the MCP client families. The rules are those of tests/fixtures/quality/reference-aggregate.mjs, applied
// incrementally: day files /state/agg-quality/quality-YYYY-MM-DD.json (schema ssam-console-quality/1, rewritten every 30 s
// while dirty), and a checkpoint part (the open chains per session and the dirty days) that matches the reader positions.
// Every line reaches here through sanitizeQualityLine (quality-line.mjs): only codes, counts, durations, the token id and
// the tool names; every map keyed by them goes through keys.mjs, also after a reload.
import { sanitizeQualityLine } from './quality-line.mjs';
import { inc, own, put, slot } from './keys.mjs';
import { bucketOf } from './usage.mjs';

export const QUALITY_SCHEMA = 'ssam-console-quality/1';
export const QUALITY_DIR = 'agg-quality';
export const RULES = Object.freeze({
  longGapMs: 600_000,        // a gap above 10 min is a pause (probably the person), out of the gap percentiles
  chainBreakMs: 1_800_000,   // a gap above 30 min ends the current chain (as "sem entrega" when it had an attempt)
  turnGapMs: 1_000,          // a model turn: nothing of the session in flight and at least 1 s since the last answer
  idleCloseMs: 7_200_000,    // a session without a line for 2 h is finished as if closed
});
const FORGET_SESSION_MS = 24 * 3600_000;   // a session silent this long leaves memory (its client family with it)
const MAX_SESSIONS = 50_000;
const MAX_REFUSALS = 200;                  // refusal records kept per chain (the count stays exact)
const INT_KEY_CAP = 500;                   // count stats keep exact integers up to this key
const TOKEN = /^tok_[0-9a-f]{12}$/;
const SESSION = /^[0-9a-f]{12}$/;

// Calls that try to change the module or the environment (reference-aggregate.mjs isAttempt).
export const DELIVER_TOOLS = Object.freeze(['o11_deliver', 'studio_deliver']);
export const CREATE_ATTEMPTS = Object.freeze({ __proto__: null, studio_create: null, studio_create_app: ['create'], o11_environment: ['create-app', 'add-modules', 'create-module'] });
export const isAttempt = l => (DELIVER_TOOLS.includes(l.tool) && l.op !== 'close' && (l.args?.until ?? 'merge') === 'merge')
  || (l.tool in CREATE_ATTEMPTS && (CREATE_ATTEMPTS[l.tool] === null || CREATE_ATTEMPTS[l.tool].includes(l.op)));
// The phase columns of the console and the line keys they read (transfer also holds the doctor's network probe).
export const COLUMNS = Object.freeze({ queue: ['queue'], capture: ['capture'], compile: ['kernelOwn'], studio: ['studio'], verify: ['verify'],
  publish: ['publish'], environment: ['environment'], transfer: ['transfer', 'network'], rest: ['rest'] });
export const COLUMN_KEYS = Object.freeze(Object.keys(COLUMNS));

// ---- statistics (the buckets of usage.mjs; zeros apart for durations, exact integers for counts)
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const durStat = () => ({ n: 0, zeros: 0, hist: {}, sum: 0, max: 0 });
export function addDur(s, value) {
  const ms = Math.max(0, num(value));
  s.n++; s.sum += ms; if (ms > s.max) s.max = ms;
  if (!ms) { s.zeros++; return; }
  inc(s.hist, String(bucketOf(ms)));
}
export function mergeDur(into, from) {
  if (!from) return into;
  into.n += num(from.n); into.zeros += num(from.zeros); into.sum += num(from.sum); into.max = Math.max(into.max, num(from.max));
  for (const [k, c] of Object.entries(from.hist ?? {})) inc(into.hist, k, num(c));
  return into;
}
// Rank ceil(q*n); a rank among the zeros is 0; else interpolated inside its bucket, never above the exact max.
export function durQuantile(s, q) {
  if (!s || !s.n) return null;
  const target = Math.max(1, Math.ceil(q * s.n));
  if (target <= s.zeros) return 0;
  let cum = s.zeros;
  for (const k of Object.keys(s.hist).map(Number).sort((a, b) => a - b)) {
    const c = s.hist[k];
    if (cum + c >= target) {
      const lo = k === 0 ? 0 : 10 * 1.1 ** (k - 1), hi = k === 0 ? 10 : 10 * 1.1 ** k;
      return Math.round(Math.min(lo + (hi - lo) * ((target - cum - 0.5) / c), s.max));
    }
    cum += c;
  }
  return null;
}
export const intStat = () => ({ n: 0, hist: {}, sum: 0, max: 0 });
export function addInt(s, value) {
  const v = Math.max(0, Math.round(num(value)));
  s.n++; s.sum += v; if (v > s.max) s.max = v;
  inc(s.hist, String(Math.min(v, INT_KEY_CAP)));
}
export function mergeInt(into, from) {
  if (!from) return into;
  into.n += num(from.n); into.sum += num(from.sum); into.max = Math.max(into.max, num(from.max));
  for (const [k, c] of Object.entries(from.hist ?? {})) inc(into.hist, k, num(c));
  return into;
}
// Nearest rank on exact integers.
export function intQuantile(s, q) {
  if (!s || !s.n) return null;
  const target = Math.max(1, Math.ceil(q * s.n));
  let cum = 0;
  for (const k of Object.keys(s.hist).map(Number).sort((a, b) => a - b)) { cum += s.hist[k]; if (cum >= target) return k; }
  return null;
}
export const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const byCountThenKey = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
const top3 = m => Object.entries(m ?? {}).sort(byCountThenKey).slice(0, 3);
const topKey = m => top3(m)[0]?.[0] ?? null;
const maxIso = (a, b) => (!a || (b && b > a) ? b : a);
const isoOf = ms => new Date(ms).toISOString();
const mergeCounts = (into, from) => { for (const [k, n] of Object.entries(from ?? {})) inc(into, k, num(n)); return into; };

// ---- the day aggregate (4.3)
export const emptyQualityDay = day => ({ schema: QUALITY_SCHEMA, day, byToken: {} });
const colStats = () => Object.fromEntries(COLUMN_KEYS.map(c => [c, durStat()]));
export const tokenAgg = () => ({ calls: 0, failures: 0, refusals: 0, delivered: 0, uncertain: 0, shared: 0, problems: 0, withPatch: 0, problemPhases: {},
  normalizations: 0, normalizedCalls: 0, errors: {}, codes: {}, rules: {}, tools: {}, gaps: durStat(), longGaps: 0,
  chains: { closed: 0, open: 0, calls: intStat(), turns: intStat(), refusals: intStat(), wall: durStat(), idleMs: 0, wallMs: 0 },
  causes: {}, clients: {} });
const toolAgg = () => ({ calls: 0, failures: 0, refusals: 0, delivered: 0, shared: 0, kernelRuns: 0, kernelCold: 0, bytes: 0, total: durStat(), cols: colStats() });
const clientAgg = () => ({ sessions: 0, chains: 0, calls: intStat(), turns: intStat(), refusals: intStat(), gaps: durStat() });
const causeAgg = () => ({ chains: 0, refusals: 0, extraCalls: intStat(), extraMs: durStat() });

// ---- the walk (reference-aggregate.mjs aggregate(), one line at a time). dayOf(iso) gives the local day; dayAgg(day)
// the aggregate a contribution goes into (the caller marks it dirty). Lines come sanitized, in file order.
export function createQualityEngine({ dayOf, dayAgg }) {
  let sessions = new Map();      // token|session -> {client, lastAtMs, chain}
  let lineClock = 0;             // newest line time applied (ms): the clock of a replay
  const agg = (day, token) => slot(dayAgg(day).byToken, token, tokenAgg);

  function finishChain(s, endIso, delivered) {
    const c = s.chain;
    s.chain = null;
    if (!c || !c.attempts) return;                    // only reads: not a chain
    const a = agg(dayOf(endIso), c.token);
    if (!delivered) { a.chains.open++; return; }
    const endMs = Date.parse(endIso), wall = Math.max(0, endMs - c.firstArrivalMs);
    a.chains.closed++; addInt(a.chains.calls, c.calls); addInt(a.chains.turns, c.turns); addInt(a.chains.refusals, c.refusalCount); addDur(a.chains.wall, wall);
    a.chains.idleMs += c.idleMs; a.chains.wallMs += wall;
    const cl = slot(a.clients, s.client ?? 'unknown', clientAgg);
    cl.chains++; addInt(cl.calls, c.calls); addInt(cl.turns, c.turns); addInt(cl.refusals, c.refusalCount);
    const seen = new Set();
    for (const r of c.refusals) for (const code of r.codes) {
      const x = slot(a.causes, code, causeAgg);
      if (!seen.has(code)) { seen.add(code); x.chains++; }
      x.refusals++; addInt(x.extraCalls, c.calls - r.atCalls); addDur(x.extraMs, endMs - r.atMs);
    }
  }

  function sessionOf(key, atMs) {
    let s = sessions.get(key);
    if (!s) {
      if (sessions.size >= MAX_SESSIONS) forgetOldest();
      s = { client: null, lastAtMs: atMs, chain: null };
      sessions.set(key, s);
    }
    return s;
  }
  function forgetOldest() {
    let oldestKey = null, oldest = Infinity;
    for (const [k, s] of sessions) if (!s.chain && s.lastAtMs < oldest) { oldest = s.lastAtMs; oldestKey = k; }
    if (oldestKey === null) for (const [k, s] of sessions) if (s.lastAtMs < oldest) { oldest = s.lastAtMs; oldestKey = k; }
    if (oldestKey !== null) sessions.delete(oldestKey);
  }

  function apply(l) {
    const key = l.token + '|' + l.session;
    const atMs = Date.parse(l.time);
    if (atMs > lineClock) lineClock = atMs;
    if (l.kind === 'session') {
      if (l.event === 'opened') {
        const s = sessionOf(key, atMs);
        s.client = l.client;
        slot(agg(dayOf(l.time), l.token).clients, l.client, clientAgg).sessions++;
      } else {
        const s = sessions.get(key);
        if (s) finishChain(s, l.time, false);
        sessions.delete(key);
      }
      return;
    }
    const s = sessionOf(key, atMs);
    const endMs = atMs, arrival = endMs - l.ms;
    const idleGap = l.call > 1 && l.gapMs !== null && l.inFlight === 0;
    // A pause above chainBreakMs ends the chain before this call.
    if (idleGap && l.gapMs > RULES.chainBreakMs && s.chain) finishChain(s, isoOf(arrival), false);
    s.chain ??= { token: l.token, firstArrivalMs: arrival, calls: 0, turns: 0, attempts: 0, refusals: [], refusalCount: 0, idleMs: 0 };
    const c = s.chain;
    c.calls++;
    if (c.calls === 1 || (l.inFlight === 0 && (l.gapMs === null || l.gapMs >= RULES.turnGapMs))) c.turns++;
    if (idleGap && c.calls > 1 && l.gapMs <= RULES.longGapMs) c.idleMs += l.gapMs;
    if (isAttempt(l)) {
      c.attempts++;
      if (!l.deliv && l.class !== 'ok') {
        c.refusalCount++;
        if (c.refusals.length < MAX_REFUSALS) c.refusals.push({ codes: l.problems?.byCode ? Object.keys(l.problems.byCode) : [l.code ?? 'TOOL_ERROR'], atCalls: c.calls, atMs: endMs });
      }
    }
    // The call itself, in the local day of its time.
    const a = agg(dayOf(l.time), l.token);
    const t = slot(a.tools, l.tool, toolAgg);
    a.calls++; t.calls++;
    if (!l.ok) {
      a.failures++; t.failures++;
      const e = slot(a.errors, l.code, () => ({ count: 0, lastAt: null, tools: {} }));
      e.count++; inc(e.tools, l.tool); e.lastAt = maxIso(e.lastAt, l.time);
    }
    if (l.class === 'refused') { a.refusals++; t.refusals++; }
    if (l.class === 'uncertain') a.uncertain++;
    if (l.deliv) { a.delivered++; t.delivered++; }
    if (l.problems) {
      a.problems += l.problems.n;
      mergeCounts(a.problemPhases, l.problems.byPhase);
      for (const n of Object.values(l.problems.withPatch ?? {})) a.withPatch += n;
      for (const [code, n] of Object.entries(l.problems.byCode ?? {})) {
        const p = slot(a.codes, code, () => ({ count: 0, refusals: 0, withPatch: 0, tools: {} }));
        p.count += n; p.refusals++; p.withPatch += num(own(l.problems.withPatch, code)); inc(p.tools, l.tool, n);
      }
    }
    if (l.norm) {
      a.normalizations += l.norm.n; a.normalizedCalls++;
      for (const [rule, n] of Object.entries(l.norm.byRule ?? {})) {
        const r = slot(a.rules, rule, () => ({ count: 0, calls: 0, tools: {} }));
        r.count += n; r.calls++; inc(r.tools, l.tool, n);
      }
    }
    if (l.agent?.shared) { a.shared++; t.shared++; }
    else {
      addDur(t.total, l.ms);
      for (const col of COLUMN_KEYS) addDur(t.cols[col], COLUMNS[col].reduce((sum, k) => sum + num(l.t?.[k]), 0));
      t.kernelRuns += num(l.kernel?.runs); t.kernelCold += num(l.kernel?.cold); t.bytes += num(l.agent?.bytes);
    }
    if (idleGap) {
      if (l.gapMs > RULES.longGapMs) a.longGaps++;
      else { addDur(a.gaps, l.gapMs); addDur(slot(a.clients, s.client ?? 'unknown', clientAgg).gaps, l.gapMs); }
    }
    if (l.deliv) finishChain(s, l.time, true);
    s.lastAtMs = endMs;
  }

  // Sessions without a line for idleCloseMs finish their chain as if closed, at lastAt + idleCloseMs (the console's tick
  // with its clock, a replay with the newest line time); a session silent for a day leaves memory.
  function sweep(atMs) {
    for (const [key, s] of sessions) {
      if (s.chain && s.lastAtMs + RULES.idleCloseMs <= atMs) finishChain(s, isoOf(s.lastAtMs + RULES.idleCloseMs), false);
      if (!s.chain && s.lastAtMs + FORGET_SESSION_MS <= atMs) sessions.delete(key);
    }
  }

  const codeList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 64).slice(0, 64) : []);
  const n0 = v => (Number.isFinite(v) ? v : 0);
  function chainOf(c) {
    if (!c || typeof c !== 'object' || typeof c.token !== 'string' || !TOKEN.test(c.token)) return null;
    const refusals = (Array.isArray(c.refusals) ? c.refusals : []).slice(0, MAX_REFUSALS)
      .map(r => ({ codes: codeList(r?.codes), atCalls: n0(r?.atCalls), atMs: n0(r?.atMs) }));
    return { token: c.token, firstArrivalMs: n0(c.firstArrivalMs), calls: n0(c.calls), turns: n0(c.turns), attempts: n0(c.attempts),
      refusals, refusalCount: Math.max(n0(c.refusalCount), refusals.length), idleMs: n0(c.idleMs) };
  }
  return {
    apply, sweep,
    get lineClock() { return lineClock; },
    get sessionCount() { return sessions.size; },
    toJSON: () => ({ lineClock, list: [...sessions].map(([key, s]) => ({ key, client: s.client, lastAtMs: s.lastAtMs, chain: s.chain })) }),
    restore(saved) {
      sessions = new Map();
      lineClock = n0(saved?.lineClock);
      for (const e of Array.isArray(saved?.list) ? saved.list.slice(0, MAX_SESSIONS) : []) {
        const [tok, ses] = String(e?.key ?? '').split('|');
        if (!TOKEN.test(tok ?? '') || !SESSION.test(ses ?? '')) continue;
        sessions.set(`${tok}|${ses}`, { client: typeof e.client === 'string' && /^[a-z-]{1,20}$/.test(e.client) ? e.client : null,
          lastAtMs: n0(e.lastAtMs), chain: chainOf(e.chain) });
      }
    },
  };
}

// ---- range summary (4.4): the day aggregates of the range merged per token, then the tables of /api/quality
function mergeToken(into, from) {
  for (const k of ['calls', 'failures', 'refusals', 'delivered', 'uncertain', 'shared', 'problems', 'withPatch', 'normalizations', 'normalizedCalls', 'longGaps']) into[k] += num(from[k]);
  mergeCounts(into.problemPhases, from.problemPhases);
  for (const [code, e] of Object.entries(from.errors ?? {})) {
    const x = slot(into.errors, code, () => ({ count: 0, lastAt: null, tools: {} }));
    x.count += num(e?.count); x.lastAt = maxIso(x.lastAt, typeof e?.lastAt === 'string' ? e.lastAt : null); mergeCounts(x.tools, e?.tools);
  }
  for (const [code, p] of Object.entries(from.codes ?? {})) {
    const x = slot(into.codes, code, () => ({ count: 0, refusals: 0, withPatch: 0, tools: {} }));
    x.count += num(p?.count); x.refusals += num(p?.refusals); x.withPatch += num(p?.withPatch); mergeCounts(x.tools, p?.tools);
  }
  for (const [rule, r] of Object.entries(from.rules ?? {})) {
    const x = slot(into.rules, rule, () => ({ count: 0, calls: 0, tools: {} }));
    x.count += num(r?.count); x.calls += num(r?.calls); mergeCounts(x.tools, r?.tools);
  }
  for (const [tool, t] of Object.entries(from.tools ?? {})) {
    const x = slot(into.tools, tool, toolAgg);
    for (const k of ['calls', 'failures', 'refusals', 'delivered', 'shared', 'kernelRuns', 'kernelCold', 'bytes']) x[k] += num(t?.[k]);
    mergeDur(x.total, t?.total);
    for (const c of COLUMN_KEYS) mergeDur(x.cols[c], t?.cols?.[c]);
  }
  mergeDur(into.gaps, from.gaps);
  const ch = from.chains ?? {};
  into.chains.closed += num(ch.closed); into.chains.open += num(ch.open); into.chains.idleMs += num(ch.idleMs); into.chains.wallMs += num(ch.wallMs);
  mergeInt(into.chains.calls, ch.calls); mergeInt(into.chains.turns, ch.turns); mergeInt(into.chains.refusals, ch.refusals); mergeDur(into.chains.wall, ch.wall);
  for (const [code, x] of Object.entries(from.causes ?? {})) {
    const y = slot(into.causes, code, causeAgg);
    y.chains += num(x?.chains); y.refusals += num(x?.refusals); mergeInt(y.extraCalls, x?.extraCalls); mergeDur(y.extraMs, x?.extraMs);
  }
  for (const [family, c] of Object.entries(from.clients ?? {})) {
    const y = slot(into.clients, family, clientAgg);
    y.sessions += num(c?.sessions); y.chains += num(c?.chains);
    mergeInt(y.calls, c?.calls); mergeInt(y.turns, c?.turns); mergeInt(y.refusals, c?.refusals); mergeDur(y.gaps, c?.gaps);
  }
  return into;
}

// aggs: the day aggregates of the range; token limits every table to one license; nameOf(token) names a customer.
export function summarizeQuality(aggs, { token = null, nameOf = t => t } = {}) {
  const T = new Map();
  for (const d of aggs) {
    for (const [tok, a] of Object.entries(d?.byToken ?? {})) {
      if (!TOKEN.test(tok) || (token && tok !== token) || !a || typeof a !== 'object') continue;
      if (!T.has(tok)) T.set(tok, tokenAgg());
      mergeToken(T.get(tok), a);
    }
  }
  const all = [...T.entries()];
  // A token is a customer of the range when it had a call or ended a chain there (session lines alone only feed byClient).
  const present = all.filter(([, a]) => a.calls || a.chains.closed || a.chains.open);
  const sumOf = f => all.reduce((s, [, a]) => s + f(a), 0);
  const chainCalls = all.reduce((s, [, a]) => mergeInt(s, a.chains.calls), intStat());
  const chainRefusals = all.reduce((s, [, a]) => mergeInt(s, a.chains.refusals), intStat());
  const chainTurns = all.reduce((s, [, a]) => mergeInt(s, a.chains.turns), intStat());
  const chainWall = all.reduce((s, [, a]) => mergeDur(s, a.chains.wall), durStat());
  const gaps = all.reduce((s, [, a]) => mergeDur(s, a.gaps), durStat());
  const failures = sumOf(a => a.failures);
  const errorsAll = {}, problemsAll = {}, rulesAll = {}, causesAll = {}, clientsAll = {}, toolsAll = {};
  for (const [tok, a] of all) {
    for (const [code, e] of Object.entries(a.errors)) {
      const x = slot(errorsAll, code, () => ({ count: 0, tools: {}, tokens: new Set(), lastAt: null }));
      x.count += e.count; mergeCounts(x.tools, e.tools); if (e.count) x.tokens.add(tok); x.lastAt = maxIso(x.lastAt, e.lastAt);
    }
    for (const [code, p] of Object.entries(a.codes)) {
      const x = slot(problemsAll, code, () => ({ count: 0, refusals: 0, withPatch: 0, tools: {}, tokens: new Set() }));
      x.count += p.count; x.refusals += p.refusals; x.withPatch += p.withPatch; mergeCounts(x.tools, p.tools); x.tokens.add(tok);
    }
    for (const [rule, r] of Object.entries(a.rules)) {
      const x = slot(rulesAll, rule, () => ({ count: 0, calls: 0, tools: {}, tokens: new Set() }));
      x.count += r.count; x.calls += r.calls; mergeCounts(x.tools, r.tools); x.tokens.add(tok);
    }
    for (const [code, c] of Object.entries(a.causes)) {
      const x = slot(causesAll, code, causeAgg);
      x.chains += c.chains; x.refusals += c.refusals; mergeInt(x.extraCalls, c.extraCalls); mergeDur(x.extraMs, c.extraMs);
    }
    for (const [family, c] of Object.entries(a.clients)) {
      const x = slot(clientsAll, family, clientAgg);
      x.sessions += c.sessions; x.chains += c.chains; mergeInt(x.calls, c.calls); mergeInt(x.turns, c.turns); mergeInt(x.refusals, c.refusals); mergeDur(x.gaps, c.gaps);
    }
    for (const [tool, t] of Object.entries(a.tools)) {
      const x = slot(toolsAll, tool, toolAgg);
      x.calls += t.calls; x.shared += t.shared; x.kernelRuns += t.kernelRuns; x.kernelCold += t.kernelCold; x.bytes += t.bytes; mergeDur(x.total, t.total);
      for (const c of COLUMN_KEYS) mergeDur(x.cols[c], t.cols[c]);
    }
  }
  const q2 = s => ({ p50: durQuantile(s, 0.5), p90: durQuantile(s, 0.9) });
  const tools3 = m => top3(m).map(([tool, count]) => ({ tool, count }));
  const withPhases = Object.entries(toolsAll).filter(([, x]) => Object.values(x.cols).some(s => s.sum > 0));
  const byKey = k => (a, b) => (a[k] < b[k] ? -1 : 1);
  return {
    totals: { calls: sumOf(a => a.calls), failures, refusals: sumOf(a => a.refusals), delivered: sumOf(a => a.delivered), uncertain: sumOf(a => a.uncertain),
      problems: sumOf(a => a.problems), withPatch: sumOf(a => a.withPatch),
      problemPhases: all.reduce((m, [, a]) => mergeCounts(m, a.problemPhases), {}),
      normalizations: sumOf(a => a.normalizations), normalizedCalls: sumOf(a => a.normalizedCalls), sharedCalls: sumOf(a => a.shared),
      chains: chainCalls.n, chainsOpen: sumOf(a => a.chains.open),
      turnsPerChainP50: intQuantile(chainTurns, 0.5), turnsPerChainP90: intQuantile(chainTurns, 0.9),
      callsPerChainP50: intQuantile(chainCalls, 0.5), callsPerChainP90: intQuantile(chainCalls, 0.9),
      refusalsBeforeP50: intQuantile(chainRefusals, 0.5), refusalsBeforeMax: chainRefusals.n ? chainRefusals.max : null,
      wallP50Ms: durQuantile(chainWall, 0.5), wallP90Ms: durQuantile(chainWall, 0.9),
      idlePct: pct(sumOf(a => a.chains.idleMs), sumOf(a => a.chains.wallMs)),
      gapP50Ms: durQuantile(gaps, 0.5), gapP90Ms: durQuantile(gaps, 0.9), gaps: gaps.n, longGaps: sumOf(a => a.longGaps) },
    errors: Object.entries(errorsAll).filter(([, e]) => e.count).map(([code, e]) => ({ code, count: e.count, pctOfFailures: pct(e.count, failures),
      tools: tools3(e.tools), customers: e.tokens.size, lastAt: e.lastAt }))
      .sort((a, b) => b.count - a.count || byKey('code')(a, b)),
    problems: Object.entries(problemsAll).map(([code, p]) => ({ code, count: p.count, refusals: p.refusals, withPatch: p.withPatch,
      tools: tools3(p.tools), customers: p.tokens.size }))
      .sort((a, b) => b.count - a.count || byKey('code')(a, b)),
    rules: Object.entries(rulesAll).map(([rule, r]) => ({ rule, count: r.count, calls: r.calls, tools: tools3(r.tools), customers: r.tokens.size }))
      .sort((a, b) => b.count - a.count || byKey('rule')(a, b)),
    phases: withPhases.map(([tool, x]) => ({ tool, calls: x.calls, shared: x.shared, total: q2(x.total),
      ...Object.fromEntries(COLUMN_KEYS.map(c => [c, q2(x.cols[c])])),
      transferBytesAvg: x.total.n ? Math.round(x.bytes / x.total.n) : null, kernelRuns: x.kernelRuns, kernelCold: x.kernelCold }))
      .sort((a, b) => b.calls - a.calls || byKey('tool')(a, b)),
    timeShare: withPhases.map(([tool, x]) => ({ tool, sumMs: x.total.sum,
      ...Object.fromEntries(COLUMN_KEYS.map(c => [c + 'Pct', pct(x.cols[c].sum, x.total.sum)])) }))
      .sort((a, b) => b.sumMs - a.sumMs || byKey('tool')(a, b)),
    rounds: all.filter(([, a]) => a.chains.closed || a.chains.open).map(([t, a]) => ({ token: t, customer: nameOf(t), chains: a.chains.closed, open: a.chains.open,
      turnsP50: intQuantile(a.chains.turns, 0.5), turnsP90: intQuantile(a.chains.turns, 0.9),
      callsP50: intQuantile(a.chains.calls, 0.5), callsP90: intQuantile(a.chains.calls, 0.9),
      refusalsBeforeP50: intQuantile(a.chains.refusals, 0.5), refusalsBeforeMax: a.chains.refusals.n ? a.chains.refusals.max : null,
      wallP50Ms: durQuantile(a.chains.wall, 0.5), wallP90Ms: durQuantile(a.chains.wall, 0.9),
      gapP50Ms: durQuantile(a.gaps, 0.5), gapP90Ms: durQuantile(a.gaps, 0.9), idlePct: pct(a.chains.idleMs, a.chains.wallMs) }))
      .sort((a, b) => b.chains - a.chains || byKey('token')(a, b)),
    causes: Object.entries(causesAll).filter(([, x]) => x.refusals).map(([code, x]) => ({ code, refusals: x.refusals, chains: x.chains, extraCallsSum: x.extraCalls.sum,
      extraCallsP50: intQuantile(x.extraCalls, 0.5), extraMsP50: durQuantile(x.extraMs, 0.5) }))
      .sort((a, b) => b.extraCallsSum - a.extraCallsSum || b.refusals - a.refusals || byKey('code')(a, b)),
    byCustomer: present.map(([t, a]) => {
      const slow = COLUMN_KEYS.map(c => [c, Object.values(a.tools).reduce((s, x) => s + x.cols[c].sum, 0)]).sort((x, y) => y[1] - x[1])[0];
      return { token: t, customer: nameOf(t), calls: a.calls, failures: a.failures, refusals: a.refusals, delivered: a.delivered,
        topError: topKey(Object.fromEntries(Object.entries(a.errors).map(([k, e]) => [k, e.count]))),
        topProblem: topKey(Object.fromEntries(Object.entries(a.codes).map(([k, p]) => [k, p.count]))),
        topRule: topKey(Object.fromEntries(Object.entries(a.rules).map(([k, r]) => [k, r.count]))),
        slowestPhase: slow && slow[1] > 0 ? slow[0] : null };
    }).sort((a, b) => b.calls - a.calls || byKey('token')(a, b)),
    byClient: Object.entries(clientsAll).filter(([, c]) => c.sessions || c.chains || c.gaps.n).map(([client, c]) => ({ client, sessions: c.sessions, chains: c.chains,
      turnsP50: intQuantile(c.turns, 0.5), callsP50: intQuantile(c.calls, 0.5),
      refusalsBeforeAvg: c.refusals.n ? Math.round((c.refusals.sum / c.refusals.n) * 10) / 10 : null,
      gapP50Ms: durQuantile(c.gaps, 0.5) })).sort((a, b) => b.sessions - a.sessions || byKey('client')(a, b)),
  };
}

// ---- the store: day files under /state/agg-quality, the engine, the checkpoint part
export function createQuality({ tz, state, now = Date.now, nativeIds = new Set() }) {
  const days = new Map();
  const dirty = new Set();
  let rebuilding = null;         // Set of days already emptied during a quality cold start
  const stats = { lines: 0, dropped: 0 };
  const file = day => `${QUALITY_DIR}/quality-${day}.json`;
  const valid = a => a && typeof a === 'object' && a.schema === QUALITY_SCHEMA && typeof a.day === 'string' && a.byToken && typeof a.byToken === 'object';

  function load(day, create) {
    if (!days.has(day)) {
      const loaded = state.readJson(file(day));
      if (valid(loaded)) days.set(day, loaded);
      else if (create) days.set(day, emptyQualityDay(day));
      else return null;
    }
    return days.get(day);
  }
  // The aggregate a contribution goes into; during a rebuild a day is emptied the first time anything reaches it.
  function dayAgg(day) {
    let a = load(day, true);
    if (rebuilding && !rebuilding.has(day)) { rebuilding.add(day); a = emptyQualityDay(day); days.set(day, a); }
    dirty.add(day);
    return a;
  }
  const engine = createQualityEngine({ dayOf: iso => tz.day(iso), dayAgg });

  // A parsed record of a quality file: the contract decides (fail closed); null when dropped.
  function addRecord(record) {
    const line = sanitizeQualityLine(record, { nativeIds });
    if (!line) { stats.dropped++; return null; }
    engine.apply(line);
    stats.lines++;
    return line;
  }
  function flushDays() {
    for (const day of dirty) state.writeJson(file(day), days.get(day));
    dirty.clear();
    const floor = tz.addDays(tz.day(now()), -35);
    for (const day of days.keys()) if (day < floor) days.delete(day);
  }
  const pending = () => Object.fromEntries([...dirty].map(d => [d, days.get(d)]));
  function restorePending(saved) {
    for (const [day, a] of Object.entries(saved ?? {})) if (valid(a) && a.day === day) { days.set(day, a); dirty.add(day); }
  }
  const get = day => load(day, false) ?? emptyQualityDay(day);
  // Local days that have a day file or unwritten data, oldest first.
  function knownDays() {
    const set = new Set([...dirty]);
    for (const name of state.list(QUALITY_DIR)) { const m = /^quality-(\d{4}-\d{2}-\d{2})\.json$/.exec(name); if (m) set.add(m[1]); }
    return [...set].sort();
  }

  return {
    addRecord, flushDays, pending, restorePending, get, knownDays, stats,
    sweep: atMs => engine.sweep(atMs),
    get lineClock() { return engine.lineClock; },
    get sessionCount() { return engine.sessionCount; },
    get dirtyCount() { return dirty.size; },
    summarize: (dayList, opts) => summarizeQuality(dayList.map(get), opts),
    toJSON: () => ({ sessions: engine.toJSON(), pending: pending() }),
    restore(saved) { engine.restore(saved?.sessions); restorePending(saved?.pending); },
    beginRebuild() { rebuilding = new Set(); engine.restore(null); },
    endRebuild() { rebuilding = null; },
  };
}
