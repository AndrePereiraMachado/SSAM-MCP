import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {configurationVaultPlan} from '../runtime/configuration-vault-plan.mjs';
const secret={key:'password',isSecret:true},integration={key:'api',pluginType:'RESTConsume',configs:[secret,{key:'url',isSecret:false}]};
const metadata=()=>({libraries:[{key:'lib',revision:2,revisionBaseline:2,settings:[secret],integrations:[integration]}],integrations:[integration]});
test('nested vault selectors resolve exact metadata and preserve input while creating empty placeholders',()=>{
 const current=metadata(),patch={key:'app',libraries:[{key:'lib',revision:2,settings:[{key:'public',value:'retained'}]}]};
 const before=structuredClone({current,patch});
 const r=configurationVaultPlan('test.outsystems.dev',current,patch,[{libraryKey:'lib',settingKey:'password',entry:'LibrarySecret'},{libraryKey:'lib',integrationKey:'api',settingKey:'password',entry:'RestSecret'},{integrationKey:'api',settingKey:'password',entry:'TopRestSecret'}]);
 assert.deepEqual({current,patch},before);
 assert.deepEqual(r.refs.map(x=>x.pointer),['/libraries/0/settings/1/value','/libraries/0/integrations/0/configs/0/value','/integrations/0/configs/0/value']);
 assert.equal(r.body.libraries[0].settings[0].value,'retained');
 assert.equal(r.body.libraries[0].integrations[0].configs[0].value,'');
 assert.equal(r.refs[0].target,'SSAM/ODC3/test.outsystems.dev/Setting/LibrarySecret');
});
test('nested vault selectors reject ambiguous, public, duplicate, stale and raw-value inputs atomically',()=>{
 const selector={libraryKey:'lib',integrationKey:'api',settingKey:'password',entry:'Secret'};
 for(const s of [{...selector,value:'not-allowed'},{...selector,entry:'../other'},{...selector,settingKey:'url'},{...selector,libraryKey:'missing'},{...selector,integrationKey:''},{settingKey:'password',entry:'Secret'}])assert.throws(()=>configurationVaultPlan('test',metadata(),{},[s]));
 assert.throws(()=>configurationVaultPlan('test',metadata(),{},[selector,selector]));
 for(const mutate of [m=>m.libraries.push(structuredClone(m.libraries[0])),m=>m.libraries[0].revisionBaseline=3,m=>m.libraries[0].integrations.push(integration),m=>m.libraries[0].integrations[0].configs.push(secret)]){
  const m=structuredClone(metadata());mutate(m);assert.throws(()=>configurationVaultPlan('test',m,{},[selector]));
 }
 for(const patch of [{libraries:[{key:'lib',revision:1}]},{libraries:[{key:'lib',revision:2,integrations:[{key:'api',configs:[{key:'password',value:''}]}]}]}]){
  const before=structuredClone(patch);assert.throws(()=>configurationVaultPlan('test',metadata(),patch,[selector]));assert.deepEqual(patch,before);
 }
});
