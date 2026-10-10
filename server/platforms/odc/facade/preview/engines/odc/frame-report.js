// Host observation only. No application implementation, role, data or native callback is changed.
(function(){
 const match=location.pathname.match(/^\/builds\/([a-f0-9]{64})\//);if(!match)return;
 const buildId=match[1],started=performance.now();let pending=0,lastActivity=performance.now(),reported='';
 const originalSend=XMLHttpRequest.prototype.send;
 XMLHttpRequest.prototype.send=function(...args){pending++;lastActivity=performance.now();this.addEventListener('loadend',()=>{pending--;lastActivity=performance.now();},{once:true});try{return originalSend.apply(this,args);}catch(error){pending--;lastActivity=performance.now();throw error;}};
 const observer=new MutationObserver(()=>{lastActivity=performance.now();});observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});
 function report(kind,details){const key=kind+JSON.stringify(details);if(key===reported)return;reported=key;parent.postMessage({protocol:'ssam-official-frame/2',buildId,entryScreenKey:window.__officialHostTarget?.screenKey,kind,elapsedMs:Math.round(performance.now()-started),details},location.origin);}
 const timer=setInterval(()=>{
  const proof=window.__o11Proof,execution=window.__candidateExecution,entryFailure=window.__candidateEntryFailure;
  const errors=[...(proof?.errors??[]),...(proof?.console??[]).filter(x=>x.level==='error'),...(proof?.cspViolations??[])];
  if(entryFailure||errors.length){report('render-error',{entryFailure:entryFailure??null,errors});clearInterval(timer);observer.disconnect();return;}
  if(execution?.routerShellRendered&&document.getElementById('reactContainer')?.childElementCount>0&&pending===0&&performance.now()-lastActivity>750){
   report('rendered',{observation:'Native Router callback, nonempty DOM, zero pending XHR and 750ms DOM/network quiet; not a proof of every application path.',originalPreflightGuardPassed:execution.originalPreflightGuardPassed===true,nativeClientDefaultsReset:execution.nativeClientDefaultsReset,explicitSynthetic:true});
   // Keep watching later runtime errors; do not assert a permanently clean application.
  }else if(performance.now()-started>30000&&reported===''){report('render-pending',{pending,routerShellRendered:execution?.routerShellRendered===true});}
 },250);
 window.addEventListener('pagehide',()=>{clearInterval(timer);observer.disconnect();},{once:true});
})();
