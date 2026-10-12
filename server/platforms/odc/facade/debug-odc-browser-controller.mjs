// Inspect controller descriptors already tracked by the private module map.
// Absence from this map does not establish absence from Chromium's ESM cache.
// Never call an application
// getter, importer, handler or dispatcher to discover whether it is present.
export async function observeOdcBrowserController({page,runtimeHandle,runtimeUrl,controllerModule,controllerExport='default',expectedDispatch}){
 if(typeof page?.evaluate!=='function'||!/^__ssamOdcRuntime_[a-f0-9]{48}$/.test(runtimeHandle??'')||
  !/^_oschunk-[A-Za-z0-9]+\.js$/.test(controllerModule??'')||! /^(?:default|__ssam_\d+)$/.test(controllerExport))throw new Error('debug_odc_browser_controller_contract_invalid');
 const dispatchNames=['fireApplicationReady','setupOnApplicationResumeListener','setupSyncOnResume','fireApplicationResume'];
 if(expectedDispatch!==undefined&&(!Array.isArray(expectedDispatch)||expectedDispatch.length!==4||
  expectedDispatch.some((r,i)=>r.name!==dispatchNames[i]||typeof r.source!=='string'||!r.source)))throw new Error('debug_odc_browser_controller_contract_invalid');
 const result=await page.evaluate(({handle,url,file,exportName,expected})=>{
  if(location.href!==url)return {bound:false};
  const runtime=globalThis[handle];if(typeof runtime?.loadedModule!=='function')return {bound:false};
  try{
   const namespace=runtime.loadedModule(file);
   if(namespace===undefined)return {bound:false,reason:'module_not_tracked'};
   const descriptor=namespace&&Object.getOwnPropertyDescriptor(namespace,exportName);
   if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.value||typeof descriptor.value!=='object')return {bound:false};
   const controller=descriptor.value;
   function describe(name){
    let owner=controller,depth=0;const seen=new Set();
    while(owner!==null){
     if(depth>20||seen.has(owner))throw Error();seen.add(owner);
     const d=Object.getOwnPropertyDescriptor(owner,name);
     if(d){const original=expected?.find(row=>row.name===name);
      return {name,depth,state:!Object.hasOwn(d,'value')?'accessor':d.value===undefined?'undefined':d.value===null?'null':typeof d.value==='function'?'function':'other',
       ...(original?{sourceMatches:Object.hasOwn(d,'value')&&typeof d.value==='function'&&Function.prototype.toString.call(d.value)===original.source}:{})};}
     owner=Object.getPrototypeOf(owner);depth++;
    }
    return {name,state:'absent'};
   }
   return {bound:true,handlers:['onApplicationReadyHandler','onApplicationResumeHandler','onSyncHandler'].map(describe),
    dispatch:['fireApplicationReady','setupOnApplicationResumeListener','setupSyncOnResume','fireApplicationResume'].map(describe)};
  }catch{return {bound:false};}
 },{handle:runtimeHandle,url:runtimeUrl,file:controllerModule,exportName:controllerExport,expected:expectedDispatch},5000);
 const expectedHandlers=['onApplicationReadyHandler','onApplicationResumeHandler','onSyncHandler'];
 if(result?.bound===false&&result.reason==='module_not_tracked')throw new Error('debug_odc_browser_controller_module_not_tracked');
 const valid=(rows,names)=>Array.isArray(rows)&&rows.length===names.length&&rows.every((r,i)=>r.name===names[i]&&
  ['absent','accessor','undefined','null','function','other'].includes(r.state)&&
  (r.state==='absent'?r.depth===undefined:Number.isInteger(r.depth)&&r.depth>=0&&r.depth<=20));
 if(result?.bound!==true||!valid(result.handlers,expectedHandlers)||!valid(result.dispatch,dispatchNames)||
  expectedDispatch!==undefined&&result.dispatch.some(r=>typeof r.sourceMatches!=='boolean'))
  throw new Error('debug_odc_browser_controller_unbound');
 return {nativeControllerBound:true,controllerModule,controllerExport,handlers:result.handlers,dispatch:result.dispatch,
  handlersAbsent:result.handlers.every(r=>r.state==='absent'),
  nativeDispatchSourceMatched:expectedDispatch!==undefined&&result.dispatch.every(r=>r.sourceMatches===true&&r.depth===2),
  applicationStartupQualified:false,lifecycleComplete:false};
}
