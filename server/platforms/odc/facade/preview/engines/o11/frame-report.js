// Host observation only. No application implementation, role, data or native callback is changed.
(function(){
 const match=location.pathname.match(/^\/builds\/([a-f0-9]{64})\//);if(!match)return;
 const buildId=match[1],started=performance.now();let pending=0,lastActivity=performance.now(),reported='',observedIdentity='';
 const originalSend=XMLHttpRequest.prototype.send;
 XMLHttpRequest.prototype.send=function(...args){pending++;lastActivity=performance.now();this.addEventListener('loadend',()=>{pending--;lastActivity=performance.now();},{once:true});try{return originalSend.apply(this,args);}catch(error){pending--;lastActivity=performance.now();throw error;}};
 const observer=new MutationObserver(()=>{lastActivity=performance.now();});observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});
 function activeEntry(){
  // Read an already loaded official getter only; do not load a module or alter routing.
  const amd=window.require,module='OutSystems/ClientRuntime/Controller';
  const viewName=typeof amd==='function'&&amd.defined?.(module)?amd(module).BaseViewController?.activeScreen?.viewName:null;
  const matches=viewName?(window.__nativeEntryOptions??[]).filter(x=>x.target.screen===viewName):[];
  return {viewName:viewName??null,screenKey:viewName?(matches.length===1?matches[0].target.screenKey:null):window.__officialHostTarget?.screenKey};
 }
 function report(entry,kind,details){details={...details,nativeViewName:entry.viewName};const key=JSON.stringify([entry.screenKey,kind,details]);if(key===reported)return;reported=key;parent.postMessage({protocol:'ssam-official-frame/2',buildId,entryScreenKey:entry.screenKey,kind,elapsedMs:Math.round(performance.now()-started),details},location.origin);}
 const timer=setInterval(()=>{
  const proof=window.__o11Proof,execution=window.__candidateExecution,entryFailure=window.__candidateEntryFailure,entry=activeEntry();
  const identity=JSON.stringify([entry.screenKey,entry.viewName]);if(identity!==observedIdentity){observedIdentity=identity;lastActivity=performance.now();}
  const errors=[...(proof?.errors??[]),...(proof?.console??[]).filter(x=>x.level==='error'),...(proof?.cspViolations??[])];
  const visible=execution?.routerShellRendered&&document.getElementById('reactContainer')?.childElementCount>0;
  if(visible&&pending===0&&performance.now()-lastActivity>750){
   report(entry,errors.length||entryFailure?'rendered-with-warnings':'rendered',{observation:'Native Router callback, nonempty DOM, zero pending XHR and 750ms DOM/network quiet; not a proof of every application path.',contextPrepared:execution.contextPrepared===true,nativeClientDefaultsOverridden:execution.nativeClientDefaultsOverridden,realAccessValidated:false,entryFailure:entryFailure??null,errors});
   // Keep watching later runtime errors; do not assert a permanently clean application.
  }else if(!visible&&(entryFailure||errors.length)){report(entry,'render-error',{summary:'The native entry has not rendered.',entryFailure:entryFailure??null,errors});}
  else if(performance.now()-started>15000&&!visible){report(entry,'render-pending',{summary:'The native entry is still waiting after 15 seconds.',pending,routerShellRendered:execution?.routerShellRendered===true});}
 },250);
 window.addEventListener('pagehide',()=>{clearInterval(timer);observer.disconnect();},{once:true});
})();
