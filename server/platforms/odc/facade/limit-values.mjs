// The values a limit of kernel/docs/NAO-DA.md carries (discovery.mjs loadLimits, scripts/release/compile-runtime-data.mjs
// parseLimits, coverage-inventory.mjs): its type tag, its verdict and the label of where it was seen. English since
// 16/10/2026 (owner rule of 15/10: every text SSAM emits is English; review english-junction round 1, F1). The Portuguese
// values the document had before are declared aliases: a reader maps them to the English value, no answer serves them.
export const LIMIT_TYPE_ALIASES = Object.freeze({
  'limite-do-kernel': 'kernel-limit', 'recusa-da-plataforma': 'platform-refusal', 'inalcancavel': 'unreachable',
  'diferenca-entre-faixas': 'lane-difference', 'armadilha': 'trap', 'lacuna-declarada': 'declared-gap', 'regra-do-ssam': 'ssam-rule',
  'medido': 'measured', 'depende-do-studio': 'studio-dependent', 'recusa-do-kernel': 'kernel-refusal',
});
export const LIMIT_TYPES = Object.freeze(new Set(Object.values(LIMIT_TYPE_ALIASES)));
export const LIMIT_VERDICT_ALIASES = Object.freeze({ CONFIRMADO: 'CONFIRMED', IMPRECISO: 'IMPRECISE', REFUTADO: 'REFUTED', OBSOLETO: 'OBSOLETE', 'NAO MEDIDO': 'NOT MEASURED' });
export const LIMIT_VERDICTS = Object.freeze(new Set(Object.values(LIMIT_VERDICT_ALIASES)));
export const limitType = tag => LIMIT_TYPE_ALIASES[tag] ?? tag;
export const limitVerdict = word => LIMIT_VERDICT_ALIASES[word] ?? word;
// A verdict line ("> **CONFIRMED** (...)", the Portuguese word as alias) and a seen-in line ("Seen in: ...", "Visto em:").
export const VERDICT_LINE = /^>\s*\*\*?(CONFIRMED|IMPRECISE|REFUTED|OBSOLETE|NOT MEASURED|CONFIRMADO|IMPRECISO|REFUTADO|OBSOLETO|NAO MEDIDO)/;
export const SEEN_IN = /^(?:Seen in|Visto em):\s*/i;
