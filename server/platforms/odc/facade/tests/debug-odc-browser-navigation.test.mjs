import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import vm from 'node:vm';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {bindOdcSdkNavigation,odcNavigationPin,odcScreenQuery,odcScreenLocation,createOdcBrowserNavigation} from '../debug-odc-browser-navigation.mjs';
import {createOdcNativeBroker} from '../debug-odc-native-broker.mjs';
import {odcMountPolicy} from '../debug-odc-browser-mount.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
import {file,source,chunk,pinFor,pin,sdkContext} from './fixtures/debug-odc-navigation-sdk.mjs';
const url='https://fixture.example/App/',handle='__ssamOdcRuntime_'+'a'.repeat(48);
function page({callbacks=true,lose=false}={}){
 const {calls,ctx,install,evaluate}=sdkContext(url,{callbacks});install(handle);
 let evaluations=0;
 const p={calls,ctx,send:async(method,params)=>{
  assert.equal(method,'Runtime.evaluate');assert.equal(params.awaitPromise,undefined);
  evaluations++;if(lose&&evaluations===1)throw new Error('transport lost');
  return {result:{value:evaluate(params.expression)}};
 },evaluations:()=>evaluations};
 return p;
}
function navigation(p,overrides={}){
 const journal=[];
 const n=createOdcBrowserNavigation({page:p,runtimeHandle:handle,runtimeUrl:url,module:'App',binding:bindOdcSdkNavigation({[file]:chunk},pin),
  beforeNavigate:async m=>{journal.push({before:m});return {recorded:true};},recordOutcome:async m=>{journal.push({outcome:m});return {recorded:true};},
  timeoutMs:5000,confirmMs:500,pollMs:5,...overrides});
 return {n,journal};
}
test('navigation binds only the pinned SDK Navigation declarations by hash',()=>{
 const b=bindOdcSdkNavigation({[file]:chunk},pin);
 assert.deepEqual(Object.keys(b.members).sort(),['generateScreenURL','getNavigationCallbacks','getUrlInfo','navigateBack','navigateTo']);
 assert.equal(b.members.navigateTo.symbol,'QO');assert.equal(b.members.navigateTo.source,source.slice(source.indexOf('function QO'),source.indexOf('function CH')));
 assert.match(b.members.getUrlInfo.source,/^function\(t\)\{/);assert.equal(b.effectsQualified,false);
 // A changed SDK is a different chunk; a declaration drift under the same pin refuses.
 assert.throws(()=>bindOdcSdkNavigation({[file]:chunk.replace('history.back()','location.reload()')},pin),/core_unreviewed/);
 const drift=pinFor(chunk);drift.declarations.navigateTo='0'.repeat(64);
 assert.throws(()=>bindOdcSdkNavigation({[file]:chunk},drift),/declaration_unreviewed/);
 assert.throws(()=>bindOdcSdkNavigation({},pin),/core_unreviewed/);
 assert.equal(odcNavigationPin.coreSha256,'1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d');
 assert.equal(odcNavigationPin.export,'s');
});
test('screen query and location are canonical and hashed',()=>{
 const q=odcScreenQuery([['Seed','4 2'],['Name','a&b']]);
 assert.equal(q.query,'Seed=4%202&Name=a%26b');assert.equal(q.querySha256,sha(q.query));
 assert.deepEqual(odcScreenQuery([]),{query:'',querySha256:sha('')});
 assert.equal(odcScreenLocation(url,'Probe',q.query),url+'Probe?'+q.query);assert.equal(odcScreenLocation(url,'Probe',''),url+'Probe');
 for(const bad of [[['__proto__','x']],[['Seed',4]],[['Seed','a'],['Seed','b']]])assert.throws(()=>odcScreenQuery(bad),/navigation_inputs_invalid/);
 assert.throws(()=>odcScreenLocation(url,'../x',''),/navigation_segment_invalid/);
});
test('in-app navigation uses only the hash-bound generateScreenURL then navigateTo, through the internal goTo',async()=>{
 const p=page(),{n,journal}=navigation(p);
 const r=await n.navigate({segment:'Probe',inputs:[['Seed','42']]});
 assert.deepEqual(p.calls,['goTo:/App/Probe?Seed=42']);assert.equal(p.ctx.fullReload,undefined);
 assert.equal(r.internalGoTo,true);assert.equal(r.reached,true);assert.equal(r.fullReload,false);
 assert.equal(journal[0].before.direction,'forward');assert.equal(journal[0].before.querySha256,sha('Seed=42'));
 assert.equal(journal[1].outcome.invoked,true);assert.equal(journal[1].outcome.internalGoTo,true);
 await assert.rejects(n.navigate({segment:'Probe',inputs:[]}),/back_required/);
 const back=await n.back();assert.equal(back.reached,true);assert.equal(back.internalGoBack,true);
 assert.deepEqual(p.calls,['goTo:/App/Probe?Seed=42','goBack']);assert.equal(journal[2].before.direction,'back');
 assert.equal(n.receipt().uncertain,false);assert.equal(n.receipt().navigations,2);
});
test('a substituted navigation function is refused before any navigation',async()=>{
 const p=page();vm.runInContext('var fake=Object.freeze({...ude,navigateTo:function QO(t,e){calls.push("fake")}})',p.ctx);
 p.ctx[handle]={loadedModule:f=>f===file?{s:vm.runInContext('fake',p.ctx)}:undefined};
 const {n}=navigation(p);await assert.rejects(n.navigate({segment:'Probe',inputs:[]}),/navigation_not_invoked/);
 assert.deepEqual(p.calls,[]);
});
test('missing internal goTo or a non-internal URL refuses instead of the full-reload fallback',async()=>{
 const none=page({callbacks:false}),a=navigation(none);
 await assert.rejects(a.n.navigate({segment:'Probe',inputs:[]}),/navigation_not_invoked/);
 assert.equal(none.ctx.fullReload,undefined);assert.equal(a.journal[1].outcome.invoked,false);assert.equal(a.journal[1].outcome.reason,'internal-navigation-unavailable');
 const external=page();external.ctx.external=true;const b=navigation(external);
 await assert.rejects(b.n.navigate({segment:'Probe',inputs:[]}),/navigation_not_invoked/);
 assert.equal(external.ctx.fullReload,undefined);assert.equal(b.journal[1].outcome.reason,'full-reload-refused');
 // The SDK-built URL must be the authorized one (module name is part of it).
 const other=page(),c=navigation(other,{module:'Other'});
 await assert.rejects(c.n.navigate({segment:'Probe',inputs:[]}),/navigation_not_invoked/);assert.equal(c.journal[1].outcome.reason,'url-mismatch');
 assert.deepEqual(other.calls,[]);
});
test('a lost navigation reply is uncertain and is never resent',async()=>{
 const p=page({lose:true}),{n,journal}=navigation(p);
 await assert.rejects(n.navigate({segment:'Probe',inputs:[]}),/result_uncertain/);
 assert.equal(journal[1].outcome.transportUnconfirmed,true);assert.equal(n.receipt().uncertain,true);
 await assert.rejects(n.navigate({segment:'Probe',inputs:[]}),/navigation_uncertain/);
 await assert.rejects(n.back(),/navigation_uncertain/);assert.equal(p.evaluations(),1);
});
test('unrecorded submission refuses before the page is touched; a reload is detected',async()=>{
 const p=page(),{n}=navigation(p,{beforeNavigate:async()=>({recorded:false})});
 await assert.rejects(n.navigate({segment:'Probe',inputs:[]}),/submission_unrecorded/);assert.equal(p.evaluations(),0);
 await assert.rejects(n.navigate({segment:'Probe',inputs:[]}),/navigation_uncertain|submission_unrecorded/);
 const r=page();vm.runInContext('gu.length=0;gH({goTo(o){calls.push("goTo");delete globalThis["'+handle+'"]}})',r.ctx);
 const reload=navigation(r);await assert.rejects(reload.n.navigate({segment:'Probe',inputs:[]}),/navigation_reload_detected/);
 assert.equal(reload.n.receipt().uncertain,false);
});
test('a reload that re-creates the runtime handle or a fresh realm is detected by identity, not by the handle alone',async()=>{
 // Same location, a new runtime object under the same handle (re-bootstrapped page).
 const a=page();vm.runInContext('gu.length=0;gH({goTo(o){calls.push("goTo");location.href=new URL(o.url,location.href).href;'+
  'globalThis["'+handle+'"]={loadedModule:globalThis["'+handle+'"].loadedModule}}})',a.ctx);
 const ra=navigation(a);await assert.rejects(ra.n.navigate({segment:'Probe',inputs:[]}),/navigation_reload_detected/);
 assert.equal(ra.journal[1].outcome.fullReload,true);assert.equal(ra.journal[1].outcome.reached,false);
 // A fresh realm: the debugger-owned mark is gone although a handle exists again.
 const b=page();vm.runInContext('gu.length=0;gH({goTo(o){location.href=new URL(o.url,location.href).href;'+
  'for(const k of Object.getOwnPropertyNames(globalThis))if(k.startsWith("__ssamOdcNavigation_"))delete globalThis[k]}})',b.ctx);
 const rb=navigation(b);await assert.rejects(rb.n.navigate({segment:'Probe',inputs:[]}),/navigation_reload_detected/);
});
test('the router callbacks captured before the call must be on top again; controller-init callbacks are transient',async()=>{
 // The router queues its navigation (setTimeout), like the pinned UI chunk's goTo.
 // A replaced router (callbacks pushed and never removed) is not the original navigation.
 const a=page();vm.runInContext('gu.length=0;gH({goTo(o){setTimeout(()=>{location.href=new URL(o.url,location.href).href;gH({goTo(){}})})}})',a.ctx);
 const ra=navigation(a);await assert.rejects(ra.n.navigate({segment:'Probe',inputs:[]}),/navigation_router_changed/);
 assert.equal(ra.journal[1].outcome.reached,true);assert.equal(ra.journal[1].outcome.sameCallbacksAfter,false);
 assert.equal(ra.n.receipt().uncertain,false);
 // ControllerInitNavigationCallback pushed while the target initializes, removed afterwards.
 const b=page();vm.runInContext('gu.length=0;gH({goTo(o){setTimeout(()=>{location.href=new URL(o.url,location.href).href;gH({goTo(){}});setTimeout(()=>pH(),30)})},'+
  'goBack(){location.href="'+url+'"}})',b.ctx);
 const rb=navigation(b),r=await rb.n.navigate({segment:'Probe',inputs:[]});
 assert.equal(r.reached,true);assert.equal(r.sameCallbacksAfter,true);assert.equal((await rb.n.back()).sameCallbacksAfter,true);
});
test('the pinned live SDK binds its Navigation exports when the r3 evidence is present',t=>{
 const dir=path.resolve(import.meta.dirname,'../../../../.local/debugger/native-runs/odc/55b60b0c-1d96-4381-b918-d8ac35c6b630/assets');
 const name='_oschunk-FDIVHSTQ.js';if(!fs.existsSync(path.join(dir,name))){t.skip('pinned r3 assets absent');return;}
 const b=bindOdcSdkNavigation({[name]:fs.readFileSync(path.join(dir,name),'utf8')});
 assert.deepEqual(Object.fromEntries(Object.entries(b.members).map(([k,m])=>[k,m.symbol])),
  {navigateTo:'QO',generateScreenURL:'ire',navigateBack:'CH',getNavigationCallbacks:'pu',getUrlInfo:'ZO'});
});
function fakeChild(handler){
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{child.emit('close');};
 child.stdin.on('finish',()=>setImmediate(()=>child.emit('close')));
 let buffer='';child.stdin.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);handler(JSON.parse(line),v=>child.stdout.write(JSON.stringify(v)+'\n'));}});
 return child;
}
test('broker relays navigate-browser with its own navigation journals and refuses without them',async()=>{
 const owned={dispose:async()=>({completed:true}),receipt:()=>({scope:'owned-browser-process'})};
 const request={policy:odcMountPolicy,authorizationSha256:'b'.repeat(64),runtimeUrl:url,screenKey:'W4JQW+OX20iILeFJFpMkqA',
  navigation:{screenKey:'RDyePs1DwUyB5poRbGhwVA',segment:'Probe',back:true,inputsSha256:[sha('Seed=1')]}};
 const journal={beforeBrowserSync:async()=>({recorded:true}),recordBrowserSyncResult:async()=>({recorded:true}),
  beforeBrowserMount:async()=>({recorded:true}),recordBrowserMountResult:async()=>({recorded:true})};
 assert.throws(()=>createOdcNativeBroker({...journal,ownedBrowser:owned,mountAuthorization:request,spawnImpl:()=>fakeChild(()=>{})}),/navigation_journal_invalid/);
 const seen=[];
 const broker=createOdcNativeBroker({...journal,ownedBrowser:owned,mountAuthorization:request,
  beforeBrowserNavigation:async m=>{seen.push(['before',m]);return {recorded:true};},recordBrowserNavigationResult:async m=>{seen.push(['result',m]);return {recorded:true};},
  connectInspector:async()=>({close:async()=>{},command:async()=>({})}),
  spawnImpl:()=>fakeChild((message,reply)=>{
   if(message.op==='authenticate')reply({id:message.id,ok:true,result:{authenticated:true,identityMatches:true}});
   if(message.op==='configure-inspection')reply({id:message.id,ok:true,result:{privateCapture:false}});
   if(message.op==='navigate-browser'){seen.push(['op',message.input]);
    reply({id:'request-1',op:'before-browser-navigation',metadata:{direction:'forward'}});
    reply({id:'request-2',op:'browser-navigation-result',metadata:{invoked:true}});
    setTimeout(()=>reply({id:message.id,ok:true,result:{reached:true}}),20);}
   if(message.op==='request-approved')seen.push(['approved',message.id,message.accepted]);
   if(message.op==='dispose')reply({id:message.id,ok:true,result:{completed:true}});
  })});
 await assert.rejects(broker.navigateBrowser({screenKey:request.navigation.screenKey,inputs:{Seed:'1'}}),/navigation_not_ready/);
 assert.deepEqual(seen,[]);
 await broker.authenticate({expiresAt:new Date(Date.now()+60000).toISOString(),binding:{}});
 await broker.configureInspection({leaseMs:30000});
 assert.deepEqual(await broker.navigateBrowser({screenKey:request.navigation.screenKey,inputs:{Seed:'1'}}),{reached:true});
 assert.deepEqual(seen,[['op',{screenKey:request.navigation.screenKey,inputs:{Seed:'1'}}],['before',{direction:'forward'}],['result',{invoked:true}],
  ['approved','request-1',true],['approved','request-2',true]]);
 await assert.rejects(broker.navigateBrowser({screenKey:'x',inputs:{}}),/navigation_input_invalid/);
 await broker.dispose();
});
