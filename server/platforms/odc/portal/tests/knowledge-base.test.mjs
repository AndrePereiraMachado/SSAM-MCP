import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {KB_CREATE,KB_DELETE,knowledgeBaseInventory,knowledgeBaseApproval,knowledgeBaseObservation} from '../runtime/knowledge-base.mjs';
import {sha256} from '../runtime/write-journal.mjs';
const id=()=>crypto.randomUUID(),inventory=rows=>({ok:true,data:{KBListItems:{List:rows},TotalCount:String(rows.length)}});
test('knowledge-base approval binds creation, deletion and live consumers to the same proposal',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kb-proof-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'context.json'),proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Synthetic empty KB cycle');
 const host='example.outsystems.dev',words='Synthetic grant',key=id(),portfolio=id(),originId=id(),source={kind:'human-conversation',threadId:id(),messageId:id(),question:'Fixture cycle'};
 const p={KnowledgeBaseCreate:{Name:'OwnedKB',Description:'Empty proof',PortfolioKey:portfolio,DataSources:{List:[{Name:'OwnedSource',Description:'Empty source',Type:'upload_files',ChunkingConfig:{ChunkingMethod:'Smart',ChunkSize:1000,ChunkOverlap:200,Separators:'',KeepSeparator:false}}]}}};
 const record={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:sha256(fs.readFileSync(proposal).toString())},scope:[{lane:'odc',host,operation:KB_CREATE,targets:['OwnedKB','OwnedSource']}],constraints:{inputSha256:sha256(JSON.stringify(p)),portfolioKey:portfolio}};
 const save=r=>fs.writeFileSync(file,JSON.stringify(r));save(record);
 const read=async op=>op==='knowledgeBases.chunkingMethods'?{ok:true,data:{ChunkingMethods:{List:[{Id:'Smart'}]}}}:op==='knowledgeBases.createStages'?{ok:true,data:{Stages:{List:[{PortfolioKey:portfolio}]}}}:inventory([]);
 const args={file,words,host,operationId:KB_CREATE,raw:{inputParameters:p},read};
 assert.equal((await knowledgeBaseApproval(args)).operation,KB_CREATE);
 await assert.rejects(knowledgeBaseApproval({...args,file:undefined}));
 await assert.rejects(knowledgeBaseApproval({...args,read:async()=>inventory([{KnowledgeBaseId:key,Name:'OwnedKB',Status:'Ready'}])}));
 await assert.rejects(knowledgeBaseApproval({...args,raw:{inputParameters:{...p,Extra:'no'}}}));
 const found={KnowledgeBaseId:key,Name:'OwnedKB',Status:'Ready'},origin={state:'confirmed',identity:{tenant:host,operationId:KB_CREATE},response:{KnowledgeBaseId:key},authorization:{source,wordsSha256:sha256(words),proposalSha256:record.proposal.sha256}};
 record.scope[0].operation=KB_DELETE;record.constraints={originOperationUuid:originId,knowledgeBaseId:key,expectedKnowledgeBaseSha256:sha256(JSON.stringify(found))};save(record);
 const deletion={...args,operationId:KB_DELETE,raw:{inputParameters:{KnowledgeBaseId:key}},lookup:()=>origin,read:async op=>op==='knowledgeBases.list'?inventory([found]):{ok:true,data:{ApplicationConsumers:{List:[]}}}};
 assert.equal((await knowledgeBaseApproval(deletion)).operation,KB_DELETE);
 for(const override of [{lookup:()=>({...origin,state:'uncertain'})},{lookup:()=>({...origin,response:{KnowledgeBaseId:id()}})},
  {lookup:()=>({...origin,authorization:{...origin.authorization,proposalSha256:'wrong'}})},
  {read:async op=>op==='knowledgeBases.list'?inventory([found]):{ok:true,data:{ApplicationConsumers:{List:[{Name:'ExistingApp'}]}}}},
  {read:async op=>op==='knowledgeBases.list'?inventory([{...found,Status:'Creating'}]):{ok:true,data:{ApplicationConsumers:{List:[]}}}}])
  await assert.rejects(knowledgeBaseApproval({...deletion,...override}));
});
test('knowledge-base readback requires complete inventory, exact identity and Ready state',()=>{
 const key=id(),item={KnowledgeBaseId:key,Name:'Proof',Status:'Ready'},receipt={identity:{operationId:KB_CREATE},response:{KnowledgeBaseId:key},reconciliation:{knowledgeBase:{name:'Proof'}}};
 assert.equal(knowledgeBaseObservation(receipt,inventory([item])).verified,true);
 for(const row of [{...item,Status:'Creating'},{...item,Status:'Error'},{...item,Name:'Other'},{...item,KnowledgeBaseId:id()}])assert.equal(knowledgeBaseObservation(receipt,inventory([row])).verified,false);
 assert.equal(knowledgeBaseObservation({...receipt,response:{}},inventory([item])).verified,false);
 const deleted={identity:{operationId:KB_DELETE},reconciliation:{knowledgeBase:{key}}};
 assert.equal(knowledgeBaseObservation(deleted,inventory([])).verified,true);assert.equal(knowledgeBaseObservation(deleted,inventory([item])).verified,false);
 for(const result of [{ok:false}, {ok:true,data:{KBListItems:{List:[]},TotalCount:'1'}},...[null,'',false,' 0'].map(TotalCount=>({ok:true,data:{KBListItems:{List:[]},TotalCount}})),inventory([item,item]),inventory([{Name:'bad',Status:'Ready'}])])assert.throws(()=>knowledgeBaseInventory(result));
});
