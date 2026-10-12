import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectOdcRecordDeclaration,createOdcRecordInitializationInspector} from '../debug-odc-record-initialization.mjs';
const source=`import {w as sdk,a as name} from './_oschunk-SDK.js';
var C=class C extends sdk.GenericRecord {
 static attributesToDeclare(){return [this.attr('Count','countVar','Count',!0,!1,sdk.DataTypes.Integer,function(){return 0},!1),this.attr('Label','labelVar','Label',!0,!1,sdk.DataTypes.Text,function(){return ''},!1)].concat(sdk.GenericRecord.attributesToDeclare.call(this))}
};name(C,'VariablesRecord');var Record=C;Record.init();
var Model=class Model {static getVariablesRecordConstructor(){return Record}};var modelFactory=new sdk.ModelFactory(Model);`;
test('record declaration keeps native inheritance, defaults and initializer identity',()=>{
 const r=inspectOdcRecordDeclaration(source,'Record');
 assert.equal(r.classLocal,'C');assert.equal(r.namespace,'sdk');
 assert.deepEqual(r.fields.map(f=>[f.name,f.dataType,f.defaultValue]),[['Count','Integer',0],['Label','Text','']]);
 assert.match(r.classSha256,/^[a-f0-9]{64}$/);
});
test('computed defaults, class effects, overridden SDK inheritance and malformed attrs are refused',()=>{
 for(const mutate of [
  s=>s.replace('return 0','return fetch()'),
  s=>s.replace('static attributesToDeclare()', 'static {fetch()} static attributesToDeclare()'),
  s=>s.replace('sdk.GenericRecord.attributesToDeclare.call(this)','other.attributesToDeclare.call(this)'),
  s=>s.replace("this.attr('Count'","this.other('Count'"),
  s=>s.replace('sdk.DataTypes.Integer','sdk.DataTypes.Record'),
  s=>s.replace("function(){return 0}","function(){return '0'}"),
  s=>s.replace('Record.init();',''),
  s=>s.replace('Record.init();','Record.init();Record.init();'),
 ])assert.throws(()=>inspectOdcRecordDeclaration(mutate(source),'Record'),/record_initialization_/);
});
test('alias mutations, indirect mutation calls and class escapes are refused',()=>{
 for(const suffix of ['Record.init=evil;','var Alias=Record;Alias.Attributes=[];','evil(Record);','Object.defineProperty(Record,"init",{});','new Record();','Record.other();','var escape={record:Record};','evil({record:Record});'])
  assert.throws(()=>inspectOdcRecordDeclaration(source+suffix,'Record'),/record_initialization_/);
});
test('the selected record alias must be initialized after its source class',()=>{
 const changed=source.replace('var C=class','var Record=C;var C=class').replace('var Record=C;Record.init();','Record.init();');
 assert.throws(()=>inspectOdcRecordDeclaration(changed,'Record'),/alias_order/);
});
test('generated shape alone cannot qualify an unreviewed native SDK',()=>{
 const files={'_oschunk-VIEW.js':source,'_oschunk-SDK.js':`class GenericRecord{};var sdk=Object.freeze({GenericRecord});export {sdk as w};`};
 assert.throws(()=>createOdcRecordInitializationInspector(files)({chunk:'_oschunk-VIEW.js',modelFactory:'modelFactory'}),/sdk_unreviewed/);
});
