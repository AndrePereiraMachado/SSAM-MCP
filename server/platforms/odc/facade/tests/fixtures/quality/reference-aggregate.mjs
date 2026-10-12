// Reference aggregation of ssam-quality/1 lines (C:\t\qual\DESIGN-QUALIDADE.md, sections 4.2-4.4): the rules the console's
// quality.mjs must follow, written plainly so the expected payloads of the fixtures can be checked by hand. Not a product
// module: the CONSOLE lane implements the same rules incrementally (day files, checkpoint) and its golden test compares its
// /api/quality payload for the fixtures with expected-api-*.json (produced by this file through make-quality-fixtures.mjs).
import { sanitizeQualityLine } from './quality-line.mjs';

export const RULES = Object.freeze({
  longGapMs: 600_000,        // a gap above 10 min is a pause (probably the person), out of the gap percentiles
  chainBreakMs: 1_800_000,   // a gap above 30 min ends the current chain (as "sem entrega" when it had an attempt)
  turnGapMs: 1_000,          // a call that starts a model turn: nothing of the session in flight and at least 1 s since the last answer
  idleCloseMs: 7_200_000,    // a session without a line for 2 h is finished as if closed
});
// Calls that try to change the module or the environment: their refusal is a round lost, their success (deliv) ends a
// chain. A delivery is an attempt unless it only closes a task (op close) or stops before the merge (args.until); a
// creation is an attempt for the ops that create (the writer marks their success deliv "criado"). Publications are not
// attempts: they come after "entregue" and never close a chain.
export const DELIVER_TOOLS = Object.freeze(['o11_deliver', 'studio_deliver']);
export const CREATE_ATTEMPTS = Object.freeze({ studio_create: null, studio_create_app: ['create'], o11_environment: ['create-app', 'add-modules', 'create-module'] });
export const isAttempt = l => (DELIVER_TOOLS.includes(l.tool) && l.op !== 'close' && (l.args?.until ?? 'merge') === 'merge')
  || (Object.hasOwn(CREATE_ATTEMPTS, l.tool) && (CREATE_ATTEMPTS[l.tool] === null || CREATE_ATTEMPTS[l.tool].includes(l.op)));
// The phase columns of the console and the line keys they read (transfer also holds the doctor's network probe).
export const COLUMNS = Object.freeze({ queue: ['queue'], capture: ['capture'], compile: ['kernelOwn'], studio: ['studio'], verify: ['verify'],
  publish: ['publish'], environment: ['environment'], transfer: ['transfer', 'network'], rest: ['rest'] });

// ---- statistics (same buckets as console usage.mjs: bucket 0 below 10 ms, else 1 + floor(ln(ms/10)/ln 1.1), cap 160)
const LN11 = Math.log(1.1);
export const bucketOf = ms => (!(ms >= 10) ? 0 : Math.min(160, 1 + Math.floor(Math.log(ms / 10) / LN11)));
// A duration stat: zeros apart (a phase the call did not have), the rest in the log histogram.
export const durStat = () => ({ n: 0, zeros: 0, hist: {}, sum: 0, max: 0 });
export function addDur(s, ms) {
  s.n++; s.sum += ms; if (ms > s.max) s.max = ms;
  if (!ms) { s.zeros++; return; }
  const k = String(bucketOf(ms)); s.hist[k] = (s.hist[k] ?? 0) + 1;
}
export function mergeDur(into, from) {
  into.n += from.n; into.zeros += from.zeros; into.sum += from.sum; into.max = Math.max(into.max, from.max);
  for (const [k, c] of Object.entries(from.hist)) into.hist[k] = (into.hist[k] ?? 0) + c;
  return into;
}
// Rank ceil(q*n); a rank among the zeros is 0; else interpolated inside its bucket (as usage.mjs), never above max.
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
// A count stat (calls per chain, refusals before success): exact small integers, nearest rank.
export const intStat = () => ({ n: 0, hist: {}, sum: 0, max: 0 });
export function addInt(s, v) { s.n++; s.sum += v; if (v > s.max) s.max = v; s.hist[v] = (s.hist[v] ?? 0) + 1; }
export function mergeInt(into, from) { into.n += from.n; into.sum += from.sum; into.max = Math.max(into.max, from.max); for (const [k, c] of Object.entries(from.hist)) into.hist[k] = (into.hist[k] ?? 0) + c; return into; }
export function intQuantile(s, q) {
  if (!s || !s.n) return null;
  const target = Math.max(1, Math.ceil(q * s.n));
  let cum = 0;
  for (const k of Object.keys(s.hist).map(Number).sort((a, b) => a - b)) { cum += s.hist[k]; if (cum >= target) return k; }
  return null;
}
const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const inc = (m, k, n = 1) => { m[k] = (m[k] ?? 0) + n; };
const top3 = m => Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3);
const topKey = m => top3(m)[0]?.[0] ?? null;

// ---- the walk: lines in file order (days ascending, each file in order), the local day by a fixed offset (America/Sao_Paulo
// has no DST since 2019: UTC-03:00), `now` for the idle close.
export function aggregate(rawLines, { days, token = null, now, offsetMs = -3 * 3600_000, nameOf = t => t, nativeIds = null }) {
  const dayOf = iso => new Date(Date.parse(iso) + offsetMs).toISOString().slice(0, 10);
  const inRange = iso => days.includes(dayOf(iso));
  const lines = rawLines.map(l => sanitizeQualityLine(l, { nativeIds })).filter(Boolean).filter(l => !token || l.token === token);
  const T = new Map();                      // token -> per-customer aggregate
  const tok = t => {
    if (!T.has(t)) T.set(t, { calls: 0, failures: 0, refusals: 0, delivered: 0, uncertain: 0, shared: 0, problems: 0, withPatch: 0, problemPhases: {}, normalizations: 0, normalizedCalls: 0,
      errors: {}, codes: {}, rules: {}, tools: {}, gaps: durStat(), longGaps: 0,
      chains: { closed: 0, open: 0, calls: intStat(), turns: intStat(), refusals: intStat(), wall: durStat(), idleMs: 0, wallMs: 0 }, phaseTotals: {} });
    return T.get(t);
  };
  const toolStat = (a, tool) => (a.tools[tool] ??= { calls: 0, failures: 0, refusals: 0, delivered: 0, shared: 0, kernelRuns: 0, kernelCold: 0,
    bytes: 0, total: durStat(), cols: Object.fromEntries(Object.keys(COLUMNS).map(c => [c, durStat()])) });
  const errorsAll = {}, problemsAll = {}, rulesAll = {}, causes = {}, clients = {};
  const clientOf = new Map();               // token|session -> client
  const sessions = new Map();               // token|session -> {lastAtMs, chain}
  const client = name => (clients[name] ??= { sessions: 0, chains: 0, calls: intStat(), turns: intStat(), refusals: intStat(), gaps: durStat() });

  function finishChain(key, state, endIso, delivered) {
    const c = state.chain; state.chain = null;
    if (!c || !c.attempts) return;                     // only reads: not a chain
    if (!inRange(endIso)) return;
    const a = tok(c.token);
    const cl = client(clientOf.get(key) ?? 'unknown');
    if (!delivered) { a.chains.open++; return; }
    const endMs = Date.parse(endIso), wall = endMs - c.firstArrivalMs;
    a.chains.closed++; addInt(a.chains.calls, c.calls); addInt(a.chains.turns, c.turns); addInt(a.chains.refusals, c.refusals.length); addDur(a.chains.wall, wall);
    a.chains.idleMs += c.idleMs; a.chains.wallMs += wall;
    cl.chains++; addInt(cl.calls, c.calls); addInt(cl.turns, c.turns); addInt(cl.refusals, c.refusals.length);
    for (const r of c.refusals) for (const code of r.codes) {
      const x = (causes[code] ??= { refusals: 0, chains: new Set(), extraCalls: intStat(), extraMs: durStat() });
      x.refusals++; x.chains.add(key + '#' + c.firstArrivalMs); addInt(x.extraCalls, c.calls - r.atCalls); addDur(x.extraMs, endMs - r.atMs);
    }
  }

  for (const l of lines) {
    const key = l.token + '|' + l.session;
    if (l.kind === 'session') {
      if (l.event === 'opened') { clientOf.set(key, l.client); if (inRange(l.time)) client(l.client).sessions++; }
      else { const s = sessions.get(key); if (s) finishChain(key, s, l.time, false); sessions.delete(key); }
      continue;
    }
    let s = sessions.get(key);
    if (!s) sessions.set(key, s = { chain: null });
    const endMs = Date.parse(l.time), arrival = endMs - l.ms;
    const idleGap = l.call > 1 && l.gapMs !== null && l.inFlight === 0;
    // A pause above chainBreakMs ends the chain before this call.
    if (idleGap && l.gapMs > RULES.chainBreakMs && s.chain) finishChain(key, s, new Date(arrival).toISOString(), false);
    s.chain ??= { token: l.token, firstArrivalMs: arrival, calls: 0, turns: 0, attempts: 0, refusals: [], idleMs: 0 };
    const c = s.chain;
    c.calls++;
    // A model turn (a 'volta'): the first call of the chain, or a call with nothing in flight at least turnGapMs after the last answer.
    if (c.calls === 1 || (l.inFlight === 0 && (l.gapMs === null || l.gapMs >= RULES.turnGapMs))) c.turns++;
    if (idleGap && c.calls > 1 && l.gapMs <= RULES.longGapMs) c.idleMs += l.gapMs;
    if (isAttempt(l)) {
      c.attempts++;
      if (!l.deliv && l.class !== 'ok') {
        const codes = l.problems?.byCode ? Object.keys(l.problems.byCode) : [l.code ?? 'TOOL_ERROR'];
        c.refusals.push({ codes, atCalls: c.calls, atMs: endMs });
      }
    }
    if (inRange(l.time)) {
      const a = tok(l.token), t = toolStat(a, l.tool);
      a.calls++; t.calls++;
      if (!l.ok) { a.failures++; t.failures++; const e = (errorsAll[l.code] ??= { count: 0, tools: {}, tokens: new Set(), lastAt: null }); e.count++; inc(e.tools, l.tool); e.tokens.add(l.token); if (!e.lastAt || l.time > e.lastAt) e.lastAt = l.time; inc(a.errors, l.code); }
      if (l.class === 'refused') { a.refusals++; t.refusals++; }
      if (l.class === 'uncertain') a.uncertain++;
      if (l.deliv) { a.delivered++; t.delivered++; }
      if (l.problems) {
        a.problems += l.problems.n;
        for (const [phase, n] of Object.entries(l.problems.byPhase ?? {})) inc(a.problemPhases, phase, n);
        for (const n of Object.values(l.problems.withPatch ?? {})) a.withPatch += n;
        for (const [code, n] of Object.entries(l.problems.byCode ?? {})) {
          const p = (problemsAll[code] ??= { count: 0, refusals: 0, withPatch: 0, tools: {}, tokens: new Set() });
          p.count += n; p.refusals++; p.withPatch += l.problems.withPatch?.[code] ?? 0; inc(p.tools, l.tool, n); p.tokens.add(l.token); inc(a.codes, code, n);
        }
      }
      if (l.norm) {
        a.normalizations += l.norm.n; a.normalizedCalls++;
        for (const [rule, n] of Object.entries(l.norm.byRule ?? {})) {
          const r = (rulesAll[rule] ??= { count: 0, calls: 0, tools: {}, tokens: new Set() });
          r.count += n; r.calls++; inc(r.tools, l.tool, n); r.tokens.add(l.token); inc(a.rules, rule, n);
        }
      }
      if (l.agent?.shared) { a.shared++; t.shared++; }
      else {
        addDur(t.total, l.ms);
        for (const [col, keys] of Object.entries(COLUMNS)) {
          const v = keys.reduce((sum, k) => sum + (l.t?.[k] ?? 0), 0);
          addDur(t.cols[col], v);
        }
        t.kernelRuns += l.kernel?.runs ?? 0; t.kernelCold += l.kernel?.cold ?? 0; t.bytes += l.agent?.bytes ?? 0;
      }
      if (idleGap) {
        if (l.gapMs > RULES.longGapMs) a.longGaps++;
        else { addDur(a.gaps, l.gapMs); addDur(client(clientOf.get(key) ?? 'unknown').gaps, l.gapMs); }
      }
    }
    if (l.deliv) finishChain(key, s, l.time, true);
    s.lastAtMs = endMs;
  }
  // Sessions without a line for idleCloseMs are finished as if closed (the console does it on its tick).
  for (const [key, s] of sessions) if (s.chain && now - s.lastAtMs >= RULES.idleCloseMs) finishChain(key, s, new Date(s.lastAtMs + RULES.idleCloseMs).toISOString(), false);

  // ---- payload (section 4.3)
  const all = [...T.entries()];
  const sumOf = f => all.reduce((s, [, a]) => s + f(a), 0);
  const chainCalls = all.reduce((s, [, a]) => mergeInt(s, a.chains.calls), intStat());
  const chainRefusals = all.reduce((s, [, a]) => mergeInt(s, a.chains.refusals), intStat());
  const chainTurns = all.reduce((s, [, a]) => mergeInt(s, a.chains.turns), intStat());
  const chainWall = all.reduce((s, [, a]) => mergeDur(s, a.chains.wall), durStat());
  const gaps = all.reduce((s, [, a]) => mergeDur(s, a.gaps), durStat());
  const failures = sumOf(a => a.failures);
  const toolsAll = {};
  for (const [, a] of all) for (const [tool, t] of Object.entries(a.tools)) {
    const x = (toolsAll[tool] ??= { calls: 0, shared: 0, kernelRuns: 0, kernelCold: 0, bytes: 0, total: durStat(), cols: Object.fromEntries(Object.keys(COLUMNS).map(c => [c, durStat()])) });
    x.calls += t.calls; x.shared += t.shared; x.kernelRuns += t.kernelRuns; x.kernelCold += t.kernelCold; x.bytes += t.bytes; mergeDur(x.total, t.total);
    for (const c of Object.keys(COLUMNS)) mergeDur(x.cols[c], t.cols[c]);
  }
  const q2 = s => ({ p50: durQuantile(s, 0.5), p90: durQuantile(s, 0.9) });
  const withPhases = Object.entries(toolsAll).filter(([, x]) => Object.values(x.cols).some(s => s.sum > 0));
  return {
    totals: { calls: sumOf(a => a.calls), failures, refusals: sumOf(a => a.refusals), delivered: sumOf(a => a.delivered), uncertain: sumOf(a => a.uncertain),
      problems: sumOf(a => a.problems), withPatch: sumOf(a => a.withPatch),
      problemPhases: all.reduce((m, [, a]) => { for (const [k, n] of Object.entries(a.problemPhases)) inc(m, k, n); return m; }, {}),
      normalizations: sumOf(a => a.normalizations), normalizedCalls: sumOf(a => a.normalizedCalls), sharedCalls: sumOf(a => a.shared),
      chains: chainCalls.n, chainsOpen: sumOf(a => a.chains.open),
      turnsPerChainP50: intQuantile(chainTurns, 0.5), turnsPerChainP90: intQuantile(chainTurns, 0.9),
      callsPerChainP50: intQuantile(chainCalls, 0.5), callsPerChainP90: intQuantile(chainCalls, 0.9),
      refusalsBeforeP50: intQuantile(chainRefusals, 0.5), refusalsBeforeMax: chainRefusals.n ? chainRefusals.max : null,
      wallP50Ms: durQuantile(chainWall, 0.5), wallP90Ms: durQuantile(chainWall, 0.9),
      idlePct: pct(sumOf(a => a.chains.idleMs), sumOf(a => a.chains.wallMs)),
      gapP50Ms: durQuantile(gaps, 0.5), gapP90Ms: durQuantile(gaps, 0.9), gaps: gaps.n, longGaps: sumOf(a => a.longGaps) },
    errors: Object.entries(errorsAll).map(([code, e]) => ({ code, count: e.count, pctOfFailures: pct(e.count, failures),
      tools: top3(e.tools).map(([tool, count]) => ({ tool, count })), customers: e.tokens.size, lastAt: e.lastAt }))
      .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)),
    problems: Object.entries(problemsAll).map(([code, p]) => ({ code, count: p.count, refusals: p.refusals, withPatch: p.withPatch,
      tools: top3(p.tools).map(([tool, count]) => ({ tool, count })), customers: p.tokens.size }))
      .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)),
    rules: Object.entries(rulesAll).map(([rule, r]) => ({ rule, count: r.count, calls: r.calls,
      tools: top3(r.tools).map(([tool, count]) => ({ tool, count })), customers: r.tokens.size }))
      .sort((a, b) => b.count - a.count || (a.rule < b.rule ? -1 : 1)),
    phases: withPhases.map(([tool, x]) => ({ tool, calls: x.calls, shared: x.shared, total: q2(x.total),
      ...Object.fromEntries(Object.keys(COLUMNS).map(c => [c, q2(x.cols[c])])),
      transferBytesAvg: x.total.n ? Math.round(x.bytes / x.total.n) : null, kernelRuns: x.kernelRuns, kernelCold: x.kernelCold }))
      .sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : 1)),
    timeShare: withPhases.map(([tool, x]) => ({ tool, sumMs: x.total.sum,
      ...Object.fromEntries(Object.keys(COLUMNS).map(c => [c + 'Pct', pct(x.cols[c].sum, x.total.sum)])) }))
      .sort((a, b) => b.sumMs - a.sumMs || (a.tool < b.tool ? -1 : 1)),
    rounds: all.filter(([, a]) => a.chains.closed || a.chains.open).map(([t, a]) => ({ token: t, customer: nameOf(t), chains: a.chains.closed, open: a.chains.open,
      turnsP50: intQuantile(a.chains.turns, 0.5), turnsP90: intQuantile(a.chains.turns, 0.9),
      callsP50: intQuantile(a.chains.calls, 0.5), callsP90: intQuantile(a.chains.calls, 0.9),
      refusalsBeforeP50: intQuantile(a.chains.refusals, 0.5), refusalsBeforeMax: a.chains.refusals.n ? a.chains.refusals.max : null,
      wallP50Ms: durQuantile(a.chains.wall, 0.5), wallP90Ms: durQuantile(a.chains.wall, 0.9),
      gapP50Ms: durQuantile(a.gaps, 0.5), gapP90Ms: durQuantile(a.gaps, 0.9), idlePct: pct(a.chains.idleMs, a.chains.wallMs) }))
      .sort((a, b) => b.chains - a.chains || (a.token < b.token ? -1 : 1)),
    causes: Object.entries(causes).map(([code, x]) => ({ code, refusals: x.refusals, chains: x.chains.size, extraCallsSum: x.extraCalls.sum,
      extraCallsP50: intQuantile(x.extraCalls, 0.5), extraMsP50: durQuantile(x.extraMs, 0.5) }))
      .sort((a, b) => b.extraCallsSum - a.extraCallsSum || b.refusals - a.refusals || (a.code < b.code ? -1 : 1)),
    byCustomer: all.map(([t, a]) => {
      const slow = Object.keys(COLUMNS).map(c => [c, Object.values(a.tools).reduce((s, x) => s + x.cols[c].sum, 0)]).sort((x, y) => y[1] - x[1])[0];
      return { token: t, customer: nameOf(t), calls: a.calls, failures: a.failures, refusals: a.refusals, delivered: a.delivered,
        topError: topKey(a.errors), topProblem: topKey(a.codes), topRule: topKey(a.rules), slowestPhase: slow && slow[1] > 0 ? slow[0] : null };
    }).sort((a, b) => b.calls - a.calls || (a.token < b.token ? -1 : 1)),
    byClient: Object.entries(clients).filter(([, c]) => c.sessions || c.chains || c.gaps.n).map(([name, c]) => ({ client: name, sessions: c.sessions, chains: c.chains,
      turnsP50: intQuantile(c.turns, 0.5), callsP50: intQuantile(c.calls, 0.5), refusalsBeforeAvg: c.refusals.n ? Math.round((c.refusals.sum / c.refusals.n) * 10) / 10 : null,
      gapP50Ms: durQuantile(c.gaps, 0.5) })).sort((a, b) => b.sessions - a.sessions || (a.client < b.client ? -1 : 1)),
  };
}
