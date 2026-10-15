import fs from 'node:fs';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {validateA2aCard} from './a2a-connection-plan.mjs';
import {fingerprint,isUuid,sha256} from './write-journal.mjs';
import {fail} from './errors.mjs';
export const A2A_DISCOVER='connections.a2aDiscover';

export function a2aDiscoveryContinuation(operationUuid,expected){
 if(!expected?.stage)return undefined;
 return {tool:'odc_a2a_connection_plan',arguments:{discoveryOperationUuid:operationUuid,name:expected.name,
  agentUrl:expected.agentUrl,stage:structuredClone(expected.stage)},
  why:'Prepare the plan using the confirmed receipt. Supply the explicit portfolioKey and configurationType; omit card.'};
}

export async function a2aDiscoveryApproval({file,words,host,raw,read}){
 const reject=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Agent card discovery requires an exact approved HTTPS base URL, connection name and live stage. Nothing was sent.');
 let record,url;try{
  if(!file||fs.statSync(file).size>32768)reject();record=JSON.parse(fs.readFileSync(file,'utf8'));
  url=new URL(raw.inputParameters?.AgentDiscovery?.url);
 }catch{reject();}
 const agent=raw.inputParameters.AgentDiscovery,name=record.constraints?.connectionName;
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||!isUuid(agent.environmentId)
  ||typeof name!=='string'||!name.trim()||name.length>100
  ||fingerprint(raw.inputParameters)!==fingerprint({AgentDiscovery:{url:url.href,environmentId:agent.environmentId}})
  ||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)reject();
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:A2A_DISCOVER,environmentKey:agent.environmentId,targets:[name],
  constraints:{connectionName:name,agentUrl:url.href,inputSha256:sha256(JSON.stringify(raw.inputParameters))}});
 const stages=await read('monitoring.stages',{});
 if(!stages?.ok||stages.truncated===true||!Array.isArray(stages.rows)||stages.rows.filter(s=>s.Key===agent.environmentId).length!==1)reject();
 const observed=stages.rows.find(stage=>stage.Key===agent.environmentId);
 const stage=Object.fromEntries(['Key','Name','Purpose','Order','Hosting'].filter(key=>observed[key]!==undefined).map(key=>[key,observed[key]]));
 return {approval,expected:{name,agentUrl:url.href,stageKey:agent.environmentId,stage}};
}

// Never return the raw string, authentication declarations or unknown fields.
// This first integration accepts only the same no_auth 0.3.0 JSONRPC cards as
// the planner; other modes remain pending rather than silently losing security.
export function a2aDiscoveryOutcome(data){
 const reject=(reason,shape)=>fail('A2A_CARD_UNVERIFIED','Discovery did not return a supported no_auth A2A card. Raw response withheld.',{reason,...(shape?{shape}:{})});
 if(typeof data?.AgentCard!=='string')reject('missing-text-card');
 if(data.AgentCard.length>131072)reject('card-too-large');
 let original;try{original=JSON.parse(data.AgentCard);}catch{reject('invalid-card-json');}
 if(!original||typeof original!=='object'||Array.isArray(original))reject('card-not-object');
 // Optional security fields serialized as null carry no authentication
 // declaration. Normalize only those nullable slots; never discard nonempty
 // schemes/requirements or convert malformed non-null values to no_auth.
 if(original.security===null)delete original.security;
 if(original.securitySchemes===null)delete original.securitySchemes;
 if(Array.isArray(original.skills))for(const skill of original.skills)if(skill&&typeof skill==='object'&&skill.security===null)delete skill.security;
 if(Array.isArray(original.skills))for(const skill of original.skills)if(skill&&typeof skill==='object')
  for(const key of ['inputModes','outputModes','examples'])if(skill[key]===null)delete skill[key];
 // Observed native nullable optional capability; null declares no support.
 // Preserve explicit true/false, and continue rejecting other wrong types.
 if(original.capabilities?.stateTransitionHistory===null)delete original.capabilities.stateTransitionHistory;
 try{validateA2aCard(original);}catch(error){
  const invalidFields=error.details?.invalidFields??['card'];
  const fieldKinds=Object.fromEntries(invalidFields.map(field=>{
   const parts=field.replace(/^card\.?/,'').replace(/\[(\d+)\]/g,'.$1').split('.').filter(Boolean);
   let value=original;for(const part of parts)value=value&&typeof value==='object'?value[part]:undefined;
   return [field,value===null?'null':Array.isArray(value)?'array':typeof value];
  }));
  reject('unsupported-card-contract',{
   invalidFields,fieldKinds,
   requiredFields:Object.fromEntries(['protocolVersion','name','description','version','url','capabilities','defaultInputModes','defaultOutputModes','skills'].map(key=>[key,Object.hasOwn(original,key)])),
   protocolSupported:original.protocolVersion==='0.3.0',transportSupported:original.preferredTransport===undefined||original.preferredTransport==='JSONRPC',
   securityDeclared:original.security!==undefined,securitySchemesDeclared:original.securitySchemes!==undefined,
   securityKind:original.security===undefined?'absent':Array.isArray(original.security)?'array':typeof original.security,
   securityEmpty:Array.isArray(original.security)&&original.security.length===0,
   securitySchemesKind:original.securitySchemes===undefined?'absent':Array.isArray(original.securitySchemes)?'array':typeof original.securitySchemes,
   securitySchemesEmpty:Boolean(original.securitySchemes&&typeof original.securitySchemes==='object'&&Object.keys(original.securitySchemes).length===0),
   skillsArray:Array.isArray(original.skills),capabilitiesObject:Boolean(original.capabilities&&typeof original.capabilities==='object'&&!Array.isArray(original.capabilities))});
 }
 const keep=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
 const card=keep(original,['protocolVersion','name','description','version','url','preferredTransport','defaultInputModes','defaultOutputModes']);
 card.capabilities=keep(original.capabilities,['streaming','pushNotifications','stateTransitionHistory']);
 card.skills=original.skills.map(skill=>keep(skill,['id','name','description','tags','inputModes','outputModes','examples']));
 validateA2aCard(card);
 return {card,cardSha256:fingerprint(card),projection:true};
}
