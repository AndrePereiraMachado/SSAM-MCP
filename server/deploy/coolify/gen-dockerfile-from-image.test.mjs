// The second Studio source of the multi-O11 Dockerfile (deploy/gen-dockerfile.mjs, fromImage): a Studio folder copied from a
// production image named by its digest, instead of a pinned bundle. Applied to the real server/Dockerfile: the stage per
// image, the checks that stay the bundle's (kernel per version, SkiaSharp probe, check-image), the provenance labels and
// sha256 lists, the ODC Studio from an image; the refusals (no digest, latest, two sources...); a file of bundles only is
// untouched; studio-from-image.sh itself, run by bash on a fake image folder; and the trust list (trilha G review, D1, D2,
// D6): only the pair images of versions.json, for their own lane and version, never a copy of a copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {generateDockerfile,o11KernelList,slugOf,studioTrust,trustedSources,checkoutTrust} from '../gen-dockerfile.mjs';

const server=fileURLToPath(new URL('../../',import.meta.url));
const base=fs.readFileSync(path.join(server,'Dockerfile'),'utf8');
const count=(text,needle)=>text.split(needle).length-1;
const IMG='docker.io/andrepereiramachado/ssam-server@sha256:';
const ref=c=>IMG+c.repeat(64);
// The window 4x4 of one ODC backend: 11.55.92 and 11.55.93 (net8.0 Studios without runtimeconfig.json) from their pair images,
// 11.55.94 from a bundle (a mixed list), 11.55.95 from the r44 image; the ODC Studio 1.7.30 from its pair image.
const spec={default:'11.55.95',o11:[
 {version:'11.55.92',fromImage:ref('a'),tfm:'net8.0'},{version:'11.55.93',fromImage:ref('b'),tfm:'net8.0'},
 {version:'11.55.94',bundle:'o11-studio-11.55.94.65328.tar.gz',sha256:'c'.repeat(64)},{version:'11.55.95',fromImage:ref('d')}],
 odc:{version:'1.7.30',fromImage:ref('e')}};
// The trust list of these tests: a versions.json whose pair images are the fake digests above (D1: nothing outside it).
const img='docker.io/andrepereiramachado/ssam-server',pin=(version,c,more={})=>({version,tag:'prod-test',image:img,sha256:c.repeat(64),...more});
const versions={odc:[pin('1.7.29','f'),pin('1.7.30','e')],o11:[pin('11.55.92','a'),pin('11.55.93','b'),pin('11.55.95','d')]};
const trust=studioTrust(versions);

test('fromImage: each Studio from an image gets its stage by digest; the bundle entry and every later check stay as they were',()=>{
 const out=generateDockerfile(base,spec,{trust});
 assert.match(out.split('\n')[1],/; Studios from pinned images: o11 11\.55\.92, o11 11\.55\.93, o11 11\.55\.95, odc 1\.7\.30\. Do not edit/);
 assert.equal(count(out,'FROM studio-reader AS studio-image-reader\n'),1,'one reader stage');
 assert.equal(count(out,"COPY <<'EOF' /reader/studio-from-image.sh\n"),1);
 for(const e of spec.o11){
  const s=slugOf(e.version);
  if(e.fromImage){
   assert.equal(count(out,`FROM ${e.fromImage} AS studio-image-o11-${s}\n`),1,e.version+': the image by its digest');
   assert.equal(count(out,`FROM studio-image-reader AS studio-o11-${s}\n`),1,e.version);
   assert.equal(count(out,`COPY --from=studio-image-o11-${s} /studio/o11/ /from-image/\n`),1,e.version+': the pair image keeps its Studio in /studio/o11');
   assert.equal(count(out,`RUN --mount=type=bind,from=studio-image-o11-${s},source=/app,target=/origin-app \\\n    sh studio-from-image.sh o11 /from-image studio-o11.txt /studio/o11/${e.version} ${e.version} "${e.fromImage}" /origin-app\n`),1,e.version+': the source /app mounted for the chain check');
   assert.equal(count(out,`SERVICE_STUDIO_${s.replaceAll('-','_')} `),0,e.version+': no bundle pin for an image entry');
   assert.equal(count(out,`ssam.studio.o11.${e.version}.source="image ${e.fromImage}" \\\n`),1,e.version+': its source label');
   assert.equal(count(out,`COPY --from=studio-o11-${s} /studio-from-image/ /app/studio-from-image/\n`),1,e.version+': its sha256 list in the image');
  }else{
   assert.equal(count(out,`FROM studio-reader AS studio-o11-${s}\n`),1,e.version+': the bundle stage as before');
   assert.equal(count(out,`sh require-pinned.sh SERVICE_STUDIO_${s.replaceAll('-','_')} "-" "" "" "${e.bundle}" "${e.sha256}"`),1);
   assert.equal(count(out,`ssam.studio.o11.${e.version}.source="bundle ${e.bundle} sha256:${e.sha256}" \\\n`),1,e.version+': its source label');
  }
  // What comes after the Studio stage does not depend on the source.
  assert.equal(count(out,`FROM sdk AS kernel-o11-${s}\n`),1,e.version);
  assert.ok(out.includes(`-p:SSDir=/studio/o11/${e.version}${e.tfm?' -p:AnvilO11StudioTfm='+e.tfm:''} -o /out/kernel/.local/o11/${e.version}/cli`),e.version+': the kernel compiled against that folder');
  assert.equal(count(out,`COPY --from=studio-o11-${s} /studio/o11/${e.version} /studio/o11/${e.version}\n`),1,e.version);
  assert.equal(count(out,`"/studio/o11/${e.version}=${e.version}"`),1,e.version+': check-image reads its FileVersion');
 }
 // The ODC Studio from its image: the stage keeps the name studio-odc, the declared version is the entry's.
 assert.equal(count(out,`FROM ${spec.odc.fromImage} AS studio-image-odc\n`),1);
 assert.equal(count(out,'FROM studio-image-reader AS studio-odc\n'),1);
 assert.equal(count(out,'RUN --mount=type=bind,from=studio-image-odc,source=/app,target=/origin-app \\\n    sh studio-from-image.sh odc /from-image studio-odc.txt /studio/odc 1.7.30 "'+spec.odc.fromImage+'" /origin-app\n'),1);
 assert.equal(count(out,'      ssam.studio.from-image="o11 11.55.92,o11 11.55.93,o11 11.55.95,odc 1.7.30" \\\n'),1,'an image built from images is recognizable by its labels');
 assert.equal(count(out,'ssam.studio.trust.extra'),0,'versions.json only: no extra-trust label');
 assert.equal(count(out,'sh studio-extract.sh odc '),0,'no ODC bundle extraction');
 assert.match(out,/^ARG SSAM_IMAGE_ODC=1\.7\.30$/m);
 assert.ok(out.includes('RUN test "${SSAM_IMAGE_O11}" = "11.55.92,11.55.93,11.55.94,11.55.95" \\\n && test "${SSAM_IMAGE_ODC}" = "1.7.30" \\\n && node /app/platforms/odc/facade/kernel-image.mjs check-image '),'a build arg cannot make the ODC label lie');
 assert.ok(out.includes('"/studio/odc=${SSAM_IMAGE_ODC}"'));
 assert.equal(count(out,'ssam.studio.odc.1.7.30.source="image '+spec.odc.fromImage+'" \\\n'),1);
 assert.equal(count(out,'COPY --from=studio-odc /studio-from-image/ /app/studio-from-image/\n'),1);
 // The SkiaSharp natives, the libsqlite3 link and the probe are this build's, on every folder; the license notice stays.
 assert.ok(out.includes('for v in 11.55.92 11.55.93 11.55.94 11.55.95; do dotnet /usr/local/lib/ssam-skia-probe/ssam-skia-probe.dll "/studio/o11/$v" || exit 1; done \\\n && dotnet /usr/local/lib/ssam-skia-probe/ssam-skia-probe.dll /studio/odc\n'));
 assert.ok(out.includes('Contains OutSystems Studio binaries: private registry only.'));
 assert.ok(out.includes('# LICENSE: the image carries OutSystems binaries'));
 assert.equal(count(out,':latest'),0,'no latest anywhere');
 for(const line of out.split('\n').filter(l=>/^FROM /.test(l)))assert.match(line,/^FROM (\$\{[A-Z_]+\}|scratch|studio-reader|studio-image-reader|sdk|docker\.io\/\S+@sha256:[a-f0-9]{64}) AS /,line);
 assert.equal(generateDockerfile(base,{...spec,o11:[...spec.o11].reverse()},{trust}),out,'the order of the list does not matter');
 assert.equal(generateDockerfile(base.replaceAll('\n','\r\n'),spec,{trust}),out,'CRLF checkouts generate the same file');
});

test('fromImage: the ODC tfm of a Studio without runtimeconfig.json; fromPath of a multi-O11 image; without "odc" the ODC stays a build arg',()=>{
 const out=generateDockerfile(base,{o11:[{version:'11.55.93',fromImage:ref('b'),tfm:'net8.0',fromPath:'/studio/o11/11.55.93'}],odc:{version:'1.7.29',fromImage:ref('f'),tfm:'net8.0'}},{trust});
 assert.match(out,/^ARG ODC_STUDIO_TFM=net8\.0$/m);
 assert.ok(out.includes('COPY --from=studio-image-o11-11-55-93 /studio/o11/11.55.93/ /from-image/\n'));
 const noOdc=generateDockerfile(base,{o11:[{version:'11.55.95',fromImage:ref('d')}]},{trust});
 assert.ok(noOdc.includes('sh studio-extract.sh odc "$ODC_STUDIO_INSTALLER"'),'the ODC stage of the build args');
 assert.match(noOdc,/^ARG SSAM_IMAGE_ODC=1\.7\.28$/m);
 assert.match(noOdc,/^ARG ODC_STUDIO_TFM=$/m);
 assert.equal(count(noOdc,'ssam.studio.odc.'),1,'one ODC label (D6): the build args, not an image');
 assert.ok(noOdc.includes('      ssam.studio.odc.source="build args: the ODC bundle of the installers context, SSAM_IMAGE_ODC=${SSAM_IMAGE_ODC}" \\\n'));
 assert.ok(noOdc.includes('      ssam.studio.from-image="o11 11.55.95" \\\n'));
 assert.ok(noOdc.includes('ssam.studio.o11.11.55.95.source="image '+ref('d')+'"'));
});

test('fromImage: a file of bundles only is untouched (no reader stage, no source label, no sha256 list)',()=>{
 const out=generateDockerfile(base,{o11:[{version:'11.55.94',bundle:'o11-studio-11.55.94.65328.tar.gz',sha256:'c'.repeat(64)}]});
 for(const absent of ['studio-image','studio-from-image','ssam.studio.','Studios from pinned images'])assert.equal(count(out,absent),0,absent);
});

test('fromImage: nothing without its digest, nothing ambiguous',()=>{
 const one={version:'11.55.95',fromImage:ref('d')};
 for(const [o11,re] of [
  [[{...one,fromImage:'docker.io/andrepereiramachado/ssam-server:prod-20261108-r44-dfb584d-o115595-odc1732'}],/has no digest/],
  [[{...one,fromImage:'docker.io/andrepereiramachado/ssam-server'}],/has no digest/],
  [[{...one,fromImage:'ssam-server:latest@sha256:'+'d'.repeat(64)}],/tag latest/],[[{...one,fromImage:'ssam-server:LATEST@sha256:'+'d'.repeat(64)}],/tag latest/],
  [[{...one,fromImage:IMG+'d'.repeat(63)}],/Invalid image reference/],
  [[{...one,fromImage:'docker.io/AndrePereiraMachado/ssam-server@sha256:'+'d'.repeat(64)}],/Invalid image reference/],
  [[{...one,fromImage:'docker.io/x@sha256:'+'d'.repeat(64)+' AS evil'}],/Invalid image reference/],
  [[{...one,fromImage:'docker.io/x@sha256:'+'d'.repeat(64)+'\nRUN id'}],/Invalid image reference/],
  [[{...one,fromImage:12}],/has no digest/],
  [[{...one,bundle:'o11-studio-11.55.95.65352.tar.gz'}],/two sources/],[[{...one,sha256:'d'.repeat(64)}],/two sources/],
  [[{version:'11.55.95',bundle:'o11-studio-11.55.95.65352.tar.gz',sha256:'d'.repeat(64),fromPath:'/studio/o11'}],/needs fromImage/],
  [[{...one,fromPath:'/app'}],/Invalid fromPath/],[[{...one,fromPath:'/studio/odc'}],/Invalid fromPath/],[[{...one,fromPath:'/studio/o11/../x'}],/Invalid fromPath/],
  [[{...one,tfm:'net8'}],/Invalid tfm/],[[{...one,from:'x'}],/unknown fields/]])assert.throws(()=>o11KernelList({o11}),re,JSON.stringify(o11));
 for(const [odc,re] of [
  [{version:'1.7.30'},/names no fromImage/],[{version:'1.7',fromImage:ref('e')},/Invalid ODC version/],
  [{version:'1.7.30',fromImage:ref('e'),bundle:'x.tar.gz'},/takes only/],[{version:'1.7.30',fromImage:'ssam:prod-x'},/has no digest/],
  [{version:'1.7.30',fromImage:ref('e'),fromPath:'/studio/o11'},/Invalid fromPath/],[null,/takes only/]])assert.throws(()=>o11KernelList({o11:[one],odc}),re,JSON.stringify(odc));
 assert.deepEqual(o11KernelList({o11:[one]}),{list:[{version:'11.55.95',fromImage:ref('d'),fromPath:'/studio/o11'}],default:'11.55.95',odc:null});
});

// studio-from-image.sh, cut out of the generated file and run on a fake image folder (bash: Git Bash on Windows).
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
const script=()=>{const out=generateDockerfile(base,spec,{trust});const a=out.indexOf("COPY <<'EOF' /reader/studio-from-image.sh\n")+"COPY <<'EOF' /reader/studio-from-image.sh\n".length;return out.slice(a,out.indexOf('\nEOF\n',a)+1);};
// The fake image: its Studio folder (from) and its /app (origin): an image built from a bundle has studio-provenance.json and
// no studio-from-image; copied:true makes it an image that was itself built from images.
function fakeImage(dir,{drop=[],add=[],copied=false,provenance=true}={}){
 const listed=fs.readFileSync(path.join(server,'docker/ssam-server/studio-o11.txt'),'utf8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
 const from=path.join(dir,'from'),origin=path.join(dir,'origin-app');
 for(const l of listed){const rel=l.replace(/^\?\s*/,'');if(l.startsWith('?')&&rel!=='ServiceStudio.runtimeconfig.json')continue;if(drop.includes(rel))continue;
  fs.mkdirSync(path.dirname(path.join(from,rel)),{recursive:true});fs.writeFileSync(path.join(from,rel),'bytes of '+rel);}
 for(const f of ['libSkiaSharp.so','libHarfBuzzSharp.so',...add])fs.writeFileSync(path.join(from,f),'native '+f);
 fs.mkdirSync(origin,{recursive:true});
 if(provenance)fs.writeFileSync(path.join(origin,'studio-provenance.json'),'{"automatic":false,"note":"origin"}\n');
 if(copied){fs.mkdirSync(path.join(origin,'studio-from-image'));fs.writeFileSync(path.join(origin,'studio-from-image','o11-11.55.95.image'),'x\n');}
 return {from,origin,listed};
}
function runScript(dir,from,origin){
 fs.writeFileSync(path.join(dir,'s.sh'),script());
 const slash=p=>p.replaceAll('\\','/');
 return spawnSync(bash,[slash(path.join(dir,'s.sh')),'o11',slash(from),slash(path.join(server,'docker/ssam-server/studio-o11.txt')),slash(path.join(dir,'out')),'11.55.95',ref('d'),slash(origin)],
  {encoding:'utf8',env:{...process.env,STUDIO_FROM_IMAGE_DIR:slash(path.join(dir,'man'))}});
}
test('studio-from-image.sh: keeps exactly the listed files, drops the natives, records every sha256 and the origin provenance; refuses extras, gaps, a copy of a copy and a non-ssam image',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-from-image-'));
 try{
  const {from,origin,listed}=fakeImage(dir);
  const r=runScript(dir,from,origin);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/o11 11\.55\.95: \d+ files .* from the image docker\.io\/andrepereiramachado\/ssam-server@sha256:d{64} into .*; sha256 of the file list [a-f0-9]{64}/);
  const required=listed.filter(l=>!l.startsWith('?'));
  const kept=fs.readFileSync(path.join(dir,'man','o11-11.55.95.sha256sums'),'utf8').trim().split('\n');
  assert.equal(kept.length,required.length+1,'every required file and the one optional present');
  assert.ok(!fs.existsSync(path.join(dir,'out','libSkiaSharp.so'))&&!fs.existsSync(path.join(dir,'out','libHarfBuzzSharp.so')),'the natives are this build\'s');
  assert.equal(fs.readFileSync(path.join(dir,'out',required[0]),'utf8'),'bytes of '+required[0]);
  assert.equal(fs.readFileSync(path.join(dir,'man','o11-11.55.95.image'),'utf8'),ref('d')+'\n');
  assert.equal(fs.readFileSync(path.join(dir,'man','o11-11.55.95.origin-provenance.json'),'utf8'),'{"automatic":false,"note":"origin"}\n','the source image\'s own provenance travels (D2)');
  assert.ok(!fs.existsSync(from),'the copied image folder is removed from the stage');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 for(const [opts,re] of [[{add:['notes.txt']},/files outside .*notes\.txt/],[{drop:['Antlr4.Runtime.dll']},/lacks the listed: Antlr4\.Runtime\.dll/],
  [{copied:true},/was itself built with Studios from images .*a copy of a copy is refused/],[{provenance:false},/has no \/app\/studio-provenance\.json: not an ssam-server image/]]){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'studio-from-image-'));
  try{const {from,origin}=fakeImage(d,opts);const r=runScript(d,from,origin);assert.equal(r.status,1,r.stdout);assert.match(r.stderr,re);assert.ok(!fs.existsSync(path.join(d,'man')),'nothing recorded');}
  finally{fs.rmSync(d,{recursive:true,force:true});}
 }
});

// D1 (trilha G review): only a digest of the trust list, for its own lane and version, is a source.
test('trust (D1): a fromImage outside versions.json, of another lane or version, or of a copied image is refused; the extra list needs a reason',()=>{
 const one={version:'11.55.95',fromImage:ref('d')};
 assert.throws(()=>generateDockerfile(base,{o11:[one]}),/needs the trust list .*none was given/,'no silent default');
 assert.throws(()=>generateDockerfile(base,{o11:[{...one,fromImage:ref('9')}]},{trust}),/not in the trust list: .*9{64}\. Only the pair images of deploy\/coolify\/versions\.json/);
 assert.throws(()=>generateDockerfile(base,{o11:[{...one,fromImage:'ghcr.io/qualquer/coisa@sha256:'+'d'.repeat(64)}]},{trust}),/not in the trust list/,'another registry with a known digest');
 assert.throws(()=>generateDockerfile(base,{o11:[{...one,fromImage:'ssam-ensaio@sha256:'+'d'.repeat(64)}]},{trust}),/not in the trust list/,'a local rehearsal image');
 assert.throws(()=>generateDockerfile(base,{o11:[{version:'11.55.94',fromImage:ref('d')}]},{trust}),/o11 Studio 11\.55\.94 is not in the trust list for that lane and version \(it is the o11 11\.55\.95 entry\)/);
 assert.throws(()=>generateDockerfile(base,{o11:[one],odc:{version:'1.7.30',fromImage:ref('d')}},{trust}),/odc Studio 1\.7\.30 is not in the trust list for that lane and version/);
 // A tag next to the digest is only a note: the digest decides.
 assert.ok(generateDockerfile(base,{o11:[{...one,fromImage:img+':prod-x@sha256:'+'d'.repeat(64)}]},{trust}).includes('FROM '+img+':prod-x@sha256:'+'d'.repeat(64)+' AS studio-image-o11-11-55-95'));
 // An entry marked as copied from images is never a source (item 2: no chain of copies).
 const marked=studioTrust({odc:versions.odc,o11:[...versions.o11.filter(e=>e.version!=='11.55.95'),pin('11.55.95','d',{studioFrom:'image'})]});
 assert.throws(()=>generateDockerfile(base,{o11:[one]},{trust:marked}),/is refused: versions\.json marks it studioFrom "image": its Studios are copies/);
 assert.equal(studioTrust({odc:[],o11:[pin('11.55.95','d',{studioFrom:'bundle'})]}).entries.size,1,'studioFrom bundle is the default');
 // After the window: the served images are the multi-O11 copies (studioFrom image), the pair images stay sources in studioSources.
 const after=studioTrust({odc:[pin('1.7.30','8',{studioFrom:'image'})],o11:[pin('11.55.95','8',{studioFrom:'image'})],
  studioSources:[{lane:'o11',...pin('11.55.95','d')},{lane:'odc',...pin('1.7.30','e')}]});
 assert.ok(generateDockerfile(base,{o11:[one],odc:{version:'1.7.30',fromImage:ref('e')}},{trust:after}).includes('ssam.studio.from-image="o11 11.55.95,odc 1.7.30"'));
 assert.throws(()=>generateDockerfile(base,{o11:[{version:'11.55.95',fromImage:ref('8')}]},{trust:after}),/is refused: versions\.json marks it studioFrom "image"/,'the window image itself is never a source');
 assert.throws(()=>studioTrust({odc:[],o11:[],studioSources:[{version:'11.55.95',image:img,sha256:'d'.repeat(64)}]}),/studioSources .*no lane o11 or odc/);
 assert.throws(()=>studioTrust({odc:[],o11:[],studioSources:{}}),/studioSources of versions\.json is a list/);
 // The extra list: only with the explicit reason, each entry with its own; the image carries the reason.
 const extra={entries:[{lane:'o11',version:'11.55.96',image:img,sha256:'7'.repeat(64),reason:'pre-release Studio for the R5 rehearsal'}]};
 const e96={version:'11.55.96',fromImage:ref('7')};
 assert.throws(()=>generateDockerfile(base,{o11:[e96]},{trust:studioTrust(versions,{extra})}),/not in the trust list/,'the file alone is not enough');
 assert.throws(()=>studioTrust(versions,{extra,extraReason:'x'}),/needs the reason, in words/);
 assert.throws(()=>studioTrust(versions,{extra:{entries:[{...extra.entries[0],reason:''}]},extraReason:'rehearsal of R5 only'}),/has no reason/);
 assert.throws(()=>studioTrust(versions,{extra:{entries:[{...extra.entries[0],lane:'x'}]},extraReason:'rehearsal of R5 only'}),/no lane o11 or odc/);
 const out=generateDockerfile(base,{o11:[e96]},{trust:studioTrust(versions,{extra,extraReason:'rehearsal of R5 only, never pushed'})});
 assert.ok(out.includes('      ssam.studio.trust.extra="o11 11.55.96: rehearsal of R5 only, never pushed" \\\n'));
 assert.throws(()=>studioTrust({odc:[{version:'1.7.30',image:img,sha256:'E'.repeat(64)}],o11:[]}),/has no version, image and sha256/);
 assert.deepEqual(trustedSources([{version:'11.55.94',bundle:'b.tar.gz',sha256:'c'.repeat(64)}],null,null),[],'bundles need no trust list');
});

test('trust (D1): the real versions.json of this checkout trusts every pair image, and the window files of trilha D pass it',()=>{
 const real=JSON.parse(fs.readFileSync(path.join(server,'deploy/coolify/versions.json'),'utf8'));
 const t=checkoutTrust();
 assert.equal(t.entries.size,real.odc.length+real.o11.length);
 assert.equal(t.refused.size,0);
 for(const lane of ['odc','o11'])for(const e of real[lane])assert.ok(t.entries.has(lane+' '+e.version+' '+e.image+'@sha256:'+e.sha256),lane+' '+e.version);
 // The 4x4 file of each ODC: every O11 from the pair image that holds it, the ODC from its own (k-4x4-odc-<v>.json of IMAGENS.md).
 const o11Of=Object.fromEntries(real.o11.map(e=>[e.version,e]));
 const older=(a,b)=>a.split('.').map(Number).some((x,i,arr)=>x!==b.split('.').map(Number)[i])&&a.split('.').map(Number).find((x,i)=>x!==b.split('.').map(Number)[i])<b.split('.').map(Number).find((x,i)=>x!==a.split('.').map(Number)[i]);
 for(const odc of real.odc){
  const spec4={default:'11.55.95',o11:['11.55.92','11.55.93','11.55.94','11.55.95'].map(v=>({version:v,fromImage:o11Of[v].image+'@sha256:'+o11Of[v].sha256,...(older(v,'11.55.94')?{tfm:'net8.0'}:{})})),
   odc:{version:odc.version,fromImage:odc.image+'@sha256:'+odc.sha256,...(older(odc.version,'1.7.30')?{tfm:'net8.0'}:{})}};
  assert.match(generateDockerfile(base,spec4,{trust:t}),/ssam\.studio\.from-image="o11 11\.55\.92,o11 11\.55\.93,o11 11\.55\.94,o11 11\.55\.95,odc /,odc.version);
 }
 const extraFile=JSON.parse(fs.readFileSync(path.join(server,'deploy/studio-image-trust.json'),'utf8'));
 assert.deepEqual(extraFile.entries,[],'the extra list starts empty');
});
