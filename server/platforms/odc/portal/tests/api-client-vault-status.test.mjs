import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {apiClientVaultStatus} from '../runtime/api-client-vault-status.mjs';
import {windowsApiClientFixtureStatus,apiClientPowerShell,apiClientCredentialHelper} from '../runtime/api-client-credential.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const uuid=()=>crypto.randomUUID(),run=promisify(execFile);
function fixture(t){
 const writesDir=fs.mkdtempSync(path.join(os.tmpdir(),'api-client-status-'));t.after(()=>fs.rmSync(writesDir,{recursive:true,force:true}));
 const id=uuid(),host='tenant.outsystems.dev',name='SSAMApiClientProof20261010',hash='a'.repeat(64),session={host,user:'user@example.test',loggedIn:true};
 const origin={schema:'ssam-odc-write/1',operationUuid:id,state:'uncertain',identity:{tenant:host,operationId:'apiClients.create',target:{apiClientFixtureName:name}},
  authorization:{source:{threadId:uuid(),messageId:uuid()},wordsSha256:hash},reconciliation:{apiClientFixture:{name}}};
 const native={operationUuid:id,operationId:'apiClients.create',host,user:session.user,authorizeSha256:hash,source:'private-session-pipe',path:'/usersaccess/screenservices/usersaccess/APIClients/apiclient/ActionAPIClients_Create'};
 const file=path.join(writesDir,id+'.json');fs.writeFileSync(file,JSON.stringify(native));let probes=0;
 const result={available:false,operationUuid:id,target:'SSAM/ODC3/'+host+'/APIClientFixture/'+id};
 const args={host,input:{creationOperationUuid:id},lookup:()=>origin,writesDir,session,probe:async(h,x)=>{probes++;assert.equal(h,host);assert.equal(x,id);return {...result,Unexpected:'synthetic-secret'};}};
 return {args,origin,native,file,result,probes:()=>probes};
}
for(const exists of [false,true])test('fixture status observes exact UUID destination without exposing private values: '+exists,async t=>{
 const f=fixture(t);f.result.available=exists;const r=await apiClientVaultStatus(f.args);
 assert.equal(r.credentialPresent,exists);assert.equal(r.credentialAbsenceVerified,!exists);assert.equal(r.captureVerified,false);assert.equal(r.remoteDeletionVerified,false);
 assert.equal(JSON.stringify(r).includes('synthetic-secret'),false);assert.equal(f.probes(),1);
});
for(const [label,change] of Object.entries({
 'missing receipt':f=>f.args.lookup=()=>null,
 'nonfixture target':f=>f.origin.identity.target.apiClientFixtureName='ExistingClient',
 'foreign tenant':f=>f.origin.identity.tenant='foreign.outsystems.dev',
 'wrong operation':f=>f.origin.identity.operationId='apiClients.delete',
 'missing human source':f=>f.origin.authorization.source=null,
 'invalid human source UUID':f=>f.origin.authorization.source.messageId='invalid',
 'unregistered UUID':f=>f.args.input.creationOperationUuid=uuid(),
 'extra input':f=>f.args.input.target='arbitrary',
 'missing native reservation':f=>fs.unlinkSync(f.file),
 'changed native words':f=>f.native.authorizeSha256='b'.repeat(64),
 'changed native principal':f=>f.native.user='other@example.test',
 'changed native operation':f=>f.native.operationId='apiClients.delete',
 'changed native path':f=>f.native.path='/other',
 'changed native source':f=>f.native.source='foreign',
 'unauthenticated studio':f=>f.args.session.loggedIn=false,
 'foreign studio':f=>f.args.session.host='foreign.outsystems.dev'
}))test('fixture status refuses '+label+' before vault probe',async t=>{
 const f=fixture(t);change(f);if(fs.existsSync(f.file))fs.writeFileSync(f.file,JSON.stringify(f.native));
 await assert.rejects(()=>apiClientVaultStatus(f.args),{code:'API_CLIENT_VAULT_SCOPE_UNVERIFIED'});assert.equal(f.probes(),0);
});
test('fixture status rejects default destination absence as proof of fixture absence',async t=>{
 const f=fixture(t);f.result.target='SSAM/ODC3/'+f.args.host+'/APIClient';
 await assert.rejects(()=>apiClientVaultStatus(f.args),{code:'API_CLIENT_VAULT_SCOPE_UNVERIFIED'});
});
test('Windows helper status verifies a unique absent synthetic fixture and forbids read or bootstrap', {skip:process.platform!=='win32'},async()=>{
 const host='ssam-status-proof.invalid',id=uuid();assert.deepEqual(await windowsApiClientFixtureStatus(host,id),{available:false,target:'SSAM/ODC3/'+host+'/APIClientFixture/'+id,operationUuid:id});
 for(const mode of ['read','bootstrap'])await assert.rejects(()=>run(apiClientPowerShell,['-NoProfile','-NonInteractive','-File',apiClientCredentialHelper,'-Mode',mode,'-Origin','https://'+host,'-FixtureOperationUuid',id],{windowsHide:true,timeout:10000}),e=>e.code!==0&&e.stdout==='');
});
