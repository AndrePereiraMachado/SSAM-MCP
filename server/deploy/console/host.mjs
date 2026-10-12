// host.json, the collector's output (DESIGN 3.6, schema ssam-console-host/1), read on change (stat every 5 s). Keeps the
// facts the alerts need across collections (restart counts, probe failures, unhealthy since, security updates since,
// memory and load samples), appends one line per collection to /state/series/host-YYYY-MM-DD.jsonl (8 files kept),
// feeds each Caddy window to the usage denials once, and emits the host transition events of 4.4.
import fs from 'node:fs';
import { eventText, healthWord } from './texts.mjs';

export const HOST_SCHEMA = 'ssam-console-host/1';
export const SECTIONS = ['host', 'updates', 'security', 'tls', 'backups', 'docker', 'server', 'caddy', 'coolify'];
const STEP_MS = 900000;
const POINTS = 96;
const DAY_MS = 86400000;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const mean = list => { const v = list.filter(x => x != null); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100 : null; };

export function serverContainer(docker) { return docker?.containers?.find(c => c.service === 'ssam-server') ?? null; }
export function memUsedPct(host) {
  const t = num(host?.mem?.totalB), a = num(host?.mem?.availableB);
  return t && a != null ? Math.round((1 - a / t) * 1000) / 10 : null;
}
export function diskUsedPct(host) {
  const list = Array.isArray(host?.disks) ? host.disks.map(d => num(d.usedPct)).filter(v => v != null) : [];
  return list.length ? Math.max(...list) : null;
}

export function createHost({ file, state, tz, now = Date.now, emit = () => {}, usage = null }) {
  let stamp = null;
  let doc = null;
  let status = 'missing';        // missing | invalid | ok
  let schemaSeen = null;
  let wasFresh = null;
  let series = null;             // cached series lines of the last two local days
  let facts = { lastCollectedAt: null, lastCaddyWindowAt: null, deniedSince: null, restarts: {}, counts: {}, probeFails: 0,
    unhealthySince: null, prevHealth: null, healthSeen: false, securitySince: null, rebootSeenAt: null, samples: [] };

  const sec = name => (doc && doc[name] && doc[name].ok === true ? doc[name] : null);

  function poll() {
    let st;
    try { st = fs.statSync(file); } catch { stamp = null; doc = null; status = 'missing'; schemaSeen = null; transitions(); return; }
    const s = `${st.mtimeMs}:${st.size}`;
    if (s !== stamp) {
      stamp = s;
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { parsed = undefined; }
      if (parsed === undefined) { doc = null; status = 'invalid'; schemaSeen = 'JSON inválido'; }
      else if (!parsed || typeof parsed !== 'object' || parsed.schema !== HOST_SCHEMA || Number.isNaN(Date.parse(parsed.collectedAt))) {
        doc = null; status = 'invalid'; schemaSeen = String(parsed?.schema ?? 'sem schema').slice(0, 60);
      } else {
        doc = parsed; status = 'ok'; schemaSeen = HOST_SCHEMA;
        if (parsed.collectedAt !== facts.lastCollectedAt) { facts.lastCollectedAt = parsed.collectedAt; onNew(parsed); }
      }
    }
    transitions();
  }

  function collector() {
    if (status !== 'ok') return { state: status, collectedAt: null, ageS: null, durationMs: null, errors: [], version: null, schema: schemaSeen };
    const ageS = Math.max(0, Math.round((now() - Date.parse(doc.collectedAt)) / 1000));
    const errors = Array.isArray(doc.collector?.errors) ? doc.collector.errors.map(String).slice(0, 20) : [];
    for (const name of SECTIONS) if (doc[name] && doc[name].ok === false) {
      const line = `${name}: ${String(doc[name].error ?? 'erro').slice(0, 40)}`;
      if (!errors.includes(line)) errors.push(line);
    }
    return { state: ageS > 120 ? 'stale' : 'fresh', collectedAt: doc.collectedAt, ageS, durationMs: num(doc.collector?.durationMs), errors,
      version: doc.collector?.version != null ? String(doc.collector.version).slice(0, 20) : null, schema: schemaSeen };
  }
  // Sections with ok:false: [{name, error}].
  const failedSections = () => (doc ? SECTIONS.filter(n => doc[n] && doc[n].ok === false).map(n => ({ name: n, error: String(doc[n].error ?? 'erro').slice(0, 40) })) : []);

  function transitions() {
    const c = collector().state;
    const fresh = c === 'fresh';
    if (wasFresh === true && !fresh) emit({ time: new Date(now()).toISOString(), level: 'warning', group: 'vps', text: eventText.collectorStopped() });
    if (wasFresh === false && fresh) emit({ time: new Date(now()).toISOString(), level: 'info', group: 'vps', text: eventText.collectorBack() });
    if (c !== 'missing' || wasFresh !== null) wasFresh = fresh;
  }

  function onNew(d) {
    const at = d.collectedAt, t = Date.parse(at);
    const host = d.host?.ok ? d.host : null, docker = d.docker?.ok ? d.docker : null, srv = serverContainer(docker);
    // series
    const line = { t: at, cpu: num(host?.cpu?.pct), mem: memUsedPct(host), load1: num(host?.load?.[0]), rx: num(host?.net?.rxBps),
      tx: num(host?.net?.txBps), scpu: num(srv?.cpuPct), smem: num(srv?.memB), disk: diskUsedPct(host) };
    try {
      state.appendLine(`series/host-${tz.day(t)}.jsonl`, JSON.stringify(line));
      const files = state.list('series').filter(n => /^host-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
      for (const old of files.slice(0, Math.max(0, files.length - 8))) state.remove(`series/${old}`);
    } catch { /* the series is a convenience; alerts do not depend on it */ }
    if (series) { series.push(line); series = series.filter(p => Date.parse(p.t) > t - 2 * DAY_MS); }
    // memory and load samples (memoria: 2 samples in a row; carga: every sample of the last 5 min)
    if (host) {
      const total = num(host.mem?.totalB), avail = num(host.mem?.availableB);
      facts.samples.push({ t: at, availPct: total && avail != null ? (avail / total) * 100 : null, availB: avail, swapTotalB: num(host.mem?.swapTotalB),
        load1: num(host.load?.[0]), nproc: num(host.nproc) });
      facts.samples = facts.samples.filter(s => Date.parse(s.t) > t - 20 * 60000).slice(-60);
    }
    // Caddy denials, once per window
    if (d.caddy?.ok && d.caddy.window && at !== facts.lastCaddyWindowAt) {
      facts.lastCaddyWindowAt = at;
      facts.deniedSince ??= typeof d.caddy.window.from === 'string' ? d.caddy.window.from : at;
      usage?.addDenied(d.caddy.window, at);
    }
    // restarts of project containers (a lower count means the container was recreated, not restarted)
    if (docker) for (const c of Array.isArray(docker.containers) ? docker.containers : []) {
      const key = String(c.service || c.name || '?').slice(0, 64);
      const count = num(c.restartCount);
      if (count == null) continue;
      const prev = facts.counts[key];
      if (prev != null && count > prev) {
        (facts.restarts[key] ??= []).push({ t: at, n: count - prev });
        emit({ time: at, level: 'warning', group: 'vps', text: eventText.restarted(key) });
      }
      facts.counts[key] = count;
    }
    for (const key of Object.keys(facts.restarts)) {
      facts.restarts[key] = facts.restarts[key].filter(r => Date.parse(r.t) > t - DAY_MS);
      if (!facts.restarts[key].length) delete facts.restarts[key];
    }
    // ssam-server health transitions and since when it is unhealthy
    if (docker) {
      const health = srv ? srv.health ?? null : 'ausente';
      if (facts.healthSeen && health !== facts.prevHealth) {
        emit({ time: at, level: health === 'unhealthy' ? 'warning' : 'info', group: 'vps', text: eventText.health(healthWord(facts.prevHealth), healthWord(health)) });
      }
      facts.healthSeen = true;
      facts.prevHealth = health;
      facts.unhealthySince = health === 'unhealthy' ? facts.unhealthySince ?? at : null;
    }
    // /health probe failing several runs in a row
    const probe = d.server?.ok ? d.server.health?.probe : null;
    if (probe) facts.probeFails = probe.available && probe.ok === false ? facts.probeFails + 1 : probe.ok ? 0 : facts.probeFails;
    // security updates pending since; reboot required since (when the collector gives no rebootSince)
    if (d.updates?.ok) {
      facts.securitySince = num(d.updates.security) > 0 ? facts.securitySince ?? at : null;
      facts.rebootSeenAt = d.updates.rebootRequired ? facts.rebootSeenAt ?? at : null;
    }
  }

  function loadSeries() {
    if (series) return series;
    series = [];
    const today = tz.day(now());
    for (const day of [tz.addDays(today, -1), today]) {
      const text = state.readText(`series/host-${day}.jsonl`);
      if (!text) continue;
      for (const raw of text.split('\n')) { try { const p = JSON.parse(raw); if (p && typeof p.t === 'string') series.push(p); } catch { /* partial */ } }
    }
    return series;
  }
  // The last 24 h in 96 points of 15 min (mean for cpu/mem/load/rates/server cpu and memory).
  function seriesPoints() {
    const end = Math.ceil(now() / STEP_MS) * STEP_MS;
    const start = end - POINTS * STEP_MS;
    const buckets = Array.from({ length: POINTS }, () => []);
    for (const p of loadSeries()) {
      const i = Math.floor((Date.parse(p.t) - start) / STEP_MS);
      if (i >= 0 && i < POINTS) buckets[i].push(p);
    }
    return buckets.map((list, i) => ({ t: new Date(start + i * STEP_MS).toISOString(), cpuPct: mean(list.map(p => p.cpu)),
      memUsedPct: mean(list.map(p => p.mem)), load1: mean(list.map(p => p.load1)), rxBps: mean(list.map(p => p.rx)),
      txBps: mean(list.map(p => p.tx)), srvCpuPct: mean(list.map(p => p.scpu)), srvMemB: mean(list.map(p => p.smem)) }));
  }
  const restarts24h = key => { const floor = now() - DAY_MS; return (facts.restarts[key] ?? []).filter(r => Date.parse(r.t) > floor).reduce((s, r) => s + r.n, 0); };

  return {
    poll, collector, failedSections, sec, seriesPoints, restarts24h,
    get doc() { return doc; },
    get facts() { return facts; },
    toJSON: () => facts,
    restore(saved) { if (saved && typeof saved === 'object') facts = { ...facts, ...saved }; },
  };
}
