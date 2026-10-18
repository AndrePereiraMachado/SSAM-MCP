import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {qualifyOdcNativeDataTypes} from '../debug-odc-native-data-types.mjs';
const file='_oschunk-SDK.js',source='var E;(function(t){t[t.Integer=0]="Integer",t[t.Text=4]="Text"})(E||(E={}));var ns=Object.freeze({get DataTypes(){return E}});export{ns as w};';
const qualify=s=>qualifyOdcNativeDataTypes({[file]:s??source},{file,exported:'w'});
test('native enum values are read from source without calling its IIFE or getter',()=>{
 const r=qualify();assert.deepEqual(r.types,{Integer:0,Text:4});assert.equal(r.qualified,true);assert.equal(r.executionAuthorized,false);
});
test('extra calls, reverse-map mismatches, duplicates and computed member names fail',()=>{
 for(const s of [source.replace('t[t.Text=4]="Text"','send()'),source.replace('t[t.Text=4]="Text"','t[t.Text=4]="Other"'),
  source.replace('Text=4','Text=0'),source.replace('t.Text=4','t.Integer=4'),source.replace('t.Text=4','t[key]=4'),
  source.replace('return E','send();return E'),source.replace('function(t)','async function(t)'),source.replace('Text=4','__proto__=4')])
  assert.throws(()=>qualify(s),/debug_odc_data_types_/);
});
