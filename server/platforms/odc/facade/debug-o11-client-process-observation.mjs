import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export async function observeO11ClientProcesses(ownerPid){
 if(!Number.isSafeInteger(ownerPid)||ownerPid<=0)throw new Error('debug_client_reconcile_owner_invalid');
 const script=`$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process); $nodes=@($rows | Where-Object {$_.Name -ieq 'node.exe'}); [pscustomobject]@{observedAt=[DateTime]::UtcNow.ToString('o');ownerPresent=@($rows | Where-Object {$_.ProcessId -eq ${ownerPid}}).Count -gt 0;workerCount=@($nodes | Where-Object {$_.CommandLine -like '*debug-o11-native-entry-worker.mjs*'}).Count;unreadableNodeCount=@($nodes | Where-Object {-not $_.CommandLine}).Count} | ConvertTo-Json -Compress`;
 const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:4096});
 const value=JSON.parse(stdout.replace(/^\uFEFF/,''));
 if(!Number.isFinite(Date.parse(value.observedAt))||typeof value.ownerPresent!=='boolean'||
  ![value.workerCount,value.unreadableNodeCount].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('debug_client_reconcile_process_observation_invalid');
 return {observedAt:value.observedAt,ownerPid,ownerPresent:value.ownerPresent,
  workerCount:value.workerCount,unreadableNodeCount:value.unreadableNodeCount,
  workerStopped:!value.ownerPresent&&value.workerCount===0&&value.unreadableNodeCount===0,
  source:'windows-cim-process-inventory',nativeDisposalConfirmed:false};
}
