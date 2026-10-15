import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzeRollout, summarize as codexSummary } from './measure/codex-context.mjs';
import { analyzeSession, summarize as claudeSummary } from './measure/claude-context.mjs';
import { polling } from './measure/legacy-codex-polling.mjs';
import { longCalls } from './measure/legacy-long-calls.mjs';
import { repetition } from './measure/answer-repetition.mjs';
import { extractCodexCalls } from './measure/codex-tool-calls.mjs';
import { schemas } from './measure/legacy-tool-schemas.mjs';
import { extras } from './measure/legacy-context-extras.mjs';
import { selectRecordedSources } from './measure/recorded-sources.mjs';
const gate=process.env.BENCH_REAL_TRANSCRIPTS==='1' && fs.existsSync('C:/t/lacunas/contexto/saida/medidas.json');
test('pure ports preserve token records and exact MCP durations',()=>{
 const rows=[{timestamp:'2026-01-01T00:00:00Z',type:'session_meta',payload:{id:'root'}},{timestamp:'2026-01-01T00:00:02Z',type:'token_usage_record',payload:{usage:{input_tokens:100,cached_input_tokens:20,output_tokens:30,reasoning_output_tokens:10}}}];
 assert.equal(codexSummary(analyzeRollout(rows)).sumIn,100);
 assert.equal(codexSummary(analyzeRollout(rows)).sumReas,10);
 assert.equal(repetition([{tool:'t',text:'a'.repeat(400)},{tool:'t',text:'a'.repeat(400)}]).per.t.repeated,400);
 rows.push({timestamp:'2026-01-01T00:00:03Z',payload:{type:'item_completed',thread_id:'root',started_at_ms:1000,completed_at_ms:3000,item:{type:'McpToolCall',server:'ssam-test',tool:'ssam_map',duration:{secs:2,nanos:0},result:{structuredContent:{ok:true}}}}});
 assert.equal(extractCodexCalls([{id:'root',rows}]).calls[0].sec,2);
});
function walk(dir){return fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):e.name.endsWith('.jsonl')?[path.join(dir,e.name)]:[]):[];}
const windows={tickets:['2026-10-13T15:32:00Z','2026-10-13T15:48:30Z'],blocks:['2026-10-13T15:48:30Z','2026-10-13T16:07:30Z'],osTickets:['2026-10-13T15:37:10Z','2026-10-13T15:44:30Z'],manhaActions:['2026-10-13T12:42:44Z','2026-10-13T12:45:38Z'],manhaBlocks:['2026-10-13T13:05:50Z','2026-10-13T13:11:00Z'],manhaTelas:['2026-10-13T13:11:00Z','2026-10-13T13:16:15Z'],P1:['2026-10-13T14:09:25Z','2026-10-13T14:14:55Z'],P2:['2026-10-13T14:14:59Z','2026-10-13T14:19:27Z'],P3:['2026-10-13T14:19:31Z','2026-10-13T14:25:48Z'],P4:['2026-10-13T14:25:53Z','2026-10-13T14:46:55Z']};
test('W1 recorded context equivalence, all source units',{skip:!gate},async t=>{
 const expected=JSON.parse(fs.readFileSync('C:/t/lacunas/contexto/saida/medidas.json','utf8'));
 const files=walk(path.join(os.homedir(),'.codex','archived_sessions')).concat(walk(path.join(os.homedir(),'.codex','sessions','2026','10','13')),walk(path.join(os.homedir(),'.claude','projects')));
 const cache=new Map();
 for(const unit of expected.units){
  await t.test(unit.label,st=>{
  const selected=selectRecordedSources({sessions:[unit]},files,{reportMtimeMs:fs.statSync('C:/t/lacunas/contexto/saida/medidas.json').mtimeMs});
  if(selected.changed.length){st.skip(selected.changed.join('; '));return;}
  const file=selected.files[0];
  if(!cache.has(file))cache.set(file,(unit.kind==='codex'?analyzeRollout:analyzeSession)(fs.readFileSync(file,'utf8')));
  let w=null;
  if(/P[1-4]$/.test(unit.label))w=windows[unit.label.slice(-2)];
  else if(unit.label.includes(': 16 actions'))w=windows[unit.label.includes('MCP OutSystems')?'osTickets':'tickets'];
  else if(unit.label.includes(': 8 blocks'))w=windows.blocks;
  else if(unit.label==='Codex manhã: actions')w=windows.manhaActions;
  else if(unit.label==='Codex manhã: blocks')w=windows.manhaBlocks;
  else if(unit.label==='Codex manhã: telas')w=windows.manhaTelas;
  const summary=(unit.kind==='codex'?codexSummary:claudeSummary)(cache.get(file),r=>!w||(Date.parse(r.at)>=Date.parse(w[0])&&Date.parse(r.at)<Date.parse(w[1])));
  for(const key of ['n','sumIn','sumOut','sumReas','firstIn','lastIn','maxIn','meanIn'])assert.equal(summary[key],unit[key],unit.label+' '+key);
  assert.deepEqual(summary.cats,unit.cats,unit.label+' categories');
  });
 }
});
test('W1 polling and long calls compare every unchanged recorded source',{skip:!gate},async t=>{
 const savedFile='C:/t/lacunas/esperas-rede/longas-1213.json',saved=JSON.parse(fs.readFileSync(savedFile,'utf8'));
 const files=walk(path.join(os.homedir(),'.codex','sessions')).concat(walk(path.join(os.homedir(),'.codex','archived_sessions'))),sources=[];let changed=0;
 const expectedPolling=JSON.parse(fs.readFileSync('C:/t/lacunas/esperas-rede/polls-codex.json','utf8'));
 for(const entry of saved.sessions)await t.test(entry.file,st=>{
  const selected=selectRecordedSources({sessions:[entry]},files,{reportMtimeMs:fs.statSync(savedFile).mtimeMs});
  if(selected.changed.length){changed++;st.skip(selected.changed.join('; '));return;}
  const file=selected.files[0],source={name:path.basename(file),rows:fs.readFileSync(file,'utf8').split(/\r?\n/).flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}})};sources.push(source);
  assert.deepEqual(longCalls([source]).sessions[0],entry);
  const id=source.rows.find(r=>r.type==='session_meta')?.payload.id,expected=Object.entries(expectedPolling).find(([prefix])=>id?.startsWith(prefix));
  if(expected)assert.deepEqual(polling(source.rows),expected[1]);
 });
 if(!changed)assert.deepEqual(longCalls(sources).summary,saved.summary);else t.diagnostic('Aggregate comparison omitted because '+changed+' source changed');
});
test('W1 recorded Claude tool schemas remain independently verified',{skip:!gate},()=>{
 const file=walk(path.join(os.homedir(),'.claude','projects')).find(f=>path.basename(f)==='7427c081-1701-4dd3-a1a7-c966a91e7d8d.jsonl');
 const sc=schemas(fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse));assert.equal(sc.loadedCount,29);assert.equal(sc.loadedChars,117189);assert.equal(sc.serverInstructionsChars,2069);
});
test('W1 recorded truncation extras remain independently verified',{skip:!gate},()=>{
 const files=walk(path.join(os.homedir(),'.codex','sessions')).concat(walk(path.join(os.homedir(),'.codex','archived_sessions'))).filter(file=>/01a135c4|01a135e5/.test(path.basename(file)));
 const ex=files.map(file=>extras(fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse)).truncated);assert.equal(ex.reduce((n,v)=>n+v.n,0),9);assert.equal(ex.reduce((n,v)=>n+v.originalTokens,0),164510);
});
