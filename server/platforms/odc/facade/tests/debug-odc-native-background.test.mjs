import './fixtures/isolated-profile.mjs';
import { foreignImport, gatedTest } from './fixtures/debug-foreign-gate.mjs';
// Port D7: timer-background, timer-screen-defaults pending in the consolidation; the tests that reach it skip by name (fixtures/debug-foreign-gate.mjs).
const test = gatedTest();
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareNativeBackground} from '../debug-native-background.mjs';
import {guidToKey,keyToGuid} from '../debug-odc-native-runtime.mjs';
import {debugRun,registerRunTools,nativeEntrySchema} from '../debug-run.mjs';
import {portalWakeStartAdmission,PORTAL_WAKE_TRIGGER} from '../debug-odc-portal-wake-interactive.mjs';
const { createOdcTimerPortalAdapter, TIMER_PORTAL_CONTRACT, verifyTimerPortalAssets } = await foreignImport('../../portal/runtime/timer-background.mjs', import.meta.url, 'timer-background', 'timer-screen-defaults');
const { createTimerScreenDefaults } = await foreignImport('../../portal/runtime/timer-screen-defaults.mjs', import.meta.url, 'timer-background', 'timer-screen-defaults');
const { prepareOdcBackgroundTrace, runOdcNativeBackground, odcBackgroundTrace } = await foreignImport('../debug-odc-native-background-run.mjs', import.meta.url, 'timer-background', 'timer-screen-defaults');
const FP='a'.repeat(64),OTHER='b'.repeat(64);

const op='11111111-2222-4333-8444-555555555555', stage='22222222-2222-4333-8444-555555555555', portfolio='33333333-2222-4333-8444-555555555555';
const moduleKey=guidToKey('44444444-2222-4333-8444-555555555555'), timerKey=guidToKey('55555555-2222-4333-8444-555555555555'), actionKey=guidToKey('66666666-2222-4333-8444-555555555555');
const child=(key,kind,name,children=[])=>({key,kind,name,path:kind+':'+name,children,childrenTotal:children.length,childrenOmitted:0,propertyReferences:{},properties:{Name:name},propertiesMissing:[],propertyErrors:{},propertiesOmitted:{}});
const binding={lane:'odc',tenant:'wrightflood.outsystems.dev',environmentKey:stage,module:'Store',moduleKey,runtimeUrl:'https://wrightflood-dev.outsystems.app/Store/',revision:42,sourceSha256:'a'.repeat(64)};
const tree=child(timerKey,'Timer','Nightly');tree.propertyReferences.Action={key:actionKey,kind:'ServerAction',path:'ServerAction:Run'};
const plan=()=>prepareNativeBackground({binding,entryKey:timerKey,model:{schema:'ssam-reading/1',model:'Store',sourceSha256:binding.sourceSha256,tree}});
const nativeState={isRunning:false,isPendingRun:false,lastRunDuration:0,currentStartedOn:'1900-01-01T00:00:00',lastRunStartedOn:'1900-01-01T00:00:00',lastRunFinishedOn:'1900-01-01T00:00:00',nextRunStartsOn:'1900-01-01T00:00:00'};
function fixture(t,change={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'odc-timer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const calls=[];
  const broker={target:'odc3',origin:'https://wrightflood.outsystems.dev',authenticated:true,
    jar:{getCookies:async()=>[{key:'crf',value:'private-csrf-value'}]},
    metadata:{resolve:async(m,v,a)=>({action:a,apiVersion:TIMER_PORTAL_CONTRACT.actions[a.split('/').at(-1)],moduleVersion:'native-v1'})},
    action:async(m,v,a,inputs,screen,signal,client)=>{calls.push({action:a,inputs,screen:structuredClone(screen),client});
      let data;
      if(a.endsWith('GetApplicationStages'))data={EnvironmentsApplicationVersion:[{Environment:{Key:stage,PortfolioKey:portfolio},IsDevEnv:true,DeployedAssetVersion:{AssetKey:keyToGuid(moduleKey),EnvironmentKey:stage,Revision:42,Url:binding.runtimeUrl}}]};
      else if(a.endsWith('CheckLatestDeployment'))data={HasOngoingDeployments:false};
      else if(a.endsWith('GetTimerInfo'))data={NotFound:false,TimerInfo:{Timer:{Key:keyToGuid(timerKey),Name:'Nightly'}}};
      else if(a.endsWith('GetCurrentTimerRunInformation'))data={TimerRunInformation:nativeState,CurrentDuration:0};
      else throw Error('unexpected action');return {data};},
    request:async(url,options)=>{calls.push({url,options});return {status:200,text:JSON.stringify({versionInfo:{hasApiVersionChanged:false,hasModuleVersionChanged:false},data:{}})}},...change};
  const adapter=createOdcTimerPortalAdapter({broker,root,verifyAssets:async()=>{}});
  return {root,broker,adapter,calls};
}
test('ODC Timer has original Portal trigger and native background identity; defaults keep NoAccess',()=>{
  const p=plan();assert.equal(p.executable,true);assert.equal(p.trigger,'odc-portal-timer-wake');assert.equal(p.environmentKey,stage);assert.equal(p.appUserIdentityProved,false);
  const state=createTimerScreenDefaults();assert.equal(Object.keys(state.screen).length,20);assert.equal(Object.keys(state.clientVariables).length,12);
  assert.equal(state.screen.ScreenPermissionsConfigurations.Configurations,'NoAccess');assert.equal(state.screen._idInDataFetchStatus,1);
});
test('prepare validates exact stage/deployment/timer without wake; one send uses original envelope and durable authorization',async t=>{
  const f=fixture(t),p=await f.adapter.prepare(plan());assert.equal(f.calls.some(c=>c.options?.method==='POST'),false);
  const original=f.broker.request;f.broker.request=async(url,o)=>{const saved=JSON.parse(fs.readFileSync(path.join(f.root,'.local/debugger/native-background/odc',op,'timer-trigger.json')));assert.equal(saved.state,'sending');return original(url,o);};
  const r=await f.adapter.run(p,{operationId:op,context:'native-background',authorizationWords:'Run this DEV Timer'});
  assert.equal(r.scheduled,true);assert.equal(r.executionCompleted,false);assert.equal(r.requestOwnershipProved,false);
  const wake=f.calls.find(c=>c.options);assert.deepEqual(Object.keys(wake.options.body).sort(),['inputParameters','versionInfo','viewName']);
  assert.deepEqual(wake.options.body.inputParameters,{StageKey:stage,ApplicationKey:keyToGuid(moduleKey),TimerKey:keyToGuid(timerKey)});
  assert.equal(wake.options.body.viewName,'Timers.timer');assert.equal(JSON.stringify(r).includes('private-csrf-value'),false);
  await assert.rejects(f.adapter.run(p,{operationId:op,context:'native-background',authorizationWords:'Run this DEV Timer'}),/already_submitted/);
  assert.equal(f.calls.filter(c=>c.options).length,1);
});
test('uncertain wake retains lock, never retries even with a new operation',async t=>{
  const f=fixture(t,{request:async()=>{throw Error('connection lost');}}),p=await f.adapter.prepare(plan());
  const r=await f.adapter.run(p,{operationId:op,context:'native-background',authorizationWords:'Run timer'});assert.equal(r.uncertain,true);assert.equal(r.lockRetained,true);
  const second=await f.adapter.run(p,{operationId:'77777777-2222-4333-8444-555555555555',context:'native-background',authorizationWords:'Run timer'});
  assert.equal(second.sent,false);assert.equal(second.error,'debug_odc_timer_already_submitted');
});
test('changed metadata, wrong scope, app-user context and forged prepared plans refuse',async t=>{
  const f=fixture(t),p=await f.adapter.prepare(plan());
  await assert.rejects(f.adapter.run(p,{operationId:op,context:'app-user',authorizationWords:'yes'}),/explicit_authorization_required/);
  await assert.rejects(f.adapter.run({...p},{operationId:op,context:'native-background',authorizationWords:'yes'}),/unprepared/);
  const native=f.broker.action;f.broker.action=async(...args)=>{const r=await native(...args);if(r.data.TimerInfo)r.data.TimerInfo.Timer.Key=portfolio;return r;};
  await assert.rejects(f.adapter.prepare(plan()),/timer_scope_mismatch/);
  f.broker.metadata.resolve=async()=>({apiVersion:'changed'});await assert.rejects(f.adapter.prepare(plan()),/contract_changed/);
});
test('historic app binding lock refuses wake without deleting its marker',async t=>{
  const f=fixture(t),p=await f.adapter.prepare(plan()),id=createHash('sha256').update('odc|'+binding.runtimeUrl+'|'+moduleKey).digest('hex');
  const file=path.join(f.root,'.local/debugger/native-runs',id+'.lock');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({operationId:'historic-uncertain'}));
  await assert.rejects(f.adapter.run(p,{operationId:op,context:'native-background',authorizationWords:'Run timer'}),/binding_blocked/);
  assert.equal(JSON.parse(fs.readFileSync(file)).operationId,'historic-uncertain');assert.equal(f.calls.some(c=>c.options),false);
});
test('public asset contract refuses changed bytes',async()=>{await assert.rejects(verifyTimerPortalAssets({origin:'https://wrightflood.outsystems.dev',request:async()=>({status:200,text:'different'})}),/contract_changed/);});
const assetRoot=path.resolve('.local/debugger/completion-20261004/odc-background-public-assets');
test('original public Timer assets match qualified pins without executing downloaded JS',{skip:!fs.existsSync(assetRoot)},async()=>{
  await verifyTimerPortalAssets({origin:'https://wrightflood.outsystems.dev',request:async url=>({status:200,text:fs.readFileSync(path.join(assetRoot,path.basename(new URL(url).pathname)),'utf8')})});
});
function runFixture(){const start=guidToKey('88888888-2222-4333-8444-555555555555');const action=child(actionKey,'ServerAction','Run',[child(start,'StartNode',''),child('local','LocalVariable','Counter')]);
  const prepared={adapter:plan(),action:{key:timerKey,kind:'Timer'},entry:{key:timerKey,entryKind:'timer'},path:[{key:timerKey,kind:'Timer'}],scenarios:[{name:'one',inputs:{}}]};
  const readers={binding,sourceContract:{sha256:binding.sourceSha256},tree:async()=>action};return {prepared,readers,start,action};}
test('Timer scopes come from original action, requested indirect ServerAction focuses its own values',async()=>{
  const {prepared,readers}=runFixture();const p=await prepareOdcBackgroundTrace({trace:'full',depth:4},prepared,readers);
  assert.equal(p.functionKey,actionKey);assert.equal(p.depth,4);assert.deepEqual(p.scopes,{[actionKey]:['Counter']});
  const foo=guidToKey('99999999-2222-4333-8444-555555555555');prepared.action={key:foo,kind:'ServerAction'};prepared.path.push({key:actionKey,kind:'ServerAction'},{key:foo,kind:'ServerAction'});
  const old=readers.tree;readers.tree=async q=>({...await old(q),key:foo,name:'Foo',path:'ServerAction:Foo'});
  const f=await prepareOdcBackgroundTrace({trace:'full'},prepared,readers);assert.equal(f.functionKey,foo);assert.deepEqual(f.scopes,{[foo]:['Counter']});
  prepared.action.kind='ClientAction';await assert.rejects(prepareOdcBackgroundTrace({},prepared,readers),/target_kind_unsupported/);
});
test('foreign frames and other thread ends never prove target capture',()=>{
  const r=odcBackgroundTrace([{kind:'node',functionKey:'other',threadId:1},{kind:'thread-end',threadId:1}],actionKey);assert.equal(r.captured,false);assert.equal(r.observedThreadEnds,0);
  const t=odcBackgroundTrace([{kind:'node',functionKey:actionKey,threadId:2,values:[]},{kind:'thread-end',threadId:1}],actionKey);assert.equal(t.captured,true);assert.equal(t.observedThreadEnds,0);assert.equal(t.executionCompleted,false);
});
test('Portal wake trace uses the same request-bound matcher: a reused threadId never attests another request',()=>{
  const reused=odcBackgroundTrace([{kind:'node',functionKey:actionKey,threadId:2,eventId:'5',nativeRequestIdSha256:FP},{kind:'thread-end',threadId:2,eventId:'9',nativeRequestIdSha256:OTHER}],actionKey);
  assert.equal(reused.captured,true);assert.equal(reused.observedThreadEnds,0);assert.equal(reused.traceVerified,false);assert.equal(reused.requestBound,false);assert.equal(reused.unmatchedEnds,1);
  const same=odcBackgroundTrace([{kind:'node',functionKey:actionKey,threadId:2,eventId:'5',nativeRequestIdSha256:FP},{kind:'thread-end',threadId:2,eventId:'9',nativeRequestIdSha256:FP}],actionKey);
  assert.equal(same.requestBound,true);assert.deepEqual(same.endedFingerprints,[FP]);assert.equal(same.executionCompleted,false);assert.equal(same.functionKey,actionKey);
  const loose=odcBackgroundTrace([{kind:'node',functionKey:actionKey,threadId:2,eventId:'5'},{kind:'thread-end',threadId:2,eventId:'9'}],actionKey);
  assert.equal(loose.traceVerified,true);assert.equal(loose.requestBound,false);
});
test('runner starts full ODC background watch, schedules once and always stops; no app user',async t=>{
  const f=fixture(t),{prepared,readers}=runFixture(),debugCalls=[];let sent=0;
  const report=await runOdcNativeBackground({contextMode:'native-background',words:'Run timer',trace:'full',depth:4},prepared,readers,{
    root:f.root,backgroundAdapter:{prepare:async p=>Object.freeze(p),run:async()=>{sent++;return{scheduled:true,uncertain:false};}},
    debug:async(a,b)=>{debugCalls.push([a,b]);return a.op==='watch'?{ok:true,state:'connected',sessionId:'watch-test'}:{ok:true,state:'stopped'};},
    observeBackground:async()=>{},traceRead:()=>[{kind:'node',functionKey:actionKey,threadId:1,eventId:'3',nativeRequestIdSha256:FP,values:[{path:'Counter',value:'1'}]},{kind:'thread-end',threadId:1,eventId:'4',nativeRequestIdSha256:FP}]});
  assert.equal(sent,1);assert.equal(debugCalls[0][0].trace.depth,4);assert.deepEqual(debugCalls[0][1],{backgroundWatch:true,contextMode:'native-background'});
  assert.equal(debugCalls.at(-1)[0].op,'stop');assert.equal(report.backgroundTrace.captured,true);assert.equal(report.backgroundTrace.observedThreadEnds,1);
  assert.equal(report.ok,true);assert.equal(report.executionCompleted,false);assert.equal(report.appUserIdentityProved,false);
});
test('runner trace failure prevents wake and still stops a created session',async t=>{
  const f=fixture(t),{prepared,readers}=runFixture();let sent=0,stops=0;
  const r=await runOdcNativeBackground({contextMode:'native-background',words:'Run timer',trace:'full'},prepared,readers,{root:f.root,
    backgroundAdapter:{prepare:async p=>p,run:async()=>{sent++;}},debug:async a=>a.op==='watch'?{ok:false,state:'failed',sessionId:'watch-fail'}:(stops++,{ok:true,state:'stopped'}),traceRead:()=>[]});
  assert.equal(sent,0);assert.equal(stops,1);assert.equal(r.ok,false);
});

test('public MCP Timer run preserves authorization and depth through strict dispatcher to native adapter',async t=>{
  const f=fixture(t),run=runFixture(),calls=[];
  const readers={...run.readers,resolveTarget:async()=>({...tree,inputs:[],closureCalls:[]}),
    properties:p=>p===tree.path?tree:null,inputs:()=>[],usages:()=>[],
    tree:async p=>p==='@'+timerKey?tree:run.action};
  const services={root:f.root,readers,backgroundAdapter:f.adapter,journal:async()=>{},
    debug:async(a,b)=>{calls.push([a,b]);return a.op==='watch'?{ok:true,state:'connected',sessionId:'public-timer-watch'}:{ok:true,state:'stopped'};},
    observeBackground:async()=>{},traceRead:()=>[{kind:'node',functionKey:actionKey,threadId:7,eventId:'3',nativeRequestIdSha256:FP,values:[{path:'Counter',value:'42'}]},{kind:'thread-end',threadId:7,eventId:'4',nativeRequestIdSha256:FP}]};
  let registration;
  registerRunTools({registerTool:(name,config,execute)=>{registration={name,config,execute};}},input=>debugRun(input,{services}),x=>x);
  const raw={op:'run',lane:'odc',tenant:binding.tenant,module:binding.module,action:'Nightly',contextMode:'native-background',words:'Run this DEV Timer once',trace:'full',depth:4};
  const result=await registration.execute(registration.config.inputSchema.parse(raw));
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.calls.filter(c=>c.options?.method==='POST').length,1);
  assert.equal(calls[0][0].trace.depth,4);assert.equal(calls[0][0].trace.fullValues,true);assert.deepEqual(calls[0][0].trace.scopes,{[actionKey]:['Counter']});
  assert.equal(calls.at(-1)[0].op,'stop');assert.equal(result.executionCompleted,false);
  const authorization=JSON.parse(fs.readFileSync(path.join(f.root,'.local/debugger/native-background/odc',result.operationId,'authorization.json')));
  // CX15 r5 (N-3, converted): the file keeps wordsSha256 of the words, never the words (before: words === raw.words).
  assert.equal(authorization.words,undefined);assert.equal(authorization.wordsSha256,createHash('sha256').update(raw.words).digest('hex'));
});

test('public Timer authorization and depth fail before readers or authentication',async()=>{
  const base={op:'run',execution:'native-entry',tenant:binding.tenant,module:binding.module,action:'Nightly',contextMode:'native-background'};
  let touched=0;const services={buildNativeReaders:async()=>{touched++;throw Error('unexpected reader');},journal:async()=>{}};
  for(const request of [base,{...base,words:'   '},{...base,words:'Run timer',depth:5},{...base,words:'Run timer',depth:-1}]){
    const result=await debugRun(request,{services});assert.equal(result.ok,false);assert.match(result.error,/words|depth/);
  }
  assert.equal(touched,0);assert.equal(nativeEntrySchema.parse({...base,op:'prepare'}).depth,2);
});

// Interactive Portal wake: no app caller. The scope binds and the fixed debugger deadline is validated before
// the single reserved Portal POST; timer-background keeps its one-send marker and lock.
function portalWake(t,{expiresAt=new Date(Date.now()+45000).toISOString(),started={},request}={}){
  const f=fixture(t,request?{request}:{}),run=runFixture(),order=[],expiry=expiresAt;
  const services={root:f.root,backgroundAdapter:{prepare:async p=>{order.push('portal-prepare');return f.adapter.prepare(p);},
      run:async(p,o)=>{order.push('post');return f.adapter.run(p,o);}},
    prepareServerInspection:async binding=>{order.push('metadata');assert.equal(binding.lane,'odc');assert.equal(binding.functionKey,actionKey);
      assert.equal(binding.moduleKey,moduleKey);assert.equal(binding.source,run.readers.sourceContract);},
    beforeServerInvocation:async()=>order.push('before-invocation'),
    debug:async a=>{order.push(a.op);return a.op==='watch'?{ok:true,state:'connected',sessionId:'portal-watch',inspectionMode:'interactive',autoContinue:false,expiresAt:expiry,...started}:{ok:true,state:'stopped'};},
    observeBackground:async(session,key,seconds)=>{order.push('observe');assert.equal(key,actionKey);assert.ok(seconds>35&&seconds<=45);},
    traceRead:()=>[{kind:'node',functionKey:actionKey,threadId:4,eventId:'3',nativeRequestIdSha256:FP},{kind:'thread-end',threadId:4,eventId:'8',nativeRequestIdSha256:FP}]};
  const input={contextMode:'native-background',trigger:PORTAL_WAKE_TRIGGER,words:'Wake this DEV Timer once',trace:'full',depth:4};
  return {f,run,order,services,input};
}
const posts=f=>f.calls.filter(c=>c.options?.method==='POST').length;
test('interactive Portal wake binds the scope before the POST and keeps the fixed deadline',async t=>{
  const w=portalWake(t),report=await runOdcNativeBackground(w.input,w.run.prepared,w.run.readers,w.services);
  assert.equal(report.ok,true,JSON.stringify(report.error));assert.deepEqual(w.order,['metadata','portal-prepare','watch','before-invocation','post','observe','stop']);
  assert.equal(posts(w.f),1);assert.equal(report.serverTrace.inspectionMode,'interactive');assert.equal(report.trigger,'portal-wake');
  assert.ok(Date.parse(report.serverTrace.requestDeadline)>Date.now());assert.equal(report.backgroundTrace.requestBound,true);
  assert.equal(report.executionCompleted,false);assert.equal(report.appUserIdentityProved,false);assert.equal(report.wakeOwnershipProved,false);
  assert.equal(report.wakeOwnership.nativeLimit,'portal_wake_has_no_app_trace_span_link');assert.equal(report.lockRetained,false);
  assert.equal(report.instanceCorrelation.state,'unavailable');assert.equal(report.instanceCorrelation.reason,'portal_observer_unwired');
});
test('interactive Portal wake with an invalid deadline refuses before reservation',async t=>{
  for(const started of [{inspectionMode:undefined},{autoContinue:true},{expiresAt:new Date(Date.now()-1000).toISOString()},{expiresAt:new Date(Date.now()+700000).toISOString()},{expiresAt:'never'}]){
    const w=portalWake(t,{started}),report=await runOdcNativeBackground(w.input,w.run.prepared,w.run.readers,w.services);
    assert.equal(report.ok,false);assert.equal(report.error,'debug_odc_timer_interactive_deadline_invalid');assert.equal(posts(w.f),0);
    assert.equal(w.order.includes('post'),false);assert.equal(w.order.at(-1),'stop');assert.equal(report.lockRetained,false);assert.equal(report.uncertain,false);
    assert.equal(fs.existsSync(path.join(w.f.root,'.local/debugger/native-background/odc')),false);
  }
  // Interactive needs trace full; a launch, inputs or Workflow are not a Portal wake.
  for(const change of [{trace:'nodes'},{launch:{contextMode:'app-user',inputs:{}}},{workflow:{module:'Flow'}},{inputs:{}}]){
    const w=portalWake(t),report=await runOdcNativeBackground({...w.input,...change},w.run.prepared,w.run.readers,w.services);
    assert.equal(report.ok,false);assert.match(report.error,/interactive_timer_required|portal_wake_has_no_launch/);assert.deepEqual(w.order,[]);assert.equal(posts(w.f),0);
  }
});
test('interactive Portal wake cancelled before the POST sends nothing; an expired deadline refuses before the marker',async t=>{
  const w=portalWake(t);w.services.beforeServerInvocation=async()=>{throw new Error('debug_server_session_cancelled');};
  const report=await runOdcNativeBackground(w.input,w.run.prepared,w.run.readers,w.services);
  assert.equal(report.error,'debug_server_session_cancelled');assert.equal(posts(w.f),0);assert.equal(report.serverTrace.stopped,true);assert.equal(report.lockRetained,false);
  const x=portalWake(t,{expiresAt:new Date(Date.now()+1500).toISOString()});x.services.beforeServerInvocation=()=>new Promise(r=>setTimeout(r,1600));
  const expired=await runOdcNativeBackground(x.input,x.run.prepared,x.run.readers,x.services);
  assert.equal(expired.error,'debug_odc_timer_interactive_deadline_expired');assert.equal(posts(x.f),0);assert.equal(expired.lockRetained,false);
});
test('an uncertain Portal POST keeps both locks and never re-sends, even through a new run',async t=>{
  const w=portalWake(t,{request:async()=>{throw Error('connection lost');}});
  const report=await runOdcNativeBackground(w.input,w.run.prepared,w.run.readers,w.services);
  assert.equal(report.uncertain,true);assert.equal(report.lockRetained,true);assert.equal(report.ok,false);assert.equal(report.background.result.lockRetained,true);
  assert.equal(w.order.filter(x=>x==='post').length,1);assert.equal(w.order.includes('observe'),false);assert.equal(w.order.at(-1),'stop');
  const again=await runOdcNativeBackground(w.input,w.run.prepared,w.run.readers,w.services);
  assert.equal(again.error,'debug_odc_timer_binding_blocked');assert.equal(w.order.filter(x=>x==='post').length,1);
});
test('Portal wake correlates the instance read-only after the stop, then releases the Portal session',async t=>{
  const w=portalWake(t),seen={};
  w.services.timerInstance={baseline:async()=>assert.fail('Portal wake reuses the prepared before-state'),
    observe:async args=>{w.order.push('correlate');Object.assign(seen,args);return {state:'correlated',instanceCorrelationProved:true,matchedFingerprint:FP,executionCompleted:true,outcome:'completed',wakeOwnershipProved:false,processingStatus:'Finished'};},
    release:async()=>{w.order.push('portal-release');return {released:true};}};
  const report=await runOdcNativeBackground(w.input,w.run.prepared,w.run.readers,w.services);
  assert.deepEqual(w.order.slice(-3),['stop','correlate','portal-release']);assert.equal(report.ok,true);
  assert.equal(report.instanceCorrelationProved,true);assert.equal(report.executionCompleted,true);assert.equal(report.outcome,'completed');
  assert.equal(report.wakeOwnershipProved,false);assert.equal(report.portalCredentialsReleased,true);assert.deepEqual(seen.threadOutcome.fingerprints,[FP]);
  assert.deepEqual(seen.baseline.state,report.background.nativePreparation.before);
});
test('portal-wake start admission: words required, no launch, inputs or Workflow',()=>{
  const run={op:'run',lane:'odc',execution:'native-entry',tenant:binding.tenant,module:binding.module,action:'Nightly',contextMode:'native-background',trigger:'portal-wake',words:'Wake it',trace:'full'};
  assert.equal(portalWakeStartAdmission(run).ok,true);assert.equal(portalWakeStartAdmission({...run,trace:undefined}).ok,true);
  for(const change of [{words:undefined},{words:'  '},{launch:{contextMode:'app-user',inputs:{}}},{inputs:{}},{workflow:{module:'F'}},{scenarios:[]},{context:{}},
    {lane:'o11'},{contextMode:'app-user'},{trace:'nodes'},{op:'prepare'},{trigger:'other'}]){
    const verdict=portalWakeStartAdmission({...run,...change});assert.equal(verdict.ok,false,JSON.stringify(change));assert.equal(typeof verdict.message,'string');
  }
});
