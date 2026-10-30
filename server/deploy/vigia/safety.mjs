import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJournal} from './journal.mjs';
import {generateCompose,versionPairs} from '../coolify/gen-compose.mjs';
const fail=(message,code)=>{throw Object.assign(Error(message),{code,environmental:true});};
export const composeHash=text=>createHash('sha256').update(text).digest('hex');
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
export const canonicalComposeHash=text=>composeHash(JSON.stringify(sorted(parseCompose(text))));
export const parseCompose=text=>JSON.parse(text.replace(/^\s*#[^\n]*\n/g,''));
export function unchanged(snapshot,current){if(snapshot.hash!==composeHash(current))fail('Live compose changed; no further mutation is permitted.','LIVE_CHANGED');}
export function liveBaseline(snapshot){
 const compose=parseCompose(snapshot.compose),rows=snapshot.backends;
 if(!rows?.length)fail('No live backend baseline.','LIVE_INVALID');
 const ordered=Object.values(compose.services).filter(s=>s.labels?.['ssam.backend']==='true');
 const result={window:Math.max(3,ordered.length),odc:[],o11:[]},kernels={};
 for(const service of ordered){
  const odc=service.labels['ssam.odc'],o11=service.labels['ssam.o11'];
  const row=rows.find(b=>b.odc===odc&&b.o11===o11);
  if(!row||row.reference!==service.image||row.kernel?.odc!==odc||row.kernel?.o11!==o11||!/^sha256:[a-f0-9]{64}$/.test(row.digest))fail('Live compose, kernels and running images disagree.','LIVE_INVALID');
  const ref=service.image.split('@')[0],colon=ref.lastIndexOf(':');
  if(colon<ref.lastIndexOf('/'))fail('Live image has no immutable tag.','LIVE_INVALID');
  const entry={image:ref.slice(0,colon),tag:ref.slice(colon+1),sha256:row.digest.slice(7)};
  for(const [lane,v] of [['odc',odc],['o11',o11]])result[lane].push({version:v,...entry});
  kernels[`o11-${o11}-odc-${odc}`]=row.kernel;
 }
 if(rows.length!==ordered.length)fail('Live backend count differs from compose.','LIVE_INVALID');
 versionPairs(result);return {manifest:result,kernels,telemetry:snapshot.telemetry??{},snapshot};
}
export function preserveCompose(snapshot,manifest){
 const live=parseCompose(snapshot.compose),next=generateCompose(manifest),old=Object.entries(live.services).filter(([,s])=>s.labels?.['ssam.backend']==='true');
 const services={...live.services};for(const [name]of old)delete services[name];
 for(const [name,desired] of Object.entries(next.services)){
  if(desired.labels?.['ssam.backend']==='true'){
   const matched=old.find(([,s])=>s.labels['ssam.odc']===desired.labels['ssam.odc']&&s.labels['ssam.o11']===desired.labels['ssam.o11']);
   const template=old[0][1];
   const source=matched?structuredClone(matched[1]):{...structuredClone(desired),...structuredClone(Object.fromEntries(['environment','networks','deploy','mem_limit','cpus'].filter(k=>template[k]!==undefined).map(k=>[k,template[k]])))};
   source.labels={...source.labels,...desired.labels};source.environment={...source.environment};
   for(const key of ['SSAM_BACKEND_NAME','SSAM_RUNTIME_DIR','SSAM_SERVED_VERSIONS'])source.environment[key]=desired.environment[key];
   if(!matched){source.image=desired.image;source.volumes=structuredClone(desired.volumes);}
   services[name]=source;
  }else if(live.services[name]&&['ssam-router','ssam-console','ssam-admin','ssam-ops'].includes(name)){
   services[name]={...live.services[name],image:desired.image};
   if(name==='ssam-router')services[name].environment={...services[name].environment,SSAM_ROUTER_BACKENDS:desired.environment.SSAM_ROUTER_BACKENDS,SSAM_VERSION_WINDOW:String(manifest.window)};
  }
 }
 return JSON.stringify({...live,services,volumes:{...next.volumes,...live.volumes}},null,2);
}
export function assertUnserved(baseline,pair){if(['odc','o11'].every(l=>baseline.manifest[l].some(e=>e.version===pair[l])))fail('The candidate is already served.','ALREADY_SERVED');}
export function assertRetained(baseline,next){
 for(let i=0;i<baseline.manifest.odc.length;i++){
  const at=next.odc.findIndex((entry,j)=>entry.version===baseline.manifest.odc[i].version&&next.o11[j].version===baseline.manifest.o11[i].version);
  if(at<0)continue;
  for(const lane of ['odc','o11'])if(['version','image','tag','sha256'].some(k=>next[lane][at][k]!==baseline.manifest[lane][i][k]))fail('A retained live image was changed.','LIVE_DOWNGRADE');
 }
}
export function assertPause(file='C:/ssam-priv/vigia/PAUSE'){try{fs.statSync(file);fail('Watcher paused by the owner.','PAUSED');}catch(e){if(e.code!=='ENOENT')throw e;}}
export function memoryFloor(backends){if(!Number.isInteger(backends)||backends<1||backends>20)fail('Invalid proposed backend count.','MEMORY_LOW');return Math.max(1024,backends*1024);}
export function assertMemory(availableMiB,backends){if(!Number.isFinite(availableMiB)||availableMiB<memoryFloor(backends))fail('Not enough available memory for the proposed window.','MEMORY_LOW');}
export function assertTime(deadline,maxMinutes,now=Date.now()){if(!Number.isFinite(deadline)||!Number.isFinite(maxMinutes)||maxMinutes<=0||deadline-now<maxMinutes*60000)fail('Insufficient round time for deployment and rollback.','DEPLOYMENT_TIME');}
export function signingPolicy(config){if(config.ownerSigningPublicKey)return true;if(config.acceptUnsignedMain===true)return false;throw Error('Owner signing public key or explicit acceptUnsignedMain:true is required.');}
export function executionSource({workspace,branch,head,main,gitDirectory}){
 if(gitDirectory!==true||path.basename(workspace)!=='vigia-run'||branch!=='server/vigia-run'||head!==main)fail('Signing requires the clean vigia-run execution clone at reviewed main.','UNTRUSTED_SOURCE');
}
export function agentReleasePin(commit,ref){if(!/^[a-f0-9]{40}$/.test(commit??'')||!/^agent\/release(?:[/-][\w.-]+)*$/.test(ref??''))fail('Pin a reviewed commit from the agent release line.','AGENT_RELEASE_REQUIRED');}
export function cleanupSsh(root){
 const absolute=path.resolve(root);if(!fs.existsSync(absolute))return;
 for(const entry of fs.readdirSync(absolute,{withFileTypes:true}))if(/^ssh-[0-9a-f-]{36}$/.test(entry.name)){
  const target=path.resolve(absolute,entry.name);if(path.dirname(target)!==absolute)fail('Invalid SSH cleanup path.','CLEANUP_PATH');
  if(entry.isSymbolicLink())fs.unlinkSync(target);else if(entry.isDirectory())fs.rmSync(target,{recursive:true,force:true});
 }
}
export function cleanupRollback(root,outDir){
 const folder=path.join(root,'rollback');if(!fs.existsSync(folder))return;
 const live=new Set();
 if(fs.existsSync(outDir))for(const entry of fs.readdirSync(outDir,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^o11-\d+\.\d+\.\d+-odc-\d+\.\d+\.\d+$/.test(entry.name))continue;
  const dir=path.join(outDir,entry.name),release=path.join(dir,'release.json'),state=path.join(dir,'deployment.json');
  if(!fs.existsSync(release))continue;
  if(!fs.existsSync(state)||!['live','idle','abandoned','rolled-back','preparation-failed'].includes(readJournal(state).status)){
   const file=readJournal(release).baseline?.file;if(file)live.add(path.resolve(file));
  }
 }
 const files=fs.readdirSync(folder).filter(n=>/^[0-9a-f-]{36}\.dpapi$/.test(n)).map(n=>path.join(folder,n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
 for(const file of files.slice(5))if(!live.has(path.resolve(file)))fs.unlinkSync(file);
}
