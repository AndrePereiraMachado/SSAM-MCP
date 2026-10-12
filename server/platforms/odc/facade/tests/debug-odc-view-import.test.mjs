import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectOdcViewImportSyntax} from '../debug-odc-view-import.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const source=`import {I as controllers,a as name,w as data} from './_oschunk-CORE.js';
var vendor=0;
var metadata={key:{getter:name(function(){throw new Error('deferred')},'getter'),dataType:data.DataTypes.Integer}};
OutSystemsDebugger.registerMetaInfo(metadata);
{let C=class C extends controllers.BaseViewController{run(){throw new Error('deferred')}};name(C,'Controller');let alias=C;Controller=alias,Controller.registerVariableGroupType('scope',[{name:'Value',defaultValue:name(function(){return 0},'defaultValue')}]);}
var Controller;export {Controller};`;
function contract(s){const start=s.indexOf('var vendor=0;');return {region:{start,end:start+13,regionSha256:hash('var vendor=0;')},
 coreFile:'_oschunk-CORE.js',uiFile:'_oschunk-UI.js',dataTypes:['Integer'],factoryOffsets:[],recordClasses:[],recordInitOffsets:[],modelClasses:[],componentFunctions:[]};}
test('covers generated metadata and controller registration without executing retained bodies',()=>{
 const r=inspectOdcViewImportSyntax(source,contract(source));assert.equal(r.syntaxCovered,true);
 assert.equal(r.executionAuthorized,false);
 assert.equal(r.effects.filter(e=>e.kind==='native-variable-group-registration').length,1);
 assert.equal(r.effects.filter(e=>e.kind==='native-debugger-metadata-registration').length,1);
});
test('extra top-level effects and static class execution cannot hide in a reviewed view',()=>{
 for(const mutate of [
  s=>s+'send();',s=>s+'(()=>send())();',s=>s.replace('run(){','static {send()}run(){'),
  s=>s.replace('run(){','static value=send();run(){'),s=>s.replace('run(){','[send()](){'),
  s=>s.replace('run(){','static registerVariableGroupType(){send()}run(){'),
  s=>s.replace('run(){','static set _hasValidationWidgetsValue(v){send()}run(){'),
 ]){const s=mutate(source);assert.throws(()=>inspectOdcViewImportSyntax(s,contract(s)),/view_import_/);}
});
test('metadata getters, inherited hasOwnProperty and unbound property reads are refused',()=>{
 for(const mutate of [
  s=>s.replace('key:{','get key(){return send()},other:{'),
  s=>s.replace('key:{','hasOwnProperty:function(){send()},key:{'),
  s=>s.replace('key:{','__proto__:{},key:{'),
  s=>s.replace('data.DataTypes.Integer','data.secret'),
  s=>s.replace('data.DataTypes.Integer','data.DataTypes.Unknown'),
 ]){const s=mutate(source);assert.throws(()=>inspectOdcViewImportSyntax(s,contract(s)),/view_import_/);}
});
test('shadowed helpers and receiver rebinding cannot inherit native registration authority',()=>{
 for(const mutate of [
  s=>s.replace('let C=class','let name=function(){};let C=class'),
  s=>s.replace('Controller=alias,','Controller={},'),
  s=>s.replace('var metadata=', 'var OutSystemsDebugger={};var metadata='),
  s=>s+'controllers=Controller;',s=>s+'Controller.prototype.run=function(){};',
  s=>s.replace('let C=class','var C=class'),
 ]){const s=mutate(source);assert.throws(()=>inspectOdcViewImportSyntax(s,contract(s)),/view_import_/);}
});
test('region boundaries and original bytes must match before any syntax coverage is claimed',()=>{
 const c=contract(source);
 for(const region of [{...c.region,start:c.region.start+1},{...c.region,regionSha256:'0'.repeat(64)}])
  assert.throws(()=>inspectOdcViewImportSyntax(source,{...c,region}),/view_import_region/);
});
test('declarations outside the reviewed vendor region cannot replace its hoisted bindings',()=>{
 for(const s of [source+'var vendor=function(){throw new Error("unexpected")};',
  source.replace('var metadata=', 'var vendor=1;var metadata=')])
  assert.throws(()=>inspectOdcViewImportSyntax(s,contract(s)),/vendor_binding_collision/);
});
