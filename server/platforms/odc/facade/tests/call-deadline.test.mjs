import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createCallDeadline, callDeadlineMs } from '../call-deadline.mjs';
import { createSsamServer } from '../ssam.mjs';
import { trackTask, readTask, tasksDir, mergeTask } from '../ssam-task.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = value => ({ content: [{type:'text', text:JSON.stringify(value)}], structuredContent:value });
const value = result => result.structuredContent;
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-deadline-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return { root, deadline:createCallDeadline({root, timeoutMs:200, ...options}) };
}
async function finish(run, result, seen = []) {
  while (value(result)?.state === 'running') { seen.push(result); result = await run(value(result).continuation.arguments); }
  return result;
}
for (const factor of [0.5,1.5,3.4,9.5]) test(`one deadline, factor ${factor}, exact final result and one execution`, async t => {
  const {root,deadline} = setup(t); let calls=0;
  const expected=text({ok:true, payload:'same'});
  const run=deadline.wrap('o11_publish', async () => { calls++; await sleep(200*factor); return expected; });
  const timed = async args => { const start=performance.now(); const result=await run(args); assert.ok(performance.now()-start <=250); return result; };
  const waits=[]; const result=await finish(timed, await timed({module:'M',lane:'o11'}), waits);
  assert.deepEqual(result, expected); assert.equal(calls,1); assert.equal(waits.length,Math.ceil(factor)-1);
  for (const response of waits) { const v=value(response); assert.ok(Buffer.byteLength(JSON.stringify(v))<=512); assert.equal(v.ok,undefined); assert.equal(response.isError,undefined); assert.equal(v.continuation.tool,'o11_publish'); assert.equal(v.continuation.arguments.lane,'o11'); }
  assert.equal(fs.existsSync(tasksDir(root)),factor>1);
  if (waits.length) assert.deepEqual(await run(value(waits[0]).continuation.arguments),expected);
});
test('environment deadline is capped and clamps below minimum', () => {
  assert.equal(callDeadlineMs({}),25000); assert.equal(callDeadlineMs({SSAM_CALL_DEADLINE_MS:'500'}),1000);
  assert.equal(callDeadlineMs({SSAM_CALL_DEADLINE_MS:'90000'}),25000); assert.equal(callDeadlineMs({SSAM_CALL_DEADLINE_MS:'bad'}),25000);
});
test('joins running calls, resumes undelivered final, then allows a fresh operation', async t => {
  const {deadline}=setup(t); let calls=0;
  const run=deadline.wrap('studio_deliver',async () => { calls++; await sleep(350); return text({ok:true,result:'delivered'}); });
  const first=await run({feature:'M'}); const joined=await run({feature:'M'});
  assert.equal(value(joined).joined,true); assert.equal(calls,1);
  // A separate operation finishes detached, without a continuation delivery.
  const second=await run({feature:'N'}); await sleep(180);
  const resumed=await run({feature:'N'}); assert.equal(value(resumed).resumedFrom,value(second).task.id);
  await finish(run,await run({feature:'N'})); assert.equal(calls,3);
  assert.deepEqual(await run(value(first).continuation.arguments),text({ok:true,result:'delivered'}));
});
test('continuations refuse all extras, unknown ids, mismatches and orphaned writes', async t => {
  const {root,deadline}=setup(t);
  const run=deadline.wrap('o11_publish',async () => { await sleep(400); return text({ok:true}); });
  const first=await run({module:'M',lane:'o11'}), id=value(first).task.id;
  const bad=value(await run({continueTask:id,module:'M',extra:1})); assert.equal(bad.code,'INPUT_INVALID'); assert.equal(bad.violations.length,2);
  assert.equal(value(await run({continueTask:randomUUID()})).code,'TASK_NOT_FOUND');
  const other=deadline.wrap('studio_status',()=>{throw Error('never')}); assert.equal(value(await other({continueTask:id})).code,'TASK_TOOL_MISMATCH');
  const orphan=randomUUID(); mergeTask(tasksDir(root),{id:orphan,tool:'o11_publish',state:'running',pid:2147483646,isWrite:true,call:{lane:'o11'}});
  assert.equal(value(await run({continueTask:orphan})).outcome,'uncertain');
  await finish(run,first);
});
test('cross-server final answer is exact; cancellation of a continuation leaves work running', async t => {
  const {root,deadline}=setup(t); let calls=0;
  const run=deadline.wrap('studio_deliver',async (_,ctx) => { calls++; await sleep(500); assert.equal(ctx.mcpReq.signal.aborted,false); return text({ok:true,payload:42}); });
  const first=await run({feature:'M'},{mcpReq:{signal:new AbortController().signal}});
  const controller=new AbortController(); const waiting=run(value(first).continuation.arguments,{mcpReq:{signal:controller.signal}});
  controller.abort(); await assert.rejects(waiting); await sleep(320);
  const other=createCallDeadline({root,timeoutMs:200}).wrap('studio_deliver',()=>{throw Error('never')});
  assert.deepEqual(await other(value(first).continuation.arguments),text({ok:true,payload:42})); assert.equal(calls,1);
});
test('trackTask inherits one id, retains kernel result, and links later cascade records', async t => {
  const {root,deadline}=setup(t); const dir=tasksDir(root);
  const run=deadline.wrap('o11_publish',async () => {
    await trackTask({tool:'o11_publish',dir,summary:{authorize:'secret'}},async () => {await sleep(250); return {ok:true,taskId:'a'.repeat(32)};});
    await trackTask({tool:'o11_publish',dir},async () => ({ok:true}));
    return text({ok:true});
  });
  const first=await run({module:'M',lane:'o11'}); await finish(run,first);
  const records=fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8')));
  assert.equal(records.length,2); const parent=records.find(r=>r.id===value(first).task.id);
  assert.equal(parent.result.taskId,'a'.repeat(32)); assert.equal(parent.call.lane,'o11'); assert.equal(records.find(r=>r.id!==parent.id).callTask,parent.id);
  assert.doesNotMatch(JSON.stringify(records),/secret/);
});
test('exceptions persist once; propose and input_required retain their open request', async t => {
  const {deadline}=setup(t);
  const fail=deadline.wrap('studio_status',async ()=>{await sleep(250);throw Error('boom');});
  const first=await fail({}); const final=await finish(fail,first); assert.equal(final.isError,true); assert.equal(value(final).error,'boom'); assert.deepEqual(await fail(value(first).continuation.arguments),final);
  const expected={resultType:'input_required'}; const propose=deadline.wrap('propose',async()=>{await sleep(250); return expected;},{exempt:true}); assert.deepEqual(await propose({}),expected);
  assert.deepEqual(await deadline.wrap('input',async()=>expected)({}),expected);
});
test('detached child count is sent only to launcher-enabled children and progress stops after detachment', async t => {
  const notifications=[], progress=[];
  const {deadline}=setup(t,{env:{SSAM_RELAY_CHILD:'1'},notify:n=>notifications.push(n)});
  const run=deadline.wrap('studio_status',async(_,ctx)=>{for(let i=0;i<3;i++){await sleep(100);await ctx.mcpReq.notify({i});} return text({ok:true});});
  const first=await run({},{mcpReq:{notify:n=>{progress.push(n);return Promise.resolve();}}}); await finish(run,first);
  assert.deepEqual(notifications.map(n=>n.params.running),[1,0]); assert.ok(progress.length<=1);
  const silent=[]; const quiet=setup(t,{env:{},notify:n=>silent.push(n)}).deadline.wrap('quiet',async()=>{await sleep(250);return text({ok:true});}); await finish(quiet,await quiet({})); assert.deepEqual(silent,[]);
});
test('MCP ODC proxy and a tool registered afterwards both use the deadline; continuations bypass release and write queue', async t => {
  const root=setup(t).root; let calls=0, locks=0, changed=false;
  const identity={root,release:{head:'a',facadeSha256:'a',catalogSha256:'a'}};
  const server=await createSsamServer({o11:false,odc:true,deps:{answersRoot:root,callDeadlineMs:200,identity:{read:()=>({root,release:{head:"a",facadeSha256:"a",catalogSha256:"a"}})},identity:{read:()=>changed?{...identity,release:{...identity.release,facadeSha256:'b'}}:identity,cacheMs:0},
    writeLock:async(_,fn)=>{locks++;return fn();},lock:{o11Root:root,odcRoot:root,connection:()=>null},odcRoot:root,
    odcFacade:async()=>{const s=new McpServer({name:'fake',version:'1'});s.registerTool('studio_deliver',{inputSchema:z.object({feature:z.string()})},async()=>{calls++;await sleep(450);return text({ok:true,result:'delivered'});});return s;}}});
  server.registerTool('local_probe',{inputSchema:z.object({delay:z.number(),lane:z.string().optional()})},async args=>{await sleep(args.delay);return text({ok:true});});
  const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'test',version:'1'});await Promise.all([server.connect(a),client.connect(b)]);
  t.after(async()=>{await client.close();await server.close();});
  const listed=(await client.listTools()).tools; assert.equal(listed.find(t=>t.name==='studio_deliver').inputSchema.properties.continueTask.type,'string'); assert.deepEqual(listed.find(t=>t.name==='studio_deliver').inputSchema.required,['feature']);
  const run=args=>client.callTool({name:'studio_deliver',arguments:args});const first=await run({feature:'M'});const before=locks;changed=true;
  const final=await finish(run,first); assert.equal(value(final).ok,true);assert.equal(calls,1);assert.equal(locks,before);
});
test('local O11, shared lane, ssam_job and nested ssam_code write all leave through one deadline', async t => {
  const root=setup(t).root; const counts=new Map(); let delay=100;
  const record=async name=>{counts.set(name,(counts.get(name)??0)+1);await sleep(delay);return text({ok:true,result:'delivered',payload:'same'});};
  const server=await createSsamServer({o11:false,odc:true,deps:{answersRoot:root,callDeadlineMs:200,identity:{read:()=>({root,release:{head:"a",facadeSha256:"a",catalogSha256:"a"}})},
    writeLock:async(_,fn)=>fn(),lock:{o11Root:root,odcRoot:root,connection:()=>null},odcRoot:root,
    jobTool:async()=>value(await record('ssam_job')),
    odcFacade:async()=>{const s=new McpServer({name:'fake',version:'1'});s.registerTool('studio_deliver',{inputSchema:z.object({feature:z.string(),module:z.string().optional(),job:z.string().optional(),owners:z.array(z.string()).optional(),changes:z.array(z.string()).optional(),until:z.string().optional(),publish:z.boolean().optional(),authorize:z.string().optional()}).strict()},()=>record('studio_deliver'));return s;}}});
  server.registerTool('o11_deliver',{inputSchema:z.object({module:z.string()})},()=>record('o11_deliver'));
  server.registerTool('shared_probe',{inputSchema:z.object({lane:z.string()})},()=>record('shared_probe'));
  const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'test',version:'1'});await Promise.all([server.connect(a),client.connect(b)]);
  t.after(async()=>{await client.close();await server.close();});
  const cases=[['o11_deliver',{module:'M'},'o11_deliver'],['shared_probe',{lane:'odc'},'shared_probe'],['ssam_job',{lane:'odc',job:{ops:[]}},'ssam_job'],['ssam_code',{lane:'odc',action:'write',part:'ddl',module:'M',text:'create entity A (Id Long Integer identifier auto required);'},'studio_deliver']];
  for(const [name,args,counter] of cases){
    delay=100;const expected=await client.callTool({name,arguments:args}); assert.ok(counts.get(counter),JSON.stringify(expected));
    for(const factor of [1.5,3.4,10]){
      delay=200*factor;const before=counts.get(counter)??0,waits=[];
      const run=async input=>{const began=performance.now();const result=await client.callTool({name,arguments:input});assert.ok(performance.now()-began<=250,`${name} window`);return result;};
      const actual=await finish(run,await run(args),waits);
      // Each distinct ssam_code invocation writes a new UUID job file; compare its hash and all content,
      // then verify the saved envelope of THIS invocation without normalizing its path.
      const comparable=structuredClone(expected);
      if(name==='ssam_code'){assert.equal(value(actual).nextBasedOn.sha256,value(expected).nextBasedOn.sha256);comparable.structuredContent.nextBasedOn.job=value(actual).nextBasedOn.job;comparable.content[0].text=JSON.stringify(comparable.structuredContent);assert.deepEqual(await run(value(waits[0]).continuation.arguments),actual);}
      assert.deepEqual(actual,comparable,`${name} result`);assert.equal((counts.get(counter)??0)-before,1,`${name} invocation`);assert.equal(waits.length,Math.ceil(factor)-1,`${name} continuations`);
    }
  }
});
test('a continuation waits on a live task from another pid and never starts a handler', async t => {
  const {root,deadline}=setup(t); const id=randomUUID();const dir=tasksDir(root);
  mergeTask(dir,{id,tool:'studio_status',pid:process.ppid,state:'running',startedAt:new Date().toISOString(),call:{lane:'odc'}});
  const expected=text({ok:true,read:'other pid'});
  const {keepAnswer}=await import('../answer-size.mjs');
  const timer=setTimeout(()=>mergeTask(dir,{id,state:'ok',answer:keepAnswer(expected,root)}),100);t.after(()=>clearTimeout(timer));
  const run=deadline.wrap('studio_status',()=>{throw Error('never re-executed');});
  assert.deepEqual(await finish(run,await run({continueTask:id,lane:'odc'})),expected);
});
test('cancelling before detachment forwards cancellation to the original handler', async t => {
  const {deadline}=setup(t);let cancelled=false;
  const run=deadline.wrap('studio_status',async(_,ctx)=>{await new Promise(resolve=>ctx.mcpReq.signal.addEventListener('abort',resolve,{once:true}));cancelled=true;return text({ok:false,code:'CANCELLED'});});
  const controller=new AbortController();const pending=run({},{mcpReq:{signal:controller.signal}});await sleep(20);controller.abort();
  await assert.rejects(pending);await sleep(0);assert.equal(cancelled,true);
});
test('the real o11_publish registration detaches a fake bridge publication once and keeps its task record', async t => {
  const {root,deadline}=setup(t);
  const {registerO11Publish}=await import('../o11-publish.mjs');
  const {o11Bridge}=await import('../o11-bridge.mjs');
  const {fakeBridge}=await import('./fixtures/fake-o11-bridge.mjs');
  const {continuationInput}=await import('../tool-input.mjs');
  const ok=data=>({success:true,data,error:null});let publications=0;
  const fake=await fakeBridge(async request=>{
    if(request.method==='open_module')return ok({name:'Orders',opened:true,alreadyOpen:true,selected:true,elapsedMs:0});
    if(request.method==='get_active_module')return ok({name:'Orders',key:'k-orders',kind:'Web',environment:'dev.example.com',isModified:false,pendingDialogs:[]});
    if(request.method==='get_errors')return ok({isValid:true,errors:0,warnings:0,total:0,messages:[],rawMessages:[]});
    if(request.method==='publish'){publications++;await sleep(500);return ok({module:'Orders',published:true,lastUploadDateTime:'2026-10-02T10:00:00',state:'CompletedWithSuccessNotOpenedInBrowser',isValid:true,elapsedMs:500});}
    return {success:false,data:null,error:'Unknown fake method '+request.method};
  });
  const server=new McpServer({name:'publish-deadline',version:'1'});const register=server.registerTool.bind(server);
  server.registerTool=(name,config,handler)=>register(name,continuationInput(config),deadline.wrap(name,handler));
  registerO11Publish(server,{root,env:process.env,lane:'ss4',bridge:o11Bridge({port:fake.port,authorization:'fake'}),assertSelected:async()=>{}});
  const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'test',version:'1'});await Promise.all([server.connect(a),client.connect(b)]);
  t.after(async()=>{await client.close();await server.close();await fake.close();});
  const run=async args=>{const began=performance.now();const reply=await client.callTool({name:'o11_publish',arguments:args});assert.ok(performance.now()-began<=250);return reply;};
  const first=await run({module:'Orders',authorize:'publish Orders in the fake test'});const final=await finish(run,first);
  assert.equal(value(first).state,'running');assert.equal(value(final).ok,true);assert.equal(publications,1);assert.deepEqual(await run(value(first).continuation.arguments),final);
  const records=fs.readdirSync(tasksDir(root)).filter(n=>n.endsWith('.json'));assert.equal(records.length,1);assert.equal(records[0],value(first).task.id+'.json');
});
test('tools without an input schema retain their context and strict output on a continuation', async t => {
  const root=setup(t).root;let calls=0;
  const server=await createSsamServer({o11:false,odc:false,deps:{answersRoot:root,callDeadlineMs:200,identity:{read:()=>({root,release:{head:'a',facadeSha256:'a',catalogSha256:'a'}})}}});
  server.registerTool('context_only',{outputSchema:z.object({result:z.number()}).strict()},async ctx=>{calls++;assert.ok(ctx.mcpReq.signal instanceof AbortSignal);await sleep(300);return text({result:1});});
  const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'test',version:'1'});await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
  const run=args=>client.callTool({name:'context_only',arguments:args});const first=await run({});const final=await finish(run,first);assert.deepEqual(value(final),{result:1});assert.equal(calls,1);assert.equal(readTask(value(first).task.id,{dir:tasksDir(root)}).state,'ok');
});
test('joining native media preserves its content and puts delivery metadata alongside it', async t => {
  const {deadline}=setup(t);const original={content:[{type:'image',data:'AA==',mimeType:'image/png'}]};let calls=0;
  const run=deadline.wrap('native_media',async()=>{calls++;await sleep(300);return original;});
  const first=await run({});const joined=await run({});assert.equal(joined._meta.joined,true);assert.deepEqual(joined.content[0],original.content[0]);assert.equal(joined.content[1].text,'{"joined":true}');assert.equal(calls,1);assert.deepEqual(await run(value(first).continuation.arguments),original);
});

test('elicitation exemption follows registration metadata regardless of tool name', async t => {
  const root=setup(t).root;
  const server=await createSsamServer({o11:false,odc:false,deps:{answersRoot:root,callDeadlineMs:200,identity:{read:()=>({root,release:{head:'a',facadeSha256:'a',catalogSha256:'a'}})}}});
  const config={inputSchema:z.object({})};
  server.registerTool('declared_elicitation',{...config,_meta:{canRequestInput:true}},async()=>{await sleep(300);return text({ok:true});});
  server.registerTool('propose',config,async()=>{await sleep(300);return text({ok:true});});
  const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'test',version:'1'});await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
  assert.deepEqual(value(await client.callTool({name:'declared_elicitation',arguments:{}})),{ok:true});
  const first=await client.callTool({name:'propose',arguments:{}});assert.equal(value(first).state,'running');
  assert.deepEqual(value(await client.callTool({name:'propose',arguments:value(first).continuation.arguments})),{ok:true});
});

test('trackers in another directory keep it and link their own id before the matching tracker inherits', async t => {
  const {root,deadline}=setup(t);const dir=tasksDir(root),other=path.join(root,'module-tasks');
  const run=deadline.wrap('o11_publish',async()=>{
    await trackTask({tool:'o11_publish',dir:other},async()=>({ok:true}));
    await trackTask({tool:'o11_publish',dir},async()=>{await sleep(300);return {ok:true,taskId:'b'.repeat(32)};});
    return text({ok:true});
  });
  const first=await run({lane:'o11'});await finish(run,first);
  const parent=value(first).task.id;
  const external=fs.readdirSync(other).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(other,n),'utf8')));
  assert.equal(external.length,1);assert.notEqual(external[0].id,parent);assert.equal(external[0].callTask,parent);
  const own=readTask(parent,{dir});assert.equal(own.result.taskId,'b'.repeat(32));assert.equal(own.callTask,undefined);
  assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.json')).length,1);
});
