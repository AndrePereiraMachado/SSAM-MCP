import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import {McpServer,InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/client';
import {fakeBridge} from './fixtures/fake-o11-bridge.mjs';
import {o11Bridge} from '../o11-bridge.mjs';
import {o11Studio} from '../o11-studio.mjs';
import {deliverOutcome} from '../o11-cycle.mjs';
import {createWorkerFirstRunner} from '../anvil-worker.mjs';
import {trackTask,registerSsamTask} from '../ssam-task.mjs';
import {withStudioWriteLock,noteStudioHolder,studioWriteHolder,busyToolResult,registerBridgeFlight} from '../studio-write-lock.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const valueOf=r=>r.structuredContent??JSON.parse(r.content[0].text);
const reply=v=>({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v,...(v.ok===false?{isError:true}:{})});
test('incident replay through MCP: immediate recovery/read, fenced uncertainty, journal settlement, zero queue timeouts',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-incident-')),tasks=path.join(root,'tasks');
 let visible=true,journalState='unknown',closed=0,taskId,publishes=0,coldCalls=0;
 const bridge=await fakeBridge(req=>{
  const data=req.method==='windows'?{windows:visible?[{title:'Unexpected Error',type:'DialogWindow',isVisible:true,isModal:false}]:[]}
   :req.method==='bridge_manifest'?{capabilities:['merge_from_oml:dialog_watch']}
   :req.method==='close_dialog'?(visible=false,closed++,{closed:['Unexpected Error']})
   :req.method==='merge_status'?{state:journalState}:{};
  return{success:true,data};
 });
 const record={pid:process.pid,port:bridge.port},deps={o11Root:root,o11Lane:'ss4',connection:()=>record,queueMs:5000};
 const clientBridge=o11Bridge({port:bridge.port,pid:process.pid});
 const studio=o11Studio({bridge:clientBridge,root,lane:'ss4',assertSelected:async()=>{}});
 const runner=createWorkerFirstRunner({worker:{run:async(_a,o)=>o.avoidBusy?{used:false,note:'the resident worker was busy with deliver; this read ran cold'}:assert.fail('read queued')},cold:async()=>{coldCalls++;await wait(10);return{ok:true,via:'cold'}}});
 const server=new McpServer({name:'cx14-module-replay',version:'1'});
 const registrar={registerTool(name,config,fn){server.registerTool(name,config,async a=>withStudioWriteLock({tool:name,args:a,deps,onBusy:busyToolResult},()=>fn(a,{})))}};
 registrar.registerTool('o11_studio',{inputSchema:z.object({command:z.string(),args:z.record(z.string(),z.unknown()).optional()})},async a=>reply(await studio(a)));
 registrar.registerTool('o11_deliver',{inputSchema:z.object({authorize:z.string().optional()})},async()=>reply(await trackTask({tool:'o11_deliver',dir:tasks},async task=>{
  taskId=task.id;noteStudioHolder({taskId});await wait(1500);
  return deliverOutcome({envelope:{data:{taskId:'a'.repeat(32),stage:'merge',writeState:'unknown',error:'fake persistent dialog',stalled:{verdict:'dialog',method:'merge_from_oml',blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'},afterMs:1400,studio:{pid:process.pid}},pendingBridgeOperation:{method:'merge_from_oml',operationId:'one-merge',moduleKey:'module'}}}},
   {trackId:taskId,work:root,pendingContext:{lane:'ss4',root,record,bridge:clientBridge,settleMs:20,capMs:5000}});
 })));
 registrar.registerTool('o11_publish',{inputSchema:z.object({})},async()=>reply({ok:true,published:++publishes}));
 registrar.registerTool('o11_data',{inputSchema:z.object({request:z.object({operation:z.literal('read')})})},async()=>reply(await runner(['data'],{read:true})));
 registerSsamTask(registrar,{tasksDir:tasks,root,close:async()=>({ok:true,result:'closed'})});
 const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'incident',version:'1'});
 await Promise.all([server.connect(a),client.connect(b)]);
 const results=[],timings={};let maxRefusalBytes=0;
 const call=async(name,args,key)=>{const at=Date.now(),r=await client.callTool({name,arguments:args});timings[key]=Date.now()-at;const v=valueOf(r);results.push(v);if(v.ok===false){const bytes=Buffer.byteLength(JSON.stringify(r));maxRefusalBytes=Math.max(maxRefusalBytes,bytes);assert.ok(bytes<=8192);}return v};
 const start=Date.now(),at=ms=>wait(Math.max(0,ms-(Date.now()-start)));
 const reappear=setTimeout(()=>{visible=true},1000);
 try{
  const delivery=call('o11_deliver',{authorize:'words-never-in-lock'},'deliver');
  await at(200);const first=await call('o11_studio',{command:'dismiss-dialog',args:{title:'Unexpected Error'}},'dismiss1');assert.equal(first.ok,true);assert.ok(timings.dismiss1<=500);assert.equal(closed,1);
  await at(300);const closing=await call('ssam_task',{id:taskId,close:{reason:'test'}},'runningClose');assert.equal(closing.code,'TASK_STILL_RUNNING');assert.equal(closing.holder.tool,'o11_deliver');assert.equal(closing.holder.taskId,taskId);assert.ok(closing.holder.heldMs>=0);assert.ok(timings.runningClose<=500);
  await at(400);const read=await call('o11_data',{request:{operation:'read'}},'read');assert.equal(read.via,'cold');assert.ok(read.workerNote);assert.equal(coldCalls,1);assert.ok(timings.read<=510);
  await at(500);const publishing=call('o11_publish',{},'waitingPublish');
  const uncertain=await delivery;assert.equal(uncertain.code,'DELIVERY_UNCERTAIN');assert.equal(uncertain.recovery[0].arguments.command,'dismiss-dialog');
  const blocked=await publishing;assert.equal(blocked.code,'STUDIO_WRITE_HOLDER_STALLED');assert.equal(blocked.holder.tool,'bridge:merge_from_oml');assert.ok(timings.waitingPublish<=2000);
  await call(blocked.recovery[0].tool,blocked.recovery[0].arguments,'dismiss2');assert.equal(closed,2);assert.equal(studioWriteHolder({deps}).state,'pending-in-studio');
  // CX14 R5: the Studio shows its report once more after the second dismiss (in the incident it stayed from 00:12 to 00:30).
  // The watch of the pending merge marks it again: a write answers at once with the recovery, never the queue timeout.
  visible=true;const reappeared=Date.now();while(studioWriteHolder({deps})?.state!=='stalled'&&Date.now()-reappeared<1000)await wait(1);timings.remarked=Date.now()-reappeared;
  const again=await call('o11_publish',{},'reappearPublish');assert.equal(again.code,'STUDIO_WRITE_HOLDER_STALLED');assert.ok(timings.reappearPublish<=500);
  assert.equal(again.recovery[0].arguments.command,'dismiss-dialog');
  await call(again.recovery[0].tool,again.recovery[0].arguments,'dismiss3');assert.equal(closed,3);assert.equal(studioWriteHolder({deps}).state,'pending-in-studio');
  const settlement=Date.now();journalState='not-applied';while(studioWriteHolder({deps})&&Date.now()-settlement<500)await wait(1);assert.equal(studioWriteHolder({deps}),null);timings.settlement=Date.now()-settlement;assert.ok(timings.settlement<=50);
  assert.equal((await call('ssam_task',{id:taskId,close:{reason:'test'}},'closed')).ok,true);
  assert.equal((await call('o11_publish',{},'publish')).ok,true);assert.equal(publishes,1);
  assert.ok(results.every(v=>v.code!=='STUDIO_WRITE_QUEUE_TIMEOUT'));
  assert.equal(bridge.seen.filter(r=>r.method==='close_dialog').length,3);
  const lockDir=path.join(root,'.local','locks');for(const file of fs.readdirSync(lockDir))assert.ok(!fs.readFileSync(path.join(lockDir,file),'utf8').includes('words-never-in-lock'));
  // Every number here comes from fakes: a fake bridge, a fake kernel (runAnvil answers a recorded receipt after a fixed
  // 1.5 s wait, so "deliver" measures that wait, not the stall detection) and a fake ssam_task close (no proof runs).
  t.diagnostic(JSON.stringify({source:'fake',timings,maxRefusalBytes,closeDialogCalls:closed,publishes,coldCalls,queueTimeouts:0}));
 }finally{clearTimeout(reappear);await client.close();await server.close();await bridge.close()}
});


test('all queue refusal families fit the MCP refusal budget and carry one actionable continuation',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-budget-')),record={pid:process.pid,port:12345};
 const deps={o11Root:root,o11Lane:'ss4',connection:()=>record,queueMs:30};
 let ready,release;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 const owner=withStudioWriteLock({tool:'o11_deliver',deps},async()=>{noteStudioHolder({taskId:'owner-task'});ready();await gate;return{ok:true}});await started;
 const server=new McpServer({name:'queue-budget',version:'1'});
 for(const tool of ['o11_publish','ssam_task'])server.registerTool(tool,{inputSchema:z.object({id:z.string().optional(),close:z.object({reason:z.string()}).optional()})},async args=>withStudioWriteLock({tool,args,deps,onBusy:busyToolResult},()=>assert.fail('refusal must not execute the write')));
 const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'queue-budget',version:'1'});await Promise.all([server.connect(a),client.connect(b)]);
 const sizes={};let flight;
 const check=async(name,args,code)=>{const response=await client.callTool({name,arguments:args}),v=valueOf(response);assert.equal(v.code,code);for(const field of ['tool','pid','startedAt','heldMs','state'])assert.notEqual(v.holder[field],undefined,field);assert.ok(v.continuation?.tool);assert.ok(!Array.isArray(v.continuation));const bytes=Buffer.byteLength(JSON.stringify(response));assert.ok(bytes<=8192);sizes[code]=bytes;return v};
 try{
  await check('o11_publish',{},'STUDIO_WRITE_QUEUE_TIMEOUT');await check('ssam_task',{id:'owner-task',close:{reason:'private budget test words'}},'TASK_STILL_RUNNING');release();await owner;
  flight=registerBridgeFlight({lane:'ss4',root,record,method:'merge_from_oml',taskId:'pending-task',operationId:'journal',blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'}});
  await check('o11_publish',{},'STUDIO_WRITE_HOLDER_STALLED');
  const dir=path.join(root,'.local','locks');for(const file of fs.readdirSync(dir)){const text=fs.readFileSync(path.join(dir,file),'utf8');assert.ok(!text.includes('private budget test words'));assert.ok(!/"(args|arguments|authorize|authorization|reason|request)"\s*:/.test(text))}
  t.diagnostic(JSON.stringify({refusalBytes:sizes,maxBytes:Math.max(...Object.values(sizes))}));
 }finally{release();await owner;flight?.();await client.close();await server.close()}
});
