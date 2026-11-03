// The load of one hosted backend for the owner's console (r41): every minute the RSS of the processes of this container
// (node and the dotnet kernels it starts; /proc of the container's pid namespace, else this process only), how many
// accounts are active now (a tool call running or answered in the last ACTIVE_MS) and, per hour, the distinct accounts that
// called a tool. Kept in <runtime dir>/metrics/backend.json (the server's own folder, /data/server/versions/<backend>):
// minute samples of the last 24 h and hourly rows of the last 7 days. Counts only: no token id, name or argument is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const METRICS_SCHEMA = 'ssam-backend-metrics/1';
export const SAMPLE_MS = 60000;
export const ACTIVE_MS = 5 * 60000;
const DAY = 86400000, HOUR = 3600000;
const PAGE = 4096;

// The resident bytes of every process this container sees (Linux), else of this process.
export function containerRss({ procDir = '/proc', platform = process.platform } = {}) {
  if (platform !== 'linux') return process.memoryUsage().rss;
  let total = 0, any = false;
  let names = [];
  try { names = fs.readdirSync(procDir); } catch { return process.memoryUsage().rss; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try { const pages = Number(fs.readFileSync(path.join(procDir, name, 'statm'), 'utf8').split(' ')[1]); if (Number.isFinite(pages)) { total += pages * PAGE; any = true; } } catch { /* gone */ }
  }
  return any ? total : process.memoryUsage().rss;
}

export const metricsFileOf = runtimeDir => path.join(runtimeDir, 'metrics', 'backend.json');
const hourOf = t => new Date(Math.floor(t / HOUR) * HOUR).toISOString();

export function createBackendMetrics({ runtimeDir, backend = process.env.SSAM_BACKEND_NAME ?? null, now = Date.now, readRss = containerRss,
  sampleMs = SAMPLE_MS, totalMem = os.totalmem } = {}) {
  const file = metricsFileOf(runtimeDir);
  let samples = [], hours = [];
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc?.schema === METRICS_SCHEMA) { samples = Array.isArray(doc.samples) ? doc.samples : []; hours = Array.isArray(doc.hours) ? doc.hours : []; }
  } catch { /* a new file */ }
  const inFlight = new Map(), lastAt = new Map();
  let hourSet = { hour: null, ids: new Set() };
  const touch = token => {
    if (typeof token !== 'string' || !token) return;
    const t = now();
    lastAt.set(token, t);
    const hour = hourOf(t);
    if (hourSet.hour !== hour) hourSet = { hour, ids: new Set() };
    hourSet.ids.add(token);
  };
  // A call never answered (its session closed) stops counting after the router's 65 min deadline.
  const concurrent = () => { const t = now(); let n = 0; for (const [token, at] of lastAt) { if (((inFlight.get(token) ?? 0) > 0 && t - at <= 70 * 60000) || t - at <= ACTIVE_MS) n++; else { lastAt.delete(token); inFlight.delete(token); } } return n; };
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({ schema: METRICS_SCHEMA, backend, pid: process.pid, updatedAt: new Date(now()).toISOString(), hostMemTotalB: totalMem(), samples, hours }));
      fs.renameSync(temp, file);
    } catch { /* the metrics never stop the server */ }
  }
  function sample() {
    const t = now();
    let rss = null;
    try { rss = Number(readRss()); } catch { rss = null; }
    const active = concurrent();
    samples.push({ t: new Date(t).toISOString(), rssB: Number.isFinite(rss) ? rss : null, active });
    samples = samples.filter(s => t - Date.parse(s.t) <= DAY).slice(-1500);
    const hour = hourOf(t);
    let row = hours.find(h => h.hour === hour);
    if (!row) { row = { hour, maxRssB: 0, accounts: 0, peakActive: 0 }; hours.push(row); }
    if (Number.isFinite(rss)) row.maxRssB = Math.max(row.maxRssB ?? 0, rss);
    row.peakActive = Math.max(row.peakActive ?? 0, active);
    if (hourSet.hour === hour) row.accounts = Math.max(row.accounts ?? 0, hourSet.ids.size);
    hours = hours.filter(h => t - Date.parse(h.hour) <= 7 * DAY + HOUR).slice(-200);
    save();
    return { rss, active };
  }
  let timer = null;
  return {
    file,
    callStarted(token) { touch(token); inFlight.set(token, (inFlight.get(token) ?? 0) + 1); },
    callEnded(token) { touch(token); const n = (inFlight.get(token) ?? 1) - 1; if (n > 0) inFlight.set(token, n); else inFlight.delete(token); },
    sample,
    start() { if (!timer) { timer = setInterval(sample, sampleMs); timer.unref?.(); sample(); } },
    stop() { clearInterval(timer); timer = null; },
    get state() { return { samples, hours }; },
  };
}
