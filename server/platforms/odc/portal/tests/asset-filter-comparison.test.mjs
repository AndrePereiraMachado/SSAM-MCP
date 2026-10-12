import test from 'node:test';import assert from 'node:assert/strict';
import {assetFilterComparison as compare} from '../runtime/asset-filter-comparison.mjs';
const op='asset-repository-api-v1:get:/assets';
const input=value=>({query:{'metadata.isDeployable':value}});
const row=(key,value)=>({assetKey:key,revision:2,_embedded:{metadata:{isDeployable:value}}});
test('deployability contradictions are reported without changing native rows or totals',()=>{
 const output={ok:true,data:{results:[row('a',true),row('b',false)],page:{totalResults:2}}};
 const original=JSON.stringify(output);const result=compare(op,input(true),output);
 assert.equal(result.consistent,false);assert.equal(result.compared,2);
 assert.deepEqual(result.mismatches,[{assetKey:'b',revision:2,observed:false}]);
 assert.equal(JSON.stringify(output),original);assert.equal(result.fullInventoryVerified,false);
 assert.equal(compare(op,input(false),output).mismatches[0].assetKey,'a');
});
test('empty and absent metadata cannot certify the filter',()=>{
 for(const rows of [[],[{}],[row('a',true),{}],[row('a','true')]]){
  const result=compare(op,input(true),{ok:true,data:{results:rows}});assert.equal(result.consistent,null);
 }
 assert.equal(compare(op,input(true),{ok:true,data:{}}).consistent,null);
 assert.equal(compare(op,input(false),{ok:true,data:{results:[row('a',false)]}}).consistent,true);
});
test('comparison is scoped to successful filtered asset listings',()=>{
 assert.equal(compare(op,input(true),{ok:false}),null);
 assert.equal(compare(op,{}, {ok:true}),null);
 assert.equal(compare(op,input('true'),{ok:true}),null);
 assert.equal(compare('other',input(true),{ok:true}),null);
});
