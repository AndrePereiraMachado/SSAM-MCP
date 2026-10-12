import test from 'node:test';import assert from 'node:assert/strict';
import {PORTAL_READS,PORTAL_WRITES,routeOf} from '../runtime/portal-routes.mjs';
import fs from 'node:fs';
test('mobile extensibility readers match exact native action and bridge allow-list, never upload or save',()=>{
 const core=fs.readFileSync(new URL('../../studio/bridge/PortalCore.cs',import.meta.url),'utf8');
 for(const [suffix,action] of [['stages','GetApplicationStages'],['revision','GetLatestDeployedAppVersion'],['setting','GetExtensibilitySettingInfo']]){
  const id='mobileExtensibility.'+suffix,route='apps/ApplicationMobile/extensibillitysetting/DataAction'+action;
  assert.deepEqual(PORTAL_READS[id],['apps','ApplicationMobile.extensibillitysetting',route]);
  assert.ok(core.includes('"'+route+'"'));assert.equal(PORTAL_WRITES[id],undefined);assert.throws(()=>routeOf(id,true));
 }
 for(const action of ['ActionFileUpload_Wrapper','ActionExtensbilitySettingSave_Wrapper','ActionBinaryToBase64'])assert.ok(!Object.values(PORTAL_READS).some(r=>r[2].endsWith('/'+action)));
});
test('native mobile build type lists are read-only data actions, never the save-and-start action',()=>{
 for(const [id,view,action] of [['mobile.androidBuildTypes','createandroidpackage','GetAndroidBuildType_NAOS'],['mobile.iosBuildTypes','createiospackage','GetiOSBuildType_NAOS']]){
  assert.deepEqual(PORTAL_READS[id],['apps','ApplicationMobile.'+view,'apps/ApplicationMobile/'+view+'/DataAction'+action]);
  assert.equal(PORTAL_WRITES[id],undefined);
  assert.throws(()=>routeOf(id,true));
 }
});
