// Recover sealed inspection values after an inspector owner is lost. This
// proves only vault cleanup; it never releases a run mutex or claims that an
// action completed, a worker exited, or an app-user credential was released.
// Every store is enumerated (debug-state-root.mjs): the new root, this process's
// legacy view (both writable) and the real/package legacy copies (read only).
// Completion requires every store readable and no matching expired record left
// in a store this process may not write; such stores are pending legacy-store:<PFN>.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {privateInspectionVault} from './debug-private-inspection.mjs';
import {debugStateStore,legacyDebugStateRoots,inspectDebugStore,storePending,legacyInventoryOf} from './debug-state-root.mjs';
const fail=code=>{throw new Error('debug_private_recovery_'+code);};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const COUNTS=['matched','removed','unreadable','unexpired','changed','failed'];
export function recoverExpiredClientInspection({sessionId,lane,runtimeUrl,moduleKey}, {
 stateRoot,directory=stateRoot,legacyRoots,env=process.env,
 vault=privateInspectionVault,clock=Date.now,dryRun=true,
}={}){
 let url;try{url=new URL(runtimeUrl);}catch{fail('binding_invalid');}
 if(!/^[a-f0-9]{48}$/.test(sessionId??'')||!['o11','odc'].includes(lane)||
  !/^[A-Za-z0-9_+]{22}$/.test(moduleKey??'')||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||
  directory!==undefined&&!path.isAbsolute(directory??'')||typeof dryRun!=='boolean')fail('binding_invalid');
 const now=clock();if(!Number.isFinite(now))fail('clock_invalid');
 let stores;
 try{stores=[debugStateStore('invoke',{env,stateRoot:directory}),...(legacyRoots??legacyDebugStateRoots('invoke',{env}))];}catch{fail('store_enumeration_failed');}
 // Writable stores first: a record removed through this process's view also leaves its own package copy.
 stores.sort((a,b)=>(b.writable===true)-(a.writable===true));
 const report={schema:'ssam-private-inspection-recovery/1',sessionId,lane,moduleKey,dryRun,
  matched:0,removed:0,unreadable:0,unexpired:0,changed:0,failed:0,completed:false,
  executionComplete:false,workerStopped:false,credentialsReleased:false,mutexReleased:false,
  stateRoot:stores.find(s=>s.origin==='state').path,origins:[],pendingStores:[],unreadableStores:0};
 let total=0;
 for(const store of stores){
  const seen=inspectDebugStore(store);
  const o={origin:store.origin,writable:store.writable===true,readable:seen.readable,entries:seen.entries,
   matched:0,removed:0,unreadable:0,unexpired:0,changed:0,failed:0};
  report.origins.push(o);
  if(!seen.readable){report.unreadableStores++;continue;}
  const names=seen.names.filter(n=>n.endsWith('.dpapi'));
  if((total+=names.length)>10000)fail('record_limit');
  for(const name of names){
   const ref=name.slice(0,-6);if(!uuid.test(ref)){o.unreadable++;continue;}
   const file=path.join(store.path,name);let record,original;
   try{
    if(fs.lstatSync(file).isSymbolicLink())throw new Error();
    original=hash(fs.readFileSync(file));
    record=store.origin==='state'?vault('Open',ref):vault('Open',ref,undefined,{sourceRoot:store.path});
    if(record?.schema!=='ssam-private-inspection/1')continue;
    if(record.context?.sessionId!==sessionId)continue;
    // A matching inspector ID with conflicting binding cannot be cleaned by
    // this request. Keep it and report incomplete recovery.
    if(record.context.runtime!=='client'||record.context.platform!==lane||record.binding?.lane!==lane||
     record.binding.runtimeUrl!==runtimeUrl||record.binding.moduleKey!==moduleKey){o.failed++;continue;}
    o.matched++;
    const expiry=Date.parse(record.expiresAt);
    if(!Number.isFinite(expiry)||expiry>now){o.unexpired++;continue;}
    record=undefined;
    if(hash(fs.readFileSync(file))!==original){o.changed++;continue;}
    // Never forget through a store this process may not write: the record stays and the store is pending.
    if(!dryRun&&o.writable){
     if(vault('Forget',ref)?.ok!==true||fs.existsSync(file)){o.failed++;continue;}
     o.removed++;
    }
   }catch{o.unreadable++;}
   finally{record=undefined;}
  }
 }
 const blocked=o=>!o.readable||o.matched>o.removed||o.unreadable>0||o.unexpired>0||o.changed>0||o.failed>0;
 for(const o of report.origins){
  for(const key of COUNTS)report[key]+=o[key];
  if(o.writable?!o.readable:blocked(o))report.pendingStores.push(storePending(o));
 }
 report.legacyInventory=legacyInventoryOf(report.origins);
 report.pending=report.matched-report.removed;
 report.completed=report.unreadableStores===0&&report.unreadable===0&&report.unexpired===0&&report.changed===0&&report.failed===0&&report.pending===0;
 return report;
}
