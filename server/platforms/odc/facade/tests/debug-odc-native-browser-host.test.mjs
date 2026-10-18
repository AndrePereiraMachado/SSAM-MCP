import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {createOdcNativeBrowserHost} from '../debug-odc-native-browser-host.mjs';
import {odcMountPolicy} from '../debug-odc-browser-mount.mjs';
function fixture({initializeFails=false}={}){
 const calls=[],url='https://fixture.example/App/';let confirmed=false;
 const host={receipt:()=>({scope:'owned-browser-process'}),dispose:async()=>{calls.push('owned-close');return {completed:true};},
  page:{send:async(method)=>{calls.push(method);return {result:{value:{initialized:!initializeFails}}};},
   evaluate:async(fn,arg)=>arg?{authenticationCleared:true}:url}};
 const metadata={request(){throw Error('unexpected request');},receipt:()=>({}),close(){calls.push('metadata-close');}};
 const services={planAssets:()=>({url,index:{bootstrap:{file:'boot.js',imports:[]},chunks:{}}}),metadata:()=>metadata,
  installAssets:async()=>({receipt:()=>({}),dispose:async()=>{calls.push('assets-close');return {completed:true};}}),
  authentication:()=>({receipt:()=>({confirmed}),authenticate:async()=>{calls.push('auth');confirmed=true;return {authenticated:true};}}),
  installInspection:async()=>{calls.push('install-inspector');let started=false;return {capability:{privateCapture:true},start:async()=>{started=true;calls.push('start-inspector');},receipt:()=>({started,closed:false}),remove:async()=>{calls.push('remove-inspector');return {removed:true};}};},
  mount:()=>({mount:async()=>{calls.push('mount');return {startupCallbackReturned:true,lifecycleComplete:false};},receipt:()=>({})}),
  observeStartup:async()=>({nativeApplicationStateBound:true,applicationReady:false,lifecycleComplete:false,mountedVerified:false}),
  planMount:(index,screenKey)=>{calls.push('plan:'+screenKey);return {requiredModelRoots:['screen'],route:{screenName:'Home',default:true}};}};
 const mountAuthorization={policy:odcMountPolicy,authorizationSha256:'b'.repeat(64),runtimeUrl:url,screenKey:'W4JQW+OX20iILeFJFpMkqA'};
 return {calls,host,services,args:{host,mountAuthorization,runtime:{runtimeUrl:url,pins:{'index.html':{sha256:'c'.repeat(64)}}},binding:{runtimeUrl:url,module:'App',moduleKey:'j8fMmV32B0iyTfbxwOOejQ',revision:2}}};
}
test('browser adapter prepares before authentication and requires auth before private inspector capability',async()=>{
 const f=fixture(),adapter=await createOdcNativeBrowserHost(f.args,f.services);
 assert.equal(adapter.receipt().initialized,true);assert.equal(adapter.receipt().authenticated,false);
 await assert.rejects(adapter.configureInspection({}),/inspection_not_ready/);
 await assert.rejects(adapter.loadGlobalExceptionController(),/exception_load_not_ready/);
 await assert.rejects(adapter.loadView('screen'),/view_load_not_ready/);
 await adapter.authenticate({},{});assert.equal((await adapter.configureInspection({})).privateCapture,true);
 await assert.rejects(adapter.loadGlobalExceptionController(),/exception_load_not_ready/);
 await assert.rejects(adapter.loadView('screen'),/view_load_not_ready/);
 const mounted=await adapter.mount();assert.equal(mounted.lifecycleComplete,false);assert.equal(mounted.startup.applicationReady,false);
 assert.equal(adapter.receipt().startup.applicationReady,false);
 assert.ok(f.calls.indexOf('start-inspector')<f.calls.indexOf('mount'));
 await assert.rejects(adapter.mount(),/mount_not_ready/);
 assert.equal((await adapter.dispose()).completed,true);const count=f.calls.length;await adapter.dispose();assert.equal(f.calls.length,count);
 await assert.rejects(adapter.authenticate({},{}),/disposed/);
});

test('mount authorization is fixed before assets load and never accepts static qualification flags',async()=>{
 const f=fixture();
 for(const mountAuthorization of [{modelQualified:true,runtimeEffectsQualified:true,applicationStartupQualified:true},
  {...f.args.mountAuthorization,runtimeUrl:'https://other.example/App/'},{...f.args.mountAuthorization,requiredModelRoots:['x']}])
  await assert.rejects(createOdcNativeBrowserHost({...f.args,mountAuthorization},f.services),/mount_authorization_invalid/);
 assert.deepEqual(f.calls,[]);
 const unauthorized=await createOdcNativeBrowserHost({...f.args,mountAuthorization:undefined},f.services);
 await unauthorized.authenticate({},{});await unauthorized.configureInspection({});
 await assert.rejects(unauthorized.mount(),/mount_not_authorized/);
 assert.equal(f.calls.includes('mount'),false);assert.equal(f.calls.includes('start-inspector'),false);
 await unauthorized.dispose();
});

test('host composes the authorization from pinned assets and the default route after authentication',async()=>{
 const f=fixture();let seen;const original=f.services.mount;
 f.services.mount=options=>{seen=options.authorization;return original(options);};
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await adapter.authenticate({},{});await adapter.configureInspection({});await adapter.mount();
 assert.equal(seen.policy,f.args.mountAuthorization.policy);assert.equal(seen.staticEffectsQualified,false);
 assert.equal(seen.authorizationSha256,'b'.repeat(64));assert.equal(seen.screenKey,f.args.mountAuthorization.screenKey);
 assert.deepEqual(seen.requiredModelRoots,['screen']);assert.match(seen.sourceSha256,/^[a-f0-9]{64}$/);
 assert.ok(f.calls.indexOf('plan:'+f.args.mountAuthorization.screenKey)<f.calls.indexOf('start-inspector'));
 await adapter.dispose();
 // A different pinned asset set yields a different source hash.
 const g=fixture();let other;const base=g.services.mount;g.services.mount=options=>{other=options.authorization;return base(options);};
 g.args.runtime.pins['index.html'].sha256='d'.repeat(64);
 const second=await createOdcNativeBrowserHost(g.args,g.services);await second.authenticate({},{});await second.configureInspection({});await second.mount();
 assert.notEqual(other.sourceSha256,seen.sourceSha256);await second.dispose();
});

test('unresolved route, missing pins or unconfirmed authentication cannot start inspector or mount',async()=>{
 for(const patch of [f=>{f.services.planMount=()=>{throw Error('debug_odc_native_mount_route_not_default');};},
  f=>{f.args.runtime.pins={};}]){
  const f=fixture();patch(f);
  const adapter=await createOdcNativeBrowserHost(f.args,f.services);
  await adapter.authenticate({},{});await adapter.configureInspection({});await assert.rejects(adapter.mount(),/mount_plan_unresolved|mount_assets_unpinned/);
  assert.equal(f.calls.includes('start-inspector'),false);assert.equal(f.calls.includes('mount'),false);await adapter.dispose();
 }
});

test('competing mounts are serialized to one native submission',async()=>{
 const f=fixture();let resolve;const wait=new Promise(r=>resolve=r);const original=f.services.mount;
 f.services.mount=options=>{const m=original(options);return {...m,mount:async()=>{await wait;return m.mount();}};};
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await adapter.authenticate({},{});await adapter.configureInspection({});
 const mounting=adapter.mount();await new Promise(r=>setImmediate(r));
 await assert.rejects(adapter.mount(),/mount_not_ready/);resolve();await mounting;
 assert.equal(f.calls.filter(c=>c==='mount').length,1);await adapter.dispose();
});

test('readiness observation failure preserves native callback result and does not enable a second mount',async()=>{
 const f=fixture();f.services.observeStartup=async()=>{throw Error('private observation error');};
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);await adapter.authenticate({},{});await adapter.configureInspection({});
 const r=await adapter.mount();assert.equal(r.startupCallbackReturned,true);assert.equal(r.startupObservationFailed,true);
 assert.equal(adapter.receipt().startup,undefined);await assert.rejects(adapter.mount(),/mount_not_ready/);
 assert.equal(f.calls.filter(c=>c==='mount').length,1);await adapter.dispose();
});
test('render observation needs a returned mount and uses targets from the host\'s own mount plan',async()=>{
 const f=fixture();let returned=false,seen;
 const M='j8fMmV32B0iyTfbxwOOejQ',S='W4JQW+OX20iILeFJFpMkqA';
 f.services.mount=()=>({mount:async()=>{returned=true;return {startupCallbackReturned:true};},receipt:()=>({callbackReturned:returned})});
 f.services.planMount=()=>({requiredModelRoots:['screen'],route:{screenName:'Home',default:true},views:[{key:S,componentLocal:'Screen',blockKeys:[],
  handlers:[{handler:'onReadyEventHandler',actionKey:'ALQheqsdZEGBVNun+Anl5w'}],dataActionKeys:[],
  renderExpressions:{renderExpressionsQualified:true,elements:[{kind:'native-widget',binding:'Ge',id:'ResultValue'}],
   textBindings:[{id:'ResultValue',attribute:'resultVar',variable:'Result',form:'toString'}],excludedTexts:[]}}]});
 f.services.observeRender=async options=>{seen=options;return {observed:true,documentMatched:true,evaluated:false,roots:[],texts:[]};};
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await assert.rejects(adapter.observeRender(),/render_not_mounted/);
 await adapter.authenticate({},{});await adapter.configureInspection({});
 await assert.rejects(adapter.observeRender(),/render_not_mounted/);assert.equal(seen,undefined);
 await adapter.mount();
 const r=await adapter.observeRender();
 assert.equal(seen.page,f.host.page);assert.equal(seen.documentUrl,f.args.runtime.runtimeUrl);
 assert.deepEqual(r.targets.instances.map(i=>[i.key,i.ids,i.functions]),[[S,['ResultValue'],[M+':ALQheqsdZEGBVNun+Anl5w']]]);
 assert.equal(r.targets.complete,true);assert.equal(r.observation.evaluated,false);
 await adapter.dispose();await assert.rejects(adapter.observeRender(),/render_not_mounted/);
});
test('native initialization failure closes browser, metadata and interception without auth',async()=>{
 const f=fixture({initializeFails:true});await assert.rejects(createOdcNativeBrowserHost(f.args,f.services),/prepare_runtime_failed/);
 assert.ok(f.calls.includes('owned-close'));assert.ok(f.calls.includes('metadata-close'));assert.ok(f.calls.includes('assets-close'));assert.ok(!f.calls.includes('auth'));
});
test('unowned browser or mismatched app is refused before assets or initialization',async()=>{
 const f=fixture();f.host.receipt=()=>({scope:'user-browser'});
 await assert.rejects(createOdcNativeBrowserHost(f.args,f.services),/contract_invalid/);assert.deepEqual(f.calls,[]);
});

test('authenticated inspection starts before mounting and mount does not restart the native session',async()=>{
 const f=fixture(),adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await assert.rejects(adapter.startInspection(),/inspection_not_ready/);
 await adapter.authenticate({},{});await adapter.configureInspection({});
 await adapter.startInspection();assert.equal(adapter.receipt().inspection.started,true);
 assert.equal(f.calls.includes('mount'),false);
 await adapter.mount();assert.equal(f.calls.filter(c=>c==='start-inspector').length,1);
 await adapter.dispose();await assert.rejects(adapter.startInspection(),/inspection_not_ready/);
});

test('an attempted but failed debugger start never qualifies native mounting',async()=>{
 const f=fixture();let attempted=false;
 f.services.installInspection=async()=>({capability:{},receipt:()=>({started:attempted,closed:false}),
  start:async()=>{if(attempted)throw Error('already-attempted');attempted=true;throw Error('start-unconfirmed');},remove:async()=>({removed:true})});
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await adapter.authenticate({},{});await adapter.configureInspection({});
 await assert.rejects(adapter.startInspection(),/start-unconfirmed/);
 await assert.rejects(adapter.mount(),/already-attempted/);
 assert.equal(f.calls.includes('mount'),false);await adapter.dispose();
});

test('mount CDP timeout follows the original inspection deadline across long pauses',async t=>{
 const now=1790000000000;t.mock.timers.enable({apis:['Date'],now});
 const f=fixture();let mountOptions;
 const original=f.services.mount;f.services.mount=options=>{mountOptions=options;return original(options);};
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);await adapter.authenticate({},{});
 await adapter.configureInspection({leaseMs:300000,inspectionExpiresAt:new Date(now+240000).toISOString()});
 t.mock.timers.tick(80000);
 await adapter.mount();assert.equal(mountOptions.timeoutMs,165000);
 await adapter.dispose();
});

test('expired inspection cannot submit a mount or renew its deadline',async t=>{
 const now=1790000000000;t.mock.timers.enable({apis:['Date'],now});
 const f=fixture(),adapter=await createOdcNativeBrowserHost(f.args,f.services);await adapter.authenticate({},{});
 await assert.rejects(adapter.configureInspection({leaseMs:1000,inspectionExpiresAt:new Date(now+2000).toISOString()}),/deadline_invalid/);
 await adapter.configureInspection({leaseMs:1000});t.mock.timers.tick(1001);
 await assert.rejects(adapter.mount(),/inspection_expired/);assert.equal(f.calls.includes('mount'),false);
 assert.equal(f.calls.includes('start-inspector'),false);await adapter.dispose();
});

test('native application-ready wait requires confirmed mount and retains the original deadline',async t=>{
 const now=1790000000000;t.mock.timers.enable({apis:['Date'],now});
 const f=fixture();let returned=false,options;
 f.services.mount=()=>({mount:async()=>{returned=true;return {startupCallbackReturned:true};},receipt:()=>({callbackReturned:returned})});
 f.services.waitForReady=async value=>{options=value;return {nativeApplicationReady:true,lifecycleComplete:false};};
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await assert.rejects(adapter.waitForApplicationReady(),/not_started/);
 await adapter.authenticate({},{});await adapter.configureInspection({leaseMs:10000});
 await assert.rejects(adapter.waitForApplicationReady(),/not_started/);
 await adapter.mount();t.mock.timers.tick(2000);
 assert.equal((await adapter.waitForApplicationReady()).lifecycleComplete,false);
 assert.equal(Date.parse(options.expiresAt),now+10000);
 t.mock.timers.tick(8001);await assert.rejects(adapter.waitForApplicationReady(),/inspection_expired/);
 await adapter.dispose();await assert.rejects(adapter.waitForApplicationReady(),/not_started/);
});

import {createHash} from 'node:crypto';
import {sdkContext,sdkBinding} from './fixtures/debug-odc-navigation-sdk.mjs';
const qsha=q=>createHash('sha256').update(q).digest('hex'),TARGET='RDyePs1DwUyB5poRbGhwVA';
function navigable(f,{route}={}){
 let returned=false;const seen={};
 f.args.mountAuthorization={...f.args.mountAuthorization,navigation:{screenKey:TARGET,segment:'InputProbe',back:true,inputsSha256:[qsha('Seed=1')]},...(route?{route}:{})};
 f.services.mount=options=>{seen.mount=options;return {mount:async()=>{returned=true;return {startupCallbackReturned:true};},receipt:()=>({callbackReturned:returned})};};
 f.services.waitForReady=async options=>{seen.ready=options;return {nativeApplicationReady:true,nativePromiseCompleted:true,lifecycleComplete:false};};
 f.services.planMount=(index,screenKey,options)=>{f.calls.push('plan:'+screenKey);seen.plan=options;
  return {requiredModelRoots:['screen'],route:options?.route?{screenName:'Probe',default:false,segment:options.route.segment}:{screenName:'Home',default:true},
   ...(options?.navigation?{navigation:{screenKey:TARGET,segment:'InputProbe',back:true,inputs:[],availableInputs:[{input:'Seed',attribute:'seedIn'}]}}:{})};};
 f.services.bindNavigation=()=>({navigationBound:true,file:'_oschunk-SDK.js',export:'s',members:{generateScreenURL:{source:'function ire(){}'}}});
 f.services.navigation=options=>{seen.navigation=options;return {
  navigate:async request=>{f.calls.push('navigate:'+JSON.stringify(request));return {direction:'forward',invoked:true,reached:true,internalGoTo:true};},
  back:async()=>{f.calls.push('back');return {direction:'back',invoked:true,reached:true,internalGoBack:true};},receipt:()=>({uncertain:false})};};
 f.services.planAssets=(runtime,options)=>{seen.assets=options;return {url:runtime.runtimeUrl,index:{bootstrap:{file:'boot.js',imports:[]},chunks:{}}};};
 return seen;
}
test('in-app navigation is refused before the application is ready and after dispose',async()=>{
 const f=fixture(),seen=navigable(f),adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await assert.rejects(adapter.navigate(TARGET,{Seed:'1'}),/navigation_not_ready/);
 await adapter.authenticate({},{});await adapter.configureInspection({});
 await assert.rejects(adapter.navigate(TARGET,{Seed:'1'}),/navigation_not_ready/);
 await adapter.mount();
 await assert.rejects(adapter.navigate(TARGET,{Seed:'1'}),/navigation_not_ready/);
 await adapter.waitForApplicationReady();
 // Authorized target and inputs only, canonicalized by the host's own plan.
 await assert.rejects(adapter.navigate(TARGET,{Seed:'2'}),/navigation_not_authorized/);
 await assert.rejects(adapter.navigate('W4JQW+OX20iILeFJFpMkqA',{Seed:'1'}),/navigation_not_authorized/);
 await assert.rejects(adapter.navigate(TARGET,{Seed:'1',Other:'x'}),/navigation_not_authorized/);
 const r=await adapter.navigate(TARGET,{Seed:'1'});assert.equal(r.internalGoTo,true);
 assert.deepEqual(f.calls.filter(c=>c.startsWith('navigate:')),['navigate:{"segment":"InputProbe","inputs":[["Seed","1"]]}']);
 assert.equal(seen.navigation.module,'App');assert.equal(seen.navigation.runtimeUrl,f.args.runtime.runtimeUrl);
 assert.equal((await adapter.navigateBack()).internalGoBack,true);
 assert.equal((await adapter.dispose()).completed,true);
 await assert.rejects(adapter.navigate(TARGET,{Seed:'1'}),/navigation_not_ready/);
 await assert.rejects(adapter.navigateBack(),/navigation_not_ready/);
});
test('a host without an authorized navigation never navigates',async()=>{
 const f=fixture();navigable(f);delete f.args.mountAuthorization.navigation;
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await adapter.authenticate({},{});await adapter.configureInspection({});await adapter.mount();await adapter.waitForApplicationReady();
 await assert.rejects(adapter.navigate(TARGET,{Seed:'1'}),/navigation_not_authorized/);
 assert.equal(f.calls.some(c=>c.startsWith('navigate:')),false);await adapter.dispose();
});
test('real in-app navigation: the host-expected URL is runtimeUrl+segment+query and the SDK-built URL reaches goTo',async()=>{
 const f=fixture(),journal=[];navigable(f);delete f.services.navigation;f.services.bindNavigation=sdkBinding;
 f.args.beforeNavigate=async m=>{journal.push(['before',m]);return {recorded:true};};
 f.args.recordNavigationOutcome=async m=>{journal.push(['outcome',m]);return {recorded:true};};
 const realm=sdkContext(f.args.runtime.runtimeUrl),send=f.host.page.send;let installed=false;
 f.host.page.send=async(method,params,timeout)=>{
  const m=/"handle":"(__ssamOdcRuntime_[a-f0-9]{48})"/.exec(params?.expression??'');
  if(method!=='Runtime.evaluate'||!m||!/navigateInPage|locationInPage/.test(params.expression))return send(method,params,timeout);
  if(!installed){realm.install(m[1]);installed=true;}
  return {result:{value:realm.evaluate(params.expression)}};
 };
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await adapter.authenticate({},{});await adapter.configureInspection({});await adapter.mount();await adapter.waitForApplicationReady();
 const r=await adapter.navigate(TARGET,{Seed:'1'});
 assert.deepEqual(realm.calls,['goTo:/App/InputProbe?Seed=1']);assert.equal(realm.ctx.fullReload,undefined);
 assert.equal(r.reached,true);assert.equal(r.internalGoTo,true);assert.equal(r.sameCallbacksAfter,true);assert.equal(r.path,'/App/InputProbe');
 assert.equal(r.querySha256,qsha('Seed=1'));assert.equal(realm.ctx.location.href,f.args.runtime.runtimeUrl+'InputProbe?Seed=1');
 assert.deepEqual(journal[0],['before',{direction:'forward',segment:'InputProbe',querySha256:qsha('Seed=1'),from:'/App/',to:'/App/InputProbe',module:'App'}]);
 const back=await adapter.navigateBack();assert.equal(back.reached,true);assert.equal(back.internalGoBack,true);
 assert.equal(realm.ctx.location.href,f.args.runtime.runtimeUrl);assert.deepEqual(realm.calls,['goTo:/App/InputProbe?Seed=1','goBack']);
 assert.doesNotMatch(JSON.stringify(journal),/Seed=1|"1"/);
 await adapter.dispose();
});
test('deep link: the authorized route reaches the asset plan and the mount as an SDK-built initial location',async()=>{
 const f=fixture(),route={segment:'InputProbe',query:'Seed=9',querySha256:qsha('Seed=9')},seen=navigable(f,{route});
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);
 assert.deepEqual(seen.assets,{includeDocumentStyles:true,route:{segment:'InputProbe',query:'Seed=9'}});
 await adapter.authenticate({},{});await adapter.configureInspection({});await adapter.mount();
 assert.deepEqual(seen.plan.route,{segment:'InputProbe'});
 assert.deepEqual(seen.mount.authorization.route,{segment:'InputProbe',querySha256:qsha('Seed=9')});
 assert.deepEqual({...seen.mount.initialLocation,source:undefined},{segment:'InputProbe',query:'Seed=9',coreFile:'_oschunk-SDK.js',navigationExport:'s',module:'App',source:undefined});
 await adapter.waitForApplicationReady();assert.equal(seen.ready.runtimeUrl,f.args.runtime.runtimeUrl+'InputProbe?Seed=9');assert.equal(seen.ready.appUrl,f.args.runtime.runtimeUrl);
 await adapter.dispose();
 // A route the host plan does not qualify refuses before the inspector starts.
 const g=fixture();navigable(g,{route});g.services.planMount=()=>({requiredModelRoots:['screen'],route:{screenName:'Home',default:true}});
 const other=await createOdcNativeBrowserHost(g.args,g.services);await other.authenticate({},{});await other.configureInspection({});
 await assert.rejects(other.mount(),/mount_plan_unresolved/);assert.equal(g.calls.includes('start-inspector'),false);await other.dispose();
});
const SAVE='SvAheqsdZEGBVNun+Anl5w',SCREEN='W4JQW+OX20iILeFJFpMkqA';
function interactive(f){
 let returned=false;const seen={clicks:[],resolved:[]};
 f.args.interactionAuthorization=[{target:'@Wd9JnWDBJUGdVNVnSt55DQ',event:'click',name:'SaveButton',viewKey:SCREEN,actionKey:SAVE}];
 f.args.beforeInteraction=async()=>({recorded:true});f.args.recordInteractionOutcome=async()=>({recorded:true});
 f.services.mount=options=>{seen.mount=options;return {mount:async()=>{f.calls.push('mount');returned=true;return {startupCallbackReturned:true};},receipt:()=>({callbackReturned:returned})};};
 f.services.waitForReady=async()=>({nativeApplicationReady:true,nativePromiseCompleted:true,lifecycleComplete:false});
 f.services.resolveInteraction=(index,views,moduleKey,target)=>{seen.resolved.push([moduleKey,target]);return {name:target.name,viewKey:SCREEN,domId:'SaveButton',method:'save$Action',actionKey:SAVE};};
 f.services.interaction=options=>{seen.interaction=options;return {click:async request=>{seen.clicks.push(request);return {sequence:request.sequence,dispatched:true,trusted:true};},receipt:()=>({})};};
 return seen;
}
test('interact is refused before the application is ready and after dispose; one click per authorized index',async()=>{
 const f=fixture(),seen=interactive(f),adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await assert.rejects(adapter.interact(0),/interaction_not_ready/);
 await adapter.authenticate({},{});await adapter.configureInspection({});
 await assert.rejects(adapter.interact(0),/interaction_not_ready/);
 await adapter.mount();
 // The target is resolved from the host's own pinned plan before the inspector starts; its handler joins the roots.
 assert.deepEqual(seen.resolved,[[f.args.binding.moduleKey,{name:'SaveButton',viewKey:SCREEN}]]);
 assert.ok(seen.mount.authorization.requiredModelRoots.includes(SAVE));
 assert.equal(Object.hasOwn(seen.mount.authorization,'interactions'),false);
 await assert.rejects(adapter.interact(0),/interaction_not_ready/);
 await adapter.waitForApplicationReady();
 await assert.rejects(adapter.interact(1),/interaction_not_authorized/);
 await assert.rejects(adapter.interact('0'),/interaction_not_authorized/);
 assert.deepEqual(await adapter.interact(0),{sequence:0,dispatched:true,trusted:true});
 assert.deepEqual(seen.clicks,[{sequence:0,id:'SaveButton',documentUrl:f.args.runtime.runtimeUrl,
  metadata:{target:'@Wd9JnWDBJUGdVNVnSt55DQ',name:'SaveButton',viewKey:SCREEN,actionKey:SAVE}}]);
 assert.equal(seen.interaction.page,f.host.page);assert.equal(seen.interaction.beforeInteraction,f.args.beforeInteraction);
 await assert.rejects(adapter.interact(0),/interaction_not_authorized/);assert.equal(seen.clicks.length,1);
 await adapter.dispose();await assert.rejects(adapter.interact(0),/interaction_not_ready/);
});
test('interactions need a mount authorization and both journals; an unresolved or changed target refuses the mount',async()=>{
 for(const patch of [f=>{delete f.args.mountAuthorization;},f=>{delete f.args.recordInteractionOutcome;},
  f=>{f.args.interactionAuthorization=[{...f.args.interactionAuthorization[0],event:'dblclick'}];}]){
  const f=fixture();interactive(f);patch(f);
  await assert.rejects(createOdcNativeBrowserHost(f.args,f.services),/interaction_authorization_invalid/);assert.deepEqual(f.calls,[]);
 }
 for(const resolve of [()=>{throw Error('debug_odc_native_mount_interaction_target_unresolved');},()=>({name:'SaveButton',viewKey:SCREEN,domId:'SaveButton',actionKey:'Other1qsdZEGBVNun+Anl5w'})]){
  const f=fixture();interactive(f);f.services.resolveInteraction=resolve;
  const adapter=await createOdcNativeBrowserHost(f.args,f.services);await adapter.authenticate({},{});await adapter.configureInspection({});
  await assert.rejects(adapter.mount(),/mount_plan_unresolved/);assert.equal(f.calls.includes('start-inspector'),false);assert.equal(f.calls.includes('mount'),false);
  await adapter.dispose();
 }
 const f=fixture(),seen=interactive(f);delete f.args.interactionAuthorization;delete f.args.beforeInteraction;delete f.args.recordInteractionOutcome;
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await adapter.authenticate({},{});await adapter.configureInspection({});await adapter.mount();await adapter.waitForApplicationReady();
 await assert.rejects(adapter.interact(0),/interaction_not_authorized/);assert.deepEqual(seen.clicks,[]);await adapter.dispose();
});
test('the SDK error page is observed read-only only after a returned mount',async()=>{
 const f=fixture();interactive(f);let options;
 f.services.observeErrorPage=async value=>{options=value;return {observed:true,navigated:true,marked:true,historyNavigated:true,valuesRead:false,appCodeCalled:false};};
 const adapter=await createOdcNativeBrowserHost(f.args,f.services);
 await assert.rejects(adapter.observeErrorPage(),/error_page_not_mounted/);
 await adapter.authenticate({},{});await adapter.configureInspection({});await adapter.mount();
 assert.equal((await adapter.observeErrorPage()).navigated,true);
 assert.equal(options.page,f.host.page);assert.equal(options.runtimeUrl,f.args.runtime.runtimeUrl);
 await adapter.dispose();await assert.rejects(adapter.observeErrorPage(),/error_page_not_mounted/);
});
