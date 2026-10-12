import fs from 'node:fs';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {customSearchConnectionPlan,customSearchSaveInput} from './custom-search-connection-plan.mjs';
import {fail} from './errors.mjs';
import {isUuid,sha256,fingerprint} from './write-journal.mjs';
export const CUSTOM_SEARCH_TEST='connections.customSearchTest',CUSTOM_SEARCH_SAVE='connections.customSearchSave';
const reject=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Custom search requires the exact new plan, own deployed service, live stage and native test receipt. Nothing was sent.');
const sameSource=(a,b)=>a?.wordsSha256===b?.wordsSha256&&a?.source?.threadId===b?.source?.threadId&&a?.source?.messageId===b?.source?.messageId;
function constraints(file){try{if(!file||fs.statSync(file).size>32768)reject();return JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{reject();}}
function restore(details){
 const h=details?.ConnectionDetails_Header,c=details?.ConnectionDetail_StageConfig?.List;
 if(!h||c?.length!==1)reject();
 const p=customSearchConnectionPlan({name:h.ConnectionName,description:h.ConnectionDescription,portfolioKey:h.PortfolioKey,stage:c[0].TenantStage,endpointURL:c[0].EndpointURL});
 if(fingerprint(p.details)!==fingerprint(details))reject();return p;
}
// Restricted to an endpoint in an own, currently deployed WebApplication.
// Live environment domains and deployed revision are checked before reservation.
// Empty headers only: no secret arguments or unsupported editing branches.
export async function customSearchConnectionApproval({file,words,host,operationId,raw,lookup,read,readPublic}){
 if(!file||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)reject();
 const c=constraints(file),p=raw.inputParameters;let plan,origin;
 if(operationId===CUSTOM_SEARCH_TEST){
  plan=restore({ConnectionDetails_Header:p?.ConnectionDetails_Header,ConnectionDetail_StageConfig:p?.ValidStageConfigs});
  if(fingerprint(p)!==fingerprint(plan.testInput.inputParameters))reject();
 }else if(operationId===CUSTOM_SEARCH_SAVE){
  if(!isUuid(c?.originOperationUuid))reject();origin=lookup(c.originOperationUuid);
  if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.kind!=='odc-portal'||origin.identity.tenant!==host
   ||origin.identity.operationId!==CUSTOM_SEARCH_TEST||!isUuid(origin.response?.Out_ConnectionId)||origin.response.Out_ConnectionId!==p?.ConnectionId)reject();
  plan=restore(origin.reconciliation?.customSearchConnection?.details);
  if(origin.reconciliation.customSearchConnection.planSha256!==plan.planSha256
   ||fingerprint(p)!==fingerprint(customSearchSaveInput(plan,p.ConnectionId,plan.planSha256).inputParameters))reject();
 }else reject();
 const {serviceAssetKey,serviceOriginOperationUuid}=c??{};
 if(!isUuid(serviceAssetKey)||!isUuid(serviceOriginOperationUuid))reject();
 const serviceOrigin=lookup(serviceOriginOperationUuid);
 if(serviceOrigin?.state!=='confirmed'||serviceOrigin.identity?.kind!=='odc-public'||serviceOrigin.identity.tenant!==host
  ||serviceOrigin.identity.operationId!=='asset-repository-api-v1:post:/assets'||serviceOrigin.response?.assetKey!==serviceAssetKey)reject();
 const name=plan.details.ConnectionDetails_Header.ConnectionName;
 const binding={planSha256:plan.planSha256,inputSha256:sha256(JSON.stringify(p)),serviceAssetKey,serviceOriginOperationUuid,
  ...(origin?{originOperationUuid:c.originOperationUuid,connectionId:p.ConnectionId}:{})};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,environmentKey:plan.stageKey,targets:[name],constraints:binding});
 if(!approval||!sameSource(serviceOrigin.authorization,approval))reject();
 if(origin&&(!sameSource(origin.authorization,approval)||origin.authorization.proposalSha256!==approval.proposalSha256
  ||origin.reconciliation.customSearchConnection.serviceAssetKey!==serviceAssetKey
  ||origin.reconciliation.customSearchConnection.serviceOriginOperationUuid!==serviceOriginOperationUuid))reject();
 const stages=await read('monitoring.stages',{}),wanted=plan.details.ConnectionDetail_StageConfig.List[0].TenantStage;
 const observed=stages?.rows?.filter(s=>s.Key===plan.stageKey);
 if(!stages?.ok||stages.truncated===true||observed?.length!==1||observed[0].Name!==wanted.Name||observed[0].Purpose!==wanted.Purpose)reject();
 const asset=await readPublic('asset-repository-api-v1:get:/assets/{assetKey}',{assetKey:serviceAssetKey});
 if(!asset?.ok||asset.data?.assetKey!==serviceAssetKey||asset.data.assetType!=='WebApplication'
  ||asset.data.name!==serviceOrigin.identity.target?.name||asset.data.portfolioKey!==plan.details.ConnectionDetails_Header.PortfolioKey)reject();
 const envs=await readPublic('portfolio-api-v2:get:/environments',{}),envRows=envs?.data?.results;
 if(!envs?.ok||!Array.isArray(envRows)||envRows.filter(e=>e.key===plan.stageKey).length!==1)reject();
 const env=envRows.find(e=>e.key===plan.stageKey),url=new URL(plan.details.ConnectionDetail_StageConfig.List[0].EndpointURL);
 const domains=[env.builtinDomain,env.defaultDomain].filter(x=>typeof x==='string'&&x).map(x=>{try{return new URL(x.includes('://')?x:'https://'+x).origin;}catch{return null;}});
 if(!domains.includes(url.origin)||!url.pathname.startsWith('/'+encodeURIComponent(asset.data.name)+'/rest/'))reject();
 const deployed=await readPublic('asset-configurations-api-v1:get:/environments/{environmentKey}/applications/{applicationKey}/revisions/deployed/configurations',
  {environmentKey:plan.stageKey,applicationKey:serviceAssetKey});
 if(!deployed?.ok||!Number.isInteger(deployed.data?.revisionDeployed)||deployed.data.revisionDeployed<1)reject();
 if(operationId===CUSTOM_SEARCH_TEST){
  const inventory=await read('connections.list',{});
  if(!inventory?.ok||inventory.truncated!==false||!Array.isArray(inventory.rows)||inventory.rows.some(r=>typeof(r.Name??r.ConnectionName)!=='string'))reject();
  if(inventory.rows.some(r=>(r.Name??r.ConnectionName).toLowerCase()===name.toLowerCase()))fail('CONNECTION_ALREADY_EXISTS','The approved name already exists. Reconcile before writing.');
 }else{
  if(!Number.isFinite(Date.parse(origin.createdAt)))reject();
  const status=await read('connections.testStatus',{clientVariables:{ConnectionListSearchValue:''},screenVariables:{
   InitDateTime:new Date(origin.createdAt).toISOString().replace('T',' ').slice(0,19),ConnectionId:p.ConnectionId,_connectionIdInDataFetchStatus:1,
   StageDetails:{List:[{Key:wanted.Key,Name:wanted.Name,Purpose:wanted.Purpose}]},_stageDetailsInDataFetchStatus:1}});
  const rows=status?.data?.Status?.Results?.List;
  if(!status?.ok||status.truncated===true||rows?.length!==1||rows[0].StageKey!==plan.stageKey||String(rows[0].Status).toLowerCase()!=='success')
   fail('CONNECTION_TEST_NOT_CONFIRMED','The exact custom search stage test must succeed before saving. Nothing was sent.');
 }
 return {approval,expected:{...binding,details:structuredClone(plan.details),stageKey:plan.stageKey,name}};
}
