import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ASSET_CREATE} from './asset-creation-approval.mjs';
import {isUuid} from './write-journal.mjs';
import {fail} from './errors.mjs';
export const ASSET_DEPLOYMENT='deployments-api-v1:post:/deployment-operations';
export async function assetDeploymentApproval({file,words,host,input,originOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Deployment requires the exact owned asset, revision, environment and immutable proposal. Nothing was sent.');
 const b=input.body,deploy=b?.operation==='Deploy';
 if(input.path||input.query||!b||!['Deploy','Undeploy'].includes(b.operation)
   ||Object.keys(b).sort().join(',')!==(deploy?'assetKey,buildKey,environmentKey,operation,revision':'assetKey,environmentKey,operation,revision')
   ||!isUuid(b.assetKey)||!isUuid(b.environmentKey)||!Number.isInteger(b.revision)||b.revision<1||deploy&&!isUuid(b.buildKey))bad();
 const origin=lookup(originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
   ||origin.identity.operationId!==ASSET_CREATE||origin.response?.assetKey!==b.assetKey||!origin.authorization?.source)bad();
 const asset=await read('asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}',{assetKey:b.assetKey,revisionNumber:b.revision});
 if(!asset?.ok||asset.data?.assetKey!==b.assetKey||asset.data.revision!==b.revision||!asset.data.name)bad();
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:ASSET_DEPLOYMENT,targets:[asset.data.name],environmentKey:b.environmentKey,
   constraints:{originOperationUuid,bodySha256:createHash('sha256').update(JSON.stringify(b)).digest('hex')}});
 if(!approval||approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId)bad();
 if(deploy){
   const build=await read('build-operations-api-v1:get:/build-operations/{operationKey}',{operationKey:b.buildKey});
   if(!build?.ok||build.data?.buildKey!==b.buildKey||build.data.assetKey!==b.assetKey||build.data.assetRevision!==b.revision||build.data.status!=='Finished')
     fail('DEPLOYMENT_BUILD_UNVERIFIED','The exact finished build was not verified. Nothing was sent.');
 }else{
   const config=await read('asset-configurations-api-v1:get:/environments/{environmentKey}/applications/{applicationKey}/revisions/deployed/configurations',
     {environmentKey:b.environmentKey,applicationKey:b.assetKey});
   if(!config?.ok||config.data?.revisionDeployed!==b.revision||config.data.revisionBaseline!==b.revision)
     fail('DEPLOYMENT_REVISION_CHANGED','The exact deployed revision was not verified. Nothing was sent.');
 }
 return approval;
}
