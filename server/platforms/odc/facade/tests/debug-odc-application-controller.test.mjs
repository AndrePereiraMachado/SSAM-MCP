import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {inspectOdcApplicationController} from '../debug-odc-application-controller.mjs';
const importer={resolved:true,imports:['./_oschunk-WRAPPER.js']};
const body=`import{I as native}from './_oschunk-SDK.js';var C=class C extends native.BaseModuleController{constructor(a,b){super(a,b)}get clientActionProxies(){return {}}};var Alias=C,instance=new Alias,other=instance;function unused(){fetch('https://example.invalid')}export{other as controller,unused};`;
const fixture=source=>({'_oschunk-WRAPPER.js':"import{controller as app}from './_oschunk-APP.js';export{app as default};",'_oschunk-APP.js':source??body});
test('original default export resolves to its instance and declaration, not every imported action',()=>{
 const p=inspectOdcApplicationController(fixture(),importer);
 assert.equal(p.controllerChunk,'_oschunk-APP.js');assert.equal(p.constructorDelegates,true);
 assert.deepEqual(p.instanceBinding,{file:'_oschunk-APP.js',local:'instance'});
 assert.ok(p.handlers.every(h=>!h.declared));assert.deepEqual(p.overriddenDispatch,[]);
 assert.equal(p.executionAuthorized,false);assert.equal(p.initializationQualified,false);assert.equal(p.sdkDispatchQualified,false);
 assert.deepEqual(p.baseImport,{file:'_oschunk-SDK.js',exported:'I'});
});
test('startup handlers and overridden SDK dispatch are explicitly distinguished',()=>{
 const p=inspectOdcApplicationController(fixture(body.replace('get clientActionProxies()',
  'get onApplicationReadyHandler(){return doWork} fireApplicationReady(){doWork()} get clientActionProxies()')),importer);
 assert.equal(p.handlers.find(h=>h.handler==='onApplicationReadyHandler').declared,true);
 assert.deepEqual(p.overriddenDispatch,['fireApplicationReady']);assert.equal(p.executionAuthorized,false);
});
test('unresolved, cyclic, executable-constructor and computed-member forms are refused',()=>{
 for(const files of [fixture(body.replace('super(a,b)','super(a,b);send()')),fixture(body.replace('get clientActionProxies()','get [dynamic]()')),
  fixture(body.replace('new Alias','new Alias(1)')),fixture(body.replace('instance=new Alias','instance=other')),
  fixture(body.replace('native.BaseModuleController','native.OtherController')),
  {...fixture(),'_oschunk-WRAPPER.js':"export{default}from './_oschunk-WRAPPER.js';"}]){
  assert.throws(()=>inspectOdcApplicationController(files,importer),/debug_odc_application_controller_/);
 }
 assert.throws(()=>inspectOdcApplicationController(fixture(),{resolved:true,imports:['https://outside.test/app.js']}),/import/);
});
