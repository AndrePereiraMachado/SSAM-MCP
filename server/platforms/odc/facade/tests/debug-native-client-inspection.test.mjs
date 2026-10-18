import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { createNativeClientInspection, connectNativeClientInspector, redactNativeClientValue, clientInspectionEnableOptions } from '../debug-native-client-inspection.mjs';
import { createPrivateInspectionChannel, privateInspectionVault, PRIVATE_VAULT_CALL_TIMEOUT_MS } from '../debug-private-inspection.mjs';
import { createNativeClientInspectionCore } from '../debug-native-client-inspection-core.mjs';
import { createPrivateCompareSession } from '../debug-private-compare.mjs';
import { createHash, randomBytes } from 'node:crypto';

const modules = [{ moduleKey: 'Module', sourceSha256: 'a'.repeat(64) }];

test('cooperative pause transport locates the private VM context and waits for an actual native stop', {timeout:15000},async()=>{
 const moduleUrl=new URL('../debug-native-client-inspection.mjs',import.meta.url).href;
 const source=`import vm from 'node:vm';import readline from 'node:readline';
 import {createNativeClientInspection,openNativeClientInspector} from ${JSON.stringify(moduleUrl)};
 const sandbox={},ctx=vm.createContext(sandbox);
 vm.runInContext(\`globalThis.dbg={isInSession:true,callContexts:new Map([[9,{}]]),getThreadState(){return {}},getThreadStack(){return [{elementKey:'Module:Action'}]},evaluateVariable(){return {type:'Integer',value:17}},stepInto(){this.pending=true},continue(){},callDebugger(id){debugger;}};globalThis.tick=()=>{if(dbg.pending){dbg.pending=false;dbg.callDebugger(9)}};\`,ctx);
 const s=createNativeClientInspection({debuggerObject:sandbox.dbg,globalObject:sandbox,platform:'o11',modules:${JSON.stringify(modules)}});
 const i=openNativeClientInspector();console.log(JSON.stringify({url:i.url,helperName:s.helperName}));
 readline.createInterface({input:process.stdin}).on('line',line=>{if(line==='tick'){vm.runInContext('tick()',ctx);console.log('done')}else{s.dispose();i.close();process.exit(0)}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['pipe','pipe','ignore']});
 const lines=readline.createInterface({input:child.stdout});let driver;
 try{
  const [line]=await once(lines,'line'),events=[];let notify;
  driver=await connectNativeClientInspector({...JSON.parse(line),leaseMs:10000,terminate:()=>child.kill(),onEvent:e=>{events.push(e);notify?.();}});
  const accepted=await driver.command({op:'request-pause'});assert.equal(accepted.requested,true);assert.equal(accepted.paused,false);
  assert.equal(events.filter(e=>e.kind==='paused').length,0);
  await assert.rejects(driver.command({op:'request-pause'}),/pause_request_pending/);
  child.stdin.write('tick\n');while(!events.some(e=>e.kind==='paused'))await new Promise(r=>{notify=r});
  assert.equal(events.find(e=>e.kind==='paused').callContextId,9);
  const done=once(lines,'line');await driver.command({op:'continue'});assert.equal((await done)[0],'done');
  await driver.close();const exited=once(child,'exit');child.stdin.write('dispose\n');assert.equal((await exited)[0],0);
 }finally{await driver?.close();child.kill();lines.close();}
});
const variables = [{ moduleKey: 'Module', actionKey: 'Action', variableKey: 'InputKey', name: 'Input', category: 'input' },
  { moduleKey: 'Module', actionKey: 'Action', variableKey: 'ListKey', name: 'Rows', category: 'local' }];

for (const platform of ['o11','odc']) test(platform+': cooperative pause uses native steps only for bound active contexts and refuses replay',()=>{
 const globalObject={},calls=[];
 const dbg={isInSession:true,callContexts:new Map([[9,{}],[10,{}]]),evaluateVariable(){},
  getThreadState:id=>dbg.callContexts.get(id),getThreadStack:id=>[{elementKey:(id===9?'Module':'Foreign')+':Action'}],
  stepInto:id=>calls.push(id),continue(){}};
 const session=createNativeClientInspection({globalObject,debuggerObject:dbg,platform,modules,variables:[]});
 const call=input=>globalObject[session.helperName](input);
 assert.deepEqual(call({op:'request-pause'}).result.callContextIds,[9]);assert.deepEqual(calls,[9]);
 assert.equal(call({op:'scope'}).error,'debug_native_client_stale_reference');
 assert.equal(call({op:'request-pause'}).error,'debug_native_client_pause_request_pending');
 assert.equal(call({op:'pause',callContextId:9}).ok,true);
 assert.equal(call({op:'request-pause'}).error,'debug_native_client_pause_not_running');
 call({op:'continue'});assert.equal(call({op:'request-pause'}).ok,true);assert.deepEqual(calls,[9,9]);
 session.dispose();assert.equal(globalObject[session.helperName],undefined);
});

for(const platform of ['o11','odc'])test(platform+': expanded binary observes native conversion and restores length accessor on success and failure',()=>{
 class Binary {constructor(content){this.data=content;}get content(){return this.data;}get length(){return 3;}}
 const original=Object.getOwnPropertyDescriptor(Binary.prototype,'length');
 const raw=new Binary('AAEC'),other=new Binary('AwQF'),globalObject={},captured=[];
 let mode='normal',evaluations=0;
 const dbg={getThreadState:()=>({getCallOnStack:()=>({})}),getThreadStack:()=>[{elementKey:'Module:Action'}],
  innerEvaluateVariable(){throw Error('must not independently reevaluate root');},
  evaluateVariable(ccid,frame,action,key,path){
   evaluations++;assert.equal(path,'Input.Rows[150].Payload');
   if(mode==='throws'){void raw.length;throw Error('native failed');}
   if(mode==='ambiguous')void other.length;
   return {type:'BinaryData',value:raw.length};
  },stepInto(){}};
 const session=createNativeClientInspection({globalObject,debuggerObject:dbg,platform,modules,variables:[variables[0]],binaryType:Binary,
  privateChannel:{publish(e){captured.push(structuredClone(e));return {reference:'opaque'};},invalidate:()=>({completed:true}),close:()=>({completed:true})}});
 const request=input=>globalObject[session.helperName](input);request({op:'pause',callContextId:9});
 const parent=request({op:'scope'}).result.variables[0].ref;
 const ref=request({op:'expand',ref:parent,path:'.Rows[150].Payload'}).result.ref;
 const before=evaluations;
 assert.equal(request({op:'private-read',ref,binary:true}).ok,true);
 assert.equal(evaluations,before+1);assert.equal(captured[0].value.value,'AAEC');
 assert.deepEqual(Object.getOwnPropertyDescriptor(Binary.prototype,'length'),original);
 raw.data='AwQF';assert.equal(request({op:'private-read',ref,binary:true}).result.changed,true);
 mode='ambiguous';assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_binary_content_unavailable');
 mode='throws';assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_evaluation_failed');
 assert.deepEqual(Object.getOwnPropertyDescriptor(Binary.prototype,'length'),original);
 request({op:'stepInto'});assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_stale_reference');
 session.dispose();
});

for(const platform of ['o11','odc'])test(platform+': explicit private binary uses native preconversion getter, stays private and observes same-length changes',()=>{
 class Binary{constructor(content){this._content=content;this.getOfflineContent=undefined;this._url=undefined;this._cachedBlob=null;}get content(){return this._content;}get url(){return this._url;}get cachedBlob(){return this._cachedBlob;}fastEquals(other){return this._content===other._content&&this._url===other._url&&Boolean(this.getOfflineContent)===Boolean(other.getOfflineContent)||this._content===null&&other._content===''&&!this._url&&!this.getOfflineContent;}}
 let raw=new Binary('AAEC'),wireLength=3,reads=0;const captured=[],globalObject={},frame={};
 const dbg={getThreadState:()=>({getCallOnStack:()=>frame}),getThreadStack:()=>[{elementKey:'Module:Action'}],
  evaluateVariable:()=>({type:'BinaryData',value:wireLength}),innerEvaluateVariable(...args){reads++;assert.deepEqual(args,[9,0,'Action','InputKey']);return raw;},stepInto(){}};
 const channel={publish(e){captured.push(structuredClone(e));return {reference:'opaque'};},invalidate:()=>({completed:true}),close:()=>({completed:true})};
 const session=createNativeClientInspection({globalObject,debuggerObject:dbg,platform,modules,variables:[variables[0]],binaryType:Binary,privateChannel:channel});
 const request=input=>globalObject[session.helperName](input);request({op:'pause',callContextId:9});const ref=request({op:'scope'}).result.variables[0].ref;
 const first=request({op:'private-read',ref,binary:true});assert.equal(first.ok,true);assert.equal(first.result.nativeContentComplete,true);assert.equal(first.result.valueComplete,false);
 assert.equal(captured[0].value.value,'AAEC');assert.equal(captured[0].value.encoding,'base64');assert.doesNotMatch(JSON.stringify(first),/AAEC/);
 raw._content='AwQF';assert.equal(request({op:'private-read',ref,binary:true}).result.changed,true);
 assert.equal(request({op:'read',ref}).result.nativeSummary,true);assert.equal(request({op:'private-read',ref,binary:true}).result.changed,false);
 raw._content='AA==';assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_binary_content_changed');
 raw._content='AB==';assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_binary_content_invalid');
 raw._content=undefined;assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_binary_content_unavailable');
 raw=new Binary('');wireLength=0;assert.equal(request({op:'private-read',ref,binary:true}).ok,true);
 raw=new Binary(null);assert.equal(request({op:'private-read',ref,binary:true}).ok,true);
 for(const patch of [{_url:'https://not-requested.invalid/binary'},{_cachedBlob:{}},{getOfflineContent:()=>{throw Error('must not load');}}]){
  raw=Object.assign(new Binary(null),patch);assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_binary_content_unavailable');
 }
 raw=new Binary('A'.repeat(131072));wireLength=98304;assert.equal(request({op:'private-read',ref,binary:true}).ok,true);
 const child=request({op:'expand',ref,path:'.Content'}).result.ref;const before=reads;
 assert.equal(request({op:'private-read',ref:child,binary:true}).error,'debug_native_client_binary_content_unavailable');assert.equal(reads,before);
 request({op:'stepInto'});assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_stale_reference');assert.equal(reads,before);
 session.dispose();
});

for (const platform of ['o11','odc']) test(platform+': binary return content exists only during the original native return breakpoint',()=>{
 class Binary {constructor(content){this.value=content;}get content(){return this.value;}}
 const raw=new Binary('AAEC'),globalObject={},owner={},captured=[];
 const stack={elementKey:'Module:Action',currentBreakpoint:'Module:Node',breakpointType:1};
 let onReturn,callbackCalls=0,ref;
 const dbg={BreakpointType:{AtFunctionReturn:1},getThreadState:()=>({stackLevel:1,getCallOnStack:()=>owner}),getThreadStack:()=>[stack],
  evaluateVariable:()=>({type:'BinaryData',value:3}),
  handleFunctionCall(callback){const value=callback();onReturn();return value;}};
 const original=dbg.handleFunctionCall;
 const session=createNativeClientInspection({globalObject,debuggerObject:dbg,platform,modules,variables:[],binaryType:Binary,
  privateChannel:{publish(e){captured.push(e.value);return {reference:'opaque'};},invalidate:()=>({completed:true,pending:0}),close:()=>({completed:true,pending:0})}});
 const request=input=>globalObject[session.helperName](input);
 onReturn=()=>{
  request({op:'pause',callContextId:9});ref=request({op:'scope'}).result.variables[0].ref;
  assert.equal(request({op:'read',ref}).result.nativeSummary,true);
  const value=request({op:'private-read',ref,binary:true});assert.equal(value.ok,true,value.error);
  assert.equal(value.result.nativeContentComplete,true);assert.equal(JSON.stringify(value).includes('AAEC'),false);
  assert.deepEqual(captured.at(-1),{type:'BinaryData',value:'AAEC',encoding:'base64',byteLength:3});
 };
 assert.equal(dbg.handleFunctionCall(()=>{callbackCalls++;return raw;},1,9),raw);assert.equal(callbackCalls,1);
 assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_binary_content_unavailable');
 const failure=new Error('original callback failure');assert.throws(()=>dbg.handleFunctionCall(()=>{throw failure;},1,9),e=>e===failure);
 assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_binary_content_unavailable');
 assert.equal(dbg.handleFunctionCall(()=>{callbackCalls++;return dbg.handleFunctionCall(()=>{callbackCalls++;return raw;},1,9);},1,9),raw);
 assert.equal(callbackCalls,3);assert.equal(captured.length,3);
 assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_binary_content_unavailable');
 session.dispose();assert.equal(dbg.handleFunctionCall,original);
});

test('compound return native watch is removed after conversion failure without changing existing metadata',()=>{
 for(const existing of [false,true]){
  class Binary{get length(){return 3;}get content(){return 'AAEC';}}
  const owner={varBag:{callContext:{}}},raw={payload:new Binary()},globalObject={};let onReturn,calls=0;
  const dbg={BreakpointType:{AtFunctionReturn:1},getThreadStack:()=>[{elementKey:'Module:Action',currentBreakpoint:'Module:Node',breakpointType:1}],getThreadState:()=>({stackLevel:1,getCallOnStack:()=>owner}),
   splitPath:path=>path.split('.').slice(1),registerMetaInfo(values){this.metaInfoMap??=new Map();for(const [key,value]of Object.entries(values))this.metaInfoMap.set(key,value);},
   handleFunctionCall(callback){calls++;const result=callback();onReturn();return result;},
   evaluateVariable(ccid,frame,action,key){if(!key)return {type:'Record',value:{Payload:{type:'BinaryData',value:3}}};assert.equal(this.metaInfoMap.get(key).getter(),raw);void raw.payload.length;throw Error('conversion failed');}};
  if(existing)dbg.metaInfoMap=new Map([['original',{getter:()=>1}]]);
  const originalMap=dbg.metaInfoMap,length=Object.getOwnPropertyDescriptor(Binary.prototype,'length');
  const session=createNativeClientInspection({globalObject,debuggerObject:dbg,platform:'odc',modules,variables:[],binaryType:Binary,
   privateChannel:{publish(){throw Error('must not publish failed read');},invalidate:()=>({completed:true}),close:()=>({completed:true})}});
  const request=input=>globalObject[session.helperName](input);
  onReturn=()=>{
   request({op:'pause',callContextId:9});const parent=request({op:'scope'}).result.variables[0].ref;
   const ref=request({op:'expand',ref:parent,path:'.Payload'}).result.ref;
   assert.equal(request({op:'private-read',ref,binary:true}).error,'debug_native_client_evaluation_failed');
   assert.equal(dbg.metaInfoMap,originalMap);if(existing)assert.deepEqual([...dbg.metaInfoMap.keys()],['original']);
   else assert.equal(Object.hasOwn(dbg,'metaInfoMap'),false);
   assert.deepEqual(Object.getOwnPropertyDescriptor(Binary.prototype,'length'),length);
  };
  assert.equal(dbg.handleFunctionCall(()=>raw,1,9),raw);assert.equal(calls,1);session.dispose();
 }
});

test('return observation cannot introduce a failure or inspect a stopped native session',()=>{
 const globalObject={},expected={},originalError=new Error('callback');let calls=0,lookups=0;
 const dbg={isInSession:false,getThreadStack:()=>[],evaluateVariable:()=>({}),
  getThreadState(){lookups++;throw Error('observation unavailable');},handleFunctionCall(callback){return callback();}};
 const session=createNativeClientInspection({globalObject,debuggerObject:dbg,platform:'o11',modules,variables:[],binaryType:class{},
  privateChannel:{invalidate:()=>({completed:true}),close:()=>({completed:true})}});
 assert.equal(dbg.handleFunctionCall(()=>{calls++;return expected;},1,9),expected);
 assert.equal(lookups,0);
 dbg.isInSession=true;
 assert.equal(dbg.handleFunctionCall(()=>{calls++;return expected;},1,9),expected);
 assert.equal(lookups,1);
 assert.throws(()=>dbg.handleFunctionCall(()=>{calls++;throw originalError;},1,9),e=>e===originalError);
 assert.equal(calls,3);assert.equal(lookups,1);session.dispose();
});

for(const platform of ['o11','odc'])test(platform+': native binary length cannot count as full content, including expanded fields and refresh',()=>{
 const globalObject={},frame={};let length=0,type='BinaryData';
 const dbg={getThreadState:()=>({getCallOnStack:()=>frame}),getThreadStack:()=>[{elementKey:'Module:Action'}],
  evaluateVariable:()=>({type,value:length})};
 const session=createNativeClientInspection({globalObject,debuggerObject:dbg,platform,modules,variables:[variables[0]]});
 const request=input=>globalObject[session.helperName](input);request({op:'pause',callContextId:9});
 const ref=request({op:'scope'}).result.variables[0].ref;
 for(const n of [0,256,8192]){
  length=n;const r=request({op:'refresh',ref}).result;
  assert.equal(r.value.value,n);assert.equal(r.nativeSummary,true);assert.equal(r.valueComplete,false);
  assert.equal(r.limitation,'native_binary_content_unavailable');
  const child=request({op:'expand',ref,path:'.Content'}).result;assert.equal(child.nativeSummary,true);assert.equal(child.valueComplete,false);
 }
 length='BinaryData (8192 bytes)';assert.equal(request({op:'slice',ref}).error,'debug_native_client_return_text_unavailable');
 type='Text';assert.equal(request({op:'refresh',ref}).result.valueComplete,true);
 session.dispose();
});

for (const platform of ['o11','odc']) test(platform+': native flow exception action identity reaches the evaluator unchanged',()=>{
  const actionKey='LXQ1dKTtRUeai5qBhffq7g.#FlowExceptionHandler',calls=[],globalObject={};
  const frame={};
  const dbg={getThreadState:()=>({getCallOnStack:()=>frame}),getThreadStack:()=>[{elementKey:'Module:'+actionKey}],
    evaluateVariable(...args){calls.push(args);return {type:'Text',value:'diagnostic error'};}};
  const options={globalObject,debuggerObject:dbg,platform,modules,variables:[{...variables[0],actionKey}]};
  const session=createNativeClientInspection(options),request=input=>globalObject[session.helperName](input);
  request({op:'pause',callContextId:9});
  const scope=request({op:'scope'});assert.equal(scope.ok,true);
  const read=request({op:'read',ref:scope.result.variables[0].ref});assert.equal(read.ok,true);
  assert.ok(calls.length>0);assert.ok(calls.every(c=>c[2]===actionKey));session.dispose();
  for(const invalid of ['Action.#FlowExceptionHandler',actionKey+'.other',actionKey.replace('FlowExceptionHandler','Unknown')])
    assert.throws(()=>createNativeClientInspection({...options,variables:[{...variables[0],actionKey:invalid}]}),/metadata_invalid/);
});

for (const platform of ['o11', 'odc']) test(platform + ': compound variable pages bind native child paths and refresh them', () => {
  const globalObject = {}, frame = {}; let current = 301;
  const dbg = { getThreadState: () => ({ getCallOnStack: () => frame }),
    getThreadStack: () => [{ elementKey: 'Module:Action' }],
    evaluateVariable(_id, _frame, _action, _key, path) {
      if (path === 'Rows[300]') return { type: 'Integer', value: current };
      return { type: 'RecordList', value: Object.fromEntries(Array.from({ length: 301 }, (_, i) => ['[' + i + ']', { type: 'Integer', value: i }])) };
    }, stepInto() {} };
  const session = createNativeClientInspection({ globalObject, debuggerObject: dbg, platform, modules, variables: [variables[1]] });
  const request = value => globalObject[session.helperName](value);
  request({ op: 'pause', callContextId: 9 });
  const ref = request({ op: 'scope' }).result.variables[0].ref;
  let offset = 0; const children = [];
  do { const page = request({ op: 'children', ref, offset, limit: 150 }).result;
    children.push(...page.children); offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(children.length, 301);
  const child = children.at(-1).ref;
  assert.equal(request({ op: 'read', ref: child }).result.value.value, 301);
  current = 999;
  assert.equal(request({ op: 'refresh', ref: child }).result.value.value, 999);
  request({ op: 'stepInto' });
  assert.equal(request({ op: 'read', ref: child }).error, 'debug_native_client_stale_reference');
  session.dispose();
});

for (const platform of ['o11', 'odc']) test(platform + ': expanded sensitive field stays private through read and text pages', () => {
  const globalObject = {}, frame = {};
  const dbg = { getThreadState: () => ({ getCallOnStack: () => frame }),
    getThreadStack: () => [{ elementKey: 'Module:Action' }],
    evaluateVariable: () => ({ type: 'Text', value: 'synthetic-hidden-value' }) };
  const session = createNativeClientInspection({ globalObject, debuggerObject: dbg, platform, modules,
    variables: [variables[0]] });
  const request = value => globalObject[session.helperName](value);
  request({ op: 'pause', callContextId: 9 });
  const ref = request({ op: 'scope' }).result.variables[0].ref;
  for (const path of ['.Password', '.Nested.AccessToken', '[3].UserName']) {
    const expanded = request({ op: 'expand', ref, path });
    assert.equal(expanded.ok, true);
    assert.equal(expanded.result.redacted, true);
    assert.equal(expanded.result.valueComplete, false);
    assert.doesNotMatch(JSON.stringify(expanded), /synthetic-hidden-value/);
    const page = request({ op: 'slice', ref: expanded.result.ref, offset: 0, limit: 64 });
    assert.equal(page.result.redacted, true);
    assert.doesNotMatch(JSON.stringify(page), /synthetic-hidden-value/);
  }
  session.dispose();
});

for (const platform of ['o11', 'odc']) test(platform + ': native input text pages preserve Unicode, refresh, privacy and stale-reference checks', () => {
  let text = 'Ω😀\n'.repeat(20);
  const globalObject = {}, frame = {};
  const dbg = { getThreadState: () => ({ getCallOnStack: () => frame }),
    getThreadStack: () => [{ elementKey: 'Module:Action' }],
    evaluateVariable: () => ({ type: 'Text', value: text }), stepInto() {} };
  const session = createNativeClientInspection({ globalObject, debuggerObject: dbg, platform, modules,
    variables: [variables[0]], redact: value => redactNativeClientValue(value, ['private-value']) });
  const request = value => globalObject[session.helperName](value);
  request({ op: 'pause', callContextId: 9 });
  const ref = request({ op: 'scope' }).result.variables[0].ref;
  let offset = 0, assembled = '';
  do { const page = request({ op: 'slice', ref, offset, limit: 3 }).result;
    assembled += page.value.value; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(assembled, text);
  text = 'changed';
  assert.equal(request({ op: 'slice', ref, offset: 0, limit: 20 }).result.value.value, text);
  text = 'private-value';
  const hidden = request({ op: 'slice', ref, offset: 0, limit: 20 });
  assert.equal(hidden.result.redacted, true);
  assert.doesNotMatch(JSON.stringify(hidden), /private-value/);
  request({ op: 'stepInto' });
  assert.equal(request({ op: 'slice', ref }).error, 'debug_native_client_stale_reference');
  session.dispose();
});
function harness(platform = 'o11') {
  const globalObject = { callContextId: 9 }, calls = [], values = { InputKey: 1, ListKey: Array.from({ length: 210 }, (_, i) => i) };
  const nativeFrames = [{}, {}];
  const debuggerObject = { getThreadState: ccid => ccid === 9 && {getCallOnStack: level => nativeFrames[level]},
    getThreadStack: () => [{ elementKey: 'Module:Action', moduleName: 'Module', elementName: 'Action' }, { elementKey: 'Module:Action', moduleName: 'Module', elementName: 'Action' }],
    evaluateVariable(ccid, level, action, key, path, detail) {
      calls.push({ ccid, level, action, key, path, detail });
      if (path) return { type: 'Integer', value: values[key][Number(path.match(/\[(\d+)\]/)[1])] };
      return key === 'ListKey' ? { type: 'RecordList', value: detail ? { Length: { type: 'Integer', value: 210 } } : null } : { type: 'Integer', value: values[key] };
    }, allowBreakpointsFromModule() {}, addBreakpoints() {}, pauseOnAllExceptions() {}, continue() {}, stepInto() {}, stepOver() {}, stepOut() {}, endSession() {} };
  const session = createNativeClientInspection({ debuggerObject, globalObject, platform, modules, variables });
  const request = input => globalObject[session.helperName](input);
  request({ op: 'pause' }); return { session, request, calls, values };
}
for (const platform of ['o11', 'odc']) test(platform + ': references use native frame and reevaluation, expand beyond initial cut, expire on frame/step', () => {
  const h = harness(platform), scope = h.request({ op: 'scope' }).result;
  assert.equal(scope.scopeComplete, false); assert.ok(scope.notApplicableToRuntime.includes('setting'));
  assert.equal(scope.unavailableCategories.includes('setting'), false);
  const input = scope.variables[0], list = scope.variables[1];
  assert.equal(h.request({ op: 'read', ref: input.ref }).result.value.value, 1);
  assert.equal(h.request({ op: 'refresh', ref: input.ref }).result.changed, false);
  h.values.InputKey = 7;
  assert.equal(h.request({ op: 'refresh', ref: input.ref }).result.changed, true);
  assert.equal(h.request({ op: 'expand', ref: list.ref, path: '[180]' }).result.value.value, 180);
  assert.deepEqual(h.calls.at(-1), { ccid: 9, level: 1, action: 'Action', key: 'ListKey', path: 'Rows[180]', detail: 1 });
  assert.equal(h.request({ op: 'expand', ref: list.ref, path: '[0];process.exit()' }).ok, false);
  h.request({ op: 'frame', frame: 0 });
  assert.equal(h.request({ op: 'read', ref: input.ref }).error, 'debug_native_client_stale_reference');
  const fresh = h.request({ op: 'scope' }).result.variables[0];
  h.request({ op: 'stepInto' });
  assert.equal(h.request({ op: 'read', ref: fresh.ref }).error, 'debug_native_client_stale_reference');
  h.values.InputKey=17;
  h.request({op:'pause'});
  const next=h.request({op:'scope'}).result.variables[0];
  const updated=h.request({op:'read',ref:next.ref}).result;
  assert.equal(updated.previousStop,1);
  assert.equal(updated.changedSincePreviousStop,true);
  h.session.dispose();
});
test('native wire redaction retains complete arrays, long strings and nested records', () => {
  const raw = { type: 'Record', value: { A: { type: 'Text', value: 'x'.repeat(9000) },
    List: Array.from({ length: 1500 }, (_, i) => i), credential: 'secret', B: { type: 'Text', value: 'user-private' } } };
  const clean = redactNativeClientValue(raw, ['user-private']);
  assert.equal(clean.value.A.value.length, 9000); assert.equal(clean.value.List.length, 1500);
  assert.equal(clean.value.credential, '[private]'); assert.equal(clean.value.B.value, '[private]');
});

for(const platform of ['o11','odc'])test(platform+': private read sends the unchanged native wire only to its private channel and clears it on frame/control',()=>{
 const globalObject={},nativeFrame={},calls=[],captured=[];let value='private-original';let cleared=0,closed=0;
 const dbg={getThreadState:()=>({getCallOnStack:()=>nativeFrame}),getThreadStack:()=>[{elementKey:'Module:Action'}],
  evaluateVariable(...args){calls.push(args);return{type:'Text',value};},stepInto(){}};
 const privateChannel={publish(envelope){captured.push(structuredClone(envelope));return{reference:'opaque-private-reference',roundTripVerified:true};},
  consume(){return structuredClone(captured.at(-1).value);},
  invalidate(){cleared++;return{completed:true,pending:0};},close(){closed++;return{completed:true,pending:0};}};
 const session=createNativeClientInspection({debuggerObject:dbg,globalObject,platform,modules,
  variables:[{moduleKey:'Module',actionKey:'Action',variableKey:'UserName',name:'Client.UserName',category:'client'}],privateChannel});
 const request=input=>globalObject[session.helperName](input);request({op:'pause',callContextId:9});
 const ref=request({op:'scope'}).result.variables[0].ref;
 const first=request({op:'private-read',ref,detail:2}).result;
 assert.equal(first.privateInspection.roundTripVerified,true);assert.equal(first.privateValueReturnedPublicly,false);
 assert.equal(captured[0].value.value,'private-original');assert.equal(captured[0].variable.sourceSha256,modules[0].sourceSha256);
 assert.equal(captured[0].context.stop,1);assert.equal(calls.length,1);
 assert.doesNotMatch(JSON.stringify(first),/private-original|Client.UserName/);
 assert.equal(request({op:'private-consume',descriptor:first.privateInspection}).error,'debug_native_client_private_consumer_unauthorized');
 const consumed=request({op:'private-consume',descriptor:first.privateInspection,consumerCapability:session.privateConsumerCapability});
 assert.equal(consumed.result.value.value,'private-original');assert.equal(calls.length,1);
 assert.equal(JSON.stringify(first).includes(session.privateConsumerCapability),false);
 value='private-changed';const repeated=request({op:'private-read',ref,detail:2}).result;assert.equal(repeated.changed,true);
 request({op:'stepInto'});assert.ok(cleared>=2);assert.equal(request({op:'private-read',ref}).ok,false);assert.equal(calls.length,2);
 request({op:'pause',callContextId:9});const fresh=request({op:'scope'}).result.variables[0].ref;
 const next=request({op:'private-read',ref:fresh}).result;assert.equal(next.previousStop,1);assert.equal(next.changedSincePreviousStop,false);
 session.dispose();assert.equal(closed,1);
});

for(const platform of ['o11','odc'])test(platform+': worker private channel fingerprints at private capture; handles survive steps until stop and the key is zeroed',()=>{
 let value='private-user-Ω';const keys=[],sealed=[];let cleared=0;
 const utilities={digest:v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),token:()=>randomBytes(24).toString('hex'),byteLength:v=>Buffer.byteLength(v),
  privateCompare:options=>createPrivateCompareSession(options,{random:n=>{const b=randomBytes(n);if(n===32)keys.push(b);return b;}})};
 const variablesUser=[{moduleKey:'Module',actionKey:'Action',variableKey:'UserName',name:'Client.UserName',category:'client'}];
 const make=()=>{const globalObject={},frame={};
  const dbg={getThreadState:()=>({getCallOnStack:()=>frame}),getThreadStack:()=>[{elementKey:'Module:Action'}],evaluateVariable:()=>({type:'Text',value}),stepInto(){},endSession(){}};
  const privateChannel={publish(e){sealed.push(e);return {reference:'opaque-'+sealed.length,roundTripVerified:true};},consume(){},
   invalidate(){cleared++;return{completed:true,pending:0};},close(){return{completed:true,pending:0};}};
  const session=createNativeClientInspectionCore({debuggerObject:dbg,globalObject,platform,modules,variables:variablesUser,privateChannel},utilities);
  return {session,request:input=>globalObject[session.helperName](input)};};
 const {session,request}=make();
 const read=()=>{const ref=request({op:'scope'}).result.variables[0].ref;return request({op:'private-read',ref}).result;};
 request({op:'pause',callContextId:9});const consumer=read();
 assert.match(consumer.privateCompareHandle,/^pc_[a-f0-9]{32}$/);assert.equal(consumer.privateInspection.reference,'opaque-1');
 assert.doesNotMatch(JSON.stringify(consumer),/private-user|[a-f0-9]{64}/);
 request({op:'stepInto'});assert.ok(cleared>=1);request({op:'pause',callContextId:9});
 const library=read();value='private-user-other';const changed=read();
 const compare=handles=>request({op:'private-compare',handles});
 const {equal,bothNonEmpty,sameNativeType,valueType,count}=compare([consumer.privateCompareHandle,library.privateCompareHandle]).result;
 assert.deepEqual({equal,bothNonEmpty,sameNativeType,valueType,count},{equal:true,bothNonEmpty:true,sameNativeType:true,valueType:'Text',count:2});
 assert.equal(compare([consumer.privateCompareHandle,changed.privateCompareHandle]).result.equal,false);
 assert.equal(request({op:'private-compare',handles:[consumer.privateCompareHandle],anchor:'app-user'}).error,'debug_native_client_private_compare_anchor_unavailable');
 assert.equal(request({op:'private-compare',handles:[consumer.privateCompareHandle,library.privateCompareHandle],values:['private-user-Ω']}).error,'debug_native_client_private_compare_caller_value_refused');
 assert.equal(request({op:'private-compare',handles:[consumer.privateCompareHandle,library.privateCompareHandle],mode:'identity'}).result.equal,true);
 assert.doesNotMatch(JSON.stringify(compare([consumer.privateCompareHandle,library.privateCompareHandle])),/private-user|[a-f0-9]{64}/);
 assert.ok(keys[0].some(b=>b!==0));
 request({op:'stop'});assert.ok(keys[0].every(b=>b===0),'stop destroys the fingerprints and key');
 assert.equal(compare([consumer.privateCompareHandle,library.privateCompareHandle]).error,'debug_native_client_stale_reference');
 request({op:'pause',callContextId:9});assert.equal(compare([consumer.privateCompareHandle,library.privateCompareHandle]).error,'debug_native_client_private_compare_closed');
 session.dispose();
 const second=make();second.request({op:'pause',callContextId:9});
 const ref=second.request({op:'scope'}).result.variables[0].ref,foreign=second.request({op:'private-read',ref}).result.privateCompareHandle;
 assert.equal(second.request({op:'private-compare',handles:[foreign,consumer.privateCompareHandle]}).error,'debug_native_client_private_compare_handle_unavailable');
 second.session.dispose();assert.ok(keys[1].every(b=>b===0),'dispose zeroes the key');
 const plain={};const none=createNativeClientInspectionCore({debuggerObject:{getThreadState:()=>({}),getThreadStack:()=>[{elementKey:'Module:Action'}],evaluateVariable:()=>({type:'Text',value})},
  globalObject:plain,platform,modules,variables:variablesUser},utilities);
 plain[none.helperName]({op:'pause',callContextId:1});
 assert.equal(plain[none.helperName]({op:'private-compare',handles:[foreign,foreign]}).error,'debug_native_client_private_compare_unavailable');none.dispose();
});

test('node adapter supplies the private compare session to the worker private channel',()=>{
 const globalObject={},dbg={getThreadState:()=>({}),getThreadStack:()=>[{elementKey:'Module:Action'}],evaluateVariable:()=>({type:'Text',value:'private-user-Ω'})};
 const privateChannel={publish:()=>({reference:'opaque'}),consume(){},invalidate:()=>({completed:true,pending:0}),close:()=>({completed:true,pending:0})};
 const session=createNativeClientInspection({debuggerObject:dbg,globalObject,platform:'o11',modules,variables:[variables[0]],privateChannel});
 const request=input=>globalObject[session.helperName](input);request({op:'pause',callContextId:1});
 const ref=request({op:'scope'}).result.variables[0].ref,a=request({op:'private-read',ref}).result,b=request({op:'private-read',ref}).result;
 assert.equal(request({op:'private-compare',handles:[a.privateCompareHandle,b.privateCompareHandle]}).result.equal,true);session.dispose();
});

for(const variant of ['worker','host-injected','host-owned'])test(`actual external V8 pause (${variant}): private-compare spans native steps and stop destroys it`,{timeout:20000},async()=>{
 const host=variant!=='worker',moduleUrl=new URL('../debug-native-client-inspection.mjs',import.meta.url).href;
 const source=`import vm from 'node:vm'; import readline from 'node:readline';
  import {createNativeClientInspection,openNativeClientInspector} from ${JSON.stringify(moduleUrl)};
  const sandbox={};sandbox.window=sandbox;const ctx=vm.createContext(sandbox);
  vm.runInContext(\`globalThis.dbg={ value:'private-user-Ω', getThreadState(){return {}}, getThreadStack(){return [{elementKey:'Module:Action'}]},
    evaluateVariable(){return {type:'Text',value:this.value}},
    callDebugger(){globalThis.callContextId=1;debugger;},continue(){},stepInto(){},stepOver(){},stepOut(){},endSession(){},
    allowBreakpointsFromModule(){},addBreakpoints(){},pauseOnAllExceptions(){}}
    globalThis.run=()=>{dbg.callDebugger();dbg.callDebugger();dbg.value='private-user-other';dbg.callDebugger();};\`,ctx);
  const sealed=new Map();let n=0;
  const privateChannel={publish(e){const reference=String(++n);sealed.set(reference,e.value);return {reference};},consume(d){return sealed.get(d.reference);},invalidate(){sealed.clear();return{completed:true,pending:0};},close(){sealed.clear();return{completed:true,pending:0};}};
  const s=createNativeClientInspection({debuggerObject:sandbox.dbg,globalObject:sandbox,platform:'odc',modules:${JSON.stringify(modules)},variables:${JSON.stringify(variables.slice(0,1))},privateCapture:${host},privateChannel:${host?'undefined':'privateChannel'}});
  const i=openNativeClientInspector();console.log(JSON.stringify({url:i.url,helperName:s.helperName,privateConsumerCapability:s.privateConsumerCapability}));
  readline.createInterface({input:process.stdin}).on('line',line=>{if(line==='run'){vm.runInContext('run()',ctx);console.log('done');}else{s.dispose();i.close();process.exit();}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['pipe','pipe','ignore']});
 const lines=readline.createInterface({input:child.stdout});let driver;
 const keys=[],session=variant==='host-injected' ? createPrivateCompareSession({sessionId:'12345678-1234-4234-8234-123456789abc',lane:'odc',runtime:'client',
  anchorProvider:({seal})=>seal({type:'Text',value:'private-user-Ω'})},{random:n=>{const b=randomBytes(n);if(n===32)keys.push(b);return b;}}) : undefined;
 try{
  const [line]=await once(lines,'line'),capability=JSON.parse(line),events=[],waiters=[];
  const sealed=new Map();let nextRef=0;
  const hostChannel={publish(e){const reference=String(++nextRef);sealed.set(reference,structuredClone(e));return {reference};},consume(){},invalidate(){sealed.clear();return {completed:true,pending:0};},close(){return this.invalidate();}};
  driver=await connectNativeClientInspector({...capability,...(host?{privateChannel:hostChannel}:{}),...(session?{privateCompare:session}:{}),leaseMs:8000,terminate:()=>child.kill(),
   onEvent:e=>{events.push(e);for(const fn of waiters.splice(0))fn();}});
  const waitPause=async count=>{while(events.filter(e=>e.kind==='paused').length<count)await new Promise(resolve=>waiters.push(resolve));};
  const read=async()=>{const scope=await driver.command({op:'scope'});return driver.command({op:'private-read',ref:scope.variables[0].ref});};
  child.stdin.write('run\n');await waitPause(1);
  const first=await read();assert.match(first.privateCompareHandle,/^pc_[a-f0-9]{32}$/);assert.equal(first.privateEnvelope,undefined);
  assert.doesNotMatch(JSON.stringify(first),/private-user|[a-f0-9]{64}/);
  await driver.command({op:'stepInto'});await waitPause(2);if(host)assert.equal(sealed.size,0);
  const second=await read();
  const compared=await driver.command({op:'private-compare',handles:[first.privateCompareHandle,second.privateCompareHandle]});
  assert.equal(compared.equal,true);assert.equal(compared.bothNonEmpty,true);assert.equal(compared.sameNativeType,true);assert.equal(compared.count,2);
  assert.doesNotMatch(JSON.stringify(compared),/private-user|[a-f0-9]{64}/);
  await assert.rejects(driver.command({op:'private-compare',handles:[first.privateCompareHandle,second.privateCompareHandle],value:'private-user-Ω'}),/private_compare_caller_value_refused/);
  await driver.command({op:'stepInto'});await waitPause(3);
  const third=await read();
  assert.equal((await driver.command({op:'private-compare',handles:[first.privateCompareHandle,third.privateCompareHandle]})).equal,false);
  assert.equal((await driver.command({op:'private-compare',handles:[first.privateCompareHandle,second.privateCompareHandle],mode:'identity'})).equal,true,'handles survive two native steps');
  if(variant==='host-injected'){
   assert.equal((await driver.command({op:'private-compare',handles:[first.privateCompareHandle],anchor:'app-user'})).equal,true);
   assert.equal((await driver.command({op:'private-compare',handles:[third.privateCompareHandle],anchor:'app-user'})).equal,false);
  }
  const exited=once(child,'exit');await driver.command({op:'stop'});await exited;
  await assert.rejects(driver.command({op:'private-compare',handles:[first.privateCompareHandle,second.privateCompareHandle]}));
  if(session){
   assert.throws(()=>session.compare([first.privateCompareHandle,second.privateCompareHandle]),/debug_private_compare_handle_unavailable/);
   assert.ok(keys[0].some(b=>b!==0),'the injected public session belongs to its owner');session.close();assert.ok(keys[0].every(b=>b===0));
  }
 }finally{await driver?.close();session?.close();child.kill();lines.close();}
});

for (const platform of ['o11', 'odc']) test(platform + ': withheld scalar values stay incomplete while native changes remain observable', () => {
  let nativeValue = 'private-first';
  const globalObject = {}, dbg = { getThreadState: () => ({}),
    getThreadStack: () => [{ elementKey: 'Module:Action' }],
    evaluateVariable(_ccid, _frame, _action, key) {
      return { type: 'Text', value: key === 'Literal' ? '[private]' : nativeValue };
    } };
  const session = createNativeClientInspection({ debuggerObject: dbg, globalObject, platform, modules,
    variables: ['Copied', 'UserName', 'Literal'].map(name => ({ moduleKey: 'Module', actionKey: 'Action',
      variableKey: name, name, category: 'local' })),
    redact: value => redactNativeClientValue(value, ['private-first', 'private-second']) });
  const request = input => globalObject[session.helperName](input);
  request({ op: 'pause', callContextId: 1 });
  const scope = request({ op: 'scope' }).result;
  for (const row of scope.variables.slice(0, 2)) {
    const value = request({ op: 'read', ref: row.ref }).result;
    assert.equal(value.value.value, '[private]'); assert.equal(value.redacted, true); assert.equal(value.valueComplete, false);
  }
  const literal = request({ op: 'read', ref: scope.variables[2].ref }).result;
  assert.equal(literal.value.value, '[private]'); assert.equal(literal.redacted, false); assert.equal(literal.valueComplete, true);
  nativeValue = 'private-second';
  const refreshed = request({ op: 'refresh', ref: scope.variables[0].ref }).result;
  assert.equal(refreshed.changed, true); assert.equal(refreshed.value.value, '[private]'); assert.equal(refreshed.valueComplete, false);
  assert.doesNotMatch(JSON.stringify(refreshed), /private-first|private-second/);
  session.dispose();
});

for (const platform of ['o11', 'odc']) test(platform + ': redacted native return and text projection never claim full observation', () => {
  let nativeValue = 'private-first';
  const globalObject = {}, dbg = { getThreadState: () => ({}), BreakpointType: { AtFunctionReturn: 2 },
    getThreadStack: () => [{ elementKey: 'Module:Action', breakpointType: 2 }],
    evaluateVariable() { return { type: 'Text', value: nativeValue }; } };
  const session = createNativeClientInspection({ debuggerObject: dbg, globalObject, platform, modules,
    variables: [{ moduleKey: 'Module', actionKey: 'Action', variableKey: '', name: '$return', category: 'return' }],
    redact: value => redactNativeClientValue(value, ['private-first', 'private-second']) });
  const request = input => globalObject[session.helperName](input);
  request({ op: 'pause', callContextId: 1 });
  const ref = request({ op: 'scope' }).result.variables[0].ref;
  const first = request({ op: 'read', ref }).result;
  assert.equal(first.redacted, true); assert.equal(first.valueComplete, false);
  nativeValue = 'private-second';
  const refreshed = request({ op: 'refresh', ref }).result;
  assert.equal(refreshed.changed, true); assert.equal(refreshed.redacted, true); assert.equal(refreshed.valueComplete, false);
  const slice = request({ op: 'slice', ref, offset: 0, limit: 100 }).result;
  assert.equal(slice.value.value, '[private]'); assert.equal(slice.redacted, true); assert.equal(slice.valueComplete, false);
  assert.doesNotMatch(JSON.stringify([first, refreshed, slice]), /private-first|private-second/);
  session.dispose();
});

for (const platform of ['o11', 'odc']) test(platform + ': native widget validation fields remain readable without exposing credential values', () => {
  let valid = false;
  const globalObject = {}, values = [{ moduleKey: 'Module', actionKey: 'Action', variableKey: 'Widget',
    name: 'Input_PasswordVal', nativePath: 'Input_PasswordVal', category: 'local', modelKind: 'ServiceStudio.Plugin.NRWidgets.Input' },
  { moduleKey: 'Module', actionKey: 'Action', variableKey: 'Credential', name: 'Password', category: 'local' }];
  const fields = () => ({ Id: { type: 'Text', value: 'input1' }, Valid: { type: 'Boolean', value: valid },
    ValidationMessage: { type: 'Text', value: 'Required' } });
  const dbg = { getThreadState: () => ({}), getThreadStack: () => [{ elementKey: 'Module:Action' }],
    evaluateVariable(_ccid, _frame, _action, key, path) {
      if (key === 'Credential') return { type: 'Text', value: 'private-password' };
      if (!path || path === 'Input_PasswordVal') return { type: 'Record', value: fields() };
      return fields()[path.slice('Input_PasswordVal.'.length)] ?? { type: 'Text', value: 'private-password' };
    } };
  const session = createNativeClientInspection({ debuggerObject: dbg, globalObject, platform, modules,
    variables: values, redact: value => redactNativeClientValue(value, ['private-password']) });
  const request = input => globalObject[session.helperName](input);
  request({ op: 'pause', callContextId: 1 });
  const scope = request({ op: 'scope' }).result, ref = scope.variables[0].ref;
  assert.deepEqual(request({ op: 'read', ref }).result.value.value, fields());
  const child = request({ op: 'expand', ref, path: '.Valid' }).result;
  assert.equal(child.value.value, false);
  valid = true;
  const changed = request({ op: 'refresh', ref: child.ref }).result;
  assert.equal(changed.value.value, true); assert.equal(changed.changed, true);
  assert.equal(request({ op: 'read', ref: scope.variables[1].ref }).result.value.value, '[private]');
  assert.equal(request({ op: 'expand', ref, path: '.Password' }).result.value.value, '[private]');
  session.dispose();
});
for (const platform of ['o11', 'odc']) test(platform + ': an unavailable native watch does not discard other batch values', () => {
  const globalObject = {}; let count = 17, missing = true, calls = 0;
  const dbg = { getThreadState: () => ({ getCallOnStack: () => ({}) }), getThreadStack: () => [{ elementKey: 'Module:Action' }],
    evaluateVariable(_cc, _frame, _action, key) { calls++;
      if (key === 'ListKey' && missing) return undefined;
      return { type: 'Integer', value: count };
    } };
  const session = createNativeClientInspection({ globalObject, debuggerObject: dbg, platform, modules, variables });
  const request = input => globalObject[session.helperName](input);
  request({ op: 'pause', callContextId: 1 });
  const refs = request({ op: 'scope' }).result.variables.map(v => v.ref);
  assert.equal(request({ op: 'read-many', refs, detail: 99 }).error, 'debug_native_client_detail_invalid');
  assert.equal(calls, 0);
  const partial = request({ op: 'read-many', refs }).result;
  assert.equal(partial.values[0].value.value, 17); assert.equal(partial.evaluationFailures, 1);
  assert.equal(partial.values[1].error, 'debug_native_client_evaluation_unavailable');
  assert.equal(partial.values[1].valueComplete, false); assert.equal(partial.values[1].value, undefined);
  count = 29; missing = false;
  const recovered = request({ op: 'read-many', refs }).result;
  assert.equal(recovered.evaluationFailures, 0); assert.equal(recovered.values[0].changed, true);
  assert.equal(recovered.values[1].value.value, 29);
  session.dispose();
});

test('native client batch validates all references before evaluation and refreshes live values', () => {
  const h = harness(), scope = h.request({ op: 'scope' }).result;
  const refs = scope.variables.map(v => v.ref);
  assert.equal(h.request({ op: 'read-many', refs: [refs[0], 'f'.repeat(48)] }).error, 'debug_native_client_stale_reference');
  assert.equal(h.calls.length, 0);
  assert.equal(h.request({ op: 'read-many', refs: [refs[0], refs[0]] }).error, 'debug_native_client_references_invalid');
  const first = h.request({ op: 'read-many', refs }).result;
  assert.equal(first.values.length, 2); assert.equal(h.calls.length, 2);
  h.values.InputKey = 9;
  const refreshed = h.request({ op: 'read-many', refs }).result;
  assert.equal(refreshed.values[0].value.value, 9); assert.equal(refreshed.values[0].changed, true);
  h.session.dispose();
});
test('native model scopes do not leak variables from a different breakpoint', () => {
  const globalObject={}, calls=[]; let node='First';
  const dbg={getThreadState:()=>({}),getThreadStack:()=>[{elementKey:'Module:Action',currentBreakpoint:'unused',breakpoint:'unused'}],
    evaluateVariable(...args){calls.push(args);return {type:'Text',value:'live'};}};
  dbg.getThreadStack=()=>[{elementKey:'Module:Action',currentBreakpoint:'Module:'+node}];
  const session=createNativeClientInspection({debuggerObject:dbg,globalObject,platform:'odc',modules,variables:[
    {moduleKey:'Module',actionKey:'Action',nodeKey:'First',variableKey:'A',name:'Client.Value',nativePath:'Value',category:'client'},
    {moduleKey:'Module',actionKey:'Action',nodeKey:'Second',variableKey:'B',name:'Other',category:'local'}]});
  const request=input=>globalObject[session.helperName](input);
  request({op:'pause',callContextId:1});
  let scope=request({op:'scope'}).result;assert.equal(scope.variables.length,1);assert.equal(scope.variables[0].name,'Client.Value');
  request({op:'read',ref:scope.variables[0].ref});assert.equal(calls[0][4],'Value');
  node='Second';request({op:'pause',callContextId:1});scope=request({op:'scope'}).result;
  assert.equal(scope.variables.length,1);assert.equal(scope.variables[0].name,'Other');session.dispose();
});

test('private lazy scope binding requires exact paused frame and original source hash',()=>{
 const globalObject={},dbg={getThreadState:()=>({}),getThreadStack:()=>[{elementKey:'Module:Action',currentBreakpoint:'Module:Next'}],
  evaluateVariable:()=>({type:'Integer',value:42})};
 const session=createNativeClientInspection({debuggerObject:dbg,globalObject,platform:'odc',modules,variables:[]});
 const request=input=>globalObject[session.helperName](input),pause=request({op:'pause',callContextId:1}).result;
 const input={op:'bind-scope',stop:pause.stop,generation:pause.generation,moduleKey:'Module',functionKey:'Action',nodeKey:'Next',sourceSha256:modules[0].sourceSha256,
  variables:[{moduleKey:'Module',actionKey:'Action',nodeKey:'Next',variableKey:'Value',name:'Value',category:'local'}]};
 for(const bad of [{sourceSha256:'b'.repeat(64)},{stop:999},{nodeKey:'Other'},{functionKey:'Other'},
  {variables:[{...input.variables[0],nodeKey:'Other'}]}])assert.equal(request({...input,...bad}).error,'debug_native_client_metadata_invalid');
 assert.equal(request(input).result.metadataBound,true);
 assert.equal(request(input).error,'debug_native_client_metadata_already_bound');
 const scope=request({op:'scope'}).result;assert.equal(scope.variables.length,1);
 assert.equal(request({op:'read',ref:scope.variables[0].ref}).result.value.value,42);session.dispose();
});

test('previous native breakpoint separates scope bindings, refuses mismatches and exposes only native return stops',()=>{
 const globalObject={},frame={elementKey:'Module:Action',currentBreakpoint:'Module:Next',previousBreakpoint:'Module:Before',breakpointType:0};
 const calls=[],dbg={BreakpointType:{AtFunctionReturn:1},getThreadState:()=>({}),getThreadStack:()=>[frame],
  evaluateVariable(...args){calls.push(args);return{type:'Integer',value:42}}};
 const s=createNativeClientInspection({debuggerObject:dbg,globalObject,platform:'odc',modules,variables:[]});
 const request=input=>globalObject[s.helperName](input),pause=request({op:'pause',callContextId:1}).result;
 assert.equal(pause.frames[0].previousBreakpoint,'Module:Before');assert.equal(pause.frames[0].nativeReturnAvailable,false);
 const bind={op:'bind-scope',stop:pause.stop,generation:pause.generation,moduleKey:'Module',functionKey:'Action',nodeKey:'Next',previousNodeKey:'Before',sourceSha256:modules[0].sourceSha256,
  variables:[{moduleKey:'Module',actionKey:'Action',nodeKey:'Next',previousNodeKey:'Before',variableKey:'V',name:'AfterCall',category:'local'}]};
 assert.equal(request({...bind,previousNodeKey:'Other'}).error,'debug_native_client_metadata_invalid');
 assert.equal(request({...bind,variables:[{...bind.variables[0],previousNodeKey:null}]}).error,'debug_native_client_metadata_invalid');
 assert.equal(request(bind).result.metadataBound,true);assert.equal(request({op:'scope'}).result.variables.length,1);
 request({op:'stepInto'});frame.previousBreakpoint='Module:Different';request({op:'pause',callContextId:1});
 assert.equal(request({op:'scope'}).result.variables.length,0,'old predecessor cannot authorize this scope');
 frame.breakpointType=1;const scope=request({op:'scope'}).result;
 assert.equal(scope.variables.length,1);assert.equal(scope.variables[0].category,'return');
 assert.deepEqual(request({op:'read',ref:scope.variables[0].ref}).result.value,{type:'Integer',value:42});
 assert.deepEqual(calls.at(-1),[1,0,'Action','','$return',1]);
 assert.equal(request({op:'expand',ref:scope.variables[0].ref,path:'.A'}).error,'debug_native_client_evaluation_failed');
 frame.previousBreakpoint='Foreign:Before';assert.equal(request({op:'scope'}).error,'debug_native_client_previous_scope_unavailable');s.dispose();
});
test('oversized native return offers bounded tree and text continuations over native wire values', () => {
 const globalObject={},dbg={BreakpointType:{AtFunctionReturn:1},getThreadState:()=>({}),stepInto(){},
  getThreadStack:()=>[{elementKey:'Module:Action',currentBreakpoint:'Module:Next',breakpointType:1}],
  evaluateVariable:()=>({type:'Record',value:{Text:{type:'Text',value:'x'.repeat(2*1024*1024)}}})};
 const s=createNativeClientInspection({debuggerObject:dbg,globalObject,platform:'odc',modules});
 const request=input=>globalObject[s.helperName](input);
 request({op:'pause',callContextId:1});const ref=request({op:'scope'}).result.variables[0].ref;
 const result=request({op:'read',ref}).result;
 assert.equal(result.omitted,true);assert.equal(result.reason,'transport_budget');
 assert.equal(result.expandable,true);assert.deepEqual(result.continuation,{op:'children',ref,offset:0});
 const children=request({op:'children',ref}).result;
 assert.equal(children.total,1);assert.equal(children.children[0].name,'Text');
 const child=children.children[0].ref;
 assert.equal(request({op:'read',ref:child}).result.continuation.op,'slice');
 let text='',offset=0;
 do { const page=request({op:'slice',ref:child,offset,limit:65536}).result;text+=page.value.value;offset=page.nextOffset; } while(offset!==null);
 assert.equal(text,'x'.repeat(2*1024*1024));
 request({op:'stepInto'});assert.equal(request({op:'slice',ref:child}).error,'debug_native_client_stale_reference');s.dispose();
});

for (const platform of ['o11','odc']) test(`${platform}: native return tree pages all list rows and refreshes child values without evaluating child paths`,()=>{
 const record=n=>({type:'Record',value:{Label:{type:'Text',value:'Row '+n},Password:{type:'Text',value:'DO_NOT_EXPOSE'}}});
 const wire={type:'RecordList',value:{Length:{type:'Integer',value:301},...Object.fromEntries(Array.from({length:301},(_,i)=>['['+i+']',record(i)]))}};
 const globalObject={},calls=[],dbg={BreakpointType:{AtFunctionReturn:1},getThreadState:()=>({}),
  getThreadStack:()=>[{elementKey:'Module:Action',currentBreakpoint:'Module:Next',breakpointType:1}],
  evaluateVariable(...args){calls.push(args);return wire;}};
 const s=createNativeClientInspection({debuggerObject:dbg,globalObject,platform,modules});
 const request=input=>globalObject[s.helperName](input);
 request({op:'pause',callContextId:1});const ref=request({op:'scope'}).result.variables[0].ref;
 let offset=0,all=[];
 do {const page=request({op:'children',ref,offset,limit:150}).result;all.push(...page.children);offset=page.nextOffset;} while(offset!==null);
 assert.equal(all.length,302);assert.equal(new Set(all.map(v=>v.name)).size,302);
 const last=request({op:'expand',ref,path:'[300].Label'}).result;
 assert.equal(last.value.value,'Row 300');assert.equal(last.nativeValueProjection,true);
 wire.value['[300]'].value.Label.value='changed';
 const refreshed=request({op:'refresh',ref:last.ref}).result;
 assert.equal(refreshed.value.value,'changed');assert.equal(refreshed.changed,true);
 assert.equal(request({op:'expand',ref,path:'[0].Password'}).ok,false);
 assert.equal(request({op:'expand',ref,path:'.constructor'}).ok,false);
 assert.equal(request({op:'children',ref,offset:303}).error,'debug_native_client_page_invalid');
 assert.equal(request({op:'expand',ref,path:'[301]'}).ok,false);
 assert.ok(calls.every(c=>c[3]===''&&c[4]==='$return'));
 assert.ok(!JSON.stringify(request({op:'read',ref}).result).includes('DO_NOT_EXPOSE'));
 s.dispose();
});

// The real-vault cases (ODC, host channel, finished paused, Windows) call powershell.exe once per vault call: Seal+Open per
// private read, Open per consume, Forget per invalidate/close (7 calls today; the 8th covers the non-vault work). Their
// lease, channel expiry and test timeout cover REAL_VAULT_CALLS calls at the vault's own per-call bound, so load can fail
// a call (vault_unavailable) but never expire the lease mid-test (1.4-3.5 s per call under load); the calls are counted.
const REAL_VAULT_CALLS = 8, REAL_VAULT_WINDOW_MS = REAL_VAULT_CALLS * PRIVATE_VAULT_CALL_TIMEOUT_MS;
for (const platform of ['o11', 'odc']) for (const finishPaused of [false, true, 'stop']) for (const hostPrivate of [false,true]) {
const realVault=hostPrivate && platform==='odc' && Boolean(finishPaused) && process.platform==='win32';
test(`${platform}: actual external V8 pause (${hostPrivate ? 'host private channel' : 'worker private channel'}) supports inspection and ${finishPaused === 'stop' ? 'stop command without resuming' : finishPaused ? 'private cleanup without resuming' : 'native stepping'}`, { timeout: realVault ? REAL_VAULT_WINDOW_MS + 20000 : 20000 }, async () => {
  const moduleUrl = new URL('../debug-native-client-inspection.mjs', import.meta.url).href;
  const source = `import vm from 'node:vm'; import readline from 'node:readline';
    import {createNativeClientInspection,openNativeClientInspector} from ${JSON.stringify(moduleUrl)};
    const sandbox={};sandbox.window=sandbox;const ctx=vm.createContext(sandbox);
    vm.runInContext(\`globalThis.dbg={ value:1, getThreadState(){return {}}, getThreadStack(){return [{elementKey:'Module:Action'}]},
      evaluateVariable(){return {type:'Integer',value:this.value}},
      callDebugger(){globalThis.callContextId=1;debugger;},continue(){},stepInto(){},stepOver(){},stepOut(){},endSession(){},
      allowBreakpointsFromModule(){},addBreakpoints(){},pauseOnAllExceptions(){}}
      globalThis.run=()=>{dbg.callDebugger();dbg.value=2;dbg.callDebugger();};\`,ctx);
    const sealed=new Map();let n=0;
    const privateChannel={publish(e){const reference=String(++n);sealed.set(reference,e.value);return {reference};},consume(d){if(!sealed.has(d.reference))throw new Error();return sealed.get(d.reference);},invalidate(){sealed.clear();return{completed:true,pending:0};},close(){sealed.clear();return{completed:true,pending:0};}};
    const s=createNativeClientInspection({debuggerObject:sandbox.dbg,globalObject:sandbox,platform:${JSON.stringify(platform)},modules:${JSON.stringify(modules)},variables:${JSON.stringify(variables.slice(0, 1))},privateCapture:${hostPrivate},privateChannel:${hostPrivate ? 'undefined' : 'privateChannel'}});
    const i=openNativeClientInspector();console.log(JSON.stringify({url:i.url,helperName:s.helperName,privateConsumerCapability:s.privateConsumerCapability}));
    readline.createInterface({input:process.stdin}).on('line',line=>{if(line==='run'){vm.runInContext('run()',ctx);console.log('done');}else{ s.dispose();i.close();process.exit();}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = readline.createInterface({ input: child.stdout });
  let driver;
  try {
    const [line] = await once(lines, 'line'), capability = JSON.parse(line);
    const events = [], waiters = [];
    const sealed=new Map();let nextRef=0;
    const hostChannel={publish(e){const reference=String(++nextRef);sealed.set(reference,structuredClone(e));return {reference};},consume(d,c){const e=sealed.get(d.reference);if(!e||['sessionId','stop','generation','frame'].some(k=>e.context[k]!==c[k]))throw new Error('stale');return e.value;},invalidate(){sealed.clear();return {completed:true,pending:0};},close(){return this.invalidate();}};
    let vaultCalls=0;const countedVault=(...call)=>{vaultCalls++;return privateInspectionVault(...call);};
    const channel=realVault ? createPrivateInspectionChannel({binding:{lane:'odc',runtimeUrl:'https://fixture.outsystems.app/Fixture/',app:'Fixture',sessionId:'a'.repeat(32),module:'Fixture',moduleKey:'A'.repeat(22)},sources:modules,expiresAt:new Date(Date.now()+REAL_VAULT_WINDOW_MS).toISOString()},{vault:countedVault}) : hostChannel;
    driver = await connectNativeClientInspector({ ...capability, privateChannel:hostPrivate?channel:undefined, leaseMs: realVault?REAL_VAULT_WINDOW_MS:5000, terminate: () => child.kill(),
      onEvent: e => { events.push(e); for (const fn of waiters.splice(0)) fn(); } });
    const waitPause = async count => { while (events.filter(e => e.kind === 'paused').length < count) await new Promise(resolve => waiters.push(resolve)); };
    child.stdin.write('run\n'); await waitPause(1);
    const scope = await driver.command({ op: 'scope' }), ref = scope.variables[0].ref;
    assert.equal((await driver.command({ op: 'read', ref })).value.value, 1);
    const privateRead=await driver.command({op:'private-read',ref});let consumed;
    if(realVault){assert.equal(privateRead.privateInspection.storage,'windows-current-user-dpapi');assert.equal(privateRead.privateInspection.roundTripVerified,true);}
    const acknowledgement=await driver.consumePrivate(privateRead.privateInspection,async value=>{consumed=value;return 'ignored-private-result';});
    assert.deepEqual(consumed,{type:'Integer',value:1});
    assert.equal(privateRead.privateEnvelope,undefined);
    await assert.rejects(driver.command({op:'private-capture',ref}),/private_consumer_unauthorized/);
    if(hostPrivate){await driver.command({op:'frame',frame:0});assert.equal(sealed.size,0);await assert.rejects(driver.consumePrivate(privateRead.privateInspection,()=>{}),/private_consumer_failed/);}assert.equal(acknowledgement.consumed,true);
    assert.equal(acknowledgement.value,undefined);assert.equal(JSON.stringify(acknowledgement).includes('ignored-private-result'),false);
    await driver.command({ op: 'stepInto' }); await waitPause(2);
    if(hostPrivate)assert.equal(sealed.size,0);
    assert.equal(events.filter(e => e.kind === 'paused')[0].expiresAt, events.filter(e => e.kind === 'paused')[1].expiresAt, 'stepping must not renew the credential lease');
    await assert.rejects(driver.command({ op: 'read', ref }), /stale_reference/);
    const second = await driver.command({ op: 'scope' });
    assert.equal((await driver.command({ op: 'read', ref: second.variables[0].ref })).value.value, 2);
    if (finishPaused) {
      await driver.command({ op: 'private-read', ref: second.variables[0].ref });
      const output = []; lines.on('line', line => output.push(line));
      const exited = once(child, 'exit');
      const cleanup = finishPaused === 'stop' ? await driver.command({op:'stop'}) : await driver.close();
      if (finishPaused === 'stop') assert.equal(cleanup.executionOutcome, 'requires-reconciliation');
      assert.deepEqual(cleanup.privateInspectionCleanup, { completed: true, pending: 0 });
      await exited;
      assert.equal(output.includes('done'), false, 'cleanup must not resume the interrupted action');
      await assert.rejects(driver.command({ op: 'read', ref: second.variables[0].ref }), /stale_reference/);
      if (realVault) assert.ok(vaultCalls > 0 && vaultCalls <= REAL_VAULT_CALLS, `${vaultCalls} real vault calls exceed the lease budget of ${REAL_VAULT_CALLS}`);
      return;
    }
    const done = once(lines, 'line'); await driver.command({ op: 'continue' });
    assert.equal((await done)[0], 'done');
    await driver.close(); child.stdin.write('dispose\n');
    assert.equal((await once(child, 'exit'))[0], 0);
  } finally { await driver?.close(); child.kill(); lines.close(); }
});
}

for (const platform of ['o11', 'odc']) test(platform + ': exception stop reports reason exception with a redacted native type; breakpoint stops are unaffected', () => {
  const globalObject = {}, errors = new Map(); let onException = false;
  class UserException extends Error { constructor(m) { super(m); this.name = 'UserException'; } }
  class ServerException extends Error { constructor(m) { super(m); this.name = 'ServerException'; } }
  const dbg = { getThreadState: () => ({}), getThreadStack: () => [{ elementKey: 'Module:Action', currentBreakpoint: 'Module:Node' }],
    evaluateVariable: () => ({ type: 'Integer', value: 1 }), isPausedOnException: () => onException, exceptionsMap: errors, stepInto() {} };
  const s = createNativeClientInspection({ globalObject, debuggerObject: dbg, platform, modules, variables: [variables[0]] });
  const request = input => globalObject[s.helperName](input), seen = [];
  const pause = () => { const r = request({ op: 'pause', callContextId: 9 }).result; seen.push(r); return r; };
  let stop = pause(); assert.equal(stop.reason, undefined); assert.equal(stop.exception, undefined);
  errors.set(9, new UserException('private-message-sentinel')); onException = true;
  request({ op: 'stepInto' }); stop = pause();
  assert.equal(stop.reason, 'exception'); assert.deepEqual(stop.exception, { type: 'UserException', typeRedacted: false });
  assert.equal(request({ op: 'status' }).result.reason, 'exception');
  const ref = request({ op: 'scope' }).result.variables[0].ref; assert.equal(request({ op: 'read', ref }).result.value.value, 1);
  // A specificType replacing .name is model text, not copied: only the native family survives.
  const typed = new ServerException('private-message-sentinel'); typed.name = 'PrivateSpecificType'; errors.set(9, typed);
  request({ op: 'stepInto' }); stop = pause();
  assert.deepEqual(stop.exception, { type: 'unknown', family: 'ServerException', typeRedacted: true });
  errors.set(9, 'private-message-sentinel'); request({ op: 'stepInto' }); stop = pause();
  assert.deepEqual(stop.exception, { type: 'unknown', typeRedacted: true });
  errors.delete(9); request({ op: 'stepInto' }); stop = pause();
  assert.equal(stop.reason, 'exception'); assert.deepEqual(stop.exception, { type: 'unknown', typeRedacted: true });
  onException = false; errors.set(9, new UserException('private-message-sentinel'));
  request({ op: 'stepInto' }); stop = pause();
  assert.equal(stop.reason, undefined); assert.equal(stop.exception, undefined);
  assert.equal(request({ op: 'status' }).result.reason, undefined);
  assert.doesNotMatch(JSON.stringify(seen), /private-message-sentinel|PrivateSpecificType/);
  s.dispose();
});

test('client inspection enable options forward only a boolean pauseOnExceptions to the original native switch', () => {
  assert.deepEqual(clientInspectionEnableOptions({ modules, variables, leaseMs: 5000, breakpoints: ['Module:Node'], pauseOnExceptions: true }),
    { breakpoints: ['Module:Node'], pauseOnExceptions: true });
  assert.deepEqual(clientInspectionEnableOptions({}), { breakpoints: [], pauseOnExceptions: false });
  for (const bad of ['true', 1, null]) assert.throws(() => clientInspectionEnableOptions({ pauseOnExceptions: bad }), /debug_native_client_pause_on_exceptions_invalid/);
  const calls = [], globalObject = {};
  const dbg = { getThreadState: () => ({}), getThreadStack: () => [], evaluateVariable() {},
    allowBreakpointsFromModule: k => calls.push('module:' + k), addBreakpoints: b => calls.push('breakpoints:' + b.join(',')), pauseOnAllExceptions: v => calls.push('exceptions:' + v) };
  const s = createNativeClientInspection({ globalObject, debuggerObject: dbg, platform: 'odc', modules, variables: [] });
  s.enable(clientInspectionEnableOptions({ breakpoints: ['Module:Node'], pauseOnExceptions: true }));
  assert.deepEqual(calls, ['module:Module', 'breakpoints:Module:Node', 'exceptions:true']); s.dispose();
});

for (const platform of ['o11', 'odc']) test(platform + ': scope binds the paused frame identity and separates not-applicable, empty and not-enumerated categories', () => {
  const globalObject = {}, frame = { elementKey: 'Module:Action', currentBreakpoint: 'Module:Node', previousBreakpoint: 'Module:Before' };
  const at = { moduleKey: 'Module', actionKey: 'Action', nodeKey: 'Node', previousNodeKey: 'Before' };
  const dbg = { getThreadState: () => ({}), getThreadStack: () => [frame], evaluateVariable: () => ({ type: 'Integer', value: 1 }), stepInto() {} };
  const s = createNativeClientInspection({ globalObject, debuggerObject: dbg, platform, modules, variables: [
    { ...at, variableKey: 'V', name: 'Input', category: 'input' }, { ...at, variableKey: 'C', name: 'Client.Last', nativePath: 'Last', category: 'client' },
    { moduleKey: 'Module', actionKey: 'Action', variableKey: 'X', name: 'Declared', category: 'output' }] });
  const request = input => globalObject[s.helperName](input);
  request({ op: 'pause', callContextId: 1 });
  let scope = request({ op: 'scope' }).result;
  assert.equal(scope.metadataBound, true);
  assert.deepEqual(scope.context, { moduleKey: 'Module', functionKey: 'Action', nodeKey: 'Node', previousNodeKey: 'Before' });
  assert.equal(scope.stop, 1); assert.equal(scope.runtime, 'client');
  assert.deepEqual(scope.notApplicableToRuntime, ['session', 'site', 'setting', 'timer']);
  assert.deepEqual(scope.notApplicableReasons.session, platform === 'odc'
    ? { reason: 'odc-model-refuses-session-variables', evidence: 'kernel/tests/jobs-odc-negative/session-variable-not-in-odc.json' }
    : { reason: 'client-runtime-has-no-session-variables' });
  // Counts come from the scope bound for exactly this frame: output is the declared action variable, local is empty.
  assert.deepEqual(scope.enumeratedCategories, ['input', 'output', 'client']);
  assert.deepEqual(scope.emptyInModel, ['local']); assert.deepEqual(scope.notEnumerated, []); assert.deepEqual(scope.unavailableCategories, []);
  // An unbound node has no frame-bound counts: nothing is claimed empty.
  request({ op: 'stepInto' }); frame.currentBreakpoint = 'Module:Other'; frame.previousBreakpoint = null;
  request({ op: 'pause', callContextId: 1 }); scope = request({ op: 'scope' }).result;
  assert.deepEqual(scope.context, { moduleKey: 'Module', functionKey: 'Action', nodeKey: 'Other', previousNodeKey: null });
  assert.deepEqual(scope.emptyInModel, []); assert.deepEqual(scope.notEnumerated, ['input', 'local', 'client']);
  assert.deepEqual(scope.unavailableCategories, scope.notEnumerated);
  // A frame without a native node cannot be bound to model coverage.
  frame.currentBreakpoint = undefined; scope = request({ op: 'scope' }).result;
  assert.equal(scope.metadataBound, false); assert.equal(scope.context, undefined);
  s.dispose();
});
