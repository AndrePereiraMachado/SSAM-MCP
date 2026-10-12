// Worker-side installation; its capability goes only over the private worker
// pipe. Connection and sealed value storage belong to the owning broker.
import {randomBytes} from 'node:crypto';
import {nativeBrowserInspectionBundle} from './debug-native-browser-inspection.mjs';
export async function installNativeBrowserInspection({host,options,runtimeHandle}){
 const fail=code=>{throw new Error('debug_native_browser_inspection_'+code);};
 if(typeof host?.page?.send!=='function'||typeof host?.page?.evaluate!=='function'||typeof host?.dispose!=='function')fail('contract_invalid');
 // The handle names its lane; the platform must match it (O11 mount runtime or ODC runtime).
 const lane=/^__ssam(Odc|O11)Runtime_[a-f0-9]{48}$/.exec(runtimeHandle??'')?.[1]?.toLowerCase();
 if(runtimeHandle!==undefined&&(!lane||options?.platform!==undefined&&options.platform!==lane))fail('runtime_handle_invalid');
 // Forwarded at start() to the original OutSystemsDebugger.pauseOnAllExceptions; never coerced.
 if(options?.pauseOnExceptions!==undefined&&typeof options.pauseOnExceptions!=='boolean')fail('options_invalid');
 const handle='__ssamBrowserInspection_'+randomBytes(24).toString('hex'),bundle=nativeBrowserInspectionBundle();
 let started=false,closed=false;
 async function remove(){
  closed=true;
  return host.page.evaluate(handle=>{
   const session=globalThis[handle];if(!session)return {removed:true};
   try{return {removed:true,privateInspectionCleanup:session.inspection.dispose()};}
   finally{try{if(session.started)globalThis.OutSystemsDebugger.endSession();}finally{delete globalThis[handle];}}
  },handle);
 }
 try{
  const installed=await host.page.send('Runtime.evaluate',{
   expression:'(()=>{const factory='+bundle.source+';const options='+JSON.stringify({
    platform:options.platform,modules:options.modules,variables:options.variables,privateValues:options.privateValues,privateCapture:true
   })+';'+(runtimeHandle===undefined?'':
    'const runtime=globalThis['+JSON.stringify(runtimeHandle)+'];'+(lane==='o11'
     // O11: OS.Internal.DataTypes.BinaryData and the original DebuggerDataConverter, from the loaded client runtime.
     ?'const binaryType=runtime?.nativeBinaryType?.();const converter=runtime?.nativeConverter?.();if(typeof converter?.to==="function")options.nativeConverter=converter;'
     :'const binaryType=runtime?.shape("DataTypes","GenericRecord").BinaryData;')+
    'if(typeof binaryType!=="function")throw new Error("native_binary_type_unavailable");options.binaryType=binaryType;')+
   'const inspection=factory.create(options);globalThis['+JSON.stringify(handle)+']={inspection,started:false};return {helperName:inspection.helperName,privateConsumerCapability:inspection.privateConsumerCapability};})()',returnByValue:true});
  if(installed.exceptionDetails||!installed.result?.value)fail('install_failed');
  const value=installed.result.value;
  if(!/^__ssamInspection_[a-f0-9]{48}$/.test(value.helperName??'')||!/^[a-f0-9]{48}$/.test(value.privateConsumerCapability??''))fail('install_failed');
  return {
   capability:{url:host.inspectionUrl,helperName:value.helperName,privateConsumerCapability:value.privateConsumerCapability,privateCapture:true},
   async start(){
    if(closed||started)fail('start_invalid');started=true;
    try{await host.page.evaluate(({handle,breakpoints,pauseOnExceptions})=>{
     const session=globalThis[handle],dbg=globalThis.OutSystemsDebugger;
     if(!session||session.started||typeof dbg?.startSession!=='function'||typeof dbg?.endSession!=='function')throw new Error('native_session_unavailable');
     session.started=true;dbg.startSession();session.inspection.enable({breakpoints,pauseOnExceptions});
    },{handle,breakpoints:options.breakpoints??[],pauseOnExceptions:options.pauseOnExceptions===true});}
    catch{fail('start_failed');}
    return {started:true};
   },remove,
   receipt:()=>({started,closed,coreSha256:bundle.coreSha256,bundleSha256:bundle.sourceSha256}),
  };
 }catch{
  try{await remove();}catch{void host.dispose();}fail('install_failed');
 }
}
