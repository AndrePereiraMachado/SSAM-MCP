import fs from 'node:fs';
import {artifactEvidence} from './artifact-evidence.mjs';
import {cleanupArtifacts,assertDisk,recordLivePairs,readLivePairs} from './artifact-retention.mjs';
import {captureProvenance,verifyProvenance,verifyBundleCustody,verifyInstallerCustody} from './provenance.mjs';
import {configureJournals,requireJournalKey,readJournal,writeJournal} from './journal.mjs';
import path from 'node:path';
import {createPrivateKey,createPublicKey,createHash,sign,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyBridge} from '../../platforms/odc/facade/bridge-store.mjs';
import {detectSources,downloadInstaller,pinOdc,redecideOdc} from './sources.mjs';
import {remind} from './pipeline.mjs';
import {readListingBudget} from './smoke.mjs';
import {refuseInRehearsal,assertPause,assertTime,canonicalComposeHash,cleanupSsh,cleanupRollback,liveBaseline,composeHash,unchanged,preserveCompose,modelPlugins} from './safety.mjs';
import {bridgeMode,parseAgentRelease} from './server-only.mjs';
import {windowPairs,pairId,version as threeOf,ownerCommand} from './window.mjs';
import {versionPairs,servedLists} from '../coolify/gen-compose.mjs';
// The codes remote-release.py returns. The VPS state of the moment (memory, disk, the lease, a backend still warming): the
// round waits and retries. A defect of the release or of the staged plugins volume, a check receipt, the published hello or a
// changed served list: the attempt fails with its own code (rolled back after a deployment), never retried unseen.
export const REMOTE_WAITS=Object.freeze(['MEMORY_LOW','DISK_LOW','LOCK_BUSY','LOCK_LOST','NOT_WARM','REMOTE_UNAVAILABLE']);
export const REMOTE_DEFECTS=Object.freeze(['REMOTE_FAILED','MODEL_PLUGINS_MISSING','MODEL_PLUGINS_MISMATCH','MODEL_PLUGINS_MOUNT','MODEL_PLUGINS_UNPINNED','CHECK_RECEIPT','PACK_HELLO_NOT_PRESENTED','SERVED_LIST_CHANGED']);
const here=path.dirname(fileURLToPath(import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const q=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
// The official releases this round verifies: those the window does not serve. A rehearsal verifies the served ones too: that is what it rehearses.
export const releasesToVerify=(observed,manifest,rehearsal=false)=>observed.filter(x=>x.url&&(rehearsal||!manifest[x.lane].some(v=>v.version===x.version)));
// Text that reaches the owner's notice: printable, no markup or control characters, bounded.
export const noticeText=value=>String(value??'').replace(/[^\w .,:;()/'=+#?-]/g,'').slice(0,300);
// A notice given once per key, ever (source-notices.json in outDir): a fact that does not change, unlike the daily ones.
async function noticeOnce(outDir,key,title,message,ops,now){
 const file=path.join(outDir,'source-notices.json');let data={};
 try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(data[key])return false;
 data[key]=new Date(now).toISOString();fs.mkdirSync(outDir,{recursive:true});fs.writeFileSync(file+'.next',JSON.stringify(data,null,2)+'\n');fs.renameSync(file+'.next',file);
 ops.log?.(`notice: ${title}: ${message}`);await ops.notify(title,message);return true;
}
// Where discovery keeps its state, per lane, in outDir:
//  - ODC: studio-sources.json, the build decisions, a journal (signed in every automatic round). One that cannot be read
//    (tampered, truncated) stops the ODC lane only, and never heals by itself: rename or delete it (the watcher decides again
//    from the public pages) or use -Pin / -Redecide on a readable one.
//  - Service Studio: studio-sources-o11.json, a disposable cache of the last version checked on releaseshub; an unreadable
//    one is ignored.
// A dry run reads and writes nothing back; without the journal key it reads the ODC value unverified (it acts on nothing).
export const SOURCES_FILE='studio-sources.json',O11_CACHE_FILE='studio-sources-o11.json';
export function sourceStore(outDir,{dryRun=false}={}){
 const odc=path.join(outDir,SOURCES_FILE),o11=path.join(outDir,O11_CACHE_FILE);
 return {
  read(lane){
   if(lane==='o11'){try{const v=JSON.parse(fs.readFileSync(o11,'utf8'));return v&&typeof v==='object'?v:null;}catch{return null;}}
   if(!fs.existsSync(odc))return null;
   let v=readJournal(odc);if(dryRun&&v?.journal===1&&v.value)v=v.value;
   if(!v||typeof v!=='object'||typeof v.versions!=='object'||!v.versions)throw Error('not an ODC decisions record');
   return v;
  },
  write(lane,value){
   if(dryRun)return;
   if(lane==='o11'){fs.mkdirSync(outDir,{recursive:true});fs.writeFileSync(o11+'.next',JSON.stringify(value??{},null,2)+'\n');fs.renameSync(o11+'.next',o11);return;}
   writeJournal(odc,value);
  }
 };
}
// The owner's commands on the ODC decisions (vigia.ps1 -Pin X.Y.Z.B, -Redecide X.Y.Z): read and written back as the same
// signed journal (an automatic configuration refuses to write it unsigned). -Pin checks the build on releaseshub (one GET,
// one HEAD); a window that already serves X.Y.Z keeps its image.
export async function pinStudioBuild(config,fullVersion,{fetcher=fetch,now=Date.now()}={}){
 if(config.automatic)requireJournalKey(config.outDir);
 const store=sourceStore(config.outDir),odc=store.read('odc');
 if(!odc)throw Error(`No ODC Studio decisions in ${path.join(config.outDir,SOURCES_FILE)} yet: run a round first.`);
 const state={odc},r=await pinOdc(state,fullVersion,{fetcher,now,retryDelayMs:0});store.write('odc',state.odc);
 return {status:'pinned',...r,note:`ODC Studio ${r.version} is decided as build ${r.build}${r.previous&&r.previous!==r.build?` (was ${r.previous})`:''} by the owner. The next round offers it if the window does not serve ${r.version} yet; an image already serving ${r.version} is not rebuilt by this.`};
}
export function redecideStudio(config,version){
 if(config.automatic)requireJournalKey(config.outDir);
 const store=sourceStore(config.outDir),odc=store.read('odc');
 if(!odc)throw Error(`No ODC Studio decisions in ${path.join(config.outDir,SOURCES_FILE)}.`);
 const state={odc},r=redecideOdc(state,version);store.write('odc',state.odc);
 return {status:'redecide',...r,note:`ODC Studio ${r.version}${r.previous?` (was build ${r.previous})`:''} will be searched again by the next round; past its cutoff, an ambiguous answer waits for -Pin.`};
}
export function createAutoRuntime(config,runtime) {
 const root=path.resolve(config.workspace),priv=path.resolve(config.tempRoot),settings=config.automaticDeployment??{};
 // The ODC features provenance is a journal too: unsigned records are never written or accepted there.
 const featuresRoot=path.resolve(config.featuresRoot??path.join(priv,'features'));
 if(config.automatic&&!config.dryRun){requireJournalKey(config.outDir);requireJournalKey(featuresRoot);}
 const ps=config.powershell??'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
 const script=(name,args=[],input)=>runtime.run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,name),...args],{input,secret:true});
 let cached,cachedRelease,activeLease;
 async function secrets(){
  await runtime.executionSource();
  if(cached)return cached;
  let s;
  try {
   s=JSON.parse((await script('read-secrets.ps1',config.vault?['-Vault',config.vault]:[])).stdout);
   // server-only signs no client bridge: the Authenticode thumbprint is optional there (empty = none), still well formed when
   // present; signed-offers keeps requiring it. Ed25519 and the journal HMAC key stay required in both.
   const signing=bridgeMode(config)==='signed-offers';
   if(['coolifyToken','sshPrivateKey',...(signing?['authenticodeThumbprint']:[]),'manifestPrivateKey','journalKey'].some(k=>!s[k]))throw Error();
   if((signing||s.authenticodeThumbprint)&&!/^[a-f0-9]{40}$/i.test(s.authenticodeThumbprint))throw Error();
   if(createPrivateKey(s.manifestPrivateKey).asymmetricKeyType!=='ed25519')throw Error();
   if(!Buffer.from(s.sshPrivateKey,'base64').toString().includes('PRIVATE KEY'))throw Error();
   const c=settings.coolify;
   if(!c?.url||!c?.resource||!settings.ssh?.host||!settings.ssh?.knownHosts)throw Error();
   const url=new URL(c.url);
   if(url.protocol!=='https:'&&!(settings.testOnly&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error();
   if(!/^[A-Za-z0-9_-]+$/.test(c.resource))throw Error();
  }catch{throw Object.assign(Error('Watcher secrets or deployment settings are missing or invalid. Run set-secrets.ps1 and review the configuration.'),{code:'secrets-missing'});}
  configureJournals(config.outDir,s.journalKey);configureJournals(priv,s.journalKey);if(config.bundleRoot)configureJournals(config.bundleRoot,s.journalKey);configureJournals(featuresRoot,s.journalKey);cached=s;return s;
 }
 async function api(s,method,route,body) {
  if(config.rehearsal&&method!=='GET')refuseInRehearsal('Coolify '+method);
  if(method!=='GET'){if(!activeLease)throw Error('Remote release lease is required.');activeLease.assertHeld();await ssh(s,{action:'fence'});}
  const response=await fetch(settings.coolify.url.replace(/\/$/,'')+'/api/v1'+route,{
   method,redirect:'error',headers:{authorization:'Bearer '+s.coolifyToken,'content-type':'application/json'},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)}).catch(()=>{throw Object.assign(Error('Coolify transport unavailable.'),{code:'COOLIFY_UNAVAILABLE',environmental:true});});
   if(!response.ok)throw Object.assign(Error(`Coolify request failed (HTTP ${response.status}).`),{code:'COOLIFY_HTTP_FAILURE',environmental:response.status>=500||response.status===429});
  try{return await response.json();}catch{throw Error('Coolify returned invalid JSON.');}
 }
 const resource=()=>'/services/'+settings.coolify.resource;
 async function ssh(s,request) {
  // Capacity only reads memory and disk. The snapshot looks like a read, but it issues and revokes a token on the live server.
  if(config.rehearsal&&request.action!=='capacity')refuseInRehearsal('SSH '+request.action);
  if(['backup','prepare','check','preflight'].includes(request.action)){if(!activeLease)throw Error('Remote release lease is required.');activeLease.assertHeld();}
  const folder=path.join(priv,'ssh-'+randomUUID());fs.mkdirSync(folder,{recursive:true});
  const key=path.join(folder,'identity');
  try{
   if(process.platform==='win32')await runtime.run('C:/Windows/System32/icacls.exe',[folder,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`],{secret:true});
   fs.writeFileSync(key,Buffer.from(s.sshPrivateKey,'base64'),{mode:0o600});
   const remote=fs.readFileSync(path.join(here,'remote-release.py'),'utf8');
   const r=await runtime.run(settings.ssh.executable??'C:/Windows/System32/OpenSSH/ssh.exe',[
    '-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${settings.ssh.knownHosts}`,
    '-o','ConnectTimeout=20','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-i',key,`${settings.ssh.user??'root'}@${settings.ssh.host}`,
    'timeout --signal=TERM --kill-after=10s 1700s python3 -c '+q(remote)
   ],{secret:true,input:JSON.stringify({...request,fence:activeLease?.token,settings:settings.remote}),timeoutMs:30*60000,evenWhenStopping:true,allowFailure:true}).catch(()=>{throw Object.assign(Error('Remote transport unavailable.'),{code:'REMOTE_UNAVAILABLE',environmental:true});});
   let result;try{result=JSON.parse(r.stdout);}catch{throw Object.assign(Error('Remote transport unavailable.'),{code:'REMOTE_UNAVAILABLE',environmental:true});}
   if(!result.ok){const code=typeof result.code==='string'&&(REMOTE_WAITS.includes(result.code)||REMOTE_DEFECTS.includes(result.code))?result.code:'REMOTE_FAILED';throw Object.assign(Error('Remote operation failed: '+code),{code,environmental:REMOTE_WAITS.includes(code)});}return result;
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
 }
 async function protect(value){return (await script('protect-value.ps1',['-Mode','Protect'],value)).stdout.trim();}
 async function unprotect(value){return (await script('protect-value.ps1',['-Mode','Unprotect'],value)).stdout;}
 const load=async baseline=>JSON.parse(await unprotect(fs.readFileSync(baseline.file,'utf8')));
 const checkSource=(budget,offers=[],capture=false,packHellos=null,extra={})=>'const expected='+JSON.stringify({budget,offers,capture,...(packHellos?{packHellos}:{}),...extra})+';\n'+fs.readFileSync(path.join(here,'check-backend.mjs'),'utf8');
 return {
  secrets,
  async verifyInput(chain){return verifyInstallerCustody(chain,{privateRoot:priv,verifyPublisher:runtime.verifyPublisher});},
  diskPreflight(){assertDisk(priv,(config.minFreeGb??25)*2**30);},
  async verifyRelease(release){for(const b of Object.values(release.bundles??{})){verifyBundleCustody(b,config.bundlePins?.[`${b.lane}-${b.version}`]);if(b.provenance)await this.verifyInput(b.provenance);}if(!release.bundles)throw Error('Release provenance is missing.');},
  pause(){assertPause();if(config.pauseFile)assertPause(config.pauseFile);},
  deploymentBudget(){assertTime(config.roundDeadline??Date.now()+(config.roundHours??7)*3600000,Math.max(180,config.deploymentMaxMinutes??180));},
  cleanupSsh(){cleanupSsh(priv);cleanupRollback(priv,config.outDir);cleanupArtifacts({...config,livePairs:readLivePairs(config.outDir)});},
  capacityPreflight:async manifest=>ssh(await secrets(),{action:'capacity',backendCount:manifest.odc.length}),
  async assertRollbackSafe(s,baseline,ownedHash){const live=(await api(s,'GET',resource())).docker_compose_raw;const old=(await load(baseline)).compose;if(![ownedHash,canonicalComposeHash(old)].includes(canonicalComposeHash(live)))throw Error('Rollback refused: another writer changed the compose.');},
  preflightRemote:(s,pinned)=>ssh(s,{action:'preflight',backendCount:pinned.odc.length}),
  async ensureReleaseLock(s,previous){
   try{activeLease?.assertHeld();if(activeLease){await ssh(s,{action:'fence'});return previous;}}catch{}
   if(previous)await previous();
   return this.acquireReleaseLock(s);
  },
  async acquireReleaseLock(s){
   if(config.rehearsal)refuseInRehearsal('the VPS release lock');
   const folder=path.join(priv,'ssh-'+randomUUID());fs.mkdirSync(folder,{recursive:true});const key=path.join(folder,'identity');
   try{
    if(process.platform==='win32')await runtime.run('C:/Windows/System32/icacls.exe',[folder,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`],{secret:true,evenWhenStopping:true});
    fs.writeFileSync(key,Buffer.from(s.sshPrivateKey,'base64'),{mode:0o600});
    const token=randomUUID();
    const release=await runtime.openLease(settings.ssh.executable??'C:/Windows/System32/OpenSSH/ssh.exe',[
     '-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${settings.ssh.knownHosts}`,'-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-i',key,`${settings.ssh.user??'root'}@${settings.ssh.host}`,
     "flock -x -w 30 -F /var/lock/ssam-release.lock sh -c "+q("umask 077; printf '{\"token\":\"%s\",\"pid\":%s}' "+q(token)+" \"$$\" > /var/lock/ssam-release.owner; trap 'rm -f /var/lock/ssam-release.owner' EXIT; printf 'SSAM_LOCKED\\n'; cat >/dev/null")
    ]);
    release.token=token;activeLease=release;
    return async()=>{try{await release();}finally{activeLease=null;fs.rmSync(folder,{recursive:true,force:true});}};
   }catch(e){fs.rmSync(folder,{recursive:true,force:true});throw e;}
  },
  async observe(installed,{dryRun=false,manifest=runtime.manifest()}={}) {
   const now=config.clock?.()??config.now??Date.now();
   const store=config.outDir?sourceStore(config.outDir,{dryRun}):null;
   const served=Object.fromEntries(['odc','o11'].map(l=>[l,(manifest?.[l]??[]).map(v=>v.version)]));
   const result=await detectSources(installed,{...(runtime.sourceFetcher?{fetcher:runtime.sourceFetcher,retryDelayMs:0}:{}),...(runtime.sourceOptions??{}),now,served,store});
   runtime.sourceStatus=result.sources;
   const studio=l=>l==='odc'?'ODC Studio':'Service Studio';
   const command=text=>String(text??'').replace(/\{\{([^}]*)\}\}/g,(_,args)=>ownerCommand(config,args.trim()));
   const once=(key,title,message)=>dryRun?null:noticeOnce(config.outDir,key,title,message,runtime,now).catch(e=>runtime.log?.(`source notice not given: ${e.message}`));
   for(const s of result.sources){
    if(s.status==='pending')runtime.log?.(`${s.lane} source: ${studio(s.lane)} ${s.version} (released ${s.releasedOn}) is decided at its cutoff ${s.definitiveAt}${s.build?` (highest eligible build so far ${s.build})`:' (no eligible build yet)'}; nothing is offered yet (${s.probes??0} probes this round)`);
    if(s.status==='queued')runtime.log?.(`${s.lane} source: ${s.version} waits behind the unserved ${s.behind}: versions are offered oldest first`);
    if(s.status==='older-than-served')runtime.log?.(`${s.lane} source: public ${s.version} is older than the newest served ${s.served}; nothing is offered`);
    // A newer Studio on the watcher machine (a preview, typically) never hides a release: the owner hears of it once.
    if(s.installedAhead){
     runtime.log?.(`${s.lane} source: the watcher machine has ${s.installedAhead}, newer than the public ${s.version}; the public release and the served window decide`);
     await once(`installed-ahead:${s.lane}:${s.installedAhead}:${s.version}`,'SSAM: watcher Studio newer than the public release',`The watcher machine has ${studio(s.lane)} ${s.installedAhead} installed, newer than the public release ${s.version} (a preview?). Discovery ignores installed Studios: ${s.version} is offered when the window does not serve it.`);
    }
    // Uploads of a decided version after its cutoff or its decision are never offered; the owner hears of each once.
    for(const b of [...(s.heldBuilds??[]),...(s.laterBuilds??[])]){
     const three=s.version.split('.').slice(0,3).join('.');
     runtime.log?.(`${s.lane} source: build ${three}.${b} was uploaded after the decided ${s.version}; it is not offered`);
     await once(`later-build:${s.lane}:${three}.${b}`,'SSAM: later Studio build not offered',`${studio(s.lane)} ${three} is decided as ${s.version} (${s.decided?.by??'decided'} ${s.decided?.at??''}). Build ${three}.${b} was uploaded later and is NOT offered: the watcher never changes a decided build. Check the release notes; to serve it instead: ${command(`{{-Pin ${three}.${b}}}`)}`);
    }
    if(s.status!=='unavailable')continue;
    const error=noticeText(s.error),what=`${studio(s.lane)}${s.version?' '+s.version:''}`;
    runtime.log?.(`${s.lane} source unavailable (${s.code}): ${error}; the installed Studio stands in this round`);
    // An owner action means it does not heal by itself: the notice says what to run instead of "retries next round".
    const tail=s.ownerAction?command(s.ownerAction):'The watcher keeps the installed Studio and retries next round.';
    if(!dryRun)await remind(config.outDir,`source:${s.lane}:${s.version?s.version+':':''}${s.code}`,s.ownerAction?'SSAM: Studio release needs the owner':'SSAM: Studio release source unreadable',`${what} releases could not be read (${s.code}): ${error} ${tail}`,runtime,{now}).catch(e=>runtime.log?.(`source notice not given: ${e.message}`));
   }
   if(dryRun)return result.observed;
   const verified=[];
   for(const release of releasesToVerify(result.observed,manifest,!!config.rehearsal)){
    runtime.diskPreflight();
    const downloaded=await downloadInstaller(release,config.installersDir??'C:/ssam-priv/vigia-installers');
    const signer=await runtime.verifyPublisher(downloaded.file);
    const folder=path.join(priv,'extracted',downloaded.sha256),receipt=folder+'.provenance.json';
    let provenance;
    if(fs.existsSync(receipt)){provenance=readJournal(receipt,{automatic:true});await runtime.verifyInput(provenance);}
    else {
    runtime.diskPreflight();
    if(fs.existsSync(folder)){if(fs.lstatSync(folder).isSymbolicLink())throw Error('Extraction root is a link.');fs.rmSync(folder,{recursive:true,force:true});}
    fs.mkdirSync(folder,{recursive:true});
    await runtime.run(config.python,[
     path.join(root,'server/docker/ssam-server/nsis_extract.py'),'extract',downloaded.file,folder,'--marker','ServiceStudio.Framework.dll'
    ],{secret:true,timeoutMs:180000});
    await runtime.run(ps,['-NoProfile','-NonInteractive','-File',path.join(here,'verify-extraction.ps1'),'-Root',folder],{secret:true});
    provenance=captureProvenance(folder,downloaded.file,signer);
    writeJournal(receipt,provenance);
    }
    const read=await runtime.run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'detect-studios.ps1'),release.lane==='odc'?'-Odc':'-O11',folder]);
    const found=JSON.parse(read.stdout).find(x=>x.lane===release.lane&&x.fullVersion===release.fullVersion);
    if(!found)throw Error('Extracted Studio version differs from the release source.');
    await runtime.verifyInput(provenance);
    Object.assign(release,found,{requiresInstallation:false,installer:downloaded.file,sha256:downloaded.sha256,provenance});
    verified.push(release);
   }
   return verified;
  },
  // Server-only: what the reviewed agent release ships and runs (its client's ODC bridges, its agents' ODC commands), read from
  // its source at agentReleaseCommit (runtime.agentReleaseFiles: git show of the pinned commit), once per round.
  async agentRelease(){
   if(cachedRelease)return cachedRelease;
   const files=await runtime.agentReleaseFiles();
   return cachedRelease=parseAgentRelease({commit:config.agentReleaseCommit??null,...files});
  },
  // The kernels of the served pairs: the live ones the baseline read (a real round), else the reviewed checkout's
  // r1-kernels.json restricted to the pairs of the window (all of them when none matches).
  servedKernels(manifest){
   const live=config.liveBaseline?.kernels??runtime.liveKernels;
   if(live)return Object.values(live);
   const file=JSON.parse(fs.readFileSync(path.join(root,'server/deploy/coolify/r1-kernels.json'),'utf8')),all=Object.values(file);
   const ids=new Set(manifest?windowPairs(manifest).map(p=>pairId(p)):[]),served=all.filter(k=>ids.has(pairId(k)));
   return served.length?served:all;
  },
  async buildBridges(pair,bundles,dir){
   if(bridgeMode(config)!=='signed-offers')throw Error('Client bridges are built and signed only in the signed-offers bridge mode.');
   await runtime.executionSource();
   for(const b of Object.values(bundles)){verifyBundleCustody(b,config.bundlePins?.[`${b.lane}-${b.version}`]);if(b.provenance)await runtime.verifyInput(b.provenance);}
   const agentSource=await runtime.agentSource();
   const s=await secrets(),key=createPublicKey(s.manifestPrivateKey).export({type:'spki',format:'pem'});
   const staging=config.rehearsal?.dir??priv,stage=path.join(staging,'bridges',randomUUID());fs.mkdirSync(stage,{recursive:true});
   fs.writeFileSync(path.join(stage,'public-key.pem'),key);
   // The client names the bridge of each runtime: Version for the net10 ODC Studios, EarlierVersion for the net8 ones (Bridge.csproj).
   const clientSource=fs.readFileSync(path.join(root,'server/platforms/odc/studio/bridge/client/Program.cs'),'utf8');
   const protocol=(bundles.odc.tfm==='net8.0'?/const string EarlierVersion = "(v\d+)"/:/const string Version = "(v\d+)"/).exec(clientSource)?.[1];
   if(!protocol)throw Error('Cannot determine ODC bridge protocol.');
   const offers=[];
   for(const lane of ['odc','o11']){
    const b=bundles[lane],p=lane==='odc'?protocol:'d1',target=path.join(stage,lane,b.version,p);
    if(fs.existsSync(path.join(target,'manifest.json'))){offers.push(verifyBridge(target,key).manifest);continue;}
    const projects=lane==='odc'?[
     ['server/platforms/odc/studio/bridge/Bridge.csproj','bridge'],
     ['server/platforms/odc/studio/bridge/client/Client.csproj','client']
    ]:[['agent/kernel/src/Anvil.Bridge.Thin/Anvil.Bridge.Thin.csproj','bridge'],['agent/kernel/tools/Anvil.RuntimeHook/Anvil.RuntimeHook.csproj','hook']];
    const outputs=[],assets=[];
    for(const [project,sub] of projects){
     await runtime.waitForDotnet();
     const projectFile=path.join(lane==='o11'?agentSource:root,project),properties=sub==='hook'?['-p:UseAppHost=false']:['-p:UseAppHost=false',`-p:OdcInstall=${bundles.odc.snapshot}`,`-p:SSDir=${bundles.o11.snapshot}`,`-p:AnvilOdcStudioTfm=${bundles.odc.tfm}`,`-p:AnvilO11StudioTfm=${bundles.o11.tfm}`,...(lane==='o11'?[`-p:TargetFramework=${b.tfm}`]:[])];
     // The hook is net8 and the client net10 in every pack, whatever the Studio; the bridges follow the Studio. The thin project names net8.0 only as its default.
     const expected=sub==='hook'?'net8.0':sub==='client'?'net10.0':b.tfm;
     const framework=await runtime.run(config.dotnet??'C:/Program Files/dotnet/dotnet.exe',['msbuild',projectFile,'-getProperty:TargetFramework',...properties],{dir});
     if(framework.stdout.trim()!==expected)throw Error('Reviewed bridge runtime does not match the Studio.');
     await runtime.run(config.dotnet??'C:/Program Files/dotnet/dotnet.exe',['build',projectFile,...(lane==='o11'&&sub==='bridge'?['-restore','-t:Rebuild']:[]),'-c','Release','-nodeReuse:false',...properties,...(sub==='hook'?['-p:AssemblyName=Anvil.RuntimeHook.Agent']:[]),'-o',path.join(target,sub)],{dir,env:{TEMP:priv,TMP:priv,DOTNET_CLI_HOME:path.join(priv,'dotnet-home'),ANVIL_LANE:lane==='odc'?'ss5':'ss4',ANVIL_STUDIO_DIR:b.snapshot,ANVIL_ODC_STUDIO_DIR:bundles.odc.snapshot},timeoutMs:15*60000});
      const builtPath=await runtime.run(config.dotnet??'C:/Program Files/dotnet/dotnet.exe',['msbuild',projectFile,'-getProperty:TargetPath','-p:Configuration=Release','-p:OutputPath='+path.join(target,sub)+path.sep,...properties,...(sub==='hook'?['-p:AssemblyName=Anvil.RuntimeHook.Agent']:[])],{dir});
      outputs.push(builtPath.stdout.trim());assets.push(path.join(path.dirname(projectFile),'obj/project.assets.json'));
    }
    const evidenceFile=path.join(target,'build-evidence.json');
    fs.writeFileSync(evidenceFile,JSON.stringify(artifactEvidence(target,outputs,assets)));
    const required=lane==='odc'?[`bridge/ODC3.Bridge.${protocol}.dll`,'client/ODC3.Bridge.Client.dll','client/ODC3.Bridge.Client.runtimeconfig.json']:['bridge/Anvil.Bridge.dll','hook/Anvil.RuntimeHook.Agent.dll'];
    if(required.some(name=>!fs.existsSync(path.join(target,name))))throw Error('The compiled client bridge entrypoints are incomplete.');
    if(lane==='odc'&&JSON.parse(fs.readFileSync(path.join(target,'client/ODC3.Bridge.Client.runtimeconfig.json'),'utf8')).runtimeOptions?.tfm!=='net10.0')throw Error('The bridge client is not the net10 client of the packs.');
    // The shared signing entry point reads the thumbprint from DPAPI itself.
    const signing=await runtime.run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'server/scripts/odc-runtime-signing.ps1'),'-Mode','Artifacts','-ArtifactDirectory',target,'-BuildEvidence',evidenceFile,'-ConfigPath',config.configFile,...(config.vault?['-Vault',config.vault]:[]),'-TimestampServer',settings.timestampServer??'http://timestamp.digicert.com'],{secret:true,timeoutMs:300000,allowFailure:true});
    if(signing.stdout.includes('REVOCATION_UNAVAILABLE'))throw Object.assign(Error('Certificate revocation service is unavailable.'),{code:'REVOCATION_UNAVAILABLE',environmental:true});
    if(signing.code && signing.code!==0)throw Error('Bridge signing failed.');
    const signatures=JSON.parse(fs.readFileSync(path.join(target,'authenticode.json'),'utf8'));
    const files=[];
    for(const sub of fs.readdirSync(target)){
     const folder=path.join(target,sub);if(!fs.statSync(folder).isDirectory())continue;
     for(const name of fs.readdirSync(folder)){
      if(!/\.(dll|exe|json)$/.test(name)){fs.rmSync(path.join(folder,name));continue;}
      const bytes=fs.readFileSync(path.join(folder,name));const record=signatures.find(r=>r.path===sub+'/'+name);
      files.push({path:sub+'/'+name,sha256:hash(bytes),size:bytes.length,...(/\.(dll|exe)$/i.test(name)?{signer:record?.signer}:{})});
     }
    }
    // A rehearsal never advances the sequence real offers count on.
    const sequenceFile=path.join(staging,'bridge-sequences.json');let sequences={};if(fs.existsSync(sequenceFile))sequences=JSON.parse(fs.readFileSync(sequenceFile,'utf8'));
    const identity=lane+':'+b.version;const sequence=(sequences[identity]??0)+1;sequences[identity]=sequence;
    fs.writeFileSync(sequenceFile+'.next',JSON.stringify(sequences));fs.renameSync(sequenceFile+'.next',sequenceFile);
    const manifest={schema:1,lane,studioVersion:b.version,runtime:b.tfm,protocol:p,sequence,createdAt:new Date().toISOString(),files,authenticodeThumbprint:s.authenticodeThumbprint};
    const bytes=Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(target,'manifest.json'),bytes);fs.writeFileSync(path.join(target,'manifest.sig'),sign(null,bytes,s.manifestPrivateKey));
    offers.push(verifyBridge(target,key).manifest);
   }
   runtime.bridgeStage=stage;runtime.bridgeOffers=offers.map(({lane,studioVersion,protocol,sequence})=>({lane,studioVersion,protocol,sequence}));
   const kernels=JSON.parse(fs.readFileSync(path.join(root,'server/deploy/coolify/r1-kernels.json'),'utf8'));
   const known=Object.values(kernels).find(k=>k.odc===pair.odc&&k.o11===pair.o11);
   return {stage,offers:offers.map(({lane,studioVersion,protocol,sequence})=>({lane,studioVersion,protocol,sequence})),kernel:{o11:pair.o11,odc:pair.odc,odcBridge:protocol,odcBridgeAccepted:[...new Set([protocol,...(known?.odcBridgeAccepted??[])])],o11BridgeAccepted:['d1']}};
  },
  async liveBaseline(s){
   const value=await api(s,'GET',resource());
   if(typeof value.docker_compose_raw!=='string'||!value.docker_compose_raw)throw Error('Coolify live compose is missing.');
   const observed=await ssh(s,{action:'snapshot',checkSource:checkSource(readListingBudget(root),[],true)});
   const snapshot={compose:value.docker_compose_raw,...observed};const baseline=liveBaseline(snapshot);
   runtime.liveKernels=baseline.kernels;recordLivePairs(config.outDir,Object.keys(baseline.kernels));
   const file=path.join(priv,'rollback',randomUUID()+'.dpapi');fs.mkdirSync(path.dirname(file),{recursive:true});
   fs.writeFileSync(file,await protect(JSON.stringify(snapshot)),{mode:0o600});
   return {file,hash:composeHash(snapshot.compose),manifest:baseline.manifest,kernels:baseline.kernels,telemetry:baseline.telemetry};
  },
  async assertCoolifyReadable(s){if(typeof (await api(s,'GET',resource())).docker_compose_raw!=='string')throw Error('Coolify live compose is missing.');},
  async assertLiveUnchanged(s,baseline){unchanged(baseline,(await api(s,'GET',resource())).docker_compose_raw);},
  async composeFor(s,baseline,pinned){return preserveCompose(await load(baseline),pinned);},
  backup:(s,id)=>ssh(s,{action:'backup',id}),
  async prepare(s,r){
   const features=fs.readFileSync(r.features);
   if(r.featuresSha256&&hash(features)!==r.featuresSha256)throw Object.assign(Error('The ODC features changed after they were recorded; nothing was sent.'),{code:'FEATURES_CHANGED'});
   const archive=path.join(r.dir,'deploy.tar.gz');await runtime.archiveDeploy(await runtime.fullHead(),archive);
   return ssh(s,{action:'prepare',id:r.id,built:r.built,kernel:r.kernel,compose:JSON.parse(r.compose.replace(/^#[^\n]*\n/,'')),
    archive:fs.readFileSync(archive).toString('base64'),features:features.toString('base64'),modelPlugins:modelPlugins()});
  },
  async writeCompose(s,compose){await api(s,'PATCH',resource(),{docker_compose_raw:Buffer.from(compose).toString('base64'),instant_deploy:false});if(canonicalComposeHash(compose)!==canonicalComposeHash((await api(s,'GET',resource())).docker_compose_raw))throw Error('Written compose read-back differs.');},
  deploy: s=>api(s,'POST',resource()+'/restart'),
  async restoreCompose(s,snapshot){const value=await load(snapshot);return this.writeCompose(s,value.compose);},
  async checks(s,expected){
   const budget=readListingBudget(root);
   const before=expected.rollback?(await load(expected.live)).backends:null;
   const checkSources=before?Object.fromEntries(before.map(b=>[b.o11+'|'+b.odc,'const expected='+JSON.stringify({budget:b.budget,offers:[],kernel:b.kernel})+';\n'+fs.readFileSync(path.join(here,'check-backend.mjs'),'utf8')])):null;
   // Server-only: the deployed new pair must accept the published pack's hello too (check-backend.mjs, that pair only).
   const hello=!before&&expected.bridges?.mode==='server-only'&&expected.bridges.hello&&expected.kernel?{[expected.kernel.o11+'|'+expected.kernel.odc]:expected.bridges.hello}:null;
   // The thin bridge of the proof the round verified for the new pair's Service Studio (server-only o11Proofs, in release.json),
   // never the configuration as written.
   const o11Proven=Object.fromEntries(Object.entries(expected.bridges?.o11Proofs??{}).filter(([v,p])=>p?.studioVersion===v&&/^[a-f0-9]{64}$/.test(p.sha256??'')&&threeOf(p.build)).map(([v,p])=>[v,threeOf(p.build)]));
   // A deployment (never a rollback, which restores what was live) also checks the reviewed ODC model plugins in every backend
   // and that exactly one backend presented the published pack's hello.
   const extra=before?{}:{modelPlugins:modelPlugins(),...(Object.keys(o11Proven).length?{o11Proven}:{})};
   // A deployment: every running backend must run with the pin's served list (a retained one: the list it was deployed with).
   const pairs=!before&&expected.pinned?versionPairs(expected.pinned):null;
   const expectedServed=pairs?Object.fromEntries(servedLists(expected.pinned).map((text,i)=>[pairs[i].o11+'|'+pairs[i].odc,text])):null;
   return ssh(s,{action:'check',...expected,budget,expectedBackends:before,checkSources,...(before?{}:{modelPlugins:extra.modelPlugins,requirePresented:!!hello,...(expectedServed?{expectedServed}:{})}),checkSource:checkSource(budget,expected.bridges?.offers??[],false,hello,extra)});
  },
  async event(name,value,s){
   runtime.log(`release ${name}: ${value.id}`);
   try{await runtime.notify('SSAM: '+name,value.message);}catch{}
   // The receipt says which remote channel took the event (releaseEvent records it only then): the VPS journal line and
   // the webhook when configured (a 2xx answer).
   const remote=await ssh(s,{action:'event',event:name,id:value.id,...(value.code?{code:value.code}:{})}).then(r=>r?.ok===true,()=>false);
   let webhook=false;
   if(s.webhookUrl)try{webhook=(await fetch(s.webhookUrl,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({event:name,...value}),signal:AbortSignal.timeout(15000)})).ok;}catch{}
   return {remote,webhook};
  }
 };
}
