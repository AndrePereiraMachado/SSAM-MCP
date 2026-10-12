import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {recoverExpiredClientInspectionAsync} from './debug-private-inspection-recovery-process.mjs';
import {observeO11OrphanedClient} from './debug-o11-client-orphan-observation.mjs';
import {reconcileO11ClientAborted,clientAbortedReceipt} from './debug-o11-client-aborted-reconcile.mjs';
import {assertLockNotRetained} from './debug-retained-locks.mjs';
const fail=code=>{throw new Error('debug_client_reconcile_'+code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STORE=/^(store|legacy-store):[A-Za-z0-9._-]{1,128}$/;
const stores=list=>Array.isArray(list)?list.filter(item=>STORE.test(item)):[];
// A cleanup result under the store rule names its state root and every legacy store it read (debug-state-root.mjs).
const storeRule=cleanup=>typeof cleanup?.stateRoot==='string'&&Array.isArray(cleanup.legacyInventory);
export async function reconcileClientPrivateValues(root,session,operationId,{recover=recoverExpiredClientInspectionAsync,clock=Date.now,observeOrphan=observeO11OrphanedClient,
 reconcileAborted=reconcileO11ClientAborted,abortedReceipt=clientAbortedReceipt}={}){
 // A lock retained by user decision is never reconciled or archived (debug_lock_retained_by_decision).
 const ran=session?.runResult;assertLockNotRetained({action:'reconcile',operationId,host:ran?.target?.host??ran?.binding?.host,moduleKey:ran?.target?.moduleKey??ran?.binding?.moduleKey});
 // A terminal uncertain session keeps runResult but no native pause id: only the public aborted reconcile applies.
 if(session?.lane==='o11'&&session.runtime==='client'&&session.state==='uncertain'&&!/^[a-f0-9]{48}$/.test(session.pause?.sessionId??'')&&
  uuid.test(operationId??'')&&session.runResult?.operationId===operationId)return reconcileAborted(root,session,operationId,{});
 // Only the execution outcome left: zero-submission evidence may archive the mutex. A refusal keeps it pending.
 const chain=async(receipt,observed)=>{
  let aborted;
  try{aborted=await reconcileAborted(root,session,operationId,{privateReceipt:{...receipt,workerStopped:true,credentialsReleased:true,
   pending:['execution-outcome'],...(observed?{terminationObservation:observed.terminationObservation}:{})},...(observed?{observation:observed.terminationObservation}:{})});}
  catch(error){if(!/^debug_o11_client_aborted_reconcile_[a-z0-9_]+$/.test(error?.message??''))throw error;
   return {...(observed??receipt),clientAbortedReconciliation:{ok:false,error:error.message}};}
  if(aborted?.ok!==true)return {...(observed??receipt),clientAbortedReconciliation:aborted,
   pending:[...new Set([...(observed??receipt).pending,...(aborted?.pending??[])])]};
  return {...receipt,workerStopped:true,credentialsReleased:true,executionOutcome:aborted.executionOutcome,mutexReleased:true,pending:[],clientAbortedReconciliation:aborted};
 };
 const observe=async receipt=>{
  if(receipt.privateCleanup?.completed!==true)return receipt;
  // Already archived: the lock is gone and the public receipt is reused, never observed or archived again.
  if(abortedReceipt(root,operationId))return chain(receipt);
  const observation=await observeOrphan(root,receipt);
  const extra=stores(observation.pending).filter(item=>!receipt.pending.includes(item));
  const observed={...receipt,workerStopped:observation.workerStopped===true,credentialsReleased:observation.credentialsReleased===true,
   terminationObservation:observation,pending:[...receipt.pending.filter(item=>
    !(item==='worker-termination-evidence'&&observation.workerStopped===true)&&
    !(item==='app-user-credential-release'&&observation.credentialsReleased===true)),...extra]};
  return same(observed.pending,['execution-outcome'])?chain(receipt,observed):observed;
 };
 if(session?.lane!=='o11'||session.runtime!=='client'||!uuid.test(session.sessionId??'')||!uuid.test(operationId??'')||
  !['ending','uncertain'].includes(session.state)||!/^[a-f0-9]{48}$/.test(session.pause?.sessionId??'')||
  !Number.isFinite(Date.parse(session.pause.expiresAt))||Date.parse(session.pause.expiresAt)>clock())fail('not_eligible');
 const realRoot=fs.realpathSync(root),pins=[];
 const read=file=>{
  const relative=path.relative(realRoot,fs.realpathSync(file));
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))fail('source_outside_workspace');
  const bytes=fs.readFileSync(file);pins.push({path:file,sha256:createHash('sha256').update(bytes).digest('hex')});return JSON.parse(bytes);
 };
 const stored=read(path.join(root,'.local/debugger/client-sessions',session.sessionId+'.json'));
 if(JSON.stringify(stored)!==JSON.stringify(session))fail('session_changed');
 const base=path.join(root,'.local/debugger/native-runs/o11');
 const matches=fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory())
  .map(e=>path.join(base,e.name,operationId,'receipt.json')).filter(file=>fs.existsSync(file));
 if(matches.length!==1)fail('run_not_unique');
 const run=read(matches[0]),target=run.target;
 if(run.schema!=='ssam-o11-native-run/1'||run.operationId!==operationId||run.receiptPath!==matches[0]||
  run.op!=='run'||!target||target.host!==path.basename(path.dirname(path.dirname(matches[0])))||
  !/^[A-Za-z0-9_+]{22}$/.test(target.moduleKey??'')||!/^[a-f0-9]{64}$/i.test(run.published?.sourceSha256??''))fail('run_invalid');
 const frame=session.pause.frames?.[session.pause.frame];
 const [moduleKey,functionKey]=String(frame?.elementKey??'').split(':');
 if(moduleKey!==target.moduleKey||!functionKey||!Array.isArray(session.metadataEvidence)||!session.metadataEvidence.length)fail('scope_unbound');
 const scopes=session.metadataEvidence.map(file=>read(file).data);
 if(!scopes.some(s=>s?.moduleKey===moduleKey&&s.functionKey===functionKey&&
  s.sourceSha256?.toLowerCase()===run.published?.sourceSha256?.toLowerCase()))fail('source_mismatch');
 for(const pin of pins)if(createHash('sha256').update(fs.readFileSync(pin.path)).digest('hex')!==pin.sha256)fail('source_changed');
 const directory=path.join(root,'.local/debugger/client-reconciliations');fs.mkdirSync(directory,{recursive:true});
 const receiptPath=path.join(directory,session.sessionId+'.'+operationId+'.json');
 const binding={sessionId:session.pause.sessionId,lane:session.lane,runtimeUrl:target.runtimeUrl,moduleKey};
 const outcome=(privateCleanup,file,extra={})=>{
  const result={ok:true,schema:'ssam-client-private-reconciliation/1',sessionId:session.sessionId,operationId,
   state:'requires-reconciliation',at:new Date(clock()).toISOString(),privateCleanup,pins,receiptPath:file,...extra,
   stateRoot:privateCleanup?.stateRoot??null,legacyInventory:privateCleanup?.legacyInventory??null,
   executionComplete:false,workerStopped:false,credentialsReleased:false,mutexReleased:false,replayed:false,
   pending:['worker-termination-evidence','execution-outcome','app-user-credential-release']};
  if(privateCleanup.completed!==true)result.pending.unshift('private-inspection-cleanup',...stores(privateCleanup.pendingStores));
  fs.writeFileSync(file+'.tmp',JSON.stringify(result,null,2),{flag:'wx'});fs.renameSync(file+'.tmp',file);return result;
 };
 // A receipt written before the store rule saw one %LOCALAPPDATA% view only. It is never rewritten nor
 // trusted: one additive re-check over every store, recorded before it runs and never replayed.
 const recheck=async previous=>{
  const file=receiptPath.slice(0,-5)+'.store-recheck.json';
  if(fs.existsSync(file)){
   const prior=JSON.parse(fs.readFileSync(file));
   if(prior.supersedes!==receiptPath||prior.sessionId!==session.sessionId||prior.operationId!==operationId||JSON.stringify(prior.pins)!==JSON.stringify(pins))fail('recovery_changed');
   if(prior.state==='requires-reconciliation'&&storeRule(prior.privateCleanup))return observe(prior);
   fail('recovery_outcome_unconfirmed');
  }
  fs.writeFileSync(file,JSON.stringify({sessionId:session.sessionId,operationId,pins,supersedes:receiptPath,
   state:'private-cleanup-pending',at:new Date(clock()).toISOString()},null,2),{flag:'wx'});
  const privateCleanup=await recover(binding,{dryRun:false});
  return observe(outcome(privateCleanup,file,{supersedes:receiptPath,previousPrivateCleanup:previous.privateCleanup,recheckReason:'receipt-before-store-rule'}));
 };
 if(fs.existsSync(receiptPath)){
  const previous=JSON.parse(fs.readFileSync(receiptPath));
  if(previous.sessionId!==session.sessionId||previous.operationId!==operationId||JSON.stringify(previous.pins)!==JSON.stringify(pins))fail('recovery_changed');
  if(previous.state==='requires-reconciliation'&&previous.privateCleanup)return storeRule(previous.privateCleanup)?observe(previous):recheck(previous);
  fail('recovery_outcome_unconfirmed');
 }
 fs.writeFileSync(receiptPath,JSON.stringify({sessionId:session.sessionId,operationId,pins,
  state:'private-cleanup-pending',at:new Date(clock()).toISOString()},null,2),{flag:'wx'});
 const privateCleanup=await recover(binding,{dryRun:false});
 return observe(outcome(privateCleanup,receiptPath));
}
