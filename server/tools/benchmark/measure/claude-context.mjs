// Source: contexto/claude-ctx.mjs; sha256: 40e5251aedce22fae00669791c583add73f19e6e08f4a3867fcf24f4cc5de367.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
// Mede o contexto de cada requisição de uma sessão Claude Code (.jsonl), por categoria.
// Verdade: message.usage de cada resposta (id único): entrada = input + cache_creation + cache_read; saída = output_tokens
// (thinking em output_tokens_details.thinking_tokens; o thinking volta como entrada nas requisições seguintes — claude-think.mjs).
// Modelo de tokens:
//  - Requisição 1: o que não é item (prompt de sistema + ferramentas do cliente) = entrada real − itens estimados → "fixo:sistema+ferramentas-cliente".
//  - tool_result: chars / CPT_JSON (calibrado na própria sessão com pares do mesmo laço; mediana).
//  - texto do usuário e lembretes: chars / CPT_PROSA (3,5 = ESTIMATIVA; são pequenos).
//  - esquemas ssam carregados por ToolSearch (deferred_tools_record): MEDIDOS pelo salto da entrada na requisição seguinte
//    (Δentrada − saída anterior − outros itens novos), repartidos por chars.
//  - saída do modelo (texto, chamadas, thinking): tokens da própria resposta.
//  O que sobra por requisição = "fixo:nao-identificado" (erro do modelo de tokens; deve ficar perto de 0).
// Uso: node claude-ctx.mjs <sessao.jsonl> [--rows 1] [--from ISO] [--to ISO]
const fs = { readFileSync: value => typeof value === 'string' ? value : value.map(r=>JSON.stringify(r)).join('\n') };
import path from 'path';

export const CPT_PROSA = 3.5;
const txt = c => typeof c === 'string' ? c : (c || []).map(x => x.type === 'text' ? x.text : x.type === 'tool_result' ? txt(x.content) : x.type === 'image' ? '' : (x.text ?? '')).join('\n');
const ssamName = n => (n || '').match(/^mcp__ssam[a-z_-]*__(.+)$/)?.[1];

export function load(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
}

export function calibrate(rows, side = false) {
  const pairs = []; let prev = null, chars = 0, other = false; const seen = new Set();
  for (const o of rows) {
    if (o.isSidechain && !side) continue;
    if (o.type === 'user') {
      const c = o.message?.content;
      if (Array.isArray(c) && c.every(x => x.type === 'tool_result')) { for (const x of c) { chars += txt(x.content).length; if (Array.isArray(x.content) && x.content.some(y => y.type !== 'text')) other = true; } }
      else other = true;
    }
    if (o.type === 'attachment' && o.attachment?.type !== 'total_tokens_reminder') other = true;
    if (o.type === 'assistant' && o.message?.usage && !seen.has(o.message.id)) {
      seen.add(o.message.id); const u = o.message.usage; const inp = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
      if (prev && !other && chars > 3000) pairs.push({ d: inp - prev.in, out: prev.out, chars });
      prev = { in: inp, out: u.output_tokens }; chars = 0; other = false;
    }
  }
  const r = pairs.map(x => x.chars / Math.max(1, x.d - x.out)).sort((a, b) => a - b);
  const S = k => pairs.reduce((n, x) => n + k(x), 0);
  return { n: pairs.length, ratio: S(x => x.chars) / Math.max(1, S(x => x.d - x.out)), median: r[Math.floor(r.length / 2)], p25: r[Math.floor(r.length / 4)], p75: r[Math.floor(r.length * 3 / 4)] };
}

export function analyzeSession(file, opts = {}) {
  const rows = load(file);
  const cal = calibrate(rows, !!opts.side);
  const CPT = +(opts.cpt || (cal.n >= 3 ? cal.median : 2.4));
  let items = []; let pendingOut = []; const reqs = []; const toolNames = new Map(); const seenIds = new Set();
  let turnIdx = 0, reqNo = 0, compactions = 0, prevReq = null, lastReq = null;
  const from = opts.from ? Date.parse(opts.from) : -Infinity, to = opts.to ? Date.parse(opts.to) : Infinity;
  const add = (cat, chars, cpt, extra = {}) => { const it = { cat, chars, tok: cpt ? chars / cpt : 0, ...extra }; items.push(it); return it; };
  const loaded = new Map(); const schemaJumps = [];
  for (const o of rows) {
    if (o.isSidechain && !opts.side) continue;
    if (o.type === 'system' && o.subtype === 'compact_boundary') { compactions++; items = items.filter(i => i.cat.startsWith('fixo:') || i.cat.startsWith('ssam:esquemas') || i.cat.startsWith('ssam:instr') || i.cat.startsWith('ssam:lista')); continue; }
    if (o.type === 'attachment') {
      const a = o.attachment || {};
      if (a.type === 'prompt_snapshot') continue; // fica no bloco fixo medido na requisição 1
      if (a.type === 'deferred_tools_record') {
        for (const e of (Array.isArray(a.entries) ? a.entries : Object.values(a.entries || {}))) {
          if (loaded.has(e.name)) continue; const n = JSON.stringify(e).length; loaded.set(e.name, n);
          add(ssamName(e.name) ? 'ssam:esquemas-carregados' : 'outros:esquemas-carregados', n, 0, { schema: true, name: e.name });
        }
        continue;
      }
      if (a.type === 'deferred_tools_delta') {
        const names = a.addedNames || []; const ss = names.filter(n => ssamName(n)).length; const all = names.length || 1;
        const n = JSON.stringify(a.addedLines ?? names).length;
        if (ss) add('ssam:lista-de-nomes-adiados', n * ss / all, CPT_PROSA); if (all - ss > 0 && n) add('instr:lista-adiados-outros', n * (all - ss) / all, CPT_PROSA);
        continue;
      }
      if (a.type === 'mcp_instructions_delta') { (a.addedNames || []).forEach((nm, i) => add(/ssam/.test(nm) ? 'ssam:instrucoes-do-servidor' : 'instr:instrucoes-mcp-outros', (a.addedBlocks?.[i] || '').length, CPT_PROSA)); continue; }
      if (a.type === 'instructions') { add('instr:CLAUDE.md+AGENTS+memoria', JSON.stringify(a.files ?? '').length, CPT_PROSA); continue; }
      if (a.type === 'skill_listing') { add('instr:lista-de-skills', (a.content || '').length, CPT_PROSA); continue; }
      add('instr:lembretes', JSON.stringify(a).length, CPT_PROSA);
      continue;
    }
    if (o.type === 'user') {
      const c = o.message?.content;
      if (o.isCompactSummary) { add('compactado:resumo', txt(c).length, CPT_PROSA); continue; }
      if (typeof c === 'string') { add(o.isMeta ? 'instr:meta' : 'usuario:pedido', c.length, CPT_PROSA); if (!o.isMeta) turnIdx++; continue; }
      let hasText = false, hasTR = false;
      for (const x of c || []) {
        if (x.type === 'tool_result') {
          hasTR = true;
          const nm = toolNames.get(x.tool_use_id) || '?'; const t = txt(x.content);
          const imgs = Array.isArray(x.content) ? x.content.filter(y => y.type === 'image').length : 0;
          const s = ssamName(nm); let cat;
          if (s) cat = /"outcome"\s*:\s*"refused"|PREFLIGHT_REFUSED/.test(t) ? 'ssam:recusas' : 'ssam:' + s;
          else if (nm === 'ToolSearch') cat = 'outros:toolsearch';
          else if (/^(Read|Grep|Glob)$/.test(nm)) cat = 'outros:ler-arquivos';
          else if (/^(Bash|PowerShell)$/.test(nm)) cat = 'outros:shell';
          else if (/^(Agent|Task|Workflow|SendMessage)$/.test(nm)) cat = 'subagente:resultado';
          else cat = 'outros:' + nm.replace(/^mcp__/, '');
          add(cat, t.length, CPT, imgs ? { extraTok: imgs * 1600 } : {});
        } else if (x.type === 'text') { hasText = true; add(o.isMeta ? 'instr:meta' : 'usuario:pedido', x.text.length, CPT_PROSA); }
        else if (x.type === 'image') add('usuario:imagem', 0, 0, { extraTok: 1600 });
      }
      if (hasText && !hasTR && !o.isMeta) turnIdx++;
      continue;
    }
    if (o.type === 'assistant') {
      const m = o.message || {};
      for (const x of m.content || []) {
        if (x.type === 'thinking' || x.type === 'redacted_thinking') pendingOut.push(add('modelo:raciocinio', 0, 0, { kind: 'think' }));
        else if (x.type === 'text') pendingOut.push(add('modelo:texto', x.text.length, 0));
        else if (x.type === 'tool_use') { toolNames.set(x.id, x.name); const s = ssamName(x.name); pendingOut.push(add(s ? 'modelo:entrada-ssam' : /^(Agent|Workflow|SendMessage)$/.test(x.name) ? 'modelo:prompt-subagente' : 'modelo:entrada-outras', JSON.stringify(x.input ?? {}).length, 0)); }
      }
      if (m.usage && !seenIds.has(m.id)) {
        seenIds.add(m.id);
        const u = m.usage; const inp = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens; const t = Date.parse(o.timestamp);
        const think = u.output_tokens_details?.thinking_tokens ?? 0;
        // saídas desta resposta = pendingOut (os blocos seguintes do mesmo id entram depois em lastReq.outItems)
        const outSet = new Set(pendingOut);
        const fresh = items.filter(it => !outSet.has(it) && it.seen == null);
        for (const it of items) if (it.extraTok && !it.extraDone) { it.tok += it.extraTok; it.extraDone = true; }
        if (reqNo === 0) {
          const known = items.filter(it => !outSet.has(it)).reduce((n, it) => n + it.tok, 0);
          const fixedIt = { cat: 'fixo:sistema+ferramentas-cliente', chars: 0, tok: Math.max(0, inp - known) };
          items.unshift(fixedIt); fresh.push(fixedIt);
        } else {
          const sch = fresh.filter(it => it.schema);
          if (sch.length) {
            const other = fresh.filter(it => !it.schema).reduce((n, it) => n + it.tok, 0);
            let jump = inp - prevReq.in - prevReq.out - other;
            const chars = sch.reduce((n, it) => n + it.chars, 0);
            if (jump <= 0) jump = chars / 2.5;
            for (const it of sch) it.tok = jump * it.chars / chars;
            schemaJumps.push({ req: reqNo + 1, chars, tok: Math.round(jump), cpt: +(chars / jump).toFixed(2), names: sch.map(s => s.name.replace(/^mcp__ssam__/, '')) });
          }
        }
        const byCat = {}; for (const it of items) if (!outSet.has(it)) byCat[it.cat] = (byCat[it.cat] || 0) + it.tok;
        const est = Object.values(byCat).reduce((a, b) => a + b, 0);
        const added = {}; for (const it of fresh) { it.seen = reqNo + 1; added[it.cat] = (added[it.cat] || 0) + it.tok; }
        reqNo++;
        const cur = { i: reqNo, id: m.id, at: o.timestamp, turn: turnIdx, in: inp, cached: u.cache_read_input_tokens, created: u.cache_creation_input_tokens, out: u.output_tokens, reas: think, est: Math.round(est), fixed: Math.round(inp - est), byCat, added, outItems: pendingOut };
        if (t >= from && t <= to) reqs.push(cur);
        prevReq = cur; lastReq = cur; pendingOut = [];
      } else if (m.usage && lastReq) { for (const it of pendingOut) lastReq.outItems.push(it); pendingOut = []; }
      if (lastReq) assignOut(lastReq);
      continue;
    }
  }
  function assignOut(r) {
    const th = r.outItems.filter(i => i.kind === 'think'), vis = r.outItems.filter(i => i.kind !== 'think');
    const visTok = Math.max(0, r.out - r.reas);
    for (const i of th) i.tok = r.reas / th.length;
    if (!th.length && r.reas && vis.length) { /* thinking sem bloco registrado: conta junto do visível */ }
    const vc = vis.reduce((n, i) => n + Math.max(1, i.chars), 0); for (const i of vis) i.tok = (th.length ? visTok : r.out) * Math.max(1, i.chars) / vc;
  }
  return { file: typeof file === 'string' ? 'transcript' : 'rows', CPT, cal, compactions, reqs, schemaJumps, loaded: Object.fromEntries(loaded) };
}

export function summarize(res, filter = () => true) {
  const R = res.reqs.filter(filter);
  const added = {}; const cats = {};
  for (const r of R) { for (const [k, v] of Object.entries(r.added || {})) added[k] = (added[k] || 0) + v; for (const [k, v] of Object.entries(r.byCat)) cats[k] = (cats[k] || 0) + v; cats['fixo:nao-identificado'] = (cats['fixo:nao-identificado'] || 0) + r.fixed; }
  const S = k => R.reduce((n, r) => n + r[k], 0);
  const fixed = R.map(r => r.fixed).sort((a, b) => a - b);
  return { n: R.length, sumIn: S('in'), sumCached: S('cached'), sumCreated: S('created'), sumOut: S('out'), sumReas: S('reas'), firstIn: R[0]?.in, lastIn: R.at(-1)?.in, maxIn: Math.max(...R.map(r => r.in)), meanIn: Math.round(S('in') / Math.max(1, R.length)), fixedMedian: fixed[Math.floor(fixed.length / 2)], fixedP10: fixed[Math.floor(fixed.length / 10)], fixedP90: fixed[Math.floor(fixed.length * 9 / 10)], added, cats };
}
