import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {afterPreview,ownerClose,withoutWords} from './helpers/owner-words.mjs';
const moduleFile=process.env.CX13_PROPERTY_MODULE??fileURLToPath(new URL('../data-load.mjs',import.meta.url));
const {runDataLoad}=await import(pathToFileURL(moduleFile).href);
const SEED=0x13c0111d,TRIALS=16;
const entity={name:'E',key:'entity-e',moduleKey:'module-m',identifier:'Id',indexes:[{unique:true,attributes:['Id']}],attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'}]};
for(const lane of ['o11','odc'])test(`generated key-declaration property: ${lane}, ${TRIALS} sequences`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-keys-p4-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let state=SEED+(lane==='odc'?19:0),actions=0;
  const rng=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};
  for(let trial=0;trial<TRIALS;trial++){
    const dir=path.join(root,String(trial));fs.mkdirSync(dir);const file=path.join(dir,'rows.json');
    const rows=Array.from({length:2+Math.floor(rng()*4)},(_,i)=>({Id:`client-${trial}-${i}`,Code:`C${trial}-${i}`}));fs.writeFileSync(file,JSON.stringify(rows));
    let writes=0;const db=[];
    const channel={
      context:lane==='odc'?async()=>({tenant:'synthetic.test',identifier:'Id'}):undefined,
      identity:async()=>({lane,host:'synthetic.test',tenant:'synthetic.test',moduleKey:'module-m',entityKey:'entity-e'}),
      schema:async()=>({entities:[entity]}),check:async()=>({ok:true}),readAll:async()=>({records:db,complete:true}),
      write:async ops=>{writes++;return ops.map(op=>({ok:true,outcome:'completed',ids:op.records.map(record=>{const Id=`server-${db.length+1}`;db.push({...record,Id});return Id;})}));}
    };
    const input={lane,host:'synthetic.test',module:'M',entity:'E',operation:'insert',files:[file],operationId:`c5200000-0000-4000-8000-${String(trial).padStart(12,'0')}`,authorization:'write synthetic keyed records',keys:trial%2?['Code','Id']:['Id']};
    const call=async args=>{actions++;return runDataLoad(args,channel,{journalRoot:path.join(dir,'loads')});};
    const rejected=await call(input);assert.equal(rejected.code,'DATA_LOAD_KEY_NOT_NATURAL');assert.equal(writes,0);assert.equal(db.length,0,'server-generated Id cannot support safe natural-key retry');
    const missing=await call({...input,keys:undefined});assert.equal(missing.code,'DATA_LOAD_KEYS_REQUIRED');
    assert.ok(missing.keyCandidates?.some(candidate=>candidate.keys.includes('Code')));
    assert.ok(missing.keyCandidates.every(candidate=>!candidate.keys.includes('Id')),'never suggest the generated Id, including its unique index');assert.equal(writes,0);
    const done=await call({...input,keys:['Code']});assert.equal(done.complete,true);assert.equal(done.ok,true);assert.equal(done.written,rows.length);assert.equal(db.length,rows.length);
    const repeat=await call({...input,keys:['Code']});assert.equal(repeat.complete,true);assert.equal(writes,1);assert.equal(new Set(db.map(row=>row.Code)).size,rows.length);
  }
  t.diagnostic(`CX13_KEYS_PROPERTY ${JSON.stringify({seed:SEED,lane,sequences:TRIALS,actions,duplicateWrites:0})}`);
});
// Persisted preflight state from an older version must not bypass the same
// natural-key rule on resume. This constructs the old durable format locally,
// without depending on a checkout, review folder, Git or external fixtures.
for(const lane of ['o11','odc'])test(`legacy key-declaration property: ${lane} rejects an already validated generated-Id plan`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-legacy-keys-p4-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'rows.json'),journalRoot=path.join(root,'loads');
  fs.writeFileSync(file,JSON.stringify([{Id:'client-A',Code:'A'},{Id:'client-B',Code:'B'}]));
  const original={lane,host:'synthetic.test',module:'M',entity:'E',operation:'insert',files:[file],keys:['Code'],operationId:'c5210000-0000-4000-8000-000000000001',authorization:'write synthetic keyed rows'};
  const db=[];let calls=0;
  const channel={schema:async()=>({entities:[entity]}),check:async()=>({ok:true}),readAll:async()=>({records:db,complete:true}),write:async ops=>{calls++;for(const op of ops)for(const record of op.records)db.push({...record,Id:`server-${db.length+1}`});return ops.map(()=>({ok:false,outcome:'uncertain',nativeOk:false,error:'response lost'}));}};
  const first=await runDataLoad(original,channel,{journalRoot});assert.equal(first.written,0);assert.equal(calls,1);assert.equal(db.length,2);
  const legacy={...original,keys:['Id']},planFile=path.join(journalRoot,original.operationId,'plan.json'),plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
  const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  plan.print.keys=['Id'];plan.sha256=crypto.createHash('sha256').update(JSON.stringify(stable(plan.print))).digest('hex');plan.resumeInput=legacy;plan.resumeContinuation={arguments:legacy};
  fs.writeFileSync(planFile,JSON.stringify(plan));
  const refused=await runDataLoad(legacy,channel,{journalRoot});
  assert.equal(refused.code,'DATA_LOAD_KEY_NOT_NATURAL','a durable old plan cannot bypass the initial natural-key guard');assert.equal(calls,1);assert.equal(db.length,2);
  assert.equal(refused.continuation.arguments.close.preview,true,'old invalid plan has an explicit owner exit');
  const preview=await runDataLoad({...legacy,close:{preview:true}},channel,{journalRoot});assert.equal(preview.closePreview.counts.uncertain,2);
  const closed=await runDataLoad({...legacy,close:{previewSha256:preview.closePreview.sha256,authorize:ownerClose(preview)}},channel,afterPreview({journalRoot}));assert.equal(closed.state,'closed');assert.equal(calls,1);
  channel.write=async()=>{throw new Error('the corrected natural-key load must adopt existing rows without writing');};
  const done=await runDataLoad({...original,operationId:'c5210000-0000-4000-8000-000000000002'},channel,{journalRoot});assert.equal(done.complete,true);assert.equal(done.unchanged,2);assert.equal(done.written,0);assert.deepEqual(db.map(row=>row.Code),['A','B']);
});
