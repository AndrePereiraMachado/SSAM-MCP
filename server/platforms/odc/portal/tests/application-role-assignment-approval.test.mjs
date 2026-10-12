import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {applicationRoleAssignmentApproval,applicationRoleAssignmentObservation,APPLICATION_ROLE_GRANT,APPLICATION_ROLE_REVOKE} from '../runtime/application-role-assignment-approval.mjs';
import {ASSET_CREATE} from '../runtime/asset-creation-approval.mjs';import {USER_CREATE} from '../runtime/inactive-user-approval.mjs';
import {OdcAccess} from '../runtime/access.mjs';import {Catalog} from '../runtime/catalog.mjs';import {WriteJournal} from '../runtime/write-journal.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'application-role-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Synthetic own application-role proof');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),host='example.outsystems.dev',words='Synthetic app and user role assignment';
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Synthetic proof'};
 const assetKey=crypto.randomUUID(),environmentKey=crypto.randomUUID(),roleKey=crypto.randomUUID(),key=crypto.randomUUID(),originOperationUuid=crypto.randomUUID(),userOriginOperationUuid=crypto.randomUUID();
 const page=results=>({results,page:{totalResults:results.length,limit:100,offset:0,nextPageOffset:null}});
 const role={key:roleKey,name:'OwnRole',assetKey,environmentKey,portfolioKey:crypto.randomUUID(),externalKey:crypto.randomUUID(),claim:null};
 const user={key,name:'OwnUser',email:'proof@ssam-proof.invalid',isActive:false,lastLoginAt:null,access:{hasOrganizationRoles:false,hasApplicationRoles:false}};
 const state={app:{assetKey,name:'OwnApp',assetType:'WebApplication'},role:page([role]),user,groups:page([]),'organization-roles':page([]),assignedRoles:page([]),roleUsers:page([])};
 const originals=new Map([[originOperationUuid,{state:'accepted',identity:{tenant:host,operationId:ASSET_CREATE,target:{name:'OwnApp'}},response:{assetKey},authorization:{source}}],
  [userOriginOperationUuid,{state:'accepted',identity:{tenant:host,operationId:USER_CREATE,target:{name:user.name,email:user.email,isActive:false,addToBuiltInIdentityProvider:false}},response:{key},authorization:{source}}]]);
 const labels={'asset-repository-api-v1:get:/assets/{assetKey}':'app','get:/application-roles':'role','get:/users/{key}':'user','get:/users/{key}/groups':'groups','get:/users/{key}/organization-roles':'organization-roles','get:/users/{key}/application-roles':'assignedRoles','get:/application-roles/{key}/users':'roleUsers'};
 let reads=0;
 const args=(operationId=APPLICATION_ROLE_GRANT)=>{
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},
   scope:[{lane:'odc',host,operation:operationId,environmentKey,targets:['OwnApp','OwnRole','OwnUser']}],
   constraints:{bodySha256:hash('null'),originOperationUuid,userOriginOperationUuid,assetKey,roleKey,environmentKey,expectedConfigurationSha256:hash(JSON.stringify(state))}}));
  return{file,words,host,operationId,input:{path:{key,roleKey}},originOperationUuid,userOriginOperationUuid,lookup:id=>originals.get(id),read:async id=>{reads++;return{ok:true,data:state[labels[id.replace('user-access-management-api-v1:','')]]};}};
 };
 const assign=()=>{user.access.hasApplicationRoles=true;state.assignedRoles=page([{...role,isDirectlyAssigned:true,assignedGroups:[]}]);state.roleUsers=page([{key,name:user.name,email:user.email,status:'Inactive',lastLoginAt:null}]);};
 return{state,originals,role,user,args,assign,page,key,assetKey,environmentKey,roleKey,originOperationUuid,userOriginOperationUuid,reads:()=>reads};
}

test('grant and revoke bind the own app, inactive user, exact role and stage',async t=>{
 const f=fixture(t);assert.deepEqual((await applicationRoleAssignmentApproval(f.args())).targets,['OwnApp','OwnRole','OwnUser']);
 f.assign();assert.deepEqual((await applicationRoleAssignmentApproval(f.args(APPLICATION_ROLE_REVOKE))).targets,['OwnApp','OwnRole','OwnUser']);
 await assert.rejects(applicationRoleAssignmentApproval(f.args()),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});
for(const [name,change]of [
 ['foreign asset',f=>{f.role.assetKey=crypto.randomUUID();}],['different stage',f=>{f.role.environmentKey=crypto.randomUUID();}],
 ['active user',f=>{f.user.isActive=true;}],['logged-in user',f=>{f.user.lastLoginAt='2026-10-10T00:00:00Z';}],
 ['different email',f=>{f.user.email='other@ssam-proof.invalid';}],['renamed user',f=>{f.user.name='Other';}],
 ['group membership',f=>{f.state.groups=f.page([{key:crypto.randomUUID()}]);}],['organization role',f=>{f.state['organization-roles']=f.page([{key:crypto.randomUUID()}]);}],
 ['incomplete role page',f=>{f.state.role.page.totalResults=2;}],['duplicate role',f=>{f.state.role=f.page([f.role,f.role]);}],
 ['unowned app',f=>{f.originals.delete(f.originOperationUuid);}],['unowned user',f=>{f.originals.delete(f.userOriginOperationUuid);}],
 ['rejected creation',f=>{f.originals.get(f.originOperationUuid).state='rejected';}],
 ['other grant source',f=>{f.originals.get(f.userOriginOperationUuid).authorization={source:{threadId:crypto.randomUUID(),messageId:crypto.randomUUID()}};}]
])test('refuses '+name+' even with approval for the observed snapshot',async t=>{
 const f=fixture(t);change(f);await assert.rejects(applicationRoleAssignmentApproval(f.args()),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});
for(const [name,change]of [['indirect role',f=>{f.state.assignedRoles.results[0].isDirectlyAssigned=false;}],['inherited group',f=>{f.state.assignedRoles.results[0].assignedGroups=[{key:crypto.randomUUID()}];}],['another user',f=>{f.state.roleUsers.results[0].key=crypto.randomUUID();}],['active role user',f=>{f.state.roleUsers.results[0].status='Active';}]])test('revocation refuses '+name,async t=>{
 const f=fixture(t);f.assign();change(f);await assert.rejects(applicationRoleAssignmentApproval(f.args(APPLICATION_ROLE_REVOKE)),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});
test('extra body or query is refused before any remote preflight read',async t=>{
 const f=fixture(t);
 for(const input of [{path:{key:f.key,roleKey:f.roleKey},body:{}},{path:{key:f.key,roleKey:f.roleKey},query:{environmentKey:f.environmentKey}}])
  await assert.rejects(applicationRoleAssignmentApproval({...f.args(),input}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 assert.equal(f.reads(),0);
});
test('configuration drift after approval refuses before a protected send',async t=>{
 const f=fixture(t),args=f.args();f.role.claim='Changed';await assert.rejects(applicationRoleAssignmentApproval(args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});

test('documented null assignedGroups is empty, while missing group evidence refuses',async t=>{
 const f=fixture(t);f.assign();f.state.assignedRoles.results[0].assignedGroups=null;
 assert.ok(await applicationRoleAssignmentApproval(f.args(APPLICATION_ROLE_REVOKE)));
 delete f.state.assignedRoles.results[0].assignedGroups;
 await assert.rejects(applicationRoleAssignmentApproval(f.args(APPLICATION_ROLE_REVOKE)),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});

test('readback verifies both association directions and preserves functional-access limits',async t=>{
 const f=fixture(t),grant=await applicationRoleAssignmentApproval(f.args());
 assert.equal((await applicationRoleAssignmentObservation(grant.applicationRoleExpectation,f.args().read)).verified,false);
 f.assign();let r=await applicationRoleAssignmentObservation(grant.applicationRoleExpectation,f.args().read);
 assert.equal(r.verified,true);assert.equal(r.functionalAccessVerified,false);assert.equal(r.verificationScope,'administrative-association');
 const revoke=await applicationRoleAssignmentApproval(f.args(APPLICATION_ROLE_REVOKE));
 assert.equal((await applicationRoleAssignmentObservation(revoke.applicationRoleExpectation,f.args().read)).verified,false);
 f.state.assignedRoles=f.page([]);f.state.roleUsers=f.page([]);f.user.access.hasApplicationRoles=false;
 assert.equal((await applicationRoleAssignmentObservation(revoke.applicationRoleExpectation,f.args().read)).verified,true);
 f.state.role.page.totalResults=2;
 assert.equal((await applicationRoleAssignmentObservation(revoke.applicationRoleExpectation,f.args().read)).reason,'incomplete-inventory');
 assert.equal((await applicationRoleAssignmentObservation(revoke.applicationRoleExpectation,async()=>({ok:false}))).reason,'read-unavailable');
});

test('readback requires the derived role flag and preserves other profile fields',async t=>{
 const f=fixture(t),a=f.args(),grant=await applicationRoleAssignmentApproval(a);f.assign();
 assert.equal((await applicationRoleAssignmentObservation(grant.applicationRoleExpectation,a.read)).verified,true);
 f.user.access.hasApplicationRoles=false;
 assert.equal((await applicationRoleAssignmentObservation(grant.applicationRoleExpectation,a.read)).reason,'identity-drift');
 f.user.access.hasApplicationRoles=true;f.user.access.hasOrganizationRoles=true;
 assert.equal((await applicationRoleAssignmentObservation(grant.applicationRoleExpectation,a.read)).reason,'identity-drift');
});

for(const lost of [false,true])test('access reconciles application-role grant without replay; lost response='+lost,async t=>{
 const f=fixture(t),a=f.args(),receipts=new WriteJournal(path.join(path.dirname(a.file),'receipts'));
 const originalLookup=receipts.lookup.bind(receipts);receipts.lookup=(id,identity)=>f.originals.get(id)??originalLookup(id,identity);
 const access=new OdcAccess({catalog:new Catalog(),receipts});
 access.resolvePublic=async()=>({path:'vault'});
 let sends=0,visible=true;
 access.read=async({operationId})=>visible?a.read(operationId):{ok:false};
 access.send=async(_host,_resolved,id,_input,mode)=>{
  if(!mode.write)return a.read(id);
  sends++;f.assign();if(lost){visible=false;throw new Error('Response lost after send');}
  return{ok:true,status:204};
 };
 const args={tenant:a.host,confirmTenant:a.host,auth:'api-client',operationId:a.operationId,...a.input,authorize:a.words,operationUuid:crypto.randomUUID()};
 const options={applicationRoleAssignmentContext:a.file,originOperationUuid:f.originOperationUuid,userOriginOperationUuid:f.userOriginOperationUuid};
 let result=await access.write(args,options);
 assert.equal(sends,1,JSON.stringify(result));assert.equal(result.receipt?.state,lost?'uncertain':'confirmed',JSON.stringify(result));
 if(lost){
  const invalid=await access.write({...args,authorize:'Different authorization'},options);
  assert.equal(invalid.error?.code,'AUTHORIZATION_CONTEXT_INVALID');assert.equal(sends,1);
  visible=true;result=await access.write(args,options);
  assert.equal(result.receipt?.state,'confirmed',JSON.stringify(result));assert.equal(result.readBack?.verified,true);
 }
 assert.equal(result.ok,true);assert.equal(result.readBack?.functionalAccessVerified,false);
 const again=await access.write(args,options);assert.equal(again.receipt?.state,'confirmed');assert.equal(sends,1);
});
