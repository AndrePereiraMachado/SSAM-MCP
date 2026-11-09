// The watcher round of a backend window (window 4x4, S2: C:\t\r5\janela-4x4\DESENHO.md 2, 5.3, 7). One lane per round:
//   - a retirement that is due (window.mjs dueRetirement) goes first: a compose-only round (no build, no test, no gate), the
//     retired ODC backend leaves or the retired O11 version leaves the served list (its kernel stays in the images until the
//     next O11 rebuild);
//   - then the new version of a lane, ODC first: an ODC round builds ONE image (the new backend, with every served O11
//     kernel); an O11 round rebuilds EVERY backend's image (the new kernel set), smokes each backend and pins every digest.
//     The lane's oldest version beyond keep enters "retiring" with graceDays (window.mjs rotateLane);
//   - the reference-app gate (FolhaPonto + VisitaCerta from zero must publish) runs for a round that adds a version, for its
//     lane only, after the smoke and before any deploy. Not configured, the round waits (REFERENCE_GATE_UNCONFIGURED): it
//     never deploys without it. A retirement round runs no gate.
// The owner hears window-retiring (a version entered its grace) and window-retired (a version left) with the customers seen on
// it; the release journal resends an event that did not reach him (automatic.mjs notify).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {releaseAutomatically,releaseEvent} from './automatic.mjs';
import {LANES,STUDIO_NAME,planWindow,readyCandidates,servedOf,newestServed,windowPolicy,dueRetirement,retireDue,rotateLane,rebuildLane,laneRounds,retireRoundId,defaultO11,backendId,compareFailures,featuresLine,failureText,affectedText,composeText,compareVersion} from './window.mjs';
import {CLIENT_BRIDGE_CODE,bridgeMode,serverOnlyGate,o11Proofs} from './server-only.mjs';
import {EnvironmentError,readAttempts,writeAttempt,remind,noticeNow,laneChecks,reviewedRelease,clientBridgeError,archive,featuresNotice,wasCut,timedOut,noteWaiting,OWNER_WAITS} from './pipeline.mjs';
import {odcBinaryCheck} from './odc-binary.mjs';
import {generateCompose} from '../coolify/gen-compose.mjs';

const hours=(now,at)=>(now-Date.parse(at))/3600000;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const writeJson=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');};
// The customers of a window change as the files keep them: never a token id, only a short hash of it (one customer seen on
// two versions reads as one), the customer label and the Studio.
export const affectedRecord=affected=>(affected??[]).map(({token,...a})=>({...a,client:createHash('sha256').update(String(token)).digest('hex').slice(0,12)}));
// The default O11 kernel the live window runs (kernel.json o11 of its backends), or null.
export const liveDefaultO11=live=>{const all=[...new Set(Object.values(live?.kernels??{}).map(k=>k?.o11).filter(Boolean))];return all.length===1?all[0]:null;};

// What a round of a backend window would do, without side effects. inputs(round) -> the inputs that make a failed round worth
// retrying (main's head and the Studio build).
export function decideWindow({manifest,observed,state,attempts,inputs,now=Date.now(),retryHours=12,laneWaitHours=24,testEnvLimit=3}){
 const plan=planWindow(manifest,observed,state);
 const waiting={installers:plan.candidates.filter(c=>c.requiresInstallation),requested:plan.requested.filter(r=>!plan.candidates.some(c=>c.lane===r.lane&&c.version===r.version&&!c.requiresInstallation))};
 const skipped=[];
 const due=dueRetirement(manifest,now);
 if(due){
  const id=retireRoundId(due.lane,due.version),a=attempts[id],want={retireAt:due.retireAt};
  const run={action:'run',kind:'retire',lane:due.lane,version:due.version,id,plan,waiting,inputs:want,previous:a??null,skipped};
  if(!a||a.retry||['deferred','running'].includes(a.status))return run;
  if(a.rollbackLatch)skipped.push({id,lanes:[due.lane],why:'failed'});
  else if(a.status==='failed'&&hours(now,a.at)>=retryHours)return run;
  else if(['approved','closed'].includes(a.status)&&!same(a.inputs,want))return run;
  else if(a.status!=='approved'&&a.status!=='closed')skipped.push({id,lanes:[due.lane],why:a.status});
 }
 const rounds=laneRounds(readyCandidates(plan));
 if(!rounds.length)return {action:skipped.length?'failed':waiting.installers.length||waiting.requested.length?'waiting-for-studio':'idle',plan,waiting,skipped,id:skipped[0]?.id};
 for(const [i,r] of rounds.entries()){
  const a=attempts[r.id],want=inputs(r),others=i<rounds.length-1;
  const run={action:'run',kind:'add',lane:r.lane,version:r.version,candidate:r.candidate,id:r.id,plan,waiting,inputs:want,previous:a??null,skipped};
  if(!a||a.retry)return run;
  if(a.rollbackLatch){if(!same(a.inputs?.studios,want.studios))return run;skipped.push({id:r.id,lanes:[r.lane],why:'failed'});continue;}
  if(a.status==='deferred'){
   // A lane that waits for the owner (a client bridge, the agent release, the reference-app gate) or longer than laneWaitHours
   // lets the other lane go on; with nothing else to run it is checked again.
   const long=OWNER_WAITS[a.code]||hours(now,a.laneSince?.[r.lane]??a.firstDeferredAt??a.at)>=laneWaitHours;
   if((a.testEnvRuns??0)>=testEnvLimit&&same(a.inputs,want)){skipped.push({id:r.id,lanes:[r.lane],why:'held'});continue;}
   if(others&&long&&hours(now,a.at)<retryHours){skipped.push({id:r.id,lanes:[r.lane],why:'deferred'});continue;}
   return run;
  }
  if(a.status==='running')return run;
  if(a.status==='failed'){if(!same(a.inputs,want)&&hours(now,a.at)>=retryHours)return run;skipped.push({id:r.id,lanes:[r.lane],why:'failed'});continue;}
  if(a.status==='closed'&&!same(a.inputs,want))return run;
  skipped.push({id:r.id,lanes:[r.lane],why:a.status});
 }
 const failed=skipped.find(s=>s.why==='failed'),held=skipped.find(s=>s.why==='held');
 return {action:failed?'failed':held?'held':'idle',plan,waiting,skipped,id:(failed??held)?.id,attempt:(failed??held)?attempts[(failed??held).id]:undefined};
}

// The reference-app gate of a lane round (owner decision 7): config.referenceGate {command, args, timeoutMinutes} run by the
// runtime (ops.referenceGate), which must report both reference apps published from zero. Not configured, or no runner: the
// round waits (fails closed). A rehearsal records the gate's state and never deploys anyway.
export const REFERENCE_APPS=Object.freeze(['FolhaPonto','VisitaCerta']);
export async function referenceGate(config,ops,{lane,version,manifest,builts,dir}){
 // A rehearsal never runs it (the gate publishes apps through a server): it records whether the gate is ready.
 if(config.rehearsal||!config.referenceGate||typeof ops.referenceGate!=='function'){
  const state={ran:false,configured:!!config.referenceGate,runner:typeof ops.referenceGate==='function',lane,version,...(config.rehearsal?{rehearsal:true}:{})};
  writeJson(path.join(dir,'reference-gate.json'),state);
  if(config.rehearsal)return state;
  throw new EnvironmentError(`The reference-app gate (${REFERENCE_APPS.join(' + ')} from zero must publish) is required before ${STUDIO_NAME[lane]} ${version} is deployed, and ${!config.referenceGate?'referenceGate is not configured in the watcher configuration':'this runtime has no reference-gate runner'}. Production is not touched; the round retries.`,'reference-gate-unconfigured',[lane]);
 }
 const r=await ops.referenceGate({lane,version,manifest,builts,dir});
 const apps=Object.fromEntries((r?.apps??[]).map(a=>[a.name,a]));
 const missing=REFERENCE_APPS.filter(n=>apps[n]?.published!==true);
 const state={ran:true,lane,version,ok:!!r?.ok&&!missing.length,apps:REFERENCE_APPS.map(n=>({name:n,published:apps[n]?.published===true,seconds:apps[n]?.seconds??null,error:apps[n]?.error??null}))};
 writeJson(path.join(dir,'reference-gate.json'),state);
 if(r?.environmental)throw new EnvironmentError(`The reference-app gate did not run (${r.error??'environment'}); the round retries.`,'reference-gate-environment',[lane]);
 if(!state.ok)throw Object.assign(Error(`The reference-app gate failed for ${STUDIO_NAME[lane]} ${version}: ${missing.length?missing.join(' and ')+' did not publish':'the gate reported a failure'}. Nothing is deployed; see ${path.join(dir,'reference-gate.json')}.`),{lanes:[lane],code:'reference-gate-failed'});
 return state;
}

export async function runWindowVigia(config,ops){
 const now=config.now??Date.now(),outDir=config.outDir,log=ops.log??(()=>{});
 const head=config.head??null;
 const inputs=r=>({head,studios:{[r.lane]:r.candidate.fullVersion??r.candidate.version}});
 const decideNow=()=>decideWindow({manifest:config.manifest,observed:config.observed,state:config.state,attempts:readAttempts(outDir),inputs,now,retryHours:config.retryHours??12,laneWaitHours:config.laneWaitHours??24,testEnvLimit:config.testEnvLimit??3});
 const decision=decideNow(),plan=decision.plan;
 if(config.dryRun)return {status:'dry-run',decision:{action:decision.action,round:decision.id??null,kind:decision.kind??null,skipped:decision.skipped??[]},plan,retiring:config.manifest.retiring??null};
 log(`decision: ${decision.action}${decision.id?' '+decision.id:''}`);
 await noteWaiting(config,ops,decision.waiting,now);
 if(decision.action==='idle'||decision.action==='waiting-for-studio')return {status:decision.action,plan};
 if(decision.action==='failed'){
  if(decision.id)await remind(outDir,'failed:'+decision.id,'SSAM: Studio version checks failed',`${decision.id}: ${path.join(outDir,decision.id,'FALHAS.md')}`,ops,{now:noticeNow(config),link:path.join(outDir,decision.id,'FALHAS.md')});
  return {status:'failed',id:decision.id??null,dir:decision.id?path.join(outDir,decision.id):null,plan};
 }
 if(decision.action==='held'){
  await remind(outDir,'held:'+decision.id,'SSAM: Studio version tests do not run',`${decision.id}: the candidate tests timed out or ran nothing ${decision.attempt?.testEnvRuns} times in a row; the watcher stops retrying them until main or the Studio changes.`,ops,{now:noticeNow(config),link:path.join(outDir,decision.id,'AGUARDANDO.md')});
  return {status:'held',id:decision.id,plan};
 }
 const result=await runWindowAttempt(config,ops,decision,now);
 // A lane that now waits lets the other lane go on in the same round (one more attempt at most).
 if(result.status==='deferred'&&result.code!=='round-timeout'){
  const again=decideNow();
  if(again.action==='run'&&again.id!==result.id&&again.skipped?.some(s=>s.id===result.id)){log(`decision: run ${again.id} (${result.id} waits)`);return runWindowAttempt(config,ops,again,now);}
 }
 return result;
}


export async function runWindowAttempt(config,ops,decision,now){
 const {id,kind,lane,version:v}=decision,outDir=config.outDir,dir=path.join(outDir,id),log=ops.log??(()=>{}),base=config.manifest;
 const policy=windowPolicy(config),tokens=config.state?.tokens;
 const waited=decision.previous?.status==='deferred'?decision.previous:null;
 if(!waited)archive(dir,decision.previous);fs.mkdirSync(dir,{recursive:true});
 if(waited)for(const name of ['AGUARDANDO.md','FALHAS.md'])fs.rmSync(path.join(dir,name),{force:true});
 for(const s of decision.skipped??[])log(`${s.id} ${s.why==='deferred'?'waits':s.why}; trying ${id}`);
 const attempt={id,round:{kind,lane,version:v},pair:{lanes:[lane]},inputs:decision.inputs,status:'running',at:new Date(now).toISOString(),baseManifest:base,replayed:[],
  ...(waited?{deferrals:waited.deferrals??1,firstDeferredAt:waited.firstDeferredAt??waited.at,laneSince:waited.laneSince??{},testEnvRuns:waited.testEnvRuns??0}:{})};
 writeAttempt(outDir,attempt);
 const runtimes={},comparisons={};
 try{
  // A backend window is deployed by the automatic release only: the pair window's proposal and -Approve do not apply to it.
  if(!config.automatic)throw new EnvironmentError('A backend window (window 4x4) runs with automatic: true only (the proposal and -Approve flow is the pair window\'s).','window-needs-automatic',[lane]);
  const secrets=await ops.secrets();
  if(kind==='retire'){
   const next=retireDue(base,{now,keep:policy.keep,tokens});
   if(!next||next.retired[0].version!==v){writeAttempt(outDir,{...attempt,status:'closed',code:'not-due',endedAt:new Date().toISOString()});return {status:'idle',id};}
   writeJson(path.join(dir,'affected.json'),{retired:next.retired,affected:affectedRecord(next.affected)});
   if(ops.capacityPreflight)await ops.capacityPreflight(next.manifest);
   const window={kind,lane,version:v,builts:[],kernels:null,defaultO11:null,retiring:[],retired:next.retired,affected:affectedRecord(next.affected),notifyAffected:policy.notifyAffected,...(next.hotPinDropped?{hotPinDropped:next.hotPinDropped}:{})};
   const release={id,dir,attempt:attempt.at,baseline:config.liveBaseline,built:null,manifest:next.manifest,kernel:null,bridges:null,bridgeMode:null,features:null,featuresProvenance:null,bundles:null,window};
   return await finishRelease(config,ops,{release,attempt,dir,id,smoke:null});
  }
  await releaseEvent(outDir,ops,'detected',id,`${id}: a new ${STUDIO_NAME[lane]} was detected.`,secrets,attempt.at);
  const c=decision.candidate,liveDefault=liveDefaultO11(config.liveBaseline),dflt=defaultO11(base,{lane,liveDefault});
  // The window this round would make, before any build (pending images): capacity, the kernel set and the backends to build.
  // A rehearsal of a version the window already serves (-RehearseCurrent, decision.rehearse) rebuilds what the lane's round
  // would build (window.mjs rebuildLane) and rotates nothing.
  const rotate=images=>decision.rehearse?{manifest:rebuildLane(base,lane,lane==='odc'?{...images,odc:v}:images),retiring:[],retired:[],affected:[]}:rotateLane(base,lane,v,{now,graceDays:policy.graceDays,keep:policy.keep,tokens,images});
  const pending={image:'pending',tag:'pending'},preview=rotate(lane==='odc'?pending:Object.fromEntries(base.backends.map(b=>[b.odc,pending])));
  if(ops.capacityPreflight)await ops.capacityPreflight(preview.manifest);
  const pair={odc:lane==='odc'?v:newestServed(base,'odc'),o11:lane==='o11'?v:dflt,lanes:[lane],candidates:[c]};
  await ops.preflight({pair,id,dir});
  const mode=bridgeMode(config);
  if(mode!=='server-only')throw new EnvironmentError(`A backend window supports bridgeMode server-only only (configured: ${mode}); production is not touched.`,'bridge-mode-unsupported',[lane]);
  const agentRelease=await reviewedRelease(ops,pair);
  const proofs=await (ops.o11Proofs??o11Proofs)(config);
  for(const r of proofs.refused)log(`o11BridgeProven ${r.version} refused: ${r.why}`);
  const gateConfig={...config,o11BridgeProven:proofs.proven,o11ProofRefusals:proofs.refused};
  await laneChecks(gateConfig,ops,pair,runtimes,log,agentRelease,[]);
  await ops.dockerReady();
  // The bundles: the candidate, every O11 Studio the images carry (the next served list: in an ODC round the live one) and the
  // ODC Studio of each backend this round builds.
  const candidate=await ops.bundle(c,dir);log(`bundle ${lane} ${candidate.version}: ${candidate.file} sha256 ${candidate.sha256}`);
  const kernels=[...(lane==='odc'?base:preview.manifest).o11.served].sort(compareVersion);
  const targets=lane==='odc'?[v]:preview.manifest.backends.map(b=>b.odc);
  const o11Bundles=[];for(const k of kernels)o11Bundles.push(lane==='o11'&&k===v?candidate:await ops.companion('o11',k,dir));
  const odcBundles={};for(const odc of targets)odcBundles[odc]=lane==='odc'&&odc===v?candidate:await ops.companion('odc',odc,dir);
  const featuresProvenance=lane==='odc'?candidate.featuresProvenance??null:null;
  if(featuresProvenance){attempt.featuresProvenance=featuresProvenance;log(`features odc ${featuresProvenance.version}: ${featuresLine(featuresProvenance)}`);if(featuresProvenance.mode!=='exact')await featuresNotice(config,ops,featuresProvenance);}
  // The server-only gate on the published agent packs, for the lane's new Studio with the other lane's default.
  const baseline={odc:await ops.companion('odc',newestServed(base,'odc'),dir),o11:await ops.companion('o11',dflt,dir)};
  const side=lane==='odc'?{odc:candidate,o11:baseline.o11}:{odc:baseline.odc,o11:candidate};
  const studios=Object.fromEntries(LANES.map(l=>[l,{version:side[l].version,fullVersion:side[l].fullVersion??null,tfm:l===lane?c.tfm??side[l].tfm??null:side[l].tfm??null}]));
  const served=Object.fromEntries(LANES.map(l=>[l,servedOf(preview.manifest,l)]));
  const gate=serverOnlyGate({config:gateConfig,release:agentRelease,pair,studios,servedKernels:await ops.servedKernels(base),served});
  if(gate.gaps.length)throw clientBridgeError(gate.gaps,pair);
  log(`server-only kernel ${JSON.stringify(gate.kernel)}; published pack hello odc ${gate.hello.pack.odcBridge}, o11 built for ${gate.hello.pack.o11BuiltFor}`);
  if(lane==='odc'){
   const check=await (ops.odcBinary??odcBinaryCheck)({references:agentRelease.odc.references,candidate,installed:c.studio??null,served:servedOf(base,'odc'),companion:(l,x)=>ops.companion(l,x,dir)});
   writeJson(path.join(dir,'odc-references.json'),check);
   if(check.gaps.length)throw clientBridgeError([{lane:'odc',version:v,tfm:studios.odc.tfm,why:`the published ODC bridge's Studio references do not resolve as in the served ODC Studio ${check.reference??'(none)'}: ${check.gaps.join('; ')}`}],pair);
  }
  writeJson(path.join(dir,'bundles.json'),{candidate,o11:o11Bundles,odc:odcBundles,baseline});
  let before;
  try{before=await ops.test(lane,'baseline',baseline,dir);}
  catch(e){if(e.environmental)throw e;throw new EnvironmentError(`The ${lane} baseline (the served default's frozen copy) did not run: ${e.message}`,'baseline',[lane]);}
  if(!before.passed)throw new EnvironmentError(`The ${lane} baseline passed ${before.passed}/${before.total}: the suite does not run on this machine now.`,'baseline',[lane]);
  const after=await ops.test(lane,'candidate',side,dir);
  if(!after.passed)throw Object.assign(Error(`The ${lane} suite did not run on the candidate: ${after.passed}/${after.total} passed (baseline ${before.passed}/${before.total}).`),{lanes:[lane]});
  comparisons[lane]={baseline:before,current:after,...compareFailures(before,after)};
  writeJson(path.join(dir,'comparison.json'),comparisons);
  log(`tests ${lane}: baseline ${before.passed}/${before.total}, candidate ${after.passed}/${after.total}, new failures ${comparisons[lane].newFailures.length}`);
  if(comparisons[lane].newFailures.length)throw Object.assign(Error(`New kernel test failures:\n${lane}:\n`+comparisons[lane].newFailures.map(n=>'  '+n).join('\n')),{lanes:[lane]});
  ops.bridgeKernel=gate.kernel;ops.packHello=gate.hello;ops.offerExpect=null;
  // The images: one per backend this round builds, each with every O11 kernel of the set and the default for its own processes.
  const builts=[];
  for(const odc of targets){
   const built=await ops.buildBackend({odc,kernels,defaultO11:dflt},{odc:odcBundles[odc],o11:o11Bundles},dir);
   log(`image ${backendId(odc)}: ${built.tag} sha256 ${built.sha256}`);builts.push(built);
  }
  writeJson(path.join(dir,'image.json'),builts);
  const images=lane==='odc'?{image:builts[0].image,tag:builts[0].tag}:Object.fromEntries(builts.map(b=>[b.odc,{image:b.image,tag:b.tag}]));
  const next=rotate(images);
  writeJson(path.join(dir,'affected.json'),{retiring:next.retiring,retired:next.retired,affected:affectedRecord(next.affected)});
  const nextServed=Object.fromEntries(LANES.map(l=>[l,servedOf(next.manifest,l)]));
  const smokes={};
  for(const b of builts){
   const smoke=await ops.smokeBackend(b,{odc:odcBundles[b.odc],o11:o11Bundles},nextServed,path.join(dir,'smoke-'+backendId(b.odc)));smokes[backendId(b.odc)]=smoke;
   writeJson(path.join(dir,'smoke.json'),smokes);
   if(!smoke.ok&&smoke.refused?.length)throw Object.assign(Error(`The built image of ${backendId(b.odc)} refuses the published agent pack's hello that the server-only gate accepted (${smoke.refused.map(r=>`${r.lane} ${r.code}`).join(', ')}). Nothing is deployed.`),{lanes:[lane],code:'smoke-refused-pack'});
   if(!smoke.ok)throw Object.assign(Error(`Image smoke of ${backendId(b.odc)} failed: ${smoke.error??'see smoke.json'}`),{lanes:[lane]});
   if(smoke.publishedPack!==true)throw Object.assign(Error(`Image smoke of ${backendId(b.odc)} did not present the published agent pack; nothing is deployed.`),{lanes:[lane]});
  }
  const reference=await referenceGate(config,ops,{lane,version:v,manifest:next.manifest,builts,dir});
  // kernel.json of each backend this round prepares: the new backend gets the gate's kernel, an O11 round moves the default O11
  // kernel of every backend (the live kernel of each, its own ODC protocol kept).
  const live=config.liveBaseline?.kernels??{};
  const kernelJson=Object.fromEntries(targets.map(odc=>[backendId(odc),lane==='odc'?{...gate.kernel,odc,o11:dflt}:{...(live[backendId(odc)]??gate.kernel),odc,o11:dflt}]));
  const own=backendId(lane==='odc'?v:newestServed(next.manifest,'odc'));
  const window={kind,lane,version:v,builts,kernels:kernelJson,defaultO11:dflt,liveDefaultO11:liveDefault,o11Kernels:kernels,retiring:next.retiring,retired:next.retired,affected:affectedRecord(next.affected),notifyAffected:policy.notifyAffected,referenceGate:reference,prepare:targets.map(backendId),...(next.hotPinDropped?{hotPinDropped:next.hotPinDropped}:{})};
  const release={id,dir,attempt:attempt.at,baseline:config.liveBaseline,built:builts.find(b=>backendId(b.odc)===own)??builts[0],manifest:next.manifest,kernel:kernelJson[own]??{...gate.kernel,o11:dflt},
   bridges:{mode:'server-only',offers:[],kernel:gate.kernel,hello:gate.hello,agentRelease:agentRelease.commit,o11Proofs:{}},bridgeMode:mode,features:lane==='odc'?candidate.features:null,featuresProvenance,bundles:{candidate,o11:o11Bundles,odc:odcBundles},window};
  const all=Object.values(smokes);
  return await finishRelease(config,ops,{release,attempt,dir,id,smoke:{...all[0],publishedPack:all.every(x=>x.publishedPack===true),backends:smokes}});
 }catch(error){
  if(wasCut(outDir,attempt)||error.code==='round-timeout'){
   if(!wasCut(outDir,attempt))timedOut(config,attempt);
   return {status:'deferred',id,dir,code:'round-timeout',error:'round time limit'};
  }
  const environmental=!!error.environmental,notice=path.join(dir,environmental?'AGUARDANDO.md':'FALHAS.md'),lanes=error.lanes?.length?error.lanes:[lane];
  if(config.automatic&&!environmental)await releaseEvent(outDir,ops,'failed',id,`${id}: build or verification failed before deployment.`,await ops.secrets(),attempt.at);
  fs.writeFileSync(notice,failureText({id,error:String(error.message),environmental,dir,retry:config.retryHours??12,config}));
  const laneSince=environmental?Object.fromEntries(lanes.map(l=>[l,attempt.laneSince?.[l]??attempt.at])):undefined;
  writeAttempt(outDir,{...attempt,status:environmental?'deferred':'failed',...(environmental?{deferrals:(attempt.deferrals??0)+1,firstDeferredAt:attempt.firstDeferredAt??attempt.at,deferredLanes:lanes,laneSince,laneCodes:error.laneCodes??null,testEnvRuns:error.code==='test-environment'?(attempt.testEnvRuns??0)+1:0}:{failedLanes:lanes}),error:String(error.message),code:error.code??null,runtimes,endedAt:new Date().toISOString()});
  log(`${environmental?'deferred':'failed'}: ${error.message}`);
  const waitCode=OWNER_WAITS[error.code],reason=waitCode?createHash('sha256').update(error.code+'\n'+String(error.message)).digest('hex').slice(0,12):null;
  if(config.automatic&&reason){try{await releaseEvent(outDir,ops,'waiting',id,`${id}: ${error.message.split('\n')[0]}`,await ops.secrets(),'reason-'+reason,waitCode);}catch(e){log(`the owner was not reached for ${error.code}: ${e.message}`);}}
  const key=(environmental?'deferred:':'failed:')+id+(environmental?':'+(error.code??''):'')+(reason?':'+reason:'');
  await remind(outDir,key,error.code===CLIENT_BRIDGE_CODE?'SSAM: client bridge update required':environmental?'SSAM: Studio version round waiting':'SSAM: Studio version checks failed',`${id}: ${error.message.split('\n')[0]}`,ops,{now:noticeNow(config),link:notice});
  return {status:environmental?'deferred':'failed',id,dir,error:String(error.message),code:error.code??null};
 }
}

// release.json, then the rehearsal's end or the automatic release (automatic.mjs releaseAutomatically, which knows
// release.window). The compose of the next window goes with the evidence.
async function finishRelease(config,ops,{release,attempt,dir,id,smoke}){
 const {writeJournal}=await import('./journal.mjs');
 fs.writeFileSync(path.join(dir,'compose.coolify.yml'),composeText(generateCompose(release.manifest)));
 writeJournal(path.join(dir,'release.json'),release);
 if(config.rehearsal){
  const rehearsed=await config.rehearsal.finish(config,ops,{release,smoke});
  writeAttempt(config.outDir,{...attempt,status:'rehearsed',built:release.built,builts:release.window.builts,endedAt:new Date().toISOString()});
  return {...rehearsed,dir};
 }
 const result=await releaseAutomatically(config,ops,release);
 const digest=release.built?'sha256:'+release.built.sha256:null;
 if(result.status==='live')writeAttempt(config.outDir,{...attempt,status:'approved',built:release.built,builts:release.window.builts,pinCommit:result.commit,approved:{at:new Date().toISOString(),digest,commit:result.commit}});
 else if(['idle','abandoned'].includes(result.status))writeAttempt(config.outDir,{...attempt,status:'closed',code:result.status});
 else writeAttempt(config.outDir,{...attempt,status:result.status==='deferred'?'deferred':'failed',built:release.built,rollbackLatch:['rolled-back','rollback-failed'].includes(result.status),code:result.code,failedLanes:[release.window.lane]});
 return {...result,dir};
}

// The owner's lines of a window change, sent after it is live (automatic.mjs): a version that entered its grace, a version that
// left, and the customers seen on them (names only with notifyAffected).
export function windowNotices(w){
 const out=[],who=list=>affectedText((w.affected??[]).filter(a=>list.some(x=>x.lane===a.lane&&x.version===a.version)),{notifyAffected:w.notifyAffected!==false});
 const retiring=w.retiring&&!Array.isArray(w.retiring)?Object.entries(w.retiring).map(([lane,r])=>({lane,...r})):(w.retiring??[]);
 const entering=retiring.filter(r=>!(w.baseRetiring?.[r.lane]?.version===r.version));
 if(entering.length)out.push({name:'window-retiring',code:'WINDOW_RETIRING',message:entering.map(r=>`${STUDIO_NAME[r.lane]} ${r.version} leaves SSAM on ${String(r.retireAt).slice(0,10)} (customers: ${who([r])})`).join('; ')+'.'});
 if(w.retired?.length)out.push({name:'window-retired',code:'WINDOW_RETIRED',message:w.retired.map(r=>`${STUDIO_NAME[r.lane]} ${r.version} left SSAM${r.early?' before its date (a newer version entered)':''} (customers: ${who([r])})`).join('; ')+'.'});
 return out;
}
