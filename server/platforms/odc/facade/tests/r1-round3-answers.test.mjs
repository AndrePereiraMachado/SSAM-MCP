import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as policy from '../answer-size.mjs';
import { exposedValue, presentedDocument } from '../exposure.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { fileOrigin, answerFolders } from '../reference-files.mjs';
import { runWithExecutor } from '../executor.mjs';
const bytes=v=>Buffer.byteLength(JSON.stringify(v));
const rootOf=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'round3-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const calls=v=>[v.omitted,...(v.omitted?.more??[])].filter(Boolean);
const extras={studioWarning:'w'.repeat(1600)};
const problems=n=>Array.from({length:n},(_,i)=>({code:'INVALID',pointer:`/ops/${i}`,message:'Problem detail. '.repeat(32)}));
test('round 3.1: final fitting and every evidence page preserve licensee exposure',t=>{
 const root=rootOf(t),origin={tool:'ssam_job',kind:'check-job'};
 const reader=createEvidenceReader({roots:[root],present:{originOf:file=>fileOrigin(file,{answers:answerFolders({root})}),apply:(doc,o)=>presentedDocument(doc,{exposure:'licensee',origin:o,handleRoots:[root]})}});
 for(const n of [40,80]){
  const raw={ok:false,problems:problems(n).map(p=>({...p,message:p.message+' Anvil.Core.Kernel.Verbs'}))};
  const fitted=policy.fitAnswer('ssam_job',{},raw,{root,origin});
  const exposed=exposedValue(fitted,{exposure:'licensee',tool:'ssam_job',handleRoots:[root]});
  const final=policy.fitFinal(exposed,extras,{tool:'ssam_job',args:{},root,origin});
  assert.ok(bytes(final)<=9216);assert.doesNotMatch(JSON.stringify(final),/Anvil\.Core/);
  for(const call of calls(final)){let a={...call.arguments};for(;;){const page=reader.read(a);assert.equal(page.ok,true);assert.doesNotMatch(JSON.stringify(page),/Anvil\.Core/);if(!Number.isInteger(page.next))break;a={...a,offset:page.next};}}
 }
});
test('round 3.2: presented existing reads survive wrapping and recover every hidden item',t=>{
 const root=rootOf(t),raw={ok:false,problems:problems(80)};
 const inner=policy.fitAnswer('o11_deliver',{},raw,{root});const shown=structuredClone(inner);
 const existing=calls(shown);const files=new Map();for(const c of existing){const file=c.arguments.file;c.arguments.file='ws:o11/answers/'+path.basename(file);files.set(c.arguments.file,file);}
 const final=policy.fitAnswer('ssam_code',{action:'write'},{...shown,continuations:{grammar:{tool:'ssam_code',arguments:{action:'grammar'}}}},{root});
 assert.ok(bytes(final)<=9216);assert.equal(final.problems.length+(final.problemsLeft??0),80);
 assert.ok(calls(final).some(c=>files.has(c.arguments.file)),'the earlier read remains present');
 const reader=createEvidenceReader({roots:[root]}), recovered=[];
 for(const c of calls(final)){let a={...c.arguments,file:files.get(c.arguments.file)??c.arguments.file};for(;;){const r=reader.read(a);assert.equal(r.ok,true);recovered.push(...(r.items??r.value??[]));if(!Number.isInteger(r.next))break;a={...a,offset:r.next};}}
 for(let i=final.problems.length;i<80;i++)assert.ok(recovered.some(p=>p.pointer===`/ops/${i}`||p.at===`/ops/${i}`),`missing ${i}`);
});
test('round 3.3: a wrapper rewrite is not reverted by refitting',t=>{
 const root=rootOf(t),inner=policy.fitAnswer('o11_deliver',{}, {ok:false,error:'Delivery wording',problems:problems(80)},{root});
 const input={...inner,error:'Code line 3 needs correction',problems:inner.problems.map(p=>({...p,message:'CODE WORDS '+p.message})),continuations:{grammar:{tool:'ssam_code',arguments:{pad:'g'.repeat(7000)}}}};
 const final=policy.fitAnswer('ssam_code',{action:'write'},input,{root});assert.equal(final.error,input.error);assert.ok(final.problems.every(p=>p.message.startsWith('CODE WORDS')));assert.ok(bytes(final)<=9216);
});
test('round 3.4: hosted final options use the common answer folder and the supplied full origin',t=>{
 const root=rootOf(t),origin={tool:'ssam_reference',kind:'check-job'},context={hosted:true,workspace:root,executor:{call(){}}};
 assert.equal(typeof policy.finalFitOptions,'function');
 const options=policy.finalFitOptions({workspace:root,tool:'ssam_reference',args:{lane:'odc',kind:'check-job'},origin});
 assert.equal(options.directory,path.join(root,'o11','answers'));assert.equal(options.origin,origin);
 runWithExecutor(context,()=>{const final=policy.fitFinal({ok:false,problems:problems(15)},extras,options);for(const c of calls(final))assert.deepEqual(fileOrigin(c.arguments.file,{answers:answerFolders({directory:options.directory})}),origin);});
});
test('round 3.5: compact nested containers remain objects with scalar identities',t=>{
 const root=rootOf(t),modules=Array.from({length:60},(_,i)=>({name:`Module${i}`,status:'broken',count:3,errors:problems(3)}));
 const final=policy.fitAnswer('o11_studio',{command:'errors'},{ok:true,modules},{root});assert.ok(bytes(final)<=9216);
 assert.ok(final.modules.length);for(const [i,item]of final.modules.entries()){assert.equal(typeof item,'object');assert.equal(item.name,modules[i].name);assert.equal(item.status,'broken');assert.equal(item.count,3);assert.equal(item.omitted,true);}assert.ok(calls(final).some(c=>c.arguments.pointer==='/modules'));
});
test('round 3.6: a final pass without a producing contract preserves content',()=>{
 const input={ok:true,text:'source\n'.repeat(4500)};assert.deepEqual(policy.fitFinal(structuredClone(input),extras),{...input,...extras});
});
test('round 3.7: drive and network paths with spaces remain whole or absent',()=>{
 for(const p of ['C:\\Program Files\\SSAM Server\\kernel\\.local\\cli\\anvil.dll','\\\\Server Name\\Shared Folder\\kernel\\.local\\cli\\anvil.dll']){
  const text='The kernel stopped while reading the producer capture and could not continue with the delivery of the module; it looked under '+p+' and gave up';
  for(const max of [100,120,140,160,180,240]){const compact=policy.oneLine(text,max);assert.ok(compact.length<=max);assert.ok(!compact.includes('anvil.dll')||compact.includes(p),compact);assert.ok(!compact.includes('SSAM Server')||compact.includes(p),compact);assert.ok(!compact.includes('Shared Folder')||compact.includes(p),compact);}
 }
 const url='https://example.test/C:/folder/item?key=1';
 for(let max=20;max<=180;max++){const out=policy.oneLine('prefix '.repeat(5)+url+' suffix '.repeat(5),max);assert.ok(!out.includes('example.test')||out.includes(url));assert.equal(out,out.toWellFormed());assert.ok(out.length<=max);}
 const p='C:\\Program Files\\SSAM Server\\kernel\\.local\\cli\\anvil.dll';
 for(const max of [100,120,140,160,180]){const text=policy.oneLine('The producer could not be loaded. '.repeat(4)+p+' and stopped',max);const out=exposedValue({message:text},{exposure:'licensee',tool:'o11_deliver'});assert.doesNotMatch(out.message,/Server\\kernel|anvil\.dll|Program Files/);}
});
