// ssam_evidence: reads the JSON/JSONL evidence SSAM wrote (inspect `out` files, deliver result.json, receipts, lab
// receipts/checks/manifests, snapshot sidecars, journals) so the model never writes a python -c / node -e /
// ConvertFrom-Json script to look inside them. Measured in the transcripts (tests/bench/baseline/
// scripts-improvisados.mjs): 52% of the shell commands were such scripts; the top patterns are inspect trees walked
// for nodes by kind/name, fields of a delivery result, journal tails filtered by field, counts and group counts.
//
// Read only. Only .json/.jsonl files whose real path (junctions and symlinks resolved) is under an allowed root: every
// folder an SSAM answer names (evidence-roots.mjs: the .local folders of the O11 and ODC lanes, the ODC journal/, lab/ and
// snapshots/, the workspace's debugger, preview, friction and module-index folders, the module reservations).
// Secrets never leave: values under keys such as password/token/secret/authorization/
// cookie (and the user's authorize words) are replaced before any filter runs, so a where clause cannot probe them. A
// kernel durable envelope {format: 1, sha256, payload} (task.json, receipts, journals of the kernel) is opened first.
// Answers are short (2 KB by default): lists page with offset/next, big values shrink by depth and string length,
// a long string pages by characters. Parsed files are cached by (real path, mtime, size).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { anvilRoot, odcRoot, workspaceRoot } from './workspace.mjs';
import { usesWorkspace, workspacePath } from './executor.mjs';
import { ssamPathRoots } from './evidence-roots.mjs';

export const DEFAULT_BUDGET = 2000;
const MIN_BUDGET = 400, MAX_BUDGET = 65536, DEFAULT_MAX = 50, MAX_ITEMS = 1000, PAGE_TARGET = 10;
export const MAX_FILE_BYTES = 96 * 1024 * 1024;
const CACHE_BYTES = 160 * 1024 * 1024;
const REDACTED = '[redacted]';

// The allowed roots of this installation: every folder an SSAM answer can name, from the one registry
// (evidence-roots.mjs, A21 of the 2026-10-06 package): the lane .local folders, the ODC journal/lab/snapshots, and of the
// workspace .local only debugger, preview, friction and module-index; plus <authority>/reservations. deps.roots replaces
// them (tests, a bench copy). Hosted (executor.mjs), the default roots are the visible area of the customer's workspace:
// odc/, o11/ and inbox/ (paged answers in <ws>/o11/answers included), never this machine's folders (the debugger and the
// preview are unavailable there).
export function evidenceRoots({ anvil = anvilRoot, odc = odcRoot, workspace = workspaceRoot, env = process.env } = {}) {
  if (usesWorkspace(anvil, anvilRoot) || usesWorkspace(odc, odcRoot)) return [workspacePath('odc'), workspacePath('o11'), workspacePath('inbox')];
  return ssamPathRoots({ anvil, odc, workspace, env });
}

// ---- secrets
const SECRET_KEY = /password|passwd|passphrase|^pwd$|^pass$|token|secret|authori[sz]ation|^authorize$|^words$|cookie|api[-_]?key|private[-_]?key|credential|^bearer$|session[-_]?(?:id|key)$/i;
const SECRET_TEXT = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}|\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/;
const SECRET_FILE = /credential|secret|password|token|cookie|vault|\.key\./i;
// Replaces secret values in place (the parsed document is ours) and counts them. A text, object or array under a
// secret key goes; numbers, booleans and null stay (a token count or `authorized: true` is not a secret).
export function redact(root) {
  let count = 0;
  const visit = value => {
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = visit(value[i]); return value; }
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        const v = value[key];
        if (SECRET_KEY.test(key) && ((typeof v === 'string' && v !== '') || (v !== null && typeof v === 'object'))) { value[key] = REDACTED; count++; }
        else value[key] = visit(v);
      }
      return value;
    }
    if (typeof value === 'string' && SECRET_TEXT.test(value)) { count++; return REDACTED; }
    return value;
  };
  return { value: visit(root), count };
}

// ---- the kernel's durable envelope (DurableJson.Write: task.json, access receipts and ledger, merge journal, app
// sessions, module reservations): {format: 1, sha256, payload: "<the JSON as text>"}. Opened before redaction, so
// pointers, filters and redaction reach the payload. envelope: 'verified' when sha256 is the hash of the payload text (as
// DurableJson.Hash), 'sha256-differs' otherwise; a payload that is not JSON is never shown (it may hold anything).
const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
export function openEnvelope(doc) {
  if (!isObject(doc) || doc.format !== 1 || typeof doc.payload !== 'string' || Object.keys(doc).some(k => k !== 'format' && k !== 'sha256' && k !== 'payload'))
    return { doc, envelope: null };
  const envelope = typeof doc.sha256 === 'string' && doc.sha256.toLowerCase() === sha256Hex(doc.payload) ? 'verified' : 'sha256-differs';
  try { return { doc: JSON.parse(doc.payload), envelope }; }
  catch { return { doc: { ...doc, payload: REDACTED }, envelope: 'payload-not-json', hidden: 1 }; }
}

// ---- paths inside a document: a JSON Pointer (/a/0/b, RFC 6901) or a dotted path (a.b[0].c, a.0.c); '' or '/' = root.
export function parsePath(spec) {
  const s = String(spec ?? '').trim();
  if (s === '' || s === '/') return [];
  if (s.startsWith('/')) return s.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  return s.replace(/\[(\d+)\]/g, '.$1').split('.').filter(k => k !== '');
}
export const toPointer = keys => keys.map(k => '/' + String(k).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// A key read from the file or the arguments ("__proto__" included) becomes an own property, never a prototype.
const put = (target, key, value) => { Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true }); return target; };
function step(value, key) {
  if (Array.isArray(value)) { const i = /^-?\d+$/.test(String(key)) ? Number(key) : NaN; const j = i < 0 ? value.length + i : i; return Number.isInteger(j) && j >= 0 && j < value.length ? { found: true, value: value[j], key: j } : { found: false }; }
  if (isObject(value) && Object.prototype.hasOwnProperty.call(value, key)) return { found: true, value: value[key], key };
  return { found: false };
}
// {found, value, keys (normalized), parentKeys (deepest that exists)}
function resolve(root, keys) {
  let value = root; const done = [];
  for (const key of keys) {
    const next = step(value, key);
    if (!next.found) return { found: false, parentKeys: done, parent: value };
    value = next.value; done.push(next.key);
  }
  return { found: true, value, keys: done };
}

// ---- where clauses: [field] op value; op = != >= <= = > < !~ ~ (~ contains, case-insensitive; = case-insensitive for
// text, numeric for numbers). No field: the item itself (= / !=) or any key/text inside it (~ / !~). An array field
// matches when any element does. A bare field ("error", "result.ok", "/merge/hasConflicts") keeps the items where it
// exists and is not false, null, "", [] or {}; "!field" keeps the others. A bare dotted path has no spaces (a key with
// spaces goes as a JSON Pointer), so "kind Container" stays a refusal instead of an empty answer.
//
// C29 (atritos 3): quotes around the whole clause or around the field name are taken off ("key", "path ~ Header2"); in
// = ~ !~ the value may list alternatives with | ("kind ~ Container|Button"; \| is the character), kept in `any`; '=='
// is '='. A clause that is still malformed (another operator, an unbalanced quote) parses to {invalid}, refused as
// EVIDENCE_FILTER_INVALID with the grammar and an example built from the fields of the rows (so is a compared field that
// no row has); a valid filter that keeps 0 of N rows answers `empty` with the fields and kinds present.
const OPS = ['!~', '!=', '>=', '<=', '~', '=', '>', '<'];
const BARE = /^(!?)\s*(\/\S.*|[^\s=<>~!]+)$/;
const QUOTED = /^(["'])(.*)\1$/s;
// Only a pair that encloses the whole text ("kind" = "X" keeps its inner quotes for the field and the value).
const unquote = text => { const t = String(text).trim(); const q = t.length >= 2 ? QUOTED.exec(t) : null; return q && !q[2].includes(q[1]) ? q[2].trim() : t; };
const loneQuote = text => /^["']/.test(text) !== /["']$/.test(text) || (text.length === 1 && /["']/.test(text));
const ALTERNATING = new Set(['=', '~', '!~']);
export const FILTER_GRAMMAR = 'field op value, op one of = != ~ (contains) !~ > >= < <=; in = ~ !~ the value may list alternatives with | (\\| is the character); '
  + 'no field: the item itself or any text in it; a bare field keeps the items where it is filled, !field the others; quotes around the clause, the field or the value are optional; several clauses all match';
export function parseClause(text) {
  const s = unquote(String(text ?? '').trim());
  let best = null;
  for (const op of OPS) { const i = s.indexOf(op); if (i >= 0 && (!best || i < best.i || (i === best.i && op.length > best.op.length))) best = { i, op }; }
  if (!best) {
    const bare = BARE.exec(s);
    if (!bare) return loneQuote(s) ? { invalid: 'unbalanced quote' } : null;
    const field = unquote(bare[2].trim());
    return { field, keys: parsePath(field), op: bare[1] ? 'absent' : 'present', value: '', lower: '' };
  }
  const rawField = s.slice(0, best.i).trim();
  let value = s.slice(best.i + best.op.length).trim();
  if (best.op === '=' && value.startsWith('=')) value = value.slice(1).trim(); // '==' is '='
  if (/^[=~<>!]/.test(value)) return { invalid: 'unknown operator ' + best.op + value[0] };
  if (loneQuote(rawField) || loneQuote(value)) return { invalid: 'unbalanced quote' };
  const field = unquote(rawField);
  if (value.length >= 2 && QUOTED.test(value)) value = value.slice(1, -1);
  const clause = { field, keys: field ? parsePath(field) : null, op: best.op, value, lower: value.toLowerCase() };
  if (ALTERNATING.has(best.op) && value.includes('|')) {
    const any = value.split(/(?<!\\)\|/).map(v => v.replace(/\\\|/g, '|').trim()).filter(v => v !== '');
    if (any.length > 1) clause.any = any.map(v => v.toLowerCase());
    else { clause.value = value.replace(/\\\|/g, '|'); clause.lower = clause.value.toLowerCase(); }
  } else if (value.includes('\\|')) { clause.value = value.replace(/\\\|/g, '|'); clause.lower = clause.value.toLowerCase(); }
  return clause;
}
const numeric = text => (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : null);
// Text search: every key and scalar inside; `own` (deep search) only the node's own keys and scalars, so a match
// names the node that holds the text, not each of its ancestors.
function hasText(value, lower, own = false) {
  if (typeof value === 'string') return value.toLowerCase().includes(lower);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase().includes(lower);
  if (Array.isArray(value)) return value.some(v => (own ? v === null || typeof v !== 'object' : true) && hasText(v, lower));
  if (isObject(value)) return Object.keys(value).some(k => k.toLowerCase().includes(lower) || (own ? !isObject(value[k]) && hasText(value[k], lower, true) : hasText(value[k], lower)));
  return false;
}
function equals(actual, c) {
  if (typeof actual === 'string') return actual.toLowerCase() === c.lower;
  if (typeof actual === 'number') return numeric(c.value) === actual;
  if (typeof actual === 'boolean' || actual === null) return String(actual) === c.lower;
  return false;
}
function ordered(actual, c) {
  const n = numeric(c.value);
  const [a, b] = typeof actual === 'number' && n !== null ? [actual, n] : typeof actual === 'string' ? [actual, c.value] : [null, null];
  if (a === null) return false;
  return c.op === '>' ? a > b : c.op === '>=' ? a >= b : c.op === '<' ? a < b : a <= b;
}
// A value that says something: not false, null, "", [] or {} (0 is a value).
const filled = v => v !== null && v !== undefined && v !== false && v !== '' && !(Array.isArray(v) && !v.length) && !(isObject(v) && !Object.keys(v).length);
function matches(item, c, own) {
  if (c.op === 'present' || c.op === 'absent') {
    const r = resolve(item, c.keys);
    const present = r.found && filled(r.value);
    return c.op === 'present' ? present : !present;
  }
  let actual = item, found = true;
  if (c.keys) { const r = resolve(item, c.keys); found = r.found; actual = r.value; }
  if (!found) return c.op === '!=' || c.op === '!~';
  const any = test => (Array.isArray(actual) && c.keys ? actual.some(test) : test(actual));
  // Alternatives (C29): any of them matches ~ and =; !~ keeps the items that hold none.
  const alternatives = c.any ? c.any.map(lower => ({ ...c, value: lower, lower })) : [c];
  const text = () => alternatives.some(a => hasText(actual, a.lower, own && !c.keys));
  switch (c.op) {
    case '=': return alternatives.some(a => any(v => equals(v, a)));
    case '!=': return !any(v => equals(v, c));
    case '~': return text();
    case '!~': return !text();
    default: return any(v => ordered(v, c));
  }
}

// ---- size-bounded rendering. Levels from richest to poorest: containers past `d` become '[... n]' / '{... n}', strings
// past `s` characters end with '...(+n)'. measure() is the UTF-8 size of the rendering's JSON, stopping past `limit`.
const LEVELS = [{ d: Infinity, s: Infinity }, { d: Infinity, s: 400 }, { d: 4, s: 200 }, { d: 3, s: 160 }, { d: 2, s: 120 }, { d: 1, s: 80 }, { d: 0, s: 60 }];
const cut = (text, s) => (text.length > s ? text.slice(0, s) + '...(+' + (text.length - s) + ')' : text);
export function render(value, d = Infinity, s = Infinity) {
  if (typeof value === 'string') return cut(value, s);
  if (Array.isArray(value)) return d <= 0 && value.length ? '[... ' + value.length + ']' : value.map(v => render(v, d - 1, s));
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (d <= 0 && keys.length) return '{... ' + keys.length + '}';
    const out = {}; for (const k of keys) put(out, k, render(value[k], d - 1, s)); return out;
  }
  return value;
}
function measure(value, d, s, limit) {
  let total = 0;
  const add = n => { total += n; if (total > limit) throw measure; };
  const visit = (v, depth) => {
    if (typeof v === 'string') { if (total + Math.min(v.length, s) + 2 > limit) throw measure; add(bytes(cut(v, s))); return; }
    if (Array.isArray(v)) {
      if (depth <= 0 && v.length) { add(bytes('[... ' + v.length + ']')); return; }
      add(2 + Math.max(0, v.length - 1)); for (const x of v) visit(x, depth - 1); return;
    }
    if (isObject(v)) {
      const keys = Object.keys(v);
      if (depth <= 0 && keys.length) { add(bytes('{... ' + keys.length + '}')); return; }
      add(2 + Math.max(0, keys.length - 1));
      for (const k of keys) { add(bytes(k) + 1); visit(v[k], depth - 1); }
      return;
    }
    add(v === undefined ? 4 : bytes(v));
  };
  try { visit(value, d); return total; } catch (stop) { if (stop === measure) return Infinity; throw stop; }
}
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const size = bytes;

// ---- refusals: code + continuation {tool, arguments, why}; never a shell command.
const refusal = (code, error, continuation, extra = {}) => ({ ok: false, code, error, ...extra, continuation });
const again = (args, why) => ({ tool: 'ssam_evidence', arguments: args, why });
const firstLine = text => String(text ?? '').split(/\r?\n/)[0].slice(0, 300);

// Is p strictly inside root? (path.relative is case-insensitive on Windows.)
function inside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && rel.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(rel);
}

export function createEvidenceReader({ roots = evidenceRoots(), maxBytes = MAX_FILE_BYTES, cacheBytes = CACHE_BYTES } = {}) {
  const cache = new Map(); let cachedBytes = 0;
  const lexicalRoots = roots.map(r => path.resolve(r));
  const realRoots = () => lexicalRoots.map(r => { try { return fs.realpathSync.native(r); } catch { return null; } }).filter(Boolean);
  const outside = () => refusal('OUTSIDE_ROOTS', 'only JSON/JSONL written by SSAM under the lane folders is read',
    again({ file: '<an out/result/receipt/journal path returned by an SSAM tool>' }, 'evidence lives under one of roots'), { roots: lexicalRoots });

  // The real file behind `file`, or a refusal. Lexical check first (nothing outside is touched), then the real path:
  // a junction or symlink under a root that points elsewhere is refused.
  function locate(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file))
      return refusal('PATH_NOT_ABSOLUTE', 'file must be an absolute path', again({ file: '<absolute path returned by an SSAM tool>' }, 'the tools return absolute evidence paths'));
    if (/^[\\/]{2}/.test(file)) return refusal('PATH_NOT_LOCAL', 'network and device paths are refused', again({ file: '<local absolute path>' }, 'evidence is local'));
    const resolved = path.resolve(file);
    if (process.platform === 'win32' && resolved.indexOf(':', 2) >= 0) return refusal('BAD_PATH', 'alternate streams are refused', again({ file: '<absolute path>' }, 'a plain file path'));
    const ext = path.extname(resolved).toLowerCase();
    if (ext !== '.json' && ext !== '.jsonl') return refusal('NOT_JSON', 'only .json and .jsonl files are read', again({ file: '<path>.json' }, 'evidence is JSON or JSONL'));
    if (SECRET_FILE.test(path.basename(resolved))) return refusal('SECRET_FILE', 'credential and secret files are never read', again({ file: '<an evidence path>' }, 'secrets never leave the machine'));
    const reals = realRoots();
    if (!lexicalRoots.some(r => inside(r, resolved)) && !reals.some(r => inside(r, resolved))) return outside();
    let real;
    try { real = fs.realpathSync.native(resolved); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return refusal('FILE_NOT_FOUND', 'no such file', again({ file: '<an existing evidence path>' }, 'use the path the SSAM tool returned'));
      return refusal('READ_FAILED', firstLine(error.message), again({ file: '<an evidence path>' }, 'the file could not be opened'));
    }
    if (!reals.some(r => inside(r, real))) return outside();
    const stat = fs.statSync(real);
    if (!stat.isFile()) return refusal('NOT_A_FILE', 'not a file', again({ file: '<path>.json' }, 'a file, not a folder'));
    if (stat.size > maxBytes) return refusal('FILE_TOO_LARGE', `the file has ${stat.size} bytes; the limit is ${maxBytes}`,
      again({ file: '<a narrower evidence file>' }, 'evidence this large comes from an unbounded reading: read again with a path or depth in the tool that wrote it'));
    return { real, stat, jsonl: ext === '.jsonl' };
  }

  // Parsed and redacted document, cached by (real path, mtime, size). A .json file holding one JSON value per line is
  // read as JSONL; torn JSONL lines are skipped and counted.
  function load({ real, stat, jsonl }) {
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    const hit = cache.get(key);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) { cache.delete(key); cache.set(key, hit); return hit; }
    const buffer = fs.readFileSync(real);
    const text = buffer[0] === 0xFF && buffer[1] === 0xFE ? buffer.toString('utf16le').replace(/^\uFEFF/, '') : buffer.toString('utf8').replace(/^\uFEFF/, '');
    const lines = () => {
      const items = []; let bad = 0;
      for (const line of text.split(/\r?\n/)) { if (!line.trim()) continue; try { items.push(JSON.parse(line)); } catch { bad++; } }
      return { items, bad };
    };
    let doc, bad = 0;
    if (jsonl) ({ items: doc, bad } = lines());
    else {
      try { doc = JSON.parse(text); }
      catch (error) {
        const asLines = lines();
        // The parser's message may quote the file (a secret included): only the position leaves.
        const position = /position (\d+)/.exec(error.message)?.[1];
        if (asLines.items.length > 1 && asLines.bad === 0) doc = asLines.items;
        else return { error: 'not valid JSON' + (position ? ' at position ' + position : '') };
      }
    }
    // A durable envelope is opened (each line of a JSONL too) before redaction, so a secret in the payload never leaves.
    let envelope = null, hidden = 0;
    const open = item => { const o = openEnvelope(item); if (o.envelope) envelope = envelope === null || envelope === o.envelope ? o.envelope : 'mixed'; hidden += o.hidden ?? 0; return o.doc; };
    doc = Array.isArray(doc) ? doc.map(open) : open(doc);
    const { value, count } = redact(doc);
    const entry = { doc: value, redacted: count + hidden, bad, ...(envelope ? { envelope } : {}), mtimeMs: stat.mtimeMs, size: stat.size };
    if (hit) { cache.delete(key); cachedBytes -= hit.size; }
    if (stat.size <= cacheBytes) {
      cache.set(key, entry); cachedBytes += stat.size;
      for (const [k, v] of cache) { if (cachedBytes <= cacheBytes) break; cache.delete(k); cachedBytes -= v.size; }
    }
    return entry;
  }

  function read(input = {}) {
    const located = locate(input.file);
    if (located.ok === false) return located;
    const loaded = load(located);
    if (loaded.error) return refusal('INVALID_JSON', loaded.error, again({ file: input.file }, 'the file is not complete JSON yet; read it again when the tool that writes it has finished'));
    const budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, input.budgetBytes ?? DEFAULT_BUDGET));
    const meta = { ...(loaded.envelope ? { envelope: loaded.envelope } : {}), ...(loaded.redacted ? { redacted: loaded.redacted } : {}), ...(loaded.bad ? { badLines: loaded.bad } : {}) };
    const fit = value => finish({ ok: true, ...value, ...meta }, budget);

    const baseKeys = parsePath(input.pointer);
    const base = resolve(loaded.doc, baseKeys);
    if (!base.found) {
      const parent = base.parent;
      const keys = Array.isArray(parent) ? 'array of ' + parent.length : isObject(parent) ? Object.keys(parent).slice(0, 40) : typeof parent;
      return refusal('POINTER_NOT_FOUND', 'nothing at ' + (input.pointer ?? ''), again({ file: input.file, pointer: toPointer(base.parentKeys) }, 'the deepest part that exists'),
        { at: toPointer(base.parentKeys), keys });
    }
    // C29: every clause is parsed first; a malformed one is refused once the rows are known (the example comes from them).
    const clauses = [], malformed = [];
    for (const text of [].concat(input.where ?? [])) {
      const clause = parseClause(text);
      if (!clause || clause.invalid) malformed.push('"' + String(text).slice(0, 80) + '": ' + (clause?.invalid ?? 'neither "field op value" nor a bare field'));
      else clauses.push(clause);
    }
    const sameReading = where => ({ file: input.file, ...(input.pointer ? { pointer: input.pointer } : {}), ...(input.deep ? { deep: true } : {}),
      ...(input.depth ? { depth: input.depth } : {}), ...(input.fields ? { fields: input.fields } : {}), where });
    const filterInvalid = (problems, rows) => {
      const facts = rowFacts(rows ?? []);
      return refusal('EVIDENCE_FILTER_INVALID', 'where: ' + problems.join('; '), again(sameReading(facts.example), 'the same reading with a clause this file can answer'),
        { grammar: FILTER_GRAMMAR, fields: facts.fields, ...(facts.kinds.length ? { kinds: facts.kinds } : {}), example: facts.example });
    };

    if (input.select) {
      if (clauses.length || malformed.length || input.deep || input.groupBy)
        return refusal('BAD_ARGUMENTS', 'select reads paths of one object; where, deep and groupBy list items',
          again({ file: input.file, ...(input.pointer ? { pointer: input.pointer } : {}), select: [...new Set([...input.select, ...(input.fields ?? [])])] }, 'select alone (fields join select)'));
      // fields with select (A21): the same paths of the same object, read together instead of refused.
      const specs = [...new Set([...input.select, ...(input.fields ?? [])])];
      const merged = (input.fields ?? []).filter(f => !input.select.includes(f));
      const values = {}, missing = [];
      for (const spec of specs) { const r = resolve(base.value, parsePath(spec)); if (r.found) put(values, spec, r.value); else missing.push(spec); }
      return fit({ values, ...(missing.length ? { missing } : {}), ...(input.fields ? { fieldsMerged: merged } : {}) });
    }

    // Rows: deep = every object below the pointer (depth = object levels); an array its items; an object its entries.
    const listing = input.deep || clauses.length || malformed.length || input.fields || input.groupBy || input.offset !== undefined || input.max !== undefined;
    let rows;
    if (input.deep) rows = nodesBelow(base.value, input.depth ?? Infinity);
    else if (Array.isArray(base.value)) rows = base.value.map((value, i) => ({ ref: { key: i }, value }));
    else if (isObject(base.value) && listing) rows = Object.keys(base.value).map(k => ({ ref: { key: k }, value: base.value[k] }));
    else if (malformed.length) return filterInvalid(malformed, []);
    else return valueAnswer(base.value, { ...input, baseKeys: base.keys }, budget, meta);
    // A compared field that no row has is a misspelled field, never "0 items" (the negations and !field stay valid).
    const absent = rows.length ? clauses.filter(c => c.keys && !['!=', '!~', 'absent'].includes(c.op) && c.op !== 'present'
      && !rows.some(r => resolve(r.value, c.keys).found)).map(c => 'no row has the field "' + c.field + '"') : [];
    if (malformed.length || absent.length) return filterInvalid([...malformed, ...absent], rows);
    const before = rows;
    if (clauses.length) rows = rows.filter(r => clauses.every(c => matches(r.value, c, input.deep)));
    // A valid filter that keeps nothing of N rows says what the rows hold.
    const empty = clauses.length && !rows.length && before.length ? (({ fields, kinds, example }) => ({ rows: before.length, fields, kinds, example }))(rowFacts(before)) : null;
    if (empty) meta.empty = empty;
    const fields = input.fields?.map(f => ({ spec: f, keys: parsePath(f) }));
    // deep + fields: an object holding none of the fields (a `properties` bag inside a tree node) is not a node of the
    // listing (an outline: deep, fields [kind, name], depth 2).
    if (input.deep && fields) rows = rows.filter(r => fields.some(f => resolve(r.value, f.keys).found));
    if (input.max === 0) return { ok: true, total: rows.length, ...meta };
    const showAt = Boolean(input.deep || clauses.length || !Array.isArray(base.value));
    const at = row => toPointer([...base.keys, ...refKeys(row.ref)]);

    if (input.groupBy) {
      const keys = parsePath(input.groupBy); const counts = new Map();
      for (const r of rows) { const v = resolve(r.value, keys); const k = !v.found ? '(absent)' : typeof v.value === 'string' ? v.value : JSON.stringify(v.value); counts.set(k, (counts.get(k) ?? 0) + 1); }
      const groups = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
      return page(groups, input, budget, meta, { total: rows.length, distinct: groups.length }, g => g, 'groups', 0);
    }
    const shape = row => {
      let body = row.value;
      if (fields && (isObject(body) || Array.isArray(body))) {
        body = {}; for (const f of fields) { const r = resolve(row.value, f.keys); if (r.found) put(body, f.spec, r.value); }
        return showAt ? { at: at(row), ...body } : body;
      }
      return showAt ? { at: at(row), value: body } : body;
    };
    // A row built here ({at, ...}, a projection) is a wrapper: its own level does not count against the depth.
    return page(rows, input, budget, meta, { total: rows.length }, shape, 'items', showAt || fields ? 1 : 0);
  }

  return { read, roots: lexicalRoots };
}

// C29: what the rows hold (the first 50): their fields, the kinds they name and one where clause they answer.
function rowFacts(rows) {
  const sample = rows.slice(0, 50).map(r => r.value).filter(isObject);
  const fields = [...new Set(sample.flatMap(v => Object.keys(v)))].slice(0, 40);
  const kinds = [...new Set(sample.map(v => v.kind).filter(k => typeof k === 'string' && k))].slice(0, 20);
  const escape = text => String(text).replace(/\|/g, '\\|');
  let example = kinds.length ? 'kind=' + kinds.slice(0, 2).map(escape).join('|') : null;
  for (const v of sample) {
    if (example) break;
    for (const f of fields) {
      const x = v[f];
      if (typeof x === 'string' && x.trim()) { example = f + '~' + escape(x.trim().slice(0, 24)); break; }
      if (typeof x === 'number' || typeof x === 'boolean') { example = f + '=' + x; break; }
    }
  }
  return { fields, kinds, example: example ?? fields[0] ?? 'error' };
}

// Every object node below `base` in document order. Arrays are transparent (an array's items are at the array's
// depth); a direct child object of the base is depth 1. Each row keeps a parent link; pointers are built only for
// the rows shown.
function nodesBelow(base, maxDepth) {
  const rows = [];
  const children = (value, ref, depth) => {
    if (Array.isArray(value)) for (let i = 0; i < value.length; i++) node(value[i], { parent: ref, key: i }, depth);
    else for (const k of Object.keys(value)) node(value[k], { parent: ref, key: k }, depth);
  };
  const node = (value, ref, depth) => {
    if (Array.isArray(value)) { children(value, ref, depth); return; }
    if (!isObject(value)) return;
    rows.push({ ref, value });
    if (depth < maxDepth) children(value, ref, depth + 1);
  };
  if (Array.isArray(base) || isObject(base)) children(base, null, 1);
  return rows;
}
function refKeys(ref) { const keys = []; for (let r = ref; r; r = r.parent) keys.push(r.key); return keys.reverse(); }

// One page of rows under the budget, all at the same rendering level: the richest level that still shows
// PAGE_TARGET rows (or all of the page), else the poorest. Items keep at least one level (`lift` more for rows built
// by the tool). offset < 0 counts from the end (a journal tail).
function page(rows, input, budget, meta, head, shape, name, lift) {
  const total = rows.length;
  const max = Math.min(MAX_ITEMS, input.max ?? DEFAULT_MAX);
  const start = input.offset === undefined ? 0 : input.offset < 0 ? Math.max(0, total + input.offset) : Math.min(input.offset, total);
  const slice = rows.slice(start, start + max).map(shape);
  const envelope = more => ({ ok: true, ...head, ...(start ? { offset: start } : {}), [name]: [], ...(more !== null ? { next: more } : {}), ...meta });
  const room = budget - size(envelope(start + 1)) - 24;
  const target = Math.min(slice.length, PAGE_TARGET);
  const levels = LEVELS.filter(l => l.d >= 1).map(l => ({ d: l.d + lift, s: l.s }));
  let chosen = null;
  for (const [index, level] of levels.entries()) {
    let used = 0, count = 0;
    for (const item of slice) { const n = measure(item, level.d, level.s, room - used); if (used + n + (count ? 1 : 0) > room) break; used += n + (count ? 1 : 0); count++; }
    chosen = { level, count, index };
    if (count >= target || count === slice.length) break;
  }
  let count = Math.max(chosen?.count ?? 0, slice.length ? 1 : 0);
  const build = (n, level = chosen.level, cutDown = chosen.index > 0) => {
    const items = slice.slice(0, n).map(item => render(item, level.d, level.s));
    const more = start + n < total ? start + n : null;
    return { ...envelope(more), [name]: items, ...(cutDown && n ? { truncated: true } : {}) };
  };
  if (!slice.length) return build(0, LEVELS[0], false);
  let answer = build(count);
  while (count > 1 && size(answer) > budget) answer = build(--count);
  if (size(answer) > budget) answer = build(1, { d: lift, s: 40 }, true);
  return answer;
}

// A single value: the richest rendering that fits; a long string pages by characters; a container that does not fit
// even one level deep is listed as entries instead.
function valueAnswer(value, input, budget, meta) {
  const head = { ok: true, ...meta };
  const room = budget - size(head) - 40;
  if (typeof value === 'string' && size(value) > room) {
    const start = Math.max(0, Math.min(value.length, input.offset ?? 0));
    let n = Math.max(1, room - 60);
    let chunk = value.slice(start, start + n);
    while (n > 1 && size(chunk) > room - 60) { n = Math.floor(n * 0.85); chunk = value.slice(start, start + n); }
    return { ...head, value: chunk, total: value.length, ...(start ? { offset: start } : {}), ...(start + n < value.length ? { next: start + n } : {}) };
  }
  for (const [index, level] of LEVELS.entries()) {
    if (level.d < 1 && (Array.isArray(value) || isObject(value))) break;
    if (measure(value, level.d, level.s, room) > room) continue;
    const answer = { ...head, value: render(value, level.d, level.s), ...(index ? { truncated: true } : {}) };
    if (size(answer) <= budget) return answer;
  }
  const rows = Array.isArray(value) ? value.map((v, i) => ({ ref: { key: i }, value: v })) : Object.keys(value).map(k => ({ ref: { key: k }, value: value[k] }));
  const map = isObject(value), prefix = toPointer(input.baseKeys ?? []);
  return page(rows, input, budget, meta, { total: rows.length }, row => (map ? { at: prefix + toPointer([row.ref.key]), value: row.value } : row.value), 'items', map ? 1 : 0);
}

function finish(answer, budget) {
  if (size(answer) <= budget) return answer;
  // select: shrink every value to the same level until it fits
  if (answer.values) {
    for (const level of LEVELS.slice(1)) {
      const values = Object.fromEntries(Object.entries(answer.values).map(([k, v]) => [k, render(v, level.d, level.s)]));
      const shrunk = { ...answer, values, truncated: true };
      if (size(shrunk) <= budget) return shrunk;
    }
    const names = Object.keys(answer.values); const kept = {};
    for (const k of names) { put(kept, k, render(answer.values[k], 0, 40)); if (size({ ...answer, values: kept }) > budget) { delete kept[k]; break; } }
    return { ...answer, values: kept, truncated: true, omitted: names.filter(k => !(k in kept)) };
  }
  return answer;
}

const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });

export function registerSsamEvidence(server, deps = {}) {
  const reader = deps.reader ?? createEvidenceReader({ ...(deps.roots ? { roots: deps.roots } : {}), ...(deps.maxBytes ? { maxBytes: deps.maxBytes } : {}) });
  const pathSpec = z.string().max(500);
  server.registerTool('ssam_evidence', {
    title: 'Read SSAM evidence (JSON/JSONL) without scripts',
    description: 'Reads a JSON or JSONL file SSAM wrote (an inspect `out`, a deliver result.json, receipts, lab receipt/checks/manifest, '
      + 'snapshot sidecars, journals) under the lane folders; use it instead of python -c, node -e or ConvertFrom-Json. Answers stay under '
      + 'budgetBytes (2000 by default): lists page (offset, next), big values shrink ("[... n]", "{... n}", "...(+n)"). '
      + 'pointer: JSON Pointer (/tree/children/0) or dotted path (tree.children[0]) of the part to read; without other arguments an '
      + 'object shows its shape. select: several paths of one object at once. List options (on an array, the entries of an object, '
      + 'or with deep:true every object below pointer, each with its `at` pointer; depth limits deep): where "field op value" '
      + '(op = != ~ contains !~ > >= < <=; several clauses all match; no field = the item itself or any text in it; a bare field '
      + '"error" keeps the items where it exists and is not false/null/empty, "!error" the others), fields to '
      + 'project, groupBy field for counts, offset (negative = from the end: offset:-20 is a journal tail), max (0 = only total). '
      + 'A kernel envelope {format, sha256, payload} (task.json, receipts) is read as its payload (envelope: verified). '
      + 'Secrets (password, token, secret, authorization, cookie, authorize words) come back as [redacted].',
    inputSchema: z.object({
      file: z.string().min(1).max(1024).describe('Absolute path of the .json/.jsonl evidence, as an SSAM tool returned it'),
      pointer: pathSpec.optional().describe('JSON Pointer or dotted path of the part to read; default the whole file'),
      select: z.array(pathSpec).min(1).max(40).optional().describe('Paths read at once from the pointer target'),
      where: z.union([z.string().min(1).max(500), z.array(z.string().min(1).max(500)).min(1).max(10)]).optional().describe('field op value, e.g. kind=JavaScriptNode, name~Pin, kind~Container|Button (| alternates in = ~ !~), ts_start>=2026-09-16; or a bare field: error, !error'),
      fields: z.array(pathSpec).min(1).max(40).optional().describe('Fields of each item to show (dotted paths)'),
      deep: z.boolean().optional().describe('List every object below pointer (tree search), each with its `at` pointer'),
      depth: z.number().int().min(1).max(64).optional().describe('With deep: object levels to descend'),
      groupBy: pathSpec.optional().describe('Count the items by this field'),
      offset: z.number().int().optional().describe('First item (negative: from the end); a long string pages by characters'),
      max: z.number().int().min(0).max(MAX_ITEMS).optional().describe('Items per page (default 50; 0 = only the total)'),
      budgetBytes: z.number().int().min(MIN_BUDGET).max(MAX_BUDGET).optional().describe('Answer size limit (default 2000)'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try { return reply(reader.read(input)); }
    catch (error) { return reply({ ok: false, error: firstLine(error.message) }); }
  });
}
