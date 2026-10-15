// Source: contexto/timefit.mjs; sha256: 03ea4bf73d819db0d6c8c7a8d054d11511dc21385593072acf32bfe854eecdc0.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
// Ajuste do tempo de cada requisição ao modelo: dur ≈ a + b·saída + c·entrada_não_cacheada + d·entrada_cacheada.
// Codex: dur = registro da requisição − max(registro anterior, último item de entrada). Claude: timestamp da resposta − último
// tool_result/pedido antes dela. Mínimos quadrados (4 parâmetros); também a mediana de tokens de saída por segundo.
// Uso: node timefit.mjs --codex <dir|arquivos...> --claude <arquivos...>
import path from 'path';
import { analyzeRollout } from './codex-context.mjs';
import { load } from './claude-context.mjs';

function solve(A, y) { // normal equations, Gauss
  const n = A[0].length; const M = Array.from({ length: n }, () => Array(n + 1).fill(0));
  for (let r = 0; r < A.length; r++) for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) M[i][j] += A[r][i] * A[r][j]; M[i][n] += A[r][i] * y[r]; }
  for (let i = 0; i < n; i++) { let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k; [M[i], M[p]] = [M[p], M[i]]; for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; } }
  return M.map((r, i) => r[n] / r[i]);
}
export function fit(rows) {
  const ok = rows.filter(r => r.dur > 0 && r.dur < 600);
  const A = ok.map(r => [1, r.out / 1000, (r.in - r.cached) / 1000, r.cached / 1000]); const y = ok.map(r => r.dur);
  const c = solve(A, y);
  const pred = A.map(a => a.reduce((n, v, i) => n + v * c[i], 0)); const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const r2 = 1 - y.reduce((n, v, i) => n + (v - pred[i]) ** 2, 0) / y.reduce((n, v) => n + (v - mean) ** 2, 0);
  const tps = ok.filter(r => r.out > 500).map(r => r.out / r.dur).sort((a, b) => a - b);
  return { n: ok.length, a_s: c[0], s_per_1k_out: c[1], s_per_1k_uncached: c[2], s_per_1k_cached: c[3], r2, medianOutTokPerSec: tps[Math.floor(tps.length / 2)], meanDur: mean };
}
export function claudeRows(file) {
  const rows = load(file); const out = []; let lastIn = null; const seen = new Set();
  for (const o of rows) {
    if (o.isSidechain) continue;
    if (o.type === 'user') lastIn = Date.parse(o.timestamp);
    if (o.type === 'assistant' && o.message?.usage && !seen.has(o.message.id)) {
      seen.add(o.message.id); const u = o.message.usage; const t = Date.parse(o.timestamp);
      // o registro do assistant sai no início do 1º bloco; usamos o último registro do mesmo id como fim
      out.push({ id: o.message.id, start: lastIn, in: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens, cached: u.cache_read_input_tokens, out: u.output_tokens, t });
    } else if (o.type === 'assistant' && o.message?.id && seen.has(o.message.id)) { const r = out.find(x => x.id === o.message.id); if (r) r.t = Date.parse(o.timestamp); }
  }
  return out.filter(r => r.start).map(r => ({ ...r, dur: (r.t - r.start) / 1000 }));
}
export function bins(rows) {
  const edges = [0, 50e3, 100e3, 150e3, 200e3, 300e3, 1e9]; const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const s = rows.filter(r => r.dur > 0 && r.dur < 600 && r.out < 300 && r.in >= edges[i] && r.in < edges[i + 1]).map(r => r.dur).sort((a, b) => a - b);
    if (s.length) out.push({ faixa: `${edges[i] / 1e3}-${edges[i + 1] >= 1e9 ? '∞' : edges[i + 1] / 1e3}k`, n: s.length, mediana_s: +s[Math.floor(s.length / 2)].toFixed(2), p75_s: +s[Math.floor(s.length * 3 / 4)].toFixed(2) });
  }
  return out;
}