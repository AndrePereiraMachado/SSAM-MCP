// One output policy for both lanes. The saved document is the input, before any reduction.
import { clipText } from './text-clip.mjs';
import { hostedContext } from './executor.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fitProblems, CONTINUATION_FIELDS, withoutDocuments, detailsOf } from './refusal-problems.mjs';
import { missingCall, READER_BUDGET } from './paged-answer.mjs';
import { VERBATIM } from './responses.mjs';
import { writeAnswerOrigin } from './reference-files.mjs';

import { ANSWER_BUDGETS, EXPANSION_DEFAULT_BYTES, RECOVERY_PART_BYTES, budgetCeiling, maxAnswerBytes } from './context-budget.mjs';
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
const token = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const pointer = keys => keys.map(k => '/' + token(k)).join('');
// What stands in a refusal for a value a problem carries that went to the kept answer (a long detail, a text past the ceiling):
// what it was (its items, characters or bytes) and the exact read that returns it.
const DETAIL_INLINE_BYTES = 512;
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
  for (const keys of paths.slice(1)) { let n = 0; while (n < shared.length && shared[n] === keys[n]) n++; shared.length = n; }
  return shared;
}
function at(value, keys) { return keys.reduce((v, k) => v?.[k], value); }
// A single ancestor usually recovers every changed field. Large documents split at JSON
// boundaries, because the evidence reader must return values rather than lossy tables.
function recoverableParts(full, paths) {
  const split = keys => {
    const value = at(full, keys);
    if (bytes(value) < RECOVERY_PART_BYTES || !value || typeof value !== 'object') return [{ at: pointer(keys) }];
    if (Array.isArray(value)) {
      const largest = value.reduce((size, item) => Math.max(size, bytes(item)), 1);
      if (largest < RECOVERY_PART_BYTES) return [{ at: pointer(keys), max: Math.min(1000, Math.max(1, Math.floor(RECOVERY_PART_BYTES / largest))) }];
    }
    return Object.keys(value).flatMap(k => split([...keys, k]));
  };
  return split(commonPath(paths));
}
function recoveryCall(full, file, paths) {
  const parts = recoverableParts(full, paths);
  const omitted = missingCall(file, parts);
  for (const call of [omitted, ...(omitted.more ?? [])]) {
    const part = parts.find(p => p.at === call.arguments.pointer);
    if (part?.max) call.arguments.max = part.max;
  }
  return omitted;
}

// maxBytes: the ceiling the server pages above (ssam.mjs pageAnswer; the environment's by default).
export function fitAnswer(tool, args = {}, full, { root, directory, budgets = ANSWER_BUDGETS, origin = null, maxBytes = maxAnswerBytes() } = {}) {
  const originalFull = full;
  full = normalizeOutputWarnings(full);
  if (VERBATIM.has(tool) || full?.omitted?.tool === 'ssam_evidence' || full?.paged) return full;
  // Work packets own their budget. Explicit expansions retain their requested content;
  // only the surrounding metadata is fitted, at their requested (normally the shared expansion budget) budget.
  if (tool === 'ssam_discover' && (['ssam-packet/1', 'ssam-packet-part/1'].includes(full?.schemaVersion) || args.packet)) return full;
  if (full?.schemaVersion === 'ssam-tool-definition/1') return full;
  const expanded = tool === 'ssam_discover' && ['expand', 'detail', 'type', 'catalog'].some(k => args[k]);
  const kind = answerKind(tool, args, full);
  const budget = tool === 'ssam_discover' && Number.isFinite(args.budgetBytes) ? args.budgetBytes : expanded ? EXPANSION_DEFAULT_BYTES : (budgets[kind] ?? ANSWER_BUDGETS[kind]);
  if (!object(full)) {
    if (bytes(full) <= budget) return full;
    const saved = keepAnswer(originalFull, root, origin, { directory });
    return { ok: true, ...(Array.isArray(full) ? { count: full.length } : {}), omitted: recoveryCall(full, saved.file, [[]]) };
  }
  const value = structuredClone(full), changed = [];
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
  // (review vps-a9, E1: the part of the module a problem of a refusal carries to go on, refusal-problems.mjs DOCUMENT_FIELDS: the
  // screen's text now, the edit ready..., is outside the editorial budget, as the problems are: only the ceiling bounds it, below)
  const measured = v => bytes(kind === 'read' ? answerEnvelope(v)
    : kind === 'refusal' && Array.isArray(v?.problems) ? { ...v, problems: v.problems.map(withoutDocuments) } : v);
  let saved;
  const keep = () => (saved ??= keepAnswer(originalFull, root, origin, { directory }));
  const withOmitted = () => {
    if (!changed.length) return value;
    keep();
    return { ...value, ...(typeof full.omitted === 'number' ? { omittedCount: full.omitted } : {}), omitted: recoveryCall(originalFull, saved.file, changed) };
  };
  const tooLarge = () => measured(withOmitted()) > budget;

  if (kind === 'refusal' && Array.isArray(value.problems)) {
    const original = value.problems;
    const fitted = fitProblems(original, { budget, alwaysGroup: true, preserveAll: true });
    value.problems = fitted.problems;
    if (fitted.grouped) value.grouped = true;
    if (JSON.stringify(value.problems) !== JSON.stringify(original)) mark(['problems']);
    const count = value.problems.reduce((n, p) => n + (p.count ?? 1), 0);
    const codes = {};
    for (const p of value.problems) codes[p.code ?? 'PROBLEM'] = (codes[p.code ?? 'PROBLEM'] ?? 0) + (p.count ?? 1);
    if (typeof value.error === 'string' && original.some(p => typeof p?.message === 'string' && p.message && (value.error === p.message || (p.message.length >= 40 && value.error.includes(p.message))))) {
      value.error = `${count} problems: ${Object.entries(codes).map(([code, n]) => `${code} x${n}`).join(', ')}`;
      mark(['error']);
    }
    value.problems.forEach(p => {
      for (const [k, v] of Object.entries(p)) {
        if (v === null || (Array.isArray(v) && !v.length) || (object(v) && !Object.keys(v).length) || (k === 'fix' && v === p.message)) { delete p[k]; mark(['problems']); }
      }
      if (p.items) { delete p.items; mark(['problems']); }
      for (const k of ['message', 'fix']) if (typeof p[k] === 'string' && p[k].length > 300) { p[k] = clipText(p[k], 300); mark(['problems']); }
      // T16 (review): only a certain patch is in the verified union (verified-patch.mjs patchUnion); a choice keeps its own.
      // a12: hosted, never: a patch is sent explicitly there (verified-patch.mjs), so each problem keeps its own.
      if (!hostedContext() && value.verifiedPatch && p.patch && p.patchCertain === true && bytes(p.patch) > 512) { delete p.patch; p.patchIn = 'verifiedPatch'; mark(['problems']); }
    });
    if (!hostedContext() && value.verifiedPatch && value.patch && bytes(value.patch) > 512) { delete value.patch; value.patchIn = 'verifiedPatch'; mark(['patch']); }
  }

  // Review refusal-followups M-A (the owner's rule, one refusal with everything): before anything else leaves the answer, the
  // long details of its problems (refusal-problems.mjs detailsOf: the readings of a FLOW_SYNTAX, each the patch of the op with
  // the whole list of its flow texts; a long text), the longest first, go to the kept answer, and in the place of each the
  // problem says what it was and its exact read (markerOf). Every problem stays with its code, pointer, fix and k (where it is).
  let moved = false;
  if (kind === 'refusal' && Array.isArray(value.problems) && tooLarge()) {
    const source = Array.isArray(originalFull?.problems) ? originalFull.problems : [];
    const long = [];
    value.problems.forEach((p, i) => {
      if (object(p)) for (const [field, v] of Object.entries(detailsOf(p))) if (field !== 'k' && !isMarker(v) && bytes(v) > DETAIL_INLINE_BYTES) long.push({ i, field, v, size: bytes(v) });
    });
    for (const d of long.sort((a, b) => b.size - a.size)) {
      if (!tooLarge()) break;
      const same = JSON.stringify(d.v);
      // the same detail of a problem of the kept answer (a group carries its first member's)
      const j = source.findIndex(p => object(p) && JSON.stringify(p[d.field]) === same);
      if (j < 0) { delete value.problems[d.i][d.field]; mark(['problems']); continue; }
      value.problems[d.i][d.field] = markerOf(d.v, { tool: 'ssam_evidence', arguments: { file: keep().file, pointer: pointer(['problems', String(j), d.field]), budgetBytes: READER_BUDGET } });
      moved = true;
    }
  }

  if (value.continuation?.why && Array.isArray(value.nextCalls)) value.nextCalls.forEach((call, i) => {
    if (call.why === value.continuation.why) remove(call, 'why', ['nextCalls', String(i), 'why']);
  });
  if (kind === 'refusal' && typeof value.error === 'string' && value.error.length > 300) {
    value.error = clipText(value.error, 300); mark(['error']);
  }

  // Repeated explanation is removed even for answers below their byte budget. A call's
  // arguments are executable data, not prose, and read payloads are deliberately untouched.
  const seen = new Set();
  // HIGH prose has priority, but A03 forbids rewriting any HIGH entry. Seed the
  // same editorial strings before deduplicating the rest of the answer.
  const rememberHighProse = (node, proseArray = false) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'arguments' && typeof node.tool === 'string') continue;
      if (typeof child === 'string' && child.length >= 40 && (PROSE_FIELDS.has(key) || (Array.isArray(node) && proseArray))) seen.add(child);
      else rememberHighProse(child, Array.isArray(child) && (PROSE_FIELDS.has(key) || proseArray));
    }
  };
  rememberHighProse(value.highWarnings);
  const deduplicate = (node, keys = [], proseArray = false) => {
    if (!node || typeof node !== 'object') return;
    const priority = key => key === 'highWarnings' ? -2 : key === 'problems' ? -1 : 0;
    const entries = Object.entries(node).sort(([a], [b]) => priority(a) - priority(b));
    for (const [key, child] of entries) {
      if (key === 'highWarnings') continue; // A03: every HIGH entry stays complete, including repeated prose.
      if (key === 'studioWrites') continue; // fix-ext-refs round 4 (N6): the protected declaration of the Studio writes stays whole.
      if (key === 'arguments' && typeof node.tool === 'string') continue;
      if (kind === 'read' && keys.length === 0 && !READ_ENVELOPE.has(key)) continue;
      if (typeof child === 'string' && child.length >= 40 && (PROSE_FIELDS.has(key) || (Array.isArray(node) && proseArray))) {
        if (seen.has(child)) remove(node, key, [...keys, key]);
        else seen.add(child);
      } else deduplicate(child, [...keys, key], Array.isArray(child) && (PROSE_FIELDS.has(key) || proseArray));
    }
  };
  deduplicate(value);

  if ((kind === 'discoverFirst' || expanded) && tooLarge() && object(value.size)) {
    // Reduction metadata can cost more than the requested first answer. Its exact
    // discover calls remain in the saved size object, reached by the same reader.
    remove(value.size, 'truncated', ['size', 'truncated']);
  }
  if (expanded) {
    for (const key of ['hint', 'identity', 'coverage', 'lexical', 'notes', 'elapsedMs', 'size', 'nextCalls']) {
      if (!tooLarge()) break;
      remove(value, key, [key]);
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
      remove(value, key, [key]);
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
      if (key === 'summary' && object(value.summary)) {
        const counts = Object.fromEntries(Object.entries(value.summary).filter(([, n]) => typeof n === 'number'));
        if (Object.keys(counts).length) value.counts = { ...value.counts, ...counts };
      }
      if (parent) remove(parent, keys.at(-1), keys);
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
      remove(value.entityActions, key, ['entityActions', key]);
    }
  }
  if (kind === 'plan') {
    // X1 (ssam_code plan): the answer is the launch of the subagents. Each batch keeps its id, items and launchPrompt, the data
    // part its file and launchPrompt, and final and launch stay; what each prompt file already holds (its check, files and
    // sizes) goes first, recovered exactly here (ssam_evidence) and in the plan's own plan.json.
    for (const key of ['check', 'estimateBytes', 'promptBytes', 'files', 'promptFile']) {
      if (!tooLarge()) break;
      if (object(value.data)) remove(value.data, key, ['data', key]);
      (Array.isArray(value.batches) ? value.batches : []).forEach((batch, i) => { if (object(batch)) remove(batch, key, ['batches', String(i), key]); });
    }
  }
  if (kind === 'read') {
    for (const key of ['note', 'notes', 'timings', 'elapsedMs', 'size', 'store', 'index', 'cache', 'query', 'counts', 'notices', 'hidden']) { if (!tooLarge()) break; remove(value, key, [key]); }
    // HTML's way back and next page are executable contracts, not optional prose.
    // Dropping them made callers guess html/edit/edits despite a pinned reading.
    const htmlRoutes = value.schema === 'ssam-html/1' && object(value.continuations);
    if (htmlRoutes) {
      for (const key of ['note', 'keys', 'inspect']) {
        if (!tooLarge()) break;
        remove(value.continuations, key, ['continuations', key]);
      }
      // Duplicate capture locations are recoverable; the next/edit calls retain
      // their own exact targets and hashes, and sourceSha256 remains inline.
      for (const key of ['target', 'file', 'contentSha256', 'snapshotSha256', 'capture']) {
        if (!tooLarge()) break;
        remove(value, key, [key]);
      }
    }
    for (const key of ['nextCalls', 'continuations', 'next', 'continuation']) {
      if (!tooLarge()) break;
      if (htmlRoutes && key === 'continuations') continue;
      remove(value, key, [key]);
    }
  }
  // fix-ext-refs round 3 (F1): studioWrites, the short declaration of every Studio write a delivery made outside its merge
  // (o11-cycle.mjs studioWritesOf), is never dropped: the person always sees that the Studio changed the module.
  const protectedKeys = new Set(['ok', 'result', 'code', 'error', 'module', 'nextBasedOn', 'continuation', 'highWarnings', 'removed', 'removedTotal', 'counts', 'problems', 'grouped', 'verifiedPatch', 'patchIn', 'studioWrites',
    // The generators' receipts, compacted above, and the launch of a plan.
    ...(kind === 'receipt' ? ['integration', 'entityActions'] : []), ...(kind === 'plan' ? ['lane', 'action', 'planId', 'dir', 'data', 'batches', 'final', 'launch'] : [])]);
  if (kind !== 'read' && !expanded) {
    for (const key of Object.keys(value).filter(k => !protectedKeys.has(k) && !/(?:Total|Count)$/.test(k)).sort((a, b) => bytes(value[b]) - bytes(value[a]))) {
      if (!tooLarge()) break;
      remove(value, key, [key]);
    }
  }
  // (review vps-a9, E1: then the problems' own short details, candidates, text, corrected, an edit without basedOn: they stay in
  // the kept answer, read back exactly by the omitted call; the part of the module a problem carries stays, and so does its k,
  // where it is: review refusal-followups M-A)
  if (kind === 'refusal' && tooLarge()) {
    for (const p of value.problems ?? []) {
      if (!tooLarge()) break;
      const details = object(p) ? Object.entries(detailsOf(p)).filter(([key, v]) => key !== 'k' && !isMarker(v)).map(([key]) => key) : [];
      if (details.length) { for (const key of details) delete p[key]; mark(['problems']); }
    }
  }
  if (kind === 'refusal' && tooLarge()) {
    for (const p of value.problems ?? []) {
      if (!tooLarge()) break;
      if (p.patch) { const certain = p.patchCertain === true; delete p.patch; p.patchIn = value.verifiedPatch && certain ? 'verifiedPatch' : 'omitted'; mark(['problems']); }
    }
  }
  // Review vps-a9, E1: a long text a problem carries to go on (the screen's text now, the edit ready...) that would take the
  // answer past the ceiling goes, the longest first, to the kept answer, and in its place the problem says exactly where it is:
  // {omitted: true, characters, read: ssam_evidence {file, pointer, budgetBytes}}; a text longer than one read pages by
  // characters (pages says how). One answer under the ceiling, never a page of it and never a second refusal.
  const ceiling = budgetCeiling(maxBytes);
  if (Array.isArray(value.problems) && bytes(withOmitted()) > ceiling) {
    const leaves = [];
    const walk = (node, keys, i) => {
      if (isMarker(node)) return;
      if (typeof node === 'string') { if (node.length >= 256) leaves.push({ i, keys, text: node }); return; }
      if (Array.isArray(node)) node.forEach((child, j) => walk(child, [...keys, j], i));
      else if (object(node)) for (const [k, child] of Object.entries(node)) walk(child, [...keys, k], i);
    };
    value.problems.forEach((p, i) => { if (object(p)) for (const field of CONTINUATION_FIELDS) if (p[field] != null) walk(p[field], [field], i); });
    const source = Array.isArray(originalFull?.problems) ? originalFull.problems : [];
    for (const leaf of leaves.sort((a, b) => b.text.length - a.text.length)) {
      if (bytes(withOmitted()) <= ceiling) break;
      // the same text at the same place of a problem of the kept answer (a group keeps its first member's)
      const j = source.findIndex(p => at(p, leaf.keys) === leaf.text);
      if (j < 0) continue;
      const read = { tool: 'ssam_evidence', arguments: { file: keep().file, pointer: pointer(['problems', String(j), ...leaf.keys.map(String)]), budgetBytes: READER_BUDGET } };
      at(value.problems[leaf.i], leaf.keys.slice(0, -1))[leaf.keys.at(-1)] = markerOf(leaf.text, read);
      moved = true;
    }
  }
  if (!changed.length && !moved) return full;
  const result = withOmitted();
  if (kind === 'discoverFirst' && object(result.size) && typeof result.size.bytes === 'number') {
    for (let i = 0; i < 6 && result.size.bytes !== bytes(result); i++) result.size.bytes = bytes(result);
  }
  return result;
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
