// The versions.json of the first backend window (window 4x4: the S1 switch from the pair window), generated, never written
// by hand: the S1 kit calls it.
//
//   node deploy/vigia/first-window.mjs --pairs <pair versions.json> --images <images.json> --now <ISO time of the switch>
//        [--keep-odc 4] [--keep-o11 4] [--grace-days 7] [--out <file>]
//
// images.json: {"<odc version>": {"image": "...", "tag": "...", "sha256": "<64 hex>"}, ...}, the multi-O11 image built for EVERY
// ODC version of the pair window that stays: the kept ones and the one that enters its grace. A missing or unpinned image stops
// the generator.
//
// The ODC (and O11) versions beyond keep do not leave at the switch: the oldest one enters "retiring" with retireAt = now +
// graceDays (window.mjs fromPairs), so ODC 1.7.28 users keep working for 7 days and are told when it leaves (studioRetiring).
// The usage of the pairs folds into their ODC backends; the generated compose and the served lists are checked before anything
// is printed. The plan (retiring, retired, the backends) goes to stderr; the file (or stdout) is the versions.json.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromPairs,DEFAULT_KEEP,DEFAULT_GRACE_DAYS,backendId} from './window.mjs';
import {generateCompose,servedLists,versionBackends,hostBudget} from '../coolify/gen-compose.mjs';

const HEX=/^[a-f0-9]{64}$/;
// -> {manifest, text, plan}. now: the switch time (ms or ISO); every backend must carry a pinned digest.
export function firstBackendWindow(pairs,{images,now,keep=DEFAULT_KEEP,graceDays=DEFAULT_GRACE_DAYS,tokens}={}){
 const at=typeof now==='string'?Date.parse(now):now;
 if(!Number.isFinite(at))throw Error('The first backend window needs the switch time (--now, ISO).');
 if(!images||typeof images!=='object')throw Error('The first backend window needs the image of every ODC backend (--images).');
 for(const [odc,i]of Object.entries(images))if(!HEX.test(String(i?.sha256??'').replace(/^sha256:/,'')))throw Error(`The image of backend ${backendId(odc)} has no pinned digest.`);
 const r=fromPairs(pairs,{now:at,images,keep,graceDays,tokens});
 const manifest=r.manifest;
 for(const b of manifest.backends)if(!HEX.test(String(b.sha256??'').replace(/^sha256:/,'')))throw Error(`The image of backend ${backendId(b.odc)} has no pinned digest.`);
 // The window must generate: backends, served lists (with retiring) and, with sizing, the host budget.
 versionBackends(manifest);generateCompose(manifest);servedLists(manifest);if(manifest.sizing)hostBudget(manifest);
 const plan={backends:manifest.backends.map(b=>backendId(b.odc)),o11:manifest.o11.served,retiring:r.retiring,retired:r.retired,affected:r.affected.length,...(r.hotPinDropped?{hotPinDropped:r.hotPinDropped}:{})};
 return {manifest,text:JSON.stringify(manifest,null,2)+'\n',plan};
}

const here=fileURLToPath(import.meta.url);
if(process.argv[1]&&path.resolve(process.argv[1])===here){
 const args={};for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i];if(!k?.startsWith('--')||process.argv[i+1]===undefined){console.error(`Unknown or incomplete argument ${k}.`);process.exit(2);}args[k.slice(2)]=process.argv[i+1];}
 try{
  for(const k of ['pairs','images','now'])if(!args[k])throw Error(`--${k} is required.`);
  const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
  const keep={odc:Number(args['keep-odc']??DEFAULT_KEEP.odc),o11:Number(args['keep-o11']??DEFAULT_KEEP.o11)};
  const r=firstBackendWindow(read(args.pairs),{images:read(args.images),now:args.now,keep,graceDays:Number(args['grace-days']??DEFAULT_GRACE_DAYS)});
  console.error(JSON.stringify(r.plan,null,2));
  if(args.out)fs.writeFileSync(args.out,r.text);else process.stdout.write(r.text);
 }catch(e){console.error(`first-window: ${e.message}`);process.exit(1);}
}
