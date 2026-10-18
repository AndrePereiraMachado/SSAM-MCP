import { originalProfile } from '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {measureContext,GROUP_KEYS} from './measure/context-groups.mjs';
import {measureReasoning} from './measure/reasoning.mjs';
import {measureToolSchemas} from './measure/tool-schemas.mjs';
import {repetitionFractions,ssamContextRatios} from './measure/legacy-context-ratios.mjs';
import {codexEntries,claudeEntries} from './measure/answer-anatomy.mjs';
const row=(type,payload,n)=>({type,payload,timestamp:`2026-01-01T00:00:${String(n).padStart(2,'0')}Z`});
const tokens=(input,output=10,reasoning=3)=>({usage:{input_tokens:input,cached_input_tokens:0,output_tokens:output,reasoning_output_tokens:reasoning}});

test('Legacy pctSSAM uses source category names and recorded input; tool-only percentage excludes folder instructions',()=>{
 const reads={'ssam:ssam_map':300,'instr:AGENTS.md':100,'instr:CLAUDE.md':50,'instr:other-CLAUDE':50,'usuario:pedido':500,'fixo:nao-registrado':-20};
 assert.deepEqual(ssamContextRatios(reads,1000),{ssamTokens:500,ssamPct:50,ssamToolsTokens:300,ssamToolsPct:30});
 const composition=measureContext([{rows:[row('response_item',{type:'message',role:'user',content:[{text:'# AGENTS.md '+ 'x'.repeat(373)}]},1),row('token_usage_record',tokens(200),2)]}],{client:'codex'}).context;
 assert.ok(composition.ssamPct>0);assert.equal(composition.ssamToolsPct,0);
});

test('Faithful repetition fractions weight chars across contexts but never share seen history',()=>{
 const text=JSON.stringify({packet:'x'.repeat(400)}), tool='ssam:ssam_map';
 assert.deepEqual(repetitionFractions([[{tool,text},{tool,text}],[{tool,text}]]),{[tool]:1/3});
 assert.deepEqual(repetitionFractions([]),{});
 assert.deepEqual(repetitionFractions([[{tool,text}],[{tool,text}]]),{[tool]:0});
});

test('Codex preserves history before window, resets at compaction, groups sum to 100%',()=>{
  const rows=[row('session_meta',{id:'own'},0),row('response_item',{type:'message',role:'user',content:[{text:'x'.repeat(373)}]},1),row('token_usage_record',tokens(120),2),row('compacted',{replacement_history:[]},3),row('token_usage_record',tokens(80),4),row('token_usage_record',{...tokens(999),thread_id:'other'},5)];
  const {context,output}=measureContext([{rows}],{client:'codex',turns:true});
  assert.equal(context.requests,2);assert.equal(context.inputTokens,200);assert.equal(output.tokens,20);assert.equal(context.compactions,1);
  assert.equal(Object.keys(context.groups).length,15);assert.deepEqual(Object.keys(context.groups),GROUP_KEYS);
  assert.ok(Math.abs(Object.values(context.groups).reduce((n,g)=>n+g.pct,0)-100)<0.1);
  assert.equal(context.turns[1].groups.userAndCompactedSummary.tokens,0);
  const window=measureContext([{rows}],{client:'codex',from:rows[2].timestamp,to:rows[2].timestamp});
  assert.ok(window.context.groups.userAndCompactedSummary.tokens>0);
});

test('Claude thinking counters win; streaming usage uses maxima per message id',()=>{
 const rows=[{type:'user',timestamp:'2026-01-01T00:00:00Z',message:{content:'hi'}},
 {type:'assistant',timestamp:'2026-01-01T00:00:01Z',message:{id:'one',usage:{input_tokens:100,cache_read_input_tokens:20,cache_creation_input_tokens:0,output_tokens:10,output_tokens_details:{thinking_tokens:4}},content:[{type:'thinking',thinking:'thought'}]}},
 {type:'assistant',timestamp:'2026-01-01T00:00:02Z',message:{id:'one',usage:{input_tokens:100,cache_read_input_tokens:20,cache_creation_input_tokens:0,output_tokens:20,output_tokens_details:{thinking_tokens:7}},content:[{type:'text',text:'answer'}]}}];
 const {context,output}=measureContext([{rows}],{client:'claude'});
 assert.equal(context.requests,1);assert.equal(context.inputTokens,120);assert.equal(output.tokens,20);assert.equal(output.reasoningTokens,7);assert.equal(output.visibleTokens,13);assert.equal(output.reasoningMethod,'recorded');assert.ok(output.estimators.chars);assert.ok(output.estimators.time);
});

test('Schemas and server instruction truncation come from transcript attachments',()=>{
 const name='mcp__ssam__ssam_map',entry={name,input_schema:{type:'object'}};
 const rows=[{type:'attachment',attachment:{type:'deferred_tools_record',entries:[entry]}},
 {type:'attachment',attachment:{type:'mcp_instructions_delta',addedNames:['ssam'],addedBlocks:['instruction [truncated]']}},
 {type:'assistant',message:{content:[{type:'tool_use',name,id:'call',input:{}}]}},
 row('response_item',{type:'custom_tool_call',call_id:'x',input:'tools.mcp__ssam__ssam_map({})'},1),row('response_item',{type:'custom_tool_call_output',call_id:'x',output:[{text:'original token count: 500'}]},2)];
 const result=measureToolSchemas([{rows}]); assert.equal(result.schemas.loaded,1);assert.equal(result.schemas.used,1);assert.equal(result.schemas.loadedChars,JSON.stringify(entry).length);assert.equal(result.serverInstructions.shownChars,23);assert.equal(result.serverInstructions.truncated,true);assert.equal(result.truncatedAnswers.originalTokens,500);assert.equal(result.truncatedAnswers.byTool.ssam_map,1);
});

test('Claude without thinking detail publishes both estimators',()=>{
 const rows=[{type:'user',timestamp:'2026-01-01T00:00:00Z',message:{content:'hi'}},{type:'assistant',timestamp:'2026-01-01T00:00:02Z',message:{id:'a',usage:{output_tokens:20},content:[{type:'thinking',thinking:'x'},{type:'text',text:'xxx'}]}}];
 const result=measureReasoning([{rows}],{client:'claude'});assert.equal(result.reasoningMethod,'estimated-chars');assert.equal(result.estimators.time.reasoningTokens,20);
});

test('Numeric epoch windows use the same request boundary as ISO windows',()=>{
 const rows=[row('token_usage_record',tokens(100),2)];
 const at=Date.parse(rows[0].timestamp);
 assert.deepEqual(measureContext([{rows}],{client:'codex',from:at,to:at}),measureContext([{rows}],{client:'codex',from:rows[0].timestamp,to:rows[0].timestamp}));
});

test('Recorded excerpt proves repeated Claude ids have one output total',()=>{
 const file=new URL('./fixtures/recorded/claude-thinking-duplicate.jsonl',import.meta.url);
 const rows=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse);
 const ids=new Map();for(const r of rows)if(r.type==='assistant'&&r.message?.usage){const m=r.message,u=m.usage,o=ids.get(m.id)||{out:0,thinking:0};o.out=Math.max(o.out,u.output_tokens||0);o.thinking=Math.max(o.thinking,u.output_tokens_details?.thinking_tokens||0);ids.set(m.id,o);}
 const result=measureReasoning([{rows}],{client:'claude'});
 assert.equal(result.tokens,[...ids.values()].reduce((n,u)=>n+u.out,0));assert.equal(result.reasoningTokens,[...ids.values()].reduce((n,u)=>n+u.thinking,0));
});

const realClaude=path.join(originalProfile.home,`.claude/projects/C--Users-${path.basename(originalProfile.home)}-SSAM-Hybrid-proto/7427c081-1701-4dd3-a1a7-c966a91e7d8d.jsonl`);
test('Real Claude context and both recorded and estimated reasoning reproduce owner criteria', {skip:process.env.BENCH_REAL_TRANSCRIPTS!=='1'||!fs.existsSync(realClaude)},()=>{
 const sources=[{rows:fs.readFileSync(realClaude,'utf8').split('\n').filter(Boolean).map(JSON.parse)}];
 const all=measureContext(sources,{client:'claude'});
 assert.equal(all.context.requests,58);assert.equal(all.context.inputTokens,13294337);assert.ok(Math.abs(all.context.ssamPct-47.4)<0.5);
 assert.deepEqual(all.context.serverInstructions,{shownChars:2069,truncated:true,method:'recorded'});
 assert.equal(all.context.schemas.loaded,29);assert.equal(all.context.schemas.loadedChars,117189);assert.equal(all.context.schemas.used,12);assert.equal(all.context.schemas.usedChars,41969);
 for(const [from,to,n,input,output,thinking] of [['14:09:25','14:14:51',8,1145275,4227,1088],['14:14:59','14:19:23',8,1384360,25491,4862],['14:19:31','14:25:44',21,5084951,33104,12318],['14:25:53','15:00:00',12,4831962,139082,64659]]){
   const result=measureContext(sources,{client:'claude',from:`2026-10-13T${from}Z`,to:`2026-10-13T${to}Z`});
   assert.equal(result.context.requests,n);assert.equal(result.context.inputTokens,input);assert.equal(result.output.tokens,output);assert.equal(result.output.reasoningTokens,thinking);
   if(n===12){assert.equal(result.output.estimators.chars.reasoningTokens,62539);assert.equal(result.output.estimators.time.reasoningTokens,73485);}
 }
});

const beforeRatios='C:/t/lacunas/contexto/saida/estimativas.json';
test('Faithful source ratios reproduce 54.1/55.1/47.4 and every saved fracoes.fRep value', {skip:process.env.BENCH_REAL_TRANSCRIPTS!=='1'||!fs.existsSync(beforeRatios)||!fs.existsSync(realClaude)},()=>{
 const archives=path.join(originalProfile.home,'.codex/archived_sessions');
 const names=['rollout-2026-10-13T11-57-13-01a135c4-8333-7190-b72c-bb2c32460f1d.jsonl','rollout-2026-10-13T12-32-45-01a135e5-0c3a-7f00-8449-ee61552717cc.jsonl','rollout-2026-10-13T12-33-01-01a135e5-4985-7972-915e-944230ba9c6c.jsonl','rollout-2026-10-13T12-33-18-01a135e5-8a28-7a11-9f74-d72ba82fe3e3.jsonl'];
 const load=file=>fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse);
 const codexRows=names.map(n=>load(path.join(archives,n))),claudeRows=load(realClaude);
 const before=JSON.parse(fs.readFileSync(beforeRatios,'utf8'));
 assert.deepEqual(repetitionFractions(codexRows.map(codexEntries)),before.fracoes.fRep.codex);
 assert.deepEqual(repetitionFractions([claudeEntries(claudeRows)]),before.fracoes.fRep.claude);
 const sources=codexRows.map((rows,i)=>({rows,main:i===0}));
 for(const [from,to,pct] of [['15:32:03.137','15:42:22.336',54.1],['15:48:31.955','16:06:49.887',55.1]]) {
   const context=measureContext(sources,{client:'codex',from:`2026-10-13T${from}Z`,to:`2026-10-13T${to}Z`}).context;
   assert.equal(context.ssamPct,pct);assert.ok(context.ssamToolsPct<context.ssamPct);
 }
 const claude=measureContext([{rows:claudeRows}],{client:'claude'}).context;
 assert.equal(claude.ssamPct,47.4);assert.ok(claude.ssamToolsPct<claude.ssamPct);
});
