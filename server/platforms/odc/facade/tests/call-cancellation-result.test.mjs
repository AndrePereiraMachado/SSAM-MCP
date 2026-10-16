import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCallDeadline} from '../call-deadline.mjs';
import {readTask,tasksDir,registerSsamTask} from '../ssam-task.mjs';
import {McpServer,fromJsonSchema} from '@modelcontextprotocol/server';
import {createSsamServer} from '../ssam.mjs';
const reply=v=>({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx12-cancel-result-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,deadline:createCallDeadline({root,timeoutMs:500})};}
async function cancel(run,args){const c=new AbortController();const first=run(args,{mcpReq:{signal:c.signal}});await sleep(20);c.abort();await assert.rejects(first,e=>e.code==='CANCELLED');}
test('N2 cancelled write preserves successful final and its record, delivering the final once',async t=>{
 const {root,deadline}=setup(t);let runs=0,release;const gate=new Promise(r=>release=r);
 const run=deadline.wrap('o11_publish',async()=>{runs++;await gate;return reply({ok:true,version:7});});
 await cancel(run,{module:'Synthetic'});
 const record=fs.readdirSync(tasksDir(root)).find(n=>n.endsWith('.json'));const id=record.slice(0,-5);
 assert.equal(readTask(id,{dir:tasksDir(root)}).state,'running');assert.equal(deadline.runningCount(),1);
 release();await sleep(5);
 const answer=await run({module:'Synthetic'});assert.equal(answer.structuredContent.version,7);assert.equal(runs,1);
 const saved=readTask(id,{dir:tasksDir(root)});assert.equal(saved.state,'ok');assert.equal(saved.cancelled,true);
 await run({module:'Synthetic'});assert.equal(runs,2);assert.equal(deadline.runningCount(),0);
});
test('N1 cancelled mutation retains an undelivered definitive result beyond the old ten minute window',async t=>{
 const {deadline}=setup(t);let runs=0,release;const gate=new Promise(r=>release=r);
 const run=deadline.wrap('odc_asset_delete',async()=>{runs++;await gate;return reply({ok:true,deleted:'Synthetic'});});
 const args={asset:'Synthetic',confirmationToken:'00000000-0000-4000-8000-00000000c12a.00000000000000c1'}; // junction (M6-1): the execution form; without the token it is a preview, a read
 await cancel(run,args);release();await sleep(5);
 const realNow=Date.now,late=realNow()+11*60000;let answer;
 try{Date.now=()=>late;answer=await run(args);}finally{Date.now=realNow;}
 assert.equal(answer.structuredContent.deleted,'Synthetic');assert.equal(runs,1);
});
test('N2 uncertain cancelled write guards a restarted deadline until explicit facade close',async t=>{
 const {root,deadline}=setup(t);let runs=0,release;const gate=new Promise(r=>release=r);
 const reconcile={tool:'o11_publish',arguments:{resume:'synthetic-receipt'},why:'reconcile the existing receipt'};
 const run=deadline.wrap('o11_publish',async()=>{runs++;await gate;return reply({ok:false,outcome:'uncertain',continuation:reconcile});});
 await cancel(run,{module:'Synthetic'});release();await sleep(5);
 const final=await run({module:'Synthetic'});assert.equal(final.structuredContent.outcome,'uncertain');assert.deepEqual(final.structuredContent.continuation,reconcile);
 const saved=fs.readdirSync(tasksDir(root)).filter(n=>n.endsWith('.json')).map(n=>readTask(n.slice(0,-5),{dir:tasksDir(root)}))[0];
 const restarted=createCallDeadline({root,timeoutMs:500});const again=restarted.wrap('o11_publish',async()=>{runs++;return reply({ok:true,version:8});});
 const refused=await again({module:'Synthetic'});assert.equal(refused.structuredContent.outcome,'uncertain');assert.equal(runs,1);
 assert.equal(refused.structuredContent.close.arguments.id,saved.id);
 let lookup;registerSsamTask({registerTool:(_,__,fn)=>lookup=fn},{root});assert.equal((await lookup({id:saved.id,close:{reason:'Synthetic receipt reconciled'}})).structuredContent.ok,true);
 assert.equal((await again({module:'Synthetic'})).structuredContent.version,8);assert.equal(runs,2);
});
test('N2 cancelled queued write retains not-sent final and permits a fresh operation',async t=>{
 const {deadline}=setup(t);let runs=0;
 const run=deadline.wrap('o11_publish',async(_,ctx)=>{runs++;if(runs>1)return reply({ok:true,published:true});await new Promise(r=>ctx.mcpReq.signal.addEventListener('abort',r,{once:true}));return reply({ok:false,code:'CANCELLED',outcome:'not-sent'});});
 await cancel(run,{module:'Synthetic'});await sleep(5);
 const final=await run({module:'Synthetic'});assert.equal(final.structuredContent.published,true);assert.equal(runs,2);
});
test('N2 real Studio queue cancels B before dispatch and permits B after A finishes',async t=>{
 const {root}=setup(t);const handlers=new Map(),runs=[];let releaseA,enteredA;const startA=new Promise(r=>enteredA=r),gate=new Promise(r=>releaseA=r);
 const identity={root,release:{head:'synthetic',facadeSha256:'synthetic',catalogSha256:'synthetic'}};
 const server=await createSsamServer({o11:false,odc:false,deps:{server:new McpServer({name:'queued',version:'1'}),registerTool:(name,config,handler)=>handlers.set(name,handler),answersRoot:root,callDeadlineMs:5000,
  lock:{o11Root:root,odcRoot:root,connection:()=>null},identity:{read:()=>identity}}});t.after(()=>server.close());
 server.registerTool('o11_publish',{inputSchema:fromJsonSchema({type:'object',properties:{module:{type:'string'}}}),annotations:{readOnlyHint:false}},async({module})=>{runs.push(module);if(module==='A'){enteredA();await gate;}return reply({ok:true,published:module});});
 const call=(args,signal)=>handlers.get('o11_publish')(args,{mcpReq:{signal:signal??new AbortController().signal}});
 const a=call({module:'A'});await startA;const c=new AbortController();const b=call({module:'B'},c.signal);await sleep(20);c.abort();await b.catch(()=>{});await sleep(20);releaseA();await a;
 const result=await call({module:'B'});assert.equal(result.structuredContent.published,'B');assert.deepEqual(runs,['A','B']);
});
// Junction CX12 x CX15 (M6-7, converted): CX15 r3 (CT-9) serves ssam_task on EVERY ssam server, so the only-ODC server's
// continuation and close are ssam_task (one per server), no longer the ssam_doctor {task} detour.
test('N2 only ODC uses the served ssam_task continuation and its close releases the persisted guard',async t=>{
 const {root}=setup(t);const handlers=new Map();let release,runs=0;const gate=new Promise(r=>release=r),identity={root,release:{head:'synthetic',facadeSha256:'synthetic',catalogSha256:'synthetic'}};
 const server=await createSsamServer({o11:false,odc:true,deps:{server:new McpServer({name:'odc-only',version:'1'}),registerTool:(name,config,handler)=>handlers.set(name,handler),answersRoot:root,callDeadlineMs:5000,writeLock:async(_,fn)=>fn(),identity:{read:()=>identity},odcFacade:async()=>new McpServer({name:'empty-odc',version:'1'})}});t.after(()=>server.close());
 server.registerTool('odc_deploy',{inputSchema:fromJsonSchema({type:'object',properties:{asset:{type:'string'}}}),annotations:{destructiveHint:true}},async()=>{runs++;await gate;return reply({ok:false,outcome:'uncertain'});});
 const call=(name,args,signal)=>handlers.get(name)(args,{mcpReq:{signal:signal??new AbortController().signal}});
 const c=new AbortController();const first=call('odc_deploy',{asset:'Synthetic'},c.signal);await sleep(20);c.abort();await first.catch(()=>{});release();await sleep(10);
 await call('odc_deploy',{asset:'Synthetic'});const refused=await call('odc_deploy',{asset:'Synthetic'});
 assert.equal(refused.structuredContent.continuation.tool,'ssam_task');assert.equal(refused.structuredContent.close.tool,'ssam_task');assert.equal(typeof refused.structuredContent.close.arguments.id,'string');assert.equal(handlers.has('ssam_task'),true);assert.equal(runs,1);
 const close=refused.structuredContent.close;close.arguments.close.reason='Synthetic reconciliation';assert.equal((await call(close.tool,close.arguments)).structuredContent.ok,true);
 await call('odc_deploy',{asset:'Synthetic'});assert.equal(runs,2);
});
