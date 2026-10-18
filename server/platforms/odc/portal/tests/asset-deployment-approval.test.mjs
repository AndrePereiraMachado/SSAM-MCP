import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {ASSET_DEPLOYMENT,assetDeploymentApproval} from '../runtime/asset-deployment-approval.mjs';
test('deployment binds owned creation, exact finished build and approved environment; undeploy binds deployed revision',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-deployment-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Deploy and undeploy own empty fixture.');
 const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),host='test.outsystems.dev',words='Synthetic authorization';
 const assetKey=crypto.randomUUID(),environmentKey=crypto.randomUUID(),buildKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID();
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Deploy and remove this own fixture'};
 const origin={state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey},authorization:{source}};
 const body={operation:'Deploy',assetKey,revision:2,environmentKey,buildKey};
 const approve=body=>fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:sha(fs.readFileSync(proposal))},scope:[{lane:'odc',host,operation:ASSET_DEPLOYMENT,targets:['Proof'],environmentKey}],
  constraints:{originOperationUuid,bodySha256:sha(JSON.stringify(body))}}));
 const revision={assetKey,revision:2,name:'Proof'},build={assetKey,assetRevision:2,buildKey,status:'Finished',buildType:'Release'};
 const read=async id=>({ok:true,data:id.startsWith('build-')?build:id.startsWith('asset-configurations')?{revisionBaseline:2,revisionDeployed:2}:revision});
 const args={file,words,host,input:{body},originOperationUuid,lookup:()=>origin,read};approve(body);
 assert.equal((await assetDeploymentApproval(args)).operation,ASSET_DEPLOYMENT);
 for(const patch of [{status:'Running'},{buildKey:crypto.randomUUID()},{assetKey:crypto.randomUUID()},{assetRevision:3}])
  await assert.rejects(assetDeploymentApproval({...args,read:async id=>id.startsWith('build-')?{ok:true,data:{...build,...patch}}:read(id)}),e=>e.code==='DEPLOYMENT_BUILD_UNVERIFIED');
 for(const patch of [{environmentKey:crypto.randomUUID()},{revision:3},{buildKey:crypto.randomUUID()},{operation:'ApplyConfigs'},{extra:true}])
  await assert.rejects(assetDeploymentApproval({...args,input:{body:{...body,...patch}}}));
 for(const patch of [{state:'uncertain'},{response:{assetKey:crypto.randomUUID()}},{identity:{tenant:'foreign',operationId:origin.identity.operationId}},{authorization:{source:{...source,messageId:crypto.randomUUID()}}}])
  await assert.rejects(assetDeploymentApproval({...args,lookup:()=>({...origin,...patch})}));
 const removal={operation:'Undeploy',assetKey,revision:2,environmentKey};approve(removal);
 const undeploy={...args,input:{body:removal}};assert.equal((await assetDeploymentApproval(undeploy)).operation,ASSET_DEPLOYMENT);
 for(const config of [{revisionBaseline:3,revisionDeployed:2},{revisionBaseline:2,revisionDeployed:3},{}])
  await assert.rejects(assetDeploymentApproval({...undeploy,read:async id=>id.startsWith('asset-configurations')?{ok:true,data:config}:read(id)}),e=>e.code==='DEPLOYMENT_REVISION_CHANGED');
 fs.appendFileSync(proposal,'drift');await assert.rejects(assetDeploymentApproval(undeploy));
});
