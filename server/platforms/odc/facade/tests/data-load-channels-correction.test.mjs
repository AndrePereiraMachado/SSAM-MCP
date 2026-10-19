import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { o11DataChannel, odcDataChannel } from '../data-load.mjs';
import {wordsSha256} from '../destructive-operations.mjs'; // review 6: only the sha256 of the owner's words is kept or sent

const operation = () => ({operation:'insert',entity:'Item',operationId:'13000000-0000-4000-8000-000000000001',batch:0,identifier:'Id',authorization:'original plan words',records:[{Name:'A'},{Name:'B'}]});
function temp(t) {const root=fs.mkdtempSync(path.join(os.tmpdir(),'data-channel-correction-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function o11(t, reply, requests=[]) {return o11DataChannel({call:{module:'M',oml:path.join(temp(t),'snapshot.oml')},work:temp(t),authorization:'changed resume words',runAnvil:async argv=>{if(argv.includes('--request'))requests.push(JSON.parse(fs.readFileSync(argv[argv.indexOf('--request')+1],'utf8')));return typeof reply==='function'?reply(argv):reply;}});}
const report = (index, success, base=0) => ({clientRecordId:`new-${index+base}`,recordId:success?String(101+index):null,status:success?'Success':'Error',error:success?null:'Value too long'});
const bridgeRecords = op => op.records.map((record,index)=>({id:record[op.identifier]??`new-${index+1}`,attributes:Object.entries(record).filter(([name])=>name!==op.identifier).map(([name,value])=>({name,value:value===''?null:value}))}));

test('O11 classifies complete partial kernel reports as failed with zero-based source indices',async t=>{
  const channel=o11(t,{envelope:{ok:false,data:{ok:false,submitted:1,total:2,results:[{ok:false,reports:[report(1,false),report(0,true)],ids:['101',null],receipt:'kernel-receipt'}]}}});
  const results=await channel.write([operation(),{...operation(),batch:1}]);
  assert.equal(results[0].outcome,'failed');assert.deepEqual(results[0].ids,['101']);assert.deepEqual(results[0].successfulRows,[{index:0,id:'101'}]);assert.deepEqual(results[0].failedRows,[{index:1,reason:'Value too long'}]);assert.equal(results[1].outcome,'not-submitted');
});

for(const reply of [{envelope:{ok:false,error:'Studio closed before connect'}},{envelope:{ok:false,data:{ok:false,submitted:0,problems:[{code:'REFUSED'}],error:'No writes sent'}}},{ok:false,outcome:'gate_refused',error:'Module gate refused'},{ok:false,outcome:'studio_busy',error:'Studio busy'}]) {
  test(`O11 pre-dispatch ${reply.envelope?.error??reply.envelope?.data?.error??reply.outcome} is not-submitted`,async t=>{const result=(await o11(t,reply).write([operation()]))[0];assert.equal(result.outcome,'not-submitted');assert.ok(result.error);assert.deepEqual(result.ids,[]);});
}

test('O11 honors plan words and strips every non-native operation field',async t=>{
  const requests=[],op={...operation(),firstRow:1,globalRows:[1,2],failedRows:[],retryOf:0,files:['synthetic']};
  await o11(t,{ok:true,results:[{ok:true,ids:['101','102']}]},requests).write([op]);
  // Review 6 (R6-F15, converted): the kernel gets sha256:<hex> of the plan's words, never the words.
  const planWords='sha256:'+wordsSha256('original plan words');
  assert.equal(requests[0].authorization,planWords);assert.deepEqual(requests[0].batch,[{operation:op.operation,entity:op.entity,operationId:op.operationId,records:op.records,authorization:planWords}]);
});

test('O11 completed receipt with readback mismatch retains the authoritative ids',async t=>{
  const result=(await o11(t,{ok:false,results:[{ok:false,outcome:'uncertain',code:'DATA_READBACK_MISMATCH',ids:['101','102'],reports:[report(0,true),report(1,true)],receipt:'completed-native-receipt'}]}).write([operation()]))[0];
  assert.equal(result.outcome,'completed');assert.deepEqual(result.ids,['101','102']);assert.equal(result.code,'DATA_READBACK_MISMATCH');
  assert.equal(result.nativeOk,false);
});

test('O11 completed ids retain native readback-failed status without making a replayable write',async t=>{
  const result=(await o11(t,{ok:false,results:[{ok:false,outcome:'uncertain',code:'DATA_READBACK_FAILED',error:'The write succeeded but reading it back failed',ids:['101','102'],reports:[report(0,true),report(1,true)],receipt:'completed-native-receipt'}]}).write([operation()]))[0];
  assert.equal(result.outcome,'completed');assert.equal(result.nativeOk,false);assert.equal(result.code,'DATA_READBACK_FAILED');assert.deepEqual(result.ids,['101','102']);assert.ok(!result.replayable);
});

test('O11 reused UUID is not-submitted and transport loss is uncertain for every op in the group',async t=>{
  const reused=(await o11(t,{ok:false,results:[{ok:false,error:'InvalidOperationException: operationId already belongs to a different request.'}]}).write([operation()]))[0];assert.equal(reused.outcome,'not-submitted');assert.equal(reused.code,'DATA_LOAD_ID_REUSED');
  const lost=await o11(t,{unknown:true,error:'Transport response lost'}).write([operation(),{...operation(),batch:1}]);assert.deepEqual(lost.map(r=>r.outcome),['uncertain','uncertain']);assert.ok(lost.every(result=>result.replayable));
  const pending=(await o11(t,{ok:false,results:[{ok:false,error:'Uncertain write: reconcile the pending native receipt'}]}).write([operation()]))[0];assert.equal(pending.outcome,'uncertain');assert.ok(!pending.replayable);
});

test('O11 schema/read errors throw their native message and check preserves structured pointers',async t=>{
  const channel=o11(t,argv=>argv.includes('--check')?{ok:false,problems:[{pointer:'/batch/0/records/1/Name',code:'DATA_VALUE_INVALID',message:'bad value'}]}:{envelope:{ok:false,data:{ok:false,code:'DATA_READ_TIMEOUT',error:'Native session unavailable'}}});
  await assert.rejects(()=>channel.schema(),/Native session unavailable/);
  await assert.rejects(()=>channel.readAll('Item',{fields:['Name'],offset:0,limit:100,deadlineAt:Date.now()+60000}),/Native session unavailable/);
  const checked=await channel.check({batch:[]});assert.equal(checked.problems[0].pointer,'/batch/0/records/1/Name');
  await assert.rejects(()=>o11(t,{ok:false,error:'Kernel check process failed'}).check({batch:[]}),/Kernel check process failed/);
  await assert.rejects(()=>o11(t,{ok:false,problems:[],error:'Kernel failed before validating any row'}).check({batch:[]}),/Kernel failed before validating any row/);
});

for(const throws of [false,true]) {
  test(`ODC ${throws?'thrown':'returned'} native error extracts validated evidence and one-based report indices`,async t=>{
    const root=temp(t),op=operation(),evidence=path.join(root,'native.json');fs.writeFileSync(evidence,JSON.stringify({count:2,request:{records:bridgeRecords(op)},reports:[report(1,false,1),report(0,true,1)]}));
    const error=`data-insert failed; the full report is in ${evidence}. Do not repeat without reading it.`,channel=odcDataChannel({module:'M',entity:'Item',authorize:'resume words',studioData:async()=>{if(throws)throw new Error(error);return{ok:false,error,code:'NATIVE_REJECTED'};}});
    const result=(await channel.write([op]))[0];assert.equal(result.outcome,'failed');assert.deepEqual(result.successfulRows,[{index:0,id:'101'}]);assert.deepEqual(result.failedRows,[{index:1,reason:'Value too long'}]);assert.equal(result.evidenceFile,evidence);assert.match(result.error,/full report/);
  });
}

for(const kind of ['wrong-count','other-records','same-values-different-order','remote']) {
  test(`ODC evidence ${kind} cannot lend success ids to this batch`,async t=>{
    const root=temp(t),op=operation(),local=path.join(root,'native.json'),evidence=kind==='remote'?'https://example.invalid/report.json':local,wire=bridgeRecords(op);
    if(kind==='other-records')wire[0].attributes[0].value='someone else';if(kind==='same-values-different-order')wire.reverse();
    fs.writeFileSync(local,JSON.stringify({count:kind==='wrong-count'?3:2,request:{records:wire},reports:[report(0,true,1),report(1,true,1)]}));
    const result=(await odcDataChannel({module:'M',entity:'Item',studioData:async()=>({ok:false,error:`the full report is in ${evidence}. Do not repeat without reading it.`})}).write([op]))[0];assert.equal(result.outcome,'uncertain');assert.deepEqual(result.ids,[]);
  });
}

test('ODC direct complete reports preserve failure reason/code and stable plan authorization',async()=>{
  let sent;const channel=odcDataChannel({module:'M',entity:'Item',authorize:'changed resume words',studioData:async args=>{sent=args;return{ok:false,code:'COLUMN_TOO_LONG',error:'Native detail '+ 'x'.repeat(2000),reports:[report(0,true,1),report(1,false,1)]};}}),result=(await channel.write([operation()]))[0];
  assert.equal(sent.authorize,'original plan words');assert.equal(result.outcome,'failed');assert.equal(result.code,'COLUMN_TOO_LONG');assert.ok(result.error.length<=600);assert.equal(result.failedRows[0].reason,'Value too long');
});

test('ODC missing acknowledgment without non-submission proof is uncertain; read failure cannot appear as an empty table',async()=>{
  const channel=odcDataChannel({module:'M',entity:'Item',studioData:async()=>({ok:false,code:'STUDIO_NOT_READY',error:'Studio closed'})});
  assert.equal((await channel.write([operation()]))[0].outcome,'uncertain');await assert.rejects(()=>channel.readAll('Item',{fields:['Name']}),/Studio closed/);await assert.rejects(()=>channel.schema(['Parent']),/Studio closed/);
});

test('Both channels correlate explicit identifiers observed by schema without an identifier option',async t=>{
  const observed={name:'Item',key:'entity-Item',identifier:'Key',attributes:[{name:'Key',type:'Item Identifier'},{name:'Name',type:'Text'}]},records=[{Key:'8',Name:'A'},{Key:'9',Name:'B'}],reports=[{clientRecordId:'9',recordId:'109',status:'Success'},{clientRecordId:'8',recordId:'108',status:'Success'}];
  const kernel=o11(t,argv=>argv.includes('--schema')?{ok:true,entities:[observed]}:{ok:true,results:[{ok:true,reports}]});await kernel.schema();assert.deepEqual((await kernel.write([{...operation(),identifier:undefined,records}]))[0].ids,['108','109']);
  const studio=odcDataChannel({module:'M',entity:'Item',studioData:async args=>args.op==='read'?{ok:true,attributes:['Key:Item Identifier','Name:Text'],records:[{Key:'7',Name:'Seed'}]}:{ok:true,reports}});await studio.schema(['Item']);assert.deepEqual((await studio.write([{...operation(),identifier:undefined,records}]))[0].ids,['108','109']);
});
