import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {isolateOdcBrowserInstrumentation} from '../debug-odc-browser-instrumentation.mjs';
test('native factory is retained and transport controls do not replace logger, tracer or debugger callbacks',async()=>{
 const calls=[],logger={removeTransport:n=>calls.push(['log',n])},tracer={removeTransport:n=>calls.push(['trace',n])};
 const factory={getLogger:async()=>logger,getTracer:()=>tracer,setTracerStatus:value=>calls.push(['status',value])};
 const original={...factory},r=await isolateOdcBrowserInstrumentation(factory);
 assert.deepEqual(factory,original);assert.equal(r.nativeFactoryRetained,true);assert.equal(r.applicationSettingsChanged,false);assert.equal(r.debuggerReplaced,false);
 assert.deepEqual(calls,[['status',false],['log','otel-logger-transport'],['log','native-logger-transport'],['log','console-transport'],['trace','otel-tracer-transport'],['trace','sw-tracer-transport']]);
});
test('missing native APIs refuse instead of substituting a fake factory',async()=>{
 for(const factory of [undefined,{}, {getLogger:async()=>({}),getTracer:()=>({}),setTracerStatus(){throw Error('must not call');}}])
  await assert.rejects(isolateOdcBrowserInstrumentation(factory),/native_api_unavailable/);
});
test('browser-serialized isolation has no module dependency and keeps native callback identity',async()=>{
 let called=0;const callback=()=>++called;
 const factory={getLogger:async()=>({removeTransport(){}}),getTracer:()=>({removeTransport(){}}),setTracerStatus(){},startActiveSpan:callback};
 const context=vm.createContext({factory});
 const result=await vm.runInContext('('+isolateOdcBrowserInstrumentation.toString()+')(factory)',context);
 assert.equal(result.nativeTracerDisabled,true);assert.equal(called,0);assert.equal(factory.startActiveSpan,callback);
});
