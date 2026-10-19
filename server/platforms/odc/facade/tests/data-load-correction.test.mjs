import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {runDataLoad,o11DataChannel} from '../data-load.mjs';
import {wordsSha256} from '../destructive-operations.mjs'; // review 6: only the sha256 of the owner's words is kept or sent
const entity={name:'Item',key:'entity-Item',identifier:'Id',attributes:[{name:'Id',type:'Item Identifier'},{name:'Code',type:'Text'},{name:'Note',type:'Text'},{name:'Qty',type:'Integer'},{name:'ParentId',type:'Parent Identifier'}]};
const operationId='99999999-1111-4111-8111-111111111111';
function fixture(t,rows,extra={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-correction-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'rows.json'),oml=path.join(root,'model.oml');fs.writeFileSync(file,JSON.stringify(rows));fs.writeFileSync(oml,'synthetic model');let clock=0;
 const input={lane:'o11',host:'synthetic.example',module:'M',entity:'Item',operation:'insert',operationId,authorization:'original user words',files:[file],oml,keys:['Code'],...extra},database=[],calls=[];
 const channel={schema:async()=>({ok:true,moduleKey:'module-m',entities:[entity]}),readAll:async(name,{offset,limit})=>({ok:true,records:database.slice(offset,offset+limit),more:false}),check:async()=>({ok:true}),write:async ops=>{calls.push(ops);return ops.map(op=>{const ids=op.records.map((r,i)=>String(database.length+i+1));database.push(...op.records.map((r,i)=>({Id:ids[i],...r})));return{ok:true,outcome:'completed',ids,successfulRows:ids.map((id,index)=>({index,id}))};});}};
 return{root,file,oml,input,database,calls,channel,options:{journalRoot:path.join(root,'loads'),now:()=>clock},tick:n=>clock+=n,dir:path.join(root,'loads',operationId)};
}
test('H1 empty mapped/null/id-only rows are refused together in both lanes and dryRun',async t=>{
 for(const lane of ['o11','odc'])for(const dryRun of [false,true]){const f=fixture(t,[{}, {Note:null},{Ignored:'x'}],{lane,dryRun,columns:{Ignored:null}});const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.ok,false);assert.equal(out.problems.filter(p=>p.code==='DATA_ROW_EMPTY').reduce((sum,p)=>sum+p.count,0),3);assert.ok(out.problems.some(p=>p.code==='DATA_KEY_NOT_FOUND'));assert.equal(f.calls.length,0);}
 const f=fixture(t,[{Id:'1'}],{operation:'update'});f.database.push({Id:'1',Code:'A'});assert.equal((await runDataLoad(f.input,f.channel,f.options)).code,'DATA_ROW_EMPTY');
});
test('H2/H3 known partial failures retain successes and retry only failed rows under a new UUID',async t=>{
 const f=fixture(t,[{Code:'A'},{Code:'B'},{Code:'C'}],{lane:'odc'});let pendingFirst=true;
 f.channel.write=async ops=>{f.calls.push(ops);if(pendingFirst){pendingFirst=false;f.database.push({Id:'8',Code:'A'},{Id:'10',Code:'C'});return[{ok:false,outcome:'failed',ids:['8','10'],successfulRows:[{index:0,id:'8'},{index:2,id:'10'}],failedRows:[{index:1,reason:'Value too long'}],code:'DATA_WRITE_FAILED',error:'Value too long'}];}f.database.push({Id:'9',...ops[0].records[0]});return[{ok:true,outcome:'completed',ids:['9'],successfulRows:[{index:0,id:'9'}]}];};
 const first=await runDataLoad(f.input,f.channel,f.options);assert.equal(first.outcome,'failed');assert.equal(first.code,'DATA_WRITE_FAILED');assert.equal(first.failedRows[0].file,f.file);assert.equal(first.failedRows[0].row,2);assert.match(first.error,/Value too long/);
 const journal=fs.readFileSync(path.join(f.dir,'journal.jsonl'),'utf8');assert.match(journal,/"state":"failed"/);assert.match(journal,/Value too long/);
 const done=await runDataLoad(f.input,f.channel,f.options);assert.equal(done.complete,true);assert.deepEqual(f.calls[1][0].records,[{Code:'B'}]);assert.notEqual(f.calls[0][0].operationId,f.calls[1][0].operationId);assert.equal(f.database.length,3);
});
test('H2 not-submitted preserves its batch UUID and permits a safe keyed retry',async t=>{
 const f=fixture(t,[{Code:'A'}]);let pendingFirst=true;const write=f.channel.write;f.channel.write=async ops=>{if(pendingFirst){pendingFirst=false;f.calls.push(ops);return[{ok:false,outcome:'not-submitted',code:'STUDIO_BUSY',error:'Studio is busy'}];}return write(ops);};
 const first=await runDataLoad(f.input,f.channel,f.options);assert.equal(first.outcome,'not-submitted');const done=await runDataLoad(f.input,f.channel,f.options);assert.equal(done.complete,true);assert.equal(f.calls[0][0].operationId,f.calls[1][0].operationId);assert.equal(f.database.length,1);
});
test('H4 original authorization is fixed per batch while resumed words are journaled; OML changes refuse reuse',async t=>{
 const f=fixture(t,[{Code:'A'},{Code:'B'}],{lane:'odc',batchSize:1,deadlineMs:1000});const write=f.channel.write;f.channel.write=async ops=>{f.tick(1000);return write(ops);};assert.equal((await runDataLoad(f.input,f.channel,f.options)).complete,false);
 // Review 6 (R6-F15, converted): the plan, the journal and the channel keep only the sha256 of the words.
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'plan.json'))).authorizationSha256,wordsSha256('original user words'));const resumed=await runDataLoad({...f.input,authorization:'resume user words'},f.channel,f.options);assert.equal(resumed.complete,true);assert.equal(f.calls[1][0].authorization,'sha256:'+wordsSha256('original user words'));assert.ok(fs.readFileSync(path.join(f.dir,'journal.jsonl'),'utf8').includes(wordsSha256('resume user words')));assert.doesNotMatch(fs.readFileSync(path.join(f.dir,'journal.jsonl'),'utf8'),/resume user words/);
 const g=fixture(t,[{Code:'A'}]);assert.equal((await runDataLoad(g.input,g.channel,g.options)).complete,true);fs.writeFileSync(g.oml,'changed model');const reused=await runDataLoad(g.input,g.channel,g.options);assert.equal(reused.code,'DATA_LOAD_ID_REUSED');assert.match(reused.next,/done.*receipt/i);assert.equal(g.calls.length,1);
});
test('H7 ODC empty Text normalization is declared with count in dryRun, receipt and plan',async t=>{
 const f=fixture(t,[{Code:'A',Note:''}],{lane:'odc',dryRun:true});const out=await runDataLoad(f.input,f.channel,f.options);assert.deepEqual(out.rules.find(r=>r?.rule==='odc-empty-text-null'),{rule:'odc-empty-text-null',count:1});const plan=JSON.parse(fs.readFileSync(path.join(path.dirname(out.receiptFile),'plan.json')));assert.deepEqual(plan.rules.find(r=>r?.rule==='odc-empty-text-null'),{rule:'odc-empty-text-null',count:1});
});
test('M3 duplicate natural keys are refused on every physical source row',async t=>{
 const f=fixture(t,[{Id:'7',Code:'A',Qty:1},{Id:'7',Code:'A',Qty:2}],{operation:'update',keys:['Code']});f.database.push({Id:'7',Qty:'0'});const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.problemCount,2);assert.equal(out.problems[0].code,'DATA_KEY_DUPLICATE');assert.equal(f.calls.length,0);
});
test('M4 dryRun reads fresh target state rather than a cached validated plan',async t=>{
 const f=fixture(t,[{Code:'A'}],{keys:['Code'],dryRun:true});assert.equal((await runDataLoad(f.input,f.channel,f.options)).inserted,1);f.database.push({Id:'1',Code:'A'});const second=await runDataLoad(f.input,f.channel,f.options);assert.equal(second.inserted,0);assert.equal(second.unchanged,1);assert.equal(f.calls.length,0);
});
test('M5/M6 O11 group transport loss preserves physical file rows, truthful counts and same-load replay',async t=>{
 const f=fixture(t,[]);const csv=path.join(f.root,'rows.csv');fs.writeFileSync(csv,'Code,Note\r\nA,"first\r\nsecond"\r\nB,x\r\n');f.input.files=[csv];f.input.batchSize=1;f.channel.write=async()=>{throw new Error('response lost');};const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.rows,2);assert.equal(out.inserted,0);assert.equal(out.written,0);assert.deepEqual(out.uncertainRows,[{file:csv,rows:'2,4'}]);assert.match(out.next,/resume.*same load/i);assert.ok(out.notes.some(n=>typeof n==='string'&&n.includes('lost')));
});
test('M7 completed kernel receipt with mismatch is never reconciled or rewritten',async t=>{
 const f=fixture(t,[{Code:'A'}],{keys:['Code']});f.channel.write=async ops=>{f.calls.push(ops);f.database.push({Id:'8',Code:'truncated'});return[{ok:false,outcome:'completed',ids:['8'],successfulRows:[{index:0,id:'8'}],code:'DATA_READBACK_MISMATCH',error:'stored text differs'}];};const first=await runDataLoad(f.input,f.channel,f.options);assert.equal(first.batches.done,1);assert.equal(first.written,1);const second=await runDataLoad(f.input,f.channel,f.options);assert.equal(second.complete,true);assert.equal(f.calls.length,1);assert.equal(f.database.length,1);
});
test('M8 parent schema errors preserve notChecked causes and do not invent missing references',async t=>{
 const f=fixture(t,[{Code:'A',ParentId:'parent'}],{lane:'odc',references:{ParentId:{key:'Code'}}});f.channel.schema=async names=>{if(names[0]==='Parent')throw new Error('parent Studio is unavailable');return{moduleKey:'module-m',entities:[entity]};};const out=await runDataLoad(f.input,f.channel,f.options);assert.deepEqual(out.notChecked,['references']);assert.match(out.reason,/parent Studio/);assert.ok(!out.problems.some(p=>p.code==='DATA_REFERENCE_NOT_FOUND'));const evidence=JSON.parse(fs.readFileSync(out.problemsFile));assert.match(evidence.reason,/parent Studio/);assert.equal(f.calls.length,0);
});
test('M9 completed changed-input refusals preserve the existing receipt and direct inspection',async t=>{
 const f=fixture(t,[{Code:'A'}]);const done=await runDataLoad(f.input,f.channel,f.options),receipt=fs.readFileSync(done.receiptFile,'utf8');fs.writeFileSync(f.file,JSON.stringify([{Code:'B'}]));const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.code,'DATA_LOAD_ID_REUSED');assert.match(out.next,/done.*receipt/i);assert.equal(fs.readFileSync(done.receiptFile,'utf8'),receipt);assert.ok(!out.problemsFile.startsWith(f.dir+path.sep));
});
test('M1 resumed never-submitted keys are reread before writing another batch',async t=>{
 const f=fixture(t,[{Code:'A'},{Code:'B'}],{lane:'odc',keys:['Code'],batchSize:1,deadlineMs:1000});const write=f.channel.write;f.channel.write=async ops=>{f.tick(1000);return write(ops);};assert.equal((await runDataLoad(f.input,f.channel,f.options)).complete,false);f.database.push({Id:'foreign',Code:'B',Qty:'9'});const second=await runDataLoad(f.input,f.channel,f.options);assert.equal(second.complete,true);assert.equal(second.inserted,1);assert.equal(second.unchanged,1);assert.equal(f.calls.length,1);assert.equal(f.database.length,2);
});
test('M6 mixed reconciliation counts both the previously written subset and the remaining write',async t=>{
 const f=fixture(t,[{Code:'A'},{Code:'B'}],{lane:'odc',keys:['Code']});let lost=true;
 f.channel.write=async ops=>{f.calls.push(ops);if(lost){lost=false;f.database.push({Id:'8',Code:'A'});throw new Error('lost after the first native row');}f.database.push({Id:'9',...ops[0].records[0]});return[{ok:true,outcome:'completed',ids:['9'],successfulRows:[{index:0,id:'9'}]}];};
 assert.equal((await runDataLoad(f.input,f.channel,f.options)).written,0);const done=await runDataLoad(f.input,f.channel,f.options);assert.equal(done.complete,true);assert.equal(done.inserted,2);assert.equal(done.written,2);assert.equal(f.database.length,2);assert.deepEqual(f.calls[1][0].records,[{Code:'B'}]);
});
test('H2 large failed acknowledgments fit 2 KiB while preserving every ID and failure in receipt evidence',async t=>{
 for(const successCount of [0,500]){const f=fixture(t,Array.from({length:1000},(_,i)=>({Code:String(i)})),{lane:'odc',batchSize:1000});const successfulRows=Array.from({length:successCount},(_,index)=>({index,id:`${index}-${'x'.repeat(1500)}`})),failedRows=Array.from({length:1000-successCount},(_,i)=>({index:i+successCount,reason:'r'.repeat(1000)}));f.channel.write=async()=>[{ok:false,outcome:'failed',ids:successfulRows.map(row=>row.id),successfulRows,failedRows,code:'DATA_WRITE_FAILED',error:'r'.repeat(1000)}];const out=await runDataLoad(f.input,f.channel,f.options);assert.ok(Buffer.byteLength(JSON.stringify(out))<=2048);const full=JSON.parse(fs.readFileSync(out.receiptFile));assert.equal(full.ids.length,successCount);assert.equal(full.successfulRows.length,successCount);assert.equal(full.failedRows.length,1000-successCount);assert.equal(out.written,successCount);}
});
test('H4 authorization audit retains every valid invocation including completed replay',async t=>{
 const f=fixture(t,[{Code:'A'}],{lane:'odc'});for(const authorization of ['first words','second words','third words']){const out=await runDataLoad({...f.input,authorization},f.channel,f.options);assert.equal(out.complete,true);}const journal=fs.readFileSync(path.join(f.dir,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(journal.filter(entry=>entry.kind==='resume').map(entry=>entry.authorizationSha256),['first words','second words','third words'].map(wordsSha256));assert.equal(f.calls.length,1);assert.equal(f.calls[0][0].authorization,'sha256:'+wordsSha256('first words')); // review 6: sha256 only
});
test('M7 READBACK_FAILED completed kernel receipts retain the native error and never write again',async t=>{
 const f=fixture(t,[{Code:'A'}]);let writes=0;const runAnvil=async argv=>{if(argv.includes('--schema'))return{envelope:{ok:true,data:{ok:true,moduleKey:'module-m',entities:[entity]}}};if(argv.includes('--check'))return{envelope:{ok:true,data:{ok:true}}};const request=JSON.parse(fs.readFileSync(argv[argv.indexOf('--request')+1],'utf8'));if(request.batch[0].operation==='read-all')return{records:[],more:false};writes++;return{envelope:{ok:false,data:{ok:false,results:[{ok:false,outcome:'uncertain',code:'DATA_READBACK_FAILED',error:'The write succeeded but reading it back failed',receipt:'completed-kernel-receipt.json',ids:['8'],reports:[{clientRecordId:'new-0',recordId:'8',status:'Success'}]}]}}};};const fresh=()=>o11DataChannel({runAnvil,call:{entity:'Item',module:'M',host:f.input.host,oml:f.oml},work:f.root});
 for(let i=0;i<2;i++){const out=await runDataLoad(f.input,fresh(),f.options);assert.equal(out.ok,false);assert.equal(out.complete,true);assert.equal(out.written,1);assert.equal(out.code,'DATA_READBACK_FAILED');assert.match(out.error,/reading it back failed/);assert.ok(out.notes.some(note=>note?.code==='DATA_READBACK_FAILED'));}assert.equal(writes,1);
});
