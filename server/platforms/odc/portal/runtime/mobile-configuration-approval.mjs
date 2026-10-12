import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {binaryPatchProvenance} from './mobile-binary-upload.mjs';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
import {checkSecretRefs} from './portal-routes.mjs';
import {MOBILE_EXTENSIBILITY_PATCH,extensibilityChanges,extensibilityStateHash,extensibilityExpectation} from './mobile-extensibility.mjs';
export const MOBILE_CONFIGURATION_WRITES=new Set(['android','ios'].map(p=>'native-application-orchestration-service-api-v1:patch:/environments/{environmentKey}/applications/{applicationKey}/configurations/'+p));
export const mobileConfigurationHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Unconfigured fields receive a fresh lastUpdateDate on each GET. Bind values,
// types and metadata, not these server-generated observation timestamps.
export const mobileConfigurationStateHash=value=>mobileConfigurationHash(Object.fromEntries(Object.keys(value).sort().map(key=>{
 const item=value[key];return [key,item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).filter(k=>k!=='lastUpdateDate').sort().map(k=>[k,item[k]])):item];
})));
export async function mobileConfigurationApproval({file,words,host,operationId,input,originOperationUuid,lookup,read,secretRefs=[]}){
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Mobile configuration approval must bind the own mobile fixture, stage, exact public fields and observed configuration. Nothing was sent.');
 const p=input.path,b=input.body,extensibility=operationId===MOBILE_EXTENSIBILITY_PATCH;
 const refs=checkSecretRefs(host,secretRefs,b,{kind:'Setting'}).map(({pointer,target,field})=>({pointer,target,field}));
 if(!extensibility&&refs.length)bad();
 if(!MOBILE_CONFIGURATION_WRITES.has(operationId)&&!extensibility||input.query||!p||Object.keys(p).sort().join(',')!=='applicationKey,environmentKey'
  ||!b||!Object.keys(b).length)bad();
 if(!extensibility){
  if(Object.keys(b).some(k=>!['appIdentifier','mabsVersion','mobileFramework','buildType'].includes(k)))bad();
  for(const value of Object.values(b))if(!value||Object.keys(value).join(',')!=='value'||value.value!==null&&typeof value.value!=='string')bad();
 }
 const origin=lookup(originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
  ||origin.identity.operationId!=='asset-repository-api-v1:post:/assets'||origin.response?.assetKey!==p.applicationKey||!origin.authorization?.source)bad();
 const asset=await read('asset-repository-api-v1:get:/assets/{assetKey}',{assetKey:p.applicationKey});
 if(!asset?.ok||asset.data?.assetKey!==p.applicationKey||asset.data.assetType!=='MobileApplication'||!asset.data.name)bad();
 const current=await read(operationId.replace(':patch:',':get:'),p);
 if(!current?.ok||!current.data)bad();
 if(extensibility){
  extensibilityChanges(b,current.data,refs);
  let constraints;try{if(fs.statSync(file).size>32768)bad();constraints=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
  binaryPatchProvenance({constraints,body:b,current:current.data,lookup,host,...p,originOperationUuid});
 }
 else for(const key of Object.keys(b))if(current.data[key]?.isSecret!==false||!Object.hasOwn(current.data[key],'value'))bad();
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:[asset.data.name],environmentKey:p.environmentKey,
  constraints:{originOperationUuid,bodySha256:mobileConfigurationHash(b),expectedConfigurationSha256:extensibility?extensibilityStateHash(current.data):mobileConfigurationStateHash(current.data),...(refs.length?{secretRefsSha256:mobileConfigurationHash(refs)}:{})}});
 if(!approval||approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId)bad();
 return extensibility ? {...approval,extensibilityExpectation:extensibilityExpectation(b,current.data)} : approval;
}
