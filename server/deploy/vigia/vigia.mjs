// The Studio versions watcher (README.md). Modes:
//   (default)     an unattended round: lock, log, fast-forward of the watcher worktree from the local main, then the round
//                 itself in a child process running the code just fetched (so a fix in main applies at once);
//   --dry-run     reads the versions and prints what a round would do; writes nothing;
//   --approve <id|lane-version>, --reject <id> --reason <text>, --retry <id>: the owner's commands.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runVigia,readAttempts,remind} from './pipeline.mjs';
import {replayApprovals} from './window.mjs';
import {approve,reject,retry} from './approve.mjs';
import {acquireLock,lockHeldBy,runLogFile,createLog} from './host.mjs';
export * from './window.mjs';
export * from './pipeline.mjs';
export * from './approve.mjs';
export * from './host.mjs';
// A worktree whose vigia.mjs declares this protocol runs the round as a child (--round); an older one does not.
export const ROUND_PROTOCOL=2;
const self=fileURLToPath(import.meta.url);
export function parseArgs(argv){
 const args={flags:new Set()};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(['--config','--approve','--reject','--reason','--retry','--log'].includes(a)){if(argv[i+1]===undefined)throw Error(`${a} needs a value.`);args[a.slice(2)]=argv[++i];}
  else if(['--dry-run','--round','--no-update'].includes(a))args.flags.add(a.slice(2));
  else throw Error(`Unknown argument ${a}. Usage: vigia.mjs --config <file> [--dry-run | --approve <id> | --reject <id> --reason <text> | --retry <id>] [--no-update]`);
 }
 if(!args.config)throw Error('Usage: vigia.mjs --config <file> [--dry-run | --approve <id> | --reject <id> --reason <text> | --retry <id>]');
 return args;
}
export function readConfig(file){
 const config=JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));
 config.outDir=path.resolve(config.outDir??path.dirname(path.resolve(file)));
 for(const key of ['workspace','tempRoot','bundleRoot'])if(!config[key])throw Error(`The watcher configuration needs ${key}.`);
 return config;
}
// The window the next proposal starts from: main's versions.json plus the approvals main does not carry yet.
export function baseWindow(mainManifest,outDir){
 const approved=Object.values(readAttempts(outDir)).filter(a=>a.status==='approved');
 return replayApprovals(mainManifest,approved);
}
export async function round(config,runtime,{dryRun=false}={}){
 const {manifest,replayed}=baseWindow(runtime.manifest(),config.outDir);
 const observed=await runtime.detect();
 let state={};if(config.versionStateFile&&fs.existsSync(config.versionStateFile))state=JSON.parse(fs.readFileSync(config.versionStateFile,'utf8'));
 const head=await runtime.head();
 runtime.log?.(`workspace ${head}; observed ${observed.map(o=>`${o.lane} ${o.fullVersion}${o.tfm?' '+o.tfm:''}${o.requiresInstallation?' (installer)':''}`).join(', ')||'nothing'}${replayed.length?`; approved, not in main: ${replayed.join(', ')}`:''}`);
 return runVigia({...config,manifest,replayed,state,observed,head,dryRun},runtime);
}
async function childSupportsRounds(file){try{return fs.readFileSync(file,'utf8').includes('ROUND_PROTOCOL=2');}catch{return false;}}
async function launch(args,config,log){
 const {createRuntime}=await import('./runtime.mjs');
 const runtime=await createRuntime(config,{log});
 const lock=acquireLock(path.join(config.outDir,'vigia.lock'));
 if(lock.busy){log(`another round holds the lock (pid ${lock.busy.pid??'?'} since ${lock.busy.at??'?'}); nothing to do`);return {status:'busy'};}
 try{
  if(!args.flags.has('no-update')){
   try{const u=await runtime.updateWorkspace(config.updateFrom??'main');log(u.updated?`workspace fast-forwarded ${u.from.slice(0,7)} -> ${u.head.slice(0,7)} from ${config.updateFrom??'main'}`:`workspace up to date at ${u.head.slice(0,7)}`);}
   catch(error){log(`workspace update stopped: ${error.message}`);await remind(config.outDir,'workspace','SSAM watcher stopped',error.message,{...runtime,log});return {status:'workspace-stopped',error:error.message};}
  }
  const child=path.join(path.resolve(config.workspace),'server/deploy/vigia/vigia.mjs');
  if(await childSupportsRounds(child)){
   const code=await new Promise((resolve,reject_)=>{const p=spawn(process.execPath,[child,'--config',args.config,'--round','--log',log.file],{env:{...process.env,SSAM_VIGIA_LOCK:lock.token},stdio:['ignore','inherit','inherit'],windowsHide:true});p.once('error',reject_);p.once('close',resolve);});
   return {status:'round-finished',code};
  }
  log('the workspace has an older watcher; this round runs the launcher code');
  return await round(config,runtime);
 }finally{lock.release();}
}
async function owner(args,config,log){
 const lock=acquireLock(path.join(config.outDir,'vigia.lock'));
 if(lock.busy)throw Error(`A watcher round is running (pid ${lock.busy.pid??'?'} since ${lock.busy.at??'?'}). Try again when it ends.`);
 try{
  if(args.reject)return reject(config,args.reject,args.reason);
  if(args.retry)return retry(config,args.retry);
  const {createRuntime}=await import('./runtime.mjs');
  return await approve(config,await createRuntime(config,{log}),args.approve);
 }finally{lock.release();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===self){
 const args=parseArgs(process.argv.slice(2));
 const config=readConfig(args.config);
 if(args.flags.has('dry-run')){
  const {createRuntime}=await import('./runtime.mjs');
  console.log(JSON.stringify(await round(config,await createRuntime(config),{dryRun:true}),null,2));
 }else if(args.flags.has('round')){
  const log=createLog(args.log);
  if(!lockHeldBy(path.join(config.outDir,'vigia.lock'),process.env.SSAM_VIGIA_LOCK))throw Error('--round runs only under the launcher that holds the watcher lock.');
  const {createRuntime}=await import('./runtime.mjs');
  const runtime=await createRuntime(config,{log});
  try{const result=await round(config,runtime);log(`round ${result.status}${result.id?' '+result.id:''}`);console.log(JSON.stringify(result,null,2));if(result.status==='failed')process.exitCode=1;}
  catch(error){log(`round error: ${error.stack??error.message}`);await remind(config.outDir,'error:'+String(error.message).split('\n')[0].slice(0,120),'SSAM watcher error',`${String(error.message).split('\n')[0]} (log ${log.file})`,{...runtime,log}).catch(()=>{});process.exitCode=1;}
 }else{
  const mode=args.approve?'approve':args.reject?'reject':args.retry?'retry':'';
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
