import {fingerprint,isUuid} from './write-journal.mjs';
import {A2A_SAVE} from './a2a-connection-approval.mjs';
import {a2aDiscoveryOutcome} from './a2a-discovery.mjs';

// Uses only the redacted typed detail. Missing/partial data never confirms save.
export function a2aConnectionObservation(receipt,result){
 const expected=receipt?.reconciliation?.a2aConnection,connection=result?.data?.Connection;
 const base={verified:false,operationId:'connections.detail',connectionId:expected?.connectionId??null};
 if(receipt?.identity?.operationId!==A2A_SAVE||!isUuid(expected?.connectionId)||!result?.ok||result.truncated===true
  ||result.data?.NotFound!==false||!connection)return base;
 const header=expected.details?.ConnectionDetails_Header,configs=expected.details?.ConnectionDetail_StageConfig?.List;
 if(!header||configs?.length!==1||connection.connectionId!==expected.connectionId||connection.providerId!=='a2a'
  ||connection.name!==header.ConnectionName||connection.description!==header.ConnectionDescription||connection.portfolioKey!==header.PortfolioKey
  ||connection.stageConfigurations?.length!==1)return base;
 const observed=connection.stageConfigurations[0],wanted=configs[0];
 let card;try{card=wanted.ConfigurationType==='url'?expected.card:JSON.parse(wanted.AgentCardJson);}catch{return base;}
 if(!card)return base;
 let expectedHash;try{expectedHash=wanted.ConfigurationType==='url'?a2aDiscoveryOutcome({AgentCard:JSON.stringify(card)}).cardSha256:fingerprint(card);}catch{return base;}
 const verified=observed.stageKey===wanted.TenantStage.Key&&observed.a2a?.configurationType===wanted.ConfigurationType
  &&observed.a2a?.authType==='no_auth'&&observed.a2a?.hasCredentialValues===false
  &&typeof wanted.AgentUrl==='string'&&wanted.AgentUrl.length>0&&observed.a2a?.agentUrlSha256===fingerprint(wanted.AgentUrl)
  &&(wanted.ConfigurationType==='url'?observed.a2a?.normalizedAgentCardSha256:observed.a2a?.agentCardSha256)===expectedHash;
 return {...base,verified,stageKey:observed.stageKey,cardVerified:verified};
}
