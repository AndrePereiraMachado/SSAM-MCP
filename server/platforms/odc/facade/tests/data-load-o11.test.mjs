import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer, o11DataArguments } from '../ssam.mjs';
import { isWrite } from '../studio-write-lock.mjs';
import { wordsSha256 } from '../destructive-operations.mjs';
import { discoverAll, TOOLS_FILE } from '../tool-routing.mjs';

const target = { host: 'dev.example.test', module: 'Load_CS', oml: 'C:\\captures\\Load_CS.oml' };
const operationId = '73168878-a1c2-419b-a099-889900112233';

test('M10 file insert intents discover data routes while records examples retain update Id',async t=>{
  const catalog=JSON.parse(fs.readFileSync(TOOLS_FILE,'utf8'));
  for(const lane of ['o11','odc'])for(const intent of ['carregar os registros do arquivo clientes.csv na entidade Cliente','load records from customers.csv into entity Customer']) {
    const answer=await discoverAll({lane,intent},{discover:async()=>({ok:true,lane,matches:[]})});
    const expected=lane==='o11'?'o11_data':'studio_data_insert';
    assert.ok((answer.tools??[]).some(item=>item.tool===expected&&(lane==='odc'||item.verb==='insert')),JSON.stringify(answer));
    t.diagnostic(`CX13_DISCOVER_FILE ${JSON.stringify({lane,intent,tools:answer.tools.map(item=>({tool:item.tool,verb:item.verb})),bytes:Buffer.byteLength(JSON.stringify(answer))})}`);
  }
  for(const name of ['studio_data_insert','studio_data_update']) {
    const args=catalog.tools[name].args;assert.ok(args.records?.length);assert.equal(args.files,undefined);
    if(name==='studio_data_update')assert.ok(args.records[0].Id);
    assert.match(catalog.tools[name].when,/replace records with files/);
  }
  for(const operation of ['insert','update']) {
    const route=catalog.tools.o11_data.verbs[operation];assert.ok(route.args.request.records?.length);assert.equal(route.args.request.files,undefined);
    if(operation==='update')assert.ok(route.args.request.records[0].Id);
    assert.match(route.when,/replace records with files/);
  }
});

test('H6 O11 MCP preserves two same-code groups by original file, column and physical rows',async t=>{
  const h=await harness(t),a=path.join(h.root,'invalid-a.csv'),b=path.join(h.root,'invalid-b.csv');
  fs.writeFileSync(a,'Name,Qty\nA,invalid\nB,invalid\n');fs.writeFileSync(b,'Name,Qty\nC,invalid\n');
  const answer=await h.call({operation:'insert',entity:'Item',files:[a,b],operationId,authorization:'validate synthetic files'});
  assert.equal(answer.ok,false);assert.equal(answer.problemCount,3,JSON.stringify(answer));assert.equal(h.rows.length,0);
  const groups=answer.problems.filter(p=>p.code==='DATA_VALUE_INVALID');
  assert.equal(groups.length,2,JSON.stringify(answer));
  assert.deepEqual(groups.map(g=>[g.pointer,g.file,g.column,g.rows]),[['/files/0/columns/Qty',a,'Qty','2-3'],['/files/1/columns/Qty',b,'Qty','2']]);
});
async function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx13-o11-'));
  const callTarget={...target,oml:path.join(root,'synthetic.oml')};fs.writeFileSync(callTarget.oml,'synthetic offline schema fixture');
  const calls = [], rows = [], seen = new Map(), locks = [];
  const file = path.join(root, 'rows.jsonl');
  fs.writeFileSync(file, Array.from({ length: 203 }, (_,i) => JSON.stringify({ Name: `N${i}`, Qty: i })).join('\n'));
  const schema = options.schema ?? { module: target.module, entities: [{ name: 'Item', identifier: 'Id', static: false, attributes: [
    { name: 'Id', type: 'Item Identifier', autoNumber: true }, { name: 'Name', type: 'Text' }, { name: 'Qty', type: 'Integer' },
  ] }] };
  const runAnvil = async args => {
    const request = args.includes('--request') ? JSON.parse(fs.readFileSync(args[args.indexOf('--request')+1], 'utf8')) : null;
    calls.push({ args, request });
    let data;
    if (args.includes('--schema')) data = {...schema,moduleKey:'module-load',entities:schema.entities.map(e=>({...e,key:e.key??`entity-${e.name}`}))};
    else if (args.includes('--check')) data = options.check ? options.check(request) : { ok: true, operations: request.batch.length, records: request.batch.reduce((n,o)=>n+o.records.length,0) };
    else data = { ok: true, results: (request.batch ?? [request]).map(op => {
      if (op.operation === 'read-all') return { ok: true, records: (options.read ? options.read(op) : rows).slice(op.offset,op.offset+op.limit), complete: true };
      if (seen.has(op.operationId)) return { ok: true, replayed: true, ids: seen.get(op.operationId) };
      const ids = op.records?.map(record => { const id = String(rows.length+1); rows.push({Id:id,...record}); return id; }) ?? [];
      seen.set(op.operationId,ids);
      return { ok: true, ids };
    }) };
    return { ok: true, envelope: { ok: true, command: 'data', data }, wallMs: 1 };
  };
  const server = await createSsamServer({ odc: false, deps: { runAnvil, dataRoot: root, answersRoot: root,
    writeLock: async (options,fn) => { locks.push(isWrite(options.tool,options.args)); return fn(); } } });
  const [s,c] = InMemoryTransport.createLinkedPair();
  const client = new Client({name:'cx13-o11',version:'1'});
  await Promise.all([server.connect(s),client.connect(c)]);
  t.after(async () => { await client.close(); await server.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const call = async request => {if(request.files&&!request.keys&&!(request.operation==='update'&&request.insertMissing))request={...request,keys:['Name']};return (await client.callTool({ name:'o11_data',arguments:{...callTarget,request} })).structuredContent;};
  return { root,file,calls,rows,locks,call,target:callTarget };
}

test('files run offline schema and whole-load check before deterministic grouped writes; same load resumes', async t => {
  const h = await harness(t);
  const request = { operation:'insert',entity:'Item',files:[h.file],operationId,authorization:'load synthetic test records' };
  const result = await h.call(request);
  assert.equal(result.ok,true,JSON.stringify(result)); assert.equal(result.inserted,203); assert.equal(result.complete,true);
  assert.equal(h.rows.length,203); assert.equal(result.batches.total,3);
  assert.equal(h.calls[0].args.at(-1),'--schema'); assert.ok(!h.calls[0].args.includes('--request'));
  const checked=h.calls.find(c=>c.args.includes('--check'));assert.equal(checked.request.batch.length,3);
  const writes = h.calls.filter(c=>c.request && !c.args.includes('--check')&&c.request.batch?.some(op=>op.operation==='insert'||op.operation==='update'));
  assert.equal(writes.length,1); assert.equal(writes[0].request.batch.length,3);
  const n = h.calls.length;
  const replay = await h.call(request);
  assert.equal(replay.inserted,203); assert.equal(h.calls.length,n+1);assert.ok(h.calls.at(-1).args.includes('--schema'));  assert.equal(h.rows.length,203);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=2048);
});

test('records preserve the exact request and existing argv', async t => {
  const h=await harness(t);
  const request={operation:'insert',entity:'Item',records:[{Name:'same',Qty:7}],operationId,authorization:'load synthetic test records'};
  await h.call(request);
  // CX15 r4 (W-4) in the candidate, converted: the request reaches the kernel as sent, the words as sha256:<hex>.
  const hashed={...request,authorization:'sha256:'+wordsSha256(request.authorization)};
  assert.equal(h.calls.filter(c=>c.request).length,1); assert.deepEqual(h.calls.at(-1).request,hashed);
  const args=h.calls.at(-1).args, file=args[args.indexOf('--request')+1], work=args[args.indexOf('--work')+1];
  assert.deepEqual(args,['data',...o11DataArguments(h.target,file,work)]);
  assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify(hashed));
});

test('dryRun performs check without write authorization or operationId and does not hold a write lock', async t => {
  const h=await harness(t);
  const result=await h.call({operation:'insert',entity:'Item',files:[h.file],dryRun:true});
  assert.equal(result.ok,true,JSON.stringify(result)); assert.equal(result.inserted,203); assert.equal(result.written,0);
  assert.deepEqual(h.locks,[false]); assert.equal(h.rows.length,0);
  assert.ok(h.calls.at(-1).args.includes('--no-write-fields'));
  for(const tool of ['studio_data_insert','studio_data_update']) assert.equal(isWrite(tool,{dryRun:true}),false);
  assert.equal(isWrite('o11_data',{request:{operation:'insert',dryRun:true}}),false);
});

test('files inside batch, another operation, or alongside records never write', async t => {
  const h=await harness(t);
  const bad=[{batch:[{operation:'insert',entity:'Item',files:[h.file]}]},
    {operation:'delete',entity:'Item',files:[h.file],operationId,authorization:'load'},
    {operation:'insert',entity:'Item',files:[h.file],records:[{Name:'x'}],operationId,authorization:'load'},
    {operation:'update',entity:'Item',files:[h.file],insertMissing:true,operationId,authorization:'load'},
    {operation:'insert',entity:'Item',records:[{Name:'A'}],keys:['Name'],operationId,authorization:'load'},
    {operation:'insert',entity:'Item',records:[{Name:'A'}],dryRun:true,operationId,authorization:'load'}];
  for(const request of bad) assert.equal((await h.call(request)).ok,false,JSON.stringify(request));
  assert.equal(h.rows.length,0);
  assert.ok(h.calls.length>=2,'conflicting file calls can inspect schema and check values');
  assert.ok(h.calls.every(c=>c.args.includes('--schema')||c.args.includes('--check')||c.request?.batch?.every(op=>op.operation==='read-all')),'only offline preflight runs');
});

test('MCP refusal retains all 602 independent CSV problems and evidence within 8192 bytes', async t => {
  const schema={module:target.module,entities:[
    {name:'Item',key:'entity-Item',identifier:'Id',attributes:[{name:'Id',type:'Item Identifier',autoNumber:true},{name:'Name',type:'Text'},{name:'Qty',type:'Integer'},{name:'EventDate',type:'Date'},{name:'ParentId',type:'Parent Identifier'}]},
    {name:'Parent',identifier:'Id',attributes:[{name:'Id',type:'Parent Identifier',autoNumber:true},{name:'Slug',type:'Text'}]},
  ]};
  const h=await harness(t,{schema,read:op=>op.entity==='Parent'?[{Id:'1',Slug:'known'}]:[]});
  const file=path.join(h.root,'invalid-10000.csv');
  const lines=['Name,Qty,EventDate,ParentId,Unknown'];
  for(let i=0;i<10000;i++) {
    const name=i>=500&&i<600?`duplicate-${Math.floor((i-500)/2)}`:`unique-${i}`;
    const date=i<300?'invalid-date':'2026-10-13';
    const parent=i>=300&&i<500?`missing-parent-${i}`:'known';
    lines.push(`${name},${i},${date},${parent},unmapped${i===600?',extra':''}`);
  }
  fs.writeFileSync(file,lines.join('\r\n'));
  const answer=await h.call({operation:'insert',entity:'Item',files:[file],keys:['Name'],references:{ParentId:{key:'Slug'}},operationId,authorization:'validate only synthetic records'});
  assert.equal(answer.ok,false,JSON.stringify(answer));assert.equal(answer.problemCount,602);assert.equal(answer.written,0);
  assert.ok(answer.problemsFile);assert.equal(h.rows.length,0);
  assert.ok(h.calls.every(c=>!c.request||c.args.includes('--check')||c.request.batch.every(op=>op.operation==='read-all')),'no insert/update command before every problem is reported');
  const evidence=JSON.parse(fs.readFileSync(answer.problemsFile,'utf8'));
  assert.equal(evidence.problems.length,602);
  const counts={};for(const p of evidence.problems)counts[p.code]=(counts[p.code]??0)+1;
  assert.deepEqual(counts,{DATA_FILE_CSV_FIELDS:1,DATA_COLUMN_UNMAPPED:1,DATA_VALUE_INVALID:300,DATA_REFERENCE_NOT_FOUND:200,DATA_KEY_DUPLICATE:100});
  const invalidRows=new Set(evidence.problems.filter(p=>p.row).map(p=>p.row));
  for(let row=2;row<=602;row++)assert.ok(invalidRows.has(row),`physical CSV row ${row} remains in evidence`);
  const bytes=Buffer.byteLength(JSON.stringify(answer));assert.ok(bytes<=8192,`MCP refusal ${bytes} bytes`);
  t.diagnostic(`CX13_MCP_METRIC ${JSON.stringify({case:'csv-10000-disjoint-602',problemCount:answer.problemCount,rowsWithProblems:answer.rowsWithProblems,bytes,writes:h.rows.length,problemsFile:answer.problemsFile})}`);
});

test('MCP refusal translates a kernel check pointer and retains evidence within 8192 bytes', async t => {
  const h=await harness(t,{check:()=>({ok:false,code:'DATA_VALUE_INVALID',problems:[{code:'DATA_VALUE_INVALID',at:'/batch/1/records/7/Qty',reason:'Invalid Integer value from authoritative kernel check'}]})});
  const answer=await h.call({operation:'insert',entity:'Item',files:[h.file],operationId,authorization:'validate only synthetic records'});
  assert.equal(answer.ok,false,JSON.stringify(answer));assert.equal(answer.problemCount,1);assert.equal(answer.written,0);assert.ok(answer.problemsFile);
  const evidence=JSON.parse(fs.readFileSync(answer.problemsFile,'utf8'));
  assert.equal(evidence.problems.length,1);
  const problem=evidence.problems[0];assert.equal(problem.file,h.file);assert.equal(problem.row,108);assert.equal(problem.column,'Qty');assert.equal(problem.attribute,'Qty');
  assert.equal(h.rows.length,0);assert.ok(h.calls.every(c=>c.args.includes('--schema')||c.args.includes('--check')||c.request?.batch?.every(op=>op.operation==='read-all')));
  const bytes=Buffer.byteLength(JSON.stringify(answer));assert.ok(bytes<=8192,`MCP refusal ${bytes} bytes`);
  t.diagnostic(`CX13_MCP_METRIC ${JSON.stringify({case:'kernel-check-pointer',problemCount:answer.problemCount,bytes,writes:h.rows.length,row:problem.row,column:problem.column,problemsFile:answer.problemsFile})}`);
});
