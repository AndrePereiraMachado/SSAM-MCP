import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {afterPreview,ownerClose,ownerUpdates,withoutWords} from './helpers/owner-words.mjs';

// Run this SAME state machine against pristine and mutated module copies.
const moduleFile=process.env.CX13_PROPERTY_MODULE??fileURLToPath(new URL('../data-load.mjs',import.meta.url));
const {runDataLoad}=await import(pathToFileURL(moduleFile).href);
const SEED=0x13f1f139,TRIALS=Number(process.env.CX13_PROPERTY_TRIALS??1024);
const EVENTS=['deterministic','failed-adopt','uncertain','external-change','cancel','deadline','death','abandon','mixed-parts'];
const entity={name:'E',key:'entity-e',moduleKey:'module-m',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'},{name:'Value',type:'Text'}]};
const id=(trial,n)=>`c5000000-0000-4000-8000-${String(trial*100+n).padStart(12,'0')}`;
function random(seed){let state=seed>>>0;return()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};}
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const continuationInput=out=>out.continuation?.arguments?.request??out.continuation?.arguments;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

for(const lane of ['o11','odc'])test(`seeded keyed lifecycle property: ${lane}, ${TRIALS} sequences`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-p4-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const rng=random(SEED+(lane==='odc'?19:0));
  const metrics={seed:SEED,lane,keys:true,sequences:TRIALS,previousValueChecks:0,uncertainUpdates:0,actions:0,nativeCalls:0,duplicates:0,lost:0,events:{},closed:0,completed:0,realDeadlines:0,midBatchCancellations:0,childDeaths:0,receiptTruthChecks:0,ownerConfirmations:0,overwriteChecks:0};
  for(let trial=0;trial<TRIALS;trial++){
    const event=EVENTS[trial%EVENTS.length];metrics.events[event]=(metrics.events[event]??0)+1;
    const dir=path.join(root,String(trial));fs.mkdirSync(dir);
    const file=path.join(dir,'rows.json'),dbFile=path.join(dir,'database.json'),journalRoot=path.join(dir,'loads');
    const many=event==='deadline'||event==='cancel',rowCount=many?12:4+Math.floor(rng()*3);
    let desired=Array.from({length:rowCount},(_,i)=>({Code:String.fromCharCode(65+i),Value:`v${Math.floor(rng()*1000)}`}));
    // The seed generates data order, failure position, changed values and client
    // actions; cyclic primary classes guarantee coverage of every fault family.
    if(rng()<.5)desired.reverse();
    const originalRows=structuredClone(desired);fs.writeFileSync(file,JSON.stringify(desired));fs.writeFileSync(dbFile,'[]');
    const input={lane,host:'synthetic.test',module:'SyntheticApp',entity:'E',operation:'insert',keys:['Code'],files:[file],operationId:id(trial,1),batchSize:many?1:2,deadlineMs:event==='deadline'?1000:60000,authorization:'write synthetic keyed records'};
    const options={journalRoot},controller=new AbortController();
    let db=[],nextId=1,clock=0,faults=true,triggered=false,secondary=trial%3===0,secondaryUsed=false,activeId=input.operationId,mixedStage='initial';
    const confirmed=new Map(),unknown=new Map(),approved=new Map();
    const confirmedFor=()=>{if(!confirmed.has(activeId))confirmed.set(activeId,new Set());return confirmed.get(activeId);};
    const target=desired[many||event==='mixed-parts'?2:2+Math.floor(rng()*(rowCount-2))];
    // Review 7 (R7-2): every other 'uncertain' sequence starts with the target key holding another value, so the batch whose
    // answer is lost is a confirmed UPDATE that ran; the resume reconciles it.
    if(event==='uncertain'&&Math.floor(trial/EVENTS.length)%2===1){db.push({Id:`pre-${trial}`,Code:target.Code,Value:`previous-${trial}`});metrics.uncertainUpdates++;}
    // The previous value of every row each load overwrote (by operationId, by key): its final receipt must keep it.
    const overwritten=new Map();
    // INSERT permits duplicate keys: the planner must provide upsert safety.
    const put=(record,operation='insert',external=false)=>{
      const existing=operation==='update'?db.find(row=>row.Id===String(record.Id)):null;
      if(operation==='update')assert.ok(existing,`update targets existing Id: ${JSON.stringify(record)}`);
      if(!external)confirmedFor().add(record.Code);
      // U1 (owner decision of 2026-10-17): the load overwrites an existing value only after the owner confirmed that exact current value.
      if(existing&&!external&&Object.keys(record).some(name=>name!=='Id'&&String(existing[name])!==String(record[name]))){metrics.overwriteChecks++;assert.equal(approved.get(existing.Code),existing.Value,JSON.stringify({message:'U1: unconfirmed overwrite of an existing row',seed:SEED,lane,trial,event,record,existing}));}
      if(existing&&!external&&Object.keys(record).some(name=>name!=='Id'&&String(existing[name])!==String(record[name]))){if(!overwritten.has(activeId))overwritten.set(activeId,new Map());overwritten.get(activeId).set(existing.Code,existing.Value);}
      if(existing){Object.assign(existing,record);return existing.Id;}
      const row={...record,Id:external?`external-${nextId++}`:String(nextId++)};db.push(row);return row.Id;
    };
    const channel={
      context:lane==='odc'?async()=>({tenant:'synthetic.test',moduleKey:'module-m',entityKey:'entity-e',identifier:'Id'}):undefined,
      identity:async()=>({lane,host:'synthetic.test',tenant:'synthetic.test',module:'module-m',moduleKey:'module-m',entity:'entity-e',entityKey:'entity-e'}),
      schema:async()=>({moduleKey:'module-m',entities:[entity]}),check:async()=>({ok:true}),
      readAll:async()=>{for(const [code,owner]of unknown){if(owner===activeId){confirmedFor().add(code);unknown.delete(code);}}return{records:db.map(row=>({...row})),complete:true};},
      write:async ops=>{
        metrics.nativeCalls++;const results=[];let stopped=false;
        for(const op of ops){
          if(stopped){results.push({ok:false,outcome:'not-submitted',sent:false});continue;}
          if(faults&&event==='deadline'&&!triggered){
            triggered=true;
            // At least one REAL elapsed deadline per lane. Other generated
            // schedules advance the injected monotonic clock past the deadline.
            if(trial===5){await delay(1010);metrics.realDeadlines++;}else clock+=1001;
          }
          const hits=op.records.some(record=>record.Code===target.Code);
          if(event==='mixed-parts'&&mixedStage==='fail-first-update'&&hits){
            assert.equal(op.operation,'update','external key change creates an update part before the unsent insert part');
            mixedStage='failed-update';results.push({ok:false,outcome:'failed',nativeOk:false,successfulRows:[],failedRows:op.records.map((_,index)=>({index,reason:'first mixed part rejected'})),error:'first mixed part rejected'});stopped=true;continue;
          }
          if(faults&&event==='mixed-parts'&&hits){
            triggered=true;results.push({ok:false,outcome:'failed',nativeOk:false,successfulRows:[],failedRows:op.records.map((_,index)=>({index,reason:'initial deterministic batch rejection'})),error:'initial deterministic batch rejection'});stopped=true;continue;
          }
          if(faults&&event==='cancel'&&!triggered&&hits){
            triggered=true;put(op.records[0],op.operation);confirmedFor().delete(op.records[0].Code);unknown.set(op.records[0].Code,activeId);controller.abort();metrics.midBatchCancellations++;
            results.push({ok:false,outcome:'uncertain',nativeOk:false,code:'DATA_OUTCOME_UNKNOWN',error:'response lost during cancellation'});stopped=true;continue;
          }
          if(faults&&['deterministic','failed-adopt','external-change','abandon'].includes(event)&&hits){
            triggered=true;const successfulRows=[],failedRows=[];
            for(const [index,record]of op.records.entries()){
              if(record.Code===target.Code)failedRows.push({index,reason:'deterministic domain constraint'});
              else successfulRows.push({index,id:put(record,op.operation)});
            }
            results.push({ok:false,outcome:'failed',nativeOk:false,code:'DATA_WRITE_FAILED',error:'deterministic domain constraint',successfulRows,failedRows});stopped=true;continue;
          }
          if(faults&&event==='uncertain'&&!triggered&&hits){
            triggered=true;for(const record of op.records){put(record,op.operation);confirmedFor().delete(record.Code);unknown.set(record.Code,activeId);}
            results.push({ok:false,outcome:'uncertain',nativeOk:false,replayable:lane==='o11',code:'DATA_OUTCOME_UNKNOWN',error:'Command is still running; do not retry'});stopped=true;continue;
          }
          // A second fault makes recovery a sequence rather than a first-call
          // glitch. It affects a later batch and leaves some rows never sent.
          if(!faults&&secondary&&!secondaryUsed&&op.batch>1){secondaryUsed=true;results.push({ok:false,outcome:'not-submitted',sent:false,error:'temporary gate busy'});stopped=true;continue;}
          results.push({ok:true,outcome:'completed',ids:op.records.map(record=>put(record,op.operation))});
        }
        return results;
      }
    };
    const checkTruth=(out,callInput)=>{
      assert.equal(new Set(db.map(row=>row.Code)).size,db.length,JSON.stringify({message:'duplicate natural keys',seed:SEED,lane,trial,event,callInput,out,db}));
      if(!callInput.close?.preview){assert.equal(typeof out.written,'number');assert.ok(out.written>=0);}
      if(out.receiptFile&&fs.existsSync(out.receiptFile)){
        const receipt=json(out.receiptFile);
        if(typeof out.written==='number')assert.equal(receipt.written,out.written);
        assert.equal(receipt.written,confirmed.get(callInput.operationId)?.size??0,JSON.stringify({message:'receipt equals independently acknowledged fake DB writes',trial,event,receipt,db}));
        for(const row of receipt.successfulRows??[])if(row.id!=null)assert.ok(db.some(actual=>actual.Id===String(row.id)),`confirmed id ${row.id} really exists`);
        metrics.receiptTruthChecks++;
      }
      // Review 6 (converted): every continuation keeps the original arguments WITHOUT the owner's words (the resume takes
      // them from the plan, which keeps only their sha256).
      if(out.resumable&&out.continuation){const {close,confirmUpdates,...args}=continuationInput(out);assert.deepEqual(args,withoutWords(input),'M6: full continuation retains original arguments');}
      return out;
    };
    // The owner reads every update preview: it names exactly the current values of the real rows; the owner answers it.
    const owner=async(out,callInput,extra)=>{
      for(let n=1;n<=3&&out.code==='DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED';n++){
        metrics.ownerConfirmations++;const source=json(file);
        for(const row of out.updatePreview.rows){const code=source[row.globalRow-1].Code,current=db.find(actual=>actual.Code===code);assert.ok(current,'an update preview names an existing row');assert.equal(row.changes.Value?.from??current.Value,current.Value,'the preview shows the real current value');approved.set(code,current.Value);}
        out=checkTruth(await runDataLoad({...callInput,confirmUpdates:{previewSha256:out.updatePreview.sha256,authorize:ownerUpdates(out)}},channel,{...options,...extra,now:()=>Date.now()+6000*n}),callInput);
      }
      return out;
    };
    const call=async(callInput=input,extra={})=>{metrics.actions++;activeId=callInput.operationId;return owner(checkTruth(await runDataLoad(callInput,channel,{...options,...extra}),callInput),callInput,extra);};
    const closeOwner=async()=>{
      const before=JSON.stringify(db),preview=await call({...input,close:{preview:true}});
      assert.ok(preview.closePreview?.sha256,'owner receives closure preview');assert.equal(JSON.stringify(db),before,'preview never writes entity data');
      const details=preview.closePreview;
      assert.equal(details.counts.confirmed,confirmed.get(input.operationId)?.size??0,'preview confirmed count matches actual acknowledged writes');
      const groups=['successfulRows','failedRows','uncertainRows','notSentRows','unchangedRows'].flatMap(kind=>details[kind]);
      assert.equal(groups.length,rowCount,'preview classifies every source row');assert.equal(new Set(groups.map(row=>row.globalRow)).size,rowCount);
      for(const row of details.successfulRows){const source=originalRows[row.globalRow-1];assert.ok(db.some(actual=>actual.Id===String(row.id)&&actual.Code===source.Code&&actual.Value===source.Value),'preview confirmed row matches real DB, source key and value');}
      const result=await call({...input,close:{previewSha256:details.sha256,authorize:ownerClose(details)}},{now:()=>Date.now()+6000});
      assert.equal(result.state,'closed');assert.equal(JSON.stringify(db),before,'closure never writes entity data');
      const closedAgain=await call();assert.equal(closedAgain.code,'DATA_LOAD_CLOSED');assert.equal(closedAgain.receiptFile,result.receiptFile);
      metrics.closed++;return result;
    };
    let answer;
    if(event==='death'&&lane==='odc'){
      const child=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/data-load-property-die.mjs',import.meta.url)),moduleFile,JSON.stringify(input),dbFile,journalRoot],{encoding:'utf8',timeout:20000,windowsHide:true});
      assert.equal(child.status,23,`child dies inside native write: ${child.error??child.stderr}`);
      metrics.childDeaths++;db=json(dbFile);nextId=db.length+1;
      confirmed.set(input.operationId,new Set(db.slice(0,2).map(row=>row.Code)));for(const row of db.slice(2))unknown.set(row.Code,input.operationId);
      assert.match(fs.readFileSync(path.join(journalRoot,input.operationId,'journal.jsonl'),'utf8'),/"state":"pending"/,'terminated writer leaves a pending journal');
      faults=false;answer=await call();
    }else{
      const extra=event==='cancel'?{signal:controller.signal}:event==='deadline'&&trial!==5?{now:()=>clock}:{};
      answer=await call(input,extra);
    }
    if(event==='death'&&lane==='o11')faults=false;
    if(event==='deadline'){
      assert.equal(answer.complete,false,`deadline must fire: ${JSON.stringify(answer)}`);
      assert.match(JSON.stringify(json(answer.receiptFile).notes),/deadline between batches/);
      assert.ok(db.length>0&&db.length<rowCount,'deadline leaves confirmed and never-sent rows');
    }
    if(event==='cancel')assert.equal(answer.complete,false,'mid-batch cancellation stops the load');
    if(event==='failed-adopt'){
      assert.equal(answer.outcome,'failed');put(target,'insert',true);faults=false;answer=await call();
      assert.equal(db.filter(row=>row.Code===target.Code).length,1,'M2: failed rows recheck externally adopted keys');
    }
    if(event==='external-change'){put({...target,Value:`external-${trial}`},'insert',true);faults=false;answer=await call();}
    if(event==='mixed-parts'){
      assert.equal(answer.outcome,'failed');assert.equal(db.some(row=>row.Code===desired[3].Code),false,'original later part has never been sent');
      put({...target,Value:`external-${trial}`},'insert',true);faults=false;mixedStage='fail-first-update';answer=await call();
      assert.equal(mixedStage,'failed-update','generated recovery reaches the failing first mixed part');
      assert.equal(db.some(row=>row.Code===desired[3].Code),false,'a rejected update part must never submit the following insert part');
      mixedStage='healthy';
    }
    if(event==='uncertain'){
      faults=false;for(let n=0;n<5&&!answer.complete;n++)answer=await call();
      assert.equal(answer.complete,true);assert.equal(answer.ok,true,'M7: native failure cannot poison reconciled completion');
      assert.equal(answer.code,undefined);assert.equal(answer.error,undefined);
      assert.doesNotMatch(JSON.stringify(json(answer.receiptFile)),/DATA_OUTCOME_UNKNOWN|do not retry/,'M7: current receipt is clean');
    }
    if(['deterministic','abandon'].includes(event)){
      answer=await call({...input,batchSize:input.batchSize+1});
      assert.equal(answer.code,'DATA_LOAD_ID_REUSED');const {close,...original}=continuationInput(answer);assert.deepEqual(original,close?withoutWords(input):input);
      if(event==='deterministic'){
        answer=await call();assert.equal(answer.complete,false,'constraint remains deterministic on repeat');
        desired=desired.map(row=>row.Code===target.Code?{...row,Value:`corrected-${trial}`}:row);
        fs.writeFileSync(file,JSON.stringify(desired));answer=await call();
        assert.equal(answer.code,'DATA_LOAD_ID_REUSED');assert.match(answer.next,/clos|encerr/i);
      }
      answer=await closeOwner();
    }else{
      faults=false;
      if(!answer.complete&&rng()<.5){const resumed=await call({...input,authorization:''});assert.notEqual(resumed.code,'INPUT_INVALID','owner decision of 2026-10-17: a resumed validated plan takes the load words from the plan');answer=resumed;}
      for(let n=0;n<6&&!answer.complete;n++)answer=await call();
      if(!answer.complete&&event==='deadline')answer=await closeOwner();
      else{assert.equal(answer.complete,true,JSON.stringify({seed:SEED,lane,trial,event,answer,db}));metrics.completed++;}
    }
    assert.ok(['completed','closed'].includes(json(path.join(journalRoot,input.operationId,'plan.json')).state),'every sequence has a durable terminal state');
    // U1 (owner decision of 2026-10-17; review 7, R7-2): the final receipt keeps the previous value of every row this load
    // overwrote: updatedRows (confirmed by the native answer or by the reconciliation), else uncertainUpdatedRows.
    {const receiptX=json(path.join(journalRoot,input.operationId,'receipt.json')),kept=[...(receiptX.updatedRows??[]),...(receiptX.uncertainUpdatedRows??[])];
      for(const [code,previous] of overwritten.get(input.operationId)??[]){
        const globalRow=originalRows.findIndex(row=>row.Code===code)+1,row=kept.find(entry=>entry.globalRow===globalRow);
        assert.ok(row,JSON.stringify({message:'U1: the final receipt keeps the previous value of every overwritten row',seed:SEED,lane,trial,event,code,previous,receipt:{updatedRows:receiptX.updatedRows,uncertainUpdatedRows:receiptX.uncertainUpdatedRows,state:receiptX.state}}));
        assert.equal(row.changes?.Value?.from,previous,'U1: the previous value is the one the load overwrote');metrics.previousValueChecks++;
      }}
    // Check X before running fresh Y: Y must not mask losses or bad receipts.
    if(answer.complete){assert.equal(answer.written+answer.unchanged,rowCount);assert.deepEqual(db.map(({Code,Value})=>({Code,Value})).sort((a,b)=>a.Code.localeCompare(b.Code)),desired.toSorted((a,b)=>a.Code.localeCompare(b.Code)),'completed X exactly matches actual DB');}
    faults=false;secondary=false;fs.writeFileSync(file,JSON.stringify(desired));
    const fresh={...input,operationId:id(trial,2),deadlineMs:60000};let final=await call(fresh);
    for(let n=0;n<3&&!final.complete;n++)final=await call(fresh);
    assert.equal(final.complete,true,JSON.stringify({trial,event,answer,final}));assert.equal(final.ok,true);assert.equal(final.written+final.unchanged,rowCount);
    assert.deepEqual(db.map(({Code,Value})=>({Code,Value})).sort((a,b)=>a.Code.localeCompare(b.Code)),desired.toSorted((a,b)=>a.Code.localeCompare(b.Code)),'actual DB exactly matches corrected file, no duplicate or missing row');
  }
  t.diagnostic(`CX13_PROPERTY ${JSON.stringify(metrics)}`);
});
