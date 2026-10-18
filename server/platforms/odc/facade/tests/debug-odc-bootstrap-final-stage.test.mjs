import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectOdcBootstrapFinalStage} from '../debug-odc-bootstrap-final-stage.mjs';
// Synthetic grammar fixture; contains no vendor implementation.
const source=`import {T as post,K as types,E as app,a as named,t as errors} from './_oschunk-CORE.js';
import {a as view} from './_oschunk-UI.js';
ready.then(function(){return post({initType:types.Application.InitializationType.Full}).then(function(ok){
if(ok){let initError=function(){return new Promise(function(resolve){
Promise.all([import('./_oschunk-ERROR.js')]).then(function(modules){var handler=modules[0];
app.default.registerDefaultErrorHandler(function(){return function(error,context){return handler.default.handleError(error,context)}}),resolve()})
})},initView=function(){return new Promise(function(resolve,reject){try{view.load(app.default,{staticScreenRoutes:routes,staticSplashRoute:null}),resolve()}catch(error){reject(error)}})};
return named(initError,'initGlobalExceptionHandler'),named(initView,'initView'),initError().then(initView)}
})}).catch(function(error){errors.handleError(error)});`;
test('recognizes deferred final stage and retains unqualified execution',()=>{
 const r=inspectOdcBootstrapFinalStage(source);
 assert.equal(r.executed,false);assert.equal(r.applicationStartupQualified,false);assert.equal(r.executionAuthorized,false);
 assert.deepEqual(r.postInitialization,{file:'./_oschunk-CORE.js',export:'T'});
 assert.deepEqual(r.errorHandler,{file:'./_oschunk-CORE.js',export:'t'});
});
test('accepts separate statements as well as compiler sequence expressions',()=>{
 assert.doesNotThrow(()=>inspectOdcBootstrapFinalStage(source.replace('}),resolve()', '});resolve()').replace('null}),resolve()', 'null});resolve()')));
});
test('rejects replaced control flow, active extra effects and missing error handling',()=>{
 for(const mutate of [
  s=>s.replace('if(ok)','if(true)'),s=>s.replace('initError().then(initView)','initView().then(initError)'),
  s=>s.replace('}),resolve()', '}),send(),resolve()'),s=>s.replace('errors.handleError(error)','send(error)'),
  s=>s.replace('.catch(function(error){errors.handleError(error)})',''),
  s=>s.replace('InitializationType.Full','InitializationType.Partial'),
  s=>s+'var Promise=other;'
 ])assert.throws(()=>inspectOdcBootstrapFinalStage(mutate(source)),/debug_odc_bootstrap_final_/);
});
test('rejects lexical shadowing that changes handlers or promise resolution',()=>{
 for(const mutate of [
  s=>s.replace('function(error,context){return handler.default.handleError(error,context)}','function(handler,context){return handler.default.handleError(handler,context)}'),
  s=>s.replace('catch(error){reject(error)}','catch(reject){reject(reject)}'),
  s=>s.replace('function(modules){var handler=modules[0]','function(resolve){var handler=resolve[0]'),
  s=>s.replace('function(resolve){','function(Promise){')
 ])assert.throws(()=>inspectOdcBootstrapFinalStage(mutate(source)),/debug_odc_bootstrap_final_/);
});
