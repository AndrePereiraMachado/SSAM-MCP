// One watcher round: decide from the plan and the recorded attempts, then run the pipeline for at most one pair.
// State lives in outDir: <pair id>/attempt.json per attempt, reminders.json for the once-a-day notices, PENDENTE.md for
// a Studio that still has to be installed. A round with nothing new reads only and writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import {LANES,STUDIO_NAME,missingPack,planWindow,readyCandidates,pairFor,pairId,hasPair,rotateWindow,compareFailures,windowPairs,tfmMajor,proposalText,failureText,composeText} from './window.mjs';
import {generateCompose} from '../coolify/gen-compose.mjs';
export class EnvironmentError extends Error{constructor(message,code='environment'){super(message);this.environmental=true;this.code=code;}}
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
const sameInputs=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hours=(now,at)=>(now-Date.parse(at))/3600000;
// What a round would do, without side effects (the dry run prints it).
export function decide({manifest,observed,state,attempts,inputs,now=Date.now(),retryHours=12}){
 const plan=planWindow(manifest,observed,state);
 const install=plan.candidates.filter(c=>c.requiresInstallation);
 const waiting={installers:install,requested:plan.requested.filter(r=>!plan.candidates.some(c=>c.lane===r.lane&&c.version===r.version&&!c.requiresInstallation))};
 const pending=Object.values(attempts).filter(a=>a.status==='proposed'&&!hasPair(manifest,a.pair));
 let ready=readyCandidates(plan);
 if(!ready.length)return {action:waiting.installers.length||waiting.requested.length?'waiting-for-studio':'idle',plan,waiting,pending};
 if(pending.length)return {action:'pending-approval',plan,waiting,pending,proposal:pending[0],observedPair:pairId(pairFor(manifest,ready))};
 const skipped=[];
 while(ready.length){
  const pair=pairFor(manifest,ready),id=pairId(pair),a=attempts[id],want=inputs(pair);
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
 await remind(config.outDir,'install:'+what,'SSAM: install a newer Studio',`${what}. See ${path.join(config.outDir,'PENDENTE.md')}`,ops,{now,link:path.join(config.outDir,'PENDENTE.md')});
}
export async function runVigia(config,ops){
 const now=config.now??Date.now(),outDir=config.outDir,log=ops.log??(()=>{});
 const attempts=readAttempts(outDir);
 const head=config.head??null;
 const inputs=pair=>({head,studios:Object.fromEntries(pair.candidates.map(c=>[c.lane,c.fullVersion??c.version]))});
 const decision=decide({manifest:config.manifest,observed:config.observed,state:config.state,attempts,inputs,now,retryHours:config.retryHours??12});
 const plan=decision.plan;
 if(config.dryRun)return {status:'dry-run',decision:{action:decision.action,pair:decision.id??null,proposal:decision.proposal?.id??null,skipped:decision.skipped??[]},plan};
 log(`decision: ${decision.action}${decision.id?' '+decision.id:''}`);
 await noteWaiting(config,ops,decision.waiting,now);
 if(decision.action==='idle'||decision.action==='waiting-for-studio')return {status:decision.action,plan};
 if(decision.action==='pending-approval'){
  const p=decision.proposal,newer=decision.observedPair!==p.id?` A newer pair was observed (${decision.observedPair}); it is tested after this proposal is approved or rejected.`:'';
  await remind(outDir,'proposal:'+p.id,'SSAM: Studio versions ready for approval',`${p.id} waits for your approval: ${path.join(outDir,p.id,'PROPOSTA.md')}.${newer}`,ops,{now,link:path.join(outDir,p.id,'PROPOSTA.md')});
  return {status:'pending-approval',id:p.id,dir:path.join(outDir,p.id),plan};
 }
 if(decision.action==='failed'){
  if(decision.id)await remind(outDir,'failed:'+decision.id,'SSAM: Studio version checks failed',`${decision.id}: ${path.join(outDir,decision.id,'FALHAS.md')}`,ops,{now,link:path.join(outDir,decision.id,'FALHAS.md')});
  return {status:'failed',id:decision.id??null,dir:decision.id?path.join(outDir,decision.id):null,plan};
 }
 if(decision.action==='rejected')return {status:'rejected',id:decision.id,plan};
 return runAttempt(config,ops,decision,now);
}
async function runAttempt(config,ops,decision,now){
 const {pair,id}=decision,outDir=config.outDir,dir=path.join(outDir,id),log=ops.log??(()=>{}),base=config.manifest;
 // A deferred attempt left no evidence beyond its notice: it is overwritten (and counted), not archived.
 const waited=decision.previous?.status==='deferred'?decision.previous:null;
 if(!waited)archive(dir,decision.previous);fs.mkdirSync(dir,{recursive:true});
 for(const s of decision.skipped??[])log(`lanes ${s.lanes.join(', ')} of ${s.id} failed before with the same inputs; trying ${id}`);
 const attempt={id,pair:{odc:pair.odc,o11:pair.o11,lanes:pair.lanes},inputs:decision.inputs,status:'running',at:new Date(now).toISOString(),baseManifest:base,replayed:config.replayed??[],
  ...(waited?{deferrals:(waited.deferrals??1),firstDeferredAt:waited.firstDeferredAt??waited.at}:{})};
 writeAttempt(outDir,attempt);
 const comparisons={},runtimes={};
 try{
  // Cheap checks first (worktree, disk), then the runtime question (dotnet only); Docker is started only for a round that
  // can build.
  await ops.preflight({pair,id,dir});
  // A Studio that moved to another .NET is the build rule's job (Directory.Build.targets): ask MSBuild which target it
  // takes for that Studio folder. A workspace without the rule is waiting for code, not a test failure.
  const mismatched=[];
  for(const c of pair.candidates){
   const build=await ops.targetFramework(c);
   runtimes[c.lane]={studio:c.tfm??null,build:build??null,baseline:config.baselineTfm?.[c.lane]??null};
   log(`runtime ${c.lane} ${c.version}: Studio ${c.tfm??'unknown'}, build ${build??'unknown'}`);
   if(c.tfm&&build&&tfmMajor(c.tfm)!==tfmMajor(build))mismatched.push(`${STUDIO_NAME[c.lane]} ${c.version} runs on ${c.tfm}, but this workspace builds the kernel for ${build} against it`);
  }
  if(mismatched.length)throw new EnvironmentError(`${mismatched.join('; ')}. The workspace needs the build rule that follows the Studio runtime (Directory.Build.targets); the round waits for that code in main.`,'runtime-unsupported');
  await ops.dockerReady();
  const bundles={};
  for(const lane of LANES){
   const candidate=pair.candidates.find(c=>c.lane===lane);
   bundles[lane]=candidate?await ops.bundle(candidate,dir):await ops.companion(lane,base[lane][0].version);
   log(`bundle ${lane} ${bundles[lane].version}: ${bundles[lane].file} sha256 ${bundles[lane].sha256}`);
  }
  const packless=missingPack(config,bundles);
  if(packless.length)throw new EnvironmentError(`No agent pack for ${packless.map(p=>`${STUDIO_NAME[p.lane]} ${p.version} (${p.tfm})`).join(' and ')}: the agent pack in the configuration is built for ${config.agentPack?.runtime??'net8.0'}. Add agentPackByRuntime.net${tfmMajor(packless[0].tfm)} (odcBridge, odcBridgeAccepted, o11BuiltFor) to the watcher configuration once that pack exists; the round waits.`,'agent-pack-missing');
  const baseline={odc:await ops.companion('odc',base.odc[0].version),o11:await ops.companion('o11',base.o11[0].version)};
  fs.writeFileSync(path.join(dir,'bundles.json'),JSON.stringify({pair:bundles,baseline},null,2));
  const failedLanes=[];
  for(const c of pair.candidates){
   const before=await ops.test(c.lane,'baseline',baseline,dir);
   const after=await ops.test(c.lane,'candidate',bundles,dir);
   if(!before.passed||!after.passed)throw Object.assign(Error(`The ${c.lane} suite did not run: baseline ${before.passed}/${before.total} passed, candidate ${after.passed}/${after.total} passed. A suite that runs nothing cannot approve a version.`),{lanes:[c.lane]});
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
  if(bundles.odc.features)fs.copyFileSync(bundles.odc.features,path.join(dir,'Features.plain.xml'));
  fs.writeFileSync(path.join(dir,'proposed-window.json'),JSON.stringify(next.manifest,null,2)+'\n');
  fs.writeFileSync(path.join(dir,'compose.coolify.yml'),composeText(generateCompose(next.manifest)));
  const proposed=await ops.propose(next.manifest,'vigia/'+id,dir,`build(deploy): propose the Studio pair ${id}\n\nNew: ${pair.lanes.map(l=>`${STUDIO_NAME[l]} ${pair[l]}`).join(', ')}. Local image ${built.tag}, filtered kernel tests and image smoke passed.\nThe new pair has no digest until the owner approves and the tag is published (vigia.ps1 -Approve ${id}).\n`);
  const branch=proposed.branch??'vigia/'+id,commit=proposed.commit;
  const base_=windowPairs(base).map(p=>pairId(p)).join(', ');
  fs.writeFileSync(path.join(dir,'PROPOSTA.md'),proposalText({id,pair,built,next,comparisons,branch,commit,dir,base:base_,replayed:config.replayed??[],runtimes}));
  writeAttempt(outDir,{...attempt,status:'proposed',built,branch,commit,proposedManifest:next.manifest,leaving:next.leaving,affected:next.affected,runtimes,proposedAt:new Date().toISOString()});
  await remind(outDir,'proposal:'+id,'SSAM: Studio versions ready for approval',`${id}: ${path.join(dir,'PROPOSTA.md')}`,ops,{now,link:path.join(dir,'PROPOSTA.md')});
  return {status:'proposed',id,branch,dir,built};
 }catch(error){
  const environmental=!!error.environmental;
  fs.writeFileSync(path.join(dir,'FALHAS.md'),failureText({id,error:String(error.message),environmental,dir,retry:config.retryHours??12}));
  writeAttempt(outDir,{...attempt,status:environmental?'deferred':'failed',...(environmental?{deferrals:(attempt.deferrals??0)+1,firstDeferredAt:attempt.firstDeferredAt??attempt.at}:{}),error:String(error.message),code:error.code??null,failedLanes:error.lanes??[],runtimes,endedAt:new Date().toISOString()});
  log(`${environmental?'deferred':'failed'}: ${error.message}`);
  const key=(environmental?'deferred:':'failed:')+id+(environmental?':'+(error.code??''):'');
  await remind(outDir,key,environmental?'SSAM: Studio version round waiting':'SSAM: Studio version checks failed',`${id}: ${error.message.split('\n')[0]}`,ops,{now,link:path.join(dir,'FALHAS.md')});
  return {status:environmental?'deferred':'failed',id,dir,error:String(error.message)};
 }
}
