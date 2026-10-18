import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {assetRevisionApproval,ASSET_REVISION_PATCH,verifyRevisionPatch} from '../runtime/asset-revision-approval.mjs';
import {ASSET_CREATE} from '../runtime/asset-creation-approval.mjs';
test('revision read-back distinguishes cleared metadata, ignored null, mismatched identity and failed notes',async()=>{
 const path={assetKey:crypto.randomUUID(),revisionNumber:1};
 const data={assetKey:path.assetKey,revision:1,tag:null,commitMessage:null};
 const base={path,body:{tag:'',commitMessage:'',releaseNotes:''},read:async()=>({ok:true,data}),readNotes:async()=>({ok:true,data:{tag:null,content:null}})};
 assert.equal((await verifyRevisionPatch(base)).verified,true);
 assert.equal((await verifyRevisionPatch({...base,body:{tag:null},read:async()=>({ok:true,data:{...data,tag:'1.0.0'}})})).verified,false);
 for(const changed of [{...data,assetKey:crypto.randomUUID()},{...data,revision:2}])
  assert.equal((await verifyRevisionPatch({...base,read:async()=>({ok:true,data:changed})})).verified,false);
 assert.equal((await verifyRevisionPatch({...base,read:async()=>({ok:false})})).verified,false);
 assert.equal((await verifyRevisionPatch({...base,readNotes:async()=>({ok:false})})).verified,false);
 assert.equal((await verifyRevisionPatch({...base,readNotes:async()=>({ok:true,data:{tag:null,content:'other'}})})).verified,false);
});
test('revision metadata approval checks provenance, exact body and optimistic baseline',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'revision-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Synthetic test');
 const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
 const host='example.outsystems.dev',words='Synthetic grant',assetKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID();
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Synthetic fixture'};
 const body={tag:'1.0.0',commitMessage:'test'},expected={tag:null,commitMessage:null};
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
 proposal:{file:proposal,sha256:sha(fs.readFileSync(proposal))},scope:[{lane:'odc',host,operation:ASSET_REVISION_PATCH,targets:['Fixture']}],
 constraints:{assetKey,revisionNumber:1,originOperationUuid,bodySha256:sha(JSON.stringify(body)),expectedMetadataSha256:sha(JSON.stringify(expected))}}));
 const origin={state:'accepted',identity:{tenant:host,operationId:ASSET_CREATE},response:{assetKey},authorization:{source}};
 const data={assetKey,revision:1,name:'Fixture',...expected};
 const base={file,words,host,operationId:ASSET_REVISION_PATCH,input:{path:{assetKey,revisionNumber:1},body},
 precondition:{originOperationUuid,expectedTag:null,expectedCommitMessage:null},lookup:()=>origin,read:async()=>({ok:true,data})};
 assert.deepEqual((await assetRevisionApproval(base)).targets,['Fixture']);
 for(const mutation of [null,{...origin,state:'uncertain'},{...origin,response:{assetKey:crypto.randomUUID()}},
 {...origin,identity:{...origin.identity,tenant:'different.test'}},{...origin,authorization:{source:{...source,messageId:crypto.randomUUID()}}}])
 await assert.rejects(assetRevisionApproval({...base,lookup:()=>mutation}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 await assert.rejects(assetRevisionApproval({...base,read:async()=>({ok:false})}),e=>e.code==='REVISION_PREREQUISITE_UNAVAILABLE');
 await assert.rejects(assetRevisionApproval({...base,read:async()=>({ok:true,data:{...data,tag:'2.0.0'}})}),e=>e.code==='REVISION_BASE_CHANGED');
 await assert.rejects(assetRevisionApproval({...base,input:{...base.input,body:{tag:null}}}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 await assert.rejects(assetRevisionApproval({...base,input:{...base.input,body:{releaseNotes:'unbound'}}}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 const notesBody={tag:'1.0.0',releaseNotes:'Synthetic release notes'};
 const permission=JSON.parse(fs.readFileSync(file,'utf8'));
 permission.constraints.bodySha256=sha(JSON.stringify(notesBody));
 permission.constraints.expectedMetadataSha256=sha(JSON.stringify({...expected,releaseNotes:null}));
 fs.writeFileSync(file,JSON.stringify(permission));
 const notesBase={...base,input:{...base.input,body:notesBody},precondition:{...base.precondition,expectedReleaseNotes:null},
 readNotes:async()=>({ok:true,data:{tag:null,content:null}})};
 assert.deepEqual((await assetRevisionApproval(notesBase)).targets,['Fixture']);
 for(const response of [{ok:false},{ok:true,data:{tag:null}},{ok:true,data:{tag:'changed',content:null}}])
  await assert.rejects(assetRevisionApproval({...notesBase,readNotes:async()=>response}),e=>e.code==='REVISION_PREREQUISITE_UNAVAILABLE');
 await assert.rejects(assetRevisionApproval({...notesBase,readNotes:async()=>({ok:true,data:{tag:null,content:'other writer'}})}),e=>e.code==='REVISION_BASE_CHANGED');
 await assert.rejects(assetRevisionApproval({...notesBase,precondition:base.precondition}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});
