import fs from 'node:fs';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {a2aConnectionPlan,a2aSaveInput} from './a2a-connection-plan.mjs';
import {fail} from './errors.mjs';
import {isUuid,sha256,fingerprint} from './write-journal.mjs';
export const A2A_TEST='connections.a2aTest',A2A_SAVE='connections.a2aSave';
const reject=()=>fail('AUTHORIZATION_CONTEXT_INVALID','A2A authorization must bind the exact new connection plan, stage and native test receipt. Nothing was sent.');
const list=x=>Array.isArray(x)?x:Array.isArray(x?.List)?x.List:null;

function restorePlan(details,discoveredCard,receiptCard=false){
 const header=details?.ConnectionDetails_Header,configs=details?.ConnectionDetail_StageConfig?.List;
 if(!header||!Array.isArray(configs)||configs.length!==1)reject();
 let card;try{card=configs[0].ConfigurationType==='url'?discoveredCard:JSON.parse(configs[0].AgentCardJson);}catch{reject();}
 if(discoveredCard&&configs[0].ConfigurationType==='json'&&fingerprint(card)!==fingerprint(discoveredCard))
  fail('A2A_DISCOVERY_CARD_MISMATCH','The native JSON card differs from the confirmed discovery receipt. Prepare a new plan using discoveryOperationUuid and omit card. Nothing was sent.');
 const plan=a2aConnectionPlan({name:header.ConnectionName,description:header.ConnectionDescription,
  portfolioKey:header.PortfolioKey,stage:configs[0].TenantStage,card,agentUrl:configs[0].AgentUrl,configurationType:configs[0].ConfigurationType},{receiptCard:receiptCard||Boolean(discoveredCard)});
 if(fingerprint(plan.details)!==fingerprint(details))reject();
 return plan;
}
async function currentStage(plan,read){
 const result=await read('monitoring.stages',{}),rows=result?.rows;
 if(!result?.ok||result.truncated===true||!Array.isArray(rows)||rows.filter(s=>s.Key===plan.stageKey).length!==1)reject();
 const observed=rows.find(s=>s.Key===plan.stageKey),wanted=plan.details.ConnectionDetail_StageConfig.List[0].TenantStage;
 if(observed.Name!==wanted.Name||observed.Purpose!==wanted.Purpose)reject();
}
function constraintsFrom(file){
 try{if(!file||fs.statSync(file).size>32768)reject();return JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{reject();}
}
// No send/reservation occurs here. The caller must durably store expected before
// dispatch and use its normal UUID journal. Only new, single-stage no_auth
// connections are covered; URL mode additionally binds a confirmed discovery.
// Edits and secret transports stay refused.
export async function a2aConnectionApproval({file,words,host,operationId,raw,lookup,read}){
 if(!file||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)reject();
 const p=raw.inputParameters;
 let plan,origin,originOperationUuid,discovery,discoveryOperationUuid;
 if(operationId===A2A_TEST){
  const constraints=constraintsFrom(file);
  if(p?.ValidStageConfigs?.List?.[0]?.ConfigurationType==='url'||constraints?.discoveryOperationUuid!==undefined){
   discoveryOperationUuid=constraints?.discoveryOperationUuid;
   if(!isUuid(discoveryOperationUuid)||typeof lookup!=='function')reject();
   discovery=lookup(discoveryOperationUuid);
   if(discovery?.state!=='confirmed'||discovery.identity?.kind!=='odc-portal'||discovery.identity.tenant!==host
    ||discovery.identity.operationId!=='connections.a2aDiscover'||!discovery.response?.card
    ||fingerprint(discovery.response.card)!==discovery.response.cardSha256)reject();
  }
  plan=restorePlan({ConnectionDetails_Header:p?.ConnectionDetails_Header,ConnectionDetail_StageConfig:p?.ValidStageConfigs},discovery?.response.card);
  if(discovery){
   const expected=discovery.reconciliation?.a2aDiscovery;
   if(expected?.stageKey!==plan.stageKey||expected.agentUrl!==plan.agentUrl||expected.name!==plan.details.ConnectionDetails_Header.ConnectionName)reject();
   const config=plan.details.ConnectionDetail_StageConfig.List[0];
   if(config.ConfigurationType==='json'&&fingerprint(JSON.parse(config.AgentCardJson))!==fingerprint(discovery.response.card))
    fail('A2A_DISCOVERY_CARD_MISMATCH','The native JSON card differs from the confirmed discovery receipt. Prepare a new plan using discoveryOperationUuid and omit card. Nothing was sent.');
  }
  if(fingerprint(p)!==fingerprint(plan.testInput.inputParameters))reject();
 }else if(operationId===A2A_SAVE){
  const constraints=constraintsFrom(file);originOperationUuid=constraints?.originOperationUuid;
  if(!isUuid(originOperationUuid))reject();origin=lookup(originOperationUuid);
  if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.kind!=='odc-portal'||origin.identity.tenant!==host
    ||origin.identity.operationId!==A2A_TEST||!isUuid(origin.response?.Out_ConnectionId)||origin.response.Out_ConnectionId!==p?.ConnectionId)reject();
  const expected=origin.reconciliation?.a2aConnection;
  plan=restorePlan(expected?.details,expected?.card,true);
  if(expected.planSha256!==plan.planSha256||fingerprint(p)!==fingerprint(a2aSaveInput(plan,p.ConnectionId,plan.planSha256).inputParameters))reject();
 }else reject();
 const name=plan.details.ConnectionDetails_Header.ConnectionName;
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,environmentKey:plan.stageKey,targets:[name],constraints:{
  planSha256:plan.planSha256,inputSha256:sha256(JSON.stringify(p)),...(origin?{originOperationUuid,connectionId:p.ConnectionId}:{}),...(discovery?{discoveryOperationUuid}:{})}});
 if(!approval)reject();
 if(origin&&(origin.authorization?.wordsSha256!==approval.wordsSha256||origin.authorization.proposalSha256!==approval.proposalSha256
  ||origin.authorization.source?.threadId!==approval.source.threadId||origin.authorization.source?.messageId!==approval.source.messageId))reject();
 if(discovery&&(discovery.authorization?.wordsSha256!==approval.wordsSha256||discovery.authorization.proposalSha256!==approval.proposalSha256
  ||discovery.authorization.source?.threadId!==approval.source.threadId||discovery.authorization.source?.messageId!==approval.source.messageId))reject();
 await currentStage(plan,read);
 if(operationId===A2A_TEST){
  const inventory=await read('connections.list',{});
  if(!inventory?.ok||inventory.truncated!==false||!Array.isArray(inventory.rows)
   ||inventory.rows.some(row=>typeof(row.Name??row.ConnectionName)!=='string'))reject();
  if(inventory.rows.some(row=>(row.Name??row.ConnectionName).toLowerCase()===name.toLowerCase()))
   fail('CONNECTION_ALREADY_EXISTS','A connection with the approved name is already present. Reconcile before any write.');
 }else{
  if(!Number.isFinite(Date.parse(origin.createdAt)))reject();
  const stage=plan.details.ConnectionDetail_StageConfig.List[0].TenantStage;
  const result=await read('connections.testStatus',{clientVariables:{ConnectionListSearchValue:''},screenVariables:{
   InitDateTime:new Date(origin.createdAt).toISOString().replace('T',' ').slice(0,19),ConnectionId:p.ConnectionId,_connectionIdInDataFetchStatus:1,
   StageDetails:{List:[{Key:stage.Key,Name:stage.Name,Purpose:stage.Purpose}]},_stageDetailsInDataFetchStatus:1}});
  const rows=list(result?.data?.Status?.Results);
  if(!result?.ok||!rows||rows.length!==1||rows[0].StageKey!==plan.stageKey||String(rows[0].Status).toLowerCase()!=='success')
   fail('CONNECTION_TEST_NOT_CONFIRMED','The exact A2A stage test must succeed before saving. Nothing was sent.');
 }
 return {approval,expected:{planSha256:plan.planSha256,details:structuredClone(plan.details),stageKey:plan.stageKey,name,
  ...(discoveryOperationUuid?{discoveryOperationUuid}:{}),
  ...(plan.card?{card:structuredClone(plan.card),discoveryOperationUuid:discoveryOperationUuid??origin?.reconciliation?.a2aConnection?.discoveryOperationUuid}:{}),
  ...(origin?{connectionId:p.ConnectionId,originOperationUuid}:{})}};
}
