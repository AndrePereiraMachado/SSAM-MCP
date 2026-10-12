import { authorizationContext } from '../../facade/authorization-context.mjs';
import { TIMER_CONFIGURATION, TIMER_APPLICATION_REVISION } from './portal-timer.mjs';
import { fail } from './errors.mjs';
export const TIMER_PATCH='asset-configurations-api-v1:patch:/environments/{environmentKey}/applications/{applicationKey}/configurations';
const DEPLOY='deployments-api-v1:post:/deployment-operations';
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Timer configuration approval does not cover this exact app, environment, revision and change. Nothing was sent.');
const readFailureCodes=new Set(['STUDIO_NOT_SIGNED_IN','STUDIO_NOT_CONNECTED','AUTH_REQUIRED','HEADLESS_AUTH_UNAVAILABLE','CREDENTIAL_METADATA_UNAVAILABLE','NOT_ALLOWED','REMOTE_ERROR','PORTAL_TIMEOUT','READ_DEADLINE_EXCEEDED']);
async function prerequisite(stage,read){
 let result;
 try { result=await read(); }
 catch(error){ refusedRead(stage,error); }
 if(result?.ok!==true)refusedRead(stage,result?.error??result);
 return result;
}
function refusedRead(stage,error){
 const causeCode=readFailureCodes.has(error?.code)?error.code:'READ_FAILED';
 fail('CONFIGURATION_PREREQUISITE_UNAVAILABLE','A required configuration read failed. Authorization could not be evaluated; nothing was sent.',{stage,causeCode});
}
const allowed=new Set(['Schedule','IsActive','Timeout']);
const inherited = items => Array.isArray(items) && items.every(c => typeof c.valueOrigin==='string' && /LevelDefault$/.test(c.valueOrigin)
 && (c.deployedValueOrigin===null || c.deployedValueOrigin===c.valueOrigin) && c.valueSetAfterDeploy!==true
 && (c.isSecret===true || c.deployedValue===null || c.value===c.deployedValue));
export function assertOnlyTimerOverrides(data, selected) {
 if(!inherited(data.settings)||!inherited(data.systemConfigurations)||!Array.isArray(data.integrations)||!data.integrations.every(i=>inherited(i.configs))
   || !Array.isArray(data.libraries)||!data.libraries.every(l=>l.revision===l.revisionBaseline&&inherited(l.settings)&&inherited(l.systemConfigurations)
     && Array.isArray(l.integrations)&&l.integrations.every(i=>inherited(i.configs))))bad();
 for(const timer of data.timers) if(!selected.some(t=>t.key===timer.key)&&!inherited(timer.configs))bad();
}
export async function timerConfigurationApproval({file,words,host,operationId,input,read,pending}){
 const applying=operationId===DEPLOY;
 if(operationId!==TIMER_PATCH&&!applying)bad();
 const body=input.body??{},environmentKey=applying?body.environmentKey:input.path?.environmentKey;
 const applicationKey=applying?body.assetKey:input.path?.applicationKey;
 if(!environmentKey||!applicationKey)bad();
 if(applying){
  if(body.operation!=='ApplyConfigs'||Object.keys(body).some(k=>!['operation','assetKey','environmentKey','revision'].includes(k)))bad();
 }else if(Object.keys(body).some(k=>!['key','timers'].includes(k))||body.key!==applicationKey||!Array.isArray(body.timers)||!body.timers.length)bad();
 const current=await prerequisite('configuration',()=>read(TIMER_CONFIGURATION,{environmentKey,applicationKey}));
 if(!current.data||current.data.revisionBaseline!==current.data.revisionDeployed||!Number.isInteger(current.data.revisionDeployed))bad();
 const revision=current.data.revisionDeployed;
 if(applying&&body.revision!==undefined&&body.revision!==revision)bad();
 const app=await prerequisite('application-revision',()=>read(TIMER_APPLICATION_REVISION,{assetKey:applicationKey,revisionNumber:revision}));
 if(!app.data?.name||app.data.revision!==revision||app.data.assetKey!==applicationKey)bad();
 const baseline=structuredClone(current.data),targets=[app.data.name];
 const selected=applying?baseline.timers?.filter(t=>t.configs?.some(c=>c.value!==c.deployedValue||c.valueOrigin!==c.deployedValueOrigin)):body.timers;
 if(!Array.isArray(selected)||!selected.length)bad();
 const seen=new Set();
 for(const item of selected){
  if(seen.has(item.key))bad();seen.add(item.key);
  const timer=baseline.timers?.find(t=>t.key===item.key);
  if(!timer?.name||!Array.isArray(item.configs)||!item.configs.length)bad();
  targets.push(timer.name);
  if(!applying&&Object.keys(item).some(k=>!['key','configs'].includes(k)))bad();
  const keys=new Set();
  for(const entry of item.configs){
   const changed=entry.value!==entry.deployedValue||entry.valueOrigin!==entry.deployedValueOrigin;
   if(applying&&!changed)continue;
   if(keys.has(entry.key)||!allowed.has(entry.key))bad();keys.add(entry.key);
   const config=timer.configs.find(c=>c.key===entry.key);
   if(!config||config.isSecret)bad();
   if(!applying&&(Object.keys(entry).some(k=>!['key','value'].includes(k))||!(entry.value===null||typeof entry.value==='string')))bad();
   config.value=config.deployedValue;config.valueOrigin=config.deployedValueOrigin;
  }
 }
 // This narrowly authorized path allows timer overrides over inherited defaults.
 // It does not compare secret contents or claim an atomic cross-service snapshot.
 assertOnlyTimerOverrides(current.data,selected);
 const pendingResult=await prerequisite('pending-configurations',()=>pending({applicationKey,environmentKey,timerKey:selected[0].key}));
 const list=pendingResult?.data?.PendingConfigurations?.List;
 if(!Array.isArray(list))bad();
 if(!applying&&list.length)bad();
 if(applying&&list.some(p=>!selected.some(t=>t.key===p.Key&&t.name===p.Name)||p.LibraryKey||p.LibraryRevision))bad();
 return authorizationContext(file,words,{lane:'odc',host,operation:'timers.configuration',environmentKey,targets});
}
