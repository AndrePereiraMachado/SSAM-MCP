// Window 4x4, S2 x S1 R3 (reader residency): the O11 reader settings of every backend follow the window's O11 list through a
// rotation and a compose-only retirement. During the grace the retiring Service Studio is served, its reader folders stay and
// the reader ceiling counts it; once it left SSAM_SERVED_VERSIONS, the ceiling drops and its reader folders are pruned like
// those of a version the image no longer carries (the retirement deploy recreates the containers, so its live readers end).
import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromPairs,rotateLane,retireDue,pinDigests} from './window.mjs';
import {generateCompose} from '../coolify/gen-compose.mjs';
import {preserveCompose} from './safety.mjs';
import {admitReader,readerO11Versions,setServedO11Versions} from '../../platforms/odc/facade/reader-client.mjs';
import {writeReaderMeta} from '../../platforms/odc/facade/reader-residency.mjs';
import {createMemoryGate} from '../../platforms/odc/facade/memory-room.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const NOW=Date.parse('2026-11-09T12:00:00Z'),DAY=86400000;
const pairs=JSON.parse(fs.readFileSync(path.join(here,'../coolify/versions.json'),'utf8'));
const images=Object.fromEntries(pairs.odc.map(e=>[e.version,{image:e.image,tag:e.tag,sha256:e.sha256}]));
const backends=compose=>Object.values(compose.services).filter(s=>s.environment?.SSAM_BACKEND_NAME);
const pin=m=>pinDigests(m,Object.fromEntries(m.backends.filter(b=>!b.sha256).map(b=>[b.tag,'sha256:'+'c'.repeat(64)])));
// The window after an O11 round (11.55.96 in, 11.55.92 retiring) and after that retirement is due.
function windows(){
 const m=fromPairs(pairs,{now:NOW,images}).manifest;
 const o11=pin(rotateLane(m,'o11','11.55.96',{now:NOW,images:Object.fromEntries(m.backends.map(b=>[b.odc,{image:'img',tag:'k'+b.odc.replaceAll('.','')}]))}).manifest);
 const retired=retireDue(retireDue(o11,{now:NOW+7*DAY}).manifest,{now:NOW+7*DAY}).manifest;
 return {o11,retired};
}

test('the reader ceiling and the served list of every backend follow the O11 window through the grace and the retirement',()=>{
 const {o11,retired}=windows();
 assert.equal(o11.retiring.o11.version,'11.55.92');
 for(const s of backends(generateCompose(o11))){
  assert.equal(s.environment.SSAM_O11_READERS_MAX,'5','the retiring version is still served: it counts');
  const served=JSON.parse(s.environment.SSAM_SERVED_VERSIONS);
  assert.ok(served.o11.includes('11.55.92'));assert.equal(served.retiring.o11.version,'11.55.92');
 }
 assert.deepEqual(retired.o11,{served:['11.55.93','11.55.94','11.55.95','11.55.96'],kernels:['11.55.92','11.55.93','11.55.94','11.55.95','11.55.96']});
 for(const s of backends(generateCompose(retired))){
  assert.equal(s.environment.SSAM_O11_READERS_MAX,'4');
  assert.deepEqual(JSON.parse(s.environment.SSAM_SERVED_VERSIONS).o11,['11.55.93','11.55.94','11.55.95','11.55.96']);
 }
});

test('the retirement compose written over the live one carries the new ceiling and list, not the live ones',()=>{
 const {o11,retired}=windows();
 const live=JSON.stringify(generateCompose(o11));
 // Both retirements fall due together here (1.7.28 and 11.55.92 entered with the same grace): the ODC backend goes, the others stay.
 const written=JSON.parse(preserveCompose({compose:live},retired,{added:[],retired:[{lane:'odc',version:'1.7.28'},{lane:'o11',version:'11.55.92'}]}));
 const list=backends(written);
 assert.equal(list.length,4);
 for(const s of list){
  assert.equal(s.environment.SSAM_O11_READERS_MAX,'4');
  assert.deepEqual(JSON.parse(s.environment.SSAM_SERVED_VERSIONS).o11,['11.55.93','11.55.94','11.55.95','11.55.96']);
 }
 // A served list that moves by anything else than the round's own versions is refused.
 assert.throws(()=>preserveCompose({compose:live},retired,{added:[],retired:[{lane:'odc',version:'1.7.28'}]}),e=>e.code==='SERVED_LIST_CHANGED');
});

test('reader folders: a retiring Service Studio keeps its folders, one removed from SSAM_SERVED_VERSIONS loses them',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'s2-readers-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const studios=path.join(root,'studio'),clis=path.join(root,'cli'),platform=path.join(root,'cache','o11');
 const {o11,retired}=windows(),envOf=m=>({SSAM_IMAGE_O11:'11.55.92,11.55.93,11.55.94,11.55.95,11.55.96',SSAM_O11_STUDIO_ROOT:studios,SSAM_O11_CLI_ROOT:clis,SSAM_SERVED_VERSIONS:backends(generateCompose(m))[0].environment.SSAM_SERVED_VERSIONS,SSAM_O11_READERS_MAX:backends(generateCompose(m))[0].environment.SSAM_O11_READERS_MAX});
 const old=path.join(platform,'gen92');fs.mkdirSync(path.join(old,'bin'),{recursive:true});writeReaderMeta(old,{dll:'/cli/anvil.dll',runtimeDir:path.join(studios,'11.55.92')});
 const gate=()=>createMemoryGate({room:()=>8000,settings:{reserveMb:1400,odcReserveMb:600,waitMs:60,growMs:15000}});
 const rpc=async()=>{throw new Error('ECONNREFUSED');};
 const start=async env=>{const directory=path.join(platform,'gen96');fs.mkdirSync(directory,{recursive:true});const admission={};
  await admitReader({dll:path.join(clis,'11.55.96','cli','anvil.dll'),runtimeDir:path.join(studios,'11.55.96'),directory,authorization:'k'},admission,{env,gate:gate(),rpc});admission.hold?.release();return admission.residency;};
 const grace=await start(envOf(o11));
 assert.deepEqual(grace.pruned,[],'served while retiring: its reader folder stays');
 assert.ok(fs.existsSync(old));
 const after=await start(envOf(retired));
 assert.deepEqual(after.pruned,['gen92'],'no longer in SSAM_SERVED_VERSIONS: its folder goes, though the image still carries the kernel');
 assert.equal(fs.existsSync(old),false);
});

// Review S1 R3 B-S2-1: the hub always serves the default kernel (kernel.json o11, kernel-image.mjs o11ServedBuilds), also when
// SSAM_SERVED_VERSIONS leaves it out; its reader folders follow the same rule and are never pruned.
test('reader folders: the default kernel keeps its folders even when the served list leaves it out (B-S2-1)',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'s2-default-'));t.after(()=>{setServedO11Versions(null);fs.rmSync(root,{recursive:true,force:true});});
 const studios=path.join(root,'studio'),clis=path.join(root,'cli'),platform=path.join(root,'cache','o11'),runtime=path.join(root,'runtime');
 const {retired}=windows(),served=backends(generateCompose(retired))[0].environment.SSAM_SERVED_VERSIONS;
 assert.ok(!JSON.parse(served).o11.includes('11.55.92'));
 const env={SSAM_IMAGE_O11:'11.55.92,11.55.93,11.55.94,11.55.95,11.55.96',SSAM_O11_STUDIO_ROOT:studios,SSAM_O11_CLI_ROOT:clis,SSAM_SERVED_VERSIONS:served,SSAM_O11_READERS_MAX:'4'};
 const old=path.join(platform,'gen92'),seed=()=>{fs.mkdirSync(path.join(old,'bin'),{recursive:true});writeReaderMeta(old,{dll:'/cli/anvil.dll',runtimeDir:path.join(studios,'11.55.92')});};
 const gate=()=>createMemoryGate({room:()=>8000,settings:{reserveMb:1400,odcReserveMb:600,waitMs:60,growMs:15000}});
 const rpc=async()=>{throw new Error('ECONNREFUSED');};
 const start=async(e,deps={})=>{const directory=path.join(platform,'gen96');fs.mkdirSync(directory,{recursive:true});const admission={};
  await admitReader({dll:path.join(clis,'11.55.96','cli','anvil.dll'),runtimeDir:path.join(studios,'11.55.96'),directory,authorization:'k'},admission,{env:e,gate:gate(),rpc,...deps});admission.hold?.release();return admission.residency;};
 // The hub's list (ssam.mjs startupKernel: the keys of kernel.o11Builds, the default included) wins over the env.
 seed();setServedO11Versions(['11.55.92','11.55.93','11.55.94','11.55.95','11.55.96']);
 assert.deepEqual(readerO11Versions(env),['11.55.92','11.55.93','11.55.94','11.55.95','11.55.96']);
 assert.deepEqual((await start(env)).pruned,[],'the default kernel the hub serves keeps its folder');
 assert.ok(fs.existsSync(old));
 setServedO11Versions(['11.55.93','11.55.94','11.55.95','11.55.96']);
 assert.deepEqual((await start(env)).pruned,['gen92'],'a kernel the hub does not serve loses it');
 setServedO11Versions(null);
 // Without the hub's list: the default of <SSAM_RUNTIME_DIR>/kernel.json is kept beside the versions the env names.
 seed();fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(path.join(runtime,'kernel.json'),JSON.stringify({o11:'11.55.92',odc:'1.7.32'}));
 assert.deepEqual(readerO11Versions({...env,SSAM_RUNTIME_DIR:runtime}),['11.55.92','11.55.93','11.55.94','11.55.95','11.55.96']);
 assert.deepEqual((await start({...env,SSAM_RUNTIME_DIR:runtime})).pruned,[]);
 assert.deepEqual((await start(env,{defaultO11:'11.55.92'})).pruned,[]);
 assert.deepEqual(readerO11Versions(env),['11.55.93','11.55.94','11.55.95','11.55.96'],'no default known: the env alone');
 assert.deepEqual((await start(env)).pruned,['gen92']);
});
