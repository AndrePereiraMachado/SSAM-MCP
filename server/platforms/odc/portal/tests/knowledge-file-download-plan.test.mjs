import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {knowledgeFileDownloadPlan as plan,KNOWLEDGE_FILE_DOWNLOAD_PATH} from '../runtime/knowledge-file-download-plan.mjs';
function fixture(){const knowledgeBaseId=crypto.randomUUID(),dataSourceId=crypto.randomUUID(),environmentKey=crypto.randomUUID(),portfolioKey=crypto.randomUUID(),fileId=crypto.randomUUID();
 return{fileId,expected:{knowledgeBaseId,dataSourceId,environmentKey,filename:'proof.txt',mimeType:'text/plain',byteLength:7,contentSha256:crypto.createHash('sha256').update('proof\r\n').digest('hex'),previousFileIds:[],
 screenVariables:{KnowledgeBaseId:knowledgeBaseId,Id:dataSourceId,stageid:environmentKey,ActivePortfolioKey:portfolioKey,SelectedStage:{Key:environmentKey,PortfolioKey:portfolioKey}}},
 base:{ok:true,data:{NotFound:false,KnowledgeBaseDetails:{KnowledgeBaseId:knowledgeBaseId,PortfolioKey:portfolioKey,Status:'Ready'}}},
 source:{ok:true,data:{NotFound_DS:false,DataSource:{DataSourceId:dataSourceId,Type:'upload_files',LifeCycleStatus:'Available'}}},
 files:{ok:true,data:{Files:{List:[{FileId:fileId,Filename:'proof.txt',MimeType:'text/plain',SizeBytes:'7',Status:'Indexed',ChunkCount:0,VectorCount:0}]},TotalResults:'1',MaxRecords:12}}};}
test('native source-list contract keeps source/file distinct, pins empty override and makes no content claim',()=>{
 const f=fixture(),before=structuredClone(f),p=plan(f);assert.deepEqual(f,before);assert.equal(p.path,KNOWLEDGE_FILE_DOWNLOAD_PATH);assert(p.path.includes('/DataSources/datasource/'));
 assert.deepEqual(p.input,{inputParameters:{KnowledgeBaseId:f.expected.knowledgeBaseId,DataSourceId:f.expected.dataSourceId,FileId:f.fileId,EnvironmentId:f.expected.environmentKey,OverrideBaseURL:''}});
 assert.equal(p.privateTransportRequired,true);assert.equal(p.verification.contentReadBackVerified,false);assert.equal(p.verification.downloadPerformed,false);assert.equal(p.verification.ingestionVerified,false);
 assert.equal(p.expectedContent.sha256,f.expected.contentSha256);assert(!JSON.stringify(p).includes('https://'));
});
for(const [name,change]of [
 ['file/source collision',f=>{f.fileId=f.expected.dataSourceId;}],['old file',f=>{f.expected.previousFileIds=[f.fileId];}],['old file case variant',f=>{f.expected.previousFileIds=[f.fileId.toUpperCase()];}],
 ['invalid recorded hash',f=>{f.expected.contentSha256='unknown';}],['unbounded content',f=>{f.expected.byteLength=20*1024*1024+1;}],['fractional length',f=>{f.expected.byteLength=7.5;}],
 ['other base',f=>{f.base.data.KnowledgeBaseDetails.KnowledgeBaseId=crypto.randomUUID();}],['base not ready',f=>{f.base.data.KnowledgeBaseDetails.Status='Creating';}],['base read failed',f=>{f.base.ok=false;}],
 ['other portfolio',f=>{f.base.data.KnowledgeBaseDetails.PortfolioKey=crypto.randomUUID();}],['other source',f=>{f.source.data.DataSource.DataSourceId=crypto.randomUUID();}],
 ['non-file source',f=>{f.source.data.DataSource.Type='external';}],['unavailable source',f=>{f.source.data.DataSource.LifeCycleStatus='Creating';}],['source not found',f=>{f.source.data.NotFound_DS=true;}],
 ['other selected stage',f=>{f.expected.screenVariables.SelectedStage.Key=crypto.randomUUID();}],['other selected portfolio',f=>{f.expected.screenVariables.SelectedStage.PortfolioKey=crypto.randomUUID();}],
 ['detail-screen Id substituted',f=>{f.expected.screenVariables.Id=f.fileId;}],['other screen base',f=>{f.expected.screenVariables.KnowledgeBaseId=crypto.randomUUID();}],
 ['incomplete file inventory',f=>{f.files.data.TotalResults='2';}],['duplicate file identity',f=>{f.files.data.Files.List.push({...f.files.data.Files.List[0]});f.files.data.TotalResults='2';}],
 ['wrong file',f=>{f.files.data.Files.List[0].FileId=crypto.randomUUID();}],['wrong filename',f=>{f.files.data.Files.List[0].Filename='business.txt';}],
 ['wrong MIME',f=>{f.files.data.Files.List[0].MimeType='application/pdf';}],['wrong byte length',f=>{f.files.data.Files.List[0].SizeBytes='8';}],['failed file read',f=>{f.files.ok=false;}]
])test('download planning refuses '+name,()=>{const f=fixture();change(f);assert.throws(()=>plan(f),e=>e.code==='KNOWLEDGE_DOWNLOAD_SCOPE_UNVERIFIED');});
test('malformed or missing proof refuses without requesting any URL',()=>{for(const f of [{},{expected:{}},{...fixture(),files:{ok:true,data:{}}},{...fixture(),base:{ok:true}},{...fixture(),source:{ok:true,data:null}},{...fixture(),base:{ok:true,data:{NotFound:false}}},{...fixture(),source:{ok:true,data:{NotFound_DS:false}}}])assert.throws(()=>plan(f),e=>e.code==='KNOWLEDGE_DOWNLOAD_SCOPE_UNVERIFIED');});
