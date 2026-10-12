// Usage aggregates per local day (DESIGN 3.4): calls, failures and sparse log1.1 duration histograms per customer, tool and
// code, local hours, MCP sessions and agent calls (from server.log) and Caddy denials (from host.json windows). Day files
// /state/agg/usage-YYYY-MM-DD.json are rewritten every 30 s while dirty; the checkpoint carries the days changed since
// the last write, so offsets and aggregates always match after a restart.
import { inc, own, put, slot } from './keys.mjs';

const LN11 = Math.log(1.1);
const TOKEN = /^tok_[0-9a-f]{12}$/;
export const USAGE_SCHEMA = 'ssam-console-usage/1';
const DENIED = new Set([401, 403, 429]);
const MAX_DENIED_KEYS = 2000;

// Bucket 0 for ms < 10, else 1 + floor(ln(ms/10)/ln 1.1), capped at 160.
export const bucketOf = ms => (!(ms >= 10) ? 0 : Math.min(160, 1 + Math.floor(Math.log(ms / 10) / LN11)));
export function addHist(hist, ms) { const k = String(bucketOf(ms)); hist[k] = (hist[k] ?? 0) + 1; return hist; }
export function mergeHist(into, from) { for (const [k, n] of Object.entries(from ?? {})) into[k] = (into[k] ?? 0) + n; return into; }
// Walk the buckets to the ceil(q*n)-th value and interpolate inside [10*1.1^(k-1), 10*1.1^k); never above the exact max.
export function quantile(hist, q, maxMs = Infinity) {
  const keys = Object.keys(hist ?? {}).map(Number).filter(k => hist[k] > 0).sort((a, b) => a - b);
  const n = keys.reduce((s, k) => s + hist[k], 0);
  if (!n) return null;
  const target = Math.max(1, Math.ceil(q * n));
  let cum = 0;
  for (const k of keys) {
    const c = hist[k];
    if (cum + c >= target) {
      const lo = k === 0 ? 0 : 10 * 1.1 ** (k - 1);
      const hi = k === 0 ? 10 : 10 * 1.1 ** k;
      return Math.round(Math.min(lo + (hi - lo) * ((target - cum - 0.5) / c), maxMs));
    }
    cum += c;
  }
  return null;
}

const stat = () => ({ calls: 0, failures: 0, hist: {}, maxMs: 0 });
function bump(s, ms, failed) { s.calls++; if (failed) s.failures++; addHist(s.hist, ms); if (ms > s.maxMs) s.maxMs = ms; }
export const emptyDay = day => ({ schema: USAGE_SCHEMA, day, total: stat(), byToken: {}, byTool: {}, byCode: {}, hours: Array(24).fill(0),
  denied: { byStatus: {}, byIp: {} } });
// Tool names and codes are customer data: every map keyed by them goes through keys.mjs (own properties only).
const tokenStat = (agg, token) => slot(agg.byToken, token, () => ({ ...stat(), byTool: {}, byCode: {}, codeLast: {}, firstAt: null, lastAt: null,
  sessionsOpened: 0, agentCalls: 0, agentFailures: 0, agentCodes: {} }));
function seen(t, at) { if (!t.firstAt || at < t.firstAt) t.firstAt = at; if (!t.lastAt || at > t.lastAt) t.lastAt = at; }
const maxAt = (a, b) => (!a || (b && b > a) ? b : a);
const top = counts => { let best = null, n = -1; for (const [k, v] of Object.entries(counts ?? {})) if (v > n || (v === n && k < best)) { best = k; n = v; } return best; };

export function createUsage({ tz, state, now = Date.now }) {
  const days = new Map();
  const dirty = new Set();     // changed since the last day-file write
  let rebuilding = null;       // Set of days already emptied during a cold-start rebuild

  const valid = a => a && a.schema === USAGE_SCHEMA && typeof a.day === 'string' && a.total && a.byToken;
  function load(day, create) {
    if (!days.has(day)) {
      const loaded = state.readJson(`agg/usage-${day}.json`);
      if (valid(loaded)) days.set(day, loaded);
      else if (create) days.set(day, emptyDay(day));
      else return null;
    }
    return days.get(day);
  }
  // The aggregate a new line goes into. During a cold-start rebuild a day is emptied the first time a line reaches it
  // (its Caddy denials stay: they come from host.json windows, which no file replays).
  function dayAgg(day) {
    let agg = load(day, true);
    if (rebuilding && !rebuilding.has(day)) {
      rebuilding.add(day);
      const keep = agg.denied;
      agg = emptyDay(day);
      agg.denied = keep ?? agg.denied;
      days.set(day, agg);
    }
    return agg;
  }
  const touched = day => { dirty.add(day); };

  function addCall(line) {
    const token = typeof line.token === 'string' && TOKEN.test(line.token) ? line.token : null;
    if (!token) return null;
    const tool = typeof line.tool === 'string' && line.tool ? line.tool.slice(0, 64) : '?';
    const ms = Number.isFinite(line.ms) && line.ms >= 0 ? line.ms : 0;
    const failed = line.ok === false;
    const code = failed ? (typeof line.error === 'string' && line.error ? line.error.slice(0, 64) : 'TOOL_ERROR') : null;
    const day = tz.day(line.time);
    const agg = dayAgg(day);
    bump(agg.total, ms, failed);
    const t = tokenStat(agg, token);
    bump(t, ms, failed);
    seen(t, line.time);
    const tt = slot(t.byTool, tool, () => ({ ...stat(), byCode: {} }));
    bump(tt, ms, failed);
    const bt = slot(agg.byTool, tool, () => ({ ...stat(), byCode: {}, tokens: [] }));
    bump(bt, ms, failed);
    if (!bt.tokens.includes(token)) bt.tokens.push(token);
    if (code) {
      inc(tt.byCode, code);
      inc(t.byCode, code);
      put(t.codeLast, code, maxAt(own(t.codeLast, code), line.time));
      inc(bt.byCode, code);
      const bc = slot(agg.byCode, code, () => ({ count: 0, tools: {}, tokens: [], lastAt: null }));
      bc.count++;
      inc(bc.tools, tool);
      if (!bc.tokens.includes(token)) bc.tokens.push(token);
      bc.lastAt = maxAt(bc.lastAt, line.time);
    }
    agg.hours[tz.hour(line.time)]++;
    touched(day);
    return { token, tool, ms, ok: !failed, code };
  }
  function addSessionOpened(token, time) {
    const day = tz.day(time);
    const t = tokenStat(dayAgg(day), token);
    t.sessionsOpened++;
    seen(t, time);
    touched(day);
  }
  function addAgentCall(token, time, ok, code) {
    const day = tz.day(time);
    const t = tokenStat(dayAgg(day), token);
    t.agentCalls++;
    if (!ok) { t.agentFailures++; inc(t.agentCodes, code ?? 'AGENT_ERROR'); }
    touched(day);
  }
  // One Caddy window of host.json (deduplicated by collectedAt by the caller): 401/403/429 by ip|status|path.
  function addDenied(window, collectedAt) {
    const at = typeof window?.to === 'string' ? window.to : collectedAt;
    if (!at || Number.isNaN(Date.parse(at))) return;
    const day = tz.day(at);
    const agg = dayAgg(day);
    for (const row of Array.isArray(window.denied) ? window.denied : []) {
      const status = Number(row?.status), count = Number(row?.count);
      if (!DENIED.has(status) || !(count > 0)) continue;
      agg.denied.byStatus[status] = (agg.denied.byStatus[status] ?? 0) + count;
      const key = `${String(row.ip ?? '?').slice(0, 64)}|${status}|${String(row.path ?? '?').slice(0, 120)}`;
      const cur = agg.denied.byIp[key];
      if (cur) { cur.count += count; cur.lastAt = maxAt(cur.lastAt, at); }
      else if (Object.keys(agg.denied.byIp).length < MAX_DENIED_KEYS) agg.denied.byIp[key] = { count, lastAt: at };
    }
    touched(day);
  }

  function flushDays() {
    for (const day of dirty) state.writeJson(`agg/usage-${day}.json`, days.get(day));
    dirty.clear();
    // keep memory small: days older than 35 days that are clean leave the cache (they reload from their file)
    const floor = tz.addDays(tz.day(now()), -35);
    for (const day of days.keys()) if (day < floor && !dirty.has(day)) days.delete(day);
  }
  const pending = () => Object.fromEntries([...dirty].map(d => [d, days.get(d)]));
  function restorePending(saved) {
    for (const [day, agg] of Object.entries(saved ?? {})) if (valid(agg)) { days.set(day, agg); dirty.add(day); }
  }
  const get = day => load(day, false) ?? emptyDay(day);

  // Range summary for /api/usage (4.3); token limits every table to one license.
  function summarize(dayList, { token = null, nameOf = () => null } = {}) {
    const aggs = dayList.map(get);
    const totals = { calls: 0, failures: 0, hist: {}, maxMs: 0, sessionsOpened: 0, agentCalls: 0, agentFailures: 0, active: new Set() };
    const customers = new Map(), tools = new Map(), codes = new Map();
    const byDay = [];
    aggs.forEach((agg, i) => {
      const entries = Object.entries(agg.byToken).filter(([tok]) => !token || tok === token);
      const dayRow = { day: agg.day, calls: 0, failures: 0, hist: {}, maxMs: 0, customers: 0 };
      for (const [tok, t] of entries) {
        const c = customers.get(tok) ?? { token: tok, calls: 0, failures: 0, hist: {}, maxMs: 0, tools: {}, sessionsOpened: 0, agentCalls: 0,
          agentFailures: 0, lastAt: null, daily: Array(dayList.length).fill(0) };
        customers.set(tok, c);
        c.calls += t.calls; c.failures += t.failures; mergeHist(c.hist, t.hist); c.maxMs = Math.max(c.maxMs, t.maxMs);
        c.sessionsOpened += t.sessionsOpened; c.agentCalls += t.agentCalls; c.agentFailures += t.agentFailures;
        c.lastAt = maxAt(c.lastAt, t.lastAt); c.daily[i] += t.calls;
        for (const [tool, s] of Object.entries(t.byTool)) inc(c.tools, tool, s.calls);
        totals.sessionsOpened += t.sessionsOpened; totals.agentCalls += t.agentCalls; totals.agentFailures += t.agentFailures;
        if (t.calls) { totals.active.add(tok); dayRow.customers++; }
        dayRow.calls += t.calls; dayRow.failures += t.failures; mergeHist(dayRow.hist, t.hist); dayRow.maxMs = Math.max(dayRow.maxMs, t.maxMs);
      }
      totals.calls += dayRow.calls; totals.failures += dayRow.failures; mergeHist(totals.hist, dayRow.hist); totals.maxMs = Math.max(totals.maxMs, dayRow.maxMs);
      byDay.push(dayRow);
      const toolSource = token ? (agg.byToken[token]?.byTool ?? {}) : agg.byTool;
      for (const [tool, s] of Object.entries(toolSource)) {
        const r = tools.get(tool) ?? { tool, calls: 0, failures: 0, hist: {}, maxMs: 0, byCode: {}, tokens: new Set() };
        tools.set(tool, r);
        r.calls += s.calls; r.failures += s.failures; mergeHist(r.hist, s.hist); r.maxMs = Math.max(r.maxMs, s.maxMs);
        for (const [code, n] of Object.entries(s.byCode ?? {})) inc(r.byCode, code, n);
        for (const tok of token ? (s.calls ? [token] : []) : s.tokens ?? []) r.tokens.add(tok);
        if (token) for (const [code, n] of Object.entries(s.byCode ?? {})) {
          const c = codes.get(code) ?? { code, count: 0, tools: {}, tokens: new Set(), lastAt: null };
          codes.set(code, c);
          c.count += n; inc(c.tools, tool, n); c.tokens.add(token);
          c.lastAt = maxAt(c.lastAt, own(agg.byToken[token]?.codeLast, code) ?? null);
        }
      }
      if (!token) for (const [code, s] of Object.entries(agg.byCode)) {
        const c = codes.get(code) ?? { code, count: 0, tools: {}, tokens: new Set(), lastAt: null };
        codes.set(code, c);
        c.count += s.count; for (const [tool, n] of Object.entries(s.tools)) inc(c.tools, tool, n);
        for (const tok of s.tokens) c.tokens.add(tok);
        c.lastAt = maxAt(c.lastAt, s.lastAt);
      }
    });
    const q = (s, p) => (s.calls ? quantile(s.hist, p, s.maxMs) : null);
    return {
      totals: { calls: totals.calls, failures: totals.failures, p50Ms: q(totals, 0.5), p90Ms: q(totals, 0.9), maxMs: totals.calls ? totals.maxMs : null,
        customersActive: totals.active.size, sessionsOpened: totals.sessionsOpened, agentCalls: totals.agentCalls, agentFailures: totals.agentFailures },
      byCustomer: [...customers.values()].map(c => ({ token: c.token, customer: nameOf(c.token), calls: c.calls, failures: c.failures,
        p50Ms: q(c, 0.5), p90Ms: q(c, 0.9), topTool: top(c.tools), sessionsOpened: c.sessionsOpened, agentCalls: c.agentCalls,
        agentFailures: c.agentFailures, lastAt: c.lastAt, daily: c.daily }))
        .sort((a, b) => b.calls - a.calls || String(a.customer ?? a.token).localeCompare(String(b.customer ?? b.token))),
      byTool: [...tools.values()].filter(r => r.calls).map(r => ({ tool: r.tool, calls: r.calls, failures: r.failures, p50Ms: q(r, 0.5), p90Ms: q(r, 0.9),
        maxMs: r.maxMs, customers: r.tokens.size, topCode: top(r.byCode) })).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
      byCode: [...codes.values()].map(c => ({ code: c.code, count: c.count,
        tools: Object.entries(c.tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([tool, count]) => ({ tool, count })),
        customers: c.tokens.size, lastAt: c.lastAt })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      byDay: byDay.map(d => ({ day: d.day, calls: d.calls, failures: d.failures, p50Ms: q(d, 0.5), p90Ms: q(d, 0.9), customers: d.customers }))
        .sort((a, b) => (a.day < b.day ? 1 : -1)),
      denied: aggs.reduce((acc, agg) => {
        for (const [s, n] of Object.entries(agg.denied?.byStatus ?? {})) acc.byStatus[s] = (acc.byStatus[s] ?? 0) + n;
        for (const [key, v] of Object.entries(agg.denied?.byIp ?? {})) {
          const cur = acc.rows.get(key) ?? { count: 0, lastAt: null };
          cur.count += v.count; cur.lastAt = maxAt(cur.lastAt, v.lastAt);
          acc.rows.set(key, cur);
        }
        return acc;
      }, { byStatus: {}, rows: new Map() }),
    };
  }

  return {
    addCall, addSessionOpened, addAgentCall, addDenied, flushDays, pending, restorePending, get, summarize,
    get dirtyCount() { return dirty.size; },
    beginRebuild() { rebuilding = new Set(); },
    endRebuild() { rebuilding = null; },
  };
}
