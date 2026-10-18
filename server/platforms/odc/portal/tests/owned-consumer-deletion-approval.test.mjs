import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ownedConsumerDeletionApproval,consumerSetHash} from '../runtime/owned-consumer-deletion-approval.mjs';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
test('owned consumer deletion binds every live identity to the exact proposal and grant',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-delete-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Synthetic owned producer and consumer deletion');
 const words='Synthetic approval for fixtures',host='example.outsystems.dev',assetKey=crypto.randomUUID(),consumer=crypto.randomUUID();
 const source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Synthetic scope'};
 const dependents={name:'Producer',consumers:[{key:consumer,name:'Consumer'}]},origins={[assetKey]:crypto.randomUUID(),[consumer]:crypto.randomUUID()};
 const record={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},
  scope:[{lane:'odc',host,operation:'asset-repository-api-v1:delete:/assets/{assetKey}',targets:['Producer','Consumer']}],
  constraints:{allowOwnedConsumerBreakage:true,producerAssetKey:assetKey,consumerSetSha256:consumerSetHash(dependents.consumers),ownedAssetOrigins:origins}};
 const receipts=Object.fromEntries(Object.entries(origins).map(([key,id])=>[id,{state:'accepted',status:201,identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:key},authorization:{source,wordsSha256:hash(words),proposalSha256:record.proposal.sha256}}]));
 const save=r=>fs.writeFileSync(file,JSON.stringify(r)),base={file,words,host,assetKey,dependents,lookup:id=>receipts[id]};save(record);
 assert.deepEqual(ownedConsumerDeletionApproval(base).targets,['Producer','Consumer']);
 assert.equal(ownedConsumerDeletionApproval({...base,file:undefined}),null);
 save({...record,constraints:{}});assert.equal(ownedConsumerDeletionApproval(base),null);save(record);
 const bad=override=>assert.throws(()=>ownedConsumerDeletionApproval({...base,...override}),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 for(const change of [{state:'uncertain'},{status:409},{response:{assetKey:crypto.randomUUID()}},{identity:{tenant:'other.test',operationId:'asset-repository-api-v1:post:/assets'}},
  {authorization:{...receipts[origins[consumer]].authorization,source:{...source,messageId:crypto.randomUUID()}}},
  {authorization:{...receipts[origins[consumer]].authorization,proposalSha256:'0'.repeat(64)}},
  {authorization:{...receipts[origins[consumer]].authorization,wordsSha256:'0'.repeat(64)}}]){
  bad({lookup:id=>id===origins[consumer]?{...receipts[id],...change}:receipts[id]});
 }
 bad({lookup:()=>null});bad({dependents:{...dependents,consumers:[...dependents.consumers,{key:crypto.randomUUID(),name:'External'}]}});
 bad({dependents:{...dependents,consumers:[{key:consumer,name:'Renamed'}]}});
 for(const patch of [{ownedAssetOrigins:{[assetKey]:origins[assetKey]}},{ownedAssetOrigins:{...origins,extra:crypto.randomUUID()}},{consumerSetSha256:'0'.repeat(64)},{producerAssetKey:consumer}]){
  save({...record,constraints:{...record.constraints,...patch}});bad({});
 }
 save({...record,scope:[{...record.scope[0],targets:['Producer']}]});bad({});
 save(record);fs.appendFileSync(proposal,' changed');bad({});
});
test('consumer identities preserve aliases and are independent of query order',()=>{
 const a=[{key:'a',name:'Old'},{key:'a',name:'New'},{key:'b',name:'New'}];
 assert.equal(consumerSetHash(a),consumerSetHash([...a].reverse()));
 assert.notEqual(consumerSetHash(a),consumerSetHash(a.slice(1)));
});
