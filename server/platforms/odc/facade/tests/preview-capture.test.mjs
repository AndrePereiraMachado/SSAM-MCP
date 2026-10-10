import test from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {request,bridgeClient} from '../preview/engines/watcher/pipe.mjs';
import {createNativeCapture as createCapture,readJson,sha256} from '../preview/engines/watcher/adapters.mjs';
import {LivePipeline} from '../preview/engines/watcher/pipeline.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-preview-capture-')),checks=[];
const flush=()=>new Promise(setImmediate);
const createNativeCapture=(config,options)=>{const capture=createCapture(config,options);return ()=>capture({revision:'test:1'});};
class Socket extends EventEmitter {
 writes=[];destroyed=false;
 write(text){this.writes.push(text);}
 destroy(){this.destroyed=true;}
}
async function pipeError(action,options={}){
 const socket=new Socket();
 const promise=request('fake-pipe','snapshot Quotes',{connect:()=>socket,connectTimeoutMs:50,replyTimeoutMs:50,...options});
 const rejected=assert.rejects(promise,error=>{action.check?.(error);return true;});
 action.send(socket);await rejected;return socket;
}
await pipeError({send:s=>s.emit('error',Object.assign(new Error('missing'),{code:'ENOENT'})),check:e=>{assert.equal(e.command,'snapshot Quotes');assert.equal(e.phase,'connect');assert.equal(e.writeAttempted,false);}});
checks.push('Transport records exact command, pre-send phase and false writeAttempted');
{
 const socket=new Socket();
 await assert.rejects(request('fake','status',{connect:()=>socket,connectTimeoutMs:1}),e=>e.code==='PIPE_CONNECT'&&e.writeAttempted===false);
 socket.emit('connect');assert.equal(socket.writes.length,0);assert.equal(socket.destroyed,true);
 checks.push('Late connection after timeout never writes');
}
await pipeError({send:s=>{s.emit('connect');s.emit('error',Object.assign(new Error('reset'),{code:'ECONNRESET'}));},check:e=>{assert.equal(e.phase,'reply');assert.equal(e.writeAttempted,true);assert.equal(e.retryable,false);}});
await pipeError({send:s=>{s.emit('connect');s.emit('data',Buffer.from('bad json\n'));},check:e=>{assert.equal(e.phase,'decode');assert.equal(e.writeAttempted,true);}});
await pipeError({send:s=>s.emit('connect'),check:e=>{assert.equal(e.code,'PIPE_REPLY');assert.equal(e.writeAttempted,true);}},{replyTimeoutMs:1});
checks.push('Post-write error, invalid reply and reply timeout all retain uncertainty metadata');
{
 const socket=new Socket(),promise=request('fake','status',{connect:()=>socket});
 socket.emit('connect');socket.emit('data',Buffer.from('{"ok":true}\n'));
 assert.deepEqual((await promise).transport,{command:'status',phase:'response',writeAttempted:true});
 let active=0,max=0,calls=0;const pending=[];
 const bridge=bridgeClient(1,{requestImpl:async(_pipe,command)=>{active++;calls++;max=Math.max(max,active);await new Promise(resolve=>pending.push(resolve));active--;return {command};}});
 assert.throws(()=>bridge('exec anything'));assert.throws(()=>bridge('merge anything'));
 const a=bridge('status'),b=bridge('snapshot Quotes');await flush();assert.equal(calls,1);pending.shift()();await a;await flush();assert.equal(calls,2);pending.shift()();await b;assert.equal(max,1);
 checks.push('Bridge admits only status/snapshot and serializes commands; exec/merge are refused');
}
const target={pid:68544,module:'Quotes',moduleKey:'y4Yw60HbIUeAR7UbZXTVjA',host:'wrightflood.outsystems.dev',screenKey:'fixture',screenName:'Fixture'};
let caseNumber=0;
function fixture(){
 const root=path.join(out,String(++caseNumber)),snapshots=path.join(root,'platforms/odc/snapshots');fs.mkdirSync(snapshots,{recursive:true});
 const file=path.join(snapshots,'Quotes-fixture.oml');fs.writeFileSync(file,'synthetic bytes; not an OML');
 const capture={ok:true,module:target.module,moduleKey:target.moduleKey,host:target.host,path:file,sha256:sha256(fs.readFileSync(file)),capturedAt:new Date(2000).toISOString()};
 const config={target,workspace:root,outputRoot:path.join(root,'watcher')};
 const status={ok:true,pid:target.pid,bridge:'v36',root,busy:false,modules:[{key:target.moduleKey,name:target.module,host:target.host,loggedIn:true,mergePending:false}],dialogs:[],modalWindows:[]};
 const marker=()=>readJson(path.join(config.outputRoot,'capture-uncertainty.json'));
 return {config,status,capture,marker,writeReceipt:()=>fs.writeFileSync(file+'.json',JSON.stringify(capture))};
}
const unavailable=command=>Object.assign(new Error('not connected'),{code:'ENOENT',command,phase:'connect',writeAttempted:false,retryable:true});
{
 const f=fixture(),calls=[];let blocked=true;
 const capture=createNativeCapture(f.config,{now:()=>1000,bridge:async command=>{calls.push(command);if(command==='status'){if(blocked)throw unavailable(command);return f.status;}return f.capture;}});
 await assert.rejects(capture(),e=>e.captureDeferred&&e.writeAttempted===false&&e.command==='status');assert.deepEqual(calls,['status']);
 blocked=false;assert.equal((await capture()).sha256,f.capture.sha256);assert.equal(calls.filter(c=>c==='snapshot Quotes').length,1);
 checks.push('Status preconnect failure defers; recovery sends exactly one snapshot');
}
{
 const f=fixture(),calls=[];let busy=true;
 const capture=createNativeCapture(f.config,{now:()=>1000,bridge:async command=>{calls.push(command);return command==='status'?{...f.status,busy}:f.capture;}});
 for(let i=0;i<3;i++)await assert.rejects(capture(),e=>e.code==='STUDIO_BUSY'&&e.captureDeferred&&e.writeAttempted===false);
 assert.ok(calls.every(c=>c==='status'));busy=false;await capture();assert.equal(calls.filter(c=>c==='snapshot Quotes').length,1);
 checks.push('Busy status never dispatches snapshot before availability resumes');
}
{
 const f=fixture();let attempts=0,writes=0;
 const capture=createNativeCapture(f.config,{now:()=>1000,bridge:async command=>{if(command==='status')return f.status;if(++attempts===1)throw unavailable(command);writes++;return f.capture;}});
 await assert.rejects(capture(),e=>e.captureDeferred&&e.writeAttempted===false);assert.equal(f.marker().status,'not-sent');
 await capture();assert.equal(attempts,2);assert.equal(writes,1);assert.equal(f.marker().status,'captured');
 checks.push('Explicit snapshot pre-send failure clears intent and safely retries once');
}
{
 const f=fixture();
 const capture=createNativeCapture(f.config,{now:()=>1000,bridge:async command=>{if(command==='status')return f.status;throw Object.assign(unavailable(command),{code:'EACCES'});}});
 await assert.rejects(capture(),e=>e.code==='EACCES'&&e.retryable===false&&!e.reconciliationRequired);
 assert.equal(f.marker().status,'not-sent');
 checks.push('Definitive pre-send failure remains definitive without inventing snapshot uncertainty');
}
{
 const f=fixture();let snapshots=0;
 const capture=createNativeCapture(f.config,{now:()=>1000,bridge:async command=>{if(command==='status')return f.status;snapshots++;throw new Error('unknown transport state');}});
 await assert.rejects(capture(),e=>e.code==='CAPTURE_UNCERTAIN'&&e.writeAttempted===null);
 await assert.rejects(capture(),e=>e.code==='CAPTURE_RECONCILIATION_REQUIRED');assert.equal(snapshots,1);
 checks.push('Unknown send state remains uncertain and never becomes a pre-send retry');
}
{
 const f=fixture();let writes=0;
 const bridge=async command=>{if(command==='status')return f.status;writes++;throw Object.assign(new Error('reply lost'),{code:'PIPE_CLOSED',command,phase:'reply',writeAttempted:true});};
 const capture=createNativeCapture(f.config,{now:()=>1000,bridge});
 await assert.rejects(capture(),e=>e.code==='CAPTURE_UNCERTAIN'&&e.writeAttempted===true&&e.reconciliationRequired);
 await assert.rejects(capture(),e=>e.code==='CAPTURE_RECONCILIATION_REQUIRED');assert.equal(writes,1);
 const restarted=createNativeCapture(f.config,{now:()=>3000,bridge});
 await assert.rejects(restarted(),e=>e.code==='CAPTURE_RECONCILIATION_REQUIRED');assert.equal(writes,1);
 f.writeReceipt();assert.equal((await restarted()).sha256,f.capture.sha256);assert.equal(writes,1);assert.equal(f.marker().status,'reconciled');
 checks.push('Uncertain snapshot persists through restart and reconciles receipt without replay');
}
{
 const f=fixture();let revision=1,writes=0,clock=1000;
 const freshFile=path.join(path.dirname(f.capture.path),'Quotes-newer.oml');fs.writeFileSync(freshFile,'newer synthetic revision');
 const fresh={...f.capture,path:freshFile,sha256:sha256(fs.readFileSync(freshFile)),capturedAt:new Date(4000).toISOString()};
 const capture=createCapture(f.config,{now:()=>clock,bridge:async command=>{
  if(command==='status')return f.status;
  if(++writes===1){f.writeReceipt();throw Object.assign(new Error('lost first reply'),{command,phase:'reply',writeAttempted:true});}
  return fresh;
 }});
 const exported=[],adapter={readSignal:async()=>({ok:true,available:true,epoch:'test',revision,lastChangedAt:new Date(clock).toISOString(),...target}),capture,exportCapture:async c=>{exported.push(c);return {};},linkExport:async()=>({}),activate:async()=>{}};
 const pipeline=new LivePipeline({adapter,target,now:()=>clock,debounceMs:0});
 await pipeline.tick();await pipeline.idle();assert.equal(pipeline.state.status,'capture-reconciliation-required');assert.equal(writes,1);
 revision=2;clock=3000;await pipeline.tick();await pipeline.idle();
 assert.equal(writes,2);assert.equal(exported.length,1);assert.equal(exported[0].sha256,fresh.sha256);assert.equal(exported[0].captureRevision,'test:2');assert.equal(pipeline.state.exportedRevision,'test:2');
 assert.equal(f.marker().precedingReconciliation.observedRevision,'test:1');
 checks.push('Old reconciled bytes never represent a newer revision; resolved old intent precedes one distinct fresh capture');
}
{
 const f=fixture();let calls=0;
 const capture=createNativeCapture(f.config,{now:()=>1000,bridge:async command=>{calls++;return command==='status'?f.status:{ok:false,gate:'STUDIO_BUSY'};}});
 await assert.rejects(capture(),e=>e.code==='CAPTURE_UNCERTAIN'&&!e.captureDeferred);
 await assert.rejects(capture(),e=>e.code==='CAPTURE_RECONCILIATION_REQUIRED');assert.equal(calls,3);
 checks.push('Busy reply after snapshot dispatch does not become a pre-send deferral');
}
function scheduling(custom={}){
 let clock=0,revision=1,captures=0,exports=0,activations=0;
 const adapter={readSignal:async()=>({ok:true,available:true,epoch:'test',revision,lastChangedAt:new Date(clock).toISOString(),...target}),capture:async()=>{captures++;return custom.capture?custom.capture():{sha256:String(revision).repeat(64),capturedAt:new Date(clock).toISOString()};},exportCapture:async()=>{exports++;if(custom.exportCapture)return custom.exportCapture();return {};},linkExport:async()=>({}),activate:async()=>{activations++;}};
 const pipeline=new LivePipeline({adapter,target,now:()=>clock,debounceMs:0,captureRetryMs:750,captureFastWindowMs:2000,backoffMs:1000,maxBackoffMs:4000});
 return {pipeline,adapter,get captures(){return captures;},get exports(){return exports;},get activations(){return activations;},set revision(v){revision=v;},async at(t){clock=t;await pipeline.tick();await pipeline.idle();}};
}
{
 let busy=true;const f=scheduling({capture:async()=>{if(busy)throw Object.assign(new Error('busy'),{code:'STUDIO_BUSY',captureDeferred:true,writeAttempted:false,command:'status',phase:'status-preflight'});return {sha256:'a'.repeat(64),capturedAt:new Date(10000).toISOString()};}});
 await f.at(0);assert.equal(f.pipeline.state.status,'capture-deferred');assert.equal(f.pipeline.retryAt,750);
 await f.at(700);assert.equal(f.captures,1);f.revision=2;await f.at(701);assert.equal(f.pipeline.retryAt,750);
 await f.at(750);await f.at(1500);await f.at(2250);assert.equal(f.pipeline.state.retryDelayMs,1000);
 await f.at(3250);assert.equal(f.pipeline.state.retryDelayMs,2000);await f.at(5250);assert.equal(f.pipeline.state.retryDelayMs,4000);
 f.revision=3;await f.at(6000);assert.equal(f.pipeline.retryAt,9250);assert.equal(f.captures,6);
 busy=false;await f.at(9250);assert.equal(f.activations,1);assert.equal(f.pipeline.state.exportedRevision,'test:3');assert.equal(f.pipeline.captureDeferredSince,null);
 checks.push('Short capture retry window escalates to a cap; healthy signals/new revisions do not reset outage backoff');
}
{
 const f=scheduling({exportCapture:async()=>{throw Object.assign(new Error('temporary compiler error'),{retryable:true});}});
 await f.at(0);await f.at(10000);assert.equal(f.exports,1);assert.equal(f.pipeline.state.retryable,false);
 f.revision=2;await f.at(11000);assert.equal(f.exports,2);assert.equal(f.activations,0);
 checks.push('Compiler errors never retry automatically, even with retryable=true; a new revision is distinct work');
}
{
 const f=scheduling({capture:async()=>{throw Object.assign(new Error('lost'),{code:'CAPTURE_UNCERTAIN',command:'snapshot Quotes',phase:'reply',writeAttempted:true,reconciliationRequired:true});}});
 await f.at(0);await f.at(10000);assert.equal(f.captures,1);assert.equal(f.pipeline.state.status,'capture-reconciliation-required');
 checks.push('Uncertain snapshot blocks the revision instead of entering availability retry');
}
test("preview capture reconciliation and bounded retry regression checks",()=>{assert.ok(checks.length>10);fs.rmSync(out,{recursive:true,force:true});});
