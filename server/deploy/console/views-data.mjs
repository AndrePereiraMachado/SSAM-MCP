// Payloads of /api/usage and /api/vps (DESIGN 4.3). Usage ranges are local days of the display time zone: today, the last
// 7 or 30 days including today, or one day. /api/vps passes the collector's sections through (null when a section failed
// or host.json is missing) with the derived fields the UI needs (ages, days left, kernel drift, warm, log sizes, series).
import { kernelDrift } from './alert-rules.mjs';
import { warmOf } from './derive.mjs';
import { serverContainer } from './host.mjs';
import { isDay } from './tz.mjs';
import { invalidField } from './texts.mjs';
import { tokenParam } from './views.mjs';

const DAY = 86400000;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const RANGES = new Set(['today', '7d', '30d', 'day']);

export function createDataViews(app) {
  const { tz, now, licenses, live, usage, host, sources, workspaces } = app;
  const nameOf = token => licenses.nameOf(token) ?? live.logNames[token] ?? null;

  function usagePayload(query) {
    const kind = query.get('range') || '7d';
    if (!RANGES.has(kind)) throw invalidField('range', 'today, 7d, 30d ou day');
    const today = tz.day(now());
    let days;
    if (kind === 'today') days = [today];
    else if (kind === '7d') days = tz.days(today, 7);
    else if (kind === '30d') days = tz.days(today, 30);
    else {
      const day = query.get('day');
      if (!isDay(day)) throw invalidField('day', 'AAAA-MM-DD');
      days = [day];
    }
    const token = tokenParam(query);
    const s = usage.summarize(days, { token, nameOf: t => nameOf(t) ?? t });
    const facts = host.facts;
    const rows = [...s.denied.rows].map(([key, v]) => {
      const [ip, status, ...rest] = key.split('|');
      return { ip, status: Number(status), path: rest.join('|'), count: v.count, lastAt: v.lastAt };
    }).sort((a, b) => b.count - a.count || String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 50);
    const caddyOk = !!host.sec('caddy');
    return {
      ok: true,
      range: { kind, from: days[0], to: days[days.length - 1], days: days.length, timeZone: tz.timeZone },
      indexing: app.indexing(),
      totals: s.totals,
      byCustomer: s.byCustomer.map(c => ({ ...c, workspaceBytes: workspaces.get(c.token)?.bytes ?? null })),
      byTool: s.byTool,
      byCode: s.byCode,
      byDay: s.byDay,
      denied: { available: caddyOk || facts.deniedSince != null, since: facts.deniedSince ?? null, byStatus: s.denied.byStatus, rows },
    };
  }

  function vpsPayload() {
    const t = now();
    const c = host.collector();
    const collector = { state: c.state, collectedAt: c.collectedAt, ageS: c.ageS, durationMs: c.durationMs, errors: c.errors, version: c.version };
    const logs = (() => { const s = sources.statFiles(); return { serverLogB: s.serverLogB, rotatedCount: s.rotatedCount, rotatedB: s.rotatedB,
      auditFiles: s.auditFiles, auditB: s.auditB, qualityFiles: s.qualityFiles, qualityB: s.qualityB, consoleAuditB: s.consoleAuditB }; })();
    const kernelFile = sources.kernel();
    if (!host.doc) {
      return { ok: true, now: new Date(t).toISOString(), collector, host: null, updates: null, security: null, tls: null, backups: null,
        containers: null, volumes: null, systemDf: null,
        server: { health: null, image: null, kernel: { running: null, file: kernelFile, drift: false, driftFields: [] }, warm: null, logs },
        coolify: null, series: null };
    }
    const docker = host.sec('docker'), server = host.sec('server'), tls = host.sec('tls'), backups = host.sec('backups');
    const srv = serverContainer(docker);
    const running = server?.startup?.kernel?.kernel ?? null;
    const drift = kernelDrift(running, kernelFile);
    const w = warmOf(host, t);
    const warm = server ? (w.warm
      ? { state: w.state, time: w.warm.time ?? null, indexes: w.warm.indexes ?? null, delivery: w.warm.delivery ?? null, ms: num(w.warm.ms), workerRunning: w.workerRunning }
      : { state: w.state, time: null, indexes: null, delivery: null, ms: null, workerRunning: w.workerRunning }) : null;
    const coolify = host.sec('coolify');
    return {
      ok: true, now: new Date(t).toISOString(), collector,
      host: host.sec('host'), updates: host.sec('updates'), security: host.sec('security'),
      tls: tls ? { certs: (Array.isArray(tls.certs) ? tls.certs : []).map(x => ({ name: x.name ?? null, notBefore: x.notBefore ?? null, notAfter: x.notAfter ?? null,
        daysLeft: Number.isNaN(Date.parse(x.notAfter)) ? null : Math.round(((Date.parse(x.notAfter) - t) / DAY) * 100) / 100, issuer: x.issuer ?? null })) } : null,
      backups: backups ? { ...backups, newest: backups.newest ? { ...backups.newest,
        ageH: Math.round(((t - Date.parse(backups.newest.mtime)) / 3600000) * 10) / 10 } : null } : null,
      containers: docker ? (Array.isArray(docker.containers) ? docker.containers : []).map(x => ({ ...x,
        sinceS: x.state === 'running' && !Number.isNaN(Date.parse(x.startedAt)) ? Math.max(0, Math.round((t - Date.parse(x.startedAt)) / 1000)) : null })) : null,
      volumes: docker ? (Array.isArray(docker.volumes) ? docker.volumes : []) : null,
      systemDf: docker ? docker.systemDf ?? null : null,
      server: {
        health: server || srv ? { docker: srv?.health ?? null, probe: server?.health?.probe ?? null } : null,
        image: server?.image ?? null,
        kernel: { running, file: kernelFile, drift: drift.length > 0, driftFields: drift.map(d => d[0]) },
        warm, logs,
      },
      coolify: coolify ? (Array.isArray(coolify.containers) ? coolify.containers : []).map(x => ({ name: x.name ?? null, state: x.state ?? null, restartPolicy: x.restartPolicy ?? null })) : null,
      series: { stepS: 900, points: host.seriesPoints() },
    };
  }

  return { usagePayload, vpsPayload };
}
