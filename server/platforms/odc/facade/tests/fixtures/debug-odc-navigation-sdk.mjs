// Synthetic core SDK Navigation namespace with the pinned chunk's branch shape:
// goTo only for an internal URL, otherwise changeWindowLocation (Jo).
import vm from 'node:vm';import {createHash} from 'node:crypto';
import {bindOdcSdkNavigation} from '../../debug-odc-browser-navigation.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
export const file='_oschunk-SDK.js';
export const source='var gu=[];function pu(){return gu[gu.length-1]}function gH(t){gu.push(t)}function pH(){return gu.pop()}'+
 'var s=(t,e)=>Object.defineProperty(t,"name",{value:e,configurable:!0});'+
 'var ZO=s(function(t){return{url:t,isInternal:!globalThis.external&&t.indexOf("/App/")===0,path:t}},"getUrlInfo");'+
 'function Jo(t){globalThis.fullReload=t}'+
 'function QO(t,e){let o=ZO(t);if(gu&&pu().goTo&&o.isInternal)pu().goTo(o,e);else Jo(t)}'+
 'function CH(t){gu&&pu().goBack?pu().goBack(t):history.back()}'+
 'function ire(t,e,n){var k=Object.keys(n||{});return(t==="App"?"/App/":"/"+t+"/")+e+(k.length?"?"+k.map(function(x){return encodeURIComponent(x)+"="+encodeURIComponent(n[x])}).join("&"):"")}'+
 'var ude=Object.freeze({__proto__:null,generateScreenURL:ire,getNavigationCallbacks:pu,getUrlInfo:ZO,navigateBack:CH,navigateTo:QO,setNavigationCallbacks:gH});';
export const chunk=source+'export{ude as s};';
export const pinFor=text=>{const p={coreSha256:sha(text),export:'s',declarations:{}};
 const b=bindOdcSdkNavigation({[file]:text},{...p,declarations:null});for(const [k,m] of Object.entries(b.members))p.declarations[k]=m.declarationSha256;return p;};
export const pin=pinFor(chunk);
export const sdkBinding=()=>bindOdcSdkNavigation({[file]:chunk},pin);
// A page realm running the synthetic SDK with a router whose goTo/goBack move location.
export function sdkContext(url,{callbacks=true}={}){
 const calls=[],ctx=vm.createContext({URL,setTimeout,history:{state:null,back(){calls.push('history-back');}},location:{href:url},calls});
 vm.runInContext(source,ctx);
 if(callbacks)vm.runInContext('gH({goTo(o){calls.push("goTo:"+o.url);location.href=new URL(o.url,location.href).href},goBack(){calls.push("goBack");location.href="'+url+'"}})',ctx);
 const install=handle=>{ctx[handle]={loadedModule:f=>f===file?{s:vm.runInContext('ude',ctx)}:undefined};};
 return {calls,ctx,install,evaluate:expression=>JSON.parse(JSON.stringify(vm.runInContext(expression,ctx)??null))};
}
