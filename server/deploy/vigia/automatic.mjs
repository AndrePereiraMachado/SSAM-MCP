// The release is based on observed production state; every mutation is fenced
// by the shared remote lease and the original Coolify compose fingerprint.
import fs from 'node:fs';
import {readJournal,writeJournal} from './journal.mjs';
import path from 'node:path';
import {rotateWindow,pinDigest} from './window.mjs';
import {assertUnserved,assertRetained,canonicalComposeHash} from './safety.mjs';
export const AUTOMATIC_PLAN=[
 'Read secrets and validate the reviewed vigia-run execution source',
 'Read the live pairs, immutable digests, kernels and telemetry (dry-run: public source reads only)',
 'Detect official Studio releases; retain active clients and never downgrade a live pair',
 'Verify installer publisher, extract, compare MSBuild runtimes and baseline/candidate tests',
 'Compile pinned client sources, verify signatures and publish sequenced manifests',
 'Build and smoke the candidate image; publish and verify its immutable digest',
 'Record the pin separately without modifying the trusted execution checkout',
 'Check PAUSE and the remaining deployment budget, then acquire the shared VPS flock',
 'Check memory and disk; compare live compose hash before backup',
 'Back up, prepare only the new stopped pair, then compare the live hash again',
 'PATCH and deploy through Coolify; check warm, health, listings and hello',
 'Restore only after a mutation; validate rollback against the captured live baseline',
 'Release the lock after verification or rollback; retain five backups',
 'Notify per attempt, always notify rollback failure'
];
const atomic=(file,value)=>{const tmp=file+'.next';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,file);};
export async function releaseEvent(directory,ops,name,id,message,secrets,attempt='legacy'){
 const file=path.join(directory,'release-events.json');let events={};
 if(fs.existsSync(file))events=JSON.parse(fs.readFileSync(file,'utf8'));
 const key=id+':'+attempt+':'+name;
 if(name!=='rollback-failed'&&events[key])return;
 events[key]=new Date().toISOString();atomic(file,events);
 await ops.event(name,{id,attempt,message},secrets).catch(()=>{});
}
export async function releaseAutomatically(config,ops,release){
 const {id,dir,built,manifest,kernel,bridges,features}=release;
 const secrets=await ops.secrets();
 const file=path.join(dir,'deployment.json');
 let state=fs.existsSync(file)?readJournal(file):{schema:2,id,attempt:release.attempt??new Date().toISOString(),steps:{}};
 if(release.attempt&&state.attempt!==release.attempt){
  const previous=path.join(dir,'previous');fs.mkdirSync(previous,{recursive:true});
  fs.renameSync(file,path.join(previous,'deployment-'+String(state.attempt).replace(/[^A-Za-z0-9_-]/g,'_')+'.json'));
  state={schema:2,id,attempt:release.attempt,steps:{}};
 }
 if(!state.mutationStarted){await ops.pause();await ops.deploymentBudget();}
 state.deploySent??=!!state.steps.deploy||['deploy','checks'].includes(state.activeStep);
 const save=()=>writeJournal(file,state);
 const event=(name,message)=>releaseEvent(config.outDir??dir,ops,name,id,message,secrets,state.attempt);
 if(['idle','abandoned'].includes(state.status))return {status:state.status,id};
 if(state.status==='live')return {status:'live',id,commit:state.pin};
 if(state.status==='rollback-failed'){await event('rollback-failed',`${id}: rollback still requires owner attention.`);return {status:'rollback-failed',id};}
 if(state.status==='rolled-back')throw Error('Owner Retry or a new Studio build is required.');
 // Never retain arbitrary service/API response objects in this journal.
 const once=async(name,fn,select=x=>x)=>{if(state.steps[name])return state.steps[name].value;state.activeStep=name;save();const value=select(await fn());state.steps[name]={value,at:new Date().toISOString()};save();return value;};
 let baseline=state.baseline??release.baseline??await ops.liveBaseline(secrets);
 let proposed=state.proposed??manifest;
 if(state.status==='deferred'){
  if((state.deferrals??0)>=(config.maxDeploymentDeferrals??3)||Date.now()-Date.parse(state.firstDeferredAt??state.attempt)>(config.maxDeferredHours??48)*3600000){
   state.status='abandoned';save();await event('failed',`${id}: deferred release expired; later rounds may proceed.`);return {status:'abandoned',id};
  }
  try {
  baseline=await ops.liveBaseline(secrets);
  try{assertUnserved(baseline,{odc:built.odc??kernel.odc,o11:built.o11??kernel.o11});}
  catch(e){if(e.code!=='ALREADY_SERVED')throw e;state.status='idle';save();return {status:'idle',id};}
  proposed=rotateWindow(baseline.manifest,{odc:built.odc??kernel.odc,o11:built.o11??kernel.o11,image:built.image,tag:built.tag},{...baseline.telemetry,maxWindow:config.maxWindow??4}).manifest;
  if(baseline.hash!==state.baseline?.hash){delete state.steps.pin;delete state.steps.backup;delete state.steps.prepared;}
  }catch(error){state.deferrals=(state.deferrals??0)+1;state.firstDeferredAt??=new Date().toISOString();save();await event('failed',`${id}: live baseline refresh deferred.`);return {status:'deferred',id,code:error.code??'BASELINE_UNAVAILABLE'};}
 }
 state.baseline=baseline;state.proposed=proposed;if(state.status!=='rolling-back')state.status='preparing';save();
 try{if(!state.mutationStarted)assertUnserved(baseline,{odc:built.odc??kernel.odc,o11:built.o11??kernel.o11});}
 catch(e){if(e.code==='ALREADY_SERVED'){state.status='idle';save();return {status:'idle',id};}throw e;}
 const pinned=pinDigest(proposed,built.tag,'sha256:'+built.sha256);assertRetained(baseline,pinned);
 await event('detected',`${id}: verified candidate detected.`);
 let unlock,protectedPhase=false;
 try{
  if(ops.verifyRelease)await ops.verifyRelease(release);
  if(!state.mutationStarted){
   await once('published',async()=>{await ops.verifyLocalImage(built);const p=await ops.publish(built);if(p.digest!=='sha256:'+built.sha256)throw Error('Registry digest differs from tested image.');return p;},p=>({digest:p.digest,already:!!p.already}));
   state.pin=await once('pin',()=>ops.pinExecution(pinned,dir,id,kernel,baseline.kernels));
  }
  if(!state.mutationStarted){await ops.pause();await ops.deploymentBudget();}
  unlock=await ops.acquireReleaseLock(secrets);ops.beginDeployment?.();protectedPhase=true;
  if(!state.mutationStarted){
   await ops.preflightRemote(secrets,pinned);
   await ops.assertLiveUnchanged(secrets,baseline);
   await once('backup',()=>ops.backup(secrets,id),x=>({ok:!!x.ok,directory:x.directory,volumes:x.volumes}));
  }
  if(state.status!=='rolling-back'){
   const compose=await ops.composeFor(secrets,baseline,pinned);
   if(!state.mutationStarted){
    await once('prepared',()=>ops.prepare(secrets,{id,built,kernel,features,bridges,compose,dir}),()=>({ok:true}));
    await ops.pause();await ops.assertLiveUnchanged(secrets,baseline);
    state.composeHash=canonicalComposeHash(compose);state.mutationStarted=true;save();
    await once('compose-written',()=>ops.writeCompose(secrets,compose),()=>({ok:true}));
   }
   await once('deploy',()=>{state.deploySent=true;save();return ops.deploy(secrets);},()=>({ok:true}));
   await once('checks',async()=>{const r=await ops.checks(secrets,{id,pinned,kernel,bridges,built});if(!r?.ok)throw Error('Post-deployment checks failed.');return r;},r=>({ok:true,backends:r.backends}));
   state.status='live';save();await event('live',`${id}: deployed and verified.`);
   return {status:'live',id,commit:state.pin};
  }
  throw Error('Resume interrupted rollback.');
 }catch(error){
  state.failure={step:state.activeStep??'preflight',code:/^[A-Z_]+$/.test(error.code??'')?error.code:'RELEASE_FAILED'};
  if(!state.mutationStarted){
   state.status=error.environmental?'deferred':'preparation-failed';
   if(error.environmental){state.deferrals=(state.deferrals??0)+1;state.firstDeferredAt??=new Date().toISOString();}
   save();await event('failed',`${id}: ${state.failure.step} failed before mutation (${state.failure.code}).`);
   return {status:error.environmental?'deferred':'failed',id,code:state.failure.code};
  }
  state.status='rolling-back';save();let restored=false;
  try{if(ops.ensureReleaseLock)unlock=await ops.ensureReleaseLock(secrets,unlock);if(ops.assertRollbackSafe)await ops.assertRollbackSafe(secrets,baseline,state.composeHash);await ops.restoreCompose(secrets,baseline);if(state.deploySent){await ops.deploy(secrets);const r=await ops.checks(secrets,{rollback:true,live:baseline});if(!r?.ok)throw Error('Rollback checks failed.');}restored=true;}catch{}
  state.status=restored?'rolled-back':'rollback-failed';save();
  await event(restored?'failed':'rollback-failed',`${id}: ${state.failure.step} failed; ${restored?'previous live baseline restored':'rollback requires owner attention'}.`);
  return {status:state.status,id,code:'automatic-deployment-failed'};
 }finally{
  try{if(unlock)await unlock();}finally{if(protectedPhase)ops.endDeployment?.();}
 }
}
