import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {apiClientCreateInput,apiClientFixtureApproval,apiClientPrivateProof,API_CLIENT_CREATE,API_CLIENT_DELETE} from '../runtime/api-client-fixture.mjs';
import {rawInput} from '../runtime/portal-routes.mjs';
const now=Date.parse('2026-10-10T12:00:00Z'),id=crypto.randomUUID(),host='tenant.outsystems.dev',name='SSAMApiClientProof20261010';
const input=()=>rawInput({inputParameters:{OIDCClientCreate:{Name:name,Description:'Own fixture',SecretExpiresAt:'2026-10-11T12:00:00Z',IsActive:true,IsSendSecretExpiryEmail:false,Permissions:{List:[]}}}});
const proof=()=>({key:crypto.randomUUID(),name,operationUuid:id,vaultRef:'urn:ssam:api-client:'+id,vaultStored:true,rawValueExposed:false,responseProjected:true});
test('API client dates pass unchanged while inline secrets remain forbidden',()=>{
 assert.equal(apiClientCreateInput(input(),now).Name,name);
 assert.throws(()=>rawInput({inputParameters:{ClientSecret:'inline'}}),{code:'SECRET_IN_ARGUMENTS'});
 for(const change of [{Name:'ExistingClient'},{IsActive:false},{IsSendSecretExpiryEmail:true},{Permissions:{List:[{Key:crypto.randomUUID()}]}},
  {SecretExpiresAt:'2026-10-10T12:01:00Z'},{SecretExpiresAt:'2026-10-13T12:00:00Z'},{SecretExpiresAt:'invalid'},{Unexpected:'value'}]){
  const raw=input();Object.assign(raw.inputParameters.OIDCClientCreate,change);assert.throws(()=>apiClientCreateInput(raw,now),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 }
});
test('private proof discards all extra credential echoes and requires exact creation binding',()=>{
 const p=proof(),safe=apiClientPrivateProof({...p,Unexpected:'synthetic-secret',ClientSecret:'synthetic-secret'},{operationUuid:id,name});
 assert.deepEqual(safe,p);assert.equal(JSON.stringify(safe).includes('synthetic-secret'),false);
 for(const change of [{key:'invalid'},{name:'Other'},{operationUuid:crypto.randomUUID()},{vaultRef:'foreign'},{vaultStored:false},{rawValueExposed:true},{responseProjected:false}])
  assert.throws(()=>apiClientPrivateProof({...p,...change},{operationUuid:id,name}),e=>e.code==='UNCERTAIN'&&e.details.sent===true);
});
test('create and delete proposals bind exact input and same human grant to the original private proof',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'api-client-fixture-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Own API client only');
 const words='Synthetic fixture grant',source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Own fixture'};
 const record={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
  scope:[{lane:'odc',host,operation:API_CLIENT_CREATE,targets:[name]},{lane:'odc',host,operation:API_CLIENT_DELETE,targets:[name]}]};
 const save=raw=>fs.writeFileSync(file,JSON.stringify({...record,constraints:{creationOperationUuid:id,inputSha256:crypto.createHash('sha256').update(JSON.stringify(raw.inputParameters)).digest('hex')}}));
 const raw=input();save(raw);const args={file,words,host,operationId:API_CLIENT_CREATE,operationUuid:id,raw,now};
 const created=apiClientFixtureApproval(args);assert.equal(created.expected.name,name);
 assert.throws(()=>apiClientFixtureApproval({...args,operationUuid:crypto.randomUUID()}),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 const p=proof(),origin={operationUuid:id,state:'accepted',identity:{tenant:host,operationId:API_CLIENT_CREATE},authorization:created.approval,reconciliation:{apiClientFixture:created.expected},response:{ApiClientProof:p}};
 const deletion=rawInput({inputParameters:{Key:p.key}});save(deletion);
 const del={...args,operationId:API_CLIENT_DELETE,operationUuid:crypto.randomUUID(),raw:deletion,lookup:()=>origin};
 assert.equal(apiClientFixtureApproval(del).expected.key,p.key);
 assert.equal(apiClientFixtureApproval({...del,lookup:()=>({...origin,state:'confirmed'})}).expected.key,p.key);
 for(const changed of [{state:'uncertain'},{identity:{tenant:'other.outsystems.dev',operationId:API_CLIENT_CREATE}},{response:{ApiClientProof:{...p,key:crypto.randomUUID()}}},
  {authorization:{...origin.authorization,source:{...source,messageId:crypto.randomUUID()}}}])
  assert.throws(()=>apiClientFixtureApproval({...del,lookup:()=>({...origin,...changed})}));
});
