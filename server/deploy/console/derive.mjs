// Facts derived from host.json and the live state, shared by the views (4.3) and the alert context (5): server state
// (up/down/starting/unknown), warm state (warm/partial/warming/cold/unknown), the public URL, license state counts.
import { serverContainer } from './host.mjs';

const MIN = 60000;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function publicHostOf(live, domain) {
  const hosts = live.server?.publicHosts ?? [];
  return hosts[0] || domain || null;
}
export const urlsOf = host => ({ publicHost: host, publicUrl: host ? `https://${host}/mcp` : null, serverUrl: host ? `https://${host}` : null });

// warm state of 4.3: 'warm' = warm event with every ok true (or worker false but an odc-worker process running);
// 'partial' = a false that is not covered; 'warming' = no warm yet and container younger than 6 min; 'cold' = older;
// 'unknown' = no host.json (or no server/docker section).
export function warmOf(host, now) {
  const docker = host.sec('docker'), server = host.sec('server');
  if (!host.doc || !server || !docker) return { state: 'unknown', detail: null, warm: null, workerRunning: null };
  const srv = serverContainer(docker);
  const startup = server.startup ?? {};
  const warm = startup.warm ?? null;
  const workerRunning = (Array.isArray(server.processes) ? server.processes : []).some(p => p.kind === 'odc-worker');
  if (!warm) {
    const startedAt = Date.parse(srv?.startedAt ?? startup.startedAt ?? '');
    const young = !Number.isNaN(startedAt) && now - startedAt < 6 * MIN;
    return { state: young ? 'warming' : 'cold', detail: null, warm: null, workerRunning };
  }
  const fails = [];
  if (warm.indexes && warm.indexes.ok === false) fails.push('índices');
  if (warm.delivery?.builder && warm.delivery.builder.ok === false) fails.push('builder residente');
  const workerFalse = !!(warm.delivery?.worker && warm.delivery.worker.ok === false);
  if (workerFalse && !workerRunning) fails.push('worker ODC');
  if (fails.length) return { state: 'partial', detail: `falhou: ${fails.join(', ')}`, warm, workerRunning };
  return { state: 'warm', detail: workerFalse ? 'worker ODC falhou no aquecimento e subiu sob demanda' : null, warm, workerRunning };
}

export function serverStatusOf(host, live, now) {
  const docker = host.sec('docker'), server = host.sec('server');
  const w = warmOf(host, now);
  if (!host.doc || !docker) {
    return { state: 'unknown', since: live.server?.since ?? null, pid: live.server?.pid ?? null, imageTag: null, health: null, warm: w.state, warmDetail: w.detail };
  }
  const srv = serverContainer(docker);
  const running = srv?.state === 'running';
  const health = srv?.health ?? null;
  const state = !running ? 'down' : health === 'starting' ? 'starting' : health === 'unhealthy' ? 'down' : 'up';
  const imageTag = server?.image?.tag ?? (typeof srv?.image === 'string' && srv.image.includes(':') ? srv.image.slice(srv.image.lastIndexOf(':') + 1) : null);
  return { state, since: running ? srv.startedAt ?? live.server?.since ?? null : null, pid: live.server?.pid ?? num(server?.health?.probe?.pid),
    imageTag: imageTag ? String(imageTag).slice(0, 80) : null, health, warm: w.state, warmDetail: w.detail };
}

export function licenseCounts(tokens) {
  const c = { active: 0, expired: 0, revoked: 0 };
  for (const t of tokens ?? []) c[t.state] = (c[t.state] ?? 0) + 1;
  return c;
}
