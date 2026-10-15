import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { actionModel, scopeRoots, traceWindow } from './debug-wrapper.mjs';
import { headlessDebug } from './debug-runtime.mjs';
import { compactServerMap } from './debug-o11-native-run.mjs';
import { createOdcTimerPortalAdapter } from '../portal/runtime/timer-background.mjs';
import { Odc3PortalBroker } from '../portal/runtime/odc3-context.mjs';
import { PortalReadAdapter } from '../portal/runtime/portal-read.mjs';
import { keyToGuid } from './debug-odc-native-runtime.mjs';
import { backgroundThreadOutcome, backgroundValuesCoverage } from './debug-background-correlation.mjs';
import { createOdcTimerInstanceObserver, bindOdcTimerInstance, requestIdShapeOf, INSTANCE_SECONDS } from './debug-odc-background-instance.mjs';
import { PORTAL_WAKE_TRIGGER, assertPortalWakeInput, bindPortalWakeScope, portalWakeDeadline, assertPortalWakeBeforePost } from './debug-odc-portal-wake-interactive.mjs';

const fail = code => { throw new Error('debug_odc_timer_' + code); };
const hash = text => createHash('sha256').update(text).digest('hex');
const KEY = /^[A-Za-z0-9_+]{22}$/;
const unproved = { requestOwnershipProved:false, applicationUserContext:false, appUserIdentityProved:false,
  rolesProved:false, propagationProved:false, valuesComplete:false, executionCompleted:false };
const write = (file,value) => { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file+'.tmp',JSON.stringify(value)); fs.renameSync(file+'.tmp',file); };
function complete(node) {
  if (!node || !Array.isArray(node.children) || node.childrenOmitted !== 0 || node.childrenTotal !== node.children.length ||
      Object.keys(node.propertyErrors??{}).length || Object.keys(node.propertiesOmitted??{}).length || node.propertiesMissing?.length) fail('target_scope_unread');
  for (const child of node.children) complete(child);
}
export async function prepareOdcBackgroundTrace(input, prepared, readers) {
  const timer = prepared.adapter;
  if (timer?.trigger !== 'odc-portal-timer-wake' || !['Timer','ServerAction'].includes(prepared.action?.kind)) fail('target_kind_unsupported');
  const key = prepared.action.kind === 'Timer' ? timer.actionKey : prepared.action.key;
  if (prepared.action.kind === 'Timer' && prepared.action.key !== timer.entryKey ||
      prepared.action.kind === 'ServerAction' && (prepared.path?.[0]?.key !== timer.entryKey || prepared.path?.at(-1)?.key !== key)) fail('target_not_reachable');
  const tree = await readers.tree('@'+key); complete(tree);
  if (tree.key !== key || tree.kind !== 'ServerAction' || /^Reference:/.test(tree.path??'') || !KEY.test(key)) fail('target_module_or_model_unavailable');
  const model = actionModel(tree), mode = input.trace ?? 'nodes', roots = scopeRoots(model, Number.MAX_SAFE_INTEGER);
  if (!KEY.test(model.start??'')) fail('target_start_node_unread');
  const window = traceWindow(model,input.window);
  return { mode, functionKey:key, startNodeKey:model.start, nodeKeys:window.entries, steps:window.steps,
    depth:input.depth??2, fullValues:mode==='full', scopes:mode==='full'?{[key]:roots.slice(0,60)}:{},
    omittedScopeRoots:Math.max(0,roots.length-60), sourceSha256:readers.sourceContract.sha256,
    observationSeconds:Math.min(60,input.timeoutSeconds??30), contextMode:'native-background', ...unproved };
}
// Same request-bound matcher as the app-caller runners: a ThreadEnd counts only for the same (threadId, fingerprint).
export function odcBackgroundTrace(lines, functionKey) {
  const target = lines.filter(x=>x.kind!=='thread-end'&&x.functionKey===functionKey);
  return {functionKey,...backgroundThreadOutcome(lines,functionKey),visits:compactServerMap(target),...unproved};
}
const portalState = ({applicationUserContext:_a,appUserIdentityProved:_b,rolesProved:_r,propagationProved:_p,requestOwnershipProved:_o,executionCompleted:_e,...state}) => state;

export async function runOdcNativeBackground(input, prepared, readers, services = {}) {
  if (input.contextMode !== 'native-background' || typeof input.words !== 'string' || !input.words.trim()) fail('explicit_authorization_required');
  if (input.context !== undefined || prepared.scenarios.some(s=>s.context!==undefined)) fail('owner_context_unsupported');
  if (prepared.scenarios.length !== 1 || Object.keys(prepared.scenarios[0].inputs??{}).length) fail('timer_has_no_direct_inputs');
  // Interactive Portal wake (run.trigger:'portal-wake' in the server session): no launch, inputs or Workflow.
  const interactive=typeof services.prepareServerInspection==='function';
  try{assertPortalWakeInput(input,interactive);}catch(error){return {ok:false,state:'refused',lane:'odc',contextMode:'native-background',error:error.message,...unproved};}
  const trace = await prepareOdcBackgroundTrace(input,prepared,readers);
  const root=services.root??workspaceRoot, binding=readers.binding, operationId=randomUUID();
  const base=path.join(root,'.local','debugger'), id=hash('odc|'+binding.runtimeUrl+'|'+binding.moduleKey);
  const dir=path.join(base,'native-runs','odc',operationId), lock=path.join(base,'native-runs',id+'.lock'), latest=path.join(base,'native-runs','odc',id+'.json');
  const report={schema:'ssam-odc-native-run/1',operationId,lane:'odc',execution:'native-entry',contextMode:'native-background',
    binding,entry:prepared.entry,path:prepared.path,callPath:prepared.callPath,state:'preparing',results:[],
    startedAt:new Date().toISOString(),receiptPath:path.join(dir,'receipt.json'),tracePlan:trace,...unproved,
    ...(interactive||input.trigger?{trigger:PORTAL_WAKE_TRIGGER}:{}),wakeOwnershipProved:false,
    wakeOwnership:{basis:'portal-one-send-receipt',nativeLimit:'portal_wake_has_no_app_trace_span_link'}};
  const save=()=>{write(report.receiptPath,report);write(latest,report);};
  const debug=services.debug??headlessDebug;
  const traceRead=services.traceRead??(sessionId=>{const file=path.join(base,sessionId,'trace.jsonl');return fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];});
  const observe=services.observeBackground??(async(sessionId,key,seconds)=>{const end=Date.now()+seconds*1000;while(Date.now()<end){const data=odcBackgroundTrace(traceRead(sessionId),key);if(data.captured&&data.observedThreadEnds)return;await new Promise(r=>setTimeout(r,150));}});
  let ownsLock=false, uncertain=false, traceSession, broker, ownsBroker=false, deadline, reservedAt, plan, receipt, instance=services.timerInstance??null;
  try {
    if (fs.existsSync(path.join(base,'blocked-bindings',id+'.json')) || fs.existsSync(path.join(base,'native-background-bindings',id+'.lock')) ||
        fs.existsSync(path.join(base,'native-endpoint-bindings',id+'.lock'))) fail('binding_blocked');
    fs.mkdirSync(path.dirname(lock),{recursive:true});const fd=fs.openSync(lock,'wx');ownsLock=true;
    try{fs.writeFileSync(fd,JSON.stringify({operationId,state:'preparing'}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);} save();
    // Bind the Timer body scope before any Portal read, debugger start or request.
    if (interactive) await bindPortalWakeScope(services,{binding,readers,trace});
    let adapter=services.backgroundAdapter;
    if (!adapter) {
      broker=services.portalBroker??new Odc3PortalBroker(); ownsBroker=!services.portalBroker;
      if (broker.origin!==prepared.adapter.portalOrigin) fail('managed_portal_target_unavailable');
      // This run explicitly authorizes background work. Portal developer authentication
      // stays separate from the app user; no Studio/browser cookies are extracted.
      if (!broker.authenticated) {await broker.initialize();const auth=await broker.authenticate();if (!auth?.ok||!broker.authenticated) fail('portal_session_required');}
      adapter=createOdcTimerPortalAdapter({broker,root});
    }
    plan=await adapter.prepare(prepared.adapter);report.background={...plan};save();
    // Read-only Portal correlator over the same developer session; the Portal wake has no app caller.
    if (!instance&&broker&&trace.mode!=='none') instance=createOdcTimerInstanceObserver({read:new PortalReadAdapter({target:'odc3',origin:broker.origin,broker,timeoutMs:30000}),
      identity:{environmentKey:plan.environmentKey,applicationKey:keyToGuid(binding.moduleKey),timerName:plan.name,callerName:null},readState:async()=>portalState(await adapter.readState(plan))});
    if (trace.mode!=='none') {
      const started=await debug({op:'watch',lane:'odc',tenant:binding.tenant,module:binding.module,moduleKey:binding.moduleKey,runtimeUrl:binding.runtimeUrl,
        nodeKeys:trace.nodeKeys,seconds:trace.observationSeconds+30,pauseSeconds:5,autoContinue:true,paths:[],
        trace:{mode:'step',steps:trace.steps,depth:trace.depth,fullValues:trace.fullValues,scopes:trace.scopes,
          focusFunctionKey:trace.functionKey,requireFunctionKey:trace.functionKey}}, {backgroundWatch:true,contextMode:'native-background'});
      traceSession=started?.sessionId;report.serverTrace={sessionId:traceSession,state:started?.state,contextMode:'native-background',requestOwnershipProved:false};
      if (!started?.ok||started.state!=='connected'){uncertain=!!traceSession;fail('trace_not_connected');}
      if (interactive){const fixed=portalWakeDeadline(started);deadline=fixed.deadline;Object.assign(report.serverTrace,{inspectionMode:'interactive',requestDeadline:fixed.requestDeadline});}
    }
    if (interactive){await services.beforeServerInvocation?.();assertPortalWakeBeforePost(deadline);}
    report.state='scheduling';save();reservedAt=Date.now();
    try {receipt=await adapter.run(plan,{operationId,context:'native-background',authorizationWords:input.words,inputs:{}});}
    catch {uncertain=true;fail('trigger_outcome_uncertain');}
    report.background.result=receipt;report.results.push({name:prepared.scenarios[0].name,scheduled:receipt.scheduled===true,...unproved});
    uncertain=receipt.uncertain===true;report.state=uncertain?'uncertain':receipt.scheduled?'scheduled':'refused';save();
    if (traceSession&&receipt.scheduled&&!uncertain){report.state='observing-background';save();
      await observe(traceSession,trace.functionKey,interactive?Math.max(0,(deadline-Date.now())/1000):trace.observationSeconds);report.state='scheduled';}
    return report;
  } catch(error) {
    report.state=uncertain?'uncertain':'refused';report.error=error?.code==='EEXIST'?'debug_odc_timer_binding_blocked':/^debug_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_timer_failed';return report;
  } finally {
    if(traceSession){try{const stopped=await debug({op:'stop',sessionId:traceSession});report.serverTrace.stopped=stopped?.ok===true&&stopped.state==='stopped';}
      catch{report.serverTrace.stopped=false;} uncertain ||= !report.serverTrace.stopped;
      try{const lines=traceRead(traceSession);report.backgroundTrace=odcBackgroundTrace(lines,trace.functionKey);
        if(report.backgroundTrace.fingerprints.length===1)report.instanceRequestIdShape=requestIdShapeOf(lines,report.backgroundTrace.fingerprints[0]);}catch{report.traceReadFailed=true;}
      // Values coverage per scope root from native reads of the interactive session only.
      try{report.valuesCoverage=interactive&&services.scopeEvidence?backgroundValuesCoverage({modelRoots:trace.scopes[trace.functionKey]??[],omittedRoots:trace.omittedScopeRoots,stops:await services.scopeEvidence()}):{valuesComplete:false,reason:'bounded_trace_without_native_completeness'};}
      catch{report.valuesCoverage={valuesComplete:false,reason:'native_scope_reads_unavailable'};}
      report.valuesComplete=report.valuesCoverage.valuesComplete===true;if(report.background)report.background.valuesComplete=report.valuesComplete;
      if(report.results.at(-1))report.results.at(-1).valuesCoverage=report.valuesCoverage;
    }
    if(trace.mode!=='none'){
      // After the answered wake, ThreadEnd and debugger stop: read-only Portal correlation; never re-wakes or re-posts.
      const thread=report.backgroundTrace;
      if(receipt?.scheduled===true&&!uncertain&&thread){
        if(!instance)report.instanceCorrelation=bindOdcTimerInstance(null,thread);
        else{const deadlineAt=Date.now()+INSTANCE_SECONDS*1000;
          report.instanceWindow={since:new Date(reservedAt-5000).toISOString(),until:new Date(deadlineAt).toISOString()};report.instanceIdentity=instance.identity??null;
          let found;try{found=await instance.observe({baseline:{available:true,state:plan?.nativePreparation?.before??null},threadOutcome:thread,
            requestIdShape:report.instanceRequestIdShape??null,window:report.instanceWindow,deadlineAt});}
          catch{found={state:'unavailable',reason:'portal_read_failed',instanceCorrelationProved:false,executionCompleted:false};}
          report.instanceCorrelation=bindOdcTimerInstance(found,thread);}
      } else report.instanceCorrelation={state:'not-observed',reason:receipt?.scheduled===true?'wake_uncertain_or_untraced':'wake_not_scheduled',instanceCorrelationProved:false,executionCompleted:false,wakeOwnershipProved:false};
      const found=report.instanceCorrelation;
      Object.assign(report,{instanceCorrelationProved:found.instanceCorrelationProved===true,executionCompleted:found.executionCompleted===true&&!uncertain,outcome:found.outcome??'unproved'});
      if(services.timerInstance){try{report.portalCredentialsReleased=(await services.timerInstance.release?.())?.released!==false;}catch{report.portalCredentialsReleased=false;} uncertain ||= !report.portalCredentialsReleased;}
    }
    if(ownsBroker){try{await broker.jar.removeAllCookies();broker.credentialRegistry?.reset();broker.authenticated=false;report.portalCredentialsReleased=true;}catch{report.portalCredentialsReleased=false;uncertain=true;}}
    report.finishedAt=new Date().toISOString();report.uncertain=uncertain;
    if(uncertain)report.executionCompleted=false;
    report.ok=report.state==='scheduled'&&!uncertain&&(trace.mode==='none'||report.backgroundTrace?.requestBound===true);
    if(!report.ok&&!report.error&&report.state==='scheduled'&&!uncertain&&trace.mode!=='none')report.error='debug_odc_timer_request_bound_thread_end_missing';
    if(uncertain)report.state='uncertain';
    if(ownsLock){report.lockRetained=uncertain;if(!uncertain){try{fs.unlinkSync(lock);}catch{report.lockRetained=true;report.ok=false;}}save();}
  }
}
