import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDataLoad} from '../data-load.mjs';

// W1 (review 5): the close of a load is confirmed only by the owner's words given AFTER the close preview, never seen
// before it (not the load's words, not a template) and stating the exact number of rows the close leaves unwritten
// (the CX15 rule, decision C of 2026-10-14). The preview continuation never carries the load's words.
const entity={name:'E',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'},{name:'Value',type:'Text'}],indexes:[{unique:true,attributes:['Code']}]};
const LOAD_WORDS='carregar linhas sinteticas';
let sequence=0;
function fixture(t,lane){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r5w-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'rows.json');fs.writeFileSync(file,JSON.stringify([{Code:'A',Value:'um'},{Code:'B',Value:'dois'},{Code:'C',Value:'tres'}]));
  const db=[];let writes=0;
  const channel={schema:async()=>({entities:[entity]}),check:async()=>({ok:true}),readAll:async()=>({records:db.map(r=>({...r})),complete:true}),
    write:async ops=>{const out=[];for(const op of ops){if(op.records.some(r=>r.Code==='B')){out.push({ok:false,outcome:'failed',failedRows:[{index:0,reason:'synthetic deterministic constraint'}]});break;}
      out.push({ok:true,ids:op.records.map(record=>{writes++;const row={...record,Id:String(db.length+1)};db.push(row);return row.Id;})});}return out;}};
  const clock={at:Date.parse('2026-10-17T12:00:00Z')};
  const input={lane,host:'synthetic.test',module:'M',entity:'E',files:[file],keys:['Code'],operation:'insert',operationId:`a1b20000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,authorization:LOAD_WORDS,batchSize:1};
  // Review 6: words are seen per host in the CX15 store; each test has its own store, as it had its own journal before.
  return{root,db,channel,input,clock,options:{journalRoot:path.join(root,'loads'),now:()=>clock.at,destructive:{root:path.join(root,'destructive')}},writes:()=>writes};
}
const argsOf=continuation=>continuation?.arguments?.request??continuation?.arguments??{};
const planState=f=>JSON.parse(fs.readFileSync(path.join(f.options.journalRoot,f.input.operationId,'plan.json'),'utf8')).state;

for(const lane of ['o11','odc']){
  test(`W1 ${lane}: the close preview continuation carries no load words and states the count to confirm`,async t=>{
    const f=fixture(t,lane);await runDataLoad(f.input,f.channel,f.options);
    const preview=await runDataLoad({...f.input,close:{preview:true}},f.channel,f.options);
    assert.equal(preview.closePreview.count,2,'one failed and one never-sent row stay unwritten');
    const args=argsOf(preview.continuation);
    assert.equal(args.authorization,undefined);assert.equal(args.authorize,undefined);
    assert.doesNotMatch(JSON.stringify(preview.continuation),new RegExp(LOAD_WORDS));
    assert.equal(args.close.previewSha256,preview.closePreview.sha256);
    assert.match(args.close.authorize,/^<.*>$/,'the continuation holds only a template, never words');
    assert.match(preview.confirmWith,/\b2\b/);
  });
  for(const [label,words] of [['bare ok','ok'],['the load words',LOAD_WORDS],['a wrong count','fechar 99 linhas'],['no count','encerrar esta carga'],['the template',null],['blank','   ']]){
    test(`W1 ${lane}: ${label} never closes the load`,async t=>{
      const f=fixture(t,lane);await runDataLoad(f.input,f.channel,f.options);
      const preview=await runDataLoad({...f.input,close:{preview:true}},f.channel,f.options);
      f.clock.at+=60000;
      const given=words??argsOf(preview.continuation).close.authorize;
      const refused=await runDataLoad({...f.input,close:{previewSha256:preview.closePreview.sha256,authorize:given}},f.channel,f.options);
      assert.equal(refused.ok,false);assert.ok(refused.problems.length>=1);assert.equal(planState(f),'resumable');
      // Review 6 (R6-F15, converted): the template is a server text, refused by the one predicate before any read (WORDS_REQUIRED).
      if(words===null){assert.equal(refused.code,'WORDS_REQUIRED');assert.deepEqual(refused.askOwner.fields,['close/authorize']);return;}
      assert.equal(refused.code,'DATA_LOAD_CLOSE_CONFIRMATION_REQUIRED');
      assert.equal(refused.closePreview.sha256,preview.closePreview.sha256,'a refused confirmation keeps the same preview');
    });
  }
  test(`W1 ${lane}: one refusal names every problem of the words (count and too soon)`,async t=>{
    const f=fixture(t,lane);await runDataLoad(f.input,f.channel,f.options);
    const preview=await runDataLoad({...f.input,close:{preview:true}},f.channel,f.options);
    const refused=await runDataLoad({...f.input,close:{previewSha256:preview.closePreview.sha256,authorize:'ok'}},f.channel,f.options);
    assert.deepEqual(refused.problems.map(p=>p.code).sort(),['CONFIRMATION_COUNT_MISMATCH','CONFIRMATION_TOO_SOON']);
  });
  test(`W1 ${lane}: words seen on this journal before the preview never confirm it`,async t=>{
    const f=fixture(t,lane);await runDataLoad(f.input,f.channel,f.options);
    const earlier='pode encerrar as 2 linhas';
    await runDataLoad({...f.input,operationId:'a1b20000-0000-4000-8000-0000000009ff',authorization:earlier,dryRun:true},f.channel,f.options);
    const preview=await runDataLoad({...f.input,close:{preview:true}},f.channel,f.options);f.clock.at+=60000;
    const refused=await runDataLoad({...f.input,close:{previewSha256:preview.closePreview.sha256,authorize:earlier}},f.channel,f.options);
    assert.equal(refused.ok,false);assert.ok(refused.problems.some(p=>p.code==='WORDS_BEFORE_PREVIEW'));assert.equal(planState(f),'resumable');
  });
  test(`W1 ${lane}: fresh owner words with the exact count, after the preview, close the load`,async t=>{
    const f=fixture(t,lane);await runDataLoad(f.input,f.channel,f.options);
    const preview=await runDataLoad({...f.input,close:{preview:true}},f.channel,f.options);
    const soon=await runDataLoad({...f.input,close:{previewSha256:preview.closePreview.sha256,authorize:'sim, pode fechar as 2 linhas'}},f.channel,f.options);
    assert.equal(soon.ok,false);assert.ok(soon.problems.some(p=>p.code==='CONFIRMATION_TOO_SOON'));
    f.clock.at+=6000;
    const closed=await runDataLoad({...argsOf(preview.continuation),lane,close:{previewSha256:preview.closePreview.sha256,authorize:'sim, pode fechar as 2 linhas'}},f.channel,f.options);
    assert.equal(closed.state,'closed',JSON.stringify(closed));assert.equal(planState(f),'closed');
    assert.equal((await runDataLoad(f.input,f.channel,f.options)).code,'DATA_LOAD_CLOSED');
  });
}
