import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createStore, digest, outcomeOf, operationName, recordEvent, frictionDirectory, STEPS } from '../facade/friction-store.mjs';
import { captureJson, lineChannel, observeMcp, observeCli, boundaryMetadata } from '../facade/friction-boundary.mjs';
import { main } from '../facade/friction-cli.mjs';

// Every test below names its own queue folder; an isolation folder inherited from the caller would merge them.
delete process.env.SSAM_FRICTION_DIR;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/friction-css-author.json'),'utf8'));
const version='a'.repeat(64);
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-friction-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const setup=t=>{const directory=temp(t);return {directory,store:createStore({directory,warning:()=>{}})};};
const begin=store=>store.begin({operation:'deliver',lane:'odc',interface:'cli',taskId:'task-css',toolingSha256:version});

test('CSS failure creates deduplicated issue without storing payload/error/tenant',t=>{
  const {store,directory}=setup(t);
  const input={...fixture,module:'secret-module',snapshot:{host:'private.example'},password:'secret-password',error:fixture.error+' secret-password'};
  begin(store).finish(input);begin(store).finish(input);
  const queue=store.issues();assert.equal(queue.total,1);assert.equal(queue.issues[0].count,2);
  assert.equal(queue.issues[0].code,'SNAPSHOT_AUTHOR_MISSING');assert.equal(queue.issues[0].state.status,'new');
  const files=fs.readdirSync(path.join(directory,'operations')).map(f=>fs.readFileSync(path.join(directory,'operations',f),'utf8')).join();
  assert.doesNotMatch(files,/secret|private|No change|snapshot developerId/);
  // C33 (atritos 3): an issue names its two last operations by id; the operations themselves come from snapshot().
  assert.equal(store.snapshot().operations.find(e=>e.operationId===queue.issues[0].lastOperationIds[0]).selectedPackageId,null);
});
test('successful transport is not semantic success and result wrappers are decoded',()=>{
  assert.equal(outcomeOf(null,{exitCode:0}).outcome,'unknown');
  assert.equal(outcomeOf({ok:true},{exitCode:1}).outcome,'failure');
  assert.equal(outcomeOf({result:{content:[{type:'text',text:JSON.stringify(fixture)}]}}).code,'SNAPSHOT_AUTHOR_MISSING');
  assert.equal(outcomeOf({result:{structuredContent:{ok:false,error:'request timed out'}}}).outcome,'timeout');
  assert.equal(outcomeOf({ok:true},{interrupted:true}).outcome,'uncertain');
});
test('the 25 s hand-off of a long call is a continuation, not an unobserved result',()=>{
  // call-deadline.mjs running(): no ok, the work goes on, the continuation call records the end (goal list of 2026-10-20, item 1).
  const handOff={state:'running',task:{id:'0123456789abcdef',tool:'o11_deliver',elapsedMs:25002},continuation:{tool:'o11_deliver',arguments:{continueTask:'0123456789abcdef',lane:'o11'},why:'…'}};
  assert.deepEqual([outcomeOf(handOff).outcome,outcomeOf(handOff).code],['success','CONTINUED']);
  const wrapped=outcomeOf({content:[{type:'text',text:JSON.stringify(handOff)}],structuredContent:handOff});
  assert.deepEqual([wrapped.outcome,wrapped.code],['success','CONTINUED']);
  // A running answer that names no continuation is still unobserved; a continuation that ended in failure is a failure.
  assert.equal(outcomeOf({state:'running',task:{id:'x'}}).code,'RESULT_UNOBSERVED');
  assert.equal(outcomeOf({ok:false,code:'PREFLIGHT_REFUSED',task:{id:'x'},continuation:{tool:'o11_deliver',arguments:{continueTask:'x'}}}).code,'PREFLIGHT_REFUSED');
});
test('incomplete starts, corrupt and partial files are visible; completion is idempotent',t=>{
  const {store,directory}=setup(t);begin(store);
  const op=begin(store);op.finish({ok:true});op.finish(fixture);
  fs.writeFileSync(path.join(directory,'operations','broken.json'),'{');
  fs.writeFileSync(path.join(directory,'operations','.crash.tmp'),'{');
  const state=store.snapshot();assert.equal(state.operations.length,2);
  assert.equal(state.operations.filter(e=>e.outcome==='incomplete').length,1);
  assert.equal(state.health.damagedRecords,1);assert.equal(state.health.partialRecords,1);
});
test('write failures are reported and never replace operation result',t=>{
  const directory=path.join(temp(t),'file');fs.writeFileSync(directory,'occupied');
  const warnings=[];const store=createStore({directory,warning:code=>warnings.push(code)});
  assert.doesNotThrow(()=>begin(store).finish(fixture));
  assert.deepEqual(warnings,['RECORD_WRITE_FAILED','RECORD_WRITE_FAILED']);
});
test('task correlation is explicit and uncorrelated calls remain separate',t=>{
  const {store}=setup(t);begin(store).finish({ok:true});store.begin({operation:'inspect'}).finish({ok:true});
  assert.equal(store.task({taskId:'task-css'}).operationCount,1);
  assert.equal(store.snapshot().operations.find(e=>e.operation==='inspect').correlation,'absent');
  assert.throws(()=>store.task(),/Explicit task/);
});
test('overlapping tasks use interval union; gaps are not called reasoning time',t=>{
  const directory=temp(t);let now=10000;const store=createStore({directory,clock:()=>now,warning:()=>{}});
  const a=begin(store);now=10010;const b=begin(store);now=10030;a.finish({ok:true});now=10040;b.finish({ok:true});
  now=10060;const c=begin(store);now=10080;c.finish({ok:true});
  const report=store.task({taskId:'task-css'});
  assert.equal(report.toolCoveredWallMs,60);assert.equal(report.observedSpanMs,80);assert.equal(report.intervalOutsideCompletedToolsMs,20);
});
test('verified state requires correction proof and later matching version, then recurrence reopens',t=>{
  const directory=temp(t);let now=1000;const store=createStore({directory,clock:()=>now,warning:()=>{}});
  begin(store).finish(fixture);const issue=store.issues().issues[0];
  assert.throws(()=>store.transition({issueId:issue.id,status:'verified'}),/transition/);
  const investigating=store.transition({issueId:issue.id,status:'investigating'});
  assert.throws(()=>store.transition({issueId:issue.id,status:'corrected',expectedRevision:investigating.state.revision}),/evidence hash/);
  now=2000;const corrected=store.transition({issueId:issue.id,status:'corrected',expectedRevision:investigating.state.revision,proof:{sha256:'b'.repeat(64),versionSha256:version}});
  assert.throws(()=>store.transition({issueId:issue.id,status:'verified',expectedRevision:corrected.state.revision,proof:{sha256:'b'.repeat(64),versionSha256:version}}),/later successful/);
  now=3000;const success=begin(store);success.finish({ok:true});
  assert.throws(()=>store.transition({issueId:issue.id,status:'verified',expectedRevision:corrected.state.revision,proof:{sha256:'b'.repeat(64),versionSha256:'c'.repeat(64),operationId:success.operationId}}),/version differs/);
  now=4000;store.transition({issueId:issue.id,status:'verified',expectedRevision:corrected.state.revision,proof:{sha256:'b'.repeat(64),versionSha256:version,operationId:success.operationId}});
  assert.equal(store.issues().issues[0].state.status,'verified');
  now=5000;begin(store).finish(fixture);assert.equal(store.issues().issues[0].state.status,'new');
});
test('concurrent state forks are surfaced as conflicts',t=>{
  const {store,directory}=setup(t);begin(store).finish(fixture);const issue=store.issues().issues[0];
  store.transition({issueId:issue.id,status:'investigating'});
  fs.writeFileSync(path.join(directory,'states',issue.id,'race.json'),JSON.stringify({revision:'race',previous:null,status:'investigating'}));
  assert.equal(store.issues().issues[0].state.status,'conflict');
  assert.throws(()=>store.transition({issueId:issue.id,status:'corrected'}),/State changed/);
});
test('CLI observes stdout and JSON stderr without changing bytes or needing returned value',t=>{
  const {store}=setup(t);const observer=observeCli({root,entry:'odc',args:['deliver'],store,meta:{operation:'deliver',lane:'odc',toolingSha256:version}});
  observer.stdout(JSON.stringify({result:fixture},null,2));observer.finish(0);
  assert.equal(store.issues().issues[0].code,'SNAPSHOT_AUTHOR_MISSING');
  const second=observeCli({root,entry:'odc',args:['deliver'],store});second.stderr('{"ok":false,"error":"sensitive password"}');second.finish(1);
  assert.equal(store.issues().total,2);
});
test('MCP logs individual calls, adds read-only queue tool and preserves call bytes',t=>{
  const {store}=setup(t);let sent='',received='';
  const observer=observeMcp({root,entry:'ssam',args:['package','mcp'],store,meta:{profile:'selected-readonly',selectedPackageId:'readonly-1234567890abcdef',selectedPackageSha256:version},toServer:s=>sent+=s,toClient:s=>received+=s});
  const request=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ssam_inspect',arguments:{lane:'odc',file:'secret.oml'},_meta:{'ssam/taskId':'task-css'}}})+'\n';
  observer.request.write(request);assert.equal(sent,request);
  const response=JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({ok:true})}]}})+'\n';observer.response.write(response);assert.equal(received,response);
  assert.equal(store.task({taskId:'task-css'}).operations[0].selectedPackageId,'readonly-1234567890abcdef');
  observer.request.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  observer.response.write('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n');assert.match(received,/ssam_friction/);
  const before=sent.length;observer.request.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ssam_friction","arguments":{"view":"task","taskId":"task-css"}}}\n');
  assert.equal(sent.length,before);assert.match(received,/operationCount/);observer.close();
});
test('MCP cancellation or disconnect retains uncertainty, including semantic late success',t=>{
  const {store}=setup(t);const observer=observeMcp({root,entry:'ssam',args:['mcp'],store,toServer:()=>{},toClient:()=>{}});
  observer.request.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"studio_deliver"}}\n');
  observer.request.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n');
  observer.response.write('{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"ok":true}}}\n');
  assert.equal(store.snapshot().operations[0].outcome,'uncertain');
  observer.request.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"studio_deliver"}}\n');observer.close();
  assert.equal(store.snapshot().operations.length,2);assert.ok(store.snapshot().operations.every(e=>e.outcome==='uncertain'));
});
test('bounded parsers preserve split Unicode and oversized protocol messages',()=>{
  let result='';const observed=[],warnings=[];
  const channel=lineChannel({onRaw:s=>result+=s,onMessage:m=>{observed.push(m);},warning:s=>warnings.push(s),limit:64});
  const input=Buffer.from('{"name":"ação"}\n'+JSON.stringify({text:'x'.repeat(128)})+'\n');
  for(let i=0;i<input.length;i+=3)channel.write(input.subarray(i,i+3));channel.end();
  assert.equal(result,input.toString());assert.equal(observed.length,1);assert.equal(warnings.length,1);
  const capture=captureJson({limit:2,onLimit:()=>warnings.push('limit')});capture.push('secret');assert.equal(capture.value(),undefined);
});
test('receipt import is sanitized and is never counted as historical tool execution time',async t=>{
  const {store,directory}=setup(t),file=path.join(directory,'deliver-result.json');fs.writeFileSync(file,JSON.stringify(fixture));
  const args=['ingest','--receipt',file,'--task-id','historical','--lane','odc'];
  const first=await main(args,{root,store});const second=await main(args,{root,store});
  assert.equal(second.alreadyRecorded,true);assert.equal(second.operationId,first.operationId);
  const task=store.task({taskId:'historical'});assert.equal(task.toolDurationSumMs,0);assert.equal(task.observedSpanMs,null);assert.deepEqual(task.importedReceiptDurationsMs,[25275]);
});

// A miniature workspace exercises the actual public launcher with fresh Node processes.
function miniature(t) {
  const directory=temp(t);fs.mkdirSync(path.join(directory,'facade'));fs.mkdirSync(path.join(directory,'platforms/odc/facade'),{recursive:true});
  for(const file of ['launch.mjs','ssam.mjs','odc.mjs','friction-cli.mjs','friction-boundary.mjs','friction-store.mjs','package-route.mjs'])fs.copyFileSync(path.join(root,'facade',file),path.join(directory,'facade',file));
  fs.writeFileSync(path.join(directory,'.ssam-workspace.json'),JSON.stringify({odc:'platforms/odc',kernel:'kernel',o11Lane:'ss4',workers:{o11ss4:1,o11ss5:2,odc:3}}));
  const code=`import readline from 'node:readline';
    const args=process.argv.slice(2);
    if(args.includes('mcp')){const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{
      const req=JSON.parse(line);if(req.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{tools:[]}})+'\\n');
      if(req.method==='tools/call')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{structuredContent:${JSON.stringify(fixture)}}})+'\\n');
    });}else {process.stdout.write(JSON.stringify(${JSON.stringify(fixture)},null,2)+'\\n');process.exitCode=1;}`;
  for(const file of ['ssam.mjs','odc.mjs'])fs.writeFileSync(path.join(directory,'platforms/odc/facade',file),code);
  for(const file of ['lib.mjs','kernel-delivery.mjs','mcp.mjs'])fs.writeFileSync(path.join(directory,'platforms/odc/facade',file),'// fixture');
  // launch.mjs imports the Studio connection environment (O11 SSO product); it only uses node:fs/node:path, so the real file is used
  fs.copyFileSync(path.join(root,'platforms/odc/facade/studio-session.mjs'),path.join(directory,'platforms/odc/facade/studio-session.mjs'));
  return directory;
}
test('two CLI processes share queue automatically; third session reads deduplicated failure',t=>{
  const directory=miniature(t),entry=path.join(directory,'facade/odc.mjs');
  for(let i=0;i<2;i++){
    const run=spawnSync(process.execPath,[entry,'deliver','private-feature'],{env:{...process.env,SSAM_TASK_ID:'shared'},encoding:'utf8'});
    assert.equal(run.status,1,run.stderr);assert.deepEqual(JSON.parse(run.stdout),fixture);
  }
  const query=spawnSync(process.execPath,[entry,'friction','issues','--task-id','shared'],{encoding:'utf8'});assert.equal(query.status,0,query.stderr);
  const result=JSON.parse(query.stdout);assert.equal(result.issues[0].count,2);assert.equal(result.issues[0].code,'SNAPSHOT_AUTHOR_MISSING');
});
test('package CLI inline fast path is observed without modifying the selected package',t=>{
  const directory=miniature(t);fs.mkdirSync(path.join(directory,'.local/releases'),{recursive:true});fs.writeFileSync(path.join(directory,'.local/releases/active-readonly.json'),'{}');
  const run=spawnSync(process.execPath,[path.join(directory,'facade/ssam.mjs'),'package','run','--operation','inspect','--lane','odc'],{encoding:'utf8'});
  assert.equal(run.status,1,run.stderr);const store=createStore({root:directory});assert.equal(store.issues().issues[0].profile,'selected-readonly');
});
test('MCP public launcher records calls and answers queue in another process',async t=>{
  const directory=miniature(t),child=spawn(process.execPath,[path.join(directory,'facade/ssam.mjs'),'package','mcp'],{stdio:['pipe','pipe','pipe'],env:{...process.env,SSAM_TASK_ID:'shared'}});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"studio_deliver"}}\n');
  const [code]=await once(child,'close');assert.equal(code,0,stderr);assert.match(stdout,/ssam_friction/);
  const query=spawnSync(process.execPath,[path.join(directory,'facade/ssam.mjs'),'friction','issues'],{encoding:'utf8'});
  const issue=JSON.parse(query.stdout).issues[0];assert.equal(issue.count,1);
  assert.equal(createStore({root:directory}).snapshot().operations.find(e=>e.operationId===issue.lastOperationIds[0]).interface,'mcp');
});
test('concurrent separate processes cannot overwrite operation events',async t=>{
  const directory=miniature(t);
  const runs=Array.from({length:6},()=>new Promise(resolve=>{
    const child=spawn(process.execPath,[path.join(directory,'facade/odc.mjs'),'deliver'],{stdio:'ignore'});child.on('close',resolve);
  }));await Promise.all(runs);
  const store=createStore({root:directory});assert.equal(store.snapshot().operations.length,6);assert.equal(store.issues().issues[0].count,6);
});
test('operational tooling identity is distinct from readonly package identity',t=>{
  const directory=miniature(t),op=boundaryMetadata(directory,'odc',['deliver']);assert.match(op.toolingSha256,/^[a-f0-9]{64}$/);assert.equal(op.selectedPackageId,undefined);
  const packageMeta=boundaryMetadata(directory,'ssam',['package','run','--operation','inspect']);assert.equal(packageMeta.profile,'selected-readonly');assert.equal(packageMeta.selectedPackageId,undefined);
});
test('Codex CLI thread correlation is automatic, but shared MCP launch thread is not reused',t=>{
  const directory=miniature(t),env={CODEX_THREAD_ID:'thread-from-client'};
  const cli=boundaryMetadata(directory,'odc',['deliver'],env);
  assert.equal(cli.taskId,'thread-from-client');assert.equal(cli.correlationSource,'client-thread-environment');
  const mcp=boundaryMetadata(directory,'ssam',['mcp'],env);assert.equal(mcp.taskId,undefined);
});
test('parallel receipt imports deduplicate by immutable receipt identity',async t=>{
  const directory=miniature(t),file=path.join(directory,'deliver-result.json');fs.writeFileSync(file,JSON.stringify(fixture));
  await Promise.all(Array.from({length:4},()=>new Promise(resolve=>{
    const child=spawn(process.execPath,[path.join(directory,'facade/ssam.mjs'),'friction','ingest','--receipt',file,'--lane','odc'],{stdio:'ignore'});child.on('close',resolve);
  })));
  const store=createStore({root:directory});assert.equal(store.snapshot().operations.length,1);assert.equal(store.issues().issues[0].count,1);
});
test('queue and task responses bound detail without dropping total counts',t=>{
  const {store}=setup(t);for(let i=0;i<8;i++)begin(store).finish(fixture);
  // C33 (atritos 3): counts and the two last ids per group (from the index), never the operations themselves.
  const issue=store.issues().issues[0];assert.equal(issue.count,8);assert.equal(issue.lastOperationIds.length,2);assert.equal(issue.operations,undefined);
  const report=store.task({taskId:'task-css',offset:6,limit:2});assert.equal(report.operationCount,8);assert.equal(report.operations.length,2);
});
test('local metadata write cost smoke (no Studio/model work)',t=>{
  const {store}=setup(t),samples=[];
  for(let i=0;i<20;i++){const start=performance.now();begin(store).finish({ok:true});samples.push(performance.now()-start);}
  samples.sort((a,b)=>a-b);assert.equal(store.snapshot().operations.length,20);
  t.diagnostic(`20 local start/end pairs: p50=${samples[9].toFixed(2)}ms p95=${samples[18].toFixed(2)}ms. Observation only, not an ODC performance acceptance gate.`);
});
test('success mentioning timeout is not a timeout; an uncertain native merge stays uncertain',()=>{
  assert.equal(outcomeOf({ok:true,message:'The timeout is configured to 30 seconds.'}).outcome,'success');
  assert.equal(outcomeOf({ok:true,message:'No change carries the snapshot author is a known diagnostic.'}).outcome,'success');
  const result=outcomeOf({ok:false,outcome:'uncertain',gate:'equivalence',error:'Native property differs: DisplayOrder'});
  assert.equal(result.outcome,'uncertain');assert.equal(result.code,'EQUIVALENCE_UNCERTAIN');assert.equal(result.step,'equivalence');
  assert.equal(outcomeOf({ok:false,outcome:'uncertain'}).code,'OUTCOME_UNCERTAIN');
});
test('spawn transport failure with no exit code is recorded as failure',t=>{
  const {store}=setup(t),observer=observeCli({root,entry:'odc',args:['deliver'],store});
  observer.finish(null,false,true);
  const event=store.snapshot().operations[0];assert.equal(event.outcome,'failure');assert.equal(event.code,'TRANSPORT_FAILED');assert.equal(event.exitCode,null);
});
test('observer failure forwards once; forwarding failure is never replayed',()=>{
  let forwarded=0;const warnings=[];
  const channel=lineChannel({onMessage:()=>{throw Error('observer failed');},onRaw:()=>forwarded++,warning:c=>warnings.push(c)});
  channel.write('{"jsonrpc":"2.0","id":1}\n');assert.equal(forwarded,1);assert.deepEqual(warnings,['MCP_OBSERVER_CALLBACK_FAILED']);
  const writer=lineChannel({onMessage:()=>false,onRaw:()=>{forwarded++;throw Error('write failed after accepting bytes');}});
  assert.throws(()=>writer.write('{"id":2}\n'),/write failed/);assert.equal(forwarded,2);
});
test('null and malformed envelopes are preserved; JSON-RPC error is a failure',t=>{
  const {store}=setup(t);let server='',client='';
  const observer=observeMcp({root,entry:'ssam',args:['mcp'],store,toServer:s=>server+=s,toClient:s=>client+=s});
  observer.request.write('null\n');observer.response.write('null\n');assert.equal(server,'null\n');assert.equal(client,'null\n');
  observer.request.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"studio_inspect"}}\n');
  observer.response.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"request timed out"}}\n');
  assert.equal(store.snapshot().operations[0].outcome,'timeout');observer.close();
});
test('generic receipt imports require explicit operation and preserve merge uncertainty',async t=>{
  const {store,directory}=setup(t),file=path.join(directory,'last-error.json');
  fs.writeFileSync(file,JSON.stringify({ok:false,outcome:'uncertain',gate:'equivalence',error:'Native property differs: DisplayOrder'}));
  await assert.rejects(()=>main(['ingest','--receipt',file],{root,store}),/explicit known/);
  await assert.rejects(()=>main(['ingest','--receipt',file,'--operation','secret-command'],{root,store}),/explicit known/);
  await main(['ingest','--receipt',file,'--operation','merge','--lane','odc'],{root,store});
  const issue=store.issues().issues[0];assert.equal(issue.operation,'merge');assert.equal(issue.code,'EQUIVALENCE_UNCERTAIN');
  await assert.rejects(()=>main(['ingest','--receipt',file,'--operation','publish'],{root,store}),/different operation/);
});
// ---- 2026-10-05 package, lane E (C44): the failure explains itself (code and step), the queue can be isolated, a
// direct API records what does not pass through a boundary, and the MCP process the clients run is the observed one.
test('a refusal is recorded with its own code and step, never OPERATION_FAILED with a null step',()=>{
  const preflight=outcomeOf({ok:false,code:'PREFLIGHT_REFUSED',error:'3 problems',problems:[{op:0,code:'ODC_COUNT_IS_LONG'}]});
  assert.equal(preflight.outcome,'failure');assert.equal(preflight.code,'PREFLIGHT_REFUSED');assert.equal(preflight.step,'preflight');
  // The same through the MCP result wrapper (text content of a tools/call answer).
  const wrapped=outcomeOf({content:[{type:'text',text:JSON.stringify({ok:false,code:'PREFLIGHT_REFUSED',problems:[]})}],isError:true});
  assert.equal(wrapped.code,'PREFLIGHT_REFUSED');assert.equal(wrapped.step,'preflight');
  const apply=outcomeOf({ok:false,failed:'apply',code:'VALIDATION_REFUSED',error:'2 unexpected messages'});
  assert.deepEqual([apply.code,apply.step],['VALIDATION_REFUSED','apply']);
  const staged=outcomeOf({ok:false,stage:'reconcile',error:'receipt unknown'});
  assert.deepEqual([staged.code,staged.step],['OPERATION_FAILED','reconcile']);
  const relay=outcomeOf({ok:false,code:'TIMEOUT',outcome:'uncertain',error:'relay gave up after 1800 s'});
  assert.deepEqual([relay.outcome,relay.code],['uncertain','TIMEOUT']);
  assert.equal(outcomeOf({ok:false,code:'PUBLISH_FAILED',result:'entregue'}).step,'publish');
  // A success never takes a failure code; `OK` and numeric JSON-RPC codes are not explicit failure codes.
  assert.deepEqual([outcomeOf({ok:true,code:'PREFLIGHT_REFUSED'}).code,outcomeOf({ok:true,code:'PREFLIGHT_REFUSED'}).step],['OK',null]);
  assert.equal(outcomeOf({ok:false,code:'OK',error:'x'}).code,'OPERATION_FAILED');
  for(const step of ['preflight','apply','verify','reconcile','refresh-references','relay','connect','data','debug','service-center']) assert.ok(STEPS.includes(step),step);
});
test('the new operations have their own names; unknown names stay other',()=>{
  for(const [tool,name] of [['ssam_grant','grant'],['ssam_task','task'],['warm','warm'],['close','close'],['ssam_discover','discover'],['ssam_map','map'],['ssam_connect','connect'],['o11_studio','studio'],['o11_environment','environment']])
    assert.equal(operationName(tool),name,tool);
  assert.equal(operationName('secret-command'),'other');
});
test('SSAM_FRICTION_DIR isolates the queue of a run from the shared one',t=>{
  const isolated=temp(t),shared=temp(t);
  assert.equal(frictionDirectory({root:shared,env:{SSAM_FRICTION_DIR:isolated}}),path.resolve(isolated));
  assert.equal(frictionDirectory({root:shared,env:{}}),path.join(shared,'.local','friction'));
  assert.equal(frictionDirectory({root:shared,directory:path.join(shared,'x'),env:{SSAM_FRICTION_DIR:isolated}}),path.join(shared,'x'),'an explicit directory wins');
  const store=createStore({root:shared,env:{SSAM_FRICTION_DIR:isolated},warning:()=>{}});begin(store).finish({ok:false,code:'PREFLIGHT_REFUSED'});
  assert.equal(fs.existsSync(path.join(shared,'.local','friction')),false);
  assert.equal(createStore({directory:isolated}).issues().issues[0].code,'PREFLIGHT_REFUSED');
  // Through the public launcher: the child process honours the variable.
  const directory=miniature(t),elsewhere=temp(t);
  const run=spawnSync(process.execPath,[path.join(directory,'facade/odc.mjs'),'deliver'],{env:{...process.env,SSAM_FRICTION_DIR:elsewhere},encoding:'utf8'});
  assert.equal(run.status,1,run.stderr);
  assert.equal(fs.existsSync(path.join(directory,'.local','friction')),false);
  assert.equal(createStore({directory:elsewhere}).issues().issues[0].count,1);
});
test('recordEvent records one event with its code and step and never throws',t=>{
  const directory=temp(t);
  const recorded=recordEvent({operation:'warm',lane:'odc',code:'INDEX_BUILD_FAILED',step:'relay',outcome:'failure'},{directory});
  assert.equal(recorded.ok,true);
  const store=createStore({directory}),issue=store.issues().issues[0],event=store.snapshot().operations.find(e=>e.operationId===issue.lastOperationIds[0]);
  assert.deepEqual([issue.operation,issue.lane,issue.code,issue.lastStep,event.step,event.interface],['warm','odc','INDEX_BUILD_FAILED','relay','relay','api']);
  assert.equal(recordEvent({operation:'warm',outcome:'success'},{directory}).ok,true);
  const blocked=path.join(temp(t),'file');fs.writeFileSync(blocked,'occupied');
  assert.doesNotThrow(()=>recordEvent({operation:'warm',outcome:'failure'},{directory:blocked}));
});
test('the MCP process the clients run (facade/ssam.mjs mcp, as .mcp.json) is observed by the boundary',async t=>{
  const config=JSON.parse(fs.readFileSync(path.join(root,'.mcp.json'),'utf8'));
  assert.deepEqual(config.mcpServers.ssam.args.map(a=>a.replace(/\\/g,'/').replace(/^.*\/facade\//,'facade/')),['facade/ssam.mjs','mcp']);
  const directory=miniature(t),child=spawn(process.execPath,[path.join(directory,'facade/ssam.mjs'),'mcp'],{stdio:['pipe','pipe','pipe'],env:{...process.env}});
  let stderr='';child.stderr.on('data',d=>stderr+=d);child.stdout.resume();
  child.stdin.end('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"o11_deliver","arguments":{"lane":"o11"}}}\n');
  const [code]=await once(child,'close');assert.equal(code,0,stderr);
  const store=createStore({root:directory}),issue=store.issues().issues[0];
  assert.deepEqual([issue.operation,issue.lane,store.snapshot().operations.find(e=>e.operationId===issue.lastOperationIds[0]).interface],['deliver','o11','mcp']);
});
test('fingerprint changes when operational MCP handlers or package router change',t=>{
  const directory=miniature(t),before=boundaryMetadata(directory,'odc',['inspect']).toolingSha256;
  fs.appendFileSync(path.join(directory,'platforms/odc/facade/mcp.mjs'),'\n// changed handler');
  const middle=boundaryMetadata(directory,'odc',['inspect']).toolingSha256;assert.notEqual(before,middle);
  fs.appendFileSync(path.join(directory,'facade/package-route.mjs'),'\n// changed route');
  assert.notEqual(middle,boundaryMetadata(directory,'odc',['inspect']).toolingSha256);
});
