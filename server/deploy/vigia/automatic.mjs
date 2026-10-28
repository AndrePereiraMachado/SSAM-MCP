// A durable release transaction. Its operations have no implicit globals, so the
// same ordering, recovery and rollback are exercised with real HTTP and fake SSH.
import fs from 'node:fs';
import path from 'node:path';
import {pinDigest,literalComposeText} from './window.mjs';
export const AUTOMATIC_PLAN = [
 'Read all required secrets from the Windows DPAPI vault before any release write',
 'Detect the stable Studio releases at the official source; fall back to installed Studios',
 'Download and SHA-256 installers into the private installer store; extract without executing',
 'Wait for other dotnet builds/tests and Docker builds; validate MSBuild runtimes and frozen baselines',
 'Build client bridges, verify Authenticode and sign each manifest with Ed25519',
 'Build and smoke the candidate image containing the signed bridges',
 'Publish an immutable private tag and verify its registry digest (never latest)',
 'Commit the digest pin and generated three-pair compose locally on the execution branch',
 'Back up PostgreSQL and every live volume over SSH; save the live Coolify compose',
 'Prepare the new pair stopped and write kernel/features with ssamctl',
 'Update and deploy the compose using the Coolify API',
 'Check backend warm, aggregate health, listing budget, synthetic hello on both lanes and bridge offers',
 'On any deployment/check failure restore the saved compose, redeploy and verify rollback',
 'Notify once per event; preserve volumes of pairs leaving the window'
];
const atomic=(file,value)=>{const tmp=file+'.next';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,file);};
export async function releaseAutomatically(config,ops,release) {
 const {id,dir,built,manifest,kernel,bridges,features}=release;
 const secrets=await ops.secrets(); // Never persisted in the journal or spread into a result.
 const file=path.join(dir,'deployment.json');
 let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{schema:1,id,steps:{}};
 const resumingRollback=state.status==='rolling-back';
 if(state.status==='live')return {status:'live',id,commit:state.pin};
 if(['rolled-back','rollback-failed'].includes(state.status))throw Error('This release was rolled back; inspect it before retrying.');
 const save=()=>atomic(file,state);
 const once=async(name,fn)=>{if(state.steps[name])return state.steps[name].value;state.activeStep=name;save();const value=await fn();state.steps[name]={value,at:new Date().toISOString()};save();return value;};
 const event=async(name,message)=>{
  if(state.steps['notice-'+name])return;
  // Record first: at most one attempt to deliver an event, including after a crash.
  state.steps['notice-'+name]={at:new Date().toISOString()};save();
  await ops.event(name,{id,message},secrets).catch(()=>{});
 };
 await event('detected',`${id}: tests and signed bridges passed; preparing automatic deployment.`);
 let published,pinned,live;
 try {
 published=await once('published',async()=>{
  await ops.verifyLocalImage(built);
  const p=await ops.publish(built);
  if(p.digest!=='sha256:'+built.sha256)throw Error('Registry digest differs from the tested image.');
  return p;
 });
 pinned=pinDigest(manifest,built.tag,published.digest);
 state.pin=await once('pin',()=>ops.pinExecution(pinned,dir,id,kernel));
 // The actual live compose is the rollback source, never a regenerated guess.
 // It can contain Coolify values: keep it only in protected memory/storage.
 live=await once('live-snapshot',()=>ops.saveLiveCompose(secrets,id));
 await once('backup',()=>ops.backup(secrets,id));
 }catch(error){
  state.failure={step:state.activeStep,code:/^[A-Z_]+$/.test(error.code??'')?error.code:'PREPARATION_FAILED'};
  state.status='preparation-failed';save();
  await event('failed',`${id}: ${state.failure.step} failed (${state.failure.code}); no deployment was started.`);
  return {status:'failed',id,code:'release-preparation-failed'};
 }
 const compose=literalComposeText(pinned,config.domains);
 try {
  if(resumingRollback)throw Error('Resume the interrupted rollback.');
  state.status='deploying';save();
  await once('prepared',()=>ops.prepare(secrets,{id,built,kernel,features,bridges,compose,dir}));
  // Mark the mutation BEFORE sending it: an ambiguous response must roll back.
  state.mutationStarted=true;save();
  await once('compose-written',()=>ops.writeCompose(secrets,compose));
  await once('deploy',()=>ops.deploy(secrets));
  await once('checks',async()=>{const r=await ops.checks(secrets,{id,pinned,kernel,bridges,built});if(!r?.ok)throw Error('Post-deployment checks failed.');return r;});
  state.status='live';save();await event('live',`${id}: deployed and verified.`);
  return {status:'live',id,commit:state.pin};
 } catch(error) {
  state.failure={step:state.activeStep,code:/^[A-Z_]+$/.test(error.code??'')?error.code:'DEPLOYMENT_FAILED'};
  // Even preparation failures may leave stopped containers; restore the exact
  // former API configuration and let Coolify reconcile it, without deleting volumes.
  state.status='rolling-back';save();
  let restored=false;
  try{
   await ops.restoreCompose(secrets,live);
   await ops.deploy(secrets);
   const check=await ops.checks(secrets,{rollback:true,live});
   if(!check?.ok)throw Error('Rollback checks failed.');
   restored=true;
  }catch{state.status='rollback-failed';}
  state.status=restored?'rolled-back':'rollback-failed';save();
  await event('failed',`${id}: ${state.failure.step} failed (${state.failure.code}); ${restored?'previous compose restored and verified':'rollback requires attention'}.`);
  // External API error bodies can contain secrets. Only a bounded internal code leaves this layer.
  return {status:state.status,id,code:'automatic-deployment-failed'};
 }
}
