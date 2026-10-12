import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ipFilterHash as hash} from './ip-filter-approval.mjs';
import {GROUP_CREATE} from './group-approval.mjs';
import {USER_CREATE} from './inactive-user-approval.mjs';
import {fail} from './errors.mjs';
const root='user-access-management-api-v1:';
export const GROUP_MEMBERSHIP=root+'patch:/groups/{key}/users';
export async function groupMembershipApproval({file,words,host,operationId,input,originOperationUuid,userOriginOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Membership proof requires two agent-created fixtures, an inactive synthetic user and a group without permissions or other members. Nothing was sent.');
 const p=input.path??{},b=input.body;
 if(operationId!==GROUP_MEMBERSHIP||input.query||Object.keys(p).length!==1||typeof p.key!=='string'||!b
  ||Object.keys(b).length!==2||!Array.isArray(b.userKeysToAdd)||!Array.isArray(b.userKeysToRemove)
  ||b.userKeysToAdd.length+b.userKeysToRemove.length!==1)bad();
 const adding=b.userKeysToAdd.length===1,userKey=(adding?b.userKeysToAdd:b.userKeysToRemove)[0];
 const groupOrigin=lookup(originOperationUuid),userOrigin=lookup(userOriginOperationUuid);
 for(const [r,operation,key] of [[groupOrigin,GROUP_CREATE,p.key],[userOrigin,USER_CREATE,userKey]])
  if(!r||!['accepted','confirmed'].includes(r.state)||r.identity?.tenant!==host||r.identity.operationId!==operation||r.response?.key!==key||!r.authorization?.source)bad();
 const snapshot={};
 async function get(label,op,path,query){const r=await read(root+op,path,query);if(!r.ok)bad();snapshot[label]=r.data;return r.data;}
 async function list(label,op,path){const d=await get(label,op,path,{limit:100,offset:0});
  if(!Array.isArray(d?.results)||d.page?.totalResults!==d.results.length)bad();return d.results;}
 const group=await get('group','get:/groups/{key}',{key:p.key});
 const user=await get('user','get:/users/{key}',{key:userKey});
 if(group.key!==p.key||group.name!==groupOrigin.identity.target?.name||group.environmentKey!==groupOrigin.identity.target?.environmentKey
  ||!Array.isArray(group.groupIdpClaimMappings)||group.groupIdpClaimMappings.length
  ||user.key!==userKey||user.isActive!==false||user.lastLoginAt!==null||user.email!==userOrigin.identity.target?.email
  ||typeof user.email!=='string'||!user.email.endsWith('@ssam-proof.invalid'))bad();
 for(const [label,op,key] of [['groupRoles','get:/groups/{key}/application-roles',p.key],['appRoles','get:/users/{key}/application-roles',userKey],['orgRoles','get:/users/{key}/organization-roles',userKey]])
  if((await list(label,op,{key})).length)bad();
 const members=await list('members','get:/groups/{key}/users',{key:p.key}),groups=await list('groups','get:/users/{key}/groups',{key:userKey});
 if(adding){if(members.length||groups.length)bad();}
 else if(members.length!==1||groups.length!==1||members[0].user?.key!==userKey||groups[0].group?.key!==p.key
  ||JSON.stringify(members[0].membershipTypes)!=='["Assigned"]'||JSON.stringify(groups[0].membershipTypes)!=='["Assigned"]')bad();
 const constraints={bodySha256:hash(b),originOperationUuid,userOriginOperationUuid,expectedConfigurationSha256:hash(snapshot)};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,environmentKey:group.environmentKey,
  targets:[groupOrigin.identity.target.name,userOrigin.identity.target.name],constraints});
 if(!approval)bad();
 for(const r of [groupOrigin,userOrigin])if(approval.source.threadId!==r.authorization.source.threadId||approval.source.messageId!==r.authorization.source.messageId)bad();
 return approval;
}
