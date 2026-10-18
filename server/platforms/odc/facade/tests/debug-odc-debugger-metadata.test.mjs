import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {qualifyOdcDebuggerMetadata} from '../debug-odc-debugger-metadata.mjs';
const file='_oschunk-DEBUGGER.js';
const source='var Debugger=class{registerMetaInfo(e){this.metaInfoMap||(this.metaInfoMap=new Map);for(let key in e)e.hasOwnProperty(key)&&!this.metaInfoMap.get(key)&&this.metaInfoMap.set(key,e[key])}};var target=typeof window!=="undefined"?window:global;target.OutSystemsDebugger=new Debugger;';
const qualify=s=>qualifyOdcDebuggerMetadata({[file]:s??source});
test('native metadata registration is tied to the globally installed debugger class',()=>{
 const r=qualify();assert.equal(r.qualified,true);assert.equal(r.effect,'native-metadata-map-storage');assert.equal(r.executionAuthorized,false);
 assert.equal(r.requiredInput,'own-data-properties-with-original-hasOwnProperty');
});
test('extra effects, getter invocation, changed guards and custom maps fail',()=>{
 for(const s of [source.replace('e[key])','e[key].getter())'),source.replace('new Map','new CustomMap'),
  source.replace('e.hasOwnProperty(key)','accept(key)'),source.replace('!this.metaInfoMap.get(key)','this.metaInfoMap.get(key)'),
  source.replace('registerMetaInfo(e){','registerMetaInfo(e){send();'),source.replace('class{','class{constructor(){this.metaInfoMap=custom}'),
  source.replace('class{','class{constructor(){this.registerMetaInfo=custom}'),source.replace('class{','class{constructor(){return custom}'),
  source.replace('class{','class{constructor(){this[key]=custom}'),
  source.replace('class{','class{get metaInfoMap(){return custom}'),source.replace('?window:global','?other:global')])
  assert.throws(()=>qualify(s),/debug_odc_debugger_metadata_/);
});
test('decoy methods, multiple installations and shadowed globals cannot bind',()=>{
 assert.throws(()=>qualify(source.replace('target.OutSystemsDebugger=new Debugger','target.other=new Debugger')),/installation/);
 assert.throws(()=>qualify(source+'target.OutSystemsDebugger=new Debugger;'),/installation/);
 assert.throws(()=>qualify('var Map=custom;'+source),/builtin_shadowed/);
});

test('runtime debugger inheritance binds the nearest method and refuses overriding storage',()=>{
 const inherited=source.replace('var target=','var Runtime=class extends Debugger{callDebugger(){}};var target=').replace('new Debugger','new Runtime');
 assert.equal(qualify(inherited).hierarchySha256.length,2);
 assert.throws(()=>qualify(inherited.replace('callDebugger(){}','registerMetaInfo(e){send(e)}')),/method|map/);
 assert.throws(()=>qualify(inherited.replace('callDebugger(){}','get metaInfoMap(){return custom}')),/map_accessor/);
});
