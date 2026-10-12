import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {withPrivateSessionHandoff} from './private-session-pipe.mjs';
import {readOptions,readCheckpoint} from '../../facade/read-budget.mjs';
import {fail} from './errors.mjs';
export const MOBILE_FILE_DOWNLOAD='mobileExtensibility.downloadFile';
export const MOBILE_FILE_DOWNLOAD_PATH='/apps/screenservices/apps/ApplicationMobile/extensibillitysetting/DataActionGetExtensibilitySettingInfo';
export function privateMobileDownloader({host,principal,bridge,requestFile,handoff=withPrivateSessionHandoff}){
 return async(value,options,context,expectedContent)=>{
  const bad=()=>fail('MOBILE_DOWNLOAD_UNVERIFIED','Private persisted content did not verify; no URL or remote response is exposed.');
  const url=new URL(value);if(url.origin!=='https://'+host||url.pathname!==MOBILE_FILE_DOWNLOAD_PATH||url.search||url.hash||url.username||url.password||options.method!=='POST')bad();
  readCheckpoint('mobile-download-private');const downloadId=randomUUID(),deadlineAt=Date.now()+Math.min(25000,readOptions().timeoutMs??25000);
  const file=await requestFile({operationId:MOBILE_FILE_DOWNLOAD,method:'POST',path:MOBILE_FILE_DOWNLOAD_PATH,body:options.body,expectedContent,downloadId,confirmTenant:host,deadlineAt});
  const requestSha256=createHash('sha256').update(fs.readFileSync(file)).digest('hex');let answer;
  try{answer=await handoff({host,principal,requestSha256,cookie:context.cookie,csrf:context.csrf},pipeId=>bridge(['portal-private-download',file,pipeId,'--tenant',host]));}catch{bad();}
  if(answer?.ok===false&&['setting-request','content-request'].includes(answer.diagnosticStage)&&[401,403].includes(answer.portalStatus))
   fail(answer.portalStatus===401?'PORTAL_AUTH_REQUIRED':'PORTAL_ACCESS_DENIED','The selected session does not authorize the private file read.',{status:answer.portalStatus});
  if(answer?.ok===false){const safe={};if(['setting-request','setting-scope','content-request','content-hash','content-mime','content-save'].includes(answer.diagnosticStage))safe.diagnosticStage=answer.diagnosticStage;if(Number.isInteger(answer.portalStatus)&&answer.portalStatus>=100&&answer.portalStatus<=599)safe.portalStatus=answer.portalStatus;
   if(/^OS-[A-Z0-9]{2,8}-[A-Z0-9]{2,12}$/.test(answer.portalErrorCode??''))safe.portalErrorCode=answer.portalErrorCode;
   if(['inline-string','inline-object','url-or-empty-object','missing','unsupported'].includes(answer.binaryWireKind))safe.binaryWireKind=answer.binaryWireKind;
   if(Number.isInteger(answer.observedByteLength)&&answer.observedByteLength>=0&&answer.observedByteLength<=1048576)safe.observedByteLength=answer.observedByteLength;
   if(typeof answer.contentHashMatches==='boolean')safe.contentHashMatches=answer.contentHashMatches;
   fail('MOBILE_DOWNLOAD_UNVERIFIED','Private persisted content did not verify; no URL or remote response is exposed.',safe);}
  if(answer?.ok!==true||answer.host!==host||String(answer.user??'').toLowerCase()!==principal.toLowerCase()||answer.status!==200||answer.bodyFile||answer.bodyOmitted||answer.bodyError)bad();
  const proof=answer.body?.data?.FileDownloadProof,vars=options.body.screenData.variables,target=path.resolve(path.dirname(file),'..','downloads','mobile-file-'+downloadId+'.bin');
  if(!proof||proof.downloadId!==downloadId||proof.applicationKey!==vars.appid||proof.environmentKey!==vars.stageid||proof.settingKey!==vars.id||proof.filename!==expectedContent.filename
   ||proof.byteLength!==expectedContent.byteLength||proof.sha256!==expectedContent.sha256||proof.contentReadBackVerified!==true||proof.persistedObjectVerified!==true||proof.signedUriExposed!==false
   ||typeof proof.mimeType!=='string'||!proof.mimeType||proof.mimeType.length>128||/[\x00-\x1f\x7f]/.test(proof.mimeType)||typeof proof.file!=='string'||path.resolve(proof.file).toLowerCase()!==target.toLowerCase())bad();
  const library=vars.libraryid??'';
  if(library?proof.libraryKey!==library||proof.libraryRevision!==expectedContent.libraryRevision:proof.libraryKey!==undefined||proof.libraryRevision!==undefined)bad();
  try{const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==expectedContent.byteLength||createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==expectedContent.sha256)bad();}catch{bad();}
  readCheckpoint('mobile-download-persisted');
  const safe=Object.fromEntries(['downloadId','applicationKey','environmentKey','settingKey','file','filename','mimeType','byteLength','sha256','contentReadBackVerified','persistedObjectVerified','signedUriExposed',...(library?['libraryKey','libraryRevision']:[])].map(k=>[k,proof[k]]));
  return{status:200,text:JSON.stringify({data:{FileDownloadProof:safe}})};
 };
}
