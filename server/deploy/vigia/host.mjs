// Machine-level guards of an unattended round: one round at a time (lock), one log per round, and the rule that tells a
// build or test of another session from the long-running kernel servers (one dotnet build/test on the machine at a time).
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
// A process is named by its pid AND its start time: Windows reuses pids, so a pid alone can name another program.
// Returns the start time (ISO) of a live process, or null.
export function processStart(pid){
 if(!Number.isInteger(pid)||pid<=0)return null;
 if(process.platform!=='win32'){try{process.kill(pid,0);return 'alive';}catch(e){return e.code==='EPERM'?'alive':null;}}
 const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";if($p){$p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}`],{encoding:'utf8',windowsHide:true,timeout:60000});
 return r.stdout?.trim()||null;
}
// A lock written before locks named their start time (no "started") counts only within the task's 8 h limit.
const holds=(entry,identity,now,at)=>!!entry&&Number.isInteger(entry.pid)&&(entry.started?identity(entry.pid)===entry.started:identity(entry.pid)!==null&&(now-Date.parse(at))/3600000<8);
// The lock of a round (and of -Approve/-Reject/-Retry): held while its launcher or the round process it registered is the
// same live process (pid and start time). Anything else is stale and taken over.
export function acquireLock(file,{now=Date.now(),identity=processStart,pid=process.pid}={}){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const token=randomUUID(),body=JSON.stringify({pid,started:identity(pid),token,at:new Date(now).toISOString(),child:null})+'\n';
 for(let attempt=0;attempt<3;attempt++){
  try{fs.writeFileSync(file,body,{flag:'wx'});return {token,release:()=>releaseLock(file,token)};}
  catch(e){if(e.code!=='EEXIST')throw e;}
  let held=null;try{held=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  if(held&&(holds(held,identity,now,held.at)||holds(held.child,identity,now,held.at)))return {busy:held};
  try{const again=fs.readFileSync(file,'utf8');if(!held||JSON.parse(again).token===held.token)fs.rmSync(file,{force:true});}catch{}
 }
 return {busy:{reason:'lock contention'}};
}
// The launcher names the round process it started, so a launcher killed at the task's time limit leaves the lock held
// while that round still runs.
export function registerChild(file,token,childPid,{identity=processStart}={}){
 const held=JSON.parse(fs.readFileSync(file,'utf8'));if(held.token!==token)return false;
 held.child={pid:childPid,started:identity(childPid)};const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(held)+'\n');fs.renameSync(temp,file);return true;
}
export function releaseLock(file,token){try{if(JSON.parse(fs.readFileSync(file,'utf8')).token===token)fs.rmSync(file,{force:true});}catch{}}
export function lockHeldBy(file,token){try{return JSON.parse(fs.readFileSync(file,'utf8')).token===token;}catch{return false;}}
// runs/<local date>/<local HHMMSS>[-<mode>].log (date and time in the same zone, so the files sort by time), append-only.
// Never given a secret: commands log arguments, never tokens.
export function runLogFile(outDir,now=new Date(),mode=''){
 const [day,time]=now.toLocaleString('sv-SE').split(' ');
 return path.join(outDir,'runs',day,`${time.replaceAll(':','')}${mode?'-'+mode:''}.log`);
}
export function createLog(file,{echo=false}={}){
 if(file)fs.mkdirSync(path.dirname(file),{recursive:true});
 const log=line=>{const text=`${new Date().toISOString()} ${String(line).replace(/\r?\n/g,'\n  ')}\n`;if(file)fs.appendFileSync(file,text);if(echo)process.stderr.write(text);};
 log.file=file;return log;
}
// Another session's dotnet build or test (the vigia waits for it). The kernel servers of the prototype (anvil.dll serve,
// anvil-odc.dll serve) and idle build servers (MSBuild node reuse, VBCSCompiler) do not count.
const VERBS=new Set(['build','test','publish','pack','restore','msbuild','vstest','run','watch','clean']);
export function busyDotnet(processes){
 return processes.filter(p=>{
  const name=String(p.Name??'').toLowerCase(),cmd=String(p.CommandLine??'');
  if(/^testhost(\.x86|\.net\d*)?\.exe$/.test(name))return true;
  if(name!=='dotnet.exe'&&name!=='dotnet')return false;
  if(/\banvil(-odc)?\.dll"?\s+serve\b/i.test(cmd))return false;
  if(/VBCSCompiler\.dll|[\\/]MSBuild\.dll"?\s+.*\/nodemode:|--nodemode|\bbuild-server\b/i.test(cmd))return false;
  if(/testhost[^\\/]*\.dll|vstest\.console\.dll/i.test(cmd))return true;
  if(/[\\/]MSBuild\.dll"?(\s|$)/i.test(cmd))return true;
  const args=cmd.match(/"[^"]*"|\S+/g)??[];
  const verb=(args[1]??'').replace(/"/g,'').toLowerCase();
  return VERBS.has(verb);
 });
}
