import test from 'node:test';
import assert from 'node:assert/strict';
import {createOdcBrowserMetadata} from '../debug-odc-browser-metadata.mjs';
const runtime={runtimeUrl:'https://fixture.outsystems.app/Fixture/',moduleVersion:'pinned'};
const binding={lane:'odc',runtimeUrl:runtime.runtimeUrl,app:'Fixture',module:'Fixture',moduleKey:'A'.repeat(22),sessionId:'a'.repeat(32)};
const expiresAt=new Date(Date.now()+60000).toISOString();
const session={binding,expiresAt,accessToken:'private-token'};
const sync={url:runtime.runtimeUrl+'moduleservices/users/userinfosync',method:'POST',headers:{Authorization:'Bearer private-token'}};
const version={url:runtime.runtimeUrl+'moduleservices/moduleversioninfo',method:'GET',headers:{}};

test('startup profile uses the received home-module metadata and records no names or body',async()=>{
 const homeModuleKey='12345678-1234-4234-8234-123456789abc';
 const data={manifest:{versionToken:'pinned'},data:{modules:{[homeModuleKey]:{splashScreenName:null}},entityModuleNames:['private-module']}};
 const broker=createOdcBrowserMetadata({runtime,homeModuleKey,fetchImpl:async()=>new Response(JSON.stringify(data))});
 const request={...version,url:runtime.runtimeUrl+'moduleservices/moduleinfo'};
 assert.equal(broker.receipt().startupProfile,undefined);
 await broker.request(request);const first=broker.receipt().startupProfile;
 assert.equal(first.hasSplashScreen,false);assert.equal(first.entityModuleCount,1);assert.match(first.moduleInfoSha256,/^[a-f0-9]{64}$/);
 first.hasSplashScreen=true;assert.equal(broker.receipt().startupProfile.hasSplashScreen,false);
 data.data.modules[homeModuleKey].splashScreenName='private-screen';await broker.request(request);
 assert.equal(broker.receipt().startupProfile.hasSplashScreen,true);assert.notEqual(first.moduleInfoSha256,broker.receipt().startupProfile.moduleInfoSha256);
 assert.doesNotMatch(JSON.stringify(broker.receipt()),/private-module|private-screen/);
 data.manifest.versionToken='changed';await assert.rejects(broker.request(request),/publication_changed/);
 assert.equal(broker.receipt().startupProfile,undefined);broker.close();
});

test('missing or malformed startup fields cannot become a no-splash profile',async()=>{
 const homeModuleKey='12345678-1234-4234-8234-123456789abc';
 for(const module of [undefined,{}, {splashScreenName:false},{splashScreenName:{}}]){
  const broker=createOdcBrowserMetadata({runtime,homeModuleKey,fetchImpl:async()=>new Response(JSON.stringify({manifest:{versionToken:'pinned'},data:{modules:{[homeModuleKey]:module},entityModuleNames:[]}}))});
  await assert.rejects(broker.request({...version,url:runtime.runtimeUrl+'moduleservices/moduleinfo'}),/startup_profile_invalid/);
  assert.equal(broker.receipt().startupProfile,undefined);broker.close();
 }
});

test('response correlation survives a failed body without exposing unrelated headers or asserting completion',async()=>{
 let recorded;
 const headers=new Headers({'traceparent':'00-'+'a'.repeat(32)+'-'+'b'.repeat(16)+'-01',
  'x-request-id':'12345678-1234-4234-8234-123456789abc','x-amzn-requestid':'private-token','set-cookie':'private-cookie'});
 const broker=createOdcBrowserMetadata({runtime,beforeSync:async()=>({recorded:true}),
  recordSyncResult:async r=>{recorded=r;return {recorded:true};},fetchImpl:async()=>({ok:true,status:200,headers,text:async()=>{throw new Error('private-body');}})});
 broker.bindSession(session,{binding,expiresAt});await assert.rejects(broker.request(sync),/request_failed/);
 assert.deepEqual(recorded.request.responseCorrelation,{traceId:'a'.repeat(32),'x-request-id':'12345678-1234-4234-8234-123456789abc'});
 assert.equal(recorded.syncUncertain,true);assert.equal(recorded.syncAccepted,false);
 assert.doesNotMatch(JSON.stringify(recorded),/private-token|private-cookie|private-body/);broker.close();
});
test('zero or malformed trace identifiers are not recorded as correlation',async()=>{
 for(const trace of ['00-'+'0'.repeat(32)+'-'+'b'.repeat(16)+'-01','private-value']){
  const broker=createOdcBrowserMetadata({runtime,fetchImpl:async()=>new Response('{"versionToken":"pinned"}',{headers:{traceparent:trace}})});
  await broker.request(version);assert.equal(broker.receipt().requests[0].responseCorrelation,undefined);broker.close();
 }
});
test('authentication barrier waits for a future native sync, not just an idle transport',async()=>{
 const broker=createOdcBrowserMetadata({runtime,beforeSync:async()=>({recorded:true}),recordSyncResult:async()=>({recorded:true}),fetchImpl:async()=>new Response('')});
 broker.bindSession(session,{binding,expiresAt});
 let passed=false;const barrier=broker.waitForAuthenticationSync().then(r=>{passed=true;return r;});
 await broker.settle();assert.equal(passed,false);
 await broker.request(sync);assert.equal((await barrier).syncAccepted,true);broker.close();
});
test('authentication barrier refuses missing completion journal, absent sync and closed transport',async()=>{
 const absent=createOdcBrowserMetadata({runtime});absent.bindSession(session,{binding,expiresAt});
 await assert.rejects(absent.waitForAuthenticationSync(),/result_journal_required/);absent.close();
 const broker=createOdcBrowserMetadata({runtime,recordSyncResult:async()=>({recorded:true})});broker.bindSession(session,{binding,expiresAt});
 await assert.rejects(broker.waitForAuthenticationSync({timeoutMs:10}),/sync_timeout/);
 const closed=assert.rejects(broker.waitForAuthenticationSync(),/expired/);broker.close();await closed;
});
test('settle includes durable completion and journal failure cannot authorize replay',async()=>{
 let release,recorded,calls=0;const journal=new Promise(resolve=>release=resolve);
 const broker=createOdcBrowserMetadata({runtime,beforeSync:async()=>({recorded:true}),
   recordSyncResult:async evidence=>{recorded=evidence;return journal;},
   fetchImpl:async()=>{calls++;return new Response('private-body');}});
 broker.bindSession(session,{binding,expiresAt});const request=broker.request(sync);
 const rejected=assert.rejects(request,/result_journal_failed/);
 await assert.rejects(broker.settle({timeoutMs:10}),/settle_timeout/);
 assert.equal(recorded.syncAccepted,true);assert.doesNotMatch(JSON.stringify(recorded),/private-token|private-body/);
 release({recorded:false});await rejected;const receipt=await broker.settle();
 assert.equal(receipt.syncAccepted,true);assert.equal(receipt.requests[0].resultRecorded,false);
 await assert.rejects(broker.request(sync),/request_refused/);assert.equal(calls,1);broker.close();
});
test('settle waits for the sync body and timeout never resends or acknowledges it',async()=>{
 let release,calls=0;const body=new Promise(resolve=>release=resolve);
 const broker=createOdcBrowserMetadata({runtime,beforeSync:async()=>({recorded:true}),fetchImpl:async()=>{
   calls++;return {ok:true,status:200,text:()=>body};
 }});
 broker.bindSession(session,{binding,expiresAt});const request=broker.request(sync);
 await assert.rejects(broker.settle({timeoutMs:10}),/settle_timeout/);
 assert.equal(calls,1);assert.equal(broker.receipt().pending,1);
 assert.equal(broker.receipt().syncAccepted,false);assert.equal(broker.receipt().syncUncertain,true);
 release('');const receipt=await broker.settle();await request;
 assert.equal(receipt.pending,0);assert.equal(receipt.syncAccepted,true);assert.equal(receipt.syncUncertain,false);
 assert.equal(calls,1);broker.close();
});
test('settled failure remains uncertain and close cannot turn it into success',async()=>{
 let rejectBody;const body=new Promise((_,reject)=>rejectBody=reject);
 const broker=createOdcBrowserMetadata({runtime,beforeSync:async()=>({recorded:true}),fetchImpl:async()=>({ok:true,status:200,text:()=>body})});
 broker.bindSession(session,{binding,expiresAt});const request=broker.request(sync);
 const rejected=assert.rejects(request,/request_failed/);
 await new Promise(resolve=>setImmediate(resolve));broker.close();rejectBody(new Error('private-token'));
 const receipt=await broker.settle();await rejected;
 assert.equal(receipt.pending,0);assert.equal(receipt.syncAccepted,false);assert.equal(receipt.syncUncertain,true);
 assert.doesNotMatch(JSON.stringify(receipt),/private-token/);
});
test('metadata pins the publication and refuses action and cross-origin requests before network',async()=>{
 let calls=0;const broker=createOdcBrowserMetadata({runtime,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({versionToken:'other'}));}});
 await assert.rejects(broker.request({...version,url:'https://other.example/'}),/scope_invalid/);
 await assert.rejects(broker.request({...version,url:runtime.runtimeUrl+'screenservices/Run'}),/request_refused/);
 assert.equal(calls,0);await assert.rejects(broker.request(version),/publication_changed/);assert.equal(calls,1);broker.close();
});
test('identity requires the bound app user and never forwards browser headers or credentials to public receipts',async()=>{
 let sent;const broker=createOdcBrowserMetadata({runtime,fetchImpl:async(url,options)=>{sent=options;return new Response('{}');}});
 const identity={...version,url:'https://fixture.outsystems.app/api/user-information/v1/claims'};
 await assert.rejects(broker.request(identity),/auth_required/);
 broker.bindSession(session,{binding,expiresAt});
 await assert.rejects(broker.request({...identity,headers:{Authorization:'Bearer wrong'}}),/auth_mismatch/);
 await broker.request({...identity,headers:{Authorization:'Bearer private-token',Cookie:'must-not-forward','User-Agent':'browser'}});
 assert.deepEqual(sent.headers,{Accept:'application/json',Authorization:'Bearer private-token'});
 assert.doesNotMatch(JSON.stringify(broker.receipt()),/private-token|must-not-forward/);broker.close();
});
test('sync reserves once before the journal awaits and retains uncertainty after a lost response',async()=>{
 let release,calls=0;const journal=new Promise(r=>release=r);
 const broker=createOdcBrowserMetadata({runtime,beforeSync:()=>journal,fetchImpl:async()=>{calls++;throw new Error('private-token');}});
 broker.bindSession(session,{binding,expiresAt});const first=broker.request(sync);
 await assert.rejects(broker.request(sync),/request_refused/);assert.equal(calls,0);
 release({recorded:true});await assert.rejects(first,/^Error: debug_odc_browser_metadata_request_failed$/);
 assert.equal(calls,1);assert.equal(broker.receipt().syncUncertain,true);
 await assert.rejects(broker.request(sync),/request_refused/);assert.equal(calls,1);broker.close();
});
test('journal failure prevents sync transmission and replay; successful sync is acknowledged only after its response',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return new Response('',{status:200});};
 const denied=createOdcBrowserMetadata({runtime,beforeSync:async()=>({recorded:false}),fetchImpl});denied.bindSession(session,{binding,expiresAt});
 await assert.rejects(denied.request(sync),/journal_failed/);await assert.rejects(denied.request(sync),/request_refused/);assert.equal(calls,0);denied.close();
 const allowed=createOdcBrowserMetadata({runtime,beforeSync:async()=>({recorded:true}),fetchImpl});allowed.bindSession(session,{binding,expiresAt});
 await allowed.request(sync);assert.equal(calls,1);assert.equal(allowed.receipt().syncAccepted,true);assert.equal(allowed.receipt().syncUncertain,false);allowed.close();
});
test('an expired or closed lease cannot return a late private response',async()=>{
 let now=Date.now();const broker=createOdcBrowserMetadata({runtime,clock:()=>now,fetchImpl:async()=>({ok:true,status:200,text:async()=>{now+=120000;return '{}';}})});
 broker.bindSession(session,{binding,expiresAt});await assert.rejects(broker.request(version),/expired/);broker.close();await assert.rejects(broker.request(version),/expired/);
});
