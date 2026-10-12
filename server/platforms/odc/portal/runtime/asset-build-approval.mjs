import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ASSET_CREATE} from './asset-creation-approval.mjs';
import {fail} from './errors.mjs';
export const ASSET_BUILD='build-operations-api-v1:post:/build-operations';
export const GENERATED_CODE='build-operations-api-v1:post:/build-operations/{operationKey}/generated-code';
export async function generatedCodeApproval({file,words,host,operationId,input,originOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Generated code approval must bind the exact completed build receipt. Nothing was sent.');
 if(operationId!==GENERATED_CODE||input.body!==undefined||input.query||!input.path?.operationKey||Object.keys(input.path).length!==1)bad();
 const origin=lookup(originOperationUuid),key=input.path.operationKey;
 if(origin?.state!=='confirmed'||origin.identity?.tenant!==host||origin.identity.operationId!==ASSET_BUILD
   ||origin.response?.buildKey!==key||!origin.authorization?.source)bad();
 const seen=await read({operationKey:key}),target=origin.identity.target;
 if(!seen?.ok||seen.data?.buildKey!==key||seen.data.status!=='Finished'
  ||['assetKey','assetRevision','buildType'].some(k=>target?.[k]===undefined||seen.data[k]!==target[k]))
  fail('BUILD_NOT_VERIFIED','The exact completed build could not be verified. Nothing was sent.');
 const approved=authorizationContext(file,words,{lane:'odc',host,operation:GENERATED_CODE,targets:[key],
  constraints:{originOperationUuid,assetKey:target.assetKey,assetRevision:target.assetRevision,buildType:target.buildType}});
 if(!approved||approved.source.threadId!==origin.authorization.source.threadId||approved.source.messageId!==origin.authorization.source.messageId)bad();
 return approved;
}
export async function assetBuildApproval({file,words,host,operationId,input,originOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Build approval must bind the exact new fixture, revision, build type and creation receipt. Nothing was sent.');
 const b=input.body;
 if(operationId!==ASSET_BUILD||input.path||input.query||!b||Object.keys(b).some(k=>!['assetKey','assetRevision','buildType'].includes(k))
  ||!Number.isInteger(b.assetRevision)||b.assetRevision<1||!['Debug','Release'].includes(b.buildType))bad();
 const origin=lookup(originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host||origin.identity.operationId!==ASSET_CREATE
  ||origin.response?.assetKey!==b.assetKey||!origin.authorization?.source)bad();
 const seen=await read({assetKey:b.assetKey,revisionNumber:b.assetRevision});
 if(!seen?.ok||seen.data?.assetKey!==b.assetKey||seen.data?.revision!==b.assetRevision)fail('BUILD_REVISION_UNAVAILABLE','Exact build revision could not be read. Nothing was sent.');
 const approved=authorizationContext(file,words,{lane:'odc',host,operation:ASSET_BUILD,targets:[seen.data.name],
  constraints:{bodySha256:createHash('sha256').update(JSON.stringify(b)).digest('hex'),originOperationUuid}});
 if(!approved||approved.source.threadId!==origin.authorization.source.threadId||approved.source.messageId!==origin.authorization.source.messageId)bad();
 return approved;
}
