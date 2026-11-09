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
//   {hot:{cpus,memory,buildWorkers,o11WorkersMax,queueMs}, other:{...same}, router:{cpus,memory}, host:{memory,reserve},
//    hotPair:"o11-<v>-odc-<v>" (optional pin)}.
// The hot backend is the NEWEST served pair (ODC Studio version first, then Service Studio: where most customers land,
// whatever its place in the manifest), unless hotPair pins another pair of the window; every other backend gets "other".
// Each value is written as a tier variable with the manifest's value as its default (${SSAM_HOT_CPUS:-4}), so Coolify can
// still override one tier without a new compose; the shared SSAM_CPUS/SSAM_MEMORY/SSAM_BUILD_WORKERS/SSAM_O11_WORKERS_MAX
// no longer reach a sized backend. host: the sum of the memory limits (backends, router, console) at their defaults
// leaves reserve for Coolify, its Postgres, the proxy and the OS; a larger window shrinks the other tier to fit (never below
// OTHER_FLOOR_MIB, else refused). Without "sizing" the compose is exactly as before.
export const SIZING_TIERS=['hot','other'];
// The least memory limit an other-tier backend gets when the host budget shrinks it (server, one build, one O11 worker).
export const OTHER_FLOOR_MIB=2048;
const TIER_KEYS={cpus:'CPUS',memory:'MEMORY',buildWorkers:'BUILD_WORKERS',o11WorkersMax:'O11_WORKERS_MAX',queueMs:'BUILD_QUEUE_MS'};
const compareVersion=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
const mib=value=>{const m=/^(\d+(?:\.\d+)?)([mg])$/i.exec(String(value));return m?Math.round(Number(m[1])*(m[2].toLowerCase()==='g'?1024:1)):null;};
const isCpus=value=>/^\d+(?:\.\d+)?$/.test(String(value))&&Number(value)>0;
// The index of the hot pair in the window: the pinned one, else the newest by ODC, then O11 version.
export function hotPairIndex(manifest,{window=manifest.window??3}={}){
 const pairs=versionPairs(manifest,window),pin=manifest.sizing?.hotPair;
 if(pin!==undefined&&pin!==null){const at=pairs.findIndex(p=>p.name===pin);if(at<0)throw new Error('sizing.hotPair names no pair of the window.');return at;}
 return pairs.reduce((best,p,i)=>compareVersion(p.odc,pairs[best].odc)>0||(compareVersion(p.odc,pairs[best].odc)===0&&compareVersion(p.o11,pairs[best].o11)>0)?i:best,0);
}
export function checkSizing(sizing){
 if(!sizing||typeof sizing!=='object'||Array.isArray(sizing))throw new Error('Invalid sizing.');
 const known=new Set([...SIZING_TIERS,'router','host','hotPair']);
 for(const k of Object.keys(sizing))if(!known.has(k))throw new Error('Unknown sizing key '+k+'.');
 for(const tier of SIZING_TIERS){
  const t=sizing[tier];
  if(!t||typeof t!=='object')throw new Error('sizing.'+tier+' is required.');
  for(const k of Object.keys(t))if(!(k in TIER_KEYS))throw new Error('Unknown sizing.'+tier+' key '+k+'.');
  if(!isCpus(t.cpus))throw new Error('Invalid sizing.'+tier+'.cpus.');
  if(!mib(t.memory)||mib(t.memory)<1024)throw new Error('Invalid sizing.'+tier+'.memory.');
  for(const k of ['buildWorkers','o11WorkersMax'])if(!Number.isInteger(t[k])||t[k]<1||t[k]>64)throw new Error('Invalid sizing.'+tier+'.'+k+'.');
  if(!Number.isInteger(t.queueMs)||t.queueMs<0)throw new Error('Invalid sizing.'+tier+'.queueMs.');
 }
 if(sizing.router!==undefined&&(!isCpus(sizing.router?.cpus)||!mib(sizing.router?.memory)||Object.keys(sizing.router).some(k=>!['cpus','memory'].includes(k))))throw new Error('Invalid sizing.router.');
 if(sizing.host!==undefined&&(!mib(sizing.host?.memory)||!mib(sizing.host?.reserve)||Object.keys(sizing.host).some(k=>!['memory','reserve'].includes(k))))throw new Error('Invalid sizing.host.');
 if(sizing.hotPair!==undefined&&sizing.hotPair!==null&&!/^o11-\d+\.\d+\.\d+-odc-\d+\.\d+\.\d+$/.test(sizing.hotPair))throw new Error('Invalid sizing.hotPair.');
 return sizing;
}
const tierVar=(tier,key,value)=>'${SSAM_'+tier.toUpperCase()+'_'+TIER_KEYS[key]+':-'+value+'}';
// The tier of each backend, in pair order ('hot' | 'other'), or null without sizing.
export function backendTiers(manifest,{window=manifest.window??3}={}){
 if(manifest.sizing===undefined)return null;
 checkSizing(manifest.sizing);
 const hot=hotPairIndex(manifest,{window});
 return versionPairs(manifest,window).map((_,i)=>i===hot?'hot':'other');
}
function applySizing(c,manifest,tiers){
 const sizing=manifest.sizing,router=c.services['ssam-router'];
 // The whole sizing rides on the router, so the watcher reads it back from the live compose (sizingOfCompose).
 router.labels['ssam.sizing']=JSON.stringify(sizing);
 if(sizing.router)router.deploy={resources:{limits:{...router.deploy.resources.limits,cpus:'${SSAM_ROUTER_CPUS:-'+sizing.router.cpus+'}',memory:'${SSAM_ROUTER_MEMORY:-'+sizing.router.memory+'}'}}};
 // host: the other tier's memory shrinks to what the host leaves once the hot backend, the router, the console and the
 // reserve are counted (a window grown past its usual size by a retained client), never below OTHER_FLOOR_MIB.
 const memory={hot:sizing.hot.memory,other:sizing.other.memory};
 if(sizing.host){
  const defaultOf=(name,m)=>{const n=mib(/:-([^}]+)\}$/.exec(String(m))?.[1]??m);if(!n)throw new Error('No memory limit default for '+name+'.');return n;};
  const fixed=Object.entries(c.services).filter(([name,s])=>!s.profiles&&!/^ssam-server-v\d+$/.test(name)&&s.deploy?.resources?.limits?.memory!==undefined).reduce((sum,[name,s])=>sum+defaultOf(name,s.deploy.resources.limits.memory),0);
  const others=tiers.filter(t=>t==='other').length,left=mib(sizing.host.memory)-mib(sizing.host.reserve)-fixed-mib(sizing.hot.memory);
  const each=others?Math.floor(left/others/128)*128:left;
  if(left<0||(others&&each<OTHER_FLOOR_MIB))throw new Error(`The memory limits leave less than sizing.host.reserve on the host (${others} other backends would get ${Math.max(0,each)} MiB each; the floor is ${OTHER_FLOOR_MIB}).`);
  if(others&&each<mib(sizing.other.memory))memory.other=each+'m';
 }
 tiers.forEach((tier,i)=>{
  const s=c.services[`ssam-server-v${i+1}`],t=sizing[tier];
  s.deploy.resources.limits={...s.deploy.resources.limits,cpus:tierVar(tier,'cpus',t.cpus),memory:tierVar(tier,'memory',memory[tier])};
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
 if(tiers)applySizing(c,manifest,tiers);
 return c;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const input=process.argv[2]??path.join(here,'versions.json'),output=process.argv[3]??path.join(here,'compose.coolify.yml');
 const manifest=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''));
 const window=Number(process.env.SSAM_VERSION_WINDOW??manifest.window??3);
 fs.writeFileSync(output,'# Generated by gen-compose.mjs. Edit versions.json and regenerate.\n'+JSON.stringify(generateCompose(manifest,{window}),null,2)+'\n');
}
