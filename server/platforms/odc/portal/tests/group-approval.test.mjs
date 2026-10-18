import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {groupApproval,GROUP_CREATE,GROUP_PATCH,GROUP_DELETE} from '../runtime/group-approval.mjs';
test('group lifecycle binds exact body, original creation, unchanged empty membership and human grant',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'group-approval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Synthetic empty group');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),host='example.outsystems.dev',words='Synthetic authorization';
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Synthetic group'};
 const key=crypto.randomUUID(),environmentKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID();
 const body={name:'Fixture',description:'Original',environmentKey,userKeys:[],applicationRoleKeys:[]};
 const current={key,name:'Fixture',description:'Original',environmentKey,groupIdpClaimMappings:[]};
 function context(op,value,extra={}){fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host,operation:op,environmentKey,targets:['Fixture']}],
  constraints:{bodySha256:hash(JSON.stringify(value??null)),...extra}}));}
 const empty={ok:true,data:{results:[],page:{totalResults:0}}};
 const base={file,words,host,operationId:GROUP_CREATE,input:{body},read:async()=>empty};context(GROUP_CREATE,body);
 assert.deepEqual((await groupApproval(base)).targets,['Fixture']);
 await assert.rejects(groupApproval({...base,input:{body:{...body,userKeys:[key]}}}));
 await assert.rejects(groupApproval({...base,read:async()=>({ok:true,data:{results:[],page:{totalResults:2}}})}));
 const origin={state:'accepted',identity:{tenant:host,operationId:GROUP_CREATE,target:{name:'Fixture',environmentKey}},response:{key},authorization:{source}};
 const patch={description:'Changed'};context(GROUP_PATCH,patch,{originOperationUuid,expectedConfigurationSha256:hash(JSON.stringify(current))});
 const edit={...base,operationId:GROUP_PATCH,input:{path:{key},body:patch},originOperationUuid,lookup:()=>origin,
  read:async op=>op.endsWith('/groups/{key}')?{ok:true,data:current}:empty};
 assert.deepEqual((await groupApproval(edit)).targets,['Fixture']);
 for(const change of [{lookup:()=>({...origin,state:'uncertain'})},{lookup:()=>({...origin,response:{key:crypto.randomUUID()}})},
  {read:async()=>({ok:true,data:{...current,description:'Concurrent'}})},
  {read:async op=>op.endsWith('/groups/{key}')?{ok:true,data:current}:{ok:true,data:{results:[{key}],page:{totalResults:1}}}},
  {input:{path:{key},body:{name:'Renamed'}}}])await assert.rejects(groupApproval({...edit,...change}));
 context(GROUP_DELETE,undefined,{originOperationUuid,expectedConfigurationSha256:hash(JSON.stringify(current))});
 assert.deepEqual((await groupApproval({...edit,operationId:GROUP_DELETE,input:{path:{key}}})).targets,['Fixture']);
});
