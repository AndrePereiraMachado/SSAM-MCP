import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {ipFilterApproval,ipFilterHash,IP_FILTER_CREATE,IP_FILTER_PATCH,IP_FILTER_DELETE} from '../runtime/ip-filter-approval.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ip-binding-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Own fixture association and restoration');
 const host='corp.outsystems.dev',environmentKey=randomUUID(),groupKey=randomUUID(),assetKey=randomUUID(),groupUuid=randomUUID(),assetUuid=randomUUID();
 const source={kind:'human-conversation',threadId:randomUUID(),messageId:randomUUID(),question:'Own fixtures only'},words='Synthetic fixture permission';
 const current={key:groupKey,name:'OwnGroup',appKeys:[],ipRules:[],accessType:'DENYLIST'};
 const records=new Map([[groupUuid,{state:'accepted',identity:{tenant:host,operationId:IP_FILTER_CREATE,target:{environmentKey,name:current.name}},response:{key:groupKey},authorization:{source}}],
  [assetUuid,{state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets',target:{name:'OwnApp'}},response:{assetKey},authorization:{source}}]]);
 const asset={assetKey,name:'OwnApp',assetType:'WebApplication'};
 function args(body,operationId=IP_FILTER_PATCH){
  const constraints={bodySha256:ipFilterHash(body??null),originOperationUuid:groupUuid,expectedConfigurationSha256:ipFilterHash(current),bindingOriginsJson:JSON.stringify([{assetKey,operationUuid:assetUuid}])};
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},constraints,
   scope:[{lane:'odc',host,operation:operationId,environmentKey,targets:[current.name]}]}));
  return {file,words,host,operationId,input:{path:{environmentKey,ipFilterGroupKey:groupKey},...(body===undefined?{}:{body})},originOperationUuid:groupUuid,
   lookup:key=>records.get(key),read:async(op)=>({ok:true,data:op.startsWith('asset-repository')?asset:current})};
 }
 return {args,current,records,assetUuid,assetKey,asset};
}
test('binds own app and removes association with the same proven origin',async t=>{
 const f=fixture(t);assert.ok(await ipFilterApproval(f.args({appKeys:[f.assetKey]})));
 f.current.appKeys=[f.assetKey];assert.ok(await ipFilterApproval(f.args({appKeys:[]})));
 await assert.rejects(()=>ipFilterApproval(f.args(undefined,IP_FILTER_DELETE)),{code:'AUTHORIZATION_CONTEXT_INVALID'});
});
test('refuses missing, foreign, renamed and non-application origins',async t=>{
 const f=fixture(t),record=f.records.get(f.assetUuid);
 for(const mutate of [()=>f.records.delete(f.assetUuid),()=>{f.records.set(f.assetUuid,record);record.identity.tenant='other.outsystems.dev';},
  ()=>{record.identity.tenant='corp.outsystems.dev';record.authorization.source={...record.authorization.source,messageId:randomUUID()};}]){
  mutate();await assert.rejects(()=>ipFilterApproval(f.args({appKeys:[f.assetKey]})),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 }
});
test('refuses duplicate bindings, configuration drift and wrong asset metadata',async t=>{
 const f=fixture(t);await assert.rejects(()=>ipFilterApproval(f.args({appKeys:[f.assetKey,f.assetKey]})),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 const args=f.args({appKeys:[f.assetKey]});f.current.description='concurrent';
 await assert.rejects(()=>ipFilterApproval(args),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 f.asset.assetType='Library';await assert.rejects(()=>ipFilterApproval(f.args({appKeys:[f.assetKey]})),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 f.asset.assetType='WebApplication';f.asset.name='Renamed';await assert.rejects(()=>ipFilterApproval(f.args({appKeys:[f.assetKey]})),{code:'AUTHORIZATION_CONTEXT_INVALID'});
});
