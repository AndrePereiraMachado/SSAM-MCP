import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runDataLoad, odcDataChannel, o11DataChannel } from '../data-load.mjs';
import { studioData } from '../lib.mjs';
import {afterPreview,ownerClose,withoutWords} from './helpers/owner-words.mjs';

const entity={name:'Item',key:'entity-Item',identifier:'Id',attributes:[{name:'Id',type:'Item Identifier'},{name:'Code',type:'Text'}]};
const rows=[{Code:'A'},{Code:'B'},{Code:'C'}];
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-shapes-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const op=()=>({operation:'insert',entity:'Item',operationId:'13000000-0000-4000-8000-000000000001',batch:0,identifier:'Id',authorization:'write synthetic records',records:rows});
function journal(result){return fs.readFileSync(path.join(path.dirname(result.receiptFile),'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);}
function bridge(t, mode){
  const root=temp(t),db=[],calls=[];let attempts=0;
  const call=async args=>{
    if(args[0]==='data')return{ok:true,module:'M',entity:'Item',tenant:'synthetic.tenant',identifier:'Id',moduleKey:'module-m',entityKey:'entity-e',attributes:['Id:Item Identifier','Code:Text'],records:db,more:false};
    assert.equal(args[0],'data-insert');const records=JSON.parse(fs.readFileSync(args[args.indexOf('--records-file')+1],'utf8'));calls.push(records);attempts++;
    const wire=records.map((record,index)=>({id:`new-${index+1}`,attributes:Object.entries(record).map(([name,value])=>({name,value}))}));
    const reports=records.map((record,index)=>{
      if(mode==='partial'&&record.Code==='B'&&attempts===1)return{recordId:null,clientRecordId:`new-${index+1}`,status:'Error',error:'Value too long'};
      const id=String(db.length+100);db.push({Id:id,...record});return{recordId:id,clientRecordId:`new-${index+1}`,status:'Success',error:mode==='contradiction'?'Conflicting native diagnostic':null};
    });
    if(mode==='timeout'&&attempts===1)return{ok:false,outcome:'uncertain',gate:'studio_busy',error:"Command 'data-insert' is still running after 00:03:00; it was not cancelled. Poll status; do not retry.",openDialogs:[],openWindows:[],dialogsClosed:[]};
    if(mode==='native-error'&&attempts===1)return{ok:false,outcome:'native_error',gate:'none',error:'HttpRequestException: The response ended prematurely.',dialogsClosed:[]};
    const evidence=path.join(root,`native-${attempts}.json`),failed=reports.filter(r=>r.status!=='Success');
    const native={ok:!failed.length,operation:'data-insert',count:reports.length,reports,request:{records:wire},evidence};fs.writeFileSync(evidence,JSON.stringify(native));
    if(failed.length)return{ok:false,outcome:'gate_refused',gate:'none',error:`data-insert: ${failed.length} of ${reports.length} records failed (${failed[0].error}); the full report is in ${evidence}. Do not repeat without reading it.`,dialogsClosed:[]};
    return native;
  };
  const data=args=>studioData(args,{call,writeRecords:(records,{name})=>{const file=path.join(root,name);fs.writeFileSync(file,JSON.stringify(records));return file;}});
  return{root,db,calls,channel:odcDataChannel({studioData:data,module:'M',entity:'Item'}),data};
}

for(const keys of [false,true])test(`literal bridge partial failure preserves evidence ids and retries only B (keys=${keys})`,async t=>{
  const b=bridge(t,'partial'),file=path.join(b.root,'rows.json');fs.writeFileSync(file,JSON.stringify(rows));
  const input={lane:'odc',module:'M',entity:'Item',operation:'insert',files:[file],operationId:op().operationId,authorize:'write synthetic records',...(keys?{keys:['Code']}:{})},options={journalRoot:path.join(b.root,'loads')};
  const first=await runDataLoad(input,b.channel,options);if(!keys){assert.equal(first.code,'DATA_LOAD_KEYS_REQUIRED');assert.equal(b.calls.length,0);assert.equal(b.db.length,0);return;}assert.equal(first.outcome,'failed');assert.equal(first.written,2);assert.deepEqual(journal(first).find(j=>j.kind==='rows').ids,['100','101']);assert.match(JSON.stringify(first),/Value too long/);
  const second=await runDataLoad(input,b.channel,options);assert.equal(second.complete,true);assert.equal(second.written,3);assert.deepEqual(b.calls.map(records=>records.map(r=>r.Code)),[['A','B','C'],['B']]);assert.deepEqual(b.db.map(r=>r.Code).sort(),['A','B','C']);
});

for(const mode of ['timeout','native-error'])for(const keys of [false,true])test(`literal ${mode} cannot duplicate submitted rows (keys=${keys})`,async t=>{
  const b=bridge(t,mode),file=path.join(b.root,'rows.json');fs.writeFileSync(file,JSON.stringify(rows));const input={lane:'odc',module:'M',entity:'Item',operation:'insert',files:[file],operationId:op().operationId,authorize:'write synthetic records',...(keys?{keys:['Code']}:{})},options={journalRoot:path.join(b.root,'loads')};
  const first=await runDataLoad(input,b.channel,options);if(!keys){assert.equal(first.code,'DATA_LOAD_KEYS_REQUIRED');assert.equal(b.calls.length,0);assert.equal(b.db.length,0);return;}assert.equal(first.outcome,'reconcilable');assert.equal(first.written,0);
  const second=await runDataLoad(input,b.channel,options);assert.equal(b.calls.length,1);assert.deepEqual(b.db.map(r=>r.Code),['A','B','C']);if(keys){assert.equal(second.complete,true);assert.equal(second.written,3);assert.equal(second.ok,true);assert.equal(second.code,undefined);assert.equal(second.error,undefined);assert.doesNotMatch(JSON.stringify(second),/DATA_OUTCOME_UNKNOWN|do not retry/i);}else {assert.equal(second.code,'DATA_LOAD_CLOSED');assert.equal(second.receiptFile,first.receiptFile);}
});

const notSent=[
  {ok:false,sent:false,code:'BRIDGE_BUSY',error:'The ODC bridge pipe is busy; nothing was sent.'},
  {ok:false,sent:false,code:'BRIDGE_NOT_ATTACHED',error:'Bridge not attached; nothing was sent.'},
  {ok:false,sent:false,code:'PIPE_CONNECT_TIMEOUT',error:'Pipe connect timed out; nothing was sent.'},
  {ok:false,error:'ODC Studio is not running'},
  {ok:false,submitted:0,error:'Validation refused before dispatch'},
  {ok:false,outcome:'gate_refused',gate:'none',error:'The module is not ready'},
  {ok:false,outcome:'gate_refused',gate:'studio_busy',busyCommand:'publish',error:'Previous command is still running'},
];
for(const reply of notSent)test(`literal non-submission proof ${reply.code??reply.error}`,async()=>{
  const channel=odcDataChannel({module:'M',entity:'Item',studioData:async()=>reply}),result=(await channel.write([op()]))[0];assert.equal(result.outcome,'not-submitted');assert.deepEqual(result.ids,[]);
});
for(const code of ['BRIDGE_BUSY','BRIDGE_NOT_ATTACHED','PIPE_CONNECT_TIMEOUT'])test(`thrown ${code} sent:false is safe to retry`,async()=>{
  const channel=odcDataChannel({module:'M',entity:'Item',studioData:async()=>{throw Object.assign(new Error('Nothing was sent'),{code,sent:false});}});assert.equal((await channel.write([op()]))[0].outcome,'not-submitted');
});

for(const keys of [false,true])for(const lane of ['o11','odc'])test(`contradictory Success with id is never resent ${lane} keys=${keys}`,async t=>{
  const root=temp(t),file=path.join(root,'rows.json'),oml=path.join(root,'snapshot.oml'),db=[],writes=[];fs.writeFileSync(file,'[{"Code":"A"}]');fs.writeFileSync(oml,'synthetic snapshot');
  const report=base=>{const id=String(db.length+100);db.push({Id:id,Code:'A'});writes.push(id);return{ok:false,ids:[id],reports:[{clientRecordId:`new-${base}`,recordId:id,status:'Success',error:'Conflicting native diagnostic'}]};};
  const channel=lane==='odc'?odcDataChannel({module:'M',entity:'Item',studioData:async args=>args.op==='read'?{ok:true,tenant:'synthetic.tenant',identifier:'Id',moduleKey:'module-m',entityKey:'entity-e',attributes:['Id:Item Identifier','Code:Text'],records:db,more:false}:report(1)}):o11DataChannel({call:{host:'synthetic.test',module:'M',entity:'Item',oml},work:root,runAnvil:async args=>{if(args.includes('--schema'))return{ok:true,moduleKey:'module-m',entities:[entity]};if(args.includes('--check'))return{ok:true};const request=JSON.parse(fs.readFileSync(args[args.indexOf('--request')+1],'utf8'));return request.batch[0].operation==='read-all'?{ok:true,results:[{ok:true,records:db,complete:true}]}:{ok:false,results:[report(0)]};}});
  const input={lane,host:'synthetic.test',module:'M',entity:'Item',oml,operation:'insert',files:[file],operationId:op().operationId,authorization:'write synthetic records',...(keys?{keys:['Code']}:{})},options={journalRoot:path.join(root,'loads')};
  const first=await runDataLoad(input,channel,options);if(!keys){assert.equal(first.code,'DATA_LOAD_KEYS_REQUIRED');assert.equal(writes.length,0);assert.equal(db.length,0);return;}assert.equal(first.outcome,'uncertain');assert.equal(first.written,0);const entry=journal(first).find(j=>j.state==='uncertain');assert.equal(entry.contradiction,true);assert.deepEqual(entry.ids,['100']);
  const preview=await runDataLoad({...input,close:{preview:true}},channel,options);assert.equal(preview.closePreview.counts.uncertain,1);const closed=await runDataLoad({...input,close:{previewSha256:preview.closePreview.sha256,authorize:ownerClose(preview)}},channel,afterPreview(options));assert.equal(closed.state,'closed');const second=await runDataLoad(input,channel,options);assert.equal(second.code,'DATA_LOAD_CLOSED');assert.equal(second.receiptFile,first.receiptFile);assert.equal(writes.length,1);assert.equal(db.length,1);assert.equal(second.written,0);assert.equal(JSON.parse(fs.readFileSync(second.receiptFile,'utf8')).written,0);
});

for(const outcome of ['gate_refused','uncertain','native_error'])test(`validated complete evidence wins over misleading bridge outcome ${outcome}`,async t=>{
  const root=temp(t),operation=op(),evidence=path.join(root,'receipt.json');fs.writeFileSync(evidence,JSON.stringify({ok:true,count:3,request:{records:rows.map((record,index)=>({id:`new-${index+1}`,attributes:[{name:'Code',value:record.Code}]}))},reports:rows.map((_,index)=>({status:'Success',clientRecordId:`new-${index+1}`,recordId:String(index+100)}))}));
  const channel=odcDataChannel({module:'M',entity:'Item',studioData:async()=>({ok:false,outcome,gate:'studio_busy',error:`the full report is in ${evidence}. Do not repeat without reading it.`})});const result=(await channel.write([operation]))[0];assert.equal(result.outcome,'completed');assert.deepEqual(result.ids,['100','101','102']);
});
