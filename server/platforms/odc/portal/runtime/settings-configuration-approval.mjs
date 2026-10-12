import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {TIMER_PATCH,assertOnlyTimerOverrides} from './timer-configuration-approval.mjs';
import {TIMER_CONFIGURATION,TIMER_APPLICATION_REVISION} from './portal-timer.mjs';
import {fail} from './errors.mjs';
import {checkSecretRefs} from './portal-routes.mjs';

export const SETTINGS_APPLY='deployments-api-v1:post:/deployment-operations';
export const AGENT_SETTINGS_PATCH='asset-configurations-api-v1:patch:/environments/{environmentKey}/agents/{agentKey}/configurations';
export const AGENT_SETTINGS_CONFIGURATION='asset-configurations-api-v1:get:/environments/{environmentKey}/agents/{agentKey}/revisions/deployed/configurations';
export const settingsBodyHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).filter(k=>k!=='lastUpdateDate').sort().map(k=>[k,stable(value[k])])):value;
export const settingsConfigurationHash=value=>settingsBodyHash(stable(value));
export async function settingsConfigurationApproval({file,words,host,operationId,input,originOperationUuid,lookup,read,secretRefs=[]}){
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Settings approval must bind the owned application, stage, revision, exact change and current configuration. Nothing was sent.');
 const applying=operationId===SETTINGS_APPLY,b=input.body;
 const refs=checkSecretRefs(host,secretRefs,b,{kind:'Setting'}).map(({pointer,target,field})=>({pointer,target,field}));
 if(new Set(refs.map(r=>r.pointer)).size!==refs.length||applying&&refs.length)bad();
 let secretTouched=false;const usedRefs=new Set();
 if(!b||input.query||![TIMER_PATCH,AGENT_SETTINGS_PATCH,SETTINGS_APPLY].includes(operationId))bad();
 const param=operationId===AGENT_SETTINGS_PATCH?'agentKey':'applicationKey';
 const applicationKey=applying?b.assetKey:input.path?.[param],environmentKey=applying?b.environmentKey:input.path?.environmentKey;
 if(!applicationKey||!environmentKey)bad();
 if(applying){
  if(input.path||b.operation!=='ApplyConfigs'||Object.keys(b).some(k=>!['operation','assetKey','environmentKey','revision'].includes(k)))bad();
 }else if(Object.keys(input.path).sort().join(',')!==[param,'environmentKey'].sort().join(',')||b.key!==applicationKey
  ||Object.keys(b).some(k=>!['key','settings','libraries','systemConfigurations','integrations'].includes(k))
  ||b.settings!==undefined&&!Array.isArray(b.settings)||b.libraries!==undefined&&!Array.isArray(b.libraries)
  ||b.systemConfigurations!==undefined&&!Array.isArray(b.systemConfigurations)
  ||b.integrations!==undefined&&!Array.isArray(b.integrations)
  ||!(b.settings?.length||b.libraries?.length||b.systemConfigurations?.length||b.integrations?.length))bad();
 const origin=lookup(originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
  ||origin.identity.operationId!=='asset-repository-api-v1:post:/assets'||origin.response?.assetKey!==applicationKey||!origin.authorization?.source)bad();
 const asset=await read('asset-repository-api-v1:get:/assets/{assetKey}',{assetKey:applicationKey});
 if(!asset?.ok||asset.data?.assetKey!==applicationKey||!['Agent','WebApplication','MobileApplication'].includes(asset.data.assetType))bad();
 const agent=asset.data.assetType==='Agent';
 if(!applying&&agent!==(operationId===AGENT_SETTINGS_PATCH))bad();
 const current=await read(agent?AGENT_SETTINGS_CONFIGURATION:TIMER_CONFIGURATION,{[agent?'agentKey':'applicationKey']:applicationKey,environmentKey});
 const data=current?.data;
 if(!current?.ok||!data||!Number.isInteger(data.revisionDeployed)||data.revisionBaseline!==data.revisionDeployed
  ||!Array.isArray(data.settings)||!Array.isArray(data.timers)||!Array.isArray(data.libraries)||!Array.isArray(data.integrations))bad();
 if(applying&&b.revision!==data.revisionDeployed)bad();
 const app=await read(TIMER_APPLICATION_REVISION,{assetKey:applicationKey,revisionNumber:data.revisionDeployed});
 if(!app?.ok||app.data?.assetKey!==applicationKey||app.data.revision!==data.revisionDeployed||!app.data.name)bad();
 // ApplyConfigs applies the whole app. Refuse other overrides before authorizing it.
 // AgentConfigResult has no top-level systemConfigurations in the native schema.
 if(agent&&(Object.hasOwn(data,'systemConfigurations')||b.systemConfigurations!==undefined))bad();
 if(!agent&&!Array.isArray(data.systemConfigurations))bad();
 const changed=s=>s.valueSetAfterDeploy===true||s.value!==s.deployedValue||s.valueOrigin!==s.deployedValueOrigin;
 const selected=applying?data.settings.filter(changed):(b.settings??[]);
 const changedSystem=s=>s.valueSetAfterDeploy===true||s.deployedValueOrigin!=null&&changed(s);
 const changedIntegration=i=>Array.isArray(i.configs)&&i.configs.some(changedSystem);
 const selectedLibraries=applying?data.libraries.filter(l=>Array.isArray(l.settings)&&l.settings.some(changed)||Array.isArray(l.systemConfigurations)&&l.systemConfigurations.some(changedSystem)||Array.isArray(l.integrations)&&l.integrations.some(changedIntegration)):(b.libraries??[]);
 const selectedSystem=agent?[]:applying?data.systemConfigurations.filter(s=>s.valueSetAfterDeploy===true||s.deployedValueOrigin!=null&&changed(s)):(b.systemConfigurations??[]);
 const selectedIntegrations=applying?data.integrations.filter(i=>Array.isArray(i.configs)&&i.configs.some(c=>c.deployedValueOrigin!=null&&changed(c)||c.valueSetAfterDeploy===true)):(b.integrations??[]);
 if(!selected.length&&!selectedLibraries.length&&!selectedSystem.length&&!selectedIntegrations.length)bad();
 const targets=[app.data.name];
 const validate=(items,known,system=false,prefix='/settings',allowSecrets=!system)=>{const seen=new Set();for(const item of items){
  if(!item||seen.has(item.key))bad();seen.add(item.key);
  const matches=known.filter(s=>s.key===item.key);
  if(matches.length!==1||!system&&!matches[0].name)bad();
  if(matches[0].isSecret===true){
   if(!allowSecrets)bad();secretTouched=true;
   if(!applying){
    const pointer=prefix+'/'+items.indexOf(item)+'/value';const ref=refs.find(r=>r.pointer===pointer);
    if(item.value===null){if(ref)bad();}
    else if(item.value!==''||!ref)bad();else usedRefs.add(pointer);
   }else if(matches[0].valueSetAfterDeploy!==true&&matches[0].valueOrigin===matches[0].deployedValueOrigin)bad();
  }else if(matches[0].isSecret!==false)bad();
  if(!applying&&(Object.keys(item).some(k=>!['key','value'].includes(k))||!(item.value===null||typeof item.value==='string')))bad();
  if(system&&(typeof item.key!=='string'||!item.key||matches[0].deployedValueOrigin==null))bad();
  targets.push(system?item.key:matches[0].name);
 }};
 validate(selected,data.settings);
 validate(selectedSystem,data.systemConfigurations??[],true);
 const seenIntegrations=new Set();
 for(const item of selectedIntegrations){
  if(!item||seenIntegrations.has(item.key))bad();seenIntegrations.add(item.key);
  const matches=data.integrations.filter(i=>i.key===item.key);
  if(matches.length!==1||!Array.isArray(matches[0].configs)||typeof matches[0].pluginType!=='string'||!matches[0].pluginType)bad();
  if(!applying&&(Object.keys(item).some(k=>!['key','configs'].includes(k))||!Array.isArray(item.configs)||!item.configs.length))bad();
  targets.push(matches[0].name||item.key);
  validate(applying?matches[0].configs.filter(c=>c.deployedValueOrigin!=null&&changed(c)||c.valueSetAfterDeploy===true):item.configs,matches[0].configs,true,'/integrations/'+selectedIntegrations.indexOf(item)+'/configs',true);
 }
 const seenLibraries=new Set();
 for(const item of selectedLibraries){
  if(!item||seenLibraries.has(item.key))bad();seenLibraries.add(item.key);
  const matches=data.libraries.filter(l=>l.key===item.key);
  if(matches.length!==1||!Array.isArray(matches[0].settings)
   ||!Number.isInteger(matches[0].revision)||matches[0].revision!==matches[0].revisionBaseline)bad();
  if(!applying&&(Object.keys(item).some(k=>!['key','revision','settings','systemConfigurations','integrations'].includes(k))||item.revision!==matches[0].revision
   ||item.settings!==undefined&&!Array.isArray(item.settings)||item.systemConfigurations!==undefined&&!Array.isArray(item.systemConfigurations)
   ||item.integrations!==undefined&&!Array.isArray(item.integrations)
   ||!(item.settings?.length||item.systemConfigurations?.length||item.integrations?.length)))bad();
  const library=await read(TIMER_APPLICATION_REVISION,{assetKey:item.key,revisionNumber:matches[0].revision});
  if(!library?.ok||library.data?.assetKey!==item.key||library.data.revision!==matches[0].revision||!library.data.name
   ||matches[0].name!=null&&matches[0].name!==library.data.name)bad();
  targets.push(library.data.name);
  const libraryPrefix='/libraries/'+selectedLibraries.indexOf(item);
  validate(applying?matches[0].settings.filter(changed):(item.settings??[]),matches[0].settings,false,libraryPrefix+'/settings');
  if(item.systemConfigurations!==undefined&&!Array.isArray(matches[0].systemConfigurations))bad();
  validate(applying?(matches[0].systemConfigurations??[]).filter(changedSystem):(item.systemConfigurations??[]),matches[0].systemConfigurations??[],true);
  if(!Array.isArray(matches[0].integrations))bad();
  const integrations=applying?matches[0].integrations.filter(changedIntegration):(item.integrations??[]),seen=new Set();
  for(const integration of integrations){
   if(!integration||seen.has(integration.key))bad();seen.add(integration.key);
   const found=matches[0].integrations.filter(i=>i.key===integration.key);
   if(found.length!==1||!Array.isArray(found[0].configs)||typeof found[0].pluginType!=='string'||!found[0].pluginType)bad();
   if(!applying&&(Object.keys(integration).some(k=>!['key','configs'].includes(k))||!Array.isArray(integration.configs)||!integration.configs.length))bad();
   targets.push(found[0].name||integration.key);
   validate(applying?found[0].configs.filter(changedSystem):integration.configs,found[0].configs,true,libraryPrefix+'/integrations/'+integrations.indexOf(integration)+'/configs',true);
  }
 }
 assertOnlyTimerOverrides({...data,settings:[],integrations:data.integrations.filter(i=>!seenIntegrations.has(i.key)),libraries:data.libraries.map(l=>{
  const selected=selectedLibraries.find(s=>s.key===l.key);if(!selected)return l;
  const selectedKeys=new Set((applying?(l.systemConfigurations??[]).filter(changedSystem):(selected.systemConfigurations??[])).map(s=>s.key));
  const integrationKeys=new Set((applying?(l.integrations??[]).filter(changedIntegration):(selected.integrations??[])).map(i=>i.key));
  return {...l,settings:[],systemConfigurations:(l.systemConfigurations??[]).filter(s=>!selectedKeys.has(s.key)),integrations:l.integrations.filter(i=>!integrationKeys.has(i.key))};
 }),systemConfigurations:agent?[]:data.systemConfigurations.filter(s=>!selectedSystem.some(c=>c.key===s.key))},[]);
 if(usedRefs.size!==refs.length)bad();
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:'settings.configuration',environmentKey,targets,
  constraints:{originOperationUuid,revision:data.revisionDeployed,bodySha256:settingsBodyHash(b),expectedConfigurationSha256:settingsConfigurationHash(data),...(secretTouched?{secretRefsSha256:settingsBodyHash(refs)}:{})}});
 if(!approval||approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId)bad();
 return approval;
}
