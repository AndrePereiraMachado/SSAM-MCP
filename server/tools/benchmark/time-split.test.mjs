import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { measureTime, partitionTime, extractNormalizedCalls, modelIntervals,callCategory } from './measure/time-split.mjs';
const ts=n=>new Date(n*1000).toISOString();
const event=(t,payload)=>({timestamp:ts(t),type:'event_msg',payload});
test('partition sums wall, applies owner/cold/SSAM/tool/model/subagent priority and reports overlap',()=>{
  const p=partitionTime(0,10000,[{start:0,end:2000,kind:'ownerWait'},{start:1000,end:3000,kind:'coldStart'},{start:0,end:6000,kind:'ssam',category:'read'},{start:0,end:7000,kind:'otherTool'},{start:0,end:8000,kind:'model'},{start:0,end:9000,kind:'subagentWait'}]);
  assert.equal(p.ownerWaitSec,2);assert.equal(p.coldStartSec,1);assert.equal(p.ssamSec,3);assert.equal(p.otherToolSec,1);assert.equal(p.modelSec,1);assert.equal(p.subagentWaitSec,1);assert.equal(p.unattributedSec,1);assert.equal(p.overlap.modelDuringSsamSec,6);
  assert.equal(['ownerWait','coldStart','ssam','otherTool','model','subagentWait','unattributed'].reduce((s,k)=>s+p[k+'Sec'],0),p.wallSec);
});
test('MCP duration survives exec yielding, copied parent calls ignored, subagents aggregate',()=>{
  const exact=(thread,t,end)=>event(end,{type:'item_completed',thread_id:thread,started_at_ms:t*1000,completed_at_ms:end*1000,item:{type:'McpToolCall',server:'ssam',tool:'ssam_map',arguments:{lane:'o11'},duration:{secs:end-t,nanos:0},result:{structuredContent:{ok:true}}}});
  const rows=[event(0,{type:'task_started'}),event(1,{type:'custom_tool_call',name:'exec',input:'await tools.mcp__ssam__ssam_map({})',call_id:'a'}),event(31,{type:'custom_tool_call_output',call_id:'a',output:'Script running with cell ID 1'}),exact('main',1,80),event(90,{type:'task_complete'})];
  const sources=[{id:'main',rows},{id:'sub',rows:[exact('main',1,80),exact('sub',2,5)]}];
  const m=measureTime(sources,{start:ts(0),end:ts(50)});assert.equal(m.ssamCalls.n,2);assert.equal(m.ssamCalls.secSum,82);assert.equal(m.timeSplit.ssamSec,49);assert.equal(m.waits.execYields,1);assert.equal(m.waits.longCalls.over28.sec,79);
});
test('recorded MCP fixture produces complete durations and stages without wrapper inference',()=>{
  const rows=fs.readFileSync(new URL('./fixtures/recorded/mcp-completion.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);const calls=extractNormalizedCalls([{rows}]);assert.equal(calls.length,4);assert.ok(calls.every(c=>c.ssam&&c.method==='recorded'&&Number.isFinite(c.sec)));
});
test('missing MCP telemetry permits explicitly labelled exec wrapper estimate',()=>{
  const rows=[event(0,{type:'custom_tool_call',call_id:'a',name:'exec',input:'await tools.mcp__ssam_novo__o11_environment({})'}),event(2,{type:'custom_tool_call_output',call_id:'a',output:'{}'})],calls=extractNormalizedCalls([{rows}]);
  assert.equal(calls[0].tool,'o11_environment');assert.equal(calls[0].ssam,true);assert.equal(calls[0].method,'estimated-exec-wrapper');
});
test('metadata regexes and quoted tool examples are not SSAM invocations',()=>{
  for(const input of ['text(ALL_TOOLS.filter(t=>/^mcp__ssam_proto__ssam_(discover|code|reference)$/.test(t.name)));','text("tools.mcp__ssam__ssam_map({})");']) {
    const rows=[event(0,{type:'custom_tool_call',call_id:'a',name:'exec',input}),event(2,{type:'custom_tool_call_output',call_id:'a',output:'[]'})];assert.equal(extractNormalizedCalls([{rows}])[0].ssam,false);
  }
});
test('schemas describing network codes retain category, actual network response overrides it',()=>{
  assert.equal(callCategory({tool:'ssam_discover',output:{structuredContent:{ok:true,examples:[{code:'TIMEOUT'}]}}}),'read');
  assert.equal(callCategory({tool:'ssam_discover',output:{content:[{type:'text',text:'A tool contract describes TIMEOUT and 502/504 handling.'}]}}),'read');
  assert.equal(callCategory({tool:'ssam_map',output:'Request timed out'}),'network');
});
test('network overrides read category and stages only use recorded values',()=>{
  const rows=[event(0,{type:'function_call',call_id:'a',name:'mcp__ssam__ssam_map',arguments:'{"lane":"odc"}'}),event(5,{type:'function_call_output',call_id:'a',output:JSON.stringify({ok:false,code:'REMOTE_UNREACHABLE',steps:[{step:'verify',seconds:2}],timings:{buildMs:120}})})];
  const m=measureTime([{rows}],{start:ts(0),end:ts(5)});assert.equal(m.ssamCalls.byCategory.network.sec,5);assert.equal(m.ssamStages.verify,2);assert.equal(m.ssamStages['timings.buildMs'],.12);assert.equal(m.waits.networkStalls.n,1);
});
test('model duration is measured from input/prior usage rather than residual',()=>{
  const rows=[{timestamp:ts(0),type:'response_item',payload:{type:'message',role:'user'}},{timestamp:ts(2),type:'token_usage_record'},{timestamp:ts(5),type:'response_item',payload:{type:'function_call_output'}},{timestamp:ts(7),type:'token_usage_record'},{timestamp:ts(9),type:'token_usage_record'}];
  assert.deepEqual(modelIntervals(rows).map(m=>[m.start/1000,m.end/1000]),[[0,2],[5,7],[7,9]]);
});
