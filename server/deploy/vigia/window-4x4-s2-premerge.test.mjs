// Pre-merge safety (S2 R8): S1+S2 merged into main BEFORE the S1 kit migrates production from the pair window (committed
// versions.json, pair mode) to backends. The production watcher plans every automatic round from the LIVE baseline (vigia.mjs
// round: manifest = live.manifest), so pair-mode production runs the pair flow: an idle round does nothing, a new Studio
// starts a pair round (o11-<o>-odc-<v>), never a backend-window round, retirement, kernel-only prepare or window compose. A
// backend window that reaches the window rounds while production still runs pairs waits (WINDOW_MIGRATION_PENDING).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateCompose,isBackendManifest} from '../coolify/gen-compose.mjs';
import {liveBaseline} from './safety.mjs';
import {runVigia} from './pipeline.mjs';
import {runWindowVigia} from './window-round.mjs';
import {fromPairs} from './window.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'s2-premerge-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const pairs=JSON.parse(fs.readFileSync(path.join(here,'../coolify/versions.json'),'utf8'));
// Pair-mode production as the remote snapshot shows it (r45: five pairs of the committed versions.json).
function pairProduction(){
 const compose=generateCompose(pairs),services=Object.values(compose.services).filter(s=>s.labels?.['ssam.backend']==='true');
 const backends=services.map(s=>{const odc=s.labels['ssam.odc'],o11=s.labels['ssam.o11'],e=pairs.odc.find(x=>x.version===odc);
  return {odc,o11,reference:s.image,digest:'sha256:'+String(e.sha256).replace(/^sha256:/,''),kernel:{odc,o11,odcBridge:'v109'},kernels:null};});
 return liveBaseline({compose:JSON.stringify(compose),hash:'pairs',backends,telemetry:{tokens:{}},usage:null});
}
// Operations that record every call and refuse all but notices: a round that reaches anything else stops there.
function guardedOps(){
 const calls=[],allowed=new Set(['log','notify','event','secrets']);
 const ops=new Proxy({},{get:(_,name)=>{if(typeof name!=='string'||name==='then')return undefined;return async(...args)=>{calls.push(name);if(allowed.has(name))return name==='secrets'?{}:name==='event'?{remote:true}:undefined;throw Object.assign(Error('stop: '+name),{environmental:true});};}});
 return {ops,calls};
}
const WINDOW_OPS=['prepare','writeCompose','deploy','composeFor','pinExecution','publish','buildBackend','restoreCompose'];

test('pre-merge: pair-mode production reads back as a window of pairs; the round never takes the backend-window flow',()=>{
 const live=pairProduction();
 assert.equal(isBackendManifest(live.manifest),false);
 assert.deepEqual(live.manifest.odc.map(e=>e.version).sort(),pairs.odc.map(e=>e.version).sort());
});

test('pre-merge (1): an idle round on pair-mode production is a no-op',async t=>{
 const out=tmp(t),live=pairProduction(),{ops,calls}=guardedOps();
 const observed=[{lane:'odc',version:'1.7.32',fullVersion:'1.7.32.1',tfm:'net10.0'},{lane:'o11',version:'11.55.95',fullVersion:'11.55.95.1',tfm:'net10.0'}];
 const r=await runVigia({automatic:true,outDir:out,manifest:live.manifest,liveBaseline:live,state:{},observed,head:'h',now:Date.parse('2026-11-10T12:00:00Z')},ops);
 assert.equal(r.status,'idle',JSON.stringify(r));
 assert.deepEqual(calls.filter(c=>!['log','notify'].includes(c)),[]);
 assert.deepEqual(fs.readdirSync(out).filter(n=>/^(?:odc|o11|retire)-/.test(n)),[]);
});

test('pre-merge (2): a new ODC or O11 Studio on pair-mode production starts a PAIR round, never a window round',async t=>{
 const live=pairProduction();
 for(const [lane,version,id] of [['o11','11.55.96',/^o11-11\.55\.96-odc-\d+\.\d+\.\d+$/],['odc','1.7.33',/^o11-\d+\.\d+\.\d+-odc-1\.7\.33$/]]){
  const observed=[{lane,version,fullVersion:version+'.1',tfm:'net10.0',url:'https://example.test/'+version}];
  const dry=await runVigia({automatic:true,outDir:tmp(t),manifest:live.manifest,liveBaseline:live,state:{},observed,head:'h',dryRun:true},guardedOps().ops);
  assert.equal(dry.status,'dry-run');assert.match(String(dry.decision.pair),id,JSON.stringify(dry.decision));
  assert.equal(dry.decision.round,undefined,'not the window dry run');
  // The real round: the pair flow starts (its folder is the pair's) and stops at the first guarded operation; no window
  // operation, kernel-only prepare, retirement or compose write is ever reached.
  const out=tmp(t),{ops,calls}=guardedOps();
  const r=await runVigia({automatic:true,outDir:out,manifest:live.manifest,liveBaseline:live,state:{},observed,head:'h'},ops).catch(e=>({error:e.message}));
  if(process.env.PREMERGE_TRACE)console.log(lane,JSON.stringify(r).slice(0,200),calls.join(','),fs.readdirSync(out).join(','));
  assert.deepEqual(calls.filter(c=>WINDOW_OPS.includes(c)),[]);
  assert.deepEqual(fs.readdirSync(out).filter(n=>/^(?:odc|o11)-\d+\.\d+\.\d+$|^retire-/.test(n)),[],'no window round folder');
  assert.ok(fs.readdirSync(out).every(n=>!/^(?:odc|o11)-/.test(n)||id.test(n)));
 }
});

test('pre-merge guard: a backend window that reaches the window rounds while production runs pairs waits, told, and touches nothing',async t=>{
 const out=tmp(t),live=pairProduction(),{ops,calls}=guardedOps();
 const images=Object.fromEntries(pairs.odc.map((e,i)=>[e.version,{image:e.image,tag:e.tag,sha256:e.sha256}]));
 const window=fromPairs(pairs,{now:Date.parse('2026-11-09T12:00:00Z'),images}).manifest;
 const r=await runWindowVigia({automatic:true,outDir:out,manifest:window,liveBaseline:live,state:{},observed:[{lane:'o11',version:'11.55.96',fullVersion:'11.55.96.1',tfm:'net10.0'}],head:'h',now:Date.parse('2026-11-20T12:00:00Z')},ops);
 assert.deepEqual(r,{status:'waiting',code:'WINDOW_MIGRATION_PENDING'});
 assert.deepEqual(calls.filter(c=>c!=='log'),['notify'],'only the owner notice');
 assert.deepEqual(fs.readdirSync(out).filter(n=>n!=='reminders.json'),[]);
});
