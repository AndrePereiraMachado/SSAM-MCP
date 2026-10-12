import {fail} from './errors.mjs';
import {isUuid,sha256} from './write-journal.mjs';

const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const text=x=>typeof x==='string'&&x.trim().length>0;
const invalid=()=>fail('INPUT_INVALID','A2A preparation requires an explicit HTTPS agent base URL, a complete version 0.3.0 JSON-RPC card without authentication, one explicit stage and a portfolio UUID.');
const modes=x=>Array.isArray(x)&&x.length>0&&x.every(text);
function endpoint(value){
 let u;try{u=new URL(value);}catch{invalid();}
 if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search)invalid();
 return u.href;
}
// Pure preparation of URL and JSON-card branches. No network, vault, receipt
// reservation or authorization. A future dispatcher must reread the tenant,
// ownership and stage before sending; this plan does not authorize any write.
export function validateA2aCard(card){
 const fields=[];const check=(valid,field)=>{if(!valid&&fields.length<32)fields.push(field);};
 check(record(card),'card');
 if(record(card)){
  check(JSON.stringify(card).length<=131072,'card.size');check(card.protocolVersion==='0.3.0','card.protocolVersion');
  for(const key of ['name','description','version'])check(text(card[key]),'card.'+key);
  check(record(card.capabilities),'card.capabilities');
  check(modes(card.defaultInputModes),'card.defaultInputModes');check(modes(card.defaultOutputModes),'card.defaultOutputModes');
  check(card.preferredTransport===undefined||card.preferredTransport==='JSONRPC','card.preferredTransport');
  check(card.security===undefined||Array.isArray(card.security)&&card.security.length===0,'card.security');
  check(card.securitySchemes===undefined||record(card.securitySchemes)&&Object.keys(card.securitySchemes).length===0,'card.securitySchemes');
  check(card.supportsAuthenticatedExtendedCard!==true,'card.supportsAuthenticatedExtendedCard');
  check(Array.isArray(card.skills)&&card.skills.length>0,'card.skills');
  if(Array.isArray(card.skills)){
   card.skills.forEach((skill,index)=>{
    const at='card.skills['+index+']';check(record(skill),at);
    if(record(skill)){
     for(const key of ['id','name','description'])check(text(skill[key]),at+'.'+key);
     check(Array.isArray(skill.tags)&&skill.tags.every(text),at+'.tags');
     check(skill.security===undefined||Array.isArray(skill.security)&&skill.security.length===0,at+'.security');
    }
   });
   check(new Set(card.skills.map(x=>x?.id)).size===card.skills.length,'card.skills.duplicateIds');
  }
  if(record(card.capabilities))for(const key of ['streaming','pushNotifications','stateTransitionHistory'])
   check(card.capabilities[key]===undefined||typeof card.capabilities[key]==='boolean','card.capabilities.'+key);
  try{endpoint(card.url);}catch{check(false,'card.url');}
 }
 if(fields.length)fail('INPUT_INVALID','The A2A card does not satisfy the supported no_auth 0.3.0 JSONRPC contract.',{invalidFields:fields});
 return structuredClone(card);
}
export function a2aConnectionPlan({name,description='',portfolioKey,stage,card,agentUrl,configurationType='json'}){
 if(!['json','url'].includes(configurationType))invalid();
 if(!text(name)||name.length>100||typeof description!=='string'||description.length>500||!isUuid(portfolioKey)
  ||!record(stage)||!isUuid(stage.Key)||!text(stage.Name)||!text(stage.Purpose))invalid();
 validateA2aCard(card);
 const serviceUrl=endpoint(card.url),baseUrl=endpoint(agentUrl),agentCardJson=JSON.stringify(card);
 const order=stage.Order??'0';if(!/^\d+$/.test(String(order)))invalid();
 const config={ConfigurationType:configurationType,AgentUrl:baseUrl,AgentCardJson:configurationType==='json'?agentCardJson:'',AgentCardJsonFileName:configurationType==='json'?'agent-card.json':'',AuthType:'no_auth',
  SecurityScheme:'',ClientId:'',ClientSecret:'',Scope:'',AccessTokenURL:'',APIKeyLocation:'',APIKeySecret:'',APIKeyName:'',BearerToken:'',Username:'',Password:'',
  IsPrivateGateway:false,PrivateGatewayPort_AgentUrl:0,PrivateGatewayPort_TokenUrl:0,EmbededAgentCard:'',NewAgentCardFetched:true,
  TenantStage:{Key:stage.Key,Name:stage.Name,Purpose:stage.Purpose,Order:String(order),Hosting:stage.Hosting??''}};
 if(typeof config.TenantStage.Hosting!=='string')invalid();
 const header={ConnectionName:name,ConnectionDescription:description,PortfolioKey:portfolioKey,o11InfrastructureKey:''};
 const details={ConnectionDetails_Header:header,ConnectionDetail_StageConfig:{List:[config]}};
 const testInput={inputParameters:{ConnectionId:'',ForceErrorOnStageKeys:'',IsEditConnection:false,
  ValidStageConfigs:{List:[structuredClone(config)]},ConnectionDetails_Header:structuredClone(header),
  EditedStageConfigs:{List:[structuredClone(config)]},IsConfigChanged:true}};
 const fingerprint=configurationType==='url'
  ?{schema:'ssam-a2a-connection-plan/2',details,testInput,card:structuredClone(card)}
  :{schema:'ssam-a2a-connection-plan/1',details,testInput};
 return {ok:true,...fingerprint,planSha256:sha256(JSON.stringify(fingerprint)),agentCardSha256:sha256(agentCardJson),
  endpoint:serviceUrl,agentUrl:baseUrl,stageKey:stage.Key,authentication:'no_auth',sent:false,liveVerified:false,
  limitations:['New single-stage no_auth connections only; edits and authenticated modes are not implemented.',
   'The explicit base URL is distinct from the card service URL. Neither was contacted or verified by this pure planner.',
   'URL dispatch requires the matching confirmed discovery receipt; complete URL CRUD and JSON configuration still require live verification.',
   'Test/save/delete dispatch and ownership reconciliation must be verified before use.']};
}

// Bind the save body to the exact reviewed plan and the ID returned by the
// test. The dispatcher still has to prove successful test status and ownership.
export function a2aSaveInput(plan,connectionId,expectedPlanSha256){
 if(!plan?.ok||!isUuid(connectionId)||!expectedPlanSha256)invalid();
 const fingerprint={schema:plan.schema,details:plan.details,testInput:plan.testInput,...(plan.schema==='ssam-a2a-connection-plan/2'?{card:plan.card}:{})};
 if(!['ssam-a2a-connection-plan/1','ssam-a2a-connection-plan/2'].includes(plan.schema)||sha256(JSON.stringify(fingerprint))!==expectedPlanSha256||plan.planSha256!==expectedPlanSha256)
  fail('CONNECTION_PLAN_CHANGED','A2A plan changed since review; prepare a new plan.');
 return {inputParameters:{ConnectionDetails:structuredClone(plan.details),ConnectionId:connectionId,
  ConnectionOriginalUpdateTimestamp:'1900-01-01T00:00:00',ForceErrorOnMetadataStatus:false}};
}
