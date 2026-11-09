// Window 4x4, S2 (C:\t\r5\janela-4x4\DESENHO.md 2, 5.3, 7): the vigia keeps a window per lane. Rotation with a retiring
// grace, the compose-only retirement, the first S1 deploy as a rotation, the safety rules of a backend window, the per-ODC
// usage, the lane rounds (retirement first, ODC before O11, a lane waiting for the owner lets the other go), the reference-app
// gate failing closed, and the automatic release of an ODC round, an O11 round and a retirement on fake operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fromPairs,rotateLane,retireDue,dueRetirement,pinDigests,defaultO11,windowPolicy,affectedBy,backendTag,kernelSetHash,ROUND_ID,servedOf} from './window.mjs';
import {servedLists,retiringOf,versionBackends,generateCompose} from '../coolify/gen-compose.mjs';
import {servedTransition,assertRetained,assertLaneUnserved,preserveCompose} from './safety.mjs';
import {decideWindow,referenceGate,windowNotices,affectedRecord,liveDefaultO11,runWindowAttempt} from './window-round.mjs';
import {releaseAutomatically,windowPinned,windowAgain} from './automatic.mjs';
import {pinnedProjection,expectedServedOf,backendCompose,releaseBundles} from './auto-runtime.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'s2-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const NOW=Date.parse('2026-11-09T12:00:00Z'),DAY=86400000;
const sha=c=>c.repeat(64);
const pairs=JSON.parse(fs.readFileSync(path.join(here,'../coolify/versions.json'),'utf8'));
const images=Object.fromEntries(pairs.odc.map(e=>[e.version,{image:e.image,tag:e.tag,sha256:e.sha256}]));
const tokens={t1:{customer:'Acme',seen:'2026-11-08T10:00:00Z',odc:{installed:'1.7.28.100'},o11:{installed:'11.55.92.1'}},t2:{customer:'Beta',seen:'2026-11-08T10:00:00Z',odc:{installed:'1.7.29.1'},o11:{installed:'11.55.95.1'}},v:{customer:'Version verification',verification:true,odc:{installed:'1.7.28.1'}}};
const first=()=>fromPairs(pairs,{now:NOW,images,tokens});

test('the first S1 deploy keeps ODC 1.7.28 in a 7-day grace instead of cutting it (fromPairs on the committed versions.json)',()=>{
 const r=first();
 assert.deepEqual(r.manifest.backends.map(b=>b.odc),['1.7.32','1.7.31','1.7.30','1.7.29','1.7.28']);
 assert.deepEqual(r.manifest.o11.served,['11.55.92','11.55.93','11.55.94','11.55.95']);
 assert.deepEqual(r.manifest.retiring,{odc:{version:'1.7.28',retireAt:new Date(NOW+7*DAY).toISOString()}});
 assert.deepEqual(r.retired,[]);
 assert.deepEqual(r.affected.map(a=>[a.customer,a.version]),[['Acme','1.7.28']]);
 // Usage is per ODC backend now; every backend keeps its pinned digest.
 assert.ok(Object.keys(r.manifest.sizing.usage).every(k=>/^odc-\d+\.\d+\.\d+$/.test(k)));
 assert.ok(r.manifest.backends.every(b=>/^[a-f0-9]{64}$/.test(String(b.sha256).replace(/^sha256:/,''))));
 const served=JSON.parse(servedLists(r.manifest)[0]);
 assert.deepEqual(served.retiring,{odc:{version:'1.7.28',retireAt:new Date(NOW+7*DAY).toISOString()}});
 assert.equal(new Set(servedLists(r.manifest)).size,1);
});

test('an ODC round adds one backend; the earlier retiring version leaves early and the oldest kept one enters its grace',()=>{
 const r=rotateLane(first().manifest,'odc','1.7.33',{now:NOW+DAY,images:{image:'img',tag:'t33'},tokens});
 assert.deepEqual(r.manifest.backends.map(b=>b.odc),['1.7.33','1.7.32','1.7.31','1.7.30','1.7.29']);
 assert.deepEqual(r.retired,[{lane:'odc',version:'1.7.28',retireAt:new Date(NOW+7*DAY).toISOString(),early:true}]);
 assert.deepEqual(r.retiring,[{lane:'odc',version:'1.7.29',retireAt:new Date(NOW+8*DAY).toISOString()}]);
 assert.deepEqual(r.affected.map(a=>[a.customer,a.version]).sort(),[['Acme','1.7.28'],['Beta','1.7.29']]);
 assert.equal(r.manifest.backends[0].sha256,undefined);
 assert.equal(r.manifest.backends[1].sha256,first().manifest.backends[0].sha256);
 assert.throws(()=>rotateLane(r.manifest,'odc','1.7.33',{images:{image:'i',tag:'t'}}),e=>e.code==='ALREADY_SERVED');
 assert.throws(()=>rotateLane(r.manifest,'odc','1.7.20',{images:{image:'i',tag:'t'}}),/only moves forward/);
});

test('an O11 round rebuilds every backend image with the new kernel set; the oldest O11 enters its grace',()=>{
 const base=first().manifest,built=Object.fromEntries(base.backends.map(b=>[b.odc,{image:'img',tag:'k-'+b.odc.replaceAll('.','')}]));
 const r=rotateLane(base,'o11','11.55.96',{now:NOW,images:built,tokens});
 assert.deepEqual(r.manifest.o11.served,['11.55.92','11.55.93','11.55.94','11.55.95','11.55.96']);
 assert.deepEqual(r.manifest.retiring.o11,{version:'11.55.92',retireAt:new Date(NOW+7*DAY).toISOString()});
 assert.ok(r.manifest.backends.every(b=>b.tag.startsWith('k-')&&b.sha256===undefined));
 assert.deepEqual(r.affected.map(a=>[a.customer,a.lane,a.version]),[['Acme','o11','11.55.92']]);
 const missing={...built};delete missing['1.7.30'];
 assert.throws(()=>rotateLane(base,'o11','11.55.96',{images:missing}),/rebuilt image of backend odc-1\.7\.30/);
 // Every image must be pinned before a deploy.
 assert.throws(()=>pinDigests(r.manifest,{'k-1732':'sha256:'+sha('a')}),/no pinned digest/);
 const pinned=pinDigests(r.manifest,Object.fromEntries(r.manifest.backends.map(b=>[b.tag,'sha256:'+sha('b')])));
 assert.ok(pinned.backends.every(b=>b.sha256===sha('b')));
});

test('a due retirement is compose-only; an O11 retirement keeps its kernel in the images until the next O11 rebuild',()=>{
 const m=first().manifest;
 assert.equal(dueRetirement(m,NOW+6*DAY),null);
 assert.equal(retireDue(m,{now:NOW+6*DAY}),null);
 const r=retireDue(m,{now:NOW+7*DAY,tokens});
 assert.deepEqual(r.manifest.backends.map(b=>b.odc),['1.7.32','1.7.31','1.7.30','1.7.29']);
 assert.equal(r.manifest.retiring,undefined);
 assert.deepEqual(r.retired.map(x=>x.version),['1.7.28']);
 for(const b of r.manifest.backends)assert.deepEqual(b,m.backends.find(x=>x.odc===b.odc));
 const o=rotateLane(m,'o11','11.55.96',{now:NOW,images:Object.fromEntries(m.backends.map(b=>[b.odc,{image:'i',tag:'t'+b.odc.replaceAll('.','')}]))}).manifest;
 const ro=retireDue(retireDue(o,{now:NOW+7*DAY}).manifest,{now:NOW+7*DAY});
 assert.deepEqual(ro.manifest.o11,{served:['11.55.93','11.55.94','11.55.95','11.55.96'],kernels:['11.55.92','11.55.93','11.55.94','11.55.95','11.55.96']});
 // A new ODC backend after it is built with the served kernels only.
 const n=rotateLane(ro.manifest,'odc','1.7.33',{now:NOW+8*DAY,images:{image:'i',tag:'t33'}}).manifest;
 assert.deepEqual(n.backends[0].o11Kernels,['11.55.93','11.55.94','11.55.95','11.55.96']);
 versionBackends(n);
});

test('the default O11 kernel is never the retiring one; an O11 round moves it to the newest live one',()=>{
 const m=first().manifest;
 assert.equal(defaultO11(m,{lane:'odc',liveDefault:'11.55.95'}),'11.55.95');
 assert.equal(defaultO11(m,{lane:'odc',liveDefault:'11.55.80'}),'11.55.95');
 assert.equal(defaultO11(m,{lane:'o11',liveDefault:'11.55.93'}),'11.55.95');
 assert.equal(liveDefaultO11({kernels:{'odc-1.7.32':{o11:'11.55.95'},'odc-1.7.31':{o11:'11.55.95'}}}),'11.55.95');
 assert.equal(liveDefaultO11({kernels:{a:{o11:'11.55.95'},b:{o11:'11.55.94'}}}),null);
});

test('window policy, tags and round ids',()=>{
 assert.deepEqual(windowPolicy({}),{keep:{odc:4,o11:4},graceDays:7,notifyAffected:true});
 assert.throws(()=>windowPolicy({window:{keep:{odc:0}}}),/keep\.odc/);
 assert.throws(()=>windowPolicy({window:{graceDays:-1}}),/graceDays/);
 assert.throws(()=>windowPolicy({window:{maxWindow:5}}),/Invalid window/);
 assert.equal(kernelSetHash(['11.55.95','11.55.92']),kernelSetHash(['11.55.92','11.55.95']));
 assert.match(backendTag({odc:'1.7.33',kernels:['11.55.95']},'abc1234','20261109'),/^prod-20261109-abc1234-odc1733-o11k[a-f0-9]{8}$/);
 for(const id of ['odc-1.7.33','o11-11.55.96','retire-odc-1.7.28','retire-o11-11.55.92','o11-11.55.95-odc-1.7.32'])assert.ok(ROUND_ID.test(id),id);
 assert.ok(!ROUND_ID.test('retire-x-1.2.3'));
 assert.deepEqual(affectedBy(tokens,[{lane:'odc',version:'1.7.28'}]).map(a=>a.customer),['Acme']);
 assert.ok(affectedRecord(affectedBy(tokens,[{lane:'odc',version:'1.7.28'}])).every(a=>!('token' in a)&&/^[a-f0-9]{12}$/.test(a.client)));
});

test('gen-compose: the retiring version must be the oldest served of its lane, with an ISO date',()=>{
 const m=first().manifest;
 assert.throws(()=>retiringOf({...m,retiring:{odc:{version:'1.7.30',retireAt:'2026-11-16T12:00:00.000Z'}}},versionBackends(m)));
 assert.throws(()=>retiringOf({...m,retiring:{odc:{version:'1.7.28',retireAt:'next week'}}},versionBackends(m)));
 assert.throws(()=>retiringOf({...m,retiring:{odc:{version:'1.7.99',retireAt:'2026-11-16T12:00:00.000Z'}}},versionBackends(m)));
 const c=generateCompose(m);
 assert.equal(Object.keys(c.services).filter(n=>/^ssam-server-v\d+$/.test(n)).length,5);
});

test('safety: the served list moves only by the round\'s own versions; retained images stay unless an O11 round pinned them',()=>{
 const live=JSON.stringify({odc:['1.7.32','1.7.28'],o11:['11.55.95']});
 assert.ok(servedTransition(live,JSON.stringify({odc:['1.7.33','1.7.32','1.7.28'],o11:['11.55.95']}),{added:[{lane:'odc',version:'1.7.33'}]}));
 assert.ok(servedTransition(live,JSON.stringify({odc:['1.7.32'],o11:['11.55.95']}),{retired:[{lane:'odc',version:'1.7.28'}]}));
 assert.ok(!servedTransition(live,JSON.stringify({odc:['1.7.32'],o11:['11.55.95']}),{}));
 assert.ok(!servedTransition(live,JSON.stringify({odc:['1.7.32','1.7.28'],o11:['11.55.95','11.55.96']}),{added:[{lane:'odc',version:'1.7.33'}]}));
 const m=first().manifest,baseline={manifest:m};
 assertLaneUnserved(baseline,'odc','1.7.33');
 assert.throws(()=>assertLaneUnserved(baseline,'o11','11.55.95'),e=>e.code==='ALREADY_SERVED');
 const odc=rotateLane(m,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t33'}}).manifest;
 assertRetained(baseline,pinDigests(odc,{t33:'sha256:'+sha('c')}),{lane:'odc',built:{t33:sha('c')}});
 const swapped=structuredClone(odc);swapped.backends[1].tag='other';
 assert.throws(()=>assertRetained(baseline,pinDigests(swapped,{t33:'sha256:'+sha('c'),other:'sha256:'+sha('d')}),{lane:'odc',built:{t33:sha('c')}}),e=>e.code==='LIVE_DOWNGRADE');
 const built=Object.fromEntries(m.backends.map(b=>[b.odc,{image:'img',tag:'k'+b.odc.replaceAll('.','')}]));
 const o11=rotateLane(m,'o11','11.55.96',{now:NOW,images:built}).manifest,digests=Object.fromEntries(o11.backends.map(b=>[b.tag,'sha256:'+sha('e')]));
 assertRetained(baseline,pinDigests(o11,digests),{lane:'o11',built:Object.fromEntries(o11.backends.map(b=>[b.tag,sha('e')]))});
 assert.throws(()=>assertRetained(baseline,pinDigests(o11,digests),{lane:'o11',built:{}}),e=>e.code==='LIVE_DOWNGRADE');
});

test('usage-count keys the counts by ODC backend inside a backend window',t=>{
 const root=tmp(t),day='20261109',write=(dir,quality,state)=>{fs.mkdirSync(path.join(root,'versions',dir,'state'),{recursive:true});fs.writeFileSync(path.join(root,'versions',dir,`quality-${day}.jsonl`),quality);fs.writeFileSync(path.join(root,'versions',dir,'state','studio-versions.json'),JSON.stringify(state));};
 const call=JSON.stringify({kind:'call',tool:'studio_deliver',time:'2026-11-09T10:00:00Z'})+'\n';
 write('odc-1.7.32',call+call,{tokens:{a:{seen:'2026-11-09T09:00:00Z'}}});
 write('o11-11.55.95-odc-1.7.32',call,{tokens:{a:{seen:'2026-11-08T09:00:00Z'},b:{seen:'2026-11-09T08:00:00Z'}}});
 write('odc-1.7.28','',{tokens:{c:{seen:'2026-11-09T08:00:00Z',revoked:true}}});
 const run=name=>JSON.parse(spawnSync(process.execPath,[path.join(here,'usage-count.cjs')],{env:{...process.env,SSAM_USAGE_ROOT:root,SSAM_USAGE_NOW:String(NOW),SSAM_BACKEND_NAME:name},encoding:'utf8'}).stdout);
 assert.deepEqual(run('odc-1.7.32').pairs,{'odc-1.7.28':{heavy:0,active:0},'odc-1.7.32':{heavy:3,active:2}});
 assert.deepEqual(Object.keys(run('o11-11.55.95-odc-1.7.32').pairs),['o11-11.55.95-odc-1.7.32']);
});

test('lane rounds: a due retirement first, then ODC before O11; a lane waiting for the owner lets the other go',()=>{
 const m=first().manifest,inputs=r=>({head:'h',studios:{[r.lane]:r.candidate.fullVersion}});
 const observed=[{lane:'odc',version:'1.7.33',fullVersion:'1.7.33.1'},{lane:'o11',version:'11.55.96',fullVersion:'11.55.96.1'}];
 const d=(now,attempts={})=>decideWindow({manifest:m,observed,state:{},attempts,inputs,now});
 assert.equal(d(NOW).id,'odc-1.7.33');
 assert.equal(d(NOW+7*DAY).id,'retire-odc-1.7.28');
 assert.equal(d(NOW+7*DAY,{'retire-odc-1.7.28':{status:'approved',inputs:{retireAt:m.retiring.odc.retireAt},at:new Date(NOW).toISOString()}}).id,'odc-1.7.33');
 const waiting={'odc-1.7.33':{status:'deferred',code:'reference-gate-unconfigured',at:new Date(NOW).toISOString(),inputs:{head:'h',studios:{odc:'1.7.33.1'}}}};
 const next=d(NOW+3600000,waiting);
 assert.equal(next.id,'o11-11.55.96');
 assert.deepEqual(next.skipped.map(s=>[s.id,s.why]),[['odc-1.7.33','deferred']]);
 // With nothing else to run, the waiting round is checked again.
 assert.equal(decideWindow({manifest:m,observed:observed.slice(0,1),state:{},attempts:waiting,inputs,now:NOW+3600000}).id,'odc-1.7.33');
 const failed={'odc-1.7.33':{status:'failed',at:new Date(NOW).toISOString(),inputs:{head:'h',studios:{odc:'1.7.33.1'}}}};
 assert.equal(decideWindow({manifest:m,observed:observed.slice(0,1),state:{},attempts:failed,inputs,now:NOW+3600000}).action,'failed');
});

test('the reference-app gate: owner by default, command fails closed without its runner, rehearsal records only, both apps needed',async t=>{
 const dir=tmp(t),args={lane:'odc',version:'1.7.33',manifest:{},builts:[],dir};
 assert.deepEqual(await referenceGate({},{},args),{mode:'owner',ran:false,waitOwner:true,lane:'odc',version:'1.7.33',apps:['FolhaPonto','VisitaCerta']});
 assert.equal((await referenceGate({referenceGate:{mode:'owner'}},{},args)).waitOwner,true);
 await assert.rejects(referenceGate({referenceGate:{mode:'command'}},{referenceGate:async()=>({})},args),e=>e.environmental&&e.code==='reference-gate-unconfigured');
 await assert.rejects(referenceGate({referenceGate:{mode:'command',command:'x'}},{},args),e=>e.environmental&&e.code==='reference-gate-unconfigured');
 await assert.rejects(referenceGate({referenceGate:{mode:'manual'}},{},args),e=>e.code==='REFERENCE_GATE_INVALID');
 const rehearsed=await referenceGate({rehearsal:{}},{},args);assert.equal(rehearsed.ran,false);assert.equal(rehearsed.waitOwner,undefined);
 const cfg={referenceGate:{mode:'command',command:'x'}};
 await assert.rejects(referenceGate(cfg,{referenceGate:async()=>({ok:true,apps:[{name:'FolhaPonto',published:true}]})},args),e=>e.code==='reference-gate-failed');
 await assert.rejects(referenceGate(cfg,{referenceGate:async()=>({ok:false,environmental:true,error:'no result'})},args),e=>e.environmental);
 const ok=await referenceGate(cfg,{referenceGate:async()=>({ok:true,apps:[{name:'FolhaPonto',published:true,seconds:300},{name:'VisitaCerta',published:true,seconds:410}]})},args);
 assert.equal(ok.ok,true);
 assert.ok(fs.existsSync(path.join(dir,'reference-gate.json')));
});

test('owner notices: window-retiring and window-retired name the customers seen on those versions',()=>{
 const r=rotateLane(first().manifest,'odc','1.7.33',{now:NOW,images:{image:'i',tag:'t'},tokens});
 const notes=windowNotices({retiring:r.retiring,retired:r.retired,affected:affectedRecord(r.affected)});
 assert.deepEqual(notes.map(n=>n.code),['WINDOW_RETIRING','WINDOW_RETIRED']);
 assert.match(notes[0].message,/ODC Studio 1\.7\.29 leaves SSAM on \d{4}-\d{2}-\d{2} \(customers: Beta/);
 assert.match(notes[1].message,/ODC Studio 1\.7\.28 left SSAM before its date.*Acme/);
 assert.match(windowNotices({retiring:r.retiring,retired:[],affected:affectedRecord(r.affected),notifyAffected:false})[0].message,/1 customer seen on it/);
});

test('remote projections: pinned per backend, expected served lists by labels, one backend\'s compose',()=>{
 const m=first().manifest,p=pinnedProjection(m);
 assert.equal(p.odc.length,5);assert.equal(p.o11[0].version,'11.55.92,11.55.93,11.55.94,11.55.95');
 const e=expectedServedOf(m);
 assert.deepEqual(Object.keys(e).sort(),m.backends.map(b=>'11.55.92,11.55.93,11.55.94,11.55.95|'+b.odc).sort());
 const c=backendCompose('# header\n'+JSON.stringify(generateCompose(m)),'odc-1.7.30');
 assert.equal(c.services['ssam-server-v1'].environment.SSAM_BACKEND_NAME,'odc-1.7.30');
 assert.throws(()=>backendCompose(JSON.stringify(generateCompose(m)),'odc-9.9.9'),/no backend/);
 assert.equal(releaseBundles({candidate:{lane:'o11',version:'11.55.96',sha256:'x'},o11:[{lane:'o11',version:'11.55.96',sha256:'x'},{lane:'o11',version:'11.55.95',sha256:'y'}],odc:{'1.7.32':{lane:'odc',version:'1.7.32',sha256:'z'}}}).length,3);
});

// The automatic release of a window round on fake operations: what is published, prepared, written and told.
function fakeOps(baseline,{fail}={}){
 const calls=[],events=[],prepared=[];let compose=null;
 const ops={secrets:async()=>({}),pause:()=>{},deploymentBudget:()=>{},verifyRelease:async()=>{},liveBaseline:async()=>baseline,
  verifyLocalImage:async b=>calls.push('verify '+b.tag),publish:async b=>{calls.push('publish '+b.tag);return {digest:'sha256:'+b.sha256};},
  pinExecution:async(pinned,dir,id,kernels)=>{calls.push('pin');ops.pinnedKernels=kernels;ops.pinned=pinned;return 'pin-commit';},
  acquireReleaseLock:async()=>async()=>{},preflightRemote:async()=>{},assertLiveUnchanged:async()=>{},backup:async()=>({ok:true,directory:'/b',volumes:1}),
  composeFor:async(s,b,pinned,change)=>{ops.change=change;return preserveCompose({compose:JSON.stringify(generateCompose(baseline.manifest))},pinned,change);},
  prepare:async(s,r)=>{prepared.push([r.service??r.id,!!r.features,r.kernel?.o11??null]);},
  writeCompose:async(s,c)=>{compose=c;calls.push('compose');},deploy:async()=>{calls.push('deploy');},
  checks:async(s,e)=>{calls.push(e.rollback?'rollback-checks':'checks');ops.checked=e;return fail==='checks'&&!e.rollback?{ok:false}:{ok:true};},
  restoreCompose:async()=>calls.push('restore'),
  event:async(name,v)=>{events.push([name,v.code??null,v.message]);return {remote:true,webhook:false};}};
 return {ops,calls,events,prepared,compose:()=>compose};
}
const liveOf=manifest=>({hash:'h',manifest,kernels:Object.fromEntries(manifest.backends.map(b=>['odc-'+b.odc,{odc:b.odc,o11:'11.55.95',odcBridge:'v109'}])),telemetry:{tokens},usage:null});

test('automatic ODC round: one image published and prepared with its features; window-retiring and window-retired reach the owner',async t=>{
 const dir=tmp(t),m=first().manifest,live=liveOf(m);
 const built={odc:'1.7.33',kernels:m.o11.served,defaultO11:'11.55.95',o11:'11.55.95',image:'img',tag:'t33',sha256:sha('f')};
 const next=rotateLane(m,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t33'},tokens});
 const w={kind:'add',lane:'odc',version:'1.7.33',builts:[built],kernels:{'odc-1.7.33':{odc:'1.7.33',o11:'11.55.95',odcBridge:'v110'}},defaultO11:'11.55.95',retiring:next.retiring,retired:next.retired,affected:affectedRecord(next.affected),prepare:['odc-1.7.33']};
 const f=fakeOps(live);
 const r=await releaseAutomatically({outDir:dir},f.ops,{id:'odc-1.7.33',dir,attempt:'a1',baseline:live,built,manifest:next.manifest,kernel:w.kernels['odc-1.7.33'],bridges:{mode:'server-only'},features:path.join(dir,'f.xml'),bundles:{},window:w});
 assert.equal(r.status,'live');
 assert.deepEqual(f.calls.filter(c=>c.startsWith('publish')),['publish t33']);
 assert.deepEqual(f.prepared,[['odc-1.7.33',true,'11.55.95']]);
 assert.deepEqual(f.ops.change,{added:[{lane:'odc',version:'1.7.33'}],retired:[{lane:'odc',version:'1.7.28'}]});
 assert.deepEqual(Object.keys(f.ops.pinnedKernels),['odc-1.7.33']);
 assert.ok(f.ops.pinned.backends.every(b=>/^[a-f0-9]{64}$/.test(String(b.sha256).replace(/^sha256:/,''))));
 assert.deepEqual(f.events.map(e=>e[0]),['detected','live','window-retiring','window-retired']);
 assert.match(f.events.find(e=>e[0]==='window-retired')[2],/Acme/);
 const written=JSON.parse(f.compose().replace(/^#[^\n]*\n/,''));
 const backends=Object.values(written.services).filter(s=>s.environment?.SSAM_BACKEND_NAME);
 assert.deepEqual(backends.map(s=>s.environment.SSAM_BACKEND_NAME).sort(),['odc-1.7.29','odc-1.7.30','odc-1.7.31','odc-1.7.32','odc-1.7.33']);
});

test('automatic O11 round: every image published, every backend\'s kernel.json moved; its rollback accepts the moved default',async t=>{
 const dir=tmp(t),m=first().manifest,live=liveOf(m);
 const builts=m.backends.map((b,i)=>({odc:b.odc,kernels:[...m.o11.served,'11.55.96'],defaultO11:'11.55.95',o11:'11.55.95',image:'img',tag:'k'+i,sha256:String(i).repeat(64)}));
 const next=rotateLane(m,'o11','11.55.96',{now:NOW,images:Object.fromEntries(builts.map(b=>[b.odc,{image:b.image,tag:b.tag}])),tokens});
 const kernels=Object.fromEntries(m.backends.map(b=>['odc-'+b.odc,{odc:b.odc,o11:'11.55.95',odcBridge:'v109'}]));
 const w={kind:'add',lane:'o11',version:'11.55.96',builts,kernels,defaultO11:'11.55.95',retiring:next.retiring,retired:next.retired,affected:affectedRecord(next.affected),prepare:Object.keys(kernels)};
 const f=fakeOps(live,{fail:'checks'});
 const r=await releaseAutomatically({outDir:dir},f.ops,{id:'o11-11.55.96',dir,attempt:'a1',baseline:live,built:builts[0],manifest:next.manifest,kernel:kernels['odc-1.7.32'],bridges:{mode:'server-only'},features:null,bundles:{},window:w});
 assert.equal(f.calls.filter(c=>c.startsWith('publish')).length,5);
 assert.deepEqual(f.prepared.map(p=>[p[0],p[1]]),Object.keys(kernels).map(k=>[k,false]));
 assert.equal(r.status,'rolled-back');
 assert.equal(f.ops.checked.kernelO11Also,'11.55.95');
});

test('automatic retirement: compose only (nothing published or prepared), and the retired version is told',async t=>{
 const dir=tmp(t),m=first().manifest,live=liveOf(m);
 const due=retireDue(m,{now:NOW+7*DAY,tokens});
 const w={kind:'retire',lane:'odc',version:'1.7.28',builts:[],kernels:null,defaultO11:null,retiring:[],retired:due.retired,affected:affectedRecord(due.affected)};
 const f=fakeOps(live);
 const r=await releaseAutomatically({outDir:dir},f.ops,{id:'retire-odc-1.7.28',dir,attempt:'a1',baseline:live,built:null,manifest:due.manifest,kernel:null,bridges:null,features:null,bundles:null,window:w});
 assert.equal(r.status,'live');
 assert.equal(f.calls.some(c=>c.startsWith('publish')),false);
 assert.deepEqual(f.prepared,[]);
 assert.deepEqual(f.ops.change,{added:[],retired:[{lane:'odc',version:'1.7.28'}]});
 assert.deepEqual(f.events.map(e=>e[0]),['detected','live','window-retired']);
 // Already retired on a newer live window: the deferred release closes as idle.
 assert.equal(windowAgain({},w,{manifest:due.manifest,telemetry:{}},NOW+7*DAY),null);
});

test('a window round pins only what it built and refuses a pin that changes a retained image',()=>{
 const m=first().manifest,built={odc:'1.7.33',image:'img',tag:'t33',sha256:sha('9')};
 const next=rotateLane(m,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t33'}}).manifest;
 const pinned=windowPinned(next,{kind:'add',lane:'odc',builts:[built]},{manifest:m,usage:null});
 assert.equal(pinned.backends[0].sha256,sha('9'));
 const bad=structuredClone(next);bad.backends[2].image='elsewhere';
 assert.throws(()=>windowPinned(bad,{kind:'add',lane:'odc',builts:[built]},{manifest:m,usage:null}),e=>e.code==='LIVE_DOWNGRADE');
});

test('a backend window round waits (fails closed) without automatic mode, and records it',async t=>{
 const dir=tmp(t),m=first().manifest,notes=[];
 const r=await runWindowAttempt({outDir:dir,manifest:m,automatic:false},{log:()=>{},notify:async(t)=>notes.push(t)},{id:'odc-1.7.33',kind:'add',lane:'odc',version:'1.7.33',candidate:{lane:'odc',version:'1.7.33'},inputs:{},previous:null,skipped:[]},NOW);
 assert.equal(r.status,'deferred');
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'odc-1.7.33','attempt.json'),'utf8')).code,'window-needs-automatic');
});

// A whole lane round on fake operations, up to the rehearsal's end: the server-only gate on this checkout's agent release,
// the candidate tests, one build per backend, one smoke per backend and the reference-app gate.
import {parseAgentRelease} from './server-only.mjs';
const read=rel=>fs.readFileSync(path.resolve(here,'../../..',rel),'utf8');
const agentFiles={program:read('agent/platforms/odc/studio/bridge/client/Program.cs'),kinds:read('agent/agent/lib/kinds.mjs'),native:read('agent/native/Ssam.Agent/StudioKinds.cs'),bridgeProject:read('agent/platforms/odc/studio/bridge/Bridge.csproj')};
const example=JSON.parse(fs.readFileSync(path.join(here,'config.example.json'),'utf8'));
const packConfig={agentPack:{...example.agentPack,o11Builds:[{version:'11.55.96',runtime:'net10.0'},{version:'11.55.95',runtime:'net10.0'},...example.agentPack.o11Builds]},agentPackByRuntime:example.agentPackByRuntime};
function roundOps(dir,{lane}){
 const builds=[],smokes=[],bundle=(l,v)=>({lane:l,version:v,fullVersion:v+'.1',tfm:'net10.0',file:path.join(dir,`${l}-${v}.tar.gz`),sha256:sha('1'),features:path.join(dir,'f.xml'),featuresProvenance:{mode:'exact',version:v}});
 const ops={log:()=>{},notify:async()=>{},secrets:async()=>({}),event:async()=>({remote:true}),preflight:async()=>{},capacityPreflight:async()=>{},targetFramework:async()=>'net10.0',dockerReady:async()=>{},
  agentRelease:async()=>parseAgentRelease({commit:'c20454cbc78f6165b7e3c58e8348adf81ad656a5',...agentFiles}),o11Proofs:async()=>({proven:{},refused:[]}),
  odcBinary:async()=>({gaps:[],compared:[],reference:'1.7.32'}),bundle:async c=>bundle(c.lane,c.version),companion:async(l,v)=>bundle(l,v),
  servedKernels:async()=>[{odc:'1.7.32',o11:'11.55.95',odcBridge:'v109',odcBridgeAccepted:['v108']}],
  test:async()=>({passed:10,total:10,failures:[]}),
  buildBackend:async(spec,b)=>{builds.push([spec.odc,spec.kernels.join(','),spec.defaultO11,b.o11.map(x=>x.version).join(',')]);return {odc:spec.odc,kernels:spec.kernels,defaultO11:spec.defaultO11,o11:spec.defaultO11,image:'img',tag:'t'+spec.odc.replaceAll('.',''),sha256:sha('2')};},
  smokeBackend:async(built,b,served)=>{smokes.push([built.odc,b.odc.version,served.o11.join(',')]);return {ok:true,publishedPack:true};}};
 return {ops,builds,smokes};
}
const roundConfig=(dir,m,extra={})=>({...packConfig,outDir:dir,manifest:m,automatic:true,state:{tokens},liveBaseline:liveOf(m),rehearsal:{finish:async(c,o,{release})=>({status:'rehearsed',release})},...extra});

test('an ODC lane round builds the new backend only, with every served O11 kernel; the reference gate is recorded',async t=>{
 const dir=tmp(t),m=first().manifest,{ops,builds,smokes}=roundOps(dir,{lane:'odc'});
 const r=await runWindowAttempt(roundConfig(dir,m),ops,{id:'odc-1.7.33',kind:'add',lane:'odc',version:'1.7.33',candidate:{lane:'odc',version:'1.7.33',fullVersion:'1.7.33.1',tfm:'net10.0'},inputs:{},previous:null,skipped:[]},NOW);
 assert.equal(r.status,'rehearsed',JSON.stringify(r));
 assert.deepEqual(builds,[['1.7.33','11.55.92,11.55.93,11.55.94,11.55.95','11.55.95','11.55.92,11.55.93,11.55.94,11.55.95']]);
 assert.deepEqual(smokes.map(s=>s[0]),['1.7.33']);
 const w=r.release.window;
 assert.deepEqual(w.prepare,['odc-1.7.33']);
 assert.deepEqual(w.retired.map(x=>x.version),['1.7.28']);
 assert.equal(w.referenceGate.ran,false);
 assert.equal(r.release.kernel.odc,'1.7.33');assert.equal(r.release.kernel.o11,'11.55.95');
 assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir,'odc-1.7.33','affected.json'),'utf8'))).includes('"t1"'));
});

test('an O11 lane round rebuilds every backend with the new kernel set and smokes each one with its own ODC Studio',async t=>{
 const dir=tmp(t),m=first().manifest,{ops,builds,smokes}=roundOps(dir,{lane:'o11'});
 const r=await runWindowAttempt(roundConfig(dir,m),ops,{id:'o11-11.55.96',kind:'add',lane:'o11',version:'11.55.96',candidate:{lane:'o11',version:'11.55.96',fullVersion:'11.55.96.1',tfm:'net10.0'},inputs:{},previous:null,skipped:[]},NOW);
 assert.equal(r.status,'rehearsed',JSON.stringify(r));
 assert.deepEqual(builds.map(b=>b[0]),['1.7.32','1.7.31','1.7.30','1.7.29','1.7.28']);
 assert.ok(builds.every(b=>b[1]==='11.55.92,11.55.93,11.55.94,11.55.95,11.55.96'&&b[2]==='11.55.95'));
 assert.deepEqual(smokes.map(s=>s[0]+'/'+s[1]),['1.7.32/1.7.32','1.7.31/1.7.31','1.7.30/1.7.30','1.7.29/1.7.29','1.7.28/1.7.28']);
 assert.deepEqual(Object.keys(r.release.window.kernels).length,5);
 assert.deepEqual(r.release.manifest.retiring.o11.version,'11.55.92');
});

test('mode command without its command: the lane round waits (REFERENCE_GATE_UNCONFIGURED) and deploys nothing',async t=>{
 const dir=tmp(t),m=first().manifest,{ops}=roundOps(dir,{lane:'odc'}),events=[];ops.event=async(n,v)=>{events.push([n,v.code]);return {remote:true};};
 const cfg=roundConfig(dir,m,{referenceGate:{mode:'command'}});delete cfg.rehearsal;
 const r=await runWindowAttempt(cfg,ops,{id:'odc-1.7.33',kind:'add',lane:'odc',version:'1.7.33',candidate:{lane:'odc',version:'1.7.33',fullVersion:'1.7.33.1',tfm:'net10.0'},inputs:{},previous:null,skipped:[]},NOW);
 assert.equal(r.status,'deferred');assert.equal(r.code,'reference-gate-unconfigured');
 assert.deepEqual(events.at(-1),['waiting','REFERENCE_GATE_UNCONFIGURED']);
 assert.equal(fs.existsSync(path.join(dir,'odc-1.7.33','release.json')),false);
});

test('mode owner (the default): the round stops in "proposed", the owner is told what to test, -Approve lets the next round deploy exactly those images',async t=>{
 const dir=tmp(t),m=first().manifest,{ops}=roundOps(dir,{lane:'odc'}),events=[],notes=[];
 ops.event=async(n,v)=>{events.push([n,v.code,v.message]);return {remote:true};};ops.notify=async(title,message)=>notes.push(title+' '+message);
 const cfg=roundConfig(dir,m,{workspace:'C:/w',configFile:'C:/c.json'});delete cfg.rehearsal;
 const candidate={lane:'odc',version:'1.7.33',fullVersion:'1.7.33.1',tfm:'net10.0'};
 const r=await runWindowAttempt(cfg,ops,{id:'odc-1.7.33',kind:'add',lane:'odc',version:'1.7.33',candidate,inputs:{head:'h',studios:{odc:'1.7.33.1'}},previous:null,skipped:[]},NOW);
 assert.equal(r.status,'proposed',JSON.stringify(r));
 const proposal=fs.readFileSync(path.join(dir,'odc-1.7.33','PROPOSTA.md'),'utf8');
 assert.match(proposal,/FolhaPonto and VisitaCerta from zero/);assert.match(proposal,/img:t1733 \(local image, sha256:2{64}/);
 assert.match(proposal,/-Approve odc-1\.7\.33/);assert.match(proposal,/-Reject odc-1\.7\.33 -Reason/);
 const told=events.find(e=>e[1]==='REFERENCE_GATE_OWNER');assert.ok(told);assert.match(told[2],/ODC Studio 1\.7\.33.*t1733 sha256:2{64}.*-Approve odc-1\.7\.33.*-Reject/);
 assert.ok(notes.some(n=>/reference-app test before deploying odc-1\.7\.33/.test(n)));
 // Nothing left the machine: no publish, no deployment journal.
 assert.equal(fs.existsSync(path.join(dir,'odc-1.7.33','deployment.json')),false);
 const {readAttempts}=await import('./pipeline.mjs');
 const inputs=x=>({head:'h',studios:{[x.lane]:x.candidate.fullVersion}}),observed=[candidate];
 const waiting=decideWindow({manifest:m,observed,state:{},attempts:readAttempts(dir),inputs,now:NOW+3600000});
 assert.equal(waiting.action,'pending-approval');assert.equal(waiting.id,'odc-1.7.33');
 // The owner's -Approve (the same command as a pair proposal) records the gate; the next decision releases.
 const {approve,reject}=await import('./approve.mjs');
 const ok=await approve({outDir:dir},{log:()=>{}},'odc-1.7.33');
 assert.equal(ok.status,'gate-approved');assert.match(ok.note,/odc-1\.7\.33 t1733/);
 const go=decideWindow({manifest:m,observed,state:{},attempts:readAttempts(dir),inputs,now:NOW+7200000});
 assert.equal(go.action,'release');
 // The release on fake operations: published and deployed are the images he was shown.
 const f=fakeOps(liveOf(m));Object.assign(f.ops,{log:()=>{},notify:async()=>{}});
 const {runWindowVigia}=await import('./window-round.mjs');
 const live=await runWindowVigia({...cfg,observed,head:'h',now:NOW+7200000},f.ops);
 assert.equal(live.status,'live',JSON.stringify(live));
 assert.deepEqual(f.calls.filter(c=>c.startsWith('publish')),['publish t1733']);
 assert.equal(readAttempts(dir)['odc-1.7.33'].status,'approved');
 // -Reject instead stops it: the lane is not rebuilt with the same inputs.
 const dir2=tmp(t),{ops:ops2}=roundOps(dir2,{lane:'odc'});ops2.event=async()=>({remote:true});
 await runWindowAttempt({...cfg,outDir:dir2},ops2,{id:'odc-1.7.33',kind:'add',lane:'odc',version:'1.7.33',candidate,inputs:{head:'h',studios:{odc:'1.7.33.1'}},previous:null,skipped:[]},NOW);
 reject({outDir:dir2},'odc-1.7.33','FolhaPonto failed');
 assert.equal(decideWindow({manifest:m,observed,state:{},attempts:readAttempts(dir2),inputs,now:NOW+3600000}).action,'idle');
});

test('a retirement round never waits for the owner, whatever the reference gate',async t=>{
 const dir=tmp(t),m=first().manifest,live=liveOf(m),f=fakeOps(live);Object.assign(f.ops,{log:()=>{},notify:async()=>{}});
 const r=await runWindowAttempt({outDir:dir,manifest:m,automatic:true,state:{tokens},liveBaseline:live,referenceGate:{mode:'owner'}},f.ops,{id:'retire-odc-1.7.28',kind:'retire',lane:'odc',version:'1.7.28',inputs:{},previous:null,skipped:[]},NOW+7*DAY);
 assert.equal(r.status,'live',JSON.stringify(r));
 assert.equal(fs.existsSync(path.join(dir,'retire-odc-1.7.28','PROPOSTA.md')),false);
});

test('-RehearseCurrent on a backend window rebuilds the served version\'s round without rotating, and never runs the reference gate',async t=>{
 const dir=tmp(t),m=first().manifest,{ops,builds}=roundOps(dir,{lane:'odc'});let ran=false;ops.referenceGate=async()=>{ran=true;return {ok:true,apps:[]};};
 const r=await runWindowAttempt(roundConfig(dir,m,{referenceGate:{command:'x'}}),ops,{id:'odc-1.7.32',kind:'add',lane:'odc',version:'1.7.32',rehearse:true,candidate:{lane:'odc',version:'1.7.32',fullVersion:'1.7.32.1',tfm:'net10.0'},inputs:{},previous:null,skipped:[]},NOW);
 assert.equal(r.status,'rehearsed',JSON.stringify(r));
 assert.equal(ran,false);assert.equal(r.release.window.referenceGate.rehearsal,true);
 assert.deepEqual(builds.map(b=>b[0]),['1.7.32']);
 assert.deepEqual(r.release.manifest.backends.map(b=>b.odc),m.backends.map(b=>b.odc));
 assert.deepEqual(r.release.manifest.retiring,m.retiring);
 assert.equal(r.release.manifest.backends[0].tag,'t1732');
});
