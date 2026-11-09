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
import {releaseAutomatically,releaseEvent,windowAgain,windowStillNeeded,keepNotice,KEPT_NOTICES} from './automatic.mjs';
import {readJournal,writeJournal,durableWrite} from './journal.mjs';
import {LANES,STUDIO_NAME,planWindow,readyCandidates,servedOf,newestServed,windowPolicy,dueRetirement,retireDue,rotateLane,rebuildLane,laneRounds,retireRoundId,defaultO11,backendId,compareFailures,featuresLine,failureText,affectedText,composeText,compareVersion,ownerCommand,affectedRecord} from './window.mjs';
import {CLIENT_BRIDGE_CODE,bridgeMode,serverOnlyGate,o11Proofs} from './server-only.mjs';
import {EnvironmentError,readAttempts,writeAttempt,remind,noticeNow,laneChecks,reviewedRelease,clientBridgeError,archive,featuresNotice,wasCut,timedOut,noteWaiting,OWNER_WAITS} from './pipeline.mjs';
import {odcBinaryCheck} from './odc-binary.mjs';
import {generateCompose,isBackendManifest} from '../coolify/gen-compose.mjs';

const hours=(now,at)=>(now-Date.parse(at))/3600000;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const writeJson=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');};
// The customers of a window change as the files keep them (window.mjs affectedRecord).
export {affectedRecord};
// The default O11 kernel the live window runs (kernel.json o11 of its backends), or null.
export const liveDefaultO11=live=>{const all=[...new Set(Object.values(live?.kernels??{}).map(k=>k?.o11).filter(Boolean))];return all.length===1?all[0]:null;};

// What a round of a backend window would do, without side effects. inputs(round) -> the inputs that make a failed round worth
// retrying (main's head and the Studio build). superseded: the proposals waiting for the owner whose version a newer one of
// its lane replaced (a newer ready version, or the live window serves it or a newer one); runWindowVigia closes them and tells
// the owner (review B6).
export function decideWindow(input){
 const decision=decideLanes(input),{manifest,attempts}=input,rounds=laneRounds(readyCandidates(decision.plan));
 const newer=a=>rounds.filter(r=>r.lane===a.round.lane&&compareVersion(r.version,a.round.version)>0).map(r=>r.version).sort(compareVersion).at(-1);
 const superseded=Object.values(attempts).filter(a=>a.status==='proposed'&&a.round?.kind==='add'&&(newer(a)||servedOf(manifest,a.round.lane).some(v=>compareVersion(v,a.round.version)>=0)))
  .map(a=>({id:a.id,lane:a.round.lane,version:a.round.version,by:newer(a)??newestServed(manifest,a.round.lane)}));
 return superseded.length?{...decision,superseded}:decision;
}
function decideLanes({manifest,observed,state,attempts,inputs,now=Date.now(),retryHours=12,laneWaitHours=24,testEnvLimit=3}){
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
  // A retirement whose deploy was abandoned (deferred too long) is due all the same: it runs again after retryHours (review B2).
  else if(a.status==='closed'&&a.code==='abandoned'&&hours(now,a.endedAt??a.at)>=retryHours)return run;
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
  // Waiting for the owner's reference-app test (referenceGate mode owner): his -Approve releases what was built, -Reject drops it.
  if(a.status==='proposed'){if(a.gateApproved)return {...run,action:'release'};skipped.push({id:r.id,lanes:[r.lane],why:'proposed'});continue;}
  if(a.status==='failed'){if(!same(a.inputs,want)&&hours(now,a.at)>=retryHours)return run;skipped.push({id:r.id,lanes:[r.lane],why:'failed'});continue;}
  if(a.status==='closed'&&!same(a.inputs,want))return run;
  skipped.push({id:r.id,lanes:[r.lane],why:a.status});
 }
 const failed=skipped.find(s=>s.why==='failed'),held=skipped.find(s=>s.why==='held'),proposed=skipped.find(s=>s.why==='proposed');
 const which=failed??held??proposed;
 return {action:failed?'failed':held?'held':proposed?'pending-approval':'idle',plan,waiting,skipped,id:which?.id,attempt:which?attempts[which.id]:undefined};
}

// The reference-app gate of a lane round (owner decision 7), config.referenceGate:
//   {mode: "owner"} (the default, until an automated runner exists): the round stops in the owner-approval state ("proposed",
//     the same -Approve/-Reject of the pair proposals) and tells him the lane, the images and what to test (FolhaPonto and
//     VisitaCerta from zero on that lane's new version); his -Approve lets the next round deploy what was built;
//   {mode: "command", command, args, timeoutMinutes}: the runtime's runner (ops.referenceGate) must report both reference apps
//     published from zero; no command or no runner: the round waits (fails closed).
// A retirement round never has the gate; a rehearsal records its state and never runs it or waits.
export const referenceGateMode=config=>{
 const g=config.referenceGate??{mode:'owner'},mode=g.mode??(g.command?'command':null);
 if(!['owner','command'].includes(mode))throw Object.assign(Error('Invalid referenceGate: {mode: "owner"} or {mode: "command", command, args, timeoutMinutes}.'),{code:'REFERENCE_GATE_INVALID'});
 return mode;
};
export const REFERENCE_APPS=Object.freeze(['FolhaPonto','VisitaCerta']);
export async function referenceGate(config,ops,{lane,version,manifest,builts,dir}){
 const mode=referenceGateMode(config);
 // A rehearsal never runs it (the gate publishes apps through a server) nor waits: it records whether the gate is ready.
 if(config.rehearsal){const state={mode,ran:false,rehearsal:true,lane,version,...(mode==='command'?{configured:!!config.referenceGate?.command,runner:typeof ops.referenceGate==='function'}:{})};writeJson(path.join(dir,'reference-gate.json'),state);return state;}
 if(mode==='owner'){const state={mode,ran:false,waitOwner:true,lane,version,apps:[...REFERENCE_APPS]};writeJson(path.join(dir,'reference-gate.json'),state);return state;}
 if(!config.referenceGate?.command||typeof ops.referenceGate!=='function'){
  writeJson(path.join(dir,'reference-gate.json'),{mode,ran:false,configured:!!config.referenceGate?.command,runner:typeof ops.referenceGate==='function',lane,version});
  throw new EnvironmentError(`The reference-app gate (${REFERENCE_APPS.join(' + ')} from zero must publish) is required before ${STUDIO_NAME[lane]} ${version} is deployed, and ${!config.referenceGate?.command?'referenceGate mode "command" has no command in the watcher configuration':'this runtime has no reference-gate runner'}. Production is not touched; the round retries.`,'reference-gate-unconfigured',[lane]);
 }
 const r=await ops.referenceGate({lane,version,manifest,builts,dir});
 const apps=Object.fromEntries((r?.apps??[]).map(a=>[a.name,a]));
 const missing=REFERENCE_APPS.filter(n=>apps[n]?.published!==true);
const state={mode,ran:true,lane,version,ok:!!r?.ok&&!missing.length,apps:REFERENCE_APPS.map(n=>({name:n,published:apps[n]?.published===true,seconds:apps[n]?.seconds??null,error:apps[n]?.error??null}))};
 writeJson(path.join(dir,'reference-gate.json'),state);
 if(r?.environmental)throw new EnvironmentError(`The reference-app gate did not run (${r.error??'environment'}); the round retries.`,'reference-gate-environment',[lane]);
 if(!state.ok)throw Object.assign(Error(`The reference-app gate failed for ${STUDIO_NAME[lane]} ${version}: ${missing.length?missing.join(' and ')+' did not publish':'the gate reported a failure'}. Nothing is deployed; see ${path.join(dir,'reference-gate.json')}.`),{lanes:[lane],code:'reference-gate-failed'});
 return state;
}

export async function runWindowVigia(config,ops){
 const now=config.now??Date.now(),outDir=config.outDir,log=ops.log??(()=>{});
 // Pre-merge guard (S2 R8): a backend-window round only ever runs against a live backend window. An automatic round plans from
 // the live baseline (vigia.mjs round: manifest = live.manifest), so pair-mode production runs the pair flow; should a backend
 // window reach here while production still runs pairs (main's versions.json ahead of the S1 kit), nothing is built,
 // retired, prepared or written: the round waits (WINDOW_MIGRATION_PENDING) and the owner is told.
 if(config.automatic&&!config.dryRun&&config.liveBaseline&&!isBackendManifest(config.liveBaseline.manifest)){
  log('backend window planned while production runs pairs: waiting for the S1 migration');
  await remind(outDir,'window-migration-pending','SSAM: backend window waits for the S1 migration','The backend window (window 4x4) does not run while production still runs the pair window: nothing was built, retired or deployed. Run the S1 migration kit, then the watcher continues with the backend window.',ops,{now:noticeNow(config)});
  return {status:'waiting',code:'WINDOW_MIGRATION_PENDING'};
 }
 const head=config.head??null;
 const inputs=r=>({head,studios:{[r.lane]:r.candidate.fullVersion??r.candidate.version}});
 const decideNow=()=>decideWindow({manifest:config.manifest,observed:config.observed,state:config.state,attempts:readAttempts(outDir),inputs,now,retryHours:config.retryHours??12,laneWaitHours:config.laneWaitHours??24,testEnvLimit:config.testEnvLimit??3});
 let decision=decideNow();const plan=decision.plan;
 if(config.dryRun)return {status:'dry-run',decision:{action:decision.action,round:decision.id??null,kind:decision.kind??null,skipped:decision.skipped??[],...(decision.superseded?{superseded:decision.superseded}:{})},plan,retiring:config.manifest.retiring??null};
 if(decision.superseded?.length){for(const s of decision.superseded)await expireProposal(config,ops,s);decision=decideNow();}
 log(`decision: ${decision.action}${decision.id?' '+decision.id:''}`);
 await noteWaiting(config,ops,decision.waiting,now);
 if(decision.action==='idle'||decision.action==='waiting-for-studio')return {status:decision.action,plan};
 if(decision.action==='failed'){
  if(decision.id)await remind(outDir,'failed:'+decision.id,'SSAM: Studio version checks failed',`${decision.id}: ${path.join(outDir,decision.id,'FALHAS.md')}`,ops,{now:noticeNow(config),link:path.join(outDir,decision.id,'FALHAS.md')});
  return {status:'failed',id:decision.id??null,dir:decision.id?path.join(outDir,decision.id):null,plan};
 }
 if(decision.action==='pending-approval'){await ownerGateNotice(config,ops,decision.attempt);return {status:'pending-approval',id:decision.id,dir:path.join(outDir,decision.id),plan};}
 if(decision.action==='release')return releaseApproved(config,ops,decision);
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
 // Owner notices not delivered yet stay with the round when its folder is archived (automatic.mjs keepNotice).
 const keptFile=path.join(dir,KEPT_NOTICES),kept=!waited&&fs.existsSync(keptFile)?fs.readFileSync(keptFile):null;
 if(!waited)archive(dir,decision.previous);fs.mkdirSync(dir,{recursive:true});
 if(kept&&!fs.existsSync(keptFile))durableWrite(keptFile,kept);
 if(waited)for(const name of ['AGUARDANDO.md','FALHAS.md'])fs.rmSync(path.join(dir,name),{force:true});
 for(const s of decision.skipped??[])log(`${s.id} ${s.why==='deferred'?'waits':s.why}; trying ${id}`);
 const attempt={id,round:{kind,lane,version:v},pair:{lanes:[lane]},inputs:decision.inputs,status:'running',at:new Date(now).toISOString(),baseManifest:base,replayed:[],
  ...(waited?{deferrals:waited.deferrals??1,firstDeferredAt:waited.firstDeferredAt??waited.at,laneSince:waited.laneSince??{},testEnvRuns:waited.testEnvRuns??0}:{})};
 writeAttempt(outDir,attempt);
 const runtimes={},comparisons={};
 try{
  // A backend window is deployed by the automatic release only: the pair window's proposal branch and its manual owner steps do
  // not apply to it. Its reference-app gate (mode owner, the default) still waits for the owner's -Approve / -Reject.
  if(!config.automatic)throw new EnvironmentError('A backend window (window 4x4) runs with automatic: true only (the proposal branch and manual steps are the pair window\'s; its reference-app gate uses -Approve / -Reject).','window-needs-automatic',[lane]);
  const secrets=await ops.secrets();
  if(kind==='retire'){
   const next=retireDue(base,{now,keep:policy.keep,tokens});
   if(!next||next.retired[0].version!==v){writeAttempt(outDir,{...attempt,status:'closed',code:'not-due',endedAt:new Date().toISOString()});return {status:'idle',id};}
   writeJson(path.join(dir,'affected.json'),{retired:next.retired,affected:affectedRecord(next.affected)});
   if(ops.capacityPreflight)await ops.capacityPreflight(next.manifest);
   // A retirement keeps the live default O11 kernel, by the ODC round's rule (review B12): it writes no kernel.json unless the
   // live defaults are mixed (automatic.mjs alignKernels).
   const window={kind,lane,version:v,builts:[],kernels:null,defaultO11:defaultO11(next.manifest,{lane:'odc',liveDefault:liveDefaultO11(config.liveBaseline)}),retiring:[],retired:next.retired,affected:affectedRecord(next.affected),notifyAffected:policy.notifyAffected,...(next.hotPinDropped?{hotPinDropped:next.hotPinDropped}:{})};
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
  // Each backend records the O11 kernels its image really carries (the build read them back from the image label).
  const images=lane==='odc'?{image:builts[0].image,tag:builts[0].tag,kernels:builts[0].kernels}:Object.fromEntries(builts.map(b=>[b.odc,{image:b.image,tag:b.tag,kernels:b.kernels}]));
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
  if(reference.waitOwner)return await proposeToOwner(config,ops,{release,attempt,dir,id});
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

// The owner's reference-app test (referenceGate mode owner): release.json and the evidence are written, the attempt waits in
// "proposed" (the pair proposals' owner-approval state, -Approve / -Reject), and the owner is told what to test and how to answer.
export function ownerGateText(config,release){
 const w=release.window,id=release.id,images=w.builts.map(b=>`- backend odc-${b.odc}: ${b.image}:${b.tag} (local image, sha256:${b.sha256}; O11 kernels ${(b.kernels??[]).join(', ')}, default ${b.defaultO11??w.defaultO11})`).join('\n');
 return `# Reference-app test: ${STUDIO_NAME[w.lane]} ${w.version} (${id})\n\nThe watcher built and checked this round (candidate tests, image smoke of every backend). Nothing is published or deployed until you approve.\n\nImages:\n${images}\n\nWhat to test: create FolhaPonto and VisitaCerta from zero through SSAM with ${STUDIO_NAME[w.lane]} ${w.version} (the new version of the ${w.lane.toUpperCase()} lane, served by ${w.lane==='odc'?'the new backend odc-'+w.version:'every backend, O11 kernels '+(w.builts[0]?.kernels??[]).join(', ')}); both must publish without error. Time them.\n\nThis window change also: ${(w.retiring??[]).map(r=>`${STUDIO_NAME[r.lane]} ${r.version} enters its grace until ${String(r.retireAt).slice(0,10)}`).concat((w.retired??[]).map(r=>`${STUDIO_NAME[r.lane]} ${r.version} leaves`)).join('; ')||'nothing else'}.\n\nApprove (the next watcher round publishes, pins and deploys exactly these images):\n\n    ${ownerCommand(config,'-Approve '+id)}\n\nRefuse:\n\n    ${ownerCommand(config,'-Reject '+id+' -Reason "<why>"')}\n`;
}
export const ownerGateMessage=(config,release)=>`${release.id}: test FolhaPonto and VisitaCerta from zero on ${STUDIO_NAME[release.window.lane]} ${release.window.version} (images ${release.window.builts.map(b=>'odc-'+b.odc+' '+b.tag+' sha256:'+b.sha256).join(', ')}), then approve: ${ownerCommand(config,'-Approve '+release.id)} or refuse: ${ownerCommand(config,'-Reject '+release.id+' -Reason "<why>"')}`;
async function ownerGateNotice(config,ops,attempt){
 const dir=path.join(config.outDir,attempt.id),file=path.join(dir,'release.json');
 const release=fs.existsSync(file)?readJournal(file):null;if(!release?.window)return;
 const message=ownerGateMessage(config,release);
 // The webhook and the VPS journal (recorded once delivered, resent every round until then) and the daily local notice.
 try{await releaseEvent(config.outDir,ops,'waiting',attempt.id,message,await ops.secrets(),'owner-gate-'+attempt.at,'REFERENCE_GATE_OWNER');}catch(e){ops.log?.(`the owner was not reached for the reference-app test: ${e.message}`);}
 await remind(config.outDir,'proposal:'+attempt.id,'SSAM: reference-app test before deploying '+attempt.id,message,ops,{now:noticeNow(config),link:path.join(dir,'PROPOSTA.md')});
}
async function proposeToOwner(config,ops,{release,attempt,dir,id}){
 fs.writeFileSync(path.join(dir,'compose.coolify.yml'),composeText(generateCompose(release.manifest)));
 writeJournal(path.join(dir,'release.json'),release);
 fs.writeFileSync(path.join(dir,'PROPOSTA.md'),ownerGateText(config,release));
 if(wasCut(config.outDir,attempt))return {status:'deferred',id,dir,code:'round-timeout'};
 const a=writeAttempt(config.outDir,{...attempt,status:'proposed',ownerGate:{since:new Date().toISOString(),images:release.window.builts.map(b=>({odc:b.odc,tag:b.tag,sha256:b.sha256}))},built:release.built,builts:release.window.builts,proposedAt:new Date().toISOString()});
 await ownerGateNotice(config,ops,a);
 return {status:'proposed',id,dir,builts:release.window.builts};
}
// The owner approved his reference-app test: the next round releases exactly the images he was shown, on the window live now
// (rotated again on it; a window that no longer needs the round closes it).
// Nothing of the release may escape the round (review M2): a release that does not fit the live window any more (rebuild
// needed), or whose files are not the ones approved, drops the proposal (dropProposal) and the next round proposes again.
async function releaseApproved(config,ops,decision){
 const a=decision.previous,dir=path.join(config.outDir,a.id),live=config.liveBaseline;
 let release,w,manifest;
 try{
  release=readJournal(path.join(dir,'release.json'));w=release.window;manifest=release.manifest;
  if((w.builts??[]).map(b=>b.sha256).join()!==(a.ownerGate?.images??[]).map(i=>i.sha256).join())throw Object.assign(Error(`The release of ${a.id} is not the one the owner approved.`),{code:'APPROVED_RELEASE_CHANGED'});
  if(live){
   const again=windowStillNeeded(live,w)?windowAgain(config,w,live,config.now??Date.now()):null;
   if(!again){writeAttempt(config.outDir,{...a,status:'closed',code:'idle',endedAt:new Date().toISOString()});return {status:'idle',id:a.id,dir};}
   manifest=again.manifest;w=again.window;
  }
 }catch(error){return dropProposal(config,ops,a,error);}
 ops.log?.(`release ${a.id}: the owner approved the reference-app test at ${a.gateApproved.at}`);
 return finishRelease(config,ops,{release:{...release,baseline:live??release.baseline,manifest,window:{...w,referenceGate:{...w.referenceGate,waitOwner:false,approved:a.gateApproved}}},attempt:a,dir,id:a.id,smoke:null});
}
// A proposal a newer version of its lane replaced (decideWindow superseded): closed, never deployed, its local images left to the
// artifact retention; the owner is told on the resent channel (review B6).
async function expireProposal(config,ops,s){
 const a=readAttempts(config.outDir)[s.id];if(a?.status!=='proposed')return;
 writeAttempt(config.outDir,{...a,status:'closed',code:'superseded',superseded:{at:new Date().toISOString(),by:s.by??null},endedAt:new Date().toISOString()});
 await keepNotice(ops,{outDir:config.outDir,id:a.id,attempt:a.at},'superseded',`${a.id}: the proposal of ${STUDIO_NAME[s.lane]} ${s.version} expired without deploying: ${s.by?STUDIO_NAME[s.lane]+' '+s.by+' replaces it':'a newer version replaces it'}. Nothing to approve for ${a.id}.`,'PROPOSAL_SUPERSEDED').catch(e=>ops.log?.(`the owner notice of ${a.id} is kept: ${e.message}`));
 ops.log?.(`${a.id} superseded by ${s.by??'a newer version'}`);
}
// A proposal that cannot be deployed as approved (S2 R4): dropped as by -Reject, but the next round builds the lane's version
// again and proposes it anew (retry); the owner is told on the resent channel (owner-notices.json, automatic.mjs keepNotice).
// It never stops a retirement or the other lane's round.
async function dropProposal(config,ops,a,error,{endedAt=new Date().toISOString()}={}){
 const code=/^[A-Z_]+$/.test(error.code??'')?error.code:'RELEASE_FAILED',message=String(error.message).split('\n')[0];
 ops.log?.(`release ${a.id} dropped (${code}): ${message}`);
 writeAttempt(config.outDir,{...a,status:'failed',retry:true,code,error:message,dropped:{at:endedAt,code},failedLanes:[a.round?.lane??a.pair?.lanes?.[0]].filter(Boolean),endedAt});
 await keepNotice(ops,{outDir:config.outDir,id:a.id,attempt:a.at},'dropped',`${a.id}: the approved images were not deployed (${code}): ${message} The next round builds ${STUDIO_NAME[a.round?.lane]??''} ${a.round?.version??''} again and proposes it anew.`,code).catch(e=>ops.log?.(`the owner notice of ${a.id} is kept: ${e.message}`));
 return {status:'failed',id:a.id,dir:path.join(config.outDir,a.id),code,dropped:true};
}

// release.json, then the rehearsal's end or the automatic release (automatic.mjs releaseAutomatically, which knows
// release.window). The compose of the next window goes with the evidence.
async function finishRelease(config,ops,{release,attempt,dir,id,smoke}){
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
 else if(['idle','abandoned'].includes(result.status))writeAttempt(config.outDir,{...attempt,status:'closed',code:result.status,endedAt:new Date().toISOString()});
 // The images no longer fit the live window (automatic.mjs told the owner): built and proposed again by the next round.
 else if(result.status==='stale')writeAttempt(config.outDir,{...attempt,status:'failed',retry:true,code:result.code,dropped:{at:new Date().toISOString(),code:result.code},failedLanes:[release.window.lane],endedAt:new Date().toISOString()});
 // An owner-approved proposal that failed before any mutation is dropped like a -Reject, and proposed again (review M2).
 else if(result.status==='failed'&&attempt.ownerGate)writeAttempt(config.outDir,{...attempt,status:'failed',retry:true,code:result.code,dropped:{at:new Date().toISOString(),code:result.code},built:release.built,failedLanes:[release.window.lane],endedAt:new Date().toISOString()});
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
