// The bytes a caller (a server token; "local" on the owner's machine) is served per UTC day and per tool (fix/no-internals,
// 17/10/2026): SIZES only, never an argument, never an answer. One small JSON file per day under <dir>:
//   served-<YYYY-MM-DD>.json  {schema, day, callers: {<caller>: {<tool>: {calls, bytes}}}, alerts: [{caller, tool, bytes, limitBytes, at}]}
// The hub (ssam.mjs) records every answer of the tools it meters and asks the day's total before a limited call.
// Round 2 (review MEDIUM 3): ONE count per folder in a process, whatever the number of stores or servers made on it (a
// hosted server makes one MCP server per HTTP session): the day lives in a module-level state per folder, read from disk
// once and written after each change; a limited call reserves its bytes before it runs (reserve), so parallel calls of
// one caller never pass the day together. A caller id outside the id set is counted under a hash of it, never a common
// bucket.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SERVED_SCHEMA = 'ssam-served-bytes/1';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CALLER = /^[\w.:@-]{1,128}$/;
const shared = new Map(); // folder -> {days: Map(day -> value), pending: Map(day|caller|tool -> bytes)}

export const callerId = caller => (typeof caller === 'string' && CALLER.test(caller) ? caller
  : 'h-' + createHash('sha256').update(String(caller ?? '')).digest('hex').slice(0, 16));

export function servedBytesStore({ dir, now = () => new Date() } = {}) {
  if (!dir) throw new Error('servedBytesStore needs a dir');
  const folder = path.resolve(dir);
  const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
  const state = shared.get(key) ?? (shared.set(key, { days: new Map(), pending: new Map() }), shared.get(key));
  const dayOf = (at = now()) => at.toISOString().slice(0, 10);
  const fileOf = day => path.join(folder, 'served-' + day + '.json');
  const empty = day => ({ schema: SERVED_SCHEMA, day, callers: {}, alerts: [] });
  function read(day) {
    if (state.days.has(day)) return state.days.get(day);
    let value = empty(day);
    try {
      const parsed = JSON.parse(fs.readFileSync(fileOf(day), 'utf8'));
      if (parsed?.schema === SERVED_SCHEMA && parsed.day === day && parsed.callers && typeof parsed.callers === 'object') value = { ...empty(day), ...parsed };
    } catch { /* a missing or unreadable file starts the day empty */ }
    state.days.set(day, value);
    return value;
  }
  function write(day, value) {
    fs.mkdirSync(folder, { recursive: true });
    const tmp = fileOf(day) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, fileOf(day));
  }
  const pendingKey = (day, caller, tool) => day + '|' + caller + '|' + tool;
  return {
    dir: folder, dayOf,
    /** Today's bytes of a caller over the tools named (every tool when none), the reserved bytes of running calls included. */
    usage(caller, tools = null, day = dayOf()) {
      if (!DAY.test(day)) return 0;
      const who = callerId(caller);
      const entry = read(day).callers[who] ?? {};
      const recorded = Object.entries(entry).filter(([tool]) => !tools || tools.includes(tool)).reduce((sum, [, t]) => sum + (t.bytes ?? 0), 0);
      const reserved = [...state.pending].filter(([k]) => { const [d, c, t] = k.split('|'); return d === day && c === who && (!tools || tools.includes(t)); }).reduce((s, [, b]) => s + b, 0);
      return recorded + reserved;
    },
    /** A limited call about to run: its bytes are held until release() (call it once, after the answer is recorded). */
    reserve(caller, tool, bytes, day = dayOf()) {
      const k = pendingKey(day, callerId(caller), tool);
      const held = Math.max(0, Math.round(Number(bytes) || 0));
      state.pending.set(k, (state.pending.get(k) ?? 0) + held);
      let done = false;
      return () => { if (done) return; done = true; const left = (state.pending.get(k) ?? 0) - held; if (left > 0) state.pending.set(k, left); else state.pending.delete(k); };
    },
    /** One answer: its size. Returns the caller's day {day, tools, total}. */
    record(caller, tool, bytes, day = dayOf()) {
      const value = read(day);
      const who = value.callers[callerId(caller)] ??= {};
      const t = who[tool] ??= { calls: 0, bytes: 0 };
      t.calls += 1; t.bytes += Math.max(0, Math.round(Number(bytes) || 0));
      write(day, value);
      return { day, tools: who, total: Object.values(who).reduce((s, x) => s + x.bytes, 0) };
    },
    /** An alert once per caller, tool group and day; true when it is new. */
    alert(caller, group, bytes, limitBytes, day = dayOf()) {
      const value = read(day);
      const who = callerId(caller);
      if (value.alerts.some(a => a.caller === who && a.tool === group)) return false;
      value.alerts.push({ caller: who, tool: group, bytes, limitBytes, at: now().toISOString() });
      write(day, value);
      return true;
    },
    /** The day as written (sizes only). */
    day(day = dayOf()) { return structuredClone(read(day)); },
  };
}
// ---- the read-tools meter of a licensee's server (fix/no-internals item 5)
// The tools whose answers are the reading of SSAM itself (the audit of a licensee's token: 56% of what he was served came
// from ssam_discover and ssam_reference; ssam_evidence returns the rest of their reduced answers).
export const READ_TOOLS = Object.freeze(['ssam_reference', 'ssam_discover', 'ssam_evidence']);
export const ALERT_GROUP = 'read-tools';
// The day's total above which a caller is flagged once (SSAM_SERVED_ALERT_BYTES): about twice a heavy working day.
export const ALERT_BYTES = 393216;
/** One answer of a read tool: recorded, and the caller flagged once when the day's total of the read tools passes the
 *  limit. Returns the line the server may log (sizes only), or null. */
export function meterRead(store, caller, tool, bytes, { alertBytes = ALERT_BYTES, log = null } = {}) {
  if (!READ_TOOLS.includes(tool)) return null;
  const day = store.record(caller, tool, bytes);
  const total = READ_TOOLS.reduce((sum, name) => sum + (day.tools[name]?.bytes ?? 0), 0);
  if (total <= alertBytes || !store.alert(caller, ALERT_GROUP, total, alertBytes)) return null;
  const line = { ssam: 'served-bytes-alert', day: day.day, caller: callerId(caller), bytes: total, limitBytes: alertBytes,
    tools: Object.fromEntries(READ_TOOLS.map(name => [name, day.tools[name]?.bytes ?? 0])) };
  try { log?.(JSON.stringify(line)); } catch { /* a log never changes an answer */ }
  return line;
}
/** The day of one caller as a line for the server's quality record: the bytes of each read tool, the total, the limit. */
export function servedDay(store, caller, day = store.dayOf()) {
  const value = store.day(day);
  const tools = value.callers?.[callerId(caller)] ?? {};
  const bytes = Object.fromEntries(READ_TOOLS.map(name => [name, tools[name]?.bytes ?? 0]));
  const total = Object.values(bytes).reduce((s, b) => s + b, 0);
  return { day, bytes, total, alerted: (value.alerts ?? []).some(a => a.caller === callerId(caller) && a.tool === ALERT_GROUP) };
}
/** Every caller of a day, sizes only, the largest first (the owner's report). */
export function servedTotals(store, day = store.dayOf()) {
  const value = store.day(day);
  return Object.keys(value.callers ?? {}).map(caller => ({ caller, ...servedDay(store, caller, day) })).sort((a, b) => b.total - a.total);
}

// The next UTC midnight: when a day's limit resets.
export const nextDay = (at = new Date()) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)).toISOString();
