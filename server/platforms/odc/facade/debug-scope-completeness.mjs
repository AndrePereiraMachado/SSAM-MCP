// Per-stop scope completeness from native read evidence. It never fills in a
// value or infers a leaf: every complete leaf needs its own native read/page,
// and every incomplete leaf keeps the native or policy reason that explains it.
const fail = code => { throw new Error('debug_scope_completeness_' + code); };
export const scopeLeafReasons = Object.freeze(['not-read', 'page-pending', 'text-pending', 'deferred', 'trimmed', 'budget-omitted',
  'private-redacted', 'native-unavailable-in-context', 'native-undefined', 'native-binary-summary']);
const nativeReasons = new Set(['native-unavailable-in-context', 'native-undefined', 'native-binary-summary']);
// Native flags only. Quoted Text that spells a sentinel is data: the server
// Describe() and the SDK's IsUnavailable decide, never a string match here.
const nativeFlags = [['unavailable', 'native-unavailable-in-context'], ['undefined', 'native-undefined'], ['nativeSummary', 'native-binary-summary']];
const serverScalar = new Set(['Scalar', 'Unknown']), clientCompound = new Set(['Record', 'RecordList']);
const indexPath = /\.\[(?:0|[1-9][0-9]{0,8})\]$/, indexName = /^\[(?:0|[1-9][0-9]{0,8})\]$/;

// Client stop counter, or server threadId plus decimal eventId.
function stopOf(runtime, stop) {
  if (runtime === 'client') return Number.isSafeInteger(stop) && stop >= 0 ? 'client:' + stop : fail('input_invalid');
  const at = typeof stop === 'string' ? stop.lastIndexOf(':') : -1;
  const [threadId, eventId] = typeof stop === 'string' ? [stop.slice(0, at), stop.slice(at + 1)] : [stop?.threadId, stop?.eventId];
  if (typeof threadId !== 'string' || !threadId || threadId.length > 200 || !/^\d+$/.test(eventId ?? '')) fail('input_invalid');
  return 'server:' + threadId + ':' + eventId;
}
function readStop(runtime, r) {
  const c = runtime === 'client' ? r : r?.context;
  if (!c || !Number.isInteger(c.generation) || (runtime === 'client' ? !Number.isSafeInteger(c.stop)
    : typeof c.threadId !== 'string' || typeof c.eventId !== 'string')) fail('read_context_missing');
  return { stop: runtime === 'client' ? 'client:' + c.stop : 'server:' + c.threadId + ':' + c.eventId, generation: c.generation };
}
function countsOf(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  const out = {};
  for (const [category, n] of Object.entries(counts)) { if (!Number.isSafeInteger(n) || n < 0) return null; if (n) out[category] = n; }
  return out;
}
const sameCounts = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => (a[k] ?? 0) === (b[k] ?? 0));
function rootsOf(runtime, scopeVariables, expected) {
  let list = scopeVariables;
  const bound = item => { const s = readStop(runtime, item); if (expected && (s.stop !== expected.stop || s.generation !== expected.generation)) fail('stale_scope'); };
  if (list && typeof list === 'object' && !Array.isArray(list)) { if (list.context !== undefined || list.stop !== undefined) bound(list); list = list.variables; }
  if (!Array.isArray(list)) fail('scope_invalid');
  const seen = new Set();
  return list.map(v => {
    const ref = runtime === 'client' ? v?.ref : v?.reference;
    if (typeof ref !== 'string' || !ref || seen.has(ref) || typeof v.category !== 'string' || !v.category) fail('scope_invalid');
    if (runtime === 'client' && v.stop !== undefined) bound(v);
    seen.add(ref);
    return { ref, name: v.name ?? null, category: v.category, path: runtime === 'client' ? v.nativePath ?? v.name ?? null : null };
  });
}

// Index every native observation by reference. Reads from another stop or an
// older generation are refused: completeness never mixes bindings.
function evidence(runtime, reads, expected) {
  if (!Array.isArray(reads)) fail('input_invalid');
  const ev = { nodes: new Map(), pages: new Map(), texts: new Map(), privateReads: new Set() };
  let order = 0;
  const push = (map, ref, item) => { if (!map.has(ref)) map.set(ref, []); map.get(ref).push({ ...item, order: order++ }); };
  const bound = r => { const s = readStop(runtime, r); if (s.stop !== expected.stop || s.generation !== expected.generation) fail('stale_read'); };
  const clean = v => !['redacted', 'unavailable', 'undefined', 'nativeSummary', 'trimmed', 'deferred'].some(k => v[k] === true);
  const text = (ref, v) => { if (clean(v) && Number.isSafeInteger(v.textOffset) && Number.isSafeInteger(v.textLength))
    push(ev.texts, ref, { offset: v.textOffset, next: v.nextTextOffset ?? null, total: v.textLength }); };
  function server(r) {
    if (r.ok === false) return;
    if (typeof r.reference !== 'string') fail('read_invalid');
    if (r.privateValueReturnedPublicly === false) { ev.privateReads.add(r.reference); return; }
    if (r.omitted === true) { push(ev.nodes, r.reference, { omitted: true }); return; }
    const v = r.value, children = r.children ?? [];
    if (!v || typeof v !== 'object' || !Array.isArray(children)) fail('read_invalid');
    push(ev.nodes, r.reference, { value: v });
    if (serverScalar.has(v.type)) text(r.reference, v);
    // A sensitive compound is blocked natively: no page, redacted container.
    else push(ev.pages, r.reference, { offset: r.offset, items: children, nextOffset: r.nextOffset ?? null, total: r.availableChildren,
      coverage: r.collectionCoverage ?? null, blocked: r.redacted === true && children.length === 0,
      deferred: r.deferred === true || v.deferred === true, trimmed: r.nativeTrimmed === true || v.trimmed === true });
    for (const child of children) {
      if (!child || typeof child.reference !== 'string') fail('read_invalid');
      push(ev.nodes, child.reference, { value: child });
      if (serverScalar.has(child.type)) text(child.reference, child);
    }
  }
  function client(r) {
    if (typeof r.ref !== 'string') fail('read_invalid');
    if (r.privateValueReturnedPublicly === false) { ev.privateReads.add(r.ref); return; }
    if (r.ok === false) { if (r.unavailable === true) push(ev.nodes, r.ref, { unavailable: true, error: r.error ?? null }); return; }
    if (r.unit === 'utf16-code-unit') { if (r.redacted !== true) push(ev.texts, r.ref, { offset: r.offset, next: r.nextOffset ?? null, total: r.total }); return; }
    if (Array.isArray(r.children) && !('value' in r)) { push(ev.pages, r.ref, { offset: r.offset, items: r.children, nextOffset: r.nextOffset ?? null, total: r.total }); return; }
    if (r.omitted === true) { push(ev.nodes, r.ref, { omitted: true }); return; }
    if (!('value' in r)) fail('read_invalid');
    push(ev.nodes, r.ref, { value: r.value, read: r });
  }
  const add = runtime === 'client' ? client : server;
  for (const r of reads) {
    if (!r || typeof r !== 'object') fail('read_invalid');
    bound(r);
    if (!Array.isArray(r.values)) { add(r); continue; }
    for (const v of r.values) { if (!v || typeof v !== 'object') fail('read_invalid'); bound(v); add(v); }
  }
  return ev;
}
const latest = (list, pick = () => true) => { let best; for (const x of list ?? []) if (pick(x) && (!best || x.order > best.order)) best = x; return best; };
// Text and children pages must chain from offset 0 to a null continuation
// with one consistent native total; the latest page at each offset wins.
function textChain(pages) {
  if (!pages?.length) return false;
  for (let offset = 0, total, steps = 0; steps <= 100000; steps++) {
    const page = latest(pages, p => p.offset === offset && (total === undefined || p.total === total));
    if (!page || !Number.isSafeInteger(page.total)) return false;
    total = page.total;
    if (page.next == null) return true;
    if (!Number.isSafeInteger(page.next) || page.next <= offset || page.next > total) return false;
    offset = page.next;
  }
  return false;
}
function pageChain(pages) {
  const items = [];
  for (let offset = 0, total, steps = 0; steps <= 100000; steps++) {
    const page = latest(pages, p => p.offset === offset && (total === undefined || p.total === total));
    if (!page || !Number.isSafeInteger(page.total) || !Array.isArray(page.items)) return { complete: false, nextOffset: offset, total: total ?? null };
    total = page.total; items.push(...page.items);
    if (page.nextOffset == null) return { complete: items.length === total, items, nextOffset: null, total };
    if (page.nextOffset !== offset + page.items.length || page.items.length === 0) return { complete: false, nextOffset: page.nextOffset, total };
    offset = page.nextOffset;
  }
  return { complete: false, nextOffset: null, total: null };
}

function walkRoots(runtime, ev, roots) {
  let nodes = 0;
  const incompleteLeaves = [], summaries = [];
  for (const root of roots) {
    const out = [], stats = { complete: 0 }, seen = new Set();
    const leaf = (reference, path, reason, extra = {}) => out.push({ root: root.ref, reference, path: path ?? null, reason, ...extra });
    const done = () => { stats.complete++; };
    const guard = (ref, depth) => { if (++nodes > 200000 || depth > 64 || seen.has(ref)) fail('tree_invalid'); seen.add(ref); };
    const server = (ref, path, depth) => {
      guard(ref, depth);
      try {
        const obs = latest(ev.nodes.get(ref));
        if (!obs) return leaf(ref, path, 'not-read');
        if (obs.omitted) return leaf(ref, path, 'budget-omitted');
        const v = obs.value; path = typeof v.path === 'string' ? v.path : path;
        if (v.redacted === true) return leaf(ref, path, 'private-redacted');
        if (serverScalar.has(v.type)) {
          for (const [flag, reason] of nativeFlags) if (v[flag] === true) return leaf(ref, path, reason, { evidence: { flag } });
          if (v.trimmed === true) return leaf(ref, path, 'trimmed');
          if (v.deferred === true) return leaf(ref, path, 'deferred');
          if (v.valueComplete === true || textChain(ev.texts.get(ref))) return done();
          return leaf(ref, path, ev.texts.has(ref) ? 'text-pending' : 'not-read');
        }
        const pages = ev.pages.get(ref), direct = latest(pages);
        if (!direct) {
          if (v.trimmed === true) return leaf(ref, path, 'trimmed');
          if (v.deferred === true) return leaf(ref, path, 'deferred');
          // The native container reported no children and no deferral.
          return v.hasChildren === false ? done() : leaf(ref, path, 'not-read');
        }
        if (direct.blocked) return leaf(ref, path, 'private-redacted');
        if (direct.trimmed) return leaf(ref, path, 'trimmed');
        if (direct.deferred) return leaf(ref, path, 'deferred');
        const chain = pageChain(pages);
        if (!chain.complete) return leaf(ref, path, 'page-pending', { detail: { nextOffset: chain.nextOffset, availableChildren: chain.total } });
        if (v.type === 'RecordList') {
          // The page total covers the native Length only when the container
          // reported it; an unknown Length cannot prove every item was paged.
          const declared = latest(pages, p => p.coverage != null)?.coverage?.declaredLength;
          const items = chain.items.filter(c => indexPath.test(c.path ?? '')).length;
          if (!Number.isSafeInteger(declared) || items !== declared)
            return leaf(ref, path, 'page-pending', { detail: { declaredLength: Number.isSafeInteger(declared) ? declared : null, pagedItems: items } });
        }
        if (!chain.items.length) return done();
        for (const child of chain.items) server(child.reference, child.path, depth + 1);
      } finally { seen.delete(ref); }
    };
    const client = (ref, path, depth) => {
      guard(ref, depth);
      try {
        const list = ev.nodes.get(ref), obs = latest(list), pages = ev.pages.get(ref), texts = ev.texts.get(ref), r = obs?.read;
        if (!obs && !pages && !texts) return leaf(ref, path, 'not-read');
        if (obs?.unavailable) return leaf(ref, path, 'native-unavailable-in-context', { evidence: { flag: 'unavailable', error: obs.error } });
        // A children page carries no type: the container's own evaluation does.
        const typed = latest(list, o => o.read)?.read, compound = clientCompound.has(typed?.value?.type);
        // A compound's flag covers private descendants; enumerated ones are judged per leaf.
        if (r?.redacted === true && !(compound && pages)) return leaf(ref, path, 'private-redacted');
        if (r?.nativeSummary === true) return leaf(ref, path, 'native-binary-summary', { evidence: { flag: 'nativeSummary' } });
        if (!compound) {
          if (pages) return leaf(ref, path, 'not-read');
          if (r?.valueComplete === true || textChain(texts)) return done();
          return leaf(ref, path, texts ? 'text-pending' : obs?.omitted ? 'budget-omitted' : 'not-read');
        }
        if (!pages) return leaf(ref, path, obs?.omitted ? 'budget-omitted' : typed.deferred === true ? 'deferred' : 'page-pending',
          obs?.omitted || typed.deferred === true ? {} : { detail: { nextOffset: 0, availableChildren: null } });
        const chain = pageChain(pages);
        if (!chain.complete) return leaf(ref, path, 'page-pending', { detail: { nextOffset: chain.nextOffset, availableChildren: chain.total } });
        if (typed.value.type === 'RecordList') {
          // Native Length comes from the container wire or its own evaluation.
          const lengthItem = chain.items.find(c => c?.name === 'Length');
          const inline = typed.value.value?.Length, own = lengthItem && latest(ev.nodes.get(lengthItem.ref))?.read;
          const length = [inline, own?.valueComplete === true ? own.value : undefined]
            .find(x => x?.type === 'Integer' && Number.isSafeInteger(x.value))?.value;
          const items = chain.items.filter(c => indexName.test(c?.name ?? '')).length;
          if (!Number.isSafeInteger(length) || items !== length)
            return leaf(ref, path, 'page-pending', { detail: { declaredLength: Number.isSafeInteger(length) ? length : null, pagedItems: items } });
        }
        if (!chain.items.length) return done();
        for (const child of chain.items) {
          if (typeof child?.ref !== 'string') fail('read_invalid');
          client(child.ref, child.nativePath ?? child.name ?? null, depth + 1);
        }
      } finally { seen.delete(ref); }
    };
    (runtime === 'client' ? client : server)(root.ref, root.path, 0);
    summaries.push({ reference: root.ref, name: root.name, category: root.category, treeComplete: out.length === 0,
      completeLeaves: stats.complete, incompleteLeaves: out.length });
    incompleteLeaves.push(...out);
  }
  const policyRedactions = incompleteLeaves.filter(l => l.reason === 'private-redacted')
    .map(l => ({ root: l.root, reference: l.reference, path: l.path, privateReadObserved: ev.privateReads.has(l.reference) }));
  return { roots: summaries, incompleteLeaves, policyRedactions, nativeLimits: incompleteLeaves.filter(l => nativeReasons.has(l.reason)),
    residualNativeLimitsOnly: incompleteLeaves.length > 0 && incompleteLeaves.every(l => nativeReasons.has(l.reason)) };
}

export function scopeCompleteness({ lane, runtime, stop, generation, metadataCoverage, scopeVariables, reads } = {}) {
  if (!['o11', 'odc'].includes(lane) || !['client', 'server'].includes(runtime) || !Number.isSafeInteger(generation) || generation < 0) fail('input_invalid');
  const expected = { stop: stopOf(runtime, stop), generation };
  const roots = rootsOf(runtime, scopeVariables, expected), ev = evidence(runtime, reads, expected);
  // The native return event adds an address that is not a model variable.
  const enumeratedCounts = {};
  for (const root of roots) if (root.category !== 'return') enumeratedCounts[root.category] = (enumeratedCounts[root.category] ?? 0) + 1;
  const base = { lane, runtime, stop: expected.stop, generation, valuesReturned: false, enumeratedCounts };
  const expectedCounts = metadataCoverage?.runtimeFrameBound === true && metadataCoverage.modelScopeEnumerated === true ? countsOf(metadataCoverage.variableCounts) : null;
  const refused = code => ({ ok: false, refused: 'debug_scope_completeness_' + code, ...base, ...(expectedCounts ? { expectedCounts } : {}),
    metadataCoverageMatched: false, runtimeValuesComplete: false, residualNativeLimitsOnly: false });
  if (!expectedCounts) return refused('metadata_coverage_unbound');
  if (!sameCounts(expectedCounts, enumeratedCounts)) return refused('metadata_coverage_mismatch');
  const walked = walkRoots(runtime, ev, roots);
  return { ok: true, ...base, expectedCounts, metadataCoverageMatched: true, ...walked, runtimeValuesComplete: walked.incompleteLeaves.length === 0 };
}

// Background captures have no frame-bound counts: report root coverage only.
export function rootCoverage(scopeRoots, reads) {
  if (!Array.isArray(scopeRoots) || !Array.isArray(reads)) fail('input_invalid');
  const runtime = scopeRoots.length && scopeRoots.every(r => typeof r?.ref === 'string') ? 'client' : 'server';
  // The first read fixes the stop; every other read must share it.
  const expected = reads.length ? readStop(runtime, reads[0]) : null;
  const roots = rootsOf(runtime, scopeRoots, expected);
  const ev = expected ? evidence(runtime, reads, expected) : { nodes: new Map(), pages: new Map(), texts: new Map(), privateReads: new Set() };
  const walked = walkRoots(runtime, ev, roots);
  return { roots: roots.length, rootsRead: roots.filter(r => ev.nodes.has(r.ref) || ev.pages.has(r.ref) || ev.texts.has(r.ref)).length,
    rootsComplete: walked.roots.filter(r => r.treeComplete).length, valuesComplete: roots.length > 0 && walked.incompleteLeaves.length === 0,
    incompleteLeaves: walked.incompleteLeaves, policyRedactions: walked.policyRedactions, nativeLimits: walked.nativeLimits,
    residualNativeLimitsOnly: walked.residualNativeLimitsOnly, valuesReturned: false, ...(expected ? expected : {}) };
}

// Binds a completeness result to a scope context: same stop, generation and
// frame-bound counts. Anything else leaves runtimeValuesComplete false.
export function completenessBinding(completeness, context, variableCounts) {
  if (completeness?.ok !== true || completeness.metadataCoverageMatched !== true || typeof completeness.runtimeValuesComplete !== 'boolean' ||
      !['client', 'server'].includes(completeness.runtime) || !context) return null;
  let key;
  try { key = readStop(completeness.runtime, completeness.runtime === 'client' ? context : { context }); } catch { return null; }
  const counts = countsOf(variableCounts), expectedCounts = countsOf(completeness.expectedCounts);
  if (key.stop !== completeness.stop || key.generation !== completeness.generation || !counts || !expectedCounts || !sameCounts(counts, expectedCounts)) return null;
  return { runtimeValuesComplete: completeness.runtimeValuesComplete, residualNativeLimitsOnly: completeness.residualNativeLimitsOnly === true };
}
