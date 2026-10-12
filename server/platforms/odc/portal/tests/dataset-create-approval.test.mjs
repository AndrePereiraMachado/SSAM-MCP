import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {datasetCreateApproval,DATASET_CREATE,datasetInputHash} from '../runtime/dataset-create-approval.mjs';
test('dataset creation binds exact content, portfolio, revision and observed eligible application',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dataset-create-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Own dataset, no execution');
 const host='tenant.outsystems.dev',words='Synthetic dataset creation grant',app=crypto.randomUUID(),portfolio=crypto.randomUUID();
 const d={Name:'DatasetProof',Description:'Synthetic',AgenticAppId:app,ServiceActionId:crypto.randomUUID(),Content:'{"testCases":[{"name":"Synthetic","inputs":{},"expectations":{}}]}',
  SetupAppId:'',SetupServiceActionId:'',TeardownAppId:'',TeardownServiceActionId:'',PortfolioKey:portfolio,AssetType:''};
 const p={OverrideBaseURL:'',Dataset:d,AdditionalApps:{List:[]}},raw={inputParameters:p};
 const approval={schema:'ssam-authorization-context/1',decision:'approved',words,
  source:{kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Dataset fixture creation'},
  proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
  scope:[{lane:'odc',host,operation:DATASET_CREATE,targets:[d.Name,'EligibleApp']}],
  constraints:{inputSha256:datasetInputHash(p),applicationKey:app,modelDigest:'digest',portfolioKey:portfolio}};
 fs.writeFileSync(file,JSON.stringify(approval));
 const asset={assetKey:app,portfolioKey:portfolio,assetType:'WebApplication',name:'EligibleApp',modelDigest:'digest'};
 const row={Key:app,Name:'EligibleApp',ModelDigest:'digest',AssetType:'WebApplication'};
 const args={file,words,host,raw,readAsset:async()=>({ok:true,data:asset}),readApps:async()=>({ok:true,data:{AgenticApps:{List:[row]}}})};
 assert.equal((await datasetCreateApproval(args)).operation,DATASET_CREATE);
 const legacyAgent={...args,readAsset:async()=>({ok:true,data:{...asset,assetType:'Agent'}}),readApps:async()=>({ok:true,data:{AgenticApps:{List:[{...row,AssetType:''}]}}})};
 assert.equal((await datasetCreateApproval(legacyAgent)).operation,DATASET_CREATE);
 await assert.rejects(datasetCreateApproval({...args,readApps:legacyAgent.readApps}),e=>e.code==='DATASET_APPLICATION_UNVERIFIED');
 await assert.rejects(datasetCreateApproval({...legacyAgent,readApps:async()=>({ok:true,data:{AgenticApps:{List:[{...row,AssetType:null}]}}})}),e=>e.code==='DATASET_APPLICATION_UNVERIFIED');
 for(const Content of ['not json','null','{}','[]','{"testCases":[]}','{"testCases":{}}']) {
  const changed={...p,Dataset:{...d,Content}};
  fs.writeFileSync(file,JSON.stringify({...approval,constraints:{...approval.constraints,inputSha256:datasetInputHash(changed)}}));
  let reads=0;
  await assert.rejects(datasetCreateApproval({...args,raw:{inputParameters:changed},readAsset:async()=>{reads++;return {ok:true,data:asset};}}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
  assert.equal(reads,0,'Invalid envelope must fail before asset or transport reads, even when explicitly authorized');
 }
 fs.writeFileSync(file,JSON.stringify(approval));
 for(const rows of [[],[row,row],[{...row,ModelDigest:'changed'}],[{...row,Name:'Different'}],[{...row,AssetType:'Agent'}]])
  await assert.rejects(datasetCreateApproval({...args,readApps:async()=>({ok:true,data:{AgenticApps:{List:rows}}})}),e=>e.code==='DATASET_APPLICATION_UNVERIFIED');
 for(const changed of [{...p,OverrideBaseURL:'https://other.test'}, {...p,Dataset:{...d,Content:'changed'}},
  {...p,Dataset:{...d,AssetType:'WebApplication'}}, {...p,Dataset:{...d,ServiceActionId:''}}, {...p,Dataset:{...d,Content:''}}, {...p,Dataset:{...d,SetupAppId:app}}, {...p,AdditionalApps:{List:[{}]}}])
  await assert.rejects(datasetCreateApproval({...args,raw:{inputParameters:changed}}));
 await assert.rejects(datasetCreateApproval({...args,readAsset:async()=>({ok:true,data:{...asset,portfolioKey:crypto.randomUUID()}})}));
});
