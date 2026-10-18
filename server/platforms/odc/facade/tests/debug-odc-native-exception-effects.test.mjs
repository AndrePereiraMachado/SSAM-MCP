import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {inspectOdcExceptionEffects} from '../debug-odc-native-exception-effects.mjs';
const moduleKey='j8fMmV32B0iyTfbxwOOejQ',actionKey='LXQ1dKTtRUeai5qBhffq7g.#FlowExceptionHandler',nodeKey='d6D9gvHjH0+Su8QAH4Mp_Q';
const attrs=guid=>`s.setAttribute("outsystems.function.key","${guid}");s.setAttribute("outsystems.function.owner.key","99ccc78f-f65d-4807-b24d-f6f1c0e39e8d");s.setAttribute("outsystems.function.type","CLIENT_EXCEPTION_HANDLER");`;
const source=`import {u as ui,j as log} from './_oschunk-SDK.js';var C=class{get handleError(){return log.startActiveSpan("OnException",function(s){${attrs('7435742d-eda4-4745-9a8b-9a8185f7eaee.#FlowExceptionHandler')}
 OutSystemsDebugger.push("${moduleKey}:${actionKey}:path:hash");
 log.startActiveSpan("Handler",function(s){${attrs('82fda077-e3f1-4f1f-92bb-c4001f8329fd')}OutSystemsDebugger.handleBreakpoint("${moduleKey}:${nodeKey}");ui.showFeedbackMessage("Diagnostic",3);});
 OutSystemsDebugger.pop("${moduleKey}:${actionKey}");});}};`;
const model={modelQualified:true,actionKey,nodeKeys:[nodeKey],handlerKeys:[nodeKey],treeSha256:'a'.repeat(64),effects:[{kind:'feedback',messageExpression:'"Diagnostic"',messageType:'Error'}]};
const inspect=s=>inspectOdcExceptionEffects(s,'_oschunk-TEST.js',model,moduleKey);
test('published dependency names are resolved but matching feedback does not qualify SDK effects',()=>{
 const r=inspect(source);assert.equal(r.feedbackMatches,true);assert.equal(r.executionAuthorized,false);assert.equal(r.runtimeEffectsQualified,false);
 assert.ok(r.dependencies.some(d=>d.export==='u'&&d.member==='showFeedbackMessage'&&d.file==='./_oschunk-SDK.js'));
 assert.ok(r.unresolvedCalls.some(c=>c.target==='s.setAttribute'));
});
test('feedback mutations and added computed or global effects remain visible and unqualified',()=>{
 for(const change of ['ui.showFeedbackMessage("Other",3)','ui.showFeedbackMessage("Diagnostic",4)','ui.showFeedbackMessage(getMessage(),3)','ui.showFeedbackMessage("Diagnostic",3,true)'])
  assert.equal(inspect(source.replace('ui.showFeedbackMessage("Diagnostic",3)',change)).feedbackMatches,false);
 const r=inspect(source.replace('ui.showFeedbackMessage("Diagnostic",3);','ui.showFeedbackMessage("Diagnostic",3);fetch("https://unexpected.invalid");obj[method]();state.value=1;'));
 assert.ok(r.unresolvedCalls.some(c=>c.target==='fetch'));assert.ok(r.unresolvedCalls.some(c=>c.target===null));assert.ok(r.writes.some(w=>w.target==='state.value'));assert.equal(r.runtimeEffectsQualified,false);
});

test('exception dependencies bind to original SDK declarations and preserve missing dependencies',()=>{
 const sdk='function feedback(message,type){} function span(name,callback){return callback({})} var ui=Object.freeze({showFeedbackMessage:feedback}),log=Object.freeze({startActiveSpan:span});export{ui as u,log as j};';
 const options={files:{'_oschunk-SDK.js':sdk}};
 const result=inspectOdcExceptionEffects(source,'_oschunk-TEST.js',model,moduleKey,options);
 assert.equal(result.sdkBindings.length,2);
 assert.ok(result.sdkBindings.every(b=>b.resolved&&b.sourceBound&&!b.effectsQualified));
 assert.deepEqual(result.sdkBindings.map(b=>b.symbol).sort(),['feedback','span']);
 assert.equal(result.executionAuthorized,false);
 assert.equal(result.runtimeEffectsQualified,false);
 const missing=inspectOdcExceptionEffects(source,'_oschunk-TEST.js',model,moduleKey,{files:{}});
 assert.equal(missing.sdkBindings.length,2);
 assert.ok(missing.sdkBindings.every(b=>!b.resolved&&b.error==='debug_odc_sdk_binding_source'));
 assert.equal(missing.executionAuthorized,false);
 const changed=inspectOdcExceptionEffects(source,'_oschunk-TEST.js',model,moduleKey,{files:{'_oschunk-SDK.js':sdk.replace('showFeedbackMessage:feedback','showFeedbackMessage:factory()')}});
 assert.ok(changed.sdkBindings.some(b=>b.resolved&&b.symbol==='span'));
 assert.ok(changed.sdkBindings.some(b=>!b.resolved&&b.dependency.member==='showFeedbackMessage'));
 assert.equal(changed.runtimeEffectsQualified,false);
});

test('SDK constant reads and computed accesses are visible even without a call',()=>{
 const extended=source.replace('ui.showFeedbackMessage("Diagnostic",3);','ui.showFeedbackMessage("Diagnostic",3);return ui.IGNORED_ERROR_RESULT;');
 const sdk='function feedback(){} function span(){} var ignored=0,ui=Object.freeze({showFeedbackMessage:feedback,IGNORED_ERROR_RESULT:ignored}),log=Object.freeze({startActiveSpan:span});export{ui as u,log as j};';
 const r=inspectOdcExceptionEffects(extended,'_oschunk-TEST.js',model,moduleKey,{files:{'_oschunk-SDK.js':sdk}});
 assert.ok(r.dependencies.some(d=>d.member==='IGNORED_ERROR_RESULT'));
 const constant=r.sdkBindings.find(b=>b.member==='IGNORED_ERROR_RESULT');
 assert.equal(constant.resolved,true);assert.equal(constant.declarationKind,'Literal');assert.equal(r.runtimeEffectsQualified,false);
 const computed=inspect(extended.replace('ui.IGNORED_ERROR_RESULT','ui[key]'));
 assert.ok(computed.reads.some(read=>read.computed&&read.dependency===null));
 assert.equal(computed.executionAuthorized,false);
});
