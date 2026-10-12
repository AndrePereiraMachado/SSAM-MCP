import test from 'node:test';
import assert from 'node:assert/strict';
import {comparePendingTimer,readPendingTimer} from '../runtime/timer-pending-state.mjs';
const target={environmentKey:'aaaaaaaa-1111-4111-8111-111111111111',applicationKey:'bbbbbbbb-2222-4222-8222-222222222222',timerKey:'cccccccc-3333-4333-8333-333333333333'};
function fixture(){
 const c=(key,value,dataType)=>({key,value,deployedValue:value,dataType,isSecret:false,valueOrigin:'ApplicationLevelDefault',deployedValueOrigin:'ApplicationLevelDefault'});
 const data={revisionBaseline:2,revisionDeployed:2,timers:[{key:target.timerKey,name:'ProofTick',configs:[c('IsActive','True','Boolean'),c('Schedule','0 0 1 1 *','Text'),c('Timeout','1','Integer')]}]};
 const n=(value)=>({Value:value,DeployedValue:value,ValueOrigin:'ApplicationLevelDefault',DeployedValueOrigin:'ApplicationLevelDefault'});
 const info={NotFound:false,TimerInfo:{HasPendingConfigurations:false,Timer:{Key:target.timerKey,Name:'ProofTick',Configs:{IsActive:{Current:true,Deployed:true,ValueOrigin:'ApplicationLevelDefault',DeployedValueOrigin:'ApplicationLevelDefault'},Schedule:n('0 0 1 1 *'),Timeout:n('1')}}}};
 const calls=[];const deps={configuration:async p=>{calls.push(['config',p]);return{ok:true,data:structuredClone(data)}},application:async p=>{calls.push(['app',p]);return{ok:true,data:{assetKey:target.applicationKey,revision:2,name:'ProofApp'}}},portalRead:async(id,vars)=>{calls.push([id,vars]);return{ok:true,data:info}}};
 const input={screenVariables:{appid:target.applicationKey,stageid:target.environmentKey,id:target.timerKey}};
 return{data,info,deps,calls,input};
}
test('empty native pending flag cannot erase a saved versus deployed timer difference',()=>{
 const f=fixture(),c=f.data.timers[0].configs[0],n=f.info.TimerInfo.Timer.Configs.IsActive;
 c.value='False';c.valueOrigin='ApplicationLevelOverride';n.Current=false;n.ValueOrigin='ApplicationLevelOverride';
 const copy=structuredClone({data:f.data,info:f.info}),r=comparePendingTimer(f.data,f.info,target);
 assert.equal(r.state,'pending');assert.equal(r.savedNotDeployed,true);assert.equal(r.nativeFlag,false);assert.equal(r.changes.length,1);assert.equal(r.applicationWideAbsenceProven,false);
 assert.deepEqual(f.data,copy.data);assert.deepEqual(f.info,copy.info);
});
test('origin-only differences are pending, Boolean casing alone is not',()=>{
 const f=fixture(),c=f.data.timers[0].configs[0],n=f.info.TimerInfo.Timer.Configs.IsActive;
 c.value='true';assert.equal(comparePendingTimer(f.data,f.info,target).state,'none');
 c.valueOrigin='ApplicationLevelOverride';n.ValueOrigin='ApplicationLevelOverride';assert.equal(comparePendingTimer(f.data,f.info,target).state,'pending');
});
test('matching values prove only the selected timer observations, never application-wide absence or atomicity',async()=>{
 const f=fixture(),r=await readPendingTimer(f.input,f.deps);assert.equal(r.state,'none');assert.equal(r.absenceProven,true);assert.equal(r.atomicityProven,false);assert.equal(r.applicationWideAbsenceProven,false);
 assert.deepEqual(f.calls.map(x=>x[0]),['config','app','timers.info','config']);assert.equal(f.calls[2][1].stageid,target.environmentKey);assert.equal(f.calls[2][1].id,target.timerKey);
});
for(const [name,change] of [
 ['revision',f=>f.data.revisionBaseline++],['missing timer',f=>f.data.timers=[]],['duplicate timer',f=>f.data.timers.push(structuredClone(f.data.timers[0]))],
 ['secret',f=>f.data.timers[0].configs[0].isSecret=true],['masked',f=>f.data.timers[0].configs[0].value='[REDACTED]'],
 ['duplicate field',f=>f.data.timers[0].configs.push(structuredClone(f.data.timers[0].configs[0]))],['missing field',f=>f.data.timers[0].configs.pop()],
 ['native identity',f=>f.info.TimerInfo.Timer.Key=target.applicationKey],['native missing',f=>f.info.NotFound=true],['native value',f=>f.info.TimerInfo.Timer.Configs.IsActive.Current=false],
 ['native origin',f=>f.info.TimerInfo.Timer.Configs.IsActive.ValueOrigin='ApplicationLevelOverride'],['native name',f=>f.info.TimerInfo.Timer.Name='Other'],
 ['type',f=>f.data.timers[0].configs[0].dataType='Text'],['origin',f=>f.data.timers[0].configs[0].valueOrigin='Unknown'],['timeout',f=>f.data.timers[0].configs[2].value='NaN']
])test('unproved '+name+' stays unknown, never no-pending',()=>{const f=fixture();change(f);const r=comparePendingTimer(f.data,f.info,target);assert.equal(r.state,'unknown');assert.equal(r.absenceProven,false);assert.equal(r.savedNotDeployed,null);});
test('scope, application identity, transport failure and drift cannot prove absence',async()=>{
 const a=fixture();assert.equal((await readPendingTimer({screenVariables:{}},a.deps)).reason,'exact_timer_scope_required');assert.equal(a.calls.length,0);
 const b=fixture();b.deps.application=async()=>({ok:true,data:{assetKey:target.timerKey,revision:2,name:'ProofApp'}});assert.equal((await readPendingTimer(b.input,b.deps)).state,'unknown');
 const c=fixture();c.deps.configuration=async()=>{throw Object.assign(new Error('deadline'),{code:'READ_BUDGET_EXCEEDED'})};assert.equal((await readPendingTimer(c.input,c.deps)).causeCode,'READ_BUDGET_EXCEEDED');
 const d=fixture();let count=0;d.deps.configuration=async()=>({ok:true,data:{...d.data,revisionBaseline:++count===1?2:3}});assert.equal((await readPendingTimer(d.input,d.deps)).reason,'configuration_changed_during_read');
});
