// Serialized into the owned browser by the private host. Only original native
// factories and initialization methods run here; no action evaluator is added.
export async function createOdcBrowserRuntime(contract,isolateInstrumentation,createModuleLoader,inspectInstrumentation){
  const fail=code=>{throw new Error('debug_odc_browser_runtime_'+code);};
  let boot,services,container,initialized=false,nativeAuth,authenticationAttempted=false,instrumentation,instrumentationFactory;
  if(location.href!==contract.url)fail('origin_changed');
  window.OutSystemsApp={basePath:new URL(contract.url).pathname};
  if(typeof createModuleLoader!=='function')fail('module_loader_missing');
  const modules=createModuleLoader(contract.imports,file=>import(contract.url+'scripts/'+file));
  const load=modules.load;
  const objects=()=>[...new Set(modules.values().flatMap(m=>Object.values(m)))];
  function shape(...keys){const matches=objects().filter(v=>v&&keys.every(k=>k in Object(v)));if(matches.length!==1)fail('sdk_shape_unresolved');return matches[0];}
  function nativeFunction(name){const matches=objects().filter(v=>typeof v==='function'&&v.name===name);if(matches.length!==1)fail('initializer_unresolved');return matches[0];}
  boot=await load(contract.bootstrap);
  container=boot.__ssamContainer;
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(contract.moduleGuid??'') ||
    boot.__ssamDefinition?.applicationKey?.toLowerCase()!==contract.moduleGuid || boot.__ssamDefinition?.homeModuleKey?.toLowerCase()!==contract.moduleGuid ||
    !container || typeof boot.__ssamMount!=='function' || !Array.isArray(boot.__ssamStages) ||
    boot.__ssamStages.length!==2 || boot.__ssamStages.some(stage=>typeof stage!=='function') || boot.__ssamDefinition?.homeModuleName!==contract.module ||
    Number(boot.__ssamDefinition?.appVersion)!==contract.revision)fail('publication_mismatch');
  return {
    async initialize(){
      if(initialized)fail('already_initialized');initialized=true;
      services=shape('HttpClient','DebuggerHttpClient','AuthConfigsManager');
      await boot.__ssamStages[0]();
      // Keep the native factory registered. Otherwise native post-initialization
      // reconstructs it, restoring transports removed during preparation.
      if(typeof isolateInstrumentation!=='function')fail('instrumentation_boundary_missing');
      const factory=container.resolve(services.InstrumentationFactory);
      instrumentationFactory=factory;
      instrumentation=await isolateInstrumentation(factory);
      if(container.resolve(services.InstrumentationFactory)!==factory)fail('instrumentation_factory_changed');
      container.unregister(services.LoggerHttpClient);
      // Preserve the published bootstrap's formatting arguments, settings
      // callback and Promise.all ordering instead of reconstructing its calls.
      // The final Full initialization/view stage remains deferred until mount.
      await boot.__ssamStages[1]();
      const provider=container.resolve(services.AuthConfigsManager).readAuthConfigs('cognito',{suppressExternalWarnings:true})?.[0];
      if(!provider)fail('auth_provider_unavailable');
      return {initialized:true,nativeAuthProviderAvailable:true,mounted:false};
    },
    async authenticate(session){
      if(!initialized || authenticationAttempted || session?.binding?.runtimeUrl!==contract.url || session.binding.lane!=='odc' ||
        session.binding.module!==contract.module || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt)<=Date.now())fail('authentication_not_ready');
      authenticationAttempted=true;
      const provider=container.resolve(services.AuthConfigsManager).readAuthConfigs('cognito',{suppressExternalWarnings:true})?.[0];
      if(!provider)fail('auth_provider_unavailable');
      const factory=container.resolve(services.Auth);
      nativeAuth=factory.getInstance('external',{identityProvider:provider.kc_hint??provider.type,scope:'openid'});
      let nonce;
      try{nonce=JSON.parse(atob(session.idToken.split('.')[1].replaceAll('-','+').replaceAll('_','/'))).nonce;}
      catch{fail('auth_nonce_missing');}
      if(typeof nonce!=='string'||!nonce)fail('auth_nonce_missing');
      await nativeAuth.storeUserInfo({token_type:'Bearer',access_token:session.accessToken,id_token:session.idToken,refresh_token:session.refreshToken},{nonce,validateNonce:true});
      const auth=shape('builtinLogin','isAuthenticated','getUserId');
      const authenticated=auth.isAuthenticated()===true,identityMatches=auth.getUserId()===session.userKey;
      const tokenMatches=await factory.getInstance().getValidAccessToken()==='Bearer '+session.accessToken;
      if(!authenticated||!identityMatches||!tokenMatches||Date.parse(session.expiresAt)<=Date.now())fail('identity_mismatch');
      return {authenticated,identityMatches,tokenMatches,mounted:false,permissionCheck:false};
    },
    async dispose(){
      await nativeAuth?.clearAuthenticationData();
      localStorage.clear();sessionStorage.clear();modules.dispose();
      return {authenticationCleared:true};
    },
    // Only the private host uses these references for native auth and mounting.
    // They are never serialized as public tool output.
    observeInstrumentation(){
      if(!initialized||typeof inspectInstrumentation!=='function'||!contract.instrumentationState)fail('instrumentation_state_unavailable');
      return inspectInstrumentation({factory:container.resolve(services.InstrumentationFactory),retainedFactory:instrumentationFactory,
        namespace:modules.loadedModule(contract.instrumentationState.file),binding:contract.instrumentationState});
    },
    boot,container,shape,nativeFunction,load,loadedModule:modules.loadedModule,instrumentationReceipt:()=>instrumentation,
  };
}
