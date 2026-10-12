import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {assetBuildApproval,generatedCodeApproval,ASSET_BUILD,GENERATED_CODE} from '../runtime/asset-build-approval.mjs';
import {ASSET_CREATE} from '../runtime/asset-creation-approval.mjs';
test('build approval binds revision and type to a creation by the same human grant',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'build-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Synthetic build test');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),host='example.outsystems.dev',words='Synthetic grant';
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Synthetic build'};
 const body={assetKey:crypto.randomUUID(),assetRevision:2,buildType:'Release'},originOperationUuid=crypto.randomUUID();
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host,operation:ASSET_BUILD,targets:['Fixture']}],
  constraints:{bodySha256:hash(JSON.stringify(body)),originOperationUuid}}));
 const origin={state:'accepted',identity:{tenant:host,operationId:ASSET_CREATE},response:{assetKey:body.assetKey},authorization:{source}};
 const base={file,words,host,operationId:ASSET_BUILD,input:{body},originOperationUuid,lookup:()=>origin,
  read:async()=>({ok:true,data:{assetKey:body.assetKey,revision:2,name:'Fixture'}})};
 assert.deepEqual((await assetBuildApproval(base)).targets,['Fixture']);
 for(const override of [{lookup:()=>({...origin,state:'uncertain'})},{lookup:()=>({...origin,response:{assetKey:crypto.randomUUID()}})},
  {input:{body:{...body,buildType:'Debug'}}},{operationId:'different'}, {host:'different.test'}])
  await assert.rejects(assetBuildApproval({...base,...override}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 await assert.rejects(assetBuildApproval({...base,read:async()=>({ok:true,data:{assetKey:body.assetKey,revision:1,name:'Fixture'}})}),e=>e.code==='BUILD_REVISION_UNAVAILABLE');
 const buildKey=crypto.randomUUID(),buildReceipt={state:'confirmed',identity:{tenant:host,operationId:ASSET_BUILD,target:body},response:{buildKey},authorization:{source}};
 const approval=JSON.parse(fs.readFileSync(file,'utf8'));approval.scope=[{lane:'odc',host,operation:GENERATED_CODE,targets:[buildKey]}];
 approval.constraints={originOperationUuid,...body};fs.writeFileSync(file,JSON.stringify(approval));
 const generated={file,words,host,operationId:GENERATED_CODE,input:{path:{operationKey:buildKey}},originOperationUuid,
  lookup:()=>buildReceipt,read:async()=>({ok:true,data:{...body,buildKey,status:'Finished'}})};
 assert.deepEqual((await generatedCodeApproval(generated)).targets,[buildKey]);
 await assert.rejects(generatedCodeApproval({...generated,lookup:()=>({...buildReceipt,state:'accepted'})}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 await assert.rejects(generatedCodeApproval({...generated,read:async()=>({ok:true,data:{...body,buildKey,status:'Running'}})}),e=>e.code==='BUILD_NOT_VERIFIED');
});
