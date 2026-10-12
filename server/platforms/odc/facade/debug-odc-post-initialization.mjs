// Compose reviewed native startup obligations. This never executes an SDK
// function and deliberately does not authorize mounting or render callbacks.
import {qualifyOdcBootstrapFinalStage} from './debug-odc-bootstrap-final-stage.mjs';
import {qualifyOdcModuleDispatch,qualifyOdcWebVersionPath} from './debug-odc-module-dispatch.mjs';
export function qualifyOdcPostInitialization({files,bootstrapFile,importer,moduleName,homeModuleKey,startup,metadata,controller}){
 const fail=code=>{throw new Error('debug_odc_post_initialization_'+code);};
 const finalStage=qualifyOdcBootstrapFinalStage(files,bootstrapFile);
 const sdkSha256=finalStage.nativePostInitialization.chunkSha256;
 const version=qualifyOdcWebVersionPath({sdkSha256,homeModuleKey,startup,metadata});
 const dispatch=qualifyOdcModuleDispatch(files,importer,moduleName,controller);
 // BO/getSyncConfiguration reads the definition installed by fV. An absent
 // configuration prevents mre from registering its online sync listener.
 if(!['absent','empty'].includes(startup.browserProfile.syncConfigurationState))fail('sync_configuration_unreviewed');
 if(startup.applicationReady!==false)fail('already_initialized');
 return {schema:'ssam-odc-post-initialization/1',successfulPostInitializationPathQualified:true,
  sdkSha256,bootstrapSha256:finalStage.sourceSha256,controllerSha256:dispatch.controllerSha256,
  moduleInfoSha256:version.moduleInfoSha256,applicationHandlersAbsent:true,onlineSyncListenerRequired:false,
  nativeEffects:['instrumentation-settings-read','instrumentation-transport-registration','instrumentation-scheduler',
   'remote-file-service-registration','offline-sync-service-registration','native-status-service-registration',
   'application-info-local-storage','upgrade-status-session-storage','application-ready-promise','instrumentation-flush'],
  // Native upgrade failures can render feedback and import the messages
  // provider; error handling can invoke model actions. Those are not covered
  // by the successful path or by absence of ApplicationReady handlers.
  pending:['instrumentation-boundary-after-update','upgrade-and-error-paths','authenticated-view-mount','native-hook-completion'],
  applicationStartupQualified:false,executionAuthorized:false};
}
