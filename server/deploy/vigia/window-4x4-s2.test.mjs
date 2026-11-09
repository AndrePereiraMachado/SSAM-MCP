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
 const K=[...m.o11.served],odc=rotateLane(m,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t33',kernels:K}}).manifest;
 assertRetained(baseline,pinDigests(odc,{t33:'sha256:'+sha('c')}),{lane:'odc',built:{t33:sha('c')},images:{t33:{odc:'1.7.33',kernels:K}}});
 // S2 R4 (review M1): the declared kernels must be the image's real ones, and the image the one built for that backend.
 assert.throws(()=>assertRetained(baseline,pinDigests(odc,{t33:'sha256:'+sha('c')}),{lane:'odc',built:{t33:sha('c')},images:{t33:{odc:'1.7.33',kernels:K.slice(1)}}}),e=>e.code==='IMAGE_KERNELS_DIFFER');
 assert.throws(()=>assertRetained(baseline,pinDigests(odc,{t33:'sha256:'+sha('c')}),{lane:'odc',built:{t33:sha('c')},images:{t33:{odc:'1.7.32',kernels:K}}}),e=>e.code==='IMAGE_KERNELS_DIFFER');
 assert.throws(()=>assertRetained(baseline,pinDigests(odc,{t33:'sha256:'+sha('c')}),{lane:'odc',built:{t33:sha('c')}}),e=>e.code==='IMAGE_KERNELS_DIFFER');
 const swapped=structuredClone(odc);swapped.backends[1].tag='other';
 assert.throws(()=>assertRetained(baseline,pinDigests(swapped,{t33:'sha256:'+sha('c'),other:'sha256:'+sha('d')}),{lane:'odc',built:{t33:sha('c')},images:{t33:{odc:'1.7.33',kernels:K}}}),e=>e.code==='LIVE_DOWNGRADE');
 const K96=[...K,'11.55.96'],built=Object.fromEntries(m.backends.map(b=>[b.odc,{image:'img',tag:'k'+b.odc.replaceAll('.',''),kernels:K96}]));
 const o11=rotateLane(m,'o11','11.55.96',{now:NOW,images:built}).manifest,digests=Object.fromEntries(o11.backends.map(b=>[b.tag,'sha256:'+sha('e')]));
 const real=Object.fromEntries(o11.backends.map(b=>[b.tag,{odc:b.odc,kernels:K96}]));
 assertRetained(baseline,pinDigests(o11,digests),{lane:'o11',built:Object.fromEntries(o11.backends.map(b=>[b.tag,sha('e')])),images:real});
 assert.throws(()=>assertRetained(baseline,pinDigests(o11,digests),{lane:'o11',built:{}}),e=>e.code==='LIVE_DOWNGRADE');
 // An O11 round's rebuilt image is checked against its real kernels, never the manifest's own (the old check was always true).
 assert.throws(()=>assertRetained(baseline,pinDigests(o11,digests),{lane:'o11',built:Object.fromEntries(o11.backends.map(b=>[b.tag,sha('e')])),images:{...real,[o11.backends[2].tag]:{odc:o11.backends[2].odc,kernels:K}}}),e=>e.code==='IMAGE_KERNELS_DIFFER');
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
 const m=first().manifest,built={odc:'1.7.33',image:'img',tag:'t33',sha256:sha('9'),kernels:[...m.o11.served]};
 const next=rotateLane(m,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t33',kernels:built.kernels}}).manifest;
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

// ---- S2 R4 (independent review C:\t\r5\janela-4x4\S2-REVISAO.md): the owner's approval is applied to the window live at that
// moment, which may have moved since the build.
import {resendKept,KEPT_NOTICES,REBUILD_NEEDED} from './automatic.mjs';
import {readAttempts} from './pipeline.mjs';
import {readJournal} from './journal.mjs';
const K=['11.55.92','11.55.93','11.55.94','11.55.95'],K96=[...K,'11.55.96'];
const pinTags=m=>pinDigests(m,Object.fromEntries(m.backends.filter(b=>!b.sha256).map(b=>[b.tag,'sha256:'+sha('7')])));
const ownerCfg=(dir,m)=>{const c=roundConfig(dir,m,{workspace:'C:/w',configFile:'C:/c.json'});delete c.rehearsal;return c;};
const cand=(lane,version)=>({lane,version,fullVersion:version+'.1',tfm:'net10.0'});
// The owner-gated proposal of a lane round, built on m at NOW, then approved by the owner.
async function proposeAndApprove(dir,m,lane,version){
 const {ops}=roundOps(dir,{lane});ops.event=async()=>({remote:true});
 const r=await runWindowAttempt(ownerCfg(dir,m),ops,{id:`${lane}-${version}`,kind:'add',lane,version,candidate:cand(lane,version),inputs:{head:'h',studios:{[lane]:version+'.1'}},previous:null,skipped:[]},NOW);
 assert.equal(r.status,'proposed',JSON.stringify(r));
 const {approve}=await import('./approve.mjs');assert.equal((await approve({outDir:dir},{log:()=>{}},`${lane}-${version}`)).status,'gate-approved');
 return r;
}
// The next watcher round on the live window `live` (fake deploy operations).
async function nextRound(dir,live,observed,now){
 const f=fakeOps(liveOf(live));Object.assign(f.ops,{log:()=>{},notify:async()=>{}});
 const {runWindowVigia}=await import('./window-round.mjs');
 const r=await runWindowVigia({...ownerCfg(dir,live),manifest:live,liveBaseline:liveOf(live),observed,head:'h',now},f.ops);
 return {r,f};
}
const inputsOf=x=>({head:'h',studios:{[x.lane]:x.candidate.fullVersion}});

test('R4 M1: an ODC proposal approved after an O11 round went live is never deployed without the new kernel: rebuilt and proposed again',async t=>{
 const dir=tmp(t),W0=first().manifest;
 // 1-2. The ODC 1.7.33 round builds with the O11 kernels served then (.92-.95) and waits for the owner.
 const proposed=await proposeAndApprove(dir,W0,'odc','1.7.33');
 assert.deepEqual(proposed.builts[0].kernels,K);
 // 3. Meanwhile the O11 11.55.96 round went live: every backend serves .92-.96.
 const W1=pinTags(rotateLane(W0,'o11','11.55.96',{now:NOW,images:Object.fromEntries(W0.backends.map(b=>[b.odc,{image:'img',tag:'k'+b.odc.replaceAll('.',''),kernels:K96}]))}).manifest);
 assert.deepEqual(W1.o11.served,K96);
 // The rotation with the image's real kernels is refused by versionBackends (the old code recorded none, so it passed).
 assert.throws(()=>rotateLane(W1,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t1733',kernels:K}}),/lacks the O11 kernels 11\.55\.96/);
 assert.throws(()=>windowAgain({},readJournal(path.join(dir,'odc-1.7.33','release.json')).window,{manifest:W1,telemetry:{}},NOW),e=>e.code===REBUILD_NEEDED);
 // 4. The owner's approval is applied on that window: nothing is published or deployed, the proposal is dropped.
 const {r,f}=await nextRound(dir,W1,[cand('odc','1.7.33')],NOW+3600000);
 assert.equal(r.status,'failed',JSON.stringify(r));assert.equal(r.code,REBUILD_NEEDED);assert.equal(r.dropped,true);
 assert.deepEqual(f.calls,[]);
 const a=readAttempts(dir)['odc-1.7.33'];assert.equal(a.status,'failed');assert.equal(a.retry,true);assert.equal(a.dropped.code,REBUILD_NEEDED);
 const told=f.events.find(e=>e[0]==='dropped'&&e[1]===REBUILD_NEEDED);assert.ok(told);assert.match(told[2],/11\.55\.96/);
 // The next round builds 1.7.33 again (with .96) and proposes it anew.
 const again=decideWindow({manifest:W1,observed:[cand('odc','1.7.33')],state:{},attempts:readAttempts(dir),inputs:inputsOf,now:NOW+7200000});
 assert.equal(again.action,'run');assert.equal(again.id,'odc-1.7.33');
});

test('R4 M2(a): an O11 proposal approved after a retirement removed a backend deploys the remaining images, with today\'s dates',async t=>{
 const dir=tmp(t),W0=first().manifest;
 await proposeAndApprove(dir,W0,'o11','11.55.96');
 // Day 7: the compose-only retirement of ODC 1.7.28 went live; day 8 the owner's approval reaches the round.
 const W1=retireDue(W0,{now:NOW+7*DAY}).manifest;assert.equal(W1.backends.length,4);
 const {r,f}=await nextRound(dir,W1,[cand('o11','11.55.96')],NOW+8*DAY);
 assert.equal(r.status,'live',JSON.stringify(r));
 assert.deepEqual(f.calls.filter(c=>c.startsWith('publish')).sort(),['publish t1729','publish t1730','publish t1731','publish t1732']);
 assert.deepEqual(f.prepared.map(p=>p[0]).sort(),['odc-1.7.29','odc-1.7.30','odc-1.7.31','odc-1.7.32']);
 assert.ok(f.prepared.every(p=>p[1]===false));
 assert.deepEqual(f.ops.pinned.backends.map(b=>b.o11Kernels),[K96,K96,K96,K96]);
 // Review B1: the grace of 11.55.92 starts at the deploy (day 8), not at the build (day 0).
 const day15=new Date(NOW+15*DAY).toISOString();
 assert.ok(f.events.find(e=>e[0]==='window-retiring')[2].includes('11.55.92 leaves SSAM on '+day15.slice(0,10)));
 assert.equal(f.ops.pinned.retiring.o11.retireAt,day15);
 assert.equal(readAttempts(dir)['o11-11.55.96'].status,'approved');
});

test('R4 M2(b): an O11 proposal approved after a new ODC backend went live is dropped, and blocks neither the retirement nor the next round',async t=>{
 const dir=tmp(t),W0=first().manifest;
 await proposeAndApprove(dir,W0,'o11','11.55.96');
 const W1=pinTags(rotateLane(W0,'odc','1.7.33',{now:NOW+DAY,images:{image:'img',tag:'t33',kernels:K}}).manifest);
 const {r,f}=await nextRound(dir,W1,[cand('o11','11.55.96')],NOW+2*DAY);
 assert.equal(r.status,'failed',JSON.stringify(r));assert.equal(r.code,REBUILD_NEEDED);assert.deepEqual(f.calls,[]);
 const attempts=readAttempts(dir);assert.equal(attempts['o11-11.55.96'].retry,true);
 // Not due yet: the O11 round runs again (rebuilt on the new window). Once 1.7.29's grace ends, its retirement comes first.
 assert.equal(decideWindow({manifest:W1,observed:[cand('o11','11.55.96')],state:{},attempts,inputs:inputsOf,now:NOW+2*DAY+60000}).id,'o11-11.55.96');
 const due=decideWindow({manifest:W1,observed:[cand('o11','11.55.96')],state:{},attempts,inputs:inputsOf,now:NOW+9*DAY});
 assert.equal(due.action,'run');assert.equal(due.kind,'retire');assert.equal(due.version,'1.7.29');
});

test('R4 M2: a pin that does not fit ends the attempt before any mutation (preparation-failed), never an exception',async t=>{
 const dir=tmp(t),m=first().manifest,live=liveOf(m);
 const built={odc:'1.7.33',kernels:K,defaultO11:'11.55.95',o11:'11.55.95',image:'img',tag:'t33',sha256:sha('f')},stray={...built,odc:'1.7.28',tag:'t28',sha256:sha('e')};
 const next=rotateLane(m,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t33',kernels:K},tokens});
 const w={kind:'add',lane:'odc',version:'1.7.33',builts:[built,stray],kernels:{'odc-1.7.33':{odc:'1.7.33',o11:'11.55.95'}},defaultO11:'11.55.95',retiring:next.retiring,retired:next.retired,affected:[],prepare:['odc-1.7.33']};
 const f=fakeOps(live);
 const r=await releaseAutomatically({outDir:dir},f.ops,{id:'odc-1.7.33',dir,attempt:'a1',baseline:live,built,manifest:next.manifest,kernel:w.kernels['odc-1.7.33'],bridges:{mode:'server-only'},features:path.join(dir,'f.xml'),bundles:{},window:w});
 assert.equal(r.status,'failed');assert.deepEqual(f.calls,[]);
 const state=readJournal(path.join(dir,'deployment.json'));assert.equal(state.status,'preparation-failed');assert.equal(state.mutationStarted,undefined);
 assert.ok(f.events.some(e=>e[0]==='failed'));
});

test('R4 M2: a deferred window deploy re-derived on a window its images no longer fit ends stale, told on the resent channel',async t=>{
 const dir=tmp(t),out=tmp(t),W0=first().manifest;
 const built={odc:'1.7.33',kernels:K,defaultO11:'11.55.95',o11:'11.55.95',image:'img',tag:'t33',sha256:sha('f')};
 const next=rotateLane(W0,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t33',kernels:K}});
 const w={kind:'add',lane:'odc',version:'1.7.33',builts:[built],o11Kernels:K,kernels:{'odc-1.7.33':{odc:'1.7.33',o11:'11.55.95'}},defaultO11:'11.55.95',retiring:next.retiring,retired:next.retired,affected:[],prepare:['odc-1.7.33']};
 const W1=pinTags(rotateLane(W0,'o11','11.55.96',{now:NOW,images:Object.fromEntries(W0.backends.map(b=>[b.odc,{image:'img',tag:'k'+b.odc,kernels:K96}]))}).manifest);
 const folder=path.join(out,'odc-1.7.33');fs.mkdirSync(folder);
 fs.writeFileSync(path.join(folder,'deployment.json'),JSON.stringify({schema:2,id:'odc-1.7.33',attempt:'a1',steps:{},status:'deferred',deferrals:1,firstDeferredAt:new Date().toISOString(),baseline:{...liveOf(W0),hash:'old'}}));
 let delivered=false;const f=fakeOps({...liveOf(W1),hash:'new'}),send=f.ops.event;f.ops.event=async(n,v)=>delivered?send(n,v):{remote:false,webhook:false};
 const r=await releaseAutomatically({outDir:out},f.ops,{id:'odc-1.7.33',dir:folder,attempt:'a1',built,manifest:next.manifest,kernel:w.kernels['odc-1.7.33'],bridges:{mode:'server-only'},features:path.join(dir,'f.xml'),bundles:{},window:w});
 assert.equal(r.status,'stale');assert.equal(r.code,REBUILD_NEEDED);assert.deepEqual(f.calls,[]);
 // Not delivered: kept, and sent by a later round once a channel takes it.
 assert.equal(readJournal(path.join(folder,KEPT_NOTICES)).unsent.length,1);
 delivered=true;assert.equal(await resendKept(f.ops,{outDir:out,id:'odc-1.7.33'}),0);
 assert.ok(f.events.some(e=>e[0]==='stale'&&e[1]===REBUILD_NEEDED));
 // A later call stays stale: it never deploys.
 assert.equal((await releaseAutomatically({outDir:out},f.ops,{id:'odc-1.7.33',dir:folder,attempt:'a1',built,manifest:next.manifest,kernel:{},bridges:{},features:null,bundles:{},window:w})).status,'stale');
});

test('R4 B3: the notices of a live release are recorded with the live state before they are sent',async t=>{
 const dir=tmp(t),m=first().manifest,live=liveOf(m);
 const built={odc:'1.7.33',kernels:K,defaultO11:'11.55.95',o11:'11.55.95',image:'img',tag:'t33',sha256:sha('f')};
 const next=rotateLane(m,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t33',kernels:K},tokens});
 const w={kind:'add',lane:'odc',version:'1.7.33',builts:[built],kernels:{'odc-1.7.33':{odc:'1.7.33',o11:'11.55.95'}},defaultO11:'11.55.95',retiring:next.retiring,retired:next.retired,affected:affectedRecord(next.affected),prepare:['odc-1.7.33']};
 const f=fakeOps(live),send=f.ops.event;let atLive=null;
 f.ops.event=async(n,v)=>{if(n==='live')atLive=readJournal(path.join(dir,'deployment.json'));return send(n,v);};
 assert.equal((await releaseAutomatically({outDir:dir},f.ops,{id:'odc-1.7.33',dir,attempt:'a1',baseline:live,built,manifest:next.manifest,kernel:w.kernels['odc-1.7.33'],bridges:{mode:'server-only'},features:path.join(dir,'f.xml'),bundles:{},window:w})).status,'live');
 assert.equal(atLive.status,'live');assert.deepEqual(atLive.unsent.map(u=>u.name),['live','window-retiring','window-retired']);
 assert.equal(readJournal(path.join(dir,'deployment.json')).unsent,undefined);
});

test('R4 B2: a retirement whose deploy was abandoned runs again after retryHours',()=>{
 const m=first().manifest,at=new Date(NOW+7*DAY).toISOString(),endedAt=new Date(NOW+7*DAY+3600000).toISOString();
 const attempts={'retire-odc-1.7.28':{id:'retire-odc-1.7.28',status:'closed',code:'abandoned',inputs:{retireAt:m.retiring.odc.retireAt},at,endedAt}};
 const d=now=>decideWindow({manifest:m,observed:[],state:{},attempts,inputs:()=>({}),now});
 assert.equal(d(NOW+7*DAY+2*3600000).action,'idle');
 const again=d(NOW+7*DAY+14*3600000);assert.equal(again.action,'run');assert.equal(again.kind,'retire');
});

test('R4 B6: a proposal a newer version of its lane replaced expires, the owner is told, and the newer one is proposed',async t=>{
 const dir=tmp(t),W0=first().manifest;
 const {ops}=roundOps(dir,{lane:'odc'}),events=[];ops.event=async(n,v)=>{events.push([n,v.code]);return {remote:true};};
 await runWindowAttempt(ownerCfg(dir,W0),ops,{id:'odc-1.7.33',kind:'add',lane:'odc',version:'1.7.33',candidate:cand('odc','1.7.33'),inputs:{head:'h',studios:{odc:'1.7.33.1'}},previous:null,skipped:[]},NOW);
 const d=decideWindow({manifest:W0,observed:[cand('odc','1.7.34')],state:{},attempts:readAttempts(dir),inputs:inputsOf,now:NOW+DAY});
 assert.deepEqual(d.superseded,[{id:'odc-1.7.33',lane:'odc',version:'1.7.33',by:'1.7.34'}]);
 const {runWindowVigia}=await import('./window-round.mjs');
 const r=await runWindowVigia({...ownerCfg(dir,W0),observed:[cand('odc','1.7.34')],head:'h',now:NOW+DAY},ops);
 assert.equal(r.status,'proposed',JSON.stringify(r));assert.equal(r.id,'odc-1.7.34');
 const old=readAttempts(dir)['odc-1.7.33'];assert.equal(old.status,'closed');assert.equal(old.code,'superseded');assert.equal(old.superseded.by,'1.7.34');
 assert.deepEqual(events.filter(e=>e[0]==='superseded'),[['superseded','PROPOSAL_SUPERSEDED']]);
 // A version the live window already serves (deployed another way) expires its proposal too.
 const served=decideWindow({manifest:rotateLane(W0,'odc','1.7.34',{now:NOW,images:{image:'i',tag:'t'}}).manifest,observed:[],state:{},attempts:{x:{id:'odc-1.7.33',status:'proposed',round:{kind:'add',lane:'odc',version:'1.7.33'}}},inputs:inputsOf,now:NOW});
 assert.deepEqual(served.superseded.map(s=>s.id),['odc-1.7.33']);
});


test('R4 M4: the prepare adapter sends kernelOnly for an O11 round only, with its round id; an ODC backend without features fails',async t=>{
 const dir=tmp(t),{createAutoRuntime}=await import('./auto-runtime.mjs'),{generateKeyPairSync}=await import('node:crypto');
 const key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}),sent=[];
 const base={executionSource:async()=>{},log:()=>{},notify:async()=>{},fullHead:async()=>'commit',archiveDeploy:async(_c,file)=>fs.writeFileSync(file,'archive'),
  openLease:async()=>{const close=async()=>{};close.assertHeld=()=>{};return close;},
  async run(cmd,args,{input}={}){
   if(args.some(x=>String(x).endsWith('read-secrets.ps1')))return {stdout:JSON.stringify({coolifyToken:'memory-only-token',sshPrivateKey:Buffer.from('PRIVATE KEY').toString('base64'),authenticodeThumbprint:'',manifestPrivateKey:key,journalKey:Buffer.alloc(32,1).toString('base64')})};
   if(cmd.endsWith('icacls.exe'))return {stdout:''};
   const request=JSON.parse(input);sent.push(request);return {stdout:JSON.stringify({ok:true})};
  }};
 const config={workspace:path.resolve(here,'../../..'),tempRoot:dir,outDir:dir,configFile:path.join(dir,'c.json'),domains:{ssam:'mcp.example.test',console:'panel.example.test'},automaticDeployment:{testOnly:true,coolify:{url:'http://127.0.0.1:9',resource:'fixture'},ssh:{host:'fixture',knownHosts:'fixture'},remote:{}}};
 const adapter=createAutoRuntime(config,base),s=await adapter.secrets(),unlock=await adapter.acquireReleaseLock(s);
 const m=first().manifest,compose=JSON.stringify(generateCompose(m)),features=path.join(dir,'f.xml');fs.writeFileSync(features,'<Features/>');
 const one={service:'odc-1.7.29',built:{image:'img',tag:'t',sha256:sha('1')},kernel:{odc:'1.7.29',o11:'11.55.96'},compose,dir};
 await adapter.prepare(s,{...one,lane:'o11',round:'o11-11.55.96',features:null});
 assert.equal(sent.at(-1).kernelOnly,true);assert.equal(sent.at(-1).round,'o11-11.55.96');assert.equal(sent.at(-1).features,undefined);
 await adapter.prepare(s,{...one,lane:'odc',round:'odc-1.7.33',features});
 assert.equal(sent.at(-1).kernelOnly,undefined);assert.ok(sent.at(-1).features);
 const before=sent.length;
 await assert.rejects(adapter.prepare(s,{...one,lane:'odc',round:'odc-1.7.33',features:null}),e=>e.code==='FEATURES_MISSING');
 await assert.rejects(adapter.prepare(s,{...one,lane:'o11',round:'odc-1.7.33',features:null}),/belongs to an O11 round/);
 assert.equal(sent.length,before);
 // R6 B11: a repair (restore or alignment of a retained backend's default) is a kernel-only write in any window round.
 for(const round of ['odc-1.7.33','retire-odc-1.7.28','o11-11.55.96']){await adapter.prepare(s,{...one,lane:'o11',repair:true,round,features:null});assert.equal(sent.at(-1).kernelOnly,true);assert.equal(sent.at(-1).repair,true);assert.equal(sent.at(-1).round,round);}
 await assert.rejects(adapter.prepare(s,{...one,lane:'o11',repair:true,round:'pair-x',features:null}),/belongs to an O11 round/);
 await unlock();
});

test('R4 M1: the kernels of an image come from its label; the post-deploy check expects each backend\'s declared set',async()=>{
 const {labelKernels,builtKernels}=await import('./window.mjs'),{expectedKernelsOf}=await import('./auto-runtime.mjs');
 assert.deepEqual(labelKernels({'ssam.kernels.o11':'11.55.95,11.55.92, 11.55.93'}),['11.55.92','11.55.93','11.55.95']);
 for(const bad of [{},{'ssam.kernels.o11':''},{'ssam.kernels.o11':'11.55,11.55.92'},{'ssam.kernels.o11':'11.55.92,11.55.92'}])assert.equal(labelKernels(bad),null);
 assert.equal(builtKernels({image:'pending'}),null);
 const m=first().manifest,o11=rotateLane(m,'o11','11.55.96',{now:NOW,images:Object.fromEntries(m.backends.map(b=>[b.odc,{image:'i',tag:'k'+b.odc,kernels:K96}]))}).manifest;
 assert.deepEqual(expectedKernelsOf(o11)['1.7.29'],K96);
 // After a compose-only O11 retirement the images still carry the retired kernel: the declared set keeps it.
 const retired=retireDue(retireDue(pinTags(o11),{now:NOW+7*DAY}).manifest,{now:NOW+7*DAY}).manifest;
 assert.deepEqual(retired.o11.served,K96.slice(1));assert.deepEqual(expectedKernelsOf(retired)['1.7.29'],K96);
 assert.equal(expectedKernelsOf({window:3,odc:[],o11:[]}),null);
});

// S2 R6 B9: the stale notice ("the approved images were not deployed ... builds them again") reaches the owner even though a
// "failed" event of the same attempt (the deferral before it) was already delivered: kept notices have their own names and keys.
test('R6 B9: the approved-images-discarded notice reaches the owner after a delivered failed event of the same attempt',async t=>{
 const dir=tmp(t),out=tmp(t),W0=first().manifest;
 const built={odc:'1.7.33',kernels:K,defaultO11:'11.55.95',o11:'11.55.95',image:'img',tag:'t33',sha256:sha('f')};
 const next=rotateLane(W0,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t33',kernels:K}});
 const w={kind:'add',lane:'odc',version:'1.7.33',builts:[built],o11Kernels:K,kernels:{'odc-1.7.33':{odc:'1.7.33',o11:'11.55.95'}},defaultO11:'11.55.95',retiring:next.retiring,retired:next.retired,affected:[],prepare:['odc-1.7.33']};
 const W1=pinTags(rotateLane(W0,'o11','11.55.96',{now:NOW,images:Object.fromEntries(W0.backends.map(b=>[b.odc,{image:'img',tag:'k'+b.odc,kernels:K96}]))}).manifest);
 const folder=path.join(out,'odc-1.7.33');fs.mkdirSync(folder);
 fs.writeFileSync(path.join(folder,'deployment.json'),JSON.stringify({schema:2,id:'odc-1.7.33',attempt:'a1',steps:{},status:'deferred',deferrals:1,firstDeferredAt:new Date().toISOString(),baseline:{...liveOf(W0),hash:'old'}}));
 // The deferral's "failed before mutation" event of attempt a1 was delivered.
 fs.writeFileSync(path.join(out,'release-events.json'),JSON.stringify({'odc-1.7.33:a1:failed':new Date().toISOString()}));
 const f=fakeOps({...liveOf(W1),hash:'new'});
 const r=await releaseAutomatically({outDir:out},f.ops,{id:'odc-1.7.33',dir:folder,attempt:'a1',built,manifest:next.manifest,kernel:w.kernels['odc-1.7.33'],bridges:{mode:'server-only'},features:path.join(dir,'f.xml'),bundles:{},window:w});
 assert.equal(r.status,'stale');
 const told=f.events.find(e=>e[0]==='stale');assert.ok(told,'sent, not swallowed by the failed key');assert.equal(told[1],REBUILD_NEEDED);
 assert.match(told[2],/approved images were not deployed.*builds them again/);
 assert.equal(readJournal(path.join(folder,KEPT_NOTICES)).unsent.length,0);
 assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(out,'release-events.json'),'utf8'))).some(k=>/^odc-1\.7\.33:a1:stale#\d+$/.test(k)));
});

test('R6 B9: two kept notices of one kind and attempt both reach the owner, once each',async t=>{
 const out=tmp(t),{keepNotice}=await import('./automatic.mjs');
 let up=false;const f=fakeOps(liveOf(first().manifest)),send=f.ops.event;f.ops.event=async(n,v)=>up?send(n,v):{remote:false,webhook:false};
 assert.equal(await keepNotice(f.ops,{outDir:out,id:'o11-11.55.96',attempt:'a1'},'dropped','o11-11.55.96: first','APPROVED_RELEASE_CHANGED'),1);
 assert.equal(await keepNotice(f.ops,{outDir:out,id:'o11-11.55.96',attempt:'a1'},'dropped','o11-11.55.96: second',REBUILD_NEEDED),2,'added, not replaced');
 assert.equal(await keepNotice(f.ops,{outDir:out,id:'o11-11.55.96',attempt:'a1'},'dropped','o11-11.55.96: second',REBUILD_NEEDED),2,'the same notice again is not doubled');
 up=true;assert.equal(await resendKept(f.ops,{outDir:out,id:'o11-11.55.96'}),0);
 assert.deepEqual(f.events.map(e=>e[2]),['o11-11.55.96: first','o11-11.55.96: second']);
 assert.equal(await resendKept(f.ops,{outDir:out,id:'o11-11.55.96'}),0);assert.equal(f.events.length,2);
});

// S2 R6 B10: owner-notices.json is replaced durably (temp, fsync, rename); a truncated one is set aside and the owner told.
test('R6 B10: kept notices are written durably; an unreadable file is set aside, told, and never stops the round',async t=>{
 const out=tmp(t),{keepNotice}=await import('./automatic.mjs'),{durableWrite}=await import('./journal.mjs');
 const f=fakeOps(liveOf(first().manifest)),logs=[];f.ops.log=m=>logs.push(m);
 const folder=path.join(out,'odc-1.7.33');durableWrite(path.join(folder,KEPT_NOTICES),'{"unsent":[{"name":"stale","mess');
 assert.ok(!fs.existsSync(path.join(folder,KEPT_NOTICES+'.next')));
 assert.equal(await resendKept(f.ops,{outDir:out,id:'odc-1.7.33'}),0);
 const aside=fs.readdirSync(folder).find(n=>n.startsWith(KEPT_NOTICES+'.unreadable-'));assert.ok(aside,'set aside, not lost');
 assert.equal(fs.readFileSync(path.join(folder,aside),'utf8'),'{"unsent":[{"name":"stale","mess');
 assert.ok(f.events.some(e=>e[0]==='notices-unreadable'&&e[1]==='NOTICES_UNREADABLE'&&e[2].includes(aside)));
 assert.match(logs.join('\n'),/unreadable/);
 fs.writeFileSync(path.join(folder,KEPT_NOTICES),'{');
 assert.equal(await keepNotice(f.ops,{outDir:out,id:'odc-1.7.33',attempt:'a2'},'stale','odc-1.7.33: kept',REBUILD_NEEDED),0);
 assert.ok(f.events.some(e=>e[2]==='odc-1.7.33: kept'));
 assert.deepEqual(fs.readdirSync(folder).filter(n=>n.endsWith('.next')),[]);
});

// S2 R6 B11: every backend runs one default O11 kernel. An O11 round stopped mid-way before any change restores the kernel.json it
// staged; a resumed one writes them all again; any other window round aligns a retained backend left on another default first.
function o11Round(m,{defaultO11='11.55.95'}={}){
 const builts=m.backends.map((b,i)=>({odc:b.odc,kernels:[...m.o11.served,'11.55.96'],defaultO11,o11:defaultO11,image:'img',tag:'k'+i,sha256:String(i).repeat(64)}));
 const next=rotateLane(m,'o11','11.55.96',{now:NOW,images:Object.fromEntries(builts.map(b=>[b.odc,{image:b.image,tag:b.tag}])),tokens});
 const kernels=Object.fromEntries(m.backends.map(b=>['odc-'+b.odc,{odc:b.odc,o11:defaultO11,odcBridge:'v109'}]));
 return {builts,next,kernels,w:{kind:'add',lane:'o11',version:'11.55.96',builts,kernels,defaultO11,retiring:next.retiring,retired:next.retired,affected:[],prepare:Object.keys(kernels)}};
}
const onDefault=(manifest,o11,other={})=>({...liveOf(manifest),kernels:Object.fromEntries(manifest.backends.map(b=>['odc-'+b.odc,{odc:b.odc,o11:other['odc-'+b.odc]??o11,odcBridge:'v109'}]))});
function recordPrepares(f,{failAt}={}){
 const seen=[];let n=0;
 f.ops.prepare=async(s,r)=>{n++;if(n===failAt)throw Object.assign(Error('ssh lost'),{environmental:true});seen.push([r.service,r.kernel?.o11,!!r.repair,r.built?.tag]);};
 return seen;
}
test('R6 B11: an O11 round that stops mid-prepare before any change restores the kernel.json it staged, with the live images',async t=>{
 const dir=tmp(t),m=first().manifest,live=onDefault(m,'11.55.94'),{builts,next,kernels,w}=o11Round(m);
 const f=fakeOps(live),seen=recordPrepares(f,{failAt:3});
 const r=await releaseAutomatically({outDir:dir},f.ops,{id:'o11-11.55.96',dir,attempt:'a1',baseline:live,built:builts[0],manifest:next.manifest,kernel:kernels['odc-1.7.32'],bridges:{mode:'server-only'},features:null,bundles:{},window:w});
 assert.equal(r.status,'deferred');assert.ok(!f.calls.includes('compose')&&!f.calls.includes('deploy'));
 // Two written with the new default, the third lost: the three staged ones go back to the live default in their live image.
 assert.deepEqual(seen.slice(0,2).map(p=>[p[0],p[1],p[2]]),[['odc-1.7.32','11.55.95',false],['odc-1.7.31','11.55.95',false]]);
 assert.deepEqual(seen.slice(2).map(p=>[p[0],p[1],p[2],p[3]]),['odc-1.7.32','odc-1.7.31','odc-1.7.30'].map(n=>[n,'11.55.94',true,m.backends.find(b=>'odc-'+b.odc===n).tag]));
 const state=readJournal(path.join(dir,'deployment.json'));
 assert.equal(state.kernelStaged,undefined);assert.ok(state.kernelRestored);assert.equal(state.steps.prepared,undefined);
});

test('R6 B11: a restore that fails is kept for the owner and the next round aligns; a resumed O11 round writes every kernel.json again',async t=>{
 const dir=tmp(t),out=tmp(t),m=first().manifest,live=onDefault(m,'11.55.94'),{builts,next,kernels,w}=o11Round(m);
 const f=fakeOps(live);let n=0;f.ops.prepare=async(s,r)=>{n++;if(n>=2)throw Object.assign(Error('ssh lost'),{environmental:true});};
 await releaseAutomatically({outDir:out},f.ops,{id:'o11-11.55.96',dir,attempt:'a1',baseline:live,built:builts[0],manifest:next.manifest,kernel:kernels['odc-1.7.32'],bridges:{mode:'server-only'},features:null,bundles:{},window:w});
 assert.deepEqual(readJournal(path.join(dir,'deployment.json')).kernelRestoreFailed,['odc-1.7.32','odc-1.7.31']);
 assert.ok(f.events.some(e=>e[0]==='kernel-restore-failed'&&e[1]==='KERNEL_RESTORE_FAILED'));
 // A vigia that stopped in the middle of the prepare: the resumed round writes every backend's kernel.json, then deploys.
 const dir2=tmp(t);fs.writeFileSync(path.join(dir2,'deployment.json'),JSON.stringify({schema:2,id:'o11-11.55.96',attempt:'a1',steps:{},status:'preparing',kernelStaged:['odc-1.7.32','odc-1.7.31'],baseline:live}));
 const g=fakeOps(live),seen=recordPrepares(g);
 const r=await releaseAutomatically({outDir:out},g.ops,{id:'o11-11.55.96',dir:dir2,attempt:'a1',baseline:live,built:builts[0],manifest:next.manifest,kernel:kernels['odc-1.7.32'],bridges:{mode:'server-only'},features:null,bundles:{},window:w});
 assert.equal(r.status,'live');
 assert.deepEqual(seen.map(p=>[p[0],p[1]]),Object.keys(kernels).map(k=>[k,'11.55.95']));
 assert.ok(g.calls.indexOf('compose')>g.calls.lastIndexOf('pin'));
});

test('R6 B11: an ODC round first aligns a retained backend an interrupted O11 prepare left on another default; its rollback accepts it',async t=>{
 const dir=tmp(t),m=first().manifest,live=onDefault(m,'11.55.95',{'odc-1.7.30':'11.55.94'});
 const built={odc:'1.7.33',kernels:m.o11.served,defaultO11:'11.55.95',o11:'11.55.95',image:'img',tag:'t33',sha256:sha('f')};
 const next=rotateLane(m,'odc','1.7.33',{now:NOW,images:{image:'img',tag:'t33'},tokens});
 const w={kind:'add',lane:'odc',version:'1.7.33',builts:[built],kernels:{'odc-1.7.33':{odc:'1.7.33',o11:'11.55.95',odcBridge:'v110'}},defaultO11:'11.55.95',retiring:next.retiring,retired:next.retired,affected:[],prepare:['odc-1.7.33']};
 const f=fakeOps(live,{fail:'checks'}),seen=recordPrepares(f);
 const order=[];const write=f.ops.writeCompose;f.ops.writeCompose=async(s,c)=>{order.push(seen.length);return write(s,c);};
 const r=await releaseAutomatically({outDir:dir},f.ops,{id:'odc-1.7.33',dir,attempt:'a1',baseline:live,built,manifest:next.manifest,kernel:w.kernels['odc-1.7.33'],bridges:{mode:'server-only'},features:path.join(dir,'f.xml'),bundles:{},window:w});
 assert.deepEqual(seen.map(p=>[p[0],p[1],p[2]]),[['odc-1.7.33','11.55.95',false],['odc-1.7.30','11.55.95',true]]);
 assert.equal(seen[1][3],m.backends.find(b=>b.odc==='1.7.30').tag,'in its live image');
 assert.deepEqual(order,[2],'aligned before the compose is written');
 assert.equal(r.status,'rolled-back');assert.equal(f.ops.checked.kernelO11Also,'11.55.95');
 // One default everywhere: nothing to align.
 const g=fakeOps(liveOf(m)),again=recordPrepares(g),dir2=tmp(t);
 await releaseAutomatically({outDir:dir2},g.ops,{id:'odc-1.7.33',dir:dir2,attempt:'a1',baseline:liveOf(m),built,manifest:next.manifest,kernel:w.kernels['odc-1.7.33'],bridges:{mode:'server-only'},features:path.join(dir2,'f.xml'),bundles:{},window:w});
 assert.deepEqual(again.map(p=>p[0]),['odc-1.7.33']);
});
