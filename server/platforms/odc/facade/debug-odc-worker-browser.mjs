// Private parent-to-worker capability, never part of MCP/CLI arguments.
import {Cdp} from './debug-invoke-browser.mjs';
export async function connectOdcWorkerBrowser(capability,{connect=Cdp.connect}={}){
 const fail=()=>{throw new Error('debug_odc_native_browser_capability_invalid');};
 let url;try{url=new URL(capability?.url);}catch{fail();}
 if(capability?.scope!=='owned-browser-process'||!['preparation-only','authenticated-preparation','authorized-mount'].includes(capability?.purpose)||
  url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||Number(url.port)<1024||Number(url.port)>65535||
  !/^\/devtools\/page\/[A-Fa-f0-9-]+$/.test(url.pathname)||url.username||url.password||url.search||url.hash||
  !Number.isFinite(Date.parse(capability.expiresAt))||Date.parse(capability.expiresAt)<=Date.now())fail();
 const page=await connect(url.href);let closed=false;
 return {page,inspectionUrl:url.href,
  receipt:()=>({scope:'owned-browser-process',processOwner:'parent-broker',connectionClosed:closed}),
  async dispose(){if(!closed){closed=true;page.close();}return {completed:true,connectionClosed:true,processCleanupOwner:'parent-broker'};},
 };
}
