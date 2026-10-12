// Public read-scope: one command reads every root of the observed frame to its
// leaves through the existing native inspection ops and returns the computed
// scopeCompleteness. Values are the native evaluator responses as returned
// (after the worker's own privacy filtering); nothing is filled in or inferred.
// A stale stop or expiry aborts the whole read; a budget stop is budget-omitted.
import { scopeCompleteness, completenessBinding } from './debug-scope-completeness.mjs';
const fail = code => { throw new Error('debug_read_scope_' + code); };
export const READ_SCOPE_MAX_NODES = 20000;
const PAGE = 150, BATCH = 500, MAX_LEVELS = 64;
const codeOf = error => typeof error === 'string' ? error : /^debug_[a-z0-9_:.@-]+$/i.test(error?.message ?? '') ? error.message : 'debug_read_scope_failed';
// Stale and expired bindings never yield a partial result.
const refusal = code => new Error(/stale/.test(code) ? 'debug_read_scope_stale_stop'
  : /expired|cancelled|not_connected|unreachable/.test(code) ? 'debug_read_scope_expired' : code);
function nodeBudget(maxNodes) {
  if (maxNodes === undefined) return READ_SCOPE_MAX_NODES;
  return Number.isSafeInteger(maxNodes) && maxNodes >= 1 && maxNodes <= READ_SCOPE_MAX_NODES ? maxNodes : fail('input_invalid');
}
async function settle(work) {
  let result;
  try { result = await work(); } catch (error) { throw refusal(codeOf(error)); }
  if (result?.ok === false) throw refusal(typeof result.error === 'string' ? result.error : 'debug_read_scope_failed');
  return result;
}

// The coordinator runs read-scope as one entry of its command queue: a step
// or another read submitted meanwhile waits until the whole traversal settles.
export function serializeReadScope(holder, work) {
  const task = holder.commands.then(work); holder.commands = task.catch(() => {}); return task;
}

// Budget stops replace the pending reason of the references they cut off; the
// aggregator's native and policy reasons are never rewritten.
function finish({ lane, runtime, stopKey, generation, scope, reads, omitted, budget, commands, nodes, extra }) {
  let completeness;
  try { completeness = scopeCompleteness({ lane, runtime, stop: stopKey, generation, metadataCoverage: scope.metadataCoverage,
    scopeVariables: runtime === 'client' ? scope.variables : scope, reads }); }
  catch (error) { throw refusal(codeOf(error)); }
  if (completeness.ok === true && omitted.size) completeness = { ...completeness, incompleteLeaves: completeness.incompleteLeaves.map(leaf =>
    omitted.has(leaf.reference) && ['not-read', 'page-pending', 'text-pending'].includes(leaf.reason)
      ? { ...leaf, reason: 'budget-omitted', detail: { budget: omitted.get(leaf.reference), pending: leaf.reason, ...(leaf.detail ?? {}) } } : leaf) };
  const bound = completenessBinding(completeness, runtime === 'client' ? scope : scope.context, scope.metadataCoverage?.variableCounts);
  const reasons = [...new Set(omitted.values())], exhausted = omitted.size > 0;
  return { ok: true, op: 'read-scope', runtime, lane, ...extra, scope, reads, nodesObserved: nodes, nativeCommands: commands,
    budget: { maxNodes: budget, exhausted, omitted: omitted.size, ...(exhausted ? { reason: reasons[0], reasons } : {}) },
    scopeCompleteness: completeness,
    metadataCoverage: scope.metadataCoverage ? { ...scope.metadataCoverage, runtimeValuesComplete: bound?.runtimeValuesComplete === true,
      ...(bound ? { residualNativeLimitsOnly: bound.residualNativeLimitsOnly } : {}) } : null,
    runtimeValuesComplete: completeness.runtimeValuesComplete === true, residualNativeLimitsOnly: completeness.residualNativeLimitsOnly === true,
    complete: completeness.ok === true && completeness.runtimeValuesComplete === true && !exhausted, valuesReturned: true };
}

// handle: { scope() -> bound scope reply (bindFrameScope + scope + frame-bound
// metadataCoverage), inspection(command) -> native client reply, current() ->
// true while the observed stop/generation is still paused and unexpired }.
export async function readClientScope(handle, { lane, stop, generation, detail = 1, maxNodes, textLimit = 65536 } = {}) {
  if (!handle || ['scope', 'inspection', 'current'].some(k => typeof handle[k] !== 'function')) fail('handle_invalid');
  if (!['o11', 'odc'].includes(lane) || !Number.isSafeInteger(stop) || stop < 1 || !Number.isSafeInteger(generation) || generation < 0 ||
      !Number.isInteger(detail) || detail < 0 || detail > 8 || !Number.isInteger(textLimit) || textLimit < 1 || textLimit > 65536) fail('input_invalid');
  const budget = nodeBudget(maxNodes), reads = [], omitted = new Map();
  let commands = 0, nodes = 0;
  const live = () => { if (handle.current() !== true) fail('stale_stop'); };
  const bound = r => { if (r?.stop !== stop || r?.generation !== generation) fail('stale_stop'); };
  const call = async command => { live(); commands++; const r = await settle(() => handle.inspection(command)); bound(r); live(); reads.push(r); return r; };
  live(); commands++;
  const scope = await settle(() => handle.scope());
  bound(scope); live();
  if (!Array.isArray(scope.variables) || scope.variables.some(v => typeof v?.ref !== 'string')) fail('scope_invalid');
  const roots = scope.variables.map(v => v.ref);
  for (const ref of roots.slice(budget)) omitted.set(ref, 'maxNodes');
  let level = roots.slice(0, budget); nodes = level.length;
  for (let depth = 0; level.length; depth++) {
    if (depth > MAX_LEVELS) fail('tree_invalid');
    const containers = [], texts = [], next = [];
    // Every reference gets its own native evaluation; a parent page never proves a leaf.
    for (let i = 0; i < level.length; i += BATCH) {
      const r = await call({ op: 'read-many', refs: level.slice(i, i + BATCH), detail });
      if (!Array.isArray(r.values)) fail('read_invalid');
      for (const v of r.values) {
        if (!v || v.ok === false) continue; // native unavailable-in-context stays as reported
        if (v.omitted === true) { if (v.continuation?.op === 'slice') texts.push(v.ref); continue; }
        // A natively deferred compound (null wire) is kept as deferred, never paged.
        if (v.expandable === true && v.value?.value && typeof v.value.value === 'object') containers.push(v.ref);
      }
    }
    for (const ref of containers) for (let offset = 0; ;) {
      const remaining = budget - nodes;
      if (remaining <= 0) { omitted.set(ref, 'maxNodes'); break; }
      const page = await call({ op: 'children', ref, offset, limit: Math.min(PAGE, remaining) });
      if (!Array.isArray(page.children) || page.children.some(c => typeof c?.ref !== 'string')) fail('read_invalid');
      nodes += page.children.length; next.push(...page.children.map(c => c.ref));
      if (page.nextOffset == null) break;
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) fail('read_invalid');
      offset = page.nextOffset;
    }
    for (const ref of texts) for (let offset = 0; ;) {
      const page = await call({ op: 'slice', ref, offset, limit: textLimit });
      if (page.nextOffset == null) break;
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) fail('read_invalid');
      offset = page.nextOffset;
    }
    level = next;
  }
  return finish({ lane, runtime: 'client', stopKey: stop, generation, scope, reads, omitted, budget, commands, nodes,
    extra: { stop, generation } });
}

// ops: { scope() -> ensureScope result, readFrame?(cmd), readMany(cmd), read(cmd)
// (existing worker ops for this threadId/eventId), current() -> true while the
// observed stop is still held, admit?(op) -> false under the request-hold cut }.
export async function readServerScope(ops, { lane, threadId, eventId, generation, depth = 1, maxNodes, textLimit = 16384 } = {}) {
  if (!ops || ['scope', 'readMany', 'read', 'current'].some(k => typeof ops[k] !== 'function')) fail('handle_invalid');
  if (!['o11', 'odc'].includes(lane) || typeof threadId !== 'string' || !threadId || threadId.length > 200 || !/^\d+$/.test(eventId ?? '') ||
      !Number.isSafeInteger(generation) || generation < 1 || !Number.isInteger(depth) || depth < 0 || depth > 4 ||
      !Number.isInteger(textLimit) || textLimit < 1 || textLimit > 16384) fail('input_invalid');
  const budget = nodeBudget(maxNodes), reads = [], omitted = new Map(), seen = new Set(), done = new Set(), queued = new Set();
  const toRead = [], pages = [], texts = [], unavailable = Symbol('unavailable');
  let commands = 0, halted = null, nativeGeneration;
  const live = () => { if (ops.current() !== true) fail('stale_stop'); };
  const bound = r => { const c = r?.context; if (c?.threadId !== threadId || c?.eventId !== eventId || c?.generation !== nativeGeneration) fail('stale_stop'); };
  const omit = (ref, reason) => { if (!omitted.has(ref)) omitted.set(ref, reason); };
  // null: a budget (native reference limit or request hold) halted the read.
  async function call(name, command, optional = false) {
    live();
    if (typeof ops.admit === 'function' && ops.admit(name) !== true) { halted = 'request-hold'; return null; }
    commands++;
    let r, code;
    try { r = await ops[name](command); } catch (error) { code = codeOf(error); }
    if (!code && r?.ok === false) code = typeof r.error === 'string' ? r.error : 'debug_read_scope_failed';
    if (code) {
      if (/inspection_reference_limit/.test(code)) { halted = 'reference-limit'; return null; }
      if (/request_hold_budget_low/.test(code)) { halted = 'request-hold'; return null; }
      if (optional && /unknown_operation|invalid_operation|operation_invalid/.test(code)) return unavailable;
      throw refusal(code);
    }
    bound(r); live(); reads.push(r); return r;
  }
  const scalar = v => ['Scalar', 'Unknown'].includes(v?.type) && v.hasChildren !== true;
  const clean = v => !['redacted', 'unavailable', 'undefined', 'nativeSummary', 'trimmed', 'deferred'].some(k => v[k] === true);
  const queue = (list, ref, offset) => { const id = list === pages ? 'p:' + ref + ':' + offset : 't:' + ref + ':' + offset;
    if (!queued.has(id)) { queued.add(id); list.push([ref, offset]); } };
  function ingest(r) {
    if (typeof r?.reference !== 'string' || !r.value || typeof r.value !== 'object' || !Array.isArray(r.children ?? [])) fail('read_invalid');
    bound(r); done.add(r.reference); seen.add(r.reference);
    if (scalar(r.value)) { if (r.value.nextTextOffset != null && clean(r.value)) queue(texts, r.reference, r.value.nextTextOffset); }
    else if (r.nextOffset != null && r.redacted !== true) queue(pages, r.reference, r.nextOffset);
    for (const child of r.children ?? []) {
      if (typeof child?.reference !== 'string') fail('read_invalid');
      seen.add(child.reference);
      if (child.redacted === true) continue; // described as redacted by its parent page; never expanded
      if (!scalar(child)) toRead.push(child.reference);
      else if (child.nextTextOffset != null && clean(child)) queue(texts, child.reference, child.nextTextOffset);
    }
  }
  live(); commands++;
  const scope = await settle(() => ops.scope());
  const context = scope?.context;
  if (context?.threadId !== threadId || context?.eventId !== eventId || !Number.isSafeInteger(context.generation)) fail('stale_stop');
  if (!Array.isArray(scope.variables) || scope.variables.some(v => typeof v?.reference !== 'string')) fail('scope_invalid');
  nativeGeneration = context.generation; live();
  const roots = scope.variables.map(v => v.reference);
  roots.forEach(ref => seen.add(ref));
  // Inside the hold budget the native read-frame reads the frame in one command;
  // the existing ops continue only what it left (pending, pages, text pages).
  let readFrameUsed = false;
  if (typeof ops.readFrame === 'function') {
    const r = await call('readFrame', { maxNodes: budget, offset: 0, depth, textOffset: 0, textLimit }, true);
    if (r && r !== unavailable) {
      if (!Array.isArray(r.values) || !Array.isArray(r.pending)) fail('read_invalid');
      readFrameUsed = true; r.values.forEach(ingest);
      for (const ref of r.pending) { if (typeof ref !== 'string') fail('read_invalid'); seen.add(ref); toRead.push(ref); }
    }
  }
  for (const ref of roots) if (!done.has(ref)) toRead.push(ref);
  for (let rounds = 0; !halted && (toRead.length || pages.length || texts.length); rounds++) {
    if (rounds > 100000) fail('tree_invalid');
    const pending = [...new Set(toRead.splice(0))].filter(ref => !done.has(ref));
    for (let i = 0; i < pending.length;) {
      const left = budget - seen.size;
      if (halted || left <= 0) { pending.slice(i).forEach(ref => omit(ref, halted ?? 'maxNodes')); break; }
      // Each reference may add one children page: plan the batch against the budget.
      const size = Math.min(BATCH, Math.max(1, Math.floor(left / PAGE))), batch = pending.slice(i, i + size);
      const r = await call('readMany', { references: batch, offset: 0, limit: Math.min(PAGE, Math.max(1, Math.floor(left / batch.length))), textOffset: 0, textLimit, depth });
      if (!r) { pending.slice(i).forEach(ref => omit(ref, halted)); break; }
      if (!Array.isArray(r.values)) fail('read_invalid');
      r.values.forEach(ingest); i += batch.length;
    }
    for (const [ref, offset] of pages.splice(0)) {
      const left = budget - seen.size;
      if (halted || left <= 0) { omit(ref, halted ?? 'maxNodes'); continue; }
      const r = await call('read', { reference: ref, offset, limit: Math.min(PAGE, left), textOffset: 0, textLimit, depth });
      if (r) ingest(r); else omit(ref, halted);
    }
    for (const [ref, textOffset] of texts.splice(0)) {
      if (halted) { omit(ref, halted); continue; }
      const r = await call('read', { reference: ref, offset: 0, limit: 1, textOffset, textLimit, depth });
      if (r) ingest(r); else omit(ref, halted);
    }
  }
  if (halted) { toRead.forEach(ref => { if (!done.has(ref)) omit(ref, halted); }); pages.forEach(([ref]) => omit(ref, halted)); texts.forEach(([ref]) => omit(ref, halted)); }
  return finish({ lane, runtime: 'server', stopKey: { threadId, eventId }, generation: nativeGeneration, scope, reads, omitted, budget, commands,
    nodes: seen.size, extra: { threadId, eventId, context, readFrameUsed } });
}

export const readScopeDescription = Object.freeze({
  client: 'read-scope {stop, generation, detail? (0..8, default 1), maxNodes? (default and cap 20000), textLimit? (1..65536, default 65536)} binds the frame scope like scope, then reads every root with read-many in batches of 500, pages every expandable value with children (limit 150) recursively, reads each child through its own reference and follows slice continuations until nextOffset is null; it runs as one entry of the session command queue, so no step interleaves. Returns the native responses (reads), scopeCompleteness computed from them and metadataCoverage bound to the same stop, generation and frame-bound counts; complete is true only when runtimeValuesComplete is true and no budget stopped the read. A stale stop or expiry refuses the whole read (debug_read_scope_stale_stop / debug_read_scope_expired); a maxNodes overrun leaves budget-omitted leaves, never a truncated success. Natively deferred, unavailable, binary-summary and redacted values keep their own reasons; private leaves need a separate private-read. Implemented, live proof pending.',
  server: 'read-scope {threadId, eventId, generation, depth? (0..4), maxNodes? (default and cap 20000), textLimit? (1..16384, default 16384)} binds the frame scope like scope (it may consume the generation; use the returned one), then reads the whole frame: native read-frame first inside the request-hold budget, then only what it left with the existing worker ops: read-many (500 references, children offset 0 limit 150), per-reference read for children pages (offset/limit 150) and textOffset pages until nextTextOffset is null. Returns the native responses (reads), scopeCompleteness and bound metadataCoverage; complete is true only when runtimeValuesComplete is true and no budget stopped the read. The native reference limit (debug_inspection_reference_limit, 20000), the request-hold cut and maxNodes classify the cut-off leaves as budget-omitted, never a truncated success; a stale stop or expiry refuses the whole read. Implemented, live proof pending.',
});
