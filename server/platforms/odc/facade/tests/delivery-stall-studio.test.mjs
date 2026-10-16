import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import {McpServer,InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/client';
import {registerO11Cycle,deliverOutcome} from '../o11-cycle.mjs';
import {withStudioWriteLock,studioWriteHolder,busyToolResult} from '../studio-write-lock.mjs';
import {fakeAnvil} from './fixtures/fake-anvil.mjs';

// CX14 N1: the pending merge ran in the Studio recorded with it (pendingBridgeOperation.stall.studio). After a restart the
// connected Studio is another one: its queue cannot hold that merge, so the facade never fences it, never offers the dismiss
// of a dialog of the dead Studio, and the close (the kernel's hash proof for another Studio) is the next call and runs.
// In the same Studio the unknown merge keeps its fence. Synthetic values; fake kernel and bridge objects.
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const OP='0123456789abcdef0123456789abcdef',K='fedcba9876543210fedcba9876543210';
const S1={pid:process.pid+100000,startedUtc:'2026-10-15T00:12:00.000Z'};
const S2={pid:process.pid,startedUtc:'2026-10-15T00:31:00.000Z'};
const stallIn=studio=>({verdict:'dialog',method:'merge_from_oml',afterMs:108,studio,blockedBy:{title:'Unexpected Error',type:'DialogWindow',kind:'UnexpectedError',seenMs:48}});
// The kernel's receipt of the resume in the connected Studio: the merge's journal is still unknown.
const resumed=studio=>({taskId:K,module:'Orders',delivered:false,writeState:'unknown',stage:'reconcile',operationId:OP,moduleKey:'KEY-A',environment:'env',
  error:'Merge outcome remains unknown; no creation or merge was replayed. Reconcile the original operation.',stalled:stallIn(studio),
  pendingBridgeOperation:{method:'merge_from_oml',moduleKey:'KEY-A',operationId:OP,stall:stallIn(studio)}});
const bridge={ok:async verb=>verb==='merge_status'?{state:'unknown'}:verb==='windows'?{windows:[]}:verb==='ui_alive'?{alive:true}:verb==='list_open_modules'?{modules:[]}:{}};
function folder(record){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-n1-')),auth=path.join(root,'authority');fs.mkdirSync(auth);
  const file=path.join(root,'.local','connections','ss4.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({ok:true,lane:'o11',anvilLane:'ss4',...record,port:12345,studioDir:root,authorityDir:auth}));
  return {root,auth,deps:{o11Root:root,o11Lane:'ss4',queueMs:1500}};
}

for(const same of [false,true])test(same?'control: in the same Studio the unknown merge keeps its fence':'after a restart the new Studio is not fenced by the old merge; the answer names the close',async()=>{
  const {root,deps}=folder(S2);
  const value=deliverOutcome({envelope:{ok:false,data:resumed(same?S2:S1)}},{trackId:'facade-task',work:path.join(root,'.local','work'),
    pendingContext:{lane:'ss4',root,record:{...S2,authorityDir:path.join(root,'authority'),port:12345},bridge,settleMs:20,capMs:300}});
  assert.equal(value.code,'DELIVERY_UNCERTAIN');assert.equal(value.writeState,'unknown');
  const holder=studioWriteHolder({lane:'o11',deps});
  if(same){
    assert.equal(holder?.tool,'bridge:merge_from_oml');assert.equal(value.recovery[0].arguments.command,'dismiss-dialog');
    assert.equal(value.studioChanged,undefined);
  }else{
    assert.equal(holder,null,'no fence on the new Studio');
    assert.deepEqual(value.studioChanged,{operation:S1,current:S2});
    assert.ok(!value.recovery.some(r=>r.arguments?.command==='dismiss-dialog'),'no dismiss of a dialog of the dead Studio');
    assert.deepEqual([value.continuation.tool,value.continuation.arguments.id],['ssam_task',K]);assert.ok(value.continuation.arguments.close);
    assert.match(value.error,/is gone/);
  }
  await wait(350);
});

test('after a restart the resume, the close and another write of the new Studio run without waiting the queue; the merge is never sent',async()=>{
  const {root,auth,deps}=folder(S2);
  const work=path.join(root,'.local','work'),job=path.join(root,'job.json');fs.writeFileSync(job,JSON.stringify({ops:[]}));
  const save=data=>{const d=path.join(work,'deliver',K);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'task.json'),JSON.stringify({...data,request:{JobPath:job,Module:'Orders'},updatedAt:new Date().toISOString()}))};
  const state=resumed(S1);save(state);
  let closes=0;const verbs=[];const counted={ok:async(verb,...rest)=>{verbs.push(verb);return bridge.ok(verb,...rest)}};
  // The kernel CLI: deliver --resume answers the receipt above; deliver --close (the close the answer names) closes with the
  // hash proof, as DeliveryTask.CloseKnownFailure does for another Studio (tested in DeliveryStallEvidenceTests).
  const runAnvil=fakeAnvil({deliver:args=>{
    if(args.includes('--close')){closes++;const closed={...state,closed:true,closedReason:'synthetic',writeState:'not-applied',closeProof:{equal:true}};save(closed);return{ok:true,command:'deliver',data:closed}}
    save(state);return{ok:false,command:'deliver',data:structuredClone(state)};
  }});
  const server=new McpServer({name:'cx14-n1',version:'1'});
  const registrar={registerTool(name,config,fn){server.registerTool(name,config,async(a,extra)=>withStudioWriteLock({tool:name,args:a,lane:'o11',deps,onBusy:busyToolResult},()=>fn(a,extra)))}};
  registerO11Cycle(registrar,{root,lane:'ss4',env:{...process.env,ANVIL_AUTHORITY_DIR:auth},assertSelected:async()=>{},runAnvil,bridge:()=>counted});
  registrar.registerTool('o11_publish',{inputSchema:z.object({module:z.string()})},async()=>({content:[{type:'text',text:'{"ok":true}'}],structuredContent:{ok:true}}));
  const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'cx14-n1-client',version:'1'});
  await Promise.all([server.connect(a),client.connect(b)]);
  const call=async(name,args)=>{const at=Date.now(),r=await client.callTool({name,arguments:args});return{ms:Date.now()-at,value:r.structuredContent??JSON.parse(r.content[0].text)}};
  try{
    const resume=await call('o11_deliver',{resume:K,authorize:'synthetic words'});
    assert.equal(resume.value.code,'DELIVERY_UNCERTAIN');assert.equal(resume.value.continuation.tool,'ssam_task');
    assert.equal(studioWriteHolder({lane:'o11',deps}),null);
    const publish=await call('o11_publish',{module:'OtherModule'});
    assert.equal(publish.value.ok,true);assert.ok(publish.ms<1000,'another write of the new Studio does not wait');
    const again=await call('o11_deliver',{resume:K,authorize:'synthetic words'});
    assert.equal(again.value.code,'DELIVERY_UNCERTAIN');assert.ok(again.ms<1000,'a second resume does not wait either');
    const close=await call('ssam_task',resume.value.continuation.arguments);
    assert.equal(close.value.ok,true,JSON.stringify(close.value));assert.equal(closes,1,'the close reaches the kernel');
    assert.equal(verbs.filter(v=>v==='merge_from_oml').length,0,'the facade never sends the merge again');
    assert.ok(!fs.existsSync(path.join(auth,'studio-locks'))||fs.readdirSync(path.join(auth,'studio-locks')).every(n=>!n.includes('~f-')),'no flight on the new Studio');
  }finally{await client.close();await server.close()}
});

// CX14 N5: N1 x N3. The merge stopped in S1 (gone); the resume ran in S2 and its own open_module stopped behind a report of
// S2. That call is judged by its own Studio: fenced in S2 until the proven idle, its stalled and the dismiss stay, the
// answer never says the connected Studio cannot be running anything, and the close comes only after that idle.
const openStopIn=studio=>({verdict:'dialog',method:'open_module',afterMs:216,studio,blockedBy:{title:'Unexpected Error',type:'DialogWindow',kind:'UnexpectedError',seenMs:100}});
const resumedWithOwnStop=()=>({...resumed(S1),stage:'open',error:'BridgeCallException: open_module: Studio call stopped (dialog): Unexpected Error; nothing was repeated',
  stalled:openStopIn(S2),pendingBridgeOperation:{method:'merge_from_oml',moduleKey:'KEY-A',operationId:OP,stall:stallIn(S1),after:[{method:'open_module',moduleKey:'KEY-A',stall:openStopIn(S2)}]}});
test('N5: a call of the resume stopped in the connected Studio keeps its fence and its dismiss; the close comes after idle',async()=>{
  const {root,deps}=folder(S2);let dialog=true,alive=false;
  const studioBridge={ok:async verb=>verb==='merge_status'?{state:'unknown'}:verb==='windows'?{windows:dialog?[{title:'Unexpected Error',type:'DialogWindow',isVisible:true,isModal:false}]:[]}
    :verb==='ui_alive'?{alive}:verb==='list_open_modules'?{modules:[]}:{}};
  const value=deliverOutcome({envelope:{ok:false,data:resumedWithOwnStop()}},{trackId:'facade-task',work:path.join(root,'.local','work'),
    pendingContext:{lane:'ss4',root,record:{...S2,authorityDir:path.join(root,'authority'),port:12345},bridge:studioBridge,settleMs:20,capMs:5000}});
  assert.equal(value.code,'DELIVERY_UNCERTAIN');
  assert.deepEqual(value.studioChanged,{operation:S1,current:S2});
  assert.equal(value.stalled?.method,'open_module','the stop of S2 is shown');
  assert.equal(value.recovery[0].arguments.command,'dismiss-dialog');assert.equal(value.recovery[0].arguments.args.title,'Unexpected Error');
  assert.equal(value.recovery[1].tool,'o11_deliver','the resume proves the idle; the close would be refused before it');
  assert.ok(!/cannot be running it/.test(value.error),value.error);
  const fenced=studioWriteHolder({lane:'o11',deps});
  assert.equal(fenced?.tool,'bridge:open_module');assert.equal(fenced?.state,'stalled');
  await wait(150);assert.equal(studioWriteHolder({lane:'o11',deps})?.tool,'bridge:open_module','the open may still run: the fence stays');
  dialog=false;alive=true;await wait(150);
  assert.equal(studioWriteHolder({lane:'o11',deps}),null,'two idle reads release it');
});
test('N5: the same rule decides in tracked() (shared helpers): the call of the connected Studio is unsettled here',async()=>{
  const {unsettledHere,studioChangedOf}=await import('../o11-cycle.mjs');
  const pending={taskId:K,...resumedWithOwnStop()};
  assert.deepEqual(studioChangedOf(pending,S2),{operation:S1,current:S2});
  assert.deepEqual(unsettledHere(pending,S2).map(c=>c.method),['open_module']);
  assert.deepEqual(unsettledHere({...pending,pendingBridgeOperation:{...pending.pendingBridgeOperation,after:[{method:'open_module',stall:openStopIn(S1)}]}},S2),[],'a call of the dead Studio is not fenced');
});
