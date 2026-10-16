import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
import {ownedCleanupApproval} from './owned-cleanup-approval.mjs';
import {createHash} from 'node:crypto';

export const EXTERNAL_LIBRARY_DEPLOY = 'external-library:deploy';
export const EXTERNAL_LIBRARY_JOB_DELETE='external-library-generation-api-v1:delete:/generation-operations/{operationKey}';
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const bad = () => fail('AUTHORIZATION_CONTEXT_INVALID', 'External library proof must bind the exact package, release and own fixture origin. Nothing was sent.');

export async function externalLibraryDiscardApproval({file,words,host,operationId,input,originOperationUuid,lookup,readJob}) {
  if(operationId!==EXTERNAL_LIBRARY_JOB_DELETE || !uuid(originOperationUuid) || !uuid(input?.path?.operationKey)
    || Object.keys(input).some(k=>k!=='path') || Object.keys(input.path).some(k=>k!=='operationKey'))bad();
  const origin=lookup(originOperationUuid),p=origin?.progress,c=p?.authorization?.context;
  if(!origin || !['confirmed','rejected','not-sent'].includes(origin.state) || origin.identity?.kind!=='odc-external-library'
    || origin.identity.tenant!==host || p?.upload?.operationKey!==input.path.operationKey
    || !c || c.operation!==EXTERNAL_LIBRARY_DEPLOY || c.host!==host
    || c.targets?.length!==1 || c.targets[0]!==origin.identity.name
    || c.constraints?.packageSha256!==origin.identity.packageSha256
    || p.publish && !p.publish.done && p.publish.state!=='not-sent')bad();
  const scope={lane:'odc',host,operation:EXTERNAL_LIBRARY_JOB_DELETE,targets:[origin.identity.name],
    constraints:{originOperationUuid,jobKey:input.path.operationKey}};
  // CX15 r3 (N3): after the guard validated the owner's reply to the preview, a new approval of that reply (proposal = the
  // preview) bound to this deploy receipt replaces the creation's words and message.
  const fresh=ownedCleanupApproval({file,words,...scope,origin,key:input.path.operationKey,what:'The discard of this own External Library job'});
  const approval=fresh??authorizationContext(file,words,scope);
  if(!approval || !fresh&&(approval.wordsSha256!==c.wordsSha256 || approval.source.threadId!==c.source?.threadId
    || approval.source.messageId!==c.source?.messageId))bad();
  const job=await readJob(input.path.operationKey);
  if(!job.ok || job.data?.key!==input.path.operationKey || job.data?.libraryName!=null && job.data.libraryName!==origin.identity.name
    || typeof p.package?.fileName!=='string' || job.data?.filename!==p.package.fileName
    || !['ReadyForReview','Completed','GenerationError','DownloadError'].includes(job.data?.status))
    fail('EXTERNAL_LIBRARY_JOB_CHANGED','The completed generation job does not match its creation receipt; nothing was deleted.');
  return approval;
}

export function externalLibraryStepUuid(operationUuid, step) {
  const h=createHash('sha256').update(String(operationUuid).toLowerCase()+':'+step).digest('hex');
  return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);
}

// Private lifecycle continuation. The caller supplies only the parent receipt ID;
// the saved receipt and unchanged human proposal determine the exact step scope.
export function externalLibraryStepApproval({parentOperationUuid,lookup,words,host,operationId,operationUuid,input}) {
  if(!uuid(parentOperationUuid))bad();
  const parent=lookup(parentOperationUuid),p=parent?.progress,c=p?.authorization?.context;
  if(!parent || parent.operationUuid!==parentOperationUuid || !['sending','uncertain'].includes(parent.state)
    || parent.identity?.kind!=='odc-external-library' || parent.identity.tenant!==host
    || !c || c.operation!==EXTERNAL_LIBRARY_DEPLOY || c.host!==host
    || c.targets?.length!==1 || c.targets[0]!==parent.identity.name
    || c.constraints?.packageSha256!==parent.identity.packageSha256
    || c.constraints?.releaseTag!==p.tag)bad();
  const checked=authorizationContext(c.file,words,{lane:'odc',host,operation:EXTERNAL_LIBRARY_DEPLOY,
    targets:[parent.identity.name],constraints:c.constraints});
  if(!checked || checked.sha256!==c.sha256 || checked.wordsSha256!==c.wordsSha256
    || checked.proposalSha256!==c.proposalSha256)bad();
  const exact=(actual,expected)=>{
    if(!actual || typeof actual!=='object' || Array.isArray(actual)
      || Object.keys(actual).length!==Object.keys(expected).length
      || Object.entries(expected).some(([k,v])=>actual[k]!==v))bad();
  };
  if(operationId==='externalLibraries.publishJob') {
    const attempt=p.publish?.attempt??1;
    if(!Number.isSafeInteger(attempt)||attempt<1 || !p.generation?.ready || !uuid(p.upload?.operationKey)
      || p.publish?.done || p.publish?.operationKey
      || operationUuid!==externalLibraryStepUuid(parentOperationUuid,'publish-'+attempt))bad();
    exact(input?.inputParameters,{JobKey:p.upload.operationKey});
    if(Object.keys(input).some(k=>!['inputParameters','screenVariables','clientVariables'].includes(k)))bad();
    for(const k of ['screenVariables','clientVariables'])if(input[k]!==undefined)exact(input[k],{});
  } else if(operationId==='asset-repository-api-v1:patch:/assets/{assetKey}/revisions/{revisionNumber}') {
    if(p.publish?.done!==true || p.publish.status!=='Finished' || !uuid(p.library?.key)
      || !Number.isSafeInteger(p.publish.revision) || p.publish.revision<1 || p.release?.done
      || operationUuid!==externalLibraryStepUuid(parentOperationUuid,'release'))bad();
    exact(input?.path,{assetKey:p.library.key,revisionNumber:p.publish.revision});
    const notes=c.constraints.releaseNotes;
    exact(input?.body,{tag:p.tag,...(notes?{releaseNotes:notes}:{})});
    if(Object.keys(input).some(k=>!['path','body'].includes(k)))bad();
  } else bad();
  return checked;
}

// This is the proposal-bound preflight for a new fixture or its first update.
// It does not authorize derived publication/tag/deletion steps by itself.
export async function externalLibraryProofApproval({file,words,host,name,packageSha256,releaseTag,releaseNotes=null,
  originOperationUuid=null,expectedRevision=null,lookup,readAssets,readDependents}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{1,79}$/.test(name??'') || !/^[a-f0-9]{64}$/.test(packageSha256??'')
    || !/^\d+\.\d+\.\d+$/.test(releaseTag??'') || !(releaseNotes===null || typeof releaseNotes==='string')
    || (originOperationUuid===null ? expectedRevision!==null : !uuid(originOperationUuid)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)) bad();
  const approval=authorizationContext(file,words,{lane:'odc',host,operation:EXTERNAL_LIBRARY_DEPLOY,targets:[name],
    constraints:{packageSha256,releaseTag,releaseNotes,originOperationUuid,expectedRevision}});
  if (!approval) bad();
  const inventory=await readAssets({nameContains:name,limit:1000,offset:0});
  const rows=inventory?.data?.results,total=inventory?.data?.page?.totalResults;
  if (!inventory?.ok || !Array.isArray(rows) || !Number.isInteger(total) || total!==rows.length
    || rows.some(x=>typeof x?.name!=='string'))
    fail('ASSET_INVENTORY_UNAVAILABLE','Complete library inventory unavailable; nothing was sent.');
  const matches=rows.filter(x=>x.name.toLowerCase()===name.toLowerCase());
  if (originOperationUuid===null) {
    if(matches.length)fail('ASSET_ALREADY_EXISTS','A matching asset already exists; new-fixture approval cannot cover it.');
    return {...approval,fixture:{isNew:true,name,key:null,revision:null}};
  }
  const origin=lookup(originOperationUuid),source=origin?.progress?.authorization?.context;
  if (!origin || origin.state!=='confirmed' || origin.identity?.kind!=='odc-external-library'
    || origin.identity.tenant!==host || origin.identity.name!==name || origin.progress?.library?.isNew!==true
    || !uuid(origin.result?.libraryKey) || origin.result?.revision!==expectedRevision
    || source?.operation!==EXTERNAL_LIBRARY_DEPLOY || source.host!==host || source.targets?.length!==1 || source.targets[0]!==name
    || source.source?.threadId!==approval.source.threadId || source.source?.messageId!==approval.source.messageId
    || source.constraints?.originOperationUuid!==null || source.constraints?.expectedRevision!==null
    || source.constraints?.packageSha256!==origin.identity.packageSha256
    || source.wordsSha256!==approval.wordsSha256) bad();
  const current=matches[0];
  if(matches.length!==1 || current.name!==name || current.assetType!=='ExternalLibrary'
    || current.assetKey!==origin.result.libraryKey || current.revision!==expectedRevision)
    fail('EXTERNAL_LIBRARY_CHANGED','The live library is not the exact created fixture revision; nothing was sent.');
  const dependents=await readDependents(current.assetKey);
  if(!dependents?.ok || !Array.isArray(dependents.consumers) || dependents.consumers.length)
    fail('EXTERNAL_LIBRARY_HAS_CONSUMERS','An own-fixture update requires verified absence of consumers; nothing was sent.');
  return {...approval,fixture:{isNew:false,name,key:current.assetKey,revision:current.revision,originOperationUuid}};
}
