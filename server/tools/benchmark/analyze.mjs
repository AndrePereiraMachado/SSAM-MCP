import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrichRequest } from './measure/request-metrics.mjs';
import { codexRelatedFiles } from './measure/transcript-discovery.mjs';
import { isCont } from './measure/legacy-owner-continuation.mjs';
import { exportView, exportFindings, persistenceRefusal } from './privacy.mjs';

export const ssamShell = /\b(ssam(\.cmd)?\s|odc(\.cmd)?\s|anvil(\.dll)?\b|run_job|o11_|studio_env|open_studio|\.local[\\/]cli)/i;
const json = value => JSON.stringify(value ?? '');
const wire = value => typeof value === 'string' ? value : json(value);
const bytes = value => Buffer.byteLength(wire(value), 'utf8');
const time = row => Date.parse(row.timestamp);
export const localTime = value => new Date(new Date(value).getTime() - 10800000).toISOString().replace('Z', '-03:00');
export function parseJsonl(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).flatMap(line => {
    try { const row = JSON.parse(line); return Number.isFinite(time(row)) ? [row] : []; } catch { return []; }
  });
}
export function category(name = '', input = '') {
  const text = wire(input);
  if (name.startsWith('mcp__ssam') || text.includes('mcp__ssam')) return 'ssam';
  if (/Bash|PowerShell|exec_command|shell/i.test(name) && ssamShell.test(text)) return 'ssam';
  return name.startsWith('mcp__') ? 'other-mcp' : 'other';
}
export function unionSeconds(intervals) {
  let total = 0, end = -Infinity;
  for (const [a, b] of intervals.slice().sort((a, b) => a[0] - b[0])) {
    if (b >= a) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
  }
  return total / 1000;
}
// Only parsed protocol objects prove delivery or refusal; prose is never evidence.
export function outcomes(value) {
  const found = [];
  function walk(v, depth = 0) {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') { try { walk(JSON.parse(v), depth + 1); } catch {} return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== 'object') return;
    if (v.outcome === 'refused') found.push({ kind: 'refused', code: v.code ?? 'UNKNOWN', problems: [...new Set([...(String(v.error ?? '').matchAll(/\[([A-Z][A-Z0-9_]*)\]/g))].map(x => x[1]).concat((v.problems ?? []).map(x => x.code).filter(Boolean)))] });
    if (v.ok === true && ['entregue', 'entregue e publicado', 'delivered'].includes(v.outcome ?? v.result)) found.push({ kind: 'accepted' });
    for (const [key, x] of Object.entries(v)) if (!['error', 'problems'].includes(key)) walk(x, depth + 1);
  }
  walk(value); return found;
}
function textParts(content) { return typeof content === 'string' ? content : (content ?? []).filter(x => ['text','input_text','output_text'].includes(x.type)).map(x => x.text ?? '').join('\n'); }
function summarize(rows, client, meta = {}) {
  const pending = new Map(), calls = [], refusals = [], tokenIds = new Set();
  let written = 0, read = 0, outputTokens = 0, lastToken = meta.tokenBaseline ?? 0, assistantText = 0, acceptedAt = null, refusedOrError = 0, model = meta.model ?? null;
  for (const row of rows) {
    const p = row.payload ?? {}, t = time(row), content = row.message?.content;
    if (row.type === 'turn_context') model = p.model ?? model;
    if (client === 'codex') {
      if (p.type === 'message' && p.role === 'assistant') assistantText += bytes(textParts(p.content));
      if (p.type === 'token_count' && p.info?.total_token_usage) { const next = p.info.total_token_usage.output_tokens ?? lastToken; outputTokens += Math.max(0, next - lastToken); lastToken = next; }
      if (['function_call','custom_tool_call'].includes(p.type)) add(p.call_id, p.name, p.type === 'function_call' ? p.arguments : p.input, t);
      if (['function_call_output','custom_tool_call_output'].includes(p.type)) finish(p.call_id, p.output, t, false);
    } else {
      if (row.type === 'assistant') {
        model = row.message?.model ?? model;
        const id = row.message?.id;
        if (!id || !tokenIds.has(id)) { outputTokens += row.message?.usage?.output_tokens ?? 0; if (id) tokenIds.add(id); }
        assistantText += bytes(textParts(content));
        for (const c of Array.isArray(content) ? content : []) if (c.type === 'tool_use') add(c.id, c.name, json(c.input ?? {}), t);
      }
      if (row.type === 'user') for (const c of Array.isArray(content) ? content : []) if (c.type === 'tool_result') finish(c.tool_use_id, c.content, t, c.is_error);
    }
  }
  function add(id, name, input, start) { const call = { id, name, input, start, end: start, category: category(name, input) }; pending.set(id, call); calls.push(call); written += bytes(input); }
  function finish(id, output, end, isError) {
    const call = pending.get(id); if (!call) return;
    pending.delete(id); call.end = Math.max(call.start, end); read += bytes(output);
    const body = json(output);
    if (isError || body.includes('REFUSED') || body.includes('"refused"')) refusedOrError++;
    if (call.category !== 'ssam') return;
    for (const o of outcomes(output)) {
      if (o.kind === 'refused') refusals.push({ at: localTime(end), code: o.code, problems: o.problems });
      else acceptedAt = localTime(end);
    }
  }
  const start = meta.start ?? time(rows[0]), end = meta.end ?? time(rows.at(-1));
  const wall = Math.max(0, end - start) / 1000, sum = calls.reduce((n,c) => n + (c.end-c.start)/1000,0);
  return { id: meta.id, client, model, prompt: (meta.prompt ?? '').slice(0,120), start: localTime(start), end: localTime(end), wallMin: wall/60, toolSecSum: sum, toolSecUnion: unionSeconds(calls.map(c=>[c.start,c.end])), ssamSec: calls.filter(c=>c.category==='ssam').reduce((n,c)=>n+(c.end-c.start)/1000,0), modelPct: wall ? 100-100*sum/wall : 100, writtenKB: written/1024, readKB: read/1024, rounds: calls.length, outputTokens, subagents: [], writtenKBTotal: written/1024, roundsTotal: calls.length, refusals, refusalsByCode: Object.fromEntries([...new Set(refusals.map(x=>x.code))].map(code=>[code,refusals.filter(x=>x.code===code).length])), accepted: acceptedAt !== null, acceptedAt, refusedOrError, assistantTextKB: assistantText/1024, file: meta.file };
}
function codexTurns(rows, child = false) {
  const turns = []; let active = null, baseline = 0, model = null;
  for (const row of rows) {
    const p = row.payload ?? {};
    if (row.type === 'turn_context') model = p.model ?? model;
    if (p.type === 'task_started') {
      const a = p.turn_attribution ?? {};
      if ((a.parent_turn_id != null) !== child) { active = null; continue; }
      active = { id: p.turn_id ?? a.turn_id, root: p.root_turn_id ?? a.root_turn_id, rows: [], tokenBaseline: baseline, model, aborted: false }; turns.push(active);
    }
    if (active) active.rows.push(row);
    if (p.type === 'token_count') baseline = p.info?.total_token_usage?.output_tokens ?? baseline;
    if (active && ['task_complete','turn_aborted'].includes(p.type)) { active.aborted = p.type === 'turn_aborted'; active = null; }
  }
  return turns;
}
function attach(result, subs) {
  result.subagents = subs;
  result.writtenKBTotal += subs.reduce((n,s)=>n+s.writtenKB,0);
  result.roundsTotal += subs.reduce((n,s)=>n+s.rounds,0);
  result.subagentTurns = subs.reduce((n,s)=>n+s.turns,0);
  return result;
}
export function analyzeCodex(rows, options = {}) {
  const metadata = rows.find(r=>r.type==='session_meta')?.payload ?? {};
  const turns = codexTurns(rows, false), groups = [];
  for (const turn of turns) { if (groups.at(-1)?.aborted) { const g=groups.at(-1); g.rows.push(...turn.rows); g.ids.push(turn.id); g.aborted=turn.aborted; } else groups.push({...turn,ids:[turn.id]}); }
  const selected = options.windows?.length ? options.windows.map(w=>{
    const start = Date.parse(w.start), end = Date.parse(w.end);
    const before = rows.filter(r=>time(r)<start);
    const tokenBaseline = before.findLast(r=>r.payload?.type==='token_count')?.payload.info?.total_token_usage?.output_tokens ?? 0;
    const model = before.findLast(r=>r.type==='turn_context')?.payload.model ?? null;
    return {id:w.name, tokenBaseline, model, rows:rows.filter(r=>time(r)>=start&&time(r)<=end), ids:turns.filter(t=>t.rows.some(r=>time(r)>=start&&time(r)<=end)).map(t=>t.id)};
  }) : groups;
  return selected.filter(g=>g.rows.length).flatMap(g=>{
    const prompt = g.rows.filter(r=>r.payload?.type==='message'&&r.payload?.role==='user')
      .flatMap(r=>(r.payload.content??[]).filter(c=>c.type==='input_text').map(c=>c.text??''))
      .find(s=>s && !s.trimStart().startsWith('<') && !s.trimStart().startsWith('# AGENTS.md instructions')) ?? '';
    if(options.tag && !prompt.split(/\r?\n/)[0].startsWith(`[${options.tag}`)) return [];
    const result = summarize(g.rows,'codex',{...g,prompt,file:options.file});
    const subs=[];
    for (const sub of options.subagents ?? []) {
      const sm = sub.rows.find(r=>r.type==='session_meta')?.payload ?? {};
      if(sm.parent_thread_id !== metadata.id) continue;
      const st=codexTurns(sub.rows,true).filter(t=>g.ids.includes(t.root));
      if(!st.length) continue;
      const metrics=st.map(t=>summarize(t.rows,'codex',t));
      const aggregate={name:sm.agent_nickname ?? sm.id,file:sub.file,wallMin:metrics.reduce((n,m)=>n+m.wallMin,0),turns:st.length};
      for(const k of ['writtenKB','readKB','rounds','outputTokens','assistantTextKB']) aggregate[k]=metrics.reduce((n,m)=>n+m[k],0);
      subs.push(aggregate);
    }
    return [enrichRequest(attach(result,subs),rows,options.subagents ?? [],options,prompt)];
  });
}
function claudePrompt(row) { if(row.type!=='user') return ''; const c=row.message?.content; return Array.isArray(c)&&c.some(x=>x.type==='tool_result') ? '' : textParts(c); }
export function analyzeClaude(rows, options = {}) {
  const main=rows.filter(r=>!r.isSidechain), groups=[];
  if(options.windows?.length) for(const w of options.windows) groups.push({id:w.name,rows:main.filter(r=>time(r)>=Date.parse(w.start)&&time(r)<=Date.parse(w.end))});
  else for(const row of main) { const prompt=claudePrompt(row); if(prompt && !(groups.length && isCont(prompt))) groups.push({id:row.uuid ?? `request-${groups.length+1}`,rows:[],prompt}); if(groups.length) groups.at(-1).rows.push(row); }
  return groups.filter(g=>g.rows.length).flatMap(g=>{
    const prompt=g.prompt ?? g.rows.map(claudePrompt).find(Boolean) ?? '';
    if(options.tag&&!prompt.split(/\r?\n/)[0].startsWith(`[${options.tag}`)) return [];
    const result=summarize(g.rows,'claude',{...g,prompt,file:options.file}), subs=[];
    const sources=[...(options.subagents??[])];
    const side=rows.filter(r=>r.isSidechain); if(side.length) sources.push({file:options.file,rows:side});
    for(const sub of sources){const sr=sub.rows.filter(r=>time(r)>=time(g.rows[0])&&time(r)<=time(g.rows.at(-1)));if(!sr.length)continue;const m=summarize(sr,'claude',{file:sub.file});subs.push({...m,name:sr[0].agentId??path.basename(sub.file??'sidechain'),turns:sr.filter(r=>claudePrompt(r)).length||1});}
    return [enrichRequest(attach(result,subs),rows,sources,options,prompt)];
  });
}
function filesIn(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isFile()&&e.name.endsWith('.jsonl')?[path.join(dir,e.name)]:[]) : []; }
const transcriptCache=new Map();
function loadTranscript(file){const stat=fs.statSync(file),cached=transcriptCache.get(file);if(cached?.size===stat.size&&cached.mtime===stat.mtimeMs)return {file,rows:cached.rows};const rows=parseJsonl(fs.readFileSync(file,'utf8'));transcriptCache.set(file,{size:stat.size,mtime:stat.mtimeMs,rows});return {file,rows};}
export function analyzeFiles(options = {}) {
  const output=[];
  for(const client of ['codex','claude']) {
    const files=[...new Set([...(options[client]??[]),...(options[`${client}Dirs`]??[]).flatMap(filesIn)].map(f=>path.resolve(f)))];
    const load=loadTranscript;
    for(const file of files) {
      const {rows}=load(file), meta=rows.find(r=>r.type==='session_meta')?.payload;
      if(client==='codex'&&meta?.parent_thread_id)continue;
      let candidates=[];
      if(client==='codex') candidates=codexRelatedFiles(file,options).map(load);
      else candidates=filesIn(path.join(path.dirname(file),path.basename(file,'.jsonl'),'subagents')).map(load);
      output.push(...(client==='codex'?analyzeCodex:analyzeClaude)(rows,{...options,file,subagents:candidates}));
    }
  }
  return output;
}
export function formatLegacyMarkdown(requests) {
  const escape=v=>String(v??'').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
  const columns=['id','client','model','case','start','end','wallMin','toolSecSum','toolSecUnion','ssamSec','modelPct','writtenKB','readKB','rounds','outputTokens','writtenKBTotal','roundsTotal','refusalsByCode','accepted','acceptedAt'];
  return '# Medição de transcrições\n\nKB = 1024 bytes; horários UTC−03:00. Soma de ferramentas pode exceder parede em paralelo.\n\n| '+columns.join(' | ')+' |\n| '+columns.map(()=> '---').join(' | ')+' |\n'+requests.map(r=>'| '+columns.map(k=>escape(typeof r[k]==='number'?r[k].toFixed(3):typeof r[k]==='object'?json(r[k]):r[k])).join(' | ')+' |').join('\n')+'\n\n'+requests.filter(r=>r.subagents.length).map(r=>`## Subagentes de ${escape(r.id)}\n\n| Nome | Min | KB escritos | KB lidos | Rodadas | Tokens |\n| --- | --- | --- | --- | --- | --- |\n`+r.subagents.map(s=>`| ${escape(s.name)} | ${s.wallMin.toFixed(3)} | ${s.writtenKB.toFixed(3)} | ${s.readKB.toFixed(3)} | ${s.rounds} | ${s.outputTokens} |`).join('\n')).join('\n\n')+'\n';
}
export function formatMarkdown(requests) {
  const cols=['id','wallSec','modelSec','ssamSec','otherToolSec','ownerWaitSec','coldStartSec','subagentWaitSec','unattributedSec','inputTokens','ssamPct','ssamToolsPct','reasoningTokens','execYields','waitStillRunning','waitCalls','stagedO11','stagedOdc'];
  const lines=requests.map(r=>{const values={id:r.id,...r.timeSplit,inputTokens:r.context?.inputTokens,ssamPct:r.context?.ssamPct,ssamToolsPct:r.context?.ssamToolsPct,reasoningTokens:r.output?.reasoningTokens,execYields:r.waits?.execYields,waitStillRunning:r.waits?.waitStillRunning,waitCalls:r.waits?.waitCalls,stagedO11:r.lanes?.o11.staged??0,stagedOdc:r.lanes?.odc.staged??0};return '| '+cols.map(k=>typeof values[k]==='number'?values[k].toFixed(3):String(values[k]??'').replace(/\|/g,'\\|')).join(' | ')+' |';});
  return formatLegacyMarkdown(requests)+'\n## Tempo e contexto por pedido\n\nTempos em segundos. Totais de tokens gravados; composição estimada.\n\n| '+cols.join(' | ')+' |\n| '+cols.map(()=>'---').join(' | ')+' |\n'+lines.join('\n')+'\n';
}
export function main(argv=process.argv.slice(2)) {
  const options={codex:[],claude:[],codexDirs:[],claudeDirs:[],windows:[]};
  const problems=[];
  for(let i=0;i<argv.length;i++){const flag=argv[i];if(flag==='--turns'){options.turns=true;continue;}if(!['--window','--codex','--claude','--codex-dir','--claude-dir','--tag','--md','--json','--head'].includes(flag)){problems.push(`Unknown flag: ${flag}`);continue;}const v=argv[i+1];if(!v||v.startsWith('--')){problems.push(`Missing value: ${flag}`);continue;}i++;if(flag==='--window'){const m=/^([^=]+)=([^/]+)\/(.+)$/.exec(v);if(!m||![m[2],m[3]].every(x=>Number.isFinite(Date.parse(x)))||Date.parse(m[2])>Date.parse(m[3]))problems.push('Invalid window');else options.windows.push({name:m[1],start:m[2],end:m[3]});}else if(['--codex','--claude','--codex-dir','--claude-dir'].includes(flag))options[flag.slice(2).replace('-dir','Dirs')].push(v);else options[flag.slice(2)]=v;}
  if(!options.codex.length&&!options.claude.length&&!options.codexDirs.length&&!options.claudeDirs.length)problems.push('Provide --codex, --codex-dir, --claude or --claude-dir');
  if(problems.length)throw Error(problems.join('\n'));
  // Exports carry measured fields only (no transcript path, no prompt text) and are all checked before any write.
  const requests=analyzeFiles(options),outputs=[['md',formatMarkdown(requests)],['json',exportView(requests)]].filter(([key])=>options[key]);
  const refusal=persistenceRefusal({exports:outputs.flatMap(([key,value])=>exportFindings('--'+key,options[key],value))});if(refusal)throw refusal;
  for(const [key,value] of outputs){fs.mkdirSync(path.dirname(path.resolve(options[key])),{recursive:true});fs.writeFileSync(options[key],typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');}
  if(!options.md&&!options.json)console.log(formatMarkdown(requests));return requests;
}
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase()){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
