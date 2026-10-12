import test from 'node:test';import assert from 'node:assert/strict';
import {inspectOdcApplicationController} from '../debug-odc-application-controller.mjs';
import {qualifyOdcBaseControllerConstruction} from '../debug-odc-base-controller-construction.mjs';
const importer={resolved:true,imports:['./_oschunk-APP.js']};
const app="import{I as sdk}from './_oschunk-SDK.js';class C extends sdk.BaseModuleController{constructor(a,b){super(a,b)}}var instance=new C;export{instance as default};";
const sdk=`class Base{constructor(resources){if(this.isExecutingJSNode=false,this.localeChangeHandler=e=>{deferred(e)},this.translationResources=resources!=null?resources:this.translationResources,this.translationResources){notReached()}}}
class Module extends Base{constructor(){super(...arguments),this.fireApplicationResumeSingletonCallback=this.fireApplicationResume.bind(this)}fireApplicationResume(){return runLater()}}
var ns=Object.freeze({BaseModuleController:Module});export{ns as I};`;
const files=(a=app,s=sdk)=>({'_oschunk-APP.js':a,'_oschunk-SDK.js':s});
const qualify=(a,s)=>{const f=files(a,s);return qualifyOdcBaseControllerConstruction(f,inspectOdcApplicationController(f,importer));};
test('zero-argument native construction initializes fields and defers callbacks without a model evaluator',()=>{
 const r=qualify();assert.equal(r.qualified,true);assert.equal(r.executionAuthorized,false);assert.equal(r.applicationStartupQualified,false);
 assert.deepEqual(r.effects,['native-instance-fields','deferred-locale-callback','bound-native-resume-callback']);
 assert.equal(qualify(app,sdk.replace('isExecutingJSNode=false','isExecutingJSNode=!1')).qualified,true);
});
test('locale fields/accessors, resume overrides and changed constructor inputs fail',()=>{
 for(const a of [app.replace('constructor(a,b)', 'get translationResources(){return injected}constructor(a,b)'),
  app.replace('constructor(a,b)','fireApplicationResume(){send()}constructor(a,b)'),app.replace('new C','new C(1)'),
  app.replace('super(a,b)','super(a,b);send()')])assert.throws(()=>qualify(a),/debug_odc_/);
});
test('native constructor mutations cannot turn the guarded locale path into execution',()=>{
 for(const s of [sdk.replace('super(...arguments)','super(1)'),sdk.replace('resources!=null','resources==null'),
  sdk.replace('resources:this.translationResources','resources:injected'),sdk.replace('this.translationResources){','true){'),
  sdk.replace('this.fireApplicationResume.bind(this)','this.fireApplicationResume()'),sdk.replace('constructor(resources){','constructor(resources){send();'),
  sdk.replace('class Base{','class Base{get translationResources(){return injected}')])assert.throws(()=>qualify(app,s),/debug_odc_base_construction_/);
});

test('plain native BaseController supports the implicit zero-argument constructor without module resume setup',()=>{
 const a=app.replace('BaseModuleController{constructor(a,b){super(a,b)}}','BaseController{}');
 const s=sdk.replace('BaseModuleController:Module','BaseModuleController:Module,BaseController:Base');
 const inspect=a=>{const f=files(a,s);return qualifyOdcBaseControllerConstruction(f,inspectOdcApplicationController(f,importer,{baseMember:'BaseController'}));};
 const result=inspect(a);assert.equal(result.qualified,true);assert.equal(result.moduleConstructorSha256,undefined);
 assert.deepEqual(result.effects,['native-instance-fields','deferred-locale-callback']);
 for(const change of [a.replace('BaseController{}','BaseController{get translationResources(){return resource}}'),
  a.replace('new C','new C(17)'),a.replace('BaseController{}','BaseController{constructor(){super(17)}}')])
  assert.throws(()=>inspect(change),/debug_odc_/);
});
