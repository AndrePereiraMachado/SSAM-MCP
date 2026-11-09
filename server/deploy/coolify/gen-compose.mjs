import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const template=JSON.parse(fs.readFileSync(path.join(here,'compose.template.json'),'utf8').replace(/^\uFEFF/,''));
const labels=value=>Array.isArray(value)?Object.fromEntries(value.map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];})):value??{};
export function versionPairs(manifest,window=manifest.window??3){
 if(!Number.isInteger(window)||window<1||window>20)throw new Error('Invalid version window.');
 if(!Array.isArray(manifest.odc)||!Array.isArray(manifest.o11)||!manifest.odc.length||manifest.odc.length!==manifest.o11.length||manifest.odc.length>window)throw new Error('The version pairs must fit the window.');
 const seen=new Set();
 return manifest.odc.map(odc=>{
  const matches=manifest.o11.filter(o=>o.tag===odc.tag&&o.image===odc.image);
  if(matches.length!==1)throw new Error('Every image must declare one pair.');
  const o11=matches[0];
  for(const v of [odc,o11])if(!/^\d+\.\d+\.\d+$/.test(v.version)||!v.image||!v.tag||v.tag==='latest'||!/^[\w.-]+$/.test(v.tag))throw new Error('Invalid pinned image version.');
  if(odc.sha256!==o11.sha256)throw new Error('The pair must use the same digest.');
  if(odc.sha256&&!/^(sha256:)?[a-f0-9]{64}$/.test(odc.sha256))throw new Error('Invalid image digest.');
  const name=`o11-${o11.version}-odc-${odc.version}`;
  if(seen.has(name))throw new Error('Duplicate pair.');seen.add(name);
  return {name,odc:odc.version,o11:o11.version,image:`${odc.image}:${odc.tag}${odc.sha256?'@sha256:'+odc.sha256.replace(/^sha256:/,''):''}`};
 });
}
// The ODC model plugins (MobileUI for every Mobile UI app) are tenant binaries the ODC Studio caches in
// LocalApplicationData\OutSystems\ODC Studio\Plugins; the kernel children get a closed environment (no HOME,
// no ANVIL_ODC_PLUGINS_DIR), so .NET falls back to the passwd home of uid 10001 (/tmp): every backend mounts the
// owner-staged plugin store read-only exactly there (OdcModelPlugins.CacheDirectory).
export const MODEL_PLUGINS_VOLUME='odc-model-plugins';
export const MODEL_PLUGINS_TARGET='/tmp/.local/share/OutSystems/ODC Studio/Plugins';
const servedOf=pairs=>JSON.stringify({odc:[...new Set(pairs.map(p=>p.odc))],o11:[...new Set(pairs.map(p=>p.o11))]});
const threeParts=list=>Array.isArray(list)&&list.length>0&&list.every(v=>/^\d+\.\d+\.\d+$/.test(v))&&new Set(list).size===list.length;
// The SSAM_SERVED_VERSIONS of each backend, in pair order. A backend's identity check counts a Studio served by a newer pair
// as served elsewhere (refused), while the router only reaches that pair through its ODC version, so an older backend that
// learns of a newer O11 would refuse a client (ODC of its own, newer O11) it serves today with a "newer" note. So:
// - served on a pair's entries (the same on its ODC and O11 entry): that backend's frozen list. The watcher records it for
//   every pair it keeps (window.mjs rotateWindow), so a later rotation never changes a running backend's list;
// - else keepServed N (r44): the first N backends keep the served list of the first N pairs (the window they were deployed with);
// - else the whole window.
export function servedLists(manifest,{window=manifest.window??3}={}){
 const pairs=versionPairs(manifest,window),keep=manifest.keepServed??0;
 if(!Number.isInteger(keep)||keep<0||keep>pairs.length)throw new Error('Invalid keepServed.');
 const all=servedOf(pairs),kept=servedOf(pairs.slice(0,keep));
 return pairs.map((p,i)=>{
  const odc=manifest.odc[i],o11=manifest.o11.find(o=>o.tag===odc.tag&&o.image===odc.image);
  if(odc.served===undefined&&o11.served===undefined)return i<keep?kept:all;
  const f=odc.served;
  if(JSON.stringify(f)!==JSON.stringify(o11.served))throw new Error('A pair must freeze one served list on both lanes.');
  if(!f||typeof f!=='object'||Object.keys(f).sort().join()!=='o11,odc'||!threeParts(f.odc)||!threeParts(f.o11)||!f.odc.includes(p.odc)||!f.o11.includes(p.o11))throw new Error('Invalid frozen served list.');
  return JSON.stringify({odc:f.odc,o11:f.o11});
 });
}
// Capacity sizing (KVM 8, measured 2026-11-09: C:/t/r5/capacity/RESULTADO.md). Optional "sizing" in versions.json:
//   {hot:{cpus,memory,cpuShares,buildWorkers,o11WorkersMax,queueMs}, other:{...same}, router:{cpus,memory},
//    host:{memory,reserve}, routed:{"<pair>":<licenses>}, hotPair:"o11-<v>-odc-<v>" (optional owner pin)}.
// The hot backend is chosen by USE, not by recency: the pinned hotPair, else the pair with the most licenses the router
// routes to it (routed: the counts of state/routing.json, recorded by the watcher at each deploy, or by hand), ties and no
// counts going to the router's default pair (the first of the window). Every other backend, the newest pair included when
// it is not the most used, gets "other". Usage is only read when a compose is generated (a deploy that happens anyway):
// a shift of use never redeploys by itself.
// Memory and cpu_shares are literal (a Coolify variable could pass the host check); cpus and the pool sizes are tier
// variables with the manifest's value as default (${SSAM_HOT_CPUS:-5}), so Coolify can still tune one tier. The shared
// SSAM_CPUS/SSAM_MEMORY/SSAM_BUILD_WORKERS/SSAM_O11_WORKERS_MAX no longer reach a sized backend. host: the memory limits
// of the backends, the router and the console must leave host.reserve of host.memory (the VPS MemTotal); a window that
// does not fit is refused (CAPACITY_WINDOW, environmental: the watcher waits and tells the owner), never shrunk.
// Without "sizing" the compose is exactly as before.
export const SIZING_TIERS=['hot','other'];
export const CAPACITY_WINDOW='CAPACITY_WINDOW';
const TIER_KEYS={cpus:'CPUS',buildWorkers:'BUILD_WORKERS',o11WorkersMax:'O11_WORKERS_MAX',queueMs:'BUILD_QUEUE_MS'};
const TIER_FIELDS=['cpus','memory','cpuShares',...Object.keys(TIER_KEYS).filter(k=>k!=='cpus')];
const PAIR_NAME=/^o11-\d+\.\d+\.\d+-odc-\d+\.\d+\.\d+$/;
const mib=value=>{const m=/^(\d+)([mg])$/i.exec(String(value));return m?Number(m[1])*(m[2].toLowerCase()==='g'?1024:1):null;};
const isCpus=value=>/^\d+(?:\.\d+)?$/.test(String(value))&&Number(value)>0;
// The index of the hot pair in the window: the pinned one, else the most routed (ties: the earlier pair, the default first).
export function hotPairIndex(manifest,{window=manifest.window??3}={}){
 const pairs=versionPairs(manifest,window),pin=manifest.sizing?.hotPair,routed=manifest.sizing?.routed??{};
 if(pin!==undefined&&pin!==null){const at=pairs.findIndex(p=>p.name===pin);if(at<0)throw new Error('sizing.hotPair names no pair of the window.');return at;}
 return pairs.reduce((best,p,i)=>(routed[p.name]??0)>(routed[pairs[best].name]??0)?i:best,0);
}
export const hotPairName=manifest=>manifest.sizing===undefined?null:versionPairs(manifest)[hotPairIndex(manifest)].name;
export function checkSizing(sizing){
 if(!sizing||typeof sizing!=='object'||Array.isArray(sizing))throw new Error('Invalid sizing.');
 const known=new Set([...SIZING_TIERS,'router','host','routed','hotPair']);
 for(const k of Object.keys(sizing))if(!known.has(k))throw new Error('Unknown sizing key '+k+'.');
 for(const tier of SIZING_TIERS){
  const t=sizing[tier];
  if(!t||typeof t!=='object')throw new Error('sizing.'+tier+' is required.');
  for(const k of Object.keys(t))if(!TIER_FIELDS.includes(k))throw new Error('Unknown sizing.'+tier+' key '+k+'.');
  if(!isCpus(t.cpus))throw new Error('Invalid sizing.'+tier+'.cpus.');
  if(!mib(t.memory)||mib(t.memory)<1024)throw new Error('Invalid sizing.'+tier+'.memory.');
  if(!Number.isInteger(t.cpuShares)||t.cpuShares<2||t.cpuShares>262144)throw new Error('Invalid sizing.'+tier+'.cpuShares.');
  for(const k of ['buildWorkers','o11WorkersMax'])if(!Number.isInteger(t[k])||t[k]<1||t[k]>64)throw new Error('Invalid sizing.'+tier+'.'+k+'.');
  if(!Number.isInteger(t.queueMs)||t.queueMs<0)throw new Error('Invalid sizing.'+tier+'.queueMs.');
 }
 if(sizing.router!==undefined&&(!isCpus(sizing.router?.cpus)||!mib(sizing.router?.memory)||Object.keys(sizing.router).some(k=>!['cpus','memory'].includes(k))))throw new Error('Invalid sizing.router.');
 if(sizing.host!==undefined&&(!mib(sizing.host?.memory)||!mib(sizing.host?.reserve)||Object.keys(sizing.host).some(k=>!['memory','reserve'].includes(k))))throw new Error('Invalid sizing.host.');
 if(sizing.routed!==undefined&&(!sizing.routed||typeof sizing.routed!=='object'||Array.isArray(sizing.routed)||Object.entries(sizing.routed).some(([k,v])=>!PAIR_NAME.test(k)||!Number.isInteger(v)||v<0)))throw new Error('Invalid sizing.routed.');
 if(sizing.hotPair!==undefined&&sizing.hotPair!==null&&!PAIR_NAME.test(sizing.hotPair))throw new Error('Invalid sizing.hotPair.');
 return sizing;
}
// The router counts of the live routing.json (pair name -> licenses), kept for the pairs of the window only.
export function withRouted(manifest,routed){
 if(manifest.sizing===undefined||!routed)return manifest;
 const names=new Set(versionPairs(manifest).map(p=>p.name)),next=structuredClone(manifest);
 next.sizing.routed=Object.fromEntries(Object.entries(routed).filter(([k,v])=>names.has(k)&&Number.isInteger(v)&&v>0).sort(([a],[b])=>a.localeCompare(b)));
 checkSizing(next.sizing);return next;
}
// The memory limits of a sized window in MiB (backends, router, console) against host.memory - host.reserve. A window that
// does not fit throws CAPACITY_WINDOW (environmental), whoever asks: the generator and the watcher's rotation.
export function hostBudget(manifest,{window=manifest.window??3}={}){
 const sizing=checkSizing(manifest.sizing),n=versionPairs(manifest,window).length;
 const consoleMb=mib(template.services['ssam-console']?.deploy?.resources?.limits?.memory)??0;
 const router=sizing.router?mib(sizing.router.memory):6144;
 const used=mib(sizing.hot.memory)+(n-1)*mib(sizing.other.memory)+router+consoleMb;
 const available=sizing.host?mib(sizing.host.memory)-mib(sizing.host.reserve):Infinity;
 if(used>available)throw Object.assign(new Error(`A window of ${n} pairs needs ${used} MiB of memory limits (hot ${sizing.hot.memory}, ${n-1} x ${sizing.other.memory}, router, console) and the host leaves ${available} MiB after its reserve; it is not deployed until a pair leaves or the owner changes sizing.`),{code:CAPACITY_WINDOW,environmental:true});
 return {used,available,pairs:n};
}
const tierVar=(tier,key,value)=>'${SSAM_'+tier.toUpperCase()+'_'+TIER_KEYS[key]+':-'+value+'}';
// The tier of each backend, in pair order ('hot' | 'other'), or null without sizing.
export function backendTiers(manifest,{window=manifest.window??3}={}){
 if(manifest.sizing===undefined)return null;
 checkSizing(manifest.sizing);
 const hot=hotPairIndex(manifest,{window});
 return versionPairs(manifest,window).map((_,i)=>i===hot?'hot':'other');
}
function applySizing(c,manifest,tiers,window){
 const sizing=manifest.sizing,router=c.services['ssam-router'];
 hostBudget(manifest,{window});
 // The whole sizing rides on the router, so the watcher reads it back from the live compose (sizingOfCompose).
 router.labels['ssam.sizing']=JSON.stringify(sizing);
 if(sizing.router)router.deploy={resources:{limits:{...router.deploy.resources.limits,cpus:'${SSAM_ROUTER_CPUS:-'+sizing.router.cpus+'}',memory:sizing.router.memory}}};
 tiers.forEach((tier,i)=>{
  const s=c.services[`ssam-server-v${i+1}`],t=sizing[tier];
  s.deploy.resources.limits={...s.deploy.resources.limits,cpus:tierVar(tier,'cpus',t.cpus),memory:t.memory};
  s.cpu_shares=t.cpuShares;
  Object.assign(s.environment,{SSAM_BUILD_WORKERS:tierVar(tier,'buildWorkers',t.buildWorkers),SSAM_O11_WORKERS_MAX:tierVar(tier,'o11WorkersMax',t.o11WorkersMax),SSAM_BUILD_QUEUE_MS:tierVar(tier,'queueMs',t.queueMs)});
  s.labels['ssam.sizing']=tier;
 });
}
// The sizing a deployed compose was generated with (the router's ssam.sizing label), or undefined for an unsized one.
export function sizingOfCompose(compose){
 const text=compose?.services?.['ssam-router']?.labels?.['ssam.sizing'];
 if(text===undefined)return undefined;
 let sizing;try{sizing=JSON.parse(text);}catch{throw new Error('The live router carries an unreadable ssam.sizing.');}
 return checkSizing(sizing);
}
export function generateCompose(manifest,{window=manifest.window??3}={}){
 // Coolify 4.4.6 corrupts image@sha256 references. Immutable tags are checked against the recorded digest.
 const pairs=versionPairs(manifest,window).map(p=>({...p,digest:p.image.split('@')[1]??null,image:p.image.split('@')[0]})),c=structuredClone(template),source=c.services['ssam-server'];
 // Each backend's served list: its frozen one, keepServed, or the whole window (servedLists).
 const lists=servedLists(manifest,{window});
 delete c.name;c.networks.default={};c.volumes={'server-state':{},friction:{},'runtime-css':{}};
 const routing=pairs.map((p,i)=>({name:p.name,url:`http://ssam-server-v${i+1}:7310`,odc:p.odc,o11:p.o11,default:i===0}));
 delete c.services['ssam-server'];
 for(const service of Object.values(c.services)){delete service.labels;service.image=pairs[0].image;}
 pairs.forEach((p,i)=>{
  const s=structuredClone(source);s.image=p.image;
  s.labels={'ssam.backend':'true','ssam.odc':p.odc,'ssam.o11':p.o11,'ssam.default':String(i===0),...(p.digest?{'ssam.image.digest':p.digest}:{})};
  Object.assign(s.environment,{SSAM_BACKEND_NAME:p.name,SSAM_RUNTIME_DIR:`/data/server/versions/${p.name}`,SSAM_SERVED_VERSIONS:lists[i]});
  for(const v of s.volumes)if(['cache','odc-features'].includes(v.source)){v.source=`${v.source}-${p.name.replaceAll('.','-')}`;c.volumes[v.source]={};}
  c.services[`ssam-server-v${i+1}`]=s;
 });
 const router=structuredClone(source);router.image=pairs[0].image;router.entrypoint=['node'];router.command=['facade/router.mjs'];router.expose=['7300'];
 router.environment={SSAM_DATABASE_URL:source.environment.SSAM_DATABASE_URL,SSAM_PORT:'7300',SSAM_HOST:'0.0.0.0',SSAM_SERVER_DIR:'/data/server',SSAM_PUBLIC_HOST:source.environment.SSAM_PUBLIC_HOST,SSAM_CONSOLE_HOST:'${CONSOLE_DOMAIN}',SSAM_CONSOLE_URL:'http://ssam-console:7320',SSAM_VERSION_WINDOW:String(window),SSAM_ROUTER_BACKENDS:JSON.stringify(routing)};
 router.labels={...labels(template.services['ssam-server'].labels),...labels(template.services['ssam-console'].labels)};
 router.labels['traefik.http.services.ssam.loadbalancer.server.port']='7300';router.labels['traefik.http.services.ssam-console.loadbalancer.server.port']='7300';
 router.healthcheck.test=router.healthcheck.test.map(v=>v.replace('7310','7300').replace('timeout(4000)','timeout(6000)'));
 router.healthcheck.timeout='7s';
 router.volumes=source.volumes.filter(v=>v.source==='server-state');
 c.services['ssam-router']=router;
 // Administrative containers retain shared state; their optional data mounts use the default pair.
 for(const name of ['ssam-admin','ssam-console'])for(const v of c.services[name]?.volumes??[])if(['cache','odc-features'].includes(v.source))v.source=`${v.source}-${pairs[0].name.replaceAll('.','-')}`;
 // Every shared read-only named volume a service mounts is declared (odc-model-plugins: the owner stages it).
 for(const s of Object.values(c.services))for(const v of s.volumes??[])if(v.read_only===true&&(v.type??'volume')==='volume'&&typeof v.source==='string'&&!(v.source in c.volumes))c.volumes[v.source]={};
 const tiers=backendTiers(manifest,{window});
 if(tiers)applySizing(c,manifest,tiers,window);
 return c;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const input=process.argv[2]??path.join(here,'versions.json'),output=process.argv[3]??path.join(here,'compose.coolify.yml');
 const manifest=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''));
 const window=Number(process.env.SSAM_VERSION_WINDOW??manifest.window??3);
 fs.writeFileSync(output,'# Generated by gen-compose.mjs. Edit versions.json and regenerate.\n'+JSON.stringify(generateCompose(manifest,{window}),null,2)+'\n');
}
