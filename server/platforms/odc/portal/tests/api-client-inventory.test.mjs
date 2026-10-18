import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {apiClientInventoryInput,collectApiClientInventory,apiClientAbsent} from '../runtime/api-client-inventory.mjs';
const raw=(StartIndex=0,NameContains='')=>({inputParameters:{},clientVariables:{},screenVariables:{StartIndex,MaxRecords:1,Filter:{NameContains,Status:''}}});
const rows=[{Key:crypto.randomUUID(),Name:'A'},{Key:crypto.randomUUID(),Name:'B'}];
const response=(list,total=2)=>({ok:true,data:{APIClientsList:{List:list},Pagination:{TotalResults:String(total),Limit:'0',Offset:'0',Count:'0'}}});
test('inventory uses requested offsets, stable totals and distinct IDs despite zero native counters',async()=>{
 const offsets=[];const result=await collectApiClientInventory({raw:raw(),result:response(rows.slice(0,1)),maxPages:3,read:async input=>{offsets.push(input.screenVariables.StartIndex);return response(rows.slice(1));}});
 assert.deepEqual(offsets,[1]);assert.equal(result.complete,true);assert.deepEqual(result.rows,rows);assert.equal(result.nativePaginationCountersVerified,false);
 assert.equal(apiClientAbsent({key:crypto.randomUUID(),name:'Absent'},{ok:true,...result}),true);
 assert.equal(apiClientAbsent({key:rows[0].Key,name:'Absent'},{ok:true,...result}),false);
 assert.equal(apiClientAbsent({key:crypto.randomUUID(),name:'A'},{ok:true,...result}),false);
 for(const changed of [{complete:false},{ok:false},{requestedPageConsistencyVerified:false},{requestedOffset:1},{scope:{NameContains:'Absent',Status:''}},{scope:{NameContains:'',Status:'Available'}},{totalResults:3},{rows:[{Key:4}]},{rows:[rows[0],rows[0]]}])
  assert.equal(apiClientAbsent({key:crypto.randomUUID(),name:'Absent'},{ok:true,...result,...changed}),false);
});
test('bounded and nonzero-offset scans cannot claim complete inventory',async()=>{
 const result=await collectApiClientInventory({raw:raw(),result:response(rows.slice(0,1)),maxPages:1,read:()=>{throw Error('must not read');}});
 assert.equal(result.complete,false);assert.equal(result.nextInput.screenVariables.StartIndex,1);
 const tail=await collectApiClientInventory({raw:raw(1),result:response(rows.slice(1)),maxPages:3,read:()=>{throw Error('must not read');}});
 assert.equal(tail.complete,false);assert.equal(tail.nextPageAvailable,false);
});
test('malformed input and contradictory pages never produce a verified absence',async()=>{
 for(const changed of [{StartIndex:-1},{StartIndex:1.1},{MaxRecords:0},{MaxRecords:101},{Filter:{NameContains:''}},{Extra:true}]){
  const input=raw();Object.assign(input.screenVariables,changed);assert.throws(()=>apiClientInventoryInput(input),{code:'INPUT_INVALID'});
 }
 for(const next of [response(rows.slice(0,1)),response([],2),response(rows.slice(1),3),response([{Key:'invalid',Name:'X'}])])
  await assert.rejects(collectApiClientInventory({raw:raw(),result:response(rows.slice(0,1)),maxPages:3,read:async()=>next}),{code:'API_CLIENT_INVENTORY_UNVERIFIED'});
 for(const total of [-1,'invalid','1.2',null])await assert.rejects(collectApiClientInventory({raw:raw(),result:{ok:true,data:{APIClientsList:{List:[]},Pagination:{TotalResults:total}}},maxPages:3}),{code:'API_CLIENT_INVENTORY_UNVERIFIED'});
});
