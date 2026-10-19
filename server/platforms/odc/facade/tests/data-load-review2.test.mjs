import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDataLoad,o11DataChannel,odcDataChannel} from '../data-load.mjs';
import {afterPreview,ownerClose,withoutWords} from './helpers/owner-words.mjs';
import {withOwnerConsent} from './helpers/owner-words.mjs';
const entity={name:'Item',key:'entity-Item',identifier:'Id',attributes:[{name:'Id',type:'Item Identifier'},{name:'Code',type:'Text'},{name:'Name',type:'Text'}]};
function fixture(t,lane){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'review2-core-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'rows.json'),oml=path.join(root,'synthetic.oml');fs.writeFileSync(oml,'synthetic');fs.writeFileSync(file,JSON.stringify([{Code:'A',Name:'a'},{Code:'B',Name:'b'}]));
 const input={lane,host:'synthetic.test',module:'M',entity:'Item',operation:'insert',files:[file],oml,keys:['Code'],batchSize:1,deadlineMs:1000,operationId:'23000000-0000-4000-8000-000000000001',authorization:'write synthetic',authorize:'write synthetic'};
 const db=[];let clock=0,writes=0;
 const channel={schema:async()=>({moduleKey:'module-m',entities:[entity]}),check:async()=>({ok:true}),readAll:async()=>({records:db,more:false}),write:async ops=>{writes++;clock+=1000;return ops.map(op=>{const ids=op.records.map(row=>{const id=String(db.length+1);db.push({Id:id,...row});return id;});return{ok:true,ids};});}};
 return{root,file,input,db,channel,options:{journalRoot:path.join(root,'loads'),now:()=>clock},writes:()=>writes};
}
for(const lane of ['o11','odc'])for(const reason of ['reused','authorization'])test(`${lane}: resumed ${reason} refusal preserves durable writes and reserves the original load`,async t=>{
 const f=fixture(t,lane);if(lane==='o11'){ // Kernel grouping permits ten operations per call; keep only one pending group.
   const write=f.channel.write;f.channel.write=async ops=>[...(await write(ops.slice(0,1))),...ops.slice(1).map(()=>({ok:false,outcome:'not-submitted'}))];
 }
 const first=await runDataLoad(f.input,f.channel,f.options);assert.equal(first.written,1);
 const original=JSON.parse(fs.readFileSync(first.receiptFile,'utf8'));
 let next={...f.input,deadlineMs:60000};
 if(reason==='keys')f.db.push({Id:'external',Code:'B',Name:'different'});
 if(reason==='reused')fs.writeFileSync(f.file,JSON.stringify([{Code:'changed'}]));
 if(reason==='authorization'){next.authorization='';next.authorize='';}
 const out=await runDataLoad(next,f.channel,f.options);
 // Owner decision of 2026-10-17 (CX13 U1/F12): a resumed validated plan takes the load's words from the plan; a
 // continuation without them resumes, it is never refused for missing words.
 if(reason==='authorization'){assert.equal(out.complete,true,JSON.stringify(out));assert.equal(out.written,2);assert.equal(f.writes(),2);return;}
 assert.equal(out.ok,false);assert.equal(out.written,1);assert.equal(out.inserted,1);assert.equal(out.receiptFile,first.receiptFile);assert.doesNotMatch(out.error,/before any write/i);assert.match(out.error,/1.*written/i);
 assert.match(out.next,/resume|close/i);assert.deepEqual(JSON.parse(fs.readFileSync(first.receiptFile,'utf8')),original);
 const blocked=await runDataLoad({...f.input,operationId:'23000000-0000-4000-8000-000000000002'},f.channel,f.options);assert.equal(blocked.code,'DATA_ENTITY_LOAD_BUSY');assert.equal(f.writes(),1);
 if(reason==='keys')f.db.pop();
 if(reason==='reused')fs.writeFileSync(f.file,JSON.stringify([{Code:'A',Name:'a'},{Code:'B',Name:'b'}]));
 const done=await runDataLoad({...f.input,deadlineMs:60000},f.channel,f.options);assert.equal(done.complete,true,JSON.stringify(done));assert.equal(f.db.length,2);assert.equal(new Set(f.db.map(row=>row.Code)).size,2);
 const writes=f.writes();await runDataLoad(f.input,f.channel,f.options);assert.equal(f.writes(),writes);assert.equal(f.db.length,2);
});
for(const lane of ['o11','odc'])test(`${lane}: contradictory Success closes the old load even when readback no longer finds the row`,async t=>{
 const f=fixture(t,lane);fs.writeFileSync(f.file,JSON.stringify([{Code:'A',Name:'a'}]));let sends=0;
 const native=()=>{sends++;return{ok:false,reports:[{status:'Success',recordId:'8',clientRecordId:lane==='o11'?'new-0':'new-1',error:'post-write diagnostic'}],ids:['8']};};
 const channel=lane==='o11'?o11DataChannel({call:f.input,work:path.join(f.root,'work'),runAnvil:async argv=>argv.includes('--schema')?{moduleKey:'module-m',entities:[entity]}:argv.includes('--check')?{ok:true}:JSON.parse(fs.readFileSync(argv[argv.indexOf('--request')+1],'utf8')).batch[0].operation==='read-all'?{records:[],more:false}:native()}):odcDataChannel({module:'M',entity:'Item',studioData:async args=>args.op==='read'?{ok:true,tenant:'fake.tenant',identifier:'Id',moduleKey:'module-m',entityKey:'entity-e',attributes:entity.attributes,records:[],more:false}:native()});
 const first=await runDataLoad(f.input,channel,f.options);assert.equal(first.outcome,'uncertain');
 const preview=await runDataLoad({...f.input,close:{preview:true}},channel,f.options);assert.equal(preview.closePreview.counts.uncertain,1);const closed=await runDataLoad({...f.input,close:{previewSha256:preview.closePreview.sha256,authorize:ownerClose(preview)}},channel,afterPreview(f.options));assert.equal(closed.state,'closed');const second=await runDataLoad(f.input,channel,f.options);assert.equal(second.code,'DATA_LOAD_CLOSED');assert.equal(second.receiptFile,first.receiptFile);assert.equal(sends,1);assert.match(second.next,/new.*operationId/i);
 const journal=fs.readFileSync(path.join(f.root,'loads',f.input.operationId,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(journal.find(j=>j.kind!=='resume').manualReconciliationRequired,true);
});
test('refusal counts successful child rows of a partially failed batch',async t=>{
 const f=fixture(t,'odc');f.input.batchSize=2;f.channel.write=async()=>[{ok:false,outcome:'failed',successfulRows:[{index:0,id:'8'}],failedRows:[{index:1,reason:'too long'}],ids:['8']}];
 const first=await runDataLoad(f.input,f.channel,f.options);assert.equal(first.written,1);
 fs.writeFileSync(f.file,JSON.stringify([{Code:'changed'}]));const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.written,1);assert.match(out.error,/1.*written/i);assert.equal(out.receiptFile,first.receiptFile);assert.match(out.next,/resume|close/i);
});
for(const lane of ['o11','odc'])for(const outcome of ['failed','reused'])test(`${lane}: ${outcome} next resumes the reserved original load`,async t=>{
 const f=fixture(t,lane);f.input.batchSize=2;f.channel.write=async()=>outcome==='failed'?[{ok:false,outcome:'failed',failedRows:[{index:0,reason:'deterministic failure'},{index:1,reason:'deterministic failure'}],successfulRows:[]}]:[{ok:false,outcome:'not-submitted',code:'DATA_LOAD_ID_REUSED',error:'operationId already belongs to a different request'}];
 const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.ok,false);assert.match(out.next,/resume|close/i);
 const blocked=await runDataLoad({...f.input,operationId:'23000000-0000-4000-8000-000000000002'},f.channel,f.options);assert.equal(blocked.code,'DATA_ENTITY_LOAD_BUSY');
});

for(const lane of ['o11','odc'])test(`${lane}: externally changed natural key is upserted without duplicate insert`,async t=>{
 const f=fixture(t,lane);let first=true;
 f.channel.write=async ops=>{const out=[];for(const op of ops){if(first){first=false;f.db.push({Id:'1',Code:'A',Name:'a'});out.push({ok:true,ids:['1']});continue;}if(!f.db.some(r=>r.Code==='B')){out.push({ok:false,outcome:'not-submitted'});continue;}assert.equal(op.operation,'update');assert.equal(op.records.length,1);assert.equal(op.records[0].Code,'B');Object.assign(f.db.find(r=>r.Code==='B'),op.records[0]);out.push({ok:true,ids:['external']});}return out;};
 const firstOut=await runDataLoad(f.input,f.channel,f.options);assert.equal(firstOut.written,1);f.db.push({Id:'external',Code:'B',Name:'different'});
 const stops=[],done=await withOwnerConsent(runDataLoad,{...f.input,deadlineMs:60000},f.channel,f.options,{stops});assert.equal(stops.length,1);assert.deepEqual(stops[0].updatePreview.rows.map(r=>r.changes),[{Name:{from:'different',to:'b'}}]);assert.equal(done.complete,true,JSON.stringify(done));assert.equal(f.db.length,2);assert.equal(f.db.find(r=>r.Code==='B').Name,'b');assert.equal(new Set(f.db.map(r=>r.Code)).size,2);
});
