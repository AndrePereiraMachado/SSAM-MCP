import {isUuid} from './write-journal.mjs';
import {knowledgeFilePage} from './knowledge-file-read.mjs';
import {fail} from './errors.mjs';

export const KNOWLEDGE_FILE_DOWNLOAD='knowledgeBases.downloadFile';
// DataSources.datasource passes its source Id and the selected file FileId.
// DataSourceFile.datasourcefile has a conflicting caller; do not copy its Id.
export const KNOWLEDGE_FILE_DOWNLOAD_PATH='/knowledgebases/screenservices/knowledgebases/DataSources/datasource/ActionDataSourceFile_Download';
const refuse=()=>fail('KNOWLEDGE_DOWNLOAD_SCOPE_UNVERIFIED','Download planning requires the recorded upload expectation and exact base, source, selected stage and complete new-file inventory. No request was sent.');

// Pure planning only. The caller must obtain expected from its private upload
// receipt and authenticate these reads in the same tenant. This does not prove
// ownership, mint a URL, download content, or expose a generic Portal route.
export function knowledgeFileDownloadPlan({expected:e,fileId,base,source,files}){
 const vars=e?.screenVariables,stage=vars?.SelectedStage;
 if(![e?.knowledgeBaseId,e?.dataSourceId,e?.environmentKey,fileId,vars?.ActivePortfolioKey].every(isUuid)
  ||fileId===e.dataSourceId||!Array.isArray(e.previousFileIds)||!e.previousFileIds.every(isUuid)
  ||e.previousFileIds.some(id=>id.toLowerCase()===fileId.toLowerCase())
  ||typeof e.filename!=='string'||!e.filename||typeof e.mimeType!=='string'||!e.mimeType
  ||!Number.isSafeInteger(e.byteLength)||e.byteLength<1||e.byteLength>20*1024*1024
  ||typeof e.contentSha256!=='string'||!/^[a-f0-9]{64}$/.test(e.contentSha256)
  ||vars.KnowledgeBaseId!==e.knowledgeBaseId||vars.Id!==e.dataSourceId||vars.stageid!==e.environmentKey
  ||stage?.Key!==e.environmentKey||stage?.PortfolioKey!==vars.ActivePortfolioKey)refuse();
 const b=base?.data?.KnowledgeBaseDetails,s=source?.data?.DataSource;
 if(base?.ok!==true||base.data?.NotFound!==false||b?.KnowledgeBaseId!==e.knowledgeBaseId||b.Status!=='Ready'||b.PortfolioKey!==vars.ActivePortfolioKey
  ||source?.ok!==true||source.data?.NotFound_DS!==false||s?.DataSourceId!==e.dataSourceId||s.Type!=='upload_files'||s.LifeCycleStatus!=='Available'
  ||files?.ok!==true)refuse();
 let page;try{page=knowledgeFilePage(files.data);}catch{refuse();}
 const selected=page.rows.filter(row=>row.FileId===fileId);
 if(!page.complete||selected.length!==1||selected[0].Filename!==e.filename||selected[0].MimeType!==e.mimeType
  ||Number(selected[0].SizeBytes)!==e.byteLength)refuse();
 return{operationId:KNOWLEDGE_FILE_DOWNLOAD,path:KNOWLEDGE_FILE_DOWNLOAD_PATH,privateTransportRequired:true,
  input:{inputParameters:{KnowledgeBaseId:e.knowledgeBaseId,DataSourceId:e.dataSourceId,FileId:fileId,EnvironmentId:e.environmentKey,OverrideBaseURL:''}},
  expectedContent:{filename:e.filename,mimeType:e.mimeType,byteLength:e.byteLength,sha256:e.contentSha256},
  verification:{identityMetadataVerified:true,downloadPerformed:false,contentReadBackVerified:false,ingestionVerified:false}};
}
