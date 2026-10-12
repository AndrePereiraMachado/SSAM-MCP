// Display time zone of the console (DESIGN 3): every time is stored and exchanged in UTC; local days ("hoje", per-day
// tables, sparklines) and hours use CONSOLE_TZ (America/Sao_Paulo). Brazil has no DST since 2019, so when the runtime
// has no time zone data the fixed offset UTC-03:00 is used.
const pad = n => String(n).padStart(2, '0');
const DAY_MS = 86400000;

export function createTz(timeZone = 'America/Sao_Paulo') {
  let format = null;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    format.formatToParts(new Date(0));
  } catch { format = null; }

  const toMs = v => typeof v === 'number' ? v : Date.parse(v);
  function parts(v) {
    const ms = toMs(v);
    if (format) {
      const p = {};
      for (const x of format.formatToParts(new Date(ms))) p[x.type] = x.value;
      return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
    }
    const u = new Date(ms - 3 * 3600000);
    return { y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate(), h: u.getUTCHours(), mi: u.getUTCMinutes(), s: u.getUTCSeconds() };
  }
  const offsetAt = ms => { const p = parts(ms); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
  const day = v => { const p = parts(v); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
  // UTC milliseconds of the local midnight that starts the day 'YYYY-MM-DD'.
  function midnight(dayStr) {
    const [y, m, d] = dayStr.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d);
    let t = guess - offsetAt(guess);
    const again = guess - offsetAt(t);
    if (again !== t) t = again;
    return t;
  }
  const addDays = (dayStr, n) => { const [y, m, d] = dayStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  return {
    timeZone, parts, day, midnight, addDays,
    hour: v => parts(v).h,
    // The n local days ending at toDay, oldest first.
    days: (toDay, n) => Array.from({ length: n }, (_, i) => addDays(toDay, i - n + 1)),
    // Whole local calendar days from the day of a to the day of b (b later -> positive).
    dayDiff: (a, b) => Math.round((Date.parse(day(b) + 'T00:00:00Z') - Date.parse(day(a) + 'T00:00:00Z')) / DAY_MS),
    dmy: v => { const p = parts(v); return `${pad(p.d)}/${pad(p.mo)}/${p.y}`; },
    hm: v => { const p = parts(v); return `${pad(p.h)}:${pad(p.mi)}`; },
  };
}

// The UTC day key of an audit file name (audit-YYYYMMDD.jsonl).
export const utcKey = ms => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
// UTC midnight that ends the UTC day key.
export const endOfUtcKey = key => Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8) + 1);
export const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
export const iso = ms => new Date(ms).toISOString();
