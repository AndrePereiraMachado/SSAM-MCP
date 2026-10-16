import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCallDeadline} from '../call-deadline.mjs';
const reply=v=>({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const val=r=>r.structuredContent;
function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx12-r3-stop-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return createCallDeadline({root,timeoutMs:35});
}
test('R3-8 explicit stop aborts a detached write before its next synthetic item',async t=>{
  const d=setup(t);let signal,release,done,sends=0;
  const gate=new Promise(r=>release=r),finished=new Promise(r=>done=r);
  const run=d.wrap('odc_asset_delete',async(_a,ctx)=>{
    signal=ctx.mcpReq.signal;sends++;
    await gate;
    if(signal.aborted){done();return reply({ok:false,code:'CANCELLED',outcome:'not-sent',sent:sends});}
    sends++;done();return reply({ok:true,sent:sends});
  });
  // Junction CX12 x CX15 (M6-1): the execution form of odc_asset_delete (with its token) is the write that stop applies to.
  const first=val(await run({assetKey:'synthetic-item',confirmationToken:'00000000-0000-4000-8000-00000000c12a.00000000000000c1'},{mcpReq:{signal:new AbortController().signal}}));
  assert.equal(first.state,'running');assert.equal(signal.aborted,false);
  assert.equal(typeof d.stop,'function','deadline needs an explicit stop route');
  const stopped=val(await d.stop(first.task.id));assert.equal(stopped.ok,true);assert.equal(signal.aborted,true);
  release();await finished;
  const final=val(await run(first.continuation.arguments));assert.equal(final.code,'CANCELLED');assert.equal(sends,1);
});
test('R3-8 cancelling a detached continuation cancels only its wait; stop is named explicitly',async t=>{
  const d=setup(t);let signal,release;
  const gate=new Promise(r=>release=r);
  const run=d.wrap('studio_deliver',async(_a,ctx)=>{signal=ctx.mcpReq.signal;await gate;return reply({ok:true,version:'v7'});});
  const first=val(await run({feature:'Synthetic'},{mcpReq:{signal:new AbortController().signal}}));
  const c=new AbortController(),waiting=run(first.continuation.arguments,{mcpReq:{signal:c.signal}});
  c.abort('synthetic wait cancellation');await assert.rejects(waiting);assert.equal(signal.aborted,false);
  assert.match(first.continuation.why,/stop/i,'continuation must name the explicit stop route');
  assert.match(first.continuation.why,/cancel/i,'continuation must explain cancellation of the wait');
  release();assert.equal(val(await run(first.continuation.arguments)).version,'v7');
});
test('R3-8 stop returns one refusal for a missing task and never invokes a handler',async t=>{
  const d=setup(t);assert.equal(typeof d.stop,'function');
  const result=val(await d.stop('00000000-0000-0000-0000-000000000000'));
  assert.equal(result.ok,false);assert.equal(result.code,'TASK_NOT_FOUND');
});
