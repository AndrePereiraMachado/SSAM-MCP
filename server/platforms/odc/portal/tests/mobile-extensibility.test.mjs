import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {MOBILE_EXTENSIBILITY_PATCH as operationId,extensibilityChanges,extensibilityStateHash,extensibilityExpectation,verifyExtensibility} from '../runtime/mobile-extensibility.mjs';
import {mobileConfigurationApproval,mobileConfigurationHash} from '../runtime/mobile-configuration-approval.mjs';
import {mobileConfigurationExpectation,verifyMobileConfiguration} from '../runtime/mobile-configuration-proof.mjs';
const field={key:'public',isSecret:false,dataType:'Text',value:'Original',defaultValue:'Original',valueOrigin:'Default',lastUpdateDate:'old'};
const current=()=>({settings:[structuredClone(field)],libraries:[]}),body={settings:[{key:'public',value:'Changed'}]};
test('extensibility supports exact public setting and verified default restoration',()=>{
 assert(extensibilityChanges(body,current()));const expected=extensibilityExpectation(body);
 assert.equal(JSON.stringify(expected).includes('Changed'),false);
 const observed={ok:true,status:200,data:current()};Object.assign(observed.data.settings[0],{value:'Changed',valueOrigin:'Override'});
 const receipt={identity:{operationId},reconciliation:{mobileConfiguration:mobileConfigurationExpectation(body)}};
 assert.equal(verifyMobileConfiguration(receipt,observed).verified,true);
 observed.data.settings[0].valueOrigin='Default';assert.equal(verifyExtensibility(expected,observed).verified,false);
 const reset=extensibilityExpectation({settings:[{key:'public',value:null}]});
 assert.equal(verifyExtensibility(reset,observed).verified,false);
 observed.data.settings[0].value='Original';assert.equal(verifyExtensibility(reset,observed).verified,true);
 observed.data.settings[0].valueOrigin='Override';assert.equal(verifyExtensibility(reset,observed).verified,false);
});
test('unknown fields, secrets, empty library edits and duplicate identities refuse',()=>{
 for(const b of [{settings:[]},{settings:[{key:'missing',value:'x'}]},{...body,libraries:[]},{settings:[...body.settings,...body.settings]},{settings:[{key:'public',value:1}]},{settings:[{key:'public',value:'x',unknown:[]}]}])assert.throws(()=>extensibilityChanges(b,current()));
 for(const change of [x=>x.isSecret=true,x=>x.dataType='BinaryData',x=>x.valueOrigin='unknown',x=>delete x.defaultValue]){
  const c=current();change(c.settings[0]);assert.throws(()=>extensibilityChanges(body,c));
 }
 const c=current(),hash=extensibilityStateHash(c);c.settings[0].lastUpdateDate='new';assert.equal(extensibilityStateHash(c),hash);
 c.settings[0].value='different';assert.notEqual(extensibilityStateHash(c),hash);
});

test('metadata-only writes and null reset verify metadata without inferring a value override',()=>{
 const data=current();data.settings[0].metadata=null;
 const patch={settings:[{key:'public',metadata:[{key:'SSAMProof',value:'Synthetic'}]}]};
 assert(extensibilityChanges(patch,data));
 const expected=extensibilityExpectation(patch),seen={ok:true,status:200,data};
 assert.equal(JSON.stringify(expected).includes('Synthetic'),false);
 assert.equal(verifyExtensibility(expected,seen).verified,false);
 data.settings[0].metadata=patch.settings[0].metadata;
 assert.equal(verifyExtensibility(expected,seen).verified,true);
 assert.equal(data.settings[0].valueOrigin,'Default');
 const reset=extensibilityExpectation({settings:[{key:'public',metadata:null}]});
 assert.equal(verifyExtensibility(reset,seen).verified,false);
 data.settings[0].metadata=[];assert.equal(verifyExtensibility(reset,seen).verified,true);
 delete data.settings[0].metadata;assert.equal(verifyExtensibility(reset,seen).verified,false);
 for(const metadata of [{},[{key:'x',value:1}],[{key:'x',value:'y',extra:true}],[{key:'x',value:'y'},{key:'x',value:'z'}]])
  assert.throws(()=>extensibilityChanges({settings:[{key:'public',metadata}]},current()));
});

test('library settings are resolved within the exact library; every value and metadata must match',()=>{
 const data=current();data.libraries=[{key:'library-a',revision:7,settings:[structuredClone(field)]},{key:'library-b',revision:8,settings:[structuredClone(field)]}];
 const patch={libraries:[{key:'library-a',settings:[{key:'public',value:'LibraryOverride',metadata:[{key:'proof',value:'a'}]}]}]};
 assert(extensibilityChanges(patch,data));
 const expected=mobileConfigurationExpectation(patch),seen={ok:true,status:200,data};
 assert.equal(expected.kind,'extensibility');
 const receipt={identity:{operationId},reconciliation:{mobileConfiguration:expected}};
 Object.assign(data.settings[0],{value:'LibraryOverride',valueOrigin:'Override',metadata:patch.libraries[0].settings[0].metadata});
 assert.equal(verifyMobileConfiguration(receipt,seen).verified,false);
 Object.assign(data.libraries[0].settings[0],data.settings[0]);
 assert.equal(verifyMobileConfiguration(receipt,seen).verified,true);
 data.libraries[0].settings[0].metadata=[];assert.equal(verifyMobileConfiguration(receipt,seen).verified,false);
 for(const library of [{key:'missing',settings:body.settings},{key:'library-a',settings:[]},{key:'library-a',settings:body.settings,revision:7}])
  assert.throws(()=>extensibilityChanges({libraries:[library]},data));
 assert.throws(()=>extensibilityChanges({libraries:[patch.libraries[0],patch.libraries[0]]},data));
 data.libraries[0].settings[0].isSecret=true;assert.throws(()=>extensibilityChanges(patch,data));
 data.libraries[0].settings[0].isSecret=false;data.libraries[0].revision=0;assert.throws(()=>extensibilityChanges(patch,data));
});

test('metadata-only confirmation preserves observed values/origins and the selected library revision',()=>{
 const data=current();data.settings[0].metadata=[];
 const patch={settings:[{key:'public',metadata:[]}]},expected=extensibilityExpectation(patch,data);
 const seen={ok:true,status:200,data:structuredClone(data)};
 assert.equal(verifyExtensibility(expected,seen).verified,true);
 seen.data.settings[0].value='Foreign';assert.equal(verifyExtensibility(expected,seen).reason,'unrequested-value-change');
 seen.data.settings[0].value='Original';seen.data.settings[0].valueOrigin='Override';assert.equal(verifyExtensibility(expected,seen).verified,false);
 data.libraries=[{key:'lib',revision:3,settings:[structuredClone(data.settings[0])]}];
 const library=extensibilityExpectation({libraries:[{key:'lib',settings:patch.settings}]},data);
 const read={ok:true,status:200,data:structuredClone(data)};assert.equal(verifyExtensibility(library,read).verified,true);
 read.data.libraries[0].revision=4;assert.equal(verifyExtensibility(library,read).reason,'library-revision-changed');
});
test('native reset empty metadata representation is equivalent, entries and values remain significant',()=>{
 const a=current(),b=current();a.settings[0].metadata=null;b.settings[0].metadata=[];
 assert.equal(extensibilityStateHash(a),extensibilityStateHash(b));
 b.settings[0].metadata=[{key:'x',value:'y'}];assert.notEqual(extensibilityStateHash(a),extensibilityStateHash(b));
 b.settings[0].metadata=[];b.settings[0].value=null;assert.notEqual(extensibilityStateHash(a),extensibilityStateHash(b));
});
test('extensibility authorization binds own fixture, exact body and whole baseline',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mobile-ext-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const applicationKey=crypto.randomUUID(),environmentKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID(),host='corp.outsystems.dev',words='Synthetic fixture approval';
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Create own fixture and restore'};
 const origin={state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:applicationKey},authorization:{source}};
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Synthetic scoped fixture');
 const state=current();fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host,operation:operationId,environmentKey,targets:['Proof']}],constraints:{originOperationUuid,bodySha256:mobileConfigurationHash(body),expectedConfigurationSha256:extensibilityStateHash(state)}}));
 const args={file,words,host,operationId,input:{path:{applicationKey,environmentKey},body},originOperationUuid,lookup:()=>origin,read:async id=>({ok:true,data:id.includes('asset-repository')?{assetKey:applicationKey,assetType:'MobileApplication',name:'Proof'}:state})};
 assert(await mobileConfigurationApproval(args));state.settings[0].lastUpdateDate='new';assert(await mobileConfigurationApproval(args));
 state.settings[0].value='concurrent';await assert.rejects(mobileConfigurationApproval(args));
});
