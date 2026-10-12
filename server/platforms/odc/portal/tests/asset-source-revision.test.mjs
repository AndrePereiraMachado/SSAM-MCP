import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {prepareSourceRevision,cleanCandidateValidation} from '../runtime/asset-source-revision.mjs';
import {ASSET_CREATE} from '../runtime/asset-creation-approval.mjs';
import {OdcAccess} from '../runtime/access.mjs';
test('source revision binds file hash, origin, tenant and latest revision',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'source-revision-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const directory=path.join(temp,'downloads','asset-sources');fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,'source.bin'),proposal=path.join(directory,'proposal.md'),context=path.join(directory,'approval.json');
 const bytes=Buffer.from('OML: synthetic fixture'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 fs.writeFileSync(file,bytes);fs.writeFileSync(proposal,'Synthetic only');
 const assetKey='41c981fe-d063-45e6-8ce5-4df6739e3a46',originOperationUuid=crypto.randomUUID(),host='example.outsystems.dev',words='Synthetic permission';
 fs.writeFileSync(file+'.json',JSON.stringify({assetKey,revisionNumber:1,byteLength:bytes.length,sha256:hash(bytes)}));
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Synthetic fixture'};
 fs.writeFileSync(context,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
 proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host,operation:ASSET_CREATE,targets:['Fixture']}],
 constraints:{assetKey,expectedRevision:1,sourceSha256:hash(bytes),originOperationUuid}}));
 const origin={state:'accepted',identity:{tenant:host,operationId:ASSET_CREATE},response:{assetKey},authorization:{source}};
 const base={directory,host,input:{assetKey,expectedRevision:1,file,expectedSha256:hash(bytes),originOperationUuid,authorize:words,authorizationContext:context},
 lookup:()=>origin,read:async()=>({ok:true,data:{assetKey,revision:1,name:'Fixture'}})};
 assert.deepEqual(Buffer.from((await prepareSourceRevision(base)).body.$base64,'base64'),bytes);
 await assert.rejects(prepareSourceRevision({...base,input:{...base.input,uploadFormat:'url'}}),e=>e.code==='SOURCE_REVISION_INVALID');
 await assert.rejects(prepareSourceRevision({...base,input:{...base.input,uploadFormat:'source-uri'}}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 await assert.rejects(prepareSourceRevision({...base,input:{...base.input,uploadFormat:'source-uri',candidateProof:'not-allowed'}}),e=>e.code==='SOURCE_REVISION_INVALID');
 await assert.rejects(prepareSourceRevision({...base,input:{...base.input,uploadFormat:'multipart'}}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 const multipartPermission=JSON.parse(fs.readFileSync(context,'utf8'));
 multipartPermission.constraints.uploadFormat='multipart';fs.writeFileSync(context,JSON.stringify(multipartPermission));
 const multipart=await prepareSourceRevision({...base,input:{...base.input,uploadFormat:'multipart'}});
 assert.equal(multipart.contentType,'multipart/form-data');assert.deepEqual(multipart.body.creationRequest,{});
 assert.equal(multipart.body.assetFile.filename,'source.oml');
 assert.deepEqual(Buffer.from(multipart.body.assetFile.$base64,'base64'),bytes);
 delete multipartPermission.constraints.uploadFormat;fs.writeFileSync(context,JSON.stringify(multipartPermission));
 await assert.rejects(prepareSourceRevision({...base,lookup:()=>({...origin,state:'uncertain'})}),e=>e.code==='SOURCE_REVISION_INVALID');
 await assert.rejects(prepareSourceRevision({...base,read:async()=>({ok:true,data:{assetKey,revision:2,name:'Fixture'}})}),e=>e.code==='REVISION_BASE_CHANGED');
 await assert.rejects(prepareSourceRevision({...base,host:'wrong.test'}),e=>e.code==='SOURCE_REVISION_INVALID');
 // A successful POST can refer to an existing revision. It must never count as a new one.
 for(const returnedRevision of [1,2]) {
  const operationUuid=crypto.randomUUID();let uploaded=false,observation;
  const receipt={operationUuid,state:'accepted',identity:{tenant:host,operationId:ASSET_CREATE,target:{assetKey}}};
  const access=new OdcAccess({receipts:{dir:path.join(temp,'receipts'),lookup:id=>id===originOperationUuid?origin:uploaded?receipt:null,
    reconcile:(r,o)=>{observation=o.observation;return {...r,state:'confirmed'};}}});
  access.read=async args=>({ok:true,status:200,operationId:args.operationId,data:{assetKey,name:'Fixture',revision:args.path.revisionNumber??1}});
  access.write=async()=>{uploaded=true;return {ok:true,status:201,data:{assetKey,revision:returnedRevision},receipt};};
  const result=await access.assetRevision({...base.input,tenant:host,operationUuid});
  assert.equal(result.revisionCreatedVerified,returnedRevision===2);
  assert.equal(result.revisionOutcome,returnedRevision===2?'new-revision':'existing-revision');
  assert.equal(observation.newRevision,returnedRevision===2);
  assert.equal(result.receipt.state,'confirmed');
 }
 const candidate=path.join(temp,'candidate.oml'),job=path.join(temp,'job.json'),proofFile=path.join(temp,'native-result.json');
 fs.writeFileSync(candidate,'OML: altered candidate');fs.writeFileSync(job,'{}');
 const candidateSha256=hash(fs.readFileSync(candidate)),moduleKey='_oHJQWPQ5kWM5U32c546Rg';
 const proof={ok:true,data:{accepted:true,isValid:true,messages:0,outPath:candidate,handles:{'@espace':moduleKey}},
   artifacts:{schema:'ssam-job-artifacts/1',lane:'odc',moduleKey,base:{file,sha256:hash(bytes)},
     job:{file:job,sha256:hash(fs.readFileSync(job))},candidate:{file:candidate,sha256:candidateSha256}}};
 fs.writeFileSync(proofFile,JSON.stringify(proof));
 const permission=JSON.parse(fs.readFileSync(context,'utf8'));
 Object.assign(permission.constraints,{candidateSha256,candidateProofSha256:hash(fs.readFileSync(proofFile))});fs.writeFileSync(context,JSON.stringify(permission));
 const candidateInput={...base,input:{...base.input,candidateProof:proofFile,candidateSha256}};
 assert.deepEqual(Buffer.from((await prepareSourceRevision(candidateInput)).body.$base64,'base64'),fs.readFileSync(candidate));
 proof.data.messages=1;fs.writeFileSync(proofFile,JSON.stringify(proof));
 await assert.rejects(prepareSourceRevision(candidateInput),e=>e.code==='SOURCE_REVISION_INVALID');
 proof.data.validation={new:[],unexpected:[],missingExpected:[],ambiguous:[],tolerated:[],preexisting:[{id:'Existing',type:'Warning',key:'key',path:'Fixture',detail:'Existing warning'}]};
 proof.data.details=['Warning Existing: Existing warning @ Fixture'];fs.writeFileSync(proofFile,JSON.stringify(proof));
 permission.constraints.candidateProofSha256=hash(fs.readFileSync(proofFile));fs.writeFileSync(context,JSON.stringify(permission));
 assert.deepEqual(Buffer.from((await prepareSourceRevision(candidateInput)).body.$base64,'base64'),fs.readFileSync(candidate));
 delete proof.data.validation;delete proof.data.details;
 proof.data.messages=0;fs.writeFileSync(proofFile,JSON.stringify(proof));fs.appendFileSync(candidate,'changed');
 await assert.rejects(prepareSourceRevision(candidateInput),e=>e.code==='SOURCE_REVISION_INVALID');
 fs.appendFileSync(file,'modified');
 await assert.rejects(prepareSourceRevision(base),e=>e.code==='SOURCE_REVISION_INVALID');
});
test('candidate upload accepts only exactly accounted preexisting warnings',()=>{
 const d={accepted:true,isValid:true,messages:1,details:['Warning Existing: Existing warning @ Fixture'],validation:{new:[],unexpected:[],missingExpected:[],ambiguous:[],tolerated:[],preexisting:[{id:'Existing',type:'Warning',key:'key',path:'Fixture',detail:'Existing warning'}]}};
 assert.equal(cleanCandidateValidation(d),true);
 for(const mutate of [x=>x.validation.new.push({type:'Warning'}),x=>x.validation.preexisting[0].type='Error',x=>x.validation.preexisting=[],x=>x.details[0]='Different',x=>x.messages=0,x=>x.validation.ambiguous.push({}),x=>x.isValid=false]){const changed=structuredClone(d);mutate(changed);assert.equal(cleanCandidateValidation(changed),false);}
});
