// One output policy for both lanes. The saved document is the input, before any reduction.
import { clipText } from './text-clip.mjs';
import { hostedContext } from './executor.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONTINUATION_FIELDS, detailsOf } from './refusal-problems.mjs';
import { READER_BUDGET } from './paged-answer.mjs';
import { VERBATIM } from './responses.mjs';
import { writeAnswerOrigin } from './reference-files.mjs';
import { POSIX_PATH } from './exposure.mjs';

import { ANSWER_BUDGETS, EXPANSION_DEFAULT_BYTES, RECOVERY_PART_BYTES, POINTER_FLOOR_BYTES, budgetCeiling, maxAnswerBytes, visibleAnswerBytes } from './context-budget.mjs';
export { ANSWER_BUDGETS } from './context-budget.mjs';
const bytes = value => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
// T16 rule 8: the one surrogate-safe cut (text-clip.mjs).
export { clipText };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const warningIdentity = value => JSON.stringify(object(value)
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'count')) : value,
(_key, child) => object(child) ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
const warningCount = list => list.reduce((sum, entry) => sum + (Number.isFinite(entry?.count) ? entry.count : 1), 0);

// No clone unless a duplicate exists; stable identity is part of fitAnswer's
// idempotence contract. Complete HIGH entries are never rewritten or grouped.
export function normalizeOutputWarnings(full) {
  if (!object(full) || !Array.isArray(full.highWarnings) || !Array.isArray(full.warnings)) return full;
  const high = new Map(), removed = new Map();
  for (const entry of full.highWarnings) {
    const key = warningIdentity(entry);
    high.set(key, (high.get(key) ?? 0) + warningCount([entry]));
  }
  const warnings = full.warnings.filter(entry => {
    const key = warningIdentity(entry);
    if (!high.has(key)) return true;
    removed.set(key, (removed.get(key) ?? 0) + warningCount([entry]));
    return false;
  });
  if (warnings.length === full.warnings.length) return full;
  const shown = warningCount(warnings) + warningCount(full.highWarnings);
  const total = Math.max(Number.isFinite(full.warningsTotal) ? full.warningsTotal : 0,
    warningCount(warnings) + [...high].reduce((sum, [key, count]) => sum + Math.max(count, removed.get(key) ?? 0), 0));
  return { ...full, warnings,
    ...(Number.isFinite(full.warningsTotal) || total > shown ? { warningsTotal: total } : {}) };
}

const PROSE_FIELDS = new Set(['error', 'errors', 'message', 'messages', 'warnings', 'fix', 'why', 'note', 'notes', 'hint', 'description', 'summary', 'title', 'detail', 'details', 'guidance', 'reason', 'recover', 'next']);
// R1 answers (BankDash item 12, 2026-10-28): a list of messages or problems is the content a tool answers, never prose. Under
// one of these names, at any depth, a list is never deduplicated as prose; at the top of a refusal, a receipt or any other
// answer it is never removed for the editorial budget: it is held under the visible ceiling instead (whole, then every item
// in one line, then its first items and ONE read of the rest). Its order is the priority of the lists when they share the room.
export const CONTENT_LISTS = Object.freeze(['problems', 'errors', 'messages', 'warnings', 'issues', 'diagnostics', 'violations', 'findings']);
const contentList = (key, value) => Array.isArray(value) && !KEPT_WITH_LISTS.includes(key) && (CONTENT_LISTS.includes(key) || /(?:Problems|Errors|Messages|Warnings|Issues|Diagnostics|Violations|Findings)$/.test(key));
// The order of a bounded answer (rule 2): status and code, the lists, the next step, then the rest.
const STATUS_KEYS = ['ok', 'code', 'error', 'result', 'outcome'];
const NEXT_KEYS = ['continuation', 'continuations', 'nextCalls', 'next', 'nextBasedOn', 'verifiedPatch', 'patchIn'];
const listPriority = key => key === 'highWarnings' ? -2 : key === 'problems' ? -1 : CONTENT_LISTS.includes(key) ? CONTENT_LISTS.indexOf(key) : 100;
const KEPT_WITH_LISTS = ['grouped', 'highWarnings', 'studioWrites'];
// Rule 3: a number, a boolean, null or a value under the floor stays inline; only a larger subtree may leave for a pointer.
const worthPointer = value => value !== null && (typeof value === 'object' || typeof value === 'string') && bytes(value) > POINTER_FLOOR_BYTES;
const identityScalar = value => value === null || ['number', 'boolean'].includes(typeof value) || (typeof value === 'string' && bytes(value) <= POINTER_FLOOR_BYTES);
// The compact form of an item of a list (rule 1): its code, where it is and one line. A text keeps its head and its tail (the
// code of an O11 message is at its head, its element at its tail).
const COMPACT_STEPS = [{ line: 240, fix: true }, { line: 160, fix: true }, { line: 160, fix: false }, { line: 100, fix: false }];
const isHighSurrogate = unit => unit >= 0xD800 && unit <= 0xDBFF;
const isLowSurrogate = unit => unit >= 0xDC00 && unit <= 0xDFFF;
export function oneLine(text, max) {
  const s = String(text ?? '').replace(/\s*\r?\n\s*/g, '; ').replace(/\s{2,}/g, ' ').trim();
  if (s.length <= max) return s;
  let head = Math.ceil((max - 1) * 0.6), start = s.length - (max - 1 - head);
  if (head > 0 && isHighSurrogate(s.charCodeAt(head - 1))) head -= 1;
  if (start < s.length && isLowSurrogate(s.charCodeAt(start))) start += 1;
  // A path or URL is an indivisible token. Prefer keeping a token that fits
  // in the head; otherwise remove it whole. Exposure owns path redaction.
  // Absolute paths may contain spaces. Consume through the extension,
  // closing quote or end, before considering ordinary whitespace tokens.
  const paths = [...s.matchAll(/(?<![A-Za-z0-9_])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>|]*?(?:\.[A-Za-z0-9_-]+(?=$|[\s"'<>),;!?])|(?=$|["'<>|]))/g), ...s.matchAll(POSIX_PATH)];
  const spans = [...paths, ...[...s.matchAll(/\S+/g)].filter(m => /\\|[a-z][a-z0-9+.-]*:\/\/|\.[a-z]+:\d+[),;!?]*$/i.test(m[0]))]
    .map(m => {
      let index = m.index, end = index + m[0].length;
      const quote = s[index - 1];
      // Keep the quote pair with a path: losing just the opening quote would
      // make exposure interpret a quoted filename as an unquoted one.
      if (["'", '"', '`'].includes(quote) && s[end] === quote) { index--; end++; }
      return { index, end };
    }).sort((a, b) => a.index - b.index || b.end - a.end);
  const tokens = [];
  for (const span of spans) {
    const last = tokens.at(-1);
    if (last && span.index < last.end) last.end = Math.max(last.end, span.end);
    else tokens.push(span);
  }
  const crossing = n => tokens.find(m => m.index < n && m.end > n);
  const h = crossing(head);
  if (h) head = h.end <= max - 1 ? h.end : h.index;
  start = Math.max(head, s.length - (max - 1 - head));
  const t = crossing(start);
  if (t) start = t.end;
  if (start < s.length && isLowSurrogate(s.charCodeAt(start))) start += 1;
  return s.slice(0, head) + '…' + s.slice(start);
}
const firstText = (...values) => values.find(v => typeof v === 'string' && v.trim());
export function compactItem(item, { line = 240, fix = true } = {}) {
  if (typeof item === 'string') return oneLine(item, line);
  if (!object(item)) return item;
  const code = firstText(item.code, item.id, item.type, item.rule, item.kind);
  const pointers = Array.isArray(item.pointers) ? item.pointers.filter(p => typeof p === 'string') : [];
  const where = firstText(item.element, item.pointer, pointers.length ? pointers.slice(0, 3).join(', ') + (pointers.length > 3 ? ` (+${pointers.length - 3})` : '') : null,
    item.at, item.path, item.key, item.k, item.name, item.owner);
  const message = firstText(item.message, item.error, item.detail, item.text, item.description, item.title, item.summary);
  if (!code && !message) return oneLine(JSON.stringify(item), line);
  return { ...(code ? { code: oneLine(code, 80) } : {}), ...(typeof item.severity === 'string' && item.severity !== 'error' ? { severity: item.severity } : {}),
    ...(Number.isInteger(item.count) && item.count > 1 ? { count: item.count } : {}), ...(where ? { at: oneLine(where, 120) } : {}),
    ...(message ? { message: oneLine(message, line) } : {}), ...(fix && typeof item.fix === 'string' && item.fix && item.fix !== message ? { fix: oneLine(item.fix, line) } : {}) };
}
const token = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const pointer = keys => keys.map(k => '/' + token(k)).join('');
// What stands in a refusal for a value a problem carries that went to the kept answer (a long detail, a text past the ceiling):
// what it was (its items, characters or bytes) and the exact read that returns it.
const PAGES_TEXT = 'longer than one read: send the same read again with offset set to the next it returns, until no next comes';
const PAGES_PARTS = PAGES_TEXT + '; a part longer than one read is read by its own pointer (this pointer and /<index> after it)';
const markerOf = (value, read) => ({ omitted: true,
  ...(Array.isArray(value) ? { count: value.length } : typeof value === 'string' ? { characters: value.length } : { bytes: bytes(value) }), read,
  ...(bytes(value) + 512 > READER_BUDGET ? { pages: typeof value === 'string' ? PAGES_TEXT : PAGES_PARTS } : {}) });
const isMarker = value => object(value) && value.omitted === true && object(value.read) && value.read.tool === 'ssam_evidence';
const delivery = new Set(['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job']);
export function answerKind(tool, args = {}, value) {
  if (value?.ok === false) return 'refusal';
  if (tool === 'ssam_discover' && (args.packet || value?.schemaVersion === 'ssam-packet/1')) return 'packet';
  if (delivery.has(tool) || (tool === 'ssam_code' && (args.action ?? args.mode) === 'write')) return 'receipt';
  // X1: the answer of ssam_code plan is the launch of its subagents (fitAnswer keeps every batch's launchPrompt).
  if (tool === 'ssam_code' && (args.action ?? args.mode) === 'plan') return 'plan';
  if (tool === 'ssam_discover' && !['expand', 'detail', 'type', 'packet', 'catalog'].some(k => args[k])) return 'discoverFirst';
  if (value?.paged || VERBATIM.has(tool)) return 'read';
  if (['ssam_map', 'ssam_reference', 'o11_inspect', 'studio_inspect'].includes(tool)) return 'read';
  return 'other';
}

// directory: where the file goes (default <root>/.local/answers; a hosted session passes the customer's <ws>/o11/answers,
// servidor/fase4-25, so the files of one customer are never in the server's root and only that customer's ssam_evidence reads them).
// origin {tool, kind?} (fix/no-internals round 4, a licensee's server): the tool whose answer this is, kept next to it
// (reference-files.mjs writeAnswerOrigin), so ssam_evidence reads the file back as that tool's answer. None: nothing more.
// servidor/fase4-26 a7: the product's signature (origin third), the line's directory as an option; a string in the place of
// origin is the directory of a caller written before the a7 merge.
export function keepAnswer(full, root, origin = null, { directory = null } = {}) {
  if (typeof origin === 'string') { directory = origin; origin = null; }
  directory ??= path.join(root, '.local', 'answers');
  const body = JSON.stringify(full);
  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const file = path.join(directory, sha256 + '.json');
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(file)) {
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, body, 'utf8');
    fs.renameSync(temporary, file);
  }
  if (origin) { try { writeAnswerOrigin(file, origin); } catch { /* the answer is kept; a missing origin reads it as a run's evidence */ } }
  return { file, sha256 };
}

// Only transport/editorial metadata is budgeted for reads. Unknown fields remain content:
// a new reader must not lose source just because the output policy has not seen its schema.
const READ_ENVELOPE = new Set(['ok', 'code', 'lane', 'target', 'module', 'sourceSha256', 'expectedSourceSha256', 'capture', 'captureSha256',
  'note', 'notes', 'timings', 'elapsedMs', 'size', 'continuation', 'continuations', 'nextCalls', 'next', 'omitted', 'omittedCount', 'paged', 'page', 'pages', 'offset', 'total', 'count', 'limit', 'hasMore', 'view',
  'schema', 'schemaVersion', 'file', 'contentSha256', 'snapshotSha256', 'capturedBy', 'versionId', 'answeredBy', 'store', 'index', 'cache', 'counts', 'query', 'keyOwner', 'returned', 'truncated', 'nextOffset',
  'kindObserved', 'kindsNotObserved', 'searchComplete', 'notices', 'hidden', 'kind', 'doc', 'source', 'cached']);
export const answerEnvelope = value => object(value) ? Object.fromEntries(Object.entries(value).filter(([k]) => READ_ENVELOPE.has(k))) : {};

function commonPath(paths) {
  const shared = [...paths[0]];
  for (const keys of paths.slice(1)) { let n = 0; while (n < shared.length && String(shared[n]) === String(keys[n])) n++; shared.length = n; }
  return shared;
}
function at(value, keys) { return keys.reduce((v, k) => v?.[k], value); }
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// What a reader returns exactly for what changed (R1 rule 3: grouped, never a pointer per scalar). The nearest part that holds
// every change, when one read returns it whole, is one pointer. A larger part is entered: only its children on a changed path
// that differ from what the answer still shows are recovered (a scalar the answer still has never gets a pointer); an array
// whose items each fit one read pages with `max`; an item larger than one read gets its own pointer.
function recoverableParts(original, current, paths) {
  paths = paths.filter(keys => worthPointer(at(original, keys)) && !sameJson(at(original, keys), at(current, keys)));
  if (!paths.length) return [];
  const parts = [];
  const prefix = (a, b) => a.length <= b.length && a.every((k, i) => String(k) === String(b[i]));
  const onPath = keys => paths.some(p => prefix(keys, p) || prefix(p, keys));
  const visit = keys => {
    const o = at(original, keys);
    if (!worthPointer(o)) return;
    if (o === null || typeof o !== 'object' || bytes(o) < RECOVERY_PART_BYTES) { parts.push({ at: pointer(keys) }); return; }
    if (Array.isArray(o)) {
      const largest = o.reduce((size, item) => Math.max(size, bytes(item)), 1);
      if (largest < RECOVERY_PART_BYTES) { parts.push({ at: pointer(keys), max: Math.min(1000, Math.max(1, Math.floor(RECOVERY_PART_BYTES / largest))) }); return; }
    }
    const c = at(current, keys);
    for (const k of Object.keys(o)) {
      const child = [...keys, k];
      if (!onPath(child)) continue;
      if (c !== null && typeof c === 'object' && Object.hasOwn(c, k) && sameJson(o[k], c[k])) continue;
      visit(child);
    }
  };
  visit(commonPath(paths));
  return parts;
}
// The one recovery call of an answer (R1 rule 4). First the read of each list the visible ceiling compacted or cut: ONE call,
// ready, from the first item the answer does not show (a list shown item by item), as many whole items as one read returns
// (next continues); then the parts of every other change.
function recoveryCall(original, current, file, paths, lists) {
  const listParts = Object.entries(lists).map(([key, { shown, oneToOne, keys = [key] }]) => {
    const items = Array.isArray(at(original, keys)) ? at(original, keys) : [];
    const from = oneToOne && shown < items.length ? shown : 0;
    let n = 0, size = 0;
    for (let i = from; i < items.length && n < 1000; i++) { const b = bytes(items[i]) + 1; if (n && size + b > RECOVERY_PART_BYTES) break; size += b; n++; }
    const more = from + n < items.length ? '; next continues' : '';
    const why = from ? `the ${items.length - from} ${key} the answer does not show (items ${from} to ${items.length - 1} of ${items.length}), whole${more}`
      : `the ${items.length} ${key}, whole (the answer shows ${shown >= items.length ? 'each' : shown + ' of them'} in one line${shown >= items.length ? '' : ' each'})${more}`;
    return { at: pointer(keys), ...(from ? { offset: from } : {}), max: Math.max(1, n), why };
  });
  const listed = Object.entries(lists).map(([key, info]) => info.keys ?? [key]);
  const parts = [...recoverableParts(original, current, paths.filter(p => !listed.some(keys => keys.length <= p.length && keys.every((k,i) => k === p[i]))))];
  if (!parts.length && !listParts.length) return null;
  const callOf = part => ({ tool: 'ssam_evidence', arguments: { file, pointer: part.at, ...(part.offset ? { offset: part.offset } : {}), ...(part.max ? { max: part.max } : {}), budgetBytes: READER_BUDGET } });
  // Recovery metadata has a budget too. Many sibling documents must not turn
  // into enough calls to overflow the answer that carries them. The reader
  // pages their common parent and leaves every scalar inline in this answer.
  const grouped = parts.length > 4 ? (() => {
    const keys = commonPath(parts.map(part => part.at.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))));
    const source = at(original, keys);
    const largest = Math.max(1, ...Object.values(source ?? {}).map(bytes));
    return [{ at: pointer(keys), max: Math.min(1000, Math.max(1, Math.floor(RECOVERY_PART_BYTES / largest))), why: 'the omitted subtrees, grouped; next continues' }];
  })() : parts;
  const [first, ...rest] = [...listParts, ...grouped];
  if (!first) return null;
  return { ...callOf(first), ...(rest.length ? { more: rest.map(callOf) } : {}) };
}
// R1 rule 2: a bounded answer reads status and code first (with its other scalars: module, counts, flags), then its lists,
// then the next step and the read of what it left out, then the rest.
function ordered(value, contentKeys) {
  const placed = new Set([...KEPT_WITH_LISTS, ...NEXT_KEYS, 'omitted', 'omittedCount']);
  const scalars = Object.keys(value).filter(k => !placed.has(k) && !k.endsWith('Left') && (value[k] === null || typeof value[k] !== 'object') && !worthPointer(value[k]));
  const status = STATUS_KEYS.filter(k => (k !== 'error' || !value.errorDetail) && !object(value[k]) && !Array.isArray(value[k]));
  const first = [...new Set([...status, ...contentKeys.flatMap(k => [k, k + 'Left']), 'error', ...KEPT_WITH_LISTS, ...NEXT_KEYS, 'omitted', 'omittedCount', ...scalars])].filter(k => Object.hasOwn(value, k));
  return Object.fromEntries([...first.map(k => [k, value[k]]), ...Object.entries(value).filter(([k]) => !first.includes(k))]);
}

// maxBytes: the ceiling the server pages above (ssam.mjs pageAnswer; the environment's by default). visibleBytes: the ceiling a
// refusal and the content lists of an answer are held under (context-budget.mjs, the one place; the environment may lower it).
function fitAnswerImpl(tool, args = {}, full, { root, directory, budgets = ANSWER_BUDGETS, origin = null, maxBytes = maxAnswerBytes(), visibleBytes = visibleAnswerBytes() } = {}) {
  // Fit only the received value. Its existing readers remain authoritative;
  // recovering their source here would undo presentation and wrapper edits.
  const entryKind = answerKind(tool, args, full);
  const contentPayload = entryKind === 'read' || entryKind === 'packet' || (tool === 'ssam_discover' && full?.ok !== false && ['expand', 'detail', 'type', 'catalog'].some(k => args[k]));
  const originalFull = full;
  full = normalizeOutputWarnings(full);
  if (full?.omitted?.fitted === true && (bytes(full) <= visibleBytes || contentPayload)) return full;
  if (full?.omitted?.tool === 'ssam_evidence' && (bytes(full) <= visibleBytes || (answerKind(tool, args, full) === 'read' && bytes(answerEnvelope(full)) <= visibleBytes))) return full;
  // Work packets own their budget. Explicit expansions retain their requested content;
  // only the surrounding metadata is fitted, at their requested (normally the shared expansion budget) budget.
  if (full?.ok !== false && tool === 'ssam_discover' && (['ssam-packet/1', 'ssam-packet-part/1'].includes(full?.schemaVersion) || args.packet)) return full;
  if (full?.ok !== false && full?.schemaVersion === 'ssam-tool-definition/1') return full;
  const expanded = full?.ok !== false && tool === 'ssam_discover' && ['expand', 'detail', 'type', 'catalog'].some(k => args[k]);
  const kind = answerKind(tool, args, full);
  const budget = tool === 'ssam_discover' && Number.isFinite(args.budgetBytes) ? args.budgetBytes : expanded ? EXPANSION_DEFAULT_BYTES : (budgets[kind] ?? ANSWER_BUDGETS[kind]);
  if (!object(full)) {
    if (kind === 'read') return full;
    if (bytes(full) <= budget) return full;
    const saved = keepAnswer(originalFull, root, origin, { directory });
    return { ok: true, ...(Array.isArray(full) ? { count: full.length } : {}), omitted: recoveryCall(full, undefined, saved.file, [[]], {}) };
  }
  const value = structuredClone(full), changed = [];
  const previousRead = object(value.omitted) && value.omitted.tool === 'ssam_evidence' ? value.omitted : null;
  if (previousRead) delete value.omitted;
  const nestedContent = [];
  const findContent = (node, keys = []) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if ((!keys.length && (NEXT_KEYS.includes(key) || KEPT_WITH_LISTS.includes(key))) || (key === 'arguments' && typeof node.tool === 'string')) continue;
      if (contentList(key, child) && child.length) { if (keys.length) nestedContent.push({ parent: node, key, keys: [...keys, key] }); }
      else if (child && typeof child === 'object') findContent(child, [...keys, key]);
    }
  };
  if (kind !== 'read') findContent(value);
  // Every top-level container owns one recovery, irrespective of the number
  // of nested diagnostic lists. A single nested list keeps its narrow path.
  const nestedGroups = new Map();
  for (const item of nestedContent) {
    const key = item.keys[0];
    if (!nestedGroups.has(key)) nestedGroups.set(key, []);
    nestedGroups.get(key).push(item);
  }
  nestedContent.length = 0;
  for (const [key, items] of nestedGroups) {
    if (items.length === 1) nestedContent.push(items[0]);
    else nestedContent.push({ parent: value, key, keys: [key], container: true, subtree: !Array.isArray(value[key]) });
  }
  // R1 rules 1 and 2: the content lists of the answer (outside its editorial budget) and the visible ceiling they and a
  // refusal are held under, below the client's cut.
  const contentKeys = !expanded
    ? Object.keys(value).filter(k => (contentList(k, value[k]) || (k === 'highWarnings' && Array.isArray(value[k]))) && value[k].length).sort((a,b) => listPriority(a) - listPriority(b) || a.localeCompare(b)) : [];
  const bounded = kind !== 'read' && !expanded || contentKeys.length > 0 || nestedContent.length > 0;
  const visible = Math.min(visibleBytes, maxBytes);
  const lists = {}; // a list compacted or cut for the visible ceiling: {shown, oneToOne}
  const oneToOne = key => Array.isArray(originalFull?.[key]) && Array.isArray(value[key]) && value[key].length === originalFull[key].length && !(key === 'problems' && value.grouped);
  let moved = false;
  let edited = false; // a repeated text left the answer: it stays where it is first, so no read is needed for it
  const mark = keys => {
    // Normalization removes array entries. Recover any later prose cut from the
    // original warnings list, whose indexes precede that normalization.
    if (full !== originalFull && keys[0] === 'warnings') keys = ['warnings'];
    if (!changed.some(p => pointer(p) === pointer(keys))) changed.push(keys);
  };
  const remove = (parent, key, keys) => { if (Object.hasOwn(parent, key)) {
    if (parent === value && key === 'warnings' && Array.isArray(parent.warnings)) {
      const total = warningCount(parent.warnings) + warningCount(parent.highWarnings ?? []);
      parent.warningsTotal = Math.max(Number.isFinite(parent.warningsTotal) ? parent.warningsTotal : 0, total);
    }
    delete parent[key]; mark(keys);
  } };
  // R1 rule 3: what an editorial cut may take. Never a content list; never a scalar of the answer itself (a flag, a count, a
  // hash, an id: /ok, /jobSha256, /verifyRan); a value under the floor only with its neighbours, when one read returns the
  // part that holds them whole (never a pointer of its own, which would cost more than it); a part larger than one read
  // keeps its small fields inline and only its large parts leave.
  const cut = (parent, key, keys) => {
    if (!object(parent) || !Object.hasOwn(parent, key) || (KEPT_WITH_LISTS.includes(keys[0]) || NEXT_KEYS.includes(keys[0]))) return false;
    if (kind === 'read' && !READ_ENVELOPE.has(keys[0]) && !contentKeys.includes(keys[0])) return false;
    const v = parent[key];
    if (parent === value && key === 'error' && value.errorDetail) return false;
    if (parent === value && (contentKeys.includes(key) || identityScalar(v))) return false;
    if (nestedContent.some(item => keys.length === item.keys.length && keys.every((k,i) => k === item.keys[i]))) return false;
    if (nestedContent.some(item => keys.length <= item.keys.length && keys.every((k,i) => k === item.keys[i]))) {
      if (object(v)) for (const k of Object.keys(v)) cut(v, k, [...keys, k]);
      else if (Array.isArray(v)) v.forEach((child, i) => { if (object(child)) for (const k of Object.keys(child)) cut(child, k, [...keys, String(i), k]); });
      return false;
    }
    if (!worthPointer(v)) return false;
    if (object(v) && bytes(v) >= RECOVERY_PART_BYTES && Object.values(v).some(child => !worthPointer(child))) {
      const kept = {};
      for (const [k, child] of Object.entries(v)) { if (worthPointer(child)) mark([...keys, k]); else kept[k] = child; }
      parent[key] = kept;
      return true;
    }
    remove(parent, key, keys);
    return true;
  };
  // The editorial budget measures what is not a content list (a list is bounded by the visible ceiling instead).
  const withoutLists = v => (contentKeys.length && object(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !contentKeys.includes(k))) : v);
  const measured = v => bytes(kind === 'read' ? answerEnvelope(v) : withoutLists(v));
  let saved;
  const keep = () => (saved ??= keepAnswer(originalFull, root, origin, { directory }));
  const withOmitted = () => {
    const calls = [];
    const add = call => {
      if (!call) return;
      const { more, fitted, ...one } = call;
      if (!calls.some(existing => sameJson(existing.arguments, one.arguments))) calls.push(one);
      for (const extra of more ?? []) add(extra);
    };
    if (changed.length || Object.keys(lists).length) {
      keep();
      add(recoveryCall(originalFull, value, saved.file, changed, lists));
    }
    add(previousRead);
    if (!calls.length) return value;
    const [first, ...more] = calls;
    return { ...value, ...(typeof full.omitted === 'number' ? { omittedCount: full.omitted } : {}),
      omitted: { ...first, ...(more.length ? { more } : {}), fitted: true } };
  };
  const tooLarge = () => measured(withOmitted()) > budget;

  // Preserve unique error text before any duplicate-message summary can replace
  // it. The first line remains visible; the exact original has its own reader.
  if (typeof value.error === 'string' && bytes(value.error) > (Array.isArray(value.problems) && value.problems.length ? 1024 : visible / 2)) {
    const text = value.error;
    value.error = oneLine(text.split(/\r?\n/)[0], 300);
    value.errorDetail = markerOf(text, { tool: 'ssam_evidence', arguments: { file: keep().file, pointer: '/error', budgetBytes: READER_BUDGET } });
    moved = true;
  }
  if (kind === 'refusal' && Array.isArray(value.problems)) {
    const original = value.problems;
    // The producer owns diagnosis and cascade grouping. Transport fitting keeps
    // each problem and its order; it must never reinterpret their identities.
    const count = value.problems.reduce((n, p) => n + (p.count ?? 1), 0);
    const codes = {};
    for (const p of value.problems) codes[p.code ?? 'PROBLEM'] = (codes[p.code ?? 'PROBLEM'] ?? 0) + (p.count ?? 1);
    const errorLine = typeof originalFull.error === 'string' ? originalFull.error.split(/\r?\n/)[0] : value.error;
    if (typeof value.error === 'string' && original.some(p => typeof p?.message === 'string' && p.message && (value.error === p.message || value.errorDetail && errorLine === p.message))) {
      value.error = `${count} problems: ${Object.entries(codes).map(([code, n]) => `${code} x${n}`).join(', ')}`;
      edited = true;
    }
    value.problems.forEach(p => {
      for (const [k, v] of Object.entries(p)) {
        if (v === null || (Array.isArray(v) && !v.length) || (object(v) && !Object.keys(v).length) || (k === 'fix' && v === p.message)) { delete p[k]; edited = true; }
      }
      // R1 rule 1: the message and the fix of a problem are the content of the refusal, never clipped as prose; only the
      // visible ceiling shortens them (every problem in one line), and the kept answer has them whole.
      // T16 (review): only a certain patch is in the verified union (verified-patch.mjs patchUnion); a choice keeps its own.
      // a12: hosted, never: a patch is sent explicitly there (verified-patch.mjs), so each problem keeps its own.
      if (!hostedContext() && value.verifiedPatch && p.patch && p.patchCertain === true && bytes(p.patch) > 512) { delete p.patch; p.patchIn = 'verifiedPatch'; mark(['problems']); }
    });
    if (!hostedContext() && value.verifiedPatch && value.patch && bytes(value.patch) > 512) { delete value.patch; value.patchIn = 'verifiedPatch'; mark(['patch']); }
  }

  if (value.continuation?.why && Array.isArray(value.nextCalls)) value.nextCalls.forEach(call => {
    if (call.why === value.continuation.why) { delete call.why; edited = true; }
  });
  // Calls and source payloads remain exact; only surrounding prose is deduplicated.
  const seen = new Set();
  // HIGH prose has priority, but A03 forbids rewriting any HIGH entry. Seed the
  // same editorial strings before deduplicating the rest of the answer.
  const remember = (node, proseArray = false) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'arguments' && typeof node.tool === 'string') continue;
      if (typeof child === 'string' && child.length >= 40 && (PROSE_FIELDS.has(key) || (Array.isArray(node) && proseArray))) seen.add(child);
      else remember(child, Array.isArray(child) && (PROSE_FIELDS.has(key) || proseArray));
    }
  };
  remember(value.highWarnings);
  remember(value.continuation);
  const deduplicate = (node, keys = [], proseArray = false) => {
    if (!node || typeof node !== 'object') return;
    const priority = key => key === 'highWarnings' ? -2 : key === 'problems' || (keys.length === 0 && contentKeys.includes(key)) ? -1 : 0;
    const entries = Object.entries(node).sort(([a], [b]) => priority(a) - priority(b));
    for (const [key, child] of entries) {
      if (!keys.length && NEXT_KEYS.includes(key)) continue;
      if (!keys.length && KEPT_WITH_LISTS.includes(key)) continue;
      if (key === 'highWarnings') continue; // A03: every HIGH entry stays complete, including repeated prose.
      if (key === 'studioWrites') continue; // fix-ext-refs round 4 (N6): the protected declaration of the Studio writes stays whole.
      if (node === value && key === 'error' && value.errorDetail) continue;
      if (key === 'arguments' && typeof node.tool === 'string') continue;
      if (kind === 'read' && keys.length === 0 && !READ_ENVELOPE.has(key)) continue;
      // R1 rule 1: a list of messages or problems is content, at any depth: its texts are seen first (prose elsewhere that
      // repeats them goes) and none of them is removed.
      if (contentList(key, child)) { remember(child, true); continue; }
      if (typeof child === 'string' && child.length >= 40 && (PROSE_FIELDS.has(key) || (Array.isArray(node) && proseArray))) {
        if (seen.has(child)) { delete node[key]; edited = true; }
        else seen.add(child);
      } else deduplicate(child, [...keys, key], Array.isArray(child) && (PROSE_FIELDS.has(key) || proseArray));
    }
  };
  deduplicate(value);

  if ((kind === 'discoverFirst' || expanded) && tooLarge() && object(value.size)) {
    // Reduction metadata can cost more than the requested first answer. Its exact
    // discover calls remain in the saved size object, reached by the same reader.
    cut(value.size, 'truncated', ['size', 'truncated']);
  }
  if (expanded) {
    for (const key of ['hint', 'identity', 'coverage', 'lexical', 'notes', 'elapsedMs', 'size', 'nextCalls']) {
      if (!tooLarge()) break;
      cut(value, key, [key]);
    }
  }

  // An explicit expansion can share its response with a large model answer. Recovery
  // metadata is attached after the engine fits that model, so the model may still
  // overflow the requested budget after the editorial envelope has yielded. Keep
  // every named expansion and its next page intact; recover other sections exactly.
  if (expanded && kind !== 'refusal' && object(value.expansions) && tooLarge()) {
    const keep = new Set(['ok', 'code', 'error', 'problems', 'result', 'schemaVersion', 'lane', 'intent', 'expansions', 'expansionsReduced', 'expansionsOmitted', 'continuation', 'continuations', 'highWarnings']);
    for (const key of Object.keys(value).filter(k => !keep.has(k)).sort((a, b) => bytes(value[b]) - bytes(value[a]))) {
      if (!tooLarge()) break;
      cut(value, key, [key]);
    }
  }

  if (kind === 'receipt') {
    if (Array.isArray(value.removed) && value.removed.length > 5) {
      value.removedTotal = value.removedTotal ?? value.removed.length;
      value.removed = value.removed.slice(0, 5); mark(['removed']);
    }
    for (const key of ['summary', 'warnings', 'normalizations.items', 'phases', 'timings', 'leftovers']) {
      if (!tooLarge()) break;
      const keys = key.split('.'), parent = at(value, keys.slice(0, -1));
      const summary = key === 'summary' && object(value.summary) ? value.summary : null;
      if (cut(parent, keys.at(-1), keys) && summary) {
        const counts = Object.fromEntries(Object.entries(summary).filter(([, n]) => typeof n === 'number'));
        if (Object.keys(counts).length) value.counts = { ...value.counts, ...counts };
      }
    }
    // The receipts of the generators (integration marco-a2): what the person acts on stays, the lists go first. An integration
    // report (rest-consume, rest, soap) keeps its op, client, the consumers it broke and what the user fills after the publish
    // (rest-consume configure, which the generator card promises), then without its generated summary; entity-actions keeps
    // its counts, kept actions and notes, without the names of every generated action. Each cut is recovered exactly.
    const integrationKeeps = [['op', 'client', 'changed', 'consumersBroken', 'configure', 'generated'], ['op', 'client', 'consumersBroken', 'configure']];
    for (const keep of integrationKeeps) {
      if (!tooLarge() || !Array.isArray(value.integration)) break;
      const compact = value.integration.map(entry => object(entry) ? Object.fromEntries(Object.entries(entry).filter(([k, v]) => keep.includes(k) && !(Array.isArray(v) && !v.length))) : entry);
      if (JSON.stringify(compact) !== JSON.stringify(value.integration)) { value.integration = compact; mark(['integration']); }
    }
    for (const key of ['actions', 'structuresCreated', 'skipped']) {
      if (!tooLarge() || !object(value.entityActions)) break;
      cut(value.entityActions, key, ['entityActions', key]);
    }
  }
  if (kind === 'plan') {
    // X1 (ssam_code plan): the answer is the launch of the subagents. Each batch keeps its id, items and launchPrompt, the data
    // part its file and launchPrompt, and final and launch stay; what each prompt file already holds (its check, files and
    // sizes) goes first, recovered exactly here (ssam_evidence) and in the plan's own plan.json.
    for (const key of ['check', 'estimateBytes', 'promptBytes', 'files', 'promptFile']) {
      if (!tooLarge()) break;
      if (object(value.data)) cut(value.data, key, ['data', key]);
      (Array.isArray(value.batches) ? value.batches : []).forEach((batch, i) => { if (object(batch)) cut(batch, key, ['batches', String(i), key]); });
    }
  }
  if (kind === 'read') {
    for (const key of ['note', 'notes', 'timings', 'elapsedMs', 'size', 'store', 'index', 'cache', 'query', 'counts', 'notices', 'hidden']) { if (!tooLarge()) break; cut(value, key, [key]); }
    // HTML's way back and next page are executable contracts, not optional prose.
    // Dropping them made callers guess html/edit/edits despite a pinned reading.
    const htmlRoutes = value.schema === 'ssam-html/1' && object(value.continuations);
    if (htmlRoutes) {
      for (const key of ['note', 'keys', 'inspect']) {
        if (!tooLarge()) break;
        cut(value.continuations, key, ['continuations', key]);
      }
      // Duplicate capture locations are recoverable; the next/edit calls retain
      // their own exact targets and hashes, and sourceSha256 remains inline.
      for (const key of ['target', 'file', 'contentSha256', 'snapshotSha256', 'capture']) {
        if (!tooLarge()) break;
        cut(value, key, [key]);
      }
    }
    for (const key of ['nextCalls', 'continuations', 'next', 'continuation']) {
      if (!tooLarge()) break;
      if (htmlRoutes && key === 'continuations') continue;
      cut(value, key, [key]);
    }
  }
  // fix-ext-refs round 3 (F1): studioWrites, the short declaration of every Studio write a delivery made outside its merge
  // (o11-cycle.mjs studioWritesOf), is never dropped: the person always sees that the Studio changed the module.
  const protectedKeys = new Set(['ok', 'result', 'code', 'error', 'module', 'nextBasedOn', 'continuation', 'highWarnings', 'removed', 'removedTotal', 'counts', 'problems', 'grouped', 'verifiedPatch', 'patchIn', 'studioWrites', 'errorDetail',
    // The generators' receipts, compacted above, and the launch of a plan.
    ...(kind === 'receipt' ? ['integration', 'entityActions'] : []), ...(kind === 'plan' ? ['lane', 'action', 'planId', 'dir', 'data', 'batches', 'final', 'launch'] : [])]);
  if (kind !== 'read' && !expanded) {
    for (const key of Object.keys(value).filter(k => !protectedKeys.has(k) && !contentKeys.includes(k) && !/(?:Total|Count)$/.test(k)).sort((a, b) => bytes(value[b]) - bytes(value[a]))) {
      if (!tooLarge()) break;
      cut(value, key, [key]);
    }
  }

  // Review vps-a9, E1: a long text a problem carries to go on (the screen's text now, the edit ready...) goes, the longest first,
  // to the kept answer, and in its place the problem says exactly where it is: {omitted: true, characters, read: ssam_evidence
  // {file, pointer, budgetBytes}}; a text longer than one read pages by characters (pages says how).
  const moveLongTexts = done => {
    const leaves = [];
    const walk = (node, keys, i, minimum = 256) => {
      if (isMarker(node)) return;
      if (object(node) && typeof node.tool === 'string' && object(node.arguments)) return;
      if (typeof node === 'string') { if (node.length >= minimum) leaves.push({ i, keys, text: node }); return; }
      if (Array.isArray(node)) node.forEach((child, j) => walk(child, [...keys, j], i, minimum));
      else if (object(node)) for (const [k, child] of Object.entries(node)) walk(child, [...keys, k], i, minimum);
    };
    // Review refusal-followups M-A, under R1-B's ceiling: a problem's own detail (refusal-problems.mjs detailsOf: the readings of
    // a FLOW_SYNTAX, each the patch of the op with the whole list of its flow texts; a corrected value) moves WHOLE, one marker
    // with its count and exact read. A marker per text inside it cost more than the ceiling (four such problems were cut to one
    // line each, their pointers renamed to at) and left candidate patches whose values were markers. The parts of the module a
    // problem carries (current, next, merged, an edit with its basedOn) still move text by text: their hashes stay inline.
    const holdsMarker = v => isMarker(v) || (v !== null && typeof v === 'object' && Object.values(v).some(holdsMarker));
    value.problems.forEach((p, i) => { if (object(p)) {
      const details = detailsOf(p);
      for (const field of CONTINUATION_FIELDS) if (p[field] != null) {
        if (Object.hasOwn(details, field) && typeof p[field] === 'object' && worthPointer(p[field]) && !holdsMarker(p[field])) leaves.push({ i, keys: [field], text: p[field] });
        else walk(p[field], [field], i);
      }
    } });
    value.problems.forEach((p, i) => { if (object(p)) for (const field of ['message', 'error', 'detail', 'fix']) if (p[field] != null) walk(p[field], [field], i, visible / 2); });
    const source = Array.isArray(originalFull?.problems) ? originalFull.problems : [];
    const size = leaf => (typeof leaf.text === 'string' ? leaf.text.length : bytes(leaf.text));
    for (const leaf of leaves.sort((a, b) => size(b) - size(a))) {
      if (done()) break;
      // the same text (or detail) at the same place of a problem of the kept answer (a group keeps its first member's)
      const j = source.findIndex(p => (typeof leaf.text === 'string' ? at(p, leaf.keys) === leaf.text : sameJson(at(p, leaf.keys), leaf.text)));
      if (j < 0) continue;
      const read = { tool: 'ssam_evidence', arguments: { file: keep().file, pointer: pointer(['problems', String(j), ...leaf.keys.map(String)]), budgetBytes: READER_BUDGET } };
      at(value.problems[leaf.i], leaf.keys.slice(0, -1))[leaf.keys.at(-1)] = markerOf(leaf.text, read);
      moved = true;
    }
  };
  if (bounded) {
    // R1 rule 2: the answer ends under the visible ceiling, in the order status and code, the lists, the next step, the rest.
    // The lists stay whole when they fit; otherwise each item becomes one line,
    // then a prefix is shown. One list read retains every original field,
    // including the full text of the items still visible in compact form.
    const visibleValue = v => kind === 'read' ? Object.fromEntries(Object.entries(v).filter(([k]) => READ_ENVELOPE.has(k) || contentKeys.includes(k) || contentKeys.some(c => k === c + 'Left'))) : v;
    const fits = () => bytes(visibleValue(withOmitted())) <= visible;
    const core = v => Object.fromEntries(Object.entries(v).filter(([k]) => STATUS_KEYS.includes(k) || contentKeys.includes(k) || NEXT_KEYS.includes(k)
      || KEPT_WITH_LISTS.includes(k) || k === 'omitted' || k === 'omittedCount' || (k.endsWith('Left') && contentKeys.includes(k.slice(0, -4)))));
    const coreFits = () => bytes(core(withOmitted())) <= visible;
    const rest = () => Object.keys(value).filter(k => !protectedKeys.has(k) && !contentKeys.includes(k) && !STATUS_KEYS.includes(k) && !NEXT_KEYS.includes(k)
      && !KEPT_WITH_LISTS.includes(k) && !/(?:Total|Count|Left)$/.test(k));
    const cutRest = (keys = rest()) => { for (const key of keys.sort((a, b) => bytes(value[b]) - bytes(value[a]))) { if (fits()) break; cut(value, key, [key]); } };
    const wholeContent = Object.fromEntries(contentKeys.map(k => [k, structuredClone(value[k])]));
    if (Array.isArray(value.problems) && !fits()) moveLongTexts(fits);
    // Nested diagnostics use the same compact representation and one recovery
    // call per list; their enclosing result object keeps its schema and scalars.
    for (const item of nestedContent) {
      if (fits()) break;
      const original = item.parent[item.key];
      if (item.subtree) {
        item.parent[item.key] = markerOf(original, { tool: 'ssam_evidence', arguments: { file: keep().file, pointer: pointer(item.keys), budgetBytes: READER_BUDGET } });
        moved = true;
        continue;
      }
      for (const step of COMPACT_STEPS) {
        item.parent[item.key] = original.map(entry => {
          if (!item.container || !object(entry)) return compactItem(entry, step);
          // Container identities stay structured. The list's shared reader
          // recovers all nested diagnostics without one pointer per item.
          return { ...Object.fromEntries(Object.entries(entry).filter(([, child]) => child === null || ['string', 'number', 'boolean'].includes(typeof child))), omitted: true };
        });
        lists[pointer(item.keys)] = { keys: item.keys, shown: original.length, oneToOne: sameJson(item.parent[item.key], original) };
        if (fits()) break;
      }
    }
    if (!fits() && coreFits()) cutRest();
    if (!fits()) {
      const before = Object.fromEntries(contentKeys.map(k => [k, value[k]]));
      compact: for (const k of [...contentKeys].reverse().filter(k => !KEPT_WITH_LISTS.includes(k))) {
        for (const step of COMPACT_STEPS) {
          value[k] = before[k].map((item, i) => {
            if (isMarker(item)) return item;
            const compact = compactItem(item, step);
            if (object(item) && object(compact)) for (const [field, child] of Object.entries(item)) {
              if (isMarker(child) || (object(child) && Object.values(child).some(isMarker))) compact[field] = child;
              else if (CONTINUATION_FIELDS.includes(field) || field === 'patch') {
                if (worthPointer(child) && !sameJson(child, compact[field])) compact[field] = markerOf(child, { tool: 'ssam_evidence', arguments: { file: keep().file, pointer: pointer([k, String(i), field]), budgetBytes: READER_BUDGET } });
              }
            }
            return compact;
          });
          if (coreFits()) break compact;
        }
      }
      for (const k of contentKeys) if (!sameJson(value[k], before[k])) lists[k] = { shown: value[k].length, oneToOne: false };
      if (coreFits()) cutRest();
    }
    if (!fits()) {
      cutRest();
      for (const key of NEXT_KEYS) {
        if (fits()) break;
        if (bytes(value[key]) > visible / 2 && !isMarker(value[key])) {
          value[key] = markerOf(value[key], { tool: 'ssam_evidence', arguments: { file: keep().file, pointer: pointer([key]), budgetBytes: READER_BUDGET } });
          moved = true;
        }
      }
      const whole = Object.fromEntries(contentKeys.map(k => [k, value[k]]));
      const ones = Object.fromEntries(contentKeys.map(k => [k, lists[k]?.oneToOne ?? oneToOne(k)]));
      const show = (k, n) => {
        value[k] = whole[k].slice(0, n);
        lists[k] = { shown: n, oneToOne: ones[k] };
        const left = (full[k + 'Left'] ?? 0) + whole[k].length - n;
        if (left) value[k + 'Left'] = left; else delete value[k + 'Left'];
      };
      for (const k of contentKeys) show(k, 0);
      for (const k of contentKeys) {
        let lo = 0, hi = whole[k].length;
        while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); show(k, mid); if (fits()) lo = mid; else hi = mid - 1; }
        show(k, lo);
      }
    }
    if (!fits()) cutRest([...protectedKeys].filter(k => Object.hasOwn(value, k) && !STATUS_KEYS.includes(k) && !NEXT_KEYS.includes(k) && !KEPT_WITH_LISTS.includes(k) && !contentKeys.includes(k)));
    for (const item of nestedContent) {
      if (fits()) break;
      if (item.subtree) continue;
      const total = item.parent[item.key].length;
      while (!fits() && item.parent[item.key].length) {
        item.parent[item.key].pop();
        const shown = item.parent[item.key].length;
        item.parent[item.key + 'Left'] = total - shown;
        lists[pointer(item.keys)] = { keys: item.keys, shown, oneToOne: lists[pointer(item.keys)]?.oneToOne ?? true };
      }
    }
    // A continuation or protected receipt can itself contain a large document.
    // Keep its small arguments/identities and recover the large subtree as a unit.
    while (!fits()) {
      const candidates = [];
      const collect = (node, keys = []) => {
        if (!node || typeof node !== 'object') return;
        for (const [key, child] of Object.entries(node)) {
          if (!keys.length && kind === 'read' && !READ_ENVELOPE.has(key) && !contentKeys.includes(key)) continue;
          if (isMarker(child) || contentList(key, child) || (!keys.length && (NEXT_KEYS.includes(key) || KEPT_WITH_LISTS.includes(key)))) continue;
          if (!keys.length && (contentKeys.includes(key) || (STATUS_KEYS.includes(key) && identityScalar(child)))) continue;
          if (object(child) || (Array.isArray(child) && nestedContent.some(item => [...keys,key].every((k,i) => k === item.keys[i])))) collect(child, [...keys, key]);
          else if (!contentList(key, child) && worthPointer(child)) candidates.push({ parent: node, key, keys: [...keys, key], size: bytes(child) });
        }
      };
      collect(value);
      const next = candidates.sort((a,b) => b.size - a.size)[0];
      if (!next || !cut(next.parent, next.key, next.keys)) break;
    }
    for (const key of NEXT_KEYS) {
      if (fits()) break;
      if (worthPointer(value[key]) && !isMarker(value[key])) {
        const original = value[key];
        value[key] = markerOf(original, { tool: 'ssam_evidence', arguments: { file: keep().file, pointer: pointer([key]), budgetBytes: READER_BUDGET } });
        moved = true;
      }
    }
    // Once a large route has moved out, promote diagnostics back to their
    // complete representation whenever that representation now fits.
    for (const k of contentKeys) {
      if (sameJson(value[k], wholeContent[k])) continue;
      const previous = value[k], left = value[k + 'Left'], entry = lists[k];
      value[k] = wholeContent[k]; if (full[k + 'Left']) value[k + 'Left'] = full[k + 'Left']; else delete value[k + 'Left']; delete lists[k];
      if (!fits()) { value[k] = previous; if (left !== undefined) value[k + 'Left'] = left; if (entry) lists[k] = entry; }
    }
  } else {
    // The answer ceiling of what is not bounded by the visible one (review vps-a9, E1): one answer under the ceiling, never a
    // page of it and never a second refusal.
    const ceiling = budgetCeiling(maxBytes);
    if (Array.isArray(value.problems) && bytes(withOmitted()) > ceiling) moveLongTexts(() => bytes(withOmitted()) <= ceiling);
  }
  if (!changed.length && !moved && !edited && !Object.keys(lists).length) {
    if (!bounded) return full;
    const result = ordered(withOmitted(), contentKeys);
    return sameJson(result, full) ? full : result;
  }
  let result = withOmitted();
  if (result.omitted?.tool === 'ssam_evidence') result.omitted = { ...result.omitted, fitted: true };
  if (bounded) result = ordered(result, contentKeys);
  if (kind === 'discoverFirst' && object(result.size) && typeof result.size.bytes === 'number') {
    for (let i = 0; i < 6 && result.size.bytes !== bytes(result); i++) result.size.bytes = bytes(result);
  }
  return result;
}

// Remember the producing contract for callers that finalize the same object.
// Explicit options remain available at transport boundaries that clone it.
const answerContexts = new WeakMap();
export function fitAnswer(tool, args = {}, full, options = {}) {
  const fitted = fitAnswerImpl(tool, args, full, options);
  if (object(fitted)) answerContexts.set(fitted, { tool, args, ...options });
  return fitted;
}

// The server supplies its already-resolved origin, including kind. All hosted
// answer readers use one common directory, independently of the active lane.
export function finalFitOptions({ workspace, tool, args = {}, origin }) {
  return { tool, args, root: workspace, directory: path.join(workspace, 'o11', 'answers'), origin };
}

// Storage failure cannot create recovery promises. Keep whole diagnostics that
// fit, the status and existing readers, and explicitly name the unsaved remainder.
function unstoredAnswer(answer, extraFields, maxBytes) {
  const value = { ...extraFields, storageNote: 'The remaining content could not be saved.' };
  const put = (key, child) => {
    if (Object.hasOwn(extraFields, key)) return;
    const previous = value[key];
    value[key] = child;
    if (bytes(value) <= maxBytes) return true;
    if (previous === undefined) delete value[key]; else value[key] = previous;
    return false;
  };
  for (const key of STATUS_KEYS) {
    if (!Object.hasOwn(answer, key)) continue;
    const child = answer[key];
    put(key, typeof child === 'string' ? oneLine(child.split(/\r?\n/)[0], 300) : child);
  }
  for (const [key, child] of Object.entries(answer)) {
    if (!STATUS_KEYS.includes(key) && key !== 'storageNote' && !key.endsWith('Left') && identityScalar(child)) put(key, child);
  }
  for (const key of ['omitted', 'errorDetail', 'studioWrites']) if (Object.hasOwn(answer, key)) put(key, answer[key]);
  const lists = Object.keys(answer).filter(key => contentList(key, answer[key]) || key === 'highWarnings' && Array.isArray(answer[key]))
    .sort((a, b) => listPriority(a) - listPriority(b) || a.localeCompare(b));
  for (const key of lists) {
    if (Object.hasOwn(extraFields, key)) continue;
    const items = answer[key], previousLeft = answer[key + 'Left'] ?? 0;
    value[key] = [];
    value[key + 'Left'] = items.length + previousLeft;
    let count = 0;
    for (const item of items) {
      value[key].push(item);
      value[key + 'Left']--;
      if (bytes(value) > maxBytes) { value[key].pop(); value[key + 'Left']++; break; }
      count++;
    }
    if (!value[key + 'Left']) delete value[key + 'Left'];
    if (!count && bytes(value) > maxBytes) { delete value[key]; delete value[key + 'Left']; }
  }
  return ordered(value, lists);
}

// The final pass owns storage when the original has not yet been kept. Read
// payloads and explicit packets retain their own pagination contract.
export function fitFinal(answer, extraFields = {}, options = {}) {
  const context = { ...answerContexts.get(answer), ...options };
  const { tool, args = {} } = context;
  const maxBytes = options.maxBytes ?? visibleAnswerBytes();
  const result = { ...answer, ...extraFields };
  if (typeof tool !== 'string' || !tool) return result;
  const kind = answerKind(tool, args, answer);
  const isRead = answer?.ok !== false && (kind === 'read' || kind === 'packet' || ['ssam-packet/1', 'ssam-packet-part/1'].includes(answer?.schemaVersion) || (tool === 'ssam_discover' && ['expand','detail','type','catalog'].some(k => args[k])));
  if (isRead || bytes(result) <= maxBytes) { answerContexts.set(result, context); return result; }
  try {
    const plain = Object.fromEntries(Object.entries(answer).filter(([k]) => !Object.hasOwn(extraFields, k)));
    const overhead = bytes({ ...plain, ...extraFields }) - bytes(plain);
    const root = context.root ?? process.cwd();
    const fitted = fitAnswer(tool, args, plain, { ...context, root, visibleBytes: Math.max(1, maxBytes - overhead) });
    const final = { ...fitted, ...extraFields };
    answerContexts.set(final, context);
    return final;
  } catch {
    const fallback = unstoredAnswer(answer, extraFields, maxBytes);
    answerContexts.set(fallback, context);
    return fallback;
  }
}

export function fitResult(tool, args, result, options) {
  if (!Array.isArray(result?.content)) return result;
  let full = result.structuredContent;
  if (full === undefined && result.content.length === 1 && result.content[0]?.type === 'text') {
    try { full = JSON.parse(result.content[0].text); } catch { full = result.content[0].text; }
  }
  const fitted = fitAnswer(tool, args, full, options);
  if (fitted === full) return result;
  return { ...result, content: result.content.map((c, i) => i === 0 && c?.type === 'text' ? { ...c, text: JSON.stringify(fitted) } : c),
    ...(result.structuredContent === undefined ? {} : { structuredContent: fitted }) };
}
