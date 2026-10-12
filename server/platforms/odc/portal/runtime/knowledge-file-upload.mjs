import fs from 'node:fs';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
import {isUuid,fingerprint} from './write-journal.mjs';
import {knowledgeFileUploadPlan} from './knowledge-file-plan.mjs';
import {knowledgeFilePage} from './knowledge-file-read.mjs';
import {KB_CREATE} from './knowledge-base.mjs';

export const KB_UPLOAD='knowledgeBases.uploadFile';
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','File upload requires an exact owned base, source, stage and approved content. Nothing was sent.');
export async function knowledgeFileApproval({file,words,host,raw,lookup,read}){
 if(!file||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)bad();
 let constraints;try{if(fs.statSync(file).size>32768)bad();constraints=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(!isUuid(constraints?.originOperationUuid))bad();
 const origin=lookup(constraints.originOperationUuid),p=raw.inputParameters,m=p?.FileMetaData;
 if(!origin||origin.state!=='confirmed'||origin.identity?.tenant!==host||origin.identity.operationId!==KB_CREATE
  ||origin.response?.KnowledgeBaseId!==p?.KnowledgeBaseId||!origin.authorization?.source)bad();
 const limits=await read('knowledgeBases.uploadLimits',{});
 const plan=knowledgeFileUploadPlan({knowledgeBaseId:p.KnowledgeBaseId,dataSourceId:p.DataSourceId,environmentKey:p.EnvironmentId,
  filename:m?.Filename,mimeType:m?.ContentType,base64:p.FileContent,limits});
 if(fingerprint(plan.input.inputParameters)!==fingerprint(p))bad();
 const base=await read('knowledgeBases.detail',{knowledgeBaseId:p.KnowledgeBaseId,environmentKey:p.EnvironmentId,portfolioKey:constraints.portfolioKey});
 const b=base.data?.KnowledgeBaseDetails;
 if(!base.ok||base.data.NotFound!==false||b?.KnowledgeBaseId!==p.KnowledgeBaseId||b?.Status!=='Ready'
  ||b?.Name!==origin.reconciliation?.knowledgeBase?.name||b?.PortfolioKey!==constraints.portfolioKey)bad();
 const sources=await read('knowledgeBases.dataSources',{knowledgeBaseId:p.KnowledgeBaseId,environmentKey:p.EnvironmentId,portfolioKey:b.PortfolioKey});
 const list=sources.data?.DataSources?.List;
 if(!sources.ok||!Array.isArray(list)||list.filter(x=>x.DataSourceId===p.DataSourceId).length!==1)bad();
 const source=list.find(x=>x.DataSourceId===p.DataSourceId);
 const screenVariables={KnowledgeBaseId:p.KnowledgeBaseId,_knowledgeBaseIdInDataFetchStatus:1,Id:p.DataSourceId,_idInDataFetchStatus:1,
  stageid:p.EnvironmentId,_stageidInDataFetchStatus:1,ActivePortfolioKey:b.PortfolioKey};
 const stages=await read('knowledgeBases.sourceStages',{screenVariables});
 const matches=stages.data?.Environments?.List?.filter(x=>x.Key===p.EnvironmentId);
 if(!stages.ok||stages.data?.NotFound_KB!==false||stages.data?.KnowledgeBaseDetails?.Name!==b.Name
  ||stages.data.KnowledgeBaseDetails.PortfolioKey!==b.PortfolioKey||matches?.length!==1||matches[0].PortfolioKey!==b.PortfolioKey)bad();
 screenVariables.SelectedStage=matches[0];
 const detail=await read('knowledgeBases.dataSource',{screenVariables});
 if(!detail.ok||detail.data?.NotFound_DS!==false||detail.data.DataSource?.DataSourceId!==p.DataSourceId
  ||detail.data.DataSource.Name!==source.Name||detail.data.DataSource.Type!=='upload_files'||detail.data.DataSource.LifeCycleStatus!=='Available')bad();
 Object.assign(screenVariables,{SearchKeyword:'',StartIndex:0,FileStatusFilter:{List:[]},SortAttribute:'',SortDirection:''});
 const files=await read('knowledgeBases.files',{screenVariables});
 if(!files.ok)bad();const page=knowledgeFilePage(files.data);
 if(!page.complete||page.rows.some(x=>x.Filename.toLowerCase()===m.Filename.toLowerCase()))
  fail('KNOWLEDGE_FILE_INVENTORY_UNVERIFIED','A complete file inventory without the proposed filename is required. Nothing was sent.');
 const approved=authorizationContext(file,words,{lane:'odc',host,operation:KB_UPLOAD,environmentKey:p.EnvironmentId,
  targets:[b.Name,source.Name,m.Filename],constraints:{originOperationUuid:constraints.originOperationUuid,portfolioKey:b.PortfolioKey,
   knowledgeBaseId:p.KnowledgeBaseId,dataSourceId:p.DataSourceId,environmentKey:p.EnvironmentId,
   inputSha256:plan.inputSha256,contentSha256:plan.contentSha256}});
 if(!approved||approved.wordsSha256!==origin.authorization.wordsSha256||approved.proposalSha256!==origin.authorization.proposalSha256
  ||approved.source.threadId!==origin.authorization.source.threadId||approved.source.messageId!==origin.authorization.source.messageId)bad();
 return {approval:approved,expected:{originOperationUuid:constraints.originOperationUuid,knowledgeBaseId:p.KnowledgeBaseId,dataSourceId:p.DataSourceId,environmentKey:p.EnvironmentId,
  filename:m.Filename,mimeType:m.ContentType,byteLength:plan.byteLength,contentSha256:plan.contentSha256,
  previousFileIds:page.rows.map(x=>x.FileId),screenVariables}};
}

export function knowledgeFileObservation(receipt,result){
 const expected=receipt.reconciliation?.knowledgeFile;
 if(!expected||!result?.ok)return {verified:false,reason:'file-inventory-unavailable'};
 const page=knowledgeFilePage(result.data);
 if(!page.complete)return {verified:false,reason:'file-inventory-incomplete'};
 const found=page.rows.filter(x=>x.Filename===expected.filename&&!expected.previousFileIds.includes(x.FileId));
 if(found.length!==1)return {verified:false,reason:'unique-new-file-unverified'};
 const row=found[0],metadataMatches=Number(row.SizeBytes)===expected.byteLength&&row.MimeType===expected.mimeType;
 const nativeAccepted=receipt.response?.uploadAccepted===true;
 // A name and length cannot authenticate content after a lost response. Such
 // receipts remain uncertain until an independent download/hash proof exists.
 const verified=metadataMatches&&nativeAccepted&&row.Status==='Indexed';
 const chunkCount=Number(row.ChunkCount),vectorCount=Number(row.VectorCount);
 const countsVerified=Number.isSafeInteger(chunkCount)&&chunkCount>0&&Number.isSafeInteger(vectorCount)&&vectorCount>0;
 return {verified,fileId:row.FileId,status:row.Status,metadataMatches,nativeAccepted,
  indexingStatusVerified:verified,ingestionVerified:verified&&countsVerified,
  indexedContentCountsVerified:countsVerified,contentReadBackVerified:false,
  ...(row.Status==='IndexingError'||row.Status==='UploadError'?{failed:true}:{}),
  ...(!nativeAccepted?{reason:'upload-response-unverified'}:{})};
}

export function knowledgeFileDetailObservation(receipt,fileId,result){
 const e=receipt.reconciliation?.knowledgeFile,r=result?.data?.DataSourceFile;
 if(!e||!isUuid(fileId)||!result?.ok||result.data?.NotFound_DSFile!==false||r?.FileId!==fileId)
  return {detailVerified:false,ingestionVerified:false,reason:'file-detail-identity-unverified'};
 const matches=r.Filename===e.filename&&r.MimeType===e.mimeType&&Number(r.SizeBytes)===e.byteLength;
 const counts=[r.ChunkCount,r.VectorCount].map(Number);
 const indexed=matches&&receipt.response?.uploadAccepted===true&&r.Status==='Indexed';
 return {detailVerified:matches,fileId,status:r.Status,chunkCount:r.ChunkCount,vectorCount:r.VectorCount,
  indexingStatusVerified:indexed,indexedContentCountsVerified:counts.every(x=>Number.isSafeInteger(x)&&x>0),
  ingestionVerified:indexed&&counts.every(x=>Number.isSafeInteger(x)&&x>0),contentReadBackVerified:false};
}
