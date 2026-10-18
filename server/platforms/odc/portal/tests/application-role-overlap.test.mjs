import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {ownedGroupRoleFixture} from './owned-role-fixture.mjs';
import {applicationRoleOverlapApproval as approve,applicationRoleOverlapObservation as observe,applicationRoleOverlapSnapshot} from '../runtime/application-role-overlap.mjs';
import {APPLICATION_ROLE_GRANT as GRANT,APPLICATION_ROLE_REVOKE as REVOKE} from '../runtime/application-role-assignment-approval.mjs';
import {OdcAccess} from '../runtime/access.mjs';import {WriteJournal} from '../runtime/write-journal.mjs';import {Catalog} from '../runtime/catalog.mjs';
function fixture(t){
 const f=ownedGroupRoleFixture(t),original=f.args(),record=JSON.parse(fs.readFileSync(f.file,'utf8'));f.assign();
 const omega={...f.role,key:crypto.randomUUID(),name:'OwnOmega',externalKey:crypto.randomUUID(),claim:'SyntheticOmega'},catalogue=[f.role,omega];
 const hash=v=>crypto.createHash('sha256').update(Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
 const read=async(id,p,q)=>{
  if(id==='user-access-management-api-v1:get:/application-roles')return{ok:true,data:f.page(q?.key?catalogue.filter(r=>r.key===q.key):catalogue)};
  if(id==='user-access-management-api-v1:get:/application-roles/{key}/users')return{ok:true,data:f.page(f.state.userDirectRoles.results.some(r=>r.key===p.key)?[{key:f.userKey,email:f.user.email,status:'Inactive',lastLoginAt:null}]:[])};
  return f.read(id,p,q);
 };
 const set=(key,assigned)=>{const role=catalogue.find(r=>r.key===key);f.state.userDirectRoles.results=f.state.userDirectRoles.results.filter(r=>r.key!==key);
  if(assigned)f.state.userDirectRoles.results.push({...role,isDirectlyAssigned:true,assignedGroups:[]});f.state.userDirectRoles=f.page(f.state.userDirectRoles.results.sort((a,b)=>a.name.localeCompare(b.name)));};
 async function args(operationId=GRANT,key=f.roleKey){
  const result=await applicationRoleOverlapSnapshot({assetKey:f.assetKey,roleKey:key,groupKey:f.groupKey,userKey:f.userKey,read});assert(result.ok);
  const role=catalogue.find(r=>r.key===key),constraints={bodySha256:hash(null),originOperationUuid:f.originOperationUuid,groupOriginOperationUuid:f.groupOriginOperationUuid,userOriginOperationUuid:f.userOriginOperationUuid,
   assetKey:f.assetKey,roleKey:key,environmentKey:f.environmentKey,expectedConfigurationSha256:hash(result.snapshot)};
  fs.writeFileSync(f.file,JSON.stringify({...record,scope:[{lane:'odc',host:original.host,operation:operationId,environmentKey:f.environmentKey,targets:[f.app.name,role?.name??'Unknown',f.group.name,f.user.name]}],constraints}));
  return{...original,operationId,input:{path:{key:f.userKey,roleKey:key}},read};
 }
 return{...f,omega,catalogue,args,read,set,host:original.host,words:original.words};
}
test('direct grants and revocations retain the exact inherited role and other owned direct roles',async t=>{
 const f=fixture(t);for(const [op,key,count]of [[GRANT,f.roleKey,1],[GRANT,f.omega.key,2],[REVOKE,f.omega.key,1],[REVOKE,f.roleKey,0]]){
  const a=await f.args(op,key),approval=await approve(a);f.set(key,op===GRANT);const r=await observe(approval.applicationRoleOverlapExpectation,f.read);
  assert.equal(r.verified,true);assert.equal(r.directRoleCount,count);assert.equal(r.inheritedRoleCount,1);assert.equal(r.functionalAccessVerified,false);
 }
});
for(const [name,change]of [
 ['active user',f=>{f.user.isActive=true;}],['actual login',f=>{f.user.lastLoginAt='2026-10-09T00:00:00Z';}],['other identity-provider mapping',f=>{f.group.groupIdpClaimMappings=[{}];}],
 ['foreign catalogue asset',f=>{f.omega.assetKey=crypto.randomUUID();}],['foreign stage',f=>{f.omega.environmentKey=crypto.randomUUID();}],['duplicate catalogue',f=>{f.catalogue.push({...f.role});}],
 ['foreign direct role',f=>{f.state.userDirectRoles=f.page([{...f.omega,key:crypto.randomUUID(),isDirectlyAssigned:true,assignedGroups:[]}]);}],
 ['mapped access',f=>{f.state.userMappedRoles=f.page([{...f.role,isDirectlyAssigned:false,assignedGroups:[{key:f.groupKey,name:f.group.name,membershipType:'Mapped'}]}]);}],
 ['organization role',f=>{f.state.orgRoles=f.page([{key:crypto.randomUUID()}]);}],['another member',f=>{f.state.members.results[0].user.key=crypto.randomUUID();}],
 ['missing origin',f=>{f.origins.delete(f.groupOriginOperationUuid);}],['different source',f=>{f.origins.get(f.userOriginOperationUuid).authorization.source={threadId:crypto.randomUUID(),messageId:crypto.randomUUID()};}],
 ['wrong inherited role',f=>{f.state.userRoles.results[0].key=crypto.randomUUID();}],['mapped membership',f=>{f.state.userGroups.results[0].membershipTypes=['Mapped'];}]
])test('overlap refuses '+name,async t=>{const f=fixture(t);change(f);await assert.rejects(approve(await f.args()),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');});
test('wrong filtered role, body/query injection and incomplete source page refuse',async t=>{
 const f=fixture(t),a=await f.args();for(const input of [{...a.input,body:{}},{...a.input,query:{limit:100}}])await assert.rejects(approve({...a,input}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 await assert.rejects(approve({...a,read:async(id,p,q)=>id==='user-access-management-api-v1:get:/application-roles'&&q?.key?{ok:true,data:f.page([f.omega])}:f.read(id,p,q)}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 f.state.userMappedRoles.page.totalResults=1;await assert.rejects(approve(a),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});
test('approved snapshot drift refuses and unchanged inherited association alone cannot confirm a direct grant',async t=>{
 const f=fixture(t),a=await f.args(),approval=await approve(a);assert.equal((await observe(approval.applicationRoleOverlapExpectation,f.read)).reason,'direct-assignment-not-observed');
 f.group.description='Changed';await assert.rejects(approve(a),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
});
for(const lost of [false,true])test('overlap write read-back reconciles without replay; response lost='+lost,async t=>{
 const f=fixture(t),a=await f.args(),receipts=new WriteJournal(path.join(f.dir,'overlap-receipts')),lookup=receipts.lookup.bind(receipts);receipts.lookup=(id,identity)=>f.origins.get(id)??lookup(id,identity);
 const access=new OdcAccess({catalog:new Catalog(),receipts});access.resolvePublic=async()=>({path:'vault'});
 let writes=0,visible=true;access.read=async({operationId,path,query})=>visible?f.read(operationId,path,query):{ok:false};
 access.send=async(_h,_r,id,input,mode)=>{if(!mode.write)return f.read(id,input.path,input.query);writes++;f.set(f.roleKey,true);if(lost){visible=false;throw new Error('Lost response');}return{ok:true,status:201};};
 const input={tenant:f.host,auth:'api-client',confirmTenant:f.host,operationId:GRANT,...a.input,authorize:f.words,operationUuid:crypto.randomUUID()},
 options={applicationRoleOverlapContext:f.file,originOperationUuid:f.originOperationUuid,groupOriginOperationUuid:f.groupOriginOperationUuid,userOriginOperationUuid:f.userOriginOperationUuid};
 let result=await access.write(input,options);assert.equal(writes,1,JSON.stringify(result));assert.equal(result.receipt?.state,lost?'uncertain':'confirmed');
 if(lost){visible=true;result=await access.write(input,options);}assert.equal(result.receipt?.state,'confirmed');assert.equal(result.readBack?.inheritedRoleCount,1);assert.equal(result.readBack?.functionalAccessVerified,false);
 assert.equal((await access.write(input,options)).receipt?.state,'confirmed');assert.equal(writes,1);
});

