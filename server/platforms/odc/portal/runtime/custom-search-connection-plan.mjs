import {fail} from './errors.mjs';
import {isUuid,fingerprint} from './write-journal.mjs';

const SCHEMA='ssam-custom-search-connection-plan/1';
const invalid=()=>fail('INPUT_INVALID','Custom AI Search preparation requires a new connection name, portfolio UUID, one explicit stage and an HTTPS endpoint without credentials, query or fragment. Only empty headers are supported.');
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const text=x=>typeof x==='string'&&x.trim().length>0;
const keys=(x,allowed)=>record(x)&&Object.keys(x).every(k=>allowed.includes(k));

// Pure preparation only. Neither the endpoint nor the tenant is contacted.
// Native contract: Connection_Edit_CustomAISearch, captured 2026-10-10.
// Headers use Name/Value records, not relational or A2A credential fields.
// Authenticated headers deliberately remain unsupported until private transport
// and read-back are implemented. This module does not expose a write route.
export function customSearchConnectionPlan(input){
 if(!keys(input,['name','description','portfolioKey','stage','endpointURL']))invalid();
 const {name,description='',portfolioKey,stage,endpointURL}=input;
 if(!text(name)||name!==name.trim()||name.length>100||typeof description!=='string'||description.length>500
  ||!isUuid(portfolioKey)||!keys(stage,['Key','Name','Purpose','Order','Hosting'])||!isUuid(stage.Key)||!text(stage.Name)||!text(stage.Purpose))invalid();
 const order=stage.Order??'0';
 if(!/^\d+$/.test(String(order))||!Number.isSafeInteger(Number(order))||typeof(stage.Hosting??'')!=='string')invalid();
 let url;try{url=new URL(endpointURL);}catch{invalid();}
 if(typeof endpointURL!=='string'||endpointURL!==endpointURL.trim()||url.protocol!=='https:'||url.username||url.password||url.hash||url.search)invalid();
 const config={EndpointURL:url.href,Headers:{List:[]},HeaderNames:{List:[]},
  TenantStage:{Key:stage.Key,Name:stage.Name,Purpose:stage.Purpose,Order:String(order),Hosting:stage.Hosting??''}};
 const header={ConnectionName:name,ConnectionDescription:description,PortfolioKey:portfolioKey,o11InfrastructureKey:''};
 const details={ConnectionDetails_Header:header,ConnectionDetail_StageConfig:{List:[config]}};
 const testInput={inputParameters:{ConnectionId:'',ForceErrorOnStageKeys:'',IsEditConnection:false,
  ValidStageConfigs:{List:[structuredClone(config)]},ConnectionDetails_Header:structuredClone(header),IsStartTest:true,
  EditedStageConfigs:{List:[structuredClone(config)]},IsConfigChanged:true}};
 const reviewed={schema:SCHEMA,details,testInput};
 return {ok:true,...reviewed,planSha256:fingerprint(reviewed),endpointSha256:fingerprint(url.href),stageKey:stage.Key,
  sent:false,liveVerified:false,authentication:'no_auth',
  limitations:['Preparation only; no dispatch, authorization, successful test, saved connection or ownership is proved.',
   'Only a new single-stage connection with empty headers is supported.',
   'Dispatch must bind endpoint ownership, current tenant/stage, absence of name and durable native receipts before sending.',
   'Saving requires the exact native test ID and successful stage status; read-back and deletion must be independently verified.']};
}

export function customSearchSaveInput(plan,connectionId,expectedPlanSha256){
 if(!plan?.ok||!isUuid(connectionId)||typeof expectedPlanSha256!=='string')invalid();
 const reviewed={schema:plan.schema,details:plan.details,testInput:plan.testInput};
 if(plan.schema!==SCHEMA||plan.planSha256!==expectedPlanSha256||fingerprint(reviewed)!==expectedPlanSha256)
  fail('CONNECTION_PLAN_CHANGED','Custom AI Search plan changed since review; prepare a new plan.');
 // Reconstruct as well as hash: a caller cannot bless arbitrary native fields
 // merely by recomputing the fingerprint.
 const header=plan.details?.ConnectionDetails_Header,configs=plan.details?.ConnectionDetail_StageConfig?.List;
 if(!header||configs?.length!==1)invalid();
 const restored=customSearchConnectionPlan({name:header.ConnectionName,description:header.ConnectionDescription,
  portfolioKey:header.PortfolioKey,stage:configs[0].TenantStage,endpointURL:configs[0].EndpointURL});
 if(restored.planSha256!==expectedPlanSha256)fail('CONNECTION_PLAN_CHANGED','Unsupported Custom AI Search plan content.');
 return {inputParameters:{ConnectionDetails:structuredClone(plan.details),ConnectionId:connectionId,
  ConnectionOriginalUpdateTimestamp:'1900-01-01T00:00:00',ForceErrorOnMetadataStatus:false}};
}
