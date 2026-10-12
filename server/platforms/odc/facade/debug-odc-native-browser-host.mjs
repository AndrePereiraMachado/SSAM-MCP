// Private browser adapter. The caller owns the isolated Chrome process; this
// adapter owns its native runtime, guarded requests and inspector installation.
import {randomBytes,createHash} from 'node:crypto';
import {planOdcBrowserAssets,installOdcBrowserAssets} from './debug-odc-native-browser-assets.mjs';
import {createOdcBrowserRuntime} from './debug-odc-browser-runtime.mjs';
import {createOdcBrowserModuleLoader} from './debug-odc-browser-module-loader.mjs';
import {createOdcViewImportInspector} from './debug-odc-view-import.mjs';
import {qualifyOdcMessagesInitialization} from './debug-odc-messages-initialization.mjs';
import {isolateOdcBrowserInstrumentation} from './debug-odc-browser-instrumentation.mjs';
import {bindOdcInstrumentationState,inspectOdcInstrumentationState} from './debug-odc-instrumentation-state.mjs';
import {createOdcBrowserMetadata} from './debug-odc-browser-metadata.mjs';
import {createOdcBrowserAuthentication} from './debug-odc-browser-authentication.mjs';
import {installNativeBrowserInspection} from './debug-native-browser-inspection-install.mjs';
import {createOdcBrowserMount,isOdcMountRequest} from './debug-odc-browser-mount.mjs';
import {observeOdcBrowserStartup} from './debug-odc-browser-startup.mjs';
import {waitForOdcBrowserReady,observeOdcBrowserErrorPage} from './debug-odc-browser-ready.mjs';
import {observeOdcBrowserController} from './debug-odc-browser-controller.mjs';
import {readOdcControllerDispatchSource} from './debug-odc-controller-dispatch-source.mjs';
import {qualifyOdcModuleDispatch,qualifyOdcWebVersionPath} from './debug-odc-module-dispatch.mjs';
import {qualifyOdcPostInitialization} from './debug-odc-post-initialization.mjs';
import {createOdcBrowserControllerLoad} from './debug-odc-browser-controller-load.mjs';
import {inspectOdcControllerInitialization} from './debug-odc-controller-initialization.mjs';
import {readOdcRuntimeSources} from './debug-odc-native-assets.mjs';
import {keyToGuid} from './debug-odc-native-runtime.mjs';
import {readNativeVersionedUrlSource,resolveOdcBrowserViewResources} from './debug-odc-browser-view-resources.mjs';
import {planOdcNativeMount,planOdcAuthorizedMount,resolveOdcInteractionTarget} from './debug-odc-native-mount-plan.mjs';
import {createNativeBrowserInteraction,isNativeInteractionAuthorization} from './debug-native-browser-interaction.mjs';
import {odcMountRenderTargets} from './debug-odc-view-render.mjs';
import {observeNativeBrowserRender} from './debug-native-browser-render-observation.mjs';
import {bindOdcSdkNavigation,createOdcBrowserNavigation,odcScreenQuery,odcScreenLocation} from './debug-odc-browser-navigation.mjs';
export async function createOdcNativeBrowserHost({host,runtime,binding,beforeSync,recordSyncResult,beforeMount,recordMountOutcome,mountAuthorization,beforeControllerLoad,recordControllerLoadOutcome,beforeNavigate,recordNavigationOutcome,interactionAuthorization,beforeInteraction,recordInteractionOutcome},services={}){
 const fail=code=>{throw new Error('debug_odc_browser_host_'+code);};
 if(host?.receipt?.().scope!=='owned-browser-process'||typeof host.dispose!=='function'||binding?.runtimeUrl!==runtime?.runtimeUrl||
  !binding.module||!Number.isInteger(binding.revision))fail('contract_invalid');
 const handle='__ssamOdcRuntime_'+randomBytes(24).toString('hex');
 // The user's Development authorization is fixed before any asset loads.
 if(mountAuthorization!==undefined&&(!isOdcMountRequest(mountAuthorization)||mountAuthorization.runtimeUrl!==runtime.runtimeUrl))fail('mount_authorization_invalid');
 // Interactions (one trusted click each) exist only inside an authorized mount, with both journals.
 if(interactionAuthorization!==undefined&&(!mountAuthorization||!isNativeInteractionAuthorization(interactionAuthorization)||
  typeof beforeInteraction!=='function'||typeof recordInteractionOutcome!=='function'))fail('interaction_authorization_invalid');
 // A deep link also serves the pinned document at its route with the authorized query only.
 const deepLink=mountAuthorization?.route;
 const plan=(services.planAssets??planOdcBrowserAssets)(runtime,{includeDocumentStyles:true,...(deepLink?{route:{segment:deepLink.segment,query:deepLink.query}}:{})});
 const navigationBinding=()=>(services.bindNavigation??(()=>bindOdcSdkNavigation(readOdcRuntimeSources(runtime))))();
 // Expected page location: the root, the deep-link route, or the current in-app navigation target.
 let currentUrl=runtime.runtimeUrl,applicationReady=false,navigation,navigationTarget,navigationOrigin,interaction,interactionPlan,nextInteraction=0;
 const metadata=(services.metadata??createOdcBrowserMetadata)({runtime,homeModuleKey:keyToGuid(binding.moduleKey).toLowerCase(),beforeSync,recordSyncResult});
 let boundary,authentication,inspection,mount,startup,controllerLoad,exceptionLoad,viewLoad,messagesLoad,instrumentation,viewResources,inspectionExpiresAt,initialized=false,inspectionStarted=false,disposed=false,disposePromise,mountStarting=false;
 const report=()=>({browser:true,initialized,disposed,authenticated:authentication?.receipt().confirmed===true,
  authentication:authentication?.receipt(),metadata:metadata.receipt(),assets:boundary?.receipt(),instrumentation,
  inspection:inspection?.receipt(),mount:mount?.receipt(),controllerLoad:controllerLoad?.receipt(),exceptionLoad:exceptionLoad?.receipt(),viewLoad:viewLoad?.receipt(),messagesLoad:messagesLoad?.receipt(),startup,viewResources,mounted:false,runtimeValuesComplete:false});
 async function observeStartup(){
  if(disposed)fail('disposed');
  startup=undefined;
  const core=plan.index.bootstrap.applicationStartup?.controller?.baseImport?.file;
  const reviewedCore=runtime.pins?.[core]?.sha256==='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d';
  startup=await (services.observeStartup??observeOdcBrowserStartup)({page:host.page,runtimeHandle:handle,runtimeUrl:currentUrl,
   ...(reviewedCore?{sdkModule:core,homeModuleKey:keyToGuid(binding.moduleKey).toLowerCase()}:{} )});
  try{startup={...startup,versionPathQualification:qualifyOdcWebVersionPath({sdkSha256:runtime.pins?.[core]?.sha256,
   homeModuleKey:keyToGuid(binding.moduleKey).toLowerCase(),startup,metadata:metadata.receipt()})};}
  catch{startup={...startup,versionPathQualification:{successfulVersionPathQualified:false,applicationStartupQualified:false,executionAuthorized:false}};}
  return startup;
 }
 async function dispose(){
  if(disposePromise)return disposePromise;disposed=true;
  disposePromise=(async()=>{
   let inspector={removed:true},native={authenticationCleared:false},owned;
   try{if(inspection)inspector=await inspection.remove();}catch{inspector={removed:false};}
   try{native=await host.page.evaluate(async handle=>{
    try{return await globalThis[handle]?.dispose()??{authenticationCleared:true};}
    finally{delete globalThis[handle];}
   },handle,5000);}catch{}
   metadata.close();
   // Close the owned process before waiting for intercepted requests whose
   // browser side may be paused or gone. Their receipts remain incomplete.
   try{owned=await host.dispose();}catch{owned={completed:false};}
   let assets;try{assets=await boundary?.dispose();}catch{assets={completed:false};}
   return {completed:inspector?.removed===true&&native?.authenticationCleared===true&&owned?.completed===true&&assets?.completed===true,
    inspector,native,owned,assets};
  })();return disposePromise;
 }
 let preparationPhase='assets';
 try{
  boundary=await (services.installAssets??installOdcBrowserAssets)(host.page,plan,{request:(request,type)=>
   ['XHR','Fetch'].includes(type)?metadata.request(request):undefined,abort:()=>{void host.dispose();}});
  preparationPhase='navigation';
  await host.page.send('Page.navigate',{url:plan.url});
  const navigationDeadline=Date.now()+5000;
  while(await host.page.evaluate(()=>location.href)!==plan.url){
   if(Date.now()>=navigationDeadline)fail('navigation_unconfirmed');
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  // Check the origin again in the constructor before native code is loaded.
  const contract={url:plan.url,module:binding.module,moduleGuid:keyToGuid(binding.moduleKey).toLowerCase(),revision:binding.revision,
   bootstrap:plan.index.bootstrap.file,imports:Object.fromEntries(Object.entries(plan.index.chunks).map(([file,c])=>[file,c.imports.map(i=>i.specifier)]))};
  contract.imports[contract.bootstrap]=plan.index.bootstrap.imports.map(i=>i.specifier);
  try{contract.instrumentationState=bindOdcInstrumentationState(readOdcRuntimeSources(runtime),plan.exports);}catch{}
  preparationPhase='runtime';
  const installed=await host.page.send('Runtime.evaluate',{expression:'(async()=>{try{const runtime=await ('+createOdcBrowserRuntime.toString()+')('+JSON.stringify(contract)+',('+isolateOdcBrowserInstrumentation.toString()+'),('+createOdcBrowserModuleLoader.toString()+'),('+inspectOdcInstrumentationState.toString()+'));globalThis['+JSON.stringify(handle)+']=runtime;await runtime.initialize();return {initialized:true,instrumentation:runtime.instrumentationReceipt()};}catch{return {initialized:false};}})()',awaitPromise:true,returnByValue:true},45000);
  if(installed.exceptionDetails||installed.result?.value?.initialized!==true)fail('initialization_failed');
  initialized=true;
  instrumentation=installed.result.value.instrumentation;
  authentication=(services.authentication??createOdcBrowserAuthentication)({page:host.page,metadata,runtimeHandle:handle});
  return {
   receipt:report,dispose,
   observeStartup,
   async resolveViewResources(screenKey){
    if(disposed)fail('disposed');
    viewResources=undefined;
    const mountPlan=planOdcNativeMount(plan.index,screenKey),sources=readOdcRuntimeSources(runtime);
    const resolved=await resolveOdcBrowserViewResources({page:host.page,runtimeHandle:handle,runtimeUrl:runtime.runtimeUrl,
     views:mountPlan.views,manifest:JSON.parse(sources['moduleinfo.json']).manifest,moduleVersion:runtime.moduleVersion,
     helperSource:readNativeVersionedUrlSource(sources),assets:plan.assets});
    viewResources={...resolved,screenKey,moduleVersion:runtime.moduleVersion,manifestSha256:runtime.pins['moduleinfo.json'].sha256};
    return viewResources;
   },
   async waitForApplicationReady(){
    if(disposed||authentication.receipt().confirmed!==true||!mount?.receipt().callbackReturned||!inspectionStarted)
     fail('application_ready_not_started');
    if(inspectionExpiresAt<=Date.now())fail('inspection_expired');
    const ready=await (services.waitForReady??waitForOdcBrowserReady)({page:host.page,runtimeHandle:handle,
     runtimeUrl:currentUrl,appUrl:runtime.runtimeUrl,expiresAt:new Date(inspectionExpiresAt).toISOString()});
    applicationReady=ready?.nativeApplicationReady===true;
    return ready;
   },
   async loadApplicationController(){
    if(disposed||controllerLoad||authentication.receipt().confirmed!==true)fail('controller_load_not_ready');
    const importer=plan.index.bootstrap.applicationStartup?.importers?.find(i=>i.name==='homeModuleControllerImporter');
    if(importer?.resolved!==true||importer.imports?.length!==1)fail('controller_unbound');
    // Recompute from pinned original assets, not a caller-supplied true flag.
    const qualified=inspectOdcControllerInitialization(readOdcRuntimeSources(runtime),importer,binding.module);
    controllerLoad=createOdcBrowserControllerLoad({page:host.page,runtimeHandle:handle,runtimeUrl:runtime.runtimeUrl,
     authentication,qualification:qualified,controllerModule:importer.imports[0].slice(2),
     beforeLoad:beforeControllerLoad,recordOutcome:recordControllerLoadOutcome});
    return controllerLoad.load();
   },
   async loadGlobalExceptionController(){
    if(disposed||exceptionLoad||authentication.receipt().confirmed!==true||controllerLoad?.receipt().importReturned!==true||
     typeof beforeControllerLoad!=='function'||typeof recordControllerLoadOutcome!=='function')fail('exception_load_not_ready');
    const imports=plan.index.bootstrap.mountImports;
    if(!Array.isArray(imports)||imports.length!==1)fail('exception_unbound');
    const applicationImporter=plan.index.bootstrap.applicationStartup?.importers?.find(i=>i.name==='homeModuleControllerImporter');
    const qualified=inspectOdcControllerInitialization(readOdcRuntimeSources(runtime),{resolved:true,imports},binding.module,
     {baseMember:'BaseController',applicationImporter});
    exceptionLoad=createOdcBrowserControllerLoad({page:host.page,runtimeHandle:handle,runtimeUrl:runtime.runtimeUrl,
     authentication,qualification:qualified,controllerModule:imports[0].slice(2),
     beforeLoad:metadata=>beforeControllerLoad({...metadata,controllerKind:'global-exception'}),
     recordOutcome:metadata=>recordControllerLoadOutcome({...metadata,controllerKind:'global-exception'})});
    return exceptionLoad.load();
   },
   async loadMessages(){
    if(disposed||messagesLoad||authentication.receipt().confirmed!==true||typeof beforeControllerLoad!=='function'||
     typeof recordControllerLoadOutcome!=='function')fail('messages_load_not_ready');
    const importer=plan.index.bootstrap.applicationStartup?.importers?.find(i=>i.name==='homeModuleLanguageResourcesImporter');
    const qualification=qualifyOdcMessagesInitialization(readOdcRuntimeSources(runtime),importer);
    messagesLoad=createOdcBrowserControllerLoad({page:host.page,runtimeHandle:handle,runtimeUrl:runtime.runtimeUrl,
     authentication,qualification,controllerModule:qualification.module,importKind:'messages',
     beforeLoad:metadata=>beforeControllerLoad({...metadata,controllerKind:'messages'}),
     recordOutcome:metadata=>recordControllerLoadOutcome({...metadata,controllerKind:'messages'})});
    return {...await messagesLoad.load(),messageCount:qualification.messageCount,localeCallbackExecuted:false};
   },
   async loadView(screenKey){
    if(disposed||viewLoad||authentication.receipt().confirmed!==true||controllerLoad?.receipt().importReturned!==true||
     exceptionLoad?.receipt().importReturned!==true||typeof beforeControllerLoad!=='function'||typeof recordControllerLoadOutcome!=='function')fail('view_load_not_ready');
    const mountedPlan=planOdcNativeMount(plan.index,screenKey),chunks=[...new Set(mountedPlan.views.map(v=>v.chunk))];
    if(chunks.length!==1)fail('view_import_graph_unqualified');
    const views=Object.values(plan.index.views).flat().filter(v=>v.chunk===chunks[0]);
    const qualified=createOdcViewImportInspector(readOdcRuntimeSources(runtime))(views);
    // Reuse the durable native-import transport. All booleans below come from
    // complete source qualification, never from public input or a saved index.
    const qualification={initializationQualified:qualified.viewImportQualified,nativeEffectsQualified:qualified.viewImportQualified,
     wrapperSyntaxQualified:qualified.viewImportQualified,pendingNativeEffectKinds:[],
     requiredAlreadyLoadedModules:qualified.requiredAlreadyLoadedModules,controller:{sourceHashes:qualified.sourceHashes}};
    viewLoad=createOdcBrowserControllerLoad({page:host.page,runtimeHandle:handle,runtimeUrl:runtime.runtimeUrl,
     authentication,qualification,controllerModule:chunks[0],importKind:'view',
     beforeLoad:metadata=>beforeControllerLoad({...metadata,controllerKind:'view',screenKey,viewKeys:qualified.viewKeys}),
     recordOutcome:metadata=>recordControllerLoadOutcome({...metadata,controllerKind:'view',screenKey})});
    return {...await viewLoad.load(),sourceSha256:qualified.sourceSha256,viewKeys:qualified.viewKeys,
     permissionsChecked:false,renderExecuted:false,mountedVerified:false};
   },
   async observeApplicationController(){
    if(disposed)fail('disposed');
    const importer=plan.index.bootstrap.applicationStartup?.importers?.find(i=>i.name==='homeModuleControllerImporter');
    if(importer?.resolved!==true||importer.imports?.length!==1)fail('controller_unbound');
    const instance=plan.index.bootstrap.applicationStartup?.controller?.instanceBinding;
    const alias=instance?plan.exports[instance.file]?.indexOf(instance.local):-1;
    const files=readOdcRuntimeSources(runtime);
    const controller=plan.index.bootstrap.applicationStartup?.controller;
    if(controller?.resolved!==true)fail('controller_unbound');
    const observation=await observeOdcBrowserController({page:host.page,runtimeHandle:handle,runtimeUrl:runtime.runtimeUrl,
     controllerModule:alias>=0?instance.file:importer.imports[0].slice(2),controllerExport:alias>=0?'__ssam_'+alias:'default',
     expectedDispatch:readOdcControllerDispatchSource(files,controller)});
    // Unsupported SDKs remain observable; they do not inherit reviewed effects.
    let dispatchQualification;
    try{dispatchQualification=qualifyOdcModuleDispatch(files,importer,binding.module,observation);}
    catch{dispatchQualification={sdkDispatchQualified:false,applicationStartupQualified:false,executionAuthorized:false};}
    let postInitializationQualification;
    try{postInitializationQualification=qualifyOdcPostInitialization({files,bootstrapFile:plan.index.bootstrap.file,
      importer,moduleName:binding.module,homeModuleKey:keyToGuid(binding.moduleKey).toLowerCase(),
      startup:await observeStartup(),metadata:metadata.receipt(),controller:observation});}
    catch{postInitializationQualification={successfulPostInitializationPathQualified:false,applicationStartupQualified:false,executionAuthorized:false};}
    return {...observation,dispatchQualification,postInitializationQualification};
   },
   async authenticate(session,descriptor){if(disposed)fail('disposed');return authentication.authenticate(session,descriptor);},
   async configureInspection(options){
    if(disposed||inspection||authentication.receipt().confirmed!==true)fail('inspection_not_ready');
    const leaseMs=options.leaseMs??300000,deadline=options.inspectionExpiresAt===undefined?Date.now()+leaseMs:Date.parse(options.inspectionExpiresAt);
    if(!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>1800000||!Number.isFinite(deadline)||deadline<=Date.now()||deadline>Date.now()+leaseMs)
     fail('inspection_deadline_invalid');
    inspection=await (services.installInspection??installNativeBrowserInspection)({host,runtimeHandle:handle,options:{...options,platform:'odc'}});
    inspectionExpiresAt=deadline;
    return inspection.capability;
   },
   async startInspection(){
    if(disposed||!inspection||authentication.receipt().confirmed!==true)fail('inspection_not_ready');
    const result=await inspection.start();inspectionStarted=true;return result;
   },
   async mount(){
    if(disposed||!inspection||mount||mountStarting)fail('mount_not_ready');
    mountStarting=true;
    try{
    if(inspectionExpiresAt<=Date.now())fail('inspection_expired');
    if(!mountAuthorization||authentication.receipt().confirmed!==true)fail('mount_not_authorized');
    // Composed in this process from the pinned published assets and the same
    // runtime index; no worker message or public argument supplies it.
    const pins=Object.entries(runtime.pins??{}).map(([name,pin])=>name+'\0'+pin?.sha256).sort();
    if(!pins.length||pins.some(line=>!/\0[a-f0-9]{64}$/.test(line)))fail('mount_assets_unpinned');
    let mountPlan;
    const authorizedNavigation=mountAuthorization.navigation;
    const planOptions={...(deepLink?{route:{segment:deepLink.segment}}:{}),
     ...(authorizedNavigation?{navigation:{screenKey:authorizedNavigation.screenKey,segment:authorizedNavigation.segment,inputs:[]}}:{})};
    try{mountPlan=(services.planMount??planOdcAuthorizedMount)(plan.index,mountAuthorization.screenKey,planOptions);}catch{fail('mount_plan_unresolved');}
    if(!Array.isArray(mountPlan?.requiredModelRoots)||!mountPlan.requiredModelRoots.length||
     (deepLink?mountPlan.route?.default!==false||mountPlan.route.segment!==deepLink.segment:mountPlan.route?.default!==true))fail('mount_plan_unresolved');
    if(authorizedNavigation&&(mountPlan.navigation?.screenKey!==authorizedNavigation.screenKey||mountPlan.navigation.segment!==authorizedNavigation.segment||
     !Array.isArray(mountPlan.navigation.availableInputs)))fail('mount_plan_unresolved');
    // The deep-link URL is built in the page by the hash-bound SDK generateScreenURL.
    let initialLocation;
    if(deepLink){
     let nav;try{nav=navigationBinding();}catch{fail('mount_plan_unresolved');}
     if(nav?.navigationBound!==true||typeof nav.members?.generateScreenURL?.source!=='string')fail('mount_plan_unresolved');
     initialLocation={segment:deepLink.segment,query:deepLink.query,coreFile:nav.file,navigationExport:nav.export,module:binding.module,source:nav.members.generateScreenURL.source};
    }
    // Each authorized click target must resolve from this process's own plan of
    // the pinned published views, to the same handler action, before the inspector starts.
    try{interactionPlan=(interactionAuthorization??[]).map(a=>{
     const resolved=(services.resolveInteraction??resolveOdcInteractionTarget)(plan.index,mountPlan.views,binding.moduleKey,{name:a.name,viewKey:a.viewKey});
     if(resolved?.actionKey!==a.actionKey||resolved.viewKey!==a.viewKey||typeof resolved.domId!=='string')throw Error('mismatch');
     return resolved;});}catch{interactionPlan=undefined;fail('mount_plan_unresolved');}
    const {route:_route,navigation:_navigation,...request}=mountAuthorization;
    const authorization={...request,staticEffectsQualified:false,requiredModelRoots:[...new Set([...mountPlan.requiredModelRoots,...interactionPlan.map(i=>i.actionKey)])],
     sourceSha256:createHash('sha256').update(pins.join('\n')).digest('hex'),
     ...(deepLink?{route:{segment:deepLink.segment,querySha256:deepLink.querySha256}}:{}),...(authorizedNavigation?{navigation:structuredClone(authorizedNavigation)}:{})};
    navigationTarget=mountPlan.navigation;
    if(!inspectionStarted){await inspection.start();inspectionStarted=true;}
    if(inspectionExpiresAt<=Date.now())fail('inspection_expired');
    mount=(services.mount??createOdcBrowserMount)({page:host.page,runtimeHandle:handle,authentication,inspection,authorization,
     beforeMount,recordOutcome:recordMountOutcome,timeoutMs:Math.max(1,inspectionExpiresAt-Date.now())+5000,expiresAt:new Date(inspectionExpiresAt).toISOString(),
     ...(initialLocation?{initialLocation}:{})});
    const result=await mount.mount();
    if(deepLink)currentUrl=odcScreenLocation(runtime.runtimeUrl,deepLink.segment,deepLink.query);
    // A later observation failure must not discard the confirmed callback
    // result or permit replay. The native readiness flag is separately read.
    try{return {...result,startup:await observeStartup()};}
    catch{return {...result,startupObservationFailed:true};}
    }finally{mountStarting=false;}
   },
   // One original in-app navigation per call, to the authorized target with
   // authorized inputs only (by query hash). The router runs OnDestroy and the
   // target lifecycle; a lost reply leaves the navigation uncertain, never resent.
   async navigate(screenKey,inputs){
    if(disposed||!applicationReady||!mount?.receipt().callbackReturned)fail('navigation_not_ready');
    const authorized=mountAuthorization?.navigation;
    if(!authorized||!navigationTarget||screenKey!==authorized.screenKey||!inputs||typeof inputs!=='object'||Array.isArray(inputs))fail('navigation_not_authorized');
    const order=navigationTarget.availableInputs.map(c=>c.input);
    if(Object.keys(inputs).some(k=>!order.includes(k)))fail('navigation_not_authorized');
    const pairs=order.filter(k=>Object.hasOwn(inputs,k)).map(k=>[k,inputs[k]]);
    let query;try{query=odcScreenQuery(pairs);}catch{fail('navigation_not_authorized');}
    if(!authorized.inputsSha256.includes(query.querySha256))fail('navigation_not_authorized');
    if(inspectionExpiresAt<=Date.now())fail('inspection_expired');
    navigation??=(services.navigation??createOdcBrowserNavigation)({page:host.page,runtimeHandle:handle,runtimeUrl:runtime.runtimeUrl,startUrl:currentUrl,
     module:binding.module,binding:navigationBinding(),beforeNavigate,recordOutcome:recordNavigationOutcome,
     timeoutMs:Math.max(1,inspectionExpiresAt-Date.now())+5000,expiresAt:new Date(inspectionExpiresAt).toISOString()});
    const result=await navigation.navigate({segment:authorized.segment,inputs:pairs});
    navigationOrigin=currentUrl;currentUrl=odcScreenLocation(runtime.runtimeUrl,authorized.segment,query.query);
    return result;
   },
   // One trusted CDP click per authorized interaction, in order, never resent:
   // the element is resolved read-only by the id the pinned view's idService
   // produces; the click journals its submission and outcome.
   async interact(index){
    if(disposed||!applicationReady||!mount?.receipt().callbackReturned)fail('interaction_not_ready');
    const authorized=interactionAuthorization?.[index],planned=interactionPlan?.[index];
    if(!Number.isInteger(index)||index!==nextInteraction||!authorized||!planned)fail('interaction_not_authorized');
    if(inspectionExpiresAt<=Date.now())fail('inspection_expired');
    nextInteraction++;
    interaction??=(services.interaction??createNativeBrowserInteraction)({page:host.page,beforeInteraction,recordOutcome:recordInteractionOutcome});
    return interaction.click({sequence:index,id:planned.domId,documentUrl:currentUrl,
     metadata:{target:authorized.target,name:authorized.name,viewKey:authorized.viewKey,actionKey:authorized.actionKey}});
   },
   // Read-only SDK error-page state (handleError -> navigateToErrorPage).
   async observeErrorPage(){
    if(disposed||!mount?.receipt().callbackReturned)fail('error_page_not_mounted');
    return (services.observeErrorPage??observeOdcBrowserErrorPage)({page:host.page,runtimeUrl:runtime.runtimeUrl});
   },
   async navigateBack(){
    if(disposed||!applicationReady||!navigation)fail('navigation_not_ready');
    const result=await navigation.back();
    currentUrl=navigationOrigin??currentUrl;navigationOrigin=undefined;
    return result;
   },
   // Read-only DOM evidence after a returned mount. Targets come from this
   // process's own plan of the pinned assets, never from a worker message.
   async observeRender(){
    if(disposed||!mountAuthorization||!mount?.receipt().callbackReturned)fail('render_not_mounted');
    let views;
    try{views=(services.planMount??planOdcAuthorizedMount)(plan.index,mountAuthorization.screenKey).views
     .map(v=>({...v,blockComponents:plan.index.views?.[v.key]?.[0]?.blockComponents}));}catch{views=undefined;}
    const targets=odcMountRenderTargets(views,{moduleKey:binding.moduleKey});
    try{return {targets,observation:await (services.observeRender??observeNativeBrowserRender)({page:host.page,documentUrl:runtime.runtimeUrl,targets})};}
    catch{fail('render_unavailable');}
   },
  };
 }catch{await dispose();fail('prepare_'+preparationPhase+'_failed');}
}
