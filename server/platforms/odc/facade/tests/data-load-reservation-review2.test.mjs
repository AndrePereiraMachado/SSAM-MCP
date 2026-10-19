import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDataLoad} from '../data-load.mjs';
import {afterPreview,ownerClose,withoutWords} from './helpers/owner-words.mjs';

const id=n=>`b3000000-0000-4000-8000-00000000000${n}`;
function fixture(t,lane){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-exit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'rows.json');fs.writeFileSync(file,JSON.stringify([{Code:'A'},{Code:'B'}]));
  const db=[];let first=true;
  const entity={name:'E',key:'entity-E',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'}]};
  const input={lane,host:'synthetic.test',module:'M',entity:'E',operation:'insert',files:[file],keys:['Code'],operationId:id(1),authorization:'write synthetic data',batchSize:2};
  const options={journalRoot:path.join(root,'loads')};
  const channel={schema:async()=>({moduleKey:'module-m',entities:[entity]}),readAll:async()=>({records:db,complete:true}),write:async ops=>{
    if(first){first=false;db.push({Id:'1',Code:'A'});return[{ok:false,outcome:'failed',ids:['1'],successfulRows:[{index:0,id:'1'}],failedRows:[{index:1,reason:'deterministic constraint'}],error:'deterministic constraint'}];}
    return ops.map(op=>({ok:true,ids:op.records.map(record=>{const Id=String(db.length+1);db.push({Id,...record});return Id;})}));
  }};
  return{root,file,db,input,options,channel};
}
for(const lane of ['o11','odc']){
  test(`N6 ${lane} owner-closed keyed uncertainty permits a new load but can never resume`,async t=>{
    const f=fixture(t,lane);let calls=0;
    f.channel.write=async ops=>{calls++;return ops.map(op=>{const ids=op.records.map(record=>{const Id=String(f.db.length+1);f.db.push({Id,...record});return Id;});return calls===1?{ok:false,outcome:'uncertain',error:'native write outcome unknown'}:{ok:true,ids};});};
    const uncertain=await runDataLoad(f.input,f.channel,f.options);assert.equal(uncertain.outcome,'reconcilable');
    const preview=await runDataLoad({...f.input,close:{preview:true}},f.channel,f.options);assert.equal(preview.closePreview.counts.uncertain,2);const closed=await runDataLoad({...f.input,close:{previewSha256:preview.closePreview.sha256,authorize:ownerClose(preview)}},f.channel,afterPreview(f.options));assert.equal(closed.state,'closed');const receipt=fs.readFileSync(uncertain.receiptFile,'utf8');
    const next=await runDataLoad({...f.input,operationId:id(2),keys:['Code']},f.channel,f.options);
    assert.equal(next.complete,true,JSON.stringify(next));assert.equal(next.unchanged,2);assert.equal(f.db.length,2);assert.equal(calls,1);
    assert.equal(fs.readFileSync(uncertain.receiptFile,'utf8'),receipt);
    const old=await runDataLoad(f.input,f.channel,f.options);assert.equal(old.code,'DATA_LOAD_CLOSED');assert.equal(old.receiptFile,uncertain.receiptFile);assert.equal(calls,1);assert.equal(f.db.length,2);
  });
  test(`N6 ${lane} deterministic failure reserves the entity until the original load resumes`,async t=>{
    const f=fixture(t,lane),failed=await runDataLoad(f.input,f.channel,f.options);
    assert.equal(failed.outcome,'failed');assert.equal(failed.written,1);
    const receipt=fs.readFileSync(failed.receiptFile,'utf8'),journal=fs.readFileSync(path.join(f.root,'loads',id(1),'journal.jsonl'),'utf8');
    const next=await runDataLoad({...f.input,operationId:id(2),keys:['Code']},f.channel,f.options);
    assert.equal(next.code,'DATA_ENTITY_LOAD_BUSY',JSON.stringify(next));assert.equal(f.db.length,1);assert.match(failed.next,/close/i);assert.equal(failed.continuation.arguments.close.preview,true);
    assert.equal(fs.readFileSync(failed.receiptFile,'utf8'),receipt);assert.equal(fs.readFileSync(path.join(f.root,'loads',id(1),'journal.jsonl'),'utf8'),journal);
    const done=await runDataLoad(f.input,f.channel,f.options);assert.equal(done.complete,true,JSON.stringify(done));assert.equal(f.db.length,2);assert.equal(new Set(f.db.map(r=>r.Code)).size,2);
    await runDataLoad(f.input,f.channel,f.options);assert.equal(f.db.length,2);
  });
  test(`N6 ${lane} reused fingerprint preserves the reservation and original resumable receipt`,async t=>{
    const f=fixture(t,lane);let clock=0;
    fs.writeFileSync(f.file,JSON.stringify(Array.from({length:11},(_,i)=>({Code:`K${i}`}))));
    f.channel.write=async ops=>{clock+=1000;return ops.map(op=>({ok:true,ids:op.records.map(record=>{const Id=String(f.db.length+1);f.db.push({Id,...record});return Id;})}));};
    const partial=await runDataLoad({...f.input,batchSize:1,deadlineMs:1000},f.channel,{...f.options,now:()=>clock});
    assert.equal(partial.complete,false);
    const receipt=fs.readFileSync(partial.receiptFile,'utf8');
    const reused=await runDataLoad({...f.input,batchSize:2,keys:['Code']},f.channel,f.options);
    assert.equal(reused.code,'DATA_LOAD_ID_REUSED');assert.match(reused.next,/close/i);assert.equal(reused.continuation.arguments.close.preview,true);assert.equal(fs.readFileSync(partial.receiptFile,'utf8'),receipt);
    const next=await runDataLoad({...f.input,operationId:id(2),keys:['Code']},f.channel,f.options);
    assert.equal(next.code,'DATA_ENTITY_LOAD_BUSY',JSON.stringify(next));
    const done=await runDataLoad({...f.input,batchSize:1},f.channel,f.options);assert.equal(done.complete,true,JSON.stringify(done));assert.equal(f.db.length,11);assert.equal(new Set(f.db.map(r=>r.Code)).size,11);
    await runDataLoad({...f.input,batchSize:1},f.channel,f.options);assert.equal(f.db.length,11);
  });
  test(`N6 ${lane} dead execution owner cannot abandon a resumable failed reservation`,async t=>{
    const f=fixture(t,lane);const failed=await runDataLoad(f.input,f.channel,f.options);
    const dir=path.join(f.root,'loads','.entities');fs.mkdirSync(dir,{recursive:true});
    const reservation=path.join(dir,fs.readdirSync(dir).find(name=>name.endsWith('.json')));const owner=JSON.parse(fs.readFileSync(reservation,'utf8'));assert.equal(owner.operationId,id(1));fs.writeFileSync(reservation,JSON.stringify({...owner,pid:2147483647}));
    const next=await runDataLoad({...f.input,operationId:id(2),keys:['Code']},f.channel,f.options);
    assert.equal(next.code,'DATA_ENTITY_LOAD_BUSY',JSON.stringify(next));assert.equal(f.db.length,1);assert.ok(fs.existsSync(failed.receiptFile));
    const done=await runDataLoad(f.input,f.channel,f.options);assert.equal(done.complete,true,JSON.stringify(done));assert.equal(f.db.length,2);assert.equal(new Set(f.db.map(r=>r.Code)).size,2);
  });
}
