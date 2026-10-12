import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ASSET_CREATE} from './asset-creation-approval.mjs';
import {fail} from './errors.mjs';
export const ASSET_REVISION_PATCH='asset-repository-api-v1:patch:/assets/{assetKey}/revisions/{revisionNumber}';
export async function verifyRevisionPatch({path,body,read,readNotes}) {
 const revision=await read(path);
 if(!revision?.ok||revision.data?.assetKey!==path.assetKey||revision.data.revision!==path.revisionNumber)
   return {verified:false,reason:'revision-read-unverified'};
 // Live API semantics: empty strings clear these optional fields to null.
 const expected=value=>value===''?null:value;
 for(const field of ['tag','commitMessage'])if(Object.hasOwn(body,field)&&revision.data[field]!==expected(body[field]))
   return {verified:false,reason:'revision-value-differs'};
 if(Object.hasOwn(body,'releaseNotes')){
   const notes=await readNotes(path);
   if(!notes?.ok||notes.data?.tag!==revision.data.tag||notes.data?.content!==expected(body.releaseNotes))
     return {verified:false,reason:'release-notes-unverified'};
 }
 return {verified:true,assetKey:path.assetKey,revisionNumber:path.revisionNumber,fields:Object.keys(body)};
}
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function assetRevisionApproval({file,words,host,operationId,input,precondition,lookup,read,readNotes}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Revision approval must bind an agent-created asset, exact revision, body and observed metadata. Nothing was sent.');
 const body=input.body, p=input.path;
 if(operationId!==ASSET_REVISION_PATCH || !body || !p || input.query || !precondition
   || Object.keys(body).length===0 || Object.keys(body).some(k=>!['tag','commitMessage','releaseNotes'].includes(k))
   || Object.values(body).some(v=>v!==null && typeof v!=='string')
   || Object.keys(p).some(k=>!['assetKey','revisionNumber'].includes(k))
   || !Number.isInteger(p.revisionNumber) || p.revisionNumber<1)bad();
 const expected={tag:precondition.expectedTag,commitMessage:precondition.expectedCommitMessage};
 const notesBound=Object.hasOwn(body,'releaseNotes');
 if(notesBound)expected.releaseNotes=precondition.expectedReleaseNotes;
 if(Object.values(expected).some(v=>v!==null && typeof v!=='string'))bad();
 const origin=lookup(precondition.originOperationUuid);
 if(!origin || !['accepted','confirmed'].includes(origin.state) || origin.identity?.tenant!==host
   || origin.identity?.operationId!==ASSET_CREATE || origin.response?.assetKey!==p.assetKey
   || !origin.authorization?.source)bad();
 const seen=await read(p);
 if(!seen?.ok || seen.data?.assetKey!==p.assetKey || seen.data?.revision!==p.revisionNumber || typeof seen.data?.name!=='string')
   fail('REVISION_PREREQUISITE_UNAVAILABLE','Exact revision could not be read. Nothing was sent.');
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:[seen.data.name],
   constraints:{assetKey:p.assetKey,revisionNumber:p.revisionNumber,originOperationUuid:precondition.originOperationUuid,
    bodySha256:sha(body),expectedMetadataSha256:sha(expected)}});
 if(!approval || origin.authorization.source.threadId!==approval.source.threadId
   || origin.authorization.source.messageId!==approval.source.messageId)bad();
 if(seen.data.tag!==expected.tag || seen.data.commitMessage!==expected.commitMessage)
   fail('REVISION_BASE_CHANGED','Revision metadata differs from the recorded baseline. Nothing was sent.');
 if(notesBound){
   const notes=await readNotes?.(p);
   if(!notes?.ok || !notes.data || notes.data.tag!==seen.data.tag || !Object.hasOwn(notes.data,'content'))
     fail('REVISION_PREREQUISITE_UNAVAILABLE','Release notes baseline could not be read. Nothing was sent.');
   if(notes.data.content!==expected.releaseNotes)
     fail('REVISION_BASE_CHANGED','Release notes differ from the recorded baseline. Nothing was sent.');
 }
 return approval;
}
