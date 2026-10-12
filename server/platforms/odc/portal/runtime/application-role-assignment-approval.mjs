import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ipFilterHash as hash} from './ip-filter-approval.mjs';
import {ASSET_CREATE} from './asset-creation-approval.mjs';
import {USER_CREATE} from './inactive-user-approval.mjs';
import {isUuid} from './write-journal.mjs';
import {fail} from './errors.mjs';
const root='user-access-management-api-v1:',route='/users/{key}/application-roles/{roleKey}';
export const APPLICATION_ROLE_GRANT=root+'post:'+route,APPLICATION_ROLE_REVOKE=root+'delete:'+route;
export const APPLICATION_ROLE_ASSIGNMENTS=new Set([APPLICATION_ROLE_GRANT,APPLICATION_ROLE_REVOKE]);

// Administrative proof on an inactive synthetic user and a role published by
// an owned app. This does not validate functional login or effective access.
export async function applicationRoleAssignmentApproval({file,words,host,operationId,input,originOperationUuid,userOriginOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Application role assignment requires an owned app and inactive synthetic user, exact stage/role identity and current associations. Nothing was sent.');
 const p=input.path??{},grant=operationId===APPLICATION_ROLE_GRANT;
 if(!APPLICATION_ROLE_ASSIGNMENTS.has(operationId)||input.query||input.body!==undefined||Object.keys(p).length!==2||!isUuid(p.key)||!isUuid(p.roleKey))bad();
 const appOrigin=lookup(originOperationUuid),userOrigin=lookup(userOriginOperationUuid);
 for(const [receipt,operation,key,field]of [[appOrigin,ASSET_CREATE,null,'assetKey'],[userOrigin,USER_CREATE,p.key,'key']])
  if(!receipt||!['accepted','confirmed'].includes(receipt.state)||receipt.identity?.tenant!==host||receipt.identity.operationId!==operation
   ||!isUuid(receipt.response?.[field])||key&&receipt.response[field]!==key||!receipt.authorization?.source)bad();
 const assetKey=appOrigin.response.assetKey,snapshot={};
 async function get(label,id,path,query){const result=await read(id,path,query);if(!result.ok)bad();snapshot[label]=result.data;return result.data;}
 const app=await get('app','asset-repository-api-v1:get:/assets/{assetKey}',{assetKey});
 if(app.assetKey!==assetKey||app.name!==appOrigin.identity.target?.name||!['WebApplication','MobileApplication'].includes(app.assetType))bad();
 async function list(label,id,path,query={}){const value=await get(label,id,path,{...query,limit:100,offset:0});
  if(!Array.isArray(value?.results)||value.page?.totalResults!==value.results.length||value.page.offset!==0
   ||value.page.nextPageOffset!=null||new Set(value.results.map(x=>x.key)).size!==value.results.length)bad();return value.results;}
 const roles=await list('role',root+'get:/application-roles',{}, {key:p.roleKey,assetKey});
 if(roles.length!==1)bad();const role=roles[0];
 if(role.key!==p.roleKey||role.assetKey!==assetKey||!isUuid(role.environmentKey)||!isUuid(role.portfolioKey)||typeof role.name!=='string'||!role.name.trim())bad();
 const user=await get('user',root+'get:/users/{key}',{key:p.key}),original=userOrigin.identity.target;
 if(user.key!==p.key||user.name!==original?.name||user.email!==original?.email||user.isActive!==false||user.lastLoginAt!==null
  ||original?.isActive!==false||original?.addToBuiltInIdentityProvider!==false||typeof user.email!=='string'
  ||!/^[a-z0-9][a-z0-9._+-]*@ssam-proof\.invalid$/.test(user.email))bad();
 for(const suffix of ['groups','organization-roles'])if((await list(suffix,root+'get:/users/{key}/'+suffix,{key:p.key})).length)bad();
 const assigned=await list('assignedRoles',root+'get:/users/{key}/application-roles',{key:p.key});
 const users=await list('roleUsers',root+'get:/application-roles/{key}/users',{key:p.roleKey});
 if(grant){if(assigned.length||users.length)bad();}
 else if(assigned.length!==1||assigned[0].key!==p.roleKey||assigned[0].assetKey!==assetKey||assigned[0].environmentKey!==role.environmentKey
  ||assigned[0].isDirectlyAssigned!==true||assigned[0].assignedGroups!==null&&(!Array.isArray(assigned[0].assignedGroups)||assigned[0].assignedGroups.length)
  ||users.length!==1||users[0].key!==p.key||users[0].email!==user.email||users[0].status!=='Inactive'||users[0].lastLoginAt!==null)bad();
 const constraints={bodySha256:hash(null),originOperationUuid,userOriginOperationUuid,assetKey,roleKey:p.roleKey,
  environmentKey:role.environmentKey,expectedConfigurationSha256:hash(snapshot)};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,environmentKey:role.environmentKey,
  targets:[app.name,role.name,user.name],constraints});
 if(!approval)bad();
 for(const receipt of [appOrigin,userOrigin])if(approval.source.threadId!==receipt.authorization.source.threadId||approval.source.messageId!==receipt.authorization.source.messageId)bad();
 return {...approval,applicationRoleExpectation:{app:structuredClone(app),role:structuredClone(role),user:structuredClone(user),assigned:grant}};
}


export async function applicationRoleAssignmentObservation(expected,read){
 if(!expected?.app||!expected?.role||!expected?.user||typeof expected.assigned!=='boolean')return{verified:false,reason:'missing-expectation'};
 const {app,role,user,assigned}=expected,rows={};
 for(const [label,id,path,query]of [
  ['app','asset-repository-api-v1:get:/assets/{assetKey}',{assetKey:app.assetKey}],
  ['user',root+'get:/users/{key}',{key:user.key}],
  ['role',root+'get:/application-roles',{}, {key:role.key,assetKey:app.assetKey}],
  ['groups',root+'get:/users/{key}/groups',{key:user.key},{}],
  ['orgRoles',root+'get:/users/{key}/organization-roles',{key:user.key},{}],
  ['assignedRoles',root+'get:/users/{key}/application-roles',{key:user.key},{}],
  ['roleUsers',root+'get:/application-roles/{key}/users',{key:role.key},{}]
 ]){
  const r=await read(id,path,query?{...query,limit:100,offset:0}:undefined);if(!r.ok)return{verified:false,reason:'read-unavailable'};
  rows[label]=r.data;
  if(query&&(!Array.isArray(r.data?.results)||r.data.page?.totalResults!==r.data.results.length||r.data.page.offset!==0||r.data.page.nextPageOffset!=null))return{verified:false,reason:'incomplete-inventory'};
 }
 // The public profile reflects this administrative association in a derived
 // flag. Require the intended value; preserve every other profile field.
 const expectedUser=structuredClone(user);
 if(typeof expectedUser.access?.hasApplicationRoles==='boolean')expectedUser.access.hasApplicationRoles=assigned;
 if(hash(rows.app)!==hash(app)||hash(rows.user)!==hash(expectedUser)||rows.role.results.length!==1||hash(rows.role.results[0])!==hash(role))return{verified:false,reason:'identity-drift'};
 if(rows.groups.results.length||rows.orgRoles.results.length)return{verified:false,reason:'other-associations'};
 const a=rows.assignedRoles.results,u=rows.roleUsers.results;
 if(assigned){
  if(a.length!==1||u.length!==1||a[0].key!==role.key||a[0].assetKey!==app.assetKey||a[0].environmentKey!==role.environmentKey||a[0].isDirectlyAssigned!==true
   ||a[0].assignedGroups!==null&&(!Array.isArray(a[0].assignedGroups)||a[0].assignedGroups.length)||u[0].key!==user.key||u[0].email!==user.email||u[0].status!=='Inactive'||u[0].lastLoginAt!==null)
   return{verified:false,reason:'assignment-not-observed'};
 }else if(a.length||u.length)return{verified:false,reason:'revocation-not-observed'};
 return{verified:true,assigned,assetKey:app.assetKey,roleKey:role.key,userKey:user.key,environmentKey:role.environmentKey,verificationScope:'administrative-association',functionalAccessVerified:false};
}
