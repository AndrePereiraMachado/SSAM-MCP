// primeira-certa A3 (decision of the owner, 2026-10-10): a refused job comes back ONCE, with every problem of every phase
// of the kernel (preflight, base, apply, Verify) and the patch of each certain fix, and the patches apply with patch +
// basedOn (job-patch.mjs). This is how every refusal of the facade carries them (o11_deliver, studio_deliver, ssam_job,
// o11_job, ssam_reference check-job):
//   problemOf(p)            -> {phase?, op, pointer, code, severity, message, fix, patch?, element?, key?}
//   fitProblems(list, opts) -> {problems, problemsTotal?, grouped?}: the whole list when it fits the budget; else the
//                              identical ones grouped (same code, phase and mold of fix: one entry with the pointers, the
//                              ops and one patch that applies all of theirs), then without the per-item detail, then
//                              without the patch of the biggest groups (patchOmitted), then with 20 pointers a group
//                              (pointersTotal), then cut (problemsTotal) so the answer stays under the 40 KB ceiling.
//   diagnosisOf(source)     -> {verifyRan?, verifyReason?, phases?, normalizations?}: whether the Verify ran (and why not),
//                              the phases, and what the kernel rewrote instead of refusing (normalizationsOf).
//   normalizationsOf(src)   -> {normalizations?: {total, byRule, items, itemsLeft?}}: the kernel's JobNormalizer entries.
// The cascade (owner direction 2026-10-12: one refusal with everything, the cascade summarized): before the fitting, a
// problem that only follows from another op of the same job that failed is not repeated. Two families, both lanes:
//   - a name problem (code *UNKNOWN*, *NOT_DECLARED*, *NOT_FOUND*) whose name another part of the job declares (a ddl
//     statement, an action header, a <screen>/<block> document, a JSON spec record or logic action, a create op) when that
//     part failed for a reason of its own (its op has a root error, or its failure is itself such a cascade): the name is
//     missing because that part failed (the session's 244 problems were 71% these);
//   - the kernel's APPLY_SKIPPED warnings (an op that uses what a failed op would have created), one per op.
// Each family becomes ONE entry (CASCADE / APPLY_SKIPPED) with its count, codes, ops, the failed parts it follows from and
// the names, and the first root problem of each failed op says how many it blocks (blocks). Without the job the name
// family is left as it is; a ring of name problems with no root of its own is left as it is (it is the root).
// Pure but for refusalFields with options.jobFile (writes <job>.verified-patch.json, verified-patch.mjs).
import { headerOf, namesOf } from './ssam-code.mjs';
import { patchUnion, writeVerifiedPatch, patchConflicts, CONFLICT_NOTE } from './verified-patch.mjs';
export { patchUnion };

export const PROBLEMS_BUDGET = 30000;
// Every verified patch of a refusal, before any fitting (integration 24-1 familias, 2026-10-13): two patches of a whole screen
// text (20 KB each) cut the session's first refusal to one problem of five. The fit may leave a patch out, never a problem
// for a patch; with options.jobFile the union goes beside the job (verified-patch.mjs) and the answer says verifiedPatch.
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const clip = (text, max) => { const s = String(text ?? ''); return s.length > max ? s.slice(0, max - 3) + '...' : s; };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// One problem as the answers keep it: the fields of the kernel's single refusal, texts cut, the patch whole (it is the fix).
export function problemOf(p, limit = 600) {
  if (!isObject(p)) return { op: null, pointer: null, code: 'PROBLEM', severity: 'error', message: clip(typeof p === 'string' ? p : JSON.stringify(p), limit), fix: null };
  return { ...(typeof p.phase === 'string' ? { phase: p.phase } : {}), op: Number.isInteger(p.op) ? p.op : null, pointer: typeof p.pointer === 'string' ? p.pointer : null,
    code: String(p.code ?? 'PROBLEM'), severity: p.severity === 'warning' ? 'warning' : 'error', message: clip(p.message, limit), fix: p.fix == null ? null : clip(p.fix, limit),
    ...(Array.isArray(p.patch) && p.patch.length ? { patch: p.patch } : {}),
    // One patch of a document for several problems (kernel JobRunner.DocumentPatches), or none and why (verified-patch.mjs).
    ...(Number.isInteger(p.patchJoins) ? { patchJoins: p.patchJoins } : {}),
    ...(p.patchOmitted === true ? { patchOmitted: true, ...(typeof p.patchOmittedWhy === 'string' ? { patchOmittedWhy: clip(p.patchOmittedWhy, 300) } : {}) } : {}),
    ...(typeof p.element === 'string' && p.element ? { element: clip(p.element, 300) } : {}), ...(typeof p.key === 'string' && p.key ? { key: p.key } : {}),
    // PROTOTYPE_BINDING_REQUIRED: what the item is and whether its patch was built offline (unresolved ones carry no patch)
    ...(isObject(p.binding) ? { binding: p.binding } : {}),
    // A summary of a cascade (summarizeCascade) keeps what it counts.
    ...(Number.isInteger(p.blocks) ? { blocks: p.blocks } : {}), ...(Number.isInteger(p.count) && p.cascade ? { count: p.count } : {}),
    ...(p.cascade ? { cascade: true, ops: p.ops, codes: p.codes, because: p.because, ...(Number.isInteger(p.patchesLeftOut) ? { patchesLeftOut: p.patchesLeftOut } : {}) } : {}) };
}

// ---- the cascade (see the head of this file)
const NAME_CODES = /UNKNOWN|NOT_DECLARED|NOT_FOUND|UNDECLARED/;
const DOCUMENT_NAME = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:screen|block)\s[^>]*?\bname\s*=\s*"([^"]+)"/;
/** The units of a job and the names each declares: [{pointer, op, names: Set (lower case)}]. */
export function declarationsOf(job) {
  const ops = Array.isArray(job) ? job : Array.isArray(job?.ops) ? job.ops : null;
  if (!ops) return [];
  const prefix = Array.isArray(job) ? '' : '/ops';
  const units = [];
  const add = (pointer, op, names) => {
    const set = new Set(names.filter(n => typeof n === 'string' && n).map(n => n.toLowerCase()));
    if (set.size) units.push({ pointer, op, names: set });
  };
  ops.forEach((op, i) => {
    if (!isObject(op)) return;
    const base = `${prefix}/${i}`;
    const d = isObject(op.data) ? op.data : {};
    if (op.op === 'spec') {
      if (typeof d.ddl === 'string') add(base + '/data/ddl', i, namesOf('ddl', d.ddl));
      for (const section of ['entities', 'clientEntities', 'static', 'structures']) (Array.isArray(d[section]) ? d[section] : []).forEach((r, j) => add(`${base}/data/${section}/${j}`, i, [r?.name]));
    } else if (op.op === 'logic') {
      const listed = Array.isArray(d.flow);
      (listed ? d.flow : d.flow != null ? [d.flow] : []).forEach((f, j) => add(listed ? `${base}/data/flow/${j}` : `${base}/data/flow`, i, [headerOf(isObject(f) ? f.text : f)?.name]));
      (Array.isArray(d.actions) ? d.actions : []).forEach((a, j) => add(`${base}/data/actions/${j}`, i, [a?.name]));
    } else if (op.op === 'html' && typeof d.html === 'string') add(base + '/data/html', i, [DOCUMENT_NAME.exec(d.html)?.[1]]);
    else if (op.op === 'create' && typeof op.name === 'string') add(base, i, [op.name]);
  });
  return units;
}
// The names a message quotes ('X', "X", "owner X"), whole and by their last dotted segment, lower case.
function namesIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/'([A-Za-z_][\w.]*)'|"([A-Za-z_][\w.]*)"|\bowner ([A-Za-z_]\w*)/g)) {
    const name = (m[1] ?? m[2] ?? m[3]).toLowerCase();
    out.add(name); out.add(name.split('.').pop());
  }
  return out;
}
const countBy = list => list.reduce((o, k) => ({ ...o, [k]: (o[k] ?? 0) + 1 }), {});
const MAX_NAMES = 40;

/** The problems with the cascade summarized (see the head of this file); the same list when there is none. */
export function summarizeCascade(problems, job = null) {
  let list = Array.isArray(problems) ? problems : [];
  // Who blocks how many: [{op, pointer?, blocks}] -> the first root error of that unit (else of that op) gets blocks.
  const blockers = [];
  const units = declarationsOf(job);
  const prefix = Array.isArray(job) ? '' : '/ops';
  const unitOf = p => {
    const pointer = typeof p.pointer === 'string' ? p.pointer : null;
    if (pointer) {
      const unit = units.filter(u => pointer === u.pointer || pointer.startsWith(u.pointer + '/')).sort((a, b) => b.pointer.length - a.pointer.length)[0];
      if (unit) return unit.pointer;
      const op = /^(?:\/ops)?\/(\d+)(?:\/|$)/.exec(pointer)?.[1];
      if (op != null) return `${prefix}/${op}`;
    }
    return Number.isInteger(p.op) ? `${prefix}/${p.op}` : null;
  };
  const markBlockers = () => {
    if (!blockers.length) return;
    const roots = list.filter(p => isObject(p) && !p.cascade && p.severity !== 'warning');
    const counts = new Map();
    for (const b of blockers) {
      const target = (b.pointer ? roots.find(p => unitOf(p) === b.pointer) : null) ?? roots.find(p => p.op === b.op);
      if (target) counts.set(target, (counts.get(target) ?? 0) + b.blocks);
    }
    list = list.map(p => (counts.has(p) ? { ...p, blocks: (Number.isInteger(p.blocks) ? p.blocks : 0) + counts.get(p) } : p));
  };
  // 1. APPLY_SKIPPED: one entry for every op skipped because of a failed op.
  const skipped = list.filter(p => isObject(p) && p.code === 'APPLY_SKIPPED');
  if (skipped.length > 1) {
    const because = new Map();
    for (const p of skipped) {
      const failed = Number(/failed op #(\d+)|fix op #(\d+)/.exec(`${p.message ?? ''} ${p.fix ?? ''}`)?.slice(1).find(Boolean) ?? NaN);
      const key = Number.isInteger(failed) ? failed : null;
      if (!because.has(key)) because.set(key, { op: key, ops: [], uses: new Set() });
      const entry = because.get(key);
      if (Number.isInteger(p.op)) entry.ops.push(p.op);
      const uses = /it uses (.+?)(?:,| which| of failed)/.exec(String(p.message ?? ''))?.[1]; if (uses) entry.uses.add(uses.trim());
    }
    const failedOps = [...because.keys()].filter(Number.isInteger);
    const summary = { phase: skipped[0].phase ?? 'apply', op: null, pointer: null, code: 'APPLY_SKIPPED', severity: 'warning', cascade: true, count: skipped.length,
      message: `${skipped.length} ops were skipped: each uses what a failed op would have created (${failedOps.map(o => '#' + o).join(', ') || 'see the errors'}); they run once those are fixed`,
      fix: 'fix the failed ops; the skipped ops run with them, unchanged',
      ops: [...new Set(skipped.map(p => p.op).filter(Number.isInteger))], codes: { APPLY_SKIPPED: skipped.length },
      because: [...because.values()].map(b => ({ op: b.op, blocks: b.ops.length, ops: b.ops, ...(b.uses.size ? { names: [...b.uses].slice(0, MAX_NAMES) } : {}) })) };
    const first = list.findIndex(p => p?.code === 'APPLY_SKIPPED');
    list = [...list.slice(0, first).filter(p => p?.code !== 'APPLY_SKIPPED'), summary, ...list.slice(first).filter(p => p?.code !== 'APPLY_SKIPPED')];
    for (const b of because.values()) if (Number.isInteger(b.op)) blockers.push({ op: b.op, blocks: b.ops.length });
  }
  // 2. Names another failed op of the job declares. A name problem is a cascade only when the part that declares the name
  // failed for a reason of its own: an op with a root error (one that is no such name problem), or a part whose own failure
  // is already such a cascade (a screen refused because the action text of a failed logic op was not there, then the
  // other actions of that screen). A ring of name problems with no root of its own stays as it is: it is the root.
  if (units.length) {
    const errors = list.filter(p => isObject(p) && p.severity !== 'warning' && !p.cascade);
    const opOf = p => (Number.isInteger(p.op) ? p.op : Number(/^(?:\/ops)?\/(\d+)(?:\/|$)/.exec(String(p.pointer ?? ''))?.[1] ?? NaN));
    const failedKeys = new Set(errors.map(unitOf).filter(Boolean));
    const failed = u => failedKeys.has(u.pointer) || failedKeys.has(`${prefix}/${u.op}`);
    const declaring = new Map(); // name problem -> the failed parts of the job that declare a name it quotes
    for (const p of errors) {
      if (!NAME_CODES.test(String(p.code ?? ''))) continue;
      const own = unitOf(p); const names = namesIn(p.message);
      if (!names.size) continue;
      const from = units.filter(u => u.pointer !== own && failed(u) && [...u.names].some(n => names.has(n)));
      if (from.length) declaring.set(p, from);
    }
    const rootOps = new Set(errors.filter(p => !declaring.has(p)).map(opOf).filter(Number.isInteger));
    const explained = new Map(); // part pointer -> the op whose root error explains its failure
    const rootOf = u => (rootOps.has(u.op) ? u.op : explained.get(u.pointer));
    const cascade = new Map(); // problem -> {from: the explained declaring parts, root: op}
    for (let changed = true; changed;) {
      changed = false;
      for (const [p, from] of declaring) {
        if (cascade.has(p)) continue;
        const explainedFrom = from.filter(u => rootOf(u) != null);
        if (!explainedFrom.length) continue;
        const root = rootOf(explainedFrom[0]);
        cascade.set(p, { from: explainedFrom, root });
        const own = unitOf(p);
        if (own && !explained.has(own)) explained.set(own, root);
        changed = true;
      }
    }
    const roots = errors.filter(p => !cascade.has(p));
    if (cascade.size && roots.length) {
      const members = [...cascade.keys()];
      const byUnit = new Map();
      for (const [p, { from }] of cascade) for (const u of from) {
        if (!byUnit.has(u.pointer)) byUnit.set(u.pointer, { op: u.op, pointer: u.pointer, problems: 0, names: new Set() });
        const entry = byUnit.get(u.pointer); entry.problems++;
        for (const n of namesIn(p.message)) if (u.names.has(n)) entry.names.add(n);
      }
      const because = [...byUnit.values()].map(b => ({ op: b.op, pointer: b.pointer, blocks: b.problems, names: [...b.names].slice(0, MAX_NAMES) }));
      const allNames = [...new Set(because.flatMap(b => b.names))];
      const phases = countBy(members.map(p => p.phase ?? ''));
      const phase = Object.entries(phases).sort((a, b) => b[1] - a[1])[0]?.[0];
      const summary = { ...(phase ? { phase } : {}), op: null, pointer: null, code: 'CASCADE', severity: 'error', cascade: true, count: members.length,
        message: `${members.length} more problems follow from ${because.length} failed part(s) of this job (ops ${[...new Set(because.map(b => '#' + b.op))].join(', ')}): they name what those parts declare (`
          + allNames.slice(0, 12).join(', ') + (allNames.length > 12 ? ', ...' : '') + '), missing because those parts failed; they clear when those are fixed, so they are listed once here, not repeated',
        fix: 'fix the root problems (each says how many it blocks); nothing else to send for these',
        ops: [...new Set(members.map(p => p.op).filter(Number.isInteger))], codes: countBy(members.map(p => String(p.code))), because,
        // A patch of such a problem points at another element (the nearest name); the job declares the name: never applied.
        ...(members.some(p => Array.isArray(p.patch) && p.patch.length) ? { patchesLeftOut: members.filter(p => Array.isArray(p.patch) && p.patch.length).length } : {}) };
      // Each cascade problem counts on the root error of the op that explains it (through the chain, if any).
      for (const { root } of cascade.values()) blockers.push({ op: root, blocks: 1 });
      list = [...list.filter(p => !cascade.has(p)), summary];
    }
  }
  markBlockers();
  return list;
}

// The mold of a fix: what stays when the names, texts and numbers it quotes are taken out.
export const moldOf = fix => String(fix ?? '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '_').replace(/\b[\w$]*[.:/][\w.$:/]+\b/g, '_')
  .replace(/\b[a-z]*[A-Z][\w]*\b/g, '_').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

// The places a member's message names ("line 12 col 416"), for a group whose members differ only there.
const placeOf = message => /\bline (\d+)(?: col(?:umn)? (\d+))?/.exec(String(message ?? '')) ?? null;

export function fitProblems(list, { budget = PROBLEMS_BUDGET, limit = 600, job = null, alwaysGroup = false, preserveAll = false } = {}) {
  // The output policy already has the complete shaped problems. It groups them without
  // clipping messages, collapsing cascades again, or discarding a group to meet a budget.
  const all = preserveAll ? (Array.isArray(list) ? list : []).map(p => isObject(p) ? structuredClone(p) : problemOf(p, Number.MAX_SAFE_INTEGER))
    : summarizeCascade((Array.isArray(list) ? list : []).map(p => problemOf(p, limit)), job);
  if (!alwaysGroup && bytes(all) <= budget) return { problems: all };
  // Identical problems, grouped: same code, phase, severity and mold of fix. A problem of the facade's own input check
  // ({at, error, lines?}: ssam_code write) has no code: only the same error text groups those (integration marco-a2: the
  // eleven different input problems of one write became one group with no code and no message, their lines left out).
  const groups = new Map();
  for (const p of all) {
    const key = [p.code, p.phase ?? '', p.severity, moldOf(p.fix), p.code == null ? String(p.error ?? p.message ?? '') : ''].join('\u0001');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const grouped = [...groups.values()].map(members => {
    if (members.length === 1) return members[0];
    const [first] = members;
    const patch = members.flatMap(m => m.patch ?? []);
    // Each pointer once (41 problems of one ddl text are one pointer and 41 lines), and the lines the messages name.
    const places = [...new Set(members.map(m => placeOf(m.message)).filter(Boolean).map(m => m[2] ? `${m[1]}:${m[2]}` : m[1]))];
    const blocks = members.reduce((n, m) => n + (Number.isInteger(m.blocks) ? m.blocks : 0), 0);
    const group = { ...(first.phase ? { phase: first.phase } : {}), code: first.code, severity: first.severity, count: members.reduce((n, m) => n + (m.count ?? 1), 0),
      message: first.message, ...(first.code == null && first.error != null ? { error: first.error } : {}), fix: first.fix, ops: [...new Set(members.map(m => m.op).filter(Number.isInteger))],
      pointers: [...new Set(members.flatMap(m => m.pointers ?? ([m.pointer ?? m.at ?? m.part ?? m.key ?? m.element].filter(v => v != null))))], ...(places.length > 1 ? { lines: places } : {}), ...(blocks ? { blocks } : {}), ...(patch.length ? { patch } : {}),
      items: members.map(m => ({ pointer: m.pointer ?? m.at, ...(m.message !== first.message ? { message: m.message } : {}), ...(m.fix !== first.fix ? { fix: m.fix } : {}),
        ...(m.element ? { element: m.element } : {}), ...(m.key ? { key: m.key } : {}) })) };
    // A group of code-less input problems has no code, severity, message or fix: no key for them.
    for (const key of ['code', 'severity', 'message', 'fix']) if (group[key] === undefined) delete group[key];
    return group;
  });
  if (preserveAll) return { problems: grouped, ...(groups.size < all.length ? { grouped: true } : {}) };
  if (bytes(grouped) <= budget) return { problems: grouped, grouped: true };
  const lean = grouped.map(g => (g.items ? (({ items, ...rest }) => rest)(g) : g));
  if (bytes(lean) <= budget) return { problems: lean, grouped: true };
  // Then the patch of the biggest groups (each says so: the pointers and the fix stay), then their pointers past 20.
  for (const g of [...lean].filter(g => g.count && g.patch).sort((a, b) => bytes(b.patch) - bytes(a.patch))) {
    if (bytes(lean) <= budget) break;
    delete g.patch; g.patchOmitted = true;
  }
  if (bytes(lean) <= budget) return { problems: lean, grouped: true };
  for (const g of lean.filter(g => g.count && g.pointers.length > 20)) { g.pointersTotal = g.pointers.length; g.pointers = g.pointers.slice(0, 20); }
  if (bytes(lean) <= budget) return { problems: lean, grouped: true };
  // Then the patch of single problems, the biggest first (patchOmitted; the union of every patch stays beside the job):
  // a problem is never cut for the size of its patch.
  for (const p of [...lean].filter(p => !p.count && p.patch).sort((a, b) => bytes(b.patch) - bytes(a.patch))) {
    if (bytes(lean) <= budget) break;
    delete p.patch; p.patchOmitted = true;
  }
  if (bytes(lean) <= budget) return { problems: lean, grouped: true };
  // Still too big: as many as fit, in order (the errors of the job first), and how many there were.
  const ordered = [...lean].sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));
  const kept = [];
  for (const p of ordered) { if (bytes([...kept, p]) > budget) break; kept.push(p); }
  return { problems: kept, grouped: true, problemsTotal: all.length };
}

// lentidao 2026-10-12 (kernel Preflight/JobNormalizer.cs): what the kernel rewrote in the job instead of refusing it
// (sort keys split, typed nulls, the entity segment of a record list, a documentation property it cannot write), so no
// rewrite reaches the module unseen: the count per rule and the first entries {rule, path, from, to}. The whole list
// stays in the kernel's result (data.normalizations, or the refusal envelope). Empty when there are none.
export const NORMALIZATIONS_SHOWN = 8;
export function normalizationsOf(source, max = NORMALIZATIONS_SHOWN) {
  const list = (Array.isArray(source?.normalizations) ? source.normalizations : []).filter(isObject);
  if (!list.length) return {};
  const byRule = {};
  for (const n of list) { const rule = String(n.rule ?? 'UNKNOWN'); byRule[rule] = (byRule[rule] ?? 0) + 1; }
  const items = list.slice(0, max).map(n => ({ rule: String(n.rule ?? 'UNKNOWN'), ...(n.path ? { path: clip(n.path, 160) } : {}),
    ...(n.from != null ? { from: clip(n.from, 160) } : {}), ...(n.to != null ? { to: clip(n.to, 160) } : {}) }));
  return { normalizations: { total: list.length, byRule, items, ...(list.length > max ? { itemsLeft: list.length - max } : {}) } };
}

// Whether the kernel's Verify ran before the refusal, why not, the phases its problems come from, and what the kernel
// normalized in the job before refusing what stayed.
export function diagnosisOf(source) {
  if (!isObject(source)) return {};
  return { ...(typeof source.verifyRan === 'boolean' ? { verifyRan: source.verifyRan } : {}),
    ...(typeof source.verifyReason === 'string' && source.verifyReason ? { verifyReason: clip(source.verifyReason, 600) } : {}),
    ...(Array.isArray(source.phases) && source.phases.length ? { phases: source.phases.filter(p => typeof p === 'string') } : {}),
    ...normalizationsOf(source) };
}

// The fields of a refusal with problems: {problems, problemsTotal?, grouped?, verifyRan?, verifyReason?, phases?}; empty
// when there are none.
export function refusalFields(problems, source, options) {
  // Integration 24-1 familias (review): patches that write different values at one path are no patch (the last would win):
  // each problem whose patch touches such a path loses it and says why (patchOmitted, patchOmittedWhy), and no verified call.
  const conflicts = Array.isArray(problems) ? patchConflicts(patchUnion(problems)) : [];
  if (conflicts.length) {
    const paths = new Set(conflicts.map(c => c.path));
    problems = problems.map(p => (isObject(p) && Array.isArray(p.patch) && p.patch.some(op => isObject(op) && paths.has(op.path))
      ? (({ patch, ...rest }) => ({ ...rest, patchOmitted: true, patchOmittedWhy: CONFLICT_NOTE }))(p) : p));
  }
  const fitted = Array.isArray(problems) && problems.length ? fitProblems(problems, options) : null;
  const verified = fitted && options?.jobFile ? writeVerifiedPatch(options.jobFile, patchUnion(problems)) : {};
  return { ...(fitted ? { problems: fitted.problems, ...(fitted.grouped ? { grouped: true } : {}), ...(fitted.problemsTotal ? { problemsTotal: fitted.problemsTotal } : {}) } : {}),
    ...diagnosisOf(source), ...verified };
}
