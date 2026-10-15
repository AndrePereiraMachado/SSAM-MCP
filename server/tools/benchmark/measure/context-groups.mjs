// Source: contexto/run-all.mjs; sha256: 4c2d3429b4df2ac3ac103ed151e3c22cb06e062cde59e4f308bbf0b4e3ec02e7.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
import {analyzeRollout} from './codex-context.mjs';
import {analyzeSession} from './claude-context.mjs';
import {measureReasoning,ownedRows} from './reasoning.mjs';
import {measureToolSchemas} from './tool-schemas.mjs';
import {ssamContextRatios} from './legacy-context-ratios.mjs';
export function group(cat) {
  if (/^ssam:(esquemas|instrucoes-do-servidor|lista-de-nomes)/.test(cat)) return 'SSAM: instruções do servidor + esquemas das ferramentas';
  if (/^instr:(AGENTS\.md|CLAUDE)/.test(cat)) return 'AGENTS.md / CLAUDE.md da pasta';
  if (cat === 'ssam:ssam_discover') return 'SSAM: discover';
  if (/^ssam:(ssam_map|o11_inspect|studio_inspect)/.test(cat)) return 'SSAM: map / inspect';
  if (cat === 'ssam:ssam_code') return 'SSAM: ssam_code';
  if (cat === 'ssam:recusas') return 'SSAM: recusas';
  if (/^ssam:(o11_deliver|studio_deliver|o11_publish|studio_publish)/.test(cat)) return 'SSAM: entregas';
  if (cat.startsWith('ssam:')) return 'SSAM: outras respostas (reference, doctor, evidence...)';
  if (cat === 'modelo:raciocinio') return 'Modelo: raciocínio';
  if (/^modelo:chamada-(spawn_agent|send_message|followup_task|wait)|^modelo:prompt-subagente|^subagente:/.test(cat)) return 'Subagentes: prompts e resultados';
  if (/^modelo:(codigo-exec|entrada|chamada)/.test(cat)) return 'Modelo: código/argumentos escritos';
  if (cat === 'modelo:texto') return 'Modelo: texto';
  if (/^(usuario|compactado):/.test(cat)) return 'Usuário / resumo compactado';
  if (/^(fixo|instr):|^outros:esquemas/.test(cat)) return 'Cliente: prompt base, ferramentas próprias, lembretes';
  return 'Outros (arquivos, shell, outro MCP, imagens)';
}

export const GROUP_KEYS = ['ssamInstructionsAndSchemas','folderInstructions','ssamDiscover','ssamMapInspect','ssamCode','ssamRefusals','ssamDeliveries','ssamOtherAnswers','modelReasoning','subagents','modelCodeArguments','modelText','userAndCompactedSummary','clientInstructionsAndTools','otherTools'];
const labels = ['SSAM: instruções do servidor + esquemas das ferramentas','AGENTS.md / CLAUDE.md da pasta','SSAM: discover','SSAM: map / inspect','SSAM: ssam_code','SSAM: recusas','SSAM: entregas','SSAM: outras respostas (reference, doctor, evidence...)','Modelo: raciocínio','Subagentes: prompts e resultados','Modelo: código/argumentos escritos','Modelo: texto','Usuário / resumo compactado','Cliente: prompt base, ferramentas próprias, lembretes','Outros (arquivos, shell, outro MCP, imagens)'];
const cache = new WeakMap();
function completeAnalysis(rows, client, side=false) {
  let stored=cache.get(rows); if(!stored) {stored={};cache.set(rows,stored);}
  const cacheKey=client+(side?':side':'');
  if(stored[cacheKey]) return stored[cacheKey];
  let clean=ownedRows(rows);
  if(client==='claude') {
    // Streaming repeats may increase counters. Use maximum usage per id without discarding content fragments.
    const maxima=new Map();
    for(const row of clean) if(row.type==='assistant' && row.message?.usage) {
      const id=row.message.id || row.uuid, u=row.message.usage, old=maxima.get(id)||{};
      for(const key of ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']) old[key]=Math.max(old[key]||0,u[key]||0);
      old.output_tokens_details={thinking_tokens:Math.max(old.output_tokens_details?.thinking_tokens||0,u.output_tokens_details?.thinking_tokens||0)}; maxima.set(id,old);
    }
    clean=clean.map(row=>row.type==='assistant' && row.message?.usage ? {...row,message:{...row.message,id:row.message.id || row.uuid,usage:maxima.get(row.message.id || row.uuid)}} : row);
  }
  return stored[cacheKey]={analysis:client==='codex'?analyzeRollout(clean):analyzeSession(clean,{side}),rows:clean};
}

export function composeGroups(requests) {
  const raw=Object.fromEntries(GROUP_KEYS.map(k=>[k,0])), byTool={}, categoryTokens={};
  let input=0;
  for(const r of requests) {
    input+=r.in || 0;
    for(const [cat,tokens] of Object.entries({...r.byCat,'fixo:nao-registrado':r.fixed||0})) {
      const key=GROUP_KEYS[labels.indexOf(group(cat))]; raw[key]+=tokens;
      categoryTokens[cat]=(categoryTokens[cat]||0)+tokens;
      if(cat.startsWith('ssam:')) byTool[cat]=(byTool[cat]||0)+tokens;
    }
  }
  // Keep signed calibration residuals: clipping them would silently lower the measured SSAM share.
  const groups=Object.fromEntries(GROUP_KEYS.map(k=>[k,{tokens:raw[k],pct:input?raw[k]*100/input:0,method:'estimated'}]));
  const ratios=input?ssamContextRatios(categoryTokens,input):{ssamTokens:0,ssamPct:0,ssamToolsTokens:0,ssamToolsPct:0};
  return {groups,byTool,rawGroupTokens:raw,...ratios,ssamPctScope:'SSAM responses, schemas and server instructions plus folder AGENTS/CLAUDE instructions (legacy comparison scope)',ssamToolsPctScope:'SSAM response, schema and server instruction categories only'};
}

export function measureContext(sources, {client,from,to,turns=false}={}) {
  const start=from!=null?(typeof from==='number'?from:Date.parse(from)):-Infinity,end=to!=null?(typeof to==='number'?to:Date.parse(to)):Infinity;
  const requests=[];let compactions=0,mainRequests=[];
  for(const source of sources) {
    const {analysis,rows}=completeAnalysis(source.rows,client,source.main===false);
    const selected=analysis.reqs.filter(r=>Date.parse(r.at)>=start&&Date.parse(r.at)<=end);if(source===sources[0])mainRequests=selected;requests.push(...selected);
    compactions+=rows.filter(r=>(r.type==='compacted'||(r.type==='system'&&r.subtype==='compact_boundary'))&&Date.parse(r.timestamp)>=start&&Date.parse(r.timestamp)<=end).length;
  }
  requests.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const sum=k=>requests.reduce((n,r)=>n+(r[k]||0),0), inputTokens=sum('in'), cachedTokens=sum('cached');
  const composition=composeGroups(requests);
  const context={requests:requests.length,inputTokens,cachedTokens,cachedPct:inputTokens?cachedTokens*100/inputTokens:0,method:'recorded',groupMethod:'estimated',...composition,
    firstInput:requests[0]?.in??null,lastInput:requests.at(-1)?.in??null,compactions,...measureToolSchemas(sources,{from,to})};
  if(client==='codex'){const mainInput=mainRequests.reduce((n,r)=>n+r.in,0),other=mainRequests.reduce((n,r)=>n+Object.entries(r.byCat).filter(([cat])=>cat.startsWith('outros:mcp-')).reduce((s,[,value])=>s+value,0),0);context.mainOtherMcpPct=mainInput?100*other/mainInput:0;context.mainOtherToolsPct=composeGroups(mainRequests).groups.otherTools.pct;}
  if(turns) context.turns=requests.map(r=>({at:r.at,inputTokens:r.in,cachedTokens:r.cached||0,outputTokens:r.out,reasoningTokens:r.reas,...composeGroups([r]),method:'recorded',groupMethod:'estimated'}));
  return {context,output:measureReasoning(sources,{client,from,to})};
}
