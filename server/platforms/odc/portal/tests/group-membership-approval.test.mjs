import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {groupMembershipApproval,GROUP_MEMBERSHIP} from '../runtime/group-membership-approval.mjs';
import {GROUP_CREATE} from '../runtime/group-approval.mjs';import {USER_CREATE} from '../runtime/inactive-user-approval.mjs';
test('membership approval binds two creations, both directions, and unchanged empty permissions',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'membership-proof-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Synthetic membership');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),host='example.outsystems.dev',words='Synthetic membership grant';
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Synthetic test'};
 const groupKey=crypto.randomUUID(),userKey=crypto.randomUUID(),environmentKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID(),userOriginOperationUuid=crypto.randomUUID();
 const group={key:groupKey,name:'Group',environmentKey,groupIdpClaimMappings:[]},user={key:userKey,name:'User',isActive:false,lastLoginAt:null,email:'user@ssam-proof.invalid'};
 const empty=()=>({results:[],page:{totalResults:0}});
 let snapshot={group,user,groupRoles:empty(),appRoles:empty(),orgRoles:empty(),members:empty(),groups:empty()};
 const origins=new Map([[originOperationUuid,{state:'accepted',identity:{tenant:host,operationId:GROUP_CREATE,target:{name:'Group',environmentKey}},response:{key:groupKey},authorization:{source}}],
 [userOriginOperationUuid,{state:'accepted',identity:{tenant:host,operationId:USER_CREATE,target:{name:'User',email:user.email}},response:{key:userKey},authorization:{source}}]]);
 const labels={'get:/groups/{key}':'group','get:/users/{key}':'user','get:/groups/{key}/application-roles':'groupRoles','get:/users/{key}/application-roles':'appRoles','get:/users/{key}/organization-roles':'orgRoles','get:/groups/{key}/users':'members','get:/users/{key}/groups':'groups'};
 function args(add){const body={userKeysToAdd:add?[userKey]:[],userKeysToRemove:add?[]:[userKey]};
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},
   scope:[{lane:'odc',host,operation:GROUP_MEMBERSHIP,environmentKey,targets:['Group','User']}],
   constraints:{bodySha256:hash(JSON.stringify(body)),originOperationUuid,userOriginOperationUuid,expectedConfigurationSha256:hash(JSON.stringify(snapshot))}}));
  return {file,words,host,operationId:GROUP_MEMBERSHIP,input:{path:{key:groupKey},body},originOperationUuid,userOriginOperationUuid,lookup:id=>origins.get(id),
   read:async id=>({ok:true,data:snapshot[labels[id.replace('user-access-management-api-v1:','')]]})};
 }
 let request=args(true);assert.deepEqual((await groupMembershipApproval(request)).targets,['Group','User']);
 for(const change of [{lookup:()=>null},{userOriginOperationUuid:originOperationUuid},{input:{...request.input,body:{userKeysToAdd:[userKey],userKeysToRemove:[userKey]}}}])await assert.rejects(groupMembershipApproval({...request,...change}));
 snapshot.user={...user,isActive:true};await assert.rejects(groupMembershipApproval(args(true)));snapshot.user=user;
 snapshot.groupRoles={results:[{key:'role'}],page:{totalResults:1}};await assert.rejects(groupMembershipApproval(args(true)));snapshot.groupRoles=empty();
 snapshot.members={results:[{user:{key:userKey},membershipTypes:['Assigned']}],page:{totalResults:1}};
 snapshot.groups={results:[{group:{key:groupKey},membershipTypes:['Assigned']}],page:{totalResults:1}};
 assert.deepEqual((await groupMembershipApproval(args(false))).targets,['Group','User']);
 await assert.rejects(groupMembershipApproval(args(true)));
 snapshot.members.results[0].membershipTypes=['Mapped'];await assert.rejects(groupMembershipApproval(args(false)));
});
