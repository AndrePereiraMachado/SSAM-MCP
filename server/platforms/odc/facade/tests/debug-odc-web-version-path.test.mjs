import test from 'node:test';import assert from 'node:assert/strict';
import {qualifyOdcWebVersionPath} from '../debug-odc-module-dispatch.mjs';
const input=()=>({sdkSha256:'1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d',homeModuleKey:'12345678-1234-4234-8234-123456789abc',
 startup:{nativeApplicationStateBound:true,browserProfile:{webApplication:true,runningOnNative:false,deviceState:'absent'}},
 metadata:{closed:false,pending:0,startupProfile:{homeModuleKey:'12345678-1234-4234-8234-123456789abc',publicationMatched:true,hasSplashScreen:false,entityModuleCount:0,moduleInfoSha256:'a'.repeat(64),observedAt:new Date().toISOString()}}});
test('reviewed successful web path preserves deferred callbacks and unresolved startup',()=>{
 const result=qualifyOdcWebVersionPath(input());assert.equal(result.successfulVersionPathQualified,true);
 assert.equal(result.applicationStartupQualified,false);assert.equal(result.executionAuthorized,false);assert.equal(result.localDatabaseRequired,false);
 assert.ok(result.pending.includes('view-mount'));assert.ok(result.pending.includes('error-paths'));
});
test('different SDK, browser, module, metadata and active requests cannot inherit the web path',()=>{
 const changes=[i=>i.sdkSha256='b'.repeat(64),i=>i.startup.browserProfile.webApplication=false,i=>i.startup.browserProfile.runningOnNative=true,
  i=>i.startup.browserProfile.deviceState='accessor',i=>i.metadata.startupProfile.homeModuleKey='other',i=>i.metadata.startupProfile.hasSplashScreen=true,
  i=>i.metadata.startupProfile.entityModuleCount=1,i=>i.metadata.startupProfile.publicationMatched=false,i=>i.metadata.pending=1,
  i=>i.metadata.closed=true,i=>delete i.metadata.startupProfile.observedAt];
 for(const change of changes){const i=input();change(i);assert.throws(()=>qualifyOdcWebVersionPath(i),/debug_odc_web_version_/);}
});
