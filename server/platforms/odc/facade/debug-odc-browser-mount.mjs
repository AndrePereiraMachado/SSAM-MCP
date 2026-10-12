// Private mount coordinator. Executes the original final bootstrap callback;
// it never substitutes lifecycle events or reconstructs application startup.
// The barrier is an explicit Development authorization (user words, pinned
// published assets, owned headless browser), not a static proof of every SDK
// effect: staticEffectsQualified stays false in every record.
import {createHash} from 'node:crypto';
export const odcMountPolicy='authorized-development-native-mount';
const sha=/^[a-f0-9]{64}$/,modelKey=/^[A-Za-z0-9_+]{22}$/,segment=/^[A-Za-z0-9_-]+$/;
const digest=s=>createHash('sha256').update(s).digest('hex');
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
// Deep link: a qualified named route and the exact authorized query (by hash).
const isRoute=(route,withQuery)=>exactKeys(route,withQuery?['segment','query','querySha256']:['segment','querySha256'])&&segment.test(route.segment)&&
 sha.test(route.querySha256)&&(!withQuery||typeof route.query==='string'&&!/[?#]/.test(route.query)&&digest(route.query)===route.querySha256);
// In-app navigation: one target screen, its route, back required, and the authorized inputs hashes.
const isNavigation=n=>exactKeys(n,['screenKey','segment','back','inputsSha256'])&&modelKey.test(n.screenKey)&&segment.test(n.segment)&&n.back===true&&
 Array.isArray(n.inputsSha256)&&n.inputsSha256.length>0&&n.inputsSha256.length<=50&&n.inputsSha256.every(h=>sha.test(h??''));
const optional=(value,keys,checks)=>Object.keys(value).every(k=>keys.includes(k))&&Object.entries(checks).every(([k,check])=>value[k]===undefined||check(value[k]));
// Parent request: what the user authorized. The host adds the fresh evidence.
export function isOdcMountRequest(request){
 return request?.policy===odcMountPolicy&&sha.test(request.authorizationSha256??'')&&/^https:\/\//.test(request.runtimeUrl??'')&&
  modelKey.test(request.screenKey??'')&&optional(request,['policy','authorizationSha256','runtimeUrl','screenKey','route','navigation'],
   {route:r=>isRoute(r,true),navigation:isNavigation});
}
export function isOdcBrowserMountAuthorized(authorization){
 return authorization?.policy===odcMountPolicy&&authorization.staticEffectsQualified===false&&
  sha.test(authorization.sourceSha256??'')&&sha.test(authorization.authorizationSha256??'')&&
  /^https:\/\//.test(authorization.runtimeUrl??'')&&modelKey.test(authorization.screenKey??'')&&
  Array.isArray(authorization.requiredModelRoots)&&authorization.requiredModelRoots.length>0&&
  (authorization.route===undefined||isRoute(authorization.route,false))&&(authorization.navigation===undefined||isNavigation(authorization.navigation));
}
// initialLocation (deep link only): the hash-bound SDK generateScreenURL builds
// the route URL in the page, and history.replaceState sets it before the final
// bootstrap stage creates the router. A URL other than the authorized one never mounts.
export function createOdcBrowserMount({page,runtimeHandle,authentication,inspection,authorization,beforeMount,recordOutcome,timeoutMs=60000,expiresAt,initialLocation}){
 const fail=code=>{throw new Error('debug_odc_browser_mount_'+code);};
 if(typeof page?.evaluate!=='function'||!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(runtimeHandle??'')||
  typeof authentication?.receipt!=='function'||typeof inspection?.receipt!=='function'||
  typeof beforeMount!=='function'||typeof recordOutcome!=='function'||
  !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>1805000||expiresAt!==undefined&&!Number.isFinite(Date.parse(expiresAt)))fail('contract_invalid');
 const deadline=expiresAt===undefined?undefined:Date.parse(expiresAt);
 let attempted=false,submitted=false,replyConfirmed=false,outcomeRecorded=false,callbackReturned=false,nativeInvoked=null;
 return {
  async mount(){
   if(attempted)fail('already_attempted');
   if(deadline!==undefined&&deadline<=Date.now())fail('inspection_expired');
   const auth=authentication.receipt(),debug=inspection.receipt();
   if(auth.confirmed!==true||debug.started!==true||debug.closed!==false)fail('session_not_ready');
   if(!isOdcBrowserMountAuthorized(authorization))fail('not_authorized');
   const route=authorization.route,initial=initialLocation??undefined;
   let deepLink;
   if(route||initial){
    if(!route||!initial||initial.segment!==route.segment||typeof initial.query!=='string'||digest(initial.query)!==route.querySha256||
     !/^_oschunk-[A-Za-z0-9]+\.js$/.test(initial.coreFile??'')||!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(initial.navigationExport??'')||
     typeof initial.source!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(initial.module??''))fail('not_authorized');
    const params=[...new URLSearchParams(initial.query)];
    if(params.map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&')!==initial.query||new Set(params.map(p=>p[0])).size!==params.length)fail('not_authorized');
    deepLink={coreFile:initial.coreFile,navigationExport:initial.navigationExport,source:initial.source,module:initial.module,segment:route.segment,
     params:Object.fromEntries(params),expected:new URL(route.segment,authorization.runtimeUrl).href+(initial.query?'?'+initial.query:'')};
   }
   // Set before journaling: an uncertain journal response cannot be retried.
   attempted=true;
   const recorded=await beforeMount({policy:authorization.policy,authorizationSha256:authorization.authorizationSha256,
    sourceSha256:authorization.sourceSha256,runtimeUrl:authorization.runtimeUrl,screenKey:authorization.screenKey,
    requiredModelRoots:[...authorization.requiredModelRoots],staticEffectsQualified:false,
    ...(route?{route:{segment:route.segment,querySha256:route.querySha256}}:{}),...(authorization.navigation?{navigation:structuredClone(authorization.navigation)}:{})});
   if(recorded?.recorded!==true)fail('submission_unrecorded');
   if(deadline!==undefined&&deadline<=Date.now()){
    nativeInvoked=false;replyConfirmed=true;
    outcomeRecorded=(await recordOutcome({invoked:false,callbackReturned:false,inspectionExpired:true}))?.recorded===true;
    if(!outcomeRecorded)fail('outcome_unrecorded');
    fail('inspection_expired');
   }
   // Native initialization may execute application code before its promise
   // settles. A transport timeout is not permission to invoke it a second time.
   submitted=true;
   let outcome;
   try{
    outcome=await page.evaluate(async({handle,url,deepLink})=>{
     const runtime=globalThis[handle];
     if(location.href!==url||typeof runtime?.boot?.__ssamMount!=='function')return {invoked:false,callbackReturned:false};
     let initialLocationSet=false;
     if(deepLink){
      try{
       const nav=runtime.loadedModule?.(deepLink.coreFile)?.[deepLink.navigationExport];
       const d=nav&&Object.isFrozen(nav)?Object.getOwnPropertyDescriptor(nav,'generateScreenURL'):undefined;
       if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||Function.prototype.toString.call(d.value)!==deepLink.source)
        return {invoked:false,callbackReturned:false,initialLocationSet};
       // A URL that needs uninitialized application state or differs from the authorized one refuses.
       const built=d.value(deepLink.module,deepLink.segment,deepLink.params);
       if(typeof built!=='string'||new URL(built,location.href).href!==deepLink.expected)return {invoked:false,callbackReturned:false,initialLocationSet};
       history.replaceState(history.state,'',built);
       if(location.href!==deepLink.expected)return {invoked:false,callbackReturned:false,initialLocationSet};
       initialLocationSet=true;
      }catch{return {invoked:false,callbackReturned:false,initialLocationSet};}
     }
     try{await runtime.boot.__ssamMount();return {invoked:true,callbackReturned:true,...(deepLink?{initialLocationSet}:{})};}
     catch{return {invoked:true,callbackReturned:false,...(deepLink?{initialLocationSet}:{})};}
    },{handle:runtimeHandle,url:authorization.runtimeUrl,deepLink},deadline===undefined?timeoutMs:Math.min(timeoutMs,deadline-Date.now()+5000));
    if(typeof outcome?.invoked!=='boolean'||typeof outcome?.callbackReturned!=='boolean'||!outcome.invoked&&outcome.callbackReturned)
     fail('reply_invalid');
    replyConfirmed=true;callbackReturned=outcome.callbackReturned;nativeInvoked=outcome.invoked;
   }catch{outcome={invoked:null,callbackReturned:false,transportUnconfirmed:true};}
   const persisted=await recordOutcome(outcome);
   outcomeRecorded=persisted?.recorded===true;
   if(!outcomeRecorded)fail('outcome_unrecorded');
   if(!replyConfirmed)fail('result_uncertain');
   if(!callbackReturned)fail('native_mount_failed');
   // Completion of this callback is NOT proof of rendered widgets, finished
   // asynchronous lifecycle hooks, role propagation, or successful cleanup.
   return {nativeBootstrapInvoked:true,startupCallbackReturned:true,outcomeRecorded:true,
    lifecycleComplete:false,mountedVerified:false};
  },
  receipt(){return {attempted,submitted,nativeInvoked,replyConfirmed,outcomeRecorded,callbackReturned,
   uncertain:submitted&&(!replyConfirmed||!outcomeRecorded||nativeInvoked&&!callbackReturned),lifecycleComplete:false,mountedVerified:false};},
 };
}
