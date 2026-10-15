// Source: contexto/anatomia.mjs; sha256: d565fd78e8d36d41cf9da76a7a114b7e7d7772acbde40cc3d14de7c704d3b02d.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
// Anatomia das respostas grandes do SSAM: tamanho por chave de topo (e 2º nível das maiores), somado por ferramenta.
// Lê respostas de rollouts Codex (texto como o modelo viu) e tool_results de sessões Claude.
// Uso: node anatomia.mjs --codex <rollout>... --claude <sessao>... [--json out.json]
const fs = { readFileSync: value => typeof value === 'string' ? value : value.map(r=>JSON.stringify(r)).join('\n') };
import path from 'path';
import { analyzeRollout } from './codex-context.mjs';
import { load } from './claude-context.mjs';

function unwrap(t) {
  let s = t.trim(); let o;
  try { o = JSON.parse(s) } catch { const i = s.indexOf('{'); if (i < 0) return null; try { o = JSON.parse(s.slice(i)) } catch { return null } }
  if (o && Array.isArray(o.content) && o.content[0]?.type === 'text') { try { return { obj: JSON.parse(o.content[0].text), wrapper: true, sc: 'structuredContent' in o } } catch { return { obj: o, wrapper: true } } }
  return { obj: o, wrapper: false };
}
const size = v => JSON.stringify(v ?? null).length;
export function anatomy(entries) {
  const per = {};
  for (const { tool, text } of entries) {
    const u = unwrap(text); const P = per[tool] ??= { n: 0, chars: 0, parsed: 0, keys: {}, sub: {}, wrapped: 0, withSC: 0 };
    P.n++; P.chars += text.length; if (!u || typeof u.obj !== 'object' || !u.obj) continue;
    P.parsed++; if (u.wrapper) P.wrapped++; if (u.sc) P.withSC++;
    for (const [k, v] of Object.entries(u.obj)) {
      const s = size(v); P.keys[k] = (P.keys[k] || 0) + s;
      if (v && typeof v === 'object' && !Array.isArray(v) && s > 2000) for (const [k2, v2] of Object.entries(v)) { const kk = k + '.' + k2; P.sub[kk] = (P.sub[kk] || 0) + size(v2); }
      if (Array.isArray(v) && s > 2000 && v[0] && typeof v[0] === 'object') for (const it of v) for (const [k2, v2] of Object.entries(it)) { const kk = k + '[].' + k2; P.sub[kk] = (P.sub[kk] || 0) + size(v2); }
    }
  }
  return per;
}
export function codexEntries(file) {
  const r = analyzeRollout(file); const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  // reconstrói textos: analyzeRollout guarda só hash; relemos as partes na mesma ordem
  const out = []; const calls = new Map();
  for (const l of lines) {
    let o; try { o = JSON.parse(l) } catch { continue }; const p = o.payload || {};
    if (o.type !== 'response_item') continue;
    if (p.type === 'custom_tool_call') calls.set(p.call_id, p.input);
    if (p.type === 'custom_tool_call_output') {
      const parts = (Array.isArray(p.output) ? p.output : []).filter(x => x.type === 'input_text' && !(/^Script (completed|failed)/.test(x.text) && x.text.length < 200));
      for (const part of parts) out.push({ text: part.text });
    }
  }
  const ans = r.answers; // mesma ordem e mesmo filtro (sem imagens/cabeçalhos)
  return out.map((x, i) => ({ tool: ans[i]?.cat ?? '?', text: x.text })).filter(x => x.tool.startsWith('ssam:'));
}
export function claudeEntries(file) {
  const rows = load(file); const names = new Map(); const out = [];
  for (const o of rows) {
    if (o.isSidechain) continue;
    if (o.type === 'assistant') for (const x of o.message?.content || []) if (x.type === 'tool_use') names.set(x.id, x.name);
    if (o.type === 'user' && Array.isArray(o.message?.content)) for (const x of o.message.content) if (x.type === 'tool_result') {
      const nm = names.get(x.tool_use_id) || ''; const m = nm.match(/^mcp__ssam[a-z_-]*__(.+)$/); if (!m) continue;
      const t = typeof x.content === 'string' ? x.content : (x.content || []).map(y => y.text || '').join('\n');
      out.push({ tool: /"outcome"\s*:\s*"refused"|PREFLIGHT_REFUSED/.test(t) ? 'ssam:recusas' : 'ssam:' + m[1], text: t });
    }
  }
  return out;
}