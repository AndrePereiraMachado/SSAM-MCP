import fs from 'node:fs';import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';import {fingerprint,isUuid} from './write-journal.mjs';
import {extensibilityStateHash} from './mobile-extensibility.mjs';
import {MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT,MOBILE_FILE_SAVE,mobileUploadObservation} from './mobile-binary-upload.mjs';
import {mobileBinaryTransport} from './mobile-binary-transport.mjs';
import {binarySetting,ownedBinaryLibrary,binaryLibraryConstraints,binaryNativeLibraryMatches} from './mobile-binary-library.mjs';
export const MOBILE_EXTENSIBILITY_GET='native-application-orchestration-service-api-v1:get:/environments/{environmentKey}/applications/{applicationKey}/configurations/extensibility-settings';
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Native binary save requires its confirmed own upload, exact current setting and opaque private URI binding. Nothing was sent.');
export async function mobileBinarySaveApproval({file,words,host,raw,lookup,read,portalRead}){
 let constraints;try{if(fs.statSync(file).size>32768)bad();constraints=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(!isUuid(constraints?.uploadOperationUuid)||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)bad();
 const upload=lookup(constraints.uploadOperationUuid),e=upload?.reconciliation?.mobileBinaryUpload;
 const proof=e&&mobileUploadObservation(e,{UploadProof:upload.response?.mobileUploadProof},constraints.uploadOperationUuid);
 if(!upload||upload.identity?.tenant!==host||upload.identity.operationId!==(e?.transportMode==='base64'?MOBILE_FILE_CONVERT:MOBILE_FILE_UPLOAD)||upload.state!=='confirmed'||!proof||!upload.authorization?.source)bad();
 const p=raw.inputParameters,info=p?.ExtensibilitySettingInfo,meta=info?.Setting?.Metadata;
 if(!p||Object.keys(p).sort().join(',')!=='ApplicationKey,EnvironmentKey,ExtensibilitySettingInfo,RequiresDecoding'
  ||p.ApplicationKey!==e.applicationKey||p.EnvironmentKey!==e.environmentKey||p.RequiresDecoding!==false
  ||!meta||Object.keys(meta).sort().join(',')!=='Filetype,Name'||typeof meta.Name!=='string'
  ||!/^[A-Za-z0-9_.-]{1,128}$/.test(meta.Name)||!/^[A-Za-z0-9]{1,16}$/.test(meta.Filetype))bad();
 const asset=await read('asset-repository-api-v1:get:/assets/{assetKey}',{assetKey:e.applicationKey});
 if(!asset.ok||asset.data?.assetKey!==e.applicationKey||asset.data.assetType!=='MobileApplication'||asset.data.portfolioKey!==e.portfolioKey)bad();
 const library=await ownedBinaryLibrary({scope:e,origin:lookup(e.originOperationUuid),host,lookup,read});
 const current=await read(MOBILE_EXTENSIBILITY_GET,{applicationKey:e.applicationKey,environmentKey:e.environmentKey});
 const field=binarySetting(current.data,e);
 if(!current.ok||field?.dataType!=='BinaryUrl'||field.isSecret!==(e.isSecret===true))bad();
 const screenVariables={appid:e.applicationKey,stageid:e.environmentKey,ActivePortfolioKey:e.portfolioKey,id:e.settingKey,libraryid:e.libraryKey??''};
 if(e.transportMode==='base64'){
  const stages=await portalRead('mobileExtensibility.stages',{screenVariables});
  if(mobileBinaryTransport(stages,e).mode!=='base64')bad();
 }
 const native=await portalRead('mobileExtensibility.setting',{screenVariables});
 const observed=native.data?.ExtensibilitySettingInfo;
 if(!native.ok||native.data.NotFound!==false||!binaryNativeLibraryMatches(observed,e)||observed.Setting?.Key!==e.settingKey
  ||observed.Setting.DataType!=='BinaryUrl'||observed.Setting.Name!==field.name)bad();
 const expected=structuredClone(observed);Object.assign(expected.Setting,{Value:'',ValueOrigin:'Override',IsSecret:field.isSecret,Metadata:meta});
 if(fingerprint(expected)!==fingerprint(info))bad();
 const approved=authorizationContext(file,words,{lane:'odc',host,operation:MOBILE_FILE_SAVE,environmentKey:e.environmentKey,targets:[asset.data.name,...(library?[library.name]:[]),field.name],
  constraints:{uploadOperationUuid:constraints.uploadOperationUuid,originOperationUuid:e.originOperationUuid,...binaryLibraryConstraints(e),inputSha256:fingerprint(p),expectedConfigurationSha256:extensibilityStateHash(current.data)}});
 if(!approved||approved.source.threadId!==upload.authorization.source.threadId||approved.source.messageId!==upload.authorization.source.messageId)bad();
 return {approval:approved,expected:{...e,uploadOperationUuid:constraints.uploadOperationUuid,objectUri:proof.objectUri,metadata:structuredClone(meta),screenVariables}};
}
export function mobileBinarySaveObservation(expected,publicRead,nativeRead){
 let field;try{field=binarySetting(publicRead?.data,expected);}catch{return {verified:false,reason:'binary-library-scope-not-observed'};}
 const info=nativeRead?.data?.ExtensibilitySettingInfo,n=info?.Setting;
 // Read URLs have deliberately redacted signatures. Compare only their public
 // object identity; content was independently downloaded inside the bridge.
 const publicUri=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash?u.origin+u.pathname:null;}catch{return null;}};
 // Native save copies the temporary upload into the configuration object's
 // scoped path. Its signed URL is deliberately different from the upload URL.
 let persistedUri;try{
  const suffix='/nativeapporchestration/configurations/management/'+expected.environmentKey+'/binaries/'+expected.applicationKey+'/'+expected.settingKey;
  if(expected.transportMode==='base64'){
   const observed=publicUri(n?.Value),url=new URL(observed);
   if(!/^plat-[a-z0-9]{1,58}\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)||url.port||url.pathname!==suffix)throw new Error();
   persistedUri=observed;
  }else persistedUri=new URL(expected.objectUri).origin+suffix;
 }catch{if(expected.isSecret!==true||expected.transportMode!=='base64')return {verified:false,reason:'invalid-upload-object'};}
 const metadata=field?.metadata;
 if(expected.isSecret===true){
  if(!publicRead?.ok||!nativeRead?.ok||nativeRead.data.NotFound!==false||!binaryNativeLibraryMatches(info,expected)
   ||field?.isSecret!==true||field.dataType!=='BinaryUrl'||field.valueOrigin!=='Override'
   ||n?.Key!==expected.settingKey||n.IsSecret!==true||n.DataType!=='BinaryUrl'||n.ValueOrigin!=='Override')
   return {verified:false,reason:'secret-binary-origin-not-observed'};
  return {verified:true,secretOriginVerified:true,valueVerified:false,metadataVerified:false,uploadedContentVerified:expected.transportMode!=='base64',...(expected.transportMode==='base64'?{convertedContentVerified:true}:{}),
   contentSha256:expected.contentSha256,byteLength:expected.byteLength,signedUriExposed:false,requestAttributionVerified:false,
   persistedContentVerified:false,contentVerificationStage:expected.transportMode==='base64'?'native-conversion':'temporary-upload'};
 }
 if(!publicRead?.ok||!nativeRead?.ok||nativeRead.data.NotFound!==false||!binaryNativeLibraryMatches(info,expected)
  ||field?.isSecret!==false||field.dataType!=='BinaryUrl'||field.valueOrigin!=='Override'
  ||publicUri(field.value)!==persistedUri||n?.Key!==expected.settingKey||n.DataType!=='BinaryUrl'||n.ValueOrigin!=='Override'
  ||publicUri(n.Value)!==persistedUri||fingerprint(n.Metadata)!==fingerprint(expected.metadata)
  ||!Array.isArray(metadata)||metadata.length!==2||metadata.find(x=>x.key==='name')?.value!==expected.metadata.Name
  ||metadata.find(x=>x.key==='type')?.value!==expected.metadata.Filetype)
  return {verified:false,reason:'binary-setting-not-observed'};
 return {verified:true,persistedObjectUriVerified:true,metadataVerified:true,uploadedContentVerified:expected.transportMode!=='base64',...(expected.transportMode==='base64'?{convertedContentVerified:true}:{}),
  contentSha256:expected.contentSha256,byteLength:expected.byteLength,signedUriExposed:false,requestAttributionVerified:false,
  persistedContentVerified:false,contentVerificationStage:expected.transportMode==='base64'?'native-conversion':'temporary-upload'};
}
