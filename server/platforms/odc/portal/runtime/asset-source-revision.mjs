import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ASSET_CREATE} from './asset-creation-approval.mjs';
import {fail} from './errors.mjs';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function cleanCandidateValidation(data){
 if(data?.accepted!==true||data.isValid!==true||!Number.isInteger(data.messages)||data.messages<0)return false;
 if(data.messages===0&&!data.validation)return true;
 const v=data.validation;
 if(!v||['new','unexpected','missingExpected','ambiguous','tolerated'].some(k=>!Array.isArray(v[k])||v[k].length))return false;
 if(!Array.isArray(v.preexisting)||v.preexisting.length!==data.messages)return false;
 if(!data.messages)return true;
 if(!Array.isArray(data.details)||data.details.length!==data.messages||new Set(v.preexisting.map(x=>x.key)).size!==data.messages)return false;
 return v.preexisting.every(x=>x.type==='Warning'&&typeof x.key==='string'&&x.key&&typeof x.id==='string'&&typeof x.detail==='string'&&typeof x.path==='string'
   &&data.details.includes(`Warning ${x.id}: ${x.detail} @ ${x.path}`));
}
function nativeKey(uuid) {
 const hex=uuid.replaceAll('-',''),b=Buffer.from(hex,'hex');
 return Buffer.from([b[3],b[2],b[1],b[0],b[5],b[4],b[7],b[6],...b.subarray(8)]).toString('base64').replaceAll('/','_').replace(/=+$/,'');
}

export async function prepareSourceRevision({input,host,directory,lookup,read}) {
 const {assetKey,expectedRevision,file,expectedSha256,originOperationUuid,authorize,authorizationContext:context}=input;
 const bad=()=>fail('SOURCE_REVISION_INVALID','The source proof, creation receipt or revision does not match. Nothing was sent.');
 const uploadFormat=input.uploadFormat??'binary';
 if(!['binary','multipart','source-uri','staged'].includes(uploadFormat)||uploadFormat==='source-uri'&&input.candidateProof)bad();
 if(!Number.isInteger(expectedRevision)||expectedRevision<1||typeof file!=='string'||!path.isAbsolute(file))bad();
 const root=fs.realpathSync(directory),actual=fs.realpathSync(file),relative=path.relative(root,actual);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||relative.includes(path.sep))bad();
 if(fs.statSync(actual).size>8*1024*1024)fail('REQUEST_TOO_LARGE','Source exceeds the direct-upload limit. Nothing was sent.');
 const bytes=fs.readFileSync(actual),sha=crypto.createHash('sha256').update(bytes).digest('hex');
 const evidence=JSON.parse(fs.readFileSync(actual+'.json','utf8'));
 if(sha!==expectedSha256||evidence.sha256!==sha||evidence.assetKey!==assetKey||evidence.revisionNumber!==expectedRevision
   ||evidence.byteLength!==bytes.length||bytes.subarray(0,3).toString()!=='OML')bad();
 const origin=lookup(originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
   ||origin.identity.operationId!==ASSET_CREATE||origin.response?.assetKey!==assetKey||!origin.authorization?.source)bad();
 const current=await read(assetKey);
 if(!current?.ok||current.data?.assetKey!==assetKey||current.data.revision!==expectedRevision)
   fail('REVISION_BASE_CHANGED','The latest asset revision differs from the expected source revision. Nothing was sent.');
 let payload=bytes,candidateBinding={};
 if(input.candidateProof){
   const proofFile=path.resolve(input.candidateProof);
   if(fs.statSync(proofFile).size>1024*1024)bad();
   const proofBytes=fs.readFileSync(proofFile),proof=JSON.parse(proofBytes),a=proof.artifacts,d=proof.data;
   if(proof.ok!==true||!cleanCandidateValidation(d)||a?.schema!=='ssam-job-artifacts/1'
     ||a.lane!=='odc'||a.moduleKey!==nativeKey(assetKey)||d.handles?.['@espace']!==a.moduleKey
     ||a.base?.sha256!==sha||a.candidate?.sha256!==input.candidateSha256
     ||path.resolve(d.outPath)!==path.resolve(a.candidate.file))bad();
   for(const item of [a.base,a.job,a.candidate]){
     if(!path.isAbsolute(item.file)||fs.statSync(item.file).size>8*1024*1024||digest(fs.readFileSync(item.file))!==item.sha256)bad();
   }
   payload=fs.readFileSync(a.candidate.file);
   if(digest(payload)!==input.candidateSha256||payload.subarray(0,3).toString()!=='OML'||digest(payload)===sha)bad();
   candidateBinding={candidateSha256:input.candidateSha256,candidateProofSha256:digest(proofBytes)};
 }else if(input.candidateSha256)bad();
 const approval=authorizationContext(context,authorize,{lane:'odc',host,operation:ASSET_CREATE,targets:[current.data.name],
   constraints:{assetKey,expectedRevision,sourceSha256:sha,originOperationUuid,...candidateBinding,...(uploadFormat!=='binary'?{uploadFormat}: {})}});
 if(!approval||approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId)bad();
 const binary={$base64:payload.toString('base64')};
 return {approval,assetKey,expectedRevision,uploadFormat,
   body:uploadFormat==='multipart'?{creationRequest:{},assetFile:{...binary,filename:'source.oml'}}:binary,
   contentType:uploadFormat==='multipart'?'multipart/form-data':'application/octet-stream'};
}
