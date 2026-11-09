// Window 4x4, S2 R6 (C:\t\r5\janela-4x4\S2-REVISAO-R2.md). M5: after a compose-only O11 retirement the images still carry the
// retired kernel; the live baseline reads each image's real kernels from its label, so the next ODC round (new Service Studio
// -> 7-day grace -> retirement -> new ODC Studio) declares for every retained backend exactly what its image carries and the
// post-deploy kernels check passes instead of rolling back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromPairs,rotateLane,retireDue,pinDigests} from './window.mjs';
import {generateCompose} from '../coolify/gen-compose.mjs';
import {liveBaseline,assertRetained} from './safety.mjs';
import {expectedKernelsOf} from './auto-runtime.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const NOW=Date.parse('2026-11-09T12:00:00Z'),DAY=86400000;
const sha=c=>c.repeat(64);
const only=(m,digests)=>Object.fromEntries(m.backends.filter(b=>!b.sha256).map(b=>[b.tag,digests[b.tag]]));
const pairs=JSON.parse(fs.readFileSync(path.join(here,'../coolify/versions.json'),'utf8'));
const K=['11.55.92','11.55.93','11.55.94','11.55.95'],K96=[...K,'11.55.96'],K93=K96.slice(1);

// What the VPS shows of a pinned window: the compose generated from it and, per running backend, the snapshot row of
// remote-release.py (labels, image reference, digest, kernel.json, the image's label ssam.kernels.o11 as kernels).
function air(m,labelOf,{kernels=true}={}){
 const compose=generateCompose(m),services=Object.values(compose.services).filter(s=>s.labels?.['ssam.backend']==='true');
 const backends=services.map(s=>{const b=m.backends.find(x=>x.odc===s.labels['ssam.odc']);
  return {odc:b.odc,o11:s.labels['ssam.o11'],reference:s.image,digest:'sha256:'+String(b.sha256).replace(/^sha256:/,''),kernel:{odc:b.odc,o11:'11.55.95',odcBridge:'v109'},...(kernels?{kernels:labelOf[b.tag]}:{})};});
 return {compose:JSON.stringify(compose),hash:'h-'+m.backends.map(b=>b.tag).join(),backends,telemetry:{tokens:{}},usage:null};
}
// remote-release.py check (expectedKernels): every running image's label is exactly the declared set of its backend, and holds
// every served O11 version.
function remoteCheck(pinned,labelOf){
 const want=expectedKernelsOf(pinned);
 for(const b of pinned.backends){
  const have=labelOf[b.tag];
  if([...have].sort().join()!==[...want[b.odc]].sort().join()||pinned.o11.served.some(v=>!have.includes(v)))return 'IMAGE_KERNELS_DIFFER';
 }
 return 'ok';
}

test('R6 M5: new Service Studio -> 7-day grace -> retirement -> new ODC Studio: the retained images declare their real kernels, no rollback',()=>{
 const labelOf={},digests={};let n=0;
 const build=(odc,tag,kernels)=>{labelOf[tag]=kernels;digests[tag]='sha256:'+sha((++n%10).toString());return {image:'docker.io/x/ssam-server',tag,kernels};};
 // W0, the first window: five backends built with .92-.95.
 const w0=fromPairs(pairs,{now:NOW,images:Object.fromEntries(['1.7.32','1.7.31','1.7.30','1.7.29','1.7.28'].map(v=>{const i=build(v,'w0-'+v,K);return [v,{...i,sha256:digests[i.tag].slice(7)}];}))}).manifest;
 let live=liveBaseline(air(w0,labelOf));
 assert.ok(live.manifest.backends.every(b=>b.o11Kernels.join()===K.join()),'the baseline reads the image label');
 // The new Service Studio 11.55.96: every image rebuilt with .92-.96, .92 enters its grace.
 const o11=rotateLane(live.manifest,'o11','11.55.96',{now:NOW+DAY,images:Object.fromEntries(live.manifest.backends.map(b=>[b.odc,build(b.odc,'k96-'+b.odc,K96)]))});
 assert.equal(o11.manifest.retiring.o11.version,'11.55.92');
 const p1=pinDigests(o11.manifest,only(o11.manifest,digests));
 assertRetained(live,p1,{lane:'o11',built:Object.fromEntries(p1.backends.map(b=>[b.tag,digests[b.tag].slice(7)])),images:Object.fromEntries(p1.backends.map(b=>[b.tag,{odc:b.odc,kernels:labelOf[b.tag]}]))});
 assert.equal(remoteCheck(p1,labelOf),'ok');
 // Day 7: ODC 1.7.28 leaves (compose only), read back from the air.
 live=liveBaseline(air(p1,labelOf));
 const p2=retireDue(live.manifest,{now:NOW+7*DAY}).manifest;
 assert.deepEqual(p2.backends.map(b=>b.odc),['1.7.32','1.7.31','1.7.30','1.7.29']);
 assertRetained(live,p2,{});assert.equal(remoteCheck(p2,labelOf),'ok');
 // Day 8: Service Studio 11.55.92 leaves o11.served (compose only); the images keep its kernel.
 live=liveBaseline(air(p2,labelOf));
 const p3=retireDue(live.manifest,{now:NOW+8*DAY}).manifest;
 assert.deepEqual(p3.o11.served,K93);
 assertRetained(live,p3,{});assert.equal(remoteCheck(p3,labelOf),'ok');
 // Day 9: the new ODC Studio 1.7.33, its image built with the served kernels .93-.96, on the window read from the air.
 live=liveBaseline(air(p3,labelOf));
 assert.deepEqual(live.manifest.o11.served,K93,'served stays the served list');
 assert.ok(live.manifest.backends.every(b=>b.o11Kernels.join()===K96.join()),'o11Kernels is what each image carries: .92 too');
 const odc=rotateLane(live.manifest,'odc','1.7.33',{now:NOW+9*DAY,images:build('1.7.33','t33',K93)});
 const p4=pinDigests(odc.manifest,only(odc.manifest,digests));
 assertRetained(live,p4,{lane:'odc',built:{t33:digests.t33.slice(7)},images:{t33:{odc:'1.7.33',kernels:K93}}});
 assert.deepEqual(expectedKernelsOf(p4)['1.7.32'],K96);assert.deepEqual(expectedKernelsOf(p4)['1.7.33'],K93);
 assert.equal(remoteCheck(p4,labelOf),'ok','the deploy is verified, not rolled back');
 // Before R6 the read-back window declared the served list for the retained images: the check rolled the deploy back.
 const before=structuredClone(p4);for(const b of before.backends)if(b.odc!=='1.7.33')delete b.o11Kernels;
 assert.equal(remoteCheck(before,labelOf),'IMAGE_KERNELS_DIFFER');
 // Now that mistake stops before any change: the pre-check compares a retained image with what the air says it carries.
 assert.throws(()=>assertRetained(live,before,{lane:'odc',built:{t33:digests.t33.slice(7)},images:{t33:{odc:'1.7.33',kernels:K93}}}),e=>e.code==='IMAGE_KERNELS_DIFFER'&&/retained backend odc-1\.7\.32/.test(e.message));
});

test('R6 M5: a live backend image without its kernels label, or without the kernel of a served version, is no baseline',()=>{
 const labelOf={},m=fromPairs(pairs,{now:NOW,images:Object.fromEntries(['1.7.32','1.7.31','1.7.30','1.7.29','1.7.28'].map((v,i)=>{labelOf['t'+v]=K;return [v,{image:'img',tag:'t'+v,sha256:sha(String(i+1)),kernels:K}];}))}).manifest;
 assert.throws(()=>liveBaseline(air(m,labelOf,{kernels:false})),e=>e.code==='LIVE_INVALID'&&/does not name its O11 kernels/.test(e.message));
 assert.throws(()=>liveBaseline(air(m,{...labelOf,'t1.7.30':K.slice(1)})),e=>e.code==='LIVE_INVALID'&&/lacks the kernel of a served O11 version/.test(e.message));
 assert.throws(()=>liveBaseline(air(m,{...labelOf,'t1.7.30':['11.55.92','11.55']})),e=>e.code==='LIVE_INVALID');
});
