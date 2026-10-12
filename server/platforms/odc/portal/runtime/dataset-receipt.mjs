// A successful HTTP response is not a persisted dataset proof. Retain the
// identities needed for read-back without automatically replaying creation.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {isUuid} from './write-journal.mjs';
import {fail} from './errors.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>fail('DATASET_RECONCILIATION_UNVERIFIED','Dataset reconciliation needs the original approved input and an exact persisted dataset read. No write was sent.');

// A missing ID in a successful native response does not permit another create.
// The caller may supply an ID discovered by a read, but not replace the approved
// content. Bind that content to the reserved receipt before observing the ID.
export function datasetReconciliationInput(receipt,{state,read,authorize}) {
 const p=read?.creationInput,d=p?.Dataset,vars=read?.input?.screenVariables;
 if(state!=='confirmed'||receipt.identity?.operationId!=='agents.datasetCreate'
   ||!receipt.authorization?.source||hash(authorize)!==receipt.authorization.wordsSha256
   ||read.operationId!=='agents.dataset'||read.tenant&&read.tenant!==receipt.identity.tenant
   ||!isUuid(vars?.id)||vars._idInDataFetchStatus!==1||Object.keys(vars).sort().join(',')!=='_idInDataFetchStatus,id'
   ||!d||hash(JSON.stringify(p))!==receipt.identity.target?.inputSha256)invalid();
 let record;
 try{if(fs.statSync(read.authorizationContext).size>32768)invalid();record=JSON.parse(fs.readFileSync(read.authorizationContext,'utf8'));}catch{invalid();}
 const approval=authorizationContext(read.authorizationContext,authorize,{lane:'odc',host:receipt.identity.tenant,operation:'agents.datasetCreate',
   targets:[d.Name,...(record.scope?.find(x=>x.operation==='agents.datasetCreate')?.targets??[]).filter(x=>x!==d.Name)],
   constraints:{inputSha256:hash(JSON.stringify(p)),applicationKey:d.AgenticAppId,portfolioKey:d.PortfolioKey}});
 if(!approval||approval.sha256!==receipt.authorization.contextSha256||approval.proposalSha256!==receipt.authorization.proposalSha256
   ||approval.source.threadId!==receipt.authorization.source.threadId||approval.source.messageId!==receipt.authorization.source.messageId
   ||receipt.response?.DatasetId&&receipt.response.DatasetId!==vars.id)invalid();
 let content;try{content=JSON.parse(d.Content);}catch{invalid();}
 const cases=Array.isArray(content)?content:content?.testCases;
 if(!Array.isArray(cases)||!cases.length)invalid();
 return {datasetId:vars.id,expected:d,cases};
}

export function datasetCreationObservation(scope,result) {
 const d=result?.data?.Dataset,e=scope.expected;
 if(result?.ok!==true||result.data.NotFound!==false||d?.DatasetId!==scope.datasetId) return {verified:false,reason:'dataset-unavailable-or-foreign'};
 for(const key of ['Name','Description','AgenticAppId','ServiceActionId','PortfolioKey','AssetType','SetupAppId','SetupServiceActionId','TeardownAppId','TeardownServiceActionId'])
  if(d[key]!==e[key])return {verified:false,reason:'dataset-header-changed'};
 const actual=d.TestCases?.List;
 if(!Array.isArray(actual)||actual.length!==scope.cases.length||String(d.TestCaseCount)!==String(actual.length))return {verified:false,reason:'dataset-case-count-changed'};
 try {
  const normalized=actual.map(x=>({name:x.Name,description:x.Description??'',inputs:JSON.parse(x.Inputs),expectations:{
   expectedResponse:JSON.parse(x.Expectations.ExpectedResponse),guidelines:x.Expectations.Guidelines.List,expectedTools:x.Expectations.ExpectedTools.List}}));
  const expected=scope.cases.map(x=>({name:x.name,description:x.description??'',inputs:x.inputs,expectations:{
   expectedResponse:x.expectations.expectedResponse??{},guidelines:x.expectations.guidelines??[],expectedTools:x.expectations.expectedTools??[]}}));
  if(!isDeepStrictEqual(normalized,expected))return {verified:false,reason:'dataset-content-changed'};
 }catch{return {verified:false,reason:'dataset-content-unreadable'};}
 return {verified:true,datasetId:d.DatasetId,applicationKey:d.AgenticAppId,portfolioKey:d.PortfolioKey,testCaseCount:actual.length,
  datasetSha256:hash(JSON.stringify(d)),attribution:'original-input-and-exact-target-readback'};
}

export function datasetCreationOutcome(data) {
  const identified = typeof data?.DatasetId === 'string' && data.DatasetId.trim().length > 0;
  return identified ? {state:'accepted', response:{DatasetId:data.DatasetId,
    ...(typeof data.GroupId === 'string' ? {GroupId:data.GroupId} : {})}}
    : {state:'uncertain',response:{},error:{code:'DATASET_ID_UNVERIFIED',
      message:'Dataset creation did not return a dataset identity. Reconcile the original operation; do not repeat creation.'}};
}
