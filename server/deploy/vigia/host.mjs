// Machine-level guards of an unattended round: one round at a time (lock), one log per round, and the rule that tells a
// build or test of another session from the long-running kernel servers (one dotnet build/test on the machine at a time).
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const pidAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
// The lock of a round (and of -Approve/-Reject/-Retry). A lock whose process is gone, or older than staleHours, is stale.
export function acquireLock(file,{now=Date.now(),staleHours=24,alive=pidAlive,pid=process.pid}={}){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const token=randomUUID(),body=JSON.stringify({pid,token,at:new Date(now).toISOString()})+'\n';
 for(let attempt=0;attempt<3;attempt++){
  try{fs.writeFileSync(file,body,{flag:'wx'});return {token,release:()=>releaseLock(file,token)};}
  catch(e){if(e.code!=='EEXIST')throw e;}
  let held=null;try{held=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  if(held&&Number.isInteger(held.pid)&&alive(held.pid)&&(now-Date.parse(held.at))/3600000<staleHours)return {busy:held};
  try{const again=fs.readFileSync(file,'utf8');if(!held||JSON.parse(again).token===held.token)fs.rmSync(file,{force:true});}catch{}
 }
 return {busy:{reason:'lock contention'}};
}
export function releaseLock(file,token){try{if(JSON.parse(fs.readFileSync(file,'utf8')).token===token)fs.rmSync(file,{force:true});}catch{}}
export function lockHeldBy(file,token){try{return JSON.parse(fs.readFileSync(file,'utf8')).token===token;}catch{return false;}}
// runs/<local date>/<HHMMSS>Z[-<mode>].log, append-only. Never given a secret: commands log arguments, never tokens.
export function runLogFile(outDir,now=new Date(),mode=''){
 const day=now.toLocaleDateString('sv-SE'),time=now.toISOString().slice(11,19).replaceAll(':','');
 return path.join(outDir,'runs',day,`${time}Z${mode?'-'+mode:''}.log`);
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
