import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fingerprint,isUuid,sha256} from './write-journal.mjs';
import {A2A_TEST} from './a2a-connection-approval.mjs';
import {fail} from './errors.mjs';
import {ownedCleanupApproval} from './owned-cleanup-approval.mjs';
import {a2aDiscoveryOutcome} from './a2a-discovery.mjs';

export function a2aDeleteApproval({file,words,host,origin,originOperationUuid,connectionId,detail,dependencies,metadata,failedTest,provisional}){
 const reject=()=>fail('AUTHORIZATION_CONTEXT_INVALID','A2A cleanup requires the originating test receipt, unchanged owned connection and complete empty consumer scope. Nothing was sent.');
 const expected=origin?.reconciliation?.a2aConnection,header=expected?.details?.ConnectionDetails_Header,configs=expected?.details?.ConnectionDetail_StageConfig?.List;
 const connection=detail?.Connection;
 if(!isUuid(originOperationUuid)||!isUuid(connectionId)||origin?.identity?.kind!=='odc-portal'||origin.identity.tenant!==host
  ||origin.identity.operationId!==A2A_TEST||!['accepted','confirmed'].includes(origin.state)||origin.response?.Out_ConnectionId!==connectionId
  ||!header||configs?.length!==1||detail?.NotFound!==false||connection?.connectionId!==connectionId||connection.providerId!=='a2a'
  ||connection.name!==header.ConnectionName||connection.portfolioKey!==header.PortfolioKey||connection.description!==header.ConnectionDescription
  ||connection.stageConfigurations?.length!==1||connection.externalMetadata?.selectedObjectCount!==0)reject();
 const actionCount=connection.externalMetadata?.selectedActionCount;
 if(actionCount!==0&&(actionCount!==1||metadata?.verified!==true||metadata.connectionId!==connectionId
  ||metadata.stateSha256!==fingerprint(connection)||fingerprint(metadata.actions)!==fingerprint(['SendMessage'])))reject();
 const stage=connection.stageConfigurations[0],wanted=configs[0];
 let card;try{card=wanted.ConfigurationType==='url'?expected.card:JSON.parse(wanted.AgentCardJson);}catch{reject();}
 if(!card||!['json','url'].includes(wanted.ConfigurationType))reject();
 let expectedCardHash;try{expectedCardHash=wanted.ConfigurationType==='url'?a2aDiscoveryOutcome({AgentCard:JSON.stringify(card)}).cardSha256:fingerprint(card);}catch{reject();}
 const failedRows=failedTest?.data?.Status?.Results?.List;
 const failedWithoutCard=failedTest?.ok===true&&failedTest.truncated!==true&&Array.isArray(failedRows)&&failedRows.length===1
  &&failedRows[0].StageKey===wanted.TenantStage.Key&&String(failedRows[0].Status).toLowerCase()==='error'
  &&actionCount===0&&stage.a2a?.agentCardSha256===null&&stage.a2a?.normalizedAgentCardSha256===null;
 if(stage.stageKey!==wanted.TenantStage.Key||stage.a2a?.configurationType!==wanted.ConfigurationType||stage.a2a?.authType!=='no_auth'
  ||stage.a2a?.hasCredentialValues!==false||(!failedWithoutCard&&(wanted.ConfigurationType==='url'?stage.a2a?.normalizedAgentCardSha256:stage.a2a?.agentCardSha256)!==expectedCardHash)
  ||!wanted.AgentUrl||stage.a2a?.agentUrlSha256!==fingerprint(wanted.AgentUrl))reject();
 const emptyProvisional=failedWithoutCard&&provisional?.verified===true&&provisional.connectionId===connectionId
  &&provisional.stateSha256===fingerprint(connection)&&provisional.neverGenerated===true&&provisional.assetAbsent===true;
 if(!emptyProvisional&&(!dependencies?.ok||dependencies.name!==connection.name||dependencies.includesPublishingDefault!==true
  ||!Array.isArray(dependencies.checkedEnvironments)||!dependencies.checkedEnvironments.includes(stage.stageKey)
  ||!Array.isArray(dependencies.consumers)||dependencies.consumers.length))
  fail('CONNECTION_DEPENDENCIES_UNVERIFIED','A2A cleanup requires a complete empty consumer inventory including its stage and publishing scope. Nothing was sent.');
 const scope={lane:'odc',host,operation:'connections.delete',environmentKey:stage.stageKey,targets:[connection.name],
  constraints:{originOperationUuid,connectionId,expectedStateSha256:fingerprint(connection),planSha256:expected.planSha256}};
 // CX15 r3 (N3): after the guard validated the owner's reply to the preview, a new approval of that reply (proposal = the
 // preview) bound to this test receipt replaces the creation's words and message.
 const fresh=ownedCleanupApproval({file,words,...scope,origin,key:connectionId,what:'The A2A cleanup'});
 if(fresh)return fresh;
 const approval=authorizationContext(file,words,scope);
 if(!approval||origin.authorization?.wordsSha256!==sha256(words)||origin.authorization.proposalSha256!==approval.proposalSha256
  ||origin.authorization.source?.threadId!==approval.source.threadId||origin.authorization.source?.messageId!==approval.source.messageId)reject();
 return approval;
}
