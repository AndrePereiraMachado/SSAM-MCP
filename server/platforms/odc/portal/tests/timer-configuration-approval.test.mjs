import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {timerConfigurationApproval,TIMER_PATCH} from '../runtime/timer-configuration-approval.mjs';
import {TIMER_CONFIGURATION} from '../runtime/portal-timer.mjs';
import {publicError} from '../runtime/errors.mjs';
const host='corp.outsystems.dev',app='app',env='env',timer='timer',words='Pode sim.';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'timer-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Configure the disposable App/Timer in env.');
 const record={schema:'ssam-authorization-context/1',decision:'approved',words,source:{kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Approve this fixture test?'},
 proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
 scope:[{lane:'odc',host,operation:'timers.configuration',environmentKey:env,targets:['App','Timer']}]};fs.writeFileSync(file,JSON.stringify(record));
 const config={revisionBaseline:2,revisionDeployed:2,settings:[],systemConfigurations:[],integrations:[],libraries:[],timers:[{key:timer,name:'Timer',configs:[{key:'IsActive',isSecret:false,value:'True',deployedValue:'True',valueOrigin:'ApplicationLevelDefault',deployedValueOrigin:'ApplicationLevelDefault'}]}]};
 const list=[];
 const args={file,words,host,operationId:TIMER_PATCH,input:{path:{environmentKey:env,applicationKey:app},body:{key:app,timers:[{key:timer,configs:[{key:'IsActive',value:'False'}]}]}},
 read:async (id,args)=>{if(id!==TIMER_CONFIGURATION)assert.deepEqual(args,{assetKey:app,revisionNumber:config.revisionDeployed});return {ok:true,data:id===TIMER_CONFIGURATION?config:{name:'App',assetKey:app,revision:2}};},
 pending:async()=>({ok:true,data:{PendingConfigurations:{List:list}}})};
 return {args,config,list};
}
test('timer config approval requires live app/environment and no pre-existing pending changes',async t=>{
 const {args,list}=fixture(t);assert.equal((await timerConfigurationApproval(args)).environmentKey,env);
 list.push({Key:'other',Name:'Other'});await assert.rejects(timerConfigurationApproval(args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});
test('timer approval cannot authorize settings, another environment, revision or secret',async t=>{
 for(const change of [
 h=>{h.args.input.body.settings=[];},h=>{h.args.input.path.environmentKey='other';},
 h=>{h.config.revisionBaseline=3;},h=>{h.config.timers[0].configs[0].isSecret=true;},
 h=>{h.args.input.body.timers[0].configs[0].key='Other';},
 h=>{h.config.settings=[{valueOrigin:'ApplicationLevelOverride',deployedValueOrigin:'ApplicationLevelDefault',value:'changed'}];},
 h=>{h.config.systemConfigurations=[{valueOrigin:'EnvironmentLevelDefault',deployedValueOrigin:'EnvironmentLevelDefault',value:'new',deployedValue:'old'}];}]){
  const h=fixture(t);change(h);await assert.rejects(timerConfigurationApproval(h.args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 }
});
test('ApplyConfigs context allows only exact pending timer and refuses Deploy or unrelated pending asset',async t=>{
 const h=fixture(t);h.config.timers[0].configs[0].value='False';h.list.push({Key:timer,Name:'Timer',LibraryKey:'',LibraryRevision:0});
 h.args.operationId='deployments-api-v1:post:/deployment-operations';
 h.args.input={body:{operation:'ApplyConfigs',assetKey:app,environmentKey:env,revision:2}};
 assert.equal((await timerConfigurationApproval(h.args)).targets[1],'Timer');
 h.list.push({Key:'setting',Name:'Setting'});await assert.rejects(timerConfigurationApproval(h.args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 h.list.pop();h.args.input.body.operation='Deploy';await assert.rejects(timerConfigurationApproval(h.args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});

for(const stage of ['configuration','application-revision','pending-configurations']){
 for(const throws of [false,true]) test(`failed ${stage} read is not an invalid approval (throws=${throws})`,async t=>{
  const h=fixture(t),original=h.args.read;
  const failure=()=>{const error=Object.assign(new Error('Bearer private-test-token'),{code:'STUDIO_NOT_SIGNED_IN'});if(throws)throw error;return {ok:false,error};};
  if(stage==='pending-configurations')h.args.pending=async()=>failure();
  else h.args.read=async(id,args)=>((id===TIMER_CONFIGURATION)===(stage==='configuration'))?failure():original(id,args);
  await assert.rejects(timerConfigurationApproval(h.args),error=>{
   const result=publicError(error);
   assert.equal(result.code,'CONFIGURATION_PREREQUISITE_UNAVAILABLE');
   assert.equal(result.stage,stage);assert.equal(result.causeCode,'STUDIO_NOT_SIGNED_IN');
   assert.equal(JSON.stringify(result).includes('private-test-token'),false);return true;
  });
 });
}
test('untrusted failure codes and messages are withheld; malformed success remains refused',async t=>{
 const h=fixture(t);h.args.read=async()=>({ok:false,code:'secret-value',message:'secret-value'});
 await assert.rejects(timerConfigurationApproval(h.args),error=>{
  assert.deepEqual(publicError(error),{code:'CONFIGURATION_PREREQUISITE_UNAVAILABLE',message:'A required configuration read failed. Authorization could not be evaluated; nothing was sent.',stage:'configuration',causeCode:'READ_FAILED'});return true;
 });
 h.args.read=async()=>({ok:true,data:{}});
 await assert.rejects(timerConfigurationApproval(h.args),error=>error.code==='AUTHORIZATION_CONTEXT_INVALID');
});
