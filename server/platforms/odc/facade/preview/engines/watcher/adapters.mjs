import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {signalClient,bridgeClient} from './pipe.mjs';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
// The preview's JSON files are read and replaced by one implementation (the replace survives a concurrent reader on Windows).
import {readJson,atomicJson} from '../../profile.mjs';
export {readJson,atomicJson};
const fail=(code,message)=>{throw Object.assign(new Error(message),{code,retryable:false});};
// The tenant host this watcher is authorized for, by the SHA-256 of its name (no client name in the code).
const AUTHORIZED_HOST_SHA256='d33eb6003a66d394419bfb2551bca77ac1eb81d9cdd874444291054723e6b860';
export function inside(root,file){const rel=path.relative(path.resolve(root),path.resolve(file));return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}
export function checkFile(file,expected,code){if(!/^[a-f0-9]{64}$/.test(expected??'')||sha256(fs.readFileSync(file))!==expected)fail(code,'Pinned file changed: '+file);}
export const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function validateConfiguration(config){
 if(config.schema!=='ssam-official-watcher-config/2'||config.expectedReleaseSchema!=='ssam-official-live-release/2')fail('CONFIG_SCHEMA','Watcher v4 requires release/2');
 const recovery=config.captureRecovery??{};
 if(Object.keys(recovery).some(k=>!['captureRetryMs','captureFastWindowMs','backoffMs','maxBackoffMs'].includes(k))||Object.values(recovery).some(v=>!Number.isFinite(v))||(recovery.captureRetryMs??750)<700||(recovery.captureRetryMs??750)>1000||(recovery.captureFastWindowMs??6000)<0||(recovery.captureFastWindowMs??6000)>10000||(recovery.backoffMs??2000)<=0||(recovery.maxBackoffMs??10000)<(recovery.backoffMs??2000))fail('CAPTURE_RECOVERY_CONFIG','Invalid bounded capture recovery configuration');
 const target=config.target;
 if(target?.module!=='Quotes'||target.moduleKey!=='y4Yw60HbIUeAR7UbZXTVjA'||sha256(String(target.host??''))!==AUTHORIZED_HOST_SHA256||!Number.isSafeInteger(target.pid))fail('TARGET','This session is bound to the authorized Quotes module of the authorized tenant');
 for(const key of ['compilerProfile','hostConfig'])checkFile(config[key]?.file,config[key]?.sha256,'CONFIG_PIN');
 const profile=readJson(config.compilerProfile.file),host=readJson(config.hostConfig.file);
 const expected={module:target.module,moduleKey:target.moduleKey,screen:target.screenName,screenKey:target.screenKey};
 if(profile.schema!=='ssam-native-preview-profile/1'||profile.kind!=='native-screen'||profile.backend!=='deny-all'||profile.consumerStaticEntities!=='none'||profile.closure!=='derive-from-native-model'||canonical(profile.target)!==canonical(expected)||canonical(host.target)!==canonical(expected))fail('PROFILE_TARGET','Compiler profile, watcher target and host target must match');
 if(host.schema!=='ssam-official-live-host-config/2'||host.bindHost!=='127.0.0.2'||!Number.isInteger(host.port)||host.port<1||host.port>65535||host.stableSessionId!==config.sessionId)fail('HOST_CONFIG','An explicit local host and matching session are required');
 if(profile.scenarioContract?.sha256!==host.scenarioContract?.sha256||path.resolve(profile.scenarioContract.path)!==path.resolve(host.scenarioContract.file))fail('SCENARIO_CONTRACT','Compiler and host scenario must match');
 checkFile(host.scenarioContract.file,host.scenarioContract.sha256,'SCENARIO_PIN');
 const scenario=readJson(host.scenarioContract.file);
 if(scenario.transport?.length!==0)fail('SCENARIO_TRANSPORT','This profile permits no application backend transport');
 for(const [watcherKey,hostKey]of [['selectionFile','selectionFile'],['statusFile','statusFile'],['hostStateFile','stateFile']])if(path.resolve(config[watcherKey])!==path.resolve(host[hostKey]))fail('HOST_PATHS','Watcher and host must share their selected state paths');
 return {profile,host,expected};
}
export function verifyCompilerReadiness(config){
 const pin=config.compilerImplementationLock;
 if(!pin)fail('COMPILER_NOT_FINAL','Compiler implementation lock was absent at configuration time; create a newly reviewed configuration');
 checkFile(pin.file,pin.sha256,'COMPILER_LOCK_CHANGED');
 const runner=fs.readFileSync(config.compiler.file,'utf8'),embedded=/const LOCK_SHA256\s*=\s*['"]([a-f0-9]{64})['"]/.exec(runner)?.[1];
 if(embedded!==pin.sha256)fail('COMPILER_LOCK_UNBOUND','Compiler entry point does not bind this implementation lock');
 const lock=readJson(pin.file);if(!Array.isArray(lock.pins)||!lock.pins.length)fail('COMPILER_LOCK_EMPTY','Compiler lock has no implementation pins');
 for(const p of lock.pins)checkFile(p.path,p.sha256,'COMPILER_IMPLEMENTATION_CHANGED');
}
export function verifyCodePins(config){
 if(!Array.isArray(config.codePins)||config.codePins.length<4)fail('CODE_PINS','Watcher code pins are required');
 const here=path.dirname(fileURLToPath(import.meta.url));
 for(const name of ['adapters.mjs','run.mjs','pipeline.mjs','pipe.mjs'])if(!config.codePins.some(p=>path.resolve(p.file)===path.join(here,name)))fail('CODE_PINS','Missing local watcher code pin: '+name);
 for(const pin of config.codePins)checkFile(pin.file,pin.sha256,'WATCHER_CODE_CHANGED');
}
export function readPreviousSelection(config){
 if(!fs.existsSync(config.selectionFile))return null;
 const {profile,host,expected}=validateConfiguration(config);
 const pointer=readJson(config.selectionFile);
 if(pointer.schema!=='ssam-official-live-selection/1'||pointer.sessionId!==config.sessionId||!Number.isSafeInteger(pointer.sequence)||pointer.sequence<0)fail('PREVIOUS_SELECTION','Invalid selection or another session owns it');
 checkFile(pointer.manifest.file,pointer.manifest.sha256,'PREVIOUS_RELEASE_HASH');
 const release=readJson(pointer.manifest.file);
 if(release.schema!=='ssam-official-live-release/2'||release.sessionId!==config.sessionId||release.sourceSha256!==pointer.sourceSha256||release.buildId!==pointer.buildId||release.source?.moduleKey!==config.target.moduleKey||release.source?.screenKey!==config.target.screenKey||release.testOnly===true||canonical(release.target)!==canonical(expected)||release.profile?.kind!==profile.kind||release.scenarioContract?.sha256!==host.scenarioContract.sha256)fail('PREVIOUS_RELEASE_IDENTITY','Previous release identity, target or scenario mismatch');
 checkFile(release.compilerManifest.file,release.compilerManifest.sha256,'PREVIOUS_COMPILER_MANIFEST');
 const emitter=readJson(release.compilerManifest.file);
 if(canonical(emitter.profile?.target)!==canonical(expected)||emitter.contracts?.scenarioContractSha256!==host.scenarioContract.sha256||emitter.source?.sha256!==pointer.sourceSha256)fail('PREVIOUS_COMPILER_PROFILE','Previous compiler manifest does not belong to this profile/source');
 checkFile(release.profile.routeCatalog.file,release.profile.routeCatalog.sha256,'PREVIOUS_CATALOG');
 const screen=readJson(release.profile.routeCatalog.file).screens?.find(s=>s.sourceNativeKey===config.target.screenKey);
 const entry=screen&&{view:screen.viewModuleName,model:screen.modelModuleName,controller:screen.controllerModuleName,flow:screen.webFlowControllerModuleName};
 if(!entry||canonical(entry)!==canonical(release.profile.entry)||canonical(entry)!==canonical(emitter.profile?.entry))fail('PREVIOUS_NATIVE_ENTRY','Previous entry does not match the pinned native route catalog');
 return {pointer,release};
}
export function verifyResult(result,sourceSha256,outputDirectory){
 if(result?.sourceSha256!==sourceSha256||!inside(outputDirectory,result.manifestPath??''))fail('RESULT_IDENTITY','Result must belong to this source and output directory');
 checkFile(result.manifestPath,result.manifestSha256,'RESULT_MANIFEST_HASH');
 return result;
}
const transientConnect=new Set(['PIPE_CONNECT','PIPE_CLOSED','ENOENT','EBUSY','ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT']);
const provenBeforeSend=(error,command)=>error.command===command&&error.phase==='connect'&&error.writeAttempted===false;
const beforeSend=(error,command)=>provenBeforeSend(error,command)&&transientConnect.has(error.code);
function deferred(error,command,phase){return Object.assign(new Error(error.message),{code:error.code||'CAPTURE_DEFERRED',command,phase,writeAttempted:false,captureDeferred:true,retryable:true});}
export function createNativeCapture(config,{bridge=bridgeClient(config.target.pid),now=()=>Date.now()}={}){
 const target=config.target,root=path.resolve(config.workspace),snapshots=path.join(root,'platforms/odc/snapshots');
 const markerFile=path.join(config.outputRoot,'capture-uncertainty.json');
 let uncertain=null;
 if(fs.existsSync(markerFile)){
  const saved=readJson(markerFile);
  if(saved.schema!=='ssam-capture-attempt/1'||canonical(saved.target)!==canonical(target))fail('CAPTURE_MARKER_IDENTITY','Capture attempt belongs to another target');
  if(saved.status==='pending')uncertain=saved;
  else if(!['not-sent','captured','reconciled'].includes(saved.status))fail('CAPTURE_MARKER_STATE','Unknown capture attempt state');
 }
 function record(status,values={}){const value={schema:'ssam-capture-attempt/1',target,status,...values};atomicJson(markerFile,value);return value;}
 function verifyCapture(value){
  if(value?.ok!==true||value.module!==target.module||value.moduleKey!==target.moduleKey||value.host!==target.host||!inside(snapshots,value.path??''))fail('CAPTURE_IDENTITY','Unexpected native capture identity or path');
  const hash=String(value.sha256??'').toLowerCase();checkFile(value.path,hash,'CAPTURE_HASH');
  if(!Number.isFinite(Date.parse(value.capturedAt)))fail('CAPTURE_TIME','Native capture timestamp is required');
  return {...value,sha256:hash};
 }
 return async function capture({revision}={}){
  if(typeof revision!=='string'||!revision)fail('CAPTURE_REVISION_REQUIRED','Capture requires the observed native revision');
  let precedingReconciliation=null;
  let s;
  try{s=await bridge('status');}catch(e){if(beforeSend(e,'status'))throw deferred(e,'status',e.phase);throw e;}
  if(s.ok===false&&(s.gate==='STUDIO_BUSY'||s.code==='STUDIO_BUSY'))throw deferred(Object.assign(new Error('Studio rejected status as busy; snapshot not sent'),{code:'STUDIO_BUSY'}),'status','status-preflight');
  const actualRoot=typeof s.root==='string'?path.resolve(s.root).toLowerCase():'';
  const allowedRoots=[root,path.join(root,'platforms/odc')].map(x=>path.resolve(x).toLowerCase());
  if(s.ok!==true||s.pid!==target.pid||s.bridge!=='v36'||!allowedRoots.includes(actualRoot))fail('STUDIO_IDENTITY','Studio/bridge/workspace changed');
  const matches=(s.modules??[]).filter(m=>m.key===target.moduleKey&&m.name===target.module&&m.host===target.host&&m.loggedIn===true);
  if(matches.length!==1)fail('STUDIO_TARGET','Authorized module is not uniquely open');
  if(s.busy||matches[0].mergePending||(s.dialogs??[]).some(d=>(d.actions??[]).length)||(s.modalWindows??[]).length){
   const e=deferred(new Error('Studio is busy; snapshot not sent'),'status','status-preflight');e.code='STUDIO_BUSY';throw e;
  }
  if(uncertain){
   const candidates=fs.readdirSync(snapshots).filter(n=>n.startsWith('Quotes-')&&n.endsWith('.oml.json')).map(n=>{try{return readJson(path.join(snapshots,n));}catch{return null;}}).filter(v=>v?.moduleKey===target.moduleKey&&v.host===target.host&&Date.parse(v.capturedAt)>=uncertain.startedAt).sort((a,b)=>Date.parse(b.capturedAt)-Date.parse(a.capturedAt));
   if(!candidates.length)throw Object.assign(new Error('Capture outcome is uncertain; reconciliation required, no snapshot replay'),{code:'CAPTURE_RECONCILIATION_REQUIRED',command:'snapshot Quotes',phase:'reconcile',writeAttempted:uncertain.writeAttempted,reconciliationRequired:true,retryable:false});
   const result=verifyCapture(candidates[0]),previousRevision=uncertain.observedRevision??null;
   precedingReconciliation={observedRevision:previousRevision,capture:result};
   record('reconciled',{startedAt:uncertain.startedAt,observedRevision:previousRevision,capture:result});uncertain=null;
   if(previousRevision===revision)return {...result,captureRevision:revision};
   // Old/unknown intent is now resolved. These bytes cannot stand for a newer
   // revision; continue with a distinct, fresh capture for that revision.
  }
  const startedAt=now();
  // Persist intent before dispatch: a process interruption cannot turn uncertainty into replay.
  uncertain=record('pending',{startedAt,observedRevision:revision,command:'snapshot Quotes',phase:'dispatch-intent',writeAttempted:null,precedingReconciliation});
  let responded=false;
  try{
   const r=await bridge('snapshot Quotes');
   responded=true;
   if(r.ok!==true)throw Object.assign(new Error(r.error||'Native snapshot did not complete successfully'),{code:r.gate||'CAPTURE_FAILED',command:'snapshot Quotes',phase:'response',writeAttempted:true});
   const result=verifyCapture(r);record('captured',{startedAt,observedRevision:revision,capture:result,precedingReconciliation});uncertain=null;return {...result,captureRevision:revision};
  }catch(e){
   if(provenBeforeSend(e,'snapshot Quotes')){
    record('not-sent',{startedAt,observedRevision:revision,command:e.command,phase:e.phase,writeAttempted:false,precedingReconciliation});uncertain=null;
    if(transientConnect.has(e.code))throw deferred(e,e.command,e.phase);
    e.retryable=false;throw e;
   }
   uncertain=record('pending',{startedAt,observedRevision:revision,command:'snapshot Quotes',phase:e.phase||'verify-response',writeAttempted:responded?true:typeof e.writeAttempted==='boolean'?e.writeAttempted:null,precedingReconciliation,error:{code:e.code||'CAPTURE_FAILED',message:e.message}});
   throw Object.assign(new Error('Snapshot outcome requires reconciliation: '+e.message),{code:'CAPTURE_UNCERTAIN',causeCode:e.code,command:'snapshot Quotes',phase:uncertain.phase,writeAttempted:uncertain.writeAttempted,reconciliationRequired:true,retryable:false});
  }
 };
}
export async function createOfficialAdapters(config){
 verifyCodePins(config);
 validateConfiguration(config);verifyCompilerReadiness(config);
 const target=config.target,outRoot=path.resolve(config.outputRoot);
 for(const key of ['compiler','assembler'])checkFile(config[key].file,config[key].sha256,'ADAPTER_PIN');
 const {compileCapture}=await import(pathToFileURL(config.compiler.file));
 const {assembleRelease}=await import(pathToFileURL(config.assembler.file));
 if(typeof compileCapture!=='function'||typeof assembleRelease!=='function')fail('ADAPTER_EXPORT','Compiler/assembler contracts unavailable');
 const signal=signalClient(target.pid);let attempt=0;
 return {
  readSignal:()=>signal('signal'),
  capture:createNativeCapture(config),
  async exportCapture(captured){
   verifyCodePins(config);
   validateConfiguration(config);verifyCompilerReadiness(config);
   checkFile(config.compiler.file,config.compiler.sha256,'ADAPTER_PIN');
   const run=path.join(outRoot,'runs',Date.now()+'-'+process.pid+'-'+(++attempt));fs.mkdirSync(run,{recursive:true});
   const source=path.join(run,'capture.oml');fs.copyFileSync(captured.path,source,fs.constants.COPYFILE_EXCL);checkFile(source,captured.sha256,'CAPTURE_COPY_HASH');atomicJson(source+'.json',captured);
   const outputDirectory=path.join(run,'compiler');
   const previous=readPreviousSelection(config);
   const comparison=previous?{comparisonManifestPath:previous.release.compilerManifest.file,comparisonManifestSha256:previous.release.compilerManifest.sha256}:{};
   const result=verifyResult(await compileCapture({capturePath:source,sourceSha256:captured.sha256,outputDirectory,expectedModuleKey:target.moduleKey,expectedScreenKey:target.screenKey,profilePath:config.compilerProfile.file,profileSha256:config.compilerProfile.sha256,...comparison}),captured.sha256,outputDirectory);
   return {...result,run,capturePath:source};
  },
  async linkExport({captured,exported}){
   verifyCodePins(config);
   validateConfiguration(config);
   checkFile(config.assembler.file,config.assembler.sha256,'ADAPTER_PIN');
   verifyResult(exported,captured.sha256,path.join(exported.run,'compiler'));
   const outputDirectory=path.join(exported.run,'release');
   const result=verifyResult(await assembleRelease({compilerManifestPath:exported.manifestPath,compilerManifestSha256:exported.manifestSha256,sourceSha256:captured.sha256,outputDirectory,sessionId:config.sessionId,configFile:config.hostConfig.file}),captured.sha256,outputDirectory);
   if(typeof result.buildId!=='string'||!result.buildId)fail('BUILD_ID','Assembled release lacks build identity');
   return {...result,run:exported.run,compiler:exported,acquisitionSha256:result.manifestSha256,receipt:result.manifestPath};
  },
  async activate({captured,exported,revision}){
   verifyCodePins(config);validateConfiguration(config);
   verifyResult(exported,captured.sha256,path.join(exported.run,'release'));
   let sequence=1;
   if(fs.existsSync(config.selectionFile)){const old=readJson(config.selectionFile);if(old.schema!=='ssam-official-live-selection/1'||old.sessionId!==config.sessionId||!Number.isSafeInteger(old.sequence))fail('SELECTION_IDENTITY','Existing selection is from another session');sequence=old.sequence+1;}
   const selection={schema:'ssam-official-live-selection/1',sessionId:config.sessionId,sequence,manifest:{file:exported.manifestPath,sha256:exported.manifestSha256},sourceSha256:captured.sha256,buildId:exported.buildId,entryScreenKey:target.screenKey,compilerProfile:config.compilerProfile,observedRevision:revision,capturedAt:captured.capturedAt,promotedAt:new Date().toISOString(),timings:{compiler:exported.compiler.timings,assembly:exported.timings},origin:'original-o11-compiler-on-adapted-odc-model'};
   atomicJson(config.selectionFile,selection);atomicJson(path.join(exported.run,'promotion.json'),selection);
  }
 };
}
