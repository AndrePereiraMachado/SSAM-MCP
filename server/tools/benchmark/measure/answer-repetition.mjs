// Source: contexto/repeticao.mjs; sha256: 59dd9b7d01152bf6581dbf9aad0d56cd27c72cc4d66cfe09c8fa1bf85d87c05b.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
// Quanto das respostas do SSAM o modelo JÁ tinha no mesmo contexto (mesmo thread/sessão): percorre o JSON de cada
// resposta; uma subárvore (≥300 chars) idêntica a uma já vista antes no mesmo contexto conta como repetida (não desce nela).
// Também: texto inteiro idêntico. Saída por ferramenta e por chave de topo. Uso: node repeticao.mjs --codex ... --claude ...
const fs = { readFileSync: value => typeof value === 'string' ? value : value.map(r=>JSON.stringify(r)).join('\n') };
import path from 'path'; import crypto from 'crypto';
import { codexEntries, claudeEntries } from './answer-anatomy.mjs';
const h = s => crypto.createHash('sha1').update(s).digest('hex');
function parse(t) {
  let o; const s = t.trim(); try { o = JSON.parse(s) } catch { const i = s.indexOf('{'); if (i < 0) return null; try { o = JSON.parse(s.slice(i)) } catch { return null } }
  if (o && Array.isArray(o.content) && o.content[0]?.type === 'text') { try { return JSON.parse(o.content[0].text) } catch { } }
  return o;
}
export function repetition(entries, { seen = new Set() } = {}) {
  const per = {}; const byKey = {};
  for (const { tool, text } of entries) {
    const P = per[tool] ??= { n: 0, chars: 0, repeated: 0, wholeDup: 0 };
    P.n++; P.chars += text.length;
    const th = h(text); if (seen.has('T' + th)) { P.wholeDup++; P.repeated += text.length; continue; } seen.add('T' + th);
    const o = parse(text); if (!o || typeof o !== 'object') continue;
    const walk = (v, key, depth) => {
      const s = JSON.stringify(v); if (s == null || s.length < 300) return;
      const k = h(s);
      if (seen.has(k)) { P.repeated += s.length; byKey[tool + ' ' + key] = (byKey[tool + ' ' + key] || 0) + s.length; return; }
      seen.add(k);
      if (depth > 6 || typeof v !== 'object') return;
      if (Array.isArray(v)) v.forEach(x => walk(x, key + '[]', depth + 1)); else for (const [kk, x] of Object.entries(v)) walk(x, key ? key + '.' + kk : kk, depth + 1);
    };
    walk(o, '', 0);
  }
  return { per, byKey };
}

import { transcriptCalls, contractRequeries } from './contract-requeries.mjs';
import { toolName } from './lane-outcomes.mjs';
import { classifyOutputPart } from './codex-context.mjs';
const isSsam = name => /^mcp__ssam/.test(name) || /^(ssam_|o11_|studio_|odc_|hybrid_)/.test(name);
const resultText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part.text ?? '').join('\n') : JSON.stringify(value ?? null);

export function transcriptAnswers(rows, { client = 'codex', thread = '' } = {}) {
  const calls = transcriptCalls(rows, { client, thread, preferEvents: false }), byId = new Map();
  for (const call of calls) { const list = byId.get(call.id) ?? []; list.push(call); byId.set(call.id, list); }
  // Attribution remains possible when args are variables, or when the sanitizer
  // intentionally removes exec source syntax. Do not count these as contract queries.
  if (client === 'codex') for (const row of rows) {
    const item = row.payload ?? {};
    if (item.type !== 'custom_tool_call' || !/(?:^|\.)exec$/.test(item.name ?? '') || byId.has(item.call_id)) continue;
    const names = [...new Set([...String(item.input ?? '').matchAll(/tools\.(mcp__ssam[\w-]*__[\w]+)/g)].map(match => match[1]))];
    if (names.length) byId.set(item.call_id, names.map(name => ({ name, args: null })));
  }
  const answers = [], cells = new Map(); let lastYieldTools = [];
  for (const row of rows) {
    const start = Date.parse(row.timestamp ?? '') || 0;
    if (row.type === 'compacted') { answers.push({ reset: true, start, thread }); continue; }
    if (client === 'claude') {
      if (row.type !== 'user') continue;
      for (const part of row.message?.content ?? []) if (part.type === 'tool_result') {
        const call = byId.get(part.tool_use_id)?.[0];
        if (call && isSsam(call.name)) {
          const text = resultText(part.content);
          // Keep Claude's original refusal family; Codex additionally recognizes
          // escaped exec output and schema dumps in classifyOutputPart.
          const tool = /"outcome"\s*:\s*"refused"|PREFLIGHT_REFUSED/.test(text) ? 'ssam:recusas' : 'ssam:' + toolName(call);
          answers.push({ tool, text, start, thread });
        }
      }
    } else {
      const item = row.payload ?? {};
      if (row.type !== 'response_item' || !['custom_tool_call_output', 'function_call_output'].includes(item.type)) continue;
      let associated = byId.get(item.call_id) ?? [];
      const direct = associated.filter(call => isSsam(call.name));
      if (direct.length) associated = direct;
      else {
        const wait = associated.find(call => /(?:^|\.)wait$/.test(call.name));
        associated = wait ? cells.get(wait.args?.cell_id) ?? lastYieldTools : [];
      }
      const parts = Array.isArray(item.output) ? item.output.map(part => part.text ?? '') : [resultText(item.output)];
      let index = 0;
      for (const text of parts) {
        const cell = text.match(/Script running with cell ID\s+([^\s]+)/);
        if (cell && associated.length) { cells.set(cell[1], associated); lastYieldTools = associated; }
        if (!text || (/^Script (completed|failed|running)/.test(text) && text.length < 200)) continue;
        const tool = classifyOutputPart(text, associated.map(call => 'ssam:' + toolName(call)), index++);
        if (!tool?.startsWith('ssam:')) continue;
        answers.push({ tool, text, start, thread });
      }
    }
  }
  return answers;
}

export function measureAnswerRepetition(entries, { from = -Infinity, to = Infinity } = {}) {
  from = typeof from === 'string' ? Date.parse(from) : from;
  to = typeof to === 'string' ? Date.parse(to) : to;
  const histories = new Map(), byTool = {}; let answerChars = 0, repeatedChars = 0;
  for (const entry of [...entries].sort((a, b) => a.start - b.start)) {
    if (entry.start > to) continue;
    const thread = entry.thread ?? '';
    const seen = histories.get(thread) ?? new Set(); histories.set(thread, seen);
    if (entry.reset) { seen.clear(); continue; }
    const measured = repetition([entry], { seen }).per[entry.tool];
    if (entry.start < from) continue;
    const counts = byTool[entry.tool] ??= { answerChars: 0, repeatedChars: 0, answers: 0 };
    counts.answerChars += measured.chars; counts.repeatedChars += measured.repeated; counts.answers++;
    answerChars += measured.chars; repeatedChars += measured.repeated;
  }
  for (const counts of Object.values(byTool)) counts.repeatedPct = counts.answerChars ? 100 * counts.repeatedChars / counts.answerChars : 0;
  return { answerChars, repeatedChars, repeatedPct: answerChars ? 100 * repeatedChars / answerChars : 0, byTool, method: 'recorded' };
}

export function measureRepeats(sources, options = {}) {
  if (options.client === 'claude') sources = claudeRepeatSources(sources);
  const calls = [], answers = [];
  const metadata = sources.map((source, index) => {
    const rows = source.rows ?? source;
    const first = rows.find(row => row.type === 'session_meta')?.payload;
    return { rows, context: first?.id ?? source.thread ?? source.file ?? String(index), parent: first?.parent_thread_id ?? source.parentThread, explicitRoot: source.rootThread };
  });
  const byId = new Map(metadata.map(source => [source.context, source]));
  for (const [index, source] of sources.entries()) {
    const { rows, context: thread, explicitRoot } = metadata[index];
    let rootThread = explicitRoot ?? thread;
    const visited = new Set();
    while (!explicitRoot && byId.get(rootThread)?.parent && !visited.has(rootThread)) { visited.add(rootThread); rootThread = byId.get(rootThread).parent; }
    calls.push(...transcriptCalls(rows, { ...options, thread, rootThread }));
    answers.push(...transcriptAnswers(rows, { ...options, thread }));
  }
  return { ...measureAnswerRepetition(answers, options), ...contractRequeries(calls, options) };
}

// Claude embeds sidechain rows in the main file and may repeat those same rows
// in a subagent file. Session IDs define roots; agent IDs define model contexts.
export function claudeRepeatSources(sources) {
  const groups = new Map(), seenCalls = new Set(), seenResults = new Set();
  const fileRoot = file => {
    if (!file) return null;
    const normalized = file.replaceAll('\\', '/');
    const subagent = /^(?:(.*)\/)?subagents\/[^/]+$/.exec(normalized);
    if (subagent) return subagent[1] ? path.posix.basename(subagent[1]) : null;
    return path.posix.basename(normalized).replace(/\.jsonl$/i, '');
  };
  const rootDefault = sources.map(source => !/(?:^|[\\/])subagents[\\/]/.test(source.file ?? '') && fileRoot(source.file)).find(Boolean)
    ?? sources.flatMap(source => source.rows ?? source).find(row => !row.isSidechain && row.sessionId)?.sessionId;
  const fileRootsByRecordedSession = new Map();
  for (const source of sources) {
    const root = fileRoot(source.file);
    if (root) for (const row of source.rows ?? source) if (row.sessionId) fileRootsByRecordedSession.set(row.sessionId, root);
  }
  // Prefer the separate subagent file when inline history omits the agent ID.
  const ordered = [...sources].sort((a, b) => Number(!/(?:^|[\\/])subagents[\\/]/.test(a.file ?? '')) - Number(!/(?:^|[\\/])subagents[\\/]/.test(b.file ?? '')));
  for (const [index, source] of ordered.entries()) {
    const rows = source.rows ?? source;
    const recordedSession = rows.find(row => row.sessionId)?.sessionId;
    const root = source.rootThread ?? fileRoot(source.file) ?? fileRootsByRecordedSession.get(recordedSession) ?? (source.file ? rootDefault : recordedSession) ?? rootDefault ?? String(index);
    const fileAgent = /(?:^|[\\/])subagents[\\/]([^\\/]+?)(?:\.jsonl)?$/.exec(source.file ?? '')?.[1];
    for (const row of rows) {
      // A resumed file can contain historical rows naming an older session.
      // File identity defines their shared root and preserves that history.
      const rowRoot = root;
      const agent = row.agentId ?? source.agentId ?? fileAgent ?? (row.isSidechain ? 'inline-sidechain' : 'main');
      const context = rowRoot + ':' + agent;
      const key = JSON.stringify([rowRoot, context]);
      const group = groups.get(key) ?? { rows: [], thread: context, rootThread: rowRoot };
      groups.set(key, group);
      if (Array.isArray(row.message?.content)) {
        const content = row.message.content.filter(part => {
          const id = part.type === 'tool_use' ? part.id : part.type === 'tool_result' ? part.tool_use_id : null;
          if (!id) return true;
          const seen = part.type === 'tool_use' ? seenCalls : seenResults;
          const identity = JSON.stringify([rowRoot, id]);
          if (seen.has(identity)) return false;
          seen.add(identity); return true;
        });
        if (content.length) group.rows.push({ ...row, message: { ...row.message, content } });
      } else group.rows.push(row);
    }
  }
  return [...groups.values()].filter(source => source.rows.length);
}
