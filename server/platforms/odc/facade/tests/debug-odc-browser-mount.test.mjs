import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createOdcBrowserMount,isOdcBrowserMountAuthorized,isOdcMountRequest,odcMountPolicy} from '../debug-odc-browser-mount.mjs';
const url='https://fixture.example/App/';
const authorization=()=>({policy:odcMountPolicy,staticEffectsQualified:false,sourceSha256:'a'.repeat(64),authorizationSha256:'b'.repeat(64),
 runtimeUrl:url,screenKey:'W4JQW+OX20iILeFJFpMkqA',requiredModelRoots:['root']});
function harness(overrides={}){
 const calls=[];
 const context=vm.createContext({location:{href:url},runtime:{boot:{async __ssamMount(){calls.push('original-mount');}}}});
 const options={runtimeHandle:'runtime',authentication:{receipt:()=>({confirmed:true})},inspection:{receipt:()=>({started:true,closed:false})},
  authorization:authorization(),
  beforeMount:async metadata=>{calls.push({journal:metadata});return {recorded:true};},
  recordOutcome:async result=>{calls.push({outcome:result});return {recorded:true};},
  page:{evaluate:async(fn,arg)=>vm.runInContext('('+fn.toString()+')',context)(arg)},...overrides};
 return {mount:createOdcBrowserMount(options),calls,context,options};
}
test('mount authorization is a DEV policy record, never a static-effects qualification flag',()=>{
 assert.equal(isOdcBrowserMountAuthorized(authorization()),true);
 for(const patch of [{policy:'qualified'},{staticEffectsQualified:true},{sourceSha256:'x'},{authorizationSha256:undefined},
  {runtimeUrl:'http://fixture.example/App/'},{screenKey:'short'},{requiredModelRoots:[]}])
  assert.equal(isOdcBrowserMountAuthorized({...authorization(),...patch}),false);
 // The former qualification shape is refused outright.
 assert.equal(isOdcBrowserMountAuthorized({modelQualified:true,runtimeEffectsQualified:true,applicationStartupQualified:true,
  sourceSha256:'a'.repeat(64),runtimeUrl:url,requiredModelRoots:['root']}),false);
 const {sourceSha256,requiredModelRoots,staticEffectsQualified,...request}=authorization();
 assert.equal(isOdcMountRequest(request),true);
 assert.equal(isOdcMountRequest({...request,requiredModelRoots}),false);
});
test('original bootstrap executes once after durable submission; callback return does not claim lifecycle completion',async()=>{
 const h=harness(),result=await h.mount.mount();
 assert.equal(h.calls[0].journal.policy,odcMountPolicy);assert.equal(h.calls[0].journal.authorizationSha256,'b'.repeat(64));
 assert.equal(h.calls[0].journal.screenKey,'W4JQW+OX20iILeFJFpMkqA');assert.equal(h.calls[1],'original-mount');
 assert.equal(result.startupCallbackReturned,true);assert.equal(result.lifecycleComplete,false);assert.equal(result.mountedVerified,false);
 assert.equal(h.mount.receipt().uncertain,false);
 await assert.rejects(h.mount.mount(),/already_attempted/);assert.equal(h.calls.filter(c=>c==='original-mount').length,1);
});
test('authentication, inspector and authorization must finish before journaling or invoking',async()=>{
 for(const patch of [{authentication:{receipt:()=>({confirmed:false})}},{inspection:{receipt:()=>({started:true,closed:true})}},
  {authorization:{...authorization(),staticEffectsQualified:true}},{authorization:{...authorization(),requiredModelRoots:[]}}]){
  const h=harness(patch);await assert.rejects(h.mount.mount(),/session_not_ready|not_authorized/);assert.deepEqual(h.calls,[]);
 }
});
test('lost response is persisted as uncertain and cannot be replayed',async()=>{
 const h=harness({page:{evaluate:async()=>{throw new Error('private transport');}}});
 await assert.rejects(h.mount.mount(),/result_uncertain/);
 assert.equal(h.mount.receipt().uncertain,true);assert.equal(h.calls[1].outcome.transportUnconfirmed,true);
 await assert.rejects(h.mount.mount(),/already_attempted/);
});
test('native failure remains incomplete; changed URL prevents native invocation',async()=>{
 const h=harness();h.context.runtime.boot.__ssamMount=async()=>{throw new Error('private native failure');};
 await assert.rejects(h.mount.mount(),/native_mount_failed/);assert.equal(h.mount.receipt().uncertain,true);
 assert.doesNotMatch(JSON.stringify(h.calls),/private native/);
 const other=harness();other.context.location.href='https://other.example/';
 await assert.rejects(other.mount.mount(),/native_mount_failed/);assert.equal(other.mount.receipt().nativeInvoked,false);
 assert.equal(other.calls.includes('original-mount'),false);
});
test('journal failures prevent replay and are not promoted to completion',async()=>{
 const before=harness({beforeMount:async()=>({recorded:false})});
 await assert.rejects(before.mount.mount(),/submission_unrecorded/);assert.equal(before.mount.receipt().submitted,false);
 await assert.rejects(before.mount.mount(),/already_attempted/);
 const after=harness({recordOutcome:async()=>({recorded:false})});
 await assert.rejects(after.mount.mount(),/outcome_unrecorded/);assert.equal(after.mount.receipt().uncertain,true);
 await assert.rejects(after.mount.mount(),/already_attempted/);
});

test('time spent persisting submission cannot extend the inspection lease',async t=>{
 const now=1790000000000;t.mock.timers.enable({apis:['Date'],now});
 let timeout;
 const h=harness({expiresAt:new Date(now+120000).toISOString(),timeoutMs:125000,
  beforeMount:async()=>{t.mock.timers.tick(80000);return {recorded:true};},
  page:{evaluate:async(fn,arg,limit)=>{timeout=limit;return {invoked:true,callbackReturned:true};}}});
 await h.mount.mount();assert.equal(timeout,45000);
 const expired=harness({expiresAt:new Date(Date.now()+1000).toISOString(),beforeMount:async()=>{t.mock.timers.tick(1001);return {recorded:true};}});
 await assert.rejects(expired.mount.mount(),/inspection_expired/);
 assert.equal(expired.calls.includes('original-mount'),false);
 assert.equal(expired.mount.receipt().submitted,false);assert.equal(expired.mount.receipt().nativeInvoked,false);
 assert.equal(expired.calls[0].outcome.inspectionExpired,true);
 await assert.rejects(expired.mount.mount(),/already_attempted/);
});

import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const deepSource='function ire(t,e,n){var k=Object.keys(n||{});return"/App/"+e+(k.length?"?"+k.map(function(x){return encodeURIComponent(x)+"="+encodeURIComponent(n[x])}).join("&"):"")}';
function deepHarness({query='Seed=4',route={segment:'Probe',querySha256:sha('Seed=4')},initial}={}){
 const h=harness({authorization:{...authorization(),...(route?{route}:{})}});
 h.context.history={state:{idx:0},replaceState(state,title,next){h.calls.push('replace:'+next);h.context.location.href=new URL(next,h.context.location.href).href;}};
 h.context.URL=URL;vm.runInContext(deepSource+';var nav=Object.freeze({generateScreenURL:ire});',h.context);
 h.context.runtime.loadedModule=f=>f==='_oschunk-SDK.js'?{s:vm.runInContext('nav',h.context)}:undefined;
 h.context.runtime.boot.__ssamMount=async()=>{h.calls.push('original-mount:'+h.context.location.href);};
 const options={...h.options,authorization:{...authorization(),...(route?{route}:{})},
  initialLocation:initial===undefined?{segment:'Probe',query,coreFile:'_oschunk-SDK.js',navigationExport:'s',module:'App',source:deepSource}:initial};
 return {...h,mount:createOdcBrowserMount(options)};
}
test('deep link: the SDK-built route URL is set with replaceState before the final bootstrap stage',async()=>{
 const h=deepHarness();await h.mount.mount();
 assert.deepEqual(h.calls.filter(c=>typeof c==='string'),['replace:/App/Probe?Seed=4','original-mount:'+url+'Probe?Seed=4']);
 assert.deepEqual(h.calls[0].journal.route,{segment:'Probe',querySha256:sha('Seed=4')});
 assert.equal(h.calls.at(-1).outcome.initialLocationSet,true);
});
test('authorization without a matching route segment or query sha is refused before journaling',async()=>{
 for(const patch of [{query:'Seed=5'},{route:{segment:'Other',querySha256:sha('Seed=4')}},{route:null},{initial:null},
  {route:{segment:'Probe',querySha256:'x'}}]){
  const h=deepHarness(patch);await assert.rejects(h.mount.mount(),/not_authorized/);
  assert.equal(h.calls.length,0,JSON.stringify(patch));
 }
 assert.equal(isOdcBrowserMountAuthorized({...authorization(),route:{segment:'Probe',querySha256:sha('')}}),true);
 for(const route of [{segment:'../x',querySha256:sha('')},{segment:'Probe'},{segment:'Probe',querySha256:sha(''),extra:1}])
  assert.equal(isOdcBrowserMountAuthorized({...authorization(),route}),false);
 const {sourceSha256,requiredModelRoots,staticEffectsQualified,...request}=authorization();
 assert.equal(isOdcMountRequest({...request,route:{segment:'Probe',query:'Seed=4',querySha256:sha('Seed=4')}}),true);
 assert.equal(isOdcMountRequest({...request,route:{segment:'Probe',query:'Seed=5',querySha256:sha('Seed=4')}}),false);
 const navigation={screenKey:'RDyePs1DwUyB5poRbGhwVA',segment:'Probe',back:true,inputsSha256:[sha('Seed=1')]};
 assert.equal(isOdcMountRequest({...request,navigation}),true);
 for(const bad of [{...navigation,back:false},{...navigation,inputsSha256:[]},{...navigation,segment:'a/b'},{...navigation,extra:1}])
  assert.equal(isOdcMountRequest({...request,navigation:bad}),false);
});
test('an SDK URL that differs from the authorized route never mounts',async()=>{
 const h=deepHarness();h.context.runtime.loadedModule=()=>({s:Object.freeze({generateScreenURL:function ire(){return '/App/Elsewhere';}})});
 await assert.rejects(h.mount.mount(),/native_mount_failed/);
 assert.equal(h.calls.some(c=>typeof c==='string'&&c.startsWith('original-mount')),false);
 assert.equal(h.calls.at(-1).outcome.invoked,false);assert.equal(h.calls.at(-1).outcome.initialLocationSet,false);
});
