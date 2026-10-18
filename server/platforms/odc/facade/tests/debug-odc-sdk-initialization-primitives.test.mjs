import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {qualifyOdcSdkInitializationPrimitives} from '../debug-odc-sdk-initialization-primitives.mjs';
const file='_oschunk-SDK.js',contract={file,helperExport:'a',controllerExport:'I'};
const source=`var define=Object.defineProperty,name=(t,e)=>define(t,"name",{value:e,configurable:true});
var Registry=class{constructor(){this.definitions=new Map;this.cache=new Map}registerTypeDefinition(e,n){this.definitions.set(e,n)}};
var registry=new Registry;var Parent=class{static registerVariableGroupType(e,n){registry.registerTypeDefinition(e,n)}};
var Controller=class extends Parent{};var ns=Object.freeze({BaseModuleController:Controller});export{name as a,ns as I};`;
const qualify=s=>qualifyOdcSdkInitializationPrimitives({[file]:s??source},contract);
test('native naming and deferred type registration qualify only their bounded effects',()=>{
 const r=qualify();assert.equal(r.naming.qualified,true);assert.equal(r.variableGroupRegistration.qualified,true);
 assert.equal(r.variableGroupRegistration.effect,'native-map-definition-storage');assert.equal(r.applicationStartupQualified,false);assert.equal(r.executionAuthorized,false);
 assert.equal(qualify(source.replace('configurable:true','configurable:!0')).naming.qualified,true);
});
test('naming side effects, altered arguments and shadowed builtins fail qualification',()=>{
 for(const s of [source.replace('"name",{','"other",{'),source.replace('value:e','value:t'),source.replace('configurable:true','configurable:false'),
  source.replace('define(t,"name",{value:e,configurable:true})','(send(),define(t,"name",{value:e,configurable:true}))'),
  'var Object=custom;'+source,'import Map from "other";'+source])assert.throws(()=>qualify(s),/debug_odc_(sdk_initialization|sdk_binding)_/);
});
test('variable registration refuses execution of defaults, custom maps and extra constructor effects',()=>{
 for(const s of [source.replace('registry.registerTypeDefinition(e,n)','registry.registerTypeDefinition(e,n());send()'),
  source.replace('this.definitions.set(e,n)','this.definitions.set(e,n.defaultValue())'),source.replace('new Map','new CustomMap'),
  source.replace('this.cache=new Map','this.cache=new Map;send()'),source.replace('this.cache=new Map','this.definitions=new Map'),
  source.replace('this.definitions.set(e,n)','this.definitions.clear(e,n)')])assert.throws(()=>qualify(s),/debug_odc_sdk_initialization_/);
});
