// The network check of the agent (fase4-24, docs/FASE2-AGENTE.md 2.10): the kind net.probe. The owner's production test
// of 2026-10-11 lost 75 s to two uploads stalled on one of the two public exits of the user's internet (the router
// balanced each connection over two exits; on one of them small requests passed and bodies of 60-75 KB crawled at
// ~2.3 KB/s). Nothing in the agent could tell "one exit loses packets" from "the server is slow". This kind uploads
// throwaway random bytes to the server (PUT /agent/v1/probe/<id>), each on a connection of its own (net.mjs `fresh`, so
// each one may leave by another exit), within one time budget, and answers what each upload did; the server, which sees
// the public address each one came from, groups them per exit (platforms/odc/facade/hosted/network-check.mjs) and
// ssam_doctor {network:true} says it in plain words. Nothing of the machine is read or written: the bytes are random and
// the server discards them.
//
// params: {probes?: [{bytes, count}], budgetMs?}. Groups run in order of size, the uploads of a group all at once; a group
// that is not the last gets at most 40% of the budget, so the small uploads measure the connection before the large ones
// fill the uplink. Default: 8 uploads of 1 KiB, then 2 of 1 MiB, in 4.5 s. Each upload answers {id, bytes, ms, ok, status,
// via?, serverMs?, error?}; an upload still running when its time is up is aborted (error "budget").
import { randomBytes } from 'node:crypto';
import { refuse } from './errors.mjs';

export const NET_PROBE_KIND = 'net.probe';
export const PROBE_MAX_BYTES = 2 * 1024 * 1024;
export const PROBE_MAX_UPLOADS = 24;
export const PROBE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const PROBE_MAX_BUDGET_MS = 15000;
export const PROBE_DEFAULTS = Object.freeze({ probes: Object.freeze([Object.freeze({ bytes: 1024, count: 8 }), Object.freeze({ bytes: 1048576, count: 2 })]), budgetMs: 4500 });
const EARLY_SHARE = 0.4;

const invalid = message => refuse('PARAMS_INVALID', message);
const reasonOf = error => (['AbortError', 'TimeoutError'].includes(error?.name) ? 'aborted' : String(error?.message || error || 'no answer').slice(0, 200));

// The uploads to run, checked before anything is sent: [{bytes, count}] sorted by size, and the budget.
export function probePlan(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object');
  const probes = params.probes ?? PROBE_DEFAULTS.probes;
  const budgetMs = params.budgetMs ?? PROBE_DEFAULTS.budgetMs;
  if (!Array.isArray(probes) || probes.length === 0 || probes.length > 4) throw invalid('probes must be 1 to 4 entries {bytes, count}');
  let uploads = 0, total = 0;
  const groups = probes.map(entry => {
    const bytes = entry?.bytes, count = entry?.count;
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > PROBE_MAX_BYTES) throw invalid('probes[].bytes must be 1 to ' + PROBE_MAX_BYTES);
    if (!Number.isSafeInteger(count) || count < 1 || count > 16) throw invalid('probes[].count must be 1 to 16');
    uploads += count; total += bytes * count;
    return { bytes, count };
  }).sort((a, b) => a.bytes - b.bytes);
  if (uploads > PROBE_MAX_UPLOADS) throw invalid('at most ' + PROBE_MAX_UPLOADS + ' uploads per check');
  if (total > PROBE_MAX_TOTAL_BYTES) throw invalid('at most ' + PROBE_MAX_TOTAL_BYTES + ' bytes per check');
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 500 || budgetMs > PROBE_MAX_BUDGET_MS) throw invalid('budgetMs must be 500 to ' + PROBE_MAX_BUDGET_MS);
  return { groups, budgetMs };
}

// put(id, body, {signal, fresh}) -> {status, value} (channel.probePut): one upload on a connection of its own.
export async function netProbe(params = {}, { put, now = Date.now, random = randomBytes, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const plan = probePlan(params);
  if (typeof put !== 'function') throw refuse('NET_PROBE_UNAVAILABLE', 'This agent has no channel for the network check');
  const started = now();
  const probes = [];
  for (const [index, group] of plan.groups.entries()) {
    const left = plan.budgetMs - (now() - started);
    if (left <= 0) { for (let i = 0; i < group.count; i++) probes.push({ id: null, bytes: group.bytes, ms: 0, ok: false, status: 0, error: 'budget' }); continue; }
    const last = index === plan.groups.length - 1;
    const share = last ? left : Math.min(left, Math.max(250, Math.round(plan.budgetMs * EARLY_SHARE)));
    const window = new AbortController();
    const timer = setTimer(() => window.abort(new Error('budget')), share);
    try {
      probes.push(...await Promise.all(Array.from({ length: group.count }, async () => {
        const id = random(16).toString('hex');
        const body = random(group.bytes);
        const t0 = now();
        try {
          const reply = await put(id, body, { signal: window.signal, fresh: true });
          const value = reply?.value && typeof reply.value === 'object' ? reply.value : {};
          return { id, bytes: group.bytes, ms: now() - t0, ok: reply?.status === 200, status: Number(reply?.status) || 0,
            ...(typeof value.via === 'string' ? { via: value.via.slice(0, 64) } : {}), ...(Number.isFinite(value.ms) ? { serverMs: value.ms } : {}) };
        } catch (error) {
          return { id, bytes: group.bytes, ms: now() - t0, ok: false, status: 0, error: window.signal.aborted ? 'budget' : reasonOf(error) };
        }
      })));
    } finally { clearTimer(timer); }
  }
  return { budgetMs: plan.budgetMs, ms: now() - started, probes };
}
