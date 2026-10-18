import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {a2aConnectionPlan,a2aSaveInput,validateA2aCard} from '../runtime/a2a-connection-plan.mjs';
const input=()=>({name:'A2AProof',description:'Owned',agentUrl:'https://example.test/agent/',portfolioKey:crypto.randomUUID(),stage:{Key:crypto.randomUUID(),Name:'Development',Purpose:'Development'},
 card:{protocolVersion:'0.3.0',name:'Proof',description:'Constant response',version:'1',url:'https://example.test/rpc',capabilities:{streaming:false,pushNotifications:false},
 defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'proof',name:'Proof',description:'Constant',tags:['test']}]}});
test('URL mode binds reviewed card outside native bodies and detects independent card mutation',()=>{
 const args={...input(),configurationType:'url'},p=a2aConnectionPlan(args),id=crypto.randomUUID();
 assert.equal(p.schema,'ssam-a2a-connection-plan/2');assert.deepEqual(p.card,args.card);
 for(const config of [p.details.ConnectionDetail_StageConfig.List[0],p.testInput.inputParameters.ValidStageConfigs.List[0],p.testInput.inputParameters.EditedStageConfigs.List[0]]){
  assert.equal(config.ConfigurationType,'url');assert.equal(config.AgentCardJson,'');assert.equal(config.AgentCardJsonFileName,'');assert.equal(config.AgentUrl,args.agentUrl);
 }
 const save=a2aSaveInput(p,id,p.planSha256);assert.doesNotMatch(JSON.stringify(save),/Constant response/);
 const changed=structuredClone(p);changed.card.capabilities.streaming=true;
 assert.throws(()=>a2aSaveInput(changed,id,p.planSha256),{code:'CONNECTION_PLAN_CHANGED'});
 args.card.name='changed';assert.equal(p.card.name,'Proof');
 assert.throws(()=>a2aConnectionPlan({...args,configurationType:'unknown'}),{code:'INPUT_INVALID'});
});
test('JSON-card plan preserves false capabilities and distinct stage lists without credentials or a send',()=>{
 const args=input(),p=a2aConnectionPlan(args),t=p.testInput.inputParameters;
 assert.equal(p.sent,false);assert.equal(p.liveVerified,false);assert.equal(t.IsEditConnection,false);
 assert.equal(t.ValidStageConfigs.List[0].AgentUrl,args.agentUrl);assert.notEqual(p.agentUrl,p.endpoint);
 assert.deepEqual(t.ValidStageConfigs,t.EditedStageConfigs);assert.notEqual(t.ValidStageConfigs.List[0],t.EditedStageConfigs.List[0]);
 assert.equal(JSON.parse(t.ValidStageConfigs.List[0].AgentCardJson).capabilities.streaming,false);
 assert.equal(t.ValidStageConfigs.List[0].AuthType,'no_auth');assert.equal(t.ValidStageConfigs.List[0].ClientSecret,'');
 const id=crypto.randomUUID(),save=a2aSaveInput(p,id,p.planSha256);assert.equal(save.inputParameters.ConnectionId,id);
 assert.deepEqual(save.inputParameters.ConnectionDetails,p.details);
 args.card.name='Changed';assert.equal(JSON.parse(p.details.ConnectionDetail_StageConfig.List[0].AgentCardJson).name,'Proof');
});
test('missing card capabilities, authenticated skills, wrong transport and unsafe URL inputs are refused',()=>{
 for(const mutate of [x=>delete x.agentUrl,x=>x.agentUrl='',x=>x.agentUrl='https://user:password@example.test/',x=>x.agentUrl='https://example.test/?token=secret',
  x=>delete x.card.capabilities,x=>x.card.security=[{bearer:[]}],x=>x.card.securitySchemes={secret:{}},
  x=>x.card.skills[0].security=[{key:[]}],x=>x.card.preferredTransport='HTTP+JSON',x=>x.card.url='http://example.test/rpc',
  x=>x.card.url='https://user:password@example.test/rpc',x=>x.card.url='https://example.test/rpc?token=sensitive',
  x=>x.card.skills.push({...x.card.skills[0]}),x=>x.stage.Key='unknown',x=>x.portfolioKey='unknown',x=>x.card.capabilities.streaming='false']){
  const args=input();mutate(args);assert.throws(()=>a2aConnectionPlan(args),e=>e.code==='INPUT_INVALID');
 }
});
test('save refuses mutated reviewed plan and never uses a guessed connection ID',()=>{
 const p=a2aConnectionPlan(input()),id=crypto.randomUUID();
 assert.throws(()=>a2aSaveInput(p,'unknown',p.planSha256));
 const edited=structuredClone(p);edited.details.ConnectionDetails_Header.ConnectionName='Other';
 assert.throws(()=>a2aSaveInput(edited,id,p.planSha256),e=>e.code==='CONNECTION_PLAN_CHANGED');
 assert.throws(()=>a2aSaveInput(p,id,'0'.repeat(64)),e=>e.code==='CONNECTION_PLAN_CHANGED');
});

test('card diagnostics return bounded known field paths, never invalid values or arbitrary names',()=>{
 const card=input().card;card.capabilities.stateTransitionHistory=null;card.skills[0].tags='private-tags';card.url='https://user:private@example.test/';
 assert.throws(()=>validateA2aCard(card),error=>{
  assert.deepEqual(error.details.invalidFields,['card.skills[0].tags','card.capabilities.stateTransitionHistory','card.url']);
  assert.doesNotMatch(JSON.stringify(error.details),/private|user|example/);return true;
 });
 card.skills=Array.from({length:100},()=>({id:'private'}));
 assert.throws(()=>validateA2aCard(card),error=>error.details.invalidFields.length===32);
});
