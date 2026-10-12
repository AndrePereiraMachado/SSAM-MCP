import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {randomUUID as uuid} from 'node:crypto';
import {sha256} from '../runtime/write-journal.mjs';
import {knowledgeFileUploadPlan} from '../runtime/knowledge-file-plan.mjs';
import {KB_UPLOAD,knowledgeFileApproval,knowledgeFileObservation,knowledgeFileDetailObservation} from '../runtime/knowledge-file-upload.mjs';
import {knowledgeFileDetailInput} from '../runtime/knowledge-file-read.mjs';
import {KB_CREATE} from '../runtime/knowledge-base.mjs';
import {OdcAccess} from '../runtime/access.mjs';
import {WriteJournal} from '../runtime/write-journal.mjs';
import {Catalog} from '../runtime/catalog.mjs';

function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kb-file-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const host='proof.outsystems.dev',words='Synthetic owned upload grant',id=uuid(),sourceId=uuid(),stageId=uuid(),portfolioKey=uuid(),originId=uuid();
 const proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Create, upload synthetic file, inspect indexing and delete own base.');
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Synthetic upload test'};
 const limits={ok:true,data:{AllowedUploadMimeTypes:'text/plain',MaximumUploadFileSize:'20971520'}};
 const plan=knowledgeFileUploadPlan({knowledgeBaseId:id,dataSourceId:sourceId,environmentKey:stageId,filename:'proof.txt',mimeType:'text/plain',base64:Buffer.from('Synthetic proof.').toString('base64'),limits});
 const origin={state:'confirmed',identity:{tenant:host,operationId:KB_CREATE},response:{KnowledgeBaseId:id},reconciliation:{knowledgeBase:{name:'OwnBase'}},
  authorization:{wordsSha256:sha256(words),proposalSha256:sha256(fs.readFileSync(proposal).toString()),source}};
 const approval={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:origin.authorization.proposalSha256},
  scope:[{lane:'odc',host,operation:KB_UPLOAD,environmentKey:stageId,targets:['OwnBase','OwnSource','proof.txt']}],
  constraints:{originOperationUuid:originId,portfolioKey,knowledgeBaseId:id,dataSourceId:sourceId,environmentKey:stageId,inputSha256:plan.inputSha256,contentSha256:plan.contentSha256}};
 const file=path.join(dir,'approval.json');fs.writeFileSync(file,JSON.stringify(approval));
 const answers={
  'knowledgeBases.uploadLimits':limits,
  'knowledgeBases.detail':{ok:true,data:{KnowledgeBaseDetails:{KnowledgeBaseId:id,Name:'OwnBase',PortfolioKey:portfolioKey,Status:'Ready'},NotFound:false}},
  'knowledgeBases.dataSources':{ok:true,data:{DataSources:{List:[{DataSourceId:sourceId,Name:'OwnSource'}]}}},
  'knowledgeBases.sourceStages':{ok:true,data:{NotFound_KB:false,KnowledgeBaseDetails:{Name:'OwnBase',PortfolioKey:portfolioKey},Environments:{List:[{Key:stageId,PortfolioKey:portfolioKey}]}}},
  'knowledgeBases.dataSource':{ok:true,data:{NotFound_DS:false,DataSource:{DataSourceId:sourceId,Name:'OwnSource',Type:'upload_files',LifeCycleStatus:'Available'}}},
  'knowledgeBases.files':{ok:true,data:{Files:{List:[]},TotalResults:'0',MaxRecords:12}}};
 return {dir,host,words,origin,originId,approval,file,plan,answers,args:{file,words,host,raw:plan.input,lookup:key=>key===originId?origin:null,read:async op=>structuredClone(answers[op])}};
}
test('upload preflight binds exact content to an owned base/source/stage and complete inventory',async t=>{
 const h=setup(t),r=await knowledgeFileApproval(h.args);assert.equal(r.expected.contentSha256,h.plan.contentSha256);assert.deepEqual(r.expected.previousFileIds,[]);
 for(const mutate of [()=>h.origin.state='accepted',()=>h.origin.identity.tenant='other.outsystems.dev',
  ()=>h.answers['knowledgeBases.dataSource'].data.DataSource.Type='other',
  ()=>h.answers['knowledgeBases.sourceStages'].data.Environments.List=[],
  ()=>h.args.raw={inputParameters:{...h.plan.input.inputParameters,FileContent:Buffer.from('Other content').toString('base64')}},
  ()=>h.approval.constraints.contentSha256='0'.repeat(64)]){
  // Restore the valid baseline after each independent refusal.
  const saved={origin:structuredClone(h.origin),answers:structuredClone(h.answers),raw:h.args.raw,approval:structuredClone(h.approval)};
  mutate();fs.writeFileSync(h.file,JSON.stringify(h.approval));await assert.rejects(()=>knowledgeFileApproval(h.args));
  Object.keys(h.origin).forEach(k=>delete h.origin[k]);Object.assign(h.origin,saved.origin);
  Object.keys(h.answers).forEach(k=>delete h.answers[k]);Object.assign(h.answers,saved.answers);h.args.raw=saved.raw;h.approval=saved.approval;
  fs.writeFileSync(h.file,JSON.stringify(h.approval));
 }
});
test('an indexed filename alone cannot confirm an uncertain upload',async t=>{
 const h=setup(t),p=await knowledgeFileApproval(h.args),receipt={reconciliation:{knowledgeFile:p.expected},response:{uploadAccepted:true}};
 const result={ok:true,data:{Files:{List:[{FileId:uuid(),Filename:'proof.txt',SizeBytes:String(h.plan.byteLength),MimeType:'text/plain',Status:'Indexed'}]},TotalResults:'1',MaxRecords:12}};
 assert.equal(knowledgeFileObservation(receipt,result).verified,true);
 assert.equal(knowledgeFileObservation(receipt,result).ingestionVerified,false);
 Object.assign(result.data.Files.List[0],{ChunkCount:'1',VectorCount:'1'});
 assert.equal(knowledgeFileObservation(receipt,result).ingestionVerified,true);
 Object.assign(result.data.Files.List[0],{ChunkCount:'0',VectorCount:'0'});
 assert.equal(knowledgeFileObservation(receipt,result).indexingStatusVerified,true);
 assert.equal(knowledgeFileObservation(receipt,result).ingestionVerified,false);
 receipt.response.uploadAccepted=false;assert.equal(knowledgeFileObservation(receipt,result).verified,false);
 receipt.response.uploadAccepted=true;result.data.Files.List[0].Status='Indexing';assert.equal(knowledgeFileObservation(receipt,result).verified,false);
 result.data.Files.List[0].Status='IndexingError';assert.equal(knowledgeFileObservation(receipt,result).failed,true);
});
test('file detail binds exact identity and native stage spelling before trusting counts',async t=>{
 const h=setup(t),p=await knowledgeFileApproval(h.args),id=uuid(),receipt={reconciliation:{knowledgeFile:p.expected},response:{uploadAccepted:true}};
 const input=knowledgeFileDetailInput(p.expected,id).screenVariables;
 assert.equal(input.StageId,p.expected.environmentKey);assert.equal(input.stageid,undefined);assert.equal(input.Id,id);assert.equal(input.DataSourceId,p.expected.dataSourceId);
 const result={ok:true,data:{NotFound_DSFile:false,DataSourceFile:{FileId:id,Filename:'proof.txt',MimeType:'text/plain',SizeBytes:String(h.plan.byteLength),Status:'Indexed',ChunkCount:'2',VectorCount:'2'}}};
 assert.equal(knowledgeFileDetailObservation(receipt,id,result).ingestionVerified,true);
 assert.equal(knowledgeFileDetailObservation(receipt,uuid(),result).detailVerified,false);
 result.data.DataSourceFile.ChunkCount='0';assert.equal(knowledgeFileDetailObservation(receipt,id,result).ingestionVerified,false);
 result.data.DataSourceFile.Filename='other.txt';assert.equal(knowledgeFileDetailObservation(receipt,id,result).detailVerified,false);
 assert.throws(()=>knowledgeFileDetailInput({...p.expected,environmentKey:uuid()},id),{code:'INPUT_INVALID'});
});
test('upload receipt exists before send and repeated UUID only reads indexing status',async t=>{
 const h=setup(t),receipts=new WriteJournal(path.join(h.dir,'receipts'));
 const access=new OdcAccess({catalog:new Catalog(),tenants:{default:h.host,tenants:{[h.host]:{class:'corporate'}}},receipts,journal:()=>{}});
 let sends=0;const lookup=receipts.lookup.bind(receipts);receipts.lookup=(key,...rest)=>key===h.originId?h.origin:lookup(key,...rest);
 access.portalRead=async({operationId})=>structuredClone(h.answers[operationId]);
 access.resolvePortal=async()=>({path:'vault',host:h.host,broker:{callScreenservice:async request=>{
  sends++;assert.equal(lookup(request.operationUuid).state,'uncertain');assert.equal(request.write,true);
  h.answers['knowledgeBases.files']={ok:true,data:{Files:{List:[{FileId:uuid(),Filename:'proof.txt',SizeBytes:String(h.plan.byteLength),MimeType:'text/plain',Status:'Indexing'}]},TotalResults:'1',MaxRecords:12}};
  return {data:{HasError:false,ErrorTitle:''}};
 }}});
 const request={tenant:h.host,auth:'portal-credential',operationId:KB_UPLOAD,input:h.plan.input,authorize:h.words,authorizationContext:h.file,confirmTenant:h.host,operationUuid:uuid()};
 const first=await access.portalWrite(request);assert.equal(first.receipt?.state,'accepted',JSON.stringify(first));
 h.answers['knowledgeBases.files'].data.Files.List[0].Status='Indexed';
 const second=await access.portalWrite(request);assert.equal(second.receipt?.state,'confirmed',JSON.stringify(second));assert.equal(second.replayed,false);assert.equal(sends,1);
 const different=await access.portalWrite({...request,input:{inputParameters:{...h.plan.input.inputParameters,FileContent:'YQ=='}}});
 assert.equal(different.error.code,'OPERATION_UUID_REUSED');assert.equal(sends,1);
});
test('lost upload response stays uncertain even when a same-name indexed file appears',async t=>{
 const h=setup(t),receipts=new WriteJournal(path.join(h.dir,'receipts'));
 const access=new OdcAccess({catalog:new Catalog(),tenants:{default:h.host,tenants:{[h.host]:{class:'corporate'}}},receipts,journal:()=>{}});
 const lookup=receipts.lookup.bind(receipts);receipts.lookup=(key,...rest)=>key===h.originId?h.origin:lookup(key,...rest);
 access.portalRead=async({operationId})=>structuredClone(h.answers[operationId]);let sends=0;
 access.resolvePortal=async()=>({path:'vault',host:h.host,broker:{callScreenservice:async()=>{
  sends++;h.answers['knowledgeBases.files']={ok:true,data:{Files:{List:[{FileId:uuid(),Filename:'proof.txt',SizeBytes:String(h.plan.byteLength),MimeType:'text/plain',Status:'Indexed'}]},TotalResults:'1',MaxRecords:12}};
  throw new Error('Response lost');
 }}});
 const request={tenant:h.host,operationId:KB_UPLOAD,input:h.plan.input,authorize:h.words,authorizationContext:h.file,confirmTenant:h.host,operationUuid:uuid()};
 const first=await access.portalWrite(request);assert.equal(first.receipt?.state,'uncertain',JSON.stringify(first));
 const again=await access.portalWrite(request);assert.equal(again.receipt?.state,'uncertain');assert.equal(again.readBack?.reason,'upload-response-unverified');
 assert.equal(sends,1);assert.equal(again.replayed,false);
});
