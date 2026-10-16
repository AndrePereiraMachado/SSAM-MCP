import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as locks from '../studio-write-lock.mjs';
import {o11Studio} from '../o11-studio.mjs';
import {trackTask,registerSsamTask} from '../ssam-task.mjs';
import {McpServer,InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/client';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const sandbox=()=>({o11Root:fs.mkdtempSync(path.join(os.tmpdir(),'cx14-recovery-')),o11Lane:'ss4',queueMs:1200});
test('error-report recovery bypasses holder, serializes recoveries, normal dismiss stays FIFO, close first',async()=>{
 const deps=sandbox();let release,ready;const gate=new Promise(r=>release=r),started=new Promise(r=>ready=r),order=[];
 const owner=locks.withStudioWriteLock({tool:'o11_deliver',deps},async()=>{locks.noteStudioHolder({taskId:'task'});ready();await gate;order.push('owner');return{ok:true}});
 await started;
 try{
  const before=Date.now(); const close=await locks.withStudioWriteLock({tool:'ssam_task',args:{id:'task',close:{reason:'words-never-in-lock'}},deps},()=>assert.fail('cannot close running task'));
  assert.equal(close.code,'TASK_STILL_RUNNING');assert.ok(Date.now()-before<500);assert.equal(close.holder.taskId,'task');
  let running=0,max=0;
  const recover=()=>locks.withStudioWriteLock({tool:'o11_studio',args:{command:'dismiss-dialog',args:{title:'Unexpected Error'}},deps},async()=>{max=Math.max(max,++running);await wait(15);running--;return{ok:true}});
  await Promise.all([recover(),recover()]);assert.equal(max,1);
  const normal=locks.withStudioWriteLock({tool:'o11_studio',args:{command:'dismiss-dialog',args:{title:'Question'}},deps},async()=>{order.push('normal');return{ok:true}});
  const writes=[1,2,3].map(i=>locks.withStudioWriteLock({tool:'o11_publish',deps},async()=>{order.push(i);return{ok:true}}));
  const priority=locks.withStudioWriteLock({tool:'ssam_task',args:{id:'other',close:{reason:'done'}},deps},async()=>{order.push('close');return{ok:true}});
  await wait(30);
  const dir=path.join(deps.o11Root,'.local','locks');for(const file of fs.readdirSync(dir)){const text=fs.readFileSync(path.join(dir,file),'utf8');assert.ok(!text.includes('words-never-in-lock'));assert.ok(!/"(args|arguments|authorize|authorization|reason|request)"\s*:/.test(text));}
  release();await owner;await Promise.all([normal,...writes,priority]);assert.deepEqual(order,['owner','close','normal',1,2,3]);
 }finally{release();await owner}
});
test('matching stalled dialog bypass clears metadata, pending task close is immediate',async()=>{
 const deps=sandbox(),record={pid:process.pid,port:1234};deps.connection=()=>record;
 const flight=locks.registerBridgeFlight({lane:'ss4',root:deps.o11Root,record,method:'merge_from_oml',taskId:'pending',operationId:'op',blockedBy:{title:'Custom dialog',kind:'MessageBox'}});
 try{
  const refused=await locks.withStudioWriteLock({tool:'ssam_task',args:{id:'pending',close:{reason:'done'}},deps},()=>assert.fail('pending'));
  assert.equal(refused.code,'CLOSE_WAITS_FOR_PENDING_OPERATION');assert.ok(refused.recovery.length);
  await locks.withStudioWriteLock({tool:'o11_studio',args:{command:'dismiss-dialog',args:{title:'Custom dialog'}},deps},async()=>({ok:false,code:'DIALOG_NOT_FOUND'}));
  const holder=locks.studioWriteHolder({deps});assert.equal(holder.state,'pending-in-studio');assert.ok(!holder.blockedBy);
 }finally{flight()}
 for(const command of ['status','windows','errors'])assert.equal(locks.isWrite('o11_studio',{command}),false);
 assert.equal(locks.isWrite('ssam_task',{id:'x'}),false);assert.equal(locks.isWrite('studio_dismiss_dialog',{}),true);
});
for(const capable of [true,false])test(`ownerless error report close requires native bridge capability (${capable})`,async()=>{
 let closes=0;
 const bridge={ok:async method=>method==='windows'?{windows:[{title:'Unexpected Error',type:'DialogWindow',isVisible:true,isModal:false}]}:method==='bridge_manifest'?{capabilities:capable?['merge_from_oml:dialog_watch']:[]}:method==='close_dialog'?(closes++,{closed:['Unexpected Error']}):{}};
 const run=o11Studio({bridge,assertSelected:async()=>{}});
 const result=await run({command:'dismiss-dialog',args:{title:'Unexpected Error'}});
 assert.equal(result.ok,capable);assert.equal(closes,capable?1:0);if(!capable)assert.equal(result.code,'WEB_DIALOG');
});
test('facade task running during build answers TASK_STILL_RUNNING without a Studio lock',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-build-close-'));let done,id;
 const gate=new Promise(r=>done=r);const tracking=trackTask({tool:'o11_deliver',dir},async task=>{id=task.id;await gate;return{ok:true}});
 const server=new McpServer({name:'build-close',version:'1'});registerSsamTask(server,{tasksDir:dir,close:async()=>assert.fail('running')});
 const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'build-close',version:'1'});await Promise.all([server.connect(a),client.connect(b)]);
 try{const reply=await client.callTool({name:'ssam_task',arguments:{id,close:{reason:'test'}}});const value=reply.structuredContent??JSON.parse(reply.content[0].text);assert.equal(value.code,'TASK_STILL_RUNNING');assert.equal(value.task.id,id);assert.equal(value.task.state,'running');assert.ok(value.task.startedAt)}finally{done();await tracking;await client.close();await server.close()}
});
test('a stalled custom dialog hidden behind its running owner still bypasses, and owner close stays TASK_STILL_RUNNING',async()=>{
 const deps=sandbox(),record={pid:process.pid,port:9012};deps.connection=()=>record;
 let ready,finish;const started=new Promise(r=>ready=r),gate=new Promise(r=>finish=r);
 const owner=locks.withStudioWriteLock({tool:'o11_deliver',deps},async()=>{locks.noteStudioHolder({taskId:'owner'});ready();await gate;return{ok:true}});
 await started;const flight=locks.registerBridgeFlight({root:deps.o11Root,lane:'ss4',record,method:'open_module',taskId:'owner',blockedBy:{title:'Custom blocker',kind:'MessageBox'}});
 try{
  const close=await locks.withStudioWriteLock({tool:'ssam_task',args:{id:'owner',close:{reason:'test'}},deps},()=>assert.fail('running'));
  assert.equal(close.code,'TASK_STILL_RUNNING');assert.equal(close.holder.tool,'o11_deliver');
  const before=Date.now();const dismissed=await locks.withStudioWriteLock({tool:'o11_studio',args:{command:'dismiss-dialog',args:{title:'Custom blocker'}},deps},async()=>({ok:true,closed:['Custom blocker']}));
  assert.equal(dismissed.ok,true);assert.ok(Date.now()-before<500);assert.equal(locks.pendingOperationOf({taskId:'owner',deps}).state,'pending-in-studio');
 }finally{flight();finish();await owner}
});
test('recovery lock excludes a normal writer and cancellation still uses the MCP onBusy shape',async()=>{
 const deps=sandbox();let ready,finish;const started=new Promise(r=>ready=r),gate=new Promise(r=>finish=r),order=[];
 const recovery=locks.withStudioWriteLock({tool:'o11_studio',args:{command:'dismiss-dialog',args:{title:'Unexpected Error'}},deps},async()=>{ready();await gate;order.push('recovery');return{ok:true}});
 await started;const normal=locks.withStudioWriteLock({tool:'o11_publish',deps},async()=>{order.push('normal');return{ok:true}});
 const aborted=new AbortController();aborted.abort();
 const answer=await locks.withStudioWriteLock({tool:'o11_studio',args:{command:'dismiss-dialog',args:{title:'Unexpected Error'}},deps,signal:aborted.signal,onBusy:locks.busyToolResult},()=>assert.fail('cancelled'));
 assert.equal(answer.structuredContent.code,'CANCELLED');assert.equal(answer.isError,true);await wait(20);assert.deepEqual(order,[]);finish();await Promise.all([recovery,normal]);assert.deepEqual(order,['recovery','normal']);
});

test('close finds its running owner behind another narrowed module holder in the same Studio',async()=>{
 const deps={...sandbox(),queueMs:100},record={pid:process.pid,port:9034};deps.connection=()=>record;
 let finish;const gate=new Promise(r=>finish=r),owners=[];
 const startOwner=async(module,id)=>{
  let ready;const started=new Promise(r=>ready=r);
  const owner=locks.withStudioWriteLock({tool:'o11_deliver',args:{module},deps},async()=>{
   locks.noteStudioHolder({taskId:id});
   assert.equal(locks.narrowStudioWrite({module}).narrowed,true);
   ready();await gate;return{ok:true};
  });
  owners.push(owner);await started;
 };
 try{
  await startOwner('ModuleA','task-A');await startOwner('ModuleB','task-B');
  const before=Date.now();
  const value=await locks.withStudioWriteLock({tool:'ssam_task',args:{id:'task-B',close:{reason:'fake close'}},deps},()=>assert.fail('the second owner is still running'));
  assert.equal(value.code,'TASK_STILL_RUNNING');
  assert.equal(value.holder.taskId,'task-B');assert.equal(value.holder.tool,'o11_deliver');
  assert.ok(Date.now()-before<500);assert.ok(value.holder.heldMs>=0);assert.ok(value.holder.startedAt);
  assert.equal(value.continuation.tool,'ssam_task');assert.equal(value.continuation.arguments.id,'task-B');
 }finally{finish();await Promise.all(owners)}
});
