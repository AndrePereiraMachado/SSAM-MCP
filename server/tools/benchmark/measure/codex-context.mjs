// Source: contexto/codex-ctx.mjs; sha256: 436a588bef02389b7482da736bc59602d2bf0763b0d7dbf5d8c47eec315fafc5.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
// Mede o contexto de cada requisição de um thread Codex (rollout .jsonl), por categoria.
// Fonte da verdade: token_usage_record.usage (input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens).
// Itens do contexto: response_item na ordem do arquivo; "compacted" substitui o histórico.
// Tokens de itens de entrada = chars / CPT (calibrado em calibra.mjs: 3,73 chars/token nos pares do mesmo turno).
// Tokens de itens de saída do modelo = os da própria requisição (raciocínio = reasoning_output_tokens; resto dividido por chars).
// O que não aparece no rollout (prompt base + definições de ferramentas do cliente) fica como "fixo (não registrado)" =
// entrada real − soma estimada, medido por requisição.
// Uso: node codex-ctx.mjs <rollout.jsonl> [--label X] [--from ISO] [--to ISO] [--json out.json]
const fs = { readFileSync: value => typeof value === 'string' ? value : value.map(r=>JSON.stringify(r)).join('\n') };
import path from 'path';
import crypto from 'crypto';
const hash = t => crypto.createHash('sha1').update(t).digest('hex').slice(0, 12);

export const CPT = 3.73;
const txt = c => typeof c === 'string' ? c : (c || []).map(x => x.text ?? '').join('\n');
const SSAM_RE = /tools\.(mcp__(ssam[a-z_]*)__([a-z0-9_]+))\s*\(/g;

export function classifyOutputPart(text, calls, idx) {
  if (/exec tool declaration|^\s*\[?\{"name":"mcp__|"description":"SSAM Hybrid controls/.test(text)) return /mcp__ssam|SSAM Hybrid controls/.test(text.slice(0, 4000)) ? 'ssam:esquemas-de-ferramentas' : 'outros:esquemas-de-ferramentas';
  if (/"outcome\\?"\s*:\s*\\?"refused|PREFLIGHT_REFUSED|"refused\\?"/.test(text)) return 'ssam:recusas';
  const call = calls[idx] ?? (calls.length === 1 ? calls[0] : null);
  if (call) return call;
  if (calls.length) return 'ssam:' + [...new Set(calls.map(c => c.replace(/^ssam:/, '')))].join('+');
  return null;
}
export function callsOf(code = '') {
  const out = [];
  for (const m of code.matchAll(SSAM_RE)) out.push('ssam:' + m[3]);
  if (/ALL_TOOLS/.test(code) && !out.length) out.push(/ssam/.test(code) ? 'ssam:esquemas-de-ferramentas' : 'outros:esquemas-de-ferramentas');
  for (const m of code.matchAll(/tools\.(exec_command|apply_patch|view_image|write_stdin)\s*\(/g)) out.push('shell:' + m[1]);
  if (/tools\.mcp__node_repl__js\s*\(/.test(code)) out.push('outros:node_repl-ler-arquivo');
  for (const m of code.matchAll(/tools\.mcp__([a-z0-9]+(?:_[a-z0-9]+)*?)__([A-Za-z0-9_]+)\s*\(/g)) if (!/^ssam/.test(m[1]) && m[1] !== 'node_repl') out.push('mcp:' + m[1] + ':' + m[2]);
  return out;
}
function shellKind(code) {
  if (/Get-Content|cat |Select-String|rg |type /i.test(code)) return 'shell:ler-arquivos';
  return 'shell:outros';
}

export function analyzeRollout(file, opts = {}) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const meta = {};
  let items = [];           // contexto atual
  let pendingOut = [];      // itens de saída da requisição em curso
  let pendingCalls = new Map();
  const reqs = []; const answers = []; let lastTs = null, lastInputTs = null, prevRecTs = null;
  let turn = null, turnIdx = 0, compactions = 0, reqNo = 0;
  const from = opts.from ? Date.parse(opts.from) : -Infinity, to = opts.to ? Date.parse(opts.to) : Infinity;
  const add = (cat, chars, extra = {}) => { const it = { cat, chars, tok: chars / CPT, turn: turnIdx, ...extra }; items.push(it); return it; };
  const baseChars = 0;
  let first = true;
  for (const l of lines) {
    let o; try { o = JSON.parse(l) } catch { continue }
    const p = o.payload || {};
    lastTs = o.timestamp;
    if (o.type === 'response_item' && (/call_output$/.test(p.type) || (p.type === 'message' && p.role !== 'assistant') || p.type === 'agent_message')) lastInputTs = Date.parse(o.timestamp);
    if (o.type === 'session_meta' && first) { first = false; Object.assign(meta, { id: p.id, fork: p.forked_from_id ?? null, base: p.base_instructions?.text?.length ?? 0, nick: p.source?.subagent?.thread_spawn?.agent_nickname ?? null }); if (meta.base) add('instr:prompt-base-codex', meta.base); continue; }
    if (o.type === 'event_msg' && p.type === 'task_started') { turnIdx++; turn = p.turn_id; continue; }
    if (o.type === 'compacted') {
      compactions++;
      const kept = [];
      const baseIt = items.find(i => i.cat === 'instr:prompt-base-codex');
      if (baseIt) kept.push(baseIt);
      items = kept;
      for (const ri of p.replacement_history || []) ingest(ri, true);
      pendingOut = [];
      continue;
    }
    if (o.type === 'response_item') { ingest(p, false); continue; }
    if (o.type === 'token_usage_record') {
      const u = p.usage; const t = Date.parse(o.timestamp);
      // contexto de entrada = items exceto pendingOut
      const outSet = new Set(pendingOut);
      const byCat = {};
      for (const it of items) if (!outSet.has(it)) byCat[it.cat] = (byCat[it.cat] || 0) + it.tok;
      const est = Object.values(byCat).reduce((a, b) => a + b, 0);
      // atribui tokens de saída aos itens desta requisição
      const reas = pendingOut.filter(i => i.cat === 'modelo:raciocinio');
      const vis = pendingOut.filter(i => i.cat !== 'modelo:raciocinio');
      const reasTok = u.reasoning_output_tokens || 0, visTok = Math.max(0, (u.output_tokens || 0) - reasTok);
      const rc = reas.reduce((n, i) => n + (i.enc || 1), 0); for (const i of reas) i.tok = reasTok * (i.enc || 1) / rc;
      const vc = vis.reduce((n, i) => n + Math.max(1, i.chars), 0); for (const i of vis) i.tok = visTok * Math.max(1, i.chars) / vc;
      if (!reas.length && reasTok) { /* raciocínio sem item (raro) */ add('modelo:raciocinio', 0).tok = reasTok; }
      // itens que entram pela 1ª vez nesta requisição (custo "uma vez")
      const added = {};
      for (const it of items) if (!outSet.has(it) && it.seen == null) { it.seen = reqNo + 1; added[it.cat] = (added[it.cat] || 0) + it.tok; }
      reqNo++;
      const start = Math.max(prevRecTs ?? -Infinity, lastInputTs ?? -Infinity); const dur = Number.isFinite(start) ? (t - start) / 1000 : null; prevRecTs = t;
      if (t >= from && t <= to) reqs.push({ i: reqNo, at: o.timestamp, dur, turn: turnIdx, in: u.input_tokens, cached: u.cached_input_tokens, out: u.output_tokens, reas: reasTok, est: Math.round(est), fixed: Math.round(u.input_tokens - est), byCat, added });
      pendingOut = [];
      continue;
    }
  }
  function ingest(p, fromCompaction) {
    if (p.type === 'message') {
      const t = txt(p.content); const n = t.length + (Array.isArray(p.content) ? p.content.filter(c => c.type === 'input_image').length * 765 * CPT : 0);
      if (p.role === 'developer') add('instr:developer-codex', n);
      else if (p.role === 'user') {
        if (t.startsWith('# AGENTS.md')) add('instr:AGENTS.md', n);
        else if (t.trimStart().startsWith('<')) add('instr:contexto-app', n);
        else add(fromCompaction ? 'compactado:usuario' : 'usuario:pedido', n);
      } else if (p.role === 'assistant') { const it = add(fromCompaction ? 'compactado:modelo' : 'modelo:texto', t.length); if (!fromCompaction) pendingOut.push(it); }
      return;
    }
    if (p.type === 'reasoning') { const it = add('modelo:raciocinio', 0, { enc: (p.encrypted_content || '').length || 1 }); if (!fromCompaction) pendingOut.push(it); return; }
    if (p.type === 'agent_message') { add('subagente:mensagens', JSON.stringify(p.content ?? p.message ?? '').length); return; }
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const code = p.input ?? p.arguments ?? '';
      const calls = callsOf(code);
      pendingCalls.set(p.call_id, { name: p.name, code, calls });
      const cat = p.type === 'function_call' ? 'modelo:chamada-' + (p.name || 'fn') : 'modelo:codigo-exec';
      const it = add(cat, code.length); if (!fromCompaction) pendingOut.push(it); return;
    }
    if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const c = pendingCalls.get(p.call_id) || { name: '?', code: '', calls: [] };
      if (p.type === 'function_call_output') { add(/^(wait|wait_agent|followup_task|send_message|spawn_agent)$/.test(c.name) ? 'subagente:resultado' : 'ferramenta:' + (c.name || 'fn'), txt(p.output).length); return; }
      const parts = Array.isArray(p.output) ? p.output : [{ type: 'input_text', text: String(p.output ?? '') }];
      const ssamCalls = c.calls.filter(x => x.startsWith('ssam:'));
      let k = 0;
      for (const part of parts) {
        if (part.type === 'input_image') { add('ferramenta:imagem', 765 * CPT); continue; }
        const t = part.text ?? '';
        if (/^Script (completed|failed)/.test(t) && t.length < 200) { add('ferramenta:cabecalho-exec', t.length); continue; }
        let cat = classifyOutputPart(t, ssamCalls, k);
        const otherMcp = c.calls.find(x => x.startsWith('mcp:'));
        if (!cat) cat = c.calls.some(x => x.startsWith('shell:')) ? shellKind(c.code) : c.calls.includes('outros:node_repl-ler-arquivo') ? 'outros:node_repl-ler-arquivo' : otherMcp ? 'outros:mcp-' + otherMcp.split(':')[1] : 'ferramenta:outros';
        k++;
        add(cat, t.length);
        answers.push({ cat, chars: t.length, req: reqNo + 1, hash: hash(t), at: lastTs, code: c.code.slice(0, 300) });
      }
      return;
    }
  }
  return { file: typeof file === 'string' ? 'transcript' : 'rows', meta, compactions, reqs, answers: answers.filter(a => Date.parse(a.at) >= from && Date.parse(a.at) <= to) };
}

export function summarize(res, filter = () => true) {
  const R = res.reqs.filter(filter);
  const added = {};
  for (const r of R) for (const [k, v] of Object.entries(r.added || {})) added[k] = (added[k] || 0) + v;
  const sumIn = R.reduce((n, r) => n + r.in, 0), sumCached = R.reduce((n, r) => n + r.cached, 0), sumOut = R.reduce((n, r) => n + r.out, 0), sumReas = R.reduce((n, r) => n + r.reas, 0);
  const cats = {};
  for (const r of R) { for (const [k, v] of Object.entries(r.byCat)) cats[k] = (cats[k] || 0) + v; cats['fixo:nao-registrado'] = (cats['fixo:nao-registrado'] || 0) + r.fixed; }
  const fixed = R.map(r => r.fixed).sort((a, b) => a - b);
  return { n: R.length, added, sumIn, sumCached, sumOut, sumReas, firstIn: R[0]?.in, lastIn: R.at(-1)?.in, maxIn: Math.max(...R.map(r => r.in)), meanIn: Math.round(sumIn / Math.max(1, R.length)), fixedMedian: fixed[Math.floor(fixed.length / 2)], fixedP10: fixed[Math.floor(fixed.length / 10)], fixedP90: fixed[Math.floor(fixed.length * 9 / 10)], cats };
}
