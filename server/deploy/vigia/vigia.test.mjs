import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {planWindow,rotateWindow,compareFailures,readTrx,runVigia,detectVersionFolders} from './vigia.mjs';
const image='docker.io/andrepereiramachado/ssam-server';
const manifest={window:2,odc:[{version:'1.7.29',tag:'new',image},{version:'1.7.28',tag:'old',image}],o11:[{version:'11.55.93',tag:'new',image},{version:'11.55.92',tag:'old',image}]};
const candidate={lane:'odc',version:'1.7.30',fullVersion:'1.7.30.12345',studio:'fake'};
test('fake installed folders reveal a new version and dry-run has no writes or operations',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-fake-'));try{
  fs.mkdirSync(path.join(root,'odc'));fs.writeFileSync(path.join(root,'odc/Version.txt'),'1.7.30.12345');
  const observed=detectVersionFolders({odc:path.join(root,'odc')});assert.equal(observed[0].version,'1.7.30');
  const outDir=path.join(root,'output');const result=await runVigia({manifest,observed,dryRun:true,outDir},new Proxy({},{get(){throw Error('Dry-run invoked an operation');}}));
  assert.equal(result.status,'dry-run');assert.equal(result.plan.candidates.length,1);assert.equal(fs.existsSync(outDir),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('test failures are compared by full name even when counts match',()=>{
 const diff=compareFailures({failures:['Old failure']},{failures:['New failure']});assert.deepEqual(diff.newFailures,['New failure']);assert.deepEqual(diff.resolved,['Old failure']);
 const parsed=readTrx('<Results><UnitTestResult testName="A &amp; B" outcome="Failed"/><UnitTestResult testName="C" outcome="Passed"/></Results>');assert.deepEqual(parsed.failures,['A & B']);assert.equal(parsed.total,2);
 assert.throws(()=>readTrx('<Results/>'),/No test results/);
});
test('rotation keeps a bounded pair window and lists customers losing a served version',()=>{
 const next=rotateWindow(manifest,{odc:'1.7.30',o11:'11.55.93',tag:'next',image,sha256:'a'.repeat(64)},{tokens:{tok_old:{customer:'Old',seen:'2026-10-20',odc:{installed:'1.7.28.10'}},tok_new:{odc:{installed:'1.7.29.10'}}}});
 assert.deepEqual(next.manifest.odc.map(x=>x.version),['1.7.30','1.7.29']);assert.equal(next.manifest.o11.length,2);assert.deepEqual(next.leaving.odc,['1.7.28']);assert.deepEqual(next.affected.map(x=>x.token),['tok_old']);
 assert.equal(planWindow(manifest,[{...candidate,version:'1.7.27'}]).candidates.length,0);
});
function fixture(t,failures=[],smokeOk=true){const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-run-'));t.after(()=>fs.rmSync(outDir,{recursive:true,force:true}));const calls=[];return {outDir,calls,ops:{
 checkWorkspace:async()=>calls.push('workspace'),bundle:async()=>{calls.push('bundle');return {odc:'1.7.30',o11:'11.55.93'};},
 test:async(_,kind)=>{calls.push(kind);return {failures:kind==='baseline'?['Known']:failures,total:3};},
 build:async()=>{calls.push('build');return {odc:'1.7.30',o11:'11.55.93',tag:'next',image,sha256:'a'.repeat(64)};},
 smoke:async()=>{calls.push('smoke');return {ok:smokeOk};},propose:async(_,branch)=>{calls.push('propose');assert.equal(branch,'vigia/odc-1.7.30');},notify:async()=>calls.push('notify')
 }};}
test('a new kernel failure stops before build and writes FALHAS with its name',async t=>{
 const f=fixture(t,['Different']);const r=await runVigia({manifest,observed:[candidate],outDir:f.outDir},f.ops);
 assert.equal(r.status,'failed');assert.ok(!f.calls.includes('build'));assert.match(fs.readFileSync(path.join(f.outDir,'odc-1.7.30/FALHAS.md'),'utf8'),/Different/);
});
test('a passing pipeline builds and smokes before creating an approval proposal, never publishing',async t=>{
 const f=fixture(t,['Known']);const r=await runVigia({manifest,observed:[candidate],outDir:f.outDir},f.ops);
 assert.equal(r.status,'proposed');assert.deepEqual(f.calls,['workspace','bundle','baseline','candidate','build','smoke','propose','notify']);
 assert.match(fs.readFileSync(path.join(f.outDir,'odc-1.7.30/PROPOSTA.md'),'utf8'),/owner approval/i);
});
test('a failed image smoke test never changes the proposed window',async t=>{
 const f=fixture(t,[],false);const r=await runVigia({manifest,observed:[candidate],outDir:f.outDir},f.ops);assert.equal(r.status,'failed');assert.ok(!f.calls.includes('propose'));
});
import {smokeImage} from './smoke.mjs';
test('image smoke keeps credentials out of arguments and removes its private state',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-smoke-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const features=path.join(dir,'Features.plain.xml');fs.writeFileSync(features,'<Features/>');const commands=[];
 const docker=async(args,options={})=>{commands.push(args);if(args[0]==='logs')return {code:0,stdout:JSON.stringify({event:'warm',indexes:{ok:true},delivery:{builder:{ok:true},worker:{ok:true}}}),stderr:''};
  if(args.includes('server-token'))return {code:0,stdout:JSON.stringify({token:'private-mcp-token',agentCredential:'private-agent-token'}),stderr:''};
  if(args.includes('-i')){assert.ok(options.input.includes('private-mcp-token'));assert.ok(options.input.includes('"o11Hook":"dev"')); return {code:0,stdout:JSON.stringify({ok:true,tools:92,totalBytes:261330}),stderr:''};}
  return {code:0,stdout:'',stderr:''};};
 const result=await smokeImage({pair:{image,tag:'test',odc:'1.7.30',o11:'11.55.93'},bundle:{features},dir,root:dir,docker,served:{odc:['1.7.30'],o11:['11.55.93','11.55.92']}});
 assert.equal(result.ok,true);assert.equal(fs.existsSync(path.join(dir,'segredo')),false);assert.ok(commands.some(x=>x[0]==='rm'&&x.includes('-v')));assert.doesNotMatch(JSON.stringify(commands),/private-mcp-token|private-agent-token/);
});
test('an unserved observation without an installed Studio is reported without building',async t=>{
 const f=fixture(t);const r=await runVigia({manifest,observed:[],state:{unserved:{odc:{'1.7.30':{tokens:['tok_waiting']}}}},outDir:f.outDir},f.ops);
 assert.equal(r.status,'waiting-for-studio');assert.deepEqual(f.calls,['notify']);assert.ok(fs.existsSync(path.join(f.outDir,'PENDENTE.md')));
 const again=await runVigia({manifest,observed:[],state:{unserved:{odc:{'1.7.30':{tokens:['tok_waiting']}}}},outDir:f.outDir},f.ops);assert.equal(again.status,'waiting-for-studio');assert.deepEqual(f.calls,['notify']);
});

test('old observations do not trigger a release and skipped suites cannot approve one',()=>{
 assert.equal(planWindow(manifest,[],{unserved:{odc:{'1.7.12':{tokens:['old']}}}}).requested.length,0);
 assert.throws(()=>readTrx('<Results><UnitTestResult testName="Skipped" outcome="NotExecuted"/></Results>'),/No executed tests/);
});
