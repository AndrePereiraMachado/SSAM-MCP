import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionHeaderPlan} from '../runtime/connection-header-plan.mjs';
const identity = {connectionId: 'fixture-id', providerId: 'mssql'};
const stamp = '2026-10-09T22:00:00Z';
function detail() {return {NotFound:false, Connection: {...identity, name:'OwnedFixture', description:'Original', portfolioKey:'portfolio',
  variant:'vanilla', updatedOn:stamp, ExternalMetadata:{selectedObjectCount:0,selectedActionCount:0},
  NullValueHandling: Object.fromEntries(['NullWriteBehavior','Boolean','Date','Time','DateTime','Integer','LongInteger','Decimal','Text'].map(key=>[key,key==='Text'?'preserve-original':''])),
  StageConfigurations:{List:[{StageKey:'dev',configurationValues:{List:[{key:'host',value:'db.test'},{key:'port',value:'1433'},
    {key:'database',value:'Fixture'},{key:'password',value:'PRIVATE_PASSWORD'},{key:'user',value:'PRIVATE_USER'}]}}]}}};}
test('header plan preserves null handling and portfolio, sends no stages or credentials and does not mutate baseline',()=>{
 const before=detail(), snapshot=structuredClone(before);
 const plan=connectionHeaderPlan(before,identity,{description:''},stamp);
 assert.equal(plan.changed,true);assert.equal(plan.sent,false);assert.equal(plan.requiresNameAvailability,false);
 assert.deepEqual(plan.input.inputParameters.ConnectionDetails.ConnectionDetail_StageConfig,{List:[]});
 assert.equal(plan.input.inputParameters.ConnectionDetails.ConnectionDetails_Header.ConnectionDescription,'');
 assert.equal(plan.input.inputParameters.ConnectionDetails.ConnectionDetails_Header.PortfolioKey,'portfolio');
 assert.deepEqual(plan.input.inputParameters.ConnectionDetails.NullValueHandling,before.Connection.NullValueHandling);
 assert.equal(plan.input.inputParameters.ConnectionOriginalUpdateTimestamp,stamp);
 assert.doesNotMatch(JSON.stringify(plan),/PRIVATE_|configurationValues/);assert.deepEqual(before,snapshot);
 const renamed=connectionHeaderPlan(before,identity,{name:'OwnedFixtureRenamed'},stamp);
 assert.equal(renamed.requiresNameAvailability,true);assert.equal(renamed.restores.name,'OwnedFixture');
 assert.equal(connectionHeaderPlan(before,identity,{description:'Original'},stamp).changed,false);
 const drift=detail();drift.Connection.description='Concurrent edit';
 assert.notEqual(connectionHeaderPlan(drift,identity,{description:''},stamp).baselineSha256,plan.baselineSha256);
});
test('header plan rejects stale timestamps, incomplete policies, wrong identity and endpoint patches',()=>{
 assert.throws(()=>connectionHeaderPlan(detail(),identity,{description:''},'old'),{code:'CONNECTION_CHANGED'});
 assert.throws(()=>connectionHeaderPlan({NotFound:true},identity,{description:''},stamp),{code:'CONNECTION_NOT_FOUND'});
 for(const patch of [{},{password:'x'},{server:'other'},[],{name:' '},{description:null},{name:'x'.repeat(101)}])
   assert.throws(()=>connectionHeaderPlan(detail(),identity,patch,stamp),{code:'INPUT_INVALID'});
 for(const change of [x=>x.Connection.connectionId='other',x=>delete x.Connection.description,
   x=>x.Connection.variant='other',x=>x.Connection.updatedOn='1900-01-01T00:00:00',
   x=>delete x.Connection.NullValueHandling.Text,x=>x.Connection.NullValueHandling.Unknown='unreviewed']){
   const data=detail();change(data);const snapshot=structuredClone(data);
   assert.throws(()=>connectionHeaderPlan(data,identity,{description:''},stamp),{code:'PORTAL_CONTRACT_CHANGED'});
   assert.deepEqual(data,snapshot);
 }
});
