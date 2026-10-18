import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {settingsConfigurationApproval,settingsBodyHash as hash,settingsConfigurationHash as stateHash,SETTINGS_APPLY,AGENT_SETTINGS_PATCH,AGENT_SETTINGS_CONFIGURATION} from '../runtime/settings-configuration-approval.mjs';
import {TIMER_PATCH} from '../runtime/timer-configuration-approval.mjs';
import {TIMER_CONFIGURATION} from '../runtime/portal-timer.mjs';

test('settings approval binds creation, exact observed state and patch/apply; unrelated changes are refused',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'settings-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Synthetic owned settings fixture');
 const host='test.outsystems.dev',words='Synthetic authorization',applicationKey=crypto.randomUUID(),environmentKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID();
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Owned fixture'};
 const origin={state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:applicationKey},authorization:{source}};
 const baseline={revisionBaseline:2,revisionDeployed:2,settings:[{key:'s1',name:'Greeting',isSecret:false,value:'Hello',deployedValue:'Hello',valueOrigin:'ApplicationLevelDefault',deployedValueOrigin:'ApplicationLevelDefault'}],timers:[],systemConfigurations:[],integrations:[],libraries:[]};
 for(const mode of ['own','library','library-system','library-integration','system','integration']) for(const agent of [false,true]) for(const applying of [false,true]){
  const libraryIntegration=mode==='library-integration',librarySystem=mode==='library-system',nested=mode==='library'||librarySystem||libraryIntegration,system=mode==='system',integration=mode==='integration';if(system&&agent)continue;
  let current=structuredClone(baseline);if(agent)delete current.systemConfigurations;
  if(nested){current.libraries=[{key:'lib1',name:'ProofLibrary',revision:3,revisionBaseline:3,settings:current.settings,systemConfigurations:[],integrations:[]}];current.settings=[];}
  if(librarySystem){current.libraries[0].systemConfigurations=current.libraries[0].settings;current.libraries[0].settings=[];current.libraries[0].systemConfigurations[0].name=null;}
  if(libraryIntegration){current.libraries[0].integrations=[{key:'i1',name:'ProofRest',pluginType:'RESTConsume',configs:current.libraries[0].settings}];current.libraries[0].settings=[];}
  if(system){current.systemConfigurations=current.settings;current.settings=[];current.systemConfigurations[0].name=null;}
  if(integration){current.integrations=[{key:'i1',name:'ProofRest',pluginType:'RestConsumer',configs:current.settings}];current.settings=[];}
  const selectedSettings=libraryIntegration?current.libraries[0].integrations[0].configs:integration?current.integrations[0].configs:librarySystem?current.libraries[0].systemConfigurations:nested?current.libraries[0].settings:system?current.systemConfigurations:current.settings;
  if(applying){selectedSettings[0].value='Changed';selectedSettings[0].valueOrigin='ApplicationLevelOverride';}
  const operationId=applying?SETTINGS_APPLY:agent?AGENT_SETTINGS_PATCH:TIMER_PATCH;
  const body=applying?{operation:'ApplyConfigs',assetKey:applicationKey,environmentKey,revision:2}:{key:applicationKey,settings:[{key:'s1',value:'Changed'}]};
  if(nested&&!applying){body.libraries=[{key:'lib1',revision:3,settings:body.settings}];delete body.settings;}
  if(librarySystem&&!applying){body.libraries[0].systemConfigurations=body.libraries[0].settings;delete body.libraries[0].settings;}
  if(libraryIntegration&&!applying){body.libraries[0].integrations=[{key:'i1',configs:body.libraries[0].settings}];delete body.libraries[0].settings;}
  if(system&&!applying){body.systemConfigurations=body.settings;delete body.settings;}
  if(integration&&!applying){body.integrations=[{key:'i1',configs:body.settings}];delete body.settings;}
  const input={body,...(applying?{}:{path:{[agent?'agentKey':'applicationKey']:applicationKey,environmentKey}})};
  const write=()=>fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hashFile(proposal)},
   scope:[{lane:'odc',host,operation:'settings.configuration',targets:['Proof','Greeting','ProofLibrary','ProofRest','s1'],environmentKey}],constraints:{originOperationUuid,revision:2,bodySha256:hash(input.body),expectedConfigurationSha256:stateHash(current)}}));
  const read=async (id,p)=>({ok:true,data:p?.assetKey==='lib1'?{assetKey:'lib1',revision:3,name:'ProofLibrary'}:[TIMER_CONFIGURATION,AGENT_SETTINGS_CONFIGURATION].includes(id)?current:{assetKey:applicationKey,revision:2,name:'Proof',assetType:agent?'Agent':'WebApplication'}});
  const args={file,words,host,operationId,input,originOperationUuid,lookup:()=>origin,read};write();
  assert.equal((await settingsConfigurationApproval(args)).operation,'settings.configuration');
  if(!applying)await assert.rejects(settingsConfigurationApproval({...args,read:async(id,p)=>{
   const result=await read(id,p);return id==='asset-repository-api-v1:get:/assets/{assetKey}'
    ?{...result,data:{...result.data,assetType:agent?'WebApplication':'Agent'}}:result;
  }}));
  await assert.rejects(settingsConfigurationApproval({...args,read:async(id,p)=>{
   const result=await read(id,p);return id==='asset-repository-api-v1:get:/assets/{assetKey}'
    ?{...result,data:{...result.data,assetType:'AgentDefinition'}}:result;
  }}));
  selectedSettings[0].lastUpdateDate='later';assert.ok(await settingsConfigurationApproval(args));
  for(const changed of [{state:'uncertain'},{response:{assetKey:crypto.randomUUID()}},{identity:{...origin.identity,tenant:'other.test'}},{authorization:{source:{...source,messageId:crypto.randomUUID()}}}])
   await assert.rejects(settingsConfigurationApproval({...args,lookup:()=>({...origin,...changed})}));
  selectedSettings[0].value='Unexpected';await assert.rejects(settingsConfigurationApproval(args));
  write();assert.ok(await settingsConfigurationApproval(args));
  selectedSettings[0].isSecret=true;write();await assert.rejects(settingsConfigurationApproval(args));selectedSettings[0].isSecret=false;
  if(system||integration||librarySystem||libraryIntegration){const previous=selectedSettings[0].deployedValueOrigin;selectedSettings[0].deployedValueOrigin=null;write();await assert.rejects(settingsConfigurationApproval(args));selectedSettings[0].deployedValueOrigin=previous;}
  current.timers=[{key:'t1',configs:[{value:'False',deployedValue:'True',valueOrigin:'ApplicationLevelOverride',deployedValueOrigin:'ApplicationLevelDefault'}]}];
  write();await assert.rejects(settingsConfigurationApproval(args));current.timers=[];
  current.revisionBaseline=3;write();await assert.rejects(settingsConfigurationApproval(args));current.revisionBaseline=2;
  if(nested){current.libraries[0].name=null;write();assert.ok(await settingsConfigurationApproval(args));current.libraries[0].name='Wrong';write();await assert.rejects(settingsConfigurationApproval(args));current.libraries[0].name=null;current.libraries[0].revision=4;write();await assert.rejects(settingsConfigurationApproval(args));current.libraries[0].revision=3;}
  if(!applying){
   const container=libraryIntegration?{get settings(){return input.body.libraries[0].integrations[0].configs;},set settings(v){input.body.libraries[0].integrations[0].configs=v;}}:integration?{get settings(){return input.body.integrations[0].configs;},set settings(v){input.body.integrations[0].configs=v;}}:librarySystem?{get settings(){return input.body.libraries[0].systemConfigurations;},set settings(v){input.body.libraries[0].systemConfigurations=v;}}:nested?input.body.libraries[0]:system?{get settings(){return input.body.systemConfigurations;},set settings(v){input.body.systemConfigurations=v;}}:input.body;container.settings=[{key:'s1',value:null}];write();assert.ok(await settingsConfigurationApproval(args));
   container.settings.push({key:'s1',value:'Duplicate'});write();await assert.rejects(settingsConfigurationApproval(args));
  }else{
   input.body.operation='Deploy';write();await assert.rejects(settingsConfigurationApproval(args));
  }
 }
});
function hashFile(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}

test('owned secret approval binds vault reference; reset and apply rely on metadata, never masked equality',async t=>{
 for(const mode of ['top','library','integration','library-integration']){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'secret-settings-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Synthetic secret fixture');
 const host='test.outsystems.dev',words='Synthetic authorization',applicationKey=crypto.randomUUID(),environmentKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID();
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Owned fixture'};
 const origin={state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:applicationKey},authorization:{source}};
 const current={revisionBaseline:2,revisionDeployed:2,settings:[{key:'s1',name:'Secret',isSecret:true,value:'***',deployedValue:'***',valueOrigin:'ApplicationLevelDefault',deployedValueOrigin:'ApplicationLevelDefault'}],timers:[],systemConfigurations:[],integrations:[],libraries:[]};
 const ref={pointer:'/settings/0/value',target:'SSAM/ODC3/'+host+'/Setting/Proof',field:'password'};
 const args={file,words,host,operationId:TIMER_PATCH,input:{path:{applicationKey,environmentKey},body:{key:applicationKey,settings:[{key:'s1',value:''}]}},originOperationUuid,lookup:()=>origin,
  secretRefs:[ref],read:async (id,p)=>({ok:true,data:p?.assetKey==='lib'?{assetKey:'lib',revision:2,name:'ProofLibrary'}:id===TIMER_CONFIGURATION?current:{assetKey:applicationKey,revision:2,name:'Proof',assetType:'WebApplication'}})};
 const observed=current.settings[0],patchEntry=args.input.body.settings[0];
 if(mode!=='top'){
  if(mode==='library'){current.libraries=[{key:'lib',revision:2,revisionBaseline:2,settings:current.settings,systemConfigurations:[],integrations:[]}];args.input.body.libraries=[{key:'lib',revision:2,settings:args.input.body.settings}];ref.pointer='/libraries/0/settings/0/value';}
  else {const integration={key:'api',name:'ProofRest',pluginType:'RESTConsume',configs:current.settings},patchIntegration={key:'api',configs:args.input.body.settings};
   if(mode==='integration'){current.integrations=[integration];args.input.body.integrations=[patchIntegration];ref.pointer='/integrations/0/configs/0/value';}
   else{current.libraries=[{key:'lib',revision:2,revisionBaseline:2,settings:[],systemConfigurations:[],integrations:[integration]}];args.input.body.libraries=[{key:'lib',revision:2,integrations:[patchIntegration]}];ref.pointer='/libraries/0/integrations/0/configs/0/value';}
  }
  current.settings=[];delete args.input.body.settings;
 }
 const authorize=()=>fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hashFile(proposal)},scope:[{lane:'odc',host,operation:'settings.configuration',targets:['Proof','Secret','ProofLibrary','ProofRest','s1'],environmentKey}],constraints:{originOperationUuid,revision:2,bodySha256:hash(args.input.body),expectedConfigurationSha256:stateHash(current),secretRefsSha256:hash(args.secretRefs)}}));
 authorize();assert.ok(await settingsConfigurationApproval(args));
 for(const refs of [[],[ref,ref],[{...ref,target:ref.target+'Other'}],[{...ref,pointer:'/settings/1/value'}],[{...ref,target:'SSAM/ODC3/other.outsystems.dev/Setting/Proof'}]])
  await assert.rejects(settingsConfigurationApproval({...args,secretRefs:refs}));
 patchEntry.value='synthetic-plaintext';authorize();await assert.rejects(settingsConfigurationApproval(args));
 patchEntry.value=null;args.secretRefs=[];authorize();assert.ok(await settingsConfigurationApproval(args));
 args.operationId=SETTINGS_APPLY;args.input={body:{operation:'ApplyConfigs',assetKey:applicationKey,environmentKey,revision:2}};
 authorize();await assert.rejects(settingsConfigurationApproval(args));
 observed.valueSetAfterDeploy=true;authorize();assert.ok(await settingsConfigurationApproval(args));
 await assert.rejects(settingsConfigurationApproval({...args,secretRefs:[ref]}));
 observed.valueSetAfterDeploy=false;observed.deployedValueOrigin='ApplicationLevelOverride';authorize();assert.ok(await settingsConfigurationApproval(args));
 observed.deployedValueOrigin=observed.valueOrigin;observed.deployedValue='different mask';authorize();await assert.rejects(settingsConfigurationApproval(args));
 }
});
