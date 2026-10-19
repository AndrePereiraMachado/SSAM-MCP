import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ownerUpdates} from './helpers/owner-words.mjs';
const moduleFile=process.env.CX13_PROPERTY_MODULE??fileURLToPath(new URL('../data-load.mjs',import.meta.url));
const {runDataLoad}=await import(pathToFileURL(moduleFile).href);

const SEED=0x13a11a54,TRIALS=32;
const id=(trial,n)=>`c5100000-0000-4000-8000-${String(trial*100+n).padStart(12,'0')}`;
const entity={name:'E',key:'entity-e',moduleKey:'module-m',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'},{name:'Value',type:'Text'}]};
for(const lane of ['o11','odc'])test(`generated alias and external-writer property: ${lane}, ${TRIALS} sequences`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-alias-p4-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let state=SEED+(lane==='odc'?19:0),actions=0;
  const rng=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};
  for(let trial=0;trial<TRIALS;trial++){
    const dir=path.join(root,String(trial));fs.mkdirSync(dir);const file=path.join(dir,'rows.json'),journalRoot=path.join(dir,'loads');
    const rows=Array.from({length:12},(_,i)=>({Code:String(i),Value:String(Math.floor(rng()*10000))}));fs.writeFileSync(file,JSON.stringify(rows));
    const input={lane,host:'synthetic.test',module:'SyntheticApp',entity:'E',operation:'insert',keys:['Code'],files:[file],operationId:id(trial,1),authorization:'write synthetic keyed records',batchSize:1,deadlineMs:1000};
    let db=[],clock=0,first=true,mode=trial%3;
    const channel={
      context:lane==='odc'?async()=>({tenant:'synthetic.test',moduleKey:'module-m',entityKey:'entity-e',identifier:'Id'}):undefined,
      identity:async()=>({lane,host:'synthetic.test',tenant:'synthetic.test',module:'module-m',entity:'entity-e',moduleKey:'module-m',entityKey:'entity-e'}),
      schema:async()=>({moduleKey:'module-m',entities:[entity]}),check:async()=>({ok:true}),
      readAll:async()=>({records:db.map(row=>({...row})),complete:true}),
      write:async ops=>{
        const out=[];let stop=false;
        for(const op of ops){
          if(stop){out.push({ok:false,outcome:'not-submitted',sent:false});continue;}
          if(first&&mode===0){first=false;out.push({ok:false,outcome:'not-submitted',sent:false,error:'nothing sent'});stop=true;continue;}
          const ids=op.records.map(record=>{
            if(op.operation==='update'){const old=db.find(row=>row.Id===String(record.Id));assert.ok(old);Object.assign(old,record);return old.Id;}
            const Id=String(db.length+1);db.push({...record,Id});return Id;
          });
          if(first&&mode===2){first=false;out.push({ok:false,outcome:'uncertain',nativeOk:false,error:'response lost',code:'DATA_OUTCOME_UNKNOWN'});stop=true;continue;}
          if(first&&mode===1){first=false;clock=1500;}
          out.push({ok:true,outcome:'completed',ids});
        }
        return out;
      }
    };
    const call=async args=>{actions++;return runDataLoad(args,channel,{journalRoot,now:()=>clock});};
    const firstAnswer=await call(input);assert.equal(firstAnswer.complete,false);
    if(mode===2){assert.ok(db.length>0);db[0].Value=`external-${trial}`;}
    const before=structuredClone(db),alias=lane==='odc'?{module:['syntheticapp','Synthetic App','module-m'][trial%3]}:{host:['SYNTHETIC.TEST','https://SYNTHETIC.TEST:443/','synthetic.test/'][trial%3]};
    const refused=await call({...input,...alias,operationId:id(trial,2)});
    assert.equal(refused.code,'DATA_ENTITY_LOAD_BUSY',JSON.stringify({seed:SEED,lane,trial,mode,alias,refused}));assert.deepEqual(db,before);
    assert.equal(refused.continuation?.arguments?.operationId,input.operationId);
    let done=await call({...input,deadlineMs:60000}),asked=0;for(let i=0;i<4&&!done.complete;i++){if(done.code==='DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED'){asked++;assert.equal(mode,2,'only the external value change asks the owner');assert.equal(db[0].Value,`external-${trial}`,'nothing is overwritten before the owner answers');clock+=6000;done=await call({...input,deadlineMs:60000,confirmUpdates:{previewSha256:done.updatePreview.sha256,authorize:ownerUpdates(done)}});continue;}done=await call({...input,deadlineMs:60000});}if(mode===2)assert.equal(asked,1,'the external value change is shown to the owner once');
    assert.equal(done.complete,true,JSON.stringify({trial,mode,done}));assert.equal(done.ok,true);
    assert.equal(done.written+done.unchanged,rows.length);assert.equal(new Set(db.map(row=>row.Code)).size,db.length);
    assert.deepEqual(db.map(({Code,Value})=>({Code,Value})),rows,'resumed owner updates changed external value and matches actual DB');
    const receipt=JSON.parse(fs.readFileSync(done.receiptFile,'utf8'));assert.equal(receipt.written,rows.length,'all original initially absent rows are physically present, with one receipt entry per source row');
  }
  t.diagnostic(`CX13_ALIAS_PROPERTY ${JSON.stringify({seed:SEED,lane,sequences:TRIALS,actions,duplicates:0,lost:0,events:['not-submitted','deadline-crossing','uncertain-external-value-change'],aliases:3})}`);
});
