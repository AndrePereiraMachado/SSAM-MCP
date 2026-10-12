import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareTimerWake, timerWakeInput} from '../runtime/portal-timer.mjs';
const stage='aaaaaaaa-1111-4111-8111-111111111111', app='bbbbbbbb-2222-4222-8222-222222222222', timer='cccccccc-3333-4333-8333-333333333333';
export function timerFixture() {
  const input={inputParameters:{StageKey:stage,ApplicationKey:app,TimerKey:timer},screenVariables:{},clientVariables:{}};
  const configuration={ok:true,data:{key:null,name:null,revisionBaseline:7,revisionDeployed:7,timers:[{key:timer,name:'ProofTick',configs:[{key:'IsActive',dataType:'Boolean',isSecret:false,value:'True',deployedValue:'True'}]}]}};
  const application={ok:true,data:{assetKey:app,name:'ProofApp',revision:7}};
  const info={ok:true,data:{NotFound:false,TimerInfo:{HasPendingConfigurations:false,Timer:{Key:timer,Name:'ProofTick',Configs:{IsActive:{Current:true,Deployed:true}}}}}};
  const current={ok:true,data:{TimerRunInformation:{isRunning:false,isPendingRun:false,lastRunStartedOn:'1900-01-01T00:00:00'}}};
  const calls=[];
  return {input,configuration,application,info,current,calls, deps:{
    configuration:async path=>{assert.deepEqual(path,{environmentKey:stage,applicationKey:app});calls.push('configuration');return configuration;},
    application:async path=>{assert.deepEqual(path,{assetKey:app,revisionNumber:configuration.data.revisionDeployed});calls.push('application');return application;},
    portalRead:async(id,variables)=>{assert.equal(variables.stageid,stage);assert.equal(variables.appid,app);assert.equal(variables.id,timer);calls.push(id);return id==='timers.info'?info:current;},
  }};
}
test('Wake preparation binds a sparse configuration DTO to the exact deployed application and timer',async()=>{
  const f=timerFixture(), plan=await prepareTimerWake(f.input,f.deps);
  assert.deepEqual(f.calls,['configuration','application','timers.info','timers.currentRun']);
  assert.equal(plan.before.revision,7);assert.equal(plan.before.applicationName,'ProofApp');assert.equal(plan.before.timerName,'ProofTick');
  assert.deepEqual(plan.target,{environmentKey:stage,applicationKey:app,timerKey:timer});
  assert.equal(plan.observation.operationId,'timers.currentRun');
});
test('Wake accepts only its three UUID inputs and normalizes the journal target',()=>{
  const f=timerFixture();
  const upper=structuredClone(f.input);for(const key of Object.keys(upper.inputParameters))upper.inputParameters[key]=upper.inputParameters[key].toUpperCase();
  assert.deepEqual(timerWakeInput(upper),f.input);
  for(const change of [x=>{x.inputParameters.TimerKey='not-a-key';},x=>{x.inputParameters.IgnoreState=true;},x=>{x.screenVariables.id=timer;},x=>{x.clientVariables.StageKey=stage;},x=>{delete x.inputParameters.StageKey;}]) {
    const bad=structuredClone(f.input);change(bad);assert.throws(()=>timerWakeInput(bad),{code:'INPUT_INVALID'});
  }
});
test('unreadable, conflicting, pending and busy timer states cannot produce a Wake plan',async t=>{
  const cases=[
    ['configuration read denied',f=>{f.configuration.ok=false;},'TIMER_CONTEXT_UNAVAILABLE'],
    ['revision drift',f=>{f.configuration.data.revisionBaseline=8;},'TIMER_CONTEXT_UNPROVEN'],
    ['asset identity changed',f=>{f.application.data.assetKey=stage;},'TIMER_CONTEXT_UNPROVEN'],
    ['asset revision changed',f=>{f.application.data.revision=8;},'TIMER_CONTEXT_UNPROVEN'],
    ['duplicate timer',f=>{f.configuration.data.timers.push(f.configuration.data.timers[0]);},'TIMER_CONTEXT_UNPROVEN'],
    ['public active missing',f=>{f.configuration.data.timers[0].configs=[];},'TIMER_CONTEXT_UNPROVEN'],
    ['public configs malformed',f=>{f.configuration.data.timers[0].configs={};},'TIMER_CONTEXT_UNPROVEN'],
    ['public active duplicated',f=>{f.configuration.data.timers[0].configs.push(f.configuration.data.timers[0].configs[0]);},'TIMER_CONTEXT_UNPROVEN'],
    ['public active unreadable',f=>{f.configuration.data.timers[0].configs[0].value='[REDACTED]';},'TIMER_CONTEXT_UNPROVEN'],
    ['public active wrong type',f=>{f.configuration.data.timers[0].configs[0].dataType='Text';},'TIMER_CONTEXT_UNPROVEN'],
    ['public current inactive while Portal active',f=>{f.configuration.data.timers[0].configs[0].value='False';},'TIMER_NOT_ACTIVE'],
    ['public deployed inactive while Portal active',f=>{f.configuration.data.timers[0].configs[0].deployedValue='False';},'TIMER_NOT_ACTIVE'],
    ['Portal timer key changed',f=>{f.info.data.TimerInfo.Timer.Key=stage;},'TIMER_CONTEXT_UNPROVEN'],
    ['Portal timer name changed',f=>{f.info.data.TimerInfo.Timer.Name='Other';},'TIMER_CONTEXT_UNPROVEN'],
    ['pending unknown',f=>{delete f.info.data.TimerInfo.HasPendingConfigurations;},'TIMER_CONTEXT_UNPROVEN'],
    ['pending config',f=>{f.info.data.TimerInfo.HasPendingConfigurations=true;},'TIMER_CONFIGURATION_PENDING'],
    ['inactive',f=>{f.info.data.TimerInfo.Timer.Configs.IsActive.Deployed=false;},'TIMER_NOT_ACTIVE'],
    ['running',f=>{f.current.data.TimerRunInformation.isRunning=true;},'TIMER_ALREADY_RUNNING'],
    ['pending run',f=>{f.current.data.TimerRunInformation.isPendingRun=true;},'TIMER_ALREADY_RUNNING'],
    ['state missing',f=>{delete f.current.data.TimerRunInformation.isRunning;},'TIMER_STATE_UNPROVEN'],
    ['bad timestamp',f=>{f.current.data.TimerRunInformation.lastRunStartedOn='[REDACTED]';},'TIMER_STATE_UNPROVEN'],
    ['loose date string',f=>{f.current.data.TimerRunInformation.lastRunStartedOn='1';},'TIMER_STATE_UNPROVEN'],
  ];
  for(const [name,change,code]of cases)await t.test(name,async()=>{const f=timerFixture();change(f);await assert.rejects(prepareTimerWake(f.input,f.deps),{code});});
});
