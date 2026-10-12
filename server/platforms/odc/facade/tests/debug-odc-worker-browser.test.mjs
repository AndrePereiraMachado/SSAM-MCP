import test from 'node:test';import assert from 'node:assert/strict';
import {connectOdcWorkerBrowser} from '../debug-odc-worker-browser.mjs';
const capability={url:'ws://127.0.0.1:45678/devtools/page/ABCDEF123',scope:'owned-browser-process',purpose:'preparation-only',expiresAt:new Date(Date.now()+60000).toISOString()};
test('worker closes only its CDP connection; the parent retains process cleanup ownership',async()=>{
 let calls=0;const host=await connectOdcWorkerBrowser(capability,{connect:async()=>({close(){calls++;}})});
 assert.equal(host.receipt().processOwner,'parent-broker');
 assert.equal((await host.dispose()).processCleanupOwner,'parent-broker');await host.dispose();assert.equal(calls,1);
 assert.ok(!JSON.stringify(host.receipt()).includes('45678'));
});
test('foreign, expired, user-browser and widened capabilities fail before connection',async()=>{
 for(const patch of [{url:'ws://external.example:45678/devtools/page/ABCDEF'},{expiresAt:'invalid'},
  {expiresAt:new Date(0).toISOString()},{scope:'user-browser'},{purpose:'invoke'},
  {url:capability.url+'?token=secret'},{url:'ws://127.0.0.1:80/devtools/page/ABCDEF'}]){
  let called=false;await assert.rejects(connectOdcWorkerBrowser({...capability,...patch},{connect:async()=>{called=true;}}),/capability_invalid/);assert.equal(called,false);
 }
});

test('authenticated preparation retains parent ownership and exposes no execution capability',async()=>{
 const host=await connectOdcWorkerBrowser({...capability,purpose:'authenticated-preparation'},{connect:async()=>({close(){}})});
 assert.equal(host.receipt().processOwner,'parent-broker');assert.equal(host.invoke,undefined);
 assert.equal((await host.dispose()).completed,true);
});
test('authorized mount still exposes only the owned CDP connection; retired mount purposes are refused',async()=>{
 for(const purpose of ['authenticated-mount-preparation','qualified-mount'])await assert.rejects(connectOdcWorkerBrowser({...capability,purpose},{connect:async()=>{throw Error('connected');}}),/capability_invalid/);
 const host=await connectOdcWorkerBrowser({...capability,purpose:'authorized-mount'},{connect:async()=>({close(){}})});
 assert.equal(host.receipt().processOwner,'parent-broker');assert.equal(host.mount,undefined);assert.equal(host.invoke,undefined);
 await host.dispose();
});
