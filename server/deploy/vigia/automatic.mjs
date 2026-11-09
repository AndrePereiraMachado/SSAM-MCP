// The release is based on observed production state; every mutation is fenced
// by the shared remote lease and the original Coolify compose fingerprint.
import fs from 'node:fs';
import {readJournal,writeJournal} from './journal.mjs';
import path from 'node:path';
import {rotateWindow,windowLimit,pinDigest,rotateLane,retireDue,pinDigests,servedOf,windowPolicy,builtKernels,affectedRecord,compareVersion,backendId,defaultO11} from './window.mjs';
import {assertUnserved,assertRetained,assertLaneUnserved,canonicalComposeHash} from './safety.mjs';
import {withUsage,hotPairName} from '../coolify/gen-compose.mjs';
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
// The plan of a bridge mode: server-only (the default) builds, signs and offers no client bridge; it gates the pair on the
// published agent packs instead.
export const SERVER_ONLY_STEP='Build no client bridge: the kernel accepts the bridges of the published agent packs, and a hello of that pack (its bridges, runtimes and reconcile-merge) must be compatible on both lanes, else the lane waits (client-bridge-update-required)';
// ed25519-offers: the server-only gate, plus client bridges compiled from the verified bundles and offered with an Ed25519 manifest only.
export const ED25519_OFFERS_STEP='Compile the client bridges from the verified Studio bundles at the owner-signed agent release, classify signers by verification only (never Authenticode-sign), write the Ed25519-signed manifest; a hello of the published pack with bridgeOffer must receive the offer and, with it installed, be compatible on both lanes, else the lane waits (client-bridge-update-required)';
export const automaticPlan=mode=>mode==='signed-offers'?AUTOMATIC_PLAN:AUTOMATIC_PLAN.map(step=>step.startsWith('Compile pinned client sources')?(mode==='ed25519-offers'?ED25519_OFFERS_STEP:SERVER_ONLY_STEP):step);
const atomic=(file,value)=>{const tmp=file+'.next';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,file);};
// Window 4x4 (S2): a release of a backend window carries release.window {kind: add|retire, lane, version, builts, kernels,
// defaultO11, retiring, retired, affected, prepare}. These are its steps where a pair release differs.
const fail=(message,code)=>{throw Object.assign(Error(message),{code});};
// The images a window round built no longer fit the live window (S2 R4, review M1/M2): an ODC image without an O11 kernel the
// window now serves, a backend of the live window without its rebuilt O11 image. Nothing is deployed: the attempt is dropped and
// the next round builds and proposes the version again (window-round.mjs finishRelease, vigia.mjs).
export const REBUILD_NEEDED='WINDOW_REBUILD_NEEDED';
const rebuildNeeded=message=>Object.assign(Error(message+' It must be built again; nothing is deployed and the next round builds and proposes it again.'),{code:REBUILD_NEEDED});
// The round re-derived on the window live now (an owner approval days later, a deferred deploy): the same rotation or
// retirement with today's dates and retiring/retired/affected recomputed (review B1), the builts, prepares and kernel.json
// limited to the backends of that window -> {manifest, window}; null when the live window no longer needs it (the version is
// served, or a newer one of the lane is). The images must carry what that window serves (their real O11 kernels, the build's
// image label): else REBUILD_NEEDED.
export function windowAgain(config,w,baseline,now=Date.now()){
 const policy=windowPolicy(config),tokens=baseline.telemetry?.tokens,live=baseline.manifest;
 if(w.kind==='retire'){
  const r=retireDue(live,{now,keep:policy.keep,tokens});
  if(!r||r.retired[0].lane!==w.lane||r.retired[0].version!==w.version)return null;
  return {manifest:r.manifest,window:{...w,retired:r.retired,affected:affectedRecord(r.affected),...(r.hotPinDropped?{hotPinDropped:r.hotPinDropped}:{})}};
 }
 const served=servedOf(live,w.lane);
 if(served.some(x=>compareVersion(x,w.version)>=0))return null;
 const realOf=b=>builtKernels(b)??builtKernels({kernels:w.o11Kernels})??[];
 const liveO11=servedOf(live,'o11');
 let images,builts;
 if(w.lane==='odc'){
  const b=w.builts[0],has=realOf(b),missing=liveO11.filter(v=>!has.includes(v));
  if(missing.length)throw rebuildNeeded(`The approved image of backend ${backendId(w.version)} (${b.tag}) carries the O11 kernels ${has.join(', ')}; the live window now serves ${missing.join(', ')} too.`);
  images={image:b.image,tag:b.tag,kernels:has};builts=[b];
 }else{
  const byOdc=new Map(w.builts.map(b=>[b.odc,b]));
  const missing=live.backends.map(b=>b.odc).filter(odc=>!byOdc.has(odc));
  if(missing.length)throw rebuildNeeded(`The O11 round rebuilt no image for ${missing.map(backendId).join(', ')}, which the live window now runs.`);
  builts=w.builts.filter(b=>live.backends.some(x=>x.odc===b.odc));
  const next=[...new Set([...liveO11,w.version])],short=builts.filter(b=>next.some(v=>!realOf(b).includes(v)));
  if(short.length)throw rebuildNeeded(`The rebuilt images of ${short.map(b=>backendId(b.odc)).join(', ')} do not carry every O11 kernel the live window serves with ${w.version}.`);
  images=Object.fromEntries(builts.map(b=>[b.odc,{image:b.image,tag:b.tag,kernels:realOf(b)}]));
 }
 const r=rotateLane(live,w.lane,w.version,{now,graceDays:policy.graceDays,keep:policy.keep,tokens,images});
 const names=new Set(r.manifest.backends.map(b=>backendId(b.odc)));
 const window={...w,builts:builts.filter(b=>names.has(backendId(b.odc))),prepare:(w.prepare??[]).filter(n=>names.has(n)),kernels:w.kernels?Object.fromEntries(Object.entries(w.kernels).filter(([n])=>names.has(n))):w.kernels,
  retiring:r.retiring,retired:r.retired,affected:affectedRecord(r.affected),baseRetiring:live.retiring??null};
 if(r.hotPinDropped)window.hotPinDropped=r.hotPinDropped;else delete window.hotPinDropped;
 return {manifest:r.manifest,window};
}
// Owner notices of a round outside a deployment journal (a dropped, stale or superseded proposal; S2 R4): kept in
// <dir>/owner-notices.json before they are sent and until the VPS journal line or the webhook took them; every later round sends
// them again (vigia.mjs resendKept), like state.unsent of a live release.
export const KEPT_NOTICES='owner-notices.json';
// S2 R6 (review B9): every kept notice has its own delivery key (<name>#<n>, n counting in the file), so the key a journal event
// of the same attempt already took ("failed" before mutation) never swallows it, and a second notice of the same kind is
// added, never replaces one not delivered yet. Names: dropped (an approved proposal discarded), stale (a deferred deploy whose
// images no longer fit), resume-failed (the resume loop stopped a release before any change), superseded.
// Review B10: the file is replaced durably (fsync, rename); an unreadable one is set aside, and the owner told.
function readKept(file,ops){
 if(!fs.existsSync(file))return {unsent:[]};
 try{const kept=readJournal(file);if(!kept||typeof kept!=='object'||!Array.isArray(kept.unsent??[]))throw Error('not a notice list');return kept;}
 catch(error){
  const aside=file+'.unreadable-'+new Date().toISOString().replace(/[^0-9TZ]/g,'');
  try{fs.renameSync(file,aside);}catch{}
  ops.log?.(`owner notices ${file} unreadable (${error.message}); set aside as ${path.basename(aside)}`);
  return {unsent:[{name:'notices-unreadable',key:'notices-unreadable#'+path.basename(aside),attempt:'notices',message:`The owner notices of ${path.basename(path.dirname(file))} were unreadable and are set aside in ${path.basename(aside)}; read them there.`,code:'NOTICES_UNREADABLE'}]};
 }
}
export async function keepNotice(ops,{outDir,id,attempt},name,message,code=null){
 const file=path.join(outDir,id,KEPT_NOTICES),kept=readKept(file,ops);
 kept.unsent=kept.unsent??[];
 if(!kept.unsent.some(u=>u.name===name&&u.attempt===attempt&&u.message===message)){
  kept.seq=(kept.seq??0)+1;kept.unsent.push({name,key:`${name}#${kept.seq}`,message,attempt,...(code?{code}:{})});
 }
 writeJournal(file,kept,{durable:true});
 return resendKept(ops,{outDir,id});
}
// -> the number of notices still not delivered.
export async function resendKept(ops,{outDir,id}){
 const file=path.join(outDir,id,KEPT_NOTICES);
 if(!fs.existsSync(file))return 0;
 const kept=readKept(file,ops);if(!kept.unsent?.length)return 0;
 let secrets;try{secrets=await ops.secrets();}catch{if(!fs.existsSync(file))writeJournal(file,kept,{durable:true});return kept.unsent.length;}
 const left=[];
 for(const u of kept.unsent){const sent=await releaseEvent(outDir,ops,u.name,id,u.message,secrets,u.attempt,u.code??null,u.key??u.name).catch(()=>false);if(sent===false)left.push(u);}
 kept.unsent=left;writeJournal(file,kept,{durable:true});return left.length;
}
// Still to do on this live window: the version to add is not served yet, the version to retire still is.
export function windowStillNeeded(baseline,w){
 if(w.kind==='retire')return servedOf(baseline.manifest,w.lane).includes(w.version);
 try{assertLaneUnserved(baseline,w.lane,w.version);return true;}catch(e){if(e.code==='ALREADY_SERVED')return false;throw e;}
}
// The pin of a window round: every image it built carries its published digest (a retirement builds none).
export function windowPinned(proposed,w,baseline){
 const digests=Object.fromEntries((w.builts??[]).map(b=>[b.tag,'sha256:'+b.sha256]));
 const pinned=withUsage(w.builts?.length?pinDigests(proposed,digests):proposed,baseline.usage);
 // What each built image really is: its backend and the O11 kernels its build read back from the image (builtKernels).
 const images=Object.fromEntries((w.builts??[]).map(b=>[b.tag,{odc:b.odc,kernels:builtKernels(b)??builtKernels({kernels:w.o11Kernels})}]));
 assertRetained(baseline,pinned,{lane:w.kind==='add'?w.lane:null,built:Object.fromEntries((w.builts??[]).map(b=>[b.tag,b.sha256])),images});
 return pinned;
}
// The window change of a round, for the served-list check of the compose (safety.mjs servedTransition).
export const windowChange=w=>({added:w.kind==='add'?[{lane:w.lane,version:w.version}]:[],retired:(w.retired??[]).map(({lane,version})=>({lane,version}))});
// key: the delivery key of the event within its attempt (default its name; a kept notice has its own, review B9).
export async function releaseEvent(directory,ops,name,id,message,secrets,attempt='legacy',code=null,key=name){
 const file=path.join(directory,'release-events.json');let events={};
 if(fs.existsSync(file))events=JSON.parse(fs.readFileSync(file,'utf8'));
 const recorded=id+':'+attempt+':'+key;
 if(name!=='rollback-failed'&&events[recorded])return;
 // The key is recorded only once the owner was reached beyond this machine: the VPS journal line (remote logger) or the
 // webhook (ops.event's receipt {remote, webhook}). A local notice alone, a failed send or no receipt leaves it unrecorded,
 // so the next round sends the event again.
 const receipt=await ops.event(name,{id,attempt,message,...(code?{code}:{})},secrets).catch(()=>null);
 if(receipt?.remote!==true&&receipt?.webhook!==true)return false;
 events[recorded]=new Date().toISOString();atomic(file,events);return true;
}
export async function releaseAutomatically(config,ops,release){
 const {id,dir,built,manifest,kernel,bridges,features}=release;let w=release.window??null;
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
 const event=(name,message,code)=>releaseEvent(config.outDir??dir,ops,name,id,message,secrets,state.attempt,code);
 // A notice of a live release that did not reach the owner (releaseEvent false: no remote line, no webhook) is kept in
 // state.unsent and sent again by every later round of the same attempt until it is delivered (review R2 B4).
 const notify=async(name,message,code)=>{const sent=await event(name,message,code);state.unsent=(state.unsent??[]).filter(u=>u.name!==name);if(sent===false)state.unsent.push({name,message,...(code?{code}:{})});if(!state.unsent.length)delete state.unsent;save();return sent;};
 if(['idle','abandoned'].includes(state.status))return {status:state.status,id};
 if(state.status==='stale')return {status:'stale',id,code:REBUILD_NEEDED};
 if(state.status==='live'){for(const u of [...(state.unsent??[])])await notify(u.name,u.message,u.code);return {status:'live',id,commit:state.pin};}
 if(state.status==='rollback-failed'){await event('rollback-failed',`${id}: rollback still requires owner attention.`);return {status:'rollback-failed',id};}
 if(state.status==='rolled-back')throw Error('Owner Retry or a new Studio build is required.');
 // Never retain arbitrary service/API response objects in this journal.
 const once=async(name,fn,select=x=>x)=>{if(state.steps[name])return state.steps[name].value;state.activeStep=name;save();const value=select(await fn());state.steps[name]={value,at:new Date().toISOString()};save();return value;};
 let baseline=state.baseline??release.baseline??await ops.liveBaseline(secrets);
 let proposed=state.proposed??manifest;
 // The window re-derived on a newer live baseline (a deferred deploy) is the one every later step and notice uses.
 if(w&&state.window)w=state.window;
 const outDir=config.outDir??path.dirname(dir);
 if(state.status==='deferred'){
  if((state.deferrals??0)>=(config.maxDeploymentDeferrals??3)||Date.now()-Date.parse(state.firstDeferredAt??state.attempt)>(config.maxDeferredHours??48)*3600000){
   // Its own event with the last deferral cause; -Retry reopens the closed attempt.
   const cause=state.failure?.code??'DEFERRED';state.status='abandoned';state.abandoned={at:new Date().toISOString(),code:cause,deferrals:state.deferrals??0};save();
   await event('abandoned',`${id}: deferred release abandoned after ${state.deferrals??0} deferrals (${cause}); later rounds may proceed. -Retry ${id} reopens it.`,cause);return {status:'abandoned',id,code:cause};
  }
  try {
  baseline=await ops.liveBaseline(secrets);
  if(w){
   let again;
   try{again=windowStillNeeded(baseline,w)?windowAgain(config,w,baseline):null;}
   catch(error){
    if(error.code!==REBUILD_NEEDED)throw error;
    // The images no longer fit the live window: never deployed; the attempt is dropped and built again (review M1).
    state.status='stale';state.failure={step:'baseline-refresh',code:REBUILD_NEEDED};save();
    await keepNotice(ops,{outDir,id,attempt:state.attempt},'stale',`${id}: the approved images were not deployed: ${error.message} The next round builds them again and proposes them anew.`,REBUILD_NEEDED);
    return {status:'stale',id,code:REBUILD_NEEDED};
   }
   if(!again){state.status='idle';save();return {status:'idle',id};}
   proposed=again.manifest;w=again.window;state.window=w;
   if(baseline.hash!==state.baseline?.hash){delete state.steps.pin;delete state.steps.backup;delete state.steps.prepared;}
  }else{
  try{assertUnserved(baseline,{odc:built.odc??kernel.odc,o11:built.o11??kernel.o11});}
  catch(e){if(e.code!=='ALREADY_SERVED')throw e;state.status='idle';save();return {status:'idle',id};}
  proposed=rotateWindow(baseline.manifest,{odc:built.odc??kernel.odc,o11:built.o11??kernel.o11,image:built.image,tag:built.tag},{...baseline.telemetry,maxWindow:windowLimit(config,baseline.manifest)}).manifest;
  if(baseline.hash!==state.baseline?.hash){delete state.steps.pin;delete state.steps.backup;delete state.steps.prepared;}
  }
  }catch(error){state.failure={step:'baseline-refresh',code:/^[A-Z_]+$/.test(error.code??'')?error.code:'BASELINE_UNAVAILABLE'};state.deferrals=(state.deferrals??0)+1;state.firstDeferredAt??=new Date().toISOString();save();await event('failed',`${id}: live baseline refresh deferred (${state.failure.code}).`,state.failure.code);return {status:'deferred',id,code:error.code??'BASELINE_UNAVAILABLE'};}
 }
 state.baseline=baseline;state.proposed=proposed;if(w)state.window=w;if(state.status!=='rolling-back')state.status='preparing';save();
 try{if(!state.mutationStarted){if(w){if(!windowStillNeeded(baseline,w))fail('The window round is already live.','ALREADY_SERVED');}else assertUnserved(baseline,{odc:built.odc??kernel.odc,o11:built.o11??kernel.o11});}}
 catch(e){if(e.code==='ALREADY_SERVED'){state.status='idle';save();return {status:'idle',id};}throw e;}
 // Capacity (gen-compose sizing): the hot tier goes to the most used pair (heavy calls of 7 days, then active clients of 14
 // days), counted in a live backend with this deploy's baseline; a deploy that happens anyway is the only moment usage moves
 // it. Unreadable counts keep the recorded ones and the owner is told; they never stop the round (review R2 M1').
 let unlock,protectedPhase=false,pinned,hot,stagedCompose;
 // S2 R6 (review B11): every backend runs ONE default O11 kernel (kernel.json o11). An O11 round stages the kernel.json of the
 // running backends before its deploy; each one is recorded (state.kernelStaged) before it is written, so a round that stops
 // before any change restores them from the live baseline's kernels (restoreStaged), and a resumed one writes them all again
 // (the prepared step runs again). Any other window round first aligns a retained backend that an interrupted O11 prepare
 // left on another default (alignKernels): a deploy never restarts backends on different defaults.
 const liveImage=b=>({odc:b.odc,image:b.image,tag:b.tag,sha256:String(b.sha256??'').replace(/^sha256:/,'')});
 const alignKernels=async compose=>{
  // The window's default, else the live one when it is still served (review B12): never the newest by default.
  const live=[...new Set(Object.values(baseline.kernels??{}).map(k=>k?.o11).filter(Boolean))];
  const o11=w.defaultO11??defaultO11(pinned,{lane:'odc',liveDefault:live.length===1?live[0]:null}),aligned=[];
  for(const b of pinned.backends){
   const name=backendId(b.odc),k=baseline.kernels?.[name];
   if(!k||(w.prepare??[]).includes(name)||k.o11===o11)continue;
   await ops.prepare(secrets,{id:name,round:id,lane:'o11',repair:true,service:name,built:liveImage(b),kernel:{...k,o11},features:null,bridges,compose,dir});
   aligned.push(name);
  }
  return {ok:true,aligned,o11};
 };
 const restoreStaged=async()=>{
  const left=[];
  for(const name of state.kernelStaged){
   const b=baseline.manifest.backends?.find(x=>backendId(x.odc)===name),k=baseline.kernels?.[name];
   try{
    if(!b||!k)throw Error('no live kernel');
    const compose=stagedCompose??await ops.composeFor(secrets,baseline,baseline.manifest,{added:[],retired:[]});
    await ops.prepare(secrets,{id:name,round:id,lane:'o11',repair:true,service:name,built:liveImage(b),kernel:k,features:null,bridges,compose,dir});
   }catch{left.push(name);}
  }
  delete state.steps.prepared;
  if(left.length){state.kernelStaged=left;state.kernelRestoreFailed=left;}else{delete state.kernelStaged;delete state.kernelRestoreFailed;state.kernelRestored=new Date().toISOString();}
  save();
  if(left.length)await keepNotice(ops,{outDir,id,attempt:state.attempt},'kernel-restore-failed',`${id}: the O11 round stopped before any change to production, but the kernel.json of ${left.join(', ')} was not restored; the next window round aligns every backend on one default O11 before it deploys.`,'KERNEL_RESTORE_FAILED').catch(()=>{});
  return left;
 };
 const pinRound=async()=>{
  pinned=w?windowPinned(proposed,w,baseline):withUsage(pinDigest(proposed,built.tag,'sha256:'+built.sha256),baseline.usage);if(!w)assertRetained(baseline,pinned);
  hot={from:baseline.manifest?.sizing?hotPairName(baseline.manifest):null,to:hotPairName(pinned)};
  if(pinned.sizing&&baseline.usageWarning)await event('usage-warning',`${id}: the usage counts of the capacity hot tier were not fully read (${baseline.usageWarning}); the recorded counts were kept where missing.`,baseline.usageWarning);
  await event('detected',`${id}: verified candidate detected.`);
 };
 // A window round pins inside the guarded part (review M2): a pin that does not fit the live window ends the attempt before any
 // mutation (preparation-failed, the owner told), never an exception that every later round would hit again.
 if(!w)await pinRound();
 try{
  if(w)await pinRound();
  if(ops.verifyRelease)await ops.verifyRelease(release);
  if(!state.mutationStarted){
   // A window round publishes every image it built (none for a retirement); each registry digest must be the tested one.
   const images=w?w.builts:[built];
   if(images.length)await once('published',async()=>{const out=[];for(const b of images){await ops.verifyLocalImage(b);const p=await ops.publish(b);if(p.digest!=='sha256:'+b.sha256)throw Error('Registry digest differs from tested image.');out.push(p);}return w?out:out[0];},p=>w?p.map(x=>({digest:x.digest,already:!!x.already})):({digest:p.digest,already:!!p.already}));
   state.pin=await once('pin',()=>ops.pinExecution(pinned,dir,id,w?w.kernels:kernel,baseline.kernels,w));
  }
  if(!state.mutationStarted){await ops.pause();await ops.deploymentBudget();}
  unlock=await ops.acquireReleaseLock(secrets);ops.beginDeployment?.();protectedPhase=true;
  if(!state.mutationStarted){
   await ops.preflightRemote(secrets,pinned);
   await ops.assertLiveUnchanged(secrets,baseline);
   await once('backup',()=>ops.backup(secrets,id),x=>({ok:!!x.ok,directory:x.directory,volumes:x.volumes}));
  }
  if(state.status!=='rolling-back'){
   const compose=await ops.composeFor(secrets,baseline,pinned,w?windowChange(w):undefined);stagedCompose=compose;
   if(!state.mutationStarted){
    // A window round prepares each backend it built: the new ODC backend (kernel.json and features), or every backend of an
    // O11 round (kernel.json only, the default O11 moved). A retirement prepares nothing.
    if(w)await once('prepared',async()=>{for(const name of w.prepare??[]){const b=w.builts.find(x=>'odc-'+x.odc===name);if(w.lane==='o11'){state.kernelStaged=[...new Set([...(state.kernelStaged??[]),name])];save();}await ops.prepare(secrets,{id:name,round:id,lane:w.lane,service:name,built:b,kernel:w.kernels[name],features:w.lane==='odc'?features:null,featuresSha256:w.lane==='odc'?release.featuresProvenance?.sha256??null:null,bridges,compose,dir});}return {ok:true};},()=>({ok:true}));
    else await once('prepared',()=>ops.prepare(secrets,{id,built,kernel,features,featuresSha256:release.featuresProvenance?.sha256??null,bridges,compose,dir}),()=>({ok:true}));
    if(w&&!(w.kind==='add'&&w.lane==='o11'))await once('kernels-aligned',()=>alignKernels(compose),x=>x);
    await ops.pause();await ops.assertLiveUnchanged(secrets,baseline);
    state.composeHash=canonicalComposeHash(compose);state.mutationStarted=true;save();
    await once('compose-written',()=>ops.writeCompose(secrets,compose),()=>({ok:true}));
   }
   await once('deploy',()=>{state.deploySent=true;save();return ops.deploy(secrets);},()=>({ok:true}));
   await once('checks',async()=>{const r=await ops.checks(secrets,{id,pinned,kernel,bridges,built,...(w?{window:{kind:w.kind,lane:w.lane,version:w.version}}:{})});if(!r?.ok)throw Error('Post-deployment checks failed.');return r;},r=>({ok:true,backends:r.backends}));
   // The notices of the live release (live; window-retiring / window-retired with the customers seen on those versions; the hot
   // tier) are recorded in state.unsent with the live state, then sent: a crash in between leaves them to the resend of every
   // later round (review B3).
   const pending=[{name:'live',message:`${id}: deployed and verified.`},
    ...(w?(await import('./window-round.mjs')).windowNotices(w).map(n=>({name:n.name,message:`${id}: ${n.message}`,code:n.code})):[]),
    ...(hot.to&&hot.to!==hot.from?[{name:'hot-pair',message:`${id}: the capacity hot tier moved from ${hot.from??'no hot pair'} to ${hot.to} (use per pair, heavy calls 7 d / active clients 14 d: ${JSON.stringify(pinned.sizing.usage??{})}${pinned.sizing.hotPair?', owner pin':''}).`,code:'HOT_PAIR_CHANGED'}]:[])];
   state.status='live';state.unsent=[...(state.unsent??[]).filter(u=>!pending.some(p=>p.name===u.name)),...pending];save();
   for(const n of pending)await notify(n.name,n.message,n.code);
   return {status:'live',id,commit:state.pin};
  }
  throw Error('Resume interrupted rollback.');
 }catch(error){
  state.failure={step:state.activeStep??'preflight',code:/^[A-Z_]+$/.test(error.code??'')?error.code:'RELEASE_FAILED'};
  if(!state.mutationStarted){
   if(w&&state.kernelStaged?.length)await restoreStaged();
   state.status=error.environmental?'deferred':'preparation-failed';
   if(error.environmental){state.deferrals=(state.deferrals??0)+1;state.firstDeferredAt??=new Date().toISOString();}
   save();await event('failed',`${id}: ${state.failure.step} failed before mutation (${state.failure.code}).`,state.failure.code);
   return {status:error.environmental?'deferred':'failed',id,code:state.failure.code};
  }
  state.status='rolling-back';save();let restored=false;
  try{if(ops.ensureReleaseLock)unlock=await ops.ensureReleaseLock(secrets,unlock);if(ops.assertRollbackSafe)await ops.assertRollbackSafe(secrets,baseline,state.composeHash);await ops.restoreCompose(secrets,baseline);if(state.deploySent){await ops.deploy(secrets);const r=await ops.checks(secrets,{rollback:true,live:baseline,...(w?.kind==='add'&&w.lane==='o11'?{kernelO11Also:w.defaultO11}:state.steps['kernels-aligned']?.value?.aligned?.length?{kernelO11Also:state.steps['kernels-aligned'].value.o11}:{})});if(!r?.ok)throw Error('Rollback checks failed.');}restored=true;}catch{}
  state.status=restored?'rolled-back':'rollback-failed';save();
  await event(restored?'failed':'rollback-failed',`${id}: ${state.failure.step} failed (${state.failure.code}); ${restored?'previous live baseline restored':'rollback requires owner attention'}.`,state.failure.code);
  return {status:state.status,id,code:'automatic-deployment-failed',cause:state.failure.code};
 }finally{
  try{if(unlock)await unlock();}finally{if(protectedPhase)ops.endDeployment?.();}
 }
}
