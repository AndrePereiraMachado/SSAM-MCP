import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareTimerActivation,verifyTimerActivation,validateTimerDeployment} from '../runtime/timer-activation.mjs';
const stage='aaaaaaaa-1111-4111-8111-111111111111',app='bbbbbbbb-2222-4222-8222-222222222222',timer='cccccccc-3333-4333-8333-333333333333';
function fixture(){
 const item=(key,value,dataType)=>({key,value,deployedValue:value,dataType,isSecret:false,valueOrigin:'ApplicationLevelDefault',deployedValueOrigin:'ApplicationLevelDefault'});
 const data={revisionBaseline:7,revisionDeployed:7,settings:[],systemConfigurations:[],libraries:[],integrations:[],timers:[{key:timer,name:'ProofTick',configs:[item('IsActive','True','Boolean'),item('Schedule','0 0 1 1 *','Text'),item('Timeout','1','Integer')]}]};
 const native={Key:timer,Name:'ProofTick',Configs:{IsActive:{Current:true,Deployed:true,ValueOrigin:'ApplicationLevelDefault',DeployedValueOrigin:'ApplicationLevelDefault'},Schedule:{Value:'0 0 1 1 *',DeployedValue:'0 0 1 1 *',ValueOrigin:'ApplicationLevelDefault',DeployedValueOrigin:'ApplicationLevelDefault'},Timeout:{Value:'1',DeployedValue:'1',ValueOrigin:'ApplicationLevelDefault',DeployedValueOrigin:'ApplicationLevelDefault'}}};
 const responses={'timers.info':{ok:true,data:{NotFound:false,TimerInfo:{Timer:native,HasPendingConfigurations:false}}},'timers.pendingConfiguration':{ok:true,data:{PendingConfigurations:{List:[]}}},'timers.currentRun':{ok:true,data:{TimerRunInformation:{isRunning:false,isPendingRun:false}}},'timers.deploymentStatus':{ok:true,data:{HasOngoingDeployments:false}}};
 const application={ok:true,data:{assetKey:app,revision:7,name:'ProofApp'}};
 let reads=0;const calls=[];
 const deps={configuration:async()=>{reads++;return{ok:true,data:structuredClone(data)}},application:async()=>application,portalRead:async id=>{calls.push(id);return responses[id];}};
 return{data,native,responses,application,calls,deps,input:{inputParameters:{StageKey:stage,ApplicationKey:app,TimerKey:timer},screenVariables:{},clientVariables:{}},reads:()=>reads};
}
test('activation preserves schedule and timeout origins and uses the native default timeout sentinel',async()=>{
 const f=fixture(),before=structuredClone(f.data),result=await prepareTimerActivation(f.input,false,f.deps);
 assert.deepEqual(f.data,before);assert.equal(result.alreadyApplied,false);assert.equal(result.atomicityProven,false);
 assert.deepEqual(result.input.inputParameters,{EnvironmentKey:stage,ApplicationKey:app,RevisionBaseline:7,TimerInfo:{Timer:{Key:timer,Configs:{IsActive:{Current:false,ValueOrigin:'ApplicationLevelOverride'},Schedule:{Value:'0 0 1 1 *',ValueOrigin:'ApplicationLevelDefault'},Timeout:{Value:'0',ValueOrigin:'ApplicationLevelDefault'}}}}});
 assert.equal(f.reads(),2);assert.deepEqual(f.calls,['timers.info','timers.pendingConfiguration','timers.currentRun','timers.deploymentStatus']);
});
test('same activation is an explicit no-op; overriding a timeout retains the value and origin',async()=>{
 const f=fixture();const c=f.data.timers[0].configs[2];c.valueOrigin=c.deployedValueOrigin='ApplicationLevelOverride';f.native.Configs.Timeout.ValueOrigin=f.native.Configs.Timeout.DeployedValueOrigin='ApplicationLevelOverride';
 const r=await prepareTimerActivation(f.input,true,f.deps);assert.equal(r.alreadyApplied,true);assert.equal(r.input.inputParameters.TimerInfo.Timer.Configs.Timeout.Value,'1');
});
const negatives=[
 ['revision drift',f=>f.data.revisionBaseline=8],['wrong app',f=>f.application.data.assetKey=stage],['missing timer',f=>f.data.timers=[]],
 ['duplicate timer',f=>f.data.timers.push(structuredClone(f.data.timers[0]))],['secret',f=>f.data.timers[0].configs[0].isSecret=true],
 ['wrong type',f=>f.data.timers[0].configs[0].dataType='Text'],['pending value',f=>f.data.timers[0].configs[1].value='0 * * * *'],
 ['pending origin',f=>f.data.timers[0].configs[1].valueOrigin='ApplicationLevelOverride'],['native disagreement',f=>f.native.Configs.IsActive.Current=false],
 ['native origin disagreement',f=>f.native.Configs.IsActive.DeployedValueOrigin='ApplicationLevelOverride'],['native missing',f=>f.responses['timers.info'].data.NotFound=true],
 ['pending list',f=>f.responses['timers.pendingConfiguration'].data.PendingConfigurations.List.push({Key:'other'})],['unreadable pending',f=>f.responses['timers.pendingConfiguration'].ok=false],
 ['running',f=>f.responses['timers.currentRun'].data.TimerRunInformation.isRunning=true],['queued',f=>f.responses['timers.currentRun'].data.TimerRunInformation.isPendingRun=true],
 ['deployment',f=>f.responses['timers.deploymentStatus'].data.HasOngoingDeployments=true],['unknown deployment',f=>delete f.responses['timers.deploymentStatus'].data.HasOngoingDeployments],
 ['unrelated override',f=>f.data.settings.push({valueOrigin:'ApplicationLevelOverride'})],['unreadable collections',f=>delete f.data.libraries],
 ['library version drift',f=>f.data.libraries.push({revision:1,revisionBaseline:2})],['unknown timeout',f=>f.data.timers[0].configs[2].value=f.data.timers[0].configs[2].deployedValue='9007199254740992'],
 ['final read changed',f=>{let n=0;f.deps.configuration=async()=>({ok:true,data:{...structuredClone(f.data),revisionBaseline:++n===1?7:8}})}],
];
for(const [name,change] of negatives)test('activation refuses '+name,async()=>{const f=fixture();change(f);await assert.rejects(prepareTimerActivation(f.input,false,f.deps));});

async function deployedFixture(){
 const f=fixture(),context=await prepareTimerActivation(f.input,false,f.deps);
 const c=f.data.timers[0].configs[0];c.value=c.deployedValue='False';c.valueOrigin=c.deployedValueOrigin='ApplicationLevelOverride';
 Object.assign(f.native.Configs.IsActive,{Current:false,Deployed:false,ValueOrigin:'ApplicationLevelOverride',DeployedValueOrigin:'ApplicationLevelOverride'});
 return {f,context};
}
test('verification independently confirms deployed values and preserved origins',async()=>{
 const {f,context}=await deployedFixture();const result=await verifyTimerActivation(context,f.deps);
 assert.equal(result.confirmed,true);assert.equal(result.active,false);assert.equal(result.originsPreserved,true);
});
test('verification binds a completed deployment to the native timer scope',async()=>{
 const {f,context}=await deployedFixture();f.responses['timers.deploymentStatus'].data.DeploymentKey=stage;
 assert.equal((await verifyTimerActivation(context,{...f.deps,deploymentKey:stage})).deploymentKey,stage);
 await assert.rejects(verifyTimerActivation(context,{...f.deps,deploymentKey:app}),e=>e.code==='TIMER_STATE_UNVERIFIED');
 f.responses['timers.deploymentStatus'].data.HasOngoingDeployments=true;
 await assert.rejects(verifyTimerActivation(context,{...f.deps,deploymentKey:stage}),e=>e.code==='TIMER_STATE_UNVERIFIED');
});
for(const [name,change] of [
 ['revision',f=>f.data.revisionDeployed++],['activation',f=>f.data.timers[0].configs[0].value='True'],
 ['origin',f=>f.data.timers[0].configs[0].valueOrigin='ApplicationLevelDefault'],
 ['schedule',f=>f.data.timers[0].configs[1].deployedValue='0 1 1 1 *'],
 ['timeout',f=>f.data.timers[0].configs[2].value='01'],
 ['native activation',f=>f.native.Configs.IsActive.Current=true],['native pending',f=>f.responses['timers.info'].data.TimerInfo.HasPendingConfigurations=true],
 ['native identity',f=>f.native.Key=app],['duplicate identity',f=>f.data.timers.push(structuredClone(f.data.timers[0]))]
])test('verification refuses changed '+name,async()=>{const {f,context}=await deployedFixture();change(f);await assert.rejects(verifyTimerActivation(context,f.deps),e=>e.code==='TIMER_STATE_UNVERIFIED');});

test('discovered deployment is bound to the write window, revision, operation and asset',()=>{
 const receipt={createdAt:'2026-10-09T00:13:19Z',updatedAt:'2026-10-09T00:13:22Z',response:{DeploymentKey:''},timerActivation:{target:{applicationKey:app},before:{revision:7}}};
 const data={key:stage,assetKey:app,operation:'ApplyConfigs',revisions:[7],startedDateTime:'2026-10-09T00:13:20Z'};
 validateTimerDeployment(receipt,stage,data);
 for(const change of [{key:app},{assetKey:stage},{operation:'Deploy'},{revisions:[8]},{startedDateTime:'2026-10-09T00:13:18Z'},{startedDateTime:'2026-10-09T00:13:23Z'}])assert.throws(()=>validateTimerDeployment(receipt,stage,{...data,...change}),e=>e.code==='OPERATION_IDENTITY_UNVERIFIED');
});
