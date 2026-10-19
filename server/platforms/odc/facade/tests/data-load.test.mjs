import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeValue,canonicalValue,familyOf,mapRows,planDataLoad,groupProblems,batchOperationId,runDataLoad,o11DataChannel,odcDataChannel} from '../data-load.mjs';
import {withOwnerConsent,withoutWords} from './helpers/owner-words.mjs';
import {wordsSha256} from '../destructive-operations.mjs'; // review 6: only the sha256 of the owner's words is kept or sent
const entity={name:'Item',key:'entity-Item',identifier:'Id',attributes:[{name:'Id',type:'Item Identifier'},{name:'Code',type:'Text'},{name:'Qty',type:'Integer'},{name:'Price',type:'Decimal'},{name:'Day',type:'Date'},{name:'ParentId',type:'Parent Identifier'}]};
const parent={name:'Parent',identifier:'Id',attributes:[{name:'Id',type:'Parent Identifier'},{name:'Slug',type:'Text'}]};
const operationId='77777777-1111-4111-8111-111111111111';
function fixture(t,rows,extra={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'data-load-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'rows.json');fs.writeFileSync(file,JSON.stringify(rows));
  const input={lane:'o11',host:'synthetic.test',module:'M',entity:'Item',operation:'insert',files:[file],keys:['Code'],operationId,authorization:'write synthetic data',...extra};
  const calls=[],db={Item:[],Parent:[]};let clock=0;
  const channel={schema:async()=>({moduleKey:'module-m',entities:[entity,parent]}),readAll:async(name,{offset,limit})=>({records:db[name].slice(offset,offset+limit),more:offset+limit<db[name].length}),check:async()=>({ok:true}),write:async ops=>{calls.push(ops);return ops.map(op=>{const ids=op.records.map((r,i)=>String(db.Item.length+i+1));db.Item.push(...op.records.map((r,i)=>({...r,Id:ids[i]})));return{ok:true,ids};});}};
  return {root,file,input,channel,calls,db,options:{journalRoot:path.join(root,'loads'),now:()=>clock},tick:n=>clock+=n};
}
test('transient Windows journal replacement locks retry only persistence, never the data write',async t=>{
  const f=fixture(t,[{Code:'A'}]);const rename=fs.renameSync;let blocked=0;
  fs.renameSync=(from,to)=>{
    if(to.endsWith('journal.jsonl')&&blocked++<2)throw Object.assign(new Error('synthetic sharing violation'),{code:'EPERM'});
    return rename(from,to);
  };
  try {
    const result=await runDataLoad(f.input,f.channel,f.options);
    assert.equal(result.complete,true);assert.equal(f.calls.length,1);assert.equal(f.db.Item.length,1);
    const journal=fs.readFileSync(path.join(f.root,'loads',operationId,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(journal.find(entry=>entry.kind!=='resume').state,'completed');assert.equal(journal.find(entry=>entry.kind==='resume').authorizationSha256,wordsSha256(f.input.authorization)); // review 6: sha256 only
    assert.ok(blocked>=2);
  } finally {fs.renameSync=rename;}
});
test('reused load ids still aggregate all independent current config and file problems',async t=>{
  const f=fixture(t,[{Code:'A'}]);assert.equal((await runDataLoad(f.input,f.channel,f.options)).complete,true);
  fs.writeFileSync(f.file,'{broken');
  const refusal=await runDataLoad({...f.input,authorization:''},f.channel,f.options);
  assert.equal(refusal.problemCount,3);assert.equal(f.calls.length,1);
  const full=JSON.parse(fs.readFileSync(refusal.problemsFile,'utf8'));
  assert.deepEqual(full.problems.map(p=>p.code),['INPUT_INVALID','DATA_FILE_JSON_INVALID','DATA_LOAD_ID_REUSED']);
});
test('shared kernel table: all 78 encode/canonical cases, numeric lexemes preserved',()=>{
  const file=fileURLToPath(new URL('../../../../kernel/tests/fixtures/data-load/value-coercion.json',import.meta.url));
  const raw=JSON.parse(fs.readFileSync(file,'utf8'),function(key,value,context){if(key==='json'&&typeof value==='number')this.numericSource=context.source;return value;});
  assert.equal(raw.encode.length+raw.canonical.length,78);
  for(const c of raw.encode) {
    if(c.written===null&&c.json!==null) assert.throws(()=>encodeValue(c.type,c.json,c.numericSource),{code:'DATA_VALUE_INVALID'},JSON.stringify(c));
    else assert.equal(encodeValue(c.type,c.json,c.numericSource),c.written,JSON.stringify(c));
  }
  for(const c of raw.canonical)assert.equal(canonicalValue(c.type,c.text),c.canonical,JSON.stringify(c));
  assert.equal(familyOf('Date Time'),'DateTime');
});
test('maps exact names, explicit ignored columns, empty header columns and every invalid scalar',()=>{
  const out=mapRows([{file:'a.csv',row:2,sourceColumns:['code','Ignored','Qty','Empty'],values:{code:'x',Ignored:'v',Qty:'no'}},{file:'b.json',row:1,values:{Qty:[],Code:'A'}}],entity,{columns:{code:'Code',Ignored:null}});
  assert.equal(out.rows[0].record.Code,'x');assert.equal(out.problems.length,3);
  assert.equal(out.problems.filter(p=>p.code==='DATA_VALUE_INVALID').length,2);
  assert.ok(out.notes.some(n=>n.rule==='ignored-column'));
});
test('an explicit wrong-case mapping reports one column problem and its exact fix across repeated rows',()=>{
  const result=mapRows([{file:'a.csv',row:2,values:{external:'A'}},{file:'a.csv',row:3,values:{external:'B'}}],entity,{columns:{external:'code'}});
  assert.equal(result.problems.length,1);assert.equal(result.problems[0].code,'DATA_COLUMN_UNMAPPED');
  assert.deepEqual(result.problems[0].fix,{columns:{external:'Code'}});
  assert.deepEqual(result.rows.map(r=>r.record),[{},{}]);
});
test('five natural-key behaviors and exact case, changed cells only',()=>{
  const row=record=>({file:'x',row:1,globalRow:1,sources:{},record});
  const existing=[{Id:'9',Code:'A',Qty:'1',Price:'12.50'}];
  const run=(operation,record,extra={})=>planDataLoad({operation,entity:'Item',operationId,keys:['Code'],...extra},[row(record)],entity,existing);
  assert.equal(run('insert',{Code:'B'}).inserted,1);
  assert.equal(run('insert',{Code:'A',Price:'12.5'}).unchanged,1);
  assert.equal(run('insert',{Code:'A',Qty:'2'}).updated,1);
  const update=run('update',{Code:'A',Qty:'2',Price:'12.5'});assert.deepEqual(update.batches[0].records,[{Qty:'2',Id:'9'}]);
  assert.equal(run('update',{Code:'a'}).inserted,1);
  assert.equal(run('update',{Code:'a'},{insertMissing:true}).inserted,1);
  const duplicate=planDataLoad({operation:'insert',entity:'Item',operationId,keys:['Code']},[row({Code:'A'}),{...row({Code:'A'}),row:2}],entity,[]);
  assert.equal(duplicate.problems.filter(p=>p.code==='DATA_KEY_DUPLICATE').length,2);
  assert.equal(planDataLoad({operation:'insert',entity:'Item',operationId,keys:['Code']},[row({Code:'A'})],entity,[...existing,...existing]).problems[0].code,'DATA_KEY_AMBIGUOUS');
});
test('references resolve composite natural keys and all missing/ambiguous/type problems before write',async t=>{
  for(const lane of ['o11','odc']) {
    const f=fixture(t,[{Code:'A',ParentId:'one',Qty:'bad'},{Code:'B',ParentId:'absent'},{Code:'C',ParentId:'dup'}],{lane,references:{ParentId:{key:'Slug'}}});
    f.db.Parent.push({Id:'1',Slug:'one'},{Id:'2',Slug:'dup'},{Id:'3',Slug:'dup'});
    const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.ok,false);assert.equal(out.problemCount,3);assert.equal(f.calls.length,0);
    assert.deepEqual(out.problems.map(p=>p.code),['DATA_VALUE_INVALID','DATA_REFERENCE_NOT_FOUND','DATA_REFERENCE_AMBIGUOUS']);
  }
  const f=fixture(t,[{ParentId:'one'}],{keys:['ParentId'],references:{ParentId:{key:['Slug','Region'],columns:['Slug','Region']}}});
  f.channel.schema=async()=>({moduleKey:'module-m',entities:[entity,{...parent,attributes:[...parent.attributes,{name:'Region',type:'Text'}]}]});
  fs.writeFileSync(f.file,JSON.stringify([{Slug:'one',Region:'BR'}]));f.db.Parent=[{Id:'1',Slug:'one',Region:'BR'}];
  const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.ok,true);assert.equal(f.calls[0][0].records[0].ParentId,'1');
});
test('kernel check pointers return source locations, every planned operation checked before any write',async t=>{
  const f=fixture(t,[{Code:'A'},{Code:'B'}],{batchSize:1});
  f.channel.check=async request=>{assert.equal(request.batch.length,2);return{ok:false,problems:[{code:'DATA_VALUE_INVALID',at:'/batch/0/records/0/Code',reason:'refused A'},{code:'DATA_VALUE_INVALID',at:'/batch/1/records/0/Code',reason:'refused B'}]};};
  const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.problemCount,2);assert.equal(out.problems[0].file,f.file);assert.equal(out.problems[1].example.row,2);assert.equal(f.calls.length,0);
});
test('dryRun counts exactly the eventual inserts/updates/unchanged and does not require authorization',async t=>{
  const f=fixture(t,[{Code:'A',Qty:1},{Code:'B',Qty:2},{Code:'C',Qty:3}],{operation:'update',keys:['Code'],insertMissing:true});
  f.db.Item.push({Id:'1',Code:'A',Qty:'1'},{Id:'2',Code:'B',Qty:'1'});
  const dry=await runDataLoad({...f.input,dryRun:true,operationId:undefined,authorization:undefined},f.channel,f.options);
  assert.deepEqual([dry.inserted,dry.updated,dry.unchanged,dry.written],[1,1,1,0]);assert.equal(f.calls.length,0);
  const real=await withOwnerConsent(runDataLoad,f.input,f.channel,f.options);assert.deepEqual([real.inserted,real.updated,real.unchanged],[1,1,1]);
});
test('paging persists before deadline; continuation resumes offset and writes only after all pages',async t=>{
  const f=fixture(t,[{Code:'A'}],{keys:['Code'],deadlineMs:1000});const offsets=[];
  f.channel.readAll=async(name,{offset})=>{offsets.push(offset);f.tick(1000);return{records:[{Id:String(offset+1),Code:'other'+offset}],more:offset<2,continuation:offset<2?{offset:offset+1}:undefined};};
  for(let i=0;i<2;i++){const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.complete,false);assert.equal(f.calls.length,0);}
  const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.complete,false); // Last read used this deadline; write deferred.
  const done=await runDataLoad({...f.input,deadlineMs:4000},f.channel,f.options);assert.equal(done.complete,true);assert.deepEqual(offsets,[0,1,2,0,1,2]);assert.equal(f.calls.length,1); // The completed read is fresh before unsent keyed writes.
});
test('deterministic ids; O11 groups 10, ODC one; deadline never repeats a completed batch',async t=>{
  assert.equal(batchOperationId(operationId,1,[{a:1}]),batchOperationId(operationId,1,[{a:1}]));
  assert.notEqual(batchOperationId(operationId,1,[{a:1}]),batchOperationId(operationId,2,[{a:1}]));
  for(const lane of ['o11','odc']) {
    const f=fixture(t,Array.from({length:31},(_,i)=>({Code:String(i)})),{lane,batchSize:1,deadlineMs:25000});
    const write=f.channel.write;f.channel.write=async ops=>{f.tick(ops.length*1000);return write(ops);};
    const first=await runDataLoad(f.input,f.channel,f.options);assert.equal(first.complete,false);assert.equal(first.batches.done,lane==='o11'?20:25);
    const second=await runDataLoad(f.input,f.channel,f.options);assert.equal(second.complete,true);assert.equal(f.db.Item.length,31);assert.equal(new Set(f.db.Item.map(r=>r.Code)).size,31);
    assert.ok(f.calls.every(c=>c.length<=(lane==='o11'?10:1)));
  }
});
test('O11 lost response rereads keys and adopts committed batches without replay',async t=>{
  const f=fixture(t,[{Code:'A'},{Code:'B'}],{keys:['Code'],batchSize:1});const seen=new Map(),ids=[];let lost=true;
  f.channel.write=async ops=>{ids.push(ops.map(o=>o.operationId));const results=ops.map(op=>{if(seen.has(op.operationId))return{ok:true,replayed:true,ids:seen.get(op.operationId)};const out=[String(seen.size+1)];seen.set(op.operationId,out);f.db.Item.push({...op.records[0],Id:out[0]});return{ok:true,ids:out};});if(lost){lost=false;throw new Error('lost');}return results;};
  const first=await runDataLoad(f.input,f.channel,f.options);assert.equal(first.outcome,'reconcilable');
  const second=await runDataLoad(f.input,f.channel,f.options);assert.equal(second.complete,true);assert.equal(second.batches.replayed,2);assert.equal(ids.length,1);assert.equal(f.db.Item.length,2);
});
test('ODC lost response reconciles keys; no keys refuses to repeat the uncertain rows',async t=>{
  for(const keys of [undefined,['Code']]) {
    const f=fixture(t,[{Code:'A'},{Code:'B'}],{lane:'odc',batchSize:1,keys});let lost=true;const write=f.channel.write;
    f.channel.write=async ops=>{const r=await write(ops);if(lost){lost=false;throw new Error('lost');}return r;};
    const first=await runDataLoad(f.input,f.channel,f.options);if(!keys){assert.equal(first.code,'DATA_LOAD_KEYS_REQUIRED');assert.equal(f.calls.length,0);continue;}assert.equal(first.outcome,'reconcilable');
    const second=await runDataLoad(f.input,f.channel,f.options);
    if(keys){assert.equal(second.complete,true);assert.equal(f.db.Item.length,2);}
  }
});
test('same operationId rejects any changed fingerprint without writing; receipts/refusals meet byte budgets',async t=>{
  const f=fixture(t,[{Code:'A'}]);const done=await runDataLoad(f.input,f.channel,f.options);assert.ok(Buffer.byteLength(JSON.stringify(done))<=2048);
  fs.writeFileSync(f.file,JSON.stringify([{Code:'B'}]));const refused=await runDataLoad(f.input,f.channel,f.options);assert.equal(refused.code,'DATA_LOAD_ID_REUSED');assert.equal(f.calls.length,1);
  const g=fixture(t,Array.from({length:2000},(_,i)=>({Code:String(i),Qty:'invalid'+i})));const out=await runDataLoad(g.input,g.channel,g.options);assert.equal(out.problemCount,2000);assert.ok(Buffer.byteLength(JSON.stringify(out))<=8192);
  assert.equal(JSON.parse(fs.readFileSync(out.problemsFile)).problems.length,2000);assert.equal(g.calls.length,0);
  assert.equal(groupProblems([{code:'X',reason:'bad',file:'f',column:'a',row:1},{code:'X',reason:'bad',file:'f',column:'a',row:2},{code:'X',reason:'bad',file:'f',column:'a',row:4}])[0].rows,'1-2,4');
});
test('channels use authoritative offline check, deterministic record names, partial evidence ids',async t=>{
  const f=fixture(t,[]);const calls=[];
  const o11=o11DataChannel({runAnvil:async argv=>{calls.push(argv);return{envelope:{data:{ok:true,results:[{ok:true,records:[]}]}}};},call:{host:'synthetic.test',entity:'Item',module:'M',oml:f.file,host:'h'},work:f.root,authorization:'write'});
  await o11.schema();assert.ok(calls[0].includes('--schema'));assert.ok(!calls[0].includes('--request'));
  await o11.check({batch:[]},{dryRun:true});assert.ok(calls[1].includes('--check'));assert.ok(calls[1].includes('--no-write-fields'));
  const evidence=path.join(f.root,'partial.json');fs.writeFileSync(evidence,JSON.stringify({count:2,request:{records:[{id:'new-1',attributes:[{name:'Code',value:'A'}]},{id:'new-2',attributes:[{name:'Code',value:'B'}]}]},reports:[{recordId:'8',clientRecordId:'new-1',status:'Success'},{recordId:null,clientRecordId:'new-2',status:'Error',error:'Value too long'}]}));
  const odc=odcDataChannel({module:'M',entity:'Item',authorize:'write',studioData:async args=>{calls.push(args);throw new Error(`failed; the full report is in ${evidence}. Do not repeat without reading it.`);}});
  const result=await odc.write([{operation:'insert',operationId,batch:7,records:[{Code:'A'},{Code:'B'}]}]);assert.equal(calls.at(-1).name,`${operationId}-7.json`);assert.deepEqual(result[0].ids,['8']);assert.equal(result[0].outcome,'failed');assert.deepEqual(result[0].failedRows,[{index:1,reason:'Value too long'}]);
});
test('independent configuration errors all survive grouping and whitespace authorization is refused',async t=>{
  const f=fixture(t,[{Code:'A'}],{records:[],batchSize:0,operationId:undefined,authorization:'  '});
  const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.problemCount,4);assert.equal(f.calls.length,0);
});
test('missing Studio reads report notChecked and genuine offline problems without fabricated key failures',async t=>{
  const f=fixture(t,[{Code:'A',Day:'invalid'}],{operation:'update',keys:['Code']});
  f.channel.readAll=async()=>{throw new Error('Studio unavailable');};
  const out=await runDataLoad(f.input,f.channel,f.options);assert.deepEqual(out.notChecked,['keys']);assert.equal(out.problemCount,1);assert.equal(out.problems[0].code,'DATA_VALUE_INVALID');assert.equal(f.calls.length,0);
});
test('numeric JSON lexemes preserve unsafe identifier refusal and decimal scale through file preflight',async t=>{
  const f=fixture(t,[]);fs.writeFileSync(f.file,'[{"Id":9007199254740993,"Price":12.500,"Qty":1e2}]');
  const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.code,'DATA_VALUE_INVALID');assert.equal(f.calls.length,0);
  const g=fixture(t,[]);fs.writeFileSync(g.file,'[{"Code":"A","Price":12.500,"Qty":1e2}]');
  const valid=await runDataLoad(g.input,g.channel,g.options);assert.equal(valid.ok,true);assert.deepEqual(g.calls[0][0].records[0],{Code:'A',Price:'12.500',Qty:'100'});
});
test('uncertain partial keyed batches write the remaining rows once and keep all resolved ids in index chunks',async t=>{
  const f=fixture(t,[{Code:'A'},{Code:'B'}],{lane:'odc',keys:['Code'],batchSize:2});let first=true;
  f.channel.write=async ops=>{f.calls.push(ops);if(first){first=false;f.db.Item.push({Code:'A',Id:'8'});return[{ok:false,outcome:'uncertain',ids:['8']}];}f.db.Item.push(...ops[0].records.map(r=>({...r,Id:'9'})));return[{ok:true,ids:['9']}];};
  assert.equal((await runDataLoad(f.input,f.channel,f.options)).outcome,'reconcilable');
  const done=await runDataLoad(f.input,f.channel,f.options);assert.equal(done.complete,true);assert.equal(f.calls[1][0].records.length,1);assert.notEqual(f.calls[0][0].operationId,f.calls[1][0].operationId);
  const index=JSON.parse(fs.readFileSync(path.join(f.root,'loads',operationId,'key-index','0.json')));assert.deepEqual(index.map(r=>r.id),['8','9']);
});
test('validated resumable plan takes the load words from its plan and still requires a single records/files input',async t=>{
  const f=fixture(t,[{Code:'A'},{Code:'B'}],{lane:'odc',batchSize:1,deadlineMs:1000});const write=f.channel.write;f.channel.write=async ops=>{f.tick(1000);return write(ops);};
  assert.equal((await runDataLoad(f.input,f.channel,f.options)).complete,false);assert.equal(f.calls.length,1);
  const invalid=await runDataLoad({...f.input,authorization:undefined,records:[]},f.channel,f.options);assert.equal(invalid.problemCount,1);assert.equal(invalid.problems[0].at??invalid.problems[0].pointer.replace(/^\//,''),'records');assert.equal(f.calls.length,1);
  const done=await runDataLoad(f.input,f.channel,f.options);assert.equal(done.complete,true);assert.equal(f.calls.length,2);
});
test('composite reference absent component is refused rather than matched as explicit null',async t=>{
  const f=fixture(t,[{Slug:'one'}],{references:{ParentId:{key:['Slug','Region'],columns:['Slug','Region']}}});
  f.channel.schema=async()=>({moduleKey:'module-m',entities:[entity,{...parent,attributes:[...parent.attributes,{name:'Region',type:'Text'}]}]});
  f.db.Parent=[{Id:'1',Slug:'one',Region:null}];const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.code,'DATA_REFERENCE_NOT_FOUND');assert.equal(out.problems[0].column,'Region');assert.equal(f.calls.length,0);
});
test('O11 returned transport loss becomes uncertain and reconciles observed natural keys',async t=>{
  const f=fixture(t,[{Code:'A'}]);const submitted=[],written=new Map();let first=true;
  const runAnvil=async argv=>{
    if(argv.includes('--schema'))return{envelope:{data:{ok:true,moduleKey:'module-m',entities:[entity]}}};
    if(argv.includes('--check'))return{envelope:{data:{ok:true}}};
    const request=JSON.parse(fs.readFileSync(argv[argv.indexOf('--request')+1]));if(request.batch[0].operation==='read-all')return{records:f.db.Item,more:false};submitted.push(request.batch[0].operationId);
    if(first){first=false;f.db.Item.push({Id:'8',Code:'A'});written.set(request.batch[0].operationId,['8']);return{ok:false,unknown:true,code:'DATA_OUTCOME_UNKNOWN'};}
    assert.ok(written.has(request.batch[0].operationId));return{envelope:{data:{ok:true,results:[{ok:true,replayed:true,ids:['8']}]}}};
  };
  const channel=o11DataChannel({runAnvil,call:{host:'synthetic.test',entity:'Item',module:'M',oml:f.file},work:f.root,authorization:'write'});
  assert.equal((await runDataLoad(f.input,channel,f.options)).outcome,'reconcilable');
  const journal=fs.readFileSync(path.join(f.root,'loads',operationId,'journal.jsonl'),'utf8');assert.equal(journal.trim().split('\n').map(JSON.parse).find(entry=>entry.kind!=='resume').state,'uncertain');
  const done=await runDataLoad(f.input,channel,f.options);assert.equal(done.complete,true);assert.equal(done.batches.replayed,1);assert.equal(submitted.length,1);assert.equal(written.size,1);
});
test('1000-path continuation fits receipt budget and evidence retains the exact call',async t=>{
  const f=fixture(t,[{Code:'A'}],{lane:'odc',batchSize:1,deadlineMs:1000});
  const longDir=path.join(f.root,'synthetic-path-with-a-deliberately-long-name');fs.mkdirSync(longDir);
  f.input.files=Array.from({length:1000},(_,index)=>{const file=path.join(longDir,`customer-load-synthetic-file-${index}.json`);fs.writeFileSync(file,JSON.stringify([{Code:String(index)}]));return file;});const call={tool:'studio_data_insert',arguments:f.input};const write=f.channel.write;f.channel.write=async ops=>{f.tick(1000);return write(ops);};
  const out=await runDataLoad(f.input,f.channel,{...f.options,continuation:call});assert.equal(out.complete,false);assert.ok(Buffer.byteLength(JSON.stringify(out))<=2048,JSON.stringify(out).length);
  assert.equal(out.continuation.tool,'ssam_evidence');assert.equal(out.continuation.arguments.file,out.continuationFile);assert.ok(out.rules.includes('large-continuation-in-evidence'));
  // Review 6 (R6-F15, converted): a stored continuation keeps no words (the resume takes them from the plan).
  const stored={...call,arguments:withoutWords(call.arguments)};
  assert.deepEqual(JSON.parse(fs.readFileSync(out.continuationFile)),stored);assert.deepEqual(JSON.parse(fs.readFileSync(out.receiptFile)).continuation,stored);
});
test('generic inserts never complete without exactly one nonempty unique acknowledged id per record',async t=>{
  for(const ids of [undefined,[],[''],['8','8'],['8']]) {
    const f=fixture(t,[{Code:'A'},{Code:'B'}]);f.channel.write=async()=>[{ok:true,ids}];
    const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.outcome,'reconcilable');assert.equal(out.batches.done,0);
    assert.equal(fs.readFileSync(path.join(f.root,'loads',operationId,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse).find(entry=>entry.kind!=='resume').state,'uncertain');
  }
  const f=fixture(t,[{Code:'A',Qty:'2'}],{operation:'update',keys:['Code']});f.db.Item=[{Id:'1',Code:'A',Qty:'1'}];
  f.channel.write=async()=>[{ok:true,written:0,unchanged:1,reports:[]}];assert.equal((await withOwnerConsent(runDataLoad,f.input,f.channel,f.options)).complete,true);
});
test('ODC native empty, missing, failed and ambiguous acknowledgments stop the channel',async()=>{
  const replies=[{ok:true,reports:[],count:0},{ok:true},{ok:true,reports:[{status:'Success',recordId:null}]},{ok:true,reports:[{status:'Success',recordId:'8',error:'failed'}]},{ok:true,reports:[{status:'Error',recordId:'8'}]}];
  // A Success receipt with an id and an error is contradictory, never a retryable failure.
  const expected=['uncertain','uncertain','uncertain','uncertain','failed'];
  for(let index=0;index<replies.length;index++){let calls=0;const channel=odcDataChannel({module:'M',entity:'Item',authorize:'write',studioData:async()=>{calls++;return replies[index];}});const out=await channel.write([{operation:'insert',operationId,batch:0,records:[{Code:'A'}]},{operation:'insert',operationId,batch:1,records:[{Code:'B'}]}]);assert.equal(out[0].outcome,expected[index]);assert.equal(calls,1);if(expected[index]==='failed')assert.equal(out[0].failedRows.length,1);}
  const channel=odcDataChannel({module:'M',entity:'Item',authorize:'write',studioData:async()=>({ok:true,reports:[{status:'Success',recordId:'8'},{status:'Success',recordId:'9'}]})});
  assert.equal((await channel.write([{operation:'insert',operationId,batch:0,records:[{Code:'A'},{Code:'B'}]}]))[0].outcome,'uncertain');
});
test('ODC insert IDs follow echoed clients rather than report order, including known explicit identifiers',async()=>{
  for(const explicit of [false,true]) {
    const expected=explicit?['provided-a','provided-b']:['new-1','new-2'];
    const channel=odcDataChannel({module:'M',entity:'Item',authorize:'write',studioData:async args=>args.op==='read'?{ok:true,attributes:['Id:Item Identifier','Code:Text'],records:[{Id:'existing',Code:'known'}]}:{ok:true,reports:[{recordId:'server-b',clientRecordId:expected[1],status:'Success'},{recordId:'server-a',clientRecordId:expected[0],status:'Success'}]}});
    if(explicit)await channel.schema(['Item']);
    const rows=explicit?[{Id:expected[0],Code:'A'},{Id:expected[1],Code:'B'}]:[{Code:'A'},{Code:'B'}];
    const out=await channel.write([{operation:'insert',operationId,batch:0,records:rows}]);assert.equal(out[0].ok,true);assert.deepEqual(out[0].ids,['server-a','server-b']);
  }
});
test('fresh ODC channel correlates explicit IDs when resuming a validated plan without a schema reread',async t=>{
  const f=fixture(t,[{Id:'provided-a',Code:'A'},{Id:'provided-b',Code:'B'},{Id:'provided-c',Code:'C'},{Id:'provided-d',Code:'D'}],{lane:'odc',batchSize:2,deadlineMs:1000});
  let schemaReads=0,writeCalls=0;
  const studioData=async args=>{
    if(args.op==='read'){schemaReads++;return{ok:true,tenant:'synthetic.tenant',moduleKey:'module-m',entityKey:'entity-e',identifier:'Id',attributes:['Id:Item Identifier','Code:Text'],records:[{Id:'known',Code:'existing'}]};}
    writeCalls++;f.tick(1000);return{ok:true,reports:args.records.map(row=>({recordId:'server-'+row.Id,clientRecordId:row.Id,status:'Success'})).reverse()};
  };
  const fresh=()=>odcDataChannel({studioData,module:'M',entity:'Item',authorize:'write'});
  const first=await runDataLoad(f.input,fresh(),f.options);assert.equal(first.complete,false);assert.equal(first.batches.done,1);assert.equal(schemaReads,2);
  const second=await runDataLoad(f.input,fresh(),f.options);assert.equal(second.complete,true);assert.equal(second.batches.done,2);assert.equal(schemaReads,4);assert.equal(writeCalls,2); // One identity read on each call; schema reuses the first page.
  const entries=fs.readFileSync(path.join(f.root,'loads',operationId,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(entry=>entry.kind!=='resume');assert.deepEqual(entries[1].ids,['server-provided-c','server-provided-d']);
});
test('keyed ODC updates retain submitted target IDs in the key index despite reversed native reports',async t=>{
  const f=fixture(t,[{Code:'A',Qty:2},{Code:'B',Qty:3}],{lane:'odc',operation:'update',keys:['Code']});
  const existing=[{Id:'target-a',Code:'A',Qty:'1'},{Id:'target-b',Code:'B',Qty:'1'}];
  const channel=odcDataChannel({module:'M',entity:'Item',authorize:'write',studioData:async args=>args.op==='read'?{ok:true,tenant:'synthetic.tenant',moduleKey:'module-m',entityKey:'entity-e',identifier:'Id',attributes:['Id:Item Identifier','Code:Text','Qty:Integer'],records:existing.slice(args.offset??0,(args.offset??0)+(args.limit??existing.length)),more:false}:{ok:true,reports:args.records.map(row=>({recordId:row.Id,clientRecordId:row.Id,status:'Success'})).reverse()}});
  const out=await withOwnerConsent(runDataLoad,f.input,channel,f.options);assert.equal(out.complete,true);assert.equal(out.updated,2);
  const index=JSON.parse(fs.readFileSync(path.join(f.root,'loads',operationId,'key-index','0.json')));assert.deepEqual(index,[{key:'["A"]',id:'target-a'},{key:'["B"]',id:'target-b'}]);
});
test('missing write authorization/id and records conflict still aggregate typed problems in both lanes',async t=>{
  for(const lane of ['o11','odc']) {
    const f=fixture(t,[{Code:'A',Day:'invalid date'}],{lane,authorization:undefined,operationId:undefined,records:[]});let schemaCalls=0;
    const schema=f.channel.schema;f.channel.schema=async entities=>{schemaCalls++;return schema(entities);};
    f.channel.check=async(request,options)=>{assert.equal(options.dryRun,true);return{ok:true};};
    const out=await runDataLoad(f.input,f.channel,f.options);assert.equal(out.ok,false);assert.equal(out.problemCount,4);assert.equal(out.problems.filter(p=>p.code==='DATA_VALUE_INVALID').length,1);assert.equal(schemaCalls,1);assert.equal(f.calls.length,0);
  }
});
test('ODC partial and completed loads reject a different connected tenant before using the persisted plan',async t=>{
  for(const partial of [true,false]) {
    const f=fixture(t,Array.from({length:partial?4:2},(_,i)=>({Code:String(i)})),{lane:'odc',batchSize:2,deadlineMs:1000});let tenant='tenant-a.example',writes=0,reads=0;
    const studioData=async args=>{if(args.op==='read'){reads++;return{ok:true,tenant,moduleKey:'module-m',entityKey:'entity-e',identifier:'Id',attributes:['Id:Item Identifier','Code:Text'],records:[]};}writes++;f.tick(1000);return{ok:true,reports:args.records.map((row,i)=>({recordId:'server-'+row.Code,clientRecordId:'new-'+(i+1),status:'Success'}))};};
    const fresh=()=>odcDataChannel({studioData,module:'M',entity:'Item',authorize:'write'});
    const first=await runDataLoad(f.input,fresh(),f.options);assert.equal(first.complete,!partial);assert.equal(writes,1);assert.equal(reads,2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'loads',operationId,'plan.json'))).print.host,'tenant-a.example');
    tenant='tenant-b.example';const rejected=await runDataLoad(f.input,fresh(),f.options);assert.equal(rejected.code,'DATA_LOAD_ID_REUSED');// A reused id reports durable writes of the original load, including a changed tenant.
    assert.equal(rejected.written,2);assert.equal(rejected.receiptFile,first.receiptFile);assert.equal(writes,1);assert.equal(reads,3);
  }
});
test('ODC missing tenant identity refuses safely while preserving offline typed problems',async t=>{
  const f=fixture(t,[{Code:'A',Day:'invalid'}],{lane:'odc'});let writes=0,reads=0;
  const channel=odcDataChannel({module:'M',entity:'Item',authorize:'write',studioData:async args=>{if(args.op==='read'){reads++;return{ok:true,attributes:['Id:Item Identifier','Code:Text','Day:Date'],records:[]};}writes++;return{ok:true,reports:[]};}});
  const out=await runDataLoad(f.input,channel,f.options);assert.equal(out.problemCount,2);assert.equal(out.code,'DATA_READ_UNAVAILABLE');assert.equal(out.problems[1].code,'DATA_VALUE_INVALID');assert.deepEqual(out.notChecked,['references','keys']);assert.equal(writes,0);assert.equal(reads,1);
});
test('ODC empty-target lost insert uses explicit identifier metadata and resumes without rewriting',async t=>{
  const f=fixture(t,[{Code:'A'}],{lane:'odc',keys:['Code']});const database=[];let writes=0;
  const studioData=async args=>{
    if(args.op==='read')return{ok:true,tenant:'same-tenant.example',moduleKey:'module-m',entityKey:'entity-e',identifier:'Id',attributes:['Id:Item Identifier','Code:Text'],records:database.slice(args.offset??0,(args.offset??0)+(args.limit??5000)),more:false};
    writes++;database.push({Id:'server-8',...args.records[0]});throw new Error('response lost after the native insert');
  };
  const fresh=()=>odcDataChannel({studioData,module:'M',entity:'Item',authorize:'write'});
  const first=await runDataLoad(f.input,fresh(),f.options);assert.equal(first.outcome,'reconcilable');assert.equal(writes,1);
  const planFile=path.join(f.root,'loads',operationId,'plan.json');assert.equal(JSON.parse(fs.readFileSync(planFile)).entity.identifier,'Id');
  const resumed=await runDataLoad(f.input,fresh(),f.options);assert.equal(resumed.complete,true);assert.equal(writes,1);assert.equal(database.length,1);
  assert.equal(JSON.parse(fs.readFileSync(planFile)).entity.identifier,'Id');
  const index=JSON.parse(fs.readFileSync(path.join(f.root,'loads',operationId,'key-index','0.json')));assert.deepEqual(index,[{key:'["A"]',id:'server-8'}]);
});

test('typed whitespace matches .NET NEL, embedded BOM and Boolean NUL handling',()=>{
  for(const [type,value,expected] of [['Boolean','True','True'],['Integer','12','12'],['Long Integer','12','12'],['Decimal','12.50','12.50'],['Date','2026-10-13','2026-10-13'],['Time','12:30','12:30:00']]){
    assert.equal(encodeValue({type},'\u0085'+value+'\u0085'),expected);
    assert.throws(()=>encodeValue({type},'\uFEFF'+value+'\uFEFF'),{code:'DATA_VALUE_INVALID'});
  }
  assert.equal(encodeValue({type:'Item Identifier'},'\uFEFFid\uFEFF'),'\uFEFFid\uFEFF');
  assert.equal(encodeValue({type:'Boolean'},'\0True\0'),'True');
});
