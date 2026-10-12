import test from 'node:test';import assert from 'node:assert/strict';
import {createOdcSdkBindingReader} from '../debug-odc-native-sdk-binding.mjs';
const file='_oschunk-SDK.js',dependency={file:'./'+file,export:'x',member:'read'};
const source='function original(value){return value};var alias=original,ns=Object.freeze({__proto__:null,read:alias});export{ns as x};';
test('namespace members bind through original aliases without claiming effect qualification',()=>{
 const r=createOdcSdkBindingReader({[file]:source})(dependency);
 assert.equal(r.symbol,'original');assert.equal(r.declarationKind,'FunctionDeclaration');assert.equal(r.sourceBound,true);assert.equal(r.effectsQualified,false);
 assert.equal(source.slice(r.start,r.end),'function original(value){return value}');
 const getter=source.replace('read:alias','get read(){return alias}');
 assert.equal(createOdcSdkBindingReader({[file]:getter})(dependency).symbol,'original');
});
test('computed properties, executable getters, cycles and unbound exports are refused',()=>{
 for(const s of [source.replace('read:alias','[key]:alias'),source.replace('read:alias','get read(){send();return alias}'),
  source.replace('alias=original','alias=alias'),source.replace('ns as x','ns as y'),source.replace('read:alias','read:factory()'),
  'var Object=custom;'+source])assert.throws(()=>createOdcSdkBindingReader({[file]:s})(dependency),/debug_odc_sdk_binding_/);
});
test('source mutations bind to different evidence and do not execute source',()=>{
 const first=createOdcSdkBindingReader({[file]:source})(dependency),second=createOdcSdkBindingReader({[file]:source.replace('return value','throw Error("never execute")')})(dependency);
 assert.notEqual(first.chunkSha256,second.chunkSha256);assert.notEqual(first.declarationSha256,second.declarationSha256);assert.equal(second.effectsQualified,false);
});

test('direct exported helpers and container initializers bind without running their factories',()=>{
 const source='function helper(a,b){return a}const alias=helper,container=createContainer();export{alias as a,container as h};';
 const bind=createOdcSdkBindingReader({[file]:source});
 const helper=bind.exportDeclaration({file:'./'+file,export:'a'});
 assert.equal(helper.symbol,'helper');assert.equal(helper.declarationKind,'FunctionDeclaration');
 const container=bind.exportDeclaration({file:'./'+file,export:'h'});
 assert.equal(container.symbol,'container');assert.equal(container.declarationKind,'CallExpression');
 assert.equal(source.slice(container.start,container.end),'createContainer()');assert.equal(container.effectsQualified,false);
 assert.throws(()=>bind.exportDeclaration({file:'./'+file,export:'missing'}),/declaration_unresolved/);
 assert.throws(()=>bind.exportDeclaration({file:'./'+file,export:'a',member:'run'}),/dependency/);
});

test('native string enum namespace binds literal members without executing its initializer',()=>{
 const source='var W;(function(t){t.ClientVariablesService="ClientVariablesService",t.Other="Other"})(W||(W={}));export{W as i};';
 const dep={file:'./'+file,export:'i',member:'ClientVariablesService'};
 const r=createOdcSdkBindingReader({[file]:source})(dep);
 assert.equal(r.namespaceKind,'literal-enum');assert.equal(r.declarationKind,'Literal');assert.equal(r.effectsQualified,false);
 assert.equal(source.slice(r.start,r.end),'"ClientVariablesService"');
 for(const change of [source.replace('t.Other="Other"','send()'),source.replace('t.Other="Other"','t.ClientVariablesService="Other"'),
  source.replace('t.Other="Other"','t[key]="Other"'),source.replace('t.Other="Other"','t.__proto__="Other"'),
  source.replace('function(t)','async function(t)'),source.replace('t.Other="Other"','t.Other=read()')])
  assert.throws(()=>createOdcSdkBindingReader({[file]:change})(dep),/enum_initializer/);
});
