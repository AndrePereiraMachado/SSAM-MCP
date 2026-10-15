// One field `normalizations` on an answer, from two sources (integration 24-1 familias, 2026-10-13):
//   - the facade's call and op shapes taken as meant (call-shapes.mjs, ssam-code.mjs normalizeCodeOps, module-map.mjs):
//     a list [{rule, at, note}];
//   - the kernel's JobNormalizer rewrites (refusal-problems.mjs normalizationsOf): {total, byRule, items, itemsLeft?}.
// mergeNormalizations(existing, added) keeps both: a list stays a list (added first); with the kernel's object, the facade
// entries go first in items and count in total and byRule. Pure: no I/O.
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function mergeNormalizations(existing, added) {
  const list = Array.isArray(added) ? added.filter(isObject) : [];
  if (!list.length) return existing;
  if (isObject(existing) && Array.isArray(existing.items)) {
    const byRule = { ...(isObject(existing.byRule) ? existing.byRule : {}) };
    for (const n of list) { const rule = String(n.rule ?? 'UNKNOWN'); byRule[rule] = (byRule[rule] ?? 0) + 1; }
    const total = (Number.isInteger(existing.total) ? existing.total : existing.items.length) + list.length;
    return { ...existing, total, byRule, items: [...list, ...existing.items] };
  }
  return [...list, ...(Array.isArray(existing) ? existing : [])];
}

/** value with `added` merged into its normalizations (the same value when nothing is added). */
export function withNormalizationsOf(value, added) {
  if (!isObject(value) || !Array.isArray(added) || !added.length) return value;
  return { ...value, normalizations: mergeNormalizations(value.normalizations, added) };
}
