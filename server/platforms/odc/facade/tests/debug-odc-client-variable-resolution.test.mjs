import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {qualifyOdcClientVariableResolution} from '../debug-odc-client-variable-resolution.mjs';
const file='_oschunk-SDK.js',source=`var cache={};function register(key,factory){cache[key]=factory()}function resolve(key){return cache[key]}function remove(key){delete cache[key]}
var container={register:register,resolve:resolve,unregister:remove};var Services;(function(t){t.ClientVariablesService="ClientVariablesService"})(Services||(Services={}));export{container as h,Services as i};`;
const qualify=s=>qualifyOdcClientVariableResolution({[file]:s??source},{file});
test('native resolve is a cache read, distinct from the service registration factory',()=>{
 const r=qualify();assert.equal(r.qualified,true);assert.equal(r.constructsService,false);assert.equal(r.serviceAvailabilityProven,false);
 assert.deepEqual(r.cacheUses,{reads:1,writes:1,deletes:1});assert.equal(r.executionAuthorized,false);
 assert.equal(qualify(source.replace('t.ClientVariablesService="ClientVariablesService"','t.ClientVariablesService="ClientVariablesService",t.Other="Other"')).qualified,true);
 assert.equal(qualify(source.replace('delete cache[key]','Reflect.deleteProperty(cache,key)')).cacheUses.deletes,1);
});
test('lazy construction, resolver effects, cache escape and reflective getters are refused',()=>{
 for(const s of [source.replace('return cache[key]','return cache[key]||create()'),source.replace('return cache[key]','send();return cache[key]'),
  source+'var escaped=cache;',source+'Object.defineProperty(cache,"ClientVariablesService",{get(){send()}});',
  source.replace('var cache={}','var cache=external'),source.replace('cache[key]=factory()','cache[key]+=factory()'),
  'var Reflect=custom;'+source.replace('delete cache[key]','Reflect.deleteProperty(cache,key)')])
  assert.throws(()=>qualify(s),/debug_odc_client_variable_resolution_/);
});
