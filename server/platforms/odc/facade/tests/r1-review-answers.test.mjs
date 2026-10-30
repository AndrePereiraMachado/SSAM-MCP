import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as policy from '../answer-size.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
const bytes = v => Buffer.byteLength(JSON.stringify(v));
const rootOf = t => { const p=fs.mkdtempSync(path.join(os.tmpdir(),'review-answers-')); t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p; };
const fit=(root,v,tool='o11_deliver',args={})=>policy.fitAnswer(tool,args,v,{root});
const warnings=n=>Array.from({length:n},(_,i)=>({id:`HIGH_${i}`,path:`/actions/Action${i}`,detail:'Parameter mismatch requires correction. '.repeat(10),fix:'Use the declared input type. '.repeat(4)}));
const problems=n=>Array.from({length:n},(_,i)=>({code:'INVALID',pointer:`/actions/Action${i}`,message:'The value cannot be assigned here. '.repeat(15)}));
const calls=v=>[v.omitted,...(v.omitted?.more??[])].filter(Boolean);
const recover=async(root,c,expected)=>{
 const reader=createEvidenceReader({roots:[root]}); let p=await reader.read(c.arguments);assert.equal(p.ok,true);
 if(p.truncated && expected && typeof expected==='object') {const out=Array.isArray(expected)?[]:{};for(const [k,v] of Object.entries(expected))out[k]=await recover(root,{arguments:{...c.arguments,pointer:c.arguments.pointer+'/'+k}},v);return out;}
 let v=p.value??p.items;if(typeof v==='string')while(p.next!==undefined){p=await reader.read({...c.arguments,offset:p.next});assert.equal(p.ok,true);v+=p.value;}return v;
};
test('review 1: final fitting includes immutable gate fields and is pure and idempotent',t=>{
 const root=rootOf(t),a=fit(root,{ok:false,problems:problems(80)}),extra={studioWarning:'Version notice. '.repeat(110),studioSkipped:false};
 const before=JSON.stringify(a); assert.equal(typeof policy.fitFinal,'function'); const b=policy.fitFinal(a,extra);
 assert.ok(bytes(b)<=9216); assert.equal(b.studioWarning,extra.studioWarning); assert.equal(JSON.stringify(a),before); assert.deepEqual(policy.fitFinal(b,extra),b);
});
test('review 2: HIGH entries stay byte-identical and excess entries have one list read',async t=>{
 const root=rootOf(t); for(const n of [9,30]) { const w=warnings(n),a=fit(root,{ok:true,highWarnings:w});
 assert.ok(bytes(a)<=9216); assert.deepEqual(a.highWarnings,w.slice(0,a.highWarnings.length));
 if(n===9) assert.deepEqual(a.highWarnings,w); else {assert.ok(a.highWarningsLeft>0);const c=calls(a).find(c=>c.arguments.pointer==='/highWarnings');assert.ok(c); assert.deepEqual(await recover(root,c),w.slice(c.arguments.offset??0,(c.arguments.offset??0)+(c.arguments.max??w.length)));}
 }
});
test('review 3: read diagnostics never trim source or nested model messages',t=>{
 const root=rootOf(t),text='source line\n'.repeat(3000),a=fit(root,{ok:true,text,warnings:[{message:'Old capture'}]},'o11_inspect'); assert.equal(a.text,text);
 const full={ok:true,elements:Array.from({length:200},(_,i)=>({name:`Screen${i}`,Messages:problems(2),text:'source'.repeat(30)}))};
 assert.deepEqual(fit(root,full,'ssam_map').elements,full.elements);
});
test('review 4: list recovery is not grouped with six document reads',async t=>{
 const root=rootOf(t),p=problems(60),a=fit(root,{ok:false,problems:p,...Object.fromEntries(Array.from({length:6},(_,i)=>[`document${i}`,{text:'x'.repeat(4000)}]))});
 const c=calls(a).find(c=>c.arguments.pointer==='/problems');assert.ok(c);const v=await recover(root,c);assert.ok(Array.isArray(v));assert.deepEqual(v[0],p[c.arguments.offset??0]);
});
test('review 5: executable continuations remain atomic under every next key',async t=>{
 const root=rootOf(t); for(const key of ['continuation','continuations','nextCalls','next']) {const c={tool:'ssam_job',arguments:{lane:'o11',job:{ops:[{text:'x'.repeat(9500)}]}}};const source=key==='nextCalls'?[c]:key==='continuations'?{edit:c}:c;
 const a=fit(root,{ok:false,problems:problems(1),[key]:source});assert.ok(bytes(a)<=9216); if(a[key]?.omitted)assert.deepEqual(await recover(root,a[key].read,source),source);else assert.deepEqual(a[key],source); }
});
test('review 6: compact problems retain exact reads for carried documents and long text',async t=>{
 const root=rootOf(t),current={text:'original source\n'.repeat(3000)},patch={value:'changed source'.repeat(1500)},a=fit(root,{ok:false,problems:[{code:'CHANGED',message:'Fix the changed source.',current,patch,k:'key'.repeat(500)}]});
 assert.ok(bytes(a)<=9216); const p=a.problems[0];assert.ok(p); for(const key of ['current','patch','k']) { const marker=p[key]?.omitted?p[key]:p[key]?.text?.omitted?p[key].text:null;assert.ok(marker, key);const expected=key==='current'&&marker===p.current.text?current.text:({current,patch,k:'key'.repeat(500)})[key];const got=await recover(root,marker.read,expected);assert.deepEqual(got,key==='current'&&marker===p.current.text?current.text:({current,patch,k:'key'.repeat(500)})[key]); }
});
test('review 7: fitted large reads and scalar-heavy legacy answers are byte-idempotent',t=>{
 const root=rootOf(t);for(const [tool,v] of [['o11_inspect',{ok:true,text:'x'.repeat(30000),notes:'n'.repeat(3000)}],['o11_deliver',{ok:true,...Object.fromEntries(Array.from({length:60},(_,i)=>[`id${i}`,'h'.repeat(140)])),omitted:{tool:'ssam_evidence',arguments:{file:'kept.json'},why:'x'.repeat(1000)}}]]) {const a=fit(root,v,tool);assert.equal(JSON.stringify(fit(root,a,tool)),JSON.stringify(a));}
});
test('review 8: explicit discovery refusal variants stay under the ceiling',t=>{
 const root=rootOf(t);for(const key of ['expand','detail','type','catalog'])assert.ok(bytes(fit(root,{ok:false,problems:problems(60)},'ssam_discover',{[key]:true}))<=9216);
});
test('review 9: visible short messages and removed nulls never create pointers',t=>{
 const a=fit(rootOf(t),{ok:false,error:'Name is required',problems:[{code:'REQUIRED',message:'Name is required',fix:null}]});assert.equal(a.omitted,undefined);
});
test('review 10: studioWrites survives pressure from sixty scalars',t=>{
 const root=rootOf(t),studioWrites=Array.from({length:6},(_,i)=>({what:`Reference ${i}`,detail:'r'.repeat(80)})),a=fit(root,{ok:true,studioWrites,...Object.fromEntries(Array.from({length:60},(_,i)=>[`id${i}`,'h'.repeat(140)]))}); assert.deepEqual(a.studioWrites,studioWrites);
});
test('review 11: path clipping retains complete tokens for the exposure layer',()=>{
 const message='The producer capture is missing; '.repeat(5)+'/data/server/customers/customer7/o11/snapshots/Producer_v12.oml and processing stopped';
 const a=policy.compactItem({code:'MISSING',message},{line:100});
 assert.ok(!a.message.includes('Producer') || a.message.includes('/data/server/customers/customer7/o11/snapshots/Producer_v12.oml'));
});
test('review 12: a long error remains whole or has an exact recovery',async t=>{
 const root=rootOf(t),error='Specific failure. '.repeat(40),a=fit(root,{ok:false,error}); assert.equal(a.error,error);
});

test('review 7: the ten largest unomitted recorded answers remain byte-idempotent',{skip:!fs.existsSync('C:/t/bankdash-analise/scratch/calls2.json')},t=>{
 const root=rootOf(t),corpus=JSON.parse(fs.readFileSync('C:/t/bankdash-analise/scratch/calls2.json','utf8'));
 const rows=corpus.flatMap(c=>{try{const value=JSON.parse(c.text);return /__ssam_|__o11_|__studio_/.test(c.name)&&value&&typeof value==='object'&&!value.omitted?[{tool:c.name.split('__').at(-1),args:c.input??{},value}]:[];}catch{return[];}}).sort((a,b)=>bytes(b.value)-bytes(a.value)).slice(0,10);
 assert.equal(rows.length,10);
 for(const row of rows){const a=fit(root,row.value,row.tool,row.args);assert.equal(JSON.stringify(fit(root,a,row.tool,row.args)),JSON.stringify(a));}
});
test('review 3: paginated readers bound only top diagnostics',t=>{
 const root=rootOf(t),text='exact source\n'.repeat(3000),warnings=problems(100);
 const a=fit(root,{ok:true,paged:{file:'page.json'},text,warnings},'ssam_evidence');
 assert.equal(a.text,text);assert.ok(bytes({...a,text:undefined})<=9216);assert.ok(a.omitted);
});
test('review 6: a single oversized refusal message has an exact ready text read',async t=>{
 const root=rootOf(t),message='The input requires a specific correction. '.repeat(1500),a=fit(root,{ok:false,problems:[{code:'INVALID',message}]});
 assert.equal(a.problems[0].message?.omitted,true);assert.equal(await recover(root,a.problems[0].message.read,message),message);
});
