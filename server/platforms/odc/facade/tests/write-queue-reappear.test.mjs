import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fakeBridge} from './fixtures/fake-o11-bridge.mjs';
import {watchPendingOperation} from '../studio-pending-operation.mjs';
import {withStudioWriteLock,studioWriteHolder} from '../studio-write-lock.mjs';
import {bridgeRequest,flightOf} from '../o11-bridge.mjs';

// CX14 R5: a dialog that blocks a pending Studio operation can go and come back (the incident's report stayed from 00:12 to
// 00:30 and the Studio showed it again). Every valid read that shows a counting window again marks the holder stalled
// again, so a write answers at once with the recovery instead of waiting for the whole queue limit, and the dismiss of that
// exact blocker still passes the queue. Synthetic values only; fake bridges.
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const MAIN={title:'Service Studio',type:'MainWindow',isVisible:true,isModal:false,texts:[]};
const REPORT={title:'Unexpected Error',type:'DialogWindow',isVisible:true,isModal:false,texts:[]};
const CUSTOM={title:'Synthetic blocker',type:'DialogWindow',isVisible:true,isModal:true,texts:['[Button] OK']};
const QUEUE_MS=1500;
const setup=tag=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-r5-'+tag+'-')),record={pid:process.pid,port:41000+Math.floor(Math.random()*999)};
  return{root,record,deps:{o11Root:root,o11Lane:'ss4',connection:()=>record,queueMs:QUEUE_MS}}};
async function write(deps) {
  let ran=false;const at=Date.now();
  const value=await withStudioWriteLock({tool:'o11_publish',args:{module:'SynthModule'},lane:'ss4',deps},async()=>{ran=true;return{ok:true}});
  return{value,ran,ms:Date.now()-at};
}
const expectStalled=(attempt,title)=>{
  assert.equal(attempt.ran,false);assert.equal(attempt.value.code,'STUDIO_WRITE_HOLDER_STALLED');assert.ok(attempt.ms<QUEUE_MS/2,`answered in ${attempt.ms} ms`);
  assert.equal(attempt.value.holder.blockedBy.title,title);assert.ok(attempt.value.recovery.length>=1);
};
const holderState=deps=>studioWriteHolder({lane:'ss4',deps})?.state??null;
async function until(check,ms=1000){const end=Date.now()+ms;while(Date.now()<end){if(check())return true;await wait(5)}return check()}

test('the pending-operation watch marks a report that comes back: the write answers stalled, never the queue timeout',async()=>{
  const {root,record,deps}=setup('watch');let dialog=true;
  const bridge={ok:async verb=>verb==='merge_status'?{state:'unknown'}:{windows:dialog?[MAIN,REPORT]:[MAIN]}};
  const release=watchPendingOperation({lane:'ss4',root,record,method:'merge_from_oml',operationId:'op-a',moduleKey:'k',taskId:'facade-a',kernelTaskId:'kernel-a',
    blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'},bridge,settleMs:20,capMs:60000,alive:()=>true});
  try{
    expectStalled(await write(deps),'Unexpected Error');
    dialog=false;assert.ok(await until(()=>holderState(deps)==='pending-in-studio'));
    dialog=true;assert.ok(await until(()=>holderState(deps)==='stalled'),'the watch marks the report again');
    expectStalled(await write(deps),'Unexpected Error');
  }finally{release()}
});

test('after the second dismiss the report comes back: the next write is answered stalled with its recovery',async()=>{
  const {root,record,deps}=setup('dismiss');let dialog=true,closes=0;
  const bridge={ok:async verb=>verb==='merge_status'?{state:'unknown'}:{windows:dialog?[MAIN,REPORT]:[MAIN]}};
  const release=watchPendingOperation({lane:'ss4',root,record,method:'merge_from_oml',operationId:'op-b',moduleKey:'k',taskId:'facade-b',
    blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'},bridge,settleMs:20,capMs:60000,alive:()=>true});
  const dismiss=()=>withStudioWriteLock({tool:'o11_studio',args:{command:'dismiss-dialog',args:{title:'Unexpected Error'}},lane:'ss4',deps},
    async()=>{closes++;dialog=false;return{ok:true,closed:['Unexpected Error']}});
  try{
    for(let round=1;round<=2;round++){
      const at=Date.now();assert.equal((await dismiss()).ok,true);assert.ok(Date.now()-at<500);assert.equal(holderState(deps),'pending-in-studio');
      dialog=true;assert.ok(await until(()=>holderState(deps)==='stalled'),'round '+round);
      const attempt=await write(deps);expectStalled(attempt,'Unexpected Error');
      assert.equal(attempt.value.recovery[0].arguments.command,'dismiss-dialog');
    }
    assert.equal(closes,2);
  }finally{release()}
});

test('a blocker that is not an error report goes and comes back: its exact dismiss still passes the queue',async()=>{
  const {root,record,deps}=setup('custom');let dialog=true;
  const bridge={ok:async verb=>verb==='merge_status'?{state:'unknown'}:{windows:dialog?[MAIN,CUSTOM]:[MAIN]}};
  const release=watchPendingOperation({lane:'ss4',root,record,method:'merge_from_oml',operationId:'op-c',moduleKey:'k',taskId:'facade-c',
    blockedBy:{title:'Synthetic blocker',kind:'MessageBox'},bridge,settleMs:20,capMs:60000,alive:()=>true});
  try{
    dialog=false;assert.ok(await until(()=>holderState(deps)==='pending-in-studio'));
    dialog=true;assert.ok(await until(()=>holderState(deps)==='stalled'));
    let ran=false;const at=Date.now();
    const value=await withStudioWriteLock({tool:'o11_studio',args:{command:'dismiss-dialog',args:{title:'Synthetic blocker'}},lane:'ss4',deps},
      async()=>{ran=true;dialog=false;return{ok:true,closed:['Synthetic blocker']}});
    assert.equal(ran,true);assert.equal(value.ok,true);assert.ok(Date.now()-at<500,`dismiss took ${Date.now()-at} ms`);
  }finally{release()}
});

test('a dismiss of the exact blocker that arrives before the watch saw it again waits only until the watch marks it',async()=>{
  const {root,record,deps}=setup('race');let dialog=true;
  const bridge={ok:async verb=>verb==='merge_status'?{state:'unknown'}:{windows:dialog?[MAIN,CUSTOM]:[MAIN]}};
  const release=watchPendingOperation({lane:'ss4',root,record,method:'merge_from_oml',operationId:'op-d',moduleKey:'k',taskId:'facade-d',
    blockedBy:{title:'Synthetic blocker',kind:'MessageBox'},bridge,settleMs:150,capMs:60000,alive:()=>true});
  try{
    dialog=false;assert.ok(await until(()=>holderState(deps)==='pending-in-studio',1500));
    dialog=true;let ran=false;const at=Date.now();
    const value=await withStudioWriteLock({tool:'o11_studio',args:{command:'dismiss-dialog',args:{title:'Synthetic blocker'}},lane:'ss4',deps},
      async()=>{ran=true;dialog=false;return{ok:true,closed:['Synthetic blocker']}});
    assert.equal(ran,true,JSON.stringify(value));assert.ok(Date.now()-at<QUEUE_MS/2,`dismiss took ${Date.now()-at} ms`);
  }finally{release()}
});

test('the bridge client keeps sampling a stalled flight while it lives: a report that comes back marks it again',async()=>{
  const {root,record:base,deps:baseDeps}=setup('flight');let dialog=false;const seen=[];let main=null;
  const bridge=await fakeBridge((req,socket)=>{
    seen.push(req.method);
    if(req.method==='ping')return{success:true,data:{pid:process.pid}};
    if(req.method==='bridge_manifest')return{success:true,data:{capabilities:[]}};
    if(req.method==='windows')return{success:true,data:{windows:dialog?[MAIN,REPORT]:[MAIN]}};
    main=socket;dialog=true;return undefined;
  });
  const record={...base,port:bridge.port},deps={...baseDeps,connection:()=>record};
  const target={port:bridge.port,pid:process.pid,record,flight:flightOf({lane:'ss4',root,record})};
  try{
    const error=await bridgeRequest(target,'merge_from_oml',{module_key:'k'},{probeMs:30,probeTimeoutMs:200,timeoutMs:5000}).then(()=>null,e=>e);
    assert.equal(error?.code,'BRIDGE_STALLED');assert.equal(holderState(deps),'stalled');
    dialog=false;assert.ok(await until(()=>holderState(deps)==='pending-in-studio'));
    dialog=true;assert.ok(await until(()=>holderState(deps)==='stalled'),'the flight keeps sampling while it lives');
    expectStalled(await write(deps),'Unexpected Error');
    assert.equal(seen.filter(m=>m==='merge_from_oml').length,1);
    main.write(JSON.stringify({success:true,data:{merged:false}})+'\n');
    assert.ok(await until(()=>holderState(deps)===null),'the late answer ends the flight');
    const probes=seen.filter(m=>m==='windows').length;await wait(150);
    assert.ok(seen.filter(m=>m==='windows').length-probes<=1,'no sampling after the flight ended');
  }finally{await bridge.close()}
});
