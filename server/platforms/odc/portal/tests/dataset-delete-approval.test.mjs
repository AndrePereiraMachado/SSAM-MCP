import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {datasetDeleteApproval,DATASET_DELETE,datasetStateHash} from '../runtime/dataset-delete-approval.mjs';
test('dataset cleanup binds ownership, current state and verified empty dependencies',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dataset-delete-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const id=crypto.randomUUID(),originId=crypto.randomUUID(),host='fixture.outsystems.dev',words='Synthetic test grant';
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Delete own fixture'};
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Delete own dataset');
 const dataset={DatasetId:id,Name:'OwnDataset',Description:'original'};
 const origin={state:'accepted',identity:{tenant:host,operationId:'agents.datasetCreate'},response:{DatasetId:id},authorization:{source}};
 const approval={schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
  scope:[{lane:'odc',host,operation:DATASET_DELETE,targets:[dataset.Name]}],
  constraints:{originOperationUuid:originId,datasetId:id,expectedDatasetSha256:datasetStateHash(dataset)}};
 fs.writeFileSync(file,JSON.stringify(approval));
 const raw={inputParameters:{DatasetId:id},screenVariables:{},clientVariables:{}};
 const read=async(op,vars)=>op==='agents.dataset'?{ok:true,data:{Dataset:dataset,NotFound:false}}:{ok:true,data:{HasConnectedEvaluations:false},dependencyState:{verified:true,datasetId:id,hasConnectedEvaluations:false}};
 const args={file,words,host,raw,lookup:key=>key===originId?origin:null,read};
 assert.equal((await datasetDeleteApproval(args)).operation,DATASET_DELETE);
 for(const changes of [{state:'uncertain'},{response:{DatasetId:crypto.randomUUID()}},{identity:{...origin.identity,tenant:'foreign.test'}},
  {authorization:{source:{...source,messageId:crypto.randomUUID()}}}])
  await assert.rejects(datasetDeleteApproval({...args,lookup:()=>({...origin,...changes})}));
 await assert.rejects(datasetDeleteApproval({...args,read:async(op,vars)=>op==='agents.dataset'?read(op,vars):{ok:true,data:{HasConnectedEvaluations:false}}}),e=>e.code==='DATASET_DEPENDENCIES_UNVERIFIED');
 for(const flag of [true,undefined,'false'])await assert.rejects(datasetDeleteApproval({...args,read:async(op,vars)=>
  op==='agents.dataset'?read(op,vars):{ok:true,data:{HasConnectedEvaluations:flag}}}),e=>e.code==='DATASET_DEPENDENCIES_UNVERIFIED');
 await assert.rejects(datasetDeleteApproval({...args,read:async()=>({ok:true,data:{NotFound:true,Dataset:dataset}})}));
 await assert.rejects(datasetDeleteApproval({...args,raw:{...raw,inputParameters:{DatasetId:id,Other:true}}}));
 dataset.Description='changed';await assert.rejects(datasetDeleteApproval(args));
});
