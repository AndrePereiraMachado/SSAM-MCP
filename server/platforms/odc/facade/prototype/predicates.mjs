// The closed predicate grammar (docs/PROTOTIPO-NATIVO.md 2.8), in this order: f, not f, f = c, f <> c, f > 0, f = 0,
// f <= k, f >= k (k = observed boundary), D = c, D <> c, D = c1 or D = c2, D = <param>, D = 0 or Current.f = D,
// Length(ctl) >= k, Length(ctl) <= k, ctl >= k, ctl <= k, ctl <> "", and/or of two terms. Ties: fewer terms, then
// the order above. Refinement: among terms with the same number of terms, the variables that already govern the
// presence of the node or of its ancestors (vars.prefer) come first, then the order above.
//
// Pred: {op: truthy|not|eq|ne|gt|ge|lt|le|in|contains|len-ge|len-le|and|or, l: Val, r: Val, a: [Pred]}
// Val: {lit}, {field}, {dim}, {param}, {control}, {view: true}

export const lit = value => ({ lit: value });

function same(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number') { const x = Number(a), y = Number(b); return String(a).trim() !== '' && String(b).trim() !== '' && Number.isFinite(x) && x === y; }
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return String(a) === String(b);
}

function truthy(value) {
  if (value === 'false' || value === '0' || value === '') return false;
  return Boolean(value);
}

export function valueOf(val, ctx) {
  if (!val) return undefined;
  if ('lit' in val) return val.lit;
  if ('field' in val) return val.via ? ctx.join?.(val.via, val.field) : ctx.row?.[val.field];
  if ('dim' in val) return ctx.dims?.[val.dim];
  if ('param' in val) return ctx.params?.[val.param];
  if ('control' in val) return ctx.controls?.[val.control];
  if ('view' in val) return ctx.view;
  if ('len' in val) return String(valueOf(val.len, ctx) ?? '').length;
  return undefined;
}

export function evaluate(pred, ctx) {
  if (!pred) return true;
  const l = () => valueOf(pred.l, ctx), r = () => valueOf(pred.r, ctx);
  switch (pred.op) {
    case 'truthy': return truthy(l());
    case 'not': return pred.a ? !evaluate(pred.a[0], ctx) : !truthy(l());
    case 'eq': return same(l(), r());
    case 'ne': return !same(l(), r());
    case 'gt': return Number(l()) > Number(r());
    case 'ge': return Number(l()) >= Number(r());
    case 'lt': return Number(l()) < Number(r());
    case 'le': return Number(l()) <= Number(r());
    case 'in': return (pred.r?.lit ?? []).some(item => same(l(), item));
    case 'contains': {
      const needle = String(r() ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const fields = pred.fields ?? [pred.l];
      return fields.some(field => String(valueOf(field, ctx) ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(needle));
    }
    case 'len-ge': return String(l() ?? '').length >= Number(r());
    case 'len-le': return String(l() ?? '').length <= Number(r());
    case 'and': return pred.a.every(item => evaluate(item, ctx));
    case 'or': return pred.a.some(item => evaluate(item, ctx));
    default: throw new Error('unknown predicate op ' + pred.op);
  }
}

const isNumber = value => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));

// Candidate single terms, in grammar order, built from the variables of the contexts.
// vars: {fields: [{name, lowCardinality, type}], dims: [{key}], params: [name], controls: [name], view: bool}
export function terms(vars, positives, negatives) {
  const out = [];
  const values = (val, list) => list.map(ctx => valueOf(val, ctx));
  const single = list => { if (list.some(value => value === undefined)) return undefined; const set = [...new Set(list.map(value => JSON.stringify(value)))]; return set.length === 1 ? JSON.parse(set[0]) : undefined; };
  for (const field of vars.fields ?? []) {
    const val = field.via ? { field: field.name, via: field.via } : { field: field.name };
    const pv = values(val, positives), nv = values(val, negatives);
    const boolish = field.type === 'Boolean' || pv.concat(nv).every(value => typeof value === 'boolean');
    if (boolish) { out.push({ op: 'truthy', l: val }); out.push({ op: 'not', l: val }); }
    if (field.lowCardinality || boolish) {
      const p = single(pv); if (p !== undefined && p !== null && !boolish) out.push({ op: 'eq', l: val, r: lit(p) });
      const n = single(nv); if (n !== undefined && n !== null && !boolish) out.push({ op: 'ne', l: val, r: lit(n) });
    }
    if (!boolish && pv.concat(nv).every(value => value === null || isNumber(value))) {
      out.push({ op: 'gt', l: val, r: lit(0) });
      out.push({ op: 'eq', l: val, r: lit(0) });
      const numbersP = pv.filter(isNumber).map(Number);
      if (numbersP.length) {
        out.push({ op: 'le', l: val, r: lit(Math.max(...numbersP)) });
        out.push({ op: 'ge', l: val, r: lit(Math.min(...numbersP)) });
      }
    }
  }
  for (const dim of vars.dims ?? []) {
    const val = { dim: dim.key };
    const pv = values(val, positives), nv = values(val, negatives);
    // A free-text dimension (typed by the user) is compared with its empty value only: its observed values are
    // SSAM's own probe words, never literals of the prototype.
    if (dim.free) {
      out.push({ op: 'ne', l: val, r: lit(dim.zero ?? '') });
      out.push({ op: 'eq', l: val, r: lit(dim.zero ?? '') });
      continue;
    }
    // A dimension that is 'set or not' (every negative at its zero value): D <> zero before any literal equality.
    if (dim.zero !== undefined && nv.length && nv.every(value => String(value) === String(dim.zero)) && pv.every(value => String(value) !== String(dim.zero)) && dim.hidden) out.push({ op: 'ne', l: val, r: lit(dim.zero) });
    const p = single(pv); if (p !== undefined) out.push({ op: 'eq', l: val, r: lit(p) });
    const n = single(nv); if (n !== undefined) out.push({ op: 'ne', l: val, r: lit(n) });
    const pset = [...new Set(pv.map(String))];
    if (pset.length === 2) out.push({ op: 'or', a: [{ op: 'eq', l: val, r: lit(pset[0]) }, { op: 'eq', l: val, r: lit(pset[1]) }] });
    // D <> c for a value only negatives have (one term of a conjunction with another variable).
    for (const value of [...new Set(nv.map(String))].filter(value => !pset.includes(value)).sort()) if (n === undefined || String(n) !== value) out.push({ op: 'ne', l: val, r: lit(value) });
    const nset = new Set(nv.map(String));
    for (const value of pset.filter(value => !nset.has(value)).sort()) if (p === undefined || String(p) !== value) out.push({ op: 'eq', l: val, r: lit(value) });
    for (const param of vars.params ?? []) out.push({ op: 'eq', l: val, r: { param } });
    for (const field of vars.fields ?? []) if (!field.via) out.push({ op: 'or', a: [{ op: 'eq', l: val, r: lit(dim.zero ?? 0) }, { op: 'eq', l: { field: field.name }, r: val }] });
  }
  if (vars.view) {
    const pv = values({ view: true }, positives), nv = values({ view: true }, negatives);
    const p = single(pv); if (p !== undefined) out.push({ op: 'eq', l: { view: true }, r: lit(p) });
    const n = single(nv); if (n !== undefined) out.push({ op: 'ne', l: { view: true }, r: lit(n) });
    const pset = [...new Set(pv.map(String))];
    if (pset.length === 2) out.push({ op: 'or', a: [{ op: 'eq', l: { view: true }, r: lit(pset[0]) }, { op: 'eq', l: { view: true }, r: lit(pset[1]) }] });
  }
  for (const control of vars.controls ?? []) {
    const val = { control };
    const lengths = list => list.map(ctx => String(valueOf(val, ctx) ?? '').length);
    const lp = lengths(positives);
    if (lp.length) {
      out.push({ op: 'len-ge', l: val, r: lit(Math.min(...lp)) });
      out.push({ op: 'len-le', l: val, r: lit(Math.max(...lp)) });
    }
    const np = values(val, positives).filter(isNumber).map(Number);
    if (np.length === positives.length && np.length) {
      out.push({ op: 'ge', l: val, r: lit(Math.min(...np)) });
      out.push({ op: 'le', l: val, r: lit(Math.max(...np)) });
    }
    out.push({ op: 'ne', l: val, r: lit('') });
  }
  if (!vars.prefer?.length) return out;
  const preferred = new Set(vars.prefer);
  const governed = term => variablesOf(term).some(key => preferred.has(key));
  return [...out.filter(governed), ...out.filter(term => !governed(term))];
}

// The variables (JSON of each non-literal value) a predicate reads.
export function variablesOf(pred, out = []) {
  if (!pred || typeof pred !== 'object') return out;
  for (const val of [pred.l, pred.r]) if (val && typeof val === 'object' && !('lit' in val)) { const key = JSON.stringify(val); if (!out.includes(key)) out.push(key); }
  for (const item of pred.a ?? []) variablesOf(item, out);
  return out;
}

function separates(pred, positives, negatives) {
  try { return positives.every(ctx => evaluate(pred, ctx)) && negatives.every(ctx => !evaluate(pred, ctx)); } catch { return false; }
}

// The first predicate of the grammar that is true for every positive and false for every negative context.
export function separate(vars, positives, negatives, { maxTerms = 2 } = {}) {
  if (!positives.length) return null;
  const list = terms(vars, positives, negatives);
  for (const term of list) if (separates(term, positives, negatives)) return term;
  if (maxTerms < 2) return null;
  const variable = term => JSON.stringify(term.l ?? term.a?.[0]?.l ?? null);
  // Two terms over the same variable first (a range of one field), then any pair.
  for (const sameVariable of [true, false]) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if ((variable(list[i]) === variable(list[j])) !== sameVariable) continue;
        const and = { op: 'and', a: [list[i], list[j]] };
        if (separates(and, positives, negatives)) return rangeOfOne(and);
      }
    }
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const or = { op: 'or', a: [list[i], list[j]] };
      if (separates(or, positives, negatives)) return or;
    }
  }
  return null;
}

// f <= k and f >= k is f = k.
function rangeOfOne(and) {
  const [a, b] = and.a;
  const bounds = [a, b].map(term => term.op).sort().join(',');
  if (bounds === 'ge,le' && JSON.stringify(a.l) === JSON.stringify(b.l) && a.r?.lit !== undefined && String(a.r.lit) === String(b.r?.lit)) return { op: 'eq', l: a.l, r: a.r };
  return and;
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

export function complexity(pred) {
  if (!pred) return 99;
  if (pred.op === 'and' || (pred.op === 'or' && pred.a?.length === 2 && pred.a.every(item => item.op !== 'eq' || !('dim' in (item.l ?? {}))))) return 2;
  return 1;
}

// A decision list over groups of contexts (2.8 "cases"): repeatedly the group with the simplest separating predicate
// against the remaining groups; the last group is the else branch. Returns [{group, when}] or null.
export function decisionList(vars, groups) {
  const remaining = groups.map((group, index) => ({ ...group, index }));
  const out = [];
  while (remaining.length > 1) {
    let best = null;
    for (const group of remaining) {
      const others = remaining.filter(item => item !== group).flatMap(item => item.contexts);
      const list = terms(vars, group.contexts, others);
      let rank = null, pred = null;
      for (const [index, term] of list.entries()) if (separates(term, group.contexts, others)) { rank = [1, index]; pred = term; break; }
      if (!pred) { pred = separate(vars, group.contexts, others); if (pred) rank = [2, 0]; }
      if (!pred) continue;
      const key = [rank[0], rank[1], group.contexts.length, group.index];
      if (!best || lexLess(key, best.key)) best = { group, pred, key };
    }
    if (!best) return null;
    out.push({ group: best.group, when: best.pred });
    remaining.splice(remaining.indexOf(best.group), 1);
  }
  out.push({ group: remaining[0], when: null });
  return out;
}
