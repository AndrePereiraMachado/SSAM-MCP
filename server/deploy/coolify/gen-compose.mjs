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
// Window 4x4 (design B: C:/t/r5/janela-4x4/DESENHO.md 1.4 item 8). A manifest with "backends" is a window of ONE backend
// per ODC Studio version, each image carrying every O11 kernel of the window (server/deploy/gen-dockerfile.mjs):
//   {"window": 4, "o11": {"served": ["11.55.92", ...], "kernels": [...]?}, "backends": [{"odc": "1.7.32", "image": "...",
//    "tag": "prod-...", "sha256": "<64 hex>"?, "o11Kernels": [...]?}, ...], "sizing": {...}?}
//   - o11.served: the O11 versions every backend serves (SSAM_SERVED_VERSIONS o11, the same on every backend; the router never
//     reaches a backend by its O11 version, hosted/router.mjs); o11.kernels (default served): what the images are built with,
//     every served version among them;
//   - backends[].o11Kernels (default o11.kernels): the kernels that image carries, which must hold every served version (its
//     label ssam.kernels.o11, checked by the deploy kit); the backend is named odc-<version>;
//   - the default backend (the router's fallback: no ODC Studio, an older one) is the NEWEST ODC.
// A manifest with "odc"/"o11" lists is the window of pairs (versionPairs), generated exactly as before: the watcher keeps
// using it until its own per-lane window (phase S2).
export const BACKEND_NAME=/^odc-\d+\.\d+\.\d+$/;
const versionKey=v=>v.split('.').map(Number);
const newerVersion=(a,b)=>{const x=versionKey(a),y=versionKey(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;};
const sortVersions=list=>[...list].sort((a,b)=>newerVersion(a,b)?1:newerVersion(b,a)?-1:0);
export const isBackendManifest=manifest=>Array.isArray(manifest?.backends);
export function versionBackends(manifest,window=manifest.window??4){
 if(!Number.isInteger(window)||window<1||window>20)throw new Error('Invalid version window.');
 if(manifest.odc!==undefined)throw new Error('A backend window has no "odc" list (one backend per ODC version).');
 const list=manifest.backends;
 if(!Array.isArray(list)||!list.length||list.length>window)throw new Error('The backends must fit the window.');
 const o11=manifest.o11;
 if(!o11||typeof o11!=='object'||Array.isArray(o11)||Object.keys(o11).some(k=>!['served','kernels'].includes(k)))throw new Error('A backend window needs o11 {served, kernels?}.');
 if(!threeParts(o11.served))throw new Error('Invalid o11.served.');
 const kernels=o11.kernels??o11.served;
 if(!threeParts(kernels)||o11.served.some(v=>!kernels.includes(v)))throw new Error('Invalid o11.kernels: every served O11 version needs its kernel.');
 const seen=new Set();
 const out=list.map(b=>{
  if(!b||typeof b!=='object'||Object.keys(b).some(k=>!['odc','image','tag','sha256','o11Kernels'].includes(k)))throw new Error('Invalid backend entry.');
  if(!/^\d+\.\d+\.\d+$/.test(b.odc??'')||!b.image||!b.tag||b.tag==='latest'||!/^[\w.-]+$/.test(b.tag))throw new Error('Invalid pinned image version.');
  if(b.sha256&&!/^(sha256:)?[a-f0-9]{64}$/.test(b.sha256))throw new Error('Invalid image digest.');
  const carried=b.o11Kernels??kernels;
  if(!threeParts(carried))throw new Error('Invalid o11Kernels of backend '+b.odc+'.');
  const missing=o11.served.filter(v=>!carried.includes(v));
  if(missing.length)throw new Error('The image of backend odc-'+b.odc+' lacks the O11 kernels '+missing.join(', ')+' the window serves.');
  const name='odc-'+b.odc;
  if(seen.has(name))throw new Error('Duplicate backend.');seen.add(name);
  return {name,odc:b.odc,o11:sortVersions(o11.served),kernels:sortVersions(carried),image:`${b.image}:${b.tag}${b.sha256?'@sha256:'+b.sha256.replace(/^sha256:/,''):''}`};
 });
 // Newest ODC first, as the watcher orders the pairs: ssam-server-v1 is the default backend in both windows.
 return out.sort((a,b)=>newerVersion(a.odc,b.odc)?-1:newerVersion(b.odc,a.odc)?1:0);
}
// The window of a manifest when the caller names none: a backend window is 4 (the 4x4 window), a pair window 3 (as before).
export const windowOf=manifest=>manifest.window??(isBackendManifest(manifest)?4:3);
// The backends of either window, in service order (ssam-server-v1 first, the router's default): {name, odc, o11, image}
// with o11 one version (a pair) or the served list (a backend window, plus kernels).
export function backendsOf(manifest,{window=windowOf(manifest)}={}){
 return isBackendManifest(manifest)?versionBackends(manifest,window):versionPairs(manifest,window);
}
// The ODC model plugins (MobileUI for every Mobile UI app) are tenant binaries the ODC Studio caches in
// LocalApplicationData\OutSystems\ODC Studio\Plugins; the kernel children get a closed environment (no HOME,
// no ANVIL_ODC_PLUGINS_DIR), so .NET falls back to the passwd home of uid 10001 (/tmp): every backend mounts the
// owner-staged plugin store read-only exactly there (OdcModelPlugins.CacheDirectory).
export const MODEL_PLUGINS_VOLUME='odc-model-plugins';
export const BRIDGES_VOLUME='ssam-bridges';
export const BRIDGES_TARGET='/data/bridges';
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
// A backend window: one list for every backend, {odc: every backend's ODC version, o11: o11.served}. The ODC list is the whole
// window, not the backend's own version (design 1.4 item 8 corrected, S1-RESULTADO): an ODC Studio upgraded under a live
// session to a version another backend serves must read "served elsewhere" (the hub redirects), never "newer". No frozen
// lists nor keepServed there: the router never reaches a backend by its O11 version, so no backend can refuse a client the
// window serves.
export function servedLists(manifest,{window=windowOf(manifest)}={}){
 if(isBackendManifest(manifest)){
  if(manifest.keepServed!==undefined)throw new Error('keepServed belongs to a pair window.');
  const backends=versionBackends(manifest,window),one=JSON.stringify({odc:backends.map(b=>b.odc),o11:backends[0].o11});
  return backends.map(()=>one);
 }
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
// Capacity sizing (KVM 8, measured 2026-11-09: C:/t/r5/capacity/RESULTADO.md, RESULTADO-R2.md). Optional "sizing" in
// versions.json:
//   {hot:{cpus,memory,cpuShares,buildWorkers,o11WorkersMax,queueMs}, other:{...same}, router:{cpus,memory},
//    host:{memory,reserve}, usage:{"<pair>":{heavy,active}}, hotPair:"o11-<v>-odc-<v>" (optional owner pin)}.
// The hot backend is chosen by REAL USE, not by recency nor by licenses ever routed: the pinned hotPair, else the pair with
// the most heavy calls of the last 7 days (usage.heavy: studio_deliver, o11_deliver, ssam_code in its quality log), then the
// most clients active in the last 14 days (usage.active), ties and no counts going to the router's default pair (the first
// of the window). The counts are read inside a live backend at each deploy (vigia/usage-count.cjs, counts only) and
// recorded here; usage is only read when a compose is generated (a deploy that happens anyway): a shift of use never
// redeploys by itself. Every other backend, the newest pair included when it is not the most used, gets "other".
// Every value is literal in the compose (review M3/M3'): Coolify 4.4.6 persisted the defaults of ${VAR:-default} in the
// environment sections as resource variables (2026-10-20 rows equal to the defaults), so a tier variable could freeze or
// override a tier silently; versions.json is the only source, checked here. The shared SSAM_CPUS/SSAM_MEMORY/
// SSAM_BUILD_WORKERS/SSAM_O11_WORKERS_MAX no longer reach a sized backend. host: the memory limits of the backends, the
// router and the console must leave host.reserve of host.memory (the VPS MemTotal); a window that does not fit is refused
// (CAPACITY_WINDOW, environmental: the watcher waits and tells the owner), never shrunk.
// cpuShares on cgroup v2 (the VPS, runc 1.5.1, systemd driver): runc 1.3 and later convert shares to cpu.weight with the
// quadratic of opencontainers/cgroups (ConvertCPUSharesToCgroupV2Value, cpuWeight below), not the linear 1+(s-2)*9999/262142
// of older runc: 1024 -> 100 (measured on the VPS 2026-11-09: a container with CpuShares 1024 has cpu.weight 100), 5768..5784
// -> 400. So the other tier is 1024 (the default 100 of the router, the console, Coolify and Postgres) and the hot one 5776
// (400, the middle of the range: half a unit of float margin each side of the ceil): hot/other = 4 (review R3 A1).
// Without "sizing" the compose is exactly as before.
export const SIZING_TIERS=['hot','other'];
export const CAPACITY_WINDOW='CAPACITY_WINDOW';
const TIER_FIELDS=['cpus','memory','cpuShares','buildWorkers','o11WorkersMax','queueMs','o11Readers'];
// Window 4x4 (review S1 M2): the resident O11 readers a backend of the window keeps (SSAM_O11_READERS_MAX, reader-residency.mjs),
// optional per tier; a backend window without it gets other 1 (the one reader of a pair, inside the r45 margin of 969 MiB)
// and hot 2 (one more inside its 1542 MiB). A pair window only carries it when the tier names it.
export const DEFAULT_O11_READERS=Object.freeze({hot:2,other:1});
const readersOf=(manifest,tier)=>manifest.sizing?.[tier]?.o11Readers??(isBackendManifest(manifest)?DEFAULT_O11_READERS[tier]:undefined);
const readersEnv=(manifest,tier)=>{const r=readersOf(manifest,tier);return r===undefined?{}:{SSAM_O11_READERS_MAX:String(r)};};
// A backend id: a pair (o11-<v>-odc-<v>) or a backend of the 4x4 window (odc-<v>); usage and hotPair are keyed by it.
const PAIR_NAME=/^(?:o11-\d+\.\d+\.\d+-)?odc-\d+\.\d+\.\d+$/;
const mib=value=>{const m=/^(\d+)([mg])$/i.exec(String(value));return m?Number(m[1])*(m[2].toLowerCase()==='g'?1024:1):null;};
const isCpus=value=>/^\d+(?:\.\d+)?$/.test(String(value))&&Number(value)>0&&Number(value)<=64;
const count=v=>Number.isInteger(v)&&v>=0;
// cpu.weight runc (1.3+) writes for cpu_shares (opencontainers/cgroups ConvertCPUSharesToCgroupV2Value); 0 is unset (100).
export const cpuWeight=shares=>{if(!shares)return 100;if(shares<=2)return 1;if(shares>=262144)return 10000;const l=Math.log2(shares);return Math.ceil(10**((l*l+125*l)/612-7/34));};
// The use of a pair as a sort key: heavy calls of 7 days first, then active clients of 14 days.
const useOf=(usage,name)=>[usage?.[name]?.heavy??0,usage?.[name]?.active??0];
const more=(a,b)=>a[0]!==b[0]?a[0]>b[0]:a[1]>b[1];
// The index of the hot pair in the window: the pinned one, else the most used (ties: the earlier pair, the default first).
export function hotPairIndex(manifest,{window=windowOf(manifest)}={}){
 const pairs=backendsOf(manifest,{window}),pin=manifest.sizing?.hotPair,usage=manifest.sizing?.usage;
 if(pin!==undefined&&pin!==null){const at=pairs.findIndex(p=>p.name===pin);if(at<0)throw new Error('sizing.hotPair names no pair of the window.');return at;}
 return pairs.reduce((best,p,i)=>more(useOf(usage,p.name),useOf(usage,pairs[best].name))?i:best,0);
}
export const hotPairName=manifest=>manifest.sizing===undefined?null:backendsOf(manifest)[hotPairIndex(manifest)].name;
export function checkSizing(sizing){
 if(!sizing||typeof sizing!=='object'||Array.isArray(sizing))throw new Error('Invalid sizing.');
 const known=new Set([...SIZING_TIERS,'router','host','usage','hotPair']);
 for(const k of Object.keys(sizing))if(!known.has(k))throw new Error('Unknown sizing key '+k+'.');
 for(const tier of SIZING_TIERS){
  const t=sizing[tier];
  if(!t||typeof t!=='object')throw new Error('sizing.'+tier+' is required.');
  for(const k of Object.keys(t))if(!TIER_FIELDS.includes(k))throw new Error('Unknown sizing.'+tier+' key '+k+'.');
  if(!isCpus(t.cpus))throw new Error('Invalid sizing.'+tier+'.cpus.');
  if(!mib(t.memory)||mib(t.memory)<1024)throw new Error('Invalid sizing.'+tier+'.memory.');
  if(!Number.isInteger(t.cpuShares)||t.cpuShares<2||t.cpuShares>262144)throw new Error('Invalid sizing.'+tier+'.cpuShares.');
  for(const k of ['buildWorkers','o11WorkersMax'])if(!Number.isInteger(t[k])||t[k]<1||t[k]>16)throw new Error('Invalid sizing.'+tier+'.'+k+'.');
  if(!Number.isInteger(t.queueMs)||t.queueMs<0||t.queueMs>3600000)throw new Error('Invalid sizing.'+tier+'.queueMs.');
  if(t.o11Readers!==undefined&&(!Number.isInteger(t.o11Readers)||t.o11Readers<1||t.o11Readers>8))throw new Error('Invalid sizing.'+tier+'.o11Readers.');
 }
 if(sizing.router!==undefined&&(!isCpus(sizing.router?.cpus)||!mib(sizing.router?.memory)||mib(sizing.router.memory)<256||Object.keys(sizing.router).some(k=>!['cpus','memory'].includes(k))))throw new Error('Invalid sizing.router.');
 if(sizing.host!==undefined&&(!mib(sizing.host?.memory)||!mib(sizing.host?.reserve)||Object.keys(sizing.host).some(k=>!['memory','reserve'].includes(k))))throw new Error('Invalid sizing.host.');
 if(sizing.usage!==undefined&&(!sizing.usage||typeof sizing.usage!=='object'||Array.isArray(sizing.usage)||Object.entries(sizing.usage).some(([k,v])=>!PAIR_NAME.test(k)||!v||typeof v!=='object'||Object.keys(v).sort().join()!=='active,heavy'||!count(v.heavy)||!count(v.active))))throw new Error('Invalid sizing.usage.');
 if(sizing.hotPair!==undefined&&sizing.hotPair!==null&&!PAIR_NAME.test(sizing.hotPair))throw new Error('Invalid sizing.hotPair.');
 return sizing;
}
// The live usage counts (vigia/usage-count.cjs: pair name -> {heavy, active}) recorded in the manifest. A pair that left the
// window has its counts folded into the router's default pair (the first), where the router sends its clients
// (routeOf -> fallback) until their next hello; an entry that is not counts is ignored. null usage keeps the recorded counts.
export function withUsage(manifest,usage){
 if(manifest.sizing===undefined||!usage||typeof usage!=='object'||Array.isArray(usage))return manifest;
 const pairs=backendsOf(manifest),names=new Set(pairs.map(p=>p.name)),next=structuredClone(manifest),out={};
 // A pair counted before the 4x4 window (o11-<v>-odc-<v>) folds into the backend of its ODC version when there is one.
 const odcBackend=name=>{const m=/^o11-[\d.]+-(odc-\d+\.\d+\.\d+)$/.exec(name);return m&&names.has(m[1])?m[1]:null;};
 for(const [name,v] of Object.entries(usage)){
  if(!PAIR_NAME.test(name)||!v||typeof v!=='object'||!count(v.heavy)||!count(v.active))continue;
  const into=names.has(name)?name:odcBackend(name)??pairs[0].name,at=out[into]??={heavy:0,active:0};
  at.heavy+=v.heavy;at.active+=v.active;
 }
 next.sizing.usage=Object.fromEntries(Object.entries(out).filter(([,v])=>v.heavy||v.active).sort(([a],[b])=>a.localeCompare(b)));
 checkSizing(next.sizing);return next;
}
// The memory limits of a sized window in MiB (backends, router, console) against host.memory - host.reserve. A window that
// does not fit throws CAPACITY_WINDOW (environmental), whoever asks: the generator and the watcher's rotation.
export function hostBudget(manifest,{window=windowOf(manifest)}={}){
 const sizing=checkSizing(manifest.sizing),n=backendsOf(manifest,{window}).length;
 const consoleMb=mib(template.services['ssam-console']?.deploy?.resources?.limits?.memory)??0;
 const router=sizing.router?mib(sizing.router.memory):6144;
 const used=mib(sizing.hot.memory)+(n-1)*mib(sizing.other.memory)+router+consoleMb;
 const available=sizing.host?mib(sizing.host.memory)-mib(sizing.host.reserve):Infinity;
 if(used>available)throw Object.assign(new Error(`A window of ${n} pairs needs ${used} MiB of memory limits (hot ${sizing.hot.memory}, ${n-1} x ${sizing.other.memory}, router, console) and the host leaves ${available} MiB after its reserve; it is not deployed until a pair leaves or the owner changes sizing.`),{code:CAPACITY_WINDOW,environmental:true});
 return {used,available,pairs:n};
}
// The tier of each backend, in pair order ('hot' | 'other'), or null without sizing.
export function backendTiers(manifest,{window=windowOf(manifest)}={}){
 if(manifest.sizing===undefined)return null;
 checkSizing(manifest.sizing);
 const hot=hotPairIndex(manifest,{window});
 return backendsOf(manifest,{window}).map((_,i)=>i===hot?'hot':'other');
}
// What docker inspect must show on each sized service after a deploy (the deploy kit's check, every backend): NanoCpus,
// Memory bytes, CpuShares and the pool environment. null without sizing.
export function sizedExpectations(manifest,{window=windowOf(manifest)}={}){
 const tiers=backendTiers(manifest,{window});if(!tiers)return null;
 const s=manifest.sizing,bytes=v=>mib(v)*1024*1024,nano=v=>Math.round(Number(v)*1e9);
 const out={};
 tiers.forEach((tier,i)=>{const t=s[tier];out[`ssam-server-v${i+1}`]={tier,pair:backendsOf(manifest,{window})[i].name,NanoCpus:nano(t.cpus),Memory:bytes(t.memory),CpuShares:t.cpuShares,
  env:{SSAM_BUILD_WORKERS:String(t.buildWorkers),SSAM_O11_WORKERS_MAX:String(t.o11WorkersMax),SSAM_BUILD_QUEUE_MS:String(t.queueMs),...readersEnv(manifest,tier)}};});
 if(s.router)out['ssam-router']={NanoCpus:nano(s.router.cpus),Memory:bytes(s.router.memory)};
 return out;
}
function applySizing(c,manifest,tiers,window){
 const sizing=manifest.sizing,router=c.services['ssam-router'];
 hostBudget(manifest,{window});
 // The whole sizing rides on the router, so the watcher reads it back from the live compose (sizingOfCompose).
 router.labels['ssam.sizing']=JSON.stringify(sizing);
 if(sizing.router)router.deploy={resources:{limits:{...router.deploy.resources.limits,cpus:sizing.router.cpus,memory:sizing.router.memory}}};
 tiers.forEach((tier,i)=>{
  const s=c.services[`ssam-server-v${i+1}`],t=sizing[tier];
  s.deploy.resources.limits={...s.deploy.resources.limits,cpus:t.cpus,memory:t.memory};
  s.cpu_shares=t.cpuShares;
  Object.assign(s.environment,{SSAM_BUILD_WORKERS:String(t.buildWorkers),SSAM_O11_WORKERS_MAX:String(t.o11WorkersMax),SSAM_BUILD_QUEUE_MS:String(t.queueMs),...readersEnv(manifest,tier)});
  s.labels['ssam.sizing']=tier;
 });
}
export function sizingOfCompose(compose){
 const text=compose?.services?.['ssam-router']?.labels?.['ssam.sizing'];
 if(text===undefined)return undefined;
 let sizing;try{sizing=JSON.parse(text);}catch{throw new Error('The live router carries an unreadable ssam.sizing.');}
 return checkSizing(sizing);
}
export function generateCompose(manifest,{window=windowOf(manifest)}={}){
 // Coolify 4.4.6 corrupts image@sha256 references. Immutable tags are checked against the recorded digest.
 const multi=isBackendManifest(manifest),pairs=backendsOf(manifest,{window}).map(p=>({...p,digest:p.image.split('@')[1]??null,image:p.image.split('@')[0]})),c=structuredClone(template),source=c.services['ssam-server'];
 // Each backend's served list: its frozen one, keepServed, or the whole window (servedLists).
 const lists=servedLists(manifest,{window});
 delete c.name;c.networks.default={};c.volumes={'server-state':{},friction:{},'runtime-css':{}};
 const routing=pairs.map((p,i)=>({name:p.name,url:`http://ssam-server-v${i+1}:7310`,odc:p.odc,o11:p.o11,default:i===0}));
 delete c.services['ssam-server'];
 for(const service of Object.values(c.services)){delete service.labels;service.image=pairs[0].image;}
 pairs.forEach((p,i)=>{
  const s=structuredClone(source);s.image=p.image;
  // ssam.o11: the pair's O11 version, or the served O11 list of a 4x4 backend (comma separated).
  s.labels={'ssam.backend':'true','ssam.odc':p.odc,'ssam.o11':multi?p.o11.join(','):p.o11,'ssam.default':String(i===0),...(p.digest?{'ssam.image.digest':p.digest}:{})};
  Object.assign(s.environment,{SSAM_BACKEND_NAME:p.name,SSAM_RUNTIME_DIR:`/data/server/versions/${p.name}`,SSAM_SERVED_VERSIONS:lists[i]});
  for(const v of s.volumes)if(['cache','odc-features'].includes(v.source)){v.source=`${v.source}-${p.name.replaceAll('.','-')}`;c.volumes[v.source]={};}
  // A 4x4 backend reads the signed thin bridges from the shared store the owner stages (read-only; the trust anchor stays
  // in the image, SSAM_BRIDGES_PUBLIC_KEY, bridge-store.mjs).
  if(multi){s.volumes.push({type:'volume',source:BRIDGES_VOLUME,target:BRIDGES_TARGET,read_only:true});s.environment.SSAM_BRIDGES_DIR=BRIDGES_TARGET;}
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
 const window=Number(process.env.SSAM_VERSION_WINDOW??windowOf(manifest));
 fs.writeFileSync(output,'# Generated by gen-compose.mjs. Edit versions.json and regenerate.\n'+JSON.stringify(generateCompose(manifest,{window}),null,2)+'\n');
}
