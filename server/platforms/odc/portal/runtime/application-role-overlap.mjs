import {authorizationContext} from '../../facade/authorization-context.mjs';
import {APPLICATION_ROLE_GRANT,APPLICATION_ROLE_REVOKE} from './application-role-assignment-approval.mjs';
import {groupRoleSnapshot} from './group-role-assignment-approval.mjs';
import {ASSET_CREATE} from './asset-creation-approval.mjs';import {GROUP_CREATE} from './group-approval.mjs';import {USER_CREATE} from './inactive-user-approval.mjs';
import {fingerprint,isUuid} from './write-journal.mjs';import {ipFilterHash as hash} from './ip-filter-approval.mjs';import {fail} from './errors.mjs';
const root='user-access-management-api-v1:',same=(a,b)=>fingerprint(a)===fingerprint(b);
const complete=p=>Array.isArray(p?.results)&&p.page?.totalResults===p.results.length&&p.page.offset===0&&p.page.nextPageOffset==null;
const configuration=group=>{const {updatedAt,...value}=group;return value;};
const memberAssigned=value=>same(value,['Assigned']);
const identity=(row,role)=>row&&role&&same(Object.fromEntries(Object.keys(role).map(k=>[k,row[k]])),role);
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Owned role overlap requires an owned app, group, inactive synthetic member and complete single-source inventories without foreign access. Nothing was sent.');

export async function applicationRoleOverlapSnapshot({assetKey,roleKey,groupKey,userKey,read}){
 const result=await groupRoleSnapshot({assetKey,roleKey,groupKey,userKey,read});if(!result.ok)return result;
 const catalogue=await read(root+'get:/application-roles',{}, {assetKey,limit:100,offset:0});
 if(!catalogue.ok)return{ok:false,reason:'read-unavailable'};if(!complete(catalogue.data))return{ok:false,reason:'incomplete-inventory'};
 result.snapshot.catalogue=catalogue.data;return result;
}
function structure(s){
 if(!s?.app||!s.group||!s.user||!s.role?.results?.[0]||!s.catalogue?.results?.every(r=>r&&typeof r==='object'))bad();
 const {app,group,user}=s,roles=s.catalogue.results,byKey=new Map(roles.map(r=>[r.key,r]));
 if(!roles.length||byKey.size!==roles.length||s.role.results.length!==1||!isUuid(app.assetKey)||!['WebApplication','MobileApplication'].includes(app.assetType)
  ||roles.some(r=>!isUuid(r.key)||!isUuid(r.externalKey)||!isUuid(r.environmentKey)||!isUuid(r.portfolioKey)||r.assetKey!==app.assetKey||r.environmentKey!==group.environmentKey||r.portfolioKey!==group.portfolioKey||typeof r.name!=='string'||!r.name.trim())
  ||!same(byKey.get(s.role.results[0].key),s.role.results[0])||!Number.isFinite(Date.parse(group.updatedAt))
  ||group.groupIdpClaimMappings!==null&&(!Array.isArray(group.groupIdpClaimMappings)||group.groupIdpClaimMappings.length)
  ||user.isActive!==false||user.status!=='Inactive'||user.lastLoginAt!==null||user.access?.hasOrganizationRoles!==false||user.access?.hasApplicationRoles!==true
  ||typeof user.email!=='string'||!/^[a-z0-9][a-z0-9._+-]*@ssam-proof\.invalid$/.test(user.email))bad();
 const members=s.members.results,groups=s.userGroups.results;
 if(members.length!==1||members[0].user?.key!==user.key||members[0].user.name!==user.name||members[0].user.email!==user.email||members[0].user.status!=='Inactive'
  ||![null,'0001-01-01T00:00:00'].includes(members[0].user.lastLoginAt)||!memberAssigned(members[0].membershipTypes)
  ||groups.length!==1||!same(configuration(groups[0].group),configuration(group))||!memberAssigned(groups[0].membershipTypes)
  ||s.orgRoles.results.length||s.userMappedRoles.results.length||s.groupRoles.results.length!==1||s.userRoles.results.length!==1)bad();
 const inherited=s.groupRoles.results[0],userRole=s.userRoles.results[0];
 if(!same(inherited,byKey.get(inherited.key))||!identity(userRole,inherited)||userRole.isDirectlyAssigned!==false
  ||!same(userRole.assignedGroups,[{key:group.key,name:group.name,membershipType:'Assigned'}]))bad();
 const direct=s.userDirectRoles.results,keys=new Set();for(const row of direct){
  if(keys.has(row.key)||!identity(row,byKey.get(row.key))||row.isDirectlyAssigned!==true||row.assignedGroups!==null&&(!Array.isArray(row.assignedGroups)||row.assignedGroups.length))bad();keys.add(row.key);
 }
 const reverse=s.roleUsers.results;
 if(reverse.length>1||reverse.length===1&&(reverse[0].key!==user.key||reverse[0].email!==user.email||reverse[0].status!=='Inactive'||reverse[0].lastLoginAt!==null))bad();
 return{role:s.role.results[0],directKeys:[...keys].sort()};
}
function stableSnapshot(snapshot){const result=structuredClone(snapshot);result.group=configuration(result.group);for(const row of result.userGroups.results)row.group=configuration(row.group);
 delete result.userDirectRoles;delete result.roleUsers;return result;}

export async function applicationRoleOverlapApproval({file,words,host,operationId,input,originOperationUuid,groupOriginOperationUuid,userOriginOperationUuid,lookup,read}){
 const p=input.path??{},assigned=operationId===APPLICATION_ROLE_GRANT;
 if(![APPLICATION_ROLE_GRANT,APPLICATION_ROLE_REVOKE].includes(operationId)||input.body!==undefined||input.query||Object.keys(p).length!==2||!isUuid(p.key)||!isUuid(p.roleKey))bad();
 const origins=[lookup(originOperationUuid),lookup(groupOriginOperationUuid),lookup(userOriginOperationUuid)];
 for(const [i,op,key]of [[0,ASSET_CREATE,'assetKey'],[1,GROUP_CREATE,'key'],[2,USER_CREATE,'key']]){
  const r=origins[i];if(!r||!['accepted','confirmed'].includes(r.state)||r.identity?.tenant!==host||r.identity.operationId!==op||!isUuid(r.response?.[key])||!r.authorization?.source)bad();
 }
 const [appOrigin,groupOrigin,userOrigin]=origins;if(userOrigin.response.key!==p.key)bad();
 const result=await applicationRoleOverlapSnapshot({assetKey:appOrigin.response.assetKey,roleKey:p.roleKey,groupKey:groupOrigin.response.key,userKey:p.key,read});if(!result.ok)bad();
 const s=result.snapshot,{role,directKeys}=structure(s),original=userOrigin.identity.target;
 if(s.app.assetKey!==appOrigin.response.assetKey||s.group.key!==groupOrigin.response.key||s.user.key!==p.key||role.key!==p.roleKey
  ||s.app.name!==appOrigin.identity.target?.name||s.group.name!==groupOrigin.identity.target?.name||s.group.environmentKey!==groupOrigin.identity.target?.environmentKey
  ||s.user.name!==original?.name||s.user.email!==original?.email||original?.isActive!==false||original?.addToBuiltInIdentityProvider!==false
  ||directKeys.includes(p.roleKey)===assigned)bad();
 const constraints={bodySha256:hash(null),originOperationUuid,groupOriginOperationUuid,userOriginOperationUuid,assetKey:s.app.assetKey,roleKey:p.roleKey,environmentKey:s.group.environmentKey,expectedConfigurationSha256:hash(s)};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,environmentKey:s.group.environmentKey,targets:[s.app.name,role.name,s.group.name,s.user.name],constraints});
 if(!approval)bad();for(const r of origins)if(approval.source.threadId!==r.authorization.source.threadId||approval.source.messageId!==r.authorization.source.messageId)bad();
 const expectedDirectKeys=assigned?[...directKeys,p.roleKey].sort():directKeys.filter(k=>k!==p.roleKey);
 return{...approval,applicationRoleOverlapExpectation:{before:structuredClone(s),expectedDirectKeys,assigned}};
}

export async function applicationRoleOverlapObservation(expected,read){
 if(!expected?.before||!Array.isArray(expected.expectedDirectKeys)||typeof expected.assigned!=='boolean')return{verified:false,reason:'missing-expectation'};
 const before=expected.before,result=await applicationRoleOverlapSnapshot({assetKey:before.app.assetKey,roleKey:before.role.results[0].key,groupKey:before.group.key,userKey:before.user.key,read});
 if(!result.ok)return{verified:false,reason:result.reason};const s=result.snapshot;
 let observed;try{observed=structure(s);}catch{return{verified:false,reason:'association-scope-drift'};}
 if(!same(stableSnapshot(s),stableSnapshot(before))||Date.parse(s.group.updatedAt)<Date.parse(before.group.updatedAt))return{verified:false,reason:'identity-drift'};
 if(!same(observed.directKeys,expected.expectedDirectKeys))return{verified:false,reason:'direct-assignment-not-observed'};
 return{verified:true,assigned:expected.assigned,assetKey:s.app.assetKey,roleKey:observed.role.key,groupKey:s.group.key,userKey:s.user.key,environmentKey:s.group.environmentKey,
  directRoleCount:observed.directKeys.length,inheritedRoleCount:1,verificationScope:'administrative-source-overlap',functionalAccessVerified:false};
}
