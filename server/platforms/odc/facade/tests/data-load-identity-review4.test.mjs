import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as locks from '../data-load-lock.mjs';
const id='9a900000-0000-4000-8000-000000000001';
const target={lane:'odc',tenant:'https://SYNTHETIC.TEST:443/',moduleKey:'module-key',entityKey:'entity-key',identifier:'Id',module:'Synthetic App',entity:'E'};
test('canonical reservation ignores resolved alias spelling and normalizes environment',()=>{
  assert.equal(typeof locks.normalizeDataTarget,'function');
  assert.deepEqual(locks.normalizeDataTarget(target),locks.normalizeDataTarget({...target,tenant:'synthetic.test',module:'syntheticapp',entity:'Alias'}));
  assert.deepEqual(locks.normalizeDataTarget({...target,lane:'o11',host:'HTTPS://SYNTHETIC.TEST:443/'}),locks.normalizeDataTarget({...target,lane:'o11',host:'synthetic.test'}));
});
test('inline insert and update share the durable canonical load reservation',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-n9-'));let sends=0;
 try {
  await locks.withDataLoadLock({operationId:id},{journalRoot:root},async ({acquireEntity})=>{
   assert.equal(await acquireEntity(target),null);
   const dir=path.join(root,id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify({validated:true,state:'resumable'}));
   return {ok:false,complete:false};
  });
  assert.equal(typeof locks.withDataEntityReservation,'function');
  for(const module of ['syntheticapp','Synthetic App','module-key']) for(const operation of ['insert','update']) {
   const result=await locks.withDataEntityReservation({...target,module,tenant:'synthetic.test'},{journalRoot:root},async()=>{sends++;return {ok:true,operation};});
   assert.equal(result.code,'DATA_ENTITY_LOAD_BUSY');assert.equal(result.otherOperationId,id);
  }
  assert.equal(sends,0);
  const independent=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-n9-other-'));
  try{assert.equal((await locks.withDataEntityReservation(target,{journalRoot:independent},async()=>({ok:true}))).ok,true);}finally{fs.rmSync(independent,{recursive:true,force:true});}
  fs.writeFileSync(path.join(root,id,'plan.json'),JSON.stringify({validated:true,state:'closed'}));
  assert.equal((await locks.withDataEntityReservation(target,{journalRoot:root},async()=>({ok:true}))).ok,true);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('ODC MCP insert/update aliases are blocked by the same file-load reservation',async()=>{
 const {createFacadeServer}=await import('../mcp.mjs');
 const {InMemoryTransport}=await import('@modelcontextprotocol/server');
 const {Client}=await import('@modelcontextprotocol/client');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-n9-mcp-'));let sends=0;
 const server=await createFacadeServer({env:{...process.env,SSAM_ODC_OFFLINE:'1'},deps:{dataRoot:root,studioData:async args=>{
  if(args.op==='read')return {ok:true,tenant:'synthetic.test',moduleKey:'module-key',entityKey:'entity-key',identifier:'Id',attributes:['Id:E Identifier','Code:Text'],records:[]};
  sends++;return {ok:true};
 }}});
 const [st,ct]=InMemoryTransport.createLinkedPair();
 const client=new Client({name:'cx13-n9',version:'1'});
 try {
  await Promise.all([server.connect(st),client.connect(ct)]);
  await locks.withDataLoadLock({operationId:id},{journalRoot:root},async ({acquireEntity})=>{
   assert.equal(await acquireEntity(target),null);const dir=path.join(root,id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify({validated:true,state:'resumable'}));return{ok:false};
  });
  for(const module of ['syntheticapp','Synthetic App','module-key'])for(const operation of ['insert','update']){
   const out=await client.callTool({name:`studio_data_${operation}`,arguments:{module,entity:'E',records:[{Code:'A'}],authorize:'load synthetic rows'}});
   const value=out.structuredContent??JSON.parse(out.content[0].text);assert.equal(value.code,'DATA_ENTITY_LOAD_BUSY',JSON.stringify(value));
  }
  assert.equal(sends,0);
 }finally{await client.close();await server.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('O11 MCP insert/update share canonical host and target keys with file loads',async()=>{
 const {createSsamServer}=await import('../ssam.mjs');const {LANES}=await import('../lanes.mjs');
 const {InMemoryTransport}=await import('@modelcontextprotocol/server');const {Client}=await import('@modelcontextprotocol/client');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-n9-o11-'));let sends=0;
 const journalRoot=path.join(root,LANES.o11.lane==='ss5'?'.local/lane-ss5/data/loads':'.local/data/loads');
 const server=await createSsamServer({odc:false,deps:{dataRoot:root,answersRoot:root,runAnvil:async args=>{
  if(args.includes('--schema'))return{ok:true,envelope:{ok:true,data:{module:'SyntheticApp',moduleKey:'module-key',entities:[{name:'E',key:'entity-key',identifier:'Id',attributes:[]}]}}};
  sends++;return{ok:true,envelope:{ok:true,data:{ok:true}}};
 }}});
 const [st,ct]=InMemoryTransport.createLinkedPair();const client=new Client({name:'cx13-n9-o11',version:'1'});
 try{
  await Promise.all([server.connect(st),client.connect(ct)]);
  await locks.withDataLoadLock({operationId:id},{journalRoot},async({acquireEntity})=>{
   assert.equal(await acquireEntity({...target,lane:'o11',host:'synthetic.test'}),null);const dir=path.join(journalRoot,id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify({validated:true,state:'resumable'}));return{ok:false};
  });
  for(const host of ['synthetic.test','SYNTHETIC.TEST','https://SYNTHETIC.TEST:443/'])for(const operation of ['insert','update']){
   const out=await client.callTool({name:'o11_data',arguments:{host,module:'SyntheticApp',oml:path.join(root,'synthetic.oml'),request:{operation,entity:'E',operationId:'9a900000-0000-4000-8000-000000000002',authorization:'load synthetic rows',records:[{Code:'A'}]}}});
   const value=out.structuredContent??JSON.parse(out.content[0].text);assert.equal(value.code,'DATA_ENTITY_LOAD_BUSY',JSON.stringify(value));
  }
  assert.equal(sends,0);
 }finally{await client.close();await server.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('an inline call holds reservation through settlement and releases even on failure',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-n9-inline-'));let finish;
 const settled=new Promise(resolve=>{finish=resolve;});let entered;
 const started=new Promise(resolve=>{entered=resolve;});
 try{
  const running=locks.withDataEntityReservation(target,{journalRoot:root},async()=>{entered();await settled;throw new Error('synthetic failed inline call');});
  await started;
  const blocked=await locks.withDataEntityReservation(target,{journalRoot:root},async()=>({ok:true}));assert.equal(blocked.code,'DATA_ENTITY_LOAD_BUSY');
  finish();await assert.rejects(running,/synthetic failed inline call/);
  assert.equal((await locks.withDataEntityReservation(target,{journalRoot:root},async()=>({ok:true}))).ok,true);
 }finally{finish();fs.rmSync(root,{recursive:true,force:true});}
});
