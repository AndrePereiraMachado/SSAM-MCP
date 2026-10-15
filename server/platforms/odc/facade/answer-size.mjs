// One output policy for both lanes. The saved document is the input, before any reduction.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fitProblems } from './refusal-problems.mjs';
import { missingCall } from './paged-answer.mjs';
import { VERBATIM } from './responses.mjs';

export const ANSWER_BUDGETS = Object.freeze({ discoverFirst: 5120, receipt: 2048, refusal: 8192, read: 1536, other: 4096, plan: 4096 });
const bytes = value => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROSE_FIELDS = new Set(['error', 'errors', 'message', 'messages', 'warnings', 'fix', 'why', 'note', 'notes', 'hint', 'description', 'summary', 'title', 'detail', 'details', 'guidance', 'reason', 'recover', 'next']);
const token = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const pointer = keys => keys.map(k => '/' + token(k)).join('');
const delivery = new Set(['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job']);
export function answerKind(tool, args = {}, value) {
  if (value?.ok === false) return 'refusal';
  if (delivery.has(tool) || (tool === 'ssam_code' && (args.action ?? args.mode) === 'write')) return 'receipt';
  // X1: the answer of ssam_code plan is the launch of its subagents (fitAnswer keeps every batch's launchPrompt).
  if (tool === 'ssam_code' && (args.action ?? args.mode) === 'plan') return 'plan';
  if (tool === 'ssam_discover' && !['expand', 'detail', 'type', 'packet', 'catalog'].some(k => args[k])) return 'discoverFirst';
  if (['ssam_map', 'ssam_reference', 'o11_inspect', 'studio_inspect'].includes(tool)) return 'read';
  return 'other';
}

// directory: where the file goes (default <root>/.local/answers; a hosted session passes the customer's <ws>/o11/answers,
// servidor/fase4-25, so the files of one customer are never in the server's root and only that customer's ssam_evidence reads them).
export function keepAnswer(full, root, directory = path.join(root, '.local', 'answers')) {
  const body = JSON.stringify(full);
  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const file = path.join(directory, sha256 + '.json');
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(file)) {
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, body, 'utf8');
    fs.renameSync(temporary, file);
  }
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
    if (bytes(value) < 60000 || !value || typeof value !== 'object') return [{ at: pointer(keys) }];
    if (Array.isArray(value)) {
      const largest = value.reduce((size, item) => Math.max(size, bytes(item)), 1);
      if (largest < 52000) return [{ at: pointer(keys), max: Math.min(1000, Math.max(1, Math.floor(52000 / largest))) }];
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

export function fitAnswer(tool, args = {}, full, { root, directory, budgets = ANSWER_BUDGETS } = {}) {
  if (VERBATIM.has(tool) || full?.omitted?.tool === 'ssam_evidence' || full?.paged) return full;
  // Work packets own their budget. Explicit expansions retain their requested content;
  // only the surrounding metadata is fitted, at their requested (normally 40 KB) budget.
  if (tool === 'ssam_discover' && (full?.schemaVersion === 'ssam-packet/1' || args.packet)) return full;
  const expanded = tool === 'ssam_discover' && ['expand', 'detail', 'type', 'catalog'].some(k => args[k]);
  const kind = answerKind(tool, args, full);
  const budget = tool === 'ssam_discover' && Number.isFinite(args.budgetBytes) ? args.budgetBytes : expanded ? 40960 : (budgets[kind] ?? ANSWER_BUDGETS[kind]);
  if (!object(full)) {
    if (bytes(full) <= budget) return full;
    const saved = keepAnswer(full, root, directory);
    return { ok: true, ...(Array.isArray(full) ? { count: full.length } : {}), omitted: recoveryCall(full, saved.file, [[]]) };
  }
  const value = structuredClone(full), changed = [];
  const mark = keys => { if (!changed.some(p => pointer(p) === pointer(keys))) changed.push(keys); };
  const remove = (parent, key, keys) => { if (Object.hasOwn(parent, key)) { delete parent[key]; mark(keys); } };
  const measured = v => bytes(kind === 'read' ? answerEnvelope(v) : v);
  let saved;
  const withOmitted = () => {
    if (!changed.length) return value;
    saved ??= keepAnswer(full, root, directory);
    return { ...value, ...(typeof full.omitted === 'number' ? { omittedCount: full.omitted } : {}), omitted: recoveryCall(full, saved.file, changed) };
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
      for (const k of ['message', 'fix']) if (typeof p[k] === 'string' && p[k].length > 300) { p[k] = p[k].slice(0, 299) + '…'; mark(['problems']); }
      if (value.verifiedPatch && p.patch && bytes(p.patch) > 512) { delete p.patch; p.patchIn = 'verifiedPatch'; mark(['problems']); }
    });
    if (value.verifiedPatch && value.patch && bytes(value.patch) > 512) { delete value.patch; value.patchIn = 'verifiedPatch'; mark(['patch']); }
  }

  if (value.continuation?.why && Array.isArray(value.nextCalls)) value.nextCalls.forEach((call, i) => {
    if (call.why === value.continuation.why) remove(call, 'why', ['nextCalls', String(i), 'why']);
  });
  if (kind === 'refusal' && typeof value.error === 'string' && value.error.length > 300) {
    value.error = value.error.slice(0, 299) + '…'; mark(['error']);
  }

  // Repeated explanation is removed even for answers below their byte budget. A call's
  // arguments are executable data, not prose, and read payloads are deliberately untouched.
  const seen = new Set();
  const deduplicate = (node, keys = [], proseArray = false) => {
    if (!node || typeof node !== 'object') return;
    const priority = key => key === 'highWarnings' ? -2 : key === 'problems' ? -1 : 0;
    const entries = Object.entries(node).sort(([a], [b]) => priority(a) - priority(b));
    for (const [key, child] of entries) {
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
    for (const key of ['nextCalls', 'continuations', 'next', 'continuation']) {
      if (!tooLarge()) break;
      remove(value, key, [key]);
    }
  }
  const protectedKeys = new Set(['ok', 'result', 'code', 'error', 'module', 'nextBasedOn', 'continuation', 'highWarnings', 'removed', 'removedTotal', 'counts', 'problems', 'grouped', 'verifiedPatch', 'patchIn',
    // The generators' receipts, compacted above, and the launch of a plan.
    ...(kind === 'receipt' ? ['integration', 'entityActions'] : []), ...(kind === 'plan' ? ['lane', 'action', 'planId', 'dir', 'data', 'batches', 'final', 'launch'] : [])]);
  if (kind !== 'read' && !expanded) {
    for (const key of Object.keys(value).filter(k => !protectedKeys.has(k) && !/(?:Total|Count)$/.test(k)).sort((a, b) => bytes(value[b]) - bytes(value[a]))) {
      if (!tooLarge()) break;
      remove(value, key, [key]);
    }
  }
  if (kind === 'refusal' && tooLarge()) {
    for (const p of value.problems ?? []) {
      if (!tooLarge()) break;
      if (p.patch) { delete p.patch; p.patchIn = value.verifiedPatch ? 'verifiedPatch' : 'omitted'; mark(['problems']); }
    }
  }
  if (!changed.length) return full;
  const result = withOmitted();
  if (kind === 'discoverFirst' && object(result.size) && typeof result.size.bytes === 'number') {
    for (let i = 0; i < 6 && result.size.bytes !== bytes(result); i++) result.size.bytes = bytes(result);
  }
  return result;
}

export function fitResult(tool, args, result, options) {
  if (VERBATIM.has(tool) || !Array.isArray(result?.content)) return result;
  let full = result.structuredContent;
  if (full === undefined && result.content.length === 1 && result.content[0]?.type === 'text') {
    try { full = JSON.parse(result.content[0].text); } catch { full = result.content[0].text; }
  }
  const fitted = fitAnswer(tool, args, full, options);
  if (fitted === full) return result;
  return { ...result, content: result.content.map((c, i) => i === 0 && c?.type === 'text' ? { ...c, text: JSON.stringify(fitted) } : c),
    ...(result.structuredContent === undefined ? {} : { structuredContent: fitted }) };
}
