// The network check of a hosted session (fase4-24, docs/FASE2-AGENTE.md 2.10): ssam_doctor {network:true}. The owner's
// production test of 2026-10-11 (C:\t\lentidao\ANALISE.md 2.5) lost 75 s to two uploads stalled on one of the two public
// exits of the user's internet, and 3.5 min of doubt in the create-app went to the wrong diagnosis. The agent uploads
// throwaway bytes on new connections (kind net.probe, agent/lib/net-probe.mjs); the hub records where each one came
// from and what arrived (agent-hub.mjs probeUpload); this module joins both and says, per exit, in plain words, whether
// the uploads pass, crawl or never get here.
//   networkCheck(link, {plan, now}) -> {ran:true, verdict, message, paths, ...} | {ran:false, code, message}
//   summarizeProbes(probes, records) -> {verdict, message, paths, unreached, probes, ok}
//   uploadsHint(link) -> {code, message, continuation} when the hub saw slow upload parts lately, else null
export const NET_PROBE_KIND = 'net.probe';
export const DEFAULT_PLAN = Object.freeze({ probes: [{ bytes: 1024, count: 8 }, { bytes: 1048576, count: 2 }], budgetMs: 4500 });
const MARGIN_MS = 5000;
// An upload that reached the server but moved less than this per second stalled (the production exit B: ~2.3 KB/s); one
// that moved more but did not finish in its time is only slow.
const STALL_BYTES_PER_SECOND = 32768;
// A small upload (<= 64 KiB) that took longer than this on a new connection is slow: connection, TLS and the bytes.
const SMALL_BYTES = 65536;
const SMALL_SLOW_MS = 2000;
// A large upload slower than this (bytes per second, ~2 Mbit/s) is slow.
const LARGE_SLOW_BYTES_PER_SECOND = 262144;

// The texts are English only (owner rule of 2026-10-15), with a decimal point. The structured values are English too since
// the owner's decision of 2026-10-19: paths[].status 'good' | 'slow' | 'losing' (they were 'boa' | 'lenta' | 'perde') and the
// exit key UNKNOWN_EXIT 'unknown' of an upload whose address the hub could not read (agent-hub.mjs maskAddress gives the same
// value; it was desconhecida). No agent reads them: the agent only copies the via the hub answered to its upload into its
// own answer (agent/lib/net-probe.mjs), so an older answer may still name LEGACY_UNKNOWN_EXIT, which reads as UNKNOWN_EXIT.
export const UNKNOWN_EXIT = 'unknown';
export const LEGACY_UNKNOWN_EXIT = 'desconhecida';
const exitOf = via => (via === LEGACY_UNKNOWN_EXIT ? UNKNOWN_EXIT : via);
const exitName = exitOf;
const seconds = ms => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s');
const size = bytes => (bytes >= 1048576 ? (bytes / 1048576).toFixed(bytes % 1048576 ? 1 : 0) + ' MB' : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' B');
const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; };
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

// One upload as the doctor reads it: ok, slow, stalled (it reached the server and crawled or stopped) or unreached (the
// connection never brought it to the server).
function classify(probe, record) {
  const reached = !!record;
  const ms = Number(probe.ms) || 0;
  if (probe.ok === true) {
    const slow = probe.bytes <= SMALL_BYTES ? ms > SMALL_SLOW_MS : probe.bytes / Math.max(ms, 1) * 1000 < LARGE_SLOW_BYTES_PER_SECOND;
    return slow ? 'slow' : 'ok';
  }
  if (!reached) return 'unreached';
  // The agent's own time (until it gave up) against what reached the server: a body that stopped after a few KB is stalled.
  const received = Number(record.received) || 0;
  const elapsed = Math.max(ms, Number(record.ms) || 0, 1);
  return received / elapsed * 1000 < STALL_BYTES_PER_SECOND ? 'stalled' : 'slow';
}

export function summarizeProbes(probes = [], records = []) {
  const byId = new Map((Array.isArray(records) ? records : []).map(r => [r.id, r]));
  const rows = (Array.isArray(probes) ? probes : []).map(p => {
    const record = p.id ? byId.get(p.id) : undefined;
    return { bytes: Number(p.bytes) || 0, ms: Number(p.ms) || 0, ok: p.ok === true, via: exitOf(record?.via ?? (typeof p.via === 'string' ? p.via : null)),
      state: classify(p, record), received: record?.received ?? null };
  });
  const groups = new Map();
  for (const row of rows.filter(r => r.state !== 'unreached')) {
    const key = row.via ?? UNKNOWN_EXIT;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const paths = [...groups.entries()].map(([via, list]) => {
    const count = state => list.filter(r => r.state === state).length;
    const small = list.filter(r => r.ok && r.bytes <= SMALL_BYTES).map(r => r.ms);
    const large = list.filter(r => r.ok && r.bytes > SMALL_BYTES);
    const best = large.length ? large.reduce((a, b) => (a.bytes / a.ms >= b.bytes / b.ms ? a : b)) : null;
    const stalled = count('stalled'), slow = count('slow');
    return { via, status: stalled ? 'losing' : slow ? 'slow' : 'good', uploads: list.length, ok: count('ok'), slow, stalled,
      smallMs: median(small), ...(best ? { largeBytes: best.bytes, largeMs: best.ms } : {}) };
  }).sort((a, b) => b.uploads - a.uploads);
  const unreached = rows.filter(r => r.state === 'unreached').length;
  const ok = rows.filter(r => r.state === 'ok').length;
  const describe = p => exitName(p.via) + (p.largeMs != null ? ' (uploaded ' + size(p.largeBytes) + ' in ' + seconds(p.largeMs) + ')' : p.smallMs != null ? ' (a small upload in ' + seconds(p.smallMs) + ')' : '');
  const exits = list => list.map(p => exitName(p.via)).join(', ');
  const bad = paths.filter(p => p.status === 'losing');
  const good = paths.filter(p => p.status === 'good');
  let verdict, message;
  if (rows.length === 0) {
    verdict = 'no-probes'; message = 'the agent made no test upload';
  } else if (unreached > 0 && unreached * 4 >= rows.length) {
    verdict = 'new-connections-fail';
    message = unreached + ' of ' + rows.length + ' uploads on a new connection did not reach the server: your internet is losing new connections (common on 5G or a tethered phone). '
      + 'SSAM repeats what did not arrive, but each lost connection costs 15 to 20 s; a wired network or another Wi-Fi solves it.';
  } else if (bad.length && good.length) {
    const lost = bad.reduce((n, p) => n + p.stalled, 0), sent = bad.reduce((n, p) => n + p.uploads, 0);
    verdict = 'one-exit-lossy';
    message = (bad.length === 1 ? 'one of your internet exits (' + exitName(bad[0].via) + ') loses packets on uploads: ' : 'some of your internet exits (' + exits(bad) + ') lose packets on uploads: ')
      + lost + ' of ' + sent + ' uploads through ' + (bad.length === 1 ? 'it' : 'them') + ' stalled; ' + (good.length === 1 ? 'the other one, ' + describe(good[0]) + ', is fine. ' : 'the others (' + good.map(describe).join('; ') + ') are fine. ')
      + 'Your internet uses more than one exit at the same time (a router with two WANs in load balancing, or the provider). SSAM repeats the stalled part on a new connection, '
      + 'but each stall costs seconds: check the router or use a single exit.';
  } else if (bad.length) {
    const lost = bad.reduce((n, p) => n + p.stalled, 0);
    verdict = 'uploads-lossy';
    message = 'your internet loses packets on uploads: ' + lost + ' of ' + rows.length + ' uploads on a new connection reached the server and stalled'
      + (paths.length > 1 ? ' (exits ' + exits(paths) + ')' : '') + '. Small uploads pass and files stall: SSAM repeats the parts, but each stall costs seconds.';
  } else if (paths.some(p => p.status === 'slow')) {
    const largest = paths.filter(p => p.largeMs != null).map(describe);
    verdict = 'slow';
    message = 'your internet is slow on uploads' + (largest.length ? ': ' + largest.join('; ') : '') + '. Nothing stalled; large deliveries just take longer.';
  } else {
    verdict = 'ok';
    const small = median(rows.filter(r => r.ok && r.bytes <= SMALL_BYTES).map(r => r.ms));
    const large = rows.filter(r => r.ok && r.bytes > SMALL_BYTES);
    message = 'uploads are fine: ' + ok + ' of ' + rows.length + ' uploads on a new connection arrived' + (small != null ? ' (small ones in ' + seconds(small) + '' : '')
      + (large.length ? (small != null ? ', ' : ' (') + size(large[0].bytes) + ' in ' + seconds(median(large.map(r => r.ms))) + ')' : small != null ? ')' : '')
      + (paths.length > 1 ? '; your internet goes out through ' + paths.length + ' addresses (' + exits(paths) + ') and all of them are fine' : '') + '.'
      + (unreached ? ' ' + plural(unreached, 'upload did not arrive', 'uploads did not arrive') + ', too few to matter.' : '');
  }
  return { verdict, message, paths, unreached, uploads: rows.length, ok };
}

// The check itself: the agent's uploads through the link (only to an agent whose Hello lists net.probe), then what the hub
// recorded for them. Never throws: what kept it from running is the answer.
export async function networkCheck(link, { plan = DEFAULT_PLAN, now = Date.now } = {}) {
  let info = null;
  try { info = link?.info?.() ?? null; } catch { info = null; }
  let connected = false;
  try { connected = link?.connected?.() === true; } catch { connected = false; }
  if (!connected) return { ran: false, code: 'AGENT_NOT_CONNECTED', message: 'the network check runs through the agent, which is not connected now' };
  if (typeof link.supports === 'function' && !link.supports(NET_PROBE_KIND))
    return { ran: false, code: 'AGENT_KIND_MISSING', agentVersion: info?.agentVersion ?? null,
      message: 'the agent of this account (' + (info?.agentVersion ?? 'an old version') + ') does not run the network check yet: ask the server owner for the current agent pack' };
  const started = now();
  let value;
  try { value = await link.call(NET_PROBE_KIND, plan, { timeoutMs: plan.budgetMs + MARGIN_MS }); }
  catch (error) { return { ran: false, code: error?.code ?? 'AGENT_ERROR', message: 'the network check did not finish: ' + String(error?.message ?? error).slice(0, 300) }; }
  const probes = Array.isArray(value?.probes) ? value.probes : [];
  let records = [];
  try { records = link.probes?.(probes.map(p => p.id).filter(Boolean)) ?? []; } catch { records = []; }
  return { ran: true, ms: now() - started, budgetMs: plan.budgetMs, ...summarizeProbes(probes, records) };
}

// Slow upload parts the hub saw for this token lately (agent-hub.mjs noteUpload): the hint to run the check.
export function uploadsHint(link) {
  let uploads = null;
  try { uploads = link?.uploads?.() ?? null; } catch { uploads = null; }
  if (!uploads || !uploads.slow) return null;
  const worst = [...(uploads.recent ?? [])].sort((a, b) => b.ms - a.ms)[0];
  return { code: 'UPLOADS_SLOW', uploads,
    message: plural(uploads.slow, 'file upload of the agent was slow', 'file uploads of the agent were slow') + ' in the last 30 min'
      + (worst ? ' (the worst: ' + size(worst.bytes) + ' in ' + seconds(worst.ms) + (worst.via ? ', through the exit ' + exitName(worst.via) : '') + ')' : '')
      + ': run the network check to find out whether it is an exit of the user\'s internet',
    continuation: { tool: 'ssam_doctor', arguments: { network: true }, why: 'tests the agent\'s uploads on new connections, per exit of the user\'s internet (about 5 s)' } };
}
