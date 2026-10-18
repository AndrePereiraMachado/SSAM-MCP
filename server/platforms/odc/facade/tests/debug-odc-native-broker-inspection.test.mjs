import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOdcNativeBroker } from '../debug-odc-native-broker.mjs';
import { odcMountPolicy } from '../debug-odc-browser-mount.mjs';
const mountAuthorization = { policy: odcMountPolicy, authorizationSha256: 'b'.repeat(64), runtimeUrl: 'https://fixture.example/App/', screenKey: 'W4JQW+OX20iILeFJFpMkqA' };

function browserHarness({connectFails=false,closeFails=false,ownedBrowser,brokerOptions={}}={}){
 const child=new EventEmitter(),events=[];child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};
 child.kill=()=>child.emit('close');child.stdin.end=()=>queueMicrotask(()=>child.emit('close'));
 child.stdin.write=bytes=>{const req=JSON.parse(bytes);queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({id:req.id,ok:true,result:
  req.op==='authenticate'?{authenticated:true,identityMatches:true}:req.op==='configure-inspection'?{privateCapture:true,url:'ws://127.0.0.1/private',helperName:'privateHelper'}:{completed:true}})+'\n'));};
 let configured,channelOptions;const channel={close(){events.push('channel-close');}};
 const broker=createOdcNativeBroker({...brokerOptions,spawnImpl:()=>child,ownedBrowser,privateChannelFactory:options=>{channelOptions=options;return channel;},
  connectInspector:async options=>{configured=options;if(connectFails)throw new Error('connect-failed');return {close:async()=>{events.push('inspector-close');if(closeFails)throw new Error('close-failed');}};}});
 return {broker,child,events,channel,configured:()=>configured,channelOptions:()=>channelOptions};
}

test('authorized mount preparation requires journals, the authorized URL and an owned browser before submission',async()=>{
 const ownedBrowser={inspectionUrl:'ws://127.0.0.1:45678/devtools/page/ABCDEF',
  receipt:()=>({scope:'owned-browser-process',ready:true,expiresAt:new Date(Date.now()+60000).toISOString()}),dispose:async()=>({completed:true})};
 assert.throws(()=>createOdcNativeBroker({mountAuthorization,ownedBrowser}),/mount_journal_invalid/);
 const journal=async()=>({recorded:true}),journals={beforeBrowserSync:journal,recordBrowserSyncResult:journal,beforeBrowserMount:journal,recordBrowserMountResult:journal};
 // Mount journals without the user's authorization, or an altered request, never spawn a worker.
 for(const options of [journals,{...journals,mountAuthorization:{...mountAuthorization,staticEffectsQualified:true}},{...journals,mountAuthorization}]){
  let spawned=false;assert.throws(()=>createOdcNativeBroker({...options,spawnImpl:()=>{spawned=true;}}),/mount_journal_invalid/);assert.equal(spawned,false);
 }
 const h=browserHarness({ownedBrowser,brokerOptions:{mountAuthorization,...journals}});
 const requests=[],write=h.child.stdin.write;h.child.stdin.write=bytes=>{requests.push(JSON.parse(bytes));write(bytes);};
 await assert.rejects(h.broker.prepareBrowser({runtime:{runtimeUrl:'https://other.example/App/'},binding:{module:'App'}}),/mount_authorization_invalid/);
 assert.equal(requests.length,0);
 await h.broker.prepareBrowser({runtime:{runtimeUrl:'https://fixture.example/App/'},binding:{module:'App'},qualification:{modelQualified:true}});
 assert.equal(requests[0].input.browser.purpose,'authorized-mount');
 assert.deepEqual(requests[0].input.mountAuthorization,mountAuthorization);
 assert.equal(Object.hasOwn(requests[0].input,'qualification'),false);
 await assert.rejects(h.broker.mountBrowser(),/execution_unqualified/);
 assert.equal(requests.filter(r=>r.op==='mount-browser').length,0);await h.broker.dispose();
});
test('parent closes its owned browser when worker is lost, and cleanup is idempotent',async()=>{
 let closes=0;
 const ownedBrowser={receipt:()=>({scope:'owned-browser-process'}),dispose:async()=>{closes++;return {completed:true};}};
 const h=browserHarness({ownedBrowser});h.child.emit('error',new Error('worker lost'));h.child.emit('close');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(closes,1);
 const result=await h.broker.dispose();assert.equal(result.completed,false);assert.equal(result.ownedBrowserCleanup.completed,true);assert.equal(closes,1);
 assert.equal(result.workerExited,true);assert.equal(result.inspectionClosed,true);assert.equal(result.nativeCleanupConfirmed,false);
});
test('browser cleanup failure cannot become successful broker disposal',async()=>{
 const h=browserHarness({ownedBrowser:{receipt:()=>({scope:'owned-browser-process'}),dispose:async()=>{throw new Error('lost browser');}}});
 assert.equal((await h.broker.dispose()).completed,false);
 assert.throws(()=>browserHarness({ownedBrowser:{dispose:async()=>{}}}),/browser_owner_invalid/);
});
test('browser private capture binds host channel to authenticated descriptor and model sources',async()=>{
 const h=browserHarness(),descriptor={binding:{lane:'odc',sessionId:'owned'},expiresAt:new Date(Date.now()+60000).toISOString()},modules=[{moduleKey:'A'.repeat(22),sourceSha256:'a'.repeat(64)}];
 await h.broker.authenticate(descriptor);await h.broker.configureInspection({modules,leaseMs:10000});
 assert.equal(h.configured().privateChannel,h.channel);assert.deepEqual(h.channelOptions().binding,descriptor.binding);assert.deepEqual(h.channelOptions().sources,modules);
 assert.ok(Date.parse(h.channelOptions().expiresAt)<=Date.parse(descriptor.expiresAt));
 const result=await h.broker.dispose();assert.equal(result.completed,true);assert.equal(result.workerExited,true);assert.equal(result.inspectionClosed,true);assert.equal(result.nativeCleanupConfirmed,true);assert.deepEqual(h.events,['inspector-close','channel-close']);
});
test('browser capture cannot configure before authenticated identity or outlive descriptor',async()=>{
 const h=browserHarness();await assert.rejects(h.broker.configureInspection({modules:[],leaseMs:1000}),/deadline_invalid/);
 assert.equal(h.configured(),undefined);await h.broker.dispose();
});
test('host channel closes after connection or inspector teardown fails',async()=>{
 for(const options of [{connectFails:true},{closeFails:true}]){
  const h=browserHarness(options);await h.broker.authenticate({binding:{lane:'odc'},expiresAt:new Date(Date.now()+60000).toISOString()});
  const configure=h.broker.configureInspection({modules:[],leaseMs:1000});
  if(options.connectFails)await assert.rejects(configure,/connect-failed/);else await configure;
  const result=await h.broker.dispose();assert.ok(h.events.includes('channel-close'));
  if(options.closeFails){assert.equal(result.completed,false);assert.equal(result.inspectionClosed,false);assert.equal(result.workerExited,true);assert.equal(result.nativeCleanupConfirmed,true);}
 }
});

test('private channel failure preserves worker and browser cleanup evidence without claiming completion',async()=>{
 let browserCloses=0;
 const h=browserHarness({ownedBrowser:{receipt:()=>({scope:'owned-browser-process'}),dispose:async()=>{browserCloses++;return {completed:true};}}});
 await h.broker.authenticate({binding:{lane:'odc'},expiresAt:new Date(Date.now()+60000).toISOString()});
 await h.broker.configureInspection({modules:[],leaseMs:1000});
 h.channel.close=()=>{throw Error('private cleanup failed');};
 const result=await h.broker.dispose();
 assert.equal(result.completed,false);assert.equal(result.privateChannelClosed,false);
 assert.equal(result.workerExited,true);assert.equal(result.inspectionClosed,true);
 assert.equal(result.nativeCleanupConfirmed,true);assert.equal(result.ownedBrowserCleanup.completed,true);
 assert.equal(browserCloses,1);
});

test('server inspection keeps broker watchdog on the fixed lease, not the normal invocation timeout', async t => {
  const now = 1790000000000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const child = new EventEmitter(), calls = [];
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  let kills = 0;
  child.kill = () => { kills++; child.emit('close'); };
  const reply = (request, result) => child.stdout.emit('data', JSON.stringify({ id: request.id, ok: true, result }) + '\n');
  child.stdin.write = bytes => {
    const request = JSON.parse(bytes); calls.push(request);
    if (request.op === 'configure-server-inspection') queueMicrotask(() => reply(request, { configured: true, expiresAt: request.input.expiresAt }));
  };
  const broker = createOdcNativeBroker({ spawnImpl: () => child });
  const expiresAt = new Date(now + 30000).toISOString();
  assert.equal((await broker.configureServerInspection({ expiresAt })).expiresAt, expiresAt);
  const invocation = broker.invoke({ timeoutSeconds: 1 });
  t.mock.timers.tick(12000);
  assert.equal(kills, 0, 'ordinary invocation timeout killed the paused worker');
  reply(calls.at(-1), { ok: true });
  assert.equal((await invocation).ok, true);
  // A later call keeps the same absolute deadline; it does not renew the lease.
  const next = broker.invoke({ timeoutSeconds: 300 });
  const rejected = assert.rejects(next, /worker_timeout/);
  t.mock.timers.tick(28001);
  await rejected;
  assert.equal(kills, 1);
});

test('browser mount survives ordinary timeout but pause/resume cannot renew the credential deadline',async t=>{
 const now=1790000000000;t.mock.timers.enable({apis:['setTimeout','Date'],now});
 const child=new EventEmitter(),calls=[];child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};
 let kills=0,inspectorOptions;child.kill=()=>{kills++;child.emit('close');};
 child.stdin.write=bytes=>{const request=JSON.parse(bytes);calls.push(request);
  if(request.op==='mount-browser')return;
  const result=request.op==='authenticate'?{authenticated:true,identityMatches:true}:{completed:true};
  queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({id:request.id,ok:true,result})+'\n'));
 };
 const record=async()=>({recorded:true});
 const broker=createOdcNativeBroker({spawnImpl:()=>child,beforeBrowserSync:record,recordBrowserSyncResult:record,
  beforeBrowserMount:record,recordBrowserMountResult:record,mountAuthorization,
  ownedBrowser:{receipt:()=>({scope:'owned-browser-process'}),dispose:async()=>({completed:true})},
  connectInspector:async options=>{inspectorOptions=options;return {close:async()=>{}};}});
 await broker.authenticate({binding:{lane:'odc'},expiresAt:new Date(now+120000).toISOString()});
 await broker.configureInspection({modules:[],leaseMs:300000});
 assert.equal(calls.at(-1).input.inspectionExpiresAt,new Date(now+120000).toISOString());
 assert.equal(inspectorOptions.leaseMs,120000);
 const mounted=broker.mountBrowser(),rejected=assert.rejects(mounted,/worker_timeout/);
 t.mock.timers.tick(80000);assert.equal(kills,0);
 inspectorOptions.onEvent({kind:'paused'});t.mock.timers.tick(10000);
 inspectorOptions.onEvent({kind:'resumed'});t.mock.timers.tick(39999);assert.equal(kills,0);
 t.mock.timers.tick(2);await rejected;assert.equal(kills,1);
});

test('inspection activity reports native pauses and the last change without exposing events',async t=>{
 const now=1790000000000;t.mock.timers.enable({apis:['Date'],now});
 const h=browserHarness();assert.deepEqual(h.broker.inspectionActivity(),{configured:false,paused:false,stops:0,functions:[],exceptions:[],lastChangeAt:null,ended:false});
 await h.broker.authenticate({binding:{lane:'odc'},expiresAt:new Date(now+60000).toISOString()});
 await h.broker.configureInspection({modules:[],leaseMs:10000});
 assert.deepEqual(h.broker.inspectionActivity(),{configured:true,paused:false,stops:0,functions:[],exceptions:[],lastChangeAt:now,ended:false});
 t.mock.timers.tick(500);h.configured().onEvent({kind:'paused',stop:1,values:{private:true}});
 assert.deepEqual(h.broker.inspectionActivity(),{configured:true,paused:true,stops:1,functions:[],exceptions:[],lastChangeAt:now+500,ended:false});
 t.mock.timers.tick(700);h.configured().onEvent({kind:'resumed'});
 assert.deepEqual(h.broker.inspectionActivity(),{configured:true,paused:false,stops:1,functions:[],exceptions:[],lastChangeAt:now+1200,ended:false});
 h.child.emit('close');assert.equal(h.broker.inspectionActivity().ended,true);
 await h.broker.dispose();
});

const M='7WNw7ud8AEKh1ftGQYhllg',INIT='OzK7jk5Lo0Wu2dmagSNFog',READY='ALQheqsdZEGBVNun+Anl5w';
const frame=(fn,i)=>({frame:i,elementKey:M+':'+fn+':/NRWebFlows.x/ClientActions.'+fn+':NdNJnz9aAvWGfF52hc8J0Q',action:'private-name-'+i});
test('activity records moduleKey:functionKey of the paused frame for every stop and never values',async()=>{
 const h=browserHarness();await h.broker.authenticate({binding:{lane:'odc'},expiresAt:new Date(Date.now()+60000).toISOString()});
 await h.broker.configureInspection({modules:[],leaseMs:10000});
 h.configured().onEvent({kind:'paused',stop:1,frame:1,frames:[frame('1ULmiCmtzU+sHAfL_d9fqQ',0),frame(INIT,1)],values:[{value:'secret-value'}]});
 h.configured().onEvent({kind:'resumed'});
 h.configured().onEvent({kind:'paused',stop:2,frame:0,frames:[frame(READY,0)]});
 h.configured().onEvent({kind:'paused',stop:3,frame:0,frames:[{elementKey:'not-a-key'}]});
 const activity=h.broker.inspectionActivity();
 assert.deepEqual(activity.functions,[M+':'+INIT,M+':'+READY]);assert.equal(activity.stops,3);
 assert.doesNotMatch(JSON.stringify(activity),/secret-value|private-name|NRWebFlows/);
 activity.functions.push('tampered');assert.equal(h.broker.inspectionActivity().functions.length,2);
 await h.broker.dispose();
});

function renderHarness(){
 const child=new EventEmitter(),requests=[];let renderReply;
 child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};
 child.kill=()=>child.emit('close');child.stdin.end=()=>queueMicrotask(()=>child.emit('close'));
 child.stdin.write=bytes=>{const req=JSON.parse(bytes);requests.push(req);queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({id:req.id,ok:true,result:
  req.op==='authenticate'?{authenticated:true,identityMatches:true}:req.op==='observe-browser-render'?renderReply:{completed:true}})+'\n'));};
 const values=new Map();let configured;
 const record=async()=>({recorded:true});
 const broker=createOdcNativeBroker({spawnImpl:()=>child,beforeBrowserSync:record,recordBrowserSyncResult:record,beforeBrowserMount:record,recordBrowserMountResult:record,
  mountAuthorization,ownedBrowser:{receipt:()=>({scope:'owned-browser-process'}),dispose:async()=>({completed:true})},
  connectInspector:async options=>{configured=options;return {close:async()=>{},command:async input=>{
   if(input.op==='scope')return {stop:input.stop,generation:1,frame:0,variables:[
    {ref:'a'.repeat(48),name:'LifecycleCount',category:'local',stop:input.stop,frame:0},{ref:'b'.repeat(48),name:'LifecycleCount',category:'local',stop:input.stop,frame:1}]};
   if(input.op==='read-many')return {stop:input.stop,values:input.refs.map(ref=>({ref,...values.get(ref)}))};
   if(input.op==='read')return {stop:input.stop,ref:input.ref,...values.get(input.ref)};
   return {};
  }};}});
 const targets={complete:true,instances:[{key:'W4JQW+OX20iILeFJFpMkqA',namespace:'',ids:['CountValue'],functions:[M+':'+READY],ambiguous:false,
  texts:[{id:'CountValue',variable:'LifecycleCount',form:'integerToText'}]}]};
 const observation=text=>({observed:true,documentMatched:true,evaluated:false,roots:[{key:'W4JQW+OX20iILeFJFpMkqA',present:true}],
  texts:[{key:'W4JQW+OX20iILeFJFpMkqA',id:'CountValue',present:true,unique:true,text}]});
 return {broker,requests,values,configured:()=>configured,render:text=>{renderReply={targets,observation:observation(text)};}};
}
test('browser render evidence is compared with the session\'s own last native read and returns no values',async()=>{
 const h=renderHarness();
 await assert.rejects(h.broker.observeBrowserRender(),/execution_unqualified/);
 await h.broker.authenticate({binding:{lane:'odc'},expiresAt:new Date(Date.now()+60000).toISOString()});
 await h.broker.configureInspection({modules:[],leaseMs:10000});
 // Stop 1 in another function: its read never counts for the bound screen variable.
 h.configured().onEvent({kind:'paused',stop:1,frame:0,frames:[frame(READY,0),frame(INIT,1)]});
 await h.broker.inspection({op:'scope',stop:1});
 h.values.set('a'.repeat(48),{value:{value:1,type:'Integer'},redacted:false,valueComplete:true});
 h.values.set('b'.repeat(48),{value:{value:11,type:'Integer'},redacted:false,valueComplete:true});
 await h.broker.inspection({op:'read',stop:1,ref:'b'.repeat(48)});
 h.render('11');
 let verdict=await h.broker.observeBrowserRender();
 assert.equal(verdict.renderVerified,false);assert.ok(verdict.reasons.includes('native-read-missing'));
 await h.broker.inspection({op:'read-many',stop:1,refs:['a'.repeat(48)]});
 h.render('1');verdict=await h.broker.observeBrowserRender();
 assert.equal(verdict.renderVerified,true);assert.deepEqual(verdict.reasons,[]);
 assert.doesNotMatch(JSON.stringify(verdict),/"1"|"11"|text/);
 // A later native read decides; a mismatch is never verified.
 h.values.set('a'.repeat(48),{value:{value:11,type:'Integer'},redacted:false,valueComplete:true});
 await h.broker.inspection({op:'read-many',stop:1,refs:['a'.repeat(48)]});
 verdict=await h.broker.observeBrowserRender();
 assert.equal(verdict.renderVerified,false);assert.ok(verdict.reasons.includes('text-mismatch'));
 h.render('11');assert.equal((await h.broker.observeBrowserRender()).renderVerified,true);
 // A later redacted or incomplete read is not native evidence, and the older value is stale.
 h.values.set('a'.repeat(48),{value:{value:'11',type:'Integer'},redacted:true,valueComplete:false});
 await h.broker.inspection({op:'read-many',stop:1,refs:['a'.repeat(48)]});
 verdict=await h.broker.observeBrowserRender();
 assert.equal(verdict.renderVerified,false);assert.ok(verdict.reasons.includes('native-read-missing'));
 assert.equal(h.requests.filter(r=>r.op==='observe-browser-render').length,5);
 await h.broker.dispose();
});

import {PassThrough} from 'node:stream';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {odcHandlerCoverage} from '../debug-odc-native-mount-run.mjs';
function lineChild(handler){
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{child.emit('close');};
 child.stdin.on('finish',()=>setImmediate(()=>child.emit('close')));
 let buffer='';child.stdin.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);handler(JSON.parse(line),v=>child.stdout.write(JSON.stringify(v)+'\n'));}});
 return child;
}
const SAVE='SvAheqsdZEGBVNun+Anl5w',interactionAuthorization=[{target:'SaveButton',event:'click',name:'SaveButton',viewKey:mountAuthorization.screenKey,actionKey:SAVE}];
const mountJournals={beforeBrowserSync:async()=>({recorded:true}),recordBrowserSyncResult:async()=>({recorded:true}),beforeBrowserMount:async()=>({recorded:true}),recordBrowserMountResult:async()=>({recorded:true})};
const owned={dispose:async()=>({completed:true}),receipt:()=>({scope:'owned-browser-process',ready:true,expiresAt:new Date(Date.now()+60000).toISOString()}),inspectionUrl:'ws://127.0.0.1:45678/devtools/page/ABCDEF'};
test('interaction requires both journals and an authorized mount before any worker exists',()=>{
 const record=async()=>({recorded:true}),both={beforeBrowserInteraction:record,recordBrowserInteractionResult:record};
 for(const options of [{...both,interactionAuthorization},{...mountJournals,mountAuthorization,interactionAuthorization},
  {...mountJournals,mountAuthorization,...both},{...mountJournals,mountAuthorization,interactionAuthorization,beforeBrowserInteraction:record},
  {...mountJournals,mountAuthorization,...both,interactionAuthorization:[{...interactionAuthorization[0],event:'dblclick'}]},
  {...mountJournals,mountAuthorization,...both,interactionAuthorization:[]}]){
  let spawned=false;
  assert.throws(()=>createOdcNativeBroker({...options,ownedBrowser:owned,spawnImpl:()=>{spawned=true;}}),/interaction_journal_invalid/);assert.equal(spawned,false);
 }
});
test('broker relays one interact-browser per authorized index with its own journals and the authorization in prepare',async()=>{
 const seen=[];
 const broker=createOdcNativeBroker({...mountJournals,ownedBrowser:owned,mountAuthorization,interactionAuthorization,
  beforeBrowserInteraction:async m=>{seen.push(['before',m]);return {recorded:true};},recordBrowserInteractionResult:async m=>{seen.push(['result',m]);return {recorded:true};},
  connectInspector:async()=>({close:async()=>{},command:async()=>({})}),
  spawnImpl:()=>lineChild((message,reply)=>{
   if(message.op==='prepare-browser'){seen.push(['prepare',message.input.interactionAuthorization]);reply({id:message.id,ok:true,result:{prepared:true}});}
   if(message.op==='authenticate')reply({id:message.id,ok:true,result:{authenticated:true,identityMatches:true}});
   if(message.op==='configure-inspection')reply({id:message.id,ok:true,result:{privateCapture:false}});
   if(message.op==='interact-browser'){seen.push(['op',message.input]);
    reply({id:'request-1',op:'before-browser-interaction',metadata:{sequence:0,event:'click'}});
    reply({id:'request-2',op:'browser-interaction-result',metadata:{sequence:0,dispatched:true}});
    setTimeout(()=>reply({id:message.id,ok:true,result:{dispatched:true}}),20);}
   if(message.op==='observe-browser-error-page')reply({id:message.id,ok:true,result:{observed:true,navigated:false,marked:false}});
   if(message.op==='request-approved')seen.push(['approved',message.id,message.accepted]);
   if(message.op==='dispose')reply({id:message.id,ok:true,result:{completed:true}});
  })});
 await assert.rejects(broker.interactBrowser(0),/interaction_not_ready/);assert.deepEqual(seen,[]);
 await broker.prepareBrowser({runtime:{runtimeUrl:mountAuthorization.runtimeUrl},binding:{module:'App'}});
 assert.deepEqual(seen.shift(),['prepare',interactionAuthorization]);
 await broker.authenticate({expiresAt:new Date(Date.now()+60000).toISOString(),binding:{}});
 await broker.configureInspection({leaseMs:30000});
 await assert.rejects(broker.interactBrowser(1),/interaction_input_invalid/);await assert.rejects(broker.interactBrowser('0'),/interaction_input_invalid/);
 assert.deepEqual(await broker.interactBrowser(0),{dispatched:true});
 assert.deepEqual(seen,[['op',{index:0}],['before',{sequence:0,event:'click'}],['result',{sequence:0,dispatched:true}],['approved','request-1',true],['approved','request-2',true]]);
 assert.equal((await broker.observeBrowserErrorPage()).observed,true);
 await broker.dispose();
});
test('a broker without interactions never relays a click',async()=>{
 const h=browserHarness({ownedBrowser:owned,brokerOptions:{mountAuthorization,...mountJournals}});
 await h.broker.authenticate({binding:{lane:'odc'},expiresAt:new Date(Date.now()+60000).toISOString()});await h.broker.configureInspection({modules:[],leaseMs:10000});
 await assert.rejects(h.broker.interactBrowser(0),/interaction_not_ready/);await h.broker.dispose();
});
test('exception stops and the global OnException (.#FlowExceptionHandler) are recorded by identity and type only',async()=>{
 const h=browserHarness();await h.broker.authenticate({binding:{lane:'odc'},expiresAt:new Date(Date.now()+60000).toISOString()});
 await h.broker.configureInspection({modules:[],leaseMs:10000});
 const HANDLER='EXwJnWDBJUGdVNVnSt55DQ.#FlowExceptionHandler';
 h.configured().onEvent({kind:'paused',stop:1,frame:0,frames:[frame(INIT,0)],reason:'exception',exception:{type:'Error',typeRedacted:false,message:'private-message'}});
 h.configured().onEvent({kind:'resumed'});
 h.configured().onEvent({kind:'paused',stop:2,frame:0,frames:[frame(HANDLER,0)]});
 h.configured().onEvent({kind:'paused',stop:3,frame:0,frames:[frame(READY,0)],reason:'exception',exception:{type:'<script>'}});
 const activity=h.broker.inspectionActivity();
 assert.deepEqual(activity.functions,[M+':'+INIT,M+':'+HANDLER,M+':'+READY]);
 assert.deepEqual(activity.exceptions,[{stop:1,function:M+':'+INIT,type:'Error'},{stop:3,function:M+':'+READY,type:'unknown'}]);
 assert.doesNotMatch(JSON.stringify(activity),/private-message|script/);
 const coverage=odcHandlerCoverage({views:[{key:mountAuthorization.screenKey,handlers:[{handler:'onInitializeEventHandler',actionKey:INIT}],absentHandlers:[]}],
  startup:{actionKeys:[HANDLER]}},M,activity.functions);
 assert.deepEqual(coverage.exceptionHandlers,[{functionKey:HANDLER,global:true,stops:1,firstIndex:1,lastIndex:1}]);
 assert.equal(coverage.declared,1);
 await h.broker.dispose();
});
test('the worker refuses interact-browser outside an authorized mount and interaction authorization without a mount',async()=>{
 const worker=spawn(process.execPath,[fileURLToPath(new URL('../debug-odc-native-worker.mjs',import.meta.url))],{stdio:['pipe','pipe','ignore'],windowsHide:true});
 const replies=new Map();let buffer='';worker.stdout.setEncoding('utf8');
 worker.stdout.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){const r=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);replies.get(r.id)?.(r);}});
 const ask=(id,op,input)=>new Promise(resolve=>{replies.set(id,resolve);worker.stdin.write(JSON.stringify({id,op,input})+'\n');});
 assert.deepEqual(await ask('1','interact-browser',{index:0}),{id:'1',ok:false,error:'debug_odc_native_browser_execution_unqualified'});
 assert.deepEqual(await ask('2','observe-browser-error-page',{}),{id:'2',ok:false,error:'debug_odc_native_browser_execution_unqualified'});
 const refused=await ask('3','prepare-browser',{interactionAuthorization,runtime:{runtimeUrl:mountAuthorization.runtimeUrl},browser:{purpose:'authenticated-preparation',url:'ws://127.0.0.1:1/devtools/page/x'}});
 assert.deepEqual(refused,{id:'3',ok:false,error:'debug_odc_browser_interaction_authorization_invalid'});
 assert.deepEqual(await ask('4','interact-browser',{index:0}),{id:'4',ok:false,error:'debug_odc_native_browser_execution_unqualified'});
 worker.stdin.end();await new Promise(resolve=>worker.once('close',resolve));
});
