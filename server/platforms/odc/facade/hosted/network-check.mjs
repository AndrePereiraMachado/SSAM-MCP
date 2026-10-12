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

const seconds = ms => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1).replace('.', ',') + ' s');
const size = bytes => (bytes >= 1048576 ? (bytes / 1048576).toFixed(bytes % 1048576 ? 1 : 0).replace('.', ',') + ' MB' : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' B');
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
    return { bytes: Number(p.bytes) || 0, ms: Number(p.ms) || 0, ok: p.ok === true, via: record?.via ?? (typeof p.via === 'string' ? p.via : null),
      state: classify(p, record), received: record?.received ?? null };
  });
  const groups = new Map();
  for (const row of rows.filter(r => r.state !== 'unreached')) {
    const key = row.via ?? 'desconhecida';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const paths = [...groups.entries()].map(([via, list]) => {
    const count = state => list.filter(r => r.state === state).length;
    const small = list.filter(r => r.ok && r.bytes <= SMALL_BYTES).map(r => r.ms);
    const large = list.filter(r => r.ok && r.bytes > SMALL_BYTES);
    const best = large.length ? large.reduce((a, b) => (a.bytes / a.ms >= b.bytes / b.ms ? a : b)) : null;
    const stalled = count('stalled'), slow = count('slow');
    return { via, status: stalled ? 'perde' : slow ? 'lenta' : 'boa', uploads: list.length, ok: count('ok'), slow, stalled,
      smallMs: median(small), ...(best ? { largeBytes: best.bytes, largeMs: best.ms } : {}) };
  }).sort((a, b) => b.uploads - a.uploads);
  const unreached = rows.filter(r => r.state === 'unreached').length;
  const ok = rows.filter(r => r.state === 'ok').length;
  const describe = p => p.via + (p.largeMs != null ? ' (subiu ' + size(p.largeBytes) + ' em ' + seconds(p.largeMs) + ')' : p.smallMs != null ? ' (1 envio pequeno em ' + seconds(p.smallMs) + ')' : '');
  const bad = paths.filter(p => p.status === 'perde');
  const good = paths.filter(p => p.status === 'boa');
  let verdict, message;
  if (rows.length === 0) {
    verdict = 'no-probes'; message = 'o agente não fez nenhum envio de teste';
  } else if (unreached > 0 && unreached * 4 >= rows.length) {
    verdict = 'new-connections-fail';
    message = plural(unreached, 'de ' + rows.length + ' envios em conexão nova não chegou', 'de ' + rows.length + ' envios em conexão nova não chegaram') + ' ao servidor: a sua internet está perdendo conexões novas (comum em 5G ou celular ancorado). '
      + 'O SSAM repete o que não chegou, mas cada conexão perdida custa de 15 a 20 s; uma rede cabeada ou outro Wi-Fi resolve.';
  } else if (bad.length && good.length) {
    const lost = bad.reduce((n, p) => n + p.stalled, 0), sent = bad.reduce((n, p) => n + p.uploads, 0);
    verdict = 'one-exit-lossy';
    message = (bad.length === 1 ? 'uma das suas saídas de internet (' + bad[0].via + ') perde pacotes nas subidas: ' : 'algumas das suas saídas de internet (' + bad.map(p => p.via).join(', ') + ') perdem pacotes nas subidas: ')
      + lost + ' de ' + sent + ' envios por ' + (bad.length === 1 ? 'ela' : 'elas') + ' travaram; ' + (good.length === 1 ? 'a outra, ' + describe(good[0]) + ', está boa. ' : 'as outras (' + good.map(describe).join('; ') + ') estão boas. ')
      + 'A sua internet usa mais de uma saída ao mesmo tempo (roteador com duas WAN em balanceamento, ou o provedor). O SSAM repete a parte travada em conexão nova, '
      + 'mas cada travamento custa segundos: confira o roteador ou use uma saída só.';
  } else if (bad.length) {
    const lost = bad.reduce((n, p) => n + p.stalled, 0);
    verdict = 'uploads-lossy';
    message = 'a sua internet perde pacotes nas subidas: ' + lost + ' de ' + rows.length + ' envios em conexão nova chegaram ao servidor e travaram'
      + (paths.length > 1 ? ' (saídas ' + paths.map(p => p.via).join(', ') + ')' : '') + '. Envios pequenos passam e arquivos travam: o SSAM repete as partes, mas cada travamento custa segundos.';
  } else if (paths.some(p => p.status === 'lenta')) {
    const largest = paths.filter(p => p.largeMs != null).map(describe);
    verdict = 'slow';
    message = 'a sua internet está lenta nas subidas' + (largest.length ? ': ' + largest.join('; ') : '') + '. Nada travou; entregas grandes só levam mais tempo.';
  } else {
    verdict = 'ok';
    const small = median(rows.filter(r => r.ok && r.bytes <= SMALL_BYTES).map(r => r.ms));
    const large = rows.filter(r => r.ok && r.bytes > SMALL_BYTES);
    message = 'subidas boas: ' + ok + ' de ' + rows.length + ' envios em conexão nova chegaram' + (small != null ? ' (pequenos em ' + seconds(small) + '' : '')
      + (large.length ? (small != null ? ', ' : ' (') + size(large[0].bytes) + ' em ' + seconds(median(large.map(r => r.ms))) + ')' : small != null ? ')' : '')
      + (paths.length > 1 ? '; a sua internet sai por ' + paths.length + ' endereços (' + paths.map(p => p.via).join(', ') + ') e todos estão bons' : '') + '.'
      + (unreached ? ' ' + plural(unreached, 'envio não chegou', 'envios não chegaram') + ', pouco para pesar.' : '');
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
  if (!connected) return { ran: false, code: 'AGENT_NOT_CONNECTED', message: 'o teste de rede roda pelo agente, que não está conectado agora' };
  if (typeof link.supports === 'function' && !link.supports(NET_PROBE_KIND))
    return { ran: false, code: 'AGENT_KIND_MISSING', agentVersion: info?.agentVersion ?? null,
      message: 'o agente desta conta (' + (info?.agentVersion ?? 'versão antiga') + ') ainda não faz o teste de rede: peça ao dono do servidor o pacote do agente atual' };
  const started = now();
  let value;
  try { value = await link.call(NET_PROBE_KIND, plan, { timeoutMs: plan.budgetMs + MARGIN_MS }); }
  catch (error) { return { ran: false, code: error?.code ?? 'AGENT_ERROR', message: 'o teste de rede não terminou: ' + String(error?.message ?? error).slice(0, 300) }; }
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
    message: plural(uploads.slow, 'subida de arquivo do agente demorou', 'subidas de arquivo do agente demoraram') + ' nos últimos 30 min'
      + (worst ? ' (a pior: ' + size(worst.bytes) + ' em ' + seconds(worst.ms) + (worst.via ? ', pela saída ' + worst.via : '') + ')' : '')
      + ': rode o teste de rede para saber se é uma saída da internet do usuário',
    continuation: { tool: 'ssam_doctor', arguments: { network: true }, why: 'testa as subidas do agente em conexões novas, por saída da internet (uns 5 s)' } };
}
