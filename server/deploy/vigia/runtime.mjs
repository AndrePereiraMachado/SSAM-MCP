import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readTrx,rotateWindow} from './window.mjs';
import {smokeImage} from './smoke.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const slash=p=>p.replaceAll('\\','/');
const bashPath=p=>slash(p).replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const DEFAULT_FILTERS={odc:'FullyQualifiedName~ScreenHtmlDataTableOdcTests|FullyQualifiedName~ScreenVisualOdcTests',o11:'FullyQualifiedName~ScreenHtmlDataTableTests|FullyQualifiedName~ScreenVisualCheckTests'};
export async function createRuntime(config){
 const root=path.resolve(config.workspace),temp=path.resolve(config.tempRoot),out=path.resolve(config.outDir);
 if(/^c:[\\/]t(?:[\\/]|$)/i.test(temp))throw Error('tempRoot must be private and outside C:\\t.');
 const exe={git:config.git??'C:/Program Files/Git/cmd/git.exe',powershell:config.powershell??'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',bash:config.bash??'C:/Program Files/Git/bin/bash.exe',dotnet:config.dotnet??'C:/Program Files/dotnet/dotnet.exe',docker:config.docker??'C:/Program Files/Docker/Docker/resources/bin/docker.exe'};
 const context=config.dockerContext??'desktop-linux';if(context!=='desktop-linux')throw Error('Only the local Docker Desktop context is supported.');
 let sequence=0;
 async function run(command,args,{env={},input,dir,allowFailure=false,secret=false}={}){
  if(dir){fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(path.join(dir,'commands.jsonl'),JSON.stringify({command,args,cwd:root,env})+'\n');}
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(command,args,{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
   child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input);
  });
  if(dir&&!secret)fs.writeFileSync(path.join(dir,`command-${++sequence}.log`),result.stdout+result.stderr);
  if(result.code!==0&&!allowFailure)throw Error(`Command failed (${result.code}): ${path.basename(command)}. See commands.jsonl and its log.`);
  return result;
 }
 const docker=(args,options={})=>run(exe.docker,['--context',context,...args],options);
 const git=(args,options={})=>run(exe.git,['-C',root,...args],options);
 async function checkWorkspace(){
  if(!fs.statSync(path.join(root,'.git')).isFile())throw Error('Use a dedicated Git worktree, not the primary checkout.');
  const branch=(await git(['branch','--show-current'])).stdout.trim();if(!branch||branch==='main'||branch==='master'||branch.startsWith('vigia/'))throw Error('Use the clean integration worktree; an existing proposal needs owner review.');
  if((await git(['status','--porcelain','--untracked-files=no'])).stdout.trim())throw Error('The worktree has tracked changes. Commit or review them first.');
 }
 const runtime={
  run,docker,
  async detect(){
   const result=await run(exe.powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(here,'detect-studios.ps1'),'-Odc',config.studios.odc??'','-O11',config.studios.o11??'','-Installers',config.installersDir??'']);
   return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
  },
  checkWorkspace,
  async bundle(candidate,dir){
   const manifest=JSON.parse(fs.readFileSync(path.join(root,'server/deploy/coolify/versions.json'),'utf8'));
   const other=candidate.lane==='odc'?'o11':'odc';
   if(config.bundles?.[other]?.version!==manifest[other][0].version)throw Error('Companion bundle must match the current default window.');
   fs.mkdirSync(temp,{recursive:true});
   const folder=path.join(config.bundleRoot,`${candidate.lane}-${candidate.version}`);
   await run(exe.powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'server/docker/ssam-server/studio-bundle.ps1'),'-Lane',candidate.lane,'-Studio',candidate.studio,'-OutDir',folder],{dir,env:{TEMP:temp,TMP:temp}});
   const file=path.join(folder,`${candidate.lane}-studio-${candidate.fullVersion}.tar.gz`),sha256=hash(file);
   if(!fs.readFileSync(file+'.sha256','utf8').toLowerCase().includes(sha256))throw Error('The new bundle checksum does not match.');
   const files=structuredClone(config.bundles);files[candidate.lane]={file,sha256,version:candidate.version};
   for(const lane of ['odc','o11'])if(hash(files[lane].file)!==files[lane].sha256.toLowerCase())throw Error('Companion bundle checksum does not match: '+lane);
   let features=config.featuresFile;
   if(candidate.lane==='odc'){
    features=path.join(folder,'Features.plain.xml');await run(exe.powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'server/deploy/odc-features-export.ps1'),'-Source',config.featuresSource,'-Out',features],{dir});
   }
   fs.copyFileSync(features,path.join(dir,'Features.plain.xml'));
   const currentFeatures=path.join(temp,`${candidate.lane}-${candidate.version}`,'features');fs.mkdirSync(currentFeatures,{recursive:true});
   if(config.featuresSource)fs.copyFileSync(config.featuresSource,path.join(currentFeatures,'Features.xml'));
   const bundle={files,features,featuresSha256:hash(features),testFeatures:currentFeatures,odc:files.odc.version,o11:files.o11.version};
   fs.writeFileSync(path.join(dir,'bundles.json'),JSON.stringify(bundle,null,2));return bundle;
  },
  async test(candidate,kind,bundle,dir){
   const studio=kind==='baseline'?config.previousStudios?.[candidate.lane]:candidate.studio;if(!studio)throw Error('A frozen previous Studio is required for comparison.');
   if(kind==='baseline'){
    const current=JSON.parse(fs.readFileSync(path.join(root,'server/deploy/coolify/versions.json'),'utf8'));
    const found=await run(exe.powershell,['-NoProfile','-File',path.join(here,'detect-studios.ps1'),candidate.lane==='odc'?'-Odc':'-O11',studio]);
    if(!JSON.parse(found.stdout.replace(/^\uFEFF/,'')).some(x=>x.lane===candidate.lane&&x.version===current[candidate.lane][0].version))throw Error('Frozen baseline must match the current default window.');
   }
   const filter=config.filters?.[candidate.lane]??DEFAULT_FILTERS[candidate.lane];
   if(!/^FullyQualifiedName~[A-Za-z0-9_.]+(?:\|FullyQualifiedName~[A-Za-z0-9_.]+)*$/.test(filter))throw Error('Use an explicit finite class filter; the full kernel suite is forbidden.');
   const resultDir=path.join(dir,kind),privateTemp=path.join(temp,candidate.lane+'-'+candidate.version,kind);fs.mkdirSync(privateTemp,{recursive:true});
   const env={TEMP:privateTemp,TMP:privateTemp,DOTNET_CLI_HOME:path.join(temp,'dotnet-home'),SSAM_MODULE_INDEX_ROOT:path.join(privateTemp,'index'),ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1',SSAM_NO_WARM:'1',ANVIL_STUDIO_DIR:candidate.lane==='o11'?studio:config.studios.o11,ANVIL_ODC_STUDIO_DIR:candidate.lane==='odc'?studio:config.studios.odc,ANVIL_ODC_FEATURES_DIR:kind==='baseline'?config.previousFeaturesDir:bundle.testFeatures};
   const project=path.join(root,'server/kernel/tests',candidate.lane==='odc'?'Anvil.Tests.Odc':'Anvil.Tests');
   fs.rmSync(path.join(resultDir,'results.trx'),{force:true});
   const result=await run(exe.dotnet,['test',project,'-c','Release','--filter',filter,'--logger','trx;LogFileName=results.trx','--results-directory',resultDir,'-nodeReuse:false',`-p:${candidate.lane==='odc'?'OdcInstall':'SSDir'}=${studio}`],{dir,env,allowFailure:true});
   const report=path.join(resultDir,'results.trx');if(!fs.existsSync(report))throw Error(`No TRX from ${kind} (exit ${result.code}).`);
   return readTrx(fs.readFileSync(report,'utf8'));
  },
  async build(candidate,bundle,dir){
   await checkWorkspace();const commit=(await git(['rev-parse','--short','HEAD'])).stdout.trim();
   const tag=`prod-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${commit}-${candidate.lane}${candidate.version.replaceAll('.','')}`;
   const installers=path.join(dir,'installers');fs.mkdirSync(installers,{recursive:true});for(const file of Object.values(bundle.files))fs.copyFileSync(file.file,path.join(installers,path.basename(file.file)));
   const metadata=path.join(dir,'image-metadata.json');
   const env={TEMP:temp,TMP:temp,PATH:path.dirname(exe.docker)+path.delimiter+path.dirname(exe.git)+path.delimiter+process.env.PATH,DOCKER:'docker --context '+context,BUILDX_BUILDER:config.builder??'ssam-multiver-impl',STUDIO_INSTALLERS_DIR:bashPath(installers),SSAM_BUILD_METADATA_FILE:slash(metadata),SERVICE_STUDIO_BUNDLE:path.basename(bundle.files.o11.file),SERVICE_STUDIO_BUNDLE_SHA256:bundle.files.o11.sha256,ODC_STUDIO_BUNDLE:path.basename(bundle.files.odc.file),ODC_STUDIO_BUNDLE_SHA256:bundle.files.odc.sha256,SSAM_IMAGE_O11:bundle.o11,SSAM_IMAGE_ODC:bundle.odc};
   const image=config.image??'docker.io/andrepereiramachado/ssam-server';
   await run(exe.bash,[slash(path.join(root,'server/deploy/build.sh')),'--image',image,'--tag',tag,'--','--progress','plain'],{dir,env});
   const sha256=JSON.parse(fs.readFileSync(metadata,'utf8'))['containerimage.digest'].replace(/^sha256:/,'');
   const pair={odc:bundle.odc,o11:bundle.o11,image,tag,sha256,revision:commit};fs.writeFileSync(path.join(dir,'image.json'),JSON.stringify(pair,null,2));return pair;
  },
  async smoke(pair,bundle,dir){const current=JSON.parse(fs.readFileSync(path.join(root,'server/deploy/coolify/versions.json'),'utf8'));const next=rotateWindow(current,pair).manifest;const served=Object.fromEntries(['odc','o11'].map(lane=>[lane,[...new Set(next[lane].map(x=>x.version))]]));return smokeImage({pair,bundle,dir,root,docker,served,pack:config.agentPack});},
  async propose(next,branch,dir){
   await checkWorkspace();await git(['switch','-c',branch],{dir});
   for(const [from,to]of [['proposed-window.json','versions.json'],['compose.coolify.yml','compose.coolify.yml']])fs.copyFileSync(path.join(dir,from),path.join(root,'server/deploy/coolify',to));
   await git(['add','--','server/deploy/coolify/versions.json','server/deploy/coolify/compose.coolify.yml'],{dir});
   const message=path.join(dir,'commit.txt');fs.writeFileSync(message,`build(deploy): propose ${branch.slice(6)} Studio window\n\nLocal image and filtered tests passed. Owner publication and deployment approval are required.\n`);
   await git(['-c','user.name=Andre Machado','-c','user.email=andre_c_machado@hotmail.com','commit','-F',message],{dir});
  },
  async notify(title,message){
   fs.mkdirSync(out,{recursive:true});fs.appendFileSync(path.join(out,'notifications.jsonl'),JSON.stringify({time:new Date().toISOString(),title,message})+'\n');
   if(config.notify===false)return;
   try{spawn(exe.powershell,['-NoProfile','-WindowStyle','Hidden','-File',path.join(here,'notify.ps1'),'-Title',title,'-Message',message],{detached:true,stdio:'ignore',windowsHide:true}).unref();}catch{}
  }
 };
 return runtime;
}
