// Read the original SDK application state. A true SDK flag is not evidence
// that every screen/block hook completed or that every scope was inspected.
// Serialized into the page; reads descriptors and SDK flags only.
function readStartupState({handle,url,sdkFile,moduleKey}){
 if(location.href!==url)return {bound:false};
 const runtime=globalThis[handle];
 if(typeof runtime?.shape!=='function')return {bound:false};
 try{
  const application=runtime.shape('initializeDatabase','triggerApplicationReadyEvent','onApplicationReady','isApplicationReady');
  if(typeof application.isApplicationReady!=='boolean')return {bound:false};
  let browserProfile;
  if(sdkFile){
   const value=(object,key)=>{const d=Object.getOwnPropertyDescriptor(object,key);if(!d||!Object.hasOwn(d,'value'))throw Error();return d.value;};
   const definition=runtime.boot?.__ssamDefinition;
   if(!definition||value(definition,'homeModuleKey')?.toLowerCase()!==moduleKey||typeof value(definition,'isWeb')!=='boolean')return {bound:false};
   const sdk=runtime.loadedModule(sdkFile),native=value(sdk,'q');
   if(!Object.isFrozen(native))return {bound:false};
   const isNative=value(native,'isRunningOnNative');if(typeof isNative!=='function')return {bound:false};
   const runningOnNative=isNative();if(typeof runningOnNative!=='boolean')return {bound:false};
   // Inspect presence without invoking a device getter supplied by app code.
   const device=Object.getOwnPropertyDescriptor(window,'device');
   // The reviewed SDK stores this exact definition as its configuration.
   // Inspect descriptors only: application-supplied accessors must not run.
   const sync=Object.getOwnPropertyDescriptor(definition,'syncConfiguration');
   let syncConfigurationState=!sync?'absent':!Object.hasOwn(sync,'value')?'accessor':sync.value==null?'empty':'present';
   browserProfile={webApplication:value(definition,'isWeb'),runningOnNative,
    syncConfigurationState,
    deviceState:!device?'absent':!Object.hasOwn(device,'value')?'accessor':device.value==null?'empty':'present'};
  }
  // The instrumentation boundary is separate evidence: an unbound reading is
  // reported as such instead of hiding the application state.
  let instrumentation;
  if(typeof runtime.observeInstrumentation==='function'){try{instrumentation=runtime.observeInstrumentation();}catch{instrumentation={nativeTracerStateBound:false};}}
  return {bound:true,applicationReady:application.isApplicationReady,...(browserProfile?{browserProfile}:{}),...(instrumentation?{instrumentation}:{})};
 }catch{return {bound:false};}
}
export async function observeOdcBrowserStartup({page,runtimeHandle,runtimeUrl,sdkModule,homeModuleKey}){
 if(typeof page?.send!=='function'||!/^__ssamOdcRuntime_[a-f0-9]{48}$/.test(runtimeHandle??''))
  throw new Error('debug_odc_browser_startup_contract_invalid');
 if(sdkModule!==undefined&&(!/^_oschunk-[A-Za-z0-9]+\.js$/.test(sdkModule)||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(homeModuleKey??'')))
  throw new Error('debug_odc_browser_startup_contract_invalid');
 // Not awaited: right after the mount callback the native debugger may hold V8
 // at a lifecycle breakpoint. An awaited evaluation answers only through a
 // microtask, which cannot run before that pause resumes (r3d recorded
 // startupObservationFailed:true). A plain synchronous read answers at once.
 const reply=await page.send('Runtime.evaluate',{expression:'('+readStartupState.toString()+')('+
  JSON.stringify({handle:runtimeHandle,url:runtimeUrl,sdkFile:sdkModule,moduleKey:homeModuleKey})+')',returnByValue:true,silent:true},5000);
 const result=reply?.exceptionDetails?undefined:reply?.result?.value;
 if(result?.bound!==true||typeof result.applicationReady!=='boolean')
  throw new Error('debug_odc_browser_startup_state_unbound');
 if(sdkModule!==undefined&&(typeof result.browserProfile?.webApplication!=='boolean'||typeof result.browserProfile?.runningOnNative!=='boolean'||
  !['absent','accessor','empty','present'].includes(result.browserProfile?.syncConfigurationState)||
  !['absent','accessor','empty','present'].includes(result.browserProfile?.deviceState)))throw new Error('debug_odc_browser_startup_profile_unbound');
 return {nativeApplicationStateBound:true,applicationReady:result.applicationReady,...(result.browserProfile?{browserProfile:result.browserProfile}:{}),...(result.instrumentation?{instrumentation:result.instrumentation}:{}),lifecycleComplete:false,mountedVerified:false};
}
