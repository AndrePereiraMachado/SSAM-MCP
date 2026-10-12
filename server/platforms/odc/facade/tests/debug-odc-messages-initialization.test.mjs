import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectOdcMessagesDeclaration} from '../debug-odc-messages-initialization.mjs';
const source=`import {L as messages,a as name} from './_oschunk-CORE.js';var C=class C extends messages.BaseMessagesProvider{constructor(r){super(r),this.setMessage('Required','Required value'),this.setMessage('Email','Email expected')}};name(C,'MessagesProvider');var Alias=C,provider=new Alias;export {provider as a};`;
test('original zero-argument provider stores only literal messages and leaves locale callbacks deferred',()=>{
 const r=inspectOdcMessagesDeclaration(source,'a');assert.equal(r.messageCount,2);
 assert.equal(r.translationResourcesSupplied,false);assert.equal(r.localeCallbackExecuted,false);
 assert.deepEqual(r.provider.binding,{file:'./_oschunk-CORE.js',export:'L',member:'BaseMessagesProvider'});
});
test('translation resources, active message expressions and additional imports are refused',()=>{
 for(const mutate of [s=>s.replace('new Alias','new Alias(resources)'),s=>s.replace('super(r)','super(read())'),
  s=>s.replace("'Required value'",'read()'),s=>s.replace("'Required value'",'`Required value`'),
  s=>s+"import './_oschunk-OTHER.js';",s=>s+'send();'])
  assert.throws(()=>inspectOdcMessagesDeclaration(mutate(source),'a'),/messages_initialization_/);
});
test('setters and overrides cannot change native dictionary construction or message storage',()=>{
 for(const mutate of [s=>s.replace('constructor(r)', 'get translationResources(){return read()}constructor(r)'),
  s=>s.replace('constructor(r)','set messages(v){send(v)}constructor(r)'),
  s=>s.replace('constructor(r)','setMessage(){send()}constructor(r)'),
  s=>s.replace("'Required','Required value'","'__proto__','Required value'")])
  assert.throws(()=>inspectOdcMessagesDeclaration(mutate(source),'a'),/messages_initialization_/);
});
