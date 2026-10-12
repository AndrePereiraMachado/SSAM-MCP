import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// All values stay inside the child and its private vault helper. Only the
// cleanup counters leave it. The MCP event loop stays available for controls.
const COUNTS=['matched','removed','unreadable','unexpired','changed','failed'];
const count=v=>Number.isSafeInteger(v)&&v>=0;
const ORIGIN=/^(state|current|real|packages|package:[A-Za-z0-9._-]{1,128})$/;
export function recoverExpiredClientInspectionAsync(target,{dryRun=true}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./debug-private-inspection-recovery-worker.mjs',import.meta.url))],
   {windowsHide:true,stdio:['pipe','pipe','ignore']});
  let output='',failed=false;
  const error=()=>{failed=true;reject(new Error('debug_private_recovery_worker_failed'));};
  child.on('error',error);child.stdin.on('error',error);
  child.stdout.on('data',data=>{output+=data;if(Buffer.byteLength(output)>65536){child.kill();error();}});
  child.on('close',code=>{
   if(failed)return;
   try{const r=JSON.parse(output);
    if(code!==0||r.schema!=='ssam-private-inspection-recovery/1'||r.sessionId!==target.sessionId||
     r.lane!==target.lane||r.moduleKey!==target.moduleKey||r.dryRun!==dryRun||
     [...COUNTS,'pending','unreadableStores'].some(k=>!count(r[k]))||
     typeof r.completed!=='boolean'||r.executionComplete!==false||r.workerStopped!==false||
     r.credentialsReleased!==false||r.mutexReleased!==false||
     // Store evidence: the new root, every enumerated store with its counts, and the pending stores.
     typeof r.stateRoot!=='string'||!Array.isArray(r.origins)||r.origins.some(o=>!ORIGIN.test(o?.origin??'')||
      typeof o.readable!=='boolean'||typeof o.writable!=='boolean'||![...COUNTS,'entries'].every(k=>count(o[k])))||
     !Array.isArray(r.legacyInventory)||r.legacyInventory.some(o=>!ORIGIN.test(o?.origin??'')||!count(o.entries)||typeof o.readable!=='boolean')||
     !Array.isArray(r.pendingStores)||r.pendingStores.some(p=>!/^(store|legacy-store):[A-Za-z0-9._-]{1,128}$/.test(p))||
     r.completed&&(r.pendingStores.length||r.unreadableStores||r.origins.some(o=>!o.readable)))throw new Error();
    resolve(r);
   }catch{error();}
  });
  child.stdin.end(JSON.stringify({target,dryRun}));
 });
}
