import test from 'node:test';import assert from 'node:assert/strict';
import {a2aConnectionObservation} from '../runtime/a2a-connection-observation.mjs';
import {fingerprint} from '../runtime/write-journal.mjs';
const id='11111111-1111-4111-8111-111111111111';
test('A2A save confirmation needs exact identity, header, stage, auth and embedded card',()=>{
 const card={url:'https://example.test/rpc',capabilities:{streaming:false}};
 const receipt={identity:{operationId:'connections.a2aSave'},reconciliation:{a2aConnection:{connectionId:id,details:{
  ConnectionDetails_Header:{ConnectionName:'Own',ConnectionDescription:'Proof',PortfolioKey:'portfolio'},
  ConnectionDetail_StageConfig:{List:[{AgentUrl:'https://example.test/agent/',AgentCardJson:JSON.stringify(card),ConfigurationType:'json',TenantStage:{Key:'dev'}}]}}}}};
 const result={ok:true,data:{NotFound:false,Connection:{connectionId:id,name:'Own',description:'Proof',portfolioKey:'portfolio',providerId:'a2a',
  stageConfigurations:[{stageKey:'dev',a2a:{configurationType:'json',authType:'no_auth',hasCredentialValues:false,agentUrlSha256:fingerprint('https://example.test/agent/'),agentCardSha256:fingerprint(card)}}]}}};
 assert.equal(a2aConnectionObservation(receipt,result).verified,true);
 for(const mutate of [r=>r.ok=false,r=>r.truncated=true,r=>r.data.NotFound=true,r=>r.data.Connection.connectionId='foreign',
  r=>r.data.Connection.providerId='mssql',r=>r.data.Connection.name='other',r=>r.data.Connection.description='changed',
  r=>r.data.Connection.portfolioKey='other',r=>r.data.Connection.stageConfigurations.push(r.data.Connection.stageConfigurations[0]),
  r=>r.data.Connection.stageConfigurations[0].stageKey='prod',r=>r.data.Connection.stageConfigurations[0].a2a.agentCardSha256=null,
  r=>r.data.Connection.stageConfigurations[0].a2a.agentUrlSha256=fingerprint('https://foreign.test/'),
  r=>r.data.Connection.stageConfigurations[0].a2a.authType='basic',r=>r.data.Connection.stageConfigurations[0].a2a.hasCredentialValues=true]){
   const changed=structuredClone(result);mutate(changed);assert.equal(a2aConnectionObservation(receipt,changed).verified,false);
 }
 assert.equal(a2aConnectionObservation({...receipt,identity:{operationId:'connections.a2aTest'}},result).verified,false);
});
