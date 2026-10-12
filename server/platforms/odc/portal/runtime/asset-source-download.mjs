import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareRequest} from './request.mjs';
import {requestBytes,readJson} from './http.mjs';
import {fail} from './errors.mjs';
import {validateSolutionPackage} from '../../facade/service-center/solution-package.mjs';
import {nativeBuildScope} from './operation-receipt.mjs';
export const SOURCE_CODE='asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}/source-code';

// Internal only: never return this capability URL from a tool or persist it in evidence.
export async function verifiedSourceUri({bridge,assetKey,revisionNumber,expectedSha256}) {
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(assetKey??'')
   ||!Number.isInteger(revisionNumber)||revisionNumber<1||!/^[a-f0-9]{64}$/.test(expectedSha256??''))
   fail('INPUT_INVALID','Source URI requires an exact asset revision and SHA256.');
 return downloadDescriptor({bridge,operationId:SOURCE_CODE,parameters:{assetKey,revisionNumber},
   urlField:'sourceCodeBinaryUrl',expectedSha256});
}

// Signed locations remain inside the transport; OAuth is sent only to the tenant.
export async function downloadAssetSource({bridge,assetKey,revisionNumber,directory,kind='source'}) {
 if(typeof assetKey!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(assetKey)
  ||!Number.isInteger(revisionNumber)||revisionNumber<1)fail('INPUT_INVALID','Source download requires an asset UUID and a positive revision.');
 const variants={source:{route:'source-code',field:'sourceCodeBinaryUrl',digest:'sourceCodeDigest'},
   icon:{route:'icon',field:'iconUrl',digest:'iconDigest'},signature:{route:'signature',field:'signatureBinaryUrl',digest:'signatureDigest'}};
 const variant=Object.hasOwn(variants,kind)?variants[kind]:null;
 if(!variant)fail('INPUT_INVALID','Asset download kind must be source, icon or signature.');
 return downloadDescriptor({bridge,directory,operationId:'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}/'+variant.route,parameters:{assetKey,revisionNumber},
  urlField:variant.field,digestField:variant.digest,identity:{assetKey,revisionNumber,kind},prefix:assetKey+'-r'+revisionNumber,extension:'.bin'});
}
export async function downloadGeneratedCode({bridge,buildKey,directory}) {
 if(typeof buildKey!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(buildKey))fail('INPUT_INVALID','Generated code requires a build UUID.');
 return downloadDescriptor({bridge,directory,operationId:'build-operations-api-v1:get:/build-operations/{operationKey}/generated-code',parameters:{operationKey:buildKey},
  urlField:'uri',identity:{buildKey},prefix:buildKey,extension:'.zip',requireFinished:true});
}
export async function downloadNativePackage({bridge,directory,receipt,operationKey}) {
 const target=receipt?.identity?.target;
 if(receipt?.state!=='confirmed'||receipt.identity?.operationId!=='native-application-orchestration-service-api-v1:post:/build-operations'
  ||receipt.response?.key!==operationKey||!['Android','iOS'].includes(target?.mobilePlatform))
  fail('OPERATION_RECEIPT_MISMATCH','A confirmed receipt for this native build is required.');
 return downloadDescriptor({bridge,directory,
  operationId:'native-application-orchestration-service-api-v1:get:/build-operations/{operationKey}',parameters:{operationKey},
  query:nativeBuildScope(receipt),
  urlField:'appBinaryDownloadUrl',identity:{operationKey,...target},prefix:operationKey,
  extension:target.mobilePlatform==='Android'?'.apk':'.zip',requireFinished:true,
  verifyDescriptor:data=>{
   if(data.key!==operationKey||['applicationKey','buildKey','revision','mobilePlatform','mobileVersionNumber','mobileVersionCode'].some(k=>target[k]===undefined||data[k]!==target[k]))
    fail('OPERATION_IDENTITY_UNVERIFIED','Native package descriptor does not match the confirmed build.');
  },verifyBinary:bytes=>{
   try{return validateSolutionPackage(bytes);}catch{fail('NATIVE_PACKAGE_INVALID','The native package is not an intact supported ZIP archive.');}
  }});
}
async function downloadDescriptor({bridge,directory,operationId,parameters,query,urlField,identity,prefix,extension,requireFinished=false,expectedSha256,digestField='sourceCodeDigest',verifyDescriptor,verifyBinary}) {
 const request=prepareRequest(bridge.catalog,operationId,{path:parameters,...(query?{query}:{})},bridge.config);
 const token=await bridge.auth.getToken();
 bridge.charge(request.api.id,request.operation);
 const descriptor=await requestBytes(bridge.fetch,request.url,{method:'GET',headers:{accept:'application/json',authorization:'Bearer '+token}},bridge.config);
 if(!descriptor.ok)fail('SOURCE_DESCRIPTOR_FAILED','The source descriptor could not be read.',{status:descriptor.status});
 const data=readJson(descriptor.bytes);
 verifyDescriptor?.(data);
 if(requireFinished && (data.status!=='Finished'||(data.errors??[]).some(x=>x.severity==='Error')))
  fail('GENERATED_CODE_NOT_READY','Generated code packaging is not successfully finished.',{status:data.status??null});
 let url;
 try {url=new URL(data[urlField]);}catch{fail('SOURCE_LOCATION_INVALID','No valid source download location was returned.');}
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash
   ||url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname.startsWith('[')
   ||/^\d+(?:\.\d+){3}$/.test(url.hostname))fail('SOURCE_LOCATION_INVALID','The source download location is not an HTTPS service hostname.');
 const binary=await requestBytes(bridge.fetch,url,{method:'GET',headers:{accept:'application/octet-stream'}},bridge.config,64*1024*1024);
 if(!binary.ok)fail('SOURCE_DOWNLOAD_FAILED','The source download failed.',{status:binary.status});
 if(!binary.bytes.length)fail('SOURCE_DOWNLOAD_EMPTY','An empty response is not source code.');
 if(requireFinished && binary.bytes.subarray(0,2).toString()!=='PK')fail('GENERATED_CODE_INVALID','Generated code did not return a ZIP archive.');
 const mediaType=binary.headers.get('content-type')??'';
 if(/(?:text\/html|application\/(?:problem\+)?json)/i.test(mediaType))fail('SOURCE_DOWNLOAD_INVALID','The source endpoint returned a document instead of an asset binary.');
 const integrity=verifyBinary?.(binary.bytes);
 if(expectedSha256){
   if(crypto.createHash('sha256').update(binary.bytes).digest('hex')!==expectedSha256 || binary.bytes.subarray(0,3).toString()!=='OML')
     fail('SOURCE_HASH_CHANGED','The remote source does not match the approved source bytes. Nothing was sent.');
   return url.href;
 }
 fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,prefix+'-'+crypto.randomUUID()+extension);
 fs.writeFileSync(file,binary.bytes,{flag:'wx'});
 const evidence={...identity,file,byteLength:binary.bytes.length,
  ...(integrity?{integrity}:{}),
  sha256:crypto.createHash('sha256').update(binary.bytes).digest('hex'),mediaType,
  [digestField]:typeof data[digestField]==='string'?data[digestField]:null,observedAt:new Date().toISOString()};
 fs.writeFileSync(file+'.json',JSON.stringify(evidence,null,2),{flag:'wx'});
 return {ok:true,...evidence};
}
