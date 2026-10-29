import fs from 'node:fs';
import {artifactEvidence} from './artifact-evidence.mjs';
import {captureProvenance,verifyProvenance,verifyBundleCustody} from './provenance.mjs';
import {configureJournals} from './journal.mjs';
import path from 'node:path';
import {createPrivateKey,createPublicKey,createHash,sign,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyBridge} from '../../platforms/odc/facade/bridge-store.mjs';
import {detectSources,downloadInstaller} from './sources.mjs';
import {readListingBudget} from './smoke.mjs';
import {assertPause,assertTime,cleanupSsh,cleanupRollback,liveBaseline,composeHash,unchanged,preserveCompose} from './safety.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const q=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
export function createAutoRuntime(config,runtime) {
 const root=path.resolve(config.workspace),priv=path.resolve(config.tempRoot),settings=config.automaticDeployment??{};
 const ps=config.powershell??'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
 const script=(name,args=[],input)=>runtime.run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,name),...args],{input,secret:true});
 let cached,activeLease;
 async function secrets(){
  await runtime.executionSource();
  if(cached)return cached;
  let s;
  try {
   s=JSON.parse((await script('read-secrets.ps1',config.vault?['-Vault',config.vault]:[])).stdout);
   if(['coolifyToken','sshPrivateKey','authenticodeThumbprint','manifestPrivateKey','journalKey'].some(k=>!s[k]))throw Error();
   if(!/^[a-f0-9]{40}$/i.test(s.authenticodeThumbprint))throw Error();
   if(createPrivateKey(s.manifestPrivateKey).asymmetricKeyType!=='ed25519')throw Error();
   if(!Buffer.from(s.sshPrivateKey,'base64').toString().includes('PRIVATE KEY'))throw Error();
   const c=settings.coolify;
   if(!c?.url||!c?.resource||!settings.ssh?.host||!settings.ssh?.knownHosts)throw Error();
   const url=new URL(c.url);
   if(url.protocol!=='https:'&&!(settings.testOnly&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error();
   if(!/^[A-Za-z0-9_-]+$/.test(c.resource))throw Error();
  }catch{throw Object.assign(Error('Watcher secrets or deployment settings are missing or invalid. Run set-secrets.ps1 and review the configuration.'),{code:'secrets-missing'});}
  configureJournals(config.outDir,s.journalKey);cached=s;return s;
 }
 async function api(s,method,route,body) {
  if(method!=='GET'){if(!activeLease)throw Error('Remote release lease is required.');activeLease.assertHeld();await ssh(s,{action:'fence'});}
  const response=await fetch(settings.coolify.url.replace(/\/$/,'')+'/api/v1'+route,{
   method,redirect:'error',headers:{authorization:'Bearer '+s.coolifyToken,'content-type':'application/json'},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)}).catch(()=>{throw Object.assign(Error('Coolify transport unavailable.'),{code:'COOLIFY_UNAVAILABLE',environmental:true});});
   if(!response.ok)throw Object.assign(Error(`Coolify request failed (HTTP ${response.status}).`),{code:'COOLIFY_HTTP_FAILURE',environmental:response.status>=500||response.status===429});
  try{return await response.json();}catch{throw Error('Coolify returned invalid JSON.');}
 }
 const resource=()=>'/services/'+settings.coolify.resource;
 async function ssh(s,request) {
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
   if(!result.ok){const code=['MEMORY_LOW','DISK_LOW','LOCK_BUSY','LOCK_LOST','NOT_WARM','REMOTE_UNAVAILABLE','REMOTE_FAILED'].includes(result.code)?result.code:'REMOTE_FAILED';throw Object.assign(Error('Remote operation failed: '+code),{code,environmental:code!=='REMOTE_FAILED'});}return result;
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
 }
 async function protect(value){return (await script('protect-value.ps1',['-Mode','Protect'],value)).stdout.trim();}
 async function unprotect(value){return (await script('protect-value.ps1',['-Mode','Unprotect'],value)).stdout;}
 const load=async baseline=>JSON.parse(await unprotect(fs.readFileSync(baseline.file,'utf8')));
 const checkSource=(budget,offers=[],capture=false)=>'const expected='+JSON.stringify({budget,offers,capture})+';\n'+fs.readFileSync(path.join(here,'check-backend.mjs'),'utf8');
 return {
  secrets,
  async verifyRelease(release){for(const b of Object.values(release.bundles??{}))verifyBundleCustody(b,config.bundlePins?.[`${b.lane}-${b.version}`]);if(!release.bundles)throw Error('Release provenance is missing.');},
  pause(){assertPause();if(config.pauseFile)assertPause(config.pauseFile);},
  deploymentBudget(){assertTime(config.roundDeadline??Date.now()+(config.roundHours??7)*3600000,Math.max(180,config.deploymentMaxMinutes??180));},
  cleanupSsh(){cleanupSsh(priv);cleanupRollback(priv,config.outDir);},
  preflightRemote:(s,pinned)=>ssh(s,{action:'preflight',backendCount:pinned.odc.length}),
  async ensureReleaseLock(s,previous){
   try{activeLease?.assertHeld();if(activeLease){await ssh(s,{action:'fence'});return previous;}}catch{}
   if(previous)await previous();
   return this.acquireReleaseLock(s);
  },
  async acquireReleaseLock(s){
   const folder=path.join(priv,'ssh-'+randomUUID());fs.mkdirSync(folder,{recursive:true});const key=path.join(folder,'identity');
   try{
    if(process.platform==='win32')await runtime.run('C:/Windows/System32/icacls.exe',[folder,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`],{secret:true,evenWhenStopping:true});
    fs.writeFileSync(key,Buffer.from(s.sshPrivateKey,'base64'),{mode:0o600});
    const token=randomUUID();
    const release=await runtime.openLease(settings.ssh.executable??'C:/Windows/System32/OpenSSH/ssh.exe',[
     '-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${settings.ssh.knownHosts}`,'-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-i',key,`${settings.ssh.user??'root'}@${settings.ssh.host}`,
     "flock -x -w 30 /var/lock/ssam-release.lock sh -c "+q("umask 077; printf %s "+q(token)+" > /var/lock/ssam-release.owner; trap 'rm -f /var/lock/ssam-release.owner' EXIT; printf 'SSAM_LOCKED\\n'; cat >/dev/null")
    ]);
    release.token=token;activeLease=release;
    return async()=>{try{await release();}finally{activeLease=null;fs.rmSync(folder,{recursive:true,force:true});}};
   }catch(e){fs.rmSync(folder,{recursive:true,force:true});throw e;}
  },
  async observe(installed,{dryRun=false,manifest=runtime.manifest()}={}) {
   const result=await detectSources(installed);
   runtime.sourceStatus=result.sources;
   if(dryRun)return result.observed;
   const verified=[];
   for(const release of result.observed.filter(x=>x.url)){
    if(manifest[release.lane].some(x=>x.version===release.version))continue;
    const downloaded=await downloadInstaller(release,config.installersDir??'C:/ssam-priv/vigia-installers');
    const signer=await runtime.verifyPublisher(downloaded.file);
    const folder=path.join(priv,'extracted',release.lane+'-'+release.fullVersion+'-'+randomUUID());
    fs.mkdirSync(folder,{recursive:true});
    await runtime.run(config.python??'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',[
     path.join(root,'server/docker/ssam-server/nsis_extract.py'),'extract',downloaded.file,folder,'--marker','ServiceStudio.Framework.dll'
    ],{secret:true,timeoutMs:180000});
    const read=await runtime.run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'detect-studios.ps1'),release.lane==='odc'?'-Odc':'-O11',folder]);
    const found=JSON.parse(read.stdout).find(x=>x.lane===release.lane&&x.fullVersion===release.fullVersion);
    if(!found)throw Error('Extracted Studio version differs from the release source.');
    await runtime.run(ps,['-NoProfile','-NonInteractive','-File',path.join(here,'verify-extraction.ps1'),'-Root',folder],{secret:true});
    const provenance=captureProvenance(folder,downloaded.file,signer);
    verifyProvenance(provenance);
    Object.assign(release,found,{requiresInstallation:false,installer:downloaded.file,sha256:downloaded.sha256,provenance});
    verified.push(release);
   }
   return verified;
  },
  async buildBridges(pair,bundles,dir){
   await runtime.executionSource();
   for(const b of Object.values(bundles))verifyBundleCustody(b,config.bundlePins?.[`${b.lane}-${b.version}`]);
   const agentSource=await runtime.agentSource();
   const s=await secrets(),key=createPublicKey(s.manifestPrivateKey).export({type:'spki',format:'pem'});
   const stage=path.join(priv,'bridges',randomUUID());fs.mkdirSync(stage,{recursive:true});
   fs.writeFileSync(path.join(stage,'public-key.pem'),key);
   const protocol=/const string Version = "(v\d+)"/.exec(fs.readFileSync(path.join(root,'server/platforms/odc/studio/bridge/client/Program.cs'),'utf8'))?.[1];
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
     const projectFile=path.join(lane==='o11'?agentSource:root,project),properties=['-p:UseAppHost=false',`-p:OdcInstall=${bundles.odc.snapshot}`,`-p:SSDir=${bundles.o11.snapshot}`];
     const framework=await runtime.run(config.dotnet??'C:/Program Files/dotnet/dotnet.exe',['msbuild',projectFile,'-getProperty:TargetFramework',...properties],{dir});
     if(framework.stdout.trim()!==b.tfm)throw Error('Reviewed bridge runtime does not match the Studio.');
     await runtime.run(config.dotnet??'C:/Program Files/dotnet/dotnet.exe',['build',projectFile,'-c','Release','-nodeReuse:false',...properties,...(sub==='hook'?['-p:AssemblyName=Anvil.RuntimeHook.Agent']:[]),'-o',path.join(target,sub)],{dir,env:{TEMP:priv,TMP:priv,DOTNET_CLI_HOME:path.join(priv,'dotnet-home'),ANVIL_LANE:lane==='odc'?'ss5':'ss4',ANVIL_STUDIO_DIR:b.snapshot,ANVIL_ODC_STUDIO_DIR:bundles.odc.snapshot},timeoutMs:15*60000});
      const builtPath=await runtime.run(config.dotnet??'C:/Program Files/dotnet/dotnet.exe',['msbuild',projectFile,'-getProperty:TargetPath','-p:Configuration=Release','-p:OutputPath='+path.join(target,sub)+path.sep,...properties,...(sub==='hook'?['-p:AssemblyName=Anvil.RuntimeHook.Agent']:[])],{dir});
      outputs.push(builtPath.stdout.trim());assets.push(path.join(path.dirname(projectFile),'obj/project.assets.json'));
    }
    const evidenceFile=path.join(target,'build-evidence.json');
    fs.writeFileSync(evidenceFile,JSON.stringify(artifactEvidence(target,outputs,assets)));
    const required=lane==='odc'?[`bridge/ODC3.Bridge.${protocol}.dll`,'client/ODC3.Bridge.Client.dll','client/ODC3.Bridge.Client.runtimeconfig.json']:['bridge/Anvil.Bridge.dll','hook/Anvil.RuntimeHook.Agent.dll'];
    if(required.some(name=>!fs.existsSync(path.join(target,name))))throw Error('The compiled client bridge entrypoints are incomplete.');
    if(lane==='odc'&&JSON.parse(fs.readFileSync(path.join(target,'client/ODC3.Bridge.Client.runtimeconfig.json'),'utf8')).runtimeOptions?.tfm!==b.tfm)throw Error('The bridge client targets a different Studio runtime.');
    // The shared signing entry point reads the thumbprint from DPAPI itself.
    await runtime.run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'server/scripts/odc-runtime-signing.ps1'),'-Mode','Artifacts','-ArtifactDirectory',target,'-BuildEvidence',evidenceFile,'-ConfigPath',config.configFile,...(config.vault?['-Vault',config.vault]:[]),'-TimestampServer',settings.timestampServer??'http://timestamp.digicert.com'],{secret:true,timeoutMs:300000});
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
    const sequenceFile=path.join(priv,'bridge-sequences.json');let sequences={};if(fs.existsSync(sequenceFile))sequences=JSON.parse(fs.readFileSync(sequenceFile,'utf8'));
    const identity=lane+':'+b.version;const sequence=(sequences[identity]??0)+1;sequences[identity]=sequence;
    fs.writeFileSync(sequenceFile+'.next',JSON.stringify(sequences));fs.renameSync(sequenceFile+'.next',sequenceFile);
    const manifest={schema:1,lane,studioVersion:b.version,runtime:b.tfm,protocol:p,sequence,createdAt:new Date().toISOString(),files,authenticodeThumbprint:s.authenticodeThumbprint};
    const bytes=Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(target,'manifest.json'),bytes);fs.writeFileSync(path.join(target,'manifest.sig'),sign(null,bytes,s.manifestPrivateKey));
    offers.push(verifyBridge(target,key).manifest);
   }
   runtime.bridgeStage=stage;
   const kernels=JSON.parse(fs.readFileSync(path.join(root,'server/deploy/coolify/r1-kernels.json'),'utf8'));
   const known=Object.values(kernels).find(k=>k.odc===pair.odc&&k.o11===pair.o11);
   return {stage,offers:offers.map(({lane,studioVersion,protocol,sequence})=>({lane,studioVersion,protocol,sequence})),kernel:{o11:pair.o11,odc:pair.odc,odcBridge:protocol,odcBridgeAccepted:[...new Set([protocol,...(known?.odcBridgeAccepted??[])])],o11BridgeAccepted:['d1']}};
  },
  async liveBaseline(s){
   const value=await api(s,'GET',resource());
   if(typeof value.docker_compose_raw!=='string'||!value.docker_compose_raw)throw Error('Coolify live compose is missing.');
   const observed=await ssh(s,{action:'snapshot',checkSource:checkSource(readListingBudget(root),[],true)});
   const snapshot={compose:value.docker_compose_raw,...observed};const baseline=liveBaseline(snapshot);
   runtime.liveKernels=baseline.kernels;
   const file=path.join(priv,'rollback',randomUUID()+'.dpapi');fs.mkdirSync(path.dirname(file),{recursive:true});
   fs.writeFileSync(file,await protect(JSON.stringify(snapshot)),{mode:0o600});
   return {file,hash:composeHash(snapshot.compose),manifest:baseline.manifest,kernels:baseline.kernels,telemetry:baseline.telemetry};
  },
  async assertLiveUnchanged(s,baseline){unchanged(baseline,(await api(s,'GET',resource())).docker_compose_raw);},
  async composeFor(s,baseline,pinned){return preserveCompose(await load(baseline),pinned);},
  backup:(s,id)=>ssh(s,{action:'backup',id}),
  async prepare(s,r){
   const archive=path.join(r.dir,'deploy.tar.gz');await runtime.archiveDeploy(await runtime.fullHead(),archive);
   return ssh(s,{action:'prepare',id:r.id,built:r.built,kernel:r.kernel,compose:JSON.parse(r.compose.replace(/^#[^\n]*\n/,'')),
    archive:fs.readFileSync(archive).toString('base64'),features:fs.readFileSync(r.features).toString('base64')});
  },
  async writeCompose(s,compose){await api(s,'PATCH',resource(),{docker_compose_raw:Buffer.from(compose).toString('base64'),instant_deploy:false});unchanged({hash:composeHash(compose)},(await api(s,'GET',resource())).docker_compose_raw);},
  deploy: s=>api(s,'POST',resource()+'/restart'),
  async restoreCompose(s,snapshot){const value=await load(snapshot);return this.writeCompose(s,value.compose);},
  async checks(s,expected){
   const budget=readListingBudget(root);
   const before=expected.rollback?(await load(expected.live)).backends:null;
   const checkSources=before?Object.fromEntries(before.map(b=>[b.o11+'|'+b.odc,'const expected='+JSON.stringify({budget:b.budget,offers:[],kernel:b.kernel})+';\n'+fs.readFileSync(path.join(here,'check-backend.mjs'),'utf8')])):null;
   return ssh(s,{action:'check',...expected,budget,expectedBackends:before,checkSources,checkSource:checkSource(budget,expected.bridges?.offers??[])});
  },
  async event(name,value,s){
   runtime.log(`release ${name}: ${value.id}`);
   await runtime.notify('SSAM: '+name,value.message);
   await ssh(s,{action:'event',event:name,id:value.id}).catch(()=>{});
   if(s.webhookUrl)try{await fetch(s.webhookUrl,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({event:name,...value}),signal:AbortSignal.timeout(15000)});}catch{}
  }
 };
}
