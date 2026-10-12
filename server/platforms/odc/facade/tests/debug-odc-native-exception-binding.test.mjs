import test from 'node:test';
import assert from 'node:assert/strict';
import {bindOdcExceptionRuntime} from '../debug-odc-native-exception-binding.mjs';
const moduleKey='j8fMmV32B0iyTfbxwOOejQ',actionKey='LXQ1dKTtRUeai5qBhffq7g.#FlowExceptionHandler',nodeKey='d6D9gvHjH0+Su8QAH4Mp_Q';
const attrs=(guid)=>`s.setAttribute("outsystems.function.key","${guid}");s.setAttribute("outsystems.function.owner.key","99ccc78f-f65d-4807-b24d-f6f1c0e39e8d");s.setAttribute("outsystems.function.type","CLIENT_EXCEPTION_HANDLER");`;
const source=`var C=class{get handleError(){return A.startActiveSpan("OnException",function(s){${attrs('7435742d-eda4-4745-9a8b-9a8185f7eaee.#FlowExceptionHandler')}
 OutSystemsDebugger.push("${moduleKey}:${actionKey}:path:hash");
 A.startActiveSpan("Handler",function(s){${attrs('82fda077-e3f1-4f1f-92bb-c4001f8329fd')}OutSystemsDebugger.handleBreakpoint("${moduleKey}:${nodeKey}");});
 OutSystemsDebugger.pop("${moduleKey}:${actionKey}");});}};`;
const model={modelQualified:true,actionKey,nodeKeys:[nodeKey],handlerKeys:[nodeKey],treeSha256:'a'.repeat(64)};
test('native exception binding preserves full frame identity and exact breakpoint set',()=>{
 const p=bindOdcExceptionRuntime(source,'_oschunk-TEST.js',model,moduleKey);
 assert.equal(p.nativeFrameBound,true);assert.equal(p.nativeBreakpointsBound,true);
 assert.equal(p.runtimeEffectsQualified,false);assert.equal(p.executionAuthorized,false);
});
test('different module, missing or extra breakpoints, and mismatched frame refuse',()=>{
 const mutations=[s=>s.replace('handleBreakpoint','unknownCall'),s=>s.replace(`:${nodeKey}");`,':OtherNode");'),
  s=>s.replace('OutSystemsDebugger.pop(',`OutSystemsDebugger.handleBreakpoint("${moduleKey}:${nodeKey}");OutSystemsDebugger.pop(`),
  s=>s.replace(`${actionKey}:path`,`${actionKey}Other:path`)];
 for(const mutate of mutations)assert.throws(()=>bindOdcExceptionRuntime(mutate(source),'_oschunk-TEST.js',model,moduleKey),/debug_odc_exception_binding_/);
 assert.throws(()=>bindOdcExceptionRuntime(source,'_oschunk-TEST.js',model,'OtherModule'),/action/);
});
