// window-images.mjs: the images of a release, from the commit's own deploy/coolify/versions.json (the pair window in
// production), for build-window-images.sh (trilha D, IMAGENS.md section 12). Nothing here builds, pushes or logs in.
//
//   node deploy/window-images/window-images.mjs specs --versions <versions.json> --commit <sha7> --date <yyyymmdd>
//        [--release <rNN>] [--mode backends|pairs] [--ensaio] [--image <name>] --out <dir>
//     Writes <out>/specs/<id>.json (the input of deploy/gen-dockerfile.mjs: every Studio from a pair image of versions.json,
//     the trust list D1) and <out>/plan.json [{id, odc, kernels, default, tag, ref, sources}], in build order (newest ODC
//     first). backends: the window 4x4, one image per ODC with EVERY O11 of the window (the default O11 of a backend is the
//     O11 of its pair); pairs: one image per pair (its O11 + its ODC), the same pair window with the new code.
//     Tags: the vigia's (window.mjs backendTag / pairTag); --release puts the release name after the date, as the hand-made
//     tags of versions.json do (prod-20261108-r44-dfb584d-...); --ensaio makes them ensaio-... (never pushed).
//
//   node deploy/window-images/window-images.mjs images --built <out>/built.json[,<out2>/built.json...] --pairs <versions.json> --out <dir>
//        [--now <ISO switch time>] [--telemetry <file>[,...]] [--from-metadata] [--partial]
//     After the owner's docker push: reads each image's digest back from `docker image inspect` (RepoDigests, written by the
//     push; no credential), checks it is the image that passed the smoke (same local id) and the digest of the build
//     (meta.json containerimage.digest), and writes:
//       backends: <out>/images.json (the --images of vigia/first-window.mjs: {odc: {image, tag, sha256, kernels}}) and, with
//                 --now, <out>/versions.json (the backend window, by first-window.mjs of this checkout), kit-plan.json and
//                 plan.json;
//       pairs:    <out>/versions.json (the pair window with each pair's new tag and digest, marked studioFrom "image");
//                 --partial (built with --only, the canary): the pairs not built keep their entries.
//                 Several built.json (comma-separated): a correction window has one build per source commit (the
//                 4 pairs of 60e13ec, the pair of dfb584d); together they must hold every pair once, without --partial.
//     Both keep every image built from bundles as "studioSources" (gen-dockerfile.mjs studioTrust): the new images are copies
//     and never Studio sources, and without the old ones the next Studio version would have no trusted source.
//     --from-metadata (ensaio images only): the digest of meta.json instead of RepoDigests, to rehearse without a push.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
export const IMAGE='docker.io/andrepereiramachado/ssam-server';
const HEX=/^[a-f0-9]{64}$/,VER=/^\d+\.\d+\.\d+$/;
export const compareVersion=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
// The vigia's tags (vigia/window.mjs; the test checks they stay equal where the checkout has them).
export const kernelSetHash=kernels=>createHash('sha256').update([...kernels].sort(compareVersion).join(',')).digest('hex').slice(0,8);
export const backendTag=({odc,kernels},commit,date)=>`prod-${date}-${commit}-odc${odc.replaceAll('.','')}-o11k${kernelSetHash(kernels)}`;
export const pairTag=(p,commit,date)=>`prod-${date}-${commit}-o${p.o11.replaceAll('.','')}-odc${p.odc.replaceAll('.','')}`;
// The Studios frozen before 2026-10-27 run on net8.0 (server/Dockerfile ARG comment; build-check.sh): ODC before 1.7.30,
// Service Studio before 11.55.94.
export const tfmOf=(lane,v)=>compareVersion(v,lane==='odc'?'1.7.30':'11.55.94')<0?'net8.0':undefined;
const ref=e=>{const sha=String(e.sha256??'').replace(/^sha256:/,'');if(!HEX.test(sha)||!e.image)throw Error(`versions.json: ${e.version} has no image and pinned sha256`);return `${e.image}@sha256:${sha}`;};
const studio=(lane,e)=>({version:e.version,fromImage:ref(e),...(tfmOf(lane,e.version)?{tfm:tfmOf(lane,e.version)}:{})});

// The pairs of the live pair window: odc[i] with o11[i] (the same image: versions.json lists each pair image in both lanes).
export function pairsOf(versions){
 if(versions.backends)throw Error('versions.json is already a backend window: its images are not Studio sources (studioFrom image).');
 const odc=versions.odc??[],o11=versions.o11??[];
 if(!odc.length||odc.length!==o11.length)throw Error('versions.json: odc and o11 must list the same pairs.');
 return odc.map((d,i)=>{const o=o11[i];if(!VER.test(d.version)||!VER.test(o.version))throw Error('versions.json: bad version');
  if(ref(d)!==ref(o))throw Error(`versions.json: pair ${i} (ODC ${d.version}, O11 ${o.version}) is not one image in both lanes`);return {odc:d,o11:o};});
}

export function windowSpecs(versions,{commit,date,release=null,mode='backends',ensaio=false,image=IMAGE}={}){
 if(!/^[0-9a-f]{7,12}$/.test(commit??''))throw Error('--commit <short sha>');
 if(!/^\d{8}$/.test(date??''))throw Error('--date <yyyymmdd>');
 if(release!==null&&!/^r[0-9]+[a-z]?$/.test(release))throw Error('--release rNN (as r44, r43b)');
 if(!['backends','pairs'].includes(mode))throw Error('--mode backends|pairs');
 const pairs=pairsOf(versions);
 const finish=t=>{let x=release?t.replace(/^prod-(\d{8})-/,`prod-$1-${release}-`):t;if(ensaio)x=x.replace(/^prod-/,'ensaio-');return x;};
 let plan;
 if(mode==='pairs'){
  plan=pairs.map(({odc,o11})=>({id:`o11-${o11.version}-odc-${odc.version}`,odc:odc.version,kernels:[o11.version],default:o11.version,
   tag:finish(pairTag({odc:odc.version,o11:o11.version},commit,date)),spec:{default:o11.version,o11:[studio('o11',o11)],odc:studio('odc',odc)}}));
 }else{
  // Every O11 of the window, each from the first pair image that has it (the order of versions.json).
  const source={};for(const {o11}of pairs)source[o11.version]??=o11;
  const kernels=Object.keys(source).sort(compareVersion);
  plan=pairs.map(({odc,o11})=>({id:`odc-${odc.version}`,odc:odc.version,kernels,default:o11.version,
   tag:finish(backendTag({odc:odc.version,kernels},commit,date)),spec:{default:o11.version,o11:kernels.map(v=>studio('o11',source[v])),odc:studio('odc',odc)}}));
 }
 plan.sort((a,b)=>compareVersion(b.odc,a.odc));
 for(const p of plan){p.ref=`${image}:${p.tag}`;p.sources=[...new Set([...p.spec.o11.map(s=>s.fromImage),p.spec.odc.fromImage])];}
 return plan;
}

const docker=(args)=>cp.execFileSync(process.env.DOCKER_BIN??'docker',args,{encoding:'utf8'}).trim();
// The digest the push recorded (RepoDigests of the local image), or (ensaio) the build's.
export function publishedImages(built,{fromMetadata=false,inspect=docker}={}){
 return built.map(b=>{
  const id=inspect(['image','inspect','-f','{{.Id}}',b.ref]);
  if(id!==b.imageId)throw Error(`${b.ref} is not the image that passed the smoke (${b.imageId}, now ${id}): never rebuild between the smoke and the push.`);
  const meta=String(b.metadataDigest??'').replace(/^sha256:/,'');
  let sha;
  if(fromMetadata){if(!b.tag.startsWith('ensaio-'))throw Error('--from-metadata is for ensaio images only: a production digest comes from the registry.');sha=meta;}
  else{
   const repo=b.ref.slice(0,b.ref.lastIndexOf(':')),digests=JSON.parse(inspect(['image','inspect','-f','{{json .RepoDigests}}',b.ref])||'[]');
   const hit=digests.filter(d=>d.startsWith(repo+'@sha256:')).map(d=>d.slice(d.indexOf('@sha256:')+8));
   if(hit.length!==1)throw Error(`${b.ref} has ${hit.length} digests of ${repo} (RepoDigests ${JSON.stringify(digests)}): push it first (docker push ${b.ref}).`);
   sha=hit[0];
   if(meta&&sha!==meta)throw Error(`${b.ref}: the registry digest ${sha} is not the build's ${meta}: do not use it.`);
  }
  if(!HEX.test(sha))throw Error(`${b.ref}: no digest`);
  const kernels=inspect(['image','inspect','-f','{{index .Config.Labels "ssam.kernels.o11"}}',b.ref]).split(',');
  if(kernels.join()!==b.kernels.join())throw Error(`${b.ref}: label ssam.kernels.o11 ${kernels} is not ${b.kernels}`);
  return {...b,image:b.ref.slice(0,b.ref.lastIndexOf(':')),sha256:sha};
 });
}
export const imagesJson=published=>Object.fromEntries(published.map(p=>[p.odc,{image:p.image,tag:p.tag,sha256:p.sha256,kernels:p.kernels}]));
// The Studio sources that must survive the release (gen-dockerfile.mjs studioTrust): every image of the pair window built
// from bundles (its odc and o11 entries not marked studioFrom image) and the studioSources it already has, once each.
export function studioSourcesOf(versions){
 const out=[],seen=new Set();
 const put=(lane,e)=>{if(e.studioFrom!==undefined&&e.studioFrom!=='bundle')return;const sha=String(e.sha256).replace(/^sha256:/,'');const k=`${lane} ${e.version} ${e.image}@${sha}`;if(seen.has(k))return;seen.add(k);out.push({lane,version:e.version,image:e.image,sha256:sha,...(e.tag?{tag:e.tag}:{})});};
 for(const e of versions.studioSources??[])put(e.lane,e);
 for(const lane of ['odc','o11'])for(const e of versions[lane]??[])put(lane,e);
 if(!out.length)throw Error('versions.json has no image built from bundles: after this release no Studio would have a source.');
 return out;
}
// The backend window of first-window.mjs plus studioSources (it drops them: a backend window has no image lists).
export const backendVersions=(manifest,pairs)=>({...manifest,studioSources:studioSourcesOf(pairs)});
// The pair window with the new image of each pair (its two entries, marked studioFrom image: they are copies) and the images
// they replace kept as studioSources; every other field stays. partial (the canary: one pair first, the others in a later
// window): a pair with no new image keeps its entries as they are; without it every pair must have one.
export function pairsVersions(versions,published,{partial=false}={}){
 const keys=published.map(p=>`${p.default}/${p.odc}`),twice=keys.find((k,i)=>keys.indexOf(k)!==i);
 if(twice)throw Error(`the pair O11 ${twice.replace('/',' / ODC ')} was built twice`);
 const v=structuredClone(versions),by=Object.fromEntries(published.map(p=>[`${p.default}/${p.odc}`,p]));
 const pairs=pairsOf(versions);
 pairs.forEach(({odc,o11},i)=>{const p=by[`${o11.version}/${odc.version}`];if(!p){if(partial)return;throw Error(`no new image for pair O11 ${o11.version} / ODC ${odc.version}`);}
  for(const e of [v.odc[i],v.o11[i]])Object.assign(e,{image:p.image,tag:p.tag,sha256:p.sha256,studioFrom:'image'});});
 if(published.some(p=>!pairs.some(({odc,o11})=>p.default===o11.version&&p.odc===odc.version))||published.length>pairs.length)throw Error('built images that are not pairs of versions.json');
 if(!published.length)throw Error('no new image');
 v.studioSources=studioSourcesOf(versions);
 return v;
}

// The built.json of one or more runs of build-window-images.sh, as one list (one mode).
export function readBuilt(list,read){
 const built=String(list).split(',').map(f=>f.trim()).filter(Boolean).flatMap(f=>read(f));
 if(new Set(built.map(b=>b.mode??'backends')).size>1)throw Error('built.json files of different modes');
 return built;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [cmd,...rest]=process.argv.slice(2),args={},flags=new Set(['--ensaio','--from-metadata','--partial']);
 for(let i=0;i<rest.length;i++){const k=rest[i];if(flags.has(k)){args[k.slice(2)]=true;continue;}if(!k.startsWith('--')||rest[i+1]===undefined){console.error(`window-images: unknown or incomplete argument ${k}`);process.exit(2);}args[k.slice(2)]=rest[++i];}
 const read=f=>JSON.parse(fs.readFileSync(f,'utf8')),write=(f,x)=>fs.writeFileSync(f,typeof x==='string'?x:JSON.stringify(x,null,2)+'\n');
 try{
  if(!args.out)throw Error('--out <dir>');fs.mkdirSync(args.out,{recursive:true});
  if(cmd==='specs'){
   const plan=windowSpecs(read(args.versions),{commit:args.commit,date:args.date,release:args.release??null,mode:args.mode??'backends',ensaio:!!args.ensaio,image:args.image??IMAGE});
   fs.mkdirSync(path.join(args.out,'specs'),{recursive:true});
   for(const p of plan)write(path.join(args.out,'specs',p.id+'.json'),p.spec);
   write(path.join(args.out,'plan.json'),plan.map(({spec,...p})=>p));
   for(const p of plan)console.log(`${p.id}\t${p.tag}\tdefault ${p.default}\tkernels ${p.kernels.join(',')}`);
  }else if(cmd==='images'){
   const built=readBuilt(args.built,read),published=publishedImages(built,{fromMetadata:!!args['from-metadata']}),mode=built[0]?.mode??'backends';
   if(mode==='pairs'){write(path.join(args.out,'versions.json'),pairsVersions(read(args.pairs),published,{partial:!!args.partial}));console.log(`versions.json: ${published.length} pairs with their new image${args.partial?' (partial: the other pairs keep theirs)':''}`);}
   else{
    const images=imagesJson(published);write(path.join(args.out,'images.json'),images);console.log(`images.json: ${Object.keys(images).join(', ')}`);
    if(args.now){
     const {firstBackendWindow}=await import(pathToFileURL(path.join(here,'..','vigia','first-window.mjs')).href);
     const {mergeTelemetry}=await import(pathToFileURL(path.join(here,'..','vigia','affected-customers.mjs')).href);
     const tokens=args.telemetry?mergeTelemetry(args.telemetry.split(',').map(f=>read(f.trim()))):undefined;
     const pairs=read(args.pairs),r=await firstBackendWindow(pairs,{images,now:args.now,tokens});
     write(path.join(args.out,'versions.json'),backendVersions(r.manifest,pairs));write(path.join(args.out,'kit-plan.json'),r.kit);write(path.join(args.out,'plan.json'),r.plan);
     console.log(`versions.json (backend window): ${r.plan.backends.join(', ')}; o11 ${r.plan.o11.join(', ')}; retiring ${JSON.stringify(r.plan.retiring)}`);
    }
   }
   for(const p of published)console.log(`${p.ref}\tsha256:${p.sha256}`);
  }else throw Error('specs | images');
 }catch(e){console.error(`window-images: ${e.message}`);process.exit(1);}
}
