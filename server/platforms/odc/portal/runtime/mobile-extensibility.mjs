import {fingerprint} from './write-journal.mjs';
import {fail} from './errors.mjs';
export const MOBILE_EXTENSIBILITY_PATCH='native-application-orchestration-service-api-v1:patch:/environments/{environmentKey}/applications/{applicationKey}/configurations/extensibility-settings';
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Extensibility changes require existing settings, vault references for secrets, exact library identities and an exact current state.');
const own=(x,k)=>Object.hasOwn(x,k);
const metadataHash=value=>fingerprint(value??[]);
function validMetadata(value){
 if(value===null)return true;
 if(!Array.isArray(value))return false;
 const keys=new Set();
 return value.every(x=>x&&Object.keys(x).sort().join(',')==='key,value'
  &&typeof x.key==='string'&&x.key.length>0&&!keys.has(x.key)&&keys.add(x.key)
  &&(x.value===null||typeof x.value==='string'));
}
function changes(items,rows,prefix,refs,used){
 if(!Array.isArray(items)||!items.length||!Array.isArray(rows)||new Set(rows.map(x=>x.key)).size!==rows.length)bad();
 const keys=new Set();
 for(const item of items){
  if(!item||Object.keys(item).some(k=>!['key','value','metadata'].includes(k))
   ||typeof item.key!=='string'||keys.has(item.key)||!own(item,'value')&&!own(item,'metadata')
   ||own(item,'value')&&item.value!==null&&typeof item.value!=='string'
   ||own(item,'metadata')&&!validMetadata(item.metadata))bad();
  keys.add(item.key);const field=rows.find(x=>x.key===item.key);
  if(!field||typeof field.isSecret!=='boolean'||!['Text','BinaryUrl'].includes(field.dataType)||!['Default','Override'].includes(field.valueOrigin)
   ||!own(field,'defaultValue')||!own(field,'value'))bad();
  if(field.dataType==='BinaryUrl'&&field.isSecret&&(item.value!==null||item.metadata!==null&&(!Array.isArray(item.metadata)||item.metadata.length)))bad();
  const pointer=prefix+'/'+items.indexOf(item)+'/value',ref=refs.find(r=>r.pointer===pointer);
  if(field.isSecret){
   if(own(item,'value')&&item.value!==null){if(item.value!==''||!ref)bad();used.add(pointer);}
   else if(ref)bad();
  }else if(ref)bad();
 }
}
export function extensibilityChanges(body,current,refs=[]){
 if(!body||!Object.keys(body).length||Object.keys(body).some(k=>!['settings','libraries'].includes(k))||!current)bad();
 if(new Set(refs.map(r=>r.pointer)).size!==refs.length)bad();
 const used=new Set();
 if(own(body,'settings'))changes(body.settings,current.settings,'/settings',refs,used);
 if(own(body,'libraries')){
  if(!Array.isArray(body.libraries)||!body.libraries.length||!Array.isArray(current.libraries)
   ||new Set(current.libraries.map(x=>x.key)).size!==current.libraries.length)bad();
  const keys=new Set();
  for(const library of body.libraries){
   if(!library||Object.keys(library).sort().join(',')!=='key,settings'||typeof library.key!=='string'||keys.has(library.key))bad();
   keys.add(library.key);const row=current.libraries.find(x=>x.key===library.key);
   if(!row||!Number.isSafeInteger(row.revision)||row.revision<1)bad();
   changes(library.settings,row.settings,'/libraries/'+body.libraries.indexOf(library)+'/settings',refs,used);
  }
 }
 if(used.size!==refs.length)bad();
 return true;
}
export function extensibilityStateHash(data){
 // The native reset materializes an absent metadata list as []. Both express
 // zero entries; preserve every nonempty entry and other null-valued fields.
 const clean=x=>Array.isArray(x)?x.map(clean):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).filter(([k])=>k!=='lastUpdateDate').map(([k,v])=>[k,k==='metadata'&&v===null?[]:clean(v)])):x;
 return fingerprint(clean(data));
}
const expectations=(items,rows)=>items.map(x=>{const field=rows?.find(r=>r.key===x.key);return field?.isSecret===true?{key:x.key,isSecret:true,valueVerified:false,
 ...(own(x,'value')?{reset:x.value===null}:{preservedOrigin:field.valueOrigin}),
 ...(own(x,'metadata')?{metadataSha256:metadataHash(x.metadata)}:{})}:({key:x.key,
 ...(own(x,'value')?{reset:x.value===null,valueSha256:x.value===null?null:fingerprint(x.value)}:{}),
 ...(!own(x,'value')&&rows?{preservedValueSha256:fingerprint(rows.find(r=>r.key===x.key).value),preservedOrigin:rows.find(r=>r.key===x.key).valueOrigin}:{}),
 ...(own(x,'metadata')?{metadataSha256:metadataHash(x.metadata)}:{})});}).sort((a,b)=>a.key.localeCompare(b.key));
export function extensibilityExpectation(body,current){
 return {kind:'extensibility',...(body.settings?{settings:expectations(body.settings,current?.settings)}:{}),
  ...(body.libraries?{libraries:body.libraries.map(x=>{const row=current?.libraries?.find(r=>r.key===x.key);return {key:x.key,...(row?{revision:row.revision}:{}),settings:expectations(x.settings,row?.settings)};}).sort((a,b)=>a.key.localeCompare(b.key))}:{})};
}
export function verifyExtensibility(expected,seen){
 if(!seen?.ok||seen.status!==200||!seen.data||!expected
  ||!expected.settings?.length&&!expected.libraries?.length)return {verified:false,reason:'read-unavailable'};
 const groups=[];
 if(expected.settings)groups.push([expected.settings,seen.data.settings]);
 if(expected.libraries){
  const libs=seen.data.libraries;
  if(!Array.isArray(libs)||new Set(libs.map(x=>x.key)).size!==libs.length)return {verified:false,reason:'library-identities-unavailable'};
  for(const library of expected.libraries){
   const row=libs.find(x=>x.key===library.key);
   if(!row)return {verified:false,reason:'library-not-observed'};
   if(own(library,'revision')&&row.revision!==library.revision)return {verified:false,reason:'library-revision-changed'};
   groups.push([library.settings,row.settings]);
  }
 }
 const secretObservations=[];
 for(const [items,rows]of groups){
 if(!Array.isArray(rows))return {verified:false,reason:'settings-unavailable'};
 if(new Set(rows.map(x=>x.key)).size!==rows.length)return {verified:false,reason:'duplicate-settings'};
 for(const item of items){
  const field=rows.find(x=>x.key===item.key);
  if(item.isSecret===true){
   if(!field||field.isSecret!==true||!['Default','Override'].includes(field.valueOrigin))return {verified:false,reason:'secret-metadata-unavailable'};
   if(own(item,'preservedOrigin')&&field.valueOrigin!==item.preservedOrigin)return {verified:false,reason:'unrequested-origin-change'};
   if(own(item,'reset')&&field.valueOrigin!==(item.reset?'Default':'Override'))return {verified:false,reason:'secret-origin-not-observed'};
   if(own(item,'metadataSha256')&&(!own(field,'metadata')||!validMetadata(field.metadata)||metadataHash(field.metadata)!==item.metadataSha256))return {verified:false,reason:'metadata-not-observed'};
   secretObservations.push({key:item.key,present:true,origin:field.valueOrigin,valueVerified:false,...(item.reset===true?{resetMetadataVerified:true}:{})});
   continue;
  }
  if(!field||field.isSecret!==false||!Object.hasOwn(field,'value'))return {verified:false,reason:'public-value-unavailable'};
  if(own(item,'preservedValueSha256')&&(fingerprint(field.value)!==item.preservedValueSha256||field.valueOrigin!==item.preservedOrigin))return {verified:false,reason:'unrequested-value-change'};
  if(own(item,'metadataSha256')&&(!own(field,'metadata')||!validMetadata(field.metadata)||metadataHash(field.metadata)!==item.metadataSha256))return {verified:false,reason:'metadata-not-observed'};
  if(own(item,'reset')){
   if(item.reset){if(field.valueOrigin!=='Default'||!Object.hasOwn(field,'defaultValue')||field.value!==field.defaultValue)return {verified:false,reason:'default-not-observed'};}
   else if(field.valueOrigin!=='Override'||fingerprint(field.value)!==item.valueSha256)return {verified:false,reason:'override-not-observed'};
  }
 }
 }
 return {verified:true,reason:secretObservations.length?'requested-settings-and-secret-origins-observed':'requested-public-settings-observed',requestAttributionVerified:false,
  ...(secretObservations.length?{valueVerified:false,secretObservations}:{})};
}
