import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {apiClientWriteApproval} from '../runtime/api-client-pending-cleanup.mjs';
import {sha256} from '../runtime/write-journal.mjs';
const uuid=()=>crypto.randomUUID(),host='tenant.outsystems.dev',name='SSAMApiClientProof20261010';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'api-client-pending-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),baselineFile=path.join(dir,'baseline.json'),proposal=path.join(dir,'proposal.md');
 fs.writeFileSync(proposal,'Delete only the partial header; no secret capture assertion.');
 const key=uuid(),creationOperationUuid=uuid(),source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own fixtures'},words='Synthetic own fixtures grant';
 const old={Key:uuid(),Name:'Existing',IsActive:false,Permissions:{List:[]}},header={Key:key,Name:name,IsActive:false,Permissions:{List:[]},CreatedAt:'1900-01-01T00:00:00'};
 const inventory=rows=>({ok:true,tenant:host,rows,totalResults:rows.length,requestedOffset:0,scope:{NameContains:'',Status:''},complete:true,requestedPageConsistencyVerified:true});
 const baseline=inventory([old]);fs.writeFileSync(baselineFile,JSON.stringify(baseline));
 const raw={inputParameters:{Key:key},screenVariables:{},clientVariables:{}};
 const context={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:sha256(fs.readFileSync(proposal,'utf8'))},
  scope:[{lane:'odc',host,operation:'apiClients.delete',targets:[name]}],constraints:{cleanupMode:'pending-header',creationOperationUuid,baselineFile,baselineSha256:sha256(fs.readFileSync(baselineFile,'utf8')),inputSha256:sha256(JSON.stringify(raw.inputParameters))}};
 fs.writeFileSync(file,JSON.stringify(context));
 const origin={schema:'ssam-odc-write/1',operationUuid:creationOperationUuid,state:'uncertain',createdAt:'2026-10-10T12:00:00Z',updatedAt:'2026-10-10T12:00:03Z',identity:{tenant:host,operationId:'apiClients.create',target:{apiClientFixtureName:name}},
  authorization:{wordsSha256:sha256(words),source},reconciliation:{apiClientFixture:{name}},response:{}};
 const current=inventory([old,header]),client={...header,IsActive:true,CreatedAt:'2026-10-10T12:00:01Z',Permissions:{List:[]}},detail={ok:true,tenant:host,data:{ApiClientDetails:client}};
 return {dir,file,context,baselineFile,baseline,old,header,current,origin,client,detail,args:{file,words,host,operationId:'apiClients.delete',operationUuid:uuid(),raw,lookup:()=>origin,readInventory:async()=>current,readDetail:async()=>detail}};
}
test('pending-header cleanup binds live new identity without asserting private capture',async t=>{
 const f=fixture(t),r=await apiClientWriteApproval(f.args);assert.equal(r.expected.key,f.header.Key);assert.equal(r.expected.privateCaptureProven,false);
 assert.equal(r.expected.cleanupMode,'pending-header');assert.equal('vaultStored' in r.expected,false);
});
for(const [label,change] of Object.entries({
 'detail state drift':f=>f.client.IsActive=false,
 'permission granted in actual detail':f=>f.client.Permissions.List.push({Key:uuid()}),
 'detail missing':f=>f.detail.ok=false,
 'detail foreign tenant':f=>f.detail.tenant='foreign.outsystems.dev',
 'detail foreign key':f=>f.client.Key=uuid(),
 'detail foreign name':f=>f.client.Name='Other',
 'detail sentinel date':f=>f.client.CreatedAt='1900-01-01T00:00:00',
 'detail date before receipt':f=>f.client.CreatedAt='2026-10-10T11:59:59Z',
 'detail date after receipt':f=>f.client.CreatedAt='2026-10-10T12:00:04Z',
 'other header':f=>f.header.Key=uuid(),
 'name mismatch':f=>f.header.Name='Another',
 'other baseline row modified':f=>f.current.rows[0]={...f.old,Name:'Changed'},
 'duplicate added key':f=>f.current.rows[0]={...f.old,Key:f.header.Key},
 'incomplete inventory':f=>f.current.complete=false,
 'filtered inventory':f=>f.current.scope.Status='Active',
 'unverified pagination':f=>f.current.requestedPageConsistencyVerified=false,
 'foreign tenant':f=>f.current.tenant='foreign.outsystems.dev',
 'creation not uncertain':f=>f.origin.state='accepted',
 'other creation target':f=>f.origin.identity.target.apiClientFixtureName='Another',
 'other human source':f=>f.origin.authorization.source={...f.origin.authorization.source,messageId:uuid()},
 'other human words':f=>f.origin.authorization.wordsSha256=sha256('other'),
 'private proof present':f=>f.origin.response.ApiClientProof={},
 'baseline bytes changed':f=>fs.appendFileSync(f.baselineFile,' '),
 'changed proposal':f=>fs.appendFileSync(f.context.proposal.file,' changed'),
 'other delete input':f=>f.args.raw.inputParameters.Key=uuid(),
 'extra delete input':f=>f.args.raw.inputParameters.Other=true,
 'baseline name existed':f=>{f.baseline.rows[0].Name=name;fs.writeFileSync(f.baselineFile,JSON.stringify(f.baseline));f.context.constraints.baselineSha256=sha256(fs.readFileSync(f.baselineFile,'utf8'));fs.writeFileSync(f.file,JSON.stringify(f.context));},
 'additional new client':f=>{f.current.rows.push({...f.header,Key:uuid(),Name:'Extra'});f.current.totalResults++;}
}))test('pending-header cleanup refuses '+label,async t=>{const f=fixture(t);change(f);await assert.rejects(()=>apiClientWriteApproval(f.args),{code:'AUTHORIZATION_CONTEXT_INVALID'});});
