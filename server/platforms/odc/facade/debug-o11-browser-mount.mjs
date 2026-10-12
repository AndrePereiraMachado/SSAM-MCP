// Private O11 mount coordinator (option B, O11). Executes the ORIGINAL bootstrap
// (<Module>.index.js, unchanged) exactly once in the clean mount realm: it
// initializes the application (Full), fires the original application-ready
// event and loads the router, which requires the screen controllers. Nothing
// substitutes lifecycle events or reconstructs startup. The barrier is the
// user's explicit Development authorization, not a static proof of effects:
// staticEffectsQualified stays false in every record.
import {observeOdcBrowserErrorPage} from './debug-odc-browser-ready.mjs';
export const o11MountPolicy='authorized-development-native-mount';
const sha=/^[a-f0-9]{64}$/,modelKey=/^[A-Za-z0-9_+]{22}$/,HANDLE=/^__ssamO11Runtime_[a-f0-9]{48}$/;
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
// Parent request: what the user authorized (default route only). The host adds the fresh evidence.
export function isO11MountRequest(request){
 return exactKeys(request,['policy','authorizationSha256','runtimeUrl','screenKey'])&&request.policy===o11MountPolicy&&
  sha.test(request.authorizationSha256??'')&&/^https:\/\/[^/]+\/[A-Za-z_][A-Za-z0-9_]*\/$/.test(request.runtimeUrl??'')&&modelKey.test(request.screenKey??'');
}
export function isO11BrowserMountAuthorized(authorization){
 return authorization?.policy===o11MountPolicy&&authorization.staticEffectsQualified===false&&authorization.developmentProved===true&&
  authorization.bootstrapQualified===true&&sha.test(authorization.sourceSha256??'')&&sha.test(authorization.authorizationSha256??'')&&
  sha.test(authorization.bootstrapSha256??'')&&/^https:\/\//.test(authorization.runtimeUrl??'')&&modelKey.test(authorization.screenKey??'');
}
export function createO11BrowserMount({page,runtimeHandle,authentication,inspection,authorization,beforeMount,recordOutcome,timeoutMs=60000,expiresAt}){
 const fail=code=>{throw new Error('debug_o11_browser_mount_'+code);};
 if(typeof page?.evaluate!=='function'||!HANDLE.test(runtimeHandle??'')||typeof authentication?.receipt!=='function'||typeof inspection?.receipt!=='function'||
  typeof beforeMount!=='function'||typeof recordOutcome!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>1805000||
  expiresAt!==undefined&&!Number.isFinite(Date.parse(expiresAt)))fail('contract_invalid');
 const deadline=expiresAt===undefined?undefined:Date.parse(expiresAt);
 let attempted=false,submitted=false,replyConfirmed=false,outcomeRecorded=false,callbackReturned=false,nativeInvoked=null;
 return {
  async mount(){
   if(attempted)fail('already_attempted');
   if(deadline!==undefined&&deadline<=Date.now())fail('inspection_expired');
   const auth=authentication.receipt(),debug=inspection.receipt();
   if(auth.confirmed!==true||debug.started!==true||debug.closed!==false)fail('session_not_ready');
   if(!isO11BrowserMountAuthorized(authorization))fail('not_authorized');
   // Set before journaling: an uncertain journal response cannot be retried.
   attempted=true;
   const recorded=await beforeMount({policy:authorization.policy,authorizationSha256:authorization.authorizationSha256,
    sourceSha256:authorization.sourceSha256,bootstrapSha256:authorization.bootstrapSha256,runtimeUrl:authorization.runtimeUrl,
    screenKey:authorization.screenKey,route:{default:true},staticEffectsQualified:false});
   if(recorded?.recorded!==true)fail('submission_unrecorded');
   if(deadline!==undefined&&deadline<=Date.now()){
    nativeInvoked=false;replyConfirmed=true;
    outcomeRecorded=(await recordOutcome({invoked:false,callbackReturned:false,inspectionExpired:true}))?.recorded===true;
    if(!outcomeRecorded)fail('outcome_unrecorded');
    fail('inspection_expired');
   }
   // The bootstrap runs application code before its promise settles. A transport
   // timeout is not permission to run it a second time.
   submitted=true;
   let outcome;
   try{
    outcome=await page.evaluate(async({handle,url})=>{
     const runtime=globalThis[handle];
     if(location.href!==url||typeof runtime?.boot?.__ssamMount!=='function')return {invoked:false,callbackReturned:false};
     try{const r=await runtime.boot.__ssamMount();return {invoked:r?.invoked===true,callbackReturned:r?.invoked===true&&r.callbackReturned===true};}
     catch{return {invoked:true,callbackReturned:false};}
    },{handle:runtimeHandle,url:authorization.runtimeUrl},deadline===undefined?timeoutMs:Math.min(timeoutMs,deadline-Date.now()+5000));
    if(typeof outcome?.invoked!=='boolean'||typeof outcome?.callbackReturned!=='boolean'||!outcome.invoked&&outcome.callbackReturned)fail('reply_invalid');
    replyConfirmed=true;callbackReturned=outcome.callbackReturned;nativeInvoked=outcome.invoked;
   }catch{outcome={invoked:null,callbackReturned:false,transportUnconfirmed:true};}
   outcomeRecorded=(await recordOutcome(outcome))?.recorded===true;
   if(!outcomeRecorded)fail('outcome_unrecorded');
   if(!replyConfirmed)fail('result_uncertain');
   if(!callbackReturned)fail('native_mount_failed');
   // The evaluated bootstrap is NOT proof of rendered widgets or finished hooks.
   return {nativeBootstrapInvoked:true,startupCallbackReturned:true,outcomeRecorded:true,lifecycleComplete:false,mountedVerified:false};
  },
  receipt(){return {attempted,submitted,nativeInvoked,replyConfirmed,outcomeRecorded,callbackReturned,
   uncertain:submitted&&(!replyConfirmed||!outcomeRecorded||nativeInvoked&&!callbackReturned),lifecycleComplete:false,mountedVerified:false};},
 };
}
// The runtime's own Application.default.waitForAppReady() and isReady, plus the
// router's first render in #reactContainer. Not proof of screen/block hooks.
// The original error path (handleError -> navigateToErrorPage -> _error.html) is read-only.
export async function waitForO11BrowserReady({page,runtimeHandle,runtimeUrl,expiresAt,observeErrorPage=observeOdcBrowserErrorPage}){
 const fail=code=>{throw new Error('debug_o11_browser_ready_'+code);};
 const deadline=Date.parse(expiresAt);
 if(typeof page?.evaluate!=='function'||!HANDLE.test(runtimeHandle??'')||!/^https:\/\//.test(runtimeUrl??'')||!Number.isFinite(deadline))fail('contract_invalid');
 if(deadline<=Date.now())fail('expired');
 let result,destroyed=false;
 try{
  result=await page.evaluate(async({handle,base,deadline})=>{
   const inApp=()=>location.href.split(/[?#]/)[0].startsWith(base);
   if(!inApp()||Date.now()>=deadline)return {ready:false,reason:'expired_or_unbound'};
   const runtime=globalThis[handle];let timer;
   try{
    const app=runtime?.application?.();
    if(typeof app?.waitForAppReady!=='function')return {ready:false,reason:'unbound'};
    const completed=await Promise.race([app.waitForAppReady().then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(1,deadline-Date.now()));})]);
    if(!completed||Date.now()>=deadline)return {ready:false,reason:'expired'};
    const container=document.getElementById('reactContainer');
    if(!inApp()||app.isReady!==true)return {ready:false,reason:'native_state_unconfirmed'};
    return {ready:true,nativePromiseCompleted:true,routerRendered:!!container&&container.childElementCount>0};
   }catch{return {ready:false,reason:'native_wait_failed'};}
   finally{clearTimeout(timer);}
  },{handle:runtimeHandle,base:runtimeUrl,deadline},Math.max(1,deadline-Date.now())+5000);
 }catch{destroyed=true;}
 const observed=await observeErrorPage({page,runtimeUrl});
 const errorPage={navigated:observed?.navigated===true||observed?.historyNavigated===true,marked:typeof observed?.marked==='boolean'?observed.marked:null,valuesRead:false};
 if(destroyed||result?.ready!==true||result.nativePromiseCompleted!==true){
  if(errorPage.navigated||errorPage.marked===true)
   return {nativeApplicationReady:false,nativePromiseCompleted:false,routerRendered:false,errorPageObserved:true,errorPage,lifecycleComplete:false,mountedVerified:false};
  if(!destroyed&&['expired','expired_or_unbound'].includes(result?.reason))fail('expired');
  fail('unconfirmed');
 }
 return {nativeApplicationReady:true,nativePromiseCompleted:true,routerRendered:result.routerRendered===true,errorPage,lifecycleComplete:false,mountedVerified:false};
}
