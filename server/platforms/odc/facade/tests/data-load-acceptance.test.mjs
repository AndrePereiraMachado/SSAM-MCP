import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { runDataLoad } from '../data-load.mjs';

const operationId='bd919078-e05b-42c2-a44f-c2fceabebb42';
const count=102300;
const target={host:'dev.example.test',module:'Synthetic_CS',oml:'C:\\synthetic\\Snapshot.oml'};
const item={name:'Item',key:'entity-Item',identifier:'Id',attributes:[{name:'Id',type:'Item Identifier',autoNumber:true},{name:'Code',type:'Text'},{name:'Qty',type:'Integer'},{name:'Day',type:'Date'},{name:'ParentId',type:'Parent Identifier'}]};
const parent={name:'Parent',identifier:'Id',attributes:[{name:'Id',type:'Parent Identifier',autoNumber:true},{name:'Slug',type:'Text'}]};
function fixture(t,lane,{size=count,cost=0,keys=true,loseAt,checkProblems}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-acceptance-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'replica.jsonl');
  const oml=path.join(root,'Snapshot.oml');fs.writeFileSync(oml,'synthetic OML bytes; channel schema is injected');
  fs.writeFileSync(file,Array.from({length:size},(_,i)=>JSON.stringify({Code:`K${i+1}`,Qty:i+1})).join('\n'));
  const input={lane,...target,oml,entity:'Item',operation:'insert',files:[file],operationId,authorization:'load synthetic records',...(keys?{keys:['Code']}:{})};
  const db=[],index=new Map(),receipts=new Map(),order=[],batchSizes=[],writes=[],reads=[];
  let clock=0,lost=false,duplicateCount=0,checkCalls=0,budgetEnd=Infinity;
  const channel={
    schema:async()=>({moduleKey:'module-m',entities:[item,parent]}),
    readAll:async(entity,{offset,limit,fields})=>{reads.push({entity,offset,limit,fields});const source=entity==='Parent'?[{Id:'P1',Slug:'known'}]:db;return{ok:true,records:source.slice(offset,offset+limit),complete:offset+limit>=source.length,continuation:offset+limit<source.length?{offset:offset+limit}:undefined};},
    check:async()=>{checkCalls++;return checkProblems?{ok:false,problems:checkProblems}:{ok:true};},
    write:async ops=>{
      assert.ok(ops.length<=(lane==='o11'?10:1));
      assert.ok(clock+ops.length*cost<=budgetEnd,'no group starts without time to finish it');
      const results=[];
      for(const op of ops) {
        clock+=cost;
        if(receipts.has(op.operationId)) {results.push({...receipts.get(op.operationId),replayed:true});continue;}
        const ids=[];batchSizes.push(op.records.length);writes.push(op);
        for(const record of op.records) {
          if(op.operation==='insert') {
            if(index.has(record.Code)) duplicateCount++;
            const id=String(db.length+1);db.push({Id:id,...record});index.set(record.Code,id);ids.push(id);order.push(record.Code);
          } else {const row=db.find(r=>r.Id===record.Id);assert.ok(row);Object.assign(row,record);ids.push(row.Id);}
        }
        const result={ok:true,ids};receipts.set(op.operationId,result);results.push(result);
        if(loseAt && !lost && op.batch+1===loseAt) {lost=true;throw new Error('synthetic response lost after write');}
      }
      return results;
    },
  };
  const options={journalRoot:path.join(root,'loads'),now:()=>clock};
  return{root,file,input,channel,options,db,order,batchSizes,writes,reads,duplicates:()=>duplicateCount,checks:()=>checkCalls,armBudget:ms=>{budgetEnd=clock+ms;}};
}
const byteLength=value=>Buffer.byteLength(JSON.stringify(value));
function argsOf(input) {
  const {lane,operation,host,module,oml,authorization,...request}=input;
  return lane==='o11'?{host,module,oml,request:{operation,authorization,...request}}:{module,operation,authorize:authorization,...request};
}
const emit=(t,name,value)=>t.diagnostic(`CX13_METRIC ${JSON.stringify({name,...value})}`);

test('102300 rows use one small file-reference call and 1023 ordered batches in both lanes',async t=>{
  for(const lane of ['o11','odc']) {
    const f=fixture(t,lane);
    const args=argsOf(f.input),argumentBytes=byteLength(args);
    assert.ok(argumentBytes<=2048);
    const started=performance.now();const result=await runDataLoad(f.input,f.channel,f.options);const wallMs=performance.now()-started;
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.complete,true);assert.equal(result.inserted,count);
    assert.equal(f.writes.length,1023);assert.equal(f.db.length,count);assert.equal(f.duplicates(),0);
    assert.ok(f.batchSizes.every(n=>n===100));assert.equal(f.order[0],'K1');assert.equal(f.order.at(-1),`K${count}`);
    for(let i=0;i<f.order.length;i++)assert.equal(f.order[i],`K${i+1}`);
    assert.ok(byteLength(result)<=2048);
    const n=f.writes.length;const replay=await runDataLoad(f.input,f.channel,f.options);
    assert.equal(replay.complete,true);assert.equal(f.writes.length,n);
    emit(t,`bulk-${lane}`,{argumentBytes,rows:f.db.length,batches:f.writes.length,duplicates:f.duplicates(),receiptBytes:byteLength(result),wallMs,maxRssKiB:process.resourceUsage().maxRSS});
  }
});

test('1000 real-shaped envelopes load 100000 synthetic rows and explicitly record ignored operationId',async t=>{
  for(const lane of ['o11','odc']) {
    const f=fixture(t,lane,{size:1});
    const files=[];
    for(let i=0;i<1000;i++) {
      const file=path.join(f.root,`opt-${String(i+1).padStart(4,'0')}.json`);
      fs.writeFileSync(file,JSON.stringify({module:target.module,entity:'Item',operationId:`old-${i}`,count:100,records:Array.from({length:100},(_,k)=>({Code:`F${i*100+k}`,Qty:k}))}));files.push(file);
    }
    const result=await runDataLoad({...f.input,files},f.channel,f.options);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.inserted,100000);assert.equal(f.writes.length,1000);assert.equal(f.duplicates(),0);
    assert.deepEqual(result.files.count,1000);assert.ok(byteLength(result)<=2048);
    const full=JSON.parse(fs.readFileSync(result.receiptFile,'utf8'));
    assert.equal(full.files.length,1000);assert.equal(full.notes.filter(n=>n.ignoredKeys?.includes('operationId')).length,1000);
    emit(t,`envelopes-${lane}`,{files:1000,rows:f.db.length,batches:f.writes.length,duplicates:f.duplicates(),receiptBytes:byteLength(result)});
  }
});

test('25 second deadline resumes every batch without rewrites, ODC in41calls and O11 only affordable groups',async t=>{
  for(const lane of ['o11','odc']) {
    const f=fixture(t,lane,{cost:1000});const input={...f.input,deadlineMs:25000};
    const continuation={tool:lane==='o11'?'o11_data':'studio_data_insert',arguments:argsOf(input),why:'Resume the same load.'};
    let calls=0,result;const batchCounts=[];
    do {
      const before=f.writes.length;f.armBudget(25000);result=await runDataLoad(input,f.channel,{...f.options,continuation});calls++;
      assert.equal(result.ok,true,JSON.stringify(result));const added=f.writes.length-before;batchCounts.push(added);
      assert.ok(added<=25);
      // Review 6 (R6-F15, converted): the continuation is the same call without the owner's words (the plan keeps their sha256).
      if(!result.complete)assert.deepEqual(result.continuation.arguments,JSON.parse(JSON.stringify(argsOf({...input,authorization:undefined}))));
      assert.ok(calls<100);
    } while(!result.complete);
    assert.equal(f.writes.length,1023);assert.equal(f.duplicates(),0);assert.equal(f.db.length,count);
    if(lane==='odc')assert.equal(calls,41);else assert.ok(batchCounts.slice(0,-1).every(n=>n===20));
    emit(t,`deadline-${lane}`,{calls,batches:f.writes.length,duplicates:f.duplicates(),batchCounts,receiptBytes:byteLength(result)});
  }
});

test('lost response at batch500 reconciles keyed loads; both lanes refuse unkeyed files before writing',async t=>{
  for(const lane of ['o11','odc']) {
    const unkeyed=fixture(t,lane,{size:2,keys:false});
    const refusal=await runDataLoad(unkeyed.input,unkeyed.channel,unkeyed.options);
    assert.equal(refusal.code,'DATA_LOAD_KEYS_REQUIRED');assert.equal(unkeyed.writes.length,0);assert.equal(unkeyed.db.length,0);
    const f=fixture(t,lane,{keys:true,loseAt:500});
    const first=await runDataLoad(f.input,f.channel,f.options);
    assert.equal(first.ok,false);assert.equal(first.outcome,'reconcilable');assert.equal(first.reconcilable,true);assert.equal(f.writes.length,500);
    const next=await runDataLoad(f.input,f.channel,f.options);
    assert.equal(next.complete,true,JSON.stringify(next));assert.equal(f.writes.length,1023);assert.equal(f.db.length,count);assert.equal(f.duplicates(),0);
    emit(t,`lost-${lane}-keys`,{batches:f.writes.length,rows:f.db.length,duplicates:f.duplicates(),replayed:next.batches.replayed,code:next.code??null});
  }
});

test('10000 invalid CSV rows yield one exact refusal and kernel pointers retain source rows',async t=>{
  for(const lane of ['o11','odc']) {
    const f=fixture(t,lane,{size:1});const file=path.join(f.root,'invalid.csv');
    const lines=['Code,Qty,Day,ParentId,Unknown'];
    for(let i=1;i<=10000;i++) {
      const code=i>=501&&i<=600?`D${Math.floor((i-501)/2)}`:`K${i}`;
      lines.push(`${code},${i},${i<=300?'31/12/2026':'2026-12-31'},${i>=301&&i<=500?'missing':'known'},x${i===10000?',extra':''}`);
    }
    fs.writeFileSync(file,lines.join('\n'));
    const input={...f.input,files:[file],keys:['Code'],references:{ParentId:{key:'Slug'}}};
    const result=await runDataLoad(input,f.channel,f.options);
    assert.equal(result.ok,false);assert.equal(result.written,0);assert.equal(f.writes.length,0);
    assert.equal(result.problemCount,602,JSON.stringify(result));assert.ok(byteLength(result)<=8192);
    const full=JSON.parse(fs.readFileSync(result.problemsFile,'utf8'));
    assert.equal(full.problems.length,602);
    const rowSet=new Set(full.problems.map(p=>p.row).filter(Boolean));
    for(let r=2;r<=601;r++)assert.ok(rowSet.has(r),`missing source row ${r}`);
    assert.ok(rowSet.has(10001));
    emit(t,`refusal-${lane}`,{problemCount:result.problemCount,rowsWithProblems:result.rowsWithProblems,groups:full.groups.length,refusalBytes:byteLength(result),writes:f.writes.length});
  }
  const f=fixture(t,'o11',{size:203,checkProblems:[{code:'DATA_VALUE_INVALID',at:'/batch/1/records/7/Qty',message:'Item.Qty: invalid value'}]});
  const result=await runDataLoad(f.input,f.channel,f.options);
  assert.equal(result.ok,false);assert.equal(result.problemCount,1);assert.equal(f.writes.length,0);
  const full=JSON.parse(fs.readFileSync(result.problemsFile,'utf8'));
  assert.equal(full.problems[0].file,f.file);assert.equal(full.problems[0].row,108);assert.equal(full.problems[0].column,'Qty');
});

test('offline read/map/plan/check of102300 rows stays below20seconds and dryRun matches real counts',async t=>{
  for(const lane of ['o11','odc']) {
    const f=fixture(t,lane);const start=performance.now();
    const dry=await runDataLoad({...f.input,dryRun:true,operationId:undefined,authorization:undefined},f.channel,f.options);
    const wallMs=performance.now()-start;
    assert.equal(dry.ok,true,JSON.stringify(dry));assert.equal(dry.written,0);assert.equal(f.writes.length,0);assert.ok(wallMs<=20000,`${wallMs}ms`);
    const real=await runDataLoad(f.input,f.channel,f.options);
    for(const key of ['inserted','updated','unchanged'])assert.equal(dry[key],real[key]);
    emit(t,`offline-${lane}`,{rows:count,wallMs,maxRssKiB:process.resourceUsage().maxRSS,inserted:dry.inserted,updated:dry.updated,unchanged:dry.unchanged,written:dry.written});
  }
});
