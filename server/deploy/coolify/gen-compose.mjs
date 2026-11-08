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
 return c;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const input=process.argv[2]??path.join(here,'versions.json'),output=process.argv[3]??path.join(here,'compose.coolify.yml');
 const manifest=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''));
 const window=Number(process.env.SSAM_VERSION_WINDOW??manifest.window??3);
 fs.writeFileSync(output,'# Generated by gen-compose.mjs. Edit versions.json and regenerate.\n'+JSON.stringify(generateCompose(manifest,{window}),null,2)+'\n');
}
