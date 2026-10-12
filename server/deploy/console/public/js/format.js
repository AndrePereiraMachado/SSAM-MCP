// pt-BR formatters of the owner console (DESIGN.md 6.6). Pure functions: no DOM, no clock of their own (every
// relative format takes `now` in ms), so the unit tests in ui-tests/ pin every boundary.
// Display time zone: America/Sao_Paulo. Brazil has no DST since 2019, so UTC-03:00 is the fallback when the
// runtime has no time zone database.

export const TZ = 'America/Sao_Paulo';
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const DASH = '—';

const nfInt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nfMax1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function makeDtf(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return null;
  }
}

let dtfLocal = makeDtf(TZ);
const dtfUtc = makeDtf('UTC');

/** Tests only: force the UTC-03:00 fallback (false) or restore the time zone database (true). */
export function _useTimeZoneDatabase(on) {
  dtfLocal = on ? makeDtf(TZ) : null;
}

/** ms since epoch from a number, an ISO string or a Date; NaN when missing or invalid. */
export function toMs(t) {
  if (t == null || t === '') return NaN;
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  const ms = Date.parse(String(t));
  return Number.isFinite(ms) ? ms : NaN;
}

function valid(ms) {
  return Number.isFinite(ms);
}

function partsWith(dtf, ms, fallbackOffsetMs) {
  if (dtf) {
    const p = {};
    for (const x of dtf.formatToParts(new Date(ms))) p[x.type] = x.value;
    return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second };
  }
  const d = new Date(ms + fallbackOffsetMs);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
  };
}

/** Calendar parts in America/Sao_Paulo. */
export function localParts(t) {
  return partsWith(dtfLocal, toMs(t), -3 * HOUR);
}

function utcParts(t) {
  return partsWith(dtfUtc, toMs(t), 0);
}

const p2 = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** `YYYY-MM-DD` of the local (America/Sao_Paulo) day. */
export function localDay(t) {
  const ms = toMs(t);
  if (!valid(ms)) return '';
  const p = localParts(ms);
  return `${p.y}-${p2(p.mo)}-${p2(p.d)}`;
}

export function sameLocalDay(a, b) {
  const x = localDay(a);
  return x !== '' && x === localDay(b);
}

/** 12/10/2026 */
export function fmtDate(t) {
  const ms = toMs(t);
  if (!valid(ms)) return DASH;
  const p = localParts(ms);
  return `${p2(p.d)}/${p2(p.mo)}/${p.y}`;
}

/** 23:51 */
export function fmtTime(t) {
  const ms = toMs(t);
  if (!valid(ms)) return DASH;
  const p = localParts(ms);
  return `${p2(p.h)}:${p2(p.mi)}`;
}

/** 23:51:08 */
export function fmtTimeSec(t) {
  const ms = toMs(t);
  if (!valid(ms)) return DASH;
  const p = localParts(ms);
  return `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`;
}

/** 12/10/2026 23:51 */
export function fmtDateTime(t) {
  const ms = toMs(t);
  if (!valid(ms)) return DASH;
  return `${fmtDate(ms)} ${fmtTime(ms)}`;
}

/** 12/10/2026 23:51:08 */
export function fmtDateTimeSec(t) {
  const ms = toMs(t);
  if (!valid(ms)) return DASH;
  return `${fmtDate(ms)} ${fmtTimeSec(ms)}`;
}

/** 11/10 22:49 (events older than today) */
export function fmtDayMonthTime(t) {
  const ms = toMs(t);
  if (!valid(ms)) return DASH;
  const p = localParts(ms);
  return `${p2(p.d)}/${p2(p.mo)} ${p2(p.h)}:${p2(p.mi)}`;
}

/** Title of every time cell: `12/10/2026 23:51:08 (02:51:08 UTC)`. */
export function fmtTitle(t) {
  const ms = toMs(t);
  if (!valid(ms)) return '';
  const u = utcParts(ms);
  return `${fmtDateTimeSec(ms)} (${p2(u.h)}:${p2(u.mi)}:${p2(u.s)} UTC)`;
}

/** UTC date-time `13/10/2026 02:51 UTC` (license detail). */
export function fmtUtcDateTime(t) {
  const ms = toMs(t);
  if (!valid(ms)) return DASH;
  const u = utcParts(ms);
  return `${p2(u.d)}/${p2(u.mo)}/${u.y} ${p2(u.h)}:${p2(u.mi)} UTC`;
}

/** Day rows: `seg 12/10` from a `YYYY-MM-DD` calendar day (no time zone shift) or a time. */
export function fmtDayShort(day) {
  let y; let mo; let d;
  const m = typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else {
    const ms = toMs(day);
    if (!valid(ms)) return DASH;
    const p = localParts(ms);
    y = p.y; mo = p.mo; d = p.d;
  }
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${p2(d)}/${p2(mo)}`;
}

/** `YYYY-MM-DD` -> `12/10/2026`. */
export function fmtCalendarDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : DASH;
}

export function fmtInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return DASH;
  return nfInt.format(Number(n));
}

/** One decimal, pt-BR: 1,2 */
export function fmtNum1(n) {
  if (n == null || !Number.isFinite(Number(n))) return DASH;
  return nf1.format(Number(n));
}

/** At most one decimal: 1,2 / 0 / 0,5 */
export function fmtNumMax1(n) {
  if (n == null || !Number.isFinite(Number(n))) return DASH;
  return nfMax1.format(Number(n));
}

/** Two decimals (load average): 0,09 */
export function fmtNum2(n) {
  if (n == null || !Number.isFinite(Number(n))) return DASH;
  return nf2.format(Number(n));
}

/** Percent: integer (6%), one decimal below 1 (0,5%), dash when null. */
export function fmtPct(p) {
  if (p == null || !Number.isFinite(Number(p))) return DASH;
  const v = Number(p);
  if (v > 0 && v < 1) {
    const r = Math.round(v * 10) / 10;
    if (r >= 1) return '1%';
    return r > 0 ? `${nf1.format(r)}%` : '0%';
  }
  return `${nfInt.format(Math.round(v))}%`;
}

/** Percent with at most one decimal (VPS CPU: 1,2% · iowait 0% · steal 0,5%). */
export function fmtPctFine(p) {
  if (p == null || !Number.isFinite(Number(p))) return DASH;
  return `${nfMax1.format(Number(p))}%`;
}

/** Share of failures (`7%`), dash when there were no calls. */
export function fmtShare(part, total) {
  if (!total) return DASH;
  return fmtPct((Number(part) / Number(total)) * 100);
}

/**
 * Duration in ms: 850 ms · 1,2 s · 3 min 05 s · 1 h 02 min · 4 d 11 h. Every unit truncates (never rounds up), so a
 * value just under a boundary stays in the smaller unit (59 999 ms = 59,9 s; 60 000 ms = 1 min 00 s).
 */
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return DASH;
  const v = Math.max(0, Number(ms));
  if (v < SEC) return `${nfInt.format(Math.floor(v))} ms`;
  if (v < MIN) return `${nf1.format(Math.floor(v / 100) / 10)} s`;
  if (v < HOUR) {
    const total = Math.floor(v / SEC);
    return `${Math.floor(total / 60)} min ${p2(total % 60)} s`;
  }
  if (v < DAY) {
    const total = Math.floor(v / MIN);
    return `${Math.floor(total / 60)} h ${p2(total % 60)} min`;
  }
  const hours = Math.floor(v / HOUR);
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** Relative time against `now` (ms): agora · há 12 s · há 3 min · há 2 h · há 3 dias · em 5 dias. */
export function fmtRelative(t, now) {
  const ms = toMs(t);
  if (!valid(ms) || !valid(now)) return DASH;
  const diff = now - ms;
  const abs = Math.abs(diff);
  if (abs < 5 * SEC) return 'agora';
  let txt;
  if (abs < MIN) txt = `${Math.floor(abs / SEC)} s`;
  else if (abs < HOUR) txt = `${Math.floor(abs / MIN)} min`;
  else if (abs < DAY) txt = `${Math.floor(abs / HOUR)} h`;
  else {
    const d = Math.floor(abs / DAY);
    txt = `${d} ${d === 1 ? 'dia' : 'dias'}`;
  }
  return diff >= 0 ? `há ${txt}` : `em ${txt}`;
}

/**
 * Bytes, base 1024 (IEC): 0 B · 512 B · 1,1 KiB · 376 MiB · 6 GiB. A value reaching 1000 of a unit moves to the next
 * one (1014 MiB -> 1,0 GiB), so a cell never shows four digits.
 */
export function fmtBytes(b) {
  if (b == null || !Number.isFinite(Number(b))) return DASH;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const last = units.length - 1;
  let v = Math.max(0, Number(b));
  let k = 0;
  while (v >= 1000 && k < last) {
    v /= 1024;
    k += 1;
  }
  if (k === 0) return `${nfInt.format(Math.round(v))} B`;
  if (v < 10 && !Number.isInteger(v)) {
    const r = Math.round(v * 10) / 10;
    if (r >= 10) return `10 ${units[k]}`;
    return `${nf1.format(r)} ${units[k]}`;
  }
  const r = Math.round(v);
  if (r >= 1000 && k < last) return `${nf1.format(r / 1024)} ${units[k + 1]}`;
  return `${nfInt.format(r)} ${units[k]}`;
}

/** Rate: 12 KiB/s */
export function fmtRate(bps) {
  if (bps == null || !Number.isFinite(Number(bps))) return DASH;
  return `${fmtBytes(bps)}/s`;
}

export function plural(n, one, many) {
  return `${fmtInt(n)} ${Number(n) === 1 ? one : many}`;
}

/** Days left of a license: 29 dias · 1 dia · vence hoje às 18:00 · venceu há 3 dias · sem validade. */
export function fmtDaysLeft(expiresAt, now) {
  if (expiresAt == null) return 'sem validade';
  const ms = toMs(expiresAt);
  if (!valid(ms)) return DASH;
  const diff = ms - now;
  if (diff <= 0) {
    const d = Math.floor(-diff / DAY);
    if (d >= 1) return `venceu há ${plural(d, 'dia', 'dias')}`;
    const h = Math.floor(-diff / HOUR);
    return h >= 1 ? `venceu há ${h} h` : 'venceu agora';
  }
  if (sameLocalDay(ms, now)) return `vence hoje às ${fmtTime(ms)}`;
  // Local calendar days, as the API's licenca-vence alert counts them: "até 14/10/2026 (2 dias)" on 12/10 whatever the hour.
  return plural(Math.max(1, localDayDiff(now, ms)), 'dia', 'dias');
}

/** Whole local (America/Sao_Paulo) calendar days from `a` to `b` (negative when `b` is earlier). */
export function localDayDiff(a, b) {
  const x = localDay(a);
  const y = localDay(b);
  if (!x || !y) return NaN;
  return Math.round((Date.parse(`${y}T00:00:00Z`) - Date.parse(`${x}T00:00:00Z`)) / DAY);
}

/** Next expiry in the Resumo: `em 2 dias` / `hoje às 18:00`. */
export function fmtExpiresIn(expiresAt, now) {
  const ms = toMs(expiresAt);
  if (!valid(ms)) return DASH;
  if (ms <= now) return `venceu em ${fmtDate(ms)}`;
  if (sameLocalDay(ms, now)) return `hoje às ${fmtTime(ms)}`;
  return `em ${fmtDaysLeft(ms, now)}`;
}

/** Licenses table `Validade` cell text and its severity ('', 'warn', 'bad'). */
export function fmtValidity(lic, now) {
  if (!lic) return { text: DASH, level: '' };
  if (lic.state === 'revoked') return { text: `revogada em ${fmtDate(lic.revokedAt)}`, level: '' };
  if (lic.expiresAt == null) return { text: 'sem validade', level: '' };
  const ms = toMs(lic.expiresAt);
  if (lic.state === 'expired' || ms <= now) return { text: `venceu em ${fmtDate(ms)}`, level: 'warn' };
  const days = (ms - now) / DAY;
  const level = days <= 2 ? 'bad' : days <= 7 ? 'warn' : '';
  if (sameLocalDay(ms, now)) return { text: `vence hoje às ${fmtTime(ms)}`, level };
  return { text: `até ${fmtDate(ms)} (${fmtDaysLeft(ms, now)})`, level };
}

const LANE_ORDER = ['odc', 'o11'];

/** Lanes: `ODC, O11` (order odc, o11). */
export function fmtLanes(lanes, sep = ', ') {
  const list = Array.isArray(lanes) ? lanes : [];
  const known = LANE_ORDER.filter((l) => list.includes(l));
  const other = list.filter((l) => !LANE_ORDER.includes(l)).map(String);
  const all = [...known, ...other].map((l) => l.toUpperCase());
  return all.length ? all.join(sep) : DASH;
}

/** `ODC e O11` (history detail). */
export function fmtLanesAnd(lanes) {
  const parts = fmtLanes(lanes, '|').split('|');
  if (parts.length <= 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

/** `tok_0000…` */
export function shortToken(token) {
  const s = String(token ?? '');
  return s.length > 8 ? `${s.slice(0, 8)}…` : s;
}

/** Customer + token in selects: `Cliente Alfa (tok_0000…)`. */
export function fmtCustomerToken(customer, token) {
  return `${customer ?? DASH} (${shortToken(token)})`;
}

/** ASCII slug for file names: lowercase, spaces to `-`. */
export function slug(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'cliente';
}

/** `PC-NOME (usuario)` */
export function fmtMachine(m) {
  if (!m || !m.name) return DASH;
  return m.user ? `${m.name} (${m.user})` : String(m.name);
}

/**
 * Two values of one cell (p50 / p90 of the Qualidade tables): `1,2 s / 4,0 s` with the given formatter; a dash when both
 * are null or both are 0 (DESIGN-QUALIDADE 4.5).
 */
export function fmtPair(a, b, fmt = fmtInt) {
  const none = (v) => v == null || !Number.isFinite(Number(v));
  if ((none(a) && none(b)) || (Number(a) === 0 && Number(b) === 0)) return DASH;
  return `${fmt(a)} / ${fmt(b)}`;
}
