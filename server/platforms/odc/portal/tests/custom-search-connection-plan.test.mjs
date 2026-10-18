import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {customSearchConnectionPlan,customSearchSaveInput} from '../runtime/custom-search-connection-plan.mjs';
import {fingerprint} from '../runtime/write-journal.mjs';
const uuid=()=>crypto.randomUUID();
const input=()=>({name:'OwnedSearch',description:'Synthetic only',portfolioKey:uuid(),stage:{Key:uuid(),Name:'Development',Purpose:'Development'},endpointURL:'https://example.test/rest/Search/CustomAISearch'});

test('native test contract starts a new test and uses independent empty-header stage lists',()=>{
 const args=input(),p=customSearchConnectionPlan(args),native=p.testInput.inputParameters;
 assert.deepEqual(Object.keys(native),['ConnectionId','ForceErrorOnStageKeys','IsEditConnection','ValidStageConfigs','ConnectionDetails_Header','IsStartTest','EditedStageConfigs','IsConfigChanged']);
 assert.equal(native.IsStartTest,true);assert.equal(native.IsEditConnection,false);assert.equal(native.ConnectionId,'');
 assert.deepEqual(native.ValidStageConfigs,native.EditedStageConfigs);
 assert.notEqual(native.ValidStageConfigs.List[0],native.EditedStageConfigs.List[0]);
 assert.deepEqual(Object.keys(native.ValidStageConfigs.List[0]),['EndpointURL','Headers','HeaderNames','TenantStage']);
 assert.deepEqual(native.ValidStageConfigs.List[0].Headers,{List:[]});assert.deepEqual(native.ValidStageConfigs.List[0].HeaderNames,{List:[]});
 assert.equal(p.sent,false);assert.equal(p.liveVerified,false);assert.equal(p.authentication,'no_auth');
 args.stage.Name='Changed';assert.equal(p.details.ConnectionDetail_StageConfig.List[0].TenantStage.Name,'Development');
});
test('unsafe endpoints and unsupported headers or stage fields never enter a plan',()=>{
 for(const mutate of [x=>x.endpointURL='http://example.test/',x=>x.endpointURL='https://user:secret@example.test/',
  x=>x.endpointURL='https://example.test/?key=secret',x=>x.endpointURL='https://example.test/#secret',
  x=>x.endpointURL=' https://example.test/',x=>x.endpointURL=null,x=>x.headers={Authorization:'private'},
  x=>x.stage.Secret='private',x=>x.stage.Order=-1,x=>x.stage.Order='9007199254740992',
  x=>x.stage.Key='unknown',x=>x.portfolioKey='unknown',x=>x.name=' OwnedSearch',x=>x.description=null]){
  const args=input();mutate(args);assert.throws(()=>customSearchConnectionPlan(args),error=>error.code==='INPUT_INVALID'&&!error.message.includes('private'));
 }
});
test('save binds the reviewed body and explicit native connection ID without aliasing',()=>{
 const p=customSearchConnectionPlan(input()),id=uuid(),save=customSearchSaveInput(p,id,p.planSha256);
 assert.equal(save.inputParameters.ConnectionId,id);assert.equal(save.inputParameters.ForceErrorOnMetadataStatus,false);
 assert.equal(save.inputParameters.ConnectionOriginalUpdateTimestamp,'1900-01-01T00:00:00');
 assert.deepEqual(save.inputParameters.ConnectionDetails,p.details);assert.notEqual(save.inputParameters.ConnectionDetails,p.details);
 assert.throws(()=>customSearchSaveInput(p,'guessed',p.planSha256));
 assert.throws(()=>customSearchSaveInput(p,id,'0'.repeat(64)),{code:'CONNECTION_PLAN_CHANGED'});
});
test('independent endpoint, stage and test flag changes invalidate the reviewed plan',()=>{
 const p=customSearchConnectionPlan(input());
 for(const mutate of [x=>x.details.ConnectionDetail_StageConfig.List[0].EndpointURL='https://foreign.test/',
  x=>x.testInput.inputParameters.IsStartTest=false,x=>x.details.ConnectionDetail_StageConfig.List[0].TenantStage.Key=uuid(),
  x=>x.details.ConnectionDetails_Header.ConnectionName='Other']){
  const changed=structuredClone(p);mutate(changed);
  assert.throws(()=>customSearchSaveInput(changed,uuid(),p.planSha256),{code:'CONNECTION_PLAN_CHANGED'});
 }
});
test('recomputed caller hash cannot enable headers, edits or unsupported native fields',()=>{
 for(const mutate of [x=>x.details.ConnectionDetail_StageConfig.List[0].Headers.List.push({Name:'Authorization',Value:'private'}),
  x=>x.details.ConnectionDetail_StageConfig.List[0].PrivateGatewayPort=443,
  x=>x.testInput.inputParameters.IsEditConnection=true,x=>x.testInput.inputParameters.IsStartTest=false]){
  const p=customSearchConnectionPlan(input());mutate(p);
  p.planSha256=fingerprint({schema:p.schema,details:p.details,testInput:p.testInput});
  assert.throws(()=>customSearchSaveInput(p,uuid(),p.planSha256),{code:'CONNECTION_PLAN_CHANGED'});
 }
});
