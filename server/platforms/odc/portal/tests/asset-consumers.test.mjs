import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {readAssetConsumers} from '../runtime/asset-consumers.mjs';
const ok=data=>({ok:true,status:200,data});
test('consumer inspection covers default, every stage and multiple revisions, preserving distinct identities',async()=>{
 const scopes=[];
 const result=await readAssetConsumers('producer',async(id,input)=>{
  if(id.startsWith('asset-repository'))return ok({name:'Library'});
  if(id.startsWith('portfolio'))return ok({results:[{key:'dev'},{key:'test'},{key:'prod'}]});
  assert.equal(input.query.allowMultipleVersions,true);scopes.push(input.query.environmentKey??'default');
  return ok({results:input.query.environmentKey==='test'?[{key:'consumer',name:'TestOnly',revision:1},{key:'consumer',name:'TestOnly',revision:2},{key:'other',name:'TestOnly',revision:1},{key:'consumer',name:'Renamed',revision:3}]:[]});
 });
 assert.equal(result.ok,true);assert.deepEqual(scopes,['default','dev','test','prod']);assert.equal(result.consumers.length,3);
});
test('malformed consumers and incomplete or inconsistent environment reads never prove absence',async()=>{
 for(const row of [{key:'consumer'}, {name:'UnnamedKey'}, {key:'producer',name:'Self'},null]){
  const result=await readAssetConsumers('producer',async id=>id.startsWith('asset-repository')?ok({name:'Library'}):id.startsWith('portfolio')?ok({results:[{key:'dev'}]}):ok({results:[row]}));
  assert.equal(result.ok,false);assert.equal(result.code,'DEPENDENCY_CHECK_UNAVAILABLE');
 }
 for(const stages of [[],[{key:'dev'},{key:'dev'}],[{}],null]){
  const result=await readAssetConsumers('producer',async id=>id.startsWith('asset-repository')?ok({name:'Library'}):ok({results:stages}));assert.equal(result.ok,false);
 }
 const failed=await readAssetConsumers('producer',async(id,input)=>id.startsWith('asset-repository')?ok({name:'Library'}):id.startsWith('portfolio')?ok({results:[{key:'dev'}]}):input.query.environmentKey?{ok:false,status:403}:ok({results:[]}));
 assert.equal(failed.ok,false);
});
