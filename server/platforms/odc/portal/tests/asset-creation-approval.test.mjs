import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ASSET_CREATE,assetCreationApproval} from '../runtime/asset-creation-approval.mjs';
import {icon} from './asset-icon.test.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('empty asset approval binds body, tenant and name, requires complete absence and rejects revision/template writes',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-asset-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Synthetic test proposal');
 const body={assetCreationDetails:{assetName:'SSAMTest',assetType:'LowCodeLibrary'}},words='Synthetic authorization only',host='example.outsystems.dev';
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,
  source:{kind:'human-conversation',threadId:'00000000-0000-4000-8000-000000000001',messageId:'00000000-0000-4000-8000-000000000002',question:'Synthetic fixture'},
  proposal:{file:proposal,sha256:sha(fs.readFileSync(proposal))},constraints:{bodySha256:sha(JSON.stringify(body))},scope:[{lane:'odc',host,operation:ASSET_CREATE,targets:['SSAMTest']}]}));
 const base={file,words,host,operationId:ASSET_CREATE,input:{body},read:async query=>{assert.equal(query.nameContains,'SSAMTest');return {ok:true,data:{results:[],page:{totalResults:0}}};}};
 assert.deepEqual((await assetCreationApproval(base)).targets,['SSAMTest']);
 const withIcon=structuredClone(body);withIcon.assetCreationDetails.iconBase64=icon().toString('base64');
 await assert.rejects(assetCreationApproval({...base,input:{body:withIcon}}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 const record=JSON.parse(fs.readFileSync(file));record.constraints.bodySha256=sha(JSON.stringify(withIcon));fs.writeFileSync(file,JSON.stringify(record));
 assert.deepEqual((await assetCreationApproval({...base,input:{body:withIcon}})).targets,['SSAMTest']);
 record.constraints.bodySha256=sha(JSON.stringify(body));fs.writeFileSync(file,JSON.stringify(record));
 for(const override of [{host:'other.outsystems.dev'},{words:'Different authorization'},{operationId:'different'},
  {input:{body:{...body,commitMessage:'changed'}}},{input:{body:{...body,fileUri:'https://example.test/source'}}},
  {input:{body:{assetCreationDetails:{...body.assetCreationDetails,templateKey:'template'}}}}])
  await assert.rejects(assetCreationApproval({...base,...override}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 for(const data of [{results:[],page:{totalResults:1}},{results:[]},null])
  await assert.rejects(assetCreationApproval({...base,read:async()=>({ok:true,data})}),e=>e.code==='ASSET_INVENTORY_UNAVAILABLE');
 await assert.rejects(assetCreationApproval({...base,read:async()=>({ok:false})}),e=>e.code==='ASSET_INVENTORY_UNAVAILABLE');
 await assert.rejects(assetCreationApproval({...base,read:async()=>({ok:true,data:{results:[{name:'ssamtest'}],page:{totalResults:1}}})}),e=>e.code==='ASSET_ALREADY_EXISTS');
});

test('template creation binds exact body and verifies a matching live application template before absence',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-template-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Synthetic template proposal');
 const templateKey='00000000-0000-4000-8000-000000000003';
 const body={assetCreationDetails:{assetName:'SSAMTemplateProof',assetType:'Agent',templateKey}},words='Synthetic authorization only',host='example.outsystems.dev';
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,
  source:{kind:'human-conversation',threadId:'00000000-0000-4000-8000-000000000001',messageId:'00000000-0000-4000-8000-000000000002',question:'Synthetic fixture'},
  proposal:{file:proposal,sha256:sha(fs.readFileSync(proposal))},constraints:{bodySha256:sha(JSON.stringify(body))},scope:[{lane:'odc',host,operation:ASSET_CREATE,targets:['SSAMTemplateProof']}]}));
 let reads=0;
 const data={assetKey:templateKey,assetType:'Agent',templateType:'ApplicationTemplate'};
 const base={file,words,host,operationId:ASSET_CREATE,input:{body},
  readTemplate:async key=>{assert.equal(key,templateKey);return {ok:true,data};},
  read:async()=>{reads++;return {ok:true,data:{results:[],page:{totalResults:0}}};}};
 assert.deepEqual((await assetCreationApproval(base)).targets,['SSAMTemplateProof']);assert.equal(reads,1);
 for(const result of [{ok:false},{ok:true,data:null},{ok:true,data:{...data,assetKey:'different'}},
  {ok:true,data:{...data,assetType:'WebApplication'}},{ok:true,data:{...data,templateType:null}},
  {ok:true,data:{...data,templateType:'ScreenTemplateBundle'}}])
  await assert.rejects(assetCreationApproval({...base,readTemplate:async()=>result}),e=>e.code==='ASSET_TEMPLATE_UNAVAILABLE');
 await assert.rejects(assetCreationApproval({...base,readTemplate:undefined}),e=>e.code==='ASSET_TEMPLATE_UNAVAILABLE');
 assert.equal(reads,1);
 await assert.rejects(assetCreationApproval({...base,input:{body:{assetCreationDetails:{...body.assetCreationDetails,templateKey:'00000000-0000-4000-8000-000000000004'}}}}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 assert.equal(reads,1);
});
