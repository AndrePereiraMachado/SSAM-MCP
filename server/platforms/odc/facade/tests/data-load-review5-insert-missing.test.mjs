import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runDataLoad,planDataLoad} from '../data-load.mjs';

// D1 (review 5): insertMissing:false is honored, never ignored: an update by file whose key is absent from the entity is
// refused (DATA_KEY_NOT_FOUND), so a mistyped key never inserts a new row. Without it the update stays an upsert (owner
// decision A of 2026-10-15). The catalog and the guides say what the code does: keys required, upsert, overwrite
// confirmation and close.
const entity={name:'E',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'},{name:'Value',type:'Text'}],indexes:[]};
const row=record=>({file:'x.json',row:2,globalRow:1,sources:{},record});
const facade=fileURLToPath(new URL('../',import.meta.url));
test('D1: the planner refuses an absent key only when insertMissing:false is given',()=>{
  const plan=extra=>planDataLoad({operation:'update',entity:'E',operationId:'d1d1d1d1-0000-4000-8000-000000000000',keys:['Code'],...extra},[row({Code:'AA-typo',Value:'new'})],entity,[{Id:'1',Code:'AA',Value:'old'}]);
  const strict=plan({insertMissing:false});
  assert.deepEqual(strict.problems.map(p=>p.code),['DATA_KEY_NOT_FOUND']);assert.match(strict.problems[0].reason,/insertMissing:false/);assert.equal(strict.batches.length,0);
  for(const extra of [{},{insertMissing:true}])assert.deepEqual([plan(extra).inserted,plan(extra).problems.length],[1,0]);
});
for(const lane of ['o11','odc'])test(`D1 ${lane}: a mistyped key with insertMissing:false is refused before any write`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r5d-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'typo.json');fs.writeFileSync(file,JSON.stringify([{Code:'AA-typo',Value:'new'}]));
  const db=[{Id:'1',Code:'AA',Value:'old'}];let writes=0;
  const channel={schema:async()=>({entities:[entity]}),check:async()=>({ok:true}),readAll:async()=>({records:db.map(r=>({...r})),complete:true}),write:async ops=>{writes++;return ops.map(()=>({ok:false,outcome:'not-submitted'}));}};
  const input={lane,host:'synthetic.test',module:'M',entity:'E',operation:'update',files:[file],keys:['Code'],insertMissing:false,operationId:'d1d1d1d1-0000-4000-8000-000000000001',authorization:'atualizar os valores'};
  const out=await runDataLoad(input,channel,{journalRoot:path.join(root,'loads')});
  assert.equal(out.ok,false);assert.equal(out.code,'DATA_KEY_NOT_FOUND');assert.equal(writes,0);assert.deepEqual(db,[{Id:'1',Code:'AA',Value:'old'}]);
  const dry=await runDataLoad({...input,dryRun:true},channel,{journalRoot:path.join(root,'loads')});
  assert.equal(dry.code,'DATA_KEY_NOT_FOUND','the dryRun shows the same refusal');
});
test('D1: catalog and guides describe keys, upsert, insertMissing:false, the overwrite confirmation and close',()=>{
  const raw=fs.readFileSync(path.join(facade,'catalog','tools.json'),'utf8'),tools=JSON.parse(raw.charCodeAt(0)===0xFEFF?raw.slice(1):raw);
  const texts=[];JSON.stringify(tools,(key,value)=>{if(key==='when'&&typeof value==='string'&&/files:\["<absolute-path/.test(value))texts.push(value);return value;});
  assert.ok(texts.length>=4,'the four file-load verbs are described');
  for(const text of texts){
    assert.doesNotMatch(text,/keys with insertMissing insert absent keys/);
    assert.match(text,/natural keys/);assert.match(text,/confirmUpdates/);assert.match(text,/close/);
  }
  assert.ok(texts.some(text=>/insertMissing:false/.test(text)),'the update says what insertMissing:false does');
  for(const guide of ['o11.md','odc.md']){
    const text=fs.readFileSync(path.join(facade,'guides',guide),'utf8');
    assert.doesNotMatch(text,/update `insertMissing` and `dryRun`/);
    assert.match(text,/REQUIRE `keys`/);assert.match(text,/confirmUpdates/);assert.match(text,/insertMissing:false/);assert.match(text,/close \{preview:true\}/);
  }
});
