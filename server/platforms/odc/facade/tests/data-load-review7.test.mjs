import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDataLoad} from '../data-load.mjs';
import * as locks from '../data-load-lock.mjs';

// Review 7 of CX13.
// R7-1: an inline o11_data write whose kernel call throws (a dead worker, a cancelled call) may have run: it is never
//       answered "not-sent". Only a failed read of the target identity (nothing sent yet) is "not-sent", as in the ODC
//       facade; any other error goes up to the hub, which answers TASK_FAILED_UNCERTAIN (outcome "uncertain"), as the
//       candidate does without the CX13 reservation.
// R7-2: an overwrite that ran but lost its answer, reconciled when the same load resumes, stays in the final receipt with
//       its previous value (owner decision U1 of 2026-10-17: the receipt keeps the previous value), whole batch or part.
const tmp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r7-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};

async function o11Hub(t,runAnvil){
  const {createSsamServer}=await import('../ssam.mjs');
  const {InMemoryTransport}=await import('@modelcontextprotocol/server');const {Client}=await import('@modelcontextprotocol/client');
  const root=tmp(t);
  const server=await createSsamServer({odc:false,deps:{dataRoot:root,answersRoot:root,runAnvil}});
  const [st,ct]=InMemoryTransport.createLinkedPair();const client=new Client({name:'cx13-r7',version:'1'});
  t.after(async()=>{await client.close();await server.close();});
  await Promise.all([server.connect(st),client.connect(ct)]);
  const call=async(operation='insert')=>{const out=await client.callTool({name:'o11_data',arguments:{host:'synthetic.test',module:'SyntheticApp',oml:path.join(root,'x.oml'),
    request:{operation,entity:'E',operationId:'b7700000-0000-4000-8000-000000000001',authorization:'grava o registro sintetico inline',records:[{Code:'A'}]}}});return out.structuredContent??JSON.parse(out.content[0].text);};
  return{root,call};
}
const schemaReply={ok:true,envelope:{ok:true,data:{module:'SyntheticApp',moduleKey:'module-key',entities:[{name:'E',key:'entity-key',identifier:'Id',attributes:[]}]}}};

for(const [label,error] of [['the worker died while writing',Object.assign(new Error('Uncertain write: the O11 worker exited while writing'),{replayable:false})],
  ['the call was aborted',Object.assign(new Error('The operation was aborted'),{name:'AbortError',code:'ABORT_ERR'})]]){
  test(`R7-1 O11 inline: a kernel write that throws (${label}) is uncertain, never not-sent`,async t=>{
    const calls=[];
    const {call}=await o11Hub(t,async args=>{calls.push(args.includes('--schema')?'schema':'data');if(args.includes('--schema'))return schemaReply;throw error;});
    const value=await call();
    assert.equal(value.ok,false);assert.equal(value.outcome,'uncertain',JSON.stringify(value).slice(0,300));
    assert.equal(value.code,'TASK_FAILED_UNCERTAIN');assert.deepEqual(calls,['data']);
  });
}
test('R7-1 O11 inline: a failed read of the target identity (an open load of the lane) is not-sent, nothing written',async t=>{
  const calls=[];
  const {root,call}=await o11Hub(t,async args=>{calls.push(args.includes('--schema')?'schema':'data');if(args.includes('--schema'))throw Object.assign(new Error('synthetic schema read failed'),{code:'DATA_READ_UNAVAILABLE'});return{ok:true,envelope:{ok:true,data:{ok:true}}};});
  const {LANES}=await import('../lanes.mjs');
  const journalRoot=path.join(root,LANES.o11.lane==='ss5'?'.local/lane-ss5/data/loads':'.local/data/loads'),id='b7700000-0000-4000-8000-0000000000aa';
  await locks.withDataLoadLock({operationId:id},{journalRoot},async({acquireEntity})=>{assert.equal(await acquireEntity({lane:'o11',host:'synthetic.test',moduleKey:'module-key',entityKey:'other-entity'}),null);
    const dir=path.join(journalRoot,id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify({validated:true,state:'resumable'}));return{ok:false};});
  const value=await call();
  assert.equal(value.outcome,'not-sent',JSON.stringify(value).slice(0,300));assert.equal(value.code,'DATA_READ_UNAVAILABLE');assert.deepEqual(calls,['schema'],'never the write');
});

// R7-2: the overwrites are confirmed; their update runs and the answer is lost (or is lost before it runs); the same load
// resumes and completes. 'one row': a batch of one update (the whole batch is reconciled). 'two rows': one batch of two
// updates whose answer is lost; before the resume another writer puts SKU-3 back, so the reconciliation confirms SKU-1
// (a part of the batch, kind rows) and sends SKU-3 again.
const stock={name:'Stock',identifier:'Id',indexes:[],attributes:[{name:'Id',type:'Stock Identifier'},{name:'Sku',type:'Text'},{name:'Qty',type:'Integer'}]};
let sequence=0;
for(const lane of ['o11','odc'])for(const mode of ['applied-then-lost','lost-before-applied'])for(const shape of ['one row','two rows']){
  test(`R7-2 ${lane}: overwrites ${mode} and reconciled on resume keep their previous value in the final receipt (${shape})`,async t=>{
    const root=tmp(t);const two=shape==='two rows';
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'},...(two?[{Id:'8',Sku:'SKU-3',Qty:'3'}]:[])];const clock={at:Date.parse('2026-10-17T12:00:00Z')};let fault=1;
    const channel={schema:async()=>({entities:[stock]}),check:async()=>({ok:true}),readAll:async()=>({records:db.map(r=>({...r})),complete:true}),
      write:async ops=>ops.map(op=>{
        if(fault&&op.operation==='update'&&mode==='lost-before-applied'){fault--;return{ok:false,outcome:'uncertain',code:'DATA_OUTCOME_UNKNOWN',error:'synthetic answer lost before apply'};}
        const ids=op.records.map(record=>{if(op.operation==='update'){const row=db.find(r=>String(r.Id)===String(record.Id));Object.assign(row,record);return String(row.Id);}const row={...record,Id:String(100+db.length)};db.push(row);return row.Id;});
        if(fault&&op.operation==='update'&&mode==='applied-then-lost'){fault--;return{ok:false,outcome:'uncertain',code:'DATA_OUTCOME_UNKNOWN',error:'synthetic answer lost after apply'};}
        return{ok:true,outcome:'completed',ids};
      })};
    const file=path.join(root,'x.csv');fs.writeFileSync(file,two?'Sku,Qty\nSKU-1,100\nSKU-3,300\nSKU-2,5\n':'Sku,Qty\nSKU-1,100\nSKU-2,5\n');
    const options={journalRoot:path.join(root,'j'),now:()=>clock.at,destructive:{root:path.join(root,'d')}};
    const X={lane,host:'synthetic.test',module:'M',entity:'Stock',operation:'insert',keys:['Sku'],files:[file],operationId:`b7720000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,authorization:'carregar a reconciliacao sintetica',batchSize:two?2:1};
    const stop=await runDataLoad(X,channel,options);clock.at+=6000;
    assert.equal(stop.code,'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED');assert.equal(stop.updatePreview.count,two?2:1);
    const first=await runDataLoad({...X,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:`pode atualizar ${two?2:1} linhas, ${lane} ${mode} ${shape}`}},channel,options);
    assert.equal(first.code,'DATA_OUTCOME_UNKNOWN',JSON.stringify(first).slice(0,300));
    if(two&&mode==='applied-then-lost')db.find(r=>r.Sku==='SKU-3').Qty='3'; // another writer puts SKU-3 back
    clock.at+=6000;
    const end=await runDataLoad({...X,authorization:undefined},channel,options);
    assert.equal(end.complete,true,JSON.stringify(end).slice(0,400));
    assert.deepEqual(db.map(r=>[r.Sku,r.Qty]).sort(),two?[['SKU-1','100'],['SKU-2','5'],['SKU-3','300']]:[['SKU-1','100'],['SKU-2','5']]);
    const receipt=JSON.parse(fs.readFileSync(end.receiptFile,'utf8'));
    assert.deepEqual(receipt.updatedRows?.map(r=>[r.globalRow,r.id,r.changes]),[[1,'7',{Qty:{from:'1',to:'100'}}],...(two?[[2,'8',{Qty:{from:'3',to:'300'}}]]:[])],'the final receipt keeps the previous value');
    assert.equal(receipt.uncertainUpdatedRows,undefined);
  });
}
