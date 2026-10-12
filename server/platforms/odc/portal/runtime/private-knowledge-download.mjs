import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {withPrivateSessionHandoff} from './private-session-pipe.mjs';
import {readOptions,readCheckpoint} from '../../facade/read-budget.mjs';
import {KNOWLEDGE_FILE_DOWNLOAD_PATH} from './knowledge-file-download-plan.mjs';
import {fail} from './errors.mjs';

export function privateKnowledgeDownloader({host,principal,bridge,requestFile,handoff=withPrivateSessionHandoff}){
 return async(value,options,context,expectedContent)=>{
  const refuse=()=>fail('KNOWLEDGE_DOWNLOAD_UNVERIFIED','Native private download did not return an exact persisted content proof; no remote response is exposed.');
  const url=new URL(value);if(url.origin!=='https://'+host||url.pathname!==KNOWLEDGE_FILE_DOWNLOAD_PATH||url.search||url.hash||url.username||url.password||options.method!=='POST')refuse();
  readCheckpoint('knowledge-download-private');const downloadId=randomUUID(),deadlineAt=Date.now()+Math.min(25000,readOptions().timeoutMs??25000);
  const file=await requestFile({operationId:'knowledgeBases.downloadFile',method:'POST',path:KNOWLEDGE_FILE_DOWNLOAD_PATH,body:options.body,expectedContent,downloadId,confirmTenant:host,deadlineAt});
  const requestSha256=createHash('sha256').update(fs.readFileSync(file)).digest('hex');let answer;
  try{answer=await handoff({host,principal,requestSha256,cookie:context.cookie,csrf:context.csrf},pipeId=>bridge(['portal-private-download',file,pipeId,'--tenant',host]));}catch{refuse();}
  if(answer?.ok!==true&&['PORTAL_AUTH_REQUIRED','PORTAL_ACCESS_DENIED'].includes(answer?.code))fail(answer.code,'The selected native session does not authorize the private file read.',{status:answer.status});
  if(answer?.ok===false&&answer.code==='KNOWLEDGE_DOWNLOAD_UNVERIFIED'){
   const safe={};
   if(['portal-request','portal-response','portal-body','storage-url','storage-request','storage-response','storage-file','storage-hash'].includes(answer.diagnosticStage))safe.diagnosticStage=answer.diagnosticStage;
   for(const key of ['portalStatus','storageStatus'])if(Number.isInteger(answer[key])&&answer[key]>=100&&answer[key]<=599)safe[key]=answer[key];
   if(['uri-shape','signature-date','signature-future','signature-duration','signature-expired','signature-value',...['s3-global','s3-regional','azure-blob','other'].flatMap(x=>['host-'+x+'-plat','host-'+x+'-other'])].includes(answer.storageUrlCheck))safe.storageUrlCheck=answer.storageUrlCheck;
   fail('KNOWLEDGE_DOWNLOAD_UNVERIFIED','Native private download did not verify its persisted content; no remote response is exposed.',safe);
  }
  if(answer?.ok!==true||answer.host!==host||String(answer.user??'').toLowerCase()!==principal.toLowerCase()||answer.status!==200||answer.bodyFile||answer.bodyOmitted||answer.bodyError)refuse();
  const proof=answer.body?.data?.FileDownloadProof,target=path.resolve(path.dirname(file),'..','downloads','knowledge-file-'+downloadId+'.bin');
  if(!proof||proof.downloadId!==downloadId||proof.fileId!==options.body.inputParameters.FileId||proof.filename!==expectedContent.filename||proof.mimeType!==expectedContent.mimeType
   ||proof.byteLength!==expectedContent.byteLength||proof.sha256!==expectedContent.sha256||proof.contentReadBackVerified!==true||proof.ingestionVerified!==false||proof.signedUriExposed!==false
   ||typeof proof.file!=='string'||path.resolve(proof.file).toLowerCase()!==target.toLowerCase())refuse();
  try{const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==expectedContent.byteLength||createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==expectedContent.sha256)refuse();}catch{refuse();}
  readCheckpoint('knowledge-download-persisted');
  const safe=Object.fromEntries(['downloadId','fileId','file','filename','mimeType','byteLength','sha256','contentReadBackVerified','ingestionVerified','signedUriExposed'].map(k=>[k,proof[k]]));
  return{status:200,text:JSON.stringify({data:{FileDownloadProof:safe}})};
 };
}
