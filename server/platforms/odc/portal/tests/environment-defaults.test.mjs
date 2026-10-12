import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {environmentDefaultsPlan,environmentDefaultsObservation} from '../runtime/environment-defaults.mjs';
const environmentKey=crypto.randomUUID(),row={key:'Name',isSecret:false,dataType:'Text',value:'Original',defaultValue:'Default',valueOrigin:'EnvironmentLevelOverride'};
const result=()=>({ok:true,data:{systemConfigurations:[structuredClone(row),{key:'Password',isSecret:true,dataType:'Text',value:'private',valueOrigin:'EnvironmentLevelOverride'}]}});
test('public environment configuration has exact restoration and no private secret value in plan',()=>{
 const p=environmentDefaultsPlan({result:result(),environmentKey,body:{systemConfigurations:[{key:'Name',value:'Temporary'}]}});
 assert.equal(JSON.stringify(p).includes('private'),false);assert.equal(p.restore.body.systemConfigurations[0].value,'Original');
 const live={ok:true,data:{systemConfigurations:structuredClone(p.after)}};
 assert.equal(environmentDefaultsObservation(p.after,live).verified,true);
 const restored=environmentDefaultsPlan({result:live,environmentKey,body:p.restore.body});assert.deepEqual(restored.after,p.before);
 live.data.systemConfigurations[0].value='Concurrent';assert.equal(environmentDefaultsObservation(p.after,live).verified,false);
});
test('default origin restores with null; timestamps are not configuration drift',()=>{
 const r=result();Object.assign(r.data.systemConfigurations[0],{value:'Default',valueOrigin:'EnvironmentLevelDefault',updatedAt:'old'});
 const p=environmentDefaultsPlan({result:r,environmentKey,body:{systemConfigurations:[{key:'Name',value:'Temporary'}]}});
 assert.equal(p.restore.body.systemConfigurations[0].value,null);
 const restore=environmentDefaultsPlan({result:{ok:true,data:{systemConfigurations:p.after}},environmentKey,body:p.restore.body});
 assert.deepEqual(restore.after,p.before);
});
test('unknown, secret, duplicate, binary, invalid type, partial baseline and extra fields refuse',()=>{
 for(const changes of [[{key:'Password',value:'x'}],[{key:'Unknown',value:'x'}],[{key:'Name',value:'x'},{key:'Name',value:'y'}],[{key:'Name',value:1}],[{key:'Name',value:'x',filename:'x'}]])
  assert.throws(()=>environmentDefaultsPlan({result:result(),environmentKey,body:{systemConfigurations:changes}}));
 for(const mutate of [r=>r.ok=false,r=>r.data.systemConfigurations.push(row),r=>delete r.data.systemConfigurations[0].defaultValue,r=>r.data.systemConfigurations[0].dataType='BinaryData']){
  const r=result();mutate(r);assert.throws(()=>environmentDefaultsPlan({result:r,environmentKey,body:{systemConfigurations:[{key:'Name',value:'x'}]}}));
 }
});
