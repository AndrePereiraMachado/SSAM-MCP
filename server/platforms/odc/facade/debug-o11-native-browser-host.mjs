// Private O11 browser adapter (option B, O11). The caller owns the isolated
// Chrome process (launchNativeDebugBrowser); this adapter owns the pinned asset
// boundary, the guarded app-user session, two page realms and the inspector:
// - preparation realm: classic scripts, Minimal initialization and the original
//   login controller (placeholders; the transport adds the private credentials);
// - mount realm (after a reload that discards the first): classic scripts only.
//   The inspector is configured after sign-in and started before the original
//   bootstrap, which is the first code that fires application events or
//   requires screen controllers. It runs once, unchanged, journaled.
import {randomBytes,createHash} from 'node:crypto';
import {planO11BrowserAssets,installO11BrowserAssets} from './debug-o11-browser-assets.mjs';
import {createO11BrowserSession,createO11BrowserAuthentication} from './debug-o11-browser-authentication.mjs';
import {createO11BrowserMount,isO11MountRequest,waitForO11BrowserReady} from './debug-o11-browser-mount.mjs';
import {observeOdcBrowserErrorPage} from './debug-odc-browser-ready.mjs';
import {installNativeBrowserInspection} from './debug-native-browser-inspection-install.mjs';
import {connectNativeClientInspector} from './debug-native-client-inspection.mjs';
import {createPrivateInspectionChannel} from './debug-private-inspection.mjs';
import {o11NativeLoginSpecValid} from './debug-o11-native-entry.mjs';

// Serialized into the owned page; references nothing outside itself. Only the
// original scripts, platform initialization and published controllers run here.
export async function createO11BrowserRuntime(contract){
 const fail=code=>{throw new Error('debug_o11_browser_runtime_'+code);};
 if(location.href!==contract.url)fail('origin_changed');
 if(!['preparation','mount'].includes(contract.realm))fail('realm_invalid');
 const loadScript=src=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.async=false;
  script.onload=()=>resolve();script.onerror=()=>reject(new Error('debug_o11_browser_runtime_script_failed'));document.head.appendChild(script);});
 // The original index order: basePath, classic scripts, indexVersionToken. Never the bootstrap.
 for(const step of contract.steps){
  if(step.kind==='basePath')globalThis.OutSystemsApp={basePath:step.value};
  else if(step.kind==='indexVersionToken'){if(!globalThis.OSManifestLoader)fail('manifest_loader_missing');globalThis.OSManifestLoader.indexVersionToken=step.value;}
  else if(step.kind==='script'&&step.src!==contract.bootstrap.src)await loadScript(step.src);
  else fail('step_invalid');
 }
 if(typeof globalThis.require!=='function')fail('amd_unavailable');
 const amd=names=>new Promise((resolve,reject)=>globalThis.require(names,(...values)=>resolve(values),reject));
 const [main,debuggerModule]=await amd(['OutSystems/ClientRuntime/Main','OutSystems/ClientRuntime/Debugger']);
 if(!globalThis.OutSystemsDebugger||globalThis.OutSystemsDebugger.isInSession)fail('debugger_context_invalid');
 let mountAttempted=false,authenticationAttempted=false;
 return {
  nativeBinaryType:()=>main?.Internal?.DataTypes?.BinaryData,
  nativeConverter:()=>debuggerModule?.DebuggerDataConverter,
  application:()=>main?.Internal?.Application?.default,
  async authenticate(placeholders,login){
   if(contract.realm!=='preparation'||authenticationAttempted)fail('realm_invalid');
   authenticationAttempted=true;
   const OS=main.Internal,minimal=OS.Interfaces?.Application?.InitializationType?.Minimal;
   if(minimal!==1)fail('initialization_unsupported');
   const appInfo=contract.appInfo;
   if(!appInfo?.manifest?.urlVersions||!appInfo.data?.modules)fail('initialization_unsupported');
   const [definition,roles,communication,info,versions,requireManager,settings]=await amd([contract.appDefinitionModule,'OutSystems/ClientRuntime/RolesInfo',
    'OutSystems/ClientRuntime/Communication','OutSystems/ClientRuntime/ApplicationInfo','OutSystems/ClientRuntime/VersionsManager',
    'OutSystems/ClientRuntime/RequireManager','OutSystems/ClientRuntime/Settings']);
   // Minimal: definition, cookies, communication and services only (no roles, database or application-ready event).
   if(await OS.Application.default.initialize(definition,minimal)!==true)fail('initialization_failed');
   // What the Full path takes from the manifest, here from the pinned moduleinfo (as the native entry worker does):
   // modules, cached app info (versionInfo of requests) and the versioned AMD script map.
   info.setModules(appInfo.data.modules);versions.default.cachedAppInfo=appInfo;
   requireManager.configure(versions.buildScriptMap(appInfo.manifest.urlVersions,appInfo.manifest.versionToken,settings.getEnvParams().CDNFilenameVersioning));
   const [modelFactory,controllerFactory]=await amd([login.modelFactory,login.controllerFactory]);
   const model=modelFactory.create({viewName:login.viewName,navigatedFromHistory:false,viewWasRestoredFromCache:false});
   const controller=controllerFactory.create(model,new OS.WidgetNaming.WidgetIdService(null));
   try{
    if(!(controller instanceof OS.Controller.BaseViewController)||typeof controller[login.method]!=='function')fail('login_contract_invalid');
    await controller[login.method](placeholders.username,placeholders.password,false,controller.callContext().withTimeout(120));
    const value=await communication.getRoles();if(typeof value!=='string')fail('roles_unavailable');
    await roles.storeRoleInformation(value);roles.checkRegistered();
    return {loginAnswered:true,registered:true,userIdentified:roles.getUserId()!==OS.BuiltinFunctions.nullIdentifier()};
   }finally{try{controller.dispose();}catch{}}
  },
  // The preparation realm leaves nothing but the session cookies behind.
  discard(){localStorage.clear();sessionStorage.clear();return {discarded:true};},
  boot:{async __ssamMount(){
   if(contract.realm!=='mount'||mountAttempted)return {invoked:false,callbackReturned:false};
   mountAttempted=true;
   let topLevelError=false;
   const onError=event=>{if(event?.filename===contract.bootstrap.src)topLevelError=true;};
   globalThis.addEventListener('error',onError);
   try{await loadScript(contract.bootstrap.src);}catch{return {invoked:false,callbackReturned:false};}
   finally{globalThis.removeEventListener('error',onError);}
   return {invoked:true,callbackReturned:!topLevelError};
  }},
  async dispose(){try{localStorage.clear();sessionStorage.clear();}catch{return {authenticationCleared:false};}return {authenticationCleared:true};},
 };
}

export async function createO11NativeBrowserHost({host,runtime,binding,login,mountAuthorization,beforeSignIn,recordSignInResult,beforeMount,recordMountOutcome},services={}){
 const fail=code=>{throw new Error('debug_o11_browser_host_'+code);};
 if(host?.receipt?.().scope!=='owned-browser-process'||typeof host.dispose!=='function'||binding?.runtimeUrl!==runtime?.runtimeUrl||
  !binding.module||binding.module!==runtime.module)fail('contract_invalid');
 // The user's Development authorization is fixed before any asset loads.
 if(mountAuthorization!==undefined&&(!isO11MountRequest(mountAuthorization)||mountAuthorization.runtimeUrl!==runtime.runtimeUrl))fail('mount_authorization_invalid');
 if(!o11NativeLoginSpecValid(login,{module:binding.module,runtimeUrl:runtime.runtimeUrl}))fail('login_contract_invalid');
 const handle='__ssamO11Runtime_'+randomBytes(24).toString('hex');
 const plan=(services.planAssets??planO11BrowserAssets)(runtime);
 let boundary,session,authentication,inspection,mount,realm,inspectionExpiresAt,initialized=false,inspectionStarted=false,disposed=false,disposePromise,mountStarting=false;
 const report=()=>({browser:true,initialized,disposed,realm,authenticated:authentication?.receipt().confirmed===true,authentication:authentication?.receipt(),
  session:session?.receipt(),assets:boundary?.receipt(),inspection:inspection?.receipt(),mount:mount?.receipt(),
  plan:{bootstrapQualified:plan.bootstrap?.bootstrapQualified===true,developmentProved:plan.appDefinition?.developmentProved===true,removedScripts:plan.removedScripts?.length??0},
  mounted:false,runtimeValuesComplete:false});
 let preparationPhase='assets';
 // Page.navigate can reply before the new document commits, and the reload goes to the URL the
 // old document already has: a random mark in the old document must be gone before a realm installs.
 async function openRealm(next){
  preparationPhase='navigation';
  const mark='__ssamO11Document_'+randomBytes(16).toString('hex'),deadline=Date.now()+(services.navigationTimeoutMs??5000);
  let marked=false;try{marked=await host.page.evaluate(m=>{globalThis[m]=true;return true;},mark,5000)===true;}catch{marked=false;}
  if(!marked)fail('navigation_unconfirmed');
  const navigated=await host.page.send('Page.navigate',{url:plan.url});
  if(navigated?.errorText)fail('navigation_unconfirmed');
  for(;;){
   let probe;try{probe=await host.page.evaluate(m=>({href:location.href,stale:globalThis[m]===true,state:document.readyState}),mark,5000);}catch{probe=undefined;}
   if(probe?.href===plan.url&&probe.stale===false&&probe.state!=='loading')break;
   if(Date.now()>=deadline)fail('navigation_unconfirmed');
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  preparationPhase='runtime';
  const contract={url:plan.url,realm:next,steps:plan.steps,bootstrap:{src:plan.bootstrap.src},appDefinitionModule:plan.module+'.appDefinition',
   ...(next==='preparation'?{appInfo:plan.appInfo}:{})};
  const installed=await host.page.send('Runtime.evaluate',{expression:'(async()=>{try{const runtime=await ('+createO11BrowserRuntime.toString()+')('+JSON.stringify(contract)+');globalThis['+JSON.stringify(handle)+']=runtime;return {initialized:true};}catch{return {initialized:false};}})()',
   awaitPromise:true,returnByValue:true},45000);
  if(installed?.exceptionDetails||installed?.result?.value?.initialized!==true)fail('initialization_failed');
  realm=next;
 }
 // Login realm -> clean mount realm: storage cleared, runtime dropped, document reloaded from the pin.
 async function reload(){
  if(disposed)fail('disposed');
  await host.page.evaluate(h=>{const r=globalThis[h];try{return r?.discard?.()??{discarded:false};}finally{delete globalThis[h];}},handle,5000);
  realm=undefined;await openRealm('mount');
 }
 async function dispose(){
  if(disposePromise)return disposePromise;disposed=true;
  disposePromise=(async()=>{
   let inspector={removed:true},native={authenticationCleared:false},cleared,owned,assets;
   try{if(inspection)inspector=await inspection.remove();}catch{inspector={removed:false};}
   try{native=await host.page.evaluate(async h=>{try{return await globalThis[h]?.dispose()??{authenticationCleared:true};}finally{delete globalThis[h];}},handle,5000);}catch{}
   try{cleared=session?await session.clear():{cleared:true};}catch{cleared={cleared:false};}
   // Close the owned process (its incognito context and cookies) before waiting for intercepted requests.
   try{owned=await host.dispose();}catch{owned={completed:false};}
   try{assets=boundary?await boundary.dispose():{completed:true};}catch{assets={completed:false};}
   return {completed:inspector?.removed===true&&native?.authenticationCleared===true&&cleared?.cleared===true&&owned?.completed===true&&assets?.completed===true,
    inspector,native,session:cleared,owned,assets};
  })();return disposePromise;
 }
 try{
  session=(services.session??(options=>createO11BrowserSession({...options,binding:{lane:'o11',runtimeUrl:runtime.runtimeUrl,app:binding.module,
   sessionId:binding.sessionId,module:binding.module,moduleKey:binding.moduleKey}})))({runtimeUrl:runtime.runtimeUrl,module:binding.module,
   versionToken:plan.versionToken,userProvider:plan.appDefinition.userProviderName,login,beforeSignIn,recordSignInResult});
  boundary=await (services.installAssets??installO11BrowserAssets)(host.page,plan,{request:(request,type)=>session.request(request,type),abort:()=>{void host.dispose();}});
  await openRealm('preparation');
  initialized=true;
  authentication=(services.authentication??createO11BrowserAuthentication)({page:host.page,session,runtimeHandle:handle,login,runtimeUrl:runtime.runtimeUrl,reload});
 }catch{await dispose();fail('prepare_'+preparationPhase+'_failed');}
 return {
  receipt:report,dispose,
  async authenticate(descriptor){if(disposed)fail('disposed');return authentication.authenticate(descriptor);},
  async configureInspection(options={}){
   if(disposed||inspection||authentication.receipt().confirmed!==true||realm!=='mount')fail('inspection_not_ready');
   const leaseMs=options.leaseMs??300000,deadline=options.inspectionExpiresAt===undefined?Date.now()+leaseMs:Date.parse(options.inspectionExpiresAt);
   if(!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>1800000||!Number.isFinite(deadline)||deadline<=Date.now()||deadline>Date.now()+leaseMs)fail('inspection_deadline_invalid');
   const {inspectionExpiresAt:_deadline,...rest}=options;
   inspection=await (services.installInspection??installNativeBrowserInspection)({host,runtimeHandle:handle,options:{...rest,platform:'o11'}});
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
    if(!mountAuthorization||authentication.receipt().confirmed!==true||realm!=='mount')fail('mount_not_authorized');
    // Composed here from the pinned published assets; no public argument supplies it.
    const pins=Object.entries(runtime.pins??{}).map(([name,pin])=>name+'\0'+pin?.sha256).sort();
    if(!pins.length||pins.some(line=>!/\0[a-f0-9]{64}$/.test(line)))fail('mount_assets_unpinned');
    const authorization={...mountAuthorization,staticEffectsQualified:false,developmentProved:plan.appDefinition?.developmentProved===true,
     bootstrapQualified:plan.bootstrap?.bootstrapQualified===true,bootstrapSha256:plan.bootstrap?.sha256,
     sourceSha256:createHash('sha256').update(pins.join('\n')).digest('hex')};
    if(!inspectionStarted){await inspection.start();inspectionStarted=true;}
    if(inspectionExpiresAt<=Date.now())fail('inspection_expired');
    mount=(services.mount??createO11BrowserMount)({page:host.page,runtimeHandle:handle,authentication,inspection,authorization,
     beforeMount,recordOutcome:recordMountOutcome,timeoutMs:Math.max(1,inspectionExpiresAt-Date.now())+5000,expiresAt:new Date(inspectionExpiresAt).toISOString()});
    return await mount.mount();
   }finally{mountStarting=false;}
  },
  async waitForApplicationReady(){
   if(disposed||authentication.receipt().confirmed!==true||!mount?.receipt().callbackReturned||!inspectionStarted)fail('application_ready_not_started');
   if(inspectionExpiresAt<=Date.now())fail('inspection_expired');
   return (services.waitForReady??waitForO11BrowserReady)({page:host.page,runtimeHandle:handle,runtimeUrl:runtime.runtimeUrl,expiresAt:new Date(inspectionExpiresAt).toISOString()});
  },
  // Read-only original error-page state (handleError -> navigateToErrorPage).
  async observeErrorPage(){
   if(disposed||!mount?.receipt().callbackReturned)fail('error_page_not_mounted');
   return (services.observeErrorPage??observeOdcBrowserErrorPage)({page:host.page,runtimeUrl:runtime.runtimeUrl});
  },
 };
}

// moduleKey:functionKey of a native frame elementKey; never its path or values.
const frameFunction=frame=>{const [moduleKey,functionKey]=String(frame?.elementKey??'').split(':');
 return /^[A-Za-z0-9_+]{22}$/.test(moduleKey??'')&&/^[A-Za-z0-9_+]{22}(?:\.#FlowExceptionHandler)?$/.test(functionKey??'')?moduleKey+':'+functionKey:null;};

// In-process broker with the ODC broker's mount surface. It never exposes an
// event trigger or lifecycle call: the original bootstrap and router are the only drivers.
export function createO11NativeMountBroker({ownedBrowser,mountAuthorization,beforeBrowserSignIn,recordBrowserSignInResult,beforeBrowserMount,recordBrowserMountResult,
 createHost=createO11NativeBrowserHost,connectInspector=connectNativeClientInspector,privateChannelFactory=createPrivateInspectionChannel,hostServices}={}){
 if(![beforeBrowserSignIn,recordBrowserSignInResult,beforeBrowserMount,recordBrowserMountResult].every(f=>typeof f==='function')||!isO11MountRequest(mountAuthorization))
  throw new Error('debug_o11_native_browser_mount_journal_invalid');
 if(typeof ownedBrowser?.dispose!=='function'||ownedBrowser.receipt?.().scope!=='owned-browser-process')throw new Error('debug_o11_native_browser_owner_invalid');
 const activity={configured:false,paused:false,stops:0,functions:[],exceptions:[],lastChangeAt:null};
 let host,inspection,channel,descriptor,expiresAt,ended=false,disposed=false;
 const unqualified=()=>Promise.reject(new Error('debug_o11_native_browser_execution_unqualified'));
 return {
  async prepareBrowser({runtime,binding,prepared}){
   const receipt=ownedBrowser.receipt();
   if(host||receipt?.ready!==true||receipt.cleanupConfirmed===true||!(Date.parse(receipt.expiresAt)>Date.now()))throw new Error('debug_o11_native_browser_owner_invalid');
   host=await createHost({host:ownedBrowser,runtime,binding,login:prepared?.login,mountAuthorization,beforeSignIn:beforeBrowserSignIn,
    recordSignInResult:recordBrowserSignInResult,beforeMount:beforeBrowserMount,recordMountOutcome:recordBrowserMountResult},hostServices);
   return {prepared:true,receipt:host.receipt()};
  },
  async authenticate(value){
   if(!host)throw new Error('debug_o11_native_browser_not_prepared');
   const result=await host.authenticate(value);
   if(result?.authenticated===true&&result.identityMatches===true)descriptor=value;
   return result;
  },
  async configureInspection({onEvent,...options}){
   if(inspection)throw new Error('debug_native_client_already_configured');
   const leaseMs=options.leaseMs??300000,deadline=Math.min(Date.now()+leaseMs,Date.parse(descriptor?.expiresAt));
   if(!host||!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>1800000||!Number.isFinite(deadline)||deadline<=Date.now())
    throw new Error('debug_o11_native_inspection_deadline_invalid');
   const capability=await host.configureInspection({...options,leaseMs,inspectionExpiresAt:new Date(deadline).toISOString()});
   expiresAt=deadline;
   if(capability?.privateCapture===true)channel=privateChannelFactory({binding:descriptor.binding,sources:options.modules,expiresAt:new Date(deadline).toISOString()});
   try{inspection=await connectInspector({...capability,...(channel?{privateChannel:channel}:{}),onEvent:event=>{
    if(event.kind==='paused'){
     activity.paused=true;activity.stops++;activity.lastChangeAt=Date.now();
     const frames=Array.isArray(event.frames)?event.frames.map(frameFunction):[];
     if(frames[event.frame])activity.functions.push(frames[event.frame]);
     if(event.reason==='exception')activity.exceptions.push({stop:activity.stops,function:frames[event.frame]??null,
      type:/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(event.exception?.type??'')?event.exception.type:'unknown'});
    }else if(event.kind==='resumed'){activity.paused=false;activity.lastChangeAt=Date.now();}
    else if(event.kind==='ended')ended=true;
    onEvent?.(event);
   },leaseMs:Math.max(1000,Math.min(leaseMs,deadline-Date.now())),terminate:()=>{void ownedBrowser.dispose();}});}
   catch(error){await channel?.close?.();channel=undefined;throw error;}
   activity.configured=true;activity.lastChangeAt=Date.now();
   return {configured:true,runtime:'client',mode:'interactive'};
  },
  inspection:input=>inspection?inspection.command(input):Promise.reject(new Error('debug_native_client_not_configured')),
  inspectionActivity:()=>({...activity,functions:[...activity.functions],exceptions:activity.exceptions.map(e=>({...e})),ended}),
  consumePrivateInspection:(value,consume)=>inspection?inspection.consumePrivate(value,consume):Promise.reject(new Error('debug_native_client_not_configured')),
  mountBrowser:()=>host&&inspection&&expiresAt>Date.now()?host.mount():unqualified(),
  waitForBrowserReady:()=>host&&inspection&&expiresAt>Date.now()?host.waitForApplicationReady():unqualified(),
  observeBrowserErrorPage:()=>host&&inspection?host.observeErrorPage():unqualified(),
  async dispose(){
   let inspectionClosed=true,privateChannelClosed=true;
   try{await inspection?.close();}catch{inspectionClosed=false;}
   try{await channel?.close();}catch{privateChannelClosed=false;}finally{descriptor=undefined;}
   if(disposed)return {completed:false};disposed=true;ended=true;
   let cleanup;try{cleanup=host?await host.dispose():await ownedBrowser.dispose();}catch{cleanup={completed:false};}
   return {...(host?{host:cleanup}:{ownedBrowserCleanup:cleanup}),inspectionClosed,privateChannelClosed,
    completed:cleanup?.completed===true&&inspectionClosed&&privateChannelClosed};
  },
 };
}
