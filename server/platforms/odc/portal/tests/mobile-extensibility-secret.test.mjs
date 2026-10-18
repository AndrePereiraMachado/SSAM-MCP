import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {extensibilityChanges,extensibilityExpectation,verifyExtensibility,extensibilityStateHash,MOBILE_EXTENSIBILITY_PATCH as operationId} from '../runtime/mobile-extensibility.mjs';
import {mobileExtensibilityVaultPlan} from '../runtime/mobile-extensibility-vault-plan.mjs';
import {mobileConfigurationApproval,mobileConfigurationHash as hash} from '../runtime/mobile-configuration-approval.mjs';
const host='corp.outsystems.dev';
const field=()=>({key:'secret',name:'Secret',isSecret:true,dataType:'Text',value:'[REDACTED]',defaultValue:'[REDACTED]',valueOrigin:'Default',metadata:null});
const ref={pointer:'/settings/0/value',target:'SSAM/ODC3/'+host+'/Setting/Synthetic',field:'password'};
test('mobile secret writes require a unique consumed vault reference; reset has no reference',()=>{
 const data={settings:[field()],libraries:[]},body={settings:[{key:'secret',value:''}]};
 assert(extensibilityChanges(body,data,[ref]));
 for(const refs of [[],[ref,ref],[{...ref,pointer:'/settings/1/value'}]])assert.throws(()=>extensibilityChanges(body,data,refs));
 assert.throws(()=>extensibilityChanges({settings:[{key:'secret',value:'RAW_SECRET'}]},data,[ref]));
 assert.throws(()=>extensibilityChanges({settings:[{key:'secret',value:null}]},data,[ref]));
 assert(extensibilityChanges({settings:[{key:'secret',value:null}]},data));
 const expected=extensibilityExpectation(body,data);
 assert.doesNotMatch(JSON.stringify(expected),/REDACTED|valueSha256|preservedValueSha256/);
 const seen={ok:true,status:200,data};
 assert.equal(verifyExtensibility(expected,seen).verified,false);
 data.settings[0].valueOrigin='Override';
 const proof=verifyExtensibility(expected,seen);assert.equal(proof.verified,true);assert.equal(proof.valueVerified,false);
 // Changed/missing masked values cannot prove or disprove secret contents.
 delete data.settings[0].value;assert.equal(verifyExtensibility(expected,seen).valueVerified,false);
 const reset=extensibilityExpectation({settings:[{key:'secret',value:null}]},data);
 assert.equal(verifyExtensibility(reset,seen).verified,false);data.settings[0].valueOrigin='Default';
 assert.equal(verifyExtensibility(reset,seen).secretObservations[0].resetMetadataVerified,true);
 data.settings[0].isSecret=false;assert.equal(verifyExtensibility(reset,seen).verified,false);
});
test('mobile library vault selectors bind exact library and setting without adding an incompatible revision',()=>{
 const current={settings:[],libraries:[{key:'lib',revision:3,settings:[field()]}]},selector={libraryKey:'lib',settingKey:'secret',entry:'Synthetic'};
 const plan=mobileExtensibilityVaultPlan(host,current,{},[selector]);
 assert.deepEqual(plan.body,{libraries:[{key:'lib',settings:[{key:'secret',value:''}]}]});
 assert.equal(plan.refs[0].pointer,'/libraries/0/settings/0/value');assert(extensibilityChanges(plan.body,current,plan.refs));
 const expected=extensibilityExpectation(plan.body,current);assert.equal(expected.libraries[0].revision,3);
 current.libraries[0].settings[0].valueOrigin='Override';assert.equal(verifyExtensibility(expected,{ok:true,status:200,data:current}).verified,true);
 current.libraries[0].revision=4;assert.equal(verifyExtensibility(expected,{ok:true,status:200,data:current}).reason,'library-revision-changed');
 for(const s of [{...selector,integrationKey:'rest'},{...selector,libraryKey:'wrong'},{...selector,settingKey:'wrong'},{...selector,entry:'../outside'}])assert.throws(()=>mobileExtensibilityVaultPlan(host,current,{},[s]));
 assert.throws(()=>mobileExtensibilityVaultPlan(host,current,{},[selector,selector]));
 assert.throws(()=>mobileExtensibilityVaultPlan(host,current,plan.body,[selector]));
 current.libraries[0].settings[0].isSecret=false;assert.throws(()=>mobileExtensibilityVaultPlan(host,current,{},[selector]));
});
test('secret authorization binds the vault selector hash and refuses cross tenant, unapproved refs or stale state',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mobile-secret-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const originOperationUuid=crypto.randomUUID(),applicationKey=crypto.randomUUID(),environmentKey=crypto.randomUUID();
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Own fixture and restore'},words='Synthetic fixture grant';
 const body={settings:[{key:'secret',value:''}]},state={settings:[field()],libraries:[]};
 const proposal=path.join(dir,'proof.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Own mobile synthetic secret');
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
  scope:[{lane:'odc',host,operation:operationId,environmentKey,targets:['Proof']}],
  constraints:{originOperationUuid,bodySha256:hash(body),expectedConfigurationSha256:extensibilityStateHash(state),secretRefsSha256:hash([ref])}}));
 const args={file,words,host,operationId,input:{path:{applicationKey,environmentKey},body},originOperationUuid,secretRefs:[ref],
  lookup:()=>({state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:applicationKey},authorization:{source}}),
  read:async id=>({ok:true,data:id.startsWith('asset-repository')?{assetKey:applicationKey,assetType:'MobileApplication',name:'Proof'}:state})};
 const accepted=await mobileConfigurationApproval(args);assert.equal(accepted.extensibilityExpectation.settings[0].valueVerified,false);
 for(const secretRefs of [[],[{...ref,target:ref.target.replace(host,'other.outsystems.dev')}],[{...ref,target:ref.target+'Other'}]])await assert.rejects(mobileConfigurationApproval({...args,secretRefs}));
 state.settings[0].valueOrigin='Override';await assert.rejects(mobileConfigurationApproval(args));
});
