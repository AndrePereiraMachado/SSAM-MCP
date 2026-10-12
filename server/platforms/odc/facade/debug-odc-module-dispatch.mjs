// Reviewed native dispatch path for the published SDK version. This is a
// compatibility gate, not an evaluator or a replacement lifecycle dispatcher.
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
import {inspectOdcControllerInitialization} from './debug-odc-controller-initialization.mjs';
const reviewedSdk='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d';
const reviewedClass='59b18d6d578a98f3e4391db3679f51fa17e56b431070a89f8084415fddb21c68';
const methods=['fireApplicationReady','setupOnApplicationResumeListener','setupSyncOnResume','fireApplicationResume'];
const handlers=['onApplicationReadyHandler','onApplicationResumeHandler','onSyncHandler'];
// Successful version initialization only. Error paths and application/view
// callbacks are distinct obligations, not implicitly accepted by this result.
export function qualifyOdcWebVersionPath({sdkSha256,homeModuleKey,startup,metadata}){
 const fail=code=>{throw new Error('debug_odc_web_version_'+code);};
 if(sdkSha256!==reviewedSdk)fail('sdk_unreviewed');
 const profile=startup?.browserProfile,remote=metadata?.startupProfile;
 if(startup?.nativeApplicationStateBound!==true||profile?.webApplication!==true||profile.runningOnNative!==false||profile.deviceState!=='absent')fail('browser_conditions');
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(homeModuleKey??'')||remote?.homeModuleKey!==homeModuleKey||
  remote.publicationMatched!==true||remote.hasSplashScreen!==false||remote.entityModuleCount!==0||
  !/^[a-f0-9]{64}$/.test(remote.moduleInfoSha256??'')||!Number.isFinite(Date.parse(remote.observedAt))||metadata.closed!==false||metadata.pending!==0)fail('metadata_conditions');
 return {schema:'ssam-odc-web-version-path/1',successfulVersionPathQualified:true,sdkSha256,
  moduleInfoSha256:remote.moduleInfoSha256,localDatabaseRequired:false,resourcePrecacheRequired:false,
  nativeEffects:['application-info-local-storage','upgrade-status-session-storage','deferred-version-ready-callback'],
  pending:['error-paths','application-ready-callback','view-mount'],applicationStartupQualified:false,executionAuthorized:false};
}
export function qualifyOdcModuleDispatch(files,importer,moduleName,observation){
 const fail=code=>{throw new Error('debug_odc_module_dispatch_'+code);};
 const initialization=inspectOdcControllerInitialization(files,importer,moduleName);
 if(!initialization.initializationQualified)fail('initialization');
 const controller=initialization.controller;
 const binding=createOdcSdkBindingReader(files)({file:'./'+controller.baseImport.file,
  export:controller.baseImport.exported,member:'BaseModuleController'});
 if(binding.chunkSha256!==reviewedSdk||binding.declarationSha256!==reviewedClass)fail('sdk_unreviewed');
 // Inspectors obtain this observation afresh from the owned browser. It must
 // never be replayed as authorization to execute a later mount.
 if(observation?.nativeControllerBound!==true||observation.nativeDispatchSourceMatched!==true||
  observation.controllerModule!==controller.controllerChunk||
  observation.handlers?.length!==handlers.length||observation.handlers.some((h,i)=>h.name!==handlers[i]||h.state!=='absent')||
  observation.dispatch?.length!==methods.length||observation.dispatch.some((m,i)=>m.name!==methods[i]||m.state!=='function'||m.depth!==2||m.sourceMatches!==true))fail('observation');
 // On the reviewed zero-argument path, absent handlers skip app invocation
 // and resume/sync listener registration. setupSyncOnResume still reads the
 // native cached DI service and sync configuration; it is not a pure function.
 return {schema:'ssam-odc-module-dispatch/1',sdkDispatchQualified:true,
  sdkSha256:binding.chunkSha256,dispatchClassSha256:binding.declarationSha256,
  controllerSha256:controller.controllerSha256,applicationHandlersAbsent:true,
  nativeEffects:['cached-sync-service-read','sync-configuration-read','resolved-promise'],
  applicationStartupQualified:false,lifecycleComplete:false,executionAuthorized:false};
}
