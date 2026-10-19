import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDataLoad} from '../data-load.mjs';

// R6-U1b (review 6, owner decision U1 of 2026-10-17: "the receipt keeps the previous value"): EVERY receipt of a load that
// updated rows lists them as updatedRows (current -> new), not only the completed one: a failed, a cancelled (partial),
// an uncertain and a closed receipt too. A row whose update was sent and whose answer was lost is listed with its previous
// value as uncertainUpdatedRows: if the write happened, the receipt is the only place that value still lives.
const stock={name:'Stock',identifier:'Id',indexes:[],attributes:[{name:'Id',type:'Stock Identifier'},{name:'Sku',type:'Text'},{name:'Qty',type:'Integer'}]};
let sequence=0;
const uuid=()=>`b6200000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
const letters=n=>{let s='';do{s=String.fromCharCode(97+n%26)+s;n=Math.floor(n/26)-1;}while(n>=0);return s;};
let said=0;
// The owner's reply after a preview: a new sentence each time (never words said before), with the exact count.
const ownerSays=count=>`sim, pode atualizar ${count} linha, resposta ${letters(said++)}`;
function fixture(t,lane,db){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r6r-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const clock={at:Date.parse('2026-10-17T12:00:00Z')};let nextId=100;const sent=[];const faults={failInsert:0,loseUpdate:0};
  const channel={schema:async()=>({entities:[stock]}),check:async()=>({ok:true}),readAll:async()=>({records:db.map(r=>({...r})),complete:true}),
    write:async ops=>ops.map(op=>{
      if(op.operation==='insert'&&faults.failInsert){faults.failInsert--;sent.push({op:op.operation,failed:true});return{ok:false,outcome:'failed',failedRows:op.records.map((_,index)=>({index,reason:'synthetic constraint'}))};}
      sent.push({op:op.operation,records:op.records});
      const ids=op.records.map(record=>{
        if(op.operation==='update'){const row=db.find(r=>String(r.Id)===String(record.Id));Object.assign(row,record);return String(row.Id);}
        const row={...record,Id:String(nextId++)};db.push(row);return row.Id;});
      if(op.operation==='update'&&faults.loseUpdate){faults.loseUpdate--;return{ok:false,outcome:'uncertain',code:'DATA_OUTCOME_UNKNOWN',error:'synthetic lost response'};}
      return{ok:true,outcome:'completed',ids};
    })};
  const file=(name,text)=>{const f=path.join(root,name);fs.writeFileSync(f,text);return f;};
  const options=()=>({journalRoot:path.join(root,'loads'),now:()=>clock.at,destructive:{root:path.join(root,'destructive')}});
  return{root,channel,sent,faults,file,options,later:(ms=6000)=>{clock.at+=ms;}};
}
const receiptOf=out=>JSON.parse(fs.readFileSync(out.receiptFile,'utf8'));
const qty={Qty:{from:'1',to:'100'}};
// Stops at the update preview, then the owner confirms it with fresh counted words.
async function confirmed(f,input){
  const stop=await runDataLoad(input,f.channel,f.options());
  assert.equal(stop.code,'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED',JSON.stringify(stop).slice(0,400));
  f.later();
  return runDataLoad({...input,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:ownerSays(stop.updatePreview.count)}},f.channel,f.options());
}

for(const lane of ['o11','odc']){
  test(`U1b ${lane}: a failed load and its closed receipt keep the previous value of the row it updated`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,lane,db);f.faults.failInsert=99;
    const input={lane,host:'synthetic.test',module:'M',entity:'Stock',operation:'insert',keys:['Sku'],files:[f.file('stock.csv','Sku,Qty\nSKU-1,100\nSKU-2,5\n')],operationId:uuid(),authorization:'carregar o estoque do arquivo u1b',batchSize:1};
    const failed=await confirmed(f,input);
    assert.equal(failed.code,'DATA_WRITE_FAILED');assert.equal(db[0].Qty,'100','the confirmed update was written');
    const receipt=receiptOf(failed);
    assert.deepEqual(receipt.updatedRows?.map(r=>[r.globalRow,r.id,r.changes]),[[1,'7',qty]],'the failed receipt keeps the previous value');
    const preview=await runDataLoad({...input,authorization:undefined,close:{preview:true}},f.channel,f.options());
    assert.ok(preview.closePreview?.sha256,JSON.stringify(preview).slice(0,300));
    f.later();
    const closed=await runDataLoad({...input,authorization:undefined,close:{previewSha256:preview.closePreview.sha256,authorize:`pode fechar a carga, ${preview.closePreview.count} linha fica sem escrita`}},f.channel,f.options());
    assert.equal(closed.state,'closed',JSON.stringify(closed).slice(0,400));
    assert.deepEqual(receiptOf(closed).updatedRows?.map(r=>[r.globalRow,r.id,r.changes]),[[1,'7',qty]],'the closed receipt keeps the previous value');
    const again=await runDataLoad({...input,authorization:undefined},f.channel,f.options());
    assert.equal(again.code,'DATA_LOAD_CLOSED');assert.deepEqual(receiptOf(again).updatedRows?.map(r=>r.globalRow),[1]);
  });
  test(`U1b ${lane}: a cancelled load keeps the previous value of the rows it updated before the cancellation`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,lane,db);
    // Twelve one-row batches: the O11 lane sends ten per kernel call, so the cancellation lands between calls on both lanes.
    const rows=Array.from({length:11},(_,i)=>`SKU-${i+2},${i+2}`).join('\n');
    const input={lane,host:'synthetic.test',module:'M',entity:'Stock',operation:'insert',keys:['Sku'],files:[f.file('stock.csv',`Sku,Qty\nSKU-1,100\n${rows}\n`)],operationId:uuid(),authorization:'carregar o estoque do arquivo u1b cancel',batchSize:1};
    const stop=await runDataLoad(input,f.channel,f.options());f.later();
    const controller=new AbortController();const write=f.channel.write;
    f.channel.write=async ops=>{const out=await write(ops);controller.abort();return out;};
    const cancelled=await runDataLoad({...input,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:ownerSays(1)}},f.channel,{...f.options(),signal:controller.signal});
    assert.equal(cancelled.code,'CANCELLED',JSON.stringify(cancelled).slice(0,400));assert.equal(db[0].Qty,'100');
    assert.deepEqual(receiptOf(cancelled).updatedRows?.map(r=>[r.globalRow,r.id,r.changes]),[[1,'7',qty]]);
  });
  test(`U1b ${lane}: a lost answer of an update keeps the previous value as uncertain`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,lane,db);f.faults.loseUpdate=1;
    const input={lane,host:'synthetic.test',module:'M',entity:'Stock',operation:'insert',keys:['Sku'],files:[f.file('stock.csv','Sku,Qty\nSKU-1,100\n')],operationId:uuid(),authorization:'carregar o estoque do arquivo u1b lost'};
    const lost=await confirmed(f,input);
    assert.equal(lost.code,'DATA_OUTCOME_UNKNOWN',JSON.stringify(lost).slice(0,400));
    const receipt=receiptOf(lost);
    assert.deepEqual(receipt.uncertainUpdatedRows?.map(r=>[r.globalRow,r.id,r.changes]),[[1,'7',qty]],'the value the uncertain write may have overwritten');
  });
}
