import {mobileConfigurationHash, MOBILE_CONFIGURATION_WRITES} from './mobile-configuration-approval.mjs';
import {MOBILE_EXTENSIBILITY_PATCH,extensibilityExpectation,verifyExtensibility} from './mobile-extensibility.mjs';

// Public fields persist hashes; secret fields persist only identity and origin,
// never a value hash. Future reads must use the receipt's original route
// and path. A match proves observed configuration, not attribution to a request.
export function mobileConfigurationExpectation(body) {
 if(Array.isArray(body.settings)||Array.isArray(body.libraries))return extensibilityExpectation(body);
 const fields=Object.keys(body).sort();
 return {fields,valuesSha256:mobileConfigurationHash(fields.map(key=>[key,body[key].value]))};
}

export function verifyMobileConfiguration(receipt, seen) {
 const expected=receipt.reconciliation?.mobileConfiguration;
 if(receipt.identity?.operationId===MOBILE_EXTENSIBILITY_PATCH&&expected?.kind==='extensibility')return verifyExtensibility(expected,seen);
 if(!MOBILE_CONFIGURATION_WRITES.has(receipt.identity?.operationId)||!expected
  ||!Array.isArray(expected.fields)||expected.fields.length===0
  ||expected.fields.some(key=>!['appIdentifier','mabsVersion','mobileFramework','buildType'].includes(key)))
  return {verified:false,reason:'missing-expectation'};
 if(!seen?.ok||!seen.data||seen.status!==200)return {verified:false,reason:'read-unavailable'};
 const values=[];
 for(const key of expected.fields){
  const field=seen.data[key];
  if(!field||field.isSecret!==false||!Object.hasOwn(field,'value')
   ||field.value!==null&&typeof field.value!=='string')return {verified:false,reason:'public-value-unavailable'};
  values.push([key,field.value]);
 }
 const observedSha256=mobileConfigurationHash(values);
 return {verified:observedSha256===expected.valuesSha256,fields:expected.fields,observedSha256,
  reason:observedSha256===expected.valuesSha256?'requested-public-values-observed':'values-differ',
  requestAttributionVerified:false};
}
