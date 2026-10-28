import fs from 'node:fs';
import path from 'node:path';
import {createPrivateKey,createPublicKey,createHash,sign,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyBridge} from '../../platforms/odc/facade/bridge-store.mjs';
import {detectSources,downloadInstaller} from './sources.mjs';
import {readListingBudget} from './smoke.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const q=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
export function createAutoRuntime(config,runtime) {
 const root=path.resolve(config.workspace),priv=path.resolve(config.tempRoot),settings=config.automaticDeployment??{};
 const ps=config.powershell??'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
 const script=(name,args=[],input)=>runtime.run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,name),...args],{input,secret:true});
 let cached;
 async function secrets(){
  if(cached)return cached;
  let s;
  try {
   s=JSON.parse((await script('read-secrets.ps1',config.vault?['-Vault',config.vault]:[])).stdout);
   if(['coolifyToken','sshPrivateKey','authenticodeThumbprint','manifestPrivateKey'].some(k=>!s[k]))throw Error();
   if(!/^[a-f0-9]{40}$/i.test(s.authenticodeThumbprint))throw Error();
   if(createPrivateKey(s.manifestPrivateKey).asymmetricKeyType!=='ed25519')throw Error();
   if(!Buffer.from(s.sshPrivateKey,'base64').toString().includes('PRIVATE KEY'))throw Error();
   const c=settings.coolify;
   if(!c?.url||!c?.resource||!settings.ssh?.host||!settings.ssh?.knownHosts)throw Error();
   const url=new URL(c.url);
   if(url.protocol!=='https:'&&!(settings.testOnly&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error();
   if(!/^[A-Za-z0-9_-]+$/.test(c.resource))throw Error();
  }catch{throw Object.assign(Error('Watcher secrets or deployment settings are missing or invalid. Run set-secrets.ps1 and review the configuration.'),{code:'secrets-missing'});}
  cached=s;return s;
 }
 async function api(s,method,route,body) {
  const response=await fetch(settings.coolify.url.replace(/\/$/,'')+'/api/v1'+route,{
   method,redirect:'error',headers:{authorization:'Bearer '+s.coolifyToken,'content-type':'application/json'},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
   if(!response.ok)throw Object.assign(Error(`Coolify request failed (HTTP ${response.status}).`),{code:'COOLIFY_HTTP_FAILURE'});
  try{return await response.json();}catch{throw Error('Coolify returned invalid JSON.');}
 }
 const resource=()=>'/services/'+settings.coolify.resource;
 async function ssh(s,request) {
  const folder=path.join(priv,'ssh-'+randomUUID());fs.mkdirSync(folder,{recursive:true});
  const key=path.join(folder,'identity');
  try{
   if(process.platform==='win32')await runtime.run('C:/Windows/System32/icacls.exe',[folder,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`],{secret:true});
   fs.writeFileSync(key,Buffer.from(s.sshPrivateKey,'base64'),{mode:0o600});
   const remote=fs.readFileSync(path.join(here,'remote-release.py'),'utf8');
   const r=await runtime.run(settings.ssh.executable??'C:/Windows/System32/OpenSSH/ssh.exe',[
    '-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${settings.ssh.knownHosts}`,
    '-o','ConnectTimeout=20','-i',key,`${settings.ssh.user??'root'}@${settings.ssh.host}`,
    'python3 -c '+q(remote)
   ],{secret:true,input:JSON.stringify({...request,settings:settings.remote}),timeoutMs:30*60000});
   const result=JSON.parse(r.stdout);if(!result.ok)throw Error('Remote operation failed.');return result;
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
 }
 async function protect(value){return (await script('protect-value.ps1',['-Mode','Protect'],value)).stdout.trim();}
 async function unprotect(value){return (await script('protect-value.ps1',['-Mode','Unprotect'],value)).stdout;}
 return {
  secrets,
  async observe(installed,{dryRun=false}={}) {
   const result=await detectSources(installed);
   runtime.sourceStatus=result.sources;
   if(dryRun)return result.observed;
   const manifest=runtime.manifest();
   for(const release of result.observed.filter(x=>x.url)){
    if(manifest[release.lane].some(x=>x.version===release.version))continue;
    const downloaded=await downloadInstaller(release,config.installersDir??'C:/ssam-priv/vigia-installers');
    if(release.studio&&!release.requiresInstallation){Object.assign(release,{installer:downloaded.file,sha256:downloaded.sha256});continue;}
    const folder=path.join(priv,'extracted',release.lane+'-'+release.fullVersion);
    fs.mkdirSync(folder,{recursive:true});
    await runtime.run(config.python??'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',[
     path.join(root,'server/docker/ssam-server/nsis_extract.py'),'extract',downloaded.file,folder,'--marker','ServiceStudio.Framework.dll'
    ],{secret:true,timeoutMs:180000});
    const read=await runtime.run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'detect-studios.ps1'),release.lane==='odc'?'-Odc':'-O11',folder]);
    const found=JSON.parse(read.stdout).find(x=>x.lane===release.lane&&x.fullVersion===release.fullVersion);
    if(!found)throw Error('Extracted Studio version differs from the release source.');
    Object.assign(release,found,{requiresInstallation:false,installer:downloaded.file,sha256:downloaded.sha256});
   }
   return result.observed;
  },
  async buildBridges(pair,bundles,dir){
   const s=await secrets(),key=createPublicKey(s.manifestPrivateKey).export({type:'spki',format:'pem'});
   const stage=path.join(priv,'bridges',path.basename(dir));fs.mkdirSync(stage,{recursive:true});
   fs.writeFileSync(path.join(stage,'public-key.pem'),key);
   const protocol=/const string Version = "(v\d+)"/.exec(fs.readFileSync(path.join(root,'server/platforms/odc/studio/bridge/client/Program.cs'),'utf8'))?.[1];
   if(!protocol)throw Error('Cannot determine ODC bridge protocol.');
   const offers=[];
   for(const lane of ['odc','o11']){
    const b=bundles[lane],p=lane==='odc'?protocol:'h1',target=path.join(stage,lane,b.version,p);
    if(fs.existsSync(path.join(target,'manifest.json'))){offers.push(verifyBridge(target,key).manifest);continue;}
    const projects=lane==='odc'?[
     ['server/platforms/odc/studio/bridge/Bridge.csproj','bridge'],
     ['server/platforms/odc/studio/bridge/client/Client.csproj','client']
    ]:[['agent/kernel/src/Anvil.Bridge.Thin/Anvil.Bridge.Thin.csproj','bridge'],['agent/kernel/tools/Anvil.RuntimeHook/Anvil.RuntimeHook.csproj','hook']];
    for(const [project,sub] of projects){
     await runtime.waitForDotnet();
     await runtime.run(config.dotnet??'C:/Program Files/dotnet/dotnet.exe',['build',path.join(root,project),'-c','Release','-nodeReuse:false',`-p:TargetFramework=${b.tfm}`,`-p:OdcBridgeRuntime=${b.tfm}`,`-p:OdcInstall=${bundles.odc.snapshot}`,`-p:SSDir=${bundles.o11.snapshot}`,...(sub==='hook'?['-p:AssemblyName=Anvil.RuntimeHook.Agent']:[]),'-o',path.join(target,sub)],{dir,env:{TEMP:priv,TMP:priv,DOTNET_CLI_HOME:path.join(priv,'dotnet-home'),ANVIL_LANE:lane==='odc'?'ss5':'ss4',ANVIL_STUDIO_DIR:b.snapshot,ANVIL_ODC_STUDIO_DIR:bundles.odc.snapshot},timeoutMs:15*60000});
    }
    const required=lane==='odc'?[`bridge/ODC3.Bridge.${protocol}.dll`,'client/ODC3.Bridge.Client.dll','client/ODC3.Bridge.Client.runtimeconfig.json']:['bridge/Anvil.Bridge.dll','hook/Anvil.RuntimeHook.Agent.dll'];
    if(required.some(name=>!fs.existsSync(path.join(target,name))))throw Error('The compiled client bridge entrypoints are incomplete.');
    if(lane==='odc'&&JSON.parse(fs.readFileSync(path.join(target,'client/ODC3.Bridge.Client.runtimeconfig.json'),'utf8')).runtimeOptions?.tfm!==b.tfm)throw Error('The bridge client targets a different Studio runtime.');
    // The shared signing entry point reads the thumbprint from DPAPI itself.
    await runtime.run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'server/scripts/odc-runtime-signing.ps1'),'-Mode','Artifacts','-ArtifactDirectory',target,...(config.vault?['-Vault',config.vault]:[]),'-TimestampServer',settings.timestampServer??'http://timestamp.digicert.com'],{secret:true,timeoutMs:300000});
    const files=[];
    for(const sub of fs.readdirSync(target)){
     const folder=path.join(target,sub);if(!fs.statSync(folder).isDirectory())continue;
     for(const name of fs.readdirSync(folder)){
      if(!/\.(dll|exe|json)$/.test(name)){fs.rmSync(path.join(folder,name));continue;}
      const bytes=fs.readFileSync(path.join(folder,name));files.push({path:sub+'/'+name,sha256:hash(bytes),size:bytes.length});
     }
    }
    const manifest={schema:1,lane,studioVersion:b.version,runtime:b.tfm,protocol:p,createdAt:new Date().toISOString(),files,authenticodeThumbprint:s.authenticodeThumbprint};
    const bytes=Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(target,'manifest.json'),bytes);fs.writeFileSync(path.join(target,'manifest.sig'),sign(null,bytes,s.manifestPrivateKey));
    offers.push(verifyBridge(target,key).manifest);
   }
   runtime.bridgeStage=stage;
   const kernels=JSON.parse(fs.readFileSync(path.join(root,'server/deploy/coolify/r1-kernels.json'),'utf8'));
   const known=Object.values(kernels).find(k=>k.odc===pair.odc&&k.o11===pair.o11);
   return {stage,offers:offers.map(({lane,studioVersion,protocol})=>({lane,studioVersion,protocol})),kernel:{o11:pair.o11,odc:pair.odc,odcBridge:protocol,odcBridgeAccepted:[...new Set([protocol,...(known?.odcBridgeAccepted??[])])],o11Hook:'h1',o11BridgeAccepted:['h1']}};
  },
  async saveLiveCompose(s,id){
   const value=await api(s,'GET',resource());
   if(typeof value.docker_compose_raw!=='string'||!value.docker_compose_raw)throw Error('Coolify live compose is missing.');
   value.vigiaSnapshot=await ssh(s,{action:'snapshot'});
   if(!value.vigiaSnapshot.backends.length)throw Error('No live backends to restore.');
   const file=path.join(priv,'rollback',id+'.dpapi');fs.mkdirSync(path.dirname(file),{recursive:true});
   fs.writeFileSync(file,await protect(JSON.stringify(value)),{mode:0o600});
   return {file};
  },
  backup:(s,id)=>ssh(s,{action:'backup',id}),
  async prepare(s,r){
   const archive=path.join(r.dir,'deploy.tar.gz');await runtime.archiveDeploy(await runtime.fullHead(),archive);
   return ssh(s,{action:'prepare',id:r.id,built:r.built,kernel:r.kernel,compose:JSON.parse(r.compose.replace(/^#[^\n]*\n/,'')),
    archive:fs.readFileSync(archive).toString('base64'),features:fs.readFileSync(r.features).toString('base64')});
  },
  writeCompose:(s,compose)=>api(s,'PATCH',resource(),{docker_compose_raw:Buffer.from(compose).toString('base64'),instant_deploy:false}),
  deploy: s=>api(s,'POST',resource()+'/restart'),
  async restoreCompose(s,snapshot){const value=JSON.parse(await unprotect(fs.readFileSync(snapshot.file,'utf8')));return api(s,'PATCH',resource(),{docker_compose_raw:Buffer.from(value.docker_compose_raw).toString('base64'),instant_deploy:false});},
  async checks(s,expected){
   const budget=readListingBudget(root);
   const before=expected.rollback?JSON.parse(await unprotect(fs.readFileSync(expected.live.file,'utf8'))).vigiaSnapshot.backends:null;
   const checkSource='const expected='+JSON.stringify({budget,offers:expected.bridges?.offers??[]})+';\n'+fs.readFileSync(path.join(here,'check-backend.mjs'),'utf8');
   return ssh(s,{action:'check',...expected,budget,expectedBackends:before,checkSource});
  },
  async event(name,value,s){
   runtime.log(`release ${name}: ${value.id}`);
   await runtime.notify('SSAM: '+name,value.message);
   await ssh(s,{action:'event',event:name,id:value.id}).catch(()=>{});
   if(s.webhookUrl)try{await fetch(s.webhookUrl,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({event:name,...value}),signal:AbortSignal.timeout(15000)});}catch{}
  }
 };
}
