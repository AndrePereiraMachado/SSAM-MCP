// window-images.test.mjs: the release images in one command (trilha D, IMAGENS.md 12), offline (no build, no push). From server/:
//   node --test deploy/window-images/tests/window-images.test.mjs
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {windowSpecs,pairsOf,publishedImages,imagesJson,pairsVersions,readBuilt,backendVersions,studioSourcesOf,tfmOf,backendTag,pairTag} from '../window-images.mjs';
import {studioTrust,trustedSources} from '../../gen-dockerfile.mjs';
import * as vigia from '../../vigia/window.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),server=path.resolve(here,'../../..');
const versions=JSON.parse(fs.readFileSync(path.join(server,'deploy/coolify/versions.json'),'utf8'));
const opts={commit:'abc1234',date:'20261111'};

test('specs: the window 4x4 from the pair window, every Studio from its pair image, newest ODC first, the vigia tags',()=>{
 const plan=windowSpecs(versions,opts),pairs=pairsOf(versions);
 assert.deepEqual(plan.map(p=>p.odc),[...pairs.map(p=>p.odc.version)].sort().reverse());
 const kernels=[...new Set(pairs.map(p=>p.o11.version))].sort();
 for(const p of plan){
  const pair=pairs.find(x=>x.odc.version===p.odc);
  assert.deepEqual(p.kernels,kernels);assert.equal(p.default,pair.o11.version,'the default O11 is the pair\'s');
  assert.equal(p.spec.odc.fromImage,`${pair.odc.image}@sha256:${pair.odc.sha256}`);
  for(const s of p.spec.o11){const src=pairs.find(x=>x.o11.version===s.version).o11;assert.equal(s.fromImage,`${src.image}@sha256:${src.sha256}`,'the first pair image with that O11');}
  assert.equal(p.tag,backendTag({odc:p.odc,kernels},'abc1234','20261111'));assert.equal(p.ref,'docker.io/andrepereiramachado/ssam-server:'+p.tag);
  if(vigia.backendTag)assert.equal(p.tag,vigia.backendTag({odc:p.odc,kernels},'abc1234','20261111'),'the vigia format');
  assert.deepEqual(p.sources,[...new Set([...p.spec.o11.map(s=>s.fromImage),p.spec.odc.fromImage])]);
 }
 assert.equal(tfmOf('o11','11.55.93'),'net8.0');assert.equal(tfmOf('o11','11.55.94'),undefined);assert.equal(tfmOf('odc','1.7.29'),'net8.0');assert.equal(tfmOf('odc','1.7.30'),undefined);
 const odc28=plan.find(p=>p.odc==='1.7.28');if(odc28)assert.equal(odc28.spec.odc.tfm,'net8.0');
});

// Trilha B, A4-1 (PARA-TRILHA-D-A4-1.md): the hub keeps the pair window only while a pair image declares ONE O11 version in
// SSAM_IMAGE_O11; a list shrinks the window to the image's kernels and refuses the bridges of the other served versions.
test('pairs mode (A4-1): one O11 Studio per spec, and the generated Dockerfile declares SSAM_IMAGE_O11 with one version',async()=>{
 const {generateDockerfile,checkoutTrust}=await import('../../gen-dockerfile.mjs');
 const base=fs.readFileSync(path.join(server,'Dockerfile'),'utf8'),trust=checkoutTrust();
 for(const x of windowSpecs(versions,{...opts,mode:'pairs'})){
  assert.equal(x.kernels.length,1,x.odc);assert.equal(x.spec.o11.length,1,x.odc);
  const m=/^ARG SSAM_IMAGE_O11=(.*)$/m.exec(generateDockerfile(base,x.spec,{trust}));
  assert.ok(m,'ARG SSAM_IMAGE_O11 in the Dockerfile of '+x.odc);assert.equal(m[1],x.kernels[0],x.odc);assert.ok(!m[1].includes(','),x.odc);
 }
});

test('specs: --release after the date, --ensaio, and the pair mode (one O11 + one ODC per image)',()=>{
 const r=windowSpecs(versions,{...opts,release:'r46'});assert.match(r[0].tag,/^prod-20261111-r46-abc1234-odc\d+-o11k[0-9a-f]{8}$/);
 const e=windowSpecs(versions,{...opts,release:'r46',ensaio:true,image:'ssam-ensaio'});assert.match(e[0].tag,/^ensaio-20261111-r46-abc1234-/);assert.equal(e[0].ref,'ssam-ensaio:'+e[0].tag);
 const p=windowSpecs(versions,{...opts,mode:'pairs'});
 for(const x of p){assert.equal(x.kernels.length,1);assert.equal(x.spec.o11[0].fromImage,x.spec.odc.fromImage,'one pair image');assert.equal(x.tag,pairTag({odc:x.odc,o11:x.default},'abc1234','20261111'));
  if(vigia.pairTag)assert.equal(x.tag,vigia.pairTag({odc:x.odc,o11:x.default},'abc1234','20261111'));}
 for(const [what,o,re] of [['commit',{commit:'xyz'},/--commit/],['date',{date:'2026-11-11'},/--date/],['release',{release:'46'},/--release/],['mode',{mode:'x'},/--mode/]])
  assert.throws(()=>windowSpecs(versions,{...opts,...o}),re,what);
 assert.throws(()=>windowSpecs({...versions,backends:[]},opts),/already a backend window/);
 const split=structuredClone(versions);split.o11[0].sha256='f'.repeat(64);assert.throws(()=>windowSpecs(split,opts),/is not one image in both lanes/);
});

const built=[{id:'odc-1.7.32',mode:'backends',odc:'1.7.32',tag:'prod-x-odc1732',ref:'reg/img:prod-x-odc1732',imageId:'sha256:'+'1'.repeat(64),default:'11.55.95',kernels:['11.55.92','11.55.95'],metadataDigest:'sha256:'+'a'.repeat(64)}];
const fake=({id='sha256:'+'1'.repeat(64),digests=['reg/img@sha256:'+'a'.repeat(64)],kernels='11.55.92,11.55.95'}={})=>args=>args.includes('{{.Id}}')?id:args.includes('{{json .RepoDigests}}')?JSON.stringify(digests):kernels;
test('images: the pushed digest from RepoDigests, the same local image, the build digest; refusals',()=>{
 const p=publishedImages(built,{inspect:fake()});assert.equal(p[0].sha256,'a'.repeat(64));assert.equal(p[0].image,'reg/img');
 assert.deepEqual(imagesJson(p),{'1.7.32':{image:'reg/img',tag:'prod-x-odc1732',sha256:'a'.repeat(64),kernels:['11.55.92','11.55.95']}});
 assert.throws(()=>publishedImages(built,{inspect:fake({digests:[]})}),/push it first \(docker push reg\/img:prod-x-odc1732\)/);
 assert.throws(()=>publishedImages(built,{inspect:fake({id:'sha256:'+'2'.repeat(64)})}),/not the image that passed the smoke/);
 assert.throws(()=>publishedImages(built,{inspect:fake({digests:['reg/img@sha256:'+'b'.repeat(64)]})}),/is not the build's/);
 assert.throws(()=>publishedImages(built,{inspect:fake({kernels:'11.55.95'})}),/label ssam.kernels.o11/);
 assert.throws(()=>publishedImages(built,{inspect:fake(),fromMetadata:true}),/ensaio images only/);
 const e=[{...built[0],tag:'ensaio-x',ref:'ssam-ensaio:ensaio-x'}];assert.equal(publishedImages(e,{inspect:fake({digests:[]}),fromMetadata:true})[0].sha256,'a'.repeat(64));
});

test('images (pairs): the pair window with each pair\'s new image, nothing else',()=>{
 const pairs=pairsOf(versions),pub=pairs.map(({odc,o11},i)=>({odc:odc.version,default:o11.version,image:'reg/img',tag:'prod-new-'+i,sha256:String(i).repeat(64).slice(0,64).replace(/\d/g,'c')}));
 const v=pairsVersions(versions,pub);
 v.odc.forEach((e,i)=>{assert.equal(e.tag,'prod-new-'+i);assert.deepEqual(v.o11[i].tag,e.tag);});
 assert.deepEqual({...v,odc:0,o11:0,studioSources:0},{...versions,odc:0,o11:0,studioSources:0},'every other field stays');
 for(const e of [...v.odc,...v.o11])assert.equal(e.studioFrom,'image','the new pair images are copies');
 assert.deepEqual(v.studioSources,studioSourcesOf(versions),'the bundle-built pair images stay sources');
 // The next build from that versions.json: the old pair images are trusted, the new ones (copies) refused.
 const tr=studioTrust(v),old=pairs[0].odc;
 assert.equal(trustedSources([],{version:old.version,fromImage:`${old.image}@sha256:${old.sha256}`},tr).length,1);
 assert.throws(()=>trustedSources([],{version:old.version,fromImage:`reg/img@sha256:${pub[0].sha256}`},tr),/studioFrom "image"/);
 assert.throws(()=>pairsVersions(versions,pub.slice(1)),/no new image for pair/);
 // The canary (--only one ODC, --partial): that pair moves, every other entry stays as it was.
 const last=pub.length-1,c=pairsVersions(versions,[pub[last]],{partial:true});
 assert.equal(c.odc[last].tag,pub[last].tag);assert.equal(c.o11[last].studioFrom,'image');
 for(let i=0;i<last;i++){assert.deepEqual(c.odc[i],versions.odc[i]);assert.deepEqual(c.o11[i],versions.o11[i]);}
 assert.deepEqual(c.studioSources,studioSourcesOf(versions));
 assert.throws(()=>pairsVersions(versions,[],{partial:true}),/no new image/);
 assert.throws(()=>pairsVersions(versions,[{...pub[0],odc:'9.9.9'}],{partial:true}),/not pairs of versions.json/);
 // The correction window: two builds (one per source commit) read as one list hold every pair once; a pair twice is refused.
 const files={a:pub.slice(0,last).map(p=>({...p,mode:'pairs'})),b:[{...pub[last],mode:'pairs'}]};
 const both=readBuilt('a, b',k=>files[k]);assert.equal(both.length,pub.length);
 assert.deepEqual(pairsVersions(versions,both),v,'two built.json give the same versions.json as one');
 assert.throws(()=>pairsVersions(versions,[...pub,pub[0]]),/built twice/);
 assert.throws(()=>pairsVersions(versions,[pub[0],pub[0]],{partial:true}),/built twice/);
 assert.throws(()=>readBuilt('a,c',k=>k==='a'?files.a:[{mode:'backends'}]),/different modes/);
});

test('build-window-images.sh refuses another HEAD, a commit off the remote main, and needs --release for production',()=>{
 const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash',script=path.join(server,'deploy/window-images/build-window-images.sh').replace(/\\/g,'/');
 const run=(...a)=>cp.spawnSync(bash,[script,...a],{encoding:'utf8'});
 const head=cp.execFileSync('git',['-C',server,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),parent=cp.execFileSync('git',['-C',server,'rev-parse','HEAD~1'],{encoding:'utf8'}).trim();
 const other=run('--commit',parent,'--ensaio');assert.equal(other.status,2);assert.match(other.stderr,/HEAD is [0-9a-f]+, not /);
 assert.match(run().stderr,/--commit <sha>/);assert.match(run('--commit',head,'--mode','x').stderr,/--mode backends\|pairs/);
 const dirty=cp.execFileSync('git',['-C',server,'status','--porcelain','--untracked-files=normal','--','.'],{encoding:'utf8'}).trim();
 const prod=run('--commit',head);assert.equal(prod.status,2);
 assert.match(prod.stderr,dirty?/not clean/:/not on the remote main|no refs\/remotes\/origin\/main|not signed|--release rNN/);
});

test('after the window: the backend versions.json keeps the pair images as studioSources, and the generator trusts only them',()=>{
 const pairs=pairsOf(versions),k=[...new Set(pairs.map(p=>p.o11.version))].sort();
 const manifest={window:5,o11:{served:k},backends:pairs.map(p=>({odc:p.odc.version,image:'reg/img',tag:'prod-w-'+p.odc.version,sha256:'d'.repeat(64),o11Kernels:k}))};
 const v=backendVersions(manifest,versions);
 assert.deepEqual(v.backends,manifest.backends);assert.ok(v.studioSources.length>=pairs.length);
 const tr=studioTrust(v),p=pairs[0],at=e=>e.image+'@sha256:'+e.sha256;
 assert.equal(trustedSources([{version:p.o11.version,fromImage:at(p.o11)}],{version:p.odc.version,fromImage:at(p.odc)},tr).length,2,'the pair images stay sources');
 assert.throws(()=>trustedSources([],{version:p.odc.version,fromImage:'reg/img@sha256:'+'d'.repeat(64)},tr),/backend window is a copy/,'a backend image is never a source');
 assert.throws(()=>trustedSources([{version:k[0],fromImage:'reg/img@sha256:'+'d'.repeat(64)}],null,tr),/backend window is a copy/);
 assert.throws(()=>studioTrust(manifest),/backend window without studioSources/,'without them the generator says why');
 assert.throws(()=>studioSourcesOf({odc:[{...versions.odc[0],studioFrom:'image'}],o11:[{...versions.o11[0],studioFrom:'image'}]}),/no image built from bundles/);
});
