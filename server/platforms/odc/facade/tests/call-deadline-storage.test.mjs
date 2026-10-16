import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createCallDeadline} from '../call-deadline.mjs';import {mergeTask,readTask,registerSsamTask,tasksDir} from '../ssam-task.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const text=v=>({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v});
function setup(t,options={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx12-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,deadline:createCallDeadline({root,timeoutMs:50,...options})};}
async function finish(run,r){while(r.structuredContent?.state==='running')r=await run(r.structuredContent.continuation.arguments);return r;}
for(const write of [false,true])test(`R1 original cancellation preserves ${write?'real cancelled write evidence':'fresh read retry'}`,async t=>{
 const {root,deadline}=setup(t,{timeoutMs:200});let calls=0;
 const run=deadline.wrap(write?'o11_publish':'studio_status',async(_,ctx)=>{calls++;await new Promise(r=>{const timer=setTimeout(r,60);ctx.mcpReq.signal.addEventListener('abort',()=>{clearTimeout(timer);r();},{once:true});});return text({ok:!ctx.mcpReq.signal.aborted,aborted:ctx.mcpReq.signal.aborted});});
 const c=new AbortController(),first=run({module:'M'},{mcpReq:{signal:c.signal}});await sleep(10);c.abort();await first.catch(()=>{});await sleep(10);
 const retry=await run({module:'M'},{mcpReq:{signal:new AbortController().signal}});assert.equal(retry.structuredContent.resumedFrom,undefined);
 if(!write){assert.equal(calls,2);assert.equal(retry.structuredContent.ok,true);}else{assert.equal(calls,1);assert.equal(retry.structuredContent.ok,false);assert.equal(retry.structuredContent.aborted,true);const id=fs.readdirSync(tasksDir(root)).find(n=>n.endsWith('.json')).slice(0,-5);
  let lookup;registerSsamTask({registerTool:(_,__,fn)=>lookup=fn},{root});const evidence=await lookup({id});assert.equal(evidence.structuredContent.ok,true);assert.equal(evidence.structuredContent.task.id,id);
  assert.equal(evidence.structuredContent.task.cancelled,true);assert.equal(evidence.structuredContent.task.state,'failed');assert.equal((await run({continueTask:id})).structuredContent.aborted,true);assert.equal(calls,1);
 }
});
test('R4 task directory is a file: memory continuation resolves once and count returns zero',async t=>{
 const {root}=setup(t);const dir=path.join(root,'not-a-directory');fs.writeFileSync(dir,'file');let calls=0;const counts=[];
 const deadline=createCallDeadline({root,dir,timeoutMs:50,env:{SSAM_RELAY_CHILD:'1'},notify:n=>counts.push(n.params.running)});
 const expected=text({ok:true,value:42});const run=deadline.wrap('o11_publish',async()=>{calls++;await sleep(120);return expected;});
 const first=await run({module:'M'});assert.equal(first.structuredContent.state,'running');assert.equal(deadline.runningCount(),1);
 const final=await finish(run,first);assert.deepEqual(final,expected);assert.deepEqual(await run(first.structuredContent.continuation.arguments),expected);assert.equal(calls,1);assert.equal(deadline.runningCount(),0);assert.deepEqual(counts,[1,0]);
});
for(const stage of ['detach','final'])test(`R4 ${stage} persist failure never loses result or makes a negative count`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx12-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const counts=[];let writes=0,calls=0;
 const deadline=createCallDeadline({root,timeoutMs:50,env:{SSAM_RELAY_CHILD:'1'},notify:n=>counts.push(n.params.running),persistTask:(dir,fields)=>{writes++;if(stage==='detach'&&writes===1||stage==='final'&&fields.endedAt)throw Object.assign(Error('rename EPERM injected'),{code:'EPERM'});return mergeTask(dir,fields);}});
 const expected=text({ok:true,value:stage});const run=deadline.wrap('o11_publish',async()=>{calls++;await sleep(120);return expected;});const first=await run({module:'M'});const final=await finish(run,first);
 assert.deepEqual(final,expected);assert.equal(calls,1);assert.equal(deadline.runningCount(),0);assert.deepEqual(counts,[1,0]);assert.ok(writes>=2);assert.ok(counts.every(n=>n>=0));assert.deepEqual(await run(first.structuredContent.continuation.arguments),expected);
});

test('R4 saving the answer can fail without rejecting the task promise or repeating work',async t=>{
 const {root}=setup(t);let calls=0;const counts=[];
 const deadline=createCallDeadline({root,timeoutMs:50,env:{SSAM_RELAY_CHILD:'1'},notify:n=>counts.push(n.params.running),saveAnswer:()=>{throw Object.assign(Error('answer storage EPERM'),{code:'EPERM'});}});
 const expected=text({ok:true,value:7}),run=deadline.wrap('o11_publish',async()=>{calls++;await sleep(90);return expected;});
 const first=await run({module:'M'});assert.deepEqual(await finish(run,first),expected);assert.deepEqual(await run(first.structuredContent.continuation.arguments),expected);assert.equal(calls,1);assert.deepEqual(counts,[1,0]);
});
