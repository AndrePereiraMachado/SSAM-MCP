// The real operations of the watcher on the owner's Windows machine: Studio detection, the bundle store, filtered kernel
// tests, the local image, its smoke test, the proposal branch and, on the owner's command, publication and the pin.
// Nothing here touches the VPS, Coolify or GitHub, pushes Git or moves latest.
import fs from 'node:fs';
import {verifyProvenance,verifyBundleCustody} from './provenance.mjs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import crypto,{createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readTrx,pairTag,pairId,packFor,version as threeOf} from './window.mjs';
import {smokeImage,readListingBudget} from './smoke.mjs';
import {EnvironmentError} from './pipeline.mjs';
import {busyDotnet} from './host.mjs';
import {peFileVersion} from '../kernel-pair-check.mjs';
import {createAutoRuntime} from './auto-runtime.mjs';
import {executionSource,agentReleasePin} from './safety.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const slash=p=>p.replaceAll('\\','/');
const bashPath=p=>slash(p).replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// A command and everything it started (dotnet test and its testhost, bash and its docker), on Windows.
const killTree=child=>{try{if(process.platform==='win32')spawnSync('C:/Windows/System32/taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});else child.kill();}catch{}};
export const DEFAULT_FILTERS={odc:'FullyQualifiedName~ScreenHtmlDataTableOdcTests|FullyQualifiedName~ScreenVisualOdcTests',o11:'FullyQualifiedName~ScreenHtmlDataTableTests|FullyQualifiedName~ScreenVisualCheckTests'};
export const TEST_PROJECT={odc:'server/kernel/tests/Anvil.Tests.Odc',o11:'server/kernel/tests/Anvil.Tests'};
export const STUDIO_PROPERTY={odc:'OdcInstall',o11:'SSDir'};
const RUNTIME_CONFIG={odc:'ODCStudio.runtimeconfig.json',o11:'ServiceStudio.runtimeconfig.json'};
// The .NET a Studio folder runs on, from its main runtimeconfig.json (null when the folder has none).
export function studioTfm(dir,lane){try{return JSON.parse(fs.readFileSync(path.join(dir,RUNTIME_CONFIG[lane]),'utf8')).runtimeOptions?.tfm??null;}catch{return null;}}
// The framework the Studio's own ServiceStudio.Framework.dll was built for (its TargetFrameworkAttribute,
// ".NETCoreApp,Version=v8.0"), for a frozen copy that has no runtimeconfig.json (bundles made before 2026-10-27).
export function assemblyTfm(dir){
 try{const b=fs.readFileSync(path.join(dir,'ServiceStudio.Framework.dll')),at=b.indexOf('.NETCoreApp,Version=v');if(at<0)return null;
  const m=/^\.NETCoreApp,Version=v(\d+\.\d+)/.exec(b.toString('latin1',at,at+32));return m?'net'+m[1]:null;}catch{return null;}
}
// The build rule (kernel/StudioRuntime.props) reads the Studio folder's runtimeconfig.json and refuses to guess without
// it; for such a folder the documented pin carries the framework the Studio's assemblies were built for.
export const RUNTIME_PIN={odc:'AnvilOdcStudioTfm',o11:'AnvilO11StudioTfm'};
export function runtimePins(side){
 return Object.entries(RUNTIME_PIN).flatMap(([lane,prop])=>{const s=side[lane];if(!s?.snapshot||studioTfm(s.snapshot,lane))return [];const tfm=assemblyTfm(s.snapshot);return tfm?[`-p:${prop}=${tfm}`]:[];});
}
// The Studio version a Features.plain.xml was exported from (<Features Version="1.7.29.10940">), or null.
export function featuresVersion(file){
 try{const b=fs.readFileSync(file).subarray(0,4096);const text=b[0]===0xff&&b[1]===0xfe?b.toString('utf16le'):b.toString('utf8');
  return /<Features\b[^>]*\bVersion="([^"]+)"/.exec(text)?.[1]??null;}catch{return null;}
}
// Why a test run gave no usable result, when the machine is the cause: a timeout, a package restore or the network, or a
// baseline (the default pair, already served) that does not build here. Anything else on the candidate is the version's.
const NETWORK=/NU1301|NU1101|NU1102|Unable to load the service index|Failed to download package|The SSL connection could not be established|No such host is known|Name or service not known|actively refused|Response status code does not indicate success|A connection attempt failed/i;
export function testCause(result,kind,hasReport){
 const out=`${result.stdout??''}\n${result.stderr??''}`;
 if(/\(timed out after \d+ ms\)/.test(out))return {environmental:true,why:'timed out'};
 if(!hasReport&&NETWORK.test(out))return {environmental:true,why:'package restore or network'};
 if(!hasReport&&kind==='baseline')return {environmental:true,why:'no test results from the baseline'};
 return {environmental:false};
}
// Why build.sh failed: the network or a registry (pulling a base image), a timeout, or the build itself. The client-name
// guard refusing is the code's, never the environment's.
const REGISTRY=/failed to (resolve source metadata|do request|fetch oauth token|authorize|copy)|TLS handshake timeout|i\/o timeout|no such host|connection (refused|reset by peer)|toomanyrequests|429 Too Many Requests|unexpected EOF|dial tcp|Temporary failure in name resolution|error pulling image|net\/http: request canceled|Cannot connect to the Docker daemon|error during connect/i;
export function buildCause(result){
 const out=`${result.stdout??''}\n${result.stderr??''}`;
 if(/\(timed out after \d+ ms\)/.test(out))return {environmental:true,why:'timed out'};
 const net=REGISTRY.exec(out);
 if(/the client-name guard FAILED/.test(out)&&!net)return {environmental:false,why:'the client-name guard failed: a client name would ship'};
 if(net)return {environmental:true,why:`network or registry: ${net[0]}`};
 return {environmental:false,why:''};
}
export async function createRuntime(config,{log=()=>{}}={}){
 const SAFE_GIT=['-c','core.autocrlf=false','-c','core.hooksPath=','-c','core.fsmonitor=false','-c','core.pager=cat','-c','credential.helper=','-c','diff.external=','-c','protocol.ext.allow=never','-c','protocol.file.allow=never','-c','core.attributesFile=NUL'];
 const root=path.resolve(config.workspace),temp=path.resolve(config.tempRoot),out=path.resolve(config.outDir),store=path.resolve(config.bundleRoot);
 if(/^c:[\\/]t(?:[\\/]|$)/i.test(temp))throw Error('tempRoot must be private and outside C:\\t.');
 const exe={git:config.git??'C:/Program Files/Git/cmd/git.exe',powershell:config.powershell??'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',bash:config.bash??'C:/Program Files/Git/bin/bash.exe',dotnet:config.dotnet??'C:/Program Files/dotnet/dotnet.exe',docker:config.docker??'C:/Program Files/Docker/Docker/resources/bin/docker.exe',dockerDesktop:config.dockerDesktop??'C:/Program Files/Docker/Docker/Docker Desktop.exe',tar:config.tar??'C:/Windows/System32/tar.exe',node:process.execPath};
 const context=config.dockerContext??'desktop-linux';if(context!=='desktop-linux')throw Error('Only the local Docker Desktop context is supported.');
 const ps=(file,args,options)=>run(exe.powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],options);
 const featuresRoot=path.resolve(config.featuresRoot??path.join(temp,'features'));
 if(/^c:[\\/]t(?:[\\/]|$)/i.test(featuresRoot))throw Error('featuresRoot must be private and outside C:\\t.');
 let sequence=0;const active=new Set();let stopping=false;
 // After the round's time limit no command starts, and one that ends (killed by the cut) reports the cut, never a result.
 const cutShort=()=>new EnvironmentError('The round reached its time limit; its commands were stopped.','round-timeout');
 async function run(command,args,{env={},input,dir,allowFailure=false,secret=false,cwd=root,timeoutMs=0,evenWhenStopping=false}={}){
  if(stopping&&!evenWhenStopping)throw cutShort();
  // PowerShell 7 hosts otherwise pass their incompatible module path to 5.1.
  if(process.platform==='win32'&&command===exe.powershell)env={PSModulePath:'C:/Windows/System32/WindowsPowerShell/v1.0/Modules;'+(process.env.PSModulePath??''),...env};
  if(dir){fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(path.join(dir,'commands.jsonl'),JSON.stringify({time:new Date().toISOString(),command,args:secret?['(not recorded)']:args,cwd,env:Object.keys(env)})+'\n');}
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(command,args,{cwd,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),...env},windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',timer=null;active.add(child);
   if(timeoutMs)timer=setTimeout(()=>{stderr+=`\n(timed out after ${timeoutMs} ms)`;killTree(child);},timeoutMs);
   child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',e=>{clearTimeout(timer);active.delete(child);reject(e);});child.once('close',code=>{clearTimeout(timer);active.delete(child);resolve({code,stdout,stderr});});child.stdin.end(input);
  });
  if(stopping&&!evenWhenStopping)throw cutShort();
  if(dir&&!secret)fs.writeFileSync(path.join(dir,`command-${++sequence}.log`),`> ${path.basename(command)} ${args.join(' ')}\n`+result.stdout+result.stderr);
  if(result.code!==0&&!allowFailure)throw Error(`Command failed (${result.code}): ${path.basename(command)} ${args.slice(0,3).join(' ')}. See ${dir?path.join(dir,'commands.jsonl'):'the run log'}.`);
  return result;
 }
 const docker=(args,options={})=>run(exe.docker,['--context',context,...args],options);
 const git=(args,options={})=>run(exe.git,[...SAFE_GIT,'-C',options.cwd??root,...args],{...options,env:{...options.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat'}});
 const commitAs=['-c','user.name=Andre Machado','-c','user.email=andre_c_machado@hotmail.com'];
 async function checkWorkspace(){
  if(config.automatic){await ps(path.join(here,'execution-trust.ps1'),['-Workspace',root]);}
  else if(!fs.statSync(path.join(root,'.git')).isFile())throw new EnvironmentError('Use a dedicated Git worktree, not the primary checkout.','workspace');
  const executors=await git(['config','--local','--get-regexp','^(include|includeIf|filter\\.|diff\\..*\\.command|merge\\..*\\.driver)'],{allowFailure:true});
  if(executors.stdout.trim())throw new EnvironmentError('Executable or included repository configuration is refused.','UNTRUSTED_SOURCE');
  const branch=(await git(['branch','--show-current'])).stdout.trim();if(!branch||branch==='main'||branch==='master'||branch.startsWith('vigia/'))throw new EnvironmentError('Use the clean integration worktree (not main, not a vigia/ proposal branch).','workspace');
  // Untracked files count too: build.sh sends the tree to Docker, and .dockerignore does not cover a loose file.
  const dirty=(await git(['status','--porcelain'])).stdout.split('\n').filter(l=>l.trim());
  if(dirty.length)throw new EnvironmentError(`The watcher worktree has changes or untracked files (${dirty.slice(0,3).map(l=>l.slice(3)).join(', ')}). Commit or review them first.`,'workspace');
  return branch;
 }
 const storeDir=(lane,v)=>path.join(store,`${lane}-${v}`);
 const studioVersionOf=dir=>{try{return peFileVersion(fs.readFileSync(path.join(dir,'ServiceStudio.Framework.dll')))?.product??null;}catch{return null;}};
 function bundleFile(folder,lane,v,full){
  let names=[];try{names=fs.readdirSync(folder);}catch{}
  const found=names.map(n=>new RegExp(`^${lane}-studio-(\\d+\\.\\d+\\.\\d+\\.\\d+)\\.tar\\.gz$`).exec(n)).filter(m=>m&&threeOf(m[1])===v);
  const chosen=full?found.find(m=>m[1]===full):found.sort((a,b)=>Number(b[1].split('.')[3])-Number(a[1].split('.')[3]))[0];
  return chosen?{file:path.join(folder,chosen[0]),fullVersion:chosen[1]}:null;
 }
 // A bundle in the store that does not check out is never bundled over (it may be another session's, half-written, or
 // the one a published image was built from): the lane waits for a person to review the store.
 function verifyBundle(lane,v,file){
  const review=why=>new EnvironmentError(`${why}: ${file}. Review the bundle store; nothing was bundled over or changed.`,'store-mismatch',[lane]);
  const sha=hash(file);let recorded='';try{recorded=fs.readFileSync(file+'.sha256','utf8').toLowerCase();}catch{throw review('The bundle has no .sha256 beside it');}
  if(!recorded.includes(sha))throw review('The bundle checksum does not match its .sha256');
  const pin=config.bundlePins?.[`${lane}-${v}`];if(config.automatic&&!pin&&!fs.existsSync(file+'.provenance.json'))throw review('Bundle requires a reviewed pin or installer provenance');if(pin&&pin.toLowerCase()!==sha)throw review(`The bundle is not the pinned one (bundlePins ${lane}-${v})`);
  return sha;
 }
 // The features of an ODC version (the tenant's feature flags) live only in the private featuresRoot, never under C:/t.
 // Their root names the Studio version they came from; a cache of another version is never stored under this one.
 const privateFeatures=v=>path.join(featuresRoot,`odc-${v}`,'Features.plain.xml');
 function checkFeatures(file,v,source){
  const found=featuresVersion(file);
  if(threeOf(found)!==v)throw new EnvironmentError(`The ODC Studio features ${source} are for ${found??'no version'}, not ${v}. Open ODC Studio ${v} once, signed in, so it refreshes its feature cache; nothing was stored.`,'features-stale',['odc']);
 }
 async function featuresFor(v,{exportFrom,dir}={}){
  const target=privateFeatures(v);
  if(fs.existsSync(target)){checkFeatures(target,v,target);return target;}
  const legacy=path.join(storeDir('odc',v),'Features.plain.xml');
  if(fs.existsSync(legacy)){checkFeatures(legacy,v,legacy);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(legacy,target);log(`features of ODC ${v} copied into the private store from ${legacy}`);return target;}
  if(!exportFrom)throw new EnvironmentError(`No Features.plain.xml for ODC ${v} in ${path.dirname(target)}.`,'store-incomplete',['odc']);
  const stage=path.join(temp,'features-export',`odc-${v}-${Date.now()}.xml`);fs.mkdirSync(path.dirname(stage),{recursive:true});
  try{
   try{await ps(path.join(root,'server/deploy/odc-features-export.ps1'),['-Source',exportFrom,'-Out',stage],{dir});}
   catch(e){throw new EnvironmentError(`The ODC Studio feature cache ${exportFrom} could not be exported (${e.message}). Open ODC Studio ${v} once, signed in.`,'features-unavailable',['odc']);}
   checkFeatures(stage,v,exportFrom);
   fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(stage,target);return target;
  }finally{fs.rmSync(stage,{force:true});}
 }
 // The frozen copy of a bundle: its files exactly as the image gets them, plus the Studio's runtimeconfig.json (so the
 // build rule sees the Studio's .NET in this folder too).
 // Never renames or deletes a folder it finds: snapshot/ when it holds this build (or does not exist yet), else
 // snapshot-<full version>/.
 async function freeze(folder,file,fullVersion,runtimeFrom,lane,dir){
  const holds=snap=>{try{return /^version (\S+)$/m.exec(fs.readFileSync(path.join(snap,'bundle.txt'),'utf8'))?.[1]===fullVersion;}catch{return false;}};
  const plain=path.join(folder,config.automatic?'snapshot-'+crypto.randomUUID():'snapshot'),own=path.join(folder,`snapshot-${fullVersion}`);
  const snap=holds(plain)?plain:holds(own)?own:fs.existsSync(plain)?own:plain;
  if(!holds(snap)){
   const stage=path.join(folder,`.snapshot-partial-${process.pid}`);fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{recursive:true});
   await run(exe.tar,['-xzf',file,'-C',stage],{dir});
   if(fs.existsSync(snap))throw new EnvironmentError(`${snap} exists but does not hold ${lane} ${fullVersion}; review the bundle store.`,'store-mismatch',[lane]);
   fs.writeFileSync(path.join(stage,'.vigia'),'frozen by the Studio versions watcher\n');
   fs.renameSync(stage,snap);
  }
  // The Studio's runtimeconfig.json goes only into a copy the watcher froze itself (never into another session's).
  const mine=fs.existsSync(path.join(snap,'.vigia'));
  if(runtimeFrom&&mine){const name=RUNTIME_CONFIG[lane],source=path.join(runtimeFrom,name),to=path.join(snap,'files',name);if(fs.existsSync(source)&&!fs.existsSync(to))fs.copyFileSync(source,to);}
  return path.join(snap,'files');
 }
 async function companion(lane,v,dir){
  const folder=storeDir(lane,v),found=bundleFile(folder,lane,v);
  if(!found)throw new EnvironmentError(`No ${lane} ${v} bundle in ${folder}. The store keeps one folder per served version (<lane>-studio-<version>.tar.gz and its .sha256).`,'store-incomplete');
  const sha256=verifyBundle(lane,v,found.file);
  const snapshot=await freeze(folder,found.file,found.fullVersion,null,lane,dir);
  if(threeOf(studioVersionOf(snapshot))!==v)throw new EnvironmentError(`The frozen copy ${snapshot} is not ${lane} ${v}; review the bundle store.`,'store-mismatch',[lane]);
  const features=lane==='odc'?await featuresFor(v):null;
  const provenance=fs.existsSync(found.file+'.provenance.json')?JSON.parse(fs.readFileSync(found.file+'.provenance.json','utf8')):undefined;
  if(config.automatic)verifyBundleCustody({file:found.file,sha256,snapshot,provenance},config.bundlePins?.[`${lane}-${v}`]);
  return {provenance,lane,version:v,fullVersion:found.fullVersion,file:found.file,sha256,snapshot,features,tfm:studioTfm(snapshot,lane)??assemblyTfm(snapshot)};
 }
 async function waitForDotnet(dir){
  const deadline=Date.now()+(config.dotnetWaitMinutes??180)*60000;let said=false;
  for(;;){
   const r=await run(exe.powershell,['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='dotnet.exe' or Name like 'testhost%'\" | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress"],{allowFailure:true,timeoutMs:60000});
   let list=[];try{const parsed=JSON.parse(r.stdout.trim()||'[]');list=Array.isArray(parsed)?parsed:[parsed];}catch{}
   const busy=busyDotnet(list);
   if(!busy.length)return;
   if(!said){log(`waiting for another dotnet build/test (pids ${busy.map(p=>p.ProcessId).join(', ')})`);said=true;}
   if(Date.now()>deadline)throw new EnvironmentError(`Another dotnet build/test kept running for ${config.dotnetWaitMinutes??180} min (pids ${busy.map(p=>p.ProcessId).join(', ')}); one dotnet build/test runs at a time on this machine.`,'dotnet-busy');
   await wait((config.dotnetPollSeconds??60)*1000);
  }
 }
 async function dockerUp(){const r=await docker(['info','--format','{{.ServerVersion}}'],{allowFailure:true,timeoutMs:30000});return r.code===0&&!!r.stdout.trim();}
 async function ensureDocker(){
  if(await dockerUp())return {started:false};
  log('Docker Desktop is not answering; starting it');
  if(!fs.existsSync(exe.dockerDesktop))throw new EnvironmentError(`Docker is not running and Docker Desktop was not found at ${exe.dockerDesktop}.`,'docker-unavailable');
  spawn(exe.dockerDesktop,[],{detached:true,stdio:'ignore',windowsHide:true}).unref();
  const deadline=Date.now()+(config.dockerWaitMinutes??8)*60000;
  while(Date.now()<deadline){await wait((config.dockerPollSeconds??10)*1000);if(await dockerUp()){log('Docker Desktop is up');return {started:true};}}
  throw new EnvironmentError(`Docker Desktop did not answer within ${config.dockerWaitMinutes??8} min of starting it.`,'docker-unavailable');
 }
 const withWorktree=async(ref,create,fn,dir)=>{
  const wt=path.join(temp,'wt',`${Date.now()}`);fs.mkdirSync(path.dirname(wt),{recursive:true});
  await git(create?['worktree','add','--detach',wt,ref]:['worktree','add',wt,ref],{dir});
  try{return await fn(wt);}
  finally{await git(['worktree','remove','--force',wt],{dir,allowFailure:true});if(fs.existsSync(wt))fs.rmSync(wt,{recursive:true,force:true});await git(['worktree','prune'],{dir,allowFailure:true});}
 };
 async function writeWindow(wt,manifest,dir,tests){
  const coolify=path.join(wt,'server/deploy/coolify');
  fs.writeFileSync(path.join(coolify,'versions.json'),JSON.stringify(manifest,null,2)+'\n');
  await run(exe.node,[path.join(coolify,'gen-compose.mjs')],{dir,cwd:wt});
  await run(exe.node,['--test',...tests.map(t=>path.join(coolify,t))],{dir,cwd:wt});
  await git(['add','--','server/deploy/coolify/versions.json','server/deploy/coolify/compose.coolify.yml'],{dir,cwd:wt});
 }
 async function commit(wt,message,dir){
  const file=path.join(dir,`commit-${Date.now()}.txt`);fs.writeFileSync(file,message);
  await git([...commitAs,'commit','-F',file],{dir,cwd:wt});
  return (await git(['rev-parse','HEAD'],{cwd:wt})).stdout.trim();
 }
 async function verifyCommit(commit){
  if(!config.ownerSigningPublicKey)return;
  if(!/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(config.ownerSigningPublicKey))throw Error('Invalid owner signing public key.');
  const allowed=path.join(temp,'allowed-signers');fs.writeFileSync(allowed,'owner '+config.ownerSigningPublicKey+'\n',{mode:0o600});
  await git(['-c','gpg.format=ssh','-c','gpg.ssh.program=C:/Windows/System32/OpenSSH/ssh-keygen.exe','-c','gpg.ssh.allowedSignersFile='+allowed,'verify-commit',commit]);
 }
 const runtime={
  run,docker,log,checkWorkspace,ensureDocker,waitForDotnet,
  deploymentActive:false,
  beginDeployment(){runtime.deploymentActive=true;},endDeployment(){runtime.deploymentActive=false;},
  async openLease(command,args){
   const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
   let alive=true;const closed=new Promise(resolve=>child.once('close',code=>{alive=false;resolve(code);}));child.stderr.resume();
   await new Promise((resolve,reject)=>{
    let text='';const timer=setTimeout(()=>{child.kill();reject(new EnvironmentError('Remote release lock timed out.','LOCK_BUSY'));},45000);
    child.once('error',()=>{clearTimeout(timer);reject(new EnvironmentError('Remote release lock unavailable.','LOCK_BUSY'));});
    child.once('close',()=>{clearTimeout(timer);reject(new EnvironmentError('Remote release lock refused.','LOCK_BUSY'));});
    child.stdin.on('error',()=>{});
    child.stdout.on('data',b=>{text+=b;if(text.includes('SSAM_LOCKED')){clearTimeout(timer);resolve();}});
   });
   const release=async()=>{if(alive)child.stdin.end();await closed;};release.assertHeld=()=>{if(!alive)throw new EnvironmentError('Remote release lease was lost.','LOCK_LOST');};return release;
  },
  manifest:()=>JSON.parse(fs.readFileSync(path.join(root,'server/deploy/coolify/versions.json'),'utf8')),
  head:async()=>(await git(['rev-parse','--short=7','HEAD'])).stdout.trim(),
  fullHead:async()=>(await git(['rev-parse','HEAD'])).stdout.trim(),
  async detect(){
   const result=await ps(path.join(here,'detect-studios.ps1'),['-Odc',config.studios?.odc??'','-O11',config.studios?.o11??'','-Installers',config.installersDir??''],{timeoutMs:120000});
   return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
  },
  // Fast-forward of the integration worktree from the local main, before each round. Anything else stops the round.
  async updateWorkspace(from='main'){
   const branch=await checkWorkspace();
   if(config.automatic){
    if(!/^https:\/\/[^@?#]+$/.test(config.trustedRemote??''))throw Error('Pin a credential-free HTTPS remote in the private configuration.');
    await git(['fetch','--no-tags','--no-recurse-submodules',config.trustedRemote,'+refs/heads/main:refs/remotes/vigia/main']);
    const fetched=(await git(['rev-parse','refs/remotes/vigia/main'])).stdout.trim();
    await verifyCommit(fetched);
    await git(['update-ref','refs/heads/main',fetched]);
   }
   const before=(await git(['rev-parse','HEAD'])).stdout.trim(),target=(await git(['rev-parse','--verify',from+'^{commit}'])).stdout.trim();
   if(before===target)return {updated:false,branch,head:before};
   if((await git(['merge-base','--is-ancestor','HEAD',target],{allowFailure:true})).code!==0)throw Error(`The watcher worktree (${branch} at ${before.slice(0,7)}) cannot fast-forward to ${from} (${target.slice(0,7)}): it has commits ${from} does not have. Nothing was changed; review the worktree ${root}.`);
   await git(['merge','--ff-only',target]);
   return {updated:true,branch,from:before,head:target};
  },
  async preflight(){
   await checkWorkspace();
   const free=fs.statfsSync(temp.slice(0,3)).bavail*fs.statfsSync(temp.slice(0,3)).bsize/2**30,min=config.minFreeGb??25;
   if(free<min)throw new EnvironmentError(`Only ${free.toFixed(1)} GB free on ${temp.slice(0,2)}; a round needs ${min} GB (image build and Docker disk).`,'disk-full');
  },
  // Docker Desktop answering (started and awaited when it is not) and the buildx builder present.
  async dockerReady(){
   await ensureDocker();
   const deadline=Date.now()+(config.dockerWaitMinutes??8)*60000;
   for(;;){
    const r=await run(exe.powershell,['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(docker|docker-buildx)(\\.exe)?$' -and $_.CommandLine -match '(buildx\\s+build|docker-buildx.+build)' } | Select-Object ProcessId) | ConvertTo-Json -Compress"],{timeoutMs:60000});
    if(!r.stdout.trim()||r.stdout.trim()==='[]')break;
    if(Date.now()>deadline)throw new EnvironmentError('Another Docker build is still running; this round is deferred.','docker-busy');
    log('waiting for another Docker build');await wait(5000);
   }
   const builder=config.builder??'ssam-multiver-impl';
   if((await docker(['buildx','inspect',builder],{allowFailure:true,timeoutMs:60000})).code!==0)throw new EnvironmentError(`The buildx builder ${builder} does not exist in Docker Desktop.`,'builder-missing');
  },
  // The target framework MSBuild picks for the test project against that Studio folder (the workspace's build rule),
  // or null when it cannot be evaluated. The watcher compares it with the Studio's own runtime; it never picks one.
  async targetFramework(candidate){
   if(config.automatic)verifyProvenance(candidate.provenance,candidate.studio);
   await waitForDotnet();
   const env={TEMP:temp,TMP:temp,DOTNET_CLI_HOME:path.join(temp,'dotnet-home'),DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1'};
   const r=await run(exe.dotnet,['msbuild',path.join(root,TEST_PROJECT[candidate.lane]),'-nologo','-getProperty:TargetFramework',`-p:${STUDIO_PROPERTY[candidate.lane]}=${candidate.studio}`],{env,allowFailure:true,timeoutMs:300000});
   const value=r.stdout.trim().split(/\r?\n/).pop()?.trim();
   if(r.code!==0||!/^net\d+\.\d+/.test(value??'')){log(`target framework of ${candidate.lane} not evaluated (exit ${r.code})`);return null;}
   return value;
  },
  async bundle(candidate,dir){
   if(config.automatic)verifyProvenance(candidate.provenance,candidate.studio);
   const folder=storeDir(candidate.lane,candidate.version);fs.mkdirSync(folder,{recursive:true});
   // A bundle of this build already in the store is used as it is, or the lane waits (verifyBundle); only a build the
   // store does not have yet is bundled.
   let found=bundleFile(folder,candidate.lane,candidate.version,candidate.fullVersion);
   if(!found){
    const privateTemp=path.join(temp,'bundle');fs.mkdirSync(privateTemp,{recursive:true});
    try{await ps(path.join(root,'server/docker/ssam-server/studio-bundle.ps1'),['-Lane',candidate.lane,'-Studio',candidate.studio,'-OutDir',folder],{dir,env:{TEMP:privateTemp,TMP:privateTemp}});}
    catch(e){throw new EnvironmentError(`studio-bundle.ps1 could not bundle ${candidate.lane} ${candidate.fullVersion} from ${candidate.studio} (${e.message}); the Studio folder may be incomplete.`,'bundle',[candidate.lane]);}
    found=bundleFile(folder,candidate.lane,candidate.version,candidate.fullVersion);
    if(!found)throw new EnvironmentError(`studio-bundle.ps1 did not write ${candidate.lane}-studio-${candidate.fullVersion}.tar.gz.`,'bundle',[candidate.lane]);
   }
   if(config.automatic){verifyProvenance(candidate.provenance,candidate.studio);fs.writeFileSync(found.file+'.provenance.json',JSON.stringify(candidate.provenance));}
   const sha256=verifyBundle(candidate.lane,candidate.version,found.file);
   const snapshot=await freeze(folder,found.file,found.fullVersion,candidate.studio,candidate.lane,dir);
   // The features of this ODC version, exported once from this machine's ODC Studio cache when it is for this version.
   const features=candidate.lane==='odc'?await featuresFor(candidate.version,{exportFrom:config.featuresSource,dir}):null;
   return {provenance:candidate.provenance,lane:candidate.lane,version:candidate.version,fullVersion:found.fullVersion,file:found.file,sha256,snapshot,features,tfm:studioTfm(snapshot,candidate.lane)??candidate.tfm??assemblyTfm(snapshot)};
  },
  companion:(lane,v)=>companion(lane,v),
  async test(lane,kind,side,dir){
   if(config.automatic)for(const b of Object.values(side))verifyBundleCustody(b,config.bundlePins?.[`${b.lane}-${b.version}`]);
   const filter=config.filters?.[lane]??DEFAULT_FILTERS[lane];
   if(!/^FullyQualifiedName~[A-Za-z0-9_.]+(?:\|FullyQualifiedName~[A-Za-z0-9_.]+)*$/.test(filter))throw Error('Use an explicit finite class filter; the full kernel suite is forbidden.');
   const resultDir=path.join(dir,`${lane}-${kind}`),privateTemp=path.join(temp,path.basename(dir),`${lane}-${kind}`);
   fs.rmSync(privateTemp,{recursive:true,force:true});fs.mkdirSync(privateTemp,{recursive:true});
   let featuresDir=null;
   if(lane==='odc'&&side.odc.features){
    featuresDir=path.join(privateTemp,'features');
    try{await ps(path.join(here,'features-protect.ps1'),['-Plain',side.odc.features,'-OutDir',featuresDir],{dir});}
    catch(e){throw new EnvironmentError(`The ODC features could not be prepared for the ${kind} tests (${e.message}).`,kind==='baseline'?'baseline':'test-environment',[lane]);}
   }
   await waitForDotnet(dir);
   const env={TEMP:privateTemp,TMP:privateTemp,DOTNET_CLI_HOME:path.join(temp,'dotnet-home'),DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1',SSAM_MODULE_INDEX_ROOT:path.join(privateTemp,'index'),ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1',SSAM_NO_WARM:'1',ANVIL_STUDIO_DIR:side.o11.snapshot,ANVIL_ODC_STUDIO_DIR:side.odc.snapshot,...(featuresDir?{ANVIL_ODC_FEATURES_DIR:featuresDir}:{})};
   fs.rmSync(path.join(resultDir,'results.trx'),{force:true});
   const result=await run(exe.dotnet,['test',path.join(root,TEST_PROJECT[lane]),'-c','Release','--filter',filter,'--logger','trx;LogFileName=results.trx','--results-directory',resultDir,'-nodeReuse:false',`-p:${STUDIO_PROPERTY[lane]}=${side[lane].snapshot}`,...runtimePins(side)],{dir,env,allowFailure:true,timeoutMs:(config.testTimeoutMinutes??90)*60000});
   const report=path.join(resultDir,'results.trx');
   const cause=testCause(result,kind,fs.existsSync(report));
   if(cause.environmental)throw new EnvironmentError(`The ${lane} ${kind} tests could not run (${cause.why}; exit ${result.code}): ${kind==='baseline'?"the default pair's suite does not build or run on this machine now":'the machine, not the version'}. See ${path.join(dir,'commands.jsonl')}.`,kind==='baseline'?'baseline':'test-environment',[lane]);
   if(!fs.existsSync(report))throw Object.assign(Error(`No test results from the ${lane} candidate run (exit ${result.code}): the test project did not build or run against ${side[lane].snapshot}. See ${path.join(dir,'commands.jsonl')}.`),{lanes:[lane]});
   try{return readTrx(fs.readFileSync(report,'utf8'));}
   catch(e){throw new EnvironmentError(`The ${lane} ${kind} run reported no executed tests (${e.message}); the Studio folder did not load for the tests.`,kind==='baseline'?'baseline':'test-environment',[lane]);}
  },
  async build(pair,bundles,dir){
   if(config.automatic)for(const b of Object.values(bundles))verifyBundleCustody(b,config.bundlePins?.[`${b.lane}-${b.version}`]);
   if(config.automatic)await runtime.executionSource();
   await checkWorkspace();
   const commitShort=(await git(['rev-parse','--short=7','HEAD'])).stdout.trim(),revision=(await git(['rev-parse','HEAD'])).stdout.trim();
   const tag=pairTag(pair,commitShort,new Date().toISOString().slice(0,10).replaceAll('-',''))+(config.automatic?'-a'+crypto.randomUUID().replaceAll('-','').slice(0,12):'');
   const installers=path.join(temp,'installers',pairId(pair));fs.rmSync(installers,{recursive:true,force:true});fs.mkdirSync(installers,{recursive:true});
   try{
    for(const b of Object.values(bundles)){const to=path.join(installers,path.basename(b.file));try{fs.linkSync(b.file,to);}catch{fs.copyFileSync(b.file,to);}}
    const metadata=path.join(dir,'image-metadata.json'),image=config.image??'docker.io/andrepereiramachado/ssam-server';
    const env={TEMP:temp,TMP:temp,PATH:path.dirname(exe.docker)+path.delimiter+path.dirname(exe.git)+path.delimiter+process.env.PATH,DOCKER:'docker --context '+context,BUILDX_BUILDER:config.builder??'ssam-multiver-impl',STUDIO_INSTALLERS_DIR:bashPath(installers),SSAM_BUILD_METADATA_FILE:slash(metadata),SERVICE_STUDIO_BUNDLE:path.basename(bundles.o11.file),SERVICE_STUDIO_BUNDLE_SHA256:bundles.o11.sha256,ODC_STUDIO_BUNDLE:path.basename(bundles.odc.file),ODC_STUDIO_BUNDLE_SHA256:bundles.odc.sha256,SSAM_IMAGE_O11:bundles.o11.version,SSAM_IMAGE_ODC:bundles.odc.version};
    Object.assign(env,{SERVICE_STUDIO_TFM:bundles.o11.tfm,ODC_STUDIO_TFM:bundles.odc.tfm});
    const custody=JSON.stringify(Object.fromEntries(Object.entries(bundles).map(([lane,b])=>[lane,b.provenance??{bundlePin:b.sha256}])));
    const custodyFile=path.join(installers,'provenance.json');fs.writeFileSync(custodyFile,custody);
    const extra=runtime.bridgeStage?['--build-context','client-bridges='+slash(runtime.bridgeStage)]:[];
    const r=await run(exe.bash,[slash(path.join(root,'server/deploy/build.sh')),'--image',image,'--tag',tag,'--','--progress','plain',...extra,'--label','pro.ssam.studio-provenance-sha256='+hash(custodyFile),'--build-context','studio-provenance='+slash(installers)],{dir,env,allowFailure:true,timeoutMs:(config.buildTimeoutMinutes??120)*60000});
    if(r.code!==0){
     const cause=buildCause(r);
     if(cause.environmental)throw new EnvironmentError(`build.sh could not finish for an environment reason (${cause.why}; exit ${r.code}); the round retries. See ${path.join(dir,'commands.jsonl')}.`,'build-environment');
     throw Error(`build.sh failed (exit ${r.code})${cause.why?': '+cause.why:''}. See ${path.join(dir,'commands.jsonl')}.`);
    }
    const sha256=JSON.parse(fs.readFileSync(metadata,'utf8'))['containerimage.digest'].replace(/^sha256:/,'');
    return {odc:bundles.odc.version,o11:bundles.o11.version,image,tag,sha256,revision:commitShort,commit:revision,provenance:JSON.parse(custody)};
   }finally{fs.rmSync(installers,{recursive:true,force:true});}
  },
  async smoke(built,bundles,served,dir){
   const pack=runtime.bridgeKernel?{...runtime.bridgeKernel,o11BuiltFor:built.o11}:packFor(config,bundles);
   return smokeImage({pair:built,bundle:{features:bundles.odc.features},dir,root,docker,served,pack,budget:readListingBudget(root),privateDir:path.join(temp,'smoke')});
  },
  // The proposal branch starts from HEAD, or from the newest approved pin main does not carry yet (base), so merging the
  // newest proposal brings the approved one too, without a conflict in versions.json.
  async propose(manifest,branch,dir,message,{base}={}){
   await checkWorkspace();
   let name=branch;for(let i=2;(await git(['rev-parse','--verify','--quiet','refs/heads/'+name],{allowFailure:true})).code===0;i++)name=`${branch}-${i}`;
   const from=base&&(await git(['merge-base','--is-ancestor',base,'HEAD'],{allowFailure:true})).code!==0?base:'HEAD';
   if(from!=='HEAD')log(`proposal branch from the approved pin ${base.slice(0,7)} (main does not carry it yet)`);
   return withWorktree(from,true,async wt=>{
    await git(['switch','-c',name],{dir,cwd:wt});
    await writeWindow(wt,manifest,dir,['gen-compose.test.mjs']);
    return {commit:await commit(wt,message,dir),branch:name};
   },dir);
  },
  // The deploy folder of the approved commit, for the VPS (ssamctl.sh and kernel-pair-check.mjs of that commit).
  async archiveDeploy(commit,file){await git(['archive','--format=tar.gz','-o',file,commit,'server/deploy'],{dir:path.dirname(file)});},
  // A pin committed on the proposal branch whose record was lost (a crash between the commit and the record): the commit
  // right after the proposed one, whose versions.json pins that digest for that tag. Else null.
  async pinnedAt(branch,proposed,tag,digest){
   const head=(await git(['rev-parse','--verify',`refs/heads/${branch}`],{allowFailure:true})).stdout.trim();
   if(!head||head===proposed)return null;
   const parent=(await git(['rev-parse','--verify',`${head}^`],{allowFailure:true})).stdout.trim();
   if(parent!==proposed)return null;
   const shown=await git(['show',`${head}:server/deploy/coolify/versions.json`],{allowFailure:true});
   try{const m=JSON.parse(shown.stdout);const entries=['odc','o11'].flatMap(l=>m[l].filter(e=>e.tag===tag));return entries.length===2&&entries.every(e=>e.sha256===digest.replace(/^sha256:/,''))?head:null;}catch{return null;}
  },
  // Stops every command the round started (its time limit).
  stopAll(){stopping=true;for(const child of active)killTree(child);},
  get stopping(){return stopping;},
  async verifyBranch(branch,expected){
   const head=(await git(['rev-parse','--verify',`refs/heads/${branch}`],{allowFailure:true})).stdout.trim();
   if(head!==expected)throw Error(`The proposal branch ${branch} is at ${head||'nothing'}, not the proposed commit ${expected}. Review it before approving.`);
  },
  async verifyLocalImage(built){
   await ensureDocker();
   const r=await docker(['image','inspect','--format','{{json .}}',`${built.image}:${built.tag}`],{allowFailure:true,timeoutMs:60000});
   if(r.code!==0)throw Error(`The tested image ${built.image}:${built.tag} is not in the local Docker any more.`);
   const info=JSON.parse(r.stdout),want='sha256:'+built.sha256;
   if(info.Id!==want&&info.Descriptor?.digest!==want)throw Error(`The local image ${built.tag} is ${info.Descriptor?.digest??info.Id}, not the tested ${want}.`);
  },
  async publish(built){
   if(config.automatic)await runtime.executionSource();
   const env={PATH:path.dirname(exe.docker)+path.delimiter+path.dirname(exe.git)+path.delimiter+process.env.PATH,DOCKER:'docker --context '+context};
   const dir=path.join(out,pairId(built));
   const r=await run(exe.bash,[slash(path.join(root,'server/deploy/publish.sh')),'--source',built.image,'--image',built.image,'--tag',built.tag,'--private-repo-ready'],{dir,env,allowFailure:true,timeoutMs:60*60000});
   const pushed=/publish: the digest to compare on the VPS[^\n]*?(sha256:[a-f0-9]{64})/.exec(r.stdout+r.stderr)?.[1];
   if(r.code===0&&pushed)return {digest:pushed,already:false};
   if(/already exists in the registry/.test(r.stderr)){
    // The registry's digest of that tag, read the way publish.sh reads it (same DOCKER).
    const inspect=await run(exe.bash,['-c','$DOCKER buildx imagetools inspect "$1"','publish',`${built.image}:${built.tag}`],{dir,env,allowFailure:true,timeoutMs:120000});
    const digest=/^Digest:\s*(sha256:[a-f0-9]{64})/m.exec(inspect.stdout)?.[1];
    if(digest)return {digest,already:true};
   }
   throw Error(`publish.sh did not publish ${built.tag} (exit ${r.code}): ${(r.stderr.trim().split('\n').pop()??'').slice(0,300)}. If it asks for a login, run docker login yourself and approve again.`);
  },
  async pin(manifest,branch,dir,message){
   return withWorktree(branch,false,async wt=>{
    await writeWindow(wt,manifest,dir,['gen-compose.test.mjs','initial-window.test.mjs']);
    return {commit:await commit(wt,message,dir)};
   },dir);
  },
  async notify(title,message,{link}={}){
   fs.mkdirSync(out,{recursive:true});fs.appendFileSync(path.join(out,'notifications.jsonl'),JSON.stringify({time:new Date().toISOString(),title,message,link:link??null})+'\n');
   if(config.notify===false)return;
   // Synchronous (a toast returns at once; the balloon fallback takes 16 s): a detached PowerShell without a console
   // never showed the toast.
   try{const r=await ps(path.join(here,'notify.ps1'),['-Title',title,'-Message',message,...(link?['-Link',link]:[]),'-Report'],{allowFailure:true,timeoutMs:60000,evenWhenStopping:true});log(`notice shown: ${(r.stdout.trim()||r.stderr.trim()||'exit '+r.code).split('\n')[0]}`);}catch(e){log(`notice not shown: ${e.message}`);}
  }
 };
 if(config.automatic===true){
  const auto=createAutoRuntime(config,runtime);Object.assign(runtime,auto);
  runtime.executionSource=async()=>{
   if(path.resolve(root,'server/deploy/vigia').toLowerCase()!==here.toLowerCase())throw Error('The watcher code must run from its execution checkout.');
   const branch=await checkWorkspace();
   for(const target of [config.outDir,config.bundleRoot,config.installersDir,config.tempRoot,config.configFile,config.vault]){
    if(!target)throw Error('Automatic private paths must be explicitly configured.');
    await ps(path.join(here,'execution-trust.ps1'),['-PrivatePaths',target]);
   }
   executionSource({workspace:root,branch,head:await runtime.fullHead(),main:(await git(['rev-parse','main'])).stdout.trim(),gitDirectory:fs.statSync(path.join(root,'.git')).isDirectory()});
   await verifyCommit(await runtime.fullHead());
  };
  runtime.verifyPublisher=async file=>JSON.parse((await ps(path.join(here,'verify-publisher.ps1'),['-File',file],{secret:true})).stdout);
  runtime.agentSource=async()=>{
   await runtime.executionSource();const commit=config.agentReleaseCommit,ref=config.agentReleaseRef;
   agentReleasePin(commit,ref);
   if((await git(['merge-base','--is-ancestor',commit,ref],{allowFailure:true})).code!==0)throw Error('Agent commit is outside the approved release line.');
   const target=path.join(temp,'agent-source-'+Date.now());fs.mkdirSync(target,{recursive:true});
   const archive=path.join(target,'source.tar');await git(['archive','-o',archive,commit,'agent']);
   await run(exe.tar,['-xf',archive,'-C',target]);fs.rmSync(archive);return target;
  };
  runtime.pinExecution=async(manifest,dir,id,kernel,liveKernels)=>{
   await runtime.executionSource();
   const kernelsFile=path.join(root,'server/deploy/coolify/r1-kernels.json');
   const previous=Object.values(liveKernels??runtime.liveKernels??JSON.parse(fs.readFileSync(kernelsFile,'utf8')));
   const kernels=Object.fromEntries(manifest.odc.map((entry,i)=>{
    const pair={odc:entry.version,o11:manifest.o11[i].version};
    const value=kernel?.odc===pair.odc&&kernel?.o11===pair.o11?kernel:previous.find(k=>k.odc===pair.odc&&k.o11===pair.o11);
    if(!value)throw Error('The proposed window has no kernel metadata for a retained pair.');
    return ['v'+(i+1),value];
   }));
   const pinBranch=`vigia/pin-${id}-${createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0,12)}`;
   const existing=await git(['rev-parse','--verify','--quiet',pinBranch],{allowFailure:true});
   if(existing.code===0){
    const saved=JSON.parse((await git(['show',`${pinBranch}:server/deploy/coolify/versions.json`])).stdout);
    if(JSON.stringify(saved)!==JSON.stringify(manifest))throw Error('Existing pin identity differs from the verified manifest.');
    return existing.stdout.trim();
   }
   return withWorktree('HEAD',true,async wt=>{
    await git(['switch','-c',pinBranch],{cwd:wt,dir});
    await writeWindow(wt,manifest,dir,['gen-compose.test.mjs']);
    fs.writeFileSync(path.join(wt,'server/deploy/coolify/r1-kernels.json'),JSON.stringify(kernels,null,2)+'\n');
    await git(['add','--','server/deploy/coolify/r1-kernels.json'],{dir,cwd:wt});
    return commit(wt,`fix(vigia): record the verified pin for ${id}\n`,dir);
   },dir);
  };
 }
 return runtime;
}
