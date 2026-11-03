// The load of each hosted backend (r41): the backends write <serverDir>/versions/<backend>/metrics/backend.json every minute
// (platforms/odc/facade/hosted/backend-metrics.mjs): the RSS of their container's processes, accounts active now and per hour.
// This reader keeps, per backend, the numbers the VPS view and the alert rules show: RSS now, peak of the last 24 h and of
// the last 7 days, accounts active in the last hour and the peak per hour, and the peak of accounts active at once.
// Counts only: the file holds no token id or name. Links are not followed; a file over MAX_BYTES is skipped.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000, HOUR = 3600000;
const MAX_BYTES = 2 * 1024 * 1024;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
export const STALE_MS = 5 * 60000;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const max = values => values.reduce((m, v) => (v != null && (m == null || v > m) ? v : m), null);

export function summarizeBackend(doc, t) {
  const samples = (Array.isArray(doc?.samples) ? doc.samples : []).filter(s => s && !Number.isNaN(Date.parse(s.t)));
  const hours = (Array.isArray(doc?.hours) ? doc.hours : []).filter(h => h && !Number.isNaN(Date.parse(h.hour)));
  const last = samples[samples.length - 1] ?? null;
  const day = hours.filter(h => t - Date.parse(h.hour) < DAY);
  const week = hours.filter(h => t - Date.parse(h.hour) < 7 * DAY);
  const lastHour = hours.find(h => Date.parse(h.hour) === Math.floor(t / HOUR) * HOUR) ?? null;
  const updatedAt = typeof doc?.updatedAt === 'string' ? doc.updatedAt : null;
  return {
    name: typeof doc?.backend === 'string' ? doc.backend.slice(0, 80) : null, updatedAt,
    stale: !updatedAt || t - Date.parse(updatedAt) > STALE_MS,
    hostMemTotalB: num(doc?.hostMemTotalB),
    rssNowB: num(last?.rssB),
    rssPeak24hB: max([...day.map(h => num(h.maxRssB)), ...samples.filter(s => t - Date.parse(s.t) < DAY).map(s => num(s.rssB))]),
    rssPeak7dB: max([...week.map(h => num(h.maxRssB)), ...samples.map(s => num(s.rssB))]),
    activeNow: num(last?.active),
    activePeak24h: max(day.map(h => num(h.peakActive))),
    activePeak7d: max(week.map(h => num(h.peakActive))),
    accountsThisHour: num(lastHour?.accounts) ?? 0,
    accountsPeakHour24h: max(day.map(h => num(h.accounts))),
    accountsPeakHour7d: max(week.map(h => num(h.accounts))),
    // the last 24 hours, oldest first: {hour, maxRssB, accounts, peakActive}
    hours: day.map(h => ({ hour: h.hour, maxRssB: num(h.maxRssB), accounts: num(h.accounts), peakActive: num(h.peakActive) })),
  };
}

export function createBackends({ serverDir, now = Date.now, cacheMs = 30000 }) {
  let cache = { at: -Infinity, list: [] };
  function read() {
    const t = now();
    if (t - cache.at < cacheMs) return cache.list;
    const base = path.join(serverDir, 'versions');
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink() && NAME.test(e.name)); } catch { entries = []; }
    const list = [];
    for (const e of entries) {
      const file = path.join(base, e.name, 'metrics', 'backend.json');
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.size > MAX_BYTES) continue;
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (doc?.schema !== 'ssam-backend-metrics/1') continue;
        list.push({ ...summarizeBackend(doc, t), name: e.name });
      } catch { /* no metrics for this backend */ }
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    cache = { at: t, list };
    return list;
  }
  return { list: read };
}
