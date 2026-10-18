import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {performanceEventsRequest,readPerformanceEvents,timerCompletionEvents} from '../service-center/performance-events.mjs';
import crypto from 'node:crypto';
import {serviceCenterTool} from '../service-center/index.mjs';
const input=()=>({host:'personal-test.outsystemscloud.com',target:'SSAM/O11/personal-test.outsystemscloud.com/ServiceCenter',principal:'test@example.test',since:'2026-10-09T16:00:00Z',until:'2026-10-09T16:10:00Z',limit:10});
test('monitoring transport fixes HTTPS endpoint and refuses other credentials or unbounded searches',()=>{
 const i=input(),p=performanceEventsRequest(i),u=new URL(p.url);assert.equal(u.origin,'https://'+i.host);assert.equal(u.pathname,'/PerformanceProbe/rest/PerformanceMonitoringAPI/RequestEvents/');assert.equal(u.searchParams.get('EventNames'),'TimerExecuted');
 for(const change of [{target:'SSAM/O11/other.outsystemscloud.com/ServiceCenter'},{target:i.target+'/Profiles/bad'},{principal:''},{until:'2026-10-09T18:00:00Z'},{limit:101},{since:'bad'}])assert.throws(()=>performanceEventsRequest({...i,...change}));
});
test('empty monitoring response proves authentication but not enabled events or timer completion',async()=>{
 const r=await readPerformanceEvents(input(),{run:async(script,request)=>{
  assert.match(script,/AllowAutoRedirect=\$false/);assert.match(script,/VAULT_PRINCIPAL_MISMATCH/);
  assert.equal(Object.hasOwn(request,'password'),false);assert.equal(Object.hasOwn(request,'authorization'),false);
  return {ok:true,status:200,authenticated:true,RequestEventList:[],ResultsTruncated:false};
 }});assert.equal(r.authenticated,true);assert.equal(r.monitoringEnabledVerified,false);assert.equal(r.executionCausalityVerified,false);
});
test('401 and private credential mismatches are terminal without retry',async()=>{
 for(const reply of [{ok:true,status:401},{ok:false,code:'VAULT_PRINCIPAL_MISMATCH'}]){let calls=0;const r=await readPerformanceEvents(input(),{run:async()=>{calls++;return reply;}});assert.equal(r.ok,false);assert.equal(calls,1);}
});
test('a server error does not establish whether authentication succeeded',async()=>{
 const r=await readPerformanceEvents(input(),{run:async()=>({ok:true,status:500,diagnostic:['Internal Error']})});
 assert.equal(r.authenticated,null);assert.deepEqual(r.diagnostic,['Internal Error']);
});

test('service token is explicit, same-host and cannot inherit a user credential or principal',async()=>{
 const i={...input(),eventAuth:'service-token',target:'SSAM/O11/personal-test.outsystemscloud.com/LifeTime',principal:undefined};
 const p=performanceEventsRequest(i);assert.equal(p.eventAuth,'service-token');
 for(const change of [{target:input().target},{target:'SSAM/O11/other.example/LifeTime'},{principal:'guessed@example.test'},{eventAuth:'auto'}])assert.throws(()=>performanceEventsRequest({...i,...change}));
 let calls=0;const result=await readPerformanceEvents(i,{run:async(script,request)=>{calls++;assert.equal(request.eventAuth,'service-token');assert.match(script,/\$authorization='Bearer '\+\$secret/);assert.match(script,/\$request.eventAuth -eq 'basic' -and/);assert.match(script,/\$secret,\$basic,\$authorization/);assert.match(script,/AllowAutoRedirect=\$false/);assert.equal(Object.hasOwn(request,'token'),false);return{ok:true,status:200,authenticated:true,RequestEventList:[],ResultsTruncated:false};}});
 assert.equal(calls,1);assert.equal(result.auth.path,'vault-service-token');assert.equal(result.auth.principal,null);assert.equal(result.auth.serviceAccountIdentityVerified,false);assert.equal(result.monitoringEnabledVerified,false);
});

test('service-token facade performs no Studio lookup, login, prompt or Basic fallback',async()=>{
 const argv=['timer-events','--host=personal-test.outsystemscloud.com','--session=vault','--event-auth=service-token','--since=2026-10-09T16:00:00Z','--until=2026-10-09T16:10:00Z','--limit=10'];
 for(const available of [false,true]){let reads=0;const r=await serviceCenterTool(argv,{locate:()=>assert.fail('No Studio lookup'),opener:()=>assert.fail('No prompt'),present:async target=>{assert.equal(target,'SSAM/O11/personal-test.outsystemscloud.com/LifeTime');return available;},performanceEvents:{run:async(_script,request)=>{reads++;assert.equal(request.eventAuth,'service-token');return{ok:true,status:401};}}});assert.equal(r.ok,false);assert.equal(reads,available?1:0);assert.equal(r.result.error?.code??r.result.code,available?'PERFORMANCE_EVENTS_ACCESS_UNVERIFIED':'AUTH_REQUIRED');}
});

const event=()=>({Instant:'2026-10-09T16:05:00Z',RequestKey:crypto.randomUUID(),RequestEventName:'TimerExecuted',ModuleKey:crypto.randomUUID(),ModuleName:'OwnFixture',ApplicationKey:crypto.randomUUID(),ApplicationName:'OwnFixture',Details:{AN:'OwnTick',AK:crypto.randomUUID(),EC:0,D:0}});
test('authenticated completion event distinguishes error count from Run Now causality and retry cycle',async()=>{
 const a=event(),b=event();b.Details.EC=2;b.Details.D=17;
 const result=await readPerformanceEvents(input(),{run:async()=>({ok:true,status:200,authenticated:true,RequestEventList:[a,b],ResultsTruncated:true})});
 assert.equal(result.monitoringEnabledVerified,true);assert.equal(result.truncated,true);
 assert.equal(result.completionEvents[0].outcome,'completed-without-reported-errors');
 assert.equal(result.completionEvents[0].durationMs,0);assert.equal(result.completionEvents[1].outcome,'completed-with-errors');
 for(const observation of result.completionEvents){assert.equal(observation.serverRequestCompleted,true);assert.equal(observation.attributedToRunNow,false);assert.equal(observation.timerCycleCompleted,null);assert.equal(observation.businessSuccessVerified,false);}
 assert.equal(result.executionCausalityVerified,false);
});
test('malformed, duplicate, foreign-window or incomplete metrics cannot prove timer completion',()=>{
 for(const mutate of [e=>e.RequestEventName='Other',e=>e.RequestKey='not-a-key',e=>e.ModuleKey=null,e=>e.ApplicationKey='00000000-0000-0000-0000-000000000000',e=>e.Instant='2026-10-09T15:00:00Z',e=>e.Instant='2026-10-09T16:05:00',e=>delete e.Details.EC,e=>e.Details.EC=null,e=>e.Details.EC='0',e=>e.Details.EC=-1,e=>e.Details.EC=0.5,e=>e.Details.D=NaN,e=>e.Details.D=-1,e=>e.Details.AK='unknown',e=>e.Details.AN='']){
  const e=event();mutate(e);assert.throws(()=>timerCompletionEvents([e],input()));
 }
 const e=event();assert.throws(()=>timerCompletionEvents([e,{...e,RequestKey:e.RequestKey.toUpperCase()}],input()));
 assert.throws(()=>timerCompletionEvents([event(),event()],{...input(),limit:1}));
});
