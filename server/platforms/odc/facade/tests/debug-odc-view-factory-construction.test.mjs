import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyOdcViewFactoryConstruction} from '../debug-odc-view-factory-construction.mjs';
const view={chunk:'_oschunk-VIEW.js',modelFactory:'model',controllerFactory:'controller'};
function fixture(){return {
 '_oschunk-VIEW.js':'import {M as models,I as controllers} from "./_oschunk-SDK.js";var Model,Controller,locale;var model=new models.ModelFactory(Model),controller=new controllers.ControllerFactory(Controller,locale);',
 '_oschunk-SDK.js':'class MF{constructor(c){this.modelClass=c}create(){return new this.modelClass()}}class CF{constructor(c,l){this.controllerClass=c,this.messagesProvider=l}initialize(){throw new Error("deferred")}}var M=Object.freeze({ModelFactory:MF}),I=Object.freeze({ControllerFactory:CF});export {M,I};',
};}
test('native factory allocation retains class/provider without claiming creation or permissions',()=>{
 const r=qualifyOdcViewFactoryConstruction(fixture(),view);
 assert.equal(r.factoryConstructionQualified,true);assert.equal(r.factories.length,2);
 assert.equal(r.modelCreated,false);assert.equal(r.controllerCreated,false);assert.equal(r.permissionsChecked,false);
 assert.equal(r.executionAuthorized,false);assert.equal(r.viewInitializationQualified,false);
});
test('constructor side effects, inheritance, setters and argument evaluation are refused',()=>{
 for(const mutation of [
  s=>s.replace('this.modelClass=c','this.modelClass=invoke(c)'),
  s=>s.replace('class MF{','class MF extends External{'),
  s=>s.replace('create(){','set modelClass(v){send(v)}create(){'),
  s=>s.replace('this.controllerClass=c,this.messagesProvider=l','this.controllerClass=c,this.messagesProvider=l,send()'),
 ]){const f=fixture();f['_oschunk-SDK.js']=mutation(f['_oschunk-SDK.js']);assert.throws(()=>qualifyOdcViewFactoryConstruction(f,view),/view_factory_/);}
 const f=fixture();f[view.chunk]=f[view.chunk].replace('ModelFactory(Model)','ModelFactory(createModel())');
 assert.throws(()=>qualifyOdcViewFactoryConstruction(f,view),/view_factory_instance/);
});
test('matching member spelling does not admit a different SDK export',()=>{
 const f=fixture();f[view.chunk]=f[view.chunk].replace('M as models','I as models');
 assert.throws(()=>qualifyOdcViewFactoryConstruction(f,view),/sdk_binding_member/);
});
