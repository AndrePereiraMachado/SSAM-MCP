import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ipFilterHash as hash} from './ip-filter-approval.mjs';
import {fail} from './errors.mjs';
const root='user-access-management-api-v1:';
export const GROUP_CREATE=root+'post:/groups',GROUP_PATCH=root+'patch:/groups/{key}',GROUP_DELETE=root+'delete:/groups/{key}';
export const GROUP_WRITES=new Set([GROUP_CREATE,GROUP_PATCH,GROUP_DELETE]);
export async function groupApproval({file,words,host,operationId,input,originOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Group approval must bind an agent-created group with no users, roles or identity-provider mappings. Nothing was sent.');
 const create=operationId===GROUP_CREATE,b=input.body,p=input.path??{};
 if(!GROUP_WRITES.has(operationId)||input.query||Object.keys(p).some(k=>k!=='key')||(create&&Object.keys(p).length))bad();
 let name,environmentKey,origin,current;
 if(create){
  if(!b||typeof b.name!=='string'||!b.name.trim()||typeof b.environmentKey!=='string'
   ||!Array.isArray(b.userKeys)||b.userKeys.length||!Array.isArray(b.applicationRoleKeys)||b.applicationRoleKeys.length
   ||Object.keys(b).some(k=>!['name','description','environmentKey','userKeys','applicationRoleKeys'].includes(k)))bad();
  name=b.name;environmentKey=b.environmentKey;
  const list=await read(root+'get:/groups',{}, {nameContains:name,environmentKey,limit:100,offset:0});
  if(!list.ok||!Array.isArray(list.data?.results)||list.data.page?.totalResults!==list.data.results.length
    ||list.data.results.some(x=>typeof x.name!=='string'||x.name.toLowerCase()===name.toLowerCase()))bad();
 }else{
  if(typeof p.key!=='string')bad();
  origin=lookup(originOperationUuid);
  if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
    ||origin.identity.operationId!==GROUP_CREATE||origin.response?.key!==p.key||!origin.authorization?.source)bad();
  const seen=await read(root+'get:/groups/{key}',p);
  if(!seen.ok||seen.data?.key!==p.key)bad();
  current=seen.data;name=current.name;environmentKey=current.environmentKey;
  if(name!==origin.identity.target?.name||environmentKey!==origin.identity.target?.environmentKey
    ||!Object.hasOwn(current,'groupIdpClaimMappings')
    ||current.groupIdpClaimMappings!==null&&(!Array.isArray(current.groupIdpClaimMappings)||current.groupIdpClaimMappings.length))bad();
  for(const suffix of ['/users','/application-roles']){
   const members=await read(root+'get:/groups/{key}'+suffix,p,{limit:1,offset:0});
   if(!members.ok||!Array.isArray(members.data?.results)||members.data.results.length||members.data.page?.totalResults!==0)bad();
  }
  if(operationId===GROUP_PATCH&&(!b||Object.keys(b).length!==1||typeof b.description!=='string'))bad();
  if(operationId===GROUP_DELETE&&b!==undefined)bad();
 }
 const constraints={bodySha256:hash(b??null),...(create?{}:{originOperationUuid,expectedConfigurationSha256:hash(current)})};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,environmentKey,targets:[name],constraints});
 if(!approval||origin&&(approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId))bad();
 return approval;
}
