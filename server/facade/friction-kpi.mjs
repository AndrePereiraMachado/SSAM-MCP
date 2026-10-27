// ssam_friction {view:"delivery-kpi"} (front R0 of the plan of 2026-10-24, the "first time right and speed" plan):
// the eight delivery KPIs of the plan's goal table, by ISO week and lane, computed from the friction queue (its daily
// index; the chain fields the boundary records since R0) and, when the root has them, the kernel's delivery receipts
// (kernel/.local/work/deliver/<task>/result.json). Read only: it never writes the queue, never rebuilds its index and
// never reads an operation file. Synchronous, as every answer of the queue on the MCP line.
//
// Definitions (the same words go in the answer's `definitions`):
// - attempt: one o11_deliver, studio_deliver or ssam_code write call that is not a continuation;
// - logical delivery: an attempt plus the continueTask calls that follow it (recorded by `delivery.continueTask`; before
//   R0, a deliver of the same session and lane started within 10 min of a 25 s hand-off: CONTINUED, or the
//   RESULT_UNOBSERVED of 24.5–26 s the hand-off was before 19/10); its outcome is the one of its last call;
// - chain: the logical deliveries of one change until it is accepted: linked by basedOn.job / basedOn.sha256 /
//   basedOn.taskId / closePrevious when recorded, else the heuristic session + lane (+ module when both name one) with
//   the previous one not accepted and at most 45 min between them, marked inferred.
import fs from 'node:fs';
import path from 'node:path';

const MINUTE = 60_000;
export const KPI_WINDOWS = Object.freeze({ chainGapMs: 45 * MINUTE, readsBeforeMs: 15 * MINUTE, continuationGapMs: 10 * MINUTE });
const READS = new Set(['map', 'discover', 'reference', 'inspect']);
const ATTEMPT_TOOLS = new Set(['o11_deliver', 'studio_deliver']);
const AFTER_BUILD = new Set(['apply', 'verify']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const KPI_COLUMNS = ['week', 'lane', 'logical', 'chains', 'inferredChains', 'firstAcceptedPct', 'attemptsPerAccepted', 'sameCodePairs',
  'readsP50', 'readsP90', 'continuedPct', 'wallP50s', 'wallP90s', 'refusedAfterBuildPct', 'refusedAfterBuildOf', 'refusedAfterBuildSource',
  'kernelP50s', 'kernelP90s', 'receipts'];
export const KPI_DEFINITIONS = Object.freeze({
  logical: 'o11_deliver, studio_deliver or ssam_code write plus the continueTask calls that follow it; outcome of its last call',
  chains: 'logical deliveries of one change up to its acceptance: basedOn.job/sha256/taskId or closePrevious when recorded, else session+lane(+module), previous not accepted, gap <= 45 min (inferredChains)',
  firstAcceptedPct: 'chains whose first logical delivery was accepted, of all chains',
  attemptsPerAccepted: 'logical deliveries per chain that ends accepted',
  sameCodePairs: 'consecutive refused logical deliveries of one chain with the same code',
  readsP50: 'ssam_map, ssam_discover, ssam_reference and *_inspect of the same session (same lane or none) in the 15 min before an accepted logical delivery',
  continuedPct: 'logical deliveries with at least one continueTask',
  wallP50s: 'seconds from the first call of an accepted logical delivery to the end of its last',
  refusedAfterBuildPct: 'refusals with a problem of phase apply or verify, of the refusals whose problem phases are known (queue when recorded, else kernel receipts)',
  kernelP50s: 'kernel registered -> complete of the delivered receipts, seconds'
});

// ---- input -----------------------------------------------------------------------------------------------------------
// since/until: a day (YYYY-MM-DD, until inclusive) or an ISO instant; lane: o11 | odc.
export function kpiRange({ since, until } = {}) {
  const at = (value, end) => {
    if (value === undefined || value === null) return end ? Infinity : -Infinity;
    if (typeof value !== 'string' || value.length > 40) throw Error('Invalid since/until');
    const ms = DAY.test(value) ? Date.parse(value + 'T00:00:00.000Z') + (end ? 86_400_000 : 0) : Date.parse(value);
    if (!Number.isFinite(ms)) throw Error('Invalid since/until');
    return ms;
  };
  const from = at(since, false), to = at(until, true);
  if (from >= to) throw Error('Invalid since/until');
  return { from, to };
}

// The operations of the daily index (index/<yyyymmdd>.jsonl, the first line of each kind wins, as the store reads it),
// of the days from `from` (less the look-back of the reads and chains) to `to`. Never writes; a damaged line is counted.
export function readIndexOperations(directory, { from = -Infinity, to = Infinity } = {}) {
  const indexDir = path.join(directory, 'index');
  const dayOf = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10).replace(/-/g, '') : null);
  const first = dayOf(from - KPI_WINDOWS.chainGapMs - 86_400_000), last = dayOf(to);
  let names = [];
  try { names = fs.readdirSync(indexDir).filter(n => /^\d{8}\.jsonl$/.test(n)).sort(); } catch { names = []; }
  const starts = new Map(), ends = new Map(); let damaged = 0, files = 0;
  for (const name of names) {
    const day = name.slice(0, 8);
    if ((first && day < first) || (last && day > last)) continue;
    let text; try { text = fs.readFileSync(path.join(indexDir, name), 'utf8'); files++; } catch { damaged++; continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry; try { entry = JSON.parse(line); } catch { damaged++; continue; }
      if (!entry || typeof entry.id !== 'string' || !Number.isFinite(Date.parse(entry.startedAt))) { damaged++; continue; }
      const map = entry.k === 'e' ? ends : starts;
      if (!map.has(entry.id)) map.set(entry.id, entry);
    }
  }
  const operations = [...starts.values()].map(s => ({ ...s, ...(ends.get(s.id) ?? { outcome: 'incomplete', code: 'NO_COMPLETION_RECEIPT' }), delivery: ends.get(s.id)?.delivery ?? s.delivery ?? null }));
  for (const [key, e] of ends) if (!starts.has(key)) operations.push(e);
  operations.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || String(a.id).localeCompare(String(b.id)));
  return { operations, files, damaged, indexComplete: fs.existsSync(path.join(indexDir, '.complete')) };
}

// The kernel's delivery receipts registered in [from, to): delivered or not, the registered -> complete time, and the
// phases of the problems of a refusal. Only result.json files of at most 16 MB whose mtime is not before `from`.
export function readReceipts(directory, { from = -Infinity, to = Infinity } = {}) {
  const receipts = []; let damaged = 0, skipped = 0;
  if (!directory) return { receipts, damaged, skipped, present: false };
  let names = [];
  try { names = fs.readdirSync(directory); } catch { return { receipts, damaged, skipped, present: false }; }
  for (const name of names) {
    const file = path.join(directory, name, 'result.json');
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (stat.mtimeMs < from || stat.size > 16 * 1024 * 1024) { skipped++; continue; }
    let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { damaged++; continue; }
    const history = Array.isArray(value?.history) ? value.history : [];
    const time = stage => { const h = history.find(x => x?.stage === stage); const ms = Date.parse(h?.time ?? ''); return Number.isFinite(ms) ? ms : null; };
    const registered = time('registered'), complete = time('complete');
    if (registered === null || registered < from || registered >= to) { skipped++; continue; }
    const phases = [...new Set((Array.isArray(value.problems) ? value.problems : []).map(p => p?.phase).filter(p => typeof p === 'string'))];
    receipts.push({ registered, delivered: value.delivered === true, kernelMs: value.delivered === true && complete !== null ? complete - registered : null,
      code: typeof value.code === 'string' ? value.code : null, phases, lane: 'o11' });
  }
  return { receipts, damaged, skipped, present: true };
}

// ---- grouping ----------------------------------------------------------------------------------------------------------
const ms = iso => Date.parse(iso);
const handOff = e => e.code === 'CONTINUED' || (e.code === 'RESULT_UNOBSERVED' && e.endedAt && ms(e.endedAt) - ms(e.startedAt) >= 24_500 && ms(e.endedAt) - ms(e.startedAt) <= 26_000);
const isDeliveryCall = e => {
  if (e.interface === 'api' || e.interface === 'receipt-import') return false;
  // An ssam_code continuation names no action: it counts when it continues a write (logicalDeliveries).
  if (e.delivery?.tool) return ATTEMPT_TOOLS.has(e.delivery.tool) || (e.delivery.tool === 'ssam_code' && (e.delivery.action === 'write' || (!e.delivery.action && !!e.delivery.continueTask)));
  return e.operation === 'deliver';
};
const statusOf = e => (e.outcome === 'success' && e.code === 'OK' ? 'accepted' : ['failure'].includes(e.outcome) ? 'refused' : 'unresolved');
const laneKey = e => (['o11', 'odc'].includes(e.lane) ? e.lane : e.delivery?.tool === 'studio_deliver' ? 'odc' : e.delivery?.tool === 'o11_deliver' ? 'o11' : 'unknown');

// The logical deliveries of the delivery calls, in start order.
export function logicalDeliveries(operations) {
  const logical = [], open = new Map(), byTask = new Map();
  for (const e of operations.filter(isDeliveryCall)) {
    const lane = laneKey(e), key = (e.sessionId ?? 'no-session') + '|' + lane;
    const start = ms(e.startedAt), end = e.endedAt ? ms(e.endedAt) : start;
    const recorded = !!e.delivery?.tool;
    let parent = null, inferredContinuation = false;
    if (recorded && e.delivery.continueTask) {
      parent = byTask.get(e.delivery.continueTask) ?? null;
      // An ssam_code continuation of no known write (a check or a plan handed off) is not a delivery.
      if (!parent && e.delivery.tool === 'ssam_code' && !e.delivery.action) continue;
      parent ??= open.get(key) ?? null;
    }
    else if (!recorded) {
      const previous = open.get(key);
      const last = previous?.calls.at(-1);
      if (last && handOff(last) && start - (last.endedAt ? ms(last.endedAt) : ms(last.startedAt)) <= KPI_WINDOWS.continuationGapMs) { parent = previous; inferredContinuation = true; }
    }
    if (parent) {
      parent.calls.push(e); parent.continuations++; parent.end = Math.max(parent.end, end);
      if (inferredContinuation) parent.inferredContinuation = true;
    } else {
      parent = { session: e.sessionId ?? null, lane, module: e.delivery?.module ?? null, tool: e.delivery?.tool ?? 'deliver', recorded,
        start, end, calls: [e], continuations: 0, basedOn: e.delivery ? { job: e.delivery.basedOnJob ?? null, sha256: e.delivery.basedOnSha256 ?? null,
          taskId: e.delivery.basedOnTaskId ?? null, closePrevious: e.delivery.closePrevious ?? null } : null };
      logical.push(parent);
    }
    open.set(key, parent);
    if (e.delivery?.taskId) byTask.set(e.delivery.taskId, parent);
  }
  for (const l of logical) {
    const last = l.calls.at(-1);
    l.status = statusOf(last); l.code = last.code ?? null;
    l.taskIds = new Set(l.calls.map(c => c.delivery?.taskId).filter(Boolean));
    l.nextJobs = new Set(l.calls.map(c => c.delivery?.nextJob).filter(Boolean));
    l.nextShas = new Set(l.calls.map(c => c.delivery?.nextSha256).filter(Boolean));
    const problems = last.delivery?.problems;
    l.phases = Array.isArray(problems) && problems.length ? [...new Set(problems.map(p => p.phase).filter(Boolean))] : null;
  }
  return logical;
}

// The chains of the logical deliveries (see the definitions above).
export function chainsOf(logical) {
  const chains = [], SCAN = 500;
  // A recorded link: the job, job hash or task of a logical delivery of an open chain (any of its items).
  const linkOf = l => {
    const b = l.basedOn; if (!b) return null;
    const links = x => (b.job && x.nextJobs.has(b.job)) || (b.sha256 && x.nextShas.has(b.sha256)) || (b.taskId && x.taskIds.has(b.taskId)) || (b.closePrevious && x.taskIds.has(b.closePrevious));
    for (let i = chains.length - 1; i >= Math.max(0, chains.length - SCAN); i--) {
      const chain = chains[i];
      if (chain.items[0].lane === l.lane && chain.items.at(-1).status !== 'accepted' && chain.items.some(links)) return chain;
    }
    return null;
  };
  // The heuristic: the latest chain of the session and lane (and module, when both name one) goes on when its last
  // logical delivery was not accepted and ended at most 45 min before this one starts.
  const heuristic = l => {
    for (let i = chains.length - 1; i >= Math.max(0, chains.length - SCAN); i--) {
      const chain = chains[i], tail = chain.items.at(-1);
      if (tail.session !== l.session || tail.lane !== l.lane || (tail.module && l.module && tail.module !== l.module)) continue;
      return tail.status !== 'accepted' && l.start - tail.end <= KPI_WINDOWS.chainGapMs ? chain : null;
    }
    return null;
  };
  for (const l of logical) {
    const linked = linkOf(l);
    if (linked) { linked.items.push(l); continue; }
    const guessed = heuristic(l);
    if (guessed) { guessed.items.push(l); guessed.inferred = true; continue; }
    chains.push({ items: [l], inferred: false });
  }
  return chains;
}

// ---- statistics --------------------------------------------------------------------------------------------------------
export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), at = (sorted.length - 1) * p, low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
}
const round = (value, digits = 1) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const pct = (part, whole) => (whole ? round((100 * part) / whole) : null);
// The ISO 8601 week of an instant (UTC): 2026-W43.
export function isoWeek(at) {
  const d = new Date(at); const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return thursday.getUTCFullYear() + '-W' + String(1 + Math.floor((thursday - yearStart) / (7 * 86_400_000))).padStart(2, '0');
}

// One row of the table from the logical deliveries, chains, reads and receipts of one group.
function row(week, lane, { logical, chains, reads, receipts }) {
  const accepted = logical.filter(l => l.status === 'accepted');
  const ended = chains.filter(c => c.items.at(-1).status === 'accepted');
  let pairs = 0;
  for (const c of chains) for (let i = 1; i < c.items.length; i++) {
    const [a, b] = [c.items[i - 1], c.items[i]];
    if (a.status === 'refused' && b.status === 'refused' && a.code && a.code === b.code) pairs++;
  }
  const refused = logical.filter(l => l.status === 'refused'), phased = refused.filter(l => l.phases);
  const fromReceipts = receipts.filter(r => !r.delivered && r.phases.length);
  const [afterBuild, of, source] = phased.length
    ? [phased.filter(l => l.phases.some(p => AFTER_BUILD.has(p))).length, phased.length, 'queue']
    : fromReceipts.length ? [fromReceipts.filter(r => r.phases.some(p => AFTER_BUILD.has(p))).length, fromReceipts.length, 'receipts'] : [0, 0, null];
  const walls = accepted.map(l => (l.end - l.start) / 1000), kernel = receipts.map(r => r.kernelMs).filter(v => v !== null).map(v => v / 1000);
  return { week, lane, logical: logical.length, chains: chains.length, inferredChains: chains.filter(c => c.inferred).length,
    firstAcceptedPct: pct(chains.filter(c => c.items[0].status === 'accepted').length, chains.length),
    attemptsPerAccepted: ended.length ? round(ended.reduce((n, c) => n + c.items.length, 0) / ended.length, 2) : null,
    sameCodePairs: pairs, readsP50: round(quantile(reads, 0.5)), readsP90: round(quantile(reads, 0.9)),
    continuedPct: pct(logical.filter(l => l.continuations > 0).length, logical.length),
    wallP50s: round(quantile(walls, 0.5)), wallP90s: round(quantile(walls, 0.9)),
    refusedAfterBuildPct: pct(afterBuild, of), refusedAfterBuildOf: of, refusedAfterBuildSource: source,
    kernelP50s: round(quantile(kernel, 0.5)), kernelP90s: round(quantile(kernel, 0.9)), receipts: receipts.length };
}

// The KPI table of operations (index-shaped records) and receipts, rows by week and lane, then the total of each lane and
// the total of all lanes.
export function deliveryKpi({ operations = [], receipts = [], from = -Infinity, to = Infinity, lane } = {}) {
  const inRange = at => at >= from && at < to;
  const logical = logicalDeliveries(operations);
  const chains = chainsOf(logical).filter(c => inRange(c.items[0].start) && (!lane || c.items[0].lane === lane));
  const counted = logical.filter(l => inRange(l.start) && (!lane || l.lane === lane));
  // Reads by session, in start order, for the window before each accepted logical delivery.
  const readsBySession = new Map();
  for (const e of operations) if (READS.has(e.operation)) {
    const key = e.sessionId ?? 'no-session';
    if (!readsBySession.has(key)) readsBySession.set(key, []);
    readsBySession.get(key).push({ at: ms(e.startedAt), lane: e.lane });
  }
  const readsOf = l => (readsBySession.get(l.session ?? 'no-session') ?? []).filter(r => r.at >= l.start - KPI_WINDOWS.readsBeforeMs && r.at < l.start && (r.lane === l.lane || !['o11', 'odc'].includes(r.lane))).length;
  const scoped = receipts.filter(r => inRange(r.registered) && (!lane || r.lane === lane));
  const groups = new Map();
  const group = (week, laneName) => { const key = week + '|' + laneName; if (!groups.has(key)) groups.set(key, { week, lane: laneName, logical: [], chains: [], reads: [], receipts: [] }); return groups.get(key); };
  const targets = (at, laneName) => [group(isoWeek(at), laneName), group('total', laneName), group('total', 'all')];
  for (const l of counted) for (const g of targets(l.start, l.lane)) { g.logical.push(l); if (l.status === 'accepted') g.reads.push(readsOf(l)); }
  for (const c of chains) for (const g of targets(c.items[0].start, c.items[0].lane)) g.chains.push(c);
  for (const r of scoped) for (const g of targets(r.registered, r.lane)) g.receipts.push(r);
  const order = g => [g.week === 'total' ? 1 : 0, g.week, g.lane === 'all' ? 1 : 0, g.lane];
  const rows = [...groups.values()].sort((a, b) => { const [x, y] = [order(a), order(b)]; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; })
    .map(g => row(g.week, g.lane, g));
  return { rows, logical: counted.length, chains: chains.length, recordedCalls: counted.reduce((n, l) => n + l.calls.filter(c => c.delivery?.tool).length, 0),
    calls: counted.reduce((n, l) => n + l.calls.length, 0) };
}

// The answer of the view: the table as paged.tables (the shape of the paged answers: at, columns, rows of cells), the
// definitions and what was read. queueDirectory: the friction folder; receiptsDirectory: kernel/.local/work/deliver or null.
export function kpiView({ queueDirectory, receiptsDirectory = null, since, until, lane } = {}) {
  if (lane !== undefined && !['o11', 'odc'].includes(lane)) throw Error('Invalid lane');
  const { from, to } = kpiRange({ since, until });
  const index = readIndexOperations(queueDirectory, { from, to });
  const read = readReceipts(receiptsDirectory, { from, to });
  const kpi = deliveryKpi({ operations: index.operations, receipts: read.receipts, from, to, lane });
  return { ok: true, view: 'delivery-kpi', ...(since ? { since } : {}), ...(until ? { until } : {}), ...(lane ? { lane } : {}),
    logical: kpi.logical, chains: kpi.chains, calls: kpi.calls, recordedCalls: kpi.recordedCalls,
    paged: { tables: [{ at: '/rows', columns: KPI_COLUMNS, rows: kpi.rows.map(r => KPI_COLUMNS.map(c => r[c] ?? null)) }], complete: true },
    definitions: KPI_DEFINITIONS,
    sources: { indexFiles: index.files, indexDamaged: index.damaged, indexComplete: index.indexComplete,
      receipts: read.present ? { read: read.receipts.length, damaged: read.damaged, outside: read.skipped } : 'absent' } };
}
