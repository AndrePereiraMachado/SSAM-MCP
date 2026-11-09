import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJournal} from './journal.mjs';
import {generateCompose,versionPairs,sizingOfCompose} from '../coolify/gen-compose.mjs';
const fail=(message,code)=>{throw Object.assign(Error(message),{code,environmental:true});};
export const composeHash=text=>createHash('sha256').update(text).digest('hex');
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
export const canonicalComposeHash=text=>composeHash(JSON.stringify(sorted(parseCompose(text))));
export const parseCompose=text=>JSON.parse(text.replace(/^\s*#[^\n]*\n/g,''));
// The ODC model plugins every backend mounts read-only, pinned by name and sha256 (coolify/model-plugins.json): the
// reviewed volume at the reviewed target, never another mount there, never code from a customer.
const PLUGINS=JSON.parse(fs.readFileSync(new URL('../coolify/model-plugins.json',import.meta.url),'utf8'));
export const modelPlugins=()=>structuredClone({volume:PLUGINS.volume,target:PLUGINS.target,files:PLUGINS.files});
const mountTarget=v=>typeof v==='string'?v.split(':')[1]:v?.target;
const reviewedPlugins=v=>!!v&&typeof v==='object'&&v.source===PLUGINS.volume&&v.target===PLUGINS.target&&v.read_only===true&&(v.type??'volume')==='volume';
// Every backend of a compose has exactly one mount at the plugins target, the reviewed read-only volume, and the volume is
// declared. A bad merge that mounts it twice, or a hand-made bind there, fails before any write.
export function assertModelPlugins(compose){
 const backends=Object.entries(compose.services??{}).filter(([,s])=>s.labels?.['ssam.backend']==='true');
 for(const [name,s] of backends){const at=(s.volumes??[]).filter(v=>mountTarget(v)===PLUGINS.target);if(at.length!==1||!reviewedPlugins(at[0]))fail(`Backend ${name} must mount exactly the reviewed read-only ${PLUGINS.volume} volume at ${PLUGINS.target}.`,'MODEL_PLUGINS_MOUNT');}
 if(backends.length&&!compose.volumes?.[PLUGINS.volume])fail(`The compose does not declare the ${PLUGINS.volume} volume.`,'MODEL_PLUGINS_MOUNT');
 return compose;
}
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
  // The served list the backend runs with is frozen with it (gen-compose servedLists): a rotation never changes it.
  let served;const text=service.environment?.SSAM_SERVED_VERSIONS;
  if(text!==undefined){try{served=JSON.parse(text);}catch{fail('A live backend has an unreadable SSAM_SERVED_VERSIONS.','LIVE_INVALID');}}
  const entry={image:ref.slice(0,colon),tag:ref.slice(colon+1),sha256:row.digest.slice(7),...(served?{served}:{})};
  for(const [lane,v] of [['odc',odc],['o11',o11]])result[lane].push({version:v,...entry});
  kernels[`o11-${o11}-odc-${odc}`]=row.kernel;
 }
 if(rows.length!==ordered.length)fail('Live backend count differs from compose.','LIVE_INVALID');
 // The capacity sizing the live compose was generated with (its router label): the rotation carries it to the next window.
 let sizing;try{sizing=sizingOfCompose(compose);}catch(error){fail(error.message,'LIVE_INVALID');}
 if(sizing)result.sizing=sizing;
 // Backends carrying a tier label without the router's sizing: the label was lost (a hand edit, a Coolify rewrite). An
 // unsized rotation would clone the first backend's limits (maybe the hot tier) into the new pair with no host check, so
 // nothing is decided from such a compose (review R2 M4.4).
 else if(ordered.some(s=>s.labels?.['ssam.sizing']!==undefined))fail('Live backends carry capacity tiers but the router carries no ssam.sizing; owner review is required.','LIVE_INVALID');
 // usage: the real use of each pair (remote snapshot, vigia/usage-count.cjs, counts only). Advisory: an absent, unreadable
 // or odd value is null plus a warning, never a stop of the round (review R2 M1').
 const {usage,warning}=usageCounts(snapshot.usage,snapshot.warnings);
 versionPairs(result);return {manifest:result,kernels,telemetry:snapshot.telemetry??{},usage,...(warning?{usageWarning:warning}:{}),snapshot};
}
const PAIR=/^o11-\d+\.\d+\.\d+-odc-\d+\.\d+\.\d+$/;
// The usage counts of a snapshot: {usage: {pair: {heavy, active}} | null, warning: code | null}. Entries that are not
// counts of a pair are dropped (USAGE_PARTIAL); a value that is not an object is USAGE_UNREADABLE with usage null; a
// warning of the remote snapshot (USAGE_*) is kept. Never throws.
export function usageCounts(value,warnings=[]){
 const remote=(Array.isArray(warnings)?warnings:[]).find(w=>typeof w==='string'&&/^USAGE_[A-Z_]{1,30}$/.test(w))??null;
 if(value===undefined||value===null)return {usage:null,warning:remote};
 if(typeof value!=='object'||Array.isArray(value))return {usage:null,warning:'USAGE_UNREADABLE'};
 const usage={};let dropped=false;
 for(const [k,v] of Object.entries(value)){
  if(PAIR.test(k)&&v&&typeof v==='object'&&Number.isInteger(v.heavy)&&v.heavy>=0&&Number.isInteger(v.active)&&v.active>=0)usage[k]={heavy:v.heavy,active:v.active};
  else dropped=true;
 }
 return {usage,warning:remote??(dropped?'USAGE_PARTIAL':null)};
}
// Two SSAM_SERVED_VERSIONS texts hold the same lists, by JSON value as the remote check compares them: spacing and key
// order are no change, list order is. An unreadable text is never the same.
export function sameServed(a,b){
 const value=text=>{try{const v=JSON.parse(text);return v&&typeof v==='object'&&!Array.isArray(v)?JSON.stringify(Object.keys(v).sort().map(k=>[k,v[k]])):null;}catch{return null;}};
 const x=value(a);return x!==null&&x===value(b);
}
// The sizing keys of a backend (gen-compose applySizing): its limits, its cpu weight, its pool sizes and its tier label.
export const SIZED_ENVIRONMENT=['SSAM_BUILD_WORKERS','SSAM_O11_WORKERS_MAX','SSAM_BUILD_QUEUE_MS'];
const labelMap=value=>Array.isArray(value)?Object.fromEntries(value.map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];})):{...(value??{})};
function resize(source,desired){
 source.deploy={...source.deploy,resources:{...source.deploy?.resources,limits:{...source.deploy?.resources?.limits,cpus:desired.deploy.resources.limits.cpus,memory:desired.deploy.resources.limits.memory}}};
 for(const key of SIZED_ENVIRONMENT)source.environment[key]=desired.environment[key];
 if(desired.cpu_shares!==undefined)source.cpu_shares=desired.cpu_shares;
 source.labels['ssam.sizing']=desired.labels['ssam.sizing'];
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
   for(const key of ['SSAM_BACKEND_NAME','SSAM_RUNTIME_DIR'])source.environment[key]=desired.environment[key];
   // A retained backend keeps the served list it runs with (keepServed, r44): the manifest must carry it unchanged, or nothing
   // is written. A new backend takes the new window's list.
   const liveServed=matched?matched[1].environment?.SSAM_SERVED_VERSIONS:undefined;
   if(liveServed!==undefined&&!sameServed(liveServed,desired.environment.SSAM_SERVED_VERSIONS))fail(`The retained backend ${desired.labels['ssam.odc']}/${desired.labels['ssam.o11']} would change its served list (${liveServed} -> ${desired.environment.SSAM_SERVED_VERSIONS}); nothing is written.`,'SERVED_LIST_CHANGED');
   source.environment.SSAM_SERVED_VERSIONS=liveServed??desired.environment.SSAM_SERVED_VERSIONS;
   if(!matched){source.image=desired.image;source.volumes=structuredClone(desired.volumes);}
   // A retained backend deployed before the plugins mount gets the reviewed one; anything else at that target stops here.
   else{const at=(source.volumes??[]).filter(v=>mountTarget(v)===PLUGINS.target);if(!at.length)source.volumes=[...(source.volumes??[]),structuredClone(desired.volumes.find(reviewedPlugins))];else if(at.length!==1||!reviewedPlugins(at[0]))fail(`The live backend ${name} mounts something else at ${PLUGINS.target}; owner review is required.`,'MODEL_PLUGINS_CONFLICT');}
   // A sized window (gen-compose sizing): every backend takes the limits, cpu weight and pool sizes of its tier in the next
   // window, so the hot tier moves to the most used pair and the previous hot backend steps down.
   if(manifest.sizing)resize(source,desired);
   services[name]=source;
  }else if(live.services[name]&&['ssam-router','ssam-console','ssam-admin','ssam-ops'].includes(name)){
   services[name]={...live.services[name],image:desired.image};
   if(name==='ssam-router')services[name].environment={...services[name].environment,SSAM_ROUTER_BACKENDS:desired.environment.SSAM_ROUTER_BACKENDS,SSAM_VERSION_WINDOW:String(manifest.window)};
   if(name==='ssam-router'&&manifest.sizing){services[name].labels=labelMap(services[name].labels);services[name].labels['ssam.sizing']=desired.labels['ssam.sizing'];if(manifest.sizing.router)services[name].deploy=structuredClone(desired.deploy);}
  }
 }
 const out={...live,services,volumes:{...next.volumes,...live.volumes}};assertModelPlugins(out);
 return JSON.stringify(out,null,2);
}
export function assertUnserved(baseline,pair){if(['odc','o11'].every(l=>baseline.manifest[l].some(e=>e.version===pair[l])))fail('The candidate is already served.','ALREADY_SERVED');}
export function assertRetained(baseline,next){
 for(let i=0;i<baseline.manifest.odc.length;i++){
  const at=next.odc.findIndex((entry,j)=>entry.version===baseline.manifest.odc[i].version&&next.o11[j].version===baseline.manifest.o11[i].version);
  if(at<0)continue;
  for(const lane of ['odc','o11'])if(['version','image','tag','sha256'].some(k=>next[lane][at][k]!==baseline.manifest[lane][i][k]))fail('A retained live image was changed.','LIVE_DOWNGRADE');
 }
}
// A rehearsal (rehearse.mjs): what no command and no door may do, whatever calls it.
export function refuseInRehearsal(what){throw Object.assign(Error('A rehearsal never does this: '+what+'.'),{code:'REHEARSAL_REFUSED'});}
export function rehearsalRefuses(command,args=[]){
 const words=args.map(String),name=String(command).replaceAll('\\','/').split('/').pop().toLowerCase();
 if(words.some(w=>/(^|[\\/])publish\.sh$/i.test(w)))return 'publish.sh';
 if(words.includes('--push'))return 'a push of an image';
 if(/^(docker|git)(\.exe)?$/.test(name)&&words.includes('push'))return name.replace('.exe','')+' push';
 if(/^(scp|sftp|rsync)(\.exe)?$/.test(name))return name.replace('.exe','');
 return null;
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
// R7 of C:\t\r5\PLANO-AGENTE-AUTO.md (owner decision 6.3.6): agent code is built (client bridges, auto-runtime.mjs agentSource) and,
// in ed25519-offers, the agent release is read only when agentReleaseCommit AND the tip of agentReleaseRef carry the owner's SSH
// signature, checked with the same ownerSigningPublicKey as main (git verify-commit). acceptUnsignedMain never waives it. The
// refusal is not environmental: the round reports what to sign (pipeline.mjs reviewedRelease: agent-release-required).
// git(args,{allowFailure}) -> {code, stdout}; ownerSigned(commit) -> true only for a valid owner signature.
export async function verifySignedAgentRelease(config,{git,ownerSigned}){
 const commit=config.agentReleaseCommit,ref=config.agentReleaseRef;
 agentReleasePin(commit,ref);
 const refuse=message=>{throw Object.assign(Error(message),{code:'AGENT_RELEASE_UNSIGNED'});};
 if(!/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(config.ownerSigningPublicKey??''))refuse('The agent release must be owner-signed: configure ownerSigningPublicKey (acceptUnsignedMain does not cover agent code).');
 // The release line is the BRANCH of that name (F1 review B5): a tag of the same name never stands in for it, so the tip whose
 // signature is checked is the branch tip, not an object a token holder pointed a tag at.
 const branch='refs/heads/'+ref;
 const tip=(await git(['rev-parse','--verify','--quiet',branch+'^{commit}'],{allowFailure:true})).stdout?.trim();
 if(!/^[a-f0-9]{40}$/.test(tip??''))throw Error(`The agent release line cannot be read (the branch ${branch} of the vigia-run clone).`);
 if((await git(['merge-base','--is-ancestor',commit,branch],{allowFailure:true})).code!==0)throw Error('Agent commit is outside the approved release line.');
 if(!await ownerSigned(commit))refuse(`agentReleaseCommit ${commit.slice(0,7)} has no valid owner signature; sign the reviewed agent release commit.`);
 if(tip!==commit&&!await ownerSigned(tip))refuse(`The tip of ${ref} (${tip.slice(0,7)}) has no valid owner signature; the agent release line must end in an owner-signed commit.`);
 return {commit,tip};
}
// F1 review round 3 B-2: the release line is fetched from trustedRemote before each automatic round in ed25519-offers, the way
// main is (runtime.mjs updateWorkspace), into refs/remotes/vigia/<ref>. The local branch refs/heads/<ref> (what R7 reads) moves
// to the fetched tip only when that tip carries the owner's signature AND the move is a fast-forward (or the branch is new);
// otherwise it stays where it was and the round's R7 judges it as before. Never stops the watcher: a release line that cannot
// be fetched, is unsigned or was rewritten only makes the rounds that need it wait (agent-release-required) with this status.
// -> {status: 'updated'|'current'|'unsigned'|'diverged'|'unreachable', ref, tip?, from?}
export async function refreshAgentReleaseLine(config,{git,ownerSigned}){
 const ref=config.agentReleaseRef;
 if(!/^agent\/release(?:[/-][\w.-]+)*$/.test(ref??'')||!/^https:\/\/[^@?#]+$/.test(config.trustedRemote??''))return {status:'unreachable',ref:ref??null};
 const remote='refs/remotes/vigia/'+ref,branch='refs/heads/'+ref;
 if((await git(['fetch','--no-tags','--no-recurse-submodules',config.trustedRemote,`+${branch}:${remote}`],{allowFailure:true})).code!==0)return {status:'unreachable',ref};
 const tip=(await git(['rev-parse','--verify','--quiet',remote+'^{commit}'],{allowFailure:true})).stdout?.trim();
 if(!/^[a-f0-9]{40}$/.test(tip??''))return {status:'unreachable',ref};
 const local=(await git(['rev-parse','--verify','--quiet',branch+'^{commit}'],{allowFailure:true})).stdout?.trim();
 if(local===tip)return {status:'current',ref,tip};
 if(!await ownerSigned(tip))return {status:'unsigned',ref,tip};
 if(/^[a-f0-9]{40}$/.test(local??'')&&(await git(['merge-base','--is-ancestor',local,tip],{allowFailure:true})).code!==0)return {status:'diverged',ref,tip,from:local};
 await git(['update-ref',branch,tip,...(/^[a-f0-9]{40}$/.test(local??'')?[local]:[])]);
 return {status:'updated',ref,tip,...(local?{from:local}:{})};
}
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
