// These private aliases expose existing native state; they never manufacture
// a tracer, invoke a span callback, or change the native enabled flag.
import {assetHash} from './debug-odc-native-assets.mjs';
const sdkHash='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d';
export function bindOdcInstrumentationState(files,exports){
 const candidates=Object.entries(files).filter(([name,source])=>name.endsWith('.js')&&assetHash(source)===sdkHash);
 if(candidates.length!==1)throw Error('debug_odc_instrumentation_state_sdk_unreviewed');
 const [file]=candidates[0],names=exports[file];
 const alias=name=>{const i=names?.indexOf(name);if(!Number.isInteger(i)||i<0||names.lastIndexOf(name)!==i)throw Error('debug_odc_instrumentation_state_alias_missing');return '__ssam_'+i;};
 // Reviewed PI.setStatus and PI.startSpan/startActiveSpan share Xu. The
 // pinned module initializes Xu with new WeakMap and never reassigns it.
 return {file,sdkSha256:sdkHash,tracerClass:alias('PI'),enabledMap:alias('Xu')};
}
// Serialized into the owned browser. Returns booleans only, never SDK objects.
export function inspectOdcInstrumentationState({factory,retainedFactory,namespace,binding}){
 const fail=()=>{throw Error('debug_odc_instrumentation_state_unbound');};
 if(!factory||factory!==retainedFactory||typeof factory.getTracer!=='function')fail();
 const value=key=>{const d=Object.getOwnPropertyDescriptor(namespace,key);if(!d||!Object.hasOwn(d,'value'))fail();return d.value;};
 const Constructor=value(binding.tracerClass),enabled=value(binding.enabledMap),tracer=factory.getTracer();
 if(typeof Constructor!=='function'||!tracer||Object.getPrototypeOf(tracer)!==Constructor.prototype)fail();
 // Intrinsic WeakMap methods do not execute application getters or methods.
 let flag;try{if(!WeakMap.prototype.has.call(enabled,tracer))fail();flag=WeakMap.prototype.get.call(enabled,tracer);}catch{fail();}
 if(typeof flag!=='boolean')fail();
 return {nativeFactoryRetained:true,nativeTracerStateBound:true,nativeTracerDisabled:!flag,
  sdkSha256:binding.sdkSha256,applicationSettingsChanged:false,debuggerReplaced:false};
}
