import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectOdcModelDeclaration} from '../debug-odc-model-construction.mjs';
const fixture=`import {M as sdk,a as name} from './_oschunk-SDK.js';
var WidgetClass=class WidgetClass extends sdk.BaseWidgetRecordMap {static getWidgetsType(){return {Input:sdk.ValidationWidgetRecord}}};
name(WidgetClass,'WidgetsRecord');var Widgets=WidgetClass;
var ModelClass=class ModelClass extends sdk.BaseViewModel {
static getVariablesRecordConstructor(){return Variables}
static getWidgetsRecordConstructor(){return Widgets}
static get hasValidationWidgets(){return !0}
setInputs(input){}
};name(ModelClass,'Model');var Model=ModelClass;Model._hasValidationWidgetsValue=void 0;
var factory=new sdk.ModelFactory(Model);var options={modelFactory:factory};export {factory as modelModule};`;
test('generated model construction binds native bases and declared validation widgets',()=>{
 const p=inspectOdcModelDeclaration(fixture,'factory');
 assert.equal(p.variablesRecord,'Variables');assert.equal(p.widgetsRecord,'Widgets');
 assert.equal(p.hasValidationWidgets,true);assert.equal(p.widgetTypes[0].name,'Input');
 assert.equal(p.widgetTypes[0].binding.member,'ValidationWidgetRecord');assert.equal(p.setInputsQualified,false);
});
test('widget-free blocks retain their native hasValidationWidgets false branch',()=>{
 const p=inspectOdcModelDeclaration(fixture.replace('{Input:sdk.ValidationWidgetRecord}','{}').replace('return !0','return !1'),'factory');
 assert.equal(p.hasValidationWidgets,false);assert.deepEqual(p.widgetTypes,[]);
});
test('constructor overrides, extra callbacks, computed widgets and executable getters refuse',()=>{
 for(const change of [
  s=>s.replace('static getVariablesRecordConstructor()', 'constructor(){send()} static getVariablesRecordConstructor()'),
  s=>s.replace('return Variables','return getVariables()'),
  s=>s.replace('setInputs(input){}','setInputs(input){} static createDefaultData(){send()}'),
  s=>s.replace('Input:sdk.ValidationWidgetRecord','[compute()]:sdk.ValidationWidgetRecord'),
  s=>s.replace('sdk.ValidationWidgetRecord','CustomWidget'),
  s=>s.replace('return !0','return !1'),
  s=>s.replace('return Widgets','send();return Widgets'),
 ])assert.throws(()=>inspectOdcModelDeclaration(change(fixture),'factory'),/model_construction_/);
});
test('model and widget aliases cannot escape or override construction methods',()=>{
 for(const suffix of ['Model.createDefaultData=evil;','WidgetClass.getWidgetsType=evil;','var Alias=Model;Alias.hasVariables=false;','use({model:Model});'])
  assert.throws(()=>inspectOdcModelDeclaration(fixture+suffix,'factory'),/class_escape/);
});
test('native namespace rebinding and direct mutation APIs cannot change the selected constructors',()=>{
 for(const suffix of ['sdk.BaseViewModel=evil;','Object.assign(sdk,{BaseViewModel:evil});'])
  assert.throws(()=>inspectOdcModelDeclaration(fixture+suffix,'factory'),/sdk_write|sdk_escape/);
});
