// One watcher round: decide from the plan and the recorded attempts, then run the pipeline for at most one pair.
// State lives in outDir: <pair id>/attempt.json per attempt, reminders.json for the once-a-day notices, PENDENTE.md for
// a Studio that still has to be installed. A round with nothing new reads only and writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import {LANES,STUDIO_NAME,ownerCommand,missingPack,planWindow,readyCandidates,pairFor,pairId,hasPair,rotateWindow,compareFailures,windowPairs,tfmMajor,proposalText,failureText,composeText} from './window.mjs';
import {generateCompose} from '../coolify/gen-compose.mjs';
// An environment problem (not a test result): the round waits and retries. lanes: the lanes it concerns (empty = the pair).
export class EnvironmentError extends Error{constructor(message,code='environment',lanes=[]){super(message);this.environmental=true;this.code=code;this.lanes=lanes;}}
const writeJson=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n');fs.renameSync(temp,file);};
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export const localDay=now=>new Date(now).toLocaleDateString('sv-SE');
export function readAttempts(outDir){
 let entries=[];try{entries=fs.readdirSync(outDir,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;}
 return Object.fromEntries(entries.filter(e=>e.isDirectory()&&/^o11-\d+\.\d+\.\d+-odc-\d+\.\d+\.\d+$/.test(e.name)).map(e=>[e.name,readJson(path.join(outDir,e.name,'attempt.json'))]).filter(([,a])=>a));
}
export function writeAttempt(outDir,attempt){writeJson(path.join(outDir,attempt.id,'attempt.json'),attempt);return attempt;}
// At most one notice per key and local day: a pending proposal, a failure or a missing Studio is repeated daily, never
// every round.
export async function remind(outDir,key,title,message,ops,{now=Date.now(),link}={}){
 const file=path.join(outDir,'reminders.json'),data=readJson(file)??{},day=localDay(now);
 if(data[key]===day){ops.log?.(`notice already given today: ${key}`);return false;}
 data[key]=day;writeJson(file,data);ops.log?.(`notice: ${title}: ${message}`);
 await ops.notify(title,message,{link});return true;
}
// The time a notice is given, which decides its "once a day" (a round can wait hours for another dotnet and cross
// midnight): config.clock in tests, else the round's fixed time in tests (config.now), else the time of the notice itself.
const noticeNow=config=>config.clock?.()??config.now??Date.now();
const sameInputs=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hours=(now,at)=>(now-Date.parse(at))/3600000;
// What a round would do, without side effects (the dry run prints it).
// A lane deferred for its own reason (its Studio incomplete, its runtime rule or agent pack missing...) holds the pair for
// laneWaitHours (24 h by default: an installation finishing, a fix landing in main); after that the other lane goes on
// alone, and the pair as a whole is checked again every retryHours.
export function decide({manifest,observed,state,attempts,inputs,now=Date.now(),retryHours=12,laneWaitHours=24,testEnvLimit=3}){
 const plan=planWindow(manifest,observed,state);
 const install=plan.candidates.filter(c=>c.requiresInstallation);
 const waiting={installers:install,requested:plan.requested.filter(r=>!plan.candidates.some(c=>c.lane===r.lane&&c.version===r.version&&!c.requiresInstallation))};
 const pending=Object.values(attempts).filter(a=>a.status==='proposed'&&!a.retry&&!hasPair(manifest,a.pair));
 let ready=readyCandidates(plan);
 if(!ready.length)return {action:waiting.installers.length||waiting.requested.length?'waiting-for-studio':'idle',plan,waiting,pending};
 if(pending.length)return {action:'pending-approval',plan,waiting,pending,proposal:pending[0],observedPair:pairId(pairFor(manifest,ready))};
 const skipped=[];
 while(ready.length){
  const pair=pairFor(manifest,ready),id=pairId(pair),a=attempts[id],want=inputs(pair);
  if(a&&!a.retry&&a.status==='deferred'&&(a.deferredLanes??[]).length&&hours(now,a.at)<retryHours){
   const held=a.deferredLanes.filter(l=>pair.lanes.includes(l)&&hours(now,a.laneSince?.[l]??a.at)>=laneWaitHours);
   if(held.length&&held.length<pair.lanes.length){skipped.push({id,lanes:held,why:'deferred'});ready=ready.filter(c=>!held.includes(c.lane));continue;}
  }
  // Candidate tests that timed out or ran nothing testEnvLimit times in a row with the same inputs (a Studio that hangs the
  // tests) are not retried every round: that lane is set aside, or the pair is held until main or the Studio changes.
  if(a&&!a.retry&&a.status==='deferred'&&(a.testEnvRuns??0)>=testEnvLimit&&sameInputs(a.inputs,want)){
   const lanes=(a.deferredLanes??[]).filter(l=>pair.lanes.includes(l));
   if(lanes.length&&lanes.length<pair.lanes.length){skipped.push({id,lanes,why:'held'});ready=ready.filter(c=>!lanes.includes(c.lane));continue;}
   return {action:'held',plan,waiting,pair,id,attempt:a,skipped};
  }
  if(!a||a.retry||['deferred','running'].includes(a.status))return {action:'run',plan,waiting,pair,id,inputs:want,previous:a??null,skipped};
  if(a.status==='failed'){
   if(!sameInputs(a.inputs,want)&&hours(now,a.at)>=retryHours)return {action:'run',plan,waiting,pair,id,inputs:want,previous:a,skipped};
   const lanes=(a.failedLanes??[]).filter(l=>pair.lanes.includes(l)&&a.inputs?.studios?.[l]===want.studios[l]);
   if(lanes.length&&lanes.length<pair.lanes.length){skipped.push({id,lanes});ready=ready.filter(c=>!lanes.includes(c.lane));continue;}
   return {action:'failed',plan,waiting,pair,id,attempt:a,skipped};
  }
  if(a.status==='rejected')return {action:'rejected',plan,waiting,pair,id,attempt:a,skipped};
  return {action:'idle',plan,waiting,pair,id,attempt:a,skipped};
 }
 return {action:'failed',plan,waiting,skipped};
}
function archive(dir,previous){
 if(!previous||!fs.existsSync(dir))return;
 const target=path.join(dir,'previous',String(previous.at).replace(/[:.]/g,'-'));fs.mkdirSync(target,{recursive:true});
 for(const name of fs.readdirSync(dir))if(name!=='previous')fs.renameSync(path.join(dir,name),path.join(target,name));
}
async function noteWaiting(config,ops,waiting,now){
 if(!waiting.installers.length&&!waiting.requested.length){
  // Nothing waits any more: the old notice is kept as resolved, so it never reads as current (one rename, once).
  for(const name of ['pending.json','PENDENTE.md'])if(fs.existsSync(path.join(config.outDir,name)))fs.renameSync(path.join(config.outDir,name),path.join(config.outDir,name.replace(/(\.\w+)$/,'.resolved$1')));
  return;
 }
 const text=JSON.stringify({requested:waiting.requested,installers:waiting.installers.map(({lane,version,fullVersion,installer})=>({lane,version,fullVersion,installer}))},null,2);
 const file=path.join(config.outDir,'pending.json');let previous='';try{previous=fs.readFileSync(file,'utf8');}catch{}
 if(previous!==text){fs.mkdirSync(config.outDir,{recursive:true});fs.writeFileSync(file,text);fs.writeFileSync(path.join(config.outDir,'PENDENTE.md'),'# Studio installation required\n\nInstall the observed Studio on this machine (or provide its folder in the watcher configuration). The next round then bundles and tests it. No image was built or published.\n\n'+text+'\n');}
 const what=[...waiting.installers.map(i=>`${STUDIO_NAME[i.lane]} ${i.version} (installer downloaded, not installed)`),...waiting.requested.map(r=>`${STUDIO_NAME[r.lane]} ${r.version} (${r.customers} customers)`)].join(', ');
 await remind(config.outDir,'install:'+what,'SSAM: install a newer Studio',`${what}. See ${path.join(config.outDir,'PENDENTE.md')}`,ops,{now:noticeNow(config),link:path.join(config.outDir,'PENDENTE.md')});
}
export async function runVigia(config,ops){
 const now=config.now??Date.now(),outDir=config.outDir,log=ops.log??(()=>{});
 const attempts=readAttempts(outDir);
 const head=config.head??null;
 const inputs=pair=>({head,studios:Object.fromEntries(pair.candidates.map(c=>[c.lane,c.fullVersion??c.version]))});
 const decision=decide({manifest:config.manifest,observed:config.observed,state:config.state,attempts,inputs,now,retryHours:config.retryHours??12,laneWaitHours:config.laneWaitHours??24,testEnvLimit:config.testEnvLimit??3});
 const plan=decision.plan;
 if(config.dryRun)return {status:'dry-run',decision:{action:decision.action,pair:decision.id??null,proposal:decision.proposal?.id??null,skipped:decision.skipped??[]},plan};
 log(`decision: ${decision.action}${decision.id?' '+decision.id:''}`);
 await noteWaiting(config,ops,decision.waiting,now);
 if(decision.action==='idle'||decision.action==='waiting-for-studio')return {status:decision.action,plan};
 if(decision.action==='pending-approval'){
  const p=decision.proposal,newer=decision.observedPair!==p.id?` A newer pair was observed (${decision.observedPair}); it is tested after this proposal is approved or rejected.`:'';
  await remind(outDir,'proposal:'+p.id,'SSAM: Studio versions ready for approval',`${p.id} waits for your approval: ${path.join(outDir,p.id,'PROPOSTA.md')}.${newer}`,ops,{now:noticeNow(config),link:path.join(outDir,p.id,'PROPOSTA.md')});
  return {status:'pending-approval',id:p.id,dir:path.join(outDir,p.id),plan};
 }
 if(decision.action==='failed'){
  if(decision.id)await remind(outDir,'failed:'+decision.id,'SSAM: Studio version checks failed',`${decision.id}: ${path.join(outDir,decision.id,'FALHAS.md')}`,ops,{now:noticeNow(config),link:path.join(outDir,decision.id,'FALHAS.md')});
  return {status:'failed',id:decision.id??null,dir:decision.id?path.join(outDir,decision.id):null,plan};
 }
 if(decision.action==='rejected')return {status:'rejected',id:decision.id,plan};
 if(decision.action==='held'){
  await remind(outDir,'held:'+decision.id,'SSAM: Studio version tests do not run',`${decision.id}: the candidate tests timed out or ran nothing ${decision.attempt.testEnvRuns} times in a row; the watcher stops retrying them until main or the Studio changes. After checking, ${ownerCommand(config,'-Retry '+decision.id)}`,ops,{now:noticeNow(config),link:path.join(outDir,decision.id,'AGUARDANDO.md')});
  return {status:'held',id:decision.id,plan};
 }
 const result=await runAttempt(config,ops,decision,now);
 // The pair was checked again and its waiting lanes still wait past laneWaitHours: the other lane goes on in this round.
 if(result.status==='deferred'&&result.code!=='round-timeout'){
  const again=decide({manifest:config.manifest,observed:config.observed,state:config.state,attempts:readAttempts(outDir),inputs,now,retryHours:config.retryHours??12,laneWaitHours:config.laneWaitHours??24,testEnvLimit:config.testEnvLimit??3});
  if(again.action==='run'&&again.id!==result.id&&again.skipped?.some(s=>s.id===result.id&&s.why==='deferred')){log(`decision: run ${again.id} (the other lanes waited long enough)`);return runAttempt(config,ops,again,now);}
 }
 return result;
}
// The lane checks that need no bundle, no Docker and no test, all of them at once (one notice names every problem): a
// Studio folder that is incomplete (an installation half-way), a Studio whose .NET the workspace's build rule does not
// target (or cannot be asked), a Studio on a .NET no agent pack covers.
async function laneChecks(config,ops,pair,runtimes,log){
 const problems=[];
 for(const c of pair.candidates){
  const missing=[...(c.missing??[]),...(!c.tfm&&!(c.missing??[]).some(m=>/runtimeconfig/i.test(m))?['the tfm of its runtimeconfig.json']:[])];
  if(missing.length){problems.push({lane:c.lane,code:'studio-incomplete',text:`The ${STUDIO_NAME[c.lane]} folder ${c.studio} has ServiceStudio.Framework.dll ${c.fullVersion} but not ${missing.join(', ')}: the Studio is incomplete (an installation may be running, or it needs a repair)`});continue;}
  const build=await ops.targetFramework(c);
  runtimes[c.lane]={studio:c.tfm,build:build??null};
  log(`runtime ${c.lane} ${c.version}: Studio ${c.tfm}, build ${build??'unknown'}`);
  if(!build)problems.push({lane:c.lane,code:'runtime-unknown',text:`MSBuild could not tell which target framework this workspace builds against ${STUDIO_NAME[c.lane]} ${c.version} (${c.tfm}); the watcher never picks one`});
  else if(tfmMajor(c.tfm)!==tfmMajor(build))problems.push({lane:c.lane,code:'runtime-unsupported',text:`${STUDIO_NAME[c.lane]} ${c.version} runs on ${c.tfm}, but this workspace builds the kernel for ${build} against it (the build rule that follows the Studio runtime is not in this workspace)`});
 }
 for(const p of missingPack(config,Object.fromEntries(pair.candidates.filter(c=>!problems.some(x=>x.lane===c.lane)).map(c=>[c.lane,{tfm:c.tfm,version:c.version}]))))
  problems.push({lane:p.lane,code:'agent-pack-missing',text:`no agent pack for ${STUDIO_NAME[p.lane]} ${p.version} (${p.tfm}): the configured pack is built for ${config.agentPack?.runtime??'net8.0'}; add agentPackByRuntime.net${tfmMajor(p.tfm)} (odcBridge, odcBridgeAccepted, o11BuiltFor) once that pack exists`});
 if(problems.length)throw Object.assign(new EnvironmentError(problems.map(p=>p.text).join('; ')+'. The round waits and retries.',problems[0].code,[...new Set(problems.map(p=>p.lane))]),{laneCodes:Object.fromEntries(problems.map(p=>[p.lane,p.code]))});
}
// A round stopped at its time limit: its running attempt is recorded as deferred, with its notice. That record is final:
// a command killed by the cut that returns afterwards (a test with no results, a build cut short) never overwrites it.
const wasCut=(outDir,attempt)=>{const now=readAttempts(outDir)[attempt.id];return now?.status==='deferred'&&now.code==='round-timeout'&&now.at===attempt.at;};
export function timedOut(config,attempt){
 const dir=path.join(config.outDir,attempt.id);
 fs.writeFileSync(path.join(dir,'AGUARDANDO.md'),failureText({id:attempt.id,error:`The round reached its ${config.roundHours??7} h limit and was stopped.`,environmental:true,dir,retry:config.retryHours??12,config}));
 writeAttempt(config.outDir,{...attempt,status:'deferred',code:'round-timeout',error:'round time limit',deferrals:(attempt.deferrals??0)+1,firstDeferredAt:attempt.firstDeferredAt??attempt.at,endedAt:new Date().toISOString()});
}
async function runAttempt(config,ops,decision,now){
 const {pair,id}=decision,outDir=config.outDir,dir=path.join(outDir,id),log=ops.log??(()=>{}),base=config.manifest;
 // A deferred attempt left no evidence beyond its notice: it is overwritten (and counted), not archived.
 const waited=decision.previous?.status==='deferred'?decision.previous:null;
 if(!waited)archive(dir,decision.previous);fs.mkdirSync(dir,{recursive:true});
 // The waiting notice of a deferral is the vigia's own (a FALHAS.md there came from a deferral of the first rounds).
 if(waited)for(const name of ['AGUARDANDO.md','FALHAS.md'])fs.rmSync(path.join(dir,name),{force:true});
 for(const s of decision.skipped??[])log(`lanes ${s.lanes.join(', ')} of ${s.id} ${s.why==='deferred'?`have waited ${config.laneWaitHours??24} h`:'failed before with the same inputs'}; trying ${id}`);
 const attempt={id,pair:{odc:pair.odc,o11:pair.o11,lanes:pair.lanes},inputs:decision.inputs,status:'running',at:new Date(now).toISOString(),baseManifest:base,replayed:config.replayed??[],
  ...(waited?{deferrals:(waited.deferrals??1),firstDeferredAt:waited.firstDeferredAt??waited.at,laneSince:waited.laneSince??{},testEnvRuns:waited.testEnvRuns??0}:{})};
 writeAttempt(outDir,attempt);
 const comparisons={},runtimes={};
 try{
  // Cheap checks first (worktree, disk), then the lane checks (dotnet only); Docker is started only for a round that
  // can build.
  await ops.preflight({pair,id,dir});
  await laneChecks(config,ops,pair,runtimes,log);
  await ops.dockerReady();
  const bundles={};
  for(const lane of LANES){
   const candidate=pair.candidates.find(c=>c.lane===lane);
   bundles[lane]=candidate?await ops.bundle(candidate,dir):await ops.companion(lane,base[lane][0].version);
   log(`bundle ${lane} ${bundles[lane].version}: ${bundles[lane].file} sha256 ${bundles[lane].sha256}`);
  }
  const baseline={odc:await ops.companion('odc',base.odc[0].version),o11:await ops.companion('o11',base.o11[0].version)};
  fs.writeFileSync(path.join(dir,'bundles.json'),JSON.stringify({pair:bundles,baseline},null,2));
  const failedLanes=[];
  for(const c of pair.candidates){
   let before;
   try{before=await ops.test(c.lane,'baseline',baseline,dir);}
   catch(e){if(e.environmental)throw e;throw new EnvironmentError(`The ${c.lane} baseline (the default pair's frozen copy) did not run: ${e.message}`,'baseline',[c.lane]);}
   // The baseline is the window's default pair, already served: when it does not run, the machine is the problem.
   if(!before.passed)throw new EnvironmentError(`The ${c.lane} baseline (the default pair's frozen copy) passed ${before.passed}/${before.total}: the suite does not run on this machine now.`,'baseline',[c.lane]);
   const after=await ops.test(c.lane,'candidate',bundles,dir);
   if(!after.passed)throw Object.assign(Error(`The ${c.lane} suite did not run on the candidate: ${after.passed}/${after.total} passed (baseline ${before.passed}/${before.total}). A suite that runs nothing cannot approve a version.`),{lanes:[c.lane]});
   comparisons[c.lane]={baseline:before,current:after,...compareFailures(before,after)};
   log(`tests ${c.lane}: baseline ${before.passed}/${before.total}, candidate ${after.passed}/${after.total}, new failures ${comparisons[c.lane].newFailures.length}`);
   if(comparisons[c.lane].newFailures.length)failedLanes.push(c.lane);
  }
  fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify(comparisons,null,2));
  if(failedLanes.length)throw Object.assign(Error('New kernel test failures:\n'+failedLanes.map(l=>`${l}:\n`+comparisons[l].newFailures.map(n=>'  '+n).join('\n')).join('\n')),{lanes:failedLanes});
  const built=await ops.build(pair,bundles,dir);
  fs.writeFileSync(path.join(dir,'image.json'),JSON.stringify(built,null,2));
  const next=rotateWindow(base,{odc:pair.odc,o11:pair.o11,image:built.image,tag:built.tag},config.state);
  const served=Object.fromEntries(LANES.map(lane=>[lane,[...new Set(next.manifest[lane].map(x=>x.version))]]));
  const smoke=await ops.smoke(built,bundles,served,dir);fs.writeFileSync(path.join(dir,'smoke.json'),JSON.stringify(smoke,null,2));
  if(!smoke.ok)throw Error('Image smoke failed: '+(smoke.error??'see smoke.json'));
  fs.writeFileSync(path.join(dir,'proposed-window.json'),JSON.stringify(next.manifest,null,2)+'\n');
  fs.writeFileSync(path.join(dir,'compose.coolify.yml'),composeText(generateCompose(next.manifest)));
  const proposed=await ops.propose(next.manifest,'vigia/'+id,dir,`build(deploy): propose the Studio pair ${id}\n\nNew: ${pair.lanes.map(l=>`${STUDIO_NAME[l]} ${pair[l]}`).join(', ')}. Local image ${built.tag}, filtered kernel tests and image smoke passed.\nThe new pair has no digest until the owner approves and the tag is published (vigia.ps1 -Approve ${id}).\n`,{base:config.branchBase??null});
  const branch=proposed.branch??'vigia/'+id,commit=proposed.commit;
  const base_=windowPairs(base).map(p=>pairId(p)).join(', ');
  fs.writeFileSync(path.join(dir,'PROPOSTA.md'),proposalText({id,pair,built,next,comparisons,branch,commit,dir,base:base_,replayed:config.replayed??[],runtimes,features:bundles.odc.features,config}));
  if(wasCut(outDir,attempt)){log('the round was cut at its time limit; the proposal is not recorded');return {status:'deferred',id,dir,code:'round-timeout'};}
  writeAttempt(outDir,{...attempt,status:'proposed',built,branch,commit,proposedManifest:next.manifest,leaving:next.leaving,affected:next.affected,runtimes,features:bundles.odc.features,proposedAt:new Date().toISOString()});
  await remind(outDir,'proposal:'+id,'SSAM: Studio versions ready for approval',`${id}: ${path.join(dir,'PROPOSTA.md')}`,ops,{now:noticeNow(config),link:path.join(dir,'PROPOSTA.md')});
  return {status:'proposed',id,branch,dir,built};
 }catch(error){
  if(wasCut(outDir,attempt)||error.code==='round-timeout'){
   if(!wasCut(outDir,attempt))timedOut(config,attempt);
   log(`stopped at the time limit (${error.message.split('\n')[0]}); the attempt stays deferred`);
   return {status:'deferred',id,dir,code:'round-timeout',error:'round time limit'};
  }
  const environmental=!!error.environmental,notice=path.join(dir,environmental?'AGUARDANDO.md':'FALHAS.md'),lanes=error.lanes??[];
  fs.writeFileSync(notice,failureText({id,error:String(error.message),environmental,dir,retry:config.retryHours??12,config}));
  const laneSince=environmental?Object.fromEntries(lanes.map(l=>[l,attempt.laneSince?.[l]??attempt.at])):undefined;
  writeAttempt(outDir,{...attempt,status:environmental?'deferred':'failed',...(environmental?{deferrals:(attempt.deferrals??0)+1,firstDeferredAt:attempt.firstDeferredAt??attempt.at,deferredLanes:lanes,laneSince,laneCodes:error.laneCodes??null,testEnvRuns:error.code==='test-environment'?(attempt.testEnvRuns??0)+1:0}:{failedLanes:lanes}),error:String(error.message),code:error.code??null,runtimes,endedAt:new Date().toISOString()});
  log(`${environmental?'deferred':'failed'}: ${error.message}`);
  const key=(environmental?'deferred:':'failed:')+id+(environmental?':'+(error.code??''):'');
  await remind(outDir,key,environmental?'SSAM: Studio version round waiting':'SSAM: Studio version checks failed',`${id}: ${error.message.split('\n')[0]}`,ops,{now:noticeNow(config),link:notice});
  return {status:environmental?'deferred':'failed',id,dir,error:String(error.message)};
 }
}
