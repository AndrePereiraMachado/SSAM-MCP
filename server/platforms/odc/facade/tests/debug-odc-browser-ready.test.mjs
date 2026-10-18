import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {waitForOdcBrowserReady} from '../debug-odc-browser-ready.mjs';
function fixture(){
 const runtimeHandle='__ssamOdcRuntime_'+'a'.repeat(48),runtimeUrl='https://fixture.example/App/';
 let resolve,calls=0;const promise=new Promise(r=>resolve=r);
 const app={isApplicationReady:false,waitForAppReady(){calls++;return promise;}};
 const context=vm.createContext({location:{href:runtimeUrl},Date,setTimeout,clearTimeout,[runtimeHandle]:{shape:()=>app}});
 const page={evaluate:async(fn,arg)=>{context.arg=arg;return vm.runInContext('('+fn.toString()+')(arg)',context);}};
 return {app,context,resolve,calls:()=>calls,args:{page,runtimeHandle,runtimeUrl,expiresAt:new Date(Date.now()+5000).toISOString()}};
}
test('wait uses the native promise and checks native readiness without claiming screen completion',async()=>{
 const f=fixture();let completed=false;
 const wait=waitForOdcBrowserReady(f.args).then(r=>{completed=true;return r;});
 await new Promise(r=>setImmediate(r));assert.equal(f.calls(),1);assert.equal(completed,false);
 f.app.isApplicationReady=true;f.resolve();const r=await wait;
 assert.deepEqual(r,{nativeApplicationReady:true,nativePromiseCompleted:true,errorPage:{navigated:false,marked:null,valuesRead:false},lifecycleComplete:false,mountedVerified:false});
});
test('resolved promise alone cannot prove readiness and navigation invalidates the result',async()=>{
 for(const navigate of [false,true]){
  const f=fixture();const wait=waitForOdcBrowserReady(f.args);
  if(navigate){f.app.isApplicationReady=true;f.context.location.href='https://other.example/';}
  f.resolve();await assert.rejects(wait,/unconfirmed/);
 }
});
test('expiry bounds an unresolved native promise without calling mount or a second wait',async()=>{
 const f=fixture();f.args.expiresAt=new Date(Date.now()+80).toISOString();
 await assert.rejects(waitForOdcBrowserReady(f.args),/expired/);assert.equal(f.calls(),1);
 await assert.rejects(waitForOdcBrowserReady(f.args),/expired/);assert.equal(f.calls(),1);
 f.resolve();
});
test('native error and missing promise API expose only bounded diagnostics',async()=>{
 for(const fail of [()=>{throw Error('private-value');},undefined]){
  const f=fixture();f.app.waitForAppReady=fail;
  await assert.rejects(waitForOdcBrowserReady(f.args),/^Error: debug_odc_browser_ready_unconfirmed$/);
 }
});
import {observeOdcBrowserErrorPage} from '../debug-odc-browser-ready.mjs';
// The SDK navigateToErrorPage path: ErrorHandlingStorage session keys and the versioned _error.html location.
function storage(keys){const touched=[];return {touched,get length(){return keys.length;},key:i=>keys[i]??null,
 getItem:k=>{touched.push('get:'+k);return 'private-message';},setItem:k=>touched.push('set:'+k),removeItem:k=>touched.push('remove:'+k),clear:()=>touched.push('clear')};}
test('SDK error-page state is observed read-only: key names and location only, never values',async()=>{
 const f=fixture(),store=storage(['os.ErrorHandling.ErrorPageMessage','os.ErrorHandling.ErrorPageExceptionInfo','other']);
 f.context.sessionStorage=store;
 const wait=waitForOdcBrowserReady(f.args);
 f.context.location.href=f.args.runtimeUrl+'_error.html?v=3';f.resolve();
 const r=await wait;
 assert.deepEqual(r,{nativeApplicationReady:false,nativePromiseCompleted:false,errorPageObserved:true,
  errorPage:{navigated:true,marked:true,valuesRead:false},lifecycleComplete:false,mountedVerified:false});
 assert.deepEqual(store.touched,[]);assert.doesNotMatch(JSON.stringify(r),/private-message|ErrorPageMessage/);
 // A ready application reports a clean error-page state; no storage means unknown, not clean.
 const ok=fixture();ok.context.sessionStorage=storage([]);const w=waitForOdcBrowserReady(ok.args);ok.app.isApplicationReady=true;ok.resolve();
 assert.deepEqual((await w).errorPage,{navigated:false,marked:false,valuesRead:false});
 const none=fixture();const n=waitForOdcBrowserReady(none.args);none.app.isApplicationReady=true;none.resolve();
 assert.deepEqual((await n).errorPage,{navigated:false,marked:null,valuesRead:false});
 // An unrelated failure without error-page evidence still refuses.
 const other=fixture();other.context.sessionStorage=storage([]);const o=waitForOdcBrowserReady(other.args);other.context.location.href='https://other.example/';other.resolve();
 await assert.rejects(o,/unconfirmed/);
});
test('error-page observation after the lifecycle reads location, key names and navigation history only',async()=>{
 const f=fixture(),store=storage(['os.ErrorHandling.ErrorPageMessage']),sent=[];
 f.context.sessionStorage=store;f.context.location.href=f.args.runtimeUrl+'_error.html';
 const page={...f.args.page,send:async method=>{sent.push(method);return {currentIndex:1,entries:[{url:f.args.runtimeUrl},{url:f.args.runtimeUrl+'_error.html?v=3'}]};}};
 assert.deepEqual(await observeOdcBrowserErrorPage({page,runtimeUrl:f.args.runtimeUrl}),
  {observed:true,navigated:true,marked:true,historyNavigated:true,valuesRead:false,appCodeCalled:false});
 assert.deepEqual(sent,['Page.getNavigationHistory']);assert.deepEqual(store.touched,[]);
 // A clean page; an unreadable page is unobserved, never clean.
 const g=fixture();g.context.sessionStorage=storage([]);
 const clean={...g.args.page,send:async()=>({currentIndex:0,entries:[{url:g.args.runtimeUrl}]})};
 assert.deepEqual(await observeOdcBrowserErrorPage({page:clean,runtimeUrl:g.args.runtimeUrl}),
  {observed:true,navigated:false,marked:false,historyNavigated:false,valuesRead:false,appCodeCalled:false});
 const lost={evaluate:async()=>{throw Error('gone');},send:async()=>{throw Error('gone');}};
 assert.deepEqual(await observeOdcBrowserErrorPage({page:lost,runtimeUrl:g.args.runtimeUrl}),{observed:false,valuesRead:false,appCodeCalled:false});
 await assert.rejects(observeOdcBrowserErrorPage({page:lost,runtimeUrl:'http://x/'}),/contract_invalid/);
});
// A real navigateToErrorPage loads a new document: the pending ready evaluation is
// destroyed with its context. The error path is then read in the new document.
function navigating(f,{keys=['os.ErrorHandling.ErrorPageMessage'],errorUrl=f.args.runtimeUrl+'_error.html?v=3',history=true}={}){
 const store=storage(keys),sent=[];let first=true;
 const fresh=vm.createContext({location:{href:errorUrl},Date,setTimeout,clearTimeout,sessionStorage:store});
 const page={evaluate:async(fn,arg)=>{
   if(first){first=false;throw new Error('Execution context was destroyed.');}
   fresh.arg=arg;return vm.runInContext('('+fn.toString()+')(arg)',fresh);},
  send:async method=>{sent.push(method);return history?{currentIndex:1,entries:[{url:f.args.runtimeUrl},{url:errorUrl}]}:{currentIndex:0,entries:[{url:errorUrl}]};}};
 return {store,sent,page};
}
test('a ready wait destroyed by the SDK error navigation reads the error page in the new document',async()=>{
 const f=fixture(),n=navigating(f);
 const r=await waitForOdcBrowserReady({...f.args,page:n.page});
 assert.deepEqual(r,{nativeApplicationReady:false,nativePromiseCompleted:false,errorPageObserved:true,
  errorPage:{navigated:true,marked:true,valuesRead:false},lifecycleComplete:false,mountedVerified:false});
 assert.deepEqual(n.sent,['Page.getNavigationHistory']);assert.deepEqual(n.store.touched,[]);
 // History alone (the new document unreadable for keys) still proves the original error path.
 const g=fixture(),h=navigating(g,{keys:[]});
 assert.equal((await waitForOdcBrowserReady({...g.args,page:h.page})).errorPageObserved,true);
 // A destroyed context without error-page evidence is a bounded refusal, never ready.
 const o=fixture(),other=navigating(o,{keys:[],errorUrl:'https://other.example/',history:false});
 await assert.rejects(waitForOdcBrowserReady({...o.args,page:other.page}),/^Error: debug_odc_browser_ready_unconfirmed$/);
});
test('a deep-link mount compares the error page with the application root, not the route URL',async()=>{
 const f=fixture(),appUrl=f.args.runtimeUrl,deep=appUrl+'InputProbe?Seed=9';
 f.context.location.href=deep;f.context.sessionStorage=storage([]);
 const wait=waitForOdcBrowserReady({...f.args,runtimeUrl:deep,appUrl});
 f.context.location.href=appUrl+'_error.html';f.resolve();
 assert.deepEqual((await wait).errorPage,{navigated:true,marked:false,valuesRead:false});
 await assert.rejects(waitForOdcBrowserReady({...f.args,runtimeUrl:deep,appUrl:'http://x/'}),/contract_invalid/);
});
