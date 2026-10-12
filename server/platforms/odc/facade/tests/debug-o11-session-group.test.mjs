import test from 'node:test';import assert from 'node:assert/strict';import {createO11SessionGroup} from '../debug-o11-session-group.mjs';
test('connected startup without an allocated native identity remains uncertain',async()=>{
 const calls=[];const group=createO11SessionGroup(async args=>{calls.push(args);return {ok:true,state:'connected'};});
 await assert.rejects(group.start(input,context),/group_start_uncertain/);
 assert.equal(group.summary().unresolvedStart,true);assert.equal(calls.length,1);
 assert.equal((await group.stop()).state,'stop-uncertain');
 await assert.rejects(group.start(input,context),/already_attempted/);assert.equal(calls.length,1);
});
const entry='A'.repeat(22),producer='B'.repeat(22),consumerId='a'.repeat(32),producerId='b'.repeat(32);
const input={op:'start',lane:'o11',module:'Producer',moduleKey:producer,runtimeUrl:'https://fixture.test/Consumer/',autoContinue:false,nodeKeys:['C'.repeat(22),'D'.repeat(22)],inspection:{scopes:[{moduleKey:entry},{moduleKey:producer}]},o11Auth:{applicationKey:'E'.repeat(22),publishedVersionId:2,publishedProof:{path:'proof',sha256:'f'.repeat(64)},entry:{module:'Consumer',moduleKey:entry,applicationKey:'F'.repeat(22),publishedVersionId:3}}};
const context={appUser:{binding:{moduleKey:entry}},redactionOnly:true};
function fixture(options={}){const calls=[];let pauseOwner=entry,primaryStopped=false;const debug=async(args,ctx)=>{calls.push({args,ctx});
 if(args.op==='start'){if(options.throwOn===args.moduleKey)throw Error('secret');if(options.refuse===args.moduleKey)return {ok:false,state:'not-started',workerStarted:false,uncertain:false,sessionId:producerId};return{ok:true,state:'connected',sessionId:args.moduleKey===entry?consumerId:producerId};}
 if(args.op==='status')return{ok:true,state:'connected',pauses:[{threadId:'T',eventId:'1',stack:[{moduleKey:pauseOwner}]}],events:[]};
 if(args.op==='stop'){if(options.stopThrow===args.sessionId)throw Error('secret');if(args.sessionId===producerId)primaryStopped=true;return args.sessionId===consumerId&&primaryStopped?{ok:false,state:'stopped',error:options.peerError??'debug_server_ended_session',privateInspectionCleanup:{completed:true,pending:0},credentialCleanup:{state:'runner-owned'}}:{ok:true,state:'stopped'};}
 };return{group:createO11SessionGroup(debug,options.checkActive),calls,setOwner:v=>pauseOwner=v};}
test('group starts consumer before producer, shares complete breakpoints and routes duplicate pauses to their module owner',async()=>{
 const f=fixture(),started=await f.group.start(input,context);assert.equal(started.sessionId,producerId);
 assert.deepEqual(f.calls.map(c=>c.args.moduleKey),[entry,producer]);assert.equal(f.calls[0].ctx.additionalO11Session,true);assert.equal(f.calls[0].ctx.appUser,context.appUser);assert.equal(f.calls[1].ctx,context);assert.equal(f.calls[0].args.o11Auth.entry,undefined);
 assert.equal(f.calls[0].args.inspection,input.inspection);assert.equal(f.calls[0].args.nodeKeys,input.nodeKeys);
 let status=await f.group.status();assert.equal(status.pauses.length,1);assert.equal(status.pauses[0].nativeSessionId,consumerId);
 f.setOwner(producer);status=await f.group.status();assert.equal(status.pauses.length,1);assert.equal(status.pauses[0].nativeSessionId,producerId);
 const [a,b]=await Promise.all([f.group.stop(),f.group.stop()]);assert.equal(a,b);assert.equal(a.ok,true);assert.equal(a.state,'stopped');assert.deepEqual(f.calls.filter(c=>c.args.op==='stop').map(c=>c.args.sessionId),[producerId,consumerId]);
 await assert.rejects(f.group.start(input,context),/already_attempted/);
});
test('group retains and stops an auxiliary session after a definite primary refusal',async()=>{const f=fixture({refuse:producer});const r=await f.group.start(input,context);assert.equal(r.ok,false);assert.equal(r.sessionId,consumerId);assert.equal(r.state,'group-start-failed');assert.equal(f.group.summary().members.length,1);const stop=await f.group.stop();assert.equal(stop.ok,true);assert.equal(stop.state,'stopped');assert.equal(f.calls.filter(c=>c.args.op==='stop').length,1);});
test('unanswered auxiliary or primary starts remain uncertain and are not replayed',async()=>{for(const moduleKey of [entry,producer]){const f=fixture({throwOn:moduleKey});if(moduleKey===entry)await assert.rejects(f.group.start(input,context),/group_start_uncertain/);else assert.equal((await f.group.start(input,context)).uncertain,true);assert.equal(f.group.summary().unresolvedStart,true);assert.equal((await f.group.stop()).state,'stop-uncertain');await assert.rejects(f.group.start(input,context),/already_attempted/);assert.equal(f.calls.filter(c=>c.args.op==='start'&&c.args.moduleKey===moduleKey).length,1);}});
test('cancellation after auxiliary startup prevents the primary start',async()=>{const f=fixture({checkActive:()=>{throw Error('cancelled');}});const r=await f.group.start(input,context);assert.equal(r.state,'group-start-cancelled');assert.equal(f.calls.filter(c=>c.args.op==='start').length,1);assert.equal(f.group.summary().unresolvedStart,false);await f.group.stop();});
test('group never normalizes unrelated peer failures or retries an uncertain stop',async()=>{for(const options of [{peerError:'debug_other_error'},{stopThrow:producerId}]){const f=fixture(options);await f.group.start(input,context);const r=await f.group.stop();assert.equal(r.ok,false);assert.equal(r.state,'stop-uncertain');await f.group.stop();assert.equal(f.calls.filter(c=>c.args.op==='stop').length,2);}});
test('group refuses unbound initial or observed modules',async()=>{const f=fixture();await assert.rejects(f.group.start({...input,inspection:{scopes:[{moduleKey:'Z'.repeat(22)}]}},context),/binding_invalid/);assert.equal(f.calls.length,0);const g=fixture();await g.group.start(input,context);g.setOwner('Z'.repeat(22));await assert.rejects(g.group.status(),/frame_owner_unavailable/);await g.group.stop();});
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {o11DebugRequest} from '../debug-runtime.mjs';import {debugSchema} from '../debug.mjs';
// Real Service plan shape: the Service is the runtime (own URL and own published row, no o11Auth.entry);
// the consumer binding arrives as the group's serviceCaller with its own runtime URL and published row.
const consumerRow={Key:entry,Name:'Consumer',ApplicationKey:'F'.repeat(22),VersionId:3,IsActive:true},serviceRow={Key:producer,Name:'Service',ApplicationKey:'E'.repeat(22),VersionId:2,IsActive:true};
function proofFile(t,name,rows){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'debug-o11-service-group-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,name);
 fs.writeFileSync(file,JSON.stringify({host:'fixture.test',capturedAtUtc:new Date().toISOString(),modules:rows}));return {path:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};}
function serviceRun(t,{serviceRows=[serviceRow],callerRows=[consumerRow]}={}){
 const {entry:_,...auth}=input.o11Auth;
 const inspection={variables:[],scopes:[entry,producer].map((moduleKey,i)=>({moduleKey,functionKey:'G'.repeat(22),nodeKey:input.nodeKeys[i],sourceSha256:String(i).repeat(64)}))};
 return {svc:{...input,inspection,tenant:'fixture.test',module:'Service',runtimeUrl:'https://fixture.test/Service/',o11Auth:{...auth,publishedProof:proofFile(t,'service.json',serviceRows)}},
  serviceCaller:{module:'Consumer',moduleKey:entry,applicationKey:'F'.repeat(22),publishedVersionId:3,runtimeUrl:'https://fixture.test/Consumer/',publishedProof:proofFile(t,'caller.json',callerRows)}};}
const serviceDebug=(calls,pauseOwner)=>async(a,c)=>{if(a.op==='status')return {ok:true,state:'connected',events:[],pauses:pauseOwner?[{threadId:'T',eventId:'1',stack:[{moduleKey:pauseOwner}]}]:a.sessionId===consumerId?[{threadId:'T-consumer',eventId:'1',stack:[{moduleKey:entry}]}]:[{threadId:'T-service',eventId:'2',stack:[{moduleKey:producer}]}]};
 calls.push({args:a,ctx:c});if(a.op==='start')return {ok:true,state:'connected',sessionId:a.moduleKey===entry?consumerId:producerId};return {ok:true,state:'stopped'};};
test('service-action group starts consumer on its own runtime then Service, routes each thread pause to its owner and publishes cross-thread summary',async t=>{
 const calls=[],{svc,serviceCaller}=serviceRun(t),direct=createO11SessionGroup(serviceDebug(calls),undefined,{boundaryKind:'service-action',serviceCaller});
 const started=await direct.start(svc,context);assert.equal(started.ok,true);assert.equal(started.sessionId,producerId);
 const [aux,primary]=calls.filter(c=>c.args.op==='start').map(c=>c.args);assert.deepEqual([aux.moduleKey,primary.moduleKey],[entry,producer]);
 assert.equal(aux.module,'Consumer');assert.equal(aux.runtimeUrl,'https://fixture.test/Consumer/');assert.equal(aux.o11Auth.entry,undefined);assert.equal(aux.o11Auth.publishedProof,serviceCaller.publishedProof);
 assert.equal(aux.o11Auth.applicationKey,serviceCaller.applicationKey);assert.equal(aux.o11Auth.publishedVersionId,3);assert.equal(calls[0].ctx.additionalO11Session,true);
 assert.equal(primary,svc);assert.equal(primary.o11Auth.entry,undefined);
 // Both starts satisfy the real same-module runtime entry gate, the debug schema and their own published row.
 const selected={pid:1,startedUtc:new Date().toISOString(),studioDir:path.resolve('/studio')};
 for(const args of [aux,primary]){debugSchema.parse(args);assert.equal(o11DebugRequest(args,'c'.repeat(32),selected,'00000000-0000-4000-8000-000000000000').request.module,args.module);}
 const status=await direct.status();assert.deepEqual(status.pauses.map(p=>[p.threadId,p.nativeSessionId]),[['T-consumer',consumerId],['T-service',producerId]]);
 const summary=direct.summary();assert.equal(summary.boundaryKind,'service-action');assert.equal(summary.requestOwnershipProved,false);assert.equal(summary.crossThread,true);assert.equal(summary.serviceHopStepInto,'not-automatic');
 assert.equal(started.nativeGroup.crossThread,true);
 const stop=await direct.stop();assert.equal(stop.ok,true);assert.deepEqual(calls.filter(c=>c.args.op==='stop').map(c=>c.args.sessionId),[producerId,consumerId]);
 assert.equal(fixture().group.summary().crossThread,undefined);
});
test('service-action group refuses a third module, a consumer entry, a foreign caller runtime and unproved rows before any native start',async t=>{
 const calls=[],run=serviceRun(t),make=(serviceCaller=run.serviceCaller)=>createO11SessionGroup(serviceDebug(calls,'Z'.repeat(22)),undefined,{boundaryKind:'service-action',serviceCaller});
 const {svc,serviceCaller}=run;
 await assert.rejects(make().start({...svc,inspection:{scopes:[{moduleKey:entry},{moduleKey:producer},{moduleKey:'Z'.repeat(22)}]}},context),/binding_invalid/);
 await assert.rejects(make().start({...svc,o11Auth:{...svc.o11Auth,entry:input.o11Auth.entry}},context),/binding_invalid/);
 await assert.rejects(make().start({...svc,runtimeUrl:'https://fixture.test/Consumer/'},context),/binding_invalid/);
 await assert.rejects(make(null).start(svc,context),/binding_invalid/);
 for(const change of [{runtimeUrl:'https://other.test/Consumer/'},{runtimeUrl:'https://fixture.test/Service/'},{moduleKey:producer},{publishedVersionId:4}])
  await assert.rejects(make({...serviceCaller,...change}).start(svc,context),/binding_invalid/);
 await assert.rejects(make().start(svc,{...context,appUser:{binding:{moduleKey:producer}}}),/binding_invalid/);
 await assert.rejects(make().start(serviceRun(t,{serviceRows:[consumerRow]}).svc,context),/binding_invalid/);
 await assert.rejects(make({...serviceCaller,publishedProof:serviceRun(t,{callerRows:[serviceRow]}).serviceCaller.publishedProof}).start(svc,context),/binding_invalid/);
 await assert.rejects(make({...serviceCaller,publishedProof:{...serviceCaller.publishedProof,sha256:'0'.repeat(64)}}).start(svc,context),/binding_invalid/);
 await assert.rejects(make().start({...svc,o11Auth:{...svc.o11Auth,publishedProof:undefined}},context),/binding_invalid/);
 assert.equal(calls.length,0);
 assert.throws(()=>createO11SessionGroup(async()=>({}),undefined,{boundaryKind:'other'}),/boundary_kind_invalid/);
 const g=make();await g.start(svc,context);await assert.rejects(g.status(),/frame_owner_unavailable/);await g.stop();
});
