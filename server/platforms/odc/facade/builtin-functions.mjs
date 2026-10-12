// The built-in functions of the expressions, for the work packet (ssam_discover packet:true) and the list form of
// ssam_reference {kind:"functions"}. Read from the kernel's checked-in catalog, the newest kernel/catalog/functions-*.json:
// the same file the kernel preflight judges calls with when no Studio is bound (Preflight/Builtins.cs; FunctionCatalogTests
// keeps it equal to the Studio's own registry). O11 only: the ODC lane has no checked-in catalog, and its packet carries
// none. Pure but for the one read of that file (cached by its size and time).
// 2026-10-12 (production test): the session asked for 13 functions in two rounds (one name per query) and wrote NullDateTime()
// and NullTime(), which do not exist, and the delivery was refused for them. The packet now carries the signatures of the
// functions the intent names, and of every date and time function when the intent speaks of dates or times; a name the
// catalog does not have gets its closest names and, for a typed null, the literal that means it.
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();
export function catalogFile(kernel) {
  try {
    const dir = path.join(kernel, 'catalog');
    const files = fs.readdirSync(dir).filter(f => /^functions-[\d.]+\.json$/i.test(f));
    const version = f => f.replace(/^functions-|\.json$/gi, '').split('.').map(Number);
    files.sort((a, b) => { const x = version(a), y = version(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; });
    return files.length ? path.join(dir, files.at(-1)) : null;
  } catch { return null; }
}
// {studio, file, functions: [{Name, Group, Signature, ...}]} or null.
export function loadBuiltins(kernel) {
  const file = catalogFile(kernel);
  if (!file) return null;
  let stamp; try { const s = fs.statSync(file); stamp = s.size + ':' + Math.round(s.mtimeMs); } catch { return null; }
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.value;
  let value = null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (Array.isArray(doc?.Functions)) value = { studio: doc.Studio ?? null, file: 'kernel/catalog/' + path.basename(file), functions: doc.Functions.filter(f => f && typeof f.Name === 'string') };
  } catch { value = null; }
  cache.set(file, { stamp, value });
  return value;
}

// The null of a type the expressions have no NullX() for: the literal (or call) that means it. Names only: the kernel's own
// renames stay in the kernel (FunctionCatalog.Renames); this is what a reader is told.
export const TYPED_NULLS = Object.freeze({
  NullDateTime: 'NullDate() (a Date Time takes it: #1900-01-01 00:00:00#)', NullTime: '#00:00:00# or NewTime(0, 0, 0)', NullText: '""', NullString: '""',
  NullInteger: '0', NullLongInteger: '0', NullDecimal: '0', NullCurrency: '0', NullBoolean: 'False', NullEmail: '""', NullPhoneNumber: '""',
});
const lower = s => String(s).toLowerCase();
function distance(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[n];
}
// The closest catalog names of a name it does not have: by edit distance (at most half the name, at least 2), or holding
// it / held by it; at most `max`, nearest first, then by name.
export function closestBuiltins(name, catalog, max = 4) {
  const wanted = lower(name);
  const limit = Math.max(2, Math.floor(wanted.length / 2));
  return [...new Set(catalog.functions.map(f => f.Name))]
    .map(c => ({ c, d: distance(wanted, lower(c)) }))
    .filter(x => x.d <= limit || lower(x.c).includes(wanted) || (wanted.length >= 4 && wanted.includes(lower(x.c))))
    .sort((a, b) => a.d - b.d || (a.c < b.c ? -1 : a.c > b.c ? 1 : 0)).slice(0, max).map(x => x.c);
}
export const unknownBuiltin = (name, catalog) => ({ name, closest: closestBuiltins(name, catalog), ...(TYPED_NULLS[name] ? { use: TYPED_NULLS[name] } : {}) });

// The words of an intent that name dates or times; with one of them the packet carries every date and time function.
const DATE_WORDS = new Set(['datetime', 'datetimes', 'date', 'dates', 'time', 'times', 'timestamp', 'hora', 'horas', 'horario', 'horarios', 'calendario',
  'calendar', 'prazo', 'prazos', 'timezone', 'fuso']);
const DATE_CONVERSIONS = f => (f.Group === 'Data Conversion' && /Date|Time/.test(f.Name)) || f.Name === 'FormatDateTime';
const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// What the intent says of the built-ins: {named, signatures, group?, unknown?, note, more} or null. A word of the intent is a
// function's name when it is that name without case and was written as a name: with an inner capital (GetUserId), followed
// by "(" (if(...)), or eight letters or more (currdatetime). Short plain words (if, max, index, day) never count alone.
export function intentFunctions(intent, catalog, { lane = 'o11' } = {}) {
  if (!catalog || !intent) return null;
  const text = String(intent);
  const byName = new Map(catalog.functions.map(f => [lower(f.Name), f]));
  const named = []; const unknown = [];
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const word = m[0]; const call = /^\s*\(/.test(text.slice(m.index + word.length));
    const written = call || /[a-z0-9][A-Z]/.test(word) || word.length >= 8;
    const f = byName.get(lower(word));
    if (f && written) { if (!named.includes(f)) named.push(f); continue; }
    // A typed null the catalog does not have (NullDateTime, NullTime): never a name of the module, always a slip.
    if (!f && /^Null[A-Z]/.test(word) && !unknown.some(u => u.name === word)) unknown.push(unknownBuiltin(word, catalog));
  }
  const dates = fold(text).split(/[^a-z0-9]+/).some(w => DATE_WORDS.has(w));
  const group = dates ? catalog.functions.filter(f => f.Group === 'Date and Time' || DATE_CONVERSIONS(f)) : [];
  const all = [...named, ...group.filter(f => !named.includes(f))];
  if (!all.length && !unknown.length) return null;
  return { from: catalog.file, ...(named.length ? { named: named.map(f => f.Name) } : {}), ...(dates ? { group: 'Date and Time (and the date and time conversions)' } : {}),
    signatures: all.map(f => f.Signature), ...(unknown.length ? { unknown } : {}),
    note: 'signatures of the built-ins named by the intent' + (dates ? ' and every date and time built-in' : '') + '; a name followed by ( that is no built-in is refused (NullDateTime: use NullDate(); a Time without value: #00:00:00#)',
    more: { tool: 'ssam_reference', arguments: { lane, kind: 'functions', query: '<Name1 Name2 ...>' }, why: 'several names in one call: each signature, and the closest names of a name that does not exist' } };
}
// The reduced forms the packet falls back to: the names only, then nothing.
export const functionNames = f => (f ? { ...(f.named ? { named: f.named } : {}), ...(f.group ? { group: f.group } : {}), names: f.signatures.map(s => s.replace(/\(.*$/, '')), ...(f.unknown ? { unknown: f.unknown } : {}), more: f.more } : null);
