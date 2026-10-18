import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {mobileConfigurationApproval,MOBILE_CONFIGURATION_WRITES,mobileConfigurationHash as hash,mobileConfigurationStateHash as stateHash} from '../runtime/mobile-configuration-approval.mjs';
test('mobile configuration binds ownership, stage, body and current state; restoration has a fresh baseline',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mobile-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Own mobile fixture');
 const host='test.outsystems.dev',words='Synthetic test authorization',applicationKey=crypto.randomUUID(),environmentKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID();
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Mobile fixture only'};
 const origin={state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:applicationKey},authorization:{source}};
 for(const operationId of MOBILE_CONFIGURATION_WRITES){
  let current={appIdentifier:{isSecret:false,value:null}},body={appIdentifier:{value:'com.ssam.proof'}};
  const input={path:{applicationKey,environmentKey},body};
  const approval=()=>({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
   scope:[{lane:'odc',host,operation:operationId,targets:['Proof'],environmentKey}],constraints:{originOperationUuid,bodySha256:hash(body),expectedConfigurationSha256:stateHash(current)}});
  const write=()=>fs.writeFileSync(file,JSON.stringify(approval()));write();
  const read=async id=>({ok:true,data:id.startsWith('asset-')?{assetKey:applicationKey,assetType:'MobileApplication',name:'Proof'}:current});
  const args={file,words,host,operationId,input,originOperationUuid,lookup:()=>origin,read};
  assert.equal((await mobileConfigurationApproval(args)).operation,operationId);
  current.appIdentifier.lastUpdateDate=new Date().toISOString();
  assert.equal((await mobileConfigurationApproval(args)).operation,operationId);
  for(const changed of [{response:{assetKey:crypto.randomUUID()}},{state:'uncertain'},{identity:{...origin.identity,tenant:'foreign.test'}},{authorization:{source:{...source,messageId:crypto.randomUUID()}}}])
   await assert.rejects(mobileConfigurationApproval({...args,lookup:()=>({...origin,...changed})}));
  await assert.rejects(mobileConfigurationApproval({...args,input:{...input,path:{...input.path,environmentKey:crypto.randomUUID()}}}));
  await assert.rejects(mobileConfigurationApproval({...args,input:{...input,body:{keystorePassword:{value:'forbidden'}}}}));
  await assert.rejects(mobileConfigurationApproval({...args,read:async()=>({ok:true,data:{assetKey:applicationKey,assetType:'WebApplication',name:'Proof'}})}));
  current={appIdentifier:{isSecret:false,value:'changed-by-someone-else'}};
  await assert.rejects(mobileConfigurationApproval(args));
  current={appIdentifier:{isSecret:false,value:'com.ssam.proof'}};body={appIdentifier:{value:null}};input.body=body;write();
  assert.equal((await mobileConfigurationApproval(args)).operation,operationId);
  current.appIdentifier.isSecret=true;write();await assert.rejects(mobileConfigurationApproval(args));
 }
});
