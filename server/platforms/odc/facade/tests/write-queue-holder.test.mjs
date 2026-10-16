import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as locks from '../studio-write-lock.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {deliverOutcome} from '../o11-cycle.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cx14-holder-'));
test('holder metadata follows phased promotion, sidecar token, timeout and release',async()=>{
 const r=root(),deps={o11Root:r,o11Lane:'ss4',queueMs:30};let release,ready;
 const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 const delivery=locks.withStudioWriteLock({tool:'o11_deliver',args:{module:'secret-user-module'},deps,phased:true},async()=>{
  locks.noteStudioHolder({taskId:'facade-task'});await locks.enterApplyPhase();ready();await gate;return {ok:true};
 });
 await started;
 try{
 const result=await locks.withStudioWriteLock({tool:'o11_publish',deps},()=>assert.fail('must not run'));
 assert.equal(result.code,'STUDIO_WRITE_QUEUE_TIMEOUT');assert.equal(result.holder.taskId,'facade-task');assert.equal(result.holder.state,'running');assert.ok(result.holder.heldMs>=0);assert.deepEqual(result.continuation.arguments,{id:'facade-task'});assert.ok(Array.isArray(result.ahead));
 const dir=path.join(r,'.local','locks');const files=fs.readdirSync(dir);assert.ok(files.some(f=>f.endsWith('.holder')));
 for(const f of files)assert.ok(!fs.readFileSync(path.join(dir,f),'utf8').includes('secret-user-module'));
 }finally{release();await delivery}
 assert.equal(fs.readdirSync(path.join(r,'.local','locks')).filter(f=>f.endsWith('.holder')).length,0);
});
test('stalled flight refuses promptly, cleared dialog becomes pending, task lookup uses files',async()=>{
 const r=root(),record={pid:process.pid,port:12345},deps={o11Root:r,o11Lane:'ss4',connection:()=>record,queueMs:50};
 const flight=locks.registerBridgeFlight({lane:'ss4',root:r,record,method:'merge_from_oml',taskId:'facade',kernelTaskId:'kernel',operationId:'operation',blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'}});
 try{
 const before=Date.now(),result=await locks.withStudioWriteLock({tool:'o11_publish',deps},()=>assert.fail('must not run'));
 assert.equal(result.code,'STUDIO_WRITE_HOLDER_STALLED');assert.ok(Date.now()-before<2000);assert.equal(result.holder.state,'stalled');assert.equal(result.recovery[0].tool,'o11_studio');assert.ok(locks.pendingOperationOf({taskId:'facade',deps}));
 flight.update({blockedBy:null});
 const pending=await locks.withStudioWriteLock({tool:'o11_publish',deps},()=>assert.fail('pending'));
 assert.equal(pending.code,'STUDIO_WRITE_QUEUE_TIMEOUT');assert.equal(pending.holder.state,'pending-in-studio');assert.ok(!pending.holder.blockedBy);
 }finally{flight()}
});
test('sidecar from another token is ignored, stale and orphan sidecars cannot hold a Studio',async()=>{
 const r=root(),deps={o11Root:r,o11Lane:'ss4',queueMs:0},dir=path.join(r,'.local','locks');
 let ready,release;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 const owner=locks.withStudioWriteLock({tool:'o11_deliver',deps},async()=>{
  locks.noteStudioHolder({taskId:'real-task'});
  const file=fs.readdirSync(dir).find(n=>n.endsWith('.lock'));
  fs.writeFileSync(path.join(dir,file+'.holder'),JSON.stringify({schema:'ssam-studio-write-holder/1',token:'wrong',taskId:'wrong-task',blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'}}));
  ready();await gate;
 });
 await started;try{const value=locks.studioWriteHolder({deps});assert.equal(value.state,'running');assert.equal(value.taskId,undefined);assert.equal(value.blockedBy,undefined)}finally{release();await owner}
 assert.equal(fs.readdirSync(dir).length,0);
 const file=path.join(dir,'o11-ss4.lock');
 fs.writeFileSync(file,JSON.stringify({schema:locks.LOCK_SCHEMA,pid:process.pid,token:'stale',tool:'gone',startedAt:new Date().toISOString()}));
 fs.writeFileSync(file+'.holder',JSON.stringify({schema:'ssam-studio-write-holder/1',token:'stale',blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'}}));
 await locks.withStudioWriteLock({tool:'o11_publish',deps},async()=>{assert.equal(fs.existsSync(file+'.holder'),false);return{ok:true}});
 fs.writeFileSync(file+'.holder',JSON.stringify({schema:'ssam-studio-write-holder/1',token:'orphan'}));assert.equal(locks.studioWriteHolder({deps}),null);
});
test('a second process finds the pending operation using only lock and sidecar files',async()=>{
 const r=root(),record={pid:process.pid,port:12345};
 const flight=locks.registerBridgeFlight({lane:'ss4',root:r,record,method:'merge_from_oml',taskId:'cross-process',kernelTaskId:'kernel',operationId:'journal',blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'}});
 try{
  const source=`import {pendingOperationOf} from ${JSON.stringify(new URL('../studio-write-lock.mjs',import.meta.url).href)}; process.stdout.write(JSON.stringify(pendingOperationOf({taskId:'cross-process',root:process.argv[1],lane:'ss4',record:JSON.parse(process.argv[2])})));`;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',source,r,JSON.stringify(record)],{windowsHide:true,env:process.env});
  const value=JSON.parse(stdout);assert.equal(value.taskId,'cross-process');assert.equal(value.operation.operationId,'journal');assert.equal(value.state,'stalled');
 }finally{flight()}
});
test('delivery pre-refusal and uncertainty preserve their codes and provide ordered recovery',()=>{
 const stalled={verdict:'dialog-before',blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'},afterMs:0};
 const pre=deliverOutcome({envelope:{data:{code:'STUDIO_ERROR_DIALOG_OPEN',writeState:'not-sent',stalled,taskId:'a'.repeat(32)}}},{work:root(),trackId:'facade'});
 assert.equal(pre.code,'STUDIO_ERROR_DIALOG_OPEN');assert.equal(pre.outcome,'refused');assert.equal(pre.writeState,'not-sent');assert.equal(pre.recovery[0].arguments.command,'dismiss-dialog');assert.equal(pre.recovery[1].arguments.resume,'a'.repeat(32));
 const uncertain=deliverOutcome({envelope:{data:{writeState:'unknown',taskId:'a'.repeat(32)}}},{work:root(),trackId:'facade'});
 assert.equal(uncertain.code,'DELIVERY_UNCERTAIN');assert.equal(uncertain.recovery.length,1);assert.equal(uncertain.continuation.arguments.resume,'a'.repeat(32));
});
