import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {inspectOdcControllerInitialization} from '../debug-odc-controller-initialization.mjs';
const importer={resolved:true,imports:['./_oschunk-WRAPPER.js']};
const source=`import{I as native,a as name,h as container,i as services,w as types}from './_oschunk-SDK.js';
var cache,Vars=class{constructor(){cache=container.resolve(services.ClientVariablesService)}getValue(){return cache.getVariable()}};
name(Vars,"Vars");var v=new Vars;
var C=class extends native.BaseModuleController{constructor(a,b){super(a,b)}get roles(){return {}}};name(C,"Controller");
var Alias=C,instance=new Alias;var metadata={value:{getter:name(function(o){return o.value},"getter"),dataType:types.DataTypes.Integer}};
OutSystemsDebugger.registerMetaInfo(metadata);
instance.constructor.registerVariableGroupType("App.Action.vars",[{name:"Value",mandatory:!0,dataType:types.DataTypes.Integer,defaultValue:name(function(){return 0},"defaultValue")}]);
function unused(){fetch('not-invoked')}export{instance as controller};`;
const files=s=>({'_oschunk-WRAPPER.js':"import{controller as app}from './_oschunk-APP.js';export{app as default};",'_oschunk-APP.js':s??source});

test('plain controller initialization requires a qualified application dependency before examining its import',()=>{
 assert.throws(()=>inspectOdcControllerInitialization(files(),importer,'App',{baseMember:'BaseController'}),/application_importer/);
 assert.throws(()=>inspectOdcControllerInitialization(files(),importer,'App',{baseMember:'BaseController',applicationImporter:importer}),/application_initialization/);
});
test('generated controller initialization syntax is separated from remaining native behavior',()=>{
 const r=inspectOdcControllerInitialization(files(),importer,'App');assert.equal(r.generatedSyntaxQualified,true);
 for(const kind of ['native-client-variables-service','native-base-controller','native-name-helper','native-debugger-metadata','native-variable-group'])
  assert.ok(r.dependencies.some(d=>d.kind===kind));
 assert.equal(r.nativeEffectsQualified,false);assert.equal(r.initializationQualified,false);assert.equal(r.executionAuthorized,false);
});
test('extra calls, getter initializers, constructor effects and service substitutions are refused',()=>{
 for(const changed of [source+'fetch("unexpected")',source.replace('var metadata=','var leak=window.secret;var metadata='),
  source.replace('cache=container.resolve(services.ClientVariablesService)','cache=container.resolve(services.Other)'),
  source.replace('cache=container.resolve(services.ClientVariablesService)','cache=container.resolve(services.ClientVariablesService);send()'),
  source.replace('get roles(){','get translationResources(){return injected}get roles(){'),
  source.replace('"App.Action.vars"','"Other.Action.vars"'),source.replace('mandatory:!0','mandatory:effect()')])
  assert.throws(()=>inspectOdcControllerInitialization(files(changed),importer,'App'),/debug_odc_(controller_initialization|application_controller)_/);
});
test('fields, computed methods, naming nonfunctions and nonlocal constructor aliases cannot pass',()=>{
 for(const changed of [source.replace('get roles(){','static value=send();get roles(){'),
  source.replace('name(Vars,"Vars")','name(v,"Vars")'),source.replace('new Vars','new unknown'),
  source.replace('getValue(){','[computed()](){')])assert.throws(()=>inspectOdcControllerInitialization(files(changed),importer,'App'),/debug_odc_/);
});

test('qualified SDK primitives reduce only their own pending effects',()=>{
 const sdk=`var define=Object.defineProperty,name=(t,e)=>define(t,"name",{value:e,configurable:true});
 var Registry=class{constructor(){this.definitions=new Map}registerTypeDefinition(e,n){this.definitions.set(e,n)}};
 var registry=new Registry,Base=class{static registerVariableGroupType(e,n){registry.registerTypeDefinition(e,n)}};
 var ns=Object.freeze({BaseModuleController:Base});export{name as a,ns as I};`;
 const r=inspectOdcControllerInitialization({...files(),'_oschunk-SDK.js':sdk},importer,'App');
 assert.deepEqual(r.qualifiedNativeEffectKinds,['native-name-helper','native-variable-group']);
 assert.ok(r.pendingNativeEffectKinds.includes('native-client-variables-service'));assert.ok(r.pendingNativeEffectKinds.includes('native-base-controller'));
 assert.equal(r.initializationQualified,false);
 const bad=inspectOdcControllerInitialization({...files(),'_oschunk-SDK.js':sdk.replace('this.definitions.set(e,n)','send(e,n)')},importer,'App');
 assert.deepEqual(bad.qualifiedNativeEffectKinds,[]);assert.equal(bad.sdkPrimitives.qualified,false);assert.equal(bad.executionAuthorized,false);
});

test('metadata types must exist in the native enum before that effect is qualified',()=>{
 const sdk='var E;(function(t){t[t.Integer=0]="Integer"})(E||(E={}));var ns=Object.freeze({get DataTypes(){return E}});export{ns as w};';
 const r=inspectOdcControllerInitialization({...files(),'_oschunk-SDK.js':sdk},importer,'App');
 assert.ok(r.qualifiedNativeEffectKinds.includes('native-data-type'));assert.ok(r.pendingNativeEffectKinds.includes('native-base-controller'));
 const missing=inspectOdcControllerInitialization({...files(source.replaceAll('DataTypes.Integer','DataTypes.NotDefined')),'_oschunk-SDK.js':sdk},importer,'App');
 assert.ok(missing.pendingNativeEffectKinds.includes('native-data-type'));assert.equal(missing.dataTypes.error,'debug_odc_data_types_member_missing');
 assert.equal(missing.executionAuthorized,false);
});

test('metadata registration cannot substitute the ownership guard with an application callback',()=>{
 const core='var D=class{registerMetaInfo(e){this.metaInfoMap||(this.metaInfoMap=new Map);for(let k in e)e.hasOwnProperty(k)&&!this.metaInfoMap.get(k)&&this.metaInfoMap.set(k,e[k])}};var root=typeof window!=="undefined"?window:global;root.OutSystemsDebugger=new D;';
 const r=inspectOdcControllerInitialization({...files(),'_oschunk-CORE.js':core},importer,'App');
 assert.ok(r.qualifiedNativeEffectKinds.includes('native-debugger-metadata'));assert.equal(r.initializationQualified,false);
 assert.throws(()=>inspectOdcControllerInitialization({...files(source.replace('var metadata={value:','var metadata={hasOwnProperty:function(){send()},value:')),'_oschunk-CORE.js':core},importer,'App'),/initialization_metadata/);
});

test('native base construction qualification leaves the client variable service pending',()=>{
 const sdk=`class B{constructor(r){if(this.isExecutingJSNode=!1,this.localeChangeHandler=e=>{},this.translationResources=r!=null?r:this.translationResources,this.translationResources){deferred()}}}
 class M extends B{constructor(){super(...arguments),this.fireApplicationResumeSingletonCallback=this.fireApplicationResume.bind(this)}fireApplicationResume(){}}
 var ns=Object.freeze({BaseModuleController:M});export{ns as I};`;
 const r=inspectOdcControllerInitialization({...files(),'_oschunk-SDK.js':sdk},importer,'App');
 assert.equal(r.baseConstruction.qualified,true);assert.ok(r.qualifiedNativeEffectKinds.includes('native-base-controller'));
 assert.ok(r.pendingNativeEffectKinds.includes('native-client-variables-service'));assert.equal(r.initializationQualified,false);
});

test('wrapper effects and unused transitive imports cannot escape initialization qualification',()=>{
 for(const wrapper of [files()['_oschunk-WRAPPER.js']+'send();',
  "import './_oschunk-OTHER.js';"+files()['_oschunk-WRAPPER.js'],
  'var other=external;'+files()['_oschunk-WRAPPER.js']])
  assert.throws(()=>inspectOdcControllerInitialization({...files(),'_oschunk-WRAPPER.js':wrapper},importer,'App'),/wrapper_/);
 assert.throws(()=>inspectOdcControllerInitialization(files("import './_oschunk-OTHER.js';"+source),importer,'App'),/additional_import/);
});
