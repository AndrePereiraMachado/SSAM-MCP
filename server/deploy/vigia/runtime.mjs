// The real operations of the watcher on the owner's Windows machine: Studio detection, the bundle store, filtered kernel
// tests, the local image, its smoke test, the proposal branch and, on the owner's command, publication and the pin.
// Nothing here touches the VPS, Coolify or GitHub, pushes Git or moves latest.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readTrx,pairTag,pairId,packFor,version as threeOf} from './window.mjs';
import {smokeImage,readListingBudget} from './smoke.mjs';
import {EnvironmentError} from './pipeline.mjs';
import {busyDotnet} from './host.mjs';
import {peFileVersion} from '../kernel-pair-check.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const slash=p=>p.replaceAll('\\','/');
const bashPath=p=>slash(p).replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const DEFAULT_FILTERS={odc:'FullyQualifiedName~ScreenHtmlDataTableOdcTests|FullyQualifiedName~ScreenVisualOdcTests',o11:'FullyQualifiedName~ScreenHtmlDataTableTests|FullyQualifiedName~ScreenVisualCheckTests'};
export const TEST_PROJECT={odc:'server/kernel/tests/Anvil.Tests.Odc',o11:'server/kernel/tests/Anvil.Tests'};
export const STUDIO_PROPERTY={odc:'OdcInstall',o11:'SSDir'};
const RUNTIME_CONFIG={odc:'ODCStudio.runtimeconfig.json',o11:'ServiceStudio.runtimeconfig.json'};
// The .NET a Studio folder runs on, from its main runtimeconfig.json (null when the folder has none).
export function studioTfm(dir,lane){try{return JSON.parse(fs.readFileSync(path.join(dir,RUNTIME_CONFIG[lane]),'utf8')).runtimeOptions?.tfm??null;}catch{return null;}}
export async function createRuntime(config,{log=()=>{}}={}){
 const root=path.resolve(config.workspace),temp=path.resolve(config.tempRoot),out=path.resolve(config.outDir),store=path.resolve(config.bundleRoot);
 if(/^c:[\\/]t(?:[\\/]|$)/i.test(temp))throw Error('tempRoot must be private and outside C:\\t.');
 const exe={git:config.git??'C:/Program Files/Git/cmd/git.exe',powershell:config.powershell??'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',bash:config.bash??'C:/Program Files/Git/bin/bash.exe',dotnet:config.dotnet??'C:/Program Files/dotnet/dotnet.exe',docker:config.docker??'C:/Program Files/Docker/Docker/resources/bin/docker.exe',dockerDesktop:config.dockerDesktop??'C:/Program Files/Docker/Docker/Docker Desktop.exe',tar:config.tar??'C:/Windows/System32/tar.exe',node:process.execPath};
 const context=config.dockerContext??'desktop-linux';if(context!=='desktop-linux')throw Error('Only the local Docker Desktop context is supported.');
 const ps=(file,args,options)=>run(exe.powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],options);
 let sequence=0;
 async function run(command,args,{env={},input,dir,allowFailure=false,secret=false,cwd=root,timeoutMs=0}={}){
  if(dir){fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(path.join(dir,'commands.jsonl'),JSON.stringify({time:new Date().toISOString(),command,args:secret?['(not recorded)']:args,cwd,env:Object.keys(env)})+'\n');}
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(command,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',timer=null;
   if(timeoutMs)timer=setTimeout(()=>{stderr+=`\n(timed out after ${timeoutMs} ms)`;child.kill();},timeoutMs);
   child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});child.stdin.end(input);
  });
  if(dir&&!secret)fs.writeFileSync(path.join(dir,`command-${++sequence}.log`),`> ${path.basename(command)} ${args.join(' ')}\n`+result.stdout+result.stderr);
  if(result.code!==0&&!allowFailure)throw Error(`Command failed (${result.code}): ${path.basename(command)} ${args.slice(0,3).join(' ')}. See ${dir?path.join(dir,'commands.jsonl'):'the run log'}.`);
  return result;
 }
 const docker=(args,options={})=>run(exe.docker,['--context',context,...args],options);
 const git=(args,options={})=>run(exe.git,['-C',options.cwd??root,...args],options);
 const commitAs=['-c','user.name=Andre Machado','-c','user.email=andre_c_machado@hotmail.com'];
 async function checkWorkspace(){
  if(!fs.statSync(path.join(root,'.git')).isFile())throw Error('Use a dedicated Git worktree, not the primary checkout.');
  const branch=(await git(['branch','--show-current'])).stdout.trim();if(!branch||branch==='main'||branch==='master'||branch.startsWith('vigia/'))throw Error('Use the clean integration worktree (not main, not a vigia/ proposal branch).');
  if((await git(['status','--porcelain','--untracked-files=no'])).stdout.trim())throw Error('The worktree has tracked changes. Commit or review them first.');
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
 function verifyBundle(lane,v,file){
  const sha=hash(file);let recorded='';try{recorded=fs.readFileSync(file+'.sha256','utf8').toLowerCase();}catch{throw new EnvironmentError(`The bundle ${file} has no .sha256 beside it.`,'store-incomplete');}
  if(!recorded.includes(sha))throw Error(`The bundle checksum does not match its .sha256: ${file}.`);
  const pin=config.bundlePins?.[`${lane}-${v}`];if(pin&&pin.toLowerCase()!==sha)throw Error(`The bundle ${file} is not the pinned one (bundlePins ${lane}-${v}).`);
  return sha;
 }
 // The frozen copy of a bundle: its files exactly as the image gets them, plus the Studio's runtimeconfig.json (so the
 // build rule sees the Studio's .NET in this folder too).
 // Never renames or deletes a folder it finds: snapshot/ when it holds this build (or does not exist yet), else
 // snapshot-<full version>/.
 async function freeze(folder,file,fullVersion,runtimeFrom,lane,dir){
  const holds=snap=>{try{return /^version (\S+)$/m.exec(fs.readFileSync(path.join(snap,'bundle.txt'),'utf8'))?.[1]===fullVersion;}catch{return false;}};
  const plain=path.join(folder,'snapshot'),own=path.join(folder,`snapshot-${fullVersion}`);
  const snap=holds(plain)?plain:holds(own)?own:fs.existsSync(plain)?own:plain;
  if(!holds(snap)){
   const stage=path.join(folder,`.snapshot-partial-${process.pid}`);fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{recursive:true});
   await run(exe.tar,['-xzf',file,'-C',stage],{dir});
   if(fs.existsSync(snap))throw Error(`${snap} exists but does not hold ${lane} ${fullVersion}; review the bundle store.`);
   fs.renameSync(stage,snap);
  }
  if(runtimeFrom){const name=RUNTIME_CONFIG[lane],source=path.join(runtimeFrom,name);if(fs.existsSync(source))fs.copyFileSync(source,path.join(snap,'files',name));}
  return path.join(snap,'files');
 }
 async function companion(lane,v,dir){
  const folder=storeDir(lane,v),found=bundleFile(folder,lane,v);
  if(!found)throw new EnvironmentError(`No ${lane} ${v} bundle in ${folder}. The store keeps one folder per served version (<lane>-studio-<version>.tar.gz and its .sha256).`,'store-incomplete');
  const sha256=verifyBundle(lane,v,found.file);
  const snapshot=await freeze(folder,found.file,found.fullVersion,null,lane,dir);
  if(threeOf(studioVersionOf(snapshot))!==v)throw Error(`The frozen copy ${snapshot} is not ${lane} ${v}.`);
  const features=lane==='odc'?path.join(folder,'Features.plain.xml'):null;
  if(features&&!fs.existsSync(features))throw new EnvironmentError(`No Features.plain.xml for ODC ${v} in ${folder}.`,'store-incomplete');
  return {lane,version:v,fullVersion:found.fullVersion,file:found.file,sha256,snapshot,features,tfm:studioTfm(snapshot,lane)};
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
 const runtime={
  run,docker,log,checkWorkspace,ensureDocker,waitForDotnet,
  manifest:()=>JSON.parse(fs.readFileSync(path.join(root,'server/deploy/coolify/versions.json'),'utf8')),
  head:async()=>(await git(['rev-parse','--short=7','HEAD'])).stdout.trim(),
  async detect(){
   const result=await ps(path.join(here,'detect-studios.ps1'),['-Odc',config.studios?.odc??'','-O11',config.studios?.o11??'','-Installers',config.installersDir??''],{timeoutMs:120000});
   return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
  },
  // Fast-forward of the integration worktree from the local main, before each round. Anything else stops the round.
  async updateWorkspace(from='main'){
   const branch=await checkWorkspace();
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
   await ensureDocker();
   const builder=config.builder??'ssam-multiver-impl';
   if((await docker(['buildx','inspect',builder],{allowFailure:true,timeoutMs:60000})).code!==0)throw new EnvironmentError(`The buildx builder ${builder} does not exist in Docker Desktop.`,'builder-missing');
  },
  // The target framework MSBuild picks for the test project against that Studio folder (the workspace's build rule),
  // or null when it cannot be evaluated. The watcher compares it with the Studio's own runtime; it never picks one.
  async targetFramework(candidate){
   await waitForDotnet();
   const env={TEMP:temp,TMP:temp,DOTNET_CLI_HOME:path.join(temp,'dotnet-home'),DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1'};
   const r=await run(exe.dotnet,['msbuild',path.join(root,TEST_PROJECT[candidate.lane]),'-nologo','-getProperty:TargetFramework',`-p:${STUDIO_PROPERTY[candidate.lane]}=${candidate.studio}`],{env,allowFailure:true,timeoutMs:300000});
   const value=r.stdout.trim().split(/\r?\n/).pop()?.trim();
   if(r.code!==0||!/^net\d+\.\d+/.test(value??'')){log(`target framework of ${candidate.lane} not evaluated (exit ${r.code})`);return null;}
   return value;
  },
  async bundle(candidate,dir){
   const folder=storeDir(candidate.lane,candidate.version);fs.mkdirSync(folder,{recursive:true});
   let found=bundleFile(folder,candidate.lane,candidate.version,candidate.fullVersion);
   if(found){try{verifyBundle(candidate.lane,candidate.version,found.file);}catch{found=null;}}
   if(!found){
    const privateTemp=path.join(temp,'bundle');fs.mkdirSync(privateTemp,{recursive:true});
    await ps(path.join(root,'server/docker/ssam-server/studio-bundle.ps1'),['-Lane',candidate.lane,'-Studio',candidate.studio,'-OutDir',folder],{dir,env:{TEMP:privateTemp,TMP:privateTemp}});
    found=bundleFile(folder,candidate.lane,candidate.version,candidate.fullVersion);
    if(!found)throw Error(`studio-bundle.ps1 did not write ${candidate.lane}-studio-${candidate.fullVersion}.tar.gz.`);
   }
   const sha256=verifyBundle(candidate.lane,candidate.version,found.file);
   const snapshot=await freeze(folder,found.file,found.fullVersion,candidate.studio,candidate.lane,dir);
   let features=null;
   if(candidate.lane==='odc'){
    // The features of this ODC version, exported once from this machine's ODC Studio cache; an existing file is kept.
    features=path.join(folder,'Features.plain.xml');
    if(!fs.existsSync(features))await ps(path.join(root,'server/deploy/odc-features-export.ps1'),['-Source',config.featuresSource,'-Out',features],{dir});
   }
   return {lane:candidate.lane,version:candidate.version,fullVersion:found.fullVersion,file:found.file,sha256,snapshot,features,tfm:studioTfm(snapshot,candidate.lane)??candidate.tfm??null};
  },
  companion:(lane,v)=>companion(lane,v),
  async test(lane,kind,side,dir){
   const filter=config.filters?.[lane]??DEFAULT_FILTERS[lane];
   if(!/^FullyQualifiedName~[A-Za-z0-9_.]+(?:\|FullyQualifiedName~[A-Za-z0-9_.]+)*$/.test(filter))throw Error('Use an explicit finite class filter; the full kernel suite is forbidden.');
   const resultDir=path.join(dir,`${lane}-${kind}`),privateTemp=path.join(temp,path.basename(dir),`${lane}-${kind}`);
   fs.rmSync(privateTemp,{recursive:true,force:true});fs.mkdirSync(privateTemp,{recursive:true});
   let featuresDir=null;
   if(lane==='odc'&&side.odc.features){
    featuresDir=path.join(privateTemp,'features');
    await ps(path.join(here,'features-protect.ps1'),['-Plain',side.odc.features,'-OutDir',featuresDir],{dir});
   }
   await waitForDotnet(dir);
   const env={TEMP:privateTemp,TMP:privateTemp,DOTNET_CLI_HOME:path.join(temp,'dotnet-home'),DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1',SSAM_MODULE_INDEX_ROOT:path.join(privateTemp,'index'),ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1',SSAM_NO_WARM:'1',ANVIL_STUDIO_DIR:side.o11.snapshot,ANVIL_ODC_STUDIO_DIR:side.odc.snapshot,...(featuresDir?{ANVIL_ODC_FEATURES_DIR:featuresDir}:{})};
   fs.rmSync(path.join(resultDir,'results.trx'),{force:true});
   const result=await run(exe.dotnet,['test',path.join(root,TEST_PROJECT[lane]),'-c','Release','--filter',filter,'--logger','trx;LogFileName=results.trx','--results-directory',resultDir,'-nodeReuse:false',`-p:${STUDIO_PROPERTY[lane]}=${side[lane].snapshot}`],{dir,env,allowFailure:true,timeoutMs:(config.testTimeoutMinutes??90)*60000});
   const report=path.join(resultDir,'results.trx');if(!fs.existsSync(report))throw Object.assign(Error(`No test results from the ${lane} ${kind} run (exit ${result.code}): the test project did not build or run against ${side[lane].snapshot}. See ${path.join(dir,'commands.jsonl')}.`),{lanes:[lane]});
   return readTrx(fs.readFileSync(report,'utf8'));
  },
  async build(pair,bundles,dir){
   await checkWorkspace();
   const commitShort=(await git(['rev-parse','--short=7','HEAD'])).stdout.trim(),revision=(await git(['rev-parse','HEAD'])).stdout.trim();
   const tag=pairTag(pair,commitShort,new Date().toISOString().slice(0,10).replaceAll('-',''));
   const installers=path.join(temp,'installers',pairId(pair));fs.rmSync(installers,{recursive:true,force:true});fs.mkdirSync(installers,{recursive:true});
   try{
    for(const b of Object.values(bundles)){const to=path.join(installers,path.basename(b.file));try{fs.linkSync(b.file,to);}catch{fs.copyFileSync(b.file,to);}}
    const metadata=path.join(dir,'image-metadata.json'),image=config.image??'docker.io/andrepereiramachado/ssam-server';
    const env={TEMP:temp,TMP:temp,PATH:path.dirname(exe.docker)+path.delimiter+path.dirname(exe.git)+path.delimiter+process.env.PATH,DOCKER:'docker --context '+context,BUILDX_BUILDER:config.builder??'ssam-multiver-impl',STUDIO_INSTALLERS_DIR:bashPath(installers),SSAM_BUILD_METADATA_FILE:slash(metadata),SERVICE_STUDIO_BUNDLE:path.basename(bundles.o11.file),SERVICE_STUDIO_BUNDLE_SHA256:bundles.o11.sha256,ODC_STUDIO_BUNDLE:path.basename(bundles.odc.file),ODC_STUDIO_BUNDLE_SHA256:bundles.odc.sha256,SSAM_IMAGE_O11:bundles.o11.version,SSAM_IMAGE_ODC:bundles.odc.version};
    await run(exe.bash,[slash(path.join(root,'server/deploy/build.sh')),'--image',image,'--tag',tag,'--','--progress','plain'],{dir,env,timeoutMs:(config.buildTimeoutMinutes??120)*60000});
    const sha256=JSON.parse(fs.readFileSync(metadata,'utf8'))['containerimage.digest'].replace(/^sha256:/,'');
    return {odc:bundles.odc.version,o11:bundles.o11.version,image,tag,sha256,revision:commitShort,commit:revision};
   }finally{fs.rmSync(installers,{recursive:true,force:true});}
  },
  async smoke(built,bundles,served,dir){
   return smokeImage({pair:built,bundle:{features:bundles.odc.features},dir,root,docker,served,pack:packFor(config,bundles),budget:readListingBudget(root)});
  },
  async propose(manifest,branch,dir,message){
   await checkWorkspace();
   let name=branch;for(let i=2;(await git(['rev-parse','--verify','--quiet','refs/heads/'+name],{allowFailure:true})).code===0;i++)name=`${branch}-${i}`;
   return withWorktree('HEAD',true,async wt=>{
    await git(['switch','-c',name],{dir,cwd:wt});
    await writeWindow(wt,manifest,dir,['gen-compose.test.mjs']);
    return {commit:await commit(wt,message,dir),branch:name};
   },dir);
  },
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
   const env={PATH:path.dirname(exe.docker)+path.delimiter+path.dirname(exe.git)+path.delimiter+process.env.PATH,DOCKER:'docker --context '+context};
   const dir=path.join(out,pairId(built));
   const r=await run(exe.bash,[slash(path.join(root,'server/deploy/publish.sh')),'--source',built.image,'--image',built.image,'--tag',built.tag,'--private-repo-ready'],{dir,env,allowFailure:true,timeoutMs:60*60000});
   const pushed=/publish: the digest to compare on the VPS[^\n]*?(sha256:[a-f0-9]{64})/.exec(r.stdout+r.stderr)?.[1];
   if(r.code===0&&pushed)return {digest:pushed,already:false};
   if(/already exists in the registry/.test(r.stderr)){
    const inspect=await docker(['buildx','imagetools','inspect',`${built.image}:${built.tag}`],{allowFailure:true,timeoutMs:120000});
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
   try{spawn(exe.powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',path.join(here,'notify.ps1'),'-Title',title,'-Message',message,...(link?['-Link',link]:[])],{detached:true,stdio:'ignore',windowsHide:true}).unref();}catch{}
  }
 };
 return runtime;
}
