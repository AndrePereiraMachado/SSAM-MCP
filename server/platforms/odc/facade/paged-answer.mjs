// What a paged answer (ssam.mjs pageAnswer: an answer above the ceiling, kept in .local/answers) carries inline, so the
// model reads the parts it needs without paging through ssam_evidence (the owner's re-test of 2026-10-12: the 85 KB
// producer listing came back as its top-level scalars and a file; five ssam_evidence calls followed (max 0, fields,
// offset, a where on a field the rows did not have, the right where) before the model saw the names it needed).
//   - the top-level scalars and the small parts, as before (texts cut at 500 characters);
//   - every large array (the rows: 10 or more, 2 KB or more, under an object, at most 4 levels down) leaves its place and
//     comes back as a table, {at, columns, rows}: every column when it fits the room, else without the opaque columns
//     (keys, hashes, GUIDs: values no model reads by eye), which one call returns;
//   - the object around such an array stays inline without it when it is small;
//   - `outline`: every part that is not inline whole, with its pointer, its size and the fields of its rows;
//   - `continuation`: ONE ssam_evidence call that returns what is still missing (the omitted columns of a table, or the
//     largest part left out), as a table of all its rows within the reader's budget (the shared expansion budget); none when nothing is missing.
// Pure: the caller writes the file and measures the room.

const bytes = value => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const pointer = keys => keys.map(k => '/' + String(k).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
import { EXPANSION_DEFAULT_BYTES } from './context-budget.mjs';
export const READER_BUDGET = EXPANSION_DEFAULT_BYTES;
const MAX_ROWS = 1000;
const PART_BYTES = 512;
const SKELETON_BYTES = 2048;

// The large arrays of a document, outermost only: [{keys, rows (the array), bytes}], largest first.
export function largeArrays(doc, { minRows = 10, minBytes = 2048, maxDepth = 4 } = {}) {
  const out = [];
  const walk = (value, keys, depth) => {
    if (depth > maxDepth || !isObject(value)) return;
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v)) { const n = bytes(v); if (v.length >= minRows && n >= minBytes) { out.push({ keys: [...keys, k], rows: v, bytes: n }); continue; } }
      if (isObject(v)) walk(v, [...keys, k], depth + 1);
    }
  };
  walk(doc, [], 1);
  return out.sort((a, b) => b.bytes - a.bytes);
}

// A cell of a table: a scalar as it is (a long text cut), anything else as its JSON, cut.
const cell = v => (v === null || ['number', 'boolean'].includes(typeof v) ? v : typeof v === 'string' ? (v.length > 400 ? v.slice(0, 400) + '…' : v)
  : (s => (s.length > 160 ? s.slice(0, 160) + '…' : s))(JSON.stringify(v) ?? 'null'));
// The columns of rows of objects: the keys of the first 50, in their order (at most 40); null when the rows are not objects.
export function columnsOf(rows) {
  const sample = rows.slice(0, 50);
  if (!sample.length || sample.filter(isObject).length < sample.length * 0.8) return null;
  return [...new Set(sample.filter(isObject).flatMap(r => Object.keys(r)))].slice(0, 40);
}
// An opaque column: its texts are keys, hashes or GUIDs (base64 or hex of 20+ characters, a GUID), 90% of the filled ones.
const OPAQUE = /^(?:[A-Za-z0-9+/_=-]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function opaqueColumns(rows, columns) {
  return columns.filter(c => {
    const values = rows.slice(0, 200).map(r => r?.[c]).filter(v => v !== null && v !== undefined && v !== '');
    return values.length > 0 && values.filter(v => typeof v === 'string' && OPAQUE.test(v) && !/\s/.test(v)).length >= values.length * 0.9;
  });
}
export function table(rows, columns, keys) {
  return { at: pointer(keys), columns, rows: rows.map(r => columns.map(c => cell(r?.[c]))) };
}

/**
 * The inline shape of a paged answer.
 * full: the whole answer; roomBytes: what the inline part may take (the ceiling less the paging fields).
 * Returns {top, tables, outline, missing}: missing = [{at, columns?, rows?}] (what one more call returns).
 */
export function pagedShape(full, { roomBytes, inlineBytes = 6144 } = {}) {
  if (!isObject(full)) return { top: {}, tables: [], outline: [], missing: [{ at: '' }] };
  const arrays = largeArrays(full);
  // The answer without its large arrays.
  const skeleton = structuredClone(full);
  for (const a of arrays) { let parent = skeleton; for (const k of a.keys.slice(0, -1)) parent = parent?.[k]; if (isObject(parent)) delete parent[a.keys.at(-1)]; }
  const top = {}; const outline = []; const missing = [];
  let used = 0;
  for (const [k, v] of Object.entries(skeleton)) {
    if (k === 'paged') continue;
    const kept = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
    const size = bytes(kept) + k.length + 4;
    const held = arrays.some(a => a.keys[0] === k);
    // A small part as before; the object around a large array without it, when small.
    const small = kept === null || ['string', 'number', 'boolean'].includes(typeof kept) || size <= PART_BYTES || (held && isObject(kept) && size <= SKELETON_BYTES);
    if (!small || used + size > inlineBytes) { outline.push({ at: pointer([k]), bytes: bytes(full[k]), ...(Array.isArray(full[k]) ? { items: full[k].length } : isObject(full[k]) ? { keys: Object.keys(full[k]).slice(0, 20) } : {}) }); continue; }
    top[k === 'continuation' ? 'answerContinuation' : k] = kept; used += size;
    if (kept !== v) missing.push({ at: pointer([k]) });
  }
  // The large arrays as tables, largest first, within the room the rest leaves.
  const tables = [];
  let room = roomBytes - used - bytes(outline) - 256;
  for (const a of arrays) {
    const columns = columnsOf(a.rows);
    const entry = { at: pointer(a.keys), rows: a.rows.length, bytes: a.bytes, ...(columns ? { fields: columns } : {}) };
    if (!columns) { outline.push({ ...entry, inline: false }); missing.push({ at: entry.at, rows: a.rows.length }); continue; }
    const whole = table(a.rows, columns, a.keys);
    const opaque = opaqueColumns(a.rows, columns);
    const lean = opaque.length && opaque.length < columns.length ? { ...table(a.rows, columns.filter(c => !opaque.includes(c)), a.keys), omitted: opaque } : null;
    const fits = [whole, lean].filter(Boolean).find(t => bytes(t) + 64 <= room);
    if (fits) {
      tables.push(fits); room -= bytes(fits) + 1;
      outline.push({ ...entry, inline: fits.omitted ? 'table without ' + fits.omitted.join(', ') : 'table' });
      if (fits.omitted) missing.push({ at: entry.at, columns: [columns.find(c => !opaque.includes(c)), ...fits.omitted].filter(Boolean), rows: a.rows.length });
    } else { outline.push({ ...entry, inline: false }); missing.push({ at: entry.at, columns, rows: a.rows.length }); }
  }
  // The room the tables leave takes the top-level parts left out, whole (without their large arrays), smallest first.
  const parts = outline.filter(o => !arrays.some(a => pointer(a.keys) === o.at) && /^\/[^/]+$/.test(o.at))
    .map(o => ({ o, key: Object.keys(skeleton).find(k => pointer([k]) === o.at) })).filter(p => p.key !== undefined)
    .map(p => ({ ...p, size: bytes(skeleton[p.key]) + p.key.length + 4 })).sort((a, b) => a.size - b.size);
  for (const p of parts) {
    if (p.size > room) continue;
    top[p.key === 'continuation' ? 'answerContinuation' : p.key] = skeleton[p.key]; room -= p.size;
    outline.splice(outline.indexOf(p.o), 1);
  }
  // A top-level part still left out (not one of the large arrays) is missing too.
  for (const o of outline) if (!arrays.some(a => pointer(a.keys) === o.at) && !missing.some(m => m.at === o.at)) missing.push({ at: o.at });
  return { top, tables, outline, missing };
}

// The one call that returns what is missing: the largest missing table as a table of all its rows (the omitted columns
// with the first readable one), else the part left out.
export function missingCall(file, missing) {
  if (!missing.length) return null;
  const first = missing.find(m => m.rows) ?? missing[0];
  const args = first.rows ? { file, pointer: first.at, table: true, ...(first.columns ? { fields: first.columns } : {}), max: Math.min(first.rows, MAX_ROWS), budgetBytes: READER_BUDGET }
    : { file, pointer: first.at, budgetBytes: READER_BUDGET };
  return { tool: 'ssam_evidence', arguments: args,
    why: first.rows ? `the ${first.rows} rows of ${first.at}${first.columns ? ' (' + first.columns.join(', ') + ')' : ''} in one table, within the reader's budget` : first.at ? `the part ${first.at}, whole` : 'the whole answer',
    ...(missing.length > 1 ? { more: missing.filter(m => m !== first).map(m => ({ tool: 'ssam_evidence', arguments: m.rows ? { file, pointer: m.at, table: true, ...(m.columns ? { fields: m.columns } : {}), max: Math.min(m.rows, MAX_ROWS), budgetBytes: READER_BUDGET } : { file, pointer: m.at, budgetBytes: READER_BUDGET } })) } : {}) };
}
