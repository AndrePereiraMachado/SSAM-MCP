import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createOdcBrowserControllerLoad} from '../debug-odc-browser-controller-load.mjs';
function fixture(){
 const events=[],handle='__ssamOdcRuntime_'+'a'.repeat(48),url='https://fixture.example/App/';
 const runtime={loadedModule:()=>({}),load:async()=>{events.push('native-import');}};
 const context=vm.createContext({location:{href:url},[handle]:runtime});
 const args={runtimeHandle:handle,runtimeUrl:url,controllerModule:'_oschunk-APP.js',
  authentication:{receipt:()=>({confirmed:true})},
  qualification:{initializationQualified:true,nativeEffectsQualified:true,wrapperSyntaxQualified:true,pendingNativeEffectKinds:[],
   requiredAlreadyLoadedModules:['_oschunk-SDK.js','_oschunk-DEBUG.js'],controller:{sourceHashes:{'_oschunk-APP.js':'a'.repeat(64)}}},
  page:{evaluate:async(fn,arg)=>{context.arg=arg;return vm.runInContext('('+fn.toString()+')(arg)',context);}},
  beforeLoad:async()=>{events.push('before');return {recorded:true};},
  recordOutcome:async outcome=>{events.push(JSON.parse(JSON.stringify(outcome)));return {recorded:true};}};
 return {args,events,runtime,context};
}
test('qualified original import runs after durable submission, once, without claiming lifecycle',async()=>{
 const f=fixture(),loader=createOdcBrowserControllerLoad(f.args),r=await loader.load();
 assert.deepEqual(f.events,['before','native-import',{invoked:true,importReturned:true}]);
 assert.equal(r.nativeControllerImported,true);assert.equal(r.lifecycleComplete,false);assert.equal(r.applicationStartupQualified,false);
 await assert.rejects(loader.load(),/already_attempted/);assert.equal(loader.receipt().uncertain,false);
});
test('view import uses the same durable transport without claiming controller or lifecycle execution',async()=>{
 const f=fixture(),loader=createOdcBrowserControllerLoad({...f.args,importKind:'view'}),r=await loader.load();
 assert.equal(r.nativeViewImported,true);assert.equal(r.nativeControllerImported,undefined);assert.equal(r.lifecycleComplete,false);
 await assert.rejects(loader.load(),/already_attempted/);
});
test('authentication and qualification are required before submission',async()=>{
 for(const change of [a=>a.authentication.receipt=()=>({confirmed:false}),a=>a.qualification.initializationQualified=false,
  a=>a.qualification.pendingNativeEffectKinds=['unknown'],a=>a.qualification.controller.sourceHashes={}]){
  const f=fixture();change(f.args);await assert.rejects(createOdcBrowserControllerLoad(f.args).load());assert.deepEqual(f.events,[]);
 }
});
test('untracked prerequisite and changed origin never import, and record a definite refusal',async()=>{
 for(const change of [f=>f.runtime.loadedModule=()=>undefined,f=>f.context.location.href='https://other.example/']){
  const f=fixture();change(f);const loader=createOdcBrowserControllerLoad(f.args);
  await assert.rejects(loader.load(),/prerequisite_not_tracked|runtime_unbound/);
  assert.equal(f.events.includes('native-import'),false);assert.equal(loader.receipt().nativeInvoked,false);
  assert.equal(loader.receipt().uncertain,false);await assert.rejects(loader.load(),/already_attempted/);
 }
});
test('lost CDP response preserves uncertainty and refuses replay',async()=>{
 const f=fixture();f.args.page.evaluate=async()=>{f.events.push('native-import');throw Error('secret-native-error');};
 const loader=createOdcBrowserControllerLoad(f.args);await assert.rejects(loader.load(),/result_uncertain/);
 assert.equal(loader.receipt().uncertain,true);assert.equal(JSON.stringify(f.events).includes('secret'),false);
 await assert.rejects(loader.load(),/already_attempted/);
});
test('uncertain before/result journals cannot authorize a repeated import',async()=>{
 for(const phase of ['beforeLoad','recordOutcome']){
  const f=fixture();f.args[phase]=async()=>({recorded:false});const loader=createOdcBrowserControllerLoad(f.args);
  await assert.rejects(loader.load(),/unrecorded/);await assert.rejects(loader.load(),/already_attempted/);
  assert.equal(f.events.includes('native-import'),phase==='recordOutcome');
  assert.equal(loader.receipt().uncertain,phase==='recordOutcome');
 }
});
test('failed native import is persisted without leaking error and cannot replay',async()=>{
 const f=fixture();f.runtime.load=async()=>{throw Error('private value');};const loader=createOdcBrowserControllerLoad(f.args);
 await assert.rejects(loader.load(),/native_import_failed/);assert.equal(loader.receipt().uncertain,true);
 assert.deepEqual(f.events,['before',{invoked:true,importReturned:false}]);await assert.rejects(loader.load(),/already_attempted/);
});
