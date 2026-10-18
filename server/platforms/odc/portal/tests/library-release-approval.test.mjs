import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {libraryPublicationApproval,LIBRARY_PUBLISH,libraryReleaseApproval,verifyLibraryRelease,LIBRARY_RELEASE} from '../runtime/library-release-approval.mjs';
test('native release requires the exact published own library revision and immutable proposal',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-proof-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Release fixture only');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 const host='test.outsystems.dev',words='Synthetic test authorization',assetKey=crypto.randomUUID(),publicationKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID();
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Release this own fixture'};
 const input={ApplicationKey:assetKey,Revision:2,Version:'1.0.0',ReleaseNotes:'Proof release'};
 const record={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},
  scope:[{lane:'odc',host,operation:LIBRARY_RELEASE,targets:['Proof']}],constraints:{originOperationUuid,publicationKey,expectedTag:null,inputSha256:hash(JSON.stringify(input))}};
 fs.writeFileSync(file,JSON.stringify(record));
 const origin={state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey},authorization:{source}};
 const revision={assetKey,revision:2,assetType:'LowCodeLibrary',tag:null,name:'Proof'};
 const pub={key:publicationKey,status:'Finished',assetKey,revision:2,operation:'Publish'};
 const read=async(id)=>({ok:true,data:id.includes('publish-operations')?pub:revision});
 const args={file,words,host,raw:{inputParameters:input},lookup:()=>origin,read};
 assert.equal((await libraryReleaseApproval(args)).operation,LIBRARY_RELEASE);
 const mobileRead=async id=>id.includes('publish-operations')?read(id):{ok:true,data:{...revision,assetType:'MobileLibrary'}};
 assert.equal((await libraryReleaseApproval({...args,read:mobileRead})).operation,LIBRARY_RELEASE);
 for(const change of [{status:'Running'},{assetKey:crypto.randomUUID()},{revision:1},{operation:'Deploy'},{key:crypto.randomUUID()}])
  await assert.rejects(libraryReleaseApproval({...args,read:async id=>id.includes('publish-operations')?{ok:true,data:{...pub,...change}}:read(id)}),e=>e.code==='LIBRARY_PUBLICATION_UNVERIFIED');
 for(const change of [{assetType:'WebApp'},{tag:'1.0.0'},{revision:1},{assetKey:crypto.randomUUID()}])
  await assert.rejects(libraryReleaseApproval({...args,read:async()=>({ok:true,data:{...revision,...change}})}));
 await assert.rejects(libraryReleaseApproval({...args,lookup:()=>({...origin,state:'uncertain'})}));
 await assert.rejects(libraryReleaseApproval({...args,raw:{inputParameters:{...input,Version:'2.0.0'}}}));
 await assert.rejects(libraryReleaseApproval({...args,raw:{inputParameters:input,screenVariables:{id:'foreign'}}}));
 const environmentKey=crypto.randomUUID(),body={operation:'Publish',assetKey,revision:2,environmentKey};
 const publicationApproval={...record,scope:[{lane:'odc',host,operation:LIBRARY_PUBLISH,targets:['Proof'],environmentKey}],constraints:{originOperationUuid,bodySha256:hash(JSON.stringify(body))}};
 fs.writeFileSync(file,JSON.stringify(publicationApproval));
 const publish={file,words,host,input:{body},originOperationUuid,lookup:()=>origin,read:async()=>({ok:true,data:revision})};
 assert.equal((await libraryPublicationApproval(publish)).operation,LIBRARY_PUBLISH);
 assert.equal((await libraryPublicationApproval({...publish,read:async()=>({ok:true,data:{...revision,assetType:'MobileLibrary'}})})).operation,LIBRARY_PUBLISH);
 const webPublish={...publish,read:async()=>({ok:true,data:{...revision,assetType:'WebApplication'}})};
 assert.equal((await libraryPublicationApproval(webPublish)).operation,LIBRARY_PUBLISH);
 const mobilePublish={...publish,read:async()=>({ok:true,data:{...revision,assetType:'MobileApplication'}})};
 assert.equal((await libraryPublicationApproval(mobilePublish)).operation,LIBRARY_PUBLISH);
 const agentPublish={...publish,read:async()=>({ok:true,data:{...revision,assetType:'Agent'}})};
 assert.equal((await libraryPublicationApproval(agentPublish)).operation,LIBRARY_PUBLISH);
 for(const change of [{state:'uncertain'},{response:{assetKey:crypto.randomUUID()}},{identity:{tenant:'other.outsystems.dev',operationId:'asset-repository-api-v1:post:/assets'}},{authorization:{source:{...source,messageId:crypto.randomUUID()}}}])
  await assert.rejects(libraryPublicationApproval({...agentPublish,lookup:()=>({...origin,...change})}));
 for(const change of [{revision:3},{environmentKey:crypto.randomUUID()},{operation:'Deploy'}])
  await assert.rejects(libraryPublicationApproval({...agentPublish,input:{body:{...body,...change}}}));
 await assert.rejects(libraryPublicationApproval({...mobilePublish,lookup:()=>({...origin,response:{assetKey:crypto.randomUUID()}})}));
 await assert.rejects(libraryPublicationApproval({...mobilePublish,input:{body:{...body,revision:3}}}));
 await assert.rejects(libraryPublicationApproval({...mobilePublish,input:{body:{...body,environmentKey:crypto.randomUUID()}}}));
 await assert.rejects(libraryPublicationApproval({...mobilePublish,read:async()=>({ok:true,data:{...revision,assetType:'ExternalLibrary'}})}));
 for(const change of [{state:'uncertain'},{response:{assetKey:crypto.randomUUID()}},{authorization:{source:{...source,messageId:crypto.randomUUID()}}}])
  await assert.rejects(libraryPublicationApproval({...webPublish,lookup:()=>({...origin,...change})}));
 await assert.rejects(libraryPublicationApproval({...webPublish,input:{body:{...body,environmentKey:crypto.randomUUID()}}}));
 await assert.rejects(libraryPublicationApproval({...webPublish,input:{body:{...body,revision:3}}}));
 for(const patch of [{revision:1},{environmentKey:crypto.randomUUID()},{operation:'Deploy'},{extra:true}])
  await assert.rejects(libraryPublicationApproval({...publish,input:{body:{...body,...patch}}}));
 await assert.rejects(libraryPublicationApproval({...publish,read:async()=>({ok:true,data:{...revision,assetType:'WebApp'}})}));
 fs.writeFileSync(file,JSON.stringify(record));
 fs.appendFileSync(proposal,'changed');await assert.rejects(libraryReleaseApproval(args));
});
test('release confirmation requires exact revision, tag and notes, not acceptance alone',async()=>{
 const input={ApplicationKey:crypto.randomUUID(),Revision:2,Version:'1.0.0',ReleaseNotes:'Proof'};
 const read=async id=>({ok:true,data:id.endsWith('release-notes')?{tag:input.Version,content:'Proof'}:{assetKey:input.ApplicationKey,revision:2,tag:input.Version}});
 assert.equal(await verifyLibraryRelease(input,read),true);
 assert.equal(await verifyLibraryRelease(input,async id=>id.endsWith('release-notes')?{ok:true,data:{tag:input.Version,content:'Other'}}:read(id)),false);
 assert.equal(await verifyLibraryRelease(input,async()=>({ok:false})),false);
});
test('an existing library (preExisting) is released only with explicit approval naming library and tenant, verified base and publication',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-existing-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Release the existing library Shared');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 const host='test.outsystems.dev',words='Synthetic test authorization',assetKey=crypto.randomUUID(),publicationKey=crypto.randomUUID();
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Release the existing library?'};
 const input={ApplicationKey:assetKey,Revision:7,Version:'2.1.0',ReleaseNotes:'Existing release'};
 const constraints={preExisting:true,publicationKey,expectedTag:null,inputSha256:hash(JSON.stringify(input))};
 const record=(scopeTargets,c=constraints)=>({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},
  scope:[{lane:'odc',host,operation:LIBRARY_RELEASE,targets:scopeTargets}],constraints:c});
 const revision={assetKey,revision:7,assetType:'LowCodeLibrary',tag:null,name:'Shared'};
 const pub={key:publicationKey,status:'Finished',assetKey,revision:7,operation:'Publish'};
 const read=async id=>({ok:true,data:id.includes('publish-operations')?pub:revision});
 const lookups=[];const args={file,words,host,raw:{inputParameters:input},lookup:id=>{lookups.push(id);return null;},read};
 fs.writeFileSync(file,JSON.stringify(record(['Shared',host])));
 const approved=await libraryReleaseApproval(args);
 assert.equal(approved.operation,LIBRARY_RELEASE);assert.equal(approved.preExisting,true);assert.deepEqual(approved.targets,['Shared',host]);
 assert.equal(approved.constraints.preExisting,true);assert.equal(lookups.length,0);
 // No context file, or a context that does not name the tenant / the library: refused before any send.
 await assert.rejects(libraryReleaseApproval({...args,file:undefined}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 fs.writeFileSync(file,JSON.stringify(record(['Shared'])));
 await assert.rejects(libraryReleaseApproval(args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 fs.writeFileSync(file,JSON.stringify(record([host])));
 await assert.rejects(libraryReleaseApproval(args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 // Other words than the recorded human ones, or other version than the approved input.
 fs.writeFileSync(file,JSON.stringify(record(['Shared',host])));
 await assert.rejects(libraryReleaseApproval({...args,words:'release it'}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 await assert.rejects(libraryReleaseApproval({...args,raw:{inputParameters:{...input,Version:'9.9.9'}}}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 // preExisting must be exactly true and exclusive with an origin receipt.
 fs.writeFileSync(file,JSON.stringify(record(['Shared',host],{...constraints,preExisting:'yes'})));
 await assert.rejects(libraryReleaseApproval(args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 fs.writeFileSync(file,JSON.stringify(record(['Shared',host])));
 // Unverified publication, tagged or non-current revision: refused.
 for(const change of [{status:'Failed'},{revision:6},{assetKey:crypto.randomUUID()}])
  await assert.rejects(libraryReleaseApproval({...args,read:async id=>id.includes('publish-operations')?{ok:true,data:{...pub,...change}}:read(id)}),e=>e.code==='LIBRARY_PUBLICATION_UNVERIFIED');
 await assert.rejects(libraryReleaseApproval({...args,read:async id=>id.includes('publish-operations')?{ok:false}:read(id)}),e=>e.code==='LIBRARY_PUBLICATION_UNVERIFIED');
 await assert.rejects(libraryReleaseApproval({...args,read:async id=>id.includes('publish-operations')?read(id):{ok:true,data:{...revision,tag:'2.0.0'}}}),e=>e.code==='LIBRARY_RELEASE_BASE_UNVERIFIED');
 await assert.rejects(libraryReleaseApproval({...args,read:async id=>id.includes('publish-operations')?read(id):id.includes('/revisions/')?{ok:true,data:revision}:{ok:true,data:{...revision,revision:8}}}),e=>e.code==='LIBRARY_RELEASE_BASE_UNVERIFIED');
 // Changed proposal after approval.
 fs.appendFileSync(proposal,'changed');await assert.rejects(libraryReleaseApproval(args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});
