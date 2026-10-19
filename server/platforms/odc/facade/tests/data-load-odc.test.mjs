import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createFacadeServer, progressNotifier } from '../mcp.mjs';
import { recordsFile, studioData } from '../lib.mjs';
import { odcDataChannel } from '../data-load.mjs';
import {wordsSha256} from '../destructive-operations.mjs'; // review 6: only the sha256 of the owner's words is kept or sent
import { createSsamServer } from '../ssam.mjs';

const operationId = '77777777-1111-2222-3333-444444444444';
const valueOf = answer => answer.structuredContent ?? JSON.parse(answer.content[0].text);

test('H6 proxy ODC MCP preserves two same-code groups by original file, column and physical rows',async t=>{
  const root=temp(t),a=put(root,'invalid-a.csv','Name,Age\nA,invalid\nB,invalid\n'),b=put(root,'invalid-b.csv','Name,Age\nC,invalid\n');
  let writes=0;
  const data=async args=>{if(args.op!=='read'){writes++;throw new Error('write must never run');}return {ok:true,tenant:'synthetic.tenant',identifier:'Id',moduleKey:'module-m',entityKey:'entity-e',attributes:['Id:Identifier','Name:Text','Age:Integer'],records:[{Id:'1',Name:'existing',Age:'1'}],more:false};};
  const server=await createSsamServer({o11:false,odc:true,deps:{odcFacade:()=>createFacadeServer({env:{...process.env,SSAM_ODC_OFFLINE:'1'},deps:{studioData:data,dataRoot:root}}),odcRoot:root,answersRoot:root,writeLock:async(_,fn)=>fn()}});
  const [s,c]=InMemoryTransport.createLinkedPair(),client=new Client({name:'cx13-H6-proxy',version:'1'});
  await Promise.all([server.connect(s),client.connect(c)]);t.after(async()=>{await client.close();await server.close();});
  const answer=valueOf(await client.callTool({name:'studio_data_insert',arguments:{module:'M',entity:'E',files:[a,b],keys:['Name'],operationId,authorize:'validate synthetic files'}}));
  assert.equal(answer.ok,false);assert.equal(answer.problemCount,3);assert.equal(writes,0);
  const groups=answer.problems.filter(p=>p.code==='DATA_VALUE_INVALID');assert.equal(groups.length,2,JSON.stringify(answer));
  assert.deepEqual(groups.map(g=>[g.pointer,g.file,g.column,g.rows]),[['/files/0/columns/Age',a,'Age','2-3'],['/files/1/columns/Age',b,'Age','2']]);
});
test('file-load progress identifies the tool and completed batches while delivery progress is preserved',async()=>{
  const messages=[],ctx={mcpReq:{_meta:{progressToken:'load'},notify:async m=>messages.push(m)}};
  progressNotifier(ctx,{tool:'studio_data_insert'})({done:2,total:3});
  progressNotifier(ctx)('verify');await new Promise(setImmediate);
  assert.deepEqual(messages[0].params,{progressToken:'load',progress:2,total:3,message:'studio_data_insert: 2/3 batches completed'});
  assert.equal(messages[1].params.message,'studio_deliver: verify');assert.equal(messages[1].params.progress,1);
});
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'cx13-odc-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}
function put(root,name,text) { const file=path.join(root,name);fs.writeFileSync(file,text);return file; }
async function harness(t,custom,extraDeps={}) {
  const root=temp(t), seen=[], rows=[{Id:'1',Name:'existing',Age:'1'}];
  const data=custom ?? (async args=>{
    seen.push(args);
    if(args.op==='read') return {ok:true,tenant:'synthetic.tenant',identifier:'Id',moduleKey:'module-m',entityKey:'entity-e',attributes:['Id:Identifier','Name:Text','Age:Integer'],records:rows.slice(args.offset??0,(args.offset??0)+(args.limit??100)),more:false};
    const ids=args.records.map((record,i)=>String(rows.length+i+1));
    if(args.op==='insert')rows.push(...args.records.map((record,i)=>({Id:ids[i],...record})));
    return {ok:true,reports:ids.map((id,i)=>({recordId:id,clientRecordId:args.records[i].Id??`new-${i+1}`,status:'Success'}))};
  });
  const server=await createFacadeServer({env:{...process.env,SSAM_ODC_OFFLINE:'1'},deps:{studioData:data,dataRoot:root,...extraDeps}});
  const [a,b]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'cx13-odc-test',version:'1'});
  await Promise.all([server.connect(a),client.connect(b)]);
  t.after(async()=>{await client.close();await server.close();});
  return {client,root,seen};
}

test('ODC tools expose the same file fields; update alone exposes insertMissing; description growth <=300 bytes',async t=>{
  const {client}=await harness(t),tools=(await client.listTools()).tools;
  const old={studio_data_insert:{before:305},studio_data_update:{before:149}};
  for(const name of ['studio_data_insert','studio_data_update']) {
    const tool=tools.find(t=>t.name===name),schema=tool.inputSchema;
    for(const field of ['records','files','columns','references','keys','batchSize','delimiter','dryRun','deadlineMs','operationId','authorize']) assert.ok(schema.properties[field],`${name}.${field}`);
    assert.ok(!schema.required.includes('records'));
    assert.ok(!schema.required.includes('authorize'));
    assert.ok(Buffer.byteLength(tool.description)-old[name].before<=300);
  }
  assert.ok(tools.find(t=>t.name==='studio_data_update').inputSchema.properties.insertMissing);
  assert.ok(!tools.find(t=>t.name==='studio_data_insert').inputSchema.properties.insertMissing);
});

// Review 6 (converted): with no file load open, the inline route reads no target identity (data-load-review6-inline-identity).
test('records route sends the exact existing studioData arguments; no target read without an open load',async t=>{
  const {client,seen}=await harness(t);
  const records=[{Name:'A',Age:2}];
  for(const operation of ['insert','update']) {
    const answer=valueOf(await client.callTool({name:`studio_data_${operation}`,arguments:{module:'M',entity:'E',records,authorize:'Autorizo',pid:42}}));
    assert.equal(answer.ok,true);
    assert.deepEqual(seen.at(-1),{op:operation,module:'M',entity:'E',records,authorize:'Autorizo',pid:42});
  }
  assert.equal(seen.filter(a=>a.op!=='read').length,2);assert.equal(seen.filter(a=>a.op==='read').length,0);
});

test('file inserts coerce values, batch stable names and retain completed IDs from native reports',async t=>{
  const {client,root,seen}=await harness(t);
  const file=put(root,'rows.json','[{"Name":"A","Age":2},{"Name":"B","Age":3},{"Name":"C","Age":4}]');
  const args={module:'M',entity:'E',files:[file],keys:['Name'],operationId,authorize:'Autorizo',batchSize:2,pid:42};
  const result=valueOf(await client.callTool({name:'studio_data_insert',arguments:args}));
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.inserted,3);assert.equal(result.batches.total,2);
  const writes=seen.filter(a=>a.op==='insert');
  assert.deepEqual(writes.map(a=>a.records.length),[2,1]);
  assert.deepEqual(writes[0].records,[{Name:'A',Age:'2'},{Name:'B',Age:'3'}]);
  assert.ok(writes.every(a=>/^[0-9a-f-]{36}-\d+\.json$/i.test(a.name)));
  assert.ok(writes.every(a=>a.pid===42&&a.authorize==='sha256:'+wordsSha256('Autorizo'))); // review 6 (R6-F15, converted): the plan's words as sha256
  const journal=fs.readFileSync(path.join(path.dirname(result.receiptFile),'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal.find(entry=>entry.state==='completed'&&entry.kind!=='rows').ids.length,2);
  assert.equal(journal.find(entry=>entry.kind==='resume').authorizationSha256,wordsSha256('Autorizo')); // review 6: sha256 only
  const again=valueOf(await client.callTool({name:'studio_data_insert',arguments:args}));
  assert.equal(again.ok,true);assert.equal(seen.filter(a=>a.op==='insert').length,2);
});

test('dryRun never writes; conflicts and missing input/auth aggregate before writes',async t=>{
  const {client,root,seen}=await harness(t),file=put(root,'rows.csv','Name,Age\nA,2\n');
  const dry=valueOf(await client.callTool({name:'studio_data_insert',arguments:{module:'M',entity:'E',files:[file],keys:['Name'],dryRun:true}}));
  assert.equal(dry.ok,true,JSON.stringify(dry));assert.equal(dry.inserted,1);assert.equal(dry.written,0);
  const conflict=valueOf(await client.callTool({name:'studio_data_insert',arguments:{module:'M',entity:'E',files:[file],records:[{Name:'A'}],batchSize:0}}));
  assert.equal(conflict.ok,false);assert.equal(conflict.code,'INPUT_INVALID');assert.ok(conflict.problemCount>=3);
  const missing=valueOf(await client.callTool({name:'studio_data_update',arguments:{module:'M',entity:'E'}}));
  assert.equal(missing.problemCount,2);
  const recordDry=valueOf(await client.callTool({name:'studio_data_insert',arguments:{module:'M',entity:'E',records:[{Name:'A'}],dryRun:true}}));
  assert.equal(recordDry.ok,false);assert.equal(recordDry.written,0);
  assert.equal(seen.filter(a=>a.op!=='read').length,0);
});

test('ODC reads paginate with only key fields and updateMissing uses insert operations',async t=>{
  const seen=[];
  const custom=async args=>{
    seen.push(args);
    if(args.op==='read'&&args.limit===1) return {ok:true,tenant:'synthetic.tenant',identifier:'Id',moduleKey:'module-m',entityKey:'entity-e',attributes:['Id:Identifier','Name:Text','Age:Integer'],records:[{Id:'1',Name:'existing',Age:'1'}]};
    if(args.op==='read') return args.offset===0 ? {ok:true,records:[{Id:'1',Name:'existing',Age:'1'}],more:true} : {ok:true,records:[],more:false};
    return {ok:true,reports:args.records.map((r,i)=>({recordId:r.Id??String(2+i),clientRecordId:r.Id??`new-${i+1}`,status:'Success'}))};
  };
  let shift=0;const {client,root}=await harness(t,custom,{now:()=>Date.now()+shift}),file=put(root,'upsert.json','[{"Name":"existing","Age":2},{"Name":"new","Age":3}]');
  const args={module:'M',entity:'E',files:[file],keys:['Name'],insertMissing:true,operationId,authorize:'Autorizo'};
  const stop=valueOf(await client.callTool({name:'studio_data_update',arguments:args}));
  assert.equal(stop.code,'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED',JSON.stringify(stop));assert.equal(stop.updatePreview.count,1);assert.equal(seen.filter(a=>a.op!=='read').length,0,'the overwrite is previewed before any write');
  shift+=6000;
  const answer=valueOf(await client.callTool({name:'studio_data_update',arguments:{...args,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:'pode atualizar 1 linha'}}}));
  assert.equal(answer.ok,true,JSON.stringify(answer));assert.equal(answer.updated,1);assert.equal(answer.inserted,1);
  const pages=seen.filter(a=>a.op==='read'&&a.limit!==1);
  assert.ok(pages.length>=2);assert.equal(pages[0].limit,5000);assert.equal(pages[1].offset,1);
  assert.deepEqual(new Set(pages[0].fields),new Set(['Id','Name','Age']));
  assert.deepEqual(seen.filter(a=>a.op!=='read').map(a=>a.op),['update','insert']);
});

test('native complete partial evidence is a certain failure; unreadable evidence remains uncertain',async t=>{
  const root=temp(t),evidence=put(root,'partial.json',JSON.stringify({ok:false,count:2,request:{records:[{id:'new-1',attributes:[{name:'Name',value:'A'}]},{id:'new-2',attributes:[{name:'Name',value:'B'}]}]},reports:[{recordId:'9',clientRecordId:'new-1',status:'Success',error:null},{recordId:null,clientRecordId:'new-2',status:'Error',error:'Value too long'}]}));
  for(const file of [evidence,path.join(root,'missing.json')]) {
    let calls=0;
    const channel=odcDataChannel({module:'M',entity:'E',authorize:'Autorizo',studioData:async()=>{calls++;throw new Error(`data-insert: 1 of 2 records failed; the full report is in ${file}. Do not repeat without reading it.`);}});
    const result=await channel.write([{operation:'insert',operationId,batch:0,records:[{Name:'A'},{Name:'B'}]},{operation:'insert',operationId,batch:1,records:[{Name:'C'}]}]);
    assert.equal(calls,1);
    if(file===evidence) {
      assert.equal(result[0].outcome,'failed');assert.deepEqual(result[0].ids,['9']);assert.deepEqual(result[0].successfulRows,[{index:0,id:'9'}]);assert.deepEqual(result[0].failedRows,[{index:1,reason:'Value too long'}]);
    } else { assert.equal(result[0].outcome,'uncertain');assert.equal((result[0].ids??[]).length,0); }
  }
});

test('recordsFile optional name is stable and refuses traversal; default bridge argv stays unchanged',async t=>{
  const records=[{Name:'A'}],name=`${operationId}-0.json`,directory=temp(t);
  const file=recordsFile(records,{name,directory});
  assert.equal(path.dirname(file),directory);
  assert.equal(path.basename(file),name);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),records);
  for(const bad of ['../bad.json','..\\bad.json','C:\\bad.json','bad/child.json','bad.txt','..json']) assert.throws(()=>recordsFile(records,{name:bad,directory}),/safe/);
  const writes=[],calls=[];
  const deps={writeRecords:(values,options)=>{writes.push({values,options});return 'C:\\synthetic\\request.json';},call:async(args,pid)=>{calls.push({args,pid});return {ok:true};}};
  await studioData({op:'insert',module:'M',entity:'E',records,authorize:'Autorizo',pid:42},deps);
  // CX15 r4 (W-2) in the candidate, converted: the bridge gets sha256:<hex> of the words, never the words.
  assert.deepEqual(calls[0],{args:['data-insert','M','E','--records-file','C:\\synthetic\\request.json','--authorize','sha256:'+wordsSha256('Autorizo')],pid:42});
  assert.equal(writes[0].options.name,undefined);
  await studioData({op:'update',module:'M',entity:'E',records,authorize:'Autorizo',pid:42,name},deps);
  assert.equal(writes[1].options.name,name);
  await studioData({op:'read',module:'M',entity:'E',fields:['Name'],offset:5,limit:100,pid:42},deps);
  assert.deepEqual(calls[2].args,['data','M','E','--limit','100','--offset','5','--fields','Name']);
});
