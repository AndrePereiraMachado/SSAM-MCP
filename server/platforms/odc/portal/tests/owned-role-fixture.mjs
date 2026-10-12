import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {GROUP_ROLE_ASSIGNMENT} from '../runtime/group-role-assignment-approval.mjs';
import {ASSET_CREATE} from '../runtime/asset-creation-approval.mjs';import {GROUP_CREATE} from '../runtime/group-approval.mjs';import {USER_CREATE} from '../runtime/inactive-user-approval.mjs';
export function ownedGroupRoleFixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'group-role-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Synthetic owned group-role proof');
 const hash=v=>crypto.createHash('sha256').update(Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex'),uuid=()=>crypto.randomUUID();
 const host='example.outsystems.dev',words='Synthetic owned group role fixture authorization',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Synthetic group-role proof'};
 const assetKey=uuid(),roleKey=uuid(),groupKey=uuid(),userKey=uuid(),environmentKey=uuid(),portfolioKey=uuid(),originOperationUuid=uuid(),groupOriginOperationUuid=uuid(),userOriginOperationUuid=uuid();
 const page=results=>({results,page:{totalResults:results.length,limit:100,offset:0,nextPageOffset:null}});
 const app={assetKey,name:'OwnApp',assetType:'WebApplication'},role={key:roleKey,name:'OwnRole',assetKey,environmentKey,portfolioKey,externalKey:uuid(),claim:'Synthetic'},
 group={key:groupKey,name:'OwnGroup',description:'Original',environmentKey,portfolioKey,updatedAt:'2026-10-10T01:00:00Z',groupIdpClaimMappings:[]},
 user={key:userKey,name:'OwnUser',email:'proof@ssam-proof.invalid',status:'Inactive',isActive:false,lastLoginAt:null,access:{hasOrganizationRoles:false,hasApplicationRoles:true}};
 const state={app,role:page([role]),group,user,groupRoles:page([]),members:page([{membershipTypes:['Assigned'],user:{key:userKey,name:user.name,email:user.email,status:'Inactive',lastLoginAt:null}}]),
 userGroups:page([{membershipTypes:['Assigned'],group}]),orgRoles:page([]),userRoles:page([]),userDirectRoles:page([]),userMappedRoles:page([]),roleUsers:page([])};
 const origins=new Map([[originOperationUuid,{state:'accepted',identity:{tenant:host,operationId:ASSET_CREATE,target:{name:app.name}},response:{assetKey},authorization:{source}}],
 [groupOriginOperationUuid,{state:'accepted',identity:{tenant:host,operationId:GROUP_CREATE,target:{name:group.name,environmentKey}},response:{key:groupKey},authorization:{source}}],
 [userOriginOperationUuid,{state:'accepted',identity:{tenant:host,operationId:USER_CREATE,target:{name:user.name,email:user.email,isActive:false,addToBuiltInIdentityProvider:false}},response:{key:userKey},authorization:{source}}]]);
 const labels={'asset-repository-api-v1:get:/assets/{assetKey}':'app',[ 'user-access-management-api-v1:get:/application-roles']:'role',
 ['user-access-management-api-v1:get:/groups/{key}']:'group',['user-access-management-api-v1:get:/users/{key}']:'user',
 ['user-access-management-api-v1:get:/groups/{key}/application-roles']:'groupRoles',['user-access-management-api-v1:get:/groups/{key}/users']:'members',
 ['user-access-management-api-v1:get:/users/{key}/groups']:'userGroups',['user-access-management-api-v1:get:/users/{key}/organization-roles']:'orgRoles',
 ['user-access-management-api-v1:get:/users/{key}/application-roles']:'userRoles',['user-access-management-api-v1:get:/application-roles/{key}/users']:'roleUsers'};
 let reads=0;const read=async(id,_path,query)=>{reads++;const label=id==='user-access-management-api-v1:get:/users/{key}/application-roles'
  ?{Direct:'userDirectRoles',GroupAssigned:'userRoles',GroupMapped:'userMappedRoles'}[query?.assignmentSources?.[0]]:labels[id];return{ok:true,data:structuredClone(state[label])};};
 function args(assigned=true){const body={applicationRoleKeysToAdd:assigned?[roleKey]:[],applicationRoleKeysToRemove:assigned?[]:[roleKey]};
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},
   scope:[{lane:'odc',host,operation:GROUP_ROLE_ASSIGNMENT,environmentKey,targets:[app.name,role.name,group.name,user.name]}],
   constraints:{bodySha256:hash(body),originOperationUuid,groupOriginOperationUuid,userOriginOperationUuid,assetKey,roleKey,environmentKey,expectedConfigurationSha256:hash(state)}}));
  return{file,words,host,operationId:GROUP_ROLE_ASSIGNMENT,input:{path:{key:groupKey},body},originOperationUuid,groupOriginOperationUuid,userOriginOperationUuid,lookup:id=>origins.get(id),read};
 }
 function assign(){group.updatedAt='2026-10-10T02:00:00Z';user.access.hasApplicationRoles=true;state.groupRoles=page([role]);state.userRoles=page([{...role,isDirectlyAssigned:false,assignedGroups:[{key:groupKey,name:group.name,membershipType:'Assigned'}]}]);}
 function remove(){group.updatedAt='2026-10-10T03:00:00Z';state.groupRoles=page([]);state.userRoles=page([]);state.roleUsers=page([]);}
 return{dir,file,state,app,role,group,user,origins,args,assign,remove,read,reads:()=>reads,page,assetKey,roleKey,groupKey,userKey,environmentKey,originOperationUuid,groupOriginOperationUuid,userOriginOperationUuid};
}

