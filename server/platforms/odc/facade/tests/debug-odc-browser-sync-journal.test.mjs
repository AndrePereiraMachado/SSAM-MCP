import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createOdcNativeBroker} from '../debug-odc-native-broker.mjs';
import {odcMountPolicy} from '../debug-odc-browser-mount.mjs';

function harness(journals={}) {
 const child=new EventEmitter(),sent=[];
 child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};
 child.kill=()=>child.emit('close');child.stdin.end=()=>queueMicrotask(()=>child.emit('close'));
 child.stdin.write=bytes=>{const value=JSON.parse(bytes);sent.push(value);
  if(value.op!=='request-approved')queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({id:value.id,ok:true,result:value.op==='authenticate'?{authenticated:true,identityMatches:true}:{completed:true}})+'\n'));
 };
 const ownedBrowser={inspectionUrl:'ws://127.0.0.1:45678/devtools/page/ABCDEF',
  receipt:()=>({scope:'owned-browser-process',ready:true,expiresAt:new Date(Date.now()+60000).toISOString()}),dispose:async()=>({completed:true})};
 return {sent,broker:createOdcNativeBroker({spawnImpl:()=>child,ownedBrowser,...journals}),
  event:async(op,metadata)=>{child.stdout.emit('data',JSON.stringify({id:'sync-1',op,metadata})+'\n');await new Promise(r=>setImmediate(r));return sent.at(-1);}};
}

test('controller import requires auth journals, paired import journals and a current app identity',async()=>{
 const record=async()=>({recorded:true});
 for(const values of [{beforeBrowserControllerLoad:record},
  {beforeBrowserControllerLoad:record,recordBrowserControllerLoadResult:record}]){
  let spawned=false;assert.throws(()=>createOdcNativeBroker({...values,spawnImpl:()=>{spawned=true;}}),/controller_journal_invalid/);
  assert.equal(spawned,false);
 }
 const h=harness({beforeBrowserSync:record,recordBrowserSyncResult:record,
  beforeBrowserControllerLoad:record,recordBrowserControllerLoadResult:record});
 await h.broker.prepareBrowser({runtime:{},binding:{}});
 assert.equal(h.sent[0].input.controllerLoad,true);
 assert.equal(h.sent[0].input.browser.purpose,'authenticated-preparation');
 await assert.rejects(h.broker.loadBrowserController(),/controller_load_not_ready/);
 await assert.rejects(h.broker.loadBrowserExceptionController(),/controller_load_not_ready/);
 await h.broker.authenticate({expiresAt:new Date(Date.now()+60000).toISOString()});
 await h.broker.loadBrowserController();assert.equal(h.sent.at(-1).op,'load-browser-controller');
 await h.broker.loadBrowserExceptionController();assert.equal(h.sent.at(-1).op,'load-browser-exception-controller');
 for(const op of ['before-browser-controller-load','browser-controller-load-result'])assert.equal((await h.event(op,{})).accepted,true);
 await h.broker.dispose();
 const unavailable=harness();
 for(const op of ['before-browser-controller-load','browser-controller-load-result'])assert.equal((await unavailable.event(op,{})).accepted,false);
 await unavailable.broker.dispose();
});

test('browser authentication requires both durable journals before spawning a worker',()=>{
 for(const values of [{beforeBrowserSync:async()=>{}},{recordBrowserSyncResult:async()=>{}},{beforeBrowserSync:true,recordBrowserSyncResult:async()=>{}}]){
  let spawned=false;assert.throws(()=>createOdcNativeBroker({...values,spawnImpl:()=>{spawned=true;}}),/browser_journal_invalid/);
  assert.equal(spawned,false);
 }
});

test('submission and result acknowledgment wait for the appropriate durable journal',async()=>{
 const seen=[];let release;
 const h=harness({beforeBrowserSync:async metadata=>{seen.push(['before',metadata]);await new Promise(r=>release=r);return {recorded:true};},
  recordBrowserSyncResult:async metadata=>{seen.push(['result',metadata]);return {recorded:true};}});
 await h.broker.prepareBrowser({runtime:{},binding:{}});
 assert.equal(h.sent[0].input.browser.purpose,'authenticated-preparation');
 const metadata={method:'POST',path:'/api/user-information/v1/sync'};
 await h.event('before-browser-sync',metadata);assert.equal(h.sent.length,1);
 release();await new Promise(r=>setImmediate(r));assert.equal(h.sent.at(-1).accepted,true);
 const result={syncAccepted:true,syncUncertain:false};assert.equal((await h.event('browser-sync-result',result)).accepted,true);
 assert.deepEqual(seen,[['before',metadata],['result',result]]);
 assert.equal((await h.broker.dispose()).completed,true);
});

test('missing, unsuccessful or failing journals never acknowledge synchronization',async()=>{
 for(const journals of [{},{beforeBrowserSync:async()=>({recorded:false}),recordBrowserSyncResult:async()=>({})},
  {beforeBrowserSync:async()=>{throw Error('private details');},recordBrowserSyncResult:async()=>{throw Error('private details');}}]){
  const h=harness(journals);await h.broker.prepareBrowser({runtime:{},binding:{}});
  if(!journals.beforeBrowserSync)assert.equal(h.sent[0].input.browser.purpose,'preparation-only');
  for(const op of ['before-browser-sync','browser-sync-result'])assert.equal((await h.event(op,{})).accepted,false);
  assert.doesNotMatch(JSON.stringify(h.sent),/private details/);
  assert.equal((await h.broker.dispose()).completed,true);
 }
});

test('mount transport requires authentication journals and both mount journals',()=>{
 for(const values of [{beforeBrowserMount:async()=>({recorded:true})},
  {beforeBrowserMount:async()=>({recorded:true}),recordBrowserMountResult:async()=>({recorded:true})},
  {beforeBrowserSync:async()=>({recorded:true}),recordBrowserSyncResult:async()=>({recorded:true}),recordBrowserMountResult:async()=>({recorded:true})}]){
  let spawned=false;assert.throws(()=>createOdcNativeBroker({...values,spawnImpl:()=>{spawned=true;}}),/mount_journal_invalid/);
  assert.equal(spawned,false);
 }
});

test('authorized mount transport binds its URL and durably acknowledges submission and result',async()=>{
 const seen=[],record=op=>async metadata=>{seen.push([op,metadata]);return {recorded:true};};
 const runtime={runtimeUrl:'https://fixture.example/App/'};
 const mountAuthorization={policy:odcMountPolicy,authorizationSha256:'b'.repeat(64),runtimeUrl:runtime.runtimeUrl,screenKey:'W4JQW+OX20iILeFJFpMkqA'};
 const h=harness({beforeBrowserSync:record('sync'),recordBrowserSyncResult:record('sync-result'),
  beforeBrowserMount:record('mount'),recordBrowserMountResult:record('mount-result'),mountAuthorization,
  connectInspector:async()=>({close:async()=>{}})});
 await assert.rejects(h.broker.prepareBrowser({runtime:{runtimeUrl:'https://other.example/App/'},binding:{}}),/mount_authorization_invalid/);
 assert.equal(h.sent.length,0);
 await h.broker.prepareBrowser({runtime,binding:{}});
 assert.equal(h.sent[0].input.browser.purpose,'authorized-mount');
 assert.deepEqual(h.sent[0].input.mountAuthorization,mountAuthorization);
 // Connecting the native inspector remains necessary before dispatch.
 await assert.rejects(h.broker.mountBrowser(),/execution_unqualified/);
 assert.equal(h.sent.length,1);
 await h.broker.authenticate({binding:{lane:'odc'},expiresAt:new Date(Date.now()+60000).toISOString()});
 await h.broker.configureInspection({modules:[],leaseMs:10000});
 await h.broker.mountBrowser();
 assert.equal(h.sent.at(-1).op,'mount-browser');
 const metadata={sourceSha256:'a'.repeat(64)};
 assert.equal((await h.event('before-browser-mount',metadata)).accepted,true);
 const result={invoked:true,callbackReturned:true};
 assert.equal((await h.event('browser-mount-result',result)).accepted,true);
 assert.deepEqual(seen,[['mount',metadata],['mount-result',result]]);
 assert.equal((await h.broker.dispose()).completed,true);
});

test('ordinary preparation cannot acknowledge or dispatch a mount',async()=>{
 const h=harness();await h.broker.prepareBrowser({runtime:{},binding:{}});
 for(const op of ['before-browser-mount','browser-mount-result'])assert.equal((await h.event(op,{})).accepted,false);
 await assert.rejects(h.broker.mountBrowser(),/execution_unqualified/);
 assert.equal((await h.broker.dispose()).completed,true);
});
