// Source: contexto/tempo-consultas.mjs; sha256: 124ae6d2c4d624ec8c2d1c5fdea571ac20d5a77aa6075392a272cbafe61bf13a.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
// Tempo de modelo gasto em requisições que só consultaram descrições/esquemas de ferramentas
// (Codex: exec só com ALL_TOOLS; Claude: ToolSearch) e tempo total de requisições (Σdur) por arquivo/janela.
const fs = { readFileSync: value => typeof value === 'string' ? value : value.map(r=>JSON.stringify(r)).join('\n') };
import { load } from './claude-context.mjs';
export function codexLookups(file, from = -Infinity, to = Infinity) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let prevRec = null, lastIn = null, outs = []; const res = { reqs: 0, durAll: 0, lookupReqs: 0, lookupDur: 0, lookupOut: 0 };
  for (const l of lines) {
    let o; try { o = JSON.parse(l) } catch { continue }; const p = o.payload || {}; const t = Date.parse(o.timestamp);
    if (o.type === 'response_item' && (/call_output$/.test(p.type) || (p.type === 'message' && p.role !== 'assistant') || p.type === 'agent_message')) lastIn = t;
    if (o.type === 'response_item' && /call$/.test(p.type)) outs.push(p.input ?? p.arguments ?? '');
    if (o.type === 'token_usage_record') {
      const start = Math.max(prevRec ?? -Infinity, lastIn ?? -Infinity); const dur = Number.isFinite(start) ? (t - start) / 1000 : 0; prevRec = t;
      if (t >= from && t <= to) {
        res.reqs++; res.durAll += dur;
        const lookup = outs.length && outs.every(c => /ALL_TOOLS/.test(c) && !/await tools\.mcp__/.test(c));
        if (lookup) { res.lookupReqs++; res.lookupDur += dur; res.lookupOut += p.usage.output_tokens; }
      }
      outs = [];
    }
  }
  return res;
}
export function claudeLookups(file, from = -Infinity, to = Infinity) {
  const rows = load(file); const seen = new Set(); let lastIn = null; const res = { reqs: 0, durAll: 0, lookupReqs: 0, lookupDur: 0 };
  const byId = new Map();
  for (const o of rows) {
    if (o.isSidechain) continue;
    if (o.type === 'user') lastIn = Date.parse(o.timestamp);
    if (o.type === 'assistant' && o.message?.id) {
      const id = o.message.id; let r = byId.get(id);
      if (!r) { r = { start: lastIn, end: Date.parse(o.timestamp), tools: [] }; byId.set(id, r); }
      r.end = Date.parse(o.timestamp);
      for (const x of o.message.content || []) if (x.type === 'tool_use') r.tools.push(x.name);
    }
  }
  for (const r of byId.values()) {
    if (!r.start || r.end < from || r.end > to) continue; const dur = (r.end - r.start) / 1000;
    res.reqs++; res.durAll += dur; if (r.tools.length && r.tools.every(n => n === 'ToolSearch')) { res.lookupReqs++; res.lookupDur += dur; }
  }
  return res;
}