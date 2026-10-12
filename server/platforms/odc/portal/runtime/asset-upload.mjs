import crypto from 'node:crypto';
import {prepareRequest} from './request.mjs';
import {requestBytes,readJson} from './http.mjs';
import {fail} from './errors.mjs';
export const ASSET_UPLOAD='asset-repository-api-v1:post:/uploads';

// Internal transport. Capability URL never leaves the caller's memory. The caller
// owns the durable receipt and must persist each stage before the corresponding send.
export async function stageAssetUpload({bridge,bytes,expectedSha256,onStage}){
 if(typeof onStage!=='function'||!Buffer.isBuffer(bytes)||!bytes.length
   ||crypto.createHash('sha256').update(bytes).digest('hex')!==expectedSha256)
   fail('ASSET_UPLOAD_INVALID','The approved source bytes or durable stage recorder are unavailable.');
 if(!bridge.config.allowedWriteOperations.has(ASSET_UPLOAD))fail('WRITE_BLOCKED','The upload operation is not allowed by the tenant policy.');
 const request=prepareRequest(bridge.catalog,ASSET_UPLOAD,{},bridge.config);
 const token=await bridge.auth.getToken();
 bridge.charge(request.api.id,request.operation);
 await onStage({phase:'upload-request-submitted',sha256:expectedSha256,byteLength:bytes.length});
 let descriptor;
 try{
  const response=await requestBytes(bridge.fetch,request.url,{method:'POST',headers:{accept:'application/json',authorization:'Bearer '+token}},bridge.config);
  if(!response.ok)return {ok:false,state:response.status>=500?'uncertain':'rejected',stage:'upload-request',status:response.status};
  descriptor=readJson(response.bytes);
 }catch{return {ok:false,state:'uncertain',stage:'upload-request'};}
 let url;
 try{url=new URL(descriptor.uploadUrl);}catch{return {ok:false,state:'uncertain',stage:'upload-descriptor'};}
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||url.hostname==='localhost'
   ||url.hostname.endsWith('.localhost')||url.hostname.startsWith('[')||/^\d+(?:\.\d+){3}$/.test(url.hostname))
   return {ok:false,state:'uncertain',stage:'upload-descriptor'};
 await onStage({phase:'upload-put-submitted',sha256:expectedSha256,byteLength:bytes.length});
 try{
  const response=await requestBytes(bridge.fetch,url,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:bytes},bridge.config);
  if(!response.ok)return {ok:false,state:response.status>=500?'uncertain':'rejected',stage:'upload-put',status:response.status};
 }catch{return {ok:false,state:'uncertain',stage:'upload-put'};}
 await onStage({phase:'upload-put-accepted',sha256:expectedSha256,byteLength:bytes.length});
 return {ok:true,fileUri:url.href};
}
