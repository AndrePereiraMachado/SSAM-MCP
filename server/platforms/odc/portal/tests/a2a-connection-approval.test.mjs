import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {a2aConnectionPlan,a2aSaveInput} from '../runtime/a2a-connection-plan.mjs';
import {a2aConnectionApproval,A2A_TEST,A2A_SAVE} from '../runtime/a2a-connection-approval.mjs';
import {sha256,fingerprint} from '../runtime/write-journal.mjs';
const id=()=>crypto.randomUUID();
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Owned A2A test fixture');
 const plan=a2aConnectionPlan({name:'OwnedA2A',agentUrl:'https://example.test/agent/',portfolioKey:id(),stage:{Key:id(),Name:'Development',Purpose:'Development'},
  card:{protocolVersion:'0.3.0',name:'Proof',description:'Constant response',version:'1',url:'https://example.test/rpc',capabilities:{streaming:false},
   defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'proof',name:'Proof',description:'Constant',tags:['test']}]}});
 const host='example.outsystems.dev',words='Synthetic own fixture grant',source={kind:'human-conversation',threadId:id(),messageId:id(),question:'Synthetic fixture approval'},originOperationUuid=id(),connectionId=id();
 function context(op,raw){const record={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:sha256(fs.readFileSync(proposal).toString())},
  scope:[{lane:'odc',host,operation:op,environmentKey:plan.stageKey,targets:['OwnedA2A']}],constraints:{planSha256:plan.planSha256,inputSha256:sha256(JSON.stringify(raw.inputParameters)),...(op===A2A_SAVE?{originOperationUuid,connectionId}:{})}};fs.writeFileSync(file,JSON.stringify(record));return record;}
 const read=async(op)=>op==='monitoring.stages'?{ok:true,rows:[{Key:plan.stageKey,Name:'Development',Purpose:'Development'}]}:op==='connections.list'?{ok:true,truncated:false,rows:[]}:{ok:true,data:{Status:{Results:{List:[{StageKey:plan.stageKey,Status:'Success'}]}}}};
 const args={file,words,host,operationId:A2A_TEST,raw:plan.testInput,read};
 return {file,plan,host,words,source,originOperationUuid,connectionId,context,read,args};
}
test('test approval binds exact plan and live stage before any reservation or send',async t=>{
 const f=fixture(t);f.context(A2A_TEST,f.plan.testInput);
 const result=await a2aConnectionApproval(f.args);assert.equal(result.approval.operation,A2A_TEST);assert.equal(result.expected.planSha256,f.plan.planSha256);
 for(const override of [{file:undefined},{raw:{...f.plan.testInput,screenVariables:{Other:'injected'}}},
  {raw:{inputParameters:{...f.plan.testInput.inputParameters,IsEditConnection:true}}},
  {read:async()=>({ok:true,rows:[]})},
  {read:async op=>op==='monitoring.stages'?{ok:true,truncated:true,rows:[{Key:f.plan.stageKey,Name:'Development',Purpose:'Development'}]}:f.read(op)},
  {read:async op=>op==='connections.list'?{ok:true,truncated:true,rows:[]}:f.read(op)},
  {read:async op=>op==='connections.list'?{ok:true,truncated:false,rows:[{Name:'owneda2a'}]}:f.read(op)},
  {read:async op=>op==='monitoring.stages'?{ok:true,rows:[{Key:f.plan.stageKey,Name:'Production',Purpose:'Production'}]}:f.read(op)}])
  await assert.rejects(a2aConnectionApproval({...f.args,...override}));
 const raw=structuredClone(f.plan.testInput);raw.inputParameters.ValidStageConfigs.List[0].Password='private';
 await assert.rejects(a2aConnectionApproval({...f.args,raw}));
});
test('save needs same proposal, native test identity, exact plan and successful stage status',async t=>{
 const f=fixture(t),testRecord=f.context(A2A_TEST,f.plan.testInput),prepared=await a2aConnectionApproval(f.args);
 const raw=a2aSaveInput(f.plan,f.connectionId,f.plan.planSha256);f.context(A2A_SAVE,raw);
 const origin={state:'accepted',createdAt:'2026-10-09T20:00:00Z',identity:{kind:'odc-portal',tenant:f.host,operationId:A2A_TEST},
  response:{Out_ConnectionId:f.connectionId},reconciliation:{a2aConnection:prepared.expected},authorization:{source:f.source,wordsSha256:sha256(f.words),proposalSha256:testRecord.proposal.sha256}};
 const args={...f.args,operationId:A2A_SAVE,raw,lookup:()=>origin};
 const result=await a2aConnectionApproval(args);assert.equal(result.expected.connectionId,f.connectionId);assert.equal(result.expected.originOperationUuid,f.originOperationUuid);
 for(const changed of [{...origin,state:'uncertain'},{...origin,response:{Out_ConnectionId:id()}},
  {...origin,identity:{...origin.identity,tenant:'other.outsystems.dev'}},{...origin,authorization:{...origin.authorization,proposalSha256:'wrong'}},
  {...origin,reconciliation:{}},{...origin,createdAt:'unknown'}])await assert.rejects(a2aConnectionApproval({...args,lookup:()=>changed}));
 for(const rows of [[],[{StageKey:f.plan.stageKey,Status:'Running'}],[{StageKey:f.plan.stageKey,Status:'Error'}],[{StageKey:id(),Status:'Success'}],
  [{StageKey:f.plan.stageKey,Status:'Success'},{StageKey:f.plan.stageKey,Status:'Success'}]])
  await assert.rejects(a2aConnectionApproval({...args,read:async op=>op==='connections.testStatus'?{ok:true,data:{Status:{Results:{List:rows}}}}:f.read(op)}),e=>e.code==='CONNECTION_TEST_NOT_CONFIRMED');
 const mutated=structuredClone(raw);mutated.inputParameters.ConnectionDetails.ConnectionDetails_Header.ConnectionName='Other';
 await assert.rejects(a2aConnectionApproval({...args,raw:mutated}));
});

test('URL test requires confirmed matching discovery and preserves card through save approval',async t=>{
 const f=fixture(t),old=f.plan,config=old.details.ConnectionDetail_StageConfig.List[0];
 const plan=a2aConnectionPlan({name:'OwnedA2A',agentUrl:old.agentUrl,portfolioKey:old.details.ConnectionDetails_Header.PortfolioKey,
  stage:config.TenantStage,card:JSON.parse(config.AgentCardJson),configurationType:'url'});
 const discoveryOperationUuid=id(),record=f.context(A2A_TEST,plan.testInput);
 record.constraints.planSha256=plan.planSha256;record.constraints.discoveryOperationUuid=discoveryOperationUuid;
 fs.writeFileSync(f.file,JSON.stringify(record));
 const discovery={state:'confirmed',identity:{kind:'odc-portal',tenant:f.host,operationId:'connections.a2aDiscover'},
  response:{card:plan.card,cardSha256:fingerprint(plan.card)},reconciliation:{a2aDiscovery:{name:'OwnedA2A',stageKey:plan.stageKey,agentUrl:plan.agentUrl}},
  authorization:{source:f.source,wordsSha256:sha256(f.words),proposalSha256:record.proposal.sha256}};
 const args={...f.args,raw:plan.testInput,lookup:key=>key===discoveryOperationUuid?discovery:null};
 const prepared=await a2aConnectionApproval(args);assert.deepEqual(prepared.expected.card,plan.card);
 assert.equal(prepared.expected.discoveryOperationUuid,discoveryOperationUuid);
 for(const mutate of [x=>x.state='uncertain',x=>delete x.response.card,x=>x.response.cardSha256='changed',
  x=>x.identity.tenant='foreign',x=>x.identity.operationId=A2A_TEST,x=>x.reconciliation.a2aDiscovery.stageKey=id(),
  x=>x.reconciliation.a2aDiscovery.agentUrl='https://other.test/',x=>x.reconciliation.a2aDiscovery.name='Other',
  x=>x.authorization.proposalSha256='other',x=>x.authorization.source.messageId=id()]){
  const changed=structuredClone(discovery);mutate(changed);
  await assert.rejects(a2aConnectionApproval({...args,lookup:()=>changed}));
 }
 const raw=a2aSaveInput(plan,f.connectionId,plan.planSha256),saveRecord=f.context(A2A_SAVE,raw);
 saveRecord.constraints.planSha256=plan.planSha256;fs.writeFileSync(f.file,JSON.stringify(saveRecord));
 const origin={state:'accepted',createdAt:'2026-10-09T20:00:00Z',identity:{kind:'odc-portal',tenant:f.host,operationId:A2A_TEST},
  response:{Out_ConnectionId:f.connectionId},reconciliation:{a2aConnection:prepared.expected},authorization:discovery.authorization};
 const saved=await a2aConnectionApproval({...args,operationId:A2A_SAVE,raw,lookup:()=>origin});
 assert.deepEqual(saved.expected.card,plan.card);assert.equal(saved.expected.discoveryOperationUuid,discoveryOperationUuid);
});
