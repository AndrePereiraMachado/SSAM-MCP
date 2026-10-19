import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDataLoad} from '../data-load.mjs';
import {isWrite} from '../studio-write-lock.mjs';
import {stateOf} from '../ssam-task.mjs';

// F12 (review 5, fence with CX12): a keyed file load is idempotent by operationId + keys, so an unknown write outcome
// is settled by the very call that resumes it. Its answer declares itself reconcilable (never outcome 'uncertain'), so
// a retry guard that holds 'uncertain' writes (CX12 call-deadline / ssam-task stateOf) does not loop; the resume works
// even when a layer strips the owner's words from the continuation. A close preview is not a write, like a dryRun.
const entity={name:'E',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'},{name:'Qty',type:'Integer'}],indexes:[]};
function fixture(t,lane){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r5f-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'rows.json');fs.writeFileSync(file,JSON.stringify([{Code:'A',Qty:1},{Code:'B',Qty:2}]));
  const db=[];let lose=1,sends=0;
  const channel={schema:async()=>({entities:[entity]}),check:async()=>({ok:true}),readAll:async()=>({records:db.map(r=>({...r})),complete:true}),
    write:async ops=>{sends++;const ids=ops.map(op=>op.records.map(record=>{const row={...record,Id:String(db.length+1)};db.push(row);return row.Id;}));
      if(lose){lose--;throw new Error('synthetic: the transport lost the response after the rows were written');}return ids.map(list=>({ok:true,ids:list}));}};
  const input={lane,host:'synthetic.test',module:'M',entity:'E',operation:'insert',files:[file],keys:['Code'],operationId:'3f1c2a10-0000-4000-8000-00000000f012',authorize:'carregar pedidos sinteticos',batchSize:10};
  return{db,channel,input,options:{journalRoot:path.join(root,'loads'),continuation:{tool:'studio_data_insert',arguments:input}},sends:()=>sends};
}
const stripWords=args=>Object.fromEntries(Object.entries(args).filter(([name])=>!['authorize','authorization'].includes(name)));
for(const lane of ['o11','odc']){
  test(`F12 ${lane}: a lost response of a keyed load is reconcilable and its resume, even without words, settles it once`,async t=>{
    const f=fixture(t,lane);
    const first=await runDataLoad(f.input,f.channel,f.options);
    assert.equal(first.ok,false);assert.equal(first.code,'DATA_OUTCOME_UNKNOWN');
    assert.equal(first.outcome,'reconcilable');assert.equal(first.reconcilable,true);assert.deepEqual(first.reconcileBy,['operationId','keys']);
    assert.notEqual(stateOf(first),'uncertain','a retry guard does not hold a reconcilable load');
    assert.ok(first.uncertainRows,'the rows whose write is unknown are still named');
    const resumed=await runDataLoad({...stripWords(first.continuation.arguments),lane},f.channel,f.options);
    assert.equal(resumed.complete,true,JSON.stringify(resumed));assert.equal(f.sends(),1,'the resume re-reads the keys and never resends');
    assert.deepEqual(f.db.map(r=>r.Code),['A','B']);
  });
  test(`F12 ${lane}: a contradictory receipt stays uncertain: the owner must settle it`,async t=>{
    const f=fixture(t,lane);f.channel.write=async ops=>ops.map(()=>({ok:false,outcome:'uncertain',contradiction:true,error:'native Success with an error'}));
    const first=await runDataLoad(f.input,f.channel,f.options);
    assert.equal(first.outcome,'uncertain');assert.equal(first.manualReconciliationRequired,true);assert.equal(first.reconcilable,undefined);
  });
}
test('F12: a close preview, like a dryRun, is not a Studio write; its confirmation and an overwrite confirmation are',()=>{
  const files=['C:/synthetic/orders.json'],odc={module:'M',entity:'E',files,keys:['Code']},request={operation:'insert',entity:'E',files,keys:['Code']};
  for(const tool of ['studio_data_insert','studio_data_update']){
    assert.equal(isWrite(tool,{...odc,dryRun:true}),false);
    assert.equal(isWrite(tool,{...odc,operationId:'x',close:{preview:true}}),false);
    assert.equal(isWrite(tool,{...odc,operationId:'x',close:{}}),false,'a close without previewSha256 only previews');
    assert.equal(isWrite(tool,{...odc,operationId:'x',close:{previewSha256:'a'.repeat(64),authorize:'w'}}),true);
    assert.equal(isWrite(tool,{...odc,operationId:'x',confirmUpdates:{previewSha256:'a'.repeat(64),authorize:'w'}}),true);
    assert.equal(isWrite(tool,{...odc,operationId:'x'}),true);
  }
  assert.equal(isWrite('o11_data',{host:'h',module:'m',oml:'o',request:{...request,dryRun:true}}),false);
  assert.equal(isWrite('o11_data',{host:'h',module:'m',oml:'o',request:{...request,operationId:'x',close:{preview:true}}}),false);
  assert.equal(isWrite('o11_data',{host:'h',module:'m',oml:'o',request:{...request,operationId:'x',close:{previewSha256:'a'.repeat(64),authorize:'w'}}}),true);
  assert.equal(isWrite('o11_data',{host:'h',module:'m',oml:'o',request:{...request,operationId:'x'}}),true);
});
