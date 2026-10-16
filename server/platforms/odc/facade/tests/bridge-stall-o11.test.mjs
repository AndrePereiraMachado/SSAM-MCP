import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeRequest, o11Bridge } from '../o11-bridge.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';
const wait = ms => new Promise(r => setTimeout(r, ms));
const report = {title:'Unexpected Error',type:'DialogWindow',isVisible:true,isModal:false};
for (const method of ['merge_from_oml','publish','open_module']) test(`${method}: positive dialog evidence abandons once, preserves flight, late reply releases`, async () => {
  let visible = false, main, flights = 0, released = 0, cleared = 0;
  const bridge = await fakeBridge((req,socket) => {
    if(req.method === 'ping') return {success:true,data:{pid:process.pid}};
    if(req.method === 'bridge_manifest') return {success:true,data:{capabilities:[]}};
    if(req.method === 'windows') return {success:true,data:{windows:visible ? [report] : []}};
    main=socket; visible=true;
  });
  const flight=(_method,_params,extra) => {flights++; assert.equal(extra.blockedBy.title,report.title); const release=()=>{released++}; release.update=value=>{if(value.blockedBy===null)cleared++}; return release;};
  try {
    const started=Date.now();
    await assert.rejects(bridgeRequest({port:bridge.port,pid:process.pid,flight},method,{}, {probeMs:30,probeTimeoutMs:100,timeoutMs:2000}), error=>error.code==='BRIDGE_STALLED' && error.stall.verdict==='dialog' && error.executed===undefined);
    assert.ok(Date.now()-started<1000); assert.equal(flights,1); assert.equal(released,0);
    visible=false; await wait(100); assert.equal(cleared,1);
    // CX14 R5: the stalled flight keeps sampling while it lives (a blocker can come back), and only until it ends.
    const probesAfterClear=bridge.seen.filter(x=>x.method==='windows').length;await wait(70);assert.ok(bridge.seen.filter(x=>x.method==='windows').length>probesAfterClear,'polling goes on while the flight lives');
    main.write(JSON.stringify({success:true,data:{done:true}})+'\n'); await wait(30); assert.equal(released,1);
    const probesAfterRelease=bridge.seen.filter(x=>x.method==='windows').length;await wait(70);assert.ok(bridge.seen.filter(x=>x.method==='windows').length-probesAfterRelease<=1,'polling stops when the flight ends');
    assert.equal(bridge.seen.filter(x=>x.method===method).length,1);
  } finally {await bridge.close()}
});
test('pre-probe refuses without sending; automatic error-report capability permits the operation', async () => {
  let automatic=false;
  const bridge=await fakeBridge(req => ({success:true,data:req.method==='windows'?{windows:[report]}:req.method==='bridge_manifest'?{capabilities:automatic?['dialogs:error_report_auto']:[]}:{done:true}}));
  try {
    const opts={probeMs:30,probeTimeoutMs:100,timeoutMs:2000};
    const result=await bridgeRequest({port:bridge.port},'publish',{},opts);
    assert.equal(result.code,'STUDIO_ERROR_DIALOG_OPEN');assert.equal(result.executed,false);assert.equal(bridge.seen.filter(x=>x.method==='publish').length,0);
    automatic=true;
    assert.equal((await bridgeRequest({port:bridge.port},'publish',{},opts)).success,true);
    await assert.rejects(o11Bridge({port:bridge.port}).ok('open_module',{},opts),e=>e.code==='STUDIO_ERROR_DIALOG_OPEN' && e.reply?.executed===false);
  }finally{await bridge.close()}
});
test('slow probes, refused probes and progress are never evidence of a stall', async () => {
  let main;
  const bridge=await fakeBridge((req,socket)=>{
    if(req.method==='windows')return {success:true,data:{windows:[{...report,title:'Publishing... 45%',isModal:true}]}};
    if(req.method==='bridge_manifest'||req.method==='ping')return {success:false,executed:false};
    main=socket;setTimeout(()=>socket.write('{"success":true,"data":{"done":true}}\n'),180);
  });
  try {assert.equal((await bridgeRequest({port:bridge.port},'publish',{}, {probeMs:20,probeTimeoutMs:50,timeoutMs:1000})).data.done,true)}finally{await bridge.close()}
});

test('o11_studio open-module exposes the stall and recovery in its existing failure path',async()=>{
  const { o11Studio }=await import('../o11-studio.mjs');
  let visible=false;
  const bridge=await fakeBridge(req=>{
    if(req.method==='windows')return {success:true,data:{windows:visible?[report]:[]}};
    if(req.method==='ping')return {success:true,data:{pid:process.pid}};
    if(req.method==='bridge_manifest')return {success:true,data:{capabilities:[]}};
    if(req.method==='open_module'){visible=true;return undefined}
    return {success:true,data:{}};
  });
  const client=o11Bridge({port:bridge.port,pid:process.pid});
  const wrapped={ok:(method,params,options)=>client.ok(method,params,{probeMs:25,probeTimeoutMs:100,timeoutMs:2000,...options})};
  try {
    const run=o11Studio({bridge:wrapped,assertSelected:async()=>{},inventory:async()=>null});
    const answer=await run({command:'open-module',args:{name:'TestModule'}});
    assert.equal(answer.code,'BRIDGE_STALLED'); assert.equal(answer.stalled.verdict,'dialog');
    assert.equal(answer.recovery[0].arguments.command,'dismiss-dialog');
    assert.deepEqual(answer.continuation,answer.recovery[0]);
    assert.equal(bridge.seen.filter(r=>r.method==='open_module').length,1);
  }finally{await bridge.close()}
});
test('o11_studio pre-probe refusal includes dismiss and the original command',async()=>{
  const { o11Studio }=await import('../o11-studio.mjs');
  const bridge=await fakeBridge(req=>({success:true,data:req.method==='windows'?{windows:[report]}:req.method==='ping'?{pid:process.pid}:{capabilities:[]}}));
  const client=o11Bridge({port:bridge.port,pid:process.pid});
  const wrapped={ok:(method,params,options)=>client.ok(method,params,{probeMs:25,probeTimeoutMs:100,timeoutMs:2000,...options})};
  try {
    const run=o11Studio({bridge:wrapped,assertSelected:async()=>{},inventory:async()=>null});
    const answer=await run({command:'open-module',args:{name:'TestModule'}});
    assert.equal(answer.code,'STUDIO_ERROR_DIALOG_OPEN');assert.equal(answer.outcome,'not-sent');
    assert.equal(answer.recovery[0].arguments.command,'dismiss-dialog');
    assert.equal(answer.recovery[1].arguments.command,'open-module');assert.equal(answer.recovery[1].arguments.args.name,'TestModule');
    assert.equal(bridge.seen.filter(r=>r.method==='open_module').length,0);
  }finally{await bridge.close()}
});
test('publish outcome preserves uncertainty and pre-probe refusal codes without editing publisher',async()=>{
  const { publishOutcome }=await import('../o11-publish.mjs');
  let visible=false;
  const bridge=await fakeBridge(req=>{
    if(req.method==='windows')return {success:true,data:{windows:visible?[report]:[]}};
    if(req.method==='ping')return {success:true,data:{pid:process.pid}};
    if(req.method==='bridge_manifest')return {success:true,data:{capabilities:[]}};
    if(req.method==='publish'){visible=true;return undefined}
  });
  const client=o11Bridge({port:bridge.port,pid:process.pid});
  try {
    const options={probeMs:25,probeTimeoutMs:100,timeoutMs:2000};
    let error;try{await client.ok('publish',{},options)}catch(e){error=e}
    assert.equal(publishOutcome({error},{name:'TestModule'}).code,'PUBLISH_UNCERTAIN');
    try{await client.ok('publish',{},options)}catch(e){error=e}
    assert.equal(publishOutcome({error},{name:'TestModule'}).code,'STUDIO_ERROR_DIALOG_OPEN');
    assert.equal(bridge.seen.filter(r=>r.method==='publish').length,1);
  }finally{await bridge.close()}
});
test('manifest is probed once per client and disabling the watch performs no probes',async()=>{
  const bridge=await fakeBridge(req=>({success:true,data:req.method==='windows'?{windows:[]}:req.method==='ping'?{pid:process.pid}:req.method==='bridge_manifest'?{capabilities:[]}:{done:true}}));
  try {
    const client=o11Bridge({port:bridge.port}); const options={probeMs:25,probeTimeoutMs:100,timeoutMs:2000};
    await client.ok('open_module',{},options);await client.ok('publish',{},options);
    assert.equal(bridge.seen.filter(r=>r.method==='bridge_manifest').length,1);
    const before=bridge.seen.length;
    await client.ok('open_module',{}, {...options,probeMs:0});
    assert.deepEqual(bridge.seen.slice(before).map(r=>r.method),['open_module']);
  }finally{await bridge.close()}
});
for(const mode of ['refusal','timeout','malformed']) test(`${mode} windows probe never turns a slow successful operation into a stall`,async()=>{
  const bridge=await fakeBridge((req,socket)=>{
    if(req.method==='ping')return {success:true,data:{pid:process.pid}};
    if(req.method==='bridge_manifest')return {success:false,executed:false,code:'UNKNOWN_METHOD'};
    if(req.method==='windows')return mode==='timeout'?undefined:mode==='refusal'?{success:false,executed:false,code:'UI_BUSY'}:{success:true,data:{windows:[{isModal:true,type:42}]}};
    setTimeout(()=>{if(!socket.destroyed)socket.write('{"success":true,"data":{"done":true}}\n')},160);
  });
  try{const reply=await bridgeRequest({port:bridge.port,pid:process.pid},'publish',{}, {probeMs:20,probeTimeoutMs:40,timeoutMs:1000});assert.equal(reply.data.done,true);assert.equal(bridge.seen.filter(r=>r.method==='publish').length,1)}finally{await bridge.close()}
});
test('positive dead-pid checks end a call without waiting for a silent windows probe',async()=>{
  const bridge=await fakeBridge(req=>req.method==='ping'?{success:true,data:{pid:123456}}:req.method==='windows'?{success:true,data:{windows:[]}}:req.method==='bridge_manifest'?{success:true,data:{capabilities:[]}}:undefined);
  try{await assert.rejects(bridgeRequest({port:bridge.port,pid:123456},'publish',{}, {probeMs:20,probeTimeoutMs:50,timeoutMs:2000,alive:()=>false}),error=>error.code==='BRIDGE_STALLED' && error.stall.verdict==='studio-gone');assert.equal(bridge.seen.filter(r=>r.method==='publish').length,1)}finally{await bridge.close()}
});

test('a reused Studio identity is positive evidence only after two changed startedUtc probes',async()=>{
  let mainStarted=false;
  const bridge=await fakeBridge(req=>{
    if(req.method==='ping')return {success:true,data:{pid:process.pid,startedUtc:mainStarted?'new':'old'}};
    if(req.method==='windows')return {success:true,data:{windows:[]}};
    if(req.method==='bridge_manifest')return {success:true,data:{capabilities:[]}};
    mainStarted=true;return undefined;
  });
  try{await assert.rejects(bridgeRequest({port:bridge.port,pid:process.pid},'publish',{}, {probeMs:20,probeTimeoutMs:50,timeoutMs:2000}),error=>error.code==='BRIDGE_STALLED' && error.stall.verdict==='studio-gone');assert.equal(bridge.seen.filter(r=>r.method==='publish').length,1)}finally{await bridge.close()}
});

test('two refused/reset probe connections are positive bridge-gone evidence',async()=>{
  let mainStarted=false;
  const bridge=await fakeBridge((req,socket)=>{
    if(req.method==='ping')return {success:true,data:{pid:process.pid}};
    if(req.method==='bridge_manifest')return {success:true,data:{capabilities:[]}};
    if(req.method==='windows') {if(mainStarted){socket.resetAndDestroy();return undefined}return {success:true,data:{windows:[]}}}
    mainStarted=true;return undefined;
  });
  try{await assert.rejects(bridgeRequest({port:bridge.port,pid:process.pid},'publish',{}, {probeMs:20,probeTimeoutMs:50,timeoutMs:2000}),error=>error.code==='BRIDGE_STALLED' && error.stall.verdict==='bridge-gone');assert.equal(bridge.seen.filter(r=>r.method==='publish').length,1)}finally{await bridge.close()}
});
test('a deadline at the cadence never sends a pre-probe or periodic probe',async()=>{
  const bridge=await fakeBridge(()=>undefined);
  try{await assert.rejects(bridgeRequest({port:bridge.port},'open_module',{}, {probeMs:70,timeoutMs:70}),error=>error.code==='BRIDGE_TIMEOUT' && error.executed===undefined);assert.deepEqual(bridge.seen.map(r=>r.method),['open_module'])}finally{await bridge.close()}
});
test('a question retains the available exact text and asks the person before reconciliation',async()=>{
  const { o11Studio }=await import('../o11-studio.mjs');
  let visible=false;
  const question={type:'MessageBoxWindow',title:'Confirm overwrite',isVisible:true,isModal:true,texts:['Overwrite local edits?','[Button] Yes','[Button] No']};
  const bridge=await fakeBridge(req=>{
    if(req.method==='ping')return {success:true,data:{pid:process.pid}};
    if(req.method==='bridge_manifest')return {success:true,data:{capabilities:[]}};
    if(req.method==='windows')return {success:true,data:{windows:visible?[question]:[]}};
    visible=true;return undefined;
  });
  const client=o11Bridge({port:bridge.port,pid:process.pid});
  const wrapped={ok:(method,params,options)=>client.ok(method,params,{probeMs:10,probeTimeoutMs:50,timeoutMs:2000,...options})};
  try {
    const answer=await o11Studio({bridge:wrapped,assertSelected:async()=>{},inventory:async()=>null})({command:'open-module',args:{name:'TestModule'}});
    assert.equal(answer.code,'BRIDGE_STALLED');assert.equal(answer.recovery[0].arguments.command,'wait');
    assert.equal(answer.recovery[0].question,'Confirm overwrite | Overwrite local edits? | [Button] Yes | [Button] No');
    assert.equal(bridge.seen.filter(r=>r.method==='close_dialog').length,0);
  }finally{await bridge.close()}
});

for(const timestampKnown of [true,false]) test(`non-preprobe UI reads detect changed startedUtc (record timestamp ${timestampKnown?'known':'learned'})`,async()=>{
  let pings=0;
  const bridge=await fakeBridge(req=>{
    if(req.method==='ping')return {success:true,data:{pid:99999999,startedUtc:++pings===1 && !timestampKnown?'old':'new'}};
    if(req.method==='windows')return {success:true,data:{windows:[]}};
    return undefined;
  });
  try {
    await assert.rejects(bridgeRequest({port:bridge.port,pid:process.pid,record:timestampKnown?{startedUtc:'old'}:{}},'get_errors',{}, {probeMs:20,probeTimeoutMs:50,timeoutMs:2000}),error=>error.code==='BRIDGE_STALLED' && error.stall.verdict==='studio-gone' && error.stall.studio.pid===process.pid);
    assert.equal(bridge.seen.filter(r=>r.method==='get_errors').length,1);
    assert.equal(pings,timestampKnown?2:3);
    assert.equal(bridge.seen.filter(r=>r.method==='bridge_manifest').length,0);
  }finally{await bridge.close()}
});
