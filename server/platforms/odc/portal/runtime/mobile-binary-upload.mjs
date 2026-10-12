import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
import {fingerprint,isUuid} from './write-journal.mjs';
import {extensibilityStateHash} from './mobile-extensibility.mjs';
import {binarySetting,ownedBinaryLibrary,binaryLibraryConstraints,binaryNativeLibraryMatches} from './mobile-binary-library.mjs';
import {mobileBinaryTransport} from './mobile-binary-transport.mjs';
export const MOBILE_FILE_UPLOAD='mobileExtensibility.uploadFile';
export const MOBILE_FILE_CONVERT='mobileExtensibility.convertFile';
export const MOBILE_FILE_SAVE='mobileExtensibility.saveFile';
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Binary upload requires an owned mobile fixture, exact binary setting, current state and approved content. Nothing was sent.');
export function mobileBinaryUploadTarget(file){
 let c;try{if(fs.statSync(file).size>32768)bad();c=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(!['applicationKey','environmentKey','settingKey'].every(k=>isUuid(c?.[k])))bad();
 return {applicationKey:c.applicationKey,environmentKey:c.environmentKey,settingKey:c.settingKey,...(c.libraryKey?{libraryKey:c.libraryKey}:{})};
}
export function mobileBinaryContent(value){
 if(typeof value!=='string'||!value.length||value.length>1398104||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))bad();
 const bytes=Buffer.from(value,'base64');if(!bytes.length||bytes.length>1048576||bytes.toString('base64')!==value)bad();
 return {contentSha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length};
}
export async function mobileBinaryUploadApproval({file,words,host,raw,lookup,read,portalRead,secretRefs=[],operationId=MOBILE_FILE_UPLOAD}){
 const conversion=operationId===MOBILE_FILE_CONVERT,key=conversion?'BinaryData':'FileContent';
 if(![MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT].includes(operationId))bad();
 let limits;try{if(fs.statSync(file).size>32768)bad();limits=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(!limits||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length
  ||Object.keys(raw.inputParameters??{}).join(',')!==key||!isUuid(limits.originOperationUuid)
  ||!['applicationKey','environmentKey','settingKey','portfolioKey'].every(k=>isUuid(limits[k])))bad();
 const origin=lookup(limits.originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
  ||origin.identity.operationId!=='asset-repository-api-v1:post:/assets'||origin.response?.assetKey!==limits.applicationKey||!origin.authorization?.source)bad();
 const asset=await read('asset-repository-api-v1:get:/assets/{assetKey}',{assetKey:limits.applicationKey});
 if(!asset?.ok||asset.data?.assetKey!==limits.applicationKey||asset.data.assetType!=='MobileApplication'||asset.data.portfolioKey!==limits.portfolioKey)bad();
 const library=await ownedBinaryLibrary({scope:limits,origin,host,lookup,read});
 const current=await read('native-application-orchestration-service-api-v1:get:/environments/{environmentKey}/applications/{applicationKey}/configurations/extensibility-settings',{applicationKey:limits.applicationKey,environmentKey:limits.environmentKey});
 const field=binarySetting(current?.data,limits);
 if(!current?.ok||field?.dataType!=='BinaryUrl'||typeof field.isSecret!=='boolean'||!['Default','Override'].includes(field.valueOrigin))bad();
 if(field.isSecret){
  if(raw.inputParameters[key]!==''||secretRefs.length!==1||secretRefs[0].pointer!=='/inputParameters/'+key
   ||secretRefs[0].field!=='password'||!secretRefs[0].target.startsWith('SSAM/ODC3/'+host+'/Setting/')
   ||!/^[a-f0-9]{64}$/.test(limits.contentSha256??'')||!Number.isSafeInteger(limits.byteLength)||limits.byteLength<1||limits.byteLength>1048576)bad();
 }else if(secretRefs.length)bad();
 const screenVariables={appid:limits.applicationKey,stageid:limits.environmentKey,ActivePortfolioKey:limits.portfolioKey,_appidInDataFetchStatus:1,_stageidInDataFetchStatus:1};
 const stages=await portalRead('mobileExtensibility.stages',{screenVariables});
 const transport=mobileBinaryTransport(stages,limits);
 if(conversion!==(transport.mode==='base64'))fail('MOBILE_BINARY_TRANSPORT_MISMATCH','The requested native action does not match the observed stage transport flag. The corporate flag was not changed. Nothing was sent.');
 if(field.isSecret){
  const native=await portalRead('mobileExtensibility.setting',{screenVariables:{appid:limits.applicationKey,stageid:limits.environmentKey,ActivePortfolioKey:limits.portfolioKey,id:limits.settingKey,libraryid:limits.libraryKey??''}});
  const max=native.data?.BinarySetting_Secret_MaxFileSize;
  if(!native.ok||native.data.NotFound!==false||!binaryNativeLibraryMatches(native.data.ExtensibilitySettingInfo,limits)||native.data.ExtensibilitySettingInfo?.Setting?.Key!==limits.settingKey
   ||native.data.ExtensibilitySettingInfo.Setting.IsSecret!==true||!Number.isFinite(Number(max))||Number(max)<=0||limits.byteLength>Number(max)*1024)bad();
 }
 const content=field.isSecret?{contentSha256:limits.contentSha256,byteLength:limits.byteLength}:mobileBinaryContent(raw.inputParameters[key]);
 const constraints={originOperationUuid:limits.originOperationUuid,applicationKey:limits.applicationKey,environmentKey:limits.environmentKey,settingKey:limits.settingKey,portfolioKey:limits.portfolioKey,
  ...binaryLibraryConstraints(limits),inputSha256:fingerprint(raw.inputParameters),expectedConfigurationSha256:extensibilityStateHash(current.data),...content,
  ...(conversion?{transportMode:'base64'}:{}),...(field.isSecret?{isSecret:true,secretRefsSha256:fingerprint(secretRefs)}:{})};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,environmentKey:limits.environmentKey,targets:[asset.data.name,...(library?[library.name]:[]),field.name],constraints});
 if(!approval||approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId)bad();
 return {approval,expected:constraints};
}
export function binaryDownloadUrl(value){
 if(typeof value!=='string'||value.length>8192||/\[REDACTED\]|%5BREDACTED%5D/i.test(value))return null;
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash?u.href:null;}catch{return null;}
}
export function mobileUploadObservation(expected,data,operationUuid){
 if(expected.transportMode==='base64'){
  const p=data?.UploadProof;
  if(p?.transportMode!=='base64'||p.uploadOperationUuid!==operationUuid||p.objectUri!=='urn:ssam:mobile-base64:'+operationUuid
   ||p.contentVerified!==true||p.signedUriExposed!==false||p.contentSha256!==expected.contentSha256||p.byteLength!==expected.byteLength)return null;
  return {uploadOperationUuid:operationUuid,objectUri:p.objectUri,transportMode:'base64',contentSha256:p.contentSha256,byteLength:p.byteLength,contentVerified:true,signedUriExposed:false};
 }
 const p=data?.UploadProof,url=binaryDownloadUrl(p?.objectUri);
 if(!p||p.uploadOperationUuid!==operationUuid||p.contentVerified!==true||p.signedUriExposed!==false
  ||p.contentSha256!==expected.contentSha256||p.byteLength!==expected.byteLength||!url
  ||new URL(url).search||!/^https:\/\/plat-[a-z0-9]{1,58}\.s3\.[a-z0-9-]+\.amazonaws\.com\/tenants\/uploads\/[a-f0-9-]{36}$/.test(url))return null;
 return {uploadOperationUuid:operationUuid,objectUri:url,contentSha256:p.contentSha256,byteLength:p.byteLength,contentVerified:true,signedUriExposed:false};
}
export function binaryPatchProvenance({body,current}){
 const groups=[{items:body.settings??[],rows:current.settings}];
 for(const library of body.libraries??[]){
  const row=current.libraries?.find(x=>x.key===library.key);
  if(!row)bad();groups.push({items:library.settings??[],rows:row.settings});
 }
 const binary=groups.flatMap(({items,rows})=>items.filter(x=>rows?.find(r=>r.key===x.key)?.dataType==='BinaryUrl'));
 for(const item of binary){
  if(!Object.hasOwn(item,'value'))bad();
  if(item.value===null){if(item.metadata!==null&&(!Array.isArray(item.metadata)||item.metadata.length))bad();continue;}
  // Signed upload capabilities stay inside Studio; use the opaque save receipt.
  bad();
 }
 if(binary.length>1)bad();
 return binary.length>0;
}
