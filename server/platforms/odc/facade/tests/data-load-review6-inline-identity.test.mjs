import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as locks from '../data-load-lock.mjs';
import {runDataLoad} from '../data-load.mjs';

// Review 6 (fence with CX15 and CX12, the PERF of review 5): an inline insert or update (records) reads no data target
// identity when no file load of its lane is open in its journalRoot: it reserves against the file loads with a marker,
// without reading the Studio or the kernel. Only an open load of the lane makes it read the identity and check the
// canonical reservation (BUSY on the same entity, as before). A file load that starts while an inline write of its lane
// runs waits for it (BUSY with the way out: the same call again).
const id='9a960000-0000-4000-8000-000000000001';
const target={lane:'odc',tenant:'synthetic.test',moduleKey:'module-key',entityKey:'entity-key',module:'Synthetic App',entity:'E'};
const tmp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r6i-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
async function openLoad(journalRoot,identity){
  await locks.withDataLoadLock({operationId:id},{journalRoot},async({acquireEntity})=>{
    assert.equal(await acquireEntity(identity),null);
    const dir=path.join(journalRoot,id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify({validated:true,state:'resumable'}));
    return{ok:false};
  });
}

test('ODC: studio_data_insert/update with records read nothing before the write when no load is open',async t=>{
  const {createFacadeServer}=await import('../mcp.mjs');const {InMemoryTransport}=await import('@modelcontextprotocol/server');const {Client}=await import('@modelcontextprotocol/client');
  const root=tmp(t);const calls=[];
  const server=await createFacadeServer({env:{...process.env,SSAM_ODC_OFFLINE:'1'},deps:{dataRoot:root,studioData:async args=>{calls.push(args.op);return args.op==='read'
    ?{ok:true,tenant:'synthetic.test',moduleKey:'module-key',entityKey:'entity-key',identifier:'Id',attributes:['Id:E Identifier','Code:Text'],records:[]}:{ok:true};}}});
  const [st,ct]=InMemoryTransport.createLinkedPair();const client=new Client({name:'cx13-r6i',version:'1'});
  t.after(async()=>{await client.close();await server.close();});
  await Promise.all([server.connect(st),client.connect(ct)]);
  for(const operation of ['insert','update']){
    const out=await client.callTool({name:`studio_data_${operation}`,arguments:{module:'M',entity:'E',records:[{Id:'1',Code:'A'}],authorize:'grava o registro sintetico'}});
    const value=out.structuredContent??JSON.parse(out.content[0].text);assert.equal(value.ok,true,JSON.stringify(value));
  }
  assert.deepEqual(calls,['insert','update'],'no identity read on the inline path');
  // With an open load of the lane, the identity is read and the same entity is BUSY, as before.
  await openLoad(root,target);calls.length=0;
  const out=await client.callTool({name:'studio_data_insert',arguments:{module:'M',entity:'E',records:[{Code:'B'}],authorize:'grava outro registro sintetico'}});
  const value=out.structuredContent??JSON.parse(out.content[0].text);
  assert.equal(value.code,'DATA_ENTITY_LOAD_BUSY',JSON.stringify(value));assert.deepEqual(calls,['read'],'the identity read, never the write');
});

test('O11: o11_data insert/update with records run no --schema before the write when no load is open',async t=>{
  const {createSsamServer}=await import('../ssam.mjs');const {LANES}=await import('../lanes.mjs');
  const {InMemoryTransport}=await import('@modelcontextprotocol/server');const {Client}=await import('@modelcontextprotocol/client');
  const root=tmp(t);const calls=[];
  const journalRoot=path.join(root,LANES.o11.lane==='ss5'?'.local/lane-ss5/data/loads':'.local/data/loads');
  const server=await createSsamServer({odc:false,deps:{dataRoot:root,answersRoot:root,runAnvil:async args=>{
    calls.push(args.includes('--schema')?'schema':'data');
    if(args.includes('--schema'))return{ok:true,envelope:{ok:true,data:{module:'SyntheticApp',moduleKey:'module-key',entities:[{name:'E',key:'entity-key',identifier:'Id',attributes:[]}]}}};
    return{ok:true,envelope:{ok:true,data:{ok:true}}};
  }}});
  const [st,ct]=InMemoryTransport.createLinkedPair();const client=new Client({name:'cx13-r6i-o11',version:'1'});
  t.after(async()=>{await client.close();await server.close();});
  await Promise.all([server.connect(st),client.connect(ct)]);
  const call=operation=>client.callTool({name:'o11_data',arguments:{host:'synthetic.test',module:'SyntheticApp',oml:path.join(root,'synthetic.oml'),request:{operation,entity:'E',operationId:`9a960000-0000-4000-8000-00000000000${operation==='insert'?2:3}`,authorization:'grava os registros sinteticos',records:[{Code:'A'}]}}});
  for(const operation of ['insert','update']){const out=await call(operation);const value=out.structuredContent??JSON.parse(out.content[0].text);assert.equal(value.ok,true,JSON.stringify(value));}
  assert.deepEqual(calls,['data','data'],'no --schema on the inline path');
  await openLoad(journalRoot,{...target,lane:'o11',host:'synthetic.test'});calls.length=0;
  const out=await call('insert');const value=out.structuredContent??JSON.parse(out.content[0].text);
  assert.equal(value.code,'DATA_ENTITY_LOAD_BUSY',JSON.stringify(value));assert.deepEqual(calls,['schema'],'the identity read, never the write');
});

test('a file load that starts while an inline write of its lane runs is BUSY until that call ends',async t=>{
  const root=tmp(t),journalRoot=path.join(root,'loads');
  const file=path.join(root,'rows.json');fs.writeFileSync(file,JSON.stringify([{Code:'A'}]));
  const db=[];
  const channel={identity:async()=>target,schema:async()=>({entities:[{name:'E',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'}]}]}),check:async()=>({ok:true}),
    readAll:async()=>({records:db.map(r=>({...r})),complete:true}),write:async ops=>ops.map(op=>({ok:true,ids:op.records.map(record=>{const row={...record,Id:String(db.length+1)};db.push(row);return row.Id;})}))};
  const input={lane:'odc',host:'synthetic.test',module:'M',entity:'E',operation:'insert',files:[file],keys:['Code'],operationId:'9a960000-0000-4000-8000-000000000009',authorization:'carrega o arquivo sintetico'};
  let release,entered;const inside=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  let resolved=0;
  const inline=locks.withInlineDataReservation({lane:'odc'},async()=>{resolved++;return[target];},{journalRoot},()=>{entered();return inside;});
  await started;
  assert.equal(resolved,0,'no open load: the inline write read no identity');
  const busy=await runDataLoad(input,channel,{journalRoot});
  assert.equal(busy.code,'DATA_ENTITY_LOAD_BUSY',JSON.stringify(busy));assert.equal(busy.ownerKind,'inline');assert.equal(busy.ownerHasPlan,false);
  assert.equal(busy.continuation?.arguments?.operationId,input.operationId,'the way out is this same call again');assert.equal(db.length,0);
  release({ok:true});assert.deepEqual(await inline,{ok:true});
  const done=await runDataLoad(input,channel,{journalRoot});assert.equal(done.complete,true,JSON.stringify(done));assert.equal(db.length,1);
});
