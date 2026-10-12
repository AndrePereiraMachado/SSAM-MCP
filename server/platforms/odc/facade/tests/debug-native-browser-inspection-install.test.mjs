import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {installNativeBrowserInspection} from '../debug-native-browser-inspection-install.mjs';

test('ODC browser installer binds the runtime binary class privately and observes same-size replacements',async()=>{
 class Binary {constructor(content){this.bytes=content;}get content(){return this.bytes;}}
 let value=new Binary('AAEC'),shapeCalls=0;
 const runtimeHandle='__ssamOdcRuntime_'+'a'.repeat(48);
 const dbg={getThreadState:()=>({getCallOnStack:()=>({})}),getThreadStack:()=>[{elementKey:'Module:Action'}],
  evaluateVariable:()=>({type:'BinaryData',value:3}),innerEvaluateVariable:()=>value};
 const sandbox={TextEncoder,crypto:webcrypto,OutSystemsDebugger:dbg,
  [runtimeHandle]:{shape(...keys){assert.deepEqual(Array.from(keys),['DataTypes','GenericRecord']);shapeCalls++;return {BinaryData:Binary};}}};
 const context=vm.createContext(sandbox);
 const host={inspectionUrl:'ws://127.0.0.1/private',dispose:async()=>{},page:{
  send:async(method,{expression})=>{assert.equal(method,'Runtime.evaluate');return {result:{value:vm.runInContext(expression,context)}};},
  evaluate:async(fn,arg)=>vm.runInContext('('+fn.toString()+')('+JSON.stringify(arg)+')',context)
 }};
 const installed=await installNativeBrowserInspection({host,runtimeHandle,options:{platform:'odc',
  modules:[{moduleKey:'Module',sourceSha256:'a'.repeat(64)}],
  variables:[{moduleKey:'Module',actionKey:'Action',variableKey:'Value',name:'Value',category:'local'}]}});
 assert.equal(shapeCalls,1);
 const request=input=>sandbox[installed.capability.helperName](input);
 request({op:'pause',callContextId:1});const ref=request({op:'scope'}).result.variables[0].ref;
 for(const content of ['AAEC','AwQF']){
  value=new Binary(content);
  const result=request({op:'private-capture',ref,binary:true,consumerCapability:installed.capability.privateConsumerCapability});
  assert.equal(result.ok,true);assert.equal(result.result.nativeContentComplete,true);
  assert.equal(result.result.privateEnvelope.value.value,content);
 }
 assert.equal(request({op:'read',ref}).result.valueComplete,false);
 await installed.remove();assert.equal(sandbox[installed.capability.helperName],undefined);
});

test('a caller cannot substitute an arbitrary browser runtime handle',async()=>{
 let sent=false;
 await assert.rejects(installNativeBrowserInspection({host:{page:{send(){sent=true;},evaluate(){}},dispose(){}},
  runtimeHandle:'arbitrary',options:{}}),/runtime_handle_invalid/);
 assert.equal(sent,false);
});

test('O11 browser installer binds the O11 runtime binary class and converter privately',async()=>{
 class Binary {constructor(content){this.bytes=content;}get content(){return this.bytes;}}
 const converter={to:value=>value};let value=new Binary('AAEC'),typeCalls=0,converterCalls=0;
 const runtimeHandle='__ssamO11Runtime_'+'b'.repeat(48);
 const dbg={getThreadState:()=>({getCallOnStack:()=>({})}),getThreadStack:()=>[{elementKey:'Module:Action'}],
  evaluateVariable:()=>({type:'BinaryData',value:3}),innerEvaluateVariable:()=>value};
 const sandbox={TextEncoder,crypto:webcrypto,OutSystemsDebugger:dbg,
  [runtimeHandle]:{nativeBinaryType(){typeCalls++;return Binary;},nativeConverter(){converterCalls++;return converter;},
   shape(){throw new Error('ODC shape must not be used for O11');}}};
 const context=vm.createContext(sandbox);
 const host={inspectionUrl:'ws://127.0.0.1/private',dispose:async()=>{},page:{
  send:async(method,{expression})=>({result:{value:vm.runInContext(expression,context)}}),
  evaluate:async(fn,arg)=>vm.runInContext('('+fn.toString()+')('+JSON.stringify(arg)+')',context)}};
 const installed=await installNativeBrowserInspection({host,runtimeHandle,options:{platform:'o11',
  modules:[{moduleKey:'Module',sourceSha256:'a'.repeat(64)}],
  variables:[{moduleKey:'Module',actionKey:'Action',variableKey:'Value',name:'Value',category:'local'}]}});
 assert.equal(typeCalls,1);assert.equal(converterCalls,1);
 const request=input=>sandbox[installed.capability.helperName](input);
 request({op:'pause',callContextId:1});const ref=request({op:'scope'}).result.variables[0].ref;
 const result=request({op:'private-capture',ref,binary:true,consumerCapability:installed.capability.privateConsumerCapability});
 assert.equal(result.ok,true);assert.equal(result.result.privateEnvelope.value.value,'AAEC');
 await installed.remove();assert.equal(sandbox[installed.capability.helperName],undefined);
});

test('runtime handle and platform must belong to the same lane; an O11 runtime without a binary type refuses',async()=>{
 for(const [runtimeHandle,platform] of [['__ssamO11Runtime_'+'c'.repeat(48),'odc'],['__ssamOdcRuntime_'+'c'.repeat(48),'o11'],
  ['__ssamO11Runtime_'+'c'.repeat(47),'o11'],['__ssamO11Runtime_'+'C'.repeat(48),'o11'],['__ssamBplRuntime_'+'c'.repeat(48),'o11']]){
  let sent=false;
  await assert.rejects(installNativeBrowserInspection({host:{page:{send(){sent=true;},evaluate(){}},dispose(){}},
   runtimeHandle,options:{platform,modules:[],variables:[]}}),/runtime_handle_invalid/,runtimeHandle+' '+platform);
  assert.equal(sent,false);
 }
 const runtimeHandle='__ssamO11Runtime_'+'d'.repeat(48);
 const sandbox={TextEncoder,crypto:webcrypto,OutSystemsDebugger:{getThreadState(){},getThreadStack:()=>[],evaluateVariable(){}},
  [runtimeHandle]:{nativeBinaryType:()=>undefined}},context=vm.createContext(sandbox);
 let removed=false;
 const host={inspectionUrl:'ws://127.0.0.1/private',dispose:async()=>{},page:{
  send:async(method,{expression})=>{try{return {result:{value:vm.runInContext(expression,context)}};}catch{return {exceptionDetails:{}};}},
  evaluate:async()=>{removed=true;return {removed:true};}}};
 await assert.rejects(installNativeBrowserInspection({host,runtimeHandle,options:{platform:'o11',modules:[{moduleKey:'Module',sourceSha256:'a'.repeat(64)}],variables:[]}}),/install_failed/);
 assert.equal(removed,true);
});

test('ODC browser installer forwards pauseOnExceptions to OutSystemsDebugger.pauseOnAllExceptions and refuses non-boolean values',async()=>{
 for(const pauseOnExceptions of [true,false,undefined]){
  const calls=[];
  const dbg={getThreadState:()=>({}),getThreadStack:()=>[],evaluateVariable(){},startSession:()=>calls.push('start'),endSession:()=>calls.push('end'),
   allowBreakpointsFromModule:k=>calls.push('module:'+k),addBreakpoints:b=>calls.push('breakpoints:'+b.join(',')),pauseOnAllExceptions:v=>calls.push('exceptions:'+v)};
  const sandbox={TextEncoder,crypto:webcrypto,OutSystemsDebugger:dbg},context=vm.createContext(sandbox);
  const host={inspectionUrl:'ws://127.0.0.1/private',dispose:async()=>{},page:{
   send:async(method,{expression})=>({result:{value:vm.runInContext(expression,context)}}),
   evaluate:async(fn,arg)=>vm.runInContext('('+fn.toString()+')('+JSON.stringify(arg)+')',context)}};
  const installed=await installNativeBrowserInspection({host,options:{platform:'odc',modules:[{moduleKey:'Module',sourceSha256:'a'.repeat(64)}],
   variables:[],breakpoints:['Module:Node'],...(pauseOnExceptions===undefined?{}:{pauseOnExceptions})}});
  await installed.start();
  assert.deepEqual(calls,['start','module:Module','breakpoints:Module:Node','exceptions:'+(pauseOnExceptions===true)]);
  await installed.remove();assert.equal(calls.at(-1),'end');
 }
 let sent=false;
 await assert.rejects(installNativeBrowserInspection({host:{page:{send(){sent=true;},evaluate(){}},dispose(){}},
  options:{platform:'odc',modules:[],variables:[],pauseOnExceptions:'true'}}),/debug_native_browser_inspection_options_invalid/);
 assert.equal(sent,false);
});
