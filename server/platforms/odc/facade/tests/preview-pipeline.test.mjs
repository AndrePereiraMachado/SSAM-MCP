import test from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LivePipeline} from '../preview/engines/watcher/pipeline.mjs';
const target={module:'Quotes',moduleKey:'y4Yw60HbIUeAR7UbZXTVjA',host:'wrightflood.outsystems.dev',pid:68544,screenKey:'test-native-key',screenName:'Test'};
const checks=[];
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function setup(custom={}) {
  let time=0,revision=1,captures=0,exports=0,links=0;const activated=[],states=[];
  const signal=()=>({ok:true,available:true,epoch:'test',revision,lastChangedAt:new Date(time).toISOString(),reason:'ModelChanged',...target});
  const capture=()=>({sha256:String(revision).repeat(64),capturedAt:new Date(time).toISOString()});
  const adapter={readSignal:async()=>signal(),capture:async()=>{captures++;return custom.capture?custom.capture(capture):capture();},exportCapture:async c=>{exports++;return custom.exportCapture?custom.exportCapture(c):{candidate:'candidate',ir:'raw-ir'};},linkExport:async x=>{links++;return custom.linkExport?custom.linkExport(x):{...x.exported,ir:'linked-ir',receipt:'link-receipt',acquisitionSha256:'linked-sha',linked:true};},activate:async x=>activated.push(x)};
  const pipeline=new LivePipeline({adapter,target,now:()=>time,debounceMs:100,backoffMs:200,maxBackoffMs:1000,onStatus:s=>states.push(s)});
  return {pipeline,adapter,states,activated,capture,get captures(){return captures;},get exports(){return exports;},get links(){return links;},set time(x){time=x;},set revision(x){revision=x;}};
}
{
  const f=setup();await f.pipeline.tick();f.time=50;f.revision=2;await f.pipeline.tick();f.time=100;f.revision=3;await f.pipeline.tick();f.time=199;await f.pipeline.tick();assert.equal(f.captures,0);
  f.time=200;await f.pipeline.tick();await f.pipeline.idle();assert.equal(f.captures,1);assert.equal(f.exports,1);assert.equal(f.links,1);assert.equal(f.activated[0].revision,'test:3');assert.equal(f.activated[0].exported.ir,'linked-ir');assert.equal(f.pipeline.state.lastLinkedSha256,'linked-sha');assert.equal(f.pipeline.state.stale,false);
  checks.push('Rapid native revisions coalesce into one capture after quiet; only linked newest revision activates');
}
{
  const gate=deferred();let first=true;const f=setup({capture:async capture=>{const result=capture();if(first){first=false;await gate.promise;}return result;}});
  await f.pipeline.tick();f.time=100;await f.pipeline.tick();assert.equal(f.captures,1);f.revision=2;f.time=200;await f.pipeline.tick();f.time=400;await f.pipeline.tick();assert.equal(f.captures,1);
  gate.resolve();await f.pipeline.idle();assert.equal(f.exports,0);assert.equal(f.activated.length,0);await f.pipeline.tick();await f.pipeline.idle();assert.equal(f.captures,2);assert.equal(f.activated[0].revision,'test:2');
  checks.push('Capture is singleflight; a revision arriving during capture discards old work before export');
}
{
  const gate=deferred();const f=setup({exportCapture:async()=>{await gate.promise;return {ir:'old'};}});
  await f.pipeline.tick();f.time=100;await f.pipeline.tick();await new Promise(setImmediate);f.revision=2;f.time=200;await f.pipeline.tick();gate.resolve();await f.pipeline.idle();assert.equal(f.activated.length,0);assert.equal(f.pipeline.state.stale,true);
  assert.equal(f.links,0);checks.push('A revision arriving during export prevents stale linkage and selection activation');
}
{
  let fail=true;const f=setup({capture:async capture=>{if(fail){fail=false;throw Object.assign(new Error('busy'),{code:'STUDIO_BUSY',retryable:true,captureDeferred:true,writeAttempted:false});}return capture();}});
  await f.pipeline.tick();f.time=100;await f.pipeline.tick();await f.pipeline.idle();f.time=849;await f.pipeline.tick();assert.equal(f.captures,1);f.time=850;await f.pipeline.tick();await f.pipeline.idle();assert.equal(f.captures,2);assert.equal(f.activated.length,1);
  checks.push('Busy Studio produces a bounded backoff, not repeated immediate capture requests');
}
{
  const f=setup({exportCapture:async()=>{throw Object.assign(new Error('unsupported expression'),{code:'UNSUPPORTED_EXPRESSION'});}});
  await f.pipeline.tick();f.time=100;await f.pipeline.tick();await f.pipeline.idle();f.time=10000;await f.pipeline.tick();assert.equal(f.exports,1);assert.equal(f.pipeline.state.error.origin,'export');f.revision=2;await f.pipeline.tick();f.time=10100;await f.pipeline.tick();await f.pipeline.idle();assert.equal(f.exports,2);assert.equal(f.activated.length,0);
  checks.push('Deterministic export failure preserves last selection and waits for another native revision');
}
{
  const f=setup({capture:async()=>({sha256:'a'.repeat(64),capturedAt:new Date().toISOString()})});
  await f.pipeline.tick();f.time=100;await f.pipeline.tick();await f.pipeline.idle();f.revision=2;f.time=200;await f.pipeline.tick();f.time=300;await f.pipeline.tick();await f.pipeline.idle();assert.equal(f.captures,2);assert.equal(f.exports,1);assert.equal(f.activated.length,1);assert.equal(f.pipeline.state.stale,false);
  checks.push('Unchanged snapshot bytes are acknowledged without redundant export or browser activation');
}
{
  const gate=deferred();let first=true;const f=setup({linkExport:async({exported})=>{if(first){first=false;await gate.promise;}return {...exported,ir:'linked-newest',linked:true};}});
  await f.pipeline.tick();f.time=100;await f.pipeline.tick();await new Promise(setImmediate);assert.equal(f.links,1);assert.equal(f.pipeline.state.status,'linking');
  f.revision=2;f.time=200;await f.pipeline.tick();f.time=500;await f.pipeline.tick();assert.equal(f.captures,1);
  gate.resolve();await f.pipeline.idle();assert.equal(f.activated.length,0);assert.equal(f.pipeline.state.discardedRevision,'test:1');
  await f.pipeline.tick();await f.pipeline.idle();assert.equal(f.activated.length,1);assert.equal(f.activated[0].revision,'test:2');assert.equal(f.links,2);
  checks.push('Link stage remains singleflight and drops a result when native revision advances before activation');
}
{
  let fail=false;const f=setup({linkExport:async({exported})=>{if(fail)throw Object.assign(new Error('Producer revision differs'),{code:'PRODUCER_REVISION_MISMATCH'});return {...exported,ir:'verified-link',linked:true};}});
  await f.pipeline.tick();f.time=100;await f.pipeline.tick();await f.pipeline.idle();assert.equal(f.activated.length,1);
  fail=true;f.revision=2;f.time=200;await f.pipeline.tick();f.time=300;await f.pipeline.tick();await f.pipeline.idle();assert.equal(f.pipeline.state.error.origin,'link');assert.equal(f.activated.length,1);assert.equal(f.pipeline.state.stale,true);
  f.time=10000;await f.pipeline.tick();assert.equal(f.links,2);f.revision=3;await f.pipeline.tick();f.time=10100;await f.pipeline.tick();await f.pipeline.idle();assert.equal(f.links,3);assert.equal(f.activated.length,1);
  checks.push('Deterministic link failure retains the previous selection and blocks replay until another native revision');
}
{
  const gate=deferred();const f=setup({linkExport:async({exported})=>{await gate.promise;return {...exported,linked:true};}});
  await f.pipeline.tick();f.time=100;await f.pipeline.tick();await new Promise(setImmediate);const stopped=f.pipeline.stop();gate.resolve();await stopped;assert.equal(f.links,1);assert.equal(f.activated.length,0);assert.equal(f.pipeline.state.running,false);
  checks.push('Stopping during offline linking drains the work and does not activate its output');
}
{
  const f=setup();f.adapter.readSignal=async()=>({ok:true,available:true,epoch:'test',revision:1,...target,moduleKey:'different'});await f.pipeline.tick();assert.equal(f.captures,0);assert.equal(f.pipeline.state.error.code,'OBSERVER_TARGET');
  checks.push('Signal identity mismatch cannot redirect capture to another app');
}
{
  const gate=deferred();const f=setup({capture:async capture=>{await gate.promise;return capture();}});await f.pipeline.tick();f.time=100;await f.pipeline.tick();const stopped=f.pipeline.stop();gate.resolve();await stopped;assert.equal(f.exports,0);assert.equal(f.activated.length,0);assert.equal(f.pipeline.state.running,false);
  checks.push('Stopping drains the current read without launching export or activating a later result');
}
{
  const f=setup();await f.pipeline.tick();f.time=100;await f.pipeline.tick();await f.pipeline.idle();const read=f.adapter.readSignal;
  f.adapter.readSignal=async()=>{throw new Error('Transient observer timeout');};await f.pipeline.tick();assert.equal(f.pipeline.state.error.origin,'observer');
  f.adapter.readSignal=read;await f.pipeline.tick();assert.equal(f.pipeline.state.observedRevision,'test:1');assert.equal(f.pipeline.state.status,'watching');assert.equal(f.pipeline.state.stale,false);assert.equal(f.pipeline.state.error,null);assert.equal(f.captures,1);
  checks.push('Observer read recovery on the same revision restores prior watching/fresh status without recapture');
}
{
  for(const stage of ['capture','link']){
    const failure=async()=>{throw Object.assign(new Error(stage+' failed'),{code:stage.toUpperCase()+'_FAILED'});};
    const f=setup(stage==='capture'?{capture:failure}:{linkExport:failure});await f.pipeline.tick();f.time=100;await f.pipeline.tick();await f.pipeline.idle();const previous={...f.pipeline.state.error},read=f.adapter.readSignal;
    f.adapter.readSignal=async()=>{throw new Error('Transient observer timeout');};await f.pipeline.tick();assert.equal(f.pipeline.state.error.origin,'observer');
    f.adapter.readSignal=read;await f.pipeline.tick();assert.equal(f.pipeline.state.status,'error');assert.equal(f.pipeline.state.stale,true);assert.deepEqual(f.pipeline.state.error,previous);assert.equal(f.pipeline.blocked,'test:1');
    f.adapter.readSignal=async()=>{throw new Error('Again');};await f.pipeline.tick();f.pipeline.publish({status:'error',error:{code:'NEW_LINK_FAILURE',message:'new failure',origin:'link'}});f.adapter.readSignal=read;await f.pipeline.tick();assert.equal(f.pipeline.state.error.code,'NEW_LINK_FAILURE');
  }
  checks.push('Observer recovery preserves previous capture/link failures and never replaces a newer pipeline failure');
}
test("preview pipeline scheduling regression checks",()=>assert.equal(checks.length>10,true));
