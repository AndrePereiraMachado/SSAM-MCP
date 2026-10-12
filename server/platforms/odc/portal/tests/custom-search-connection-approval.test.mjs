import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {customSearchConnectionPlan,customSearchSaveInput} from '../runtime/custom-search-connection-plan.mjs';
import {customSearchConnectionApproval,CUSTOM_SEARCH_TEST,CUSTOM_SEARCH_SAVE} from '../runtime/custom-search-connection-approval.mjs';
import {customSearchConnectionObservation} from '../runtime/custom-search-connection-observation.mjs';
import {projectConnectionDetail} from '../runtime/connection-detail.mjs';
import {customSearchDeleteApproval} from '../runtime/custom-search-delete-approval.mjs';
import {sha256,fingerprint} from '../runtime/write-journal.mjs';
const id=()=>crypto.randomUUID();
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'custom-search-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Own search fixture');
 const host='example.outsystems.dev',words='Synthetic own fixture grant',source={kind:'human-conversation',threadId:id(),messageId:id(),question:'Own fixture'};
 const plan=customSearchConnectionPlan({name:'OwnedSearch',description:'Synthetic only',portfolioKey:id(),stage:{Key:id(),Name:'Development',Purpose:'Development'},endpointURL:'https://example-dev.outsystems.app/OwnService/rest/Search/CustomAISearch'});
 const serviceAssetKey=id(),serviceOriginOperationUuid=id(),originOperationUuid=id(),connectionId=id();
 const serviceOrigin={state:'confirmed',identity:{kind:'odc-public',tenant:host,operationId:'asset-repository-api-v1:post:/assets',target:{name:'OwnService'}},response:{assetKey:serviceAssetKey},authorization:{wordsSha256:sha256(words),source}};
 const records=new Map([[serviceOriginOperationUuid,serviceOrigin]]);
 function context(operationId,raw){const record={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:sha256(fs.readFileSync(proposal).toString())},
  scope:[{lane:'odc',host,operation:operationId,environmentKey:plan.stageKey,targets:['OwnedSearch']}],constraints:{planSha256:plan.planSha256,inputSha256:sha256(JSON.stringify(raw.inputParameters)),serviceAssetKey,serviceOriginOperationUuid,
   ...(operationId===CUSTOM_SEARCH_SAVE?{originOperationUuid,connectionId}:{})}};fs.writeFileSync(file,JSON.stringify(record));return record;}
 const read=async op=>op==='monitoring.stages'?{ok:true,truncated:false,rows:[{Key:plan.stageKey,Name:'Development',Purpose:'Development'}]}
  :op==='connections.list'?{ok:true,truncated:false,rows:[]}:{ok:true,data:{Status:{Results:{List:[{StageKey:plan.stageKey,Status:'Success'}]}}}};
 const readPublic=async op=>op.startsWith('asset-repository')?{ok:true,data:{assetKey:serviceAssetKey,name:'OwnService',assetType:'WebApplication',portfolioKey:plan.details.ConnectionDetails_Header.PortfolioKey}}
  :op.startsWith('portfolio')?{ok:true,data:{results:[{key:plan.stageKey,builtinDomain:'example-dev.outsystems.app'}]}}:{ok:true,data:{revisionDeployed:2}};
 const args={file,host,words,operationId:CUSTOM_SEARCH_TEST,raw:plan.testInput,lookup:key=>records.get(key),read,readPublic};
 return {plan,context,args,records,serviceOrigin,serviceAssetKey,serviceOriginOperationUuid,originOperationUuid,connectionId,read,readPublic};
}
test('test approval requires live own service identity, environment domain and publication',async t=>{
 const f=fixture(t);f.context(CUSTOM_SEARCH_TEST,f.plan.testInput);
 const p=await customSearchConnectionApproval(f.args);assert.equal(p.expected.serviceAssetKey,f.serviceAssetKey);
 for(const mutate of [x=>x.state='accepted',x=>x.identity.tenant='other',x=>x.identity.operationId='other',x=>x.response.assetKey=id(),x=>x.authorization.source.messageId=id(),x=>x.authorization.wordsSha256='other']){
  const changed=structuredClone(f.serviceOrigin);mutate(changed);
  await assert.rejects(customSearchConnectionApproval({...f.args,lookup:()=>changed}));
 }
 for(const override of [{file:undefined},{raw:{...f.plan.testInput,screenVariables:{Injected:true}}},
  {read:async op=>op==='connections.list'?{ok:true,truncated:true,rows:[]}:f.read(op)},
  {read:async op=>op==='connections.list'?{ok:true,truncated:false,rows:[{Name:'ownedsearch'}]}:f.read(op)},
  {read:async op=>op==='monitoring.stages'?{ok:true,rows:[{Key:f.plan.stageKey,Name:'Production',Purpose:'Production'}]}:f.read(op)},
  {readPublic:async op=>op.startsWith('asset-repository')?{ok:true,data:{assetKey:f.serviceAssetKey,name:'ForeignService',assetType:'WebApplication'}}:f.readPublic(op)},
  {readPublic:async op=>op.startsWith('portfolio')?{ok:true,data:{results:[{key:f.plan.stageKey,builtinDomain:'foreign.test'}]}}:f.readPublic(op)},
  {readPublic:async op=>op.startsWith('asset-configurations')?{ok:true,data:{revisionDeployed:0}}:f.readPublic(op)}])await assert.rejects(customSearchConnectionApproval({...f.args,...override}));
});
test('save is bound to native test receipt, successful exact stage and original approval',async t=>{
 const f=fixture(t),record=f.context(CUSTOM_SEARCH_TEST,f.plan.testInput),prepared=await customSearchConnectionApproval(f.args);
 const origin={state:'accepted',createdAt:'2026-10-10T12:00:00Z',identity:{kind:'odc-portal',tenant:f.args.host,operationId:CUSTOM_SEARCH_TEST},
  response:{Out_ConnectionId:f.connectionId},authorization:{...f.serviceOrigin.authorization,proposalSha256:record.proposal.sha256},reconciliation:{customSearchConnection:prepared.expected}};
 f.records.set(f.originOperationUuid,origin);const raw=customSearchSaveInput(f.plan,f.connectionId,f.plan.planSha256);f.context(CUSTOM_SEARCH_SAVE,raw);
 const args={...f.args,operationId:CUSTOM_SEARCH_SAVE,raw};assert.equal((await customSearchConnectionApproval(args)).expected.connectionId,f.connectionId);
 for(const mutate of [x=>x.state='uncertain',x=>x.response.Out_ConnectionId=id(),x=>x.createdAt='unknown',x=>x.authorization.proposalSha256='changed',
  x=>x.reconciliation.customSearchConnection.serviceAssetKey=id(),x=>x.identity.tenant='foreign']){
  const changed=structuredClone(origin);mutate(changed);f.records.set(f.originOperationUuid,changed);
  await assert.rejects(customSearchConnectionApproval(args));
 }f.records.set(f.originOperationUuid,origin);
 for(const rows of [[],[{StageKey:f.plan.stageKey,Status:'Running'}],[{StageKey:f.plan.stageKey,Status:'Error'}],[{StageKey:id(),Status:'Success'}]])
  await assert.rejects(customSearchConnectionApproval({...args,read:async op=>op==='connections.testStatus'?{ok:true,data:{Status:{Results:{List:rows}}}}:f.read(op)}),{code:'CONNECTION_TEST_NOT_CONFIRMED'});
});
test('typed detail withholds credentials and save observation requires every reviewed field',async t=>{
 const f=fixture(t),config=f.plan.details.ConnectionDetail_StageConfig.List[0];
 const data={NotFound:false,Connection:{connectionId:f.connectionId,providerId:'customAISearch',name:'OwnedSearch',description:'Synthetic only',portfolioKey:f.plan.details.ConnectionDetails_Header.PortfolioKey,
  ExternalMetadata:{selectedObjectCount:0,selectedActionCount:0},StageConfigurations:{List:[{StageKey:f.plan.stageKey,configurationValues:{List:[
   {key:'endpointURL',value:config.EndpointURL},{key:'headers',value:'[]'},{key:'headerNames',value:'[]'}]}}]}}};
 const result={ok:true,data:projectConnectionDetail(data,{connectionId:f.connectionId,providerId:'customAISearch'})};
 const receipt={identity:{operationId:CUSTOM_SEARCH_SAVE},reconciliation:{customSearchConnection:{connectionId:f.connectionId,details:f.plan.details}}};
 assert.equal(customSearchConnectionObservation(receipt,result).verified,true);
 for(const mutate of [x=>x.data.Connection.name='Other',x=>x.data.Connection.description='Other',x=>x.data.Connection.providerId='mssql',
  x=>x.data.Connection.stageConfigurations[0].customSearch.endpointSha256=null,x=>x.data.Connection.stageConfigurations[0].customSearch.headersEmpty=null,
  x=>x.data.Connection.stageConfigurations[0].customSearch.headerNamesEmpty=false,x=>x.data.Connection.stageConfigurations.push(x.data.Connection.stageConfigurations[0]),x=>x.truncated=true]){
  const changed=structuredClone(result);mutate(changed);assert.equal(customSearchConnectionObservation(receipt,changed).verified,false);
 }
 data.Connection.StageConfigurations.List[0].configurationValues.List[1].value=JSON.stringify([{Name:'Authorization',Value:'private-secret'}]);
 const safe=projectConnectionDetail(data,{connectionId:f.connectionId,providerId:'customAISearch'});
 assert.equal(safe.Connection.stageConfigurations[0].customSearch.headersEmpty,false);
 assert.doesNotMatch(JSON.stringify(safe),/private-secret|Authorization|example-dev/);
 data.Connection.StageConfigurations.List[0].configurationValues.List[1].value='not-json-private';
 assert.equal(projectConnectionDetail(data,{connectionId:f.connectionId,providerId:'customAISearch'}).Connection.stageConfigurations[0].customSearch.headersEmpty,null);
});

test('delete binds own test, current state and complete consumer scope; drift and existing assets refuse',async t=>{
 const f=fixture(t),record=f.context(CUSTOM_SEARCH_TEST,f.plan.testInput),prepared=await customSearchConnectionApproval(f.args);
 const origin={state:'accepted',identity:{kind:'odc-portal',tenant:f.args.host,operationId:CUSTOM_SEARCH_TEST},response:{Out_ConnectionId:f.connectionId},
  authorization:{...f.serviceOrigin.authorization,proposalSha256:record.proposal.sha256},reconciliation:{customSearchConnection:prepared.expected}};
 f.records.set(f.originOperationUuid,origin);
 const c={connectionId:f.connectionId,providerId:'customAISearch',name:'OwnedSearch',description:'Synthetic only',portfolioKey:f.plan.details.ConnectionDetails_Header.PortfolioKey,
  externalMetadata:{selectedObjectCount:0,selectedActionCount:1},stageConfigurations:[{stageKey:f.plan.stageKey,customSearch:{endpointSha256:fingerprint(f.plan.details.ConnectionDetail_StageConfig.List[0].EndpointURL),headersEmpty:null,headerNamesEmpty:true}}]};
 const native={inputParameters:{ConnectionId:f.connectionId,ProviderId:'customAISearch',ConsoleProviderId:''}};
 const context=f.context('connections.delete',native);context.constraints={originOperationUuid:f.originOperationUuid,connectionId:f.connectionId,planSha256:f.plan.planSha256,expectedStateSha256:fingerprint(c)};
 fs.writeFileSync(f.args.file,JSON.stringify(context));
 const deps={ok:true,name:'OwnedSearch',consumers:[],checkedEnvironments:[f.plan.stageKey],includesPublishingDefault:true};
 const args={...f.args,raw:native,read:async()=>({ok:true,data:{NotFound:false,Connection:structuredClone(c)}}),dependencies:async()=>deps};
 assert.equal((await customSearchDeleteApproval(args)).expected.connectionId,f.connectionId);
 for(const override of [{lookup:()=>({...origin,state:'uncertain'})},{lookup:()=>({...origin,response:{Out_ConnectionId:id()}})},
  {raw:{inputParameters:{...native.inputParameters,ProviderId:'a2a'}}},
  {dependencies:async()=>({...deps,consumers:[{key:id(),name:'Consumer'}]})},
  {dependencies:async()=>({...deps,includesPublishingDefault:false})},
  {dependencies:async()=>({...deps,checkedEnvironments:[]})},
  {read:async()=>({ok:true,data:{NotFound:false,Connection:{...c,name:'Foreign'}}})}])await assert.rejects(customSearchDeleteApproval({...args,...override}));
 let reads=0;
 await assert.rejects(customSearchDeleteApproval({...args,read:async()=>({ok:true,data:{NotFound:false,Connection:++reads===1?c:{...c,description:'Changed'}}})}));
});


test('a provisional header needs terminal stage status, never-generated native metadata and exact Repository 404',async t=>{
 const f=fixture(t),record=f.context(CUSTOM_SEARCH_TEST,f.plan.testInput),prepared=await customSearchConnectionApproval(f.args);
 const origin={state:'accepted',createdAt:'2026-10-10T12:00:00Z',identity:{kind:'odc-portal',tenant:f.args.host,operationId:CUSTOM_SEARCH_TEST},response:{Out_ConnectionId:f.connectionId},
  authorization:{...f.serviceOrigin.authorization,proposalSha256:record.proposal.sha256},reconciliation:{customSearchConnection:prepared.expected}};f.records.set(f.originOperationUuid,origin);
 const c={connectionId:f.connectionId,providerId:'customAISearch',name:'OwnedSearch',description:'Synthetic only',portfolioKey:f.plan.details.ConnectionDetails_Header.PortfolioKey,updatedOn:'2026-10-10T12:00:01Z',
  externalMetadata:{selectedObjectCount:0,selectedActionCount:0},stageConfigurations:[{stageKey:f.plan.stageKey,customSearch:{endpointSha256:fingerprint(f.plan.details.ConnectionDetail_StageConfig.List[0].EndpointURL)}}]};
 const native={inputParameters:{ConnectionId:f.connectionId,ProviderId:'customAISearch',ConsoleProviderId:''}},context=f.context('connections.delete',native);
 context.constraints={originOperationUuid:f.originOperationUuid,connectionId:f.connectionId,planSha256:f.plan.planSha256,expectedStateSha256:fingerprint(c)};fs.writeFileSync(f.args.file,JSON.stringify(context));
 const metadata={NotFound:false,Name:c.name,ProviderId:c.providerId,PortfolioKey:c.portfolioKey,ConnectionUpdateTimestamp:c.updatedOn,
  IsRefreshingMetadata:false,IsError:false,LastSuccessfulMetadataUpdateTimestamp:'1900-01-01T00:00:00'};
 const status={ok:true,data:{Status:{Results:{List:[{StageKey:f.plan.stageKey,Status:'Error'}]}}}};
 const read=async op=>op==='connections.detail'?{ok:true,data:{NotFound:false,Connection:c}}:op==='connections.testStatus'?status:{ok:true,data:metadata};
 const args={...f.args,raw:native,read,readPublic:async()=>({ok:false,status:404,data:{errorCode:'OS-APPS-40401'}}),dependencies:async()=>({ok:false})};
 assert.equal((await customSearchDeleteApproval(args)).expected.provisional,true);
 for(const override of [{readPublic:async()=>({ok:false,status:403,data:{errorCode:'OS-APPS-40401'}})},
  {readPublic:async()=>({ok:false,status:404,data:{errorCode:'Other'}})},
  {read:async op=>op==='connections.connection'?{ok:true,data:{...metadata,LastSuccessfulMetadataUpdateTimestamp:'2026-10-10T12:00:02Z'}}:read(op)},
  {read:async op=>op==='connections.connection'?{ok:true,data:{...metadata,ProviderId:'a2a'}}:read(op)},
  {read:async op=>op==='connections.testStatus'?{ok:true,data:{Status:{Results:{List:[{StageKey:f.plan.stageKey,Status:'Running'}]}}}}:read(op)}])
  await assert.rejects(customSearchDeleteApproval({...args,...override}),{code:'CONNECTION_DEPENDENCIES_UNVERIFIED'});
});
