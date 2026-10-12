// Private, owned Chrome process. Never attach to or close a user's browser.
// Runtime URLs and credentials are supplied later by the guarded native host.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {Cdp} from './debug-invoke-browser.mjs';

const fail=code=>{throw new Error('debug_native_browser_'+code);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,ms){
  let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}
  finally{clearTimeout(timer);}
}

export async function launchNativeDebugBrowser({directory,executable,leaseMs=300000}){
  if(process.platform!=='win32' || !path.isAbsolute(directory??'') || !path.isAbsolute(executable??'') ||
    !Number.isInteger(leaseMs) || leaseMs<1000 || leaseMs>1800000)fail('configuration_invalid');
  // Exclusive directory is also a replay guard; previous evidence is retained.
  fs.mkdirSync(directory);
  const profile=path.join(directory,'profile');fs.mkdirSync(profile);
  const report={startedAt:new Date().toISOString(),executableSha256:createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
    scope:'owned-browser-process',cleanupConfirmed:false};
  const save=()=>fs.writeFileSync(path.join(directory,'browser-receipt.json'),JSON.stringify(report,null,2));
  let child,browser,page,contextId,exitPromise,exited=false,disposePromise,leaseTimer,networkGuard;
  async function dispose(){
    if(disposePromise)return disposePromise;
    disposePromise=(async()=>{
      clearTimeout(leaseTimer);page?.close();
      if(browser&&contextId){
        try{await browser.send('Target.disposeBrowserContext',{browserContextId:contextId},5000);report.contextDisposed=true;}
        catch{report.contextDisposeFailed=true;}
      }
      if(browser){try{await browser.send('Browser.close',{},5000);}catch{report.closeReplyMissing=true;}browser.close();}
      if(exitPromise && !await bounded(exitPromise,5000)){
        report.ownedProcessTerminationRequested=true;child.kill();await bounded(exitPromise,5000);
      }
      report.ownedProcessExited=exited;
      // A process exit also destroys its isolated incognito context. A missing
      // disposal reply is preserved, never upgraded to a successful CDP reply.
      report.contextDestroyed=exited || report.contextDisposed===true;
      if(networkGuard){networkGuard.closeAllConnections();await new Promise(resolve=>networkGuard.close(resolve));report.networkGuardClosed=true;}
      report.cleanupConfirmed=exited && report.contextDestroyed && report.networkGuardClosed===true;
      report.finishedAt=new Date().toISOString();save();
      return {completed:report.cleanupConfirmed,ownedProcessExited:exited,contextDestroyed:report.contextDestroyed};
    })();return disposePromise;
  }
  try{
    // Fetch interception does not intercept WebSockets; Chromium's blocked URL
    // list was also observed permitting a WS upgrade. Never let the browser
    // fall through to direct networking. Only host-side guarded transports may
    // send real requests; CDP fulfils their responses without this proxy.
    report.networkDenied={http:0,connect:0,upgrade:0};
    networkGuard=createServer((request,response)=>{report.networkDenied.http++;response.writeHead(403,{'Connection':'close'});response.end();});
    networkGuard.on('connection',socket=>socket.on('error',()=>{}));
    networkGuard.on('clientError',(error,socket)=>socket.destroy());
    networkGuard.on('connect',(request,socket)=>{report.networkDenied.connect++;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
    networkGuard.on('upgrade',(request,socket)=>{report.networkDenied.upgrade++;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
    await new Promise((resolve,reject)=>{networkGuard.once('error',reject);networkGuard.listen(0,'127.0.0.1',resolve);});
    child=spawn(executable,['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
      '--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking',
      '--disable-default-apps','--disable-extensions','--disable-quic',
      '--proxy-server=http://127.0.0.1:'+networkGuard.address().port,'--proxy-bypass-list=<-loopback>',
      'about:blank'],{windowsHide:true,stdio:'ignore'});
    report.ownedPid=child.pid;save();
    let spawnFailed=false;
    exitPromise=new Promise(resolve=>{
      child.once('error',()=>{spawnFailed=true;report.spawnFailed=true;resolve(false);});
      child.once('exit',(code,signal)=>{exited=true;report.exit={code,signal};save();resolve(true);});
    });
    const deadline=Date.now()+15000;let portInfo;
    while(Date.now()<deadline){
      if(spawnFailed || exited)fail('startup_failed');
      try{portInfo=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);break;}catch{}
      await delay(100);
    }
    if(!/^\d+$/.test(portInfo?.[0]??'') || Number(portInfo[0])<1024 || Number(portInfo[0])>65535 ||
      !/^\/devtools\/browser\/[a-f0-9-]+$/.test(portInfo?.[1]??''))fail('endpoint_unverified');
    const base='http://127.0.0.1:'+portInfo[0];
    const version=await(await fetch(base+'/json/version',{signal:AbortSignal.timeout(3000)})).json();
    const endpoint=new URL(version.webSocketDebuggerUrl);
    if(endpoint.protocol!=='ws:' || endpoint.hostname!=='127.0.0.1' || endpoint.port!==portInfo[0] ||
      endpoint.pathname!==portInfo[1] || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)fail('endpoint_unverified');
    report.browserVersion=version.Browser;
    browser=await Cdp.connect(endpoint.href);
    ({browserContextId:contextId}=await browser.send('Target.createBrowserContext',{disposeOnDetach:true}));
    const target=await browser.send('Target.createTarget',{url:'about:blank',browserContextId:contextId});
    const tabs=await(await fetch(base+'/json/list',{signal:AbortSignal.timeout(3000)})).json();
    const tab=tabs.find(t=>t.id===target.targetId && t.type==='page');
    if(!tab || tab.url!=='about:blank')fail('target_unverified');
    const targetEndpoint=new URL(tab.webSocketDebuggerUrl);
    if(targetEndpoint.protocol!=='ws:' || targetEndpoint.hostname!=='127.0.0.1' || targetEndpoint.port!==portInfo[0] ||
      targetEndpoint.pathname!=='/devtools/page/'+target.targetId || targetEndpoint.username || targetEndpoint.password || targetEndpoint.search || targetEndpoint.hash)fail('target_unverified');
    page=await Cdp.connect(targetEndpoint.href);
    report.ready=true;report.expiresAt=new Date(Date.now()+leaseMs).toISOString();save();
    leaseTimer=setTimeout(()=>{report.expired=true;void dispose();},leaseMs);
    // inspectionUrl is a private capability: callers must never include it in
    // public receipts, tool responses or exception messages.
    return {page,inspectionUrl:targetEndpoint.href,dispose,receipt:()=>({...report})};
  }catch{
    report.startupFailed=true;await dispose();fail('startup_failed');
  }
}
