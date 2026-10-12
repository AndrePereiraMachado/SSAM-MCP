import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {A2A_DISCOVER,a2aDiscoveryApproval,a2aDiscoveryOutcome} from '../runtime/a2a-discovery.mjs';
import {sha256,fingerprint} from '../runtime/write-journal.mjs';
const uuid=()=>crypto.randomUUID();
const card=()=>({protocolVersion:'0.3.0',name:'Proof',description:'Fixture',version:'1',url:'https://example.test/rpc',capabilities:{streaming:false},
 defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'proof',name:'Proof',description:'Constant',tags:['test']}]});

test('native discovery binds exact normalized base URL and existing stage before sending',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-discovery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Own discovery');
 const host='corp.outsystems.dev',stage=uuid(),words='Synthetic discovery grant';
 const raw={inputParameters:{AgentDiscovery:{url:'https://example.test/agent/',environmentId:stage}}};
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,
  source:{kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Discover own fixture'},proposal:{file:proposal,sha256:sha256(fs.readFileSync(proposal).toString())},
  scope:[{lane:'odc',host,operation:A2A_DISCOVER,environmentKey:stage,targets:['Owned']}],
  constraints:{connectionName:'Owned',agentUrl:raw.inputParameters.AgentDiscovery.url,inputSha256:sha256(JSON.stringify(raw.inputParameters))}}));
 const args={file,host,words,raw,read:async()=>({ok:true,truncated:false,rows:[{Key:stage}]})};
 assert.equal((await a2aDiscoveryApproval(args)).expected.stageKey,stage);
 for(const change of [{words:'Different grant'},{read:async()=>({ok:true,truncated:true,rows:[{Key:stage}]})},
  {raw:{...raw,screenVariables:{Injected:true}}},{raw:{inputParameters:{AgentDiscovery:{url:'https://example.test/?token=secret',environmentId:stage}}}}])
  await assert.rejects(a2aDiscoveryApproval({...args,...change}));
});
test('native discovery rejects authenticated or malformed cards and projects only reviewed fields',()=>{
 const original=card();original.secret='private-unknown';original.capabilities.extra='private-extra';
 const result=a2aDiscoveryOutcome({AgentCard:JSON.stringify(original)});
 assert.equal(result.cardSha256,fingerprint(card()));assert.doesNotMatch(JSON.stringify(result),/private-/);
 for(const value of [{AgentCard:'invalid'},{AgentCard:JSON.stringify({...card(),securitySchemes:{bearer:{}}})},{AgentCard:JSON.stringify({...card(),url:'http://example.test/'})}])
  assert.throws(()=>a2aDiscoveryOutcome(value),e=>e.code==='A2A_CARD_UNVERIFIED');
});

test('discovery diagnostics identify contract shape without echoing unknown names or values',()=>{
 for(const [data,reason] of [[{},'missing-text-card'],[{AgentCard:'private-invalid'},'invalid-card-json'],
  [{AgentCard:'[]'},'card-not-object'],[{AgentCard:JSON.stringify({privateName:'private-value',protocolVersion:'private-version'})},'unsupported-card-contract']]){
  assert.throws(()=>a2aDiscoveryOutcome(data),error=>{
   assert.equal(error.details.reason,reason);assert.doesNotMatch(JSON.stringify(error.details),/private-/);
   if(error.details.shape){assert.equal(error.details.shape.protocolSupported,false);assert.equal(error.details.shape.requiredFields.protocolVersion,true);}
   return true;
  });
 }
});

test('native optional null security is absent, while nonempty and malformed security stays refused',()=>{
 const source=card();source.security=null;source.securitySchemes=null;source.skills[0].security=null;
 assert.deepEqual(a2aDiscoveryOutcome({AgentCard:JSON.stringify(source)}).card,card());
 for(const change of [x=>x.security=[{bearer:[]}],x=>x.securitySchemes={bearer:{type:'http',scheme:'bearer'}},
  x=>x.skills[0].security=[{bearer:[]}],x=>x.security='private',x=>x.securitySchemes=[]]){
  const value=structuredClone(source);change(value);
  assert.throws(()=>a2aDiscoveryOutcome({AgentCard:JSON.stringify(value)}),e=>e.code==='A2A_CARD_UNVERIFIED');
 }
});

test('invalid card diagnostics distinguish nullable optional fields from wrong primitive types',()=>{
 const value=card();value.capabilities.streaming=null;value.skills[0].tags='private-tags';
 assert.throws(()=>a2aDiscoveryOutcome({AgentCard:JSON.stringify(value)}),error=>{
  assert.deepEqual(error.details.shape.fieldKinds,{'card.skills[0].tags':'string','card.capabilities.streaming':'null'});
  assert.doesNotMatch(JSON.stringify(error.details),/private-/);return true;
 });
});

test('observed native null optional state history is absent, while true and false remain explicit',()=>{
 const value=card();value.capabilities.stateTransitionHistory=null;
 assert.deepEqual(a2aDiscoveryOutcome({AgentCard:JSON.stringify(value)}).card,card());
 for(const enabled of [true,false]){
  value.capabilities.stateTransitionHistory=enabled;
  assert.equal(a2aDiscoveryOutcome({AgentCard:JSON.stringify(value)}).card.capabilities.stateTransitionHistory,enabled);
 }
 value.capabilities.stateTransitionHistory='false';
 assert.throws(()=>a2aDiscoveryOutcome({AgentCard:JSON.stringify(value)}),error=>error.details.shape.invalidFields.includes('card.capabilities.stateTransitionHistory'));
});
