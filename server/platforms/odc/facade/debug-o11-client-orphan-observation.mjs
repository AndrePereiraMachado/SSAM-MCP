import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {observeO11ClientProcesses} from './debug-o11-client-process-observation.mjs';
import {debugStoreInventory} from './debug-state-root.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw new Error('debug_client_reconcile_'+code);};
// CIM evidence that the owner and every O11 worker are gone: the owner pid, no unreadable node, at most 60 s old.
export const freshProcessAbsence=(e,ownerPid,now=Date.now())=>e?.workerStopped===true&&e.ownerPid===ownerPid&&e.ownerPresent===false&&
 e.workerCount===0&&e.unreadableNodeCount===0&&Number.isFinite(Date.parse(e.observedAt))&&Math.abs(now-Date.parse(e.observedAt))<=60000;
// This observation adds current termination/lease evidence to a confirmed
// private cleanup receipt. It never invents the missing action response.
export async function observeO11OrphanedClient(root,privateReceipt,{
 observeProcesses=observeO11ClientProcesses,
 // App-user leases in the new root and in every legacy copy (debug-state-root.mjs); counted, never opened.
 vaultRoot,legacyRoots,env=process.env,
}={}){
 if(privateReceipt.schema!=='ssam-client-private-reconciliation/1'||privateReceipt.privateCleanup?.completed!==true)fail('private_cleanup_unconfirmed');
 const pins=[...privateReceipt.pins],rootReal=fs.realpathSync(root);
 for(const pin of pins)if(hash(fs.readFileSync(pin.path))!==pin.sha256)fail('source_changed');
 const runPin=pins.find(p=>path.basename(p.path)==='receipt.json'&&path.basename(path.dirname(p.path))===privateReceipt.operationId);
 if(!runPin)fail('run_unbound');
 const run=JSON.parse(fs.readFileSync(runPin.path)),directory=path.dirname(runPin.path),lock=path.join(path.dirname(directory),run.target.moduleKey+'.lock');
 const relative=path.relative(rootReal,fs.realpathSync(lock));if(relative.startsWith('..')||path.isAbsolute(relative))fail('lock_outside_workspace');
 const lockBytes=fs.readFileSync(lock),owner=JSON.parse(lockBytes);
 if(owner.operationId!==privateReceipt.operationId||!Number.isSafeInteger(owner.pid)||owner.pid<=0)fail('mutex_owner_changed');
 let processEvidence;
 try{processEvidence=await observeProcesses(owner.pid);}catch{processEvidence={workerStopped:false,source:'unavailable',nativeDisposalConfirmed:false};}
 if(processEvidence.workerStopped===true&&!freshProcessAbsence(processEvidence,owner.pid))fail('process_observation_invalid');
 // Released only when every store was read and none holds a lease; a lease elsewhere is pending legacy-store:<PFN>.
 let leases;
 try{leases=debugStoreInventory('app-user',{env,stateRoot:vaultRoot,legacyRoots});}
 catch{leases={stateRoot:vaultRoot??null,stores:[],legacyInventory:[],empty:false,pending:['store:state']};}
 const leaseEntries=leases.stores.length&&leases.stores.every(s=>s.readable)?leases.stores.reduce((n,s)=>n+s.entries,0):null;
 const credentialsReleased=leases.empty===true&&leaseEntries===0;
 if(hash(fs.readFileSync(lock))!==hash(lockBytes)||pins.some(p=>hash(fs.readFileSync(p.path))!==p.sha256))fail('source_changed');
 const result={schema:'ssam-o11-client-orphan-observation/1',operationId:privateReceipt.operationId,sessionId:privateReceipt.sessionId,
  at:new Date().toISOString(),processEvidence,workerStopped:processEvidence.workerStopped===true,credentialsReleased,
  credentialEvidence:{scope:'current-user-app-user-lease-stores',leaseEntries,savedProfilesRead:false},
  stateRoot:leases.stateRoot,legacyInventory:leases.legacyInventory,pending:leases.pending,
  executionComplete:false,executionOutcome:'unconfirmed',mutexReleased:false,replayed:false,
  lockSha256:hash(lockBytes),pins};
 const directoryOut=path.join(root,'.local/debugger/client-reconciliations');
 const file=path.join(directoryOut,privateReceipt.sessionId+'.'+privateReceipt.operationId+'.observation-'+Date.now()+'.json');
 fs.writeFileSync(file,JSON.stringify(result,null,2),{flag:'wx'});return {...result,receiptPath:file};
}
