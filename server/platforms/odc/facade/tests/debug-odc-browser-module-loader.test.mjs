import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createOdcBrowserModuleLoader} from '../debug-odc-browser-module-loader.mjs';
const a='_oschunk-A.js',b='_oschunk-B.js',c='_oschunk-C.js';
// Use the serialized function as the browser does; no module-scope helpers.
const create=vm.runInNewContext('('+createOdcBrowserModuleLoader.toString()+')');
test('tracks native namespaces across cycles without evaluating a module twice',async()=>{
 const calls=[],values={[a]:{a:1},[b]:{b:2}};
 const loader=create({[a]:['./'+b],[b]:['./'+a]},async file=>{calls.push(file);return values[file];});
 assert.equal(await loader.load(a),values[a]);assert.equal(await loader.load(b),values[b]);
 assert.deepEqual(calls,[a,b]);assert.equal(loader.loadedModule(b),values[b]);
});
test('validates all dependencies before the first native import',async()=>{
 for(const graph of [{[a]:['./'+b]},{[a]:['./'+b],[b]:['https://other.example/'+c]},
  {[a]:['./'+b],[b]:null},{[a]:['./../'+b]}]){
  let count=0;const loader=create(graph,async()=>{count++;return {};});
  await assert.rejects(loader.load(a),/graph_unbound/);assert.equal(count,0);
 }
});
test('concurrent callers await the same native import and dependency tracking',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),calls=[];
 const loader=create({[a]:['./'+b],[b]:[]},async file=>{calls.push(file);await gate;return {file};});
 let settled=false;const first=loader.load(a),second=loader.load(a).then(value=>{settled=true;return value;});
 await Promise.resolve();assert.equal(settled,false);assert.equal(loader.loadedModule(a),undefined);
 release();assert.equal(await first,await second);assert.deepEqual(calls,[a,b]);
});
test('failed imports stay rejected without replay or a successful undefined result',async()=>{
 const error=new Error('native failure');let count=0;
 const loader=create({[a]:[]},async()=>{count++;throw error;});
 for(let i=0;i<2;i++)await assert.rejects(loader.load(a),e=>e===error);
 assert.equal(count,1);assert.equal(loader.loadedModule(a),undefined);
});
test('a failed dependency tracking import remains a failure for the root',async()=>{
 const calls=[];const loader=create({[a]:['./'+b],[b]:[]},async file=>{
  calls.push(file);if(file===b)throw new Error('dependency');return {};
 });
 for(let i=0;i<2;i++)await assert.rejects(loader.load(a),/dependency/);
 assert.deepEqual(calls,[a,b]);
});
test('disposal prevents pending imports from repopulating native references',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);
 const loader=create({[a]:[]},async()=>{await gate;return {};});
 const pending=loader.load(a);await Promise.resolve();loader.dispose();release();
 await assert.rejects(pending,/disposed/);assert.equal(loader.loadedModule(a),undefined);
 assert.equal(loader.values().length,0);await assert.rejects(loader.load(a),/disposed/);
});
