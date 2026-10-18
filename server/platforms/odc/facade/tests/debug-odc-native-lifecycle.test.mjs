import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {nativeLifecycleBinding,nativeLifecycleHelper} from '../debug-odc-native-lifecycle.mjs';

// Shape observed in the published ODC bundle; identifiers and label are neutral.
const source = `get onInitializeEventHandler(){return this.hasOwnProperty("_onInitializeEventHandler")||(this._onInitializeEventHandler=function(e){var t=this.controller,i=this.model,c=this.idService;return v.tryFinally(function(){var f={};return t.pushDebuggerContext(e),OutSystemsDebugger.setThreadStartName(e==null?void 0:e.id,"Flow/Screen On Initialize"),t.onInitialize$Action(e)},function(){t.popDebuggerContext(e)})}),this._onInitializeEventHandler}`;
const getter = s => parse('class C {'+s+'}',{ecmaVersion:'latest'}).body[0].body.body[0];
test('generated cached event preserves its native context, action and finally dispatcher', () => {
  assert.deepEqual(nativeLifecycleBinding(getter(source),'onInitialize$Action'), {
    kind:'native-cached-event',handler:'onInitializeEventHandler',action:'onInitialize$Action',helperLocal:'v',contextPreserved:true,
  });
  for(const [before,after] of [
    ['t.onInitialize$Action(e)','other.onInitialize$Action(e)'],
    ['t.onInitialize$Action(e)','t.onInitialize$Action(i)'],
    ['t.popDebuggerContext(e)','t.popDebuggerContext(i)'],
    ['t.popDebuggerContext(e)','t.popDebuggerContext(e);sideEffect()'],
    ['t.pushDebuggerContext(e),',''],
    ['v.tryFinally','v.otherHelper'],
    ['this.controller','this.foreignController'],
    ['this.hasOwnProperty','other.hasOwnProperty'],
  ]) assert.equal(nativeLifecycleBinding(getter(source.replace(before,after)),'onInitialize$Action'),null,after);
});
test('direct event forwards the same context exactly once', () => {
  const s='get onReadyEventHandler(){return function(cc){return this.ready$Action(cc);};}';
  assert.equal(nativeLifecycleBinding(getter(s),'ready$Action').kind,'direct');
  assert.equal(nativeLifecycleBinding(getter(s.replace('this.ready','other.ready')),'ready$Action'),null);
  assert.equal(nativeLifecycleBinding(getter(s.replace('return this.ready','sideEffect();return this.ready')),'ready$Action'),null);
});

test('event helper follows the SDK export and the unchanged finally wrapper', () => {
  const sdk='function f(a,b){return d(a,void 0,b)} function d(a,b,c){return a()} var ns=Object.freeze({tryFinally:f});';
  const chunks={'app.js':{imports:[{specifier:'./core.js',names:[{local:'v',imported:'events'}]}]},
    'core.js':{exports:{events:'ns'},keepNames:{widget:'WidgetIdService',f:'tryFinally',d:'tryCatchFinally'}}};
  const binding={kind:'native-cached-event',helperLocal:'v'};
  const qualify=(c=chunks,s=sdk)=>nativeLifecycleHelper(binding,'app.js',c,{'core.js':s});
  const proof=qualify(); assert.equal(proof.local,'f');assert.equal(proof.delegate,'d');assert.equal(proof.sourceBindingOnly,true);
  assert.equal(qualify(chunks,sdk.replace('d(a,void 0,b)','d(b,void 0,a)')),null);
  assert.equal(qualify(chunks,sdk.replace('return d','sideEffect();return d')),null);
  for(const change of [c=>{c['core.js'].exports.events='other';},c=>{delete c['core.js'].keepNames.widget;},
    c=>{c['core.js'].keepNames.d='other';},c=>{c['app.js'].imports.push(c['app.js'].imports[0]);}]){
    const modified=structuredClone(chunks);change(modified);assert.equal(qualify(modified),null);
  }
});
