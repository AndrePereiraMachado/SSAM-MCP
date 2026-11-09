// The versions.json of the first backend window (window 4x4: the S1 switch from the pair window), generated, never written
// by hand: the S1 kit calls it.
//
//   node deploy/vigia/first-window.mjs --pairs <pair versions.json> --images <images.json> --now <ISO time of the switch>
//        [--keep-odc 4] [--keep-o11 4] [--grace-days 7] [--telemetry <file>[,<file>...]] [--out <versions.json>]
//        [--plan-out <kit-plan.json>] [--notice-out <window-retiring.json>]
// --notice-out: the window-retiring notice {name, code, message, affected}, the same object affected-customers.mjs notice prints.
//
// images.json: {"<odc version>": {"image": "...", "tag": "...", "sha256": "<64 hex>", "kernels": ["11.55.92", ...]?}, ...}, the
// multi-O11 image built for EVERY ODC version of the pair window that stays: the kept ones AND the one that enters its grace
// (ODC 1.7.28 on the first switch: 5 backends). kernels: the image's label ssam.kernels.o11 (docker image inspect), recorded as
// the backend's o11Kernels; it must carry every served O11 version. A missing or unpinned image stops the generator.
// --telemetry: the captures of affected-customers.mjs (the live usage data of every running pair), for the affected customers.
//
// The ODC (and O11) versions beyond keep do not leave at the switch: the oldest one enters "retiring" with retireAt = now +
// graceDays (window.mjs fromPairs), so ODC 1.7.28 users keep working for 7 days and are told when it leaves (studioRetiring).
// The usage of the pairs folds into their ODC backends; the generated compose and the served lists are checked before anything
// is printed. The plan goes to stderr (and --plan-out: what the kit deploys and checks, per backend); the file (or stdout) is
// the versions.json; --notice-out is the owner's window-retiring notice with the customers seen on the retiring version (one
// object, as affected-customers.mjs notice prints it).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromPairs,DEFAULT_KEEP,DEFAULT_GRACE_DAYS,backendId,defaultO11,builtKernels} from './window.mjs';
import {generateCompose,servedLists,versionBackends,versionPairs,hostBudget,sizedExpectations} from '../coolify/gen-compose.mjs';
import {mergeTelemetry,retiringNotice} from './affected-customers.mjs';

const HEX=/^[a-f0-9]{64}$/;
const volumeOf=(service,target)=>service.volumes?.find(v=>v.target===target)?.source??null;
// What the S1 kit deploys and checks for this window (S1-KIT-PLANO.md 3-4, with every backend of the manifest, the retiring
// one included): per backend its image, the pair it comes from (features volume, per-customer state folder, kernel.json to
// derive with the default O11), and the values the compose must show.
export function kitPlan(pairs,manifest,{retiring=[],affected=[],notice=null}={}){
 const compose=generateCompose(manifest),from=generateCompose(pairs);
 const services=Object.entries(compose.services).filter(([,s])=>s.environment?.SSAM_BACKEND_NAME);
 const pairOf=Object.fromEntries(Object.values(from.services).filter(s=>s.environment?.SSAM_BACKEND_NAME).map(s=>[s.labels['ssam.odc'],s]));
 const dflt=defaultO11(manifest),declared=Object.fromEntries(versionBackends(manifest).map(b=>[b.odc,b.kernels])),sized=sizedExpectations(manifest);
 const router=compose.services['ssam-router'].environment;
 const backends=services.map(([service,s])=>{
  const odc=s.labels['ssam.odc'],b=manifest.backends.find(x=>x.odc===odc),p=pairOf[odc];
  if(!p)throw Error(`No pair of the live window serves ODC ${odc}: the backend ${backendId(odc)} has nothing to migrate from.`);
  return {service,name:s.environment.SSAM_BACKEND_NAME,odc,default:s.labels['ssam.default']==='true',retiring:manifest.retiring?.odc?.version===odc,
   image:b.image,tag:b.tag,sha256:String(b.sha256).replace(/^sha256:/,''),o11Kernels:declared[odc],runtimeDir:s.environment.SSAM_RUNTIME_DIR,
   volumes:{odcFeatures:volumeOf(s,'/data/odc-features'),cache:volumeOf(s,'/data/cache')},
   from:{pair:p.environment.SSAM_BACKEND_NAME,runtimeDir:p.environment.SSAM_RUNTIME_DIR,odcFeatures:volumeOf(p,'/data/odc-features'),
    customerState:`state/versions/${p.environment.SSAM_BACKEND_NAME}`},
   customerState:`state/versions/${s.environment.SSAM_BACKEND_NAME}`,
   kernel:{from:p.environment.SSAM_RUNTIME_DIR+'/kernel.json',set:{o11:dflt},to:s.environment.SSAM_RUNTIME_DIR+'/kernel.json'},
   expect:{SSAM_SERVED_VERSIONS:s.environment.SSAM_SERVED_VERSIONS,...(s.environment.SSAM_O11_READERS_MAX!==undefined?{SSAM_O11_READERS_MAX:s.environment.SSAM_O11_READERS_MAX}:{}),
    ...(s.environment.ANVIL_WORKER_IDLE_MINUTES!==undefined?{ANVIL_WORKER_IDLE_MINUTES:s.environment.ANVIL_WORKER_IDLE_MINUTES}:{}),labels:{'ssam.odc':odc,'ssam.o11':s.labels['ssam.o11']},
    ...(sized?.[service]?{sized:sized[service]}:{})}};
 });
 return {backends,count:backends.length,routerWindow:Number(router.SSAM_VERSION_WINDOW),defaultO11:dflt,servedVersions:JSON.parse(backends[0].expect.SSAM_SERVED_VERSIONS),
  retiring,affected:affected.length,...(manifest.sizing?{hostBudget:hostBudget(manifest)}:{}),...(notice?{notice}:{})};
}
// -> {manifest, text, plan, kit, notice}. now: the switch time (ms or ISO); every backend must carry a pinned digest.
export async function firstBackendWindow(pairs,{images,now,keep=DEFAULT_KEEP,graceDays=DEFAULT_GRACE_DAYS,tokens,notifyAffected=true}={}){
 const at=typeof now==='string'?Date.parse(now):now;
 if(!Number.isFinite(at))throw Error('The first backend window needs the switch time (--now, ISO).');
 if(!images||typeof images!=='object')throw Error('The first backend window needs the image of every ODC backend (--images).');
 for(const [odc,i]of Object.entries(images)){
  if(!HEX.test(String(i?.sha256??'').replace(/^sha256:/,'')))throw Error(`The image of backend ${backendId(odc)} has no pinned digest.`);
  if(i.kernels!==undefined&&!builtKernels(i))throw Error(`The kernels of backend ${backendId(odc)} are not a list of three-part O11 versions.`);
 }
 versionPairs(pairs);
 const r=fromPairs(pairs,{now:at,images,keep,graceDays,tokens});
 const manifest=r.manifest;
 for(const b of manifest.backends)if(!HEX.test(String(b.sha256??'').replace(/^sha256:/,'')))throw Error(`The image of backend ${backendId(b.odc)} has no pinned digest.`);
 // The window must generate: backends, served lists (with retiring) and, with sizing, the host budget.
 versionBackends(manifest);generateCompose(manifest);servedLists(manifest);if(manifest.sizing)hostBudget(manifest);
 const plan={backends:manifest.backends.map(b=>backendId(b.odc)),o11:manifest.o11.served,retiring:r.retiring,retired:r.retired,affected:r.affected.length,...(r.hotPinDropped?{hotPinDropped:r.hotPinDropped}:{})};
 const notice=tokens&&r.retiring.length?await Promise.all(r.retiring.map(x=>retiringNotice(tokens,{...x,notifyAffected}))):null;
 const kit=kitPlan(pairs,manifest,{retiring:r.retiring,affected:r.affected,notice});
 return {manifest,text:JSON.stringify(manifest,null,2)+'\n',plan,kit,notice};
}

const here=fileURLToPath(import.meta.url);
if(process.argv[1]&&path.resolve(process.argv[1])===here){
 const args={};for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i];if(!k?.startsWith('--')||process.argv[i+1]===undefined){console.error(`Unknown or incomplete argument ${k}.`);process.exit(2);}args[k.slice(2)]=process.argv[i+1];}
 try{
  for(const k of ['pairs','images','now'])if(!args[k])throw Error(`--${k} is required.`);
  const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
  const keep={odc:Number(args['keep-odc']??DEFAULT_KEEP.odc),o11:Number(args['keep-o11']??DEFAULT_KEEP.o11)};
  const tokens=args.telemetry?mergeTelemetry(args.telemetry.split(',').map(f=>read(f.trim()))):undefined;
  const r=await firstBackendWindow(read(args.pairs),{images:read(args.images),now:args.now,keep,graceDays:Number(args['grace-days']??DEFAULT_GRACE_DAYS),tokens,notifyAffected:args.names!=='false'});
  console.error(JSON.stringify(r.plan,null,2));
  if(args['plan-out'])fs.writeFileSync(args['plan-out'],JSON.stringify(r.kit,null,2)+'\n');
  // The same notice object as affected-customers.mjs notice ({name, code, message, affected}; review B13): one version enters
  // its grace on the first switch (ODC 1.7.28); more than one is refused here (one affected-customers.mjs notice per version).
  if(args['notice-out']){
   if(!r.notice)throw Error('--notice-out needs --telemetry and a version that enters its grace.');
   if(r.notice.length!==1)throw Error(`--notice-out writes one notice; ${r.notice.length} versions enter their grace: run affected-customers.mjs notice for each.`);
   fs.writeFileSync(args['notice-out'],JSON.stringify(r.notice[0],null,2)+'\n');
  }
  if(args.out)fs.writeFileSync(args.out,r.text);else process.stdout.write(r.text);
 }catch(e){console.error(`first-window: ${e.message}`);process.exit(1);}
}
