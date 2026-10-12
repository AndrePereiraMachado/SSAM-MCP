import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createHash} from 'node:crypto';
import {EXTERNAL_LIBRARY_DEPLOY,externalLibraryProofApproval,externalLibraryStepApproval,externalLibraryStepUuid} from '../runtime/external-library-approval.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const id='00000000-0000-4000-8000-000000000001',key='00000000-0000-4000-8000-000000000003';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-extlib-approval-'));
 t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Synthetic own-library lifecycle');
 const base={file,words:'Synthetic standing fixture grant',host:'example.outsystems.dev',name:'SSAMOwnLibrary',packageSha256:'a'.repeat(64),releaseTag:'1.0.0',
  readAssets:async()=>({ok:true,data:{results:[],page:{totalResults:0}}}),lookup:()=>null,readDependents:async()=>({ok:true,consumers:[]})};
 const write=(overrides={})=>{
  const input={...base,...overrides};
  const constraints={packageSha256:input.packageSha256,releaseTag:input.releaseTag,releaseNotes:input.releaseNotes??null,originOperationUuid:input.originOperationUuid??null,expectedRevision:input.expectedRevision??null};
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words:input.words,
   source:{kind:'human-conversation',threadId:id,messageId:'00000000-0000-4000-8000-000000000002',question:'Synthetic test'},
   proposal:{file:proposal,sha256:sha(fs.readFileSync(proposal))},constraints,
   scope:[{lane:'odc',host:input.host,operation:EXTERNAL_LIBRARY_DEPLOY,targets:[input.name]}]}));return input;
 };
 return {base,write,proposal};
}
test('new external library approval binds exact package and release and requires complete live absence',async t=>{
 const f=fixture(t),input=f.write();
 assert.equal((await externalLibraryProofApproval(input)).fixture.isNew,true);
 for(const changed of [{packageSha256:'b'.repeat(64)},{releaseTag:'1.0.1'},{releaseNotes:'different'},{host:'other.test'},
  {name:'Other'},{words:'different words'},{expectedRevision:1},{originOperationUuid:id,expectedRevision:1},{file:undefined}])
  await assert.rejects(externalLibraryProofApproval({...input,...changed}),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 for(const data of [{results:[],page:{totalResults:1}},{results:[]},{results:[{}],page:{totalResults:1}}])
  await assert.rejects(externalLibraryProofApproval({...input,readAssets:async()=>({ok:true,data})}),{code:'ASSET_INVENTORY_UNAVAILABLE'});
 await assert.rejects(externalLibraryProofApproval({...input,readAssets:async()=>({ok:true,data:{results:[{name:'ssamownlibrary'}],page:{totalResults:1}}})}),{code:'ASSET_ALREADY_EXISTS'});
 fs.writeFileSync(f.proposal,'Altered proposal');
 await assert.rejects(externalLibraryProofApproval(input),{code:'AUTHORIZATION_CONTEXT_INVALID'});
});

test('derived publication and tag bind the parent receipt, phase, job, revision, body and unchanged approval',async t=>{
 const f=fixture(t),context=await externalLibraryProofApproval(f.write({releaseNotes:'Proof revision'}));
 const parent={operationUuid:id,state:'sending',identity:{kind:'odc-external-library',tenant:f.base.host,name:f.base.name,packageSha256:f.base.packageSha256},
  progress:{authorization:{context},tag:'1.0.0',library:{key},upload:{operationKey:key},generation:{ready:true}}};
 const publish={parentOperationUuid:id,lookup:()=>parent,words:f.base.words,host:f.base.host,operationId:'externalLibraries.publishJob',
  operationUuid:externalLibraryStepUuid(id,'publish-1'),input:{inputParameters:{JobKey:key}}};
 assert.equal(externalLibraryStepApproval(publish).sha256,context.sha256);
 for(const changed of [{host:'other.test'},{words:'Other grant'},{operationUuid:key},{operationId:'timers.run'},
  {input:{inputParameters:{JobKey:id}}},{input:{inputParameters:{JobKey:key,Other:true}}},
  {input:{inputParameters:{JobKey:key},screenVariables:{unapproved:true}}}])
  assert.throws(()=>externalLibraryStepApproval({...publish,...changed}),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 for(const mutate of [x=>x.state='confirmed',x=>x.operationUuid=key,x=>x.identity.name='Other',
  x=>x.identity.packageSha256='b'.repeat(64),x=>x.progress.generation.ready=false,
  x=>x.progress.publish={done:true},x=>x.progress.publish={operationKey:key},
  x=>x.progress.publish={attempt:0},x=>x.progress.authorization.context.sha256='changed']){
  const changed=structuredClone(parent);mutate(changed);
  assert.throws(()=>externalLibraryStepApproval({...publish,lookup:()=>changed}),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 }
 parent.progress.publish={done:true,status:'Finished',revision:2};
 const release={...publish,operationId:'asset-repository-api-v1:patch:/assets/{assetKey}/revisions/{revisionNumber}',
  operationUuid:externalLibraryStepUuid(id,'release'),input:{path:{assetKey:key,revisionNumber:2},body:{tag:'1.0.0',releaseNotes:'Proof revision'}}};
 assert.equal(externalLibraryStepApproval(release).sha256,context.sha256);
 for(const changed of [{path:{assetKey:id,revisionNumber:2},body:release.input.body},
  {path:{assetKey:key,revisionNumber:1},body:release.input.body},
  {path:release.input.path,body:{tag:'1.0.1',releaseNotes:'Proof revision'}},
  {path:release.input.path,body:{tag:'1.0.0'}},{...release.input,query:{}}])
  assert.throws(()=>externalLibraryStepApproval({...release,input:changed}),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 for(const mutate of [x=>x.progress.publish.done=false,x=>x.progress.publish.status='Running',
  x=>x.progress.publish.revision=null,x=>x.progress.release={done:true}]){
  const changed=structuredClone(parent);mutate(changed);
  assert.throws(()=>externalLibraryStepApproval({...release,lookup:()=>changed}),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 }
 fs.writeFileSync(f.proposal,'Changed proposal');
 assert.throws(()=>externalLibraryStepApproval(release),{code:'AUTHORIZATION_CONTEXT_INVALID'});
});
test('update requires the confirmed new-fixture receipt, same grant, exact revision and no consumers',async t=>{
 const f=fixture(t),initial=await externalLibraryProofApproval(f.write());
 const origin={state:'confirmed',identity:{kind:'odc-external-library',tenant:f.base.host,name:f.base.name,packageSha256:f.base.packageSha256},
  progress:{library:{isNew:true},authorization:{context:initial}},result:{libraryKey:key,revision:1}};
 const current={assetKey:key,name:f.base.name,assetType:'ExternalLibrary',revision:1};
 const input=f.write({packageSha256:'b'.repeat(64),releaseTag:'1.0.1',originOperationUuid:id,expectedRevision:1,
  lookup:uuid=>{assert.equal(uuid,id);return origin;},readAssets:async()=>({ok:true,data:{results:[current],page:{totalResults:1}}})});
 assert.deepEqual((await externalLibraryProofApproval(input)).fixture,{isNew:false,name:f.base.name,key,revision:1,originOperationUuid:id});
 for(const mutate of [x=>x.state='accepted',x=>x.identity.tenant='other.test',x=>x.identity.name='Other',x=>x.progress.library.isNew=false,
  x=>x.result.libraryKey='invalid',x=>x.result.revision=2,x=>x.progress.authorization.context.source.messageId=id,
  x=>x.progress.authorization.context.wordsSha256='altered',x=>x.progress.authorization.context.constraints.packageSha256='altered',
  x=>delete x.progress.authorization]){
  const altered=structuredClone(origin);mutate(altered);
  await assert.rejects(externalLibraryProofApproval({...input,lookup:()=>altered}),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 }
 for(const changed of [{revision:2},{assetKey:id},{assetType:'LowCodeLibrary'},{name:'ssamownlibrary'}])
  await assert.rejects(externalLibraryProofApproval({...input,readAssets:async()=>({ok:true,data:{results:[{...current,...changed}],page:{totalResults:1}}})}),{code:'EXTERNAL_LIBRARY_CHANGED'});
 for(const dependents of [{ok:false},{ok:true},{ok:true,consumers:[{name:'OtherApp'}]}])
  await assert.rejects(externalLibraryProofApproval({...input,readDependents:async()=>dependents}),{code:'EXTERNAL_LIBRARY_HAS_CONSUMERS'});
});
