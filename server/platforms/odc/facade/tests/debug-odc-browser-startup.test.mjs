import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {observeOdcBrowserStartup} from '../debug-odc-browser-startup.mjs';
// A paused page answers a plain Runtime.evaluate, but an awaited one settles only
// through a microtask, which V8 cannot run until the native breakpoint resumes.
function fixture({paused=false}={}){
 const runtimeHandle='__ssamOdcRuntime_'+'a'.repeat(48),runtimeUrl='https://fixture.example/App/',sent=[];
 let calls=0;const application={isApplicationReady:false};
 const context=vm.createContext({location:{href:runtimeUrl},[runtimeHandle]:{shape(...keys){calls++;assert.deepEqual(keys,['initializeDatabase','triggerApplicationReadyEvent','onApplicationReady','isApplicationReady']);return application;}}});
 const page={evaluate:async()=>{throw Error('awaited evaluation is not used');},
  send:async(method,params,timeout)=>{sent.push({method,params,timeout});
   if(params.awaitPromise&&paused)return new Promise(()=>{});
   // returnByValue: the reply is JSON, never a live page object.
   try{return {result:{value:JSON.parse(JSON.stringify(vm.runInContext(params.expression,context)))}};}catch{return {exceptionDetails:{}};}}};
 return {application,context,sent,calls:()=>calls,args:{runtimeHandle,runtimeUrl,page}};
}
test('native state can be re-read after the SDK changes it without invoking lifecycle',async()=>{
 const f=fixture();assert.equal((await observeOdcBrowserStartup(f.args)).applicationReady,false);
 f.application.isApplicationReady=true;const r=await observeOdcBrowserStartup(f.args);
 assert.equal(r.applicationReady,true);assert.equal(r.lifecycleComplete,false);assert.equal(r.mountedVerified,false);assert.equal(f.calls(),2);
});
test('startup observation succeeds after the mount callback while the native debugger holds the page',async()=>{
 const f=fixture({paused:true});f.application.isApplicationReady=true;
 const r=await observeOdcBrowserStartup(f.args);
 assert.equal(r.nativeApplicationStateBound,true);assert.equal(r.applicationReady,true);assert.equal(r.lifecycleComplete,false);
 assert.deepEqual(f.sent.map(s=>s.method),['Runtime.evaluate']);
 assert.equal(f.sent[0].params.awaitPromise,undefined);assert.equal(f.sent[0].params.returnByValue,true);assert.equal(f.sent[0].params.silent,true);
 assert.equal(f.sent[0].timeout,5000);
});
test('changed document, unavailable SDK state and nonboolean flags cannot claim readiness',async()=>{
 const f=fixture();f.context.location.href='https://other.example/';await assert.rejects(observeOdcBrowserStartup(f.args),/state_unbound/);assert.equal(f.calls(),0);
 const g=fixture();g.application.isApplicationReady='true';await assert.rejects(observeOdcBrowserStartup(g.args),/state_unbound/);
 const h=fixture();delete h.context[h.args.runtimeHandle];await assert.rejects(observeOdcBrowserStartup(h.args),/state_unbound/);
 const i=fixture();i.args.page.send=async()=>({exceptionDetails:{text:'private'}});await assert.rejects(observeOdcBrowserStartup(i.args),/state_unbound/);
 await assert.rejects(observeOdcBrowserStartup({...f.args,page:{evaluate:async()=>({})}}),/contract_invalid/);
});

test('an unbound instrumentation boundary is reported, not hidden behind the application state',async()=>{
 const f=fixture(),runtime=f.context[f.args.runtimeHandle];f.application.isApplicationReady=true;
 runtime.observeInstrumentation=()=>{throw Error('private factory state');};
 const r=await observeOdcBrowserStartup(f.args);
 assert.equal(r.applicationReady,true);assert.deepEqual(r.instrumentation,{nativeTracerStateBound:false});
 runtime.observeInstrumentation=()=>({nativeFactoryRetained:true,nativeTracerStateBound:true,nativeTracerDisabled:true});
 assert.equal((await observeOdcBrowserStartup(f.args)).instrumentation.nativeTracerDisabled,true);
});

test('reads web/native conditions from the bound SDK and definition without invoking device getters',async()=>{
 const f=fixture(),runtime=f.context[f.args.runtimeHandle],homeModuleKey='12345678-1234-4234-8234-123456789abc';let nativeCalls=0,deviceReads=0;
 runtime.boot={__ssamDefinition:{homeModuleKey,isWeb:true}};
 runtime.loadedModule=file=>{assert.equal(file,'_oschunk-SDK.js');return {q:Object.freeze({isRunningOnNative(){nativeCalls++;return false;}})};};
 f.context.window={};
 const args={...f.args,sdkModule:'_oschunk-SDK.js',homeModuleKey};
 const first=await observeOdcBrowserStartup(args);assert.equal(first.browserProfile.webApplication,true);assert.equal(first.browserProfile.runningOnNative,false);assert.equal(first.browserProfile.deviceState,'absent');
 assert.equal(first.browserProfile.syncConfigurationState,'absent');
 Object.defineProperty(f.context.window,'device',{get(){deviceReads++;throw Error('private-device');}});
 assert.equal((await observeOdcBrowserStartup(args)).browserProfile.deviceState,'accessor');assert.equal(deviceReads,0);assert.equal(nativeCalls,2);
 Object.defineProperty(runtime.boot.__ssamDefinition,'isWeb',{get(){throw Error('private-definition');}});
 await assert.rejects(observeOdcBrowserStartup(args),/state_unbound/);assert.equal(nativeCalls,2);
});

test('sync configuration observation does not execute accessors or silently treat objects as absent',async()=>{
 const f=fixture(),runtime=f.context[f.args.runtimeHandle],homeModuleKey='12345678-1234-4234-8234-123456789abc';
 runtime.boot={__ssamDefinition:{homeModuleKey,isWeb:true,syncConfiguration:{syncOnOnline:true}}};
 runtime.loadedModule=()=>({q:Object.freeze({isRunningOnNative:()=>false})});f.context.window={};
 const args={...f.args,sdkModule:'_oschunk-SDK.js',homeModuleKey};
 assert.equal((await observeOdcBrowserStartup(args)).browserProfile.syncConfigurationState,'present');
 runtime.boot.__ssamDefinition.syncConfiguration=null;
 assert.equal((await observeOdcBrowserStartup(args)).browserProfile.syncConfigurationState,'empty');
 Object.defineProperty(runtime.boot.__ssamDefinition,'syncConfiguration',{get(){throw Error('must not run');}});
 assert.equal((await observeOdcBrowserStartup(args)).browserProfile.syncConfigurationState,'accessor');
});
