import fs from 'node:fs';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {CUSTOM_SEARCH_TEST} from './custom-search-connection-approval.mjs';
import {isUuid,sha256,fingerprint} from './write-journal.mjs';
import {fail} from './errors.mjs';
export async function customSearchDeleteApproval({file,words,host,raw,lookup,read,readPublic,dependencies}){
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Custom search cleanup requires the originating test, unchanged own connection and complete empty consumer scope. Nothing was sent.');
 let constraints;try{if(!file||fs.statSync(file).size>32768)bad();constraints=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 const p=raw.inputParameters,originOperationUuid=constraints?.originOperationUuid;
 if(Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length
  ||!isUuid(p?.ConnectionId)||p.ProviderId!=='customAISearch'||p.ConsoleProviderId!==''
  ||Object.keys(p).sort().join(',')!=='ConnectionId,ConsoleProviderId,ProviderId'||!isUuid(originOperationUuid))bad();
 const origin=lookup(originOperationUuid),e=origin?.reconciliation?.customSearchConnection,h=e?.details?.ConnectionDetails_Header;
 const configs=e?.details?.ConnectionDetail_StageConfig?.List;
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.kind!=='odc-portal'||origin.identity.tenant!==host
  ||origin.identity.operationId!==CUSTOM_SEARCH_TEST||origin.response?.Out_ConnectionId!==p.ConnectionId||!h||configs?.length!==1)bad();
 const detail=await read('connections.detail',{connectionId:p.ConnectionId,providerId:'customAISearch'}),c=detail?.data?.Connection;
 if(!detail?.ok||detail.truncated===true||detail.data?.NotFound!==false||c?.connectionId!==p.ConnectionId||c.providerId!=='customAISearch'
  ||c.name!==h.ConnectionName||c.description!==h.ConnectionDescription||c.portfolioKey!==h.PortfolioKey||c.stageConfigurations?.length!==1
  ||c.stageConfigurations[0].stageKey!==configs[0].TenantStage.Key||c.stageConfigurations[0].customSearch?.endpointSha256!==fingerprint(configs[0].EndpointURL)
  ||c.externalMetadata?.selectedObjectCount!==0||!Number.isSafeInteger(c.externalMetadata.selectedActionCount)||c.externalMetadata.selectedActionCount<0)bad();
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:'connections.delete',environmentKey:e.stageKey,targets:[c.name],
  constraints:{originOperationUuid,connectionId:p.ConnectionId,planSha256:e.planSha256,expectedStateSha256:fingerprint(c)}});
 if(!approval||origin.authorization?.wordsSha256!==sha256(words)||origin.authorization.proposalSha256!==approval.proposalSha256
  ||origin.authorization.source?.threadId!==approval.source.threadId||origin.authorization.source?.messageId!==approval.source.messageId)bad();
 const consumers=await dependencies(p.ConnectionId);
 let provisional=false;
 // Native testing can leave a provisional header before any asset is generated.
 // A Repository 404 alone cannot establish this state or justify deletion.
 if(!consumers?.ok&&typeof readPublic==='function'&&c.externalMetadata.selectedActionCount===0&&c.updatedOn&&Number.isFinite(Date.parse(origin.createdAt))){
  const stage=configs[0].TenantStage;
  const status=await read('connections.testStatus',{clientVariables:{ConnectionListSearchValue:''},screenVariables:{
   InitDateTime:new Date(origin.createdAt).toISOString().replace('T',' ').slice(0,19),ConnectionId:p.ConnectionId,_connectionIdInDataFetchStatus:1,
   StageDetails:{List:[{Key:stage.Key,Name:stage.Name,Purpose:stage.Purpose}]},_stageDetailsInDataFetchStatus:1}});
  const rows=status?.data?.Status?.Results?.List;
  if(status?.ok&&status.truncated!==true&&rows?.length===1&&rows[0].StageKey===e.stageKey&&['success','error'].includes(String(rows[0].Status).toLowerCase())){
   const native=await read('connections.connection',{screenVariables:{ConnectionId:p.ConnectionId,_connectionIdInDataFetchStatus:1,Source:'',_sourceInDataFetchStatus:1,
    ForceRefreshFail:false,_forceRefreshFailInDataFetchStatus:1,ForceSupportBoth:false,_forceSupportBothInDataFetchStatus:1}}),d=native?.data;
   const asset=await readPublic('asset-repository-api-v1:get:/assets/{assetKey}',{assetKey:p.ConnectionId});
   provisional=native?.ok===true&&native.truncated!==true&&d?.NotFound===false&&d.Name===c.name&&d.ProviderId==='customAISearch'
    &&d.PortfolioKey===c.portfolioKey&&d.ConnectionUpdateTimestamp===c.updatedOn&&d.IsRefreshingMetadata===false&&d.IsError===false
    &&d.LastSuccessfulMetadataUpdateTimestamp==='1900-01-01T00:00:00'&&asset?.status===404&&asset.data?.errorCode==='OS-APPS-40401';
  }
 }
 if(!provisional&&(!consumers?.ok||consumers.name!==c.name||consumers.includesPublishingDefault!==true||!consumers.checkedEnvironments?.includes(e.stageKey)
  ||!Array.isArray(consumers.consumers)||consumers.consumers.length))fail('CONNECTION_DEPENDENCIES_UNVERIFIED','Complete empty consumer scope or exact never-generated provisional state is required for own search cleanup. Nothing was sent.');
 const after=await read('connections.detail',{connectionId:p.ConnectionId,providerId:'customAISearch'});
 if(!after?.ok||after.truncated===true||after.data?.NotFound!==false||fingerprint(after.data.Connection)!==fingerprint(c))bad();
 return {approval,expected:{connectionId:p.ConnectionId,connectionName:c.name,providerId:'customAISearch',originOperationUuid,provisional}};
}
