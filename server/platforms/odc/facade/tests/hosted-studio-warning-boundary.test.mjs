import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {wrapHostedTool} from '../hosted/policy.mjs';
import {compatibility} from '../agent-hub.mjs';
const kernel={odc:'1.7.29',o11:'11.55.93',odcBridge:'v97'};
const hello={studios:{odc:{installed:{version:'1.7.30.1'}}},pack:{lanes:['odc'],odcBridge:'v97'}};
const info={...hello,kernel,compatible:compatibility(hello,kernel,['odc'])};
for(const [name,args,code] of [['ssam_map',{lane:'odc',target:'ws:../other'},'PATH_OUTSIDE_WORKSPACE'],['ssam_debug',{},'HOSTED_UNAVAILABLE'],['odc_search_operations',{},null]]) {
 test(`newer Studio warning survives the response boundary: ${name}`,async()=>{
  const context={workspace:path.join(os.tmpdir(),'warning-workspace'),executor:{quota:{full:()=>false}}};
  const fn=wrapHostedTool(name,{inputSchema:{}},async()=>({content:[{type:'text',text:'{"ok":true}'}],structuredContent:{ok:true}}),{context,link:{info:()=>info,connected:()=>true},lanes:['odc']});
  const answer=await fn(args,{});
  if(code){assert.equal(answer.isError,true);assert.equal(answer.structuredContent.code,code);}
  assert.equal(answer.structuredContent.studioWarning.code,'studioNewerThanServed');
  assert.match(answer.content.map(x=>x.text??'').join(''),/studioNewerThanServed/);
 });
}