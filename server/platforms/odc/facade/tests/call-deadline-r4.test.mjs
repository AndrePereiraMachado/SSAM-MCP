// Review 4 of CX12 (C:\t\codex\cx12\revisao4\REVISAO.md): R4-1 (a queued write cancelled before dispatch never reserves
// its key), R4-2 (the live answer is the handler's; only the persisted copy and its replay are sanitized), R4-3 (the
// delivered confirmation answers the ORIGINAL call: publish:true without a proven publication is never ok:true) and R4-7
// (the confirmation never marks a record cancelled). Synthetic values only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createCallDeadline} from '../call-deadline.mjs';
import {readTask,tasksDir,mergeTask} from '../ssam-task.mjs';
import {canonicalArguments} from '../read-budget.mjs';
import {registerO11Cycle} from '../o11-cycle.mjs';
import {registerO11Access} from '../o11-access.mjs';
import {TargetPending} from '../service-center/errors.mjs';
import {inputInvalidAnswer} from '../tool-input.mjs';
import {WORDS_MARKER} from '../next-steps.mjs';
import {WORDS as ENGLISH_WORDS_MARKER} from '../continuations.mjs';
import {fakeAnvil} from './fixtures/fake-anvil.mjs';

const reply=v=>({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v,...(v.ok===false?{isError:true}:{})});
const value=a=>a?.structuredContent!==undefined?a.structuredContent:JSON.parse(a.content.find(c=>c.type==='text').text);
const textValue=a=>JSON.parse(a.content.find(c=>c.type==='text').text);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const box=(t,tag)=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx12-r4-'+tag+'-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
async function cancel(run,args){const c=new AbortController();const first=run(args,{mcpReq:{signal:c.signal}});await sleep(20);c.abort();await assert.rejects(first,e=>e.code==='CANCELLED');}
const records=root=>{try{return fs.readdirSync(tasksDir(root)).filter(n=>/^[0-9a-f-]{36}\.json$/i.test(n)).map(n=>readTask(n.slice(0,-5),{dir:tasksDir(root)}));}catch{return [];}};

// ---- R4-1
test('R4-1 a cancelled queued write (not-sent) never reserves its key after a restart: the first retry runs',async t=>{
  const root=box(t,'r41');let runs=0;
  const handler=async(_,ctx)=>{runs++;if(runs>1)return reply({ok:true,published:true});await new Promise(r=>ctx.mcpReq.signal.addEventListener('abort',r,{once:true}));return reply({ok:false,code:'CANCELLED',outcome:'not-sent'});};
  const first=createCallDeadline({root,timeoutMs:500}).wrap('o11_publish',handler);
  await cancel(first,{module:'Synthetic'});await sleep(10);
  const restarted=createCallDeadline({root,timeoutMs:500}).wrap('o11_publish',handler);
  const retry=value(await restarted({module:'Synthetic'}));
  assert.equal(retry.published,true,'nothing was sent, so the identical call is a new operation');assert.equal(runs,2);
  assert.notEqual(retry.code,'CANCELLED');
});
test('R4-1 control: a cancelled write that ran ok is delivered after a restart without running again',async t=>{
  const root=box(t,'r41c');let runs=0,release;const gate=new Promise(r=>release=r);
  const handler=async()=>{runs++;await gate;return reply({ok:true,version:7});};
  const first=createCallDeadline({root,timeoutMs:500}).wrap('o11_publish',handler);
  await cancel(first,{module:'Synthetic'});release();await sleep(10);
  const restarted=createCallDeadline({root,timeoutMs:500}).wrap('o11_publish',handler);
  assert.equal(value(await restarted({module:'Synthetic'})).version,7);assert.equal(runs,1,'the saved final is delivered, the write never runs twice');
});

// ---- R4-5
test('R4-5 a stale call index entry for a delivered write never refuses the identical call forever',async t=>{
  const root=box(t,'r45');const dir=tasksDir(root);let runs=0;
  const args={module:'Synthetic'},hash=createHash('sha256').update(canonicalArguments(args)).digest('hex');
  const id='0f0e0d0c-0b0a-4908-8706-050403020100';
  mergeTask(dir,{id,tool:'o11_publish',pid:process.pid,startedAt:new Date().toISOString(),state:'ok',call:{argsSha256:hash,lane:'o11'},isWrite:true,cancelled:false,deliveries:1,endedAt:new Date().toISOString(),callResult:{ok:true}});
  const index=path.join(dir,'.index','calls',createHash('sha256').update('o11_publish\0'+hash).digest('hex')+'.json');
  fs.mkdirSync(path.dirname(index),{recursive:true});fs.writeFileSync(index,JSON.stringify({id}));
  fs.writeFileSync(path.join(dir,'.index','version.json'),JSON.stringify({format:1}),'utf8'); // migrated already: only the guard can see the stale entry
  const run=createCallDeadline({root,timeoutMs:500}).wrap('o11_publish',async()=>{runs++;return reply({ok:true,version:9});});
  const answer=value(await run(args));
  assert.equal(answer.version,9,'the delivered record no longer holds the key');assert.equal(runs,1);
  assert.equal(fs.existsSync(index),false,'the stale entry is removed');
});

// ---- R4-2
function accessTool(root){
  const tools=new Map();
  registerO11Access({registerTool:(name,config,handler)=>tools.set(name,{config,handler})},
    {root,env:{},tasksDir:path.join(root,'.local','tasks'),runAnvil:async()=>{throw new Error('the kernel is never reached here');},assertSelected:()=>{},journal:()=>{},newOperationId:()=>'0'.repeat(32)});
  return tools.get('o11_access');
}
function shapes(root){
  const access=accessTool(root),manifestPath=path.join(root,'synthetic-manifest.json'),write={annotations:{readOnlyHint:false}};
  return [
    {name:'o11_access apply without words',tool:'o11_access',config:access.config,handler:access.handler,args:{action:'apply',manifestPath}},
    {name:'o11_access apply with the marker',tool:'o11_access',config:access.config,handler:access.handler,args:{action:'apply',manifestPath,words:WORDS_MARKER}},
    {name:'service center discard alternative',tool:'o11_service_center_write',config:write,handler:async()=>reply(new TargetPending({holder:'a'.repeat(32),host:'synthetic.example',receipt:{state:'uncertain',identity:{action:'delete',name:'SyntheticTimer'}}}).answer()),args:{action:'delete',host:'synthetic.example',timer:'SyntheticTimer'}},
    {name:'o11_data corrected request.authorization',tool:'o11_data',config:write,handler:async()=>inputInvalidAnswer('o11_data',[{path:'/request/entity',message:'synthetic'}],{request:{op:'insert',entity:'<entity>',authorization:WORDS_MARKER}},{fixed:true}),args:{request:{op:'insert'}}},
    {name:'o11_extension repeat.words and continuation words',tool:'o11_extension',config:write,handler:async()=>reply({ok:false,code:'WORDS_REQUIRED',error:'synthetic',repeat:{action:'publish',host:'h',specFile:'C:/x.json',words:"<the user's words naming SynthExt>"},continuation:{tool:'o11_extension',arguments:{action:'publish',host:'h',spec:'<this spec, changed>',words:"<the user's words naming SynthExt>"},why:'synthetic'}}),args:{action:'publish',host:'h',specFile:'C:/x.json'}},
    {name:'debugger needs.words and credentials.outcome',tool:'ssam_debug_run',config:write,handler:async()=>reply({ok:true,state:'prepared',needs:{loginWindow:false,words:true},credentials:{outcome:'not-requested'}}),args:{op:'prepare',target:'synthetic'}},
    {name:'delivery authorization field',tool:'studio_deliver',config:write,handler:async()=>reply({ok:true,result:'delivered',authorization:{kind:'standing-grant',grant:'synthetic-grant-id'}}),args:{module:'Synth',job:'C:/j.json'}},
    {name:'o11_deliver authorize marker',tool:'o11_deliver',config:write,handler:async()=>reply({ok:false,code:'WORDS_REQUIRED',continuation:{tool:'o11_deliver',arguments:{module:'M',authorize:WORDS_MARKER}}}),args:{module:'M'}},
  ];
}
test('R4-2 the live answer of every served tool is the handler answer (8 shapes)',async t=>{
  const root=box(t,'r42');const deadline=createCallDeadline({root,timeoutMs:5000,env:{}});
  for(const shape of shapes(root)){
    const direct=await shape.handler(shape.args,{});
    const live=await deadline.wrap(shape.tool,shape.handler,shape.config)(shape.args,{mcpReq:{signal:new AbortController().signal}});
    assert.deepEqual(value(live),value(direct),shape.name+': structured answer');
    assert.deepEqual(textValue(live),textValue(direct),shape.name+': text answer');
  }
});
test('R4-2 the persisted copy and its replay keep public markers for every words key and never a secret',async t=>{
  const root=box(t,'r42p');const SECRET='SYNTHETIC-SECRET-WORDS-0042';let release;const gate=new Promise(r=>release=r);
  const answer={ok:false,code:'WORDS_REQUIRED',words:SECRET,authorization:SECRET,repeat:{words:"<the user's words naming SynthExt>"},
    continuation:{tool:'o11_access',arguments:{action:'apply',words:WORDS_MARKER,authorize:ENGLISH_WORDS_MARKER,request:{op:'insert',authorization:WORDS_MARKER}}},
    nested:{credentials:{password:SECRET},authorize:SECRET,token:'<not a marker for a token>'}};
  const handler=async()=>{await gate;return reply(answer);};
  const first=createCallDeadline({root,timeoutMs:50,env:{}});const run=first.wrap('o11_access',handler,{annotations:{readOnlyHint:false}});
  const running=value(await run({action:'apply'},{mcpReq:{signal:new AbortController().signal}}));assert.equal(running.state,'running');
  release();await sleep(20);
  const live=value(await run({continueTask:running.task.id},{mcpReq:{signal:new AbortController().signal}}));
  assert.deepEqual(live,answer,'the live continuation of this process is the handler answer');
  const [task]=records(root);assert.ok(task.answer?.file,'the final answer is persisted');
  const disk=fs.readFileSync(task.answer.file,'utf8');assert.doesNotMatch(disk,new RegExp(SECRET));
  assert.doesNotMatch(fs.readFileSync(path.join(tasksDir(root),task.id+'.json'),'utf8'),new RegExp(SECRET+'|'+WORDS_MARKER.replace(/[<>]/g,'.')),'the record keeps the strict scrub');
  const replay=value(await createCallDeadline({root,timeoutMs:500,env:{}}).wrap('o11_access',handler,{annotations:{readOnlyHint:false}})({continueTask:task.id},{mcpReq:{signal:new AbortController().signal}}));
  assert.deepEqual(replay.continuation.arguments,answer.continuation.arguments,'markers survive in the replayed continuation');
  assert.equal(replay.repeat.words,answer.repeat.words);
  for(const key of ['words','authorization'])assert.equal(Object.hasOwn(replay,key),false,key+' with a secret value never reaches the copy');
  assert.equal(Object.hasOwn(replay.nested,'authorize'),false);assert.equal(Object.hasOwn(replay.nested,'credentials'),false);
  assert.equal(Object.hasOwn(replay.nested,'token'),false,'only words keys accept a marker');
  assert.doesNotMatch(JSON.stringify(replay),new RegExp(SECRET));
});

// ---- R4-3 and R4-7
const KID='5e6f708192a3b4c5d6e7f8091a2b3c4d';
function cycle(t,{resumePublishes=false}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'cx12-r4-publish-')),root=path.join(base,'anvil'),auth=path.join(base,'authority'),home=path.join(base,'home');
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  for(const dir of [root,auth,home])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(auth,'bridge.key'),'SYNTHETIC');
  const env={USERPROFILE:home,HOME:home,APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),ANVIL_AUTHORITY_DIR:auth,ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1',ANVIL_LANE:'ss4'};
  fs.mkdirSync(path.join(root,'.local','connections'),{recursive:true});
  fs.writeFileSync(path.join(root,'.local','connections','ss4.json'),JSON.stringify({ok:true,lane:'o11',anvilLane:'ss4',pid:4243,port:45997,studioDir:path.join(base,'Studio'),authorityDir:auth}));
  const work=path.join(root,'.local','work'),job=path.join(base,'synthetic-job.json');
  fs.writeFileSync(job,JSON.stringify({ops:[{op:'get',target:'ServerAction:Synthetic'}]}));
  const kernel=state=>{const dir=path.join(work,'deliver',KID);fs.mkdirSync(dir,{recursive:true});
    const payload=JSON.stringify({taskId:KID,module:'SyntheticInvoices',updatedAt:new Date().toISOString(),request:{JobPath:job},...state});
    fs.writeFileSync(path.join(dir,'task.json'),JSON.stringify({format:1,sha256:createHash('sha256').update(payload).digest('hex'),payload}));};
  const counts={fresh:0,resumes:0,publishes:0};
  const runAnvil=fakeAnvil({deliver:args=>{
    if(args[1]==='--resume'){counts.resumes++;const state={writeState:'applied',delivered:true,validation:{newErrors:0}};kernel(state);return {ok:true,command:'deliver',data:{taskId:KID,module:'SyntheticInvoices',...state}};}
    counts.fresh++;const state={writeState:'unknown',delivered:false,stage:'merge',error:'Synthetic merge outcome unknown'};kernel(state);
    return {ok:false,command:'deliver',data:{taskId:KID,module:'SyntheticInvoices',...state}};
  }});
  const publish=async()=>{counts.publishes++;return {ok:true,version:8};};
  function server(){
    const deadline=createCallDeadline({root,timeoutMs:3000,env:{}}),tools=new Map();
    registerO11Cycle({registerTool(name,config,handler){tools.set(name,{config,run:deadline.wrap(name,handler,config)});}},
      {root,env,lane:'ss4',runAnvil,publish,assertSelected:async()=>{},grantsFile:path.join(base,'synthetic-grants.json'),lastPublication:async()=>({at:'2026-10-01T09:00:00.000Z',version:7}),
        bridge:{ok:async()=>{throw Error('No bridge is used by this synthetic runner');}}});
    return async(name,args)=>{const {config,run}=tools.get(name),checked=await config.inputSchema['~standard'].validate(args);
      assert.equal(checked.issues,undefined,'synthetic inputs satisfy the registered schema');
      return value(await run(checked.value,{mcpReq:{signal:new AbortController().signal,notify:async()=>{}}}));};
  }
  return {root,counts,server,original:{module:'SyntheticInvoices',job,publish:true,authorize:'synthetic-confirmation'},resumePublishes};
}
for(const mode of ['live','reloaded'])test(`R4-3 the delivered confirmation of a publish:true call never claims a publication the resume did not prove (${mode})`,async t=>{
  const b=cycle(t);let call=b.server();const seen=[];
  const initial=await call('o11_deliver',b.original);seen.push(initial);
  assert.equal(initial.outcome,'uncertain');assert.deepEqual(initial.publish,{requested:true,outcome:'skipped'});
  const before=await call('o11_deliver',b.original);seen.push(before);assert.equal(before.continuation.arguments.resume,KID);
  const resumed=await call('o11_deliver',{resume:KID,authorize:'synthetic-confirmation'});assert.equal(resumed.result,'delivered');
  if(mode==='reloaded')call=b.server();
  const after=await call('o11_deliver',b.original);seen.push(after);
  assert.equal(after.ok,false,'the original call asked for a publication that never ran');
  assert.equal(after.result,'delivered');assert.equal(after.failed,'publish');
  assert.deepEqual(after.publish,{requested:true,outcome:'skipped'});
  assert.deepEqual(after.continuation?.tool,'o11_publish');
  assert.deepEqual(after.continuation?.arguments,{module:'SyntheticInvoices',authorize:WORDS_MARKER});
  assert.equal(Object.hasOwn(after,'lastPublication'),false,'the previous publication is never offered as if it were this one');
  assert.deepEqual(after.previousPublication,{at:'2026-10-01T09:00:00.000Z',version:7});
  assert.equal(b.counts.publishes,0);assert.equal(b.counts.fresh,1,'the delivery never runs twice');
  assert.ok(seen.every(answer=>answer.ok!==true),'no answer to the publish:true call says ok:true');
  const record=records(b.root).find(task=>task.reconciledOutcome==='delivered');
  assert.ok(record);assert.notEqual(record.cancelled,true,'R4-7: the confirmation never marks a call cancelled');
  assert.equal(record.confirmation,'delivered');
});
test('R4-3 control: a confirmation of a call without publish stays ok:true and offers lastPublication',async t=>{
  const b=cycle(t);const call=b.server();const original={...b.original};delete original.publish;
  await call('o11_deliver',original);await call('o11_deliver',{resume:KID,authorize:'synthetic-confirmation'});
  const after=await call('o11_deliver',original);
  assert.equal(after.ok,true);assert.equal(after.code,'TASK_DELIVERED');assert.equal(after.result,'delivered');
  assert.deepEqual(after.lastPublication,{at:'2026-10-01T09:00:00.000Z',version:7});assert.equal(b.counts.publishes,0);
});
