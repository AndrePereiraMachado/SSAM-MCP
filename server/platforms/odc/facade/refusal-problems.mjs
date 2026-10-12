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
// Pure: no I/O.

export const PROBLEMS_BUDGET = 30000;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const clip = (text, max) => { const s = String(text ?? ''); return s.length > max ? s.slice(0, max - 3) + '...' : s; };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// One problem as the answers keep it: the fields of the kernel's single refusal, texts cut, the patch whole (it is the fix).
export function problemOf(p, limit = 600) {
  if (!isObject(p)) return { op: null, pointer: null, code: 'PROBLEM', severity: 'error', message: clip(typeof p === 'string' ? p : JSON.stringify(p), limit), fix: null };
  return { ...(typeof p.phase === 'string' ? { phase: p.phase } : {}), op: Number.isInteger(p.op) ? p.op : null, pointer: typeof p.pointer === 'string' ? p.pointer : null,
    code: String(p.code ?? 'PROBLEM'), severity: p.severity === 'warning' ? 'warning' : 'error', message: clip(p.message, limit), fix: p.fix == null ? null : clip(p.fix, limit),
    ...(Array.isArray(p.patch) && p.patch.length ? { patch: p.patch } : {}),
    ...(typeof p.element === 'string' && p.element ? { element: clip(p.element, 300) } : {}), ...(typeof p.key === 'string' && p.key ? { key: p.key } : {}) };
}

// The mold of a fix: what stays when the names, texts and numbers it quotes are taken out.
export const moldOf = fix => String(fix ?? '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '_').replace(/\b[\w$]*[.:/][\w.$:/]+\b/g, '_')
  .replace(/\b[a-z]*[A-Z][\w]*\b/g, '_').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export function fitProblems(list, { budget = PROBLEMS_BUDGET, limit = 600 } = {}) {
  const all = (Array.isArray(list) ? list : []).map(p => problemOf(p, limit));
  if (bytes(all) <= budget) return { problems: all };
  // Identical problems, grouped: same code, phase, severity and mold of fix.
  const groups = new Map();
  for (const p of all) {
    const key = [p.code, p.phase ?? '', p.severity, moldOf(p.fix)].join('\u0001');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const grouped = [...groups.values()].map(members => {
    if (members.length === 1) return members[0];
    const [first] = members;
    const patch = members.flatMap(m => m.patch ?? []);
    return { ...(first.phase ? { phase: first.phase } : {}), code: first.code, severity: first.severity, count: members.length,
      message: first.message, fix: first.fix, ops: [...new Set(members.map(m => m.op).filter(Number.isInteger))],
      pointers: members.map(m => m.pointer), ...(patch.length ? { patch } : {}),
      items: members.map(m => ({ pointer: m.pointer, ...(m.message !== first.message ? { message: m.message } : {}), ...(m.fix !== first.fix ? { fix: m.fix } : {}),
        ...(m.element ? { element: m.element } : {}), ...(m.key ? { key: m.key } : {}) })) };
  });
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
  const fitted = Array.isArray(problems) && problems.length ? fitProblems(problems, options) : null;
  return { ...(fitted ? { problems: fitted.problems, ...(fitted.grouped ? { grouped: true } : {}), ...(fitted.problemsTotal ? { problemsTotal: fitted.problemsTotal } : {}) } : {}),
    ...diagnosisOf(source) };
}
