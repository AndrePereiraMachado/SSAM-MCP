import test from 'node:test';import assert from 'node:assert/strict';
import {qualifyOdcExceptionBody} from '../debug-odc-exception-body.mjs';
const moduleKey='j8fMmV32B0iyTfbxwOOejQ',actionKey='LXQ1dKTtRUeai5qBhffq7g.#FlowExceptionHandler',nodeKey='d6D9gvHjH0+Su8QAH4Mp_Q';
const attrs=guid=>`span.setAttribute("outsystems.function.key","${guid}");span.setAttribute("outsystems.function.owner.key","99ccc78f-f65d-4807-b24d-f6f1c0e39e8d");span.setAttribute("outsystems.function.type","CLIENT_EXCEPTION_HANDLER");`;
const source=`import{j as log,g as errors,t as errorHandling,u as ui,w as types}from './_oschunk-SDK.js';
var Controller=class{get handleError(){return this.hasOwnProperty("_handleError")||(this._handleError=function(error,context){
 var bag={},controller=this.controller;
 return log.startActiveSpan("OnException",function(span){${attrs('7435742d-eda4-4745-9a8b-9a8185f7eaee.#FlowExceptionHandler')}
 context=controller.callContext(context);var output=new types.VariableHolder(new types.ErrorHandlerOutputType);bag.handleAllVar=output;
 if(errorHandling.ignoreError(error,context))return errorHandling.IGNORED_ERROR_RESULT;
 try{OutSystemsDebugger.push("${moduleKey}:${actionKey}:path:hash");
  output.value.exceptionMessageAttr=errors.getMessage(error);
  OutSystemsDebugger.handleBreakpoint("${moduleKey}:${nodeKey}");ui.showFeedbackMessage("Diagnostic",3);
 }catch(span){return errorHandling.defaultErrorHandler(span,context);}
 finally{OutSystemsDebugger.pop("${moduleKey}:${actionKey}");span.end();}
 },1);
}),this._handleError}};`;
const sdk=`function span(){}function message(){}function ignore(){}function handler(){}function feedback(){}
class Holder{}class Output{}var ignored={errorCode:'IGNORED'};
var log=Object.freeze({startActiveSpan:span}),errors=Object.freeze({getMessage:message}),
handling=Object.freeze({ignoreError:ignore,defaultErrorHandler:handler,IGNORED_ERROR_RESULT:ignored}),
ui=Object.freeze({showFeedbackMessage:feedback}),types=Object.freeze({VariableHolder:Holder,ErrorHandlerOutputType:Output});
export{log as j,errors as g,handling as t,ui as u,types as w};`;
const model={modelQualified:true,actionKey,nodeKeys:[nodeKey],handlerKeys:[],treeSha256:'a'.repeat(64),effects:[{kind:'feedback',messageExpression:'"Diagnostic"',messageType:'Error'}]};
const qualify=(s=source,files={'_oschunk-SDK.js':sdk})=>qualifyOdcExceptionBody(s,'_oschunk-TEST.js',model,moduleKey,{files});
test('generated local exception effects bind to model and preserve pending SDK and initialization dependencies',()=>{
 const r=qualify();assert.equal(r.localEffectsQualified,true);assert.equal(r.runtimeEffectsQualified,false);assert.equal(r.executionAuthorized,false);
 assert.equal(r.localEffects.variableHolders,1);assert.deepEqual(r.pending,['sdk-effect-closure','exception-module-initialization']);
});
test('a catch parameter sharing the span spelling cannot call a span method',()=>{
 assert.throws(()=>qualify(source.replace('catch(span){','catch(span){span.end();')),/exception_body_call/);
 assert.equal(qualify().localEffectsQualified,true);
});
test('global reads, computed access, extra calls, writes and modified feedback refuse qualification',()=>{
 for(const injected of ['globalThis.secret;','controller[method]();','fetch("external");','output.value.exceptionMessageAttr="replaced";',
  'bag.extra=output;','controller.callContext(error);']){
  assert.throws(()=>qualify(source.replace('try{OutSystemsDebugger.push',injected+'try{OutSystemsDebugger.push')),/exception_body_/);
 }
 assert.throws(()=>qualify(source.replace('"Diagnostic",3','"Other",3')),/exception_body_feedback/);
});
test('changed cache, missing native dependencies and imported alias shadowing cannot pass',()=>{
 assert.throws(()=>qualify(source.replace('this.hasOwnProperty("_handleError")','other.hasOwnProperty("_handleError")')),/exception_body_cache/);
 assert.throws(()=>qualify(source,{}),/exception_body_/);
 assert.throws(()=>qualify(source.replace('var bag={},','var log={},bag={},')),/exception_body_declaration/);
});
