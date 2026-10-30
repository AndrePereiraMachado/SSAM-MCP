import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitAnswer, fitFinal, compactItem, oneLine } from '../answer-size.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { presenter } from '../hosted/policy.mjs';
import { exposedValue } from '../exposure.mjs';
const bytes = v => Buffer.byteLength(JSON.stringify(v));
const rootOf = t => {const root=fs.mkdtempSync(path.join(os.tmpdir(),'round2-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const problems = n => Array.from({length:n},(_,i)=>({code:'INVALID',pointer:`/actions/Action${i}`,message:'The assigned value requires correction. '.repeat(12)}));
const calls = v => [v.omitted,...(v.omitted?.more??[])].filter(Boolean);
test('round 2.1: final fitting reserves extras without prior omission and preserves reads',t=>{
 const root=rootOf(t),extra={studioWarning:'w'.repeat(1600)},raw={ok:false,problems:problems(17)};
 const a=fitAnswer('o11_deliver',{},raw,{root});
 const b=fitFinal(a,extra);assert.ok(bytes(b)<=9216,bytes(b));assert.equal(b.studioWarning,extra.studioWarning);
 const file=b.omitted.arguments.file;assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),raw);
 const read=fitAnswer('o11_inspect',{}, {ok:true,text:'source line\n'.repeat(2200)},{root});
 assert.deepEqual(fitFinal(read,extra),{...read,...extra});
 assert.deepEqual(fitFinal(b,extra),b);
 const refusedPacket=fitAnswer('ssam_discover',{packet:true},{...raw,schemaVersion:'ssam-packet/1'},{root});
 assert.ok(bytes(fitFinal(refusedPacket,extra))<=9216);
});
test('round 2.2: HIGH gets space before LOW regardless of object key order',t=>{
 const root=rootOf(t),high=Array.from({length:12},(_,i)=>({id:`HIGH${i}`,detail:'security '.repeat(80)})),low=Array.from({length:40},(_,i)=>({id:`LOW${i}`,detail:'style '.repeat(60)}));
 const a=fitAnswer('o11_deliver',{}, {ok:true,warnings:low,highWarnings:high},{root});
 const b=fitAnswer('o11_deliver',{}, {ok:true,highWarnings:high,warnings:low},{root});
 assert.equal(a.highWarnings.length,b.highWarnings.length);assert.ok(a.highWarnings.length>=10);assert.deepEqual(a.highWarnings,high.slice(0,a.highWarnings.length));assert.ok(bytes(a)<=9216);
});
test('round 2.3: nested diagnostics share one ancestor read and remain reachable',t=>{
 const root=rootOf(t),reader=createEvidenceReader({roots:[root]});
 for(const field of ['problems','modules']){
 const rows=Array.from({length:60},(_,i)=>({code:'FLOW',name:`Module${i}`,message:'Fix input',messages:Array.from({length:3},(_,j)=>({text:`Message ${i}/${j} `+'detail '.repeat(30)}))}));
 if(field==='modules')for(const r of rows){r.errors=r.messages;delete r.messages;}
 const raw={ok:field!=='problems',[field]:rows};const a=fitAnswer('o11_studio',{},raw,{root});
 assert.ok(bytes(a)<=9216,`${field}: ${bytes(a)}`);assert.equal(calls(a).length,1);
 const file=calls(a)[0].arguments.file;
 for(let i=0;i<60;i++)for(let j=0;j<3;j++){const key=field==='problems'?'messages':'errors';const value=reader.read({file,pointer:`/${field}/${i}/${key}/${j}/text`}).value;assert.equal(value,rows[i][key][j].text);}
 }
});
test('round 2.4: an enlarged fitted refusal preserves received content and existing reads',t=>{
 const root=rootOf(t),raw={ok:false,problems:problems(80)},inner=fitAnswer('o11_deliver',{},raw,{root});
 const extra={grammar:{tool:'ssam_code',arguments:{text:'g'.repeat(7000)}}};
 const a=fitAnswer('ssam_code',{action:'write'},{...inner,continuations:extra},{root});
 assert.ok(bytes(a)<=9216,bytes(a));const file=calls(a)[0].arguments.file;const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(saved.problems,inner.problems);assert.deepEqual(saved.omitted,inner.omitted);assert.deepEqual(saved.continuations,extra);assert.ok(calls(a).some(c=>c.arguments.file===inner.omitted.arguments.file));
});
test('round 2.5: long errors retain a first line and exact recovery without hiding problems',t=>{
 const root=rootOf(t),reader=createEvidenceReader({roots:[root]});
 for(const n of [6000,20000])for(const withProblems of [false,true]){
 const error='Failure detail line.\n'+'x'.repeat(n),p=problems(1),a=fitAnswer('o11_deliver',{}, {ok:false,error,...(withProblems?{problems:p}:{})},{root});
 assert.equal(a.error,'Failure detail line.');assert.equal(a.errorDetail.omitted,true);let args=a.errorDetail.read.arguments,page=reader.read(args),text=page.value;while(page.next!==undefined){page=reader.read({...args,offset:page.next});text+=page.value;}assert.equal(text,error);
 if(withProblems){assert.deepEqual(a.problems,p);assert.ok(Object.keys(a).indexOf('problems')<Object.keys(a).indexOf('error'));}assert.ok(bytes(a)<=9216);
 }
});
test('round 2.6: clipping preserves whole path tokens and exposure alone presents them',()=>{
 const emoji = oneLine('😀'.repeat(100), 24);assert.equal(emoji, emoji.toWellFormed());
 const job='C:\\workspace\\.local\\jobs\\inline\\job123.json';
 const fix='Send basedOn '+job+' with the same words; '+'detail '.repeat(30);
 const c=compactItem({code:'X',message:'Fix input',fix},{line:160});assert.ok(c.fix.includes(job),c.fix);
 assert.equal(oneLine('Failure at Verbs.cs:120',160),'Failure at Verbs.cs:120');
 const server='/data/server/customers/customer7/o11/snapshots/Producer.oml';
 for(const n of [80,100,160]){const text=oneLine('Reason '.repeat(20)+server+' stopped',n);assert.ok(!text.includes('Producer')||text.includes(server));const visible=exposedValue({message:text},{exposure:'licensee',tool:'o11_deliver'});assert.doesNotMatch(visible.message,/Producer|customer7|snapshots/);}
 const p=presenter({workspace:'C:\\workspace',serverRoots:['C:\\server'],pathApi:path.win32});
 const hostedFix=c.fix.replace('C:\\workspace\\.local\\jobs', 'C:\\workspace\\o11\\jobs');
 const presented=p.result({structuredContent:{fix:hostedFix},content:[{type:'text',text:JSON.stringify({fix:hostedFix})}]});assert.match(presented.structuredContent.fix,/ws:.*job123\.json/);
});
test('round 2.7: repeated nextCalls why is deduplicated while arguments remain exact',t=>{
 const why='Use the same saved job to resume the operation without repeating the write.';const c={tool:'ssam_job',arguments:{job:'job.json'},why};
 const a=fitAnswer('o11_deliver',{}, {ok:false,continuation:c,nextCalls:[structuredClone(c)],recovery:[structuredClone(c)]},{root:rootOf(t)});
 assert.equal(a.continuation.why,why);assert.equal(a.nextCalls[0].why,undefined);assert.equal(a.recovery[0].why,undefined);assert.deepEqual(a.nextCalls[0].arguments,c.arguments);
});
test('round 2.8: moving a large continuation restores complete problems when they fit',t=>{
 const p=problems(6),a=fitAnswer('o11_deliver',{}, {ok:false,problems:p,continuation:{tool:'ssam_job',arguments:{job:{text:'x'.repeat(15000)}}}},{root:rootOf(t)});
 assert.equal(a.continuation.omitted,true);assert.deepEqual(a.problems,p);assert.ok(bytes(a)<=9216);
 const long = [{code:'INVALID',message:'m'.repeat(6000)}];
 const restored=fitAnswer('o11_deliver',{}, {ok:false,problems:long,continuation:{tool:'ssam_job',arguments:{job:{text:'x'.repeat(15000)}}}},{root:rootOf(t)});
 assert.deepEqual(restored.problems,long);assert.ok(bytes(restored)<=9216);
});
