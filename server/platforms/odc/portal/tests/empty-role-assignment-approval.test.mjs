import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {emptyRoleAssignmentApproval,EMPTY_ROLE_GRANT,EMPTY_ROLE_REVOKE} from '../runtime/empty-role-assignment-approval.mjs';
import {ORG_ROLE_CREATE} from '../runtime/organization-role-approval.mjs';import {USER_CREATE} from '../runtime/inactive-user-approval.mjs';
test('empty role grant and revocation bind both fixtures and refuse effective access or unrelated grants',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'role-assignment-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Synthetic empty role assignment');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),host='example.outsystems.dev',words='Synthetic role assignment grant';
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Synthetic proof'};
 const roleKey=crypto.randomUUID(),key=crypto.randomUUID(),originOperationUuid=crypto.randomUUID(),userOriginOperationUuid=crypto.randomUUID();
 const empty=()=>({results:[],page:{totalResults:0}});
 const state={role:{key:roleKey,name:'Role',isReadOnly:false,permissions:[]},user:{key,name:'User',isActive:false,lastLoginAt:null,email:'proof@ssam-proof.invalid'},groups:empty(),appRoles:empty(),orgRoles:empty(),users:empty()};
 const origins=new Map([[originOperationUuid,{state:'accepted',identity:{tenant:host,operationId:ORG_ROLE_CREATE,target:{name:'Role'}},response:{orgRoleKey:roleKey},authorization:{source}}],
 [userOriginOperationUuid,{state:'accepted',identity:{tenant:host,operationId:USER_CREATE,target:{name:'User',email:state.user.email}},response:{key},authorization:{source}}]]);
 const labels={'get:/organization-roles/{key}':'role','get:/users/{key}':'user','get:/users/{key}/groups':'groups','get:/users/{key}/application-roles':'appRoles','get:/users/{key}/organization-roles':'orgRoles','get:/organization-roles/{key}/users':'users'};
 function args(operationId){fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},
  scope:[{lane:'odc',host,operation:operationId,targets:['Role','User']}],constraints:{bodySha256:hash('{}'),originOperationUuid,userOriginOperationUuid,expectedConfigurationSha256:hash(JSON.stringify(state))}}));
  return {file,words,host,operationId,input:{path:{key,roleKey},body:{}},originOperationUuid,userOriginOperationUuid,lookup:id=>origins.get(id),read:async id=>({ok:true,data:state[labels[id.replace('user-access-management-api-v1:','')]]})};}
 assert.deepEqual((await emptyRoleAssignmentApproval(args(EMPTY_ROLE_GRANT))).targets,['Role','User']);
 await assert.rejects(emptyRoleAssignmentApproval({...args(EMPTY_ROLE_GRANT),lookup:()=>null}));
 state.role.permissions=[{key:crypto.randomUUID()}];await assert.rejects(emptyRoleAssignmentApproval(args(EMPTY_ROLE_GRANT)));state.role.permissions=[];
 state.user.isActive=true;await assert.rejects(emptyRoleAssignmentApproval(args(EMPTY_ROLE_GRANT)));state.user.isActive=false;
 state.orgRoles={results:[{key:roleKey,assetKey:null,portfolioKey:null}],page:{totalResults:1}};state.users={results:[{key}],page:{totalResults:1}};
 assert.deepEqual((await emptyRoleAssignmentApproval(args(EMPTY_ROLE_REVOKE))).targets,['Role','User']);
 await assert.rejects(emptyRoleAssignmentApproval(args(EMPTY_ROLE_GRANT)));
 state.orgRoles.results[0].assetKey=crypto.randomUUID();await assert.rejects(emptyRoleAssignmentApproval(args(EMPTY_ROLE_REVOKE)));
});
