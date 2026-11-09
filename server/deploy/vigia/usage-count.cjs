// usage-count.cjs: executed inside a live backend by the remote snapshot (remote-release.py, stdin of `docker exec -i <id> node`), read
// only. The capacity hot tier goes by real use (gen-compose sizing.usage), counted from the shared server state every
// backend mounts at /data/server:
//   heavy:  the heavy tool calls (studio_deliver, o11_deliver, ssam_code) of the last 7 days in the quality log of each
//           pair (versions/<pair>/quality-YYYYMMDD.jsonl, written by the backend that served them);
//   active: the real clients seen in the last 14 days, each counted once, on the pair of its newest hello
//           (versions/<pair>/state/studio-versions.json; verification and revoked entries are not clients: window.mjs
//           isRealClient). A revoked or expired license can no longer hello, so it leaves this count within 14 days.
// Only counts leave the container, never a token id or a customer label: {"pairs":{"<pair>":{"heavy":n,"active":n}},
// "skipped":n}. A line, a file or a folder that does not read is skipped and counted, never fatal (usage is advisory: it
// must never stop a watcher round). SSAM_USAGE_ROOT and SSAM_USAGE_NOW exist for the tests only.
// Window 4x4 (S2): run inside a backend of a backend window (its own SSAM_BACKEND_NAME is odc-<v>), the counts are keyed by
// ODC Studio backend (odc-<v>): the runtime folder of a backend (versions/odc-<v>) and the one of an old pair of the same ODC
// (versions/o11-<o>-odc-<v>, kept after the switch) both count for odc-<v>, since the router reaches a backend by its ODC
// Studio alone; a client's newest hello counts once, for the ODC of that hello's runtime folder.
const fs=require('fs'),path=require('path');
const root=process.env.SSAM_USAGE_ROOT||'/data/server',now=Number(process.env.SSAM_USAGE_NOW)||Date.now();
const DAY=86400000,HEAVY=new Set(['studio_deliver','o11_deliver','ssam_code']),PAIR=/^o11-\d+\.\d+\.\d+-odc-\d+\.\d+\.\d+$/,BACKEND=/^odc-\d+\.\d+\.\d+$/;
const byOdc=BACKEND.test(process.env.SSAM_BACKEND_NAME||'');
const keyOf=dir=>byOdc?'odc-'+/odc-(\d+\.\d+\.\d+)$/.exec(dir)[1]:dir;
const out={pairs:{},skipped:0},of=n=>out.pairs[n]??(out.pairs[n]={heavy:0,active:0});
const real=t=>t&&typeof t==='object'&&!t.revokedAt&&!t.revoked&&t.state!=='revoked'&&!t.verification&&t.customer!=='Version verification';
let pairs=[];
try{pairs=fs.readdirSync(path.join(root,'versions'),{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&(PAIR.test(e.name)||(byOdc&&BACKEND.test(e.name)))).map(e=>e.name).sort();}
catch(e){if(e.code!=='ENOENT')out.skipped++;}
const newest={};
for(const pair of pairs){
 const dir=path.join(root,'versions',pair),key=keyOf(pair);of(key);
 let files=[];try{files=fs.readdirSync(dir).filter(f=>/^quality-\d{8}\.jsonl$/.test(f));}catch{out.skipped++;}
 for(const f of files){
  const day=Date.parse(`${f.slice(8,12)}-${f.slice(12,14)}-${f.slice(14,16)}T00:00:00Z`);
  if(!(now-day<8*DAY))continue;
  let text;try{text=fs.readFileSync(path.join(dir,f),'utf8');}catch{out.skipped++;continue;}
  for(const line of text.split('\n')){
   if(!line.trim())continue;
   let r;try{r=JSON.parse(line);}catch{out.skipped++;continue;}
   const at=Date.parse(r?.time);
   if(r?.kind==='call'&&HEAVY.has(r.tool)&&at<=now&&now-at<7*DAY)out.pairs[key].heavy++;
  }
 }
 let state;try{state=JSON.parse(fs.readFileSync(path.join(dir,'state','studio-versions.json'),'utf8'));}
 catch(e){if(e.code!=='ENOENT')out.skipped++;continue;}
 for(const [id,t]of Object.entries(state?.tokens??{})){
  const seen=Date.parse(t?.seen);
  if(!real(t)||!(seen<=now&&now-seen<14*DAY)){continue;}
  if(!newest[id]||newest[id].seen<seen)newest[id]={pair:key,seen};
 }
}
for(const {pair}of Object.values(newest))out.pairs[pair].active++;
console.log(JSON.stringify(out));
