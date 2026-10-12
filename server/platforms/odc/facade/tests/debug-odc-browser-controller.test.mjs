import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {observeOdcBrowserController} from '../debug-odc-browser-controller.mjs';
function fixture(){
 const runtimeHandle='__ssamOdcRuntime_'+'a'.repeat(48),runtimeUrl='https://fixture.example/App/',controllerModule='_oschunk-APP.js';
 const base={fireApplicationReady(){},setupOnApplicationResumeListener(){},setupSyncOnResume(){},fireApplicationResume(){}};
 const controller=Object.create(base);let loads=0;
 const namespace={default:controller};
 const context=vm.createContext({location:{href:runtimeUrl},[runtimeHandle]:{loadedModule(file){loads++;assert.equal(file,controllerModule);return namespace;}}});
 return {controller,base,namespace,context,loads:()=>loads,args:{runtimeHandle,runtimeUrl,controllerModule,page:{evaluate:async(fn,arg)=>vm.runInContext('('+fn.toString()+')',context)(arg)}}};
}
test('observes current own/inherited handler descriptors without dispatching them',async()=>{
 const f=fixture(),first=await observeOdcBrowserController(f.args);
 assert.equal(first.handlersAbsent,true);assert.ok(first.dispatch.every(d=>d.depth===1&&d.state==='function'));
 let invoked=false;f.base.onSyncHandler=()=>{invoked=true;};
 const second=await observeOdcBrowserController(f.args);assert.equal(second.handlersAbsent,false);
 assert.equal(second.handlers.find(d=>d.name==='onSyncHandler').depth,1);assert.equal(invoked,false);
 assert.equal(second.applicationStartupQualified,false);assert.equal(second.lifecycleComplete,false);
});
test('getters, explicit undefined, null and other data are distinguished without exposing values',async()=>{
 const f=fixture();let read=false;Object.defineProperty(f.controller,'onApplicationReadyHandler',{get(){read=true;throw Error('private');}});
 f.controller.onApplicationResumeHandler=undefined;f.controller.onSyncHandler='private value';
 const r=await observeOdcBrowserController(f.args);assert.equal(read,false);
 assert.deepEqual(Array.from(r.handlers,d=>d.state),['accessor','undefined','other']);assert.doesNotMatch(JSON.stringify(r),/private value/);
 f.controller.onSyncHandler=null;assert.equal((await observeOdcBrowserController(f.args)).handlers[2].state,'null');
});
test('changed origin, missing module and getter default export fail without invoking code',async()=>{
 const f=fixture();f.context.location.href='https://other.example/';await assert.rejects(observeOdcBrowserController(f.args),/unbound/);assert.equal(f.loads(),0);
 const g=fixture();delete g.namespace.default;await assert.rejects(observeOdcBrowserController(g.args),/unbound/);
 let read=false;Object.defineProperty(g.namespace,'default',{get(){read=true;}});await assert.rejects(observeOdcBrowserController(g.args),/unbound/);assert.equal(read,false);
});

test('an untracked dynamic module is reported without inferring browser load state or executing its importer',async()=>{
 const f=fixture();let imported=false;
 f.context[f.args.runtimeHandle]={loadedModule:()=>undefined,load:()=>{imported=true;throw Error();}};
 await assert.rejects(observeOdcBrowserController(f.args),/controller_module_not_tracked/);assert.equal(imported,false);
});

test('source-bound instance alias is inspected without requiring the wrapper module',async()=>{
 const f=fixture();f.namespace.__ssam_7=f.namespace.default;delete f.namespace.default;
 const result=await observeOdcBrowserController({...f.args,controllerExport:'__ssam_7'});
 assert.equal(result.nativeControllerBound,true);assert.equal(result.controllerExport,'__ssam_7');
 await assert.rejects(observeOdcBrowserController({...f.args,controllerExport:'unbound'}),/contract_invalid/);
});

test('matches native method source and depth, rejects shadowing without executing accessors',async()=>{
 const f=fixture();Object.setPrototypeOf(f.controller,Object.create(f.base));
 const expectedDispatch=Object.keys(f.base).map(name=>({name,source:f.base[name].toString()}));
 const run=()=>observeOdcBrowserController({...f.args,expectedDispatch});
 assert.equal((await run()).nativeDispatchSourceMatched,true);
 f.controller.fireApplicationReady=function fireApplicationReady(){return 'changed';};
 assert.equal((await run()).nativeDispatchSourceMatched,false);
 delete f.controller.fireApplicationReady;
 let invoked=false;Object.defineProperty(f.controller,'fireApplicationReady',{get(){invoked=true;throw Error('private');}});
 assert.equal((await run()).nativeDispatchSourceMatched,false);assert.equal(invoked,false);
 assert.doesNotMatch(JSON.stringify(await run()),/return 'changed'/);
});
