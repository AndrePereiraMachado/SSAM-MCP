import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
import {isUuid} from './write-journal.mjs';
export const LIBRARY_RELEASE='libraries.release';
export const LIBRARY_PUBLISH='deployments-api-v1:post:/publish-operations';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Library release requires a bound proposal for an agent-created library, its published revision and exact version/notes. Nothing was sent.');

export async function libraryPublicationApproval({file,words,host,input,originOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Publication requires a bound proposal for an agent-created supported asset, exact revision and environment. Nothing was sent.');
 const body=input.body;
 if(input.path||input.query||!body||Object.keys(body).sort().join(',')!=='assetKey,environmentKey,operation,revision'
   ||body.operation!=='Publish'||!isUuid(body.assetKey)||!isUuid(body.environmentKey)||!Number.isInteger(body.revision)||body.revision<1)bad();
 const origin=lookup(originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
   ||origin.identity.operationId!=='asset-repository-api-v1:post:/assets'||origin.response?.assetKey!==body.assetKey||!origin.authorization?.source)bad();
 const revision=await read({assetKey:body.assetKey,revisionNumber:body.revision});
 if(!revision?.ok||revision.data?.assetKey!==body.assetKey||revision.data.revision!==body.revision
   ||!['LowCodeLibrary','MobileLibrary','WebApplication','MobileApplication','Agent'].includes(revision.data.assetType)||!revision.data.name)bad();
 const approved=authorizationContext(file,words,{lane:'odc',host,operation:LIBRARY_PUBLISH,targets:[revision.data.name],environmentKey:body.environmentKey,
  constraints:{originOperationUuid,bodySha256:sha(body)}});
 if(!approved||approved.source.threadId!==origin.authorization.source.threadId||approved.source.messageId!==origin.authorization.source.messageId)bad();
 return approved;
}

export async function libraryReleaseApproval({file,words,host,raw,lookup,read}) {
 const input=raw.inputParameters;
 if(!file||!input||Object.keys(input).sort().join(',')!=='ApplicationKey,ReleaseNotes,Revision,Version'
   ||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length
   ||!isUuid(input.ApplicationKey)||!Number.isInteger(input.Revision)||input.Revision<1
   ||typeof input.Version!=='string'||!/^\d+\.\d+\.\d+$/.test(input.Version)
   ||typeof input.ReleaseNotes!=='string'||input.ReleaseNotes.length>10000)bad();
 let constraints;
 try {if(fs.statSync(file).size>32768)bad();constraints=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(!isUuid(constraints?.originOperationUuid)||!isUuid(constraints?.publicationKey)
   ||constraints.expectedTag!==null)bad();
 const origin=lookup(constraints.originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
   ||origin.identity.operationId!=='asset-repository-api-v1:post:/assets'
   ||origin.response?.assetKey!==input.ApplicationKey||!origin.authorization?.source)bad();
 const path={assetKey:input.ApplicationKey,revisionNumber:input.Revision};
 const revision=await read('asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}',path);
 const current=await read('asset-repository-api-v1:get:/assets/{assetKey}',{assetKey:input.ApplicationKey});
 if(!revision?.ok||!current?.ok||revision.data?.assetKey!==input.ApplicationKey
   ||revision.data.revision!==input.Revision||!['LowCodeLibrary','MobileLibrary'].includes(revision.data.assetType)
   ||revision.data.tag!==null||!revision.data.name||current.data?.assetKey!==input.ApplicationKey
   ||current.data.revision!==input.Revision||current.data.name!==revision.data.name)
   fail('LIBRARY_RELEASE_BASE_UNVERIFIED','Exact current untagged low-code or mobile library revision was not verified. Nothing was sent.');
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:LIBRARY_RELEASE,targets:[revision.data.name],
  constraints:{originOperationUuid:constraints.originOperationUuid,publicationKey:constraints.publicationKey,expectedTag:null,inputSha256:sha(input)}});
 if(!approval||approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId)bad();
 const publication=await read('deployments-api-v1:get:/publish-operations/{operationKey}',{operationKey:constraints.publicationKey});
 if(!publication?.ok||publication.data?.key!==constraints.publicationKey||publication.data.status!=='Finished'
   ||publication.data.assetKey!==input.ApplicationKey||publication.data.revision!==input.Revision||publication.data.operation!=='Publish')
   fail('LIBRARY_PUBLICATION_UNVERIFIED','The same library revision must have a verified successful publication before this release. Nothing was sent.');
 return approval;
}

export async function verifyLibraryRelease(input,read) {
 const path={assetKey:input.ApplicationKey,revisionNumber:input.Revision};
 const revision=await read('asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}',path);
 const notes=await read('asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}/release-notes',path);
 return revision?.ok===true&&notes?.ok===true&&revision.data?.assetKey===input.ApplicationKey
  &&revision.data.revision===input.Revision&&revision.data.tag===input.Version
  &&notes.data?.tag===input.Version&&notes.data.content===(input.ReleaseNotes===''?null:input.ReleaseNotes);
}
