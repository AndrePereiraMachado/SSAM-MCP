import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ipFilterHash as hash} from './ip-filter-approval.mjs';
import {ORG_ROLE_CREATE} from './organization-role-approval.mjs';
import {USER_CREATE} from './inactive-user-approval.mjs';
import {fail} from './errors.mjs';
const root='user-access-management-api-v1:',route='/users/{key}/organization-roles/{roleKey}';
export const EMPTY_ROLE_GRANT=root+'post:'+route,EMPTY_ROLE_REVOKE=root+'delete:'+route;
export const EMPTY_ROLE_ASSIGNMENTS=new Set([EMPTY_ROLE_GRANT,EMPTY_ROLE_REVOKE]);
export async function emptyRoleAssignmentApproval({file,words,host,operationId,input,originOperationUuid,userOriginOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Empty role assignment requires two new fixtures, no permissions, no other assignments, and exact current state. Nothing was sent.');
 const p=input.path??{},b=input.body,grant=operationId===EMPTY_ROLE_GRANT;
 if(!EMPTY_ROLE_ASSIGNMENTS.has(operationId)||input.query||Object.keys(p).length!==2||typeof p.key!=='string'||typeof p.roleKey!=='string'
  ||!b||Array.isArray(b)||Object.keys(b).length)bad();
 const ro=lookup(originOperationUuid),uo=lookup(userOriginOperationUuid);
 for(const [r,op,key,field] of [[ro,ORG_ROLE_CREATE,p.roleKey,'orgRoleKey'],[uo,USER_CREATE,p.key,'key']])
  if(!r||!['accepted','confirmed'].includes(r.state)||r.identity?.tenant!==host||r.identity.operationId!==op||r.response?.[field]!==key||!r.authorization?.source)bad();
 const snapshot={};
 async function get(label,op,key,isList=false){const r=await read(root+op,{key},isList?{limit:100,offset:0}:undefined);if(!r.ok)bad();snapshot[label]=r.data;
  if(isList&&(!Array.isArray(r.data?.results)||r.data.page?.totalResults!==r.data.results.length))bad();return r.data;}
 const role=await get('role','get:/organization-roles/{key}',p.roleKey),user=await get('user','get:/users/{key}',p.key);
 if(role.key!==p.roleKey||role.name!==ro.identity.target?.name||role.isReadOnly!==false||!Array.isArray(role.permissions)||role.permissions.length
  ||user.key!==p.key||user.isActive!==false||user.lastLoginAt!==null||user.email!==uo.identity.target?.email
  ||typeof user.email!=='string'||!user.email.endsWith('@ssam-proof.invalid'))bad();
 if((await get('groups','get:/users/{key}/groups',p.key,true)).results.length||(await get('appRoles','get:/users/{key}/application-roles',p.key,true)).results.length)bad();
 const roles=(await get('orgRoles','get:/users/{key}/organization-roles',p.key,true)).results;
 const users=(await get('users','get:/organization-roles/{key}/users',p.roleKey,true)).results;
 if(grant){if(roles.length||users.length)bad();}
 else if(roles.length!==1||users.length!==1||roles[0].key!==p.roleKey||users[0].key!==p.key||roles[0].assetKey!==null||roles[0].portfolioKey!==null)bad();
 const constraints={bodySha256:hash(b),originOperationUuid,userOriginOperationUuid,expectedConfigurationSha256:hash(snapshot)};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:[ro.identity.target.name,uo.identity.target.name],constraints});
 if(!approval)bad();
 for(const r of [ro,uo])if(approval.source.threadId!==r.authorization.source.threadId||approval.source.messageId!==r.authorization.source.messageId)bad();
 return approval;
}
