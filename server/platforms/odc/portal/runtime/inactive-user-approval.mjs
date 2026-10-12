import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ipFilterHash as hash} from './ip-filter-approval.mjs';
import {fail} from './errors.mjs';
const root='user-access-management-api-v1:',collection='/users';
export const USER_CREATE=root+'post:'+collection,USER_PATCH=root+'patch:'+collection+'/{key}',USER_DELETE=root+'delete:'+collection+'/{key}';
export const USER_BULK_CREATE=root+'post:'+collection+'/bulk';
export const INACTIVE_USER_WRITES=new Set([USER_CREATE,USER_BULK_CREATE,USER_PATCH,USER_DELETE]);
const syntheticUser=b=>b&&typeof b.name==='string'&&b.name.trim()&&b.isActive===false&&b.addToBuiltInIdentityProvider===false
 &&typeof b.email==='string'&&/^[a-z0-9][a-z0-9._+-]*@ssam-proof\.invalid$/.test(b.email)
 &&Object.keys(b).every(k=>['name','email','isActive','addToBuiltInIdentityProvider'].includes(k));
export async function inactiveUserApproval({file,words,host,operationId,input,originOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Inactive user proof requires its creation receipt, a synthetic reserved-domain email, no provider/roles/groups, and exact current configuration. Nothing was sent.');
 const bulk=operationId===USER_BULK_CREATE,create=operationId===USER_CREATE||bulk,b=input.body,p=input.path??{};
 const activation=operationId===USER_PATCH&&b&&Object.keys(b).length===1&&typeof b.isActive==='boolean';
 if(!INACTIVE_USER_WRITES.has(operationId)||input.query||Object.keys(p).some(k=>k!=='key')||(create&&Object.keys(p).length))bad();
 let name,origin,current,createdUser,records;
 if(create){
  if(bulk&&(!b||Object.keys(b).length!==1||!Array.isArray(b.records)||b.records.length<1||b.records.length>100))bad();
  records=bulk?b.records:[b];
  if(records.some(r=>!syntheticUser(r))||new Set(records.map(r=>r.name.toLowerCase())).size!==records.length
    ||new Set(records.map(r=>r.email)).size!==records.length)bad();
  name=records[0].name;
 }else{
  origin=lookup(originOperationUuid);
  if(typeof p.key!=='string'||!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
    ||![USER_CREATE,USER_BULK_CREATE].includes(origin.identity.operationId)||!origin.authorization?.source)bad();
  if(origin.identity.operationId===USER_BULK_CREATE){
   const batch=await read(root+'get:/users/bulk/{key}',{key:origin.response?.key});
   if(!batch.ok||batch.data?.key!==origin.response?.key||!['Finished','FinishedWithErrors'].includes(batch.data.status)
     ||!Array.isArray(batch.data.operations))bad();
   const matches=batch.data.operations.filter(x=>x.status==='Inserted'&&x.record?.key===p.key);
   if(matches.length!==1||!Array.isArray(origin.identity.target?.records))bad();
   const originals=origin.identity.target.records.filter(r=>r.email===matches[0].record.email);
   if(originals.length!==1||!syntheticUser(originals[0]))bad();
   createdUser=originals[0];
  }else{
   if(origin.response?.key!==p.key)bad();
   createdUser=origin.identity.target;
  }
  name=createdUser?.name;
  const seen=await read(root+'get:'+collection+'/{key}',p);
  if(!seen.ok||seen.data?.key!==p.key)bad();current=seen.data;
  if(current.email!==createdUser?.email||current.lastLoginAt!==null)bad();
  if(activation){
   if(typeof current.isActive!=='boolean'||current.isActive===b.isActive
    ||createdUser?.isActive!==false||createdUser?.addToBuiltInIdentityProvider!==false
    ||typeof current.email!=='string'||!/^[a-z0-9][a-z0-9._+-]*@ssam-proof\.invalid$/.test(current.email))bad();
  }else if(current.isActive!==false)bad();
  for(const suffix of ['/groups','/application-roles','/organization-roles']){
   const r=await read(root+'get:'+collection+'/{key}'+suffix,p,{limit:1,offset:0});
   if(!r.ok||!Array.isArray(r.data?.results)||r.data.results.length||r.data.page?.totalResults!==0)bad();
  }
  if(operationId===USER_PATCH&&!activation&&(!b||Object.keys(b).length!==1||typeof b.name!=='string'||!b.name.trim()))bad();
  if(operationId===USER_DELETE&&b!==undefined)bad();
 }
 if(create||operationId===USER_PATCH&&!activation){
  const list=await read(root+'get:'+collection,{}, {limit:100,offset:0,sort:'key'});
  const desired=create?records:[b];
  if(!list.ok||!Array.isArray(list.data?.results)||list.data.page?.totalResults!==list.data.results.length
   ||list.data.results.some(r=>typeof r.name!=='string'||desired.some(d=>(r.name.toLowerCase()===d.name.toLowerCase()
     ||d.email&&r.email===d.email)&&r.key!==p.key)))bad();
 }
 const constraints={bodySha256:hash(b??null),...(create?{}:{originOperationUuid,expectedConfigurationSha256:hash(current)})};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:bulk?records.map(r=>r.name):[name],constraints});
 if(!approval||origin&&(approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId))bad();
 return approval;
}
