import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {GROUP_ROLE_ASSIGNMENT,groupRoleAssignmentApproval,groupRoleAssignmentObservation} from '../runtime/group-role-assignment-approval.mjs';
import {ASSET_CREATE} from '../runtime/asset-creation-approval.mjs';import {GROUP_CREATE} from '../runtime/group-approval.mjs';import {USER_CREATE} from '../runtime/inactive-user-approval.mjs';
import {OdcAccess} from '../runtime/access.mjs';import {Catalog} from '../runtime/catalog.mjs';import {WriteJournal} from '../runtime/write-journal.mjs';
import {ownedGroupRoleFixture as fixture} from './owned-role-fixture.mjs';

test('group role grant and removal bind three own fixtures and exact inherited membership',async t=>{
 const f=fixture(t);assert.deepEqual((await groupRoleAssignmentApproval(f.args())).targets,['OwnApp','OwnRole','OwnGroup','OwnUser']);
 f.assign();assert.ok(await groupRoleAssignmentApproval(f.args(false)));
 await assert.rejects(groupRoleAssignmentApproval(f.args()),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});
for(const [name,change]of [
 ['foreign app',f=>{f.role.assetKey=crypto.randomUUID();}],['foreign role',f=>{f.role.key=crypto.randomUUID();}],['other stage',f=>{f.group.environmentKey=crypto.randomUUID();}],
 ['other portfolio',f=>{f.group.portfolioKey=crypto.randomUUID();}],['missing app origin',f=>{f.origins.delete(f.originOperationUuid);}],['missing group origin',f=>{f.origins.delete(f.groupOriginOperationUuid);}],
 ['missing user origin',f=>{f.origins.delete(f.userOriginOperationUuid);}],['rejected group creation',f=>{f.origins.get(f.groupOriginOperationUuid).state='rejected';}],
 ['foreign grant source',f=>{f.origins.get(f.groupOriginOperationUuid).authorization.source={threadId:crypto.randomUUID(),messageId:crypto.randomUUID()};}],
 ['identity provider mapping',f=>{f.group.groupIdpClaimMappings=[{key:crypto.randomUUID()}];}],['missing mappings evidence',f=>{delete f.group.groupIdpClaimMappings;}],
 ['active user',f=>{f.user.isActive=true;}],['previous login',f=>{f.user.lastLoginAt='2026-10-09T00:00:00Z';}],['business email',f=>{f.user.email='business@example.com';}],
 ['another member',f=>{f.state.members.results[0].user.key=crypto.randomUUID();}],['another group',f=>{f.state.userGroups=f.page([{membershipTypes:['Assigned'],group:{...f.group,key:crypto.randomUUID()}}]);}],
 ['mapped membership',f=>{f.state.members.results[0].membershipTypes=['Mapped'];}],['organization role',f=>{f.state.orgRoles=f.page([{key:crypto.randomUUID()}]);}],
 ['incomplete members page',f=>{f.state.members.page.totalResults=2;}],['pending continuation',f=>{f.state.userGroups.page.nextPageOffset=100;}],
 ['invalid audit timestamp',f=>{f.group.updatedAt='invalid';}],['contradictory access flag',f=>{f.user.access.hasApplicationRoles=false;}],
 ['member with actual login',f=>{f.state.members.results[0].user.lastLoginAt='2026-10-09T00:00:00Z';}],
 ['hidden direct role',f=>{f.state.userDirectRoles=f.page([{...f.role,isDirectlyAssigned:true,assignedGroups:[]}]);}],
 ['hidden mapped role',f=>{f.state.userMappedRoles=f.page([{...f.role,isDirectlyAssigned:false,assignedGroups:[{key:f.groupKey,name:f.group.name,membershipType:'Mapped'}]}]);}]
])test('group assignment refuses '+name,async t=>{const f=fixture(t);change(f);await assert.rejects(groupRoleAssignmentApproval(f.args()),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');});

for(const [name,change]of [
 ['direct assignment',f=>{f.state.userRoles.results[0].isDirectlyAssigned=true;}],['foreign inherited group',f=>{f.state.userRoles.results[0].assignedGroups[0].key=crypto.randomUUID();}],
 ['mapped inherited group',f=>{f.state.userRoles.results[0].assignedGroups[0].membershipType='Mapped';}],['missing inherited group',f=>{f.state.userRoles.results[0].assignedGroups=null;}],
 ['foreign reverse user',f=>{f.state.roleUsers=f.page([{key:crypto.randomUUID(),email:'other@ssam-proof.invalid',status:'Inactive',lastLoginAt:null}]);}]
])test('group removal refuses '+name,async t=>{const f=fixture(t);f.assign();change(f);await assert.rejects(groupRoleAssignmentApproval(f.args(false)),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');});

test('invalid group-role body and query refuse before any remote read',async t=>{
 const f=fixture(t);for(const input of [{path:{key:f.groupKey},body:{}},{path:{key:f.groupKey},query:{limit:100},body:{applicationRoleKeysToAdd:[f.roleKey],applicationRoleKeysToRemove:[]}},
  {path:{key:f.groupKey},body:{applicationRoleKeysToAdd:[f.roleKey],applicationRoleKeysToRemove:[f.roleKey]}}])
  await assert.rejects(groupRoleAssignmentApproval({...f.args(),input}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 assert.equal(f.reads(),0);
});
test('approved group-role snapshot drift refuses',async t=>{const f=fixture(t),a=f.args();f.group.description='Changed';await assert.rejects(groupRoleAssignmentApproval(a),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');});
test('preflight and readback explicitly select every native assignment source',async t=>{
 const f=fixture(t),a=f.args(),queries=[],read=async(id,path,query)=>{if(id==='user-access-management-api-v1:get:/users/{key}/application-roles')queries.push(query);return f.read(id,path,query);};
 const grant=await groupRoleAssignmentApproval({...a,read});f.assign();assert.equal((await groupRoleAssignmentObservation(grant.groupRoleExpectation,read)).verified,true);
 assert.equal(queries.length,6);assert.deepEqual(queries,[...['GroupAssigned','Direct','GroupMapped'],...['GroupAssigned','Direct','GroupMapped']].map(source=>({assignmentSources:[source],limit:100,offset:0})));
});
test('native minimum member date is accepted only with a never-logged-in inactive profile',async t=>{
 const f=fixture(t);f.state.members.results[0].user.lastLoginAt='0001-01-01T00:00:00';assert.ok(await groupRoleAssignmentApproval(f.args()));
 f.user.lastLoginAt='2026-10-09T00:00:00Z';await assert.rejects(groupRoleAssignmentApproval(f.args()),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});
test('group-role readback verifies inheritance and removal with audit-only timestamp changes',async t=>{
 const f=fixture(t),grant=await groupRoleAssignmentApproval(f.args());assert.equal((await groupRoleAssignmentObservation(grant.groupRoleExpectation,f.read)).reason,'inheritance-not-observed');
 f.assign();let r=await groupRoleAssignmentObservation(grant.groupRoleExpectation,f.read);assert.equal(r.verified,true);assert.equal(r.functionalAccessVerified,false);assert.equal(r.verificationScope,'administrative-group-inheritance');
 const revoke=await groupRoleAssignmentApproval(f.args(false));f.remove();assert.equal((await groupRoleAssignmentObservation(revoke.groupRoleExpectation,f.read)).verified,true);
 f.group.updatedAt='2026-10-09T00:00:00Z';assert.equal((await groupRoleAssignmentObservation(revoke.groupRoleExpectation,f.read)).reason,'identity-drift');
});
test('readback rejects weakened inheritance, hidden associations and profile changes',async t=>{
 const f=fixture(t),grant=await groupRoleAssignmentApproval(f.args());f.assign();f.state.userRoles.results[0].isDirectlyAssigned=true;
 assert.equal((await groupRoleAssignmentObservation(grant.groupRoleExpectation,f.read)).reason,'inheritance-not-observed');
 f.assign();f.user.access.hasOrganizationRoles=true;assert.equal((await groupRoleAssignmentObservation(grant.groupRoleExpectation,f.read)).reason,'identity-drift');
 f.user.access.hasOrganizationRoles=false;f.state.userGroups.page.totalResults=2;assert.equal((await groupRoleAssignmentObservation(grant.groupRoleExpectation,f.read)).reason,'incomplete-inventory');
 assert.equal((await groupRoleAssignmentObservation(grant.groupRoleExpectation,async()=>({ok:false}))).reason,'read-unavailable');
});
for(const lost of [false,true])test('group-role access confirms or reconciles after response loss without replay; lost='+lost,async t=>{
 const f=fixture(t),a=f.args(),receipts=new WriteJournal(path.join(f.dir,'receipts')),lookup=receipts.lookup.bind(receipts);
 receipts.lookup=(id,identity)=>f.origins.get(id)??lookup(id,identity);const access=new OdcAccess({catalog:new Catalog(),receipts});access.resolvePublic=async()=>({path:'vault'});
 let writes=0,visible=true;access.read=async({operationId,path,query})=>visible?f.read(operationId,path,query):{ok:false};
 access.send=async(_host,_resolved,id,input,mode)=>{if(!mode.write)return f.read(id,input.path,input.query);writes++;f.assign();if(lost){visible=false;throw new Error('Lost after send');}return{ok:true,status:200};};
 const input={tenant:a.host,confirmTenant:a.host,auth:'api-client',operationId:GROUP_ROLE_ASSIGNMENT,...a.input,authorize:a.words,operationUuid:crypto.randomUUID()},
 options={groupRoleAssignmentContext:a.file,originOperationUuid:f.originOperationUuid,groupOriginOperationUuid:f.groupOriginOperationUuid,userOriginOperationUuid:f.userOriginOperationUuid};
 let result=await access.write(input,options);assert.equal(writes,1,JSON.stringify(result));assert.equal(result.receipt?.state,lost?'uncertain':'confirmed');
 if(lost){const refused=await access.write({...input,authorize:'Different authorization'},options);assert.equal(refused.error?.code,'AUTHORIZATION_CONTEXT_INVALID');visible=true;result=await access.write(input,options);}
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.receipt?.state,'confirmed');assert.equal(result.readBack?.functionalAccessVerified,false);
 assert.equal((await access.write(input,options)).receipt?.state,'confirmed');assert.equal(writes,1);
});
