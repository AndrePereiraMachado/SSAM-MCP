// Simulation of the watcher: fake Studios, fake operations, real files in a temporary outDir. No Studio, Docker, dotnet
// or Git here (vigia-runtime.test.mjs covers the real Git and PowerShell parts).
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {timedOut,packFor,missingPack,planWindow,rotateWindow,compareFailures,readTrx,runVigia,detectVersionFolders,pairId,pairTag,replayApprovals,pinDigest,literalCompose,literalComposeText,EnvironmentError,approve,reject,retry,acquireLock,registerChild,busyDotnet,readAttempts,localDay,baseWindow} from './vigia.mjs';
import {smokeImage} from './smoke.mjs';
import {generateCompose} from '../coolify/gen-compose.mjs';
const image='docker.io/andrepereiramachado/ssam-server';
const sha=c=>c.repeat(64);
const manifest={window:2,odc:[{version:'1.7.29',tag:'new',image,sha256:sha('1')},{version:'1.7.28',tag:'old',image,sha256:sha('2')}],o11:[{version:'11.55.93',tag:'new',image,sha256:sha('1')},{version:'11.55.92',tag:'old',image,sha256:sha('2')}]};
const odc={lane:'odc',version:'1.7.30',fullVersion:'1.7.30.10980',studio:'C:/fake/odc',tfm:'net10.0'};
const o11={lane:'o11',version:'11.55.94',fullVersion:'11.55.94.65328',studio:'C:/fake/o11',tfm:'net10.0'};
const DAY=86400000,T0=Date.parse('2026-10-28T12:00:00Z');
function fixture(t,{failures={},smokeOk=true,tfm={odc:'net10.0',o11:'net10.0'},preflight,docker,passed=2,bundleTfm=null}={}){
 const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-sim-'));t.after(()=>fs.rmSync(outDir,{recursive:true,force:true}));
 const features=path.join(outDir,'..',path.basename(outDir)+'-features.xml');fs.writeFileSync(features,'<Features/>');t.after(()=>fs.rmSync(features,{force:true}));
 const calls=[],notes=[];
 const side=(lane,v)=>({lane,version:v,fullVersion:v+'.1',file:`C:/store/${lane}-${v}.tar.gz`,sha256:sha('9'),snapshot:`C:/store/${lane}-${v}/snapshot/files`,features:lane==='odc'?features:null,tfm:null});
 const ops={log(){},
  notify:async title=>{notes.push(title);calls.push('notify');},
  preflight:async()=>{calls.push('preflight');if(preflight)await preflight();},
  dockerReady:async()=>{calls.push('docker');if(docker)await docker();},
  targetFramework:async c=>{calls.push('tfm:'+c.lane);return tfm[c.lane]??null;},
  bundle:async c=>{calls.push('bundle:'+c.lane);return {...side(c.lane,c.version),tfm:bundleTfm};},
  companion:async(lane,v)=>{calls.push('companion:'+lane);return side(lane,v);},
  test:async(lane,kind)=>{calls.push(`test:${lane}:${kind}`);return {total:3,passed:typeof passed==='object'?passed[kind]:passed,failures:kind==='baseline'?['Known']:(failures[lane]??['Known'])};},
  build:async pair=>{calls.push('build');return {odc:pair.odc,o11:pair.o11,image,tag:pairTag(pair,'abc1234','20261028'),sha256:sha('a'),revision:'abc1234',commit:'abc1234'+'0'.repeat(33)};},
  smoke:async()=>{calls.push('smoke');return {ok:smokeOk};},
  propose:async(m,branch)=>{calls.push('propose');return {commit:'c'.repeat(40),branch};},
 };
 const round=(extra={})=>runVigia({manifest,observed:[odc,o11],outDir,head:'h1',now:T0,agentPack:{odcBridge:'v97',runtime:'net8.0'},agentPackByRuntime:{net10:{odcBridge:'v100',o11BuiltFor:'11.55.94'}},...extra},ops);
 return {outDir,calls,notes,ops,round,features};
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
 const next=rotateWindow(manifest,{odc:'1.7.30',o11:'11.55.93',tag:'next',image,sha256:sha('a')},{tokens:{tok_old:{customer:'Old',seen:'2026-09-20',odc:{installed:'1.7.28.10'}},tok_new:{odc:{installed:'1.7.29.10'}}}});
 assert.deepEqual(next.manifest.odc.map(x=>x.version),['1.7.30','1.7.29']);assert.equal(next.manifest.o11.length,2);assert.deepEqual(next.leaving.odc,['1.7.28']);assert.deepEqual(next.affected.map(x=>x.token),['tok_old']);
 assert.equal(planWindow(manifest,[{...odc,version:'1.7.27'}]).candidates.length,0);
});
test('ODC and O11 new together become ONE pair: one build, one smoke, one proposal without a digest until approval',async t=>{
 const f=fixture(t);const r=await f.round();
 assert.equal(r.status,'proposed');assert.equal(r.id,'o11-11.55.94-odc-1.7.30');assert.equal(r.branch,'vigia/o11-11.55.94-odc-1.7.30');
 assert.deepEqual(f.calls,['preflight','tfm:odc','tfm:o11','docker','bundle:odc','bundle:o11','companion:odc','companion:o11','test:odc:baseline','test:odc:candidate','test:o11:baseline','test:o11:candidate','build','smoke','propose','notify']);
 assert.equal(r.built.tag,'prod-20261028-abc1234-o115594-odc1730');
 const a=readAttempts(f.outDir)[r.id];assert.equal(a.status,'proposed');
 assert.equal(a.proposedManifest.odc[0].version,'1.7.30');assert.equal(a.proposedManifest.odc[0].sha256,undefined,'no digest before publication');assert.equal(a.proposedManifest.odc[1].sha256,sha('1'));
 const proposal=fs.readFileSync(path.join(r.dir,'PROPOSTA.md'),'utf8');assert.match(proposal,/-Approve o11-11\.55\.94-odc-1\.7\.30/);assert.match(proposal,/No image was published/);
 // The tenant's feature flags stay in the private store, never in the watcher folder (C:/t).
 assert.equal(fs.existsSync(path.join(r.dir,'Features.plain.xml')),false);assert.equal(a.features,f.features);
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
test('a candidate suite that runs nothing cannot approve a version; a baseline that does not run is the machine, not the version',async t=>{
 const f=fixture(t,{passed:{baseline:2,candidate:0}});const r=await f.round();assert.equal(r.status,'failed');assert.match(r.error,/did not run on the candidate/);
 const g=fixture(t,{passed:{baseline:0,candidate:2}});const b=await g.round();assert.equal(b.status,'deferred');const a=readAttempts(g.outDir)[b.id];assert.equal(a.code,'baseline');assert.deepEqual(a.deferredLanes,['odc']);
 assert.ok(fs.existsSync(path.join(b.dir,'AGUARDANDO.md')));
});
test('a stopped Docker defers the round (environment, not a test result) and the next round retries',async t=>{
 let up=false;const f=fixture(t,{docker:async()=>{if(!up)throw new EnvironmentError('Docker Desktop did not answer.','docker-unavailable');}});
 const r=await f.round();assert.equal(r.status,'deferred');assert.equal(readAttempts(f.outDir)[r.id].status,'deferred');
 assert.match(fs.readFileSync(path.join(r.dir,'AGUARDANDO.md'),'utf8'),/retries it automatically/);assert.equal(fs.existsSync(path.join(r.dir,'FALHAS.md')),false,'a deferral is not a failure');
 up=true;const again=await f.round({now:T0+6*3600000});assert.equal(again.status,'proposed');
 assert.equal(fs.existsSync(path.join(again.dir,'previous')),false,'a deferral leaves no archive');assert.equal(readAttempts(f.outDir)[again.id].deferrals,1);
});
test('a Studio on .NET 10 follows the normal path when the build rule targets it; without the rule the round waits, never FALHAS of tests',async t=>{
 const ok=fixture(t,{tfm:{odc:'net10.0',o11:'net10.0'}});const r=await ok.round();assert.equal(r.status,'proposed');
 assert.match(fs.readFileSync(path.join(r.dir,'PROPOSTA.md'),'utf8'),/odc: Studio net10\.0, build net10\.0/);
 const old=fixture(t,{tfm:{odc:'net8.0',o11:'net8.0'}});const w=await old.round();
 assert.equal(w.status,'deferred');assert.equal(readAttempts(old.outDir)[w.id].code,'runtime-unsupported');assert.ok(!old.calls.some(c=>c.startsWith('test:')));
 assert.ok(!old.calls.includes('docker'),'a round that waits for the runtime rule never starts Docker');assert.match(w.error,/ODC Studio 1.7.30 runs on net10.0.*; Service Studio 11.55.94 runs on net10.0/,'every lane in one message');
 await old.round({now:T0+6*3600000});await old.round({now:T0+12*3600000});const a=readAttempts(old.outDir)[w.id];assert.equal(a.deferrals,3);assert.equal(a.firstDeferredAt,new Date(T0).toISOString());assert.equal(fs.existsSync(path.join(w.dir,'previous')),false);
 // MSBuild that cannot be asked: the watcher never picks a framework, so the lane waits (it used to go on).
 const unknown=fixture(t,{tfm:{}});const u=await unknown.round();assert.equal(u.status,'deferred');assert.equal(readAttempts(unknown.outDir)[u.id].code,'runtime-unknown');
});
test('a pair on .NET 10 waits for its agent pack instead of failing the smoke; with agentPackByRuntime.net10 it proceeds',async t=>{
 const f=fixture(t,{bundleTfm:'net10.0'});const r=await f.round({agentPackByRuntime:{}});
 assert.equal(r.status,'deferred');assert.equal(readAttempts(f.outDir)[r.id].code,'agent-pack-missing');assert.match(r.error,/agentPackByRuntime.net10/);assert.ok(!f.calls.some(c=>c.startsWith('test:')||c==='build'));
 assert.ok(!f.calls.includes('docker'),'a round that waits for the agent pack never starts Docker');assert.deepEqual(readAttempts(f.outDir)[r.id].deferredLanes,['odc','o11']);
 const g=fixture(t,{bundleTfm:'net10.0'});assert.equal((await g.round({agentPackByRuntime:{net10:{odcBridge:'v100',o11BuiltFor:'11.55.94'}}})).status,'proposed');
 assert.deepEqual(missingPack({agentPack:{runtime:'net8.0'}},{odc:{tfm:'net8.0'},o11:{tfm:null}}),[]);
});
// M3: a lane deferred for its own reason holds the pair for laneWaitHours (24 h), then the other lane goes on alone.
test('one lane waiting for the runtime rule holds the other for a day at most, then the other lane goes on alone',async t=>{
 const f=fixture(t,{tfm:{odc:'net8.0',o11:'net8.0'}});
 const observed=[odc,{lane:'o11',version:'11.55.95',fullVersion:'11.55.95.1',studio:'C:/fake/o11',tfm:'net8.0'}];
 const rounds=[];for(const h of [0,6,12,18])rounds.push((await f.round({observed,now:T0+h*3600000})).status);
 assert.deepEqual(rounds,['deferred','deferred','deferred','deferred']);assert.ok(!f.calls.some(c=>c.startsWith('test:')));
 const a=readAttempts(f.outDir)['o11-11.55.95-odc-1.7.30'];assert.deepEqual(a.deferredLanes,['odc']);assert.equal(a.laneSince.odc,new Date(T0).toISOString());
 const alone=await f.round({observed,now:T0+24*3600000});
 assert.equal(alone.status,'proposed');assert.equal(alone.id,'o11-11.55.95-odc-1.7.29','the O11 lane alone, with the default ODC');
});
test('one lane without its agent pack holds the other for a day at most',async t=>{
 const f=fixture(t,{tfm:{odc:'net8.0',o11:'net10.0'}});
 const observed=[{...odc,tfm:'net8.0'},o11];
 for(const h of [0,6,12,18])assert.equal((await f.round({observed,now:T0+h*3600000,agentPackByRuntime:{}})).status,'deferred');
 const alone=await f.round({observed,now:T0+24*3600000,agentPackByRuntime:{}});assert.equal(alone.status,'proposed');assert.equal(alone.id,'o11-11.55.93-odc-1.7.30');
});
test('an incomplete Studio folder (no exe, no runtimeconfig.json) defers its lane with the reason, never as an unknown runtime',async t=>{
 const f=fixture(t);
 const broken={...o11,tfm:null,missing:['ServiceStudio.exe','ServiceStudio.runtimeconfig.json']};
 const r=await f.round({observed:[odc,broken]});
 assert.equal(r.status,'deferred');const a=readAttempts(f.outDir)[r.id];assert.equal(a.laneCodes.o11,'studio-incomplete');assert.deepEqual(a.deferredLanes,['o11']);
 assert.match(r.error,/Service Studio folder C:\/fake\/o11 has ServiceStudio\.Framework\.dll 11\.55\.94\.65328 but not ServiceStudio\.exe, ServiceStudio\.runtimeconfig\.json: the Studio is incomplete/);
 assert.ok(!f.calls.includes('tfm:o11'),'the build rule is not asked about an incomplete folder');assert.ok(!f.calls.includes('docker'));
 const quiet=fixture(t);const q=await quiet.round({observed:[odc,{...o11,tfm:null}]});assert.equal(readAttempts(quiet.outDir)[q.id].laneCodes.o11,'studio-incomplete','a null runtime is never skipped');
 const alone=await f.round({observed:[odc,broken],now:T0+24*3600000});assert.equal(alone.id,'o11-11.55.93-odc-1.7.30');assert.equal(alone.status,'proposed');
});
test('R7: the once-a-day notice counts the day of the notice, not the day the round started (a round across midnight)',async t=>{
 const f=fixture(t,{tfm:{odc:'net8.0',o11:'net8.0'}});
 // Day 1: the waiting notice is given.
 await f.round();const given=f.notes.length;assert.ok(given>=1);
 // Day 2: a round that started on day 1 (decision time T0+1h) defers only on day 2 (it waited for another dotnet).
 let clock=T0+3600000;const wait=f.ops.targetFramework;f.ops.targetFramework=async c=>{clock=T0+DAY+3600000;return wait(c);};
 await f.round({now:T0+3600000,clock:()=>clock});
 assert.equal(f.notes.length,given+1,'the first notice of day 2 is given');
});
test('R3: candidate tests that time out three rounds in a row are held (no 90 min every 6 h) until main moves or -Retry',async t=>{
 const f=fixture(t);
 f.ops.test=async(lane,kind)=>{f.calls.push(`test:${lane}:${kind}`);if(kind==='baseline')return {total:3,passed:3,failures:[]};throw new EnvironmentError('The odc candidate tests could not run (timed out).','test-environment',[lane]);};
 const config=extra=>({manifest,observed:[odc],outDir:f.outDir,head:'h1',agentPack:{runtime:'net8.0'},agentPackByRuntime:{net10:{odcBridge:'v100',o11BuiltFor:'11.55.94'}},...extra});
 for(const h of [0,6,12])assert.equal((await runVigia(config({now:T0+h*3600000}),f.ops)).status,'deferred');
 const runs=f.calls.filter(c=>c==='test:odc:candidate').length;assert.equal(runs,3);
 const held=await runVigia(config({now:T0+18*3600000}),f.ops);assert.equal(held.status,'held');assert.equal(f.calls.filter(c=>c==='test:odc:candidate').length,runs,'not run again');
 assert.ok(f.notes.includes('SSAM: Studio version tests do not run'));
 await runVigia(config({now:T0+19*3600000,head:'h2'}),f.ops);assert.equal(f.calls.filter(c=>c==='test:odc:candidate').length,runs+1,'main moved: tried again');
});
test('N1: at the time limit the record stays deferred even when the killed test returns afterwards as a failure',async t=>{
 let kill;const killed=new Promise(r=>kill=r);
 const f=fixture(t);
 f.ops.test=async(lane,kind)=>{f.calls.push(`test:${lane}:${kind}`);if(kind==='baseline')return {total:3,passed:3,failures:[]};
  await killed;throw Object.assign(Error(`No test results from the ${lane} candidate run (exit 1)`),{lanes:[lane]});};
 const config={manifest,observed:[odc],outDir:f.outDir,head:'h1',now:T0,agentPack:{runtime:'net8.0'},agentPackByRuntime:{net10:{odcBridge:'v100',o11BuiltFor:'11.55.94'}}};
 const round=runVigia(config,f.ops);
 while(!f.calls.includes('test:odc:candidate'))await new Promise(r=>setTimeout(r,5));
 // The timer of vigia.mjs: stop the commands, record the cut, then (while the toast shows) the killed test comes back.
 for(const a of Object.values(readAttempts(f.outDir)).filter(a=>a.status==='running'))timedOut(config,a);
 kill();const r=await round;
 const a=readAttempts(f.outDir)['o11-11.55.93-odc-1.7.30'];
 assert.equal(a.status,'deferred');assert.equal(a.code,'round-timeout');assert.equal(r.status,'deferred');
 assert.equal(fs.existsSync(path.join(f.outDir,'o11-11.55.93-odc-1.7.30','FALHAS.md')),false,'no FALHAS beside the cut');
 assert.ok(fs.existsSync(path.join(f.outDir,'o11-11.55.93-odc-1.7.30','AGUARDANDO.md')));
 assert.ok(!f.notes.includes('SSAM: Studio version checks failed'));
});
test('a round stopped at its time limit leaves its attempt deferred with its notice',async t=>{
 const f=fixture(t);const r=await f.round();const a={...readAttempts(f.outDir)[r.id],status:'running'};
 timedOut({outDir:f.outDir},a);const b=readAttempts(f.outDir)[r.id];assert.equal(b.status,'deferred');assert.equal(b.code,'round-timeout');assert.ok(fs.existsSync(path.join(r.dir,'AGUARDANDO.md')));
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
 await runVigia({manifest,observed:[],state:{},outDir:f.outDir,now:T0+7200000},f.ops);
 assert.equal(fs.existsSync(path.join(f.outDir,'PENDENTE.md')),false,'a resolved notice never reads as current');assert.ok(fs.existsSync(path.join(f.outDir,'PENDENTE.resolved.md')));
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
  if(args.includes('-i')){assert.ok(options.input.includes('private-mcp-token'));assert.ok(options.input.includes('"o11Hook":"dev"'));assert.ok(options.input.includes('"tools":93'));assert.ok(options.input.includes('"coreBytes":34097'),'the core ceiling is checked too');return {code:0,stdout:JSON.stringify({ok:true,tools:93,totalBytes:261000}),stderr:''};}
  return {code:0,stdout:'',stderr:''};};
 // R1: the test server's state and features go to a private folder, never into the evidence folder (C:/t/vigia/<pair>).
 const evidence=path.join(dir,'evidence'),privateDir=path.join(dir,'private');const mounts=[];
 const result=await smokeImage({pair:{image,tag:'test',odc:'1.7.30',o11:'11.55.93'},bundle:{features},dir:evidence,root:dir,docker:async(args,o)=>{if(args[0]==='run')mounts.push(...args.filter(a=>/:\/data\//.test(a)));return docker(args,o);},served:{odc:['1.7.30'],o11:['11.55.93','11.55.92']},budget:{tools:93,totalBytes:262000,coreBytes:34097,core:['ssam_doctor']},pack:{odcBridgeAccepted:['v99']},privateDir});
 assert.ok(mounts.length&&mounts.every(m=>m.startsWith(privateDir.replaceAll('\\','/'))),'state, features and cache mounted from the private folder');
 assert.deepEqual(fs.readdirSync(evidence).filter(n=>!/^(kernel\.json|smoke-server\.log|commands\.jsonl|command-\d+\.log)$/.test(n)),[],'only evidence in the watcher folder');
 assert.deepEqual(fs.readdirSync(privateDir),[],'the private state is removed');
 await assert.rejects(smokeImage({pair:{image,tag:'t',odc:'1.7.30',o11:'11.55.93'},bundle:{features},dir:evidence,root:dir,docker,served:{},budget:{tools:1,totalBytes:1}}),/private folder/);
 assert.equal(result.ok,true);assert.equal(fs.existsSync(path.join(dir,'segredo')),false);assert.ok(commands.some(x=>x[0]==='rm'&&x.includes('-v')));assert.doesNotMatch(JSON.stringify(commands),/private-mcp-token|private-agent-token/);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(evidence,'kernel.json'),'utf8')).odcBridgeAccepted,['v99']);
 await assert.rejects(smokeImage({pair:{image,tag:'t',odc:'1.7.30',o11:'11.55.93'},bundle:{features},dir,root:dir,docker,served:{}}),/listing budget/);
});
test('the listing budget is one file shared by the rehearsal, the smoke and the facade budget test',()=>{
 const budget=JSON.parse(fs.readFileSync(new URL('../coolify/listing-budget.json',import.meta.url),'utf8'));
 const facade=fs.readFileSync(new URL('../../platforms/odc/facade/tests/hosted-listing-budget.test.mjs',import.meta.url),'utf8');
 assert.equal(Number(/HOSTED_LISTING_CEILING = (\d+)/.exec(facade)[1]),budget.totalBytes);assert.equal(Number(/HOSTED_CORE_CEILING = (\d+)/.exec(facade)[1]),budget.coreBytes);
 assert.deepEqual([.../const CORE = \[([^\]]+)\]/s.exec(facade)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]),budget.core);
 const rehearse=fs.readFileSync(new URL('../coolify/rehearse.mjs',import.meta.url),'utf8');assert.match(rehearse,new RegExp('tools\\.length,'+budget.tools));
});
function approvalOps(f,{digest='sha256:'+sha('a'),already=false}={}){
 const calls=[];
 return {calls,ops:{log(){},manifest:()=>manifest,verifyBranch:async(b,c)=>calls.push(['branch',b,c]),verifyLocalImage:async b=>calls.push(['image',b.tag]),publish:async b=>{calls.push(['publish',b.tag]);return {digest,already};},
  pin:async(m,branch)=>{calls.push(['pin',branch,m]);return {commit:'d'.repeat(40)};},archiveDeploy:async(commit,file)=>{calls.push(['archive',commit]);fs.writeFileSync(file,'tar');}}};
}
const domains={ssam:'mcp.example.test',console:'panel.example.test'};
test('-Approve prints the owner steps in the runbook order: the new compose and its stopped containers BEFORE kernel and features, Redeploy last',async t=>{
 const f=fixture(t);const r=await f.round();const a=approvalOps(f);
 const all=(await approve({outDir:f.outDir,domains},a.ops,r.id)).steps,steps=all.slice(all.indexOf('What is left'));
 const at=re=>{const m=re.exec(steps);assert.ok(m,'missing: '+re);return m.index;};
 const order=[/maintenance window/,/ssamctl\.sh backup/,/deploy-[0-9a-f]{7}\.tar\.gz/,/In Coolify, replace the compose/,/ssamctl\.sh status/,/kernel write --version odc=1\.7\.30/,/features put --version odc=1\.7\.30/,/rm \/tmp\/ssam-vigia\/Features\.plain\.xml/,/\n\d+\. Redeploy in Coolify/,/SESSION_REROUTED/];
 const positions=order.map(at);assert.deepEqual([...positions].sort((x,y)=>x-y),positions,'steps out of order');
 assert.ok(!/Redeploy/.test(steps.slice(0,at(/kernel write/)).replace(/without a Redeploy/g,'')),'no Redeploy before the kernel is written');
 assert.match(steps,/candidates: none/,'says what the selector error means');
 assert.ok(a.calls.some(c=>c[0]==='archive'&&c[1]==='d'.repeat(40)),'the deploy folder comes from the pin commit');
 assert.doesNotMatch(steps,new RegExp(f.outDir.replace(/[\\.]/g,'\\$&')+'[^\\n]*Features\\.plain\\.xml'),'the features never sit in the watcher folder');
});
test('-Approve refuses a pair main already serves (published by hand), before publishing',async t=>{
 const f=fixture(t);const r=await f.round();const a=approvalOps(f);
 const served=structuredClone(manifest);served.odc.unshift({version:'1.7.30',tag:'manual',image,sha256:sha('f')});served.o11.unshift({version:'11.55.94',tag:'manual',image,sha256:sha('f')});served.odc.pop();served.o11.pop();
 a.ops.manifest=()=>served;
 await assert.rejects(approve({outDir:f.outDir,domains},a.ops,r.id),/main already serves/);assert.ok(!a.calls.some(c=>c[0]==='publish'));
});
test('-Approve checks, publishes (simulated), pins the published digest and prints what is left and the way back',async t=>{
 const f=fixture(t);const r=await f.round();const a=approvalOps(f);
 const done=await approve({outDir:f.outDir,domains},a.ops,'odc-1.7.30');
 assert.equal(done.status,'approved');assert.deepEqual(a.calls.map(c=>c[0]),['branch','image','publish','branch','pin','archive']);
 const pinned=a.calls[4][2];assert.equal(pinned.odc[0].sha256,sha('a'));assert.equal(pinned.o11[0].sha256,sha('a'));
 assert.match(done.steps,/kernel write --version odc=1\.7\.30/);assert.match(done.steps,/compose\.coolify\.literal\.yml/);assert.match(done.steps,/Way back \(if the checks fail\): paste .*compose\.rollback\.literal\.yml/);assert.match(done.steps,/latest was not moved/);
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
test('-Approve checks the configuration before publishing and resumes an approval stopped half-way without publishing or pinning twice',async t=>{
 const f=fixture(t);const r=await f.round();
 const none=approvalOps(f);await assert.rejects(approve({outDir:f.outDir},none.ops,r.id),/domains/);assert.equal(none.calls.length,0,'nothing published without the domains');
 const a=approvalOps(f);a.ops.pin=async()=>{a.calls.push(['pin']);throw Error('disk full');};
 await assert.rejects(approve({outDir:f.outDir,domains},a.ops,r.id),/disk full/);
 assert.equal(readAttempts(f.outDir)[r.id].status,'proposed');assert.ok(readAttempts(f.outDir)[r.id].published);
 const b=approvalOps(f);const done=await approve({outDir:f.outDir,domains},b.ops,r.id);
 assert.equal(done.status,'approved');assert.deepEqual(b.calls.map(c=>c[0]),['branch','pin','archive'],'resumed at the pin: no second publication');
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
test('one round at a time: the lock names its processes by pid AND start time; a reused pid is stale, a live orphan round holds it',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-lock-'));try{
  const file=path.join(dir,'vigia.lock'),starts={[process.pid]:'2026-10-28T10:00:00.000Z',4242:'2026-10-28T10:00:05.000Z'};
  const identity=pid=>starts[pid]??null,opts={identity};
  const a=acquireLock(file,opts);assert.ok(a.token);
  assert.ok(acquireLock(file,opts).busy,'held by the live launcher');
  a.release();const b=acquireLock(file,opts);assert.ok(b.token);b.release();
  // The launcher died and Windows gave its pid to another process: another start time, so the lock is stale.
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,started:'2026-10-27T01:00:00.000Z',token:'old',at:new Date().toISOString()}));
  const c=acquireLock(file,opts);assert.ok(c.token,'pid reused by another process: stale');
  // The launcher was killed (8 h limit) but its round process lives on: still held.
  registerChild(file,c.token,4242,opts);starts[process.pid]=null;
  const d=acquireLock(file,opts);assert.ok(d.busy,'the orphan round still runs');assert.equal(d.busy.child.pid,4242);
  starts[4242]=null;const e=acquireLock(file,opts);assert.ok(e.token,'both gone: stale');
  // R2: when the start time cannot be read (CIM failed) but the pid lives, the holder counts as live.
  starts[process.pid]='alive';assert.ok(acquireLock(file,opts).busy,'unreadable identity of a live pid: held');
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
test('M2: test and build failures of the machine (restore, network, timeout, a baseline that does not build) wait; the code\'s fail',async()=>{
 const {testCause,buildCause}=await import('./runtime.mjs');
 assert.equal(testCause({stdout:'error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.',stderr:''},'candidate',false).environmental,true);
 assert.equal(testCause({stdout:'',stderr:'\n(timed out after 5400000 ms)'},'candidate',true).environmental,true);
 assert.equal(testCause({stdout:'error CS0518: Predefined type System.Object is not defined',stderr:''},'baseline',false).environmental,true,'the default pair must build: the machine');
 assert.equal(testCause({stdout:'error CS0518: Predefined type System.Object is not defined',stderr:''},'candidate',false).environmental,false,'the candidate not building is the version');
 assert.equal(buildCause({stdout:'ERROR: failed to solve: failed to resolve source metadata for docker.io/library/node:24: failed to do request: dial tcp: lookup registry-1.docker.io: no such host',stderr:''}).environmental,true);
 assert.equal(buildCause({stdout:'',stderr:'toomanyrequests: You have reached your pull rate limit'}).environmental,true);
 assert.equal(buildCause({stdout:'build: the client-name guard FAILED: a client name would ship; nothing was built',stderr:''}).environmental,false);
 assert.equal(buildCause({stdout:'#12 ERROR: process "/bin/sh -c dotnet publish" did not complete successfully: exit code: 1',stderr:''}).environmental,false);
});
test('the notice day is the local calendar day',()=>{assert.match(localDay(T0),/^\d{4}-\d{2}-\d{2}$/);});
