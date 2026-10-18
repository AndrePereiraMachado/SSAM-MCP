import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {routeOf,screenservice} from '../runtime/portal-routes.mjs';

test('navigation uses the observed aside action in its calling Apps screen',async()=>{
  const route=routeOf('portal.navigation',false),requests=[];
  assert.deepEqual(route,{module:'apps',view:'apps.apps',discoveryView:'apps.apps',action:'UnifiedExperienceCommonLib/UnifiedExpTools/UnifiedExperienceAside/DataActionGetUEAside'});
  const result=await screenservice({origin:'https://fixture.outsystems.dev',metadata:{resolve:async(module,view,action)=>{
    assert.equal(module,'apps');assert.equal(view,'apps.apps');return{action,moduleVersion:'fixture-version',apiVersion:'fixture-api'};
  }},request:async(url,options)=>{requests.push({url,options});return{status:200,text:JSON.stringify({data:{ReceivedMenuOptions:{List:[]}}})};}},route);
  assert.equal(requests.length,1);assert.equal(requests[0].options.body.viewName,'apps.apps');
  assert.match(requests[0].url,/\/apps\/screenservices\/UnifiedExperienceCommonLib\/UnifiedExpTools\/UnifiedExperienceAside\/DataActionGetUEAside$/);
  assert.deepEqual(result.data,{ReceivedMenuOptions:{List:[]}});
});

test('navigation does not expose shell authentication or write actions',()=>{
  for(const id of ['portal.header','portal.lightAccessToken','portal.navigationSave'])
    assert.throws(()=>routeOf(id,false),{code:'PORTAL_OPERATION_NOT_FOUND'});
  assert.throws(()=>routeOf('portal.navigation',true),{code:'PORTAL_OPERATION_NOT_FOUND'});
});

test('API client inventory reads remain distinct from bounded writes and permission changes',()=>{
  for(const [id,action] of [['apiClients.list','DataActionApiClients_GetAll'],['apiClients.statuses','DataActionApiClientsStatus_GetAll']]){
    assert.deepEqual(routeOf(id,false),{module:'usersaccess',view:'APIClients.apiclients',discoveryView:'APIClients.apiclients',action:'usersaccess/APIClients/apiclients/'+action});
    assert.throws(()=>routeOf(id,true),{code:'PORTAL_OPERATION_NOT_FOUND'});
  }
  for(const id of ['apiClients.create','apiClients.delete']){
    assert.throws(()=>routeOf(id,false),{code:'PORTAL_OPERATION_NOT_FOUND'});
    assert.equal(routeOf(id,true).module,'usersaccess');
  }
  for(const id of ['apiClients.rotate','apiClients.updatePermissions'])
    for(const write of [false,true])assert.throws(()=>routeOf(id,write),{code:'PORTAL_OPERATION_NOT_FOUND'});
});
