// Small pieces the Service Center port shares, each matching the Python it replaces byte for byte where a value is
// persisted or compared: receipts and target locks written by the Python adapter keep answering here.
import crypto from 'node:crypto';

export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

// json.dumps(value, sort_keys=True, ensure_ascii=False) with the default separators: the fingerprint of a plan or of
// a lock target must equal the one Python computed (lock file names live in the shared journal folder).
export function pyJson(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : value > 0 ? 'Infinity' : value < 0 ? '-Infinity' : 'NaN';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(pyJson).join(', ') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ': ' + pyJson(value[k])).join(', ') + '}';
}
export const fingerprint = value => sha256(Buffer.from(pyJson(value), 'utf8'));

// datetime.now(timezone.utc).isoformat(): microseconds, '+00:00', the fraction omitted when it is zero.
export function utc(date = new Date()) {
  const iso = date.toISOString();
  const ms = date.getUTCMilliseconds();
  return iso.slice(0, 19) + (ms ? '.' + String(ms * 1000).padStart(6, '0') : '') + '+00:00';
}

// str(uuid.UUID(value)): braces, urn:uuid: and hyphens tolerated; null when it is not a UUID.
export function canonicalUuid(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/urn:/g, '').replace(/uuid:/g, '').replace(/^[{}]+|[{}]+$/g, '').replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// str.casefold() for the names Service Center shows.
export const fold = value => String(value).toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');

// Python's str.isspace() set, for split()/strip() parity (it differs from \s on \x1c-\x1f, \x85 and ﻿).
export const WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const wsRun = new RegExp(`[${WS}]+`);
const leading = new RegExp(`^[${WS}]+`);
const trailing = new RegExp(`[${WS}]+$`);
export const words = text => String(text).split(wsRun).filter(Boolean);
export const strip = (text, chars) => chars === undefined ? String(text).replace(leading, '').replace(trailing, '')
  : String(text).replace(new RegExp(`^[${escapeClass(chars)}]+|[${escapeClass(chars)}]+$`, 'g'), '');
export const rstrip = text => String(text).replace(trailing, '');
const LINE_BREAK = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');
export const splitlines = text => { const parts = String(text).split(LINE_BREAK); if (parts.at(-1) === '') parts.pop(); return parts; };
const escapeClass = chars => chars.replace(/[\\\]^-]/g, m => '\\' + m);
export const escapeRegExp = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Python == between JSON-like values (dict equality ignores key order).
export function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  const ka = Object.keys(a); const kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}

// `value in (None, '', False)`: 0 equals False in Python.
export const falsyScalar = v => v === null || v === undefined || v === '' || v === false || v === 0;

// A Python ValueError surfaces as the generic local failure, never as its text.
export class LocalFailure extends Error {}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A bounded wait for a real state, inside the tool (the model never polls): about 30 s, pauses of 1 to 5 s. The time is
// the sum of the pauses, so an injected sleep keeps a test instant and the number of reads bounded.
export const WAIT = Object.freeze({ timeoutMs: 30000, pausesMs: [1000, 1000, 2000, 3000, 5000] });
export async function waitFor(check, { timeoutMs = WAIT.timeoutMs, pausesMs = WAIT.pausesMs, sleep: pause = sleep } = {}) {
  let waitedMs = 0;
  for (let attempts = 1; ; attempts++) {
    const value = await check();
    if (value) return { done: true, value, attempts, waitedMs };
    if (waitedMs >= timeoutMs) return { done: false, value, attempts, waitedMs };
    const ms = Math.max(1, Math.min(pausesMs[Math.min(attempts - 1, pausesMs.length - 1)], timeoutMs - waitedMs));
    await pause(ms);
    waitedMs += ms;
  }
}
