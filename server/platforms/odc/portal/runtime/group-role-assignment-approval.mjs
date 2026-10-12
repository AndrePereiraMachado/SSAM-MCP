import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ipFilterHash as hash} from './ip-filter-approval.mjs';
import {ASSET_CREATE} from './asset-creation-approval.mjs';
import {GROUP_CREATE} from './group-approval.mjs';
import {USER_CREATE} from './inactive-user-approval.mjs';
import {isUuid} from './write-journal.mjs';
import {fail} from './errors.mjs';
const root='user-access-management-api-v1:';
export const GROUP_ROLE_ASSIGNMENT=root+'patch:/groups/{key}/application-roles';
const configuration=group=>{const {updatedAt,...value}=group??{};return value;};
const complete=value=>Array.isArray(value?.results)&&value.page?.totalResults===value.results.length&&value.page.offset===0&&value.page.nextPageOffset==null;
const same=(a,b)=>hash(a)===hash(b);
const assignedMembership=value=>same(value,['Assigned']);
const noMemberLogin=value=>value===null||value==='0001-01-01T00:00:00';
const roleIdentity=(seen,role)=>seen&&same(Object.fromEntries(Object.keys(role).map(k=>[k,seen[k]])),role);
function inheritedRole(roles,role,group){return roles.length===1&&roleIdentity(roles[0],role)&&roles[0].isDirectlyAssigned===false
 &&Array.isArray(roles[0].assignedGroups)&&roles[0].assignedGroups.length===1
 &&same(roles[0].assignedGroups[0],{key:group.key,name:group.name,membershipType:'Assigned'});}
function ownMembers(snapshot){const {group,user,members,userGroups,orgRoles}=snapshot;
 return members.results.length===1&&members.results[0].user?.key===user.key&&members.results[0].user.name===user.name
 &&members.results[0].user.email===user.email&&members.results[0].user.status==='Inactive'&&noMemberLogin(members.results[0].user.lastLoginAt)
 &&assignedMembership(members.results[0].membershipTypes)&&userGroups.results.length===1
 &&same(configuration(userGroups.results[0].group),configuration(group))&&assignedMembership(userGroups.results[0].membershipTypes)
 &&orgRoles.results.length===0&&snapshot.userDirectRoles.results.length===0&&snapshot.userMappedRoles.results.length===0;
}
function confinedReverseUsers(snapshot,assigned){const users=snapshot.roleUsers.results,user=snapshot.user;
 // The captured reverse endpoint contract does not specify inheritance.
 // Prove inheritance by userRoles.assignedGroups, never by an empty reverse
 // list. Any foreign or active returned user is refused.
 return users.length===0||assigned&&users.length===1&&users[0].key===user.key&&users[0].email===user.email&&users[0].status==='Inactive'&&users[0].lastLoginAt===null;
}

export async function groupRoleSnapshot({assetKey,roleKey,groupKey,userKey,read}){
 const rows={};
 for(const [label,id,path,query]of [
  ['app','asset-repository-api-v1:get:/assets/{assetKey}',{assetKey}],
  ['role',root+'get:/application-roles',{}, {key:roleKey,assetKey}],
  ['group',root+'get:/groups/{key}',{key:groupKey}],
  ['user',root+'get:/users/{key}',{key:userKey}],
  ['groupRoles',root+'get:/groups/{key}/application-roles',{key:groupKey},{}],
  ['members',root+'get:/groups/{key}/users',{key:groupKey},{}],
  ['userGroups',root+'get:/users/{key}/groups',{key:userKey},{}],
  ['orgRoles',root+'get:/users/{key}/organization-roles',{key:userKey},{}],
  // Live multi-source queries returned empty despite the single GroupAssigned
  // query returning the owned inherited role. Read each source separately;
  // require direct and mapped inventories empty instead of hiding either.
  ['userRoles',root+'get:/users/{key}/application-roles',{key:userKey},{assignmentSources:['GroupAssigned']}],
  ['userDirectRoles',root+'get:/users/{key}/application-roles',{key:userKey},{assignmentSources:['Direct']}],
  ['userMappedRoles',root+'get:/users/{key}/application-roles',{key:userKey},{assignmentSources:['GroupMapped']}],
  ['roleUsers',root+'get:/application-roles/{key}/users',{key:roleKey},{}]
 ]){
  const result=await read(id,path,query?{...query,limit:100,offset:0}:undefined);
  if(!result.ok)return{ok:false,reason:'read-unavailable'};
  if(query&&!complete(result.data))return{ok:false,reason:'incomplete-inventory'};
  rows[label]=result.data;
 }
 return{ok:true,snapshot:rows};
}

export async function groupRoleAssignmentApproval({file,words,host,operationId,input,originOperationUuid,groupOriginOperationUuid,userOriginOperationUuid,lookup,read}){
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Group role assignment requires an owned published app role, group and inactive synthetic member, exact stage and current snapshot. Nothing was sent.');
 const p=input.path??{},b=input.body;
 if(operationId!==GROUP_ROLE_ASSIGNMENT||input.query||Object.keys(p).length!==1||!isUuid(p.key)||!b||Object.keys(b).length!==2
  ||!Array.isArray(b.applicationRoleKeysToAdd)||!Array.isArray(b.applicationRoleKeysToRemove)
  ||b.applicationRoleKeysToAdd.length+b.applicationRoleKeysToRemove.length!==1)bad();
 const assigned=b.applicationRoleKeysToAdd.length===1,roleKey=(assigned?b.applicationRoleKeysToAdd:b.applicationRoleKeysToRemove)[0];
 if(!isUuid(roleKey))bad();
 const origins=[lookup(originOperationUuid),lookup(groupOriginOperationUuid),lookup(userOriginOperationUuid)];
 for(const [index,operation,field]of [[0,ASSET_CREATE,'assetKey'],[1,GROUP_CREATE,'key'],[2,USER_CREATE,'key']]){
  const receipt=origins[index];if(!receipt||!['accepted','confirmed'].includes(receipt.state)||receipt.identity?.tenant!==host
   ||receipt.identity.operationId!==operation||!isUuid(receipt.response?.[field])||!receipt.authorization?.source)bad();
 }
 const [appOrigin,groupOrigin,userOrigin]=origins,assetKey=appOrigin.response.assetKey,userKey=userOrigin.response.key;
 if(groupOrigin.response.key!==p.key)bad();
 const readBack=await groupRoleSnapshot({assetKey,roleKey,groupKey:p.key,userKey,read});if(!readBack.ok)bad();
 const snapshot=readBack.snapshot,{app,role:roles,group,user}=snapshot;if(roles.results.length!==1)bad();const role=roles.results[0];
 if(app.assetKey!==assetKey||app.name!==appOrigin.identity.target?.name||!['WebApplication','MobileApplication'].includes(app.assetType)
  ||role.key!==roleKey||role.assetKey!==assetKey||!isUuid(role.environmentKey)||!isUuid(role.portfolioKey)||typeof role.name!=='string'||!role.name.trim()
  ||group.key!==p.key||group.name!==groupOrigin.identity.target?.name||group.environmentKey!==groupOrigin.identity.target?.environmentKey
  ||group.environmentKey!==role.environmentKey||group.portfolioKey!==role.portfolioKey
  ||!Number.isFinite(Date.parse(group.updatedAt))||group.groupIdpClaimMappings!==null&&(!Array.isArray(group.groupIdpClaimMappings)||group.groupIdpClaimMappings.length))bad();
 const original=userOrigin.identity.target;
 if(user.key!==userKey||user.name!==original?.name||user.email!==original?.email||user.isActive!==false||user.status!=='Inactive'||user.lastLoginAt!==null
  ||original?.isActive!==false||original?.addToBuiltInIdentityProvider!==false||typeof user.email!=='string'||!/^[a-z0-9][a-z0-9._+-]*@ssam-proof\.invalid$/.test(user.email)
  // The live API sets hasApplicationRoles for membership even in an empty
  // group. Keep it true while membership is unchanged; it proves no role.
  ||user.access?.hasOrganizationRoles!==false||user.access?.hasApplicationRoles!==true||!ownMembers(snapshot))bad();
 if(assigned){if(snapshot.groupRoles.results.length||snapshot.userRoles.results.length)bad();}
 else if(snapshot.groupRoles.results.length!==1||!same(snapshot.groupRoles.results[0],role)||!inheritedRole(snapshot.userRoles.results,role,group))bad();
 if(!confinedReverseUsers(snapshot,!assigned))bad();
 const constraints={bodySha256:hash(b),originOperationUuid,groupOriginOperationUuid,userOriginOperationUuid,assetKey,roleKey,environmentKey:role.environmentKey,expectedConfigurationSha256:hash(snapshot)};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,environmentKey:role.environmentKey,targets:[app.name,role.name,group.name,user.name],constraints});
 if(!approval)bad();for(const receipt of origins)if(approval.source.threadId!==receipt.authorization.source.threadId||approval.source.messageId!==receipt.authorization.source.messageId)bad();
 return{...approval,groupRoleExpectation:{app:structuredClone(app),role:structuredClone(role),group:structuredClone(group),user:structuredClone(user),assigned}};
}

export async function groupRoleAssignmentObservation(expected,read){
 if(!expected?.app||!expected?.role||!expected?.group||!expected?.user||typeof expected.assigned!=='boolean')return{verified:false,reason:'missing-expectation'};
 const {app,role,group,user,assigned}=expected,result=await groupRoleSnapshot({assetKey:app.assetKey,roleKey:role.key,groupKey:group.key,userKey:user.key,read});
 if(!result.ok)return{verified:false,reason:result.reason};const s=result.snapshot;
 const expectedUser=structuredClone(user);
 if(!same(s.app,app)||s.role.results.length!==1||!same(s.role.results[0],role)||!same(configuration(s.group),configuration(group))
  ||!Number.isFinite(Date.parse(s.group.updatedAt))||Date.parse(s.group.updatedAt)<Date.parse(group.updatedAt)||!same(s.user,expectedUser))return{verified:false,reason:'identity-drift'};
 if(!ownMembers(s)||!confinedReverseUsers(s,assigned))return{verified:false,reason:'other-associations'};
 if(assigned){if(s.groupRoles.results.length!==1||!same(s.groupRoles.results[0],role)||!inheritedRole(s.userRoles.results,role,group))return{verified:false,reason:'inheritance-not-observed'};}
 else if(s.groupRoles.results.length||s.userRoles.results.length)return{verified:false,reason:'removal-not-observed'};
 return{verified:true,assigned,assetKey:app.assetKey,roleKey:role.key,groupKey:group.key,userKey:user.key,environmentKey:role.environmentKey,
  verificationScope:'administrative-group-inheritance',functionalAccessVerified:false,reverseUsersInventoryCount:s.roleUsers.results.length};
}
