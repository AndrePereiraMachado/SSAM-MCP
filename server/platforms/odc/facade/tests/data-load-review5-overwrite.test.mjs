import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDataLoad} from '../data-load.mjs';

// U1 (review 5, owner decision of 2026-10-17): no file write overwrites an existing row without a preview and the
// owner's words with the number of rows. The KEYS_REQUIRED continuation is a dryRun; a column unique only in the file
// is never chosen alone; the dryRun shows insert / update (current -> new) / unchanged per row; an insert that turns
// into an update, a recheck and a reconciliation that diverge (another writer's value included) stop before writing;
// new rows (pure inserts) need no words; the receipt keeps the previous value of every updated row.
const customer={name:'Customer',identifier:'Id',indexes:[],attributes:[{name:'Id',type:'Customer Identifier'},{name:'Name',type:'Text'},{name:'Email',type:'Text'},{name:'City',type:'Text'}]};
const stock={name:'Stock',identifier:'Id',indexes:[],attributes:[{name:'Id',type:'Stock Identifier'},{name:'Sku',type:'Text'},{name:'Qty',type:'Integer'}]};
const indexed={...stock,name:'Indexed',indexes:[{unique:true,attributes:['Sku']}]};
let sequence=0;
const uuid=()=>`a5000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
function fixture(t,lane,entity,db=[]){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r5u-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const clock={at:Date.parse('2026-10-17T12:00:00Z')};let nextId=100;const sent=[],overwritten=[];const faults={};
  const channel={schema:async()=>({entities:[entity]}),check:async()=>({ok:true}),readAll:async()=>({records:db.map(r=>({...r})),complete:true}),
    write:async ops=>ops.map(op=>{
      if(faults.notSubmitted){faults.notSubmitted--;sent.push({op:op.operation,refused:true});return{ok:false,outcome:'not-submitted',code:'STUDIO_BUSY'};}
      sent.push({op:op.operation,records:op.records});
      const ids=op.records.map(record=>{
        if(op.operation==='update'){const row=db.find(r=>String(r.Id)===String(record.Id));overwritten.push({before:{...row},after:{...row,...record}});Object.assign(row,record);return String(row.Id);}
        const row={...record,Id:String(nextId++)};db.push(row);return row.Id;
      });
      if(faults.lose){faults.lose--;return{ok:false,outcome:'uncertain',code:'DATA_OUTCOME_UNKNOWN',error:'synthetic lost response'};}
      return{ok:true,outcome:'completed',ids};
    })};
  const file=(name,text)=>{const f=path.join(root,name);fs.writeFileSync(f,text);return f;};
  // Review 6: words are seen per host in the CX15 store; each test has its own store, as it had its own journal before.
  const options={journalRoot:path.join(root,'loads'),now:()=>clock.at,destructive:{root:path.join(root,'destructive')}};
  const later=(ms=6000)=>{clock.at+=ms;return options;};
  return{root,db,channel,sent,overwritten,faults,file,options,later,clock,
    input:extra=>({lane,host:'synthetic.test',module:'Crm',entity:entity.name,operationId:uuid(),authorization:'pode carregar os registros do arquivo',...extra})};
}
const argsOf=continuation=>continuation?.arguments?.request??continuation?.arguments??{};

for(const lane of ['o11','odc']){
  test(`U1 ${lane}: KEYS_REQUIRED never chooses a column unique only in the file and never continues with a write`,async t=>{
    const f=fixture(t,lane,customer,[{Id:'1',Name:'Ana Souza',Email:'ana.sp@example.test',City:'Sao Paulo'}]);
    const input=f.input({operation:'insert',files:[f.file('novos.csv','Name,Email,City\nAna Souza,ana.rj@example.test,Rio\nBruno Lima,bruno@example.test,Recife\n')]});
    const out=await runDataLoad(input,f.channel,f.options);
    assert.equal(out.code,'DATA_LOAD_KEYS_REQUIRED');assert.equal(f.sent.length,0);
    assert.ok(out.keyCandidates.some(c=>c.keys[0]==='Name'),'file columns are listed for the owner');
    assert.equal(out.continuation,undefined,'no model unique index: nothing is chosen for the owner');
    assert.equal(out.correctedRequest,undefined);
    assert.match(out.next,/owner/i);
    assert.deepEqual(f.db,[{Id:'1',Name:'Ana Souza',Email:'ana.sp@example.test',City:'Sao Paulo'}]);
  });
  test(`U1 ${lane}: a model unique index continues only as a dryRun that shows each row`,async t=>{
    const f=fixture(t,lane,indexed,[{Id:'7',Sku:'SKU-1',Qty:'1'},{Id:'8',Sku:'SKU-3',Qty:'3'}]);
    const input=f.input({operation:'insert',files:[f.file('stock.csv','Sku,Qty\nSKU-1,100\nSKU-2,5\nSKU-3,3\n')]});
    const out=await runDataLoad(input,f.channel,f.options);
    assert.equal(out.code,'DATA_LOAD_KEYS_REQUIRED');
    const args=argsOf(out.continuation);assert.equal(args.dryRun,true);assert.deepEqual(args.keys,['Sku']);
    const dry=await runDataLoad({...input,...args},f.channel,f.options);
    assert.equal(dry.dryRun,true);assert.equal(dry.written,0);assert.equal(f.sent.length,0);
    assert.deepEqual([dry.inserted,dry.updated,dry.unchanged],[1,1,1]);
    const rows=JSON.parse(fs.readFileSync(dry.rowsPreviewFile,'utf8'));
    assert.deepEqual(rows.map(r=>r.action),['update','insert','unchanged']);
    assert.deepEqual(rows[0].changes,{Qty:{from:'1',to:'100'}});assert.equal(rows[0].id,'7');
    assert.equal(dry.updatePreview.count,1);assert.ok(dry.updatePreview.sha256);
    assert.equal(argsOf(dry.continuation).confirmUpdates.previewSha256,dry.updatePreview.sha256);
    assert.equal(argsOf(dry.continuation).dryRun,undefined);
  });
  test(`U1 ${lane}: an insert over an existing key stops before any write and asks the owner's counted words`,async t=>{
    const f=fixture(t,lane,stock,[{Id:'7',Sku:'SKU-1',Qty:'1'}]);
    const input=f.input({operation:'insert',keys:['Sku'],files:[f.file('stock.csv','Sku,Qty\nSKU-1,100\nSKU-2,5\n')]});
    const stop=await runDataLoad(input,f.channel,f.options);
    assert.equal(stop.ok,false);assert.equal(stop.code,'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED');assert.equal(stop.written,0);
    assert.equal(f.sent.length,0,'not even the new row is sent before the owner answers');
    assert.equal(stop.updatePreview.count,1);assert.deepEqual(stop.updatePreview.rows[0].changes,{Qty:{from:'1',to:'100'}});
    assert.equal(stop.updatePreview.inserts,1);
    const cont=argsOf(stop.continuation);assert.equal(cont.authorization,undefined);assert.match(cont.confirmUpdates.authorize,/^<.*>$/);
    assert.equal((await runDataLoad(f.input({operation:'insert',keys:['Sku'],files:[f.file('other.csv','Sku,Qty\nSKU-9,9\n')]}),f.channel,f.options)).complete,true,'a stop holds no reservation');
    f.sent.length=0;
    for(const words of [input.authorization,'ok','atualizar 99 linhas',cont.confirmUpdates.authorize]){
      const refused=await runDataLoad({...input,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:words}},f.channel,f.later());
      // Review 6 (R6-F15, converted): the template is a server text, refused by the one predicate before any read (WORDS_REQUIRED).
      assert.equal(refused.ok,false);assert.equal(refused.code,words===cont.confirmUpdates.authorize?'WORDS_REQUIRED':'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED');assert.equal(f.sent.length,0,`no write with ${words}`);
    }
    assert.equal(f.db.find(r=>r.Sku==='SKU-1').Qty,'1');
    const done=await runDataLoad({...cont,lane,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:'sim, pode atualizar 1 linha'}},f.channel,f.later());
    assert.equal(done.complete,true,JSON.stringify(done));assert.deepEqual([done.inserted,done.updated],[1,1]);
    assert.equal(f.db.find(r=>r.Sku==='SKU-1').Qty,'100');
    const receipt=JSON.parse(fs.readFileSync(done.receiptFile,'utf8'));
    assert.deepEqual(receipt.updatedRows.map(r=>({id:r.id,changes:r.changes})),[{id:'7',changes:{Qty:{from:'1',to:'100'}}}]);
  });
  test(`U1 ${lane}: values changed after the preview make a new preview, never a write`,async t=>{
    const f=fixture(t,lane,stock,[{Id:'7',Sku:'SKU-1',Qty:'1'}]);
    const input=f.input({operation:'insert',keys:['Sku'],files:[f.file('stock.csv','Sku,Qty\nSKU-1,100\n')]});
    const stop=await runDataLoad(input,f.channel,f.options);
    f.db[0].Qty='50';
    const changed=await runDataLoad({...input,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:'pode atualizar 1 linha'}},f.channel,f.later());
    assert.equal(changed.code,'DATA_LOAD_UPDATE_PREVIEW_CHANGED');assert.notEqual(changed.updatePreview.sha256,stop.updatePreview.sha256);
    assert.deepEqual(changed.updatePreview.rows[0].changes,{Qty:{from:'50',to:'100'}});assert.equal(f.sent.length,0);
  });
  test(`U1 ${lane}: an update by file also previews and needs the counted words`,async t=>{
    const f=fixture(t,lane,stock,[{Id:'7',Sku:'SKU-1',Qty:'1'},{Id:'8',Sku:'SKU-2',Qty:'2'}]);
    const input=f.input({operation:'update',keys:['Sku'],files:[f.file('stock.csv','Sku,Qty\nSKU-1,10\nSKU-2,20\n')]});
    const stop=await runDataLoad(input,f.channel,f.options);
    assert.equal(stop.code,'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED');assert.equal(stop.updatePreview.count,2);assert.equal(f.sent.length,0);
    const done=await runDataLoad({...input,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:'confirmo as 2 linhas'}},f.channel,f.later());
    assert.equal(done.complete,true);assert.equal(done.updated,2);assert.deepEqual(f.db.map(r=>r.Qty),['10','20']);
  });
  test(`U1 ${lane}: new rows need no words`,async t=>{
    const f=fixture(t,lane,stock,[{Id:'7',Sku:'SKU-1',Qty:'1'}]);
    const out=await runDataLoad(f.input({operation:'insert',keys:['Sku'],files:[f.file('stock.csv','Sku,Qty\nSKU-1,1\nSKU-2,5\n')]}),f.channel,f.options);
    assert.equal(out.complete,true);assert.deepEqual([out.inserted,out.updated,out.unchanged],[1,0,1]);assert.equal(f.overwritten.length,0);
  });
  test(`U1 ${lane}: another writer's value found on resume stops before the overwrite`,async t=>{
    const f=fixture(t,lane,stock,[]);f.faults.notSubmitted=1;
    const input=f.input({operation:'insert',keys:['Sku'],files:[f.file('stock.csv','Sku,Qty\nSKU-9,3\n')]});
    const first=await runDataLoad(input,f.channel,f.options);assert.equal(first.state,'resumable');
    f.db.push({Id:'55',Sku:'SKU-9',Qty:'42'});
    const stop=await runDataLoad(input,f.channel,f.options);
    assert.equal(stop.code,'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED');assert.equal(stop.state,'resumable');
    assert.deepEqual(stop.updatePreview.rows[0].changes,{Qty:{from:'42',to:'3'}});assert.equal(f.db[0].Qty,'42');assert.equal(f.overwritten.length,0);
    const resume=argsOf(stop.continuation);assert.equal(resume.authorization,undefined);
    const done=await runDataLoad({...resume,lane,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:'pode sobrescrever 1 linha'}},f.channel,f.later());
    assert.equal(done.complete,true,JSON.stringify(done));assert.equal(f.db[0].Qty,'3');
    assert.deepEqual(JSON.parse(fs.readFileSync(done.receiptFile,'utf8')).updatedRows[0].changes,{Qty:{from:'42',to:'3'}});
  });
  test(`U1 ${lane}: a reconciliation that finds another writer's value stops before the overwrite`,async t=>{
    const f=fixture(t,lane,stock,[]);f.faults.lose=1;
    const input=f.input({operation:'insert',keys:['Sku'],files:[f.file('stock.csv','Sku,Qty\nSKU-1,1\nSKU-2,2\n')],batchSize:1});
    const first=await runDataLoad(input,f.channel,f.options);assert.equal(first.complete,false);
    f.db[0].Qty='20';
    const stop=await runDataLoad(input,f.channel,f.options);
    assert.equal(stop.code,'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED');assert.deepEqual(stop.updatePreview.rows.map(r=>r.changes),[{Qty:{from:'20',to:'1'}}]);
    assert.equal(f.db[0].Qty,'20');assert.equal(f.overwritten.length,0);
    const done=await runDataLoad({...input,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:'sim, 1 linha'}},f.channel,f.later());
    assert.equal(done.complete,true,JSON.stringify(done));assert.deepEqual(f.db.map(r=>[r.Sku,r.Qty]),[['SKU-1','1'],['SKU-2','2']]);
  });
}
