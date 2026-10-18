import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import path from 'node:path';
import {OdcAccess} from '../runtime/access.mjs';import {KB_CREATE} from '../runtime/knowledge-base.mjs';import {KB_UPLOAD} from '../runtime/knowledge-file-upload.mjs';
const host='personal-test.outsystems.dev',uuid=()=>crypto.randomUUID();
function fixture(){const uploadId=uuid(),originId=uuid(),fileId=uuid(),baseId=uuid(),sourceId=uuid(),stageId=uuid(),portfolioKey=uuid(),downloadId=uuid();let downloads=0,reconciliations=0,reads=[];
 const authorization={wordsSha256:'a'.repeat(64),proposalSha256:'b'.repeat(64),source:{threadId:uuid(),messageId:uuid()}};
 const origin={operationUuid:originId,state:'confirmed',identity:{tenant:host,operationId:KB_CREATE},response:{KnowledgeBaseId:baseId},reconciliation:{knowledgeBase:{name:'OwnBase'}},authorization:structuredClone(authorization)};
 const expected={originOperationUuid:originId,knowledgeBaseId:baseId,dataSourceId:sourceId,environmentKey:stageId,filename:'proof.txt',mimeType:'text/plain',byteLength:7,contentSha256:'c'.repeat(64),previousFileIds:[],screenVariables:{ActivePortfolioKey:portfolioKey}};
 const receipt={operationUuid:uploadId,state:'uncertain',identity:{tenant:host,operationId:KB_UPLOAD},authorization:structuredClone(authorization),reconciliation:{knowledgeFile:expected},response:{}};
 const answers={
  'knowledgeBases.detail':{ok:true,data:{NotFound:false,KnowledgeBaseDetails:{KnowledgeBaseId:baseId,Name:'OwnBase',PortfolioKey:portfolioKey,Status:'Ready'}}},
  'knowledgeBases.dataSources':{ok:true,data:{DataSources:{List:[{DataSourceId:sourceId,Name:'OwnSource'}]}}},
  'knowledgeBases.sourceStages':{ok:true,data:{NotFound_KB:false,KnowledgeBaseDetails:{Name:'OwnBase',PortfolioKey:portfolioKey},Environments:{List:[{Key:stageId,PortfolioKey:portfolioKey,Name:'Development'}]}}},
  'knowledgeBases.dataSource':{ok:true,data:{NotFound_DS:false,DataSource:{DataSourceId:sourceId,Name:'OwnSource',Type:'upload_files',LifeCycleStatus:'Available'}}},
  'knowledgeBases.files':{ok:true,data:{Files:{List:[{FileId:fileId,Filename:'proof.txt',MimeType:'text/plain',SizeBytes:'7',Status:'Indexed',ChunkCount:0,VectorCount:0}]},TotalResults:'1',MaxRecords:12}}};
 const proof={downloadId,fileId,filename:expected.filename,mimeType:expected.mimeType,byteLength:7,sha256:expected.contentSha256,file:path.resolve('journal/portal/downloads/knowledge-file-'+downloadId+'.bin'),contentReadBackVerified:true,ingestionVerified:false,signedUriExposed:false};
 const receipts={lookup:key=>key===uploadId?receipt:key===originId?origin:null,reconcile:(r,{state,observation})=>{reconciliations++;r.state=state;r.observation=observation;return r;}};
 const access=new OdcAccess({receipts});access.resolvePortal=async(h,a)=>{assert.equal(h,host);assert.equal(a,'auto');return resolved;};
 const resolved={path:'profile',privateKnowledgeDownload:()=>{},broker:{downloadKnowledgeFile:async args=>{downloads++;assert.equal(args.input.inputParameters.DataSourceId,sourceId);assert.equal(args.input.inputParameters.FileId,fileId);assert.equal(args.input.inputParameters.OverrideBaseURL,'');assert.equal(args.expectedContent.sha256,expected.contentSha256);return{data:{FileDownloadProof:proof}};}}};
 access.portalRead=async args=>{assert.equal(args.tenant,host);reads.push(args.operationId);return structuredClone(answers[args.operationId]);};
 const invoke=(input={uploadOperationUuid:uploadId,fileId})=>OdcAccess.prototype.portalRead.call(access,{tenant:host,auth:'auto',operationId:'knowledgeBases.downloadFile',input});
 return{invoke,access,origin,receipt,expected,answers,proof,resolved,uploadId,fileId,get downloads(){return downloads;},get reconciliations(){return reconciliations;},get reads(){return reads;}};
}
test('public read validates five fresh scopes then confirms lost upload by independently verified private bytes',async()=>{
 const f=fixture();f.proof.Url='https://private.test/?secret';const result=await f.invoke();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.downloads,1);assert.equal(f.reconciliations,1);assert.equal(f.receipt.state,'confirmed');
 assert.deepEqual(f.reads,['knowledgeBases.detail','knowledgeBases.dataSources','knowledgeBases.sourceStages','knowledgeBases.dataSource','knowledgeBases.files']);assert.equal(result.ingestionVerified,false);assert.equal(result.data.FileDownloadProof.sha256,f.expected.contentSha256);assert(!JSON.stringify(result).includes('private.test'));assert.equal(f.receipt.response.uploadAccepted,undefined);
});
for(const [name,change]of [
 ['foreign tenant',f=>{f.receipt.identity.tenant='other.outsystems.dev';}],['wrong operation',f=>{f.receipt.identity.operationId='other';}],['rejected upload',f=>{f.receipt.state='rejected';}],
 ['legacy missing ownership',f=>{delete f.expected.originOperationUuid;}],['unconfirmed base origin',f=>{f.origin.state='accepted';}],['other base origin',f=>{f.origin.response.KnowledgeBaseId=uuid();}],
 ['different grant',f=>{f.receipt.authorization.source.messageId=uuid();}],['missing words binding',f=>{delete f.origin.authorization.wordsSha256;delete f.receipt.authorization.wordsSha256;}],['missing proposal binding',f=>{delete f.origin.authorization.proposalSha256;delete f.receipt.authorization.proposalSha256;}],['different words',f=>{f.receipt.authorization.wordsSha256='d'.repeat(64);}],['different proposal',f=>{f.receipt.authorization.proposalSha256='d'.repeat(64);}],
 ['missing native capability',f=>{delete f.resolved.privateKnowledgeDownload;}],['base renamed',f=>{f.answers['knowledgeBases.detail'].data.KnowledgeBaseDetails.Name='Other';}],
 ['other source',f=>{f.answers['knowledgeBases.dataSources'].data.DataSources.List[0].DataSourceId=uuid();}],['other stage',f=>{f.answers['knowledgeBases.sourceStages'].data.Environments.List[0].Key=uuid();}],
 ['source unavailable',f=>{f.answers['knowledgeBases.dataSource'].data.DataSource.LifeCycleStatus='Creating';}],['partial files',f=>{f.answers['knowledgeBases.files'].data.TotalResults='2';}],
 ['wrong file bytes metadata',f=>{f.answers['knowledgeBases.files'].data.Files.List[0].SizeBytes='8';}]
])test('owned download refuses '+name+' before requesting a URL',async()=>{const f=fixture();change(f);const r=await f.invoke();assert.equal(r.ok,false);assert.equal(f.downloads,0);assert.equal(f.reconciliations,0);});
test('caller cannot override scope, hash, path or raw native inputs',async()=>{const f=fixture();for(const extra of [{sha256:'forged'},{path:'other'},{inputParameters:{}},{tenant:'other'}]){const r=await f.invoke({uploadOperationUuid:f.uploadId,fileId:f.fileId,...extra});assert.equal(r.ok,false);}assert.equal(f.downloads,0);assert.equal(f.reads.length,0);});
test('native content mismatch never confirms the original upload',async()=>{const f=fixture();f.proof.sha256='d'.repeat(64);const r=await f.invoke();assert.equal(r.ok,false);assert.equal(f.reconciliations,0);assert.equal(f.receipt.state,'uncertain');});
