// Original in-app navigation of a mounted ODC screen. Only the reviewed core SDK
// Navigation exports are called, bound by declaration hash: generateScreenURL
// builds the URL and navigateTo/navigateBack hand it to the router's own goTo/
// goBack callbacks. The changeWindowLocation full-reload branch of navigateTo
// is refused before the call: a reload would skip OnDestroy and lose the session.
// No lifecycle hook is called here; the original router runs them.
import {parse} from 'acorn';
import {createHash,randomBytes} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';

const fail=code=>{throw new Error('debug_odc_browser_navigation_'+code);};
const hash=s=>createHash('sha256').update(s).digest('hex');
const SEGMENT=/^[A-Za-z0-9_-]+$/,NAME=/^[A-Za-z_][A-Za-z0-9_]{0,120}$/,unsafe=new Set(['__proto__','prototype','constructor']);
// Pinned _oschunk 1dbfad22: Navigation namespace `ude` exported as `s` (QO/ire/CH/pu/ZO).
export const odcNavigationPin=Object.freeze({coreSha256:'1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d',export:'s',
 declarations:Object.freeze({navigateTo:'402f5d28fd1fd05f9fa4216aabf3e554d552fbf079271ccf574a62c2610ec6ce',
  generateScreenURL:'f652ac36be89dde3a33bfb3df3a4fb562dd9105d807f947420c1a80f62463b64',
  navigateBack:'771c96df235f092f3888da70afbae772f7cc031b893ce07aec99ccc7cd323f15',
  getNavigationCallbacks:'cd92e09b0f2d5b72cdd6b366fce4561fe8e167345e569b4a8600cc58156a878e',
  getUrlInfo:'dbe3547ecffc77dbfeeffc8da28cadad8f73a74e1cdc30ab7543f46de0b501b3'})});
const MEMBERS=['navigateTo','generateScreenURL','navigateBack','getNavigationCallbacks','getUrlInfo'];
// Source only: no getter, factory or SDK function runs. `source` is what
// Function.prototype.toString returns for the member in the page.
export function bindOdcSdkNavigation(files,pin=odcNavigationPin){
 const matches=Object.entries(files??{}).filter(([name,text])=>/^_oschunk-[A-Za-z0-9]+\.js$/.test(name)&&typeof text==='string'&&hash(text)===pin?.coreSha256);
 if(matches.length!==1)fail('core_unreviewed');
 const [file,text]=matches[0],bind=createOdcSdkBindingReader({[file]:text}),members={};
 for(const member of MEMBERS){
  let r;try{r=bind({file:'./'+file,export:pin.export,member});}catch{fail('member_unbound');}
  if(pin.declarations!==null&&r.declarationSha256!==pin.declarations?.[member])fail('declaration_unreviewed');
  let source=text.slice(r.start,r.end);
  if(r.declarationKind==='CallExpression'){
   // Name helper around a function expression: s(function(t){...},"getUrlInfo").
   const call=parse('('+source+')',{ecmaVersion:'latest'}).body[0].expression,fn=call.arguments?.[0];
   if(call.callee?.type!=='Identifier'||call.arguments.length!==2||fn?.type!=='FunctionExpression'||fn.async||fn.generator||
    call.arguments[1].type!=='Literal'||call.arguments[1].value!==member)fail('member_unbound');
   source=source.slice(fn.start-1,fn.end-1);
  }else if(r.declarationKind!=='FunctionDeclaration')fail('member_unbound');
  members[member]={symbol:r.symbol,declarationSha256:r.declarationSha256,source};
 }
 return {navigationBound:true,file,export:pin.export,chunkSha256:pin.coreSha256,members,effectsQualified:false};
}
// Canonical screen query: ordered [name,value] pairs of strings, encoded like the SDK.
export function odcScreenQuery(inputs){
 const pairs=Array.isArray(inputs)?inputs:Object.entries(inputs??{});
 if(pairs.some(p=>!Array.isArray(p)||p.length!==2||!NAME.test(p[0]??'')||unsafe.has(p[0])||typeof p[1]!=='string')||
  new Set(pairs.map(p=>p[0])).size!==pairs.length)fail('inputs_invalid');
 const query=pairs.map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
 return {query,querySha256:hash(query)};
}
export function odcScreenLocation(runtimeUrl,segment,query){
 if(!SEGMENT.test(segment??''))fail('segment_invalid');
 if(typeof query!=='string'||/[?#]/.test(query))fail('query_invalid');
 return new URL(segment,runtimeUrl).href+(query?'?'+query:'');
}
// Serialized into the page and evaluated WITHOUT awaitPromise: a lifecycle
// breakpoint may hold V8 inside the original code, and an awaited promise could
// not answer until it resumes. Every call is decided in this synchronous turn.
// Right before the call a debugger-owned global records the runtime handle and
// the router callbacks: a reload is a new realm where that mark no longer exists.
function navigateInPage({handle,mark,from,coreFile,navigationExport,sources,module,segment,params,expected,direction}){
 if(location.href!==from)return {invoked:false,reason:'location-changed'};
 const runtime=globalThis[handle];
 try{
  const namespace=runtime?.loadedModule?.(coreFile),nav=namespace?.[navigationExport],fns={};
  if(!nav||!Object.isFrozen(nav))return {invoked:false,reason:'sdk-unbound'};
  for(const [member,source] of Object.entries(sources)){
   const d=Object.getOwnPropertyDescriptor(nav,member);
   if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||Function.prototype.toString.call(d.value)!==source)return {invoked:false,reason:'sdk-unbound'};
   fns[member]=d.value;
  }
  const callbacks=fns.getNavigationCallbacks(),marked=()=>Object.defineProperty(globalThis,mark,{value:Object.freeze({runtime,callbacks}),configurable:true});
  if(direction==='back'){
   if(typeof callbacks?.goBack!=='function')return {invoked:false,reason:'internal-navigation-unavailable'};
   marked();
   try{fns.navigateBack();}catch{return {invoked:true,returned:false,internalGoBack:true};}
   return {invoked:true,returned:true,internalGoBack:true,sameCallbacks:fns.getNavigationCallbacks()===callbacks};
  }
  if(typeof callbacks?.goTo!=='function')return {invoked:false,reason:'internal-navigation-unavailable'};
  const url=fns.generateScreenURL(module,segment,params);
  if(typeof url!=='string'||new URL(url,location.href).href!==expected)return {invoked:false,reason:'url-mismatch'};
  // navigateTo takes goTo only for an internal URL; otherwise it would reload the window.
  if(fns.getUrlInfo(url)?.isInternal!==true)return {invoked:false,reason:'full-reload-refused'};
  marked();
  try{fns.navigateTo(url);}catch{return {invoked:true,returned:false,internalGoTo:true};}
  return {invoked:true,returned:true,internalGoTo:true,sameCallbacks:fns.getNavigationCallbacks()===callbacks};
 }catch{return {invoked:false,reason:'sdk-unbound'};}
}
// Read-only post-condition: same realm (mark and runtime handle identity) and the
// router callbacks captured before the call are on top again (the controller-init
// callbacks the SDK pushes while a screen initializes are transient).
function locationInPage({handle,mark,coreFile,navigationExport,source}){
 const runtime=globalThis[handle],m=Object.getOwnPropertyDescriptor(globalThis,mark)?.value;
 let sameCallbacks=false;
 try{const d=Object.getOwnPropertyDescriptor(runtime?.loadedModule?.(coreFile)?.[navigationExport]??{},'getNavigationCallbacks');
  sameCallbacks=!!m&&Object.hasOwn(d??{},'value')&&typeof d.value==='function'&&Function.prototype.toString.call(d.value)===source&&d.value()===m.callbacks;}catch{}
 return {href:location.href,bound:!!runtime,sameRealm:!!m&&!!runtime&&m.runtime===runtime,sameCallbacks};
}
export function createOdcBrowserNavigation({page,runtimeHandle,runtimeUrl,startUrl=runtimeUrl,module,binding,beforeNavigate,recordOutcome,timeoutMs=60000,expiresAt,confirmMs=30000,pollMs=100}){
 if(typeof page?.send!=='function'||!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(runtimeHandle??'')||!/^https:\/\/[^/]+\/.*\/$/.test(runtimeUrl??'')||
  !NAME.test(module??'')||binding?.navigationBound!==true||MEMBERS.some(m=>typeof binding.members?.[m]?.source!=='string')||
  typeof beforeNavigate!=='function'||typeof recordOutcome!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||
  expiresAt!==undefined&&!Number.isFinite(Date.parse(expiresAt)))fail('contract_invalid');
 const deadline=expiresAt===undefined?undefined:Date.parse(expiresAt);
 const sources=Object.fromEntries(MEMBERS.map(m=>[m,binding.members[m].source]));
 if(typeof startUrl!=='string'||!startUrl.startsWith(runtimeUrl))fail('contract_invalid');
 let uncertain=false,busy=false,navigations=0,origin,current=startUrl;
 const mark='__ssamOdcNavigation_'+randomBytes(16).toString('hex');
 const remaining=()=>deadline===undefined?timeoutMs:Math.min(timeoutMs,deadline-Date.now()+5000);
 async function read(){
  const reply=await page.send('Runtime.evaluate',{expression:'('+locationInPage.toString()+')('+JSON.stringify({handle:runtimeHandle,mark,coreFile:binding.file,
   navigationExport:binding.export,source:sources.getNavigationCallbacks})+')',returnByValue:true,silent:true},Math.max(1,Math.min(5000,remaining())));
  return reply?.exceptionDetails?undefined:reply?.result?.value;
 }
 async function run(direction,{segment,inputs}={}){
  if(uncertain)fail('uncertain');
  if(busy)fail('busy');
  if(direction==='forward'&&origin)fail('back_required');
  if(direction==='back'&&!origin)fail('forward_required');
  if(deadline!==undefined&&deadline<=Date.now())fail('expired');
  busy=true;
  try{
   let expected,params,querySha256;
   if(direction==='forward'){
    const pairs=Array.isArray(inputs)?inputs:Object.entries(inputs??{}),q=odcScreenQuery(pairs);
    expected=odcScreenLocation(runtimeUrl,segment,q.query);querySha256=q.querySha256;params=Object.fromEntries(pairs);
   }else expected=origin;
   const from=current;
   // Set before journaling: an unrecorded or lost submission is never retried.
   uncertain=true;
   const recorded=await beforeNavigate({direction,...(direction==='forward'?{segment,querySha256}:{}),from:new URL(from).pathname,
    to:new URL(expected).pathname,module});
   if(recorded?.recorded!==true)fail('submission_unrecorded');
   let outcome,replied=false;
   try{
    const reply=await page.send('Runtime.evaluate',{expression:'('+navigateInPage.toString()+')('+JSON.stringify({handle:runtimeHandle,mark,from,
     coreFile:binding.file,navigationExport:binding.export,sources,module,segment,params,expected,direction})+')',returnByValue:true,silent:true},Math.max(1,remaining()));
    const value=reply?.exceptionDetails?undefined:reply?.result?.value;
    if(typeof value?.invoked!=='boolean')fail('reply_invalid');
    outcome={direction,invoked:value.invoked,...(value.invoked?{returned:value.returned===true,
     ...(direction==='forward'?{internalGoTo:value.internalGoTo===true}:{internalGoBack:value.internalGoBack===true}),sameCallbacks:value.sameCallbacks===true}:
     {reason:typeof value.reason==='string'?value.reason:'unknown'})};
    replied=true;
   }catch{outcome={direction,invoked:null,transportUnconfirmed:true};}
   // The router completes asynchronously (lazy screen import, OnDestroy, the
   // new screen's lifecycle). Confirm the location, the same realm (no reload,
   // even one that re-creates a runtime handle) and the same router callbacks.
   let reached=false,reload=false,routerKept=false;
   if(replied&&outcome.invoked&&outcome.returned){
    const until=Date.now()+confirmMs;
    for(;;){
     let seen;try{seen=await read();}catch{seen=undefined;}
     if(seen&&(seen.bound!==true||seen.sameRealm!==true)){reload=true;break;}
     if(seen?.href===expected){reached=true;if(seen.sameCallbacks===true){routerKept=true;break;}}
     if(Date.now()>=until||deadline!==undefined&&Date.now()>=deadline)break;
     await new Promise(resolve=>setTimeout(resolve,pollMs));
    }
    Object.assign(outcome,{reached,fullReload:reload,sameCallbacksAfter:routerKept});
   }
   const persisted=await recordOutcome(outcome);
   if(persisted?.recorded!==true)fail('outcome_unrecorded');
   if(!replied)fail('result_uncertain');
   uncertain=false;navigations++;
   if(!outcome.invoked)fail('not_invoked');
   if(!outcome.returned||outcome.sameCallbacks!==true)fail('native_navigation_failed');
   if(reload)fail('reload_detected');
   if(!reached)fail('location_unconfirmed');
   if(!routerKept)fail('router_changed');
   current=expected;origin=direction==='forward'?from:undefined;
   return {...outcome,path:new URL(expected).pathname,...(querySha256?{querySha256}:{}),lifecycleComplete:false};
  }finally{busy=false;}
 }
 return {
  navigate:request=>run('forward',request),
  back:()=>run('back'),
  location:()=>current,
  receipt:()=>({uncertain,navigations,awaitingBack:!!origin,fullReloadRefused:true,lifecycleComplete:false}),
 };
}
