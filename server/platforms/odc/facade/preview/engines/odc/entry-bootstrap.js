// Entry host only: route and module identities are supplied by native metadata.
window.startReviewedNativeScreen=async function(config){
 if(config?.canStart!==true||config.authorization?.status!=='authorized-local-render-scenario'||location.hostname!=='127.0.0.2')throw Error('LOCAL_SCENARIO_SCOPE_ABSENT');
 if(document.body.hasAttribute('data-ss-design'))throw Error('Runtime preview profile required');
 const installer=window.__reviewedOriginalContextInstaller,catalog=window.__nativeConsumerRouteCatalog,modules=window.__nativeScenarioModules;
 if(installer?.sha256!==config.authorization.contextInstallerSha256)throw Error('Context installer pin mismatch');
 const screen=catalog.screens.find(x=>x.sourceNativeKey===config.entryScreenKey);if(!screen||modules[catalog.moduleKey]?.moduleName!==config.module)throw Error('Native entry not present');
 const amd=ids=>new Promise((resolve,reject)=>require(ids,(...v)=>resolve(v),reject));
 const [Main,Injector,KnownServices,LocaleService,ClientService]=await amd(['OutSystems/ClientRuntime/Main','OutSystems/ClientRuntime/Injector','OutSystems/ClientRuntime/Injector/KnownServices','OutSystems/ClientRuntime/modules/LocaleService/LocaleService','OutSystems/ClientRuntime/modules/ClientVariables/LocalStorageClientVariablesService']);
 const OS=Main.Internal,proof=window.__candidateExecution={explicitSynthetic:true,realAccessValidated:false,applicationInitializeCalled:false,screenEntryAttempted:false,entryScreenKey:config.entryScreenKey,realRolesGranted:false,syntheticRoleScenario:true,errors:[]};
 OS.ApplicationInfo.setApplicationDefinition({applicationName:config.applicationName,userProviderName:'Users',homeModuleName:catalog.moduleName,homeModuleKey:catalog.moduleKey,modules,homeModuleControllerName:config.module+'.controller',homeModuleLanguageResourcesName:config.module+'.languageResources',clientEntitiesModules:[],isWeb:true,debugEnabled:false});
 installer.installIdentity({OS,proof,config});
 if(!Injector.register(KnownServices.ServiceNames.ClientVariablesService,()=>new ClientService.default(OS.ApplicationInfo.getUserProviderName()))||!Injector.resolve(KnownServices.ServiceNames.ClientVariablesService))throw Error('Native ClientVariables registration failed');
 if(!Injector.register(KnownServices.ServiceNames.LocaleService,()=>new LocaleService.default(config.module)))throw Error('Native locale registration failed');Injector.resolve(KnownServices.ServiceNames.LocaleService).setCurrentLocale('en-US');
 const [ClientVariables,ModuleController,Router,Application,History]=await amd([config.module+'.clientVariables',config.module+'.controller','OutSystems/ReactView/Router','OutSystems/ClientRuntime/Application','history']);
 if(Application.default!==Application||typeof Application.shouldRenderSplashScreen!=='function')throw Error('Original Application singleton required');
 await installer.installRoles({OS,QuotesController:ModuleController,proof,config});
 proof.originalPreflightGuardPassed=proof.context.nativeQuotesGuardPassed===true;
 for(const item of config.nativeClientVariables){const setter=ClientVariables['set'+item.name],type=OS.DataTypes.DataTypes[item.type];if(typeof setter!=='function'||type===undefined)throw Error('Native client default metadata mismatch');setter(OS.DataTypes.defaultForType(type));}
 proof.nativeClientDefaultsReset=config.nativeClientVariables.length;proof.clientOverrides=0;
 proof.screenEntryAttempted=true;
 Router.load(Application,()=>{proof.routerShellRendered=true;},options=>History.createMemoryHistory({...options,initialEntries:['/'+catalog.moduleName+'/'+screen.screenUrl],initialIndex:0}));
 return proof;
};
