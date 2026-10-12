// Import only the qualified original controller into the authenticated runtime.
// Missing tracking is a refused prerequisite, never evidence of an empty ESM cache.
export function createOdcBrowserControllerLoad({page,runtimeHandle,runtimeUrl,authentication,qualification,
 controllerModule,beforeLoad,recordOutcome,importKind='controller'}){
 const fail=code=>{throw new Error('debug_odc_browser_controller_load_'+code);};
 if(!['controller','view','messages'].includes(importKind)||typeof page?.evaluate!=='function'||!/^__ssamOdcRuntime_[a-f0-9]{48}$/.test(runtimeHandle??'')||
  !/^https:\/\//.test(runtimeUrl??'')||!/^_oschunk-[A-Za-z0-9]+\.js$/.test(controllerModule??'')||
  typeof authentication?.receipt!=='function'||typeof beforeLoad!=='function'||typeof recordOutcome!=='function')fail('contract_invalid');
 let attempted=false,submitted=false,replyConfirmed=false,outcomeRecorded=false,importReturned=false,nativeInvoked=null;
 return {
  async load(){
   if(attempted)fail('already_attempted');
   if(authentication.receipt().confirmed!==true)fail('authentication_required');
   const q=qualification,required=q?.requiredAlreadyLoadedModules;
   if(q?.initializationQualified!==true||q.nativeEffectsQualified!==true||q.wrapperSyntaxQualified!==true||
    !Array.isArray(q.pendingNativeEffectKinds)||q.pendingNativeEffectKinds.length||
    !Array.isArray(required)||!required.length||required.some(f=>!/^_oschunk-[A-Za-z0-9]+\.js$/.test(f))||
    !/^[a-f0-9]{64}$/.test(q.controller?.sourceHashes?.[controllerModule]??''))fail('qualification_incomplete');
   attempted=true;
   if((await beforeLoad({controllerModule,runtimeUrl,sourceHashes:{...q.controller.sourceHashes},requiredAlreadyLoadedModules:[...required]}))?.recorded!==true)
    fail('submission_unrecorded');
   submitted=true;let outcome;
   try{
    outcome=await page.evaluate(async({handle,url,file,required})=>{
     const runtime=globalThis[handle];
     if(location.href!==url||typeof runtime?.loadedModule!=='function'||typeof runtime?.load!=='function')
      return {invoked:false,importReturned:false,reason:'runtime_unbound'};
     if(required.some(name=>runtime.loadedModule(name)===undefined))
      return {invoked:false,importReturned:false,reason:'prerequisite_not_tracked'};
     try{await runtime.load(file);return {invoked:true,importReturned:true};}
     catch{return {invoked:true,importReturned:false};}
    },{handle:runtimeHandle,url:runtimeUrl,file:controllerModule,required:[...required]},30000);
    if(typeof outcome?.invoked!=='boolean'||typeof outcome?.importReturned!=='boolean'||!outcome.invoked&&outcome.importReturned)
     fail('reply_invalid');
    // Copy only the bounded diagnostic vocabulary; never persist native values/errors.
    outcome={invoked:outcome.invoked,importReturned:outcome.importReturned,
     ...(['runtime_unbound','prerequisite_not_tracked'].includes(outcome.reason)?{reason:outcome.reason}:{})};
    nativeInvoked=outcome.invoked;importReturned=outcome.importReturned;replyConfirmed=true;
   }catch{outcome={invoked:null,importReturned:false,transportUnconfirmed:true};}
   outcomeRecorded=(await recordOutcome(outcome))?.recorded===true;
   if(!outcomeRecorded)fail('outcome_unrecorded');
   if(!replyConfirmed)fail('result_uncertain');
   if(!nativeInvoked)fail(outcome.reason??'runtime_unbound');
   if(!importReturned)fail('native_import_failed');
   return {[{view:'nativeViewImported',messages:'nativeMessagesImported',controller:'nativeControllerImported'}[importKind]]:true,outcomeRecorded:true,applicationStartupQualified:false,lifecycleComplete:false};
  },
  receipt:()=>({attempted,submitted,replyConfirmed,outcomeRecorded,nativeInvoked,importReturned,
   uncertain:submitted&&(!replyConfirmed||!outcomeRecorded||nativeInvoked&&!importReturned),lifecycleComplete:false}),
 };
}
