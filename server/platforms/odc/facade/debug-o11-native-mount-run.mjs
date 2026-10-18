// Mounted O11 Reactive screen through the ORIGINAL bootstrap (option B for O11,
// same barrier as ODC). The published app runs in an owned headless Chrome whose
// network is denied except for the guarded host transport; assets are the
// published, hash-pinned version. The app user signs in through the original
// login controller in a preparation realm that is discarded; the inspector is
// configured after sign-in and started before the original bootstrap runs once,
// unchanged, in a clean realm (it fires the application-ready event and loads the
// router, which requires the screen controllers).
//
// The barrier is the user's Development authorization (words recorded before
// any download or browser) plus the recorded decision for an O11 owned-browser
// mount. It is NOT a static proof of effects: staticEffectsQualified:false. No
// evaluator, no forced flag, no handler called by hand and no synthetic event:
// the original router mounts the default screen and the native debugger observes it.
import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {workspaceRoot} from './workspace.mjs';
import {o11MountPolicy} from './debug-o11-browser-mount.mjs';
import {odcHandlerCoverage,odcLifecycleCompletion,odcChromeExecutable} from './debug-odc-native-mount-run.mjs';
import {o11NativeLoginSpecValid} from './debug-o11-native-entry.mjs';

const fail=code=>{throw new Error('debug_o11_native_mount_'+code);};
const KEY=/^[A-Za-z0-9_+]{22}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,1));fs.renameSync(file+'.tmp',file);};
const publicError=error=>error?.code==='EEXIST'?'debug_o11_native_mount_binding_busy'
  :/^debug_[a-z0-9_]+$/.test(error?.message??'')?error.message:'debug_o11_native_mount_failed';
export const o11MountDecision='o11-owned-browser-mount';
// The user's decision for an O11 owned-browser mount, recorded by the integrator; never written here.
export const o11MountDecisionFile=root=>path.join(root,'.local','debugger','decisions',o11MountDecision+'.json');
function readDecision(root){
  let value;try{value=JSON.parse(fs.readFileSync(o11MountDecisionFile(root),'utf8'));}catch{fail('decision_unrecorded');}
  if(value?.schema!=='ssam-debugger-decision/1'||value.decision!==o11MountDecision||value.approved!==true||!Number.isFinite(Date.parse(value.decidedAt)))fail('decision_unrecorded');
  return {decision:value.decision,decidedAt:value.decidedAt,sha256:sha(fs.readFileSync(o11MountDecisionFile(root)))};
}
// Recomputed from the per-binding DOM/native verdicts, not from a bare flag.
function renderVerifiedFrom(render){
  return render?.renderVerified===true&&Array.isArray(render.reasons)&&!render.reasons.length&&
    Array.isArray(render.roots)&&render.roots.length>0&&render.roots.every(r=>r?.present===true)&&
    Array.isArray(render.bindings)&&render.bindings.length>0&&
    render.bindings.every(b=>b?.present===true&&b.unique===true&&b.nativeRead===true&&b.typeSupported===true&&b.matches===true);
}

export async function runO11NativeMount(input,prepared,readers,services={}){
  // Refusals that need no live state come before the lock and any download.
  if(services.requireClientInspection!==true)fail('client_inspection_required');
  if(!wordsGiven(input.words))fail('explicit_authorization_required'); // CX15 r7: one predicate
  const mountPlan=prepared?.mount??{};
  if(mountPlan.navigation!==undefined)fail('navigation_unsupported');
  if(mountPlan.interactions!==undefined)fail('interactions_unsupported');
  if(mountPlan.route!==undefined&&mountPlan.route?.default!==true)fail('route_unsupported');
  // The default route only: no screen inputs, one scenario.
  if(input.context!==undefined||!Array.isArray(prepared.scenarios)||prepared.scenarios.length!==1||
    prepared.scenarios.some(s=>s.context!==undefined||Object.keys(s.inputs??{}).length))fail('screen_inputs_unsupported');
  const binding=readers.binding,screenKey=mountPlan.screenKey;
  if(!KEY.test(screenKey??''))fail('screen_required');
  let runtimeHost;try{runtimeHost=new URL(binding?.runtimeUrl).hostname;}catch{runtimeHost=undefined;}
  if(binding?.lane!=='o11'||!KEY.test(binding.moduleKey??'')||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.module??'')||
    binding.runtimeUrl!=='https://'+binding.host+'/'+binding.module+'/'||runtimeHost!==binding.host||
    !Number.isSafeInteger(binding.publishedVersionId)||binding.publishedVersionId<1)fail('development_binding_required');
  if(!o11NativeLoginSpecValid(prepared.login,{module:binding.module,runtimeUrl:binding.runtimeUrl}))fail('login_contract_required');
  if(!/^[a-f0-9]{64}$/i.test(readers.sourceContract?.sha256??''))fail('model_source_required');
  // The published version is re-checked before the browser and before the mount; never skipped.
  if(typeof readers.verifyPublication!=='function')fail('publication_check_required');
  const root=services.root??workspaceRoot,base=path.join(root,'.local','debugger');
  const decision=readDecision(root);
  const sessionId=services.sessionId??randomUUID().replaceAll('-','');
  if(!/^[a-f0-9]{32}$/.test(sessionId))fail('session_id_invalid');
  // The same per-binding mutex and latest receipt as every O11 native run.
  const operationId=randomUUID(),folder=path.join(base,'native-runs','o11',binding.host);
  const dir=path.join(folder,operationId),lock=path.join(folder,binding.moduleKey+'.lock'),latest=path.join(folder,binding.moduleKey+'.json');
  const settleMs=services.settleMs??3000,pollMs=services.pollMs??100;
  const publicBinding={lane:'o11',host:binding.host,runtimeUrl:binding.runtimeUrl,module:binding.module,moduleKey:binding.moduleKey,
    applicationKey:binding.applicationKey??null,publishedVersionId:binding.publishedVersionId};
  const report={schema:'ssam-o11-native-run/1',operationId,sessionId,lane:'o11',execution:'native-entry',lifecycle:'mounted',
    mountPolicy:o11MountPolicy,staticEffectsQualified:false,binding:publicBinding,entry:prepared.entry,screenKey,state:'preparing',
    startedAt:new Date().toISOString(),receiptPath:path.join(dir,'receipt.json'),results:[],
    lifecycleComplete:false,renderVerified:false,appRequestIdentityProved:false,userRequestIsolationProved:false,route:{default:true}};
  const save=()=>{write(report.receiptPath,report);write(latest,report);};
  // Each journal entry is written once (wx): a lost reply can never be re-recorded as a fresh submission.
  const journal=(name,apply)=>async metadata=>{
    try{fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify({operationId,at:new Date().toISOString(),metadata}),{flag:'wx',flush:true});}
    catch{return {recorded:false};}
    apply(metadata);save();return {recorded:true};
  };
  async function verifyPublication(phase){
    try{await readers.verifyPublication();}
    catch(error){report.failurePhase=phase;throw /^debug_[a-z0-9_]+$/.test(error?.message??'')?error:new Error('debug_o11_native_mount_publication_check_failed');}
  }
  let ownsLock=false,uncertain=false,browser,broker,descriptor;
  try{
    const blocked=(services.blocked??(await import('./debug-o11-native-run.mjs')).blockedBinding)(root,binding.host,binding.moduleKey);
    if(blocked)fail('binding_blocked');
    // The user's words first (wx, in this operation's own folder), then the binding lock.
    fs.mkdirSync(dir,{recursive:true});
    const authorizationFile=path.join(dir,'authorization.json');
    // CX15 r5 (N-3): the file keeps wordsSha256 of the user's words, never the words (authorizationSha256 = sha of the file).
    fs.writeFileSync(authorizationFile,JSON.stringify({schema:'ssam-o11-mount-authorization/1',policy:o11MountPolicy,operationId,wordsSha256:sha(String(input.words)),
      decision,host:binding.host,module:binding.module,moduleKey:binding.moduleKey,runtimeUrl:binding.runtimeUrl,publishedVersionId:binding.publishedVersionId,
      screenKey,sourceSha256:readers.sourceContract.sha256.toLowerCase(),route:report.route,at:new Date().toISOString()}),{flag:'wx',flush:true});
    const authorizationSha256=sha(fs.readFileSync(authorizationFile));
    report.authorizationSha256=authorizationSha256;
    const fd=fs.openSync(lock,'wx');ownsLock=true;
    try{fs.writeFileSync(fd,JSON.stringify({operationId,sessionId,kind:'authorized-mount'}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    save();
    const runtime=await (services.acquire??(await import('./debug-o11-browser-assets.mjs')).acquireO11BrowserAssets)(
      {binding,versionId:binding.publishedVersionId,directory:path.join(dir,'assets')});
    if(runtime.runtimeUrl!==binding.runtimeUrl)fail('runtime_url_mismatch');
    if(runtime.versionId!==binding.publishedVersionId)fail('publication_changed');
    // Qualified before any browser exists: reviewed bootstrap, Development appDefinition, pinned index.
    const plan=(services.planAssets??(await import('./debug-o11-browser-assets.mjs')).planO11BrowserAssets)(runtime);
    if(plan.versionId!==binding.publishedVersionId)fail('publication_changed');
    report.assets={versionId:plan.versionId,versionToken:plan.versionToken,bootstrapQualified:plan.bootstrap?.bootstrapQualified===true,
      bootstrapSha256:plan.bootstrap?.sha256,developmentProved:plan.appDefinition?.developmentProved===true,
      pins:Object.fromEntries(Object.entries(runtime.pins??{}).map(([name,pin])=>[name,pin.sha256]))};
    if(!report.assets.bootstrapQualified||!report.assets.developmentProved)fail('assets_unqualified');
    await verifyPublication('publication-before-browser');
    report.state='preparing-browser';save();
    browser=await (services.launchBrowser??(await import('./debug-native-browser-host.mjs')).launchNativeDebugBrowser)({
      directory:path.join(dir,'browser'),executable:services.chromeExecutable??odcChromeExecutable(),leaseMs:900000});
    broker=(services.broker??(await import('./debug-o11-native-browser-host.mjs')).createO11NativeMountBroker)({ownedBrowser:browser,
      mountAuthorization:{policy:o11MountPolicy,authorizationSha256,runtimeUrl:binding.runtimeUrl,screenKey},
      beforeBrowserSignIn:journal('sign-in-submission',()=>{report.signInSubmitted=true;}),
      recordBrowserSignInResult:journal('sign-in-result',result=>{report.signInResult=result;}),
      beforeBrowserMount:journal('mount-submission',()=>{report.mountSubmitted=true;}),
      recordBrowserMountResult:journal('mount-result',outcome=>{report.mountOutcome=outcome;})});
    const modelSources=await readers.clientInspectionModels?.()??[];
    const browserPrepared=await broker.prepareBrowser({runtime,binding:{...publicBinding,sessionId},prepared,modelSources});
    report.browser={prepared:browserPrepared?.prepared===true,initialized:browserPrepared?.receipt?.initialized===true};
    report.state='sign-in';save();
    const entered=await (services.prepareUser??(await import('./debug-app-user.mjs')).prepareDebugAppUser)({...publicBinding,seconds:600},{sessionId});
    if(!entered?.ok){report.state=entered?.state==='cancelled'?'cancelled':'sign-in-refused';return report;}
    descriptor=entered.descriptor;
    const sameTarget=services.sameTarget??(async()=>{const m=await import('./debug-app-user.mjs');
      return m.sameAppUserTarget(descriptor?.binding,m.appUserBinding(publicBinding,sessionId));});
    if(!await sameTarget())fail('app_user_scope_mismatch');
    // In a client session this also configures the native inspector with the selected breakpoints.
    const authenticated=await broker.authenticate(descriptor);
    if(authenticated?.authenticated!==true||authenticated.identityMatches!==true)fail('native_identity_unproved');
    report.authentication=authenticated;
    if(broker.inspectionActivity?.().configured!==true)fail('inspection_not_configured');
    await verifyPublication('publication-before-mount');
    report.state='mounting';save();
    try{report.mount=await broker.mountBrowser();}
    catch(error){
      // Only a durably recorded, confirmed reply makes the outcome known.
      const outcome=report.mountOutcome;
      uncertain=report.mountSubmitted===true&&!(typeof outcome?.invoked==='boolean'&&outcome.transportUnconfirmed!==true);
      throw error;
    }
    report.state='waiting-ready';save();
    let ready;
    report.errorPage={navigated:false,marked:null,valuesRead:false};
    // The original error path (handleError -> navigateToErrorPage), read-only. With
    // an exception stop or an observed error page it is a known native failure.
    const errorPath=async phase=>{
      const exceptions=(broker.inspectionActivity().exceptions??[]).map(e=>({function:e.function??null,type:e.type??'unknown'}));
      if(!exceptions.length&&ready?.errorPageObserved!==true)return;
      let observed;
      try{observed=typeof broker.observeBrowserErrorPage==='function'?await broker.observeBrowserErrorPage():undefined;}catch{observed=undefined;}
      const navigated=report.errorPage.navigated||observed?.navigated===true||observed?.historyNavigated===true;
      const marked=report.errorPage.marked===true||observed?.marked===true;
      const known=report.errorPage.marked===false||observed?.marked===false;
      report.errorPage={navigated,marked:marked?true:known?false:null,observed:observed?.observed===true,valuesRead:false};
      if(exceptions.length)report.exceptionStops=exceptions;
      if(!navigated&&!marked)return;
      report.lifecycleException={phase,knownNativeFailure:true,exceptionStops:exceptions.length,exceptions,errorPage:{navigated,marked}};
      fail(exceptions.length?'lifecycle_exception':'error_page_observed');
    };
    try{ready=await broker.waitForBrowserReady();}
    catch(error){await errorPath('ready');throw error;}
    report.applicationReady=ready?.nativeApplicationReady===true&&ready.nativePromiseCompleted===true;
    report.routerRendered=ready?.routerRendered===true;
    report.errorPage={navigated:ready?.errorPage?.navigated===true,marked:typeof ready?.errorPage?.marked==='boolean'?ready.errorPage.marked:null,valuesRead:false};
    // Hooks after ready (OnReady, OnRender, blocks) pause the original code
    // cooperatively. Hold the session until those pauses resume and stay quiet.
    report.state='observing-lifecycle';save();
    const deadline=Date.parse(descriptor.expiresAt);
    let activity=broker.inspectionActivity();
    while(!activity.ended&&Date.now()<deadline&&(activity.paused||Date.now()-activity.lastChangeAt<settleMs)){
      await new Promise(resolve=>setTimeout(resolve,pollMs));
      activity=broker.inspectionActivity();
    }
    report.lifecycleSettled=!activity.ended&&!activity.paused&&Date.now()-activity.lastChangeAt>=settleMs;
    report.inspection={stops:activity.stops,paused:activity.paused,ended:activity.ended===true};
    report.handlerCoverage=odcHandlerCoverage({views:mountPlan.views??[],startup:mountPlan.startup},binding.moduleKey,activity.functions);
    await errorPath('lifecycle');
    // Read-only DOM evidence once the lifecycle is quiet; a missing observer is unverified, not a failure.
    if(report.lifecycleSettled){
      try{report.render=typeof broker.observeBrowserRender==='function'?await broker.observeBrowserRender()
        :{renderVerified:false,error:'debug_o11_native_mount_render_unavailable'};}
      catch(error){report.render={renderVerified:false,error:publicError(error)};}
    }
    report.renderVerified=renderVerifiedFrom(report.render);
    report.results.push({name:prepared.scenarios[0]?.name??'mount',ok:report.applicationReady&&report.lifecycleSettled,
      startupCallbackReturned:report.mount?.startupCallbackReturned===true,applicationReady:report.applicationReady,
      lifecycleSettled:report.lifecycleSettled,nativeStops:activity.stops,lifecycleComplete:false,renderVerified:report.renderVerified});
    report.state='answered';
    return report;
  }catch(error){
    report.state=uncertain?'uncertain':'failed';report.error=publicError(error);
    if(error?.code==='EEXIST'&&!ownsLock)throw new Error('debug_o11_native_mount_binding_busy');
    return report;
  }finally{
    if(broker){
      try{report.cleanup=await broker.dispose();}catch{report.cleanup={completed:false};}
      uncertain||=report.cleanup?.completed!==true;
    }else if(browser){
      try{report.cleanup=await browser.dispose();}catch{report.cleanup={completed:false};}
      uncertain||=report.cleanup?.completed!==true;
    }
    // A submitted sign-in without a recorded answer stays unknown.
    if(report.signInSubmitted)uncertain||=report.signInResult?.answered!==true;
    if(descriptor){
      try{report.credentialsReleased=(await (services.releaseUser??(await import('./debug-app-user.mjs')).releaseDebugAppUser)(descriptor))?.ok===true;}
      catch{report.credentialsReleased=false;}
      uncertain||=!report.credentialsReleased;
    }
    if(ownsLock){
      report.finishedAt=new Date().toISOString();report.uncertain=uncertain;
      if(uncertain)report.state='uncertain';
      report.ok=report.state==='answered'&&!uncertain&&report.results.every(r=>r.ok);
      report.lockRetained=uncertain;
      if(!uncertain){try{fs.unlinkSync(lock);}catch{report.lockRetained=true;report.ok=false;}}
      // Computed last: the lock release is part of the evidence. No O11 in-app
      // navigation exists yet, so OnDestroy (and lifecycleComplete) stays unproved.
      Object.assign(report,odcLifecycleCompletion(report));
      for(const result of report.results)result.lifecycleComplete=report.lifecycleComplete;
      save();
    }
  }
}
