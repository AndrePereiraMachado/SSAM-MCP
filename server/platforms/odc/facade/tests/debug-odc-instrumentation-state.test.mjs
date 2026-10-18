import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {inspectOdcInstrumentationState,bindOdcInstrumentationState} from '../debug-odc-instrumentation-state.mjs';
function fixture(){class Tracer{}const tracer=new Tracer,enabled=new WeakMap([[tracer,false]]),factory={getTracer:()=>tracer};
 return {tracer,enabled,args:{factory,retainedFactory:factory,namespace:{C:Tracer,E:enabled},binding:{tracerClass:'C',enabledMap:'E',sdkSha256:'reviewed'}}};}
test('reads native enabled state freshly and never invokes a span',()=>{
 const f=fixture();f.tracer.startSpan=()=>{throw Error('must not run');};
 assert.equal(inspectOdcInstrumentationState(f.args).nativeTracerDisabled,true);
 f.enabled.set(f.tracer,true);assert.equal(inspectOdcInstrumentationState(f.args).nativeTracerDisabled,false);
});
test('replacement factory, wrong tracer, missing flag and nonboolean state refuse',()=>{
 for(const mutate of [f=>f.args.factory={getTracer:()=>f.tracer},f=>f.args.factory.getTracer=()=>({}),
  f=>f.enabled.delete(f.tracer),f=>f.enabled.set(f.tracer,0),f=>f.args.namespace.E={get(){throw Error('must not run');}}]){
  const f=fixture();mutate(f);assert.throws(()=>inspectOdcInstrumentationState(f.args),/state_unbound/);
 }
});
test('namespace accessors cannot execute during state inspection',()=>{
 const f=fixture();Object.defineProperty(f.args.namespace,'E',{get(){throw Error('private getter');}});
 assert.throws(()=>inspectOdcInstrumentationState(f.args),/^Error: debug_odc_instrumentation_state_unbound$/);
});
test('serialized observer has no dependency on module scope',()=>{
 const f=fixture(),context=vm.createContext({args:f.args});
 assert.equal(vm.runInContext('('+inspectOdcInstrumentationState.toString()+')(args)',context).nativeTracerDisabled,true);
});
test('unreviewed SDK cannot select private native aliases',()=>{
 assert.throws(()=>bindOdcInstrumentationState({'sdk.js':'unreviewed'},{'sdk.js':['PI','Xu']}),/sdk_unreviewed/);
});
