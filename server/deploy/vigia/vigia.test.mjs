// Simulation of the watcher: fake Studios, fake operations, real files in a temporary outDir. No Studio, Docker, dotnet
// or Git here (vigia-runtime.test.mjs covers the real Git and PowerShell parts).
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {packFor,planWindow,rotateWindow,compareFailures,readTrx,runVigia,detectVersionFolders,pairId,pairTag,replayApprovals,pinDigest,literalCompose,literalComposeText,EnvironmentError,approve,reject,retry,acquireLock,busyDotnet,readAttempts,localDay,baseWindow} from './vigia.mjs';
import {smokeImage} from './smoke.mjs';
import {generateCompose} from '../coolify/gen-compose.mjs';
const image='docker.io/andrepereiramachado/ssam-server';
const sha=c=>c.repeat(64);
const manifest={window:2,odc:[{version:'1.7.29',tag:'new',image,sha256:sha('1')},{version:'1.7.28',tag:'old',image,sha256:sha('2')}],o11:[{version:'11.55.93',tag:'new',image,sha256:sha('1')},{version:'11.55.92',tag:'old',image,sha256:sha('2')}]};
const odc={lane:'odc',version:'1.7.30',fullVersion:'1.7.30.10980',studio:'C:/fake/odc',tfm:'net10.0'};
const o11={lane:'o11',version:'11.55.94',fullVersion:'11.55.94.65328',studio:'C:/fake/o11',tfm:'net10.0'};
const DAY=86400000,T0=Date.parse('2026-10-28T12:00:00Z');
function fixture(t,{failures={},smokeOk=true,tfm={odc:'net10.0',o11:'net10.0'},preflight,passed=2}={}){
 const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-sim-'));t.after(()=>fs.rmSync(outDir,{recursive:true,force:true}));
 const features=path.join(outDir,'..',path.basename(outDir)+'-features.xml');fs.writeFileSync(features,'<Features/>');t.after(()=>fs.rmSync(features,{force:true}));
 const calls=[],notes=[];
 const side=(lane,v)=>({lane,version:v,fullVersion:v+'.1',file:`C:/store/${lane}-${v}.tar.gz`,sha256:sha('9'),snapshot:`C:/store/${lane}-${v}/snapshot/files`,features:lane==='odc'?features:null,tfm:null});
 const ops={log(){},
  notify:async title=>{notes.push(title);calls.push('notify');},
  preflight:async()=>{calls.push('preflight');if(preflight)await preflight();},
  targetFramework:async c=>{calls.push('tfm:'+c.lane);return tfm[c.lane]??null;},
  bundle:async c=>{calls.push('bundle:'+c.lane);return side(c.lane,c.version);},
  companion:async(lane,v)=>{calls.push('companion:'+lane);return side(lane,v);},
  test:async(lane,kind)=>{calls.push(`test:${lane}:${kind}`);return {total:3,passed,failures:kind==='baseline'?['Known']:(failures[lane]??['Known'])};},
  build:async pair=>{calls.push('build');return {odc:pair.odc,o11:pair.o11,image,tag:pairTag(pair,'abc1234','20261028'),sha256:sha('a'),revision:'abc1234',commit:'abc1234'+'0'.repeat(33)};},
  smoke:async()=>{calls.push('smoke');return {ok:smokeOk};},
  propose:async(m,branch)=>{calls.push('propose');return {commit:'c'.repeat(40),branch};},
 };
 const round=(extra={})=>runVigia({manifest,observed:[odc,o11],outDir,head:'h1',now:T0,...extra},ops);
 return {outDir,calls,notes,ops,round};
}
test('fake installed folders reveal a new version and dry-run has no writes or operations',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-fake-'));try{
  fs.mkdirSync(path.join(root,'odc'));fs.writeFileSync(path.join(root,'odc/Version.txt'),'1.7.30.12345');
  const observed=detectVersionFolders({odc:path.join(root,'odc')});assert.equal(observed[0].version,'1.7.30');
  const outDir=path.join(root,'output');const result=await runVigia({manifest,observed,dryRun:true,outDir,head:'h'},new Proxy({},{get(_,k){if(k==='log')return undefined;throw Error('Dry-run invoked an operation');}}));
  assert.equal(result.status,'dry-run');assert.equal(result.decision.action,'run');assert.equal(result.decision.pair,'o11-11.55.93-odc-1.7.30');assert.equal(fs.existsSync(outDir),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('test failures are compared by full name even when counts match',()=>{
 const diff=compareFailures({failures:['Old failure']},{failures:['New failure']});assert.deepEqual(diff.newFailures,['New failure']);assert.deepEqual(diff.resolved,['Old failure']);
 const parsed=readTrx('<Results><UnitTestResult testName="A &amp; B" outcome="Failed"/><UnitTestResult testName="C" outcome="Passed"/></Results>');assert.deepEqual(parsed.failures,['A & B']);assert.equal(parsed.total,2);
 assert.throws(()=>readTrx('<Results/>'),/No test results/);
});
test('rotation keeps a bounded pair window and lists customers losing a served version',()=>{
 const next=rotateWindow(manifest,{odc:'1.7.30',o11:'11.55.93',tag:'next',image,sha256:sha('a')},{tokens:{tok_old:{customer:'Old',seen:'2026-10-20',odc:{installed:'1.7.28.10'}},tok_new:{odc:{installed:'1.7.29.10'}}}});
 assert.deepEqual(next.manifest.odc.map(x=>x.version),['1.7.30','1.7.29']);assert.equal(next.manifest.o11.length,2);assert.deepEqual(next.leaving.odc,['1.7.28']);assert.deepEqual(next.affected.map(x=>x.token),['tok_old']);
 assert.equal(planWindow(manifest,[{...odc,version:'1.7.27'}]).candidates.length,0);
});
test('ODC and O11 new together become ONE pair: one build, one smoke, one proposal without a digest until approval',async t=>{
 const f=fixture(t);const r=await f.round();
 assert.equal(r.status,'proposed');assert.equal(r.id,'o11-11.55.94-odc-1.7.30');assert.equal(r.branch,'vigia/o11-11.55.94-odc-1.7.30');
 assert.deepEqual(f.calls,['preflight','tfm:odc','tfm:o11','bundle:odc','bundle:o11','companion:odc','companion:o11','test:odc:baseline','test:odc:candidate','test:o11:baseline','test:o11:candidate','build','smoke','propose','notify']);
 assert.equal(r.built.tag,'prod-20261028-abc1234-o115594-odc1730');
 const a=readAttempts(f.outDir)[r.id];assert.equal(a.status,'proposed');
 assert.equal(a.proposedManifest.odc[0].version,'1.7.30');assert.equal(a.proposedManifest.odc[0].sha256,undefined,'no digest before publication');assert.equal(a.proposedManifest.odc[1].sha256,sha('1'));
 const proposal=fs.readFileSync(path.join(r.dir,'PROPOSTA.md'),'utf8');assert.match(proposal,/-Approve o11-11\.55\.94-odc-1\.7\.30/);assert.match(proposal,/No image was published/);
 assert.ok(fs.existsSync(path.join(r.dir,'Features.plain.xml')));
});
test('an unchanged pending proposal is never rebuilt and its notice repeats at most once a day',async t=>{
 const f=fixture(t);await f.round();const n=f.notes.length,c=f.calls.length;
 const again=await f.round({now:T0+3600000,head:'h2'});assert.equal(again.status,'pending-approval');assert.equal(f.calls.length,c,'no operation');assert.equal(f.notes.length,n,'same day: no second notice');
 await f.round({now:T0+DAY});assert.equal(f.notes.length,n+1,'next day: one notice');
 await f.round({now:T0+DAY+3600000});assert.equal(f.notes.length,n+1);
});
test('a new kernel failure stops before build, names it, and is not retried with the same inputs',async t=>{
 const f=fixture(t,{failures:{odc:['Known','Different'],o11:['Known','Other']}});
 const r=await f.round();assert.equal(r.status,'failed');assert.ok(!f.calls.includes('build'));
 const text=fs.readFileSync(path.join(f.outDir,r.id,'FALHAS.md'),'utf8');assert.match(text,/Different/);assert.match(text,/Other/);assert.match(text,/-Retry/);
 const c=f.calls.length,n=f.notes.length;
 const again=await f.round({now:T0+3600000});assert.equal(again.status,'failed');assert.equal(f.calls.length,c+0,'no rerun');assert.equal(f.notes.length,n,'no second notice the same day');
});
test('a failed lane is set aside and the other lane proceeds alone',async t=>{
 const f=fixture(t,{failures:{o11:['Known','O11 regression']}});
 const first=await f.round();assert.equal(first.status,'failed');assert.deepEqual(readAttempts(f.outDir)[first.id].failedLanes,['o11']);
 const second=await f.round({now:T0+3600000});assert.equal(second.status,'proposed');assert.equal(second.id,'o11-11.55.93-odc-1.7.30');
});
test('a failure is retried when main moved and enough time passed, or on -Retry',async t=>{
 const f=fixture(t,{failures:{odc:['Known','Different'],o11:['Known','Other']}});
 const r=await f.round();
 assert.equal((await f.round({now:T0+2*3600000,head:'h2'})).status,'failed','too soon');
 const builds=f.calls.filter(c=>c==='preflight').length;
 await f.round({now:T0+13*3600000,head:'h2'});assert.equal(f.calls.filter(c=>c==='preflight').length,builds+1,'retried after main moved');
 retry({outDir:f.outDir},r.id);await f.round({now:T0+14*3600000,head:'h2'});assert.equal(f.calls.filter(c=>c==='preflight').length,builds+2,'retried on -Retry');
});
test('a suite that runs nothing cannot approve a version',async t=>{
 const f=fixture(t,{passed:0});const r=await f.round();assert.equal(r.status,'failed');assert.match(r.error,/did not run/);
});
test('a stopped Docker defers the round (environment, not a test result) and the next round retries',async t=>{
 let up=false;const f=fixture(t,{preflight:async()=>{if(!up)throw new EnvironmentError('Docker Desktop did not answer.','docker-unavailable');}});
 const r=await f.round();assert.equal(r.status,'deferred');assert.equal(readAttempts(f.outDir)[r.id].status,'deferred');
 assert.match(fs.readFileSync(path.join(r.dir,'FALHAS.md'),'utf8'),/retries it automatically/);
 up=true;const again=await f.round({now:T0+6*3600000});assert.equal(again.status,'proposed');
 assert.ok(fs.existsSync(path.join(again.dir,'previous')),'the deferred attempt is kept');
});
test('a Studio on .NET 10 follows the normal path when the build rule targets it; without the rule the round waits, never FALHAS of tests',async t=>{
 const ok=fixture(t,{tfm:{odc:'net10.0',o11:'net10.0'}});const r=await ok.round();assert.equal(r.status,'proposed');
 assert.match(fs.readFileSync(path.join(r.dir,'PROPOSTA.md'),'utf8'),/odc: Studio net10\.0, build net10\.0/);
 const old=fixture(t,{tfm:{odc:'net8.0',o11:'net8.0'}});const w=await old.round();
 assert.equal(w.status,'deferred');assert.equal(readAttempts(old.outDir)[w.id].code,'runtime-unsupported');assert.ok(!old.calls.some(c=>c.startsWith('test:')));
 const unknown=fixture(t,{tfm:{}});assert.equal((await unknown.round()).status,'proposed','an unevaluated target does not block');
});
test('an idle round writes nothing at all',async t=>{
 const outDir=path.join(os.tmpdir(),'vigia-idle-'+process.pid);t.after(()=>fs.rmSync(outDir,{recursive:true,force:true}));
 const r=await runVigia({manifest,observed:[{lane:'odc',version:'1.7.29',fullVersion:'1.7.29.10940'}],outDir,head:'h'},new Proxy({},{get(_,k){if(k==='log')return ()=>{};throw Error('Idle round invoked '+String(k));}}));
 assert.equal(r.status,'idle');assert.equal(fs.existsSync(outDir),false);
});
test('an unserved observation without an installed Studio is reported without building, once a day',async t=>{
 const f=fixture(t);const state={unserved:{odc:{'1.7.30':{tokens:['tok_waiting']}}}};
 const r=await runVigia({manifest,observed:[],state,outDir:f.outDir,now:T0},f.ops);
 assert.equal(r.status,'waiting-for-studio');assert.deepEqual(f.calls,['notify']);assert.ok(fs.existsSync(path.join(f.outDir,'PENDENTE.md')));
 await runVigia({manifest,observed:[],state,outDir:f.outDir,now:T0+3600000},f.ops);assert.deepEqual(f.calls,['notify']);
});
test('old observations do not trigger a release and skipped suites cannot approve one',()=>{
 assert.equal(planWindow(manifest,[],{unserved:{odc:{'1.7.12':{tokens:['old']}}}}).requested.length,0);
 assert.throws(()=>readTrx('<Results><UnitTestResult testName="Skipped" outcome="NotExecuted"/></Results>'),/No executed tests/);
});
for(const lane of ['odc','o11']) test(`single ${lane} rotation carries the current other lane and never duplicates a pair`,()=>{
 const other=lane==='odc'?'o11':'odc',value=lane==='odc'?'1.7.30':'11.55.94';
 const pair={[lane]:value,image,tag:'single',sha256:sha('b')};
 const next=rotateWindow(manifest,pair).manifest;
 assert.equal(next[lane][0].version,value);assert.equal(next[other][0].version,manifest[other][0].version);
 const repeated=rotateWindow(next,pair).manifest;assert.deepEqual(repeated,next);
});
test('image smoke takes the listing budget, keeps credentials out of arguments and removes its private state',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-smoke-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const features=path.join(dir,'Features.plain.xml');fs.writeFileSync(features,'<Features/>');const commands=[];
 const docker=async(args,options={})=>{commands.push(args);if(args[0]==='logs')return {code:0,stdout:JSON.stringify({event:'warm',indexes:{ok:true},delivery:{builder:{ok:true},worker:{ok:true}}}),stderr:''};
  if(args.includes('server-token'))return {code:0,stdout:JSON.stringify({token:'private-mcp-token',agentCredential:'private-agent-token'}),stderr:''};
  if(args.includes('-i')){assert.ok(options.input.includes('private-mcp-token'));assert.ok(options.input.includes('"o11Hook":"dev"'));assert.ok(options.input.includes('"tools":93'));return {code:0,stdout:JSON.stringify({ok:true,tools:93,totalBytes:261000}),stderr:''};}
  return {code:0,stdout:'',stderr:''};};
 const result=await smokeImage({pair:{image,tag:'test',odc:'1.7.30',o11:'11.55.93'},bundle:{features},dir,root:dir,docker,served:{odc:['1.7.30'],o11:['11.55.93','11.55.92']},budget:{tools:93,totalBytes:262000},pack:{odcBridgeAccepted:['v99']}});
 assert.equal(result.ok,true);assert.equal(fs.existsSync(path.join(dir,'segredo')),false);assert.ok(commands.some(x=>x[0]==='rm'&&x.includes('-v')));assert.doesNotMatch(JSON.stringify(commands),/private-mcp-token|private-agent-token/);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'kernel.json'),'utf8')).odcBridgeAccepted,['v99']);
 await assert.rejects(smokeImage({pair:{image,tag:'t',odc:'1.7.30',o11:'11.55.93'},bundle:{features},dir,root:dir,docker,served:{}}),/listing budget/);
});
test('the listing budget is one file shared by the rehearsal, the smoke and the facade budget test',()=>{
 const budget=JSON.parse(fs.readFileSync(new URL('../coolify/listing-budget.json',import.meta.url),'utf8'));
 const facade=fs.readFileSync(new URL('../../platforms/odc/facade/tests/hosted-listing-budget.test.mjs',import.meta.url),'utf8');
 assert.equal(Number(/HOSTED_LISTING_CEILING = (\d+)/.exec(facade)[1]),budget.totalBytes);assert.equal(Number(/HOSTED_CORE_CEILING = (\d+)/.exec(facade)[1]),budget.coreBytes);
 assert.deepEqual([.../const CORE = \[([^\]]+)\]/s.exec(facade)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]),budget.core);
 const rehearse=fs.readFileSync(new URL('../coolify/rehearse.mjs',import.meta.url),'utf8');assert.doesNotMatch(rehearse,/261330|34097|tools\.length,92/);
});
function approvalOps(f,{digest='sha256:'+sha('a'),already=false}={}){
 const calls=[];
 return {calls,ops:{log(){},verifyBranch:async(b,c)=>calls.push(['branch',b,c]),verifyLocalImage:async b=>calls.push(['image',b.tag]),publish:async b=>{calls.push(['publish',b.tag]);return {digest,already};},
  pin:async(m,branch)=>{calls.push(['pin',branch,m]);return {commit:'d'.repeat(40)};}}};
}
const domains={ssam:'mcp.example.test',console:'panel.example.test'};
test('-Approve checks, publishes (simulated), pins the published digest and prints what is left and the way back',async t=>{
 const f=fixture(t);const r=await f.round();const a=approvalOps(f);
 const done=await approve({outDir:f.outDir,domains},a.ops,'odc-1.7.30');
 assert.equal(done.status,'approved');assert.deepEqual(a.calls.map(c=>c[0]),['branch','image','publish','pin']);
 const pinned=a.calls[3][2];assert.equal(pinned.odc[0].sha256,sha('a'));assert.equal(pinned.o11[0].sha256,sha('a'));
 assert.match(done.steps,/kernel write --version odc=1\.7\.30/);assert.match(done.steps,/compose\.coolify\.literal\.yml/);assert.match(done.steps,/Way back: .*compose\.rollback\.literal\.yml/);assert.match(done.steps,/latest was not moved/);
 const literal=fs.readFileSync(path.join(r.dir,'compose.coolify.literal.yml'),'utf8');assert.match(literal,/Host\(`mcp\.example\.test`\)/);assert.match(literal,/o115594-odc1730/);
 assert.match(fs.readFileSync(path.join(r.dir,'compose.rollback.literal.yml'),'utf8'),/"image": "docker.io\/andrepereiramachado\/ssam-server:new"/);
 assert.equal(readAttempts(f.outDir)[r.id].status,'approved');
 // The next round plans from the approved window even before main carries it: nothing new, nothing rebuilt.
 const base=baseWindow(manifest,f.outDir);assert.deepEqual(base.replayed,[r.id]);
 const next=await runVigia({manifest:base.manifest,observed:[odc,o11],outDir:f.outDir,head:'h1',now:T0+DAY},f.ops);assert.equal(next.status,'idle');
});
test('-Approve refuses to pin when the registry digest is not the tested one',async t=>{
 const f=fixture(t);await f.round();const a=approvalOps(f,{digest:'sha256:'+sha('b')});
 await assert.rejects(approve({outDir:f.outDir,domains},a.ops,'o11-11.55.94'),/not the tested/);assert.ok(!a.calls.some(c=>c[0]==='pin'));
});
test('-Reject drops a proposal for good with the same inputs; -Retry builds it again',async t=>{
 const f=fixture(t);const r=await f.round();
 assert.throws(()=>reject({outDir:f.outDir},r.id),/reason/);reject({outDir:f.outDir},r.id,'test');
 const c=f.calls.length;assert.equal((await f.round({now:T0+DAY})).status,'rejected');assert.equal(f.calls.length,c);
 retry({outDir:f.outDir},r.id);assert.equal((await f.round({now:T0+DAY})).status,'proposed');
});
test('approvals main lacks are replayed in order on top of main; a pair main has is skipped',()=>{
 const approved={id:'o11-11.55.93-odc-1.7.30',pair:{odc:'1.7.30',o11:'11.55.93'},built:{image,tag:'p1'},approved:{at:'2026-10-28T00:00:00Z',digest:'sha256:'+sha('c')}};
 const r=replayApprovals(manifest,[approved]);assert.equal(r.manifest.odc[0].version,'1.7.30');assert.equal(r.manifest.odc[0].sha256,sha('c'));assert.deepEqual(r.replayed,[approved.id]);
 assert.deepEqual(replayApprovals(r.manifest,[approved]).replayed,[]);
 assert.throws(()=>pinDigest(manifest,'missing','sha256:'+sha('d')),/once per lane/);
});
test('the literal compose substitutes the domains only in the Traefik rules',()=>{
 const c=literalCompose(generateCompose(manifest),domains);
 const rules=Object.values(c.services).flatMap(s=>Object.entries(s.labels??{})).filter(([k])=>/\.rule$/.test(k));assert.ok(rules.length>=4);
 for(const [,v] of rules)assert.doesNotMatch(v,/\$\{/);
 assert.match(JSON.stringify(c.services['ssam-router'].environment),/\$\{CONSOLE_DOMAIN\}/);
 assert.throws(()=>literalCompose(generateCompose(manifest),{ssam:'x'}),/domains/);
});
test('the release literal compose of 2026-10-27 is exactly what the watcher would hand the owner',{skip:!fs.existsSync('C:/t/vps-a11/compose.coolify.literal.yml')},()=>{
 const main=JSON.parse(fs.readFileSync(new URL('../coolify/versions.json',import.meta.url),'utf8'));
 if(main.odc[0].tag!=='prod-20261027-77413f9-o115593-odc1729')return;
 const want=fs.readFileSync('C:/t/vps-a11/compose.coolify.literal.yml','utf8').replace(/\r\n/g,'\n');
 assert.equal(literalComposeText(main,{ssam:'mcp.ssam.pro',console:'panel.ssam.pro'}),want);
});
test('one round at a time: the lock is exclusive, a dead holder is stale, release frees it',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-lock-'));try{
  const file=path.join(dir,'vigia.lock');const a=acquireLock(file);assert.ok(a.token);
  assert.ok(acquireLock(file).busy,'held by a live process');
  a.release();const b=acquireLock(file);assert.ok(b.token);b.release();
  fs.writeFileSync(file,JSON.stringify({pid:999999,token:'old',at:new Date().toISOString()}));
  const c=acquireLock(file,{alive:()=>false});assert.ok(c.token,'dead holder: stale lock taken over');c.release();
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,token:'old',at:new Date(Date.now()-30*3600000).toISOString()}));
  assert.ok(acquireLock(file).token,'a lock older than a day is stale');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('one dotnet build/test at a time: builds and tests count, kernel servers and idle build servers do not',()=>{
 const p=(Name,CommandLine)=>({Name,CommandLine,ProcessId:1});
 const busy=busyDotnet([
  p('dotnet.exe','dotnet C:\\Users\\andre\\SSAM-Hybrid-proto\\kernel\\.local\\cli\\anvil.dll serve --port 21517'),
  p('dotnet.exe','dotnet C:\\x\\lane-odc\\cli\\anvil-odc.dll serve --port 21547'),
  p('dotnet.exe','"C:\\Program Files\\dotnet\\dotnet.exe" "C:\\Program Files\\dotnet\\sdk\\10.0.401\\MSBuild.dll" /nologo /nodemode:1 /nodeReuse:true'),
  p('dotnet.exe','"C:\\Program Files\\dotnet\\dotnet.exe" "C:\\Program Files\\dotnet\\sdk\\10.0.401\\Roslyn\\bincore\\VBCSCompiler.dll" -pipename:x'),
  p('dotnet.exe','"C:\\Program Files\\dotnet\\dotnet.exe" build kernel\\Anvil.slnx'),
  p('dotnet.exe','dotnet test server/kernel/tests/Anvil.Tests.Odc --filter X'),
  p('testhost.exe','testhost.exe --port 1'),
  p('dotnet.exe','dotnet exec --runtimeconfig x.json C:\\x\\testhost.dll --port 2')]);
 assert.deepEqual(busy.map(x=>x.CommandLine.split(' ').at(-1)==='kernel\\Anvil.slnx'?'build':x.CommandLine.split(' ')[1]),['build','test','--port','exec']);
});
test('a pair whose Studio moved to .NET 10 presents the agent pack built for it; older pairs keep the base pack',()=>{
 const config={agentPack:{odcBridge:'v97',odcBridgeAccepted:['v96'],o11BuiltFor:'11.55.92',o11Hook:'dev'},agentPackByRuntime:{net10:{odcBridge:'v100',odcBridgeAccepted:['v97'],o11BuiltFor:'11.55.94'}}};
 assert.deepEqual(packFor(config,{odc:{tfm:'net10.0'},o11:{tfm:null}}),{odcBridge:'v100',odcBridgeAccepted:['v97'],o11BuiltFor:'11.55.92',o11Hook:'dev'});
 assert.deepEqual(packFor(config,{odc:{tfm:'net10.0'},o11:{tfm:'net10.0'}}).o11BuiltFor,'11.55.94');
 assert.deepEqual(packFor(config,{odc:{tfm:'net8.0'},o11:{}}),config.agentPack);
});
test('the notice day is the local calendar day',()=>{assert.match(localDay(T0),/^\d{4}-\d{2}-\d{2}$/);});
