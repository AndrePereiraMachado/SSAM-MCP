import {authorizationContext} from '../../facade/authorization-context.mjs';
import {mobileConfigurationHash,mobileConfigurationStateHash} from './mobile-configuration-approval.mjs';
import {ASSET_CREATE} from './asset-creation-approval.mjs';
import {fail} from './errors.mjs';
export const NATIVE_MOBILE_BUILD='native-application-orchestration-service-api-v1:post:/build-operations';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
export async function nativeMobileBuildApproval({file,words,host,input,originOperationUuid,lookup,read}){
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Native mobile build needs the own mobile fixture, exact completed build, stage, platform, configuration and human approval. Nothing was sent.');
 const b=input.body;
 if(input.path||input.query||!b||Object.keys(b).sort().join(',')!=='applicationKey,buildKey,environmentKey,mobilePlatform,mobileVersionCode,mobileVersionNumber,revision'
  ||!['applicationKey','buildKey','environmentKey'].every(k=>uuid(b[k]))||!Number.isInteger(b.revision)||b.revision<1
  ||!['Android','iOS'].includes(b.mobilePlatform)||!Number.isInteger(b.mobileVersionCode)||b.mobileVersionCode<1
  ||!/^\d+\.\d+\.\d+$/.test(b.mobileVersionNumber??''))bad();
 const origin=lookup(originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
  ||origin.identity.operationId!==ASSET_CREATE||origin.response?.assetKey!==b.applicationKey||!origin.authorization?.source)bad();
 const asset=await read('asset-repository-api-v1:get:/assets/{assetKey}',{path:{assetKey:b.applicationKey}});
 if(!asset?.ok||asset.data?.assetKey!==b.applicationKey||asset.data.assetType!=='MobileApplication'||!asset.data.name)bad();
 const build=await read('build-operations-api-v1:get:/build-operations/{operationKey}',{path:{operationKey:b.buildKey}});
 if(!build?.ok||build.data?.buildKey!==b.buildKey||build.data.assetKey!==b.applicationKey||build.data.assetRevision!==b.revision||build.data.status!=='Finished')
  fail('BUILD_NOT_VERIFIED','The exact finished application build is required before a native package request. Nothing was sent.');
 const platform=b.mobilePlatform==='Android'?'android':'ios';
 const config=await read('native-application-orchestration-service-api-v1:get:/environments/{environmentKey}/applications/{applicationKey}/configurations/'+platform,
  {path:{environmentKey:b.environmentKey,applicationKey:b.applicationKey}});
 if(!config?.ok||config.data?.buildType?.isSecret!==false||config.data.buildType.value!==(platform==='android'?'Debug':'Simulator'))bad();
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:NATIVE_MOBILE_BUILD,targets:[asset.data.name],environmentKey:b.environmentKey,
  constraints:{originOperationUuid,bodySha256:mobileConfigurationHash(b),expectedConfigurationSha256:mobileConfigurationStateHash(config.data)}});
 if(!approval||approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId)bad();
 const {mobileVersionNumber,mobileVersionCode,...validationBody}=b;
 const validation=await read('native-application-orchestration-service-api-v1:post:/build-operations/native-build-validation',{body:validationBody});
 if(!validation?.ok||validation.data?.platformResults?.[b.mobilePlatform]!=='NativeBuildNeeded')
  fail('NATIVE_BUILD_NOT_READY','Native validation must explicitly report NativeBuildNeeded for the selected platform. Nothing was sent.');
 return approval;
}
