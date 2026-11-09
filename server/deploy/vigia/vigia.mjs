// The Studio versions watcher (README.md). Modes:
//   (default)     an unattended round: lock, log, fast-forward of the watcher worktree from the local main, then the round
//                 itself in a child process running the code just fetched (so a fix in main applies at once);
//   --dry-run     reads the versions and prints what a round would do; writes nothing;
//   --approve <id|lane-version>, --reject <id> --reason <text>, --retry <id>: the owner's commands;
//   --seed-features <Features.plain.xml>: the owner's one-time seed of an exact ODC features export (features-carry.mjs);
//   --pin <X.Y.Z.B>, --redecide <X.Y.Z>, --skip <X.Y.Z>: the owner's choice of an ODC Studio build, a new decision, or going
//                 on without a version (sources.mjs); --skip refuses a version no round has read from the release notes
//                 unless --force;
//   --rehearse-current: the real round on the served versions, stopped before anything changes outside this machine (rehearse.mjs).
import fs from 'node:fs';
import {readJournal} from './journal.mjs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runVigia,readAttempts,remind,timedOut} from './pipeline.mjs';
import {replayApprovals} from './window.mjs';
import {approve,reject,retry} from './approve.mjs';
import {acquireLock,lockHeldBy,registerChild,runLogFile,createLog} from './host.mjs';
import {automaticPlan,releaseAutomatically,releaseEvent} from './automatic.mjs';
import {bridgeMode} from './server-only.mjs';
import {rehearseCurrent,rehearsalConfig} from './rehearse.mjs';
export * from './window.mjs';
export * from './pipeline.mjs';
export * from './approve.mjs';
export * from './host.mjs';
// A worktree whose vigia.mjs declares this protocol runs the round as a child (--round); an older one does not.
export const ROUND_PROTOCOL=2;
// A worktree whose vigia.mjs declares this one understands --rehearse-current; an older one is never asked to run it.
export const REHEARSE_PROTOCOL=1;
const self=fileURLToPath(import.meta.url);
export function parseArgs(argv){
 const args={flags:new Set()};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(['--config','--approve','--reject','--reason','--retry','--log','--acknowledge-rollback','--seed-features','--pin','--redecide','--skip'].includes(a)){if(argv[i+1]===undefined)throw Error(`${a} needs a value.`);if(args[a.slice(2)]!==undefined)throw Error(`${a} is given twice.`);args[a.slice(2)]=argv[++i];}
  else if(['--dry-run','--round','--no-update','--rehearse-current','--force'].includes(a))args.flags.add(a.slice(2));
  else throw Error(`Unknown argument ${a}. Usage: vigia.mjs --config <file> [--dry-run | --approve <id> | --reject <id> --reason <text> | --retry <id> | --seed-features <Features.plain.xml> | --pin <X.Y.Z.B> | --redecide <X.Y.Z> | --skip <X.Y.Z> [--force]] [--no-update]`);
 }
 // --force only lets -Skip record a version no round has read from the release notes.
 if(args.flags.has('force')&&args.skip===undefined)throw Error('--force goes only with --skip.');
 // One owner command per run: a second one would be dropped unseen (owner() runs only the first it finds).
 const commands=['approve','reject','retry','seed-features','pin','redecide','skip'].filter(k=>args[k]!==undefined);
 if(commands.length>1)throw Error(`--${commands.join(' and --')} cannot be combined: run one owner command at a time.`);
 for(const round of ['dry-run','round'])if(commands.length&&args.flags.has(round))throw Error(`--${commands[0]} cannot be combined with --${round}: an owner command is not a round.`);
 if(commands.length&&args['acknowledge-rollback']!==undefined)throw Error(`--${commands[0]} cannot be combined with --acknowledge-rollback: that one belongs to a round.`);
 if(args.flags.has('rehearse-current')&&(args.flags.has('dry-run')||args.approve||args.reject||args.retry||args['acknowledge-rollback']||args['seed-features']||args.pin||args.redecide||args.skip))throw Error('--rehearse-current runs alone.');
 if(!args.config)throw Error('Usage: vigia.mjs --config <file> [--dry-run | --approve <id> | --reject <id> --reason <text> | --retry <id> | --seed-features <Features.plain.xml> | --pin <X.Y.Z.B> | --redecide <X.Y.Z> | --skip <X.Y.Z> [--force]]');
 return args;
}
export function readConfig(file){
 const config=JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));
 config.automatic=config.automatic!==false;
 if(config.automatic)config.updateFrom='main';
 config.outDir=path.resolve(config.outDir??path.dirname(path.resolve(file)));config.configFile=path.resolve(file);
 for(const key of ['workspace','tempRoot','bundleRoot'])if(!config[key])throw Error(`The watcher configuration needs ${key}.`);
 bridgeMode(config);
 return config;
}
// The window the next proposal starts from: main's versions.json plus the approvals main does not carry yet.
export function baseWindow(mainManifest,outDir){
 const attempts=Object.values(readAttempts(outDir));
 // An automatic pin precedes deployment. If deployment failed, that local pin
 // is evidence, not the served baseline; plan from its recorded previous window.
 const failed=attempts.filter(a=>a.status==='failed'&&a.baseManifest&&a.built?.tag&&mainManifest.odc.some(e=>e.tag===a.built.tag)).sort((a,b)=>String(b.at).localeCompare(String(a.at)))[0];
 const approved=attempts.filter(a=>a.status==='approved');
 const r=replayApprovals(failed?.baseManifest??mainManifest,approved);
 // The next proposal branch starts from the newest approved pin main lacks, so merging it brings both without a conflict.
 const last=approved.filter(a=>r.replayed.includes(a.id)).sort((x,y)=>String(x.approved?.at).localeCompare(String(y.approved?.at))).at(-1);
 return {...r,branchBase:last?.pinCommit??last?.approved?.commit??null};
}
export async function round(config,runtime,{dryRun=false}={}){
 if(config.automatic&&!dryRun){
  await runtime.executionSource();const secrets=await runtime.secrets();
  // The owner's acceptUnsignedMain is a standing risk: every round says so on every channel (toast, webhook, VPS journal).
  if(config.acceptUnsignedMain===true&&!config.ownerSigningPublicKey)await runtime.event('unsigned-main',{id:'main',attempt:new Date().toISOString(),message:'This round runs main without owner commit-signature verification (acceptUnsignedMain is true). Configure ownerSigningPublicKey to close this risk.'},secrets).catch(()=>{});
  await runtime.cleanupSsh();await runtime.pause();
 }
 // A process interrupted after publication resumes its journal before any new build.
 if(config.automatic&&!dryRun)for(const a of Object.values(readAttempts(config.outDir))){
  const file=path.join(config.outDir,a.id,'release.json'),journal=path.join(config.outDir,a.id,'deployment.json');
  if(!fs.existsSync(file)||!fs.existsSync(journal))continue;
  const state=readJournal(journal);
  const release=readJournal(file);
  if(a.retry&&state.status!=='rollback-failed')continue;
  if(a.retry&&state.status==='rollback-failed'&&a.acknowledgeRollback===a.id)continue;
  if(state.status==='rollback-failed'){
   await releaseEvent(config.outDir,runtime,'rollback-failed',a.id,'Rollback still requires owner attention.',await runtime.secrets(),a.at);
   return {status:'rollback-failed',id:a.id,code:'rollback-needs-attention'};
  }
  if(state.status==='live'&&a.status!=='approved'){
   const {writeAttempt}=await import('./pipeline.mjs');
   writeAttempt(config.outDir,{...a,status:'approved',built:release.built,pinCommit:state.pin,approved:{at:new Date().toISOString(),digest:'sha256:'+release.built.sha256,commit:state.pin}});
  }
  if(['rolled-back','preparation-failed'].includes(state.status)&&a.status==='running'){
   const {writeAttempt}=await import('./pipeline.mjs');writeAttempt(config.outDir,{...a,status:'failed',built:release.built,rollbackLatch:state.status==='rolled-back',failedLanes:a.pair.lanes,code:state.status});
  }
  if(['idle','abandoned'].includes(state.status)){const {writeAttempt}=await import('./pipeline.mjs');writeAttempt(config.outDir,{...a,status:'closed',code:state.status,cause:state.abandoned?.code??null});continue;}
  if(!['live','idle','abandoned','rolled-back','rollback-failed','preparation-failed'].includes(state.status)){
   const result=await releaseAutomatically(config,runtime,release);
   if(result.status==='live'){
    const {writeAttempt}=await import('./pipeline.mjs');
    writeAttempt(config.outDir,{...a,status:'approved',built:release.built,pinCommit:result.commit,approved:{at:new Date().toISOString(),digest:'sha256:'+release.built.sha256,commit:result.commit}});
   }
   if(['idle','abandoned'].includes(result.status)){const {writeAttempt}=await import('./pipeline.mjs');writeAttempt(config.outDir,{...a,status:'closed',code:result.status,cause:result.status==='abandoned'?result.code??null:null});continue;}
   return result;
  }
 }
 const live=config.automatic&&!dryRun?await runtime.liveBaseline(await runtime.secrets()):null;
 const {manifest,replayed,branchBase}=live?{manifest:live.manifest,replayed:[],branchBase:null}:baseWindow(runtime.manifest(),config.outDir);
 const local=await runtime.detect();
 const observed=config.automatic?await runtime.observe(local,{dryRun,manifest}):local;
 let state=live?.telemetry??{};if(!live&&config.versionStateFile&&fs.existsSync(config.versionStateFile))state=JSON.parse(fs.readFileSync(config.versionStateFile,'utf8'));
 const head=await runtime.head();
 runtime.log?.(`workspace ${head}; observed ${observed.map(o=>`${o.lane} ${o.fullVersion}${o.tfm?' '+o.tfm:''}${o.requiresInstallation?' (installer)':''}`).join(', ')||'nothing'}${replayed.length?`; approved, not in main: ${replayed.join(', ')}`:''}`);
 const result=await runVigia({...config,manifest,liveBaseline:live,replayed,branchBase,state,observed,head,dryRun},runtime);
 return dryRun&&config.automatic?{...result,sources:runtime.sourceStatus,bridgeMode:bridgeMode(config),automaticPlan:automaticPlan(bridgeMode(config))}:result;
}
async function childSupportsRehearsal(file){try{return fs.readFileSync(file,'utf8').includes('REHEARSE_PROTOCOL=1');}catch{return false;}}
async function childSupportsRounds(file){try{return fs.readFileSync(file,'utf8').includes('ROUND_PROTOCOL=2');}catch{return false;}}
async function launch(args,config,log){
 const {createRuntime}=await import('./runtime.mjs');
 const runtime=await createRuntime(config,{log});
 const rehearsing=args.flags.has('rehearse-current');
 // PAUSE refuses a rehearsal before anything is fetched or built.
 if(rehearsing)runtime.pause();
 const lock=acquireLock(path.join(config.outDir,'vigia.lock'));
 if(lock.busy){
  log(`another round holds the lock (pid ${lock.busy.pid??'?'}${lock.busy.child?', round pid '+lock.busy.child.pid:''} since ${lock.busy.at??'?'}); nothing to do`);
  const held=(Date.now()-Date.parse(lock.busy.at))/3600000;
  if(held>=(config.busyNoticeHours??10))await remind(config.outDir,'busy','SSAM watcher round still running',`A watcher round has held the lock for ${Math.floor(held)} h (pid ${lock.busy.pid}${lock.busy.child?', round pid '+lock.busy.child.pid:''}). See the newest log in ${path.join(config.outDir,'runs')}.`,{...runtime,log});
  return {status:'busy'};
 }
 try{
  if(!args.flags.has('no-update')){
   try{const u=await runtime.updateWorkspace(config.updateFrom??'main');log(u.updated?`workspace fast-forwarded ${u.from.slice(0,7)} -> ${u.head.slice(0,7)} from ${config.updateFrom??'main'}`:`workspace up to date at ${u.head.slice(0,7)}`);}
   catch(error){log(`workspace update stopped: ${error.message}`);await remind(config.outDir,'workspace','SSAM watcher stopped',error.message,{...runtime,log});return {status:'workspace-stopped',error:error.message};}
  }
  const child=path.join(path.resolve(config.workspace),'server/deploy/vigia/vigia.mjs');
  if(rehearsing&&!await childSupportsRehearsal(child))throw Error('The watcher worktree does not know -RehearseCurrent yet: nothing was run.');
  if(await childSupportsRounds(child)){
   let stderr='';const before=fs.statSync(log.file).size;
   const code=await new Promise((resolve,reject_)=>{const p=spawn(process.execPath,[child,'--config',args.config,'--round','--log',log.file,...(rehearsing?['--rehearse-current']:[])],{env:{...process.env,SSAM_VIGIA_LOCK:lock.token},stdio:['ignore','inherit','pipe'],windowsHide:true});try{registerChild(path.join(config.outDir,'vigia.lock'),lock.token,p.pid);}catch(e){log(`round process not registered in the lock: ${e.message}`);}p.stderr.on('data',b=>{stderr+=b;process.stderr.write(b);});p.once('error',reject_);p.once('close',resolve);});
   // A round that could not even start (the code fetched from main does not load) still leaves a trace and a notice: the
   // child always ends its log with "round <status>" or "round error: ...".
   const tail=fs.readFileSync(log.file,'utf8').slice(before);
   if(!/^\S+ round (\w|error:)/m.test(tail)){const first=stderr.trim().split('\n').find(Boolean)??'no output';log(`round process exited ${code} without finishing its round: ${stderr.trim().slice(-2000)}`);await remind(config.outDir,'round-exit','SSAM watcher round did not run',`The round process exited ${code}: ${first.slice(0,160)} (log ${log.file})`,{...runtime,log});}
   return {status:'round-finished',code};
  }
  log('the workspace has an older watcher; this round runs the launcher code');
  return await round(config,runtime);
 }finally{lock.release();}
}
// The launcher's gate before any release write (the vault and the deployment configuration are read, nothing is written).
// {startup} when ready; else {startup, code, message} for the console and the Windows notice. A refusal of the bridge trust-key
// pin (F1 review round 3, M-3) keeps its code and its message (they carry fingerprint prefixes only, never a secret), so the
// owner fixes the pin instead of auditing a vault that is right; any other failure stays the generic message.
export const STARTUP_CODES=Object.freeze(['BRIDGE_TRUST_KEY_UNPINNED','BRIDGE_TRUST_KEY_MISMATCH']);
export async function startupGate(config,createRuntime){
 let startup;
 try{startup=await createRuntime(config);await startup.secrets();return {startup};}
 catch(error){
  const code=STARTUP_CODES.includes(error?.code)?error.code:null;
  return {startup,code,message:code?`${code}: ${String(error.message).split('\n')[0].slice(0,600)} No release writes were started.`:'Required secrets or deployment configuration are missing. No release writes were started.'};
 }
}
// --dry-run in ed25519-offers: the pin's format (64 hex, either case), without the vault. null when fine or another mode.
export async function dryRunPinProblem(config){
 if(!config.automatic||bridgeMode(config)!=='ed25519-offers')return null;
 const {trustPin}=await import('./auto-runtime.mjs');
 try{trustPin(config);return null;}catch(error){return `${error.code}: ${error.message}`;}
}
async function owner(args,config,log){
 const lock=acquireLock(path.join(config.outDir,'vigia.lock'));
 if(lock.busy)throw Error(`A watcher round is running (pid ${lock.busy.pid??'?'} since ${lock.busy.at??'?'}). Try again when it ends.`);
 try{
  if(args.reject)return reject(config,args.reject,args.reason);
  if(args.retry)return retry(config,args.retry);
  // The ODC build decisions (studio-sources.json), written back as the same signed journal; -Pin reads releaseshub once.
  if(args.pin||args.redecide||args.skip){const {pinStudioBuild,redecideStudio,skipStudio}=await import('./auto-runtime.mjs');return args.pin?await pinStudioBuild(config,args.pin):args.skip?skipStudio(config,args.skip,{force:args.flags.has('force')}):redecideStudio(config,args.redecide);}
  const {createRuntime}=await import('./runtime.mjs');
  // Only the version, the feature count and the sha256 are printed or logged, never a feature.
  if(args['seed-features']){const r=(await createRuntime(config,{log})).seedFeatures(args['seed-features']);return {status:'seeded',version:r.version,count:r.count,sha256:r.sha256,note:`ODC features ${r.version} ${r.already?"already stored":"seeded"}: ${r.count} features, sha256 ${r.sha256}.`};}
  return await approve(config,await createRuntime(config,{log}),args.approve);
 }finally{lock.release();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===self){
 const args=parseArgs(process.argv.slice(2));
 const config=readConfig(args.config);config.acknowledgeRollback=args['acknowledge-rollback'];
 if(config.automatic&&!args.flags.has('dry-run')){
  const {createRuntime}=await import('./runtime.mjs');
  const {startup,message}=await startupGate(config,createRuntime);
  if(message){
   console.error('SSAM watcher deferred: '+message);
   // No journal/directory is written before this gate; the only side effect is
   // a generic Windows notification so a scheduled, hidden task is observable.
   if(config.notify!==false&&startup)await startup.run(config.powershell??'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',[
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(path.dirname(self),'notify.ps1'),'-Title','SSAM watcher deferred','-Message',message
   ],{secret:true,allowFailure:true,timeoutMs:60000}).catch(()=>{});
   process.exit(2);
  }
 }
 if(args.flags.has('dry-run')){
  // Round 3 M-3: the dry-run of the activation checks the trust-key pin's format too (no vault is read).
  const problem=await dryRunPinProblem(config);
  if(problem){console.error('SSAM watcher dry-run stopped: '+problem);process.exit(2);}
  const {createRuntime}=await import('./runtime.mjs');
  console.log(JSON.stringify(await round(config,await createRuntime({...config,dryRun:true}),{dryRun:true}),null,2));
 }else if(args.flags.has('round')){
  const log=createLog(args.log);
  if(!lockHeldBy(path.join(config.outDir,'vigia.lock'),process.env.SSAM_VIGIA_LOCK))throw Error('--round runs only under the launcher that holds the watcher lock.');
  const {createRuntime,createBelowChecked}=await import('./runtime.mjs');
  const rehearsing=args.flags.has('rehearse-current');
  // The round's own folder for a rehearsal, below the private outDir the startup gate has just checked.
  const rehearsal=rehearsing?rehearsalConfig(config):null;
  if(rehearsal)createBelowChecked(rehearsal.outDir,[config.outDir]);
  const runtime=await createRuntime({...(rehearsal??config),roundDeadline:Date.now()+(config.roundHours??7)*3600000},{log});
  // A round ends before the scheduled task's time limit (8 h): at roundHours it stops its commands, records the running
  // attempt as deferred (round-timeout) and says so, instead of being killed half-way.
  const deadline=setTimeout(async()=>{
   if(runtime.deploymentActive){log('round deadline reached during protected deployment; finishing verification or rollback');return;}
   log(`round stopped at its time limit (${config.roundHours??7} h)`);runtime.stopAll?.();
   for(const a of Object.values(readAttempts(config.outDir)).filter(a=>a.status==='running'))timedOut(config,a);
   await remind(config.outDir,'round-timeout','SSAM watcher round stopped',`A round reached its ${config.roundHours??7} h limit and was stopped; the next round retries (log ${log.file}).`,{...runtime,log}).catch(()=>{});
   log('round timeout');process.exit(3);
  },(config.roundHours??7)*3600000);deadline.unref();
  try{const result=rehearsal?await rehearseCurrent({...rehearsal,roundDeadline:Date.now()+(config.roundHours??7)*3600000},runtime,{manifest:baseWindow(runtime.manifest(),config.outDir).manifest}):await round(config,runtime);log(`round ${result.status}${result.id?' '+result.id:''}`);console.log(JSON.stringify(result,null,2));if(['failed','rolled-back','rollback-failed'].includes(result.status)||(rehearsal&&result.status!=='rehearsed'))process.exitCode=1;}
  catch(error){log(`round error: ${error.stack??error.message}`);await remind(config.outDir,'error:'+String(error.message).split('\n')[0].slice(0,120),'SSAM watcher error',`${String(error.message).split('\n')[0]} (log ${log.file})`,{...runtime,log}).catch(()=>{});process.exitCode=1;}
 }else{
  const mode=args.approve?'approve':args.reject?'reject':args.retry?'retry':args['seed-features']?'seed-features':args.pin?'pin':args.redecide?'redecide':args.skip?'skip':'';
  const log=createLog(runLogFile(config.outDir,new Date(),mode),{echo:!!mode});
  log(`watcher ${mode||'round'} start (pid ${process.pid})`);
  try{
   const result=mode?await owner(args,config,log):await launch(args,config,log);
   log(`watcher ${mode||'round'} end: ${result.status}`);
   if(result.steps)console.log(result.steps);else if(result.note)console.log(result.note);else if(mode||result.status!=='round-finished')console.log(JSON.stringify(result,null,2));
   if(result.code)process.exitCode=result.code;else if(['failed','workspace-stopped'].includes(result.status))process.exitCode=1;
  }catch(error){
   log(`watcher ${mode||'round'} error: ${error.stack??error.message}`);
   console.error(error.message);process.exitCode=1;
   if(!mode){const {createRuntime}=await import('./runtime.mjs');await remind(config.outDir,'error:'+String(error.message).split('\n')[0].slice(0,120),'SSAM watcher error',`${String(error.message).split('\n')[0]} (log ${log.file})`,{...(await createRuntime(config,{log}).catch(()=>({notify:async()=>{}}))),log}).catch(()=>{});}
  }
 }
}
