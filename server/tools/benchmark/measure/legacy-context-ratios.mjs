// Source: contexto/estimativas.mjs; sha256: b18a2c59448126a5982ca7f3a916a2bf6a3a5f34601a8c477772b286b10e17c3.
// Port scope: ONLY repFrac (line 35) and pctSSAM (line 61). Pure parameterized functions,
// English exported names, no file reads, writes, projections, SLOPE or savings assumptions.
import { repetition } from './answer-repetition.mjs';

export function repetitionFractions(entriesPerContext) {
  const tot = {};
  for (const e of entriesPerContext) {
    const r = repetition(e);
    for (const [t, p] of Object.entries(r.per)) {
      const T = tot[t] ??= { chars: 0, repeated: 0 };
      T.chars += p.chars;
      T.repeated += p.repeated;
    }
  }
  return Object.fromEntries(Object.entries(tot).map(([t, v]) => [t, v.repeated / v.chars]));
}

export function ssamContextRatios(reads, sumIn) {
  const ssamReads = Object.entries(reads).filter(([k]) => k.startsWith('ssam:') || /AGENTS|CLAUDE/.test(k)).reduce((a, [, v]) => a + v, 0);
  // ssamTokens and ssamPct preserve the source's rounding and denominator.
  const ssamToolsReads = Object.entries(reads).filter(([k]) => k.startsWith('ssam:')).reduce((a, [, v]) => a + v, 0);
  return { ssamTokens: Math.round(ssamReads), ssamPct: +(100 * ssamReads / sumIn).toFixed(1),
    ssamToolsTokens: Math.round(ssamToolsReads), ssamToolsPct: +(100 * ssamToolsReads / sumIn).toFixed(1) };
}
