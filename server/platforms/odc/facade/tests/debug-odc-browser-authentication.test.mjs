import test from 'node:test';
import assert from 'node:assert/strict';
import {createOdcBrowserAuthentication} from '../debug-odc-browser-authentication.mjs';
import {createOdcBrowserMetadata} from '../debug-odc-browser-metadata.mjs';
const runtime={runtimeUrl:'https://fixture.outsystems.app/Fixture/',moduleVersion:'pinned'};
const binding={lane:'odc',runtimeUrl:runtime.runtimeUrl,app:'Fixture',module:'Fixture',moduleKey:'A'.repeat(22),sessionId:'a'.repeat(32)};
const expiresAt=new Date(Date.now()+60000).toISOString();
const session={binding,expiresAt,accessToken:'private-token'},descriptor={binding,expiresAt};
const request={url:runtime.runtimeUrl+'moduleservices/users/userinfosync',method:'POST',headers:{Authorization:'Bearer private-token'}};
test('host waits for delayed native sync and durable evidence after SDK returns',async()=>{
 let finish,networkCalls=0;const body=new Promise(resolve=>finish=resolve);
 const metadata=createOdcBrowserMetadata({runtime,beforeSync:async()=>({recorded:true}),recordSyncResult:async()=>({recorded:true}),
   fetchImpl:async()=>{networkCalls++;return {ok:true,status:200,text:()=>body};}});
 const page={evaluate:async()=>({authenticated:true,identityMatches:true,tokenMatches:true})};
 const host=createOdcBrowserAuthentication({page,metadata,runtimeHandle:'privateRuntime'});
 const auth=host.authenticate(session,descriptor);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(host.receipt().confirmed,false);
 const sync=metadata.request(request);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(host.receipt().confirmed,false);finish('');await sync;
 const result=await auth;assert.equal(result.nativeAuthenticationSyncAccepted,true);
 assert.equal(result.permissionCheck,false);assert.equal(result.mounted,false);
 assert.doesNotMatch(JSON.stringify(result),/private-token/);
 await assert.rejects(host.authenticate(session,descriptor),/already_attempted/);assert.equal(networkCalls,1);metadata.close();
});
test('native failure is sanitized and never retried or promoted to authentication',async()=>{
 const metadata=createOdcBrowserMetadata({runtime});let calls=0;
 const page={evaluate:async()=>{calls++;throw new Error('private-token');}};
 const host=createOdcBrowserAuthentication({page,metadata,runtimeHandle:'privateRuntime'});
 await assert.rejects(host.authenticate(session,descriptor),/^Error: debug_odc_browser_authentication_native_result_unconfirmed$/);
 await assert.rejects(host.authenticate(session,descriptor),/already_attempted/);
 assert.deepEqual(host.receipt(),{attempted:true,confirmed:false});assert.equal(calls,1);metadata.close();
});
test('SDK success without native synchronization cannot pass the host',async()=>{
 const metadata=createOdcBrowserMetadata({runtime,recordSyncResult:async()=>({recorded:true})});
 const page={evaluate:async()=>({authenticated:true,identityMatches:true,tokenMatches:true})};
 const host=createOdcBrowserAuthentication({page,metadata,runtimeHandle:'privateRuntime',timeoutMs:20});
 await assert.rejects(host.authenticate(session,descriptor),/sync_timeout|deadline/);
 assert.equal(host.receipt().confirmed,false);assert.equal(metadata.receipt().syncAttempted,false);metadata.close();
});

for(const failure of ['throw','identity'])test(`failed SDK ${failure} preserves a pending sync response without authenticating or replaying`,async()=>{
 let finish,sync,networkCalls=0,journalCalls=0;
 const body=new Promise(resolve=>finish=resolve);
 const metadata=createOdcBrowserMetadata({runtime,beforeSync:async()=>({recorded:true}),
  recordSyncResult:async()=>{journalCalls++;return {recorded:true};},
  fetchImpl:async()=>{networkCalls++;return {ok:true,status:200,text:()=>body};}});
 const page={evaluate:async()=>{
  sync=metadata.request(request);await new Promise(resolve=>setImmediate(resolve));
  if(failure==='throw')throw new Error('private-token');
  return {authenticated:true,identityMatches:false,tokenMatches:true};
 }};
 const host=createOdcBrowserAuthentication({page,metadata,runtimeHandle:'privateRuntime'});
 let settled=false;
 const rejected=assert.rejects(host.authenticate(session,descriptor),failure==='throw'?/native_result_unconfirmed/:/identity_unconfirmed/)
  .then(()=>{settled=true;});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false);assert.equal(host.receipt().confirmed,false);
 finish('');await sync;await rejected;
 assert.deepEqual(host.receipt(),{attempted:true,confirmed:false,failureSync:{attempted:true,confirmed:true}});
 assert.equal(networkCalls,1);assert.equal(journalCalls,1);
 assert.doesNotMatch(JSON.stringify(host.receipt()),/private-token/);
 await assert.rejects(host.authenticate(session,descriptor),/already_attempted/);
 metadata.close();
});

test('failed SDK keeps synchronization uncertainty when its result journal fails',async()=>{
 let sync;
 const metadata=createOdcBrowserMetadata({runtime,beforeSync:async()=>({recorded:true}),
  recordSyncResult:async()=>({recorded:false}),fetchImpl:async()=>({ok:true,status:200,text:async()=>''})});
 const page={evaluate:async()=>{
  sync=metadata.request(request).catch(()=>{});await sync;
  throw new Error('private-token');
 }};
 const host=createOdcBrowserAuthentication({page,metadata,runtimeHandle:'privateRuntime'});
 await assert.rejects(host.authenticate(session,descriptor),/native_result_unconfirmed/);
 assert.equal(host.receipt().confirmed,false);assert.equal(host.receipt().failureSync.confirmed,false);
 assert.equal(host.receipt().failureSync.error,'debug_odc_browser_metadata_sync_unconfirmed');
 metadata.close();
});
