// The customers a window change affects, from the live usage data on the VPS (window 4x4, S2 R4 M3): the same source the
// watcher reads in its live baseline, the studio-versions telemetry of every running backend (readStudioVersions over the
// server's token store, check-backend.mjs capture), merged the way remote-release.py merges it (per token, the newest seen).
// The S1 kit calls it for the window-retiring notice of the first switch (ODC 1.7.28 enters its grace).
//
//   node deploy/vigia/affected-customers.mjs source > capture.mjs
//     A read-only module for each running backend (it issues no token and writes nothing):
//       docker exec -i <backend container> node --input-type=module < capture.mjs > telemetry-<container>.json
//   node deploy/vigia/affected-customers.mjs notice --telemetry <file>[,<file>...] --lane odc --version 1.7.28
//        --retire-at <ISO> [--names false]
//     -> stdout: {name: "window-retiring", code: "WINDOW_RETIRING", message, affected: [{customer, lane, version, lastSeen,
//        retireAt, client}]} (client: a short hash of the token, never the token id). --names false keeps the customers' names
//        out of the message (window.notifyAffected false), as the watcher does.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {affectedBy,affectedRecord,LANES} from './window.mjs';

// The module each backend runs (cwd /app of the server image, like check-backend.mjs): one line of JSON.
export const CAPTURE_SOURCE=`import {openTokenStore} from './platforms/odc/facade/server-tokens.mjs';
import {readStudioVersions} from './platforms/odc/facade/studio-version-state.mjs';
const dir=process.env.SSAM_SERVER_DIR||'/data/server';
const store=await openTokenStore({dir,env:process.env});
try{console.log(JSON.stringify({ok:true,backend:process.env.SSAM_BACKEND_NAME??null,telemetry:{tokens:readStudioVersions(dir,await store.list())}}));}
finally{await store.close?.();}
`;
// The tokens of several captures (or {tokens} / {telemetry: {tokens}} objects), merged per token by the newest "seen".
export function mergeTelemetry(captures){
 const tokens={};
 for(const c of captures){
  const list=c?.telemetry?.tokens??c?.tokens;
  if(c?.ok===false||!list||typeof list!=='object')throw Error('A telemetry capture is not readable (ok:false or no tokens).');
  for(const [key,value]of Object.entries(list))if(!tokens[key]||String(tokens[key].seen??'')<String(value?.seen??''))tokens[key]=value;
 }
 return tokens;
}
// The window-retiring notice of a version that enters its grace, with the customers seen on it.
export async function retiringNotice(tokens,{lane,version,retireAt,notifyAffected=true}){
 if(!LANES.includes(lane)||!/^\d+\.\d+\.\d+$/.test(version??''))throw Error('--lane odc|o11 and a three-part --version are required.');
 if(!Number.isFinite(Date.parse(retireAt??'')))throw Error('--retire-at must be an ISO time.');
 const at=new Date(Date.parse(retireAt)).toISOString(),retiring=[{lane,version,retireAt:at}];
 const affected=affectedRecord(affectedBy(tokens,retiring));
 const {windowNotices}=await import('./window-round.mjs');
 const [n]=windowNotices({retiring,retired:[],affected,notifyAffected});
 return {...n,affected};
}

const here=fileURLToPath(import.meta.url);
if(process.argv[1]&&path.resolve(process.argv[1])===here){
 const [command,...rest]=process.argv.slice(2),args={};
 for(let i=0;i<rest.length;i+=2){const k=rest[i];if(!k?.startsWith('--')||rest[i+1]===undefined){console.error(`Unknown or incomplete argument ${k}.`);process.exit(2);}args[k.slice(2)]=rest[i+1];}
 try{
  if(command==='source')process.stdout.write(CAPTURE_SOURCE);
  else if(command==='notice'){
   if(!args.telemetry)throw Error('--telemetry is required.');
   const tokens=mergeTelemetry(args.telemetry.split(',').map(f=>JSON.parse(fs.readFileSync(f.trim(),'utf8'))));
   console.log(JSON.stringify(await retiringNotice(tokens,{lane:args.lane,version:args.version,retireAt:args['retire-at'],notifyAffected:args.names!=='false'}),null,2));
  }else throw Error('Use: source | notice --telemetry <files> --lane <odc|o11> --version <x.y.z> --retire-at <ISO> [--names false].');
 }catch(e){console.error(`affected-customers: ${e.message}`);process.exit(1);}
}
