// Original O11 runtime entry; context is provided separately, never inferred from Studio.
window.startNativeO11Screen=async function(config){
 if(config?.canStart!==true||config.context?.status!=='authorized-local-render-scenario'||location.hostname!==config.bindHost)throw Error('LOCAL_CONTEXT_NOT_CONFIGURED');
 if(document.body.hasAttribute('data-ss-design'))throw Error('Runtime preview profile required');
 const catalog=window.__nativeConsumerRouteCatalog,modules=window.__nativeModules;
 const screen=catalog.screens.find(x=>x.sourceNativeKey===config.entryScreenKey);
 if(!screen||modules[catalog.moduleKey]?.moduleName!==config.module)throw Error('Native entry not present');
 const installer=window.__nativeO11ContextInstaller;
 if(!installer||typeof installer.prepareRuntime!=='function'||typeof installer.beforeScreen!=='function')throw Error('Explicit context installer required');
 const amd=ids=>new Promise((resolve,reject)=>require(ids,(...v)=>resolve(v),reject));
 const [Main,Injector,KnownServices,ClientService]=await amd(['OutSystems/ClientRuntime/Main','OutSystems/ClientRuntime/Injector','OutSystems/ClientRuntime/Injector/KnownServices','OutSystems/ClientRuntime/modules/ClientVariables/LocalStorageClientVariablesService']);
 const OS=Main.Internal,proof=window.__candidateExecution={realAccessValidated:false,applicationInitializeCalled:false,screenEntryAttempted:false,entryScreenKey:config.entryScreenKey,nativeClientDefaultsOverridden:false,errors:[]};
 OS.ApplicationInfo.setApplicationDefinition({...config.application.definition,modules});
 if(config.context.platformSettings){
  const values=config.context.platformSettings;
  if(Object.keys(values).some(k=>k!=='DisableRequestToECTProvider')||Object.values(values).some(v=>typeof v!=='boolean'))throw Error('Unreviewed native preview settings');
  const [Settings]=await amd(['OutSystems/ClientRuntime/Settings']);Settings.setPlatformSettings(values);proof.nativePreviewSettings={...values};
 }
 await installer.prepareRuntime({OS,config,proof});
 if(!Injector.register(KnownServices.ServiceNames.ClientVariablesService,()=>new ClientService.default(OS.ApplicationInfo.getUserProviderName()))||!Injector.resolve(KnownServices.ServiceNames.ClientVariablesService))throw Error('Native ClientVariables registration failed');
 if(config.context.locale){
  const [LocaleService]=await amd(['OutSystems/ClientRuntime/modules/LocaleService/LocaleService']);
  if(!Injector.register(KnownServices.ServiceNames.LocaleService,()=>new LocaleService.default(config.module)))throw Error('Native locale registration failed');
  Injector.resolve(KnownServices.ServiceNames.LocaleService).setCurrentLocale(config.context.locale.code);
 }
 const [ClientVariables,ModuleController,Router,Application,History]=await amd([config.module+'.clientVariables',config.module+'.controller','OutSystems/ReactView/Router','OutSystems/ClientRuntime/Application','history']);
 if(Application.default!==Application||typeof Application.shouldRenderSplashScreen!=='function')throw Error('Original Application singleton required');
 for(const variable of config.clientVariables)if(typeof ClientVariables['get'+variable.name]!=='function'||typeof ClientVariables['set'+variable.name]!=='function')throw Error('Native client variable metadata mismatch');
 // Do not write defaultForType or copy values. Generated getters retain their own defaults.
 await installer.beforeScreen({OS,ModuleController,config,proof});
 proof.contextPrepared=true;proof.screenEntryAttempted=true;
 if(typeof config.entryLocation!=='string')throw Error('Reviewed native entry location required');
 Router.load(Application,()=>{proof.routerShellRendered=true;},options=>History.createMemoryHistory({...options,initialEntries:[config.entryLocation],initialIndex:0}));
 return proof;
};
