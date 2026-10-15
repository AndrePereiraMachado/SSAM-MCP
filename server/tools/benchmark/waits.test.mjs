import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { measureColdStart } from './measure/cold-start.mjs';
import { measureOwnerWait } from './measure/owner-wait.mjs';
import { measureTime } from './measure/time-split.mjs';
import path from 'node:path';
import os from 'node:os';
import { extractNormalizedCalls } from './measure/time-split.mjs';
import { measurePolling } from './measure/codex-polling.mjs';
import { selectRecordedSources } from './measure/recorded-sources.mjs';
const ts=n=>new Date(n*1000).toISOString();
test('exec yields and waits still running are distinct counters',()=>{const calls=[{tool:'exec',start:0,end:1,output:'Script running with cell ID a'},{tool:'wait',start:2,end:3,output:'Script running with cell ID a'},{tool:'wait',start:4,end:5,output:'Script completed'},{tool:'read',start:6,end:7,output:'Script running with cell ID documentation'}];const result=measurePolling([],calls);assert.equal(result.execYields,1);assert.equal(result.waitStillRunning,1);assert.equal(result.waitCalls,2);assert.equal(result.waitCalls,result.execYields+result.waitStillRunning);});
test('fixed recorded rollouts compare unchanged polling sources independently',{skip:process.env.BENCH_REAL_TRANSCRIPTS!=='1'||!fs.existsSync('C:/t/lacunas/esperas-rede/longas-1213.json')},async t=>{
 const savedFile='C:/t/lacunas/esperas-rede/longas-1213.json',expected=JSON.parse(fs.readFileSync(savedFile,'utf8')),home=path.join(os.homedir(),'.codex');
 const walk=dir=>fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):entry.name.endsWith('.jsonl')?[path.join(dir,entry.name)]:[]):[];
 const files=walk(path.join(home,'archived_sessions')).concat(walk(path.join(home,'sessions'))),sum={execYields:0,waitStillRunning:0,waitCalls:0};let changed=0;
 for(const entry of expected.sessions)await t.test(entry.file,st=>{
  const selected=selectRecordedSources({sessions:[entry]},files,{reportMtimeMs:fs.statSync(savedFile).mtimeMs});if(selected.changed.length){changed++;st.skip(selected.changed.join('; '));return;}
  const rows=fs.readFileSync(selected.files[0],'utf8').split(/\r?\n/).flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}}),result=measurePolling(rows,extractNormalizedCalls([{rows}],{client:'codex'}));
  assert.equal(result.waitCalls,entry.waits);assert.equal(result.waitStillRunning,entry.yields);assert.equal(result.waitCalls,result.execYields+result.waitStillRunning);for(const key of Object.keys(sum))sum[key]+=result[key];
 });
 if(!changed)assert.deepEqual(sum,{execYields:81,waitStillRunning:132,waitCalls:213});else t.diagnostic('Aggregate comparison omitted because '+changed+' source changed; unchanged polling sums '+JSON.stringify(sum));
});

test('recorded Claude connecting fixture reaches instruction attachment: 21.925 seconds, three turns',()=>{
  const rows=fs.readFileSync(new URL('./fixtures/recorded/claude-cold-start.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse),c=measureColdStart(rows,[],'claude');
  assert.equal(c.sec,21.925);assert.equal(c.lostTurns,3);assert.equal(c.method,'recorded');
});
test('Claude cold start measures connecting invocation to server attachment and counts failed turns',()=>{
  const rows=[];for(let i=0;i<3;i++){rows.push({timestamp:ts(i*5),type:'assistant',message:{content:[{type:'tool_use',id:String(i),name:'ToolSearch'}]}});rows.push({timestamp:ts(i*5+1),type:'user',message:{content:[{type:'tool_result',tool_use_id:String(i),content:'MCP still connecting: ssam-new'}]}});}
  rows.push({timestamp:ts(21.9),type:'attachment',attachment:{type:'deferred_tools_delta',addedNames:['mcp__ssam-new__ssam_doctor'],pendingMcpServers:[]}});
  const c=measureColdStart(rows,[{ssam:true,sec:7.7,start:22000}],'claude');assert.equal(c.sec,21.9);assert.equal(c.lostTurns,3);assert.equal(c.firstSsamCallSec,7.7);assert.equal(c.method,'recorded');assert.equal(measureColdStart([],[]).method,'not-recorded');
});
test('owner wait only after stop, explicit window does not turn active-runtime input into owner wait',()=>{
  const r=(t,p)=>({timestamp:ts(t),type:'response_item',payload:p}),rows=[r(0,{type:'message',role:'user',content:[{text:'start'}]}),r(3,{type:'message',role:'user',content:[{text:'continue'}]}),r(5,{type:'task_complete'}),r(9,{type:'message',role:'user',content:[{text:'continue'}]})];
  const waits=measureOwnerWait(rows,[],{explicitWindow:true});assert.equal(waits.length,1);assert.equal(waits[0].sec,4);
  const m=measureTime([{rows}],{explicitWindow:true,start:ts(0),end:ts(10)});assert.equal(m.timeSplit.ownerWaitSec,4);
});
test('new request gap is not owner wait, question tool is recorded',()=>{
  const rows=[{timestamp:ts(1),payload:{type:'task_complete'}},{timestamp:ts(10),payload:{type:'message',role:'user',content:[{text:'Implement another unrelated application'}]}}];
  assert.equal(measureOwnerWait(rows,[]).length,0);assert.equal(measureOwnerWait([], [{tool:'request_user_input_async',start:1000,end:3000,sec:2}])[0].kind,'question-tool');
});
test('runtime restart, injected contexts, previous-window stop and async dispatch receipt are not owner waits',()=>{
  const row=(t,payload)=>({timestamp:ts(t),payload});
  const rows=[row(0,{type:'task_complete'}),row(2,{type:'message',role:'user',content:[{text:'<external_codex_apps_open_page>{}</external_codex_apps_open_page>'}]}),row(3,{type:'task_started'}),row(9,{type:'message',role:'user',content:[{text:'continue'}]})];
  assert.deepEqual(measureOwnerWait(rows,[{tool:'request_user_input_async',start:4000,end:5000,sec:1,result:{accepted:true}}],{explicitWindow:true}),[]);
  assert.deepEqual(measureOwnerWait([row(0,{type:'task_complete'}),row(9,{type:'message',role:'user',content:[{text:'continue'}]})],[],{explicitWindow:true,start:8000}),[]);
});
test('Claude pure polling groups duplicate usage by message id, excluding mixed tool requests',()=>{
  const user=(t,content)=>({type:'user',timestamp:ts(t),message:{content}}),assistant=(t,id,content,usage)=>({type:'assistant',timestamp:ts(t),message:{id,content,usage}});
  const usage={input_tokens:100,cache_creation_input_tokens:200,cache_read_input_tokens:300},poll={type:'tool_use',id:'p',name:'mcp__ssam__studio_status',input:{}},mixedPoll={...poll,id:'m'},read={type:'tool_use',id:'r',name:'mcp__ssam__ssam_map',input:{}};
  const rows=[user(0,'start'),assistant(1,'poll-request',[{type:'thinking',thinking:'x'}],usage),assistant(3,'poll-request',[poll],{...usage,input_tokens:250}),user(4,[{type:'tool_result',tool_use_id:'p',content:'{}'}]),assistant(5,'mixed-request',[mixedPoll],usage),assistant(6,'mixed-request',[read],usage),user(7,[{type:'tool_result',tool_use_id:'m',content:'{}'},{type:'tool_result',tool_use_id:'r',content:'{}'}])];
  const m=measureTime([{rows}],{client:'claude',start:ts(0),end:ts(7)});
  assert.equal(m.waits.pollTurnInputTokens,750);assert.equal(m.waits.pollTurnModelSec,3);assert.equal(m.waits.pollCalls,2);assert.equal(m.waits.methods.pollTurnInputTokens,'recorded');assert.equal(m.waits.methods.pollTurnModelSec,'recorded');
});
