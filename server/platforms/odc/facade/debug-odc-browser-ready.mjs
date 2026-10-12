// Wait on the SDK's own application-ready promise. This does not prove that
// screen/block hooks, data actions or scope captures have finished.
// The SDK error path (handleError -> navigateToErrorPage) writes its
// ErrorHandlingStorage session keys and moves to the versioned _error.html.
// It is observed read-only: the location and key names, never stored values,
// and no SDK or app function is called.
// Serialized into the page by page.evaluate; url is the application root.
function errorPageState(url){
 const base=location.href.split(/[?#]/)[0];let marked=null;
 try{const keys=[];for(let i=0;i<sessionStorage.length;i++)keys.push(sessionStorage.key(i));
  marked=keys.some(k=>/ErrorPage(?:Message|ExtraMessage|ExceptionInfo)$/.test(k??''));}catch{marked=null;}
 return {navigated:base.startsWith(url)&&base.endsWith('/_error.html'),marked,valuesRead:false};
}
// runtimeUrl: the mounted location (a deep link keeps its route and query);
// appUrl: the application root that owns the versioned _error.html.
export async function waitForOdcBrowserReady({page,runtimeHandle,runtimeUrl,appUrl=runtimeUrl,expiresAt}){
 const fail=code=>{throw new Error('debug_odc_browser_ready_'+code);};
 const deadline=Date.parse(expiresAt);
 if(typeof page?.evaluate!=='function'||!/^__ssamOdcRuntime_[a-f0-9]{48}$/.test(runtimeHandle??'')||
  !/^https:\/\//.test(runtimeUrl??'')||!/^https:\/\//.test(appUrl??'')||!Number.isFinite(deadline))fail('contract_invalid');
 if(deadline<=Date.now())fail('expired');
 let result,destroyed=false;
 try{
  result=await page.evaluate(async({handle,url,deadline})=>{
   if(location.href!==url||Date.now()>=deadline)return {ready:false,reason:'expired_or_unbound'};
   const runtime=globalThis[handle];
   if(typeof runtime?.shape!=='function')return {ready:false,reason:'unbound'};
   let timer,completed=false;
   try{
    const app=runtime.shape('initializeDatabase','triggerApplicationReadyEvent','onApplicationReady','isApplicationReady');
    if(typeof app.waitForAppReady!=='function'||typeof app.isApplicationReady!=='boolean')return {ready:false,reason:'unbound'};
    completed=await Promise.race([
     app.waitForAppReady().then(()=>true),
     new Promise(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(1,deadline-Date.now()));}),
    ]);
    if(!completed||Date.now()>=deadline)return {ready:false,reason:'expired'};
    if(location.href!==url||app.isApplicationReady!==true)return {ready:false,reason:'native_state_unconfirmed',completed};
    return {ready:true,nativePromiseCompleted:true};
   }catch{return {ready:false,reason:'native_wait_failed'};}
   finally{clearTimeout(timer);}
  },{handle:runtimeHandle,url:runtimeUrl,deadline},Math.max(1,deadline-Date.now())+5000);
 }catch{destroyed=true;}
 // A real error navigation destroys the pending evaluation with its document:
 // the error path is read separately, in whatever document is current now.
 const observed=await observeOdcBrowserErrorPage({page,runtimeUrl:appUrl});
 const errorPage={navigated:observed.navigated===true||observed.historyNavigated===true,
  marked:typeof observed.marked==='boolean'?observed.marked:null,valuesRead:false};
 if(destroyed||result?.ready!==true||result.nativePromiseCompleted!==true){
  // The original error path ran: a known native state, reported, not a timeout.
  if(errorPage.navigated||errorPage.marked===true)
   return {nativeApplicationReady:false,nativePromiseCompleted:false,errorPageObserved:true,errorPage,lifecycleComplete:false,mountedVerified:false};
  if(!destroyed&&['expired','expired_or_unbound'].includes(result?.reason))fail('expired');
  fail('unconfirmed');
 }
 return {nativeApplicationReady:true,nativePromiseCompleted:true,errorPage,lifecycleComplete:false,mountedVerified:false};
}
const errorPageOf=v=>({navigated:v?.navigated===true,marked:typeof v?.marked==='boolean'?v.marked:null,valuesRead:false});
// Also after the lifecycle settles (the error navigation may follow a resumed
// exception stop). Navigation history is read through CDP; nothing else.
export async function observeOdcBrowserErrorPage({page,runtimeUrl,timeoutMs=5000}){
 if(typeof page?.evaluate!=='function'||!/^https:\/\//.test(runtimeUrl??''))throw new Error('debug_odc_browser_ready_contract_invalid');
 let state,history;
 try{state=errorPageOf(await page.evaluate(errorPageState,runtimeUrl,timeoutMs));}catch{}
 try{history=typeof page.send==='function'?await page.send('Page.getNavigationHistory',{},timeoutMs):undefined;}catch{}
 const historyNavigated=Array.isArray(history?.entries)?history.entries.some(e=>{const base=String(e?.url??'').split(/[?#]/)[0];
  return base.startsWith(runtimeUrl)&&base.endsWith('/_error.html');}):null;
 // History alone is evidence too: the new document may be unreadable.
 if(!state)return historyNavigated===true?{observed:true,navigated:false,marked:null,historyNavigated,valuesRead:false,appCodeCalled:false}
  :{observed:false,valuesRead:false,appCodeCalled:false};
 return {observed:true,navigated:state.navigated,marked:state.marked,historyNavigated,valuesRead:false,appCodeCalled:false};
}
