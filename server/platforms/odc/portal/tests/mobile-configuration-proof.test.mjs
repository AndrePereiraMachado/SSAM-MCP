import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mobileConfigurationExpectation,verifyMobileConfiguration} from '../runtime/mobile-configuration-proof.mjs';
import {MOBILE_CONFIGURATION_WRITES} from '../runtime/mobile-configuration-approval.mjs';

test('mobile readback confirms exact public values including reset, without timestamp or attribution assumptions',()=>{
 for(const operationId of MOBILE_CONFIGURATION_WRITES)for(const value of ['com.ssam.proof',null]){
  const receipt={identity:{operationId},reconciliation:{mobileConfiguration:mobileConfigurationExpectation({appIdentifier:{value}})}};
  const seen={ok:true,status:200,data:{appIdentifier:{isSecret:false,value,lastUpdateDate:'variable'}}};
  assert.equal(verifyMobileConfiguration(receipt,seen).verified,true);
  assert.equal(verifyMobileConfiguration(receipt,seen).requestAttributionVerified,false);
  for(const field of [{isSecret:true,value},{isSecret:false},{value},{isSecret:false,value:5},{isSecret:false,value:'foreign'}])
   assert.equal(verifyMobileConfiguration(receipt,{...seen,data:{appIdentifier:field}}).verified,false);
  for(const read of [{...seen,ok:false},{...seen,status:404},{ok:true,status:200,data:null}])
   assert.equal(verifyMobileConfiguration(receipt,read).verified,false);
  assert.equal(verifyMobileConfiguration({...receipt,identity:{operationId:'other'}},seen).verified,false);
 }
});

test('mobile readback requires every requested field and keeps expected values private',()=>{
 const expected=mobileConfigurationExpectation({mabsVersion:{value:'12.0'},appIdentifier:{value:'com.ssam.proof'}});
 assert.deepEqual(expected.fields,['appIdentifier','mabsVersion']);
 assert.equal(JSON.stringify(expected).includes('com.ssam.proof'),false);
 const receipt={identity:{operationId:[...MOBILE_CONFIGURATION_WRITES][0]},reconciliation:{mobileConfiguration:expected}};
 assert.equal(verifyMobileConfiguration(receipt,{ok:true,status:200,data:{appIdentifier:{isSecret:false,value:'com.ssam.proof'}}}).verified,false);
});
