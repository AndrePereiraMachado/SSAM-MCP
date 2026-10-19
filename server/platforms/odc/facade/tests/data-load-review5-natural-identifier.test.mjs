import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDataLoad,odcDataChannel} from '../data-load.mjs';

// I1 (review 5): DATA_LOAD_KEY_NOT_NATURAL applies only to an auto-number identifier. O11 uses the autoNumber its schema
// already exposes; the ODC bridge reports identifierAutoNumber, and without it an identifier that is not an integer
// (a Text Code) is not generated. A natural identifier is the entity's own unique key: it is a candidate and may be the
// dryRun continuation. The next step never asks for the impossible.
let sequence=0;
const uuid=()=>`a6000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r5i-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const file=(root,name,rows)=>{const f=path.join(root,`${name}.json`);fs.writeFileSync(f,JSON.stringify(rows));return f;};
function odc({identifier,attributes,db,autoNumber}){
  const sent=[];
  const studioData=async args=>{
    if(args.op==='read')return{ok:true,tenant:'synthetic-tenant.test',moduleKey:'mk-synth',entityKey:'ek-synth',identifier,...(autoNumber===undefined?{}:{identifierAutoNumber:autoNumber}),
      attributes:attributes.map(a=>`${a.name}:${a.type}`),indexes:[],records:db.map(r=>({...r})),count:db.length,more:false};
    sent.push(args.op);
    const reports=args.records.map(record=>{const id=record[identifier];db.push({...record});return{status:'Success',clientRecordId:id,recordId:id};});
    return{ok:true,reports};
  };
  return{channel:odcDataChannel({studioData,module:'Geo',entity:'Country'}),sent};
}
const odcInput=(f,keys)=>({lane:'odc',module:'Geo',entity:'Country',files:[f],...(keys?{keys}:{}),operation:'insert',operationId:uuid(),authorization:'load synthetic countries',batchSize:10});
function o11(entity,db){
  let writes=0;
  return{channel:{schema:async()=>({ok:true,module:'Geo',moduleKey:'mk-o11',entities:[entity]}),identity:async()=>({lane:'o11',host:'synthetic-o11.test',moduleKey:'mk-o11',entityKey:'ek-o11',module:'Geo',entity:entity.name}),
    check:async()=>({ok:true}),readAll:async()=>({records:db.map(r=>({...r})),complete:true}),
    write:async ops=>ops.map(op=>({ok:true,ids:op.records.map(record=>{writes++;db.push({...record});return String(record[entity.identifier]);})}))},writes:()=>writes};
}
const o11Input=(f,keys,entity)=>({lane:'o11',host:'synthetic-o11.test',module:'Geo',entity,files:[f],keys,operation:'insert',operationId:uuid(),authorization:'load synthetic rows',batchSize:10});

for(const autoNumber of [undefined,false])test(`I1 odc: a Text identifier ${autoNumber===undefined?'(old bridge)':'(autoNumber:false)'} is a natural key and the only candidate`,async t=>{
  const root=temp(t),db=[],{channel,sent}=odc({identifier:'Code',attributes:[{name:'Code',type:'Text'},{name:'Active',type:'Boolean'}],db,autoNumber});
  const f=file(root,'currency',[{Code:'BRL',Active:true},{Code:'EUR',Active:true}]);
  const refused=await runDataLoad(odcInput(f,null),channel,{journalRoot:path.join(root,'j')});
  assert.equal(refused.code,'DATA_LOAD_KEYS_REQUIRED');assert.deepEqual(refused.keyCandidates[0],{keys:['Code'],source:'entity-identifier'});
  assert.deepEqual(refused.continuation.arguments.keys,['Code']);assert.equal(refused.continuation.arguments.dryRun,true);assert.doesNotMatch(refused.next,/add .*column to the source/i);
  const done=await runDataLoad(odcInput(f,['Code']),channel,{journalRoot:path.join(root,'j')});
  assert.equal(done.complete,true,JSON.stringify(done));assert.equal(done.inserted,2);assert.deepEqual(sent,['insert']);
  const composite=await runDataLoad({...odcInput(f,['Code','Active'])},channel,{journalRoot:path.join(root,'j')});
  assert.notEqual(composite.code,'DATA_LOAD_KEY_NOT_NATURAL');
});
test('I1 odc: identifierAutoNumber:true keeps the refusal, with a possible next step',async t=>{
  const root=temp(t),{channel}=odc({identifier:'Code',attributes:[{name:'Code',type:'Text'},{name:'Label',type:'Text'}],db:[],autoNumber:true});
  const out=await runDataLoad(odcInput(file(root,'c',[{Code:'BR',Label:'Brasil'}]),['Code']),channel,{journalRoot:path.join(root,'j')});
  assert.equal(out.code,'DATA_LOAD_KEY_NOT_NATURAL');assert.match(out.problems[0].reason,/auto-number/);
});
test('I1 odc: an integer identifier of an old bridge stays refused and says how to prove it is not auto-number',async t=>{
  const root=temp(t),{channel}=odc({identifier:'Id',attributes:[{name:'Id',type:'Long Integer'},{name:'Code',type:'Text'}],db:[{Id:'7',Code:'A'}]});
  const out=await runDataLoad(odcInput(file(root,'e',[{Id:'7',Code:'A2'}]),['Id']),channel,{journalRoot:path.join(root,'j')});
  assert.equal(out.code,'DATA_LOAD_KEY_NOT_NATURAL');assert.match(out.problems[0].reason,/identifierAutoNumber|auto-number/);
});
test('I1 o11: autoNumber from the schema decides; an Integer Id that is not auto-number is a natural key',async t=>{
  const root=temp(t);
  const natural={name:'Product',key:'ek-o11',identifier:'Id',attributes:[{name:'Id',type:'Integer',autoNumber:false},{name:'Name',type:'Text',autoNumber:false}],indexes:[]};
  const a=o11(natural,[]),done=await runDataLoad(o11Input(file(root,'p',[{Id:1,Name:'Pen'},{Id:2,Name:'Pen'}]),['Id'],'Product'),a.channel,{journalRoot:path.join(root,'j')});
  assert.equal(done.complete,true,JSON.stringify(done));assert.equal(a.writes(),2);
  const generated={name:'Order',key:'ek-o11',identifier:'Id',attributes:[{name:'Id',type:'Long Integer',autoNumber:true},{name:'Ref',type:'Text',autoNumber:false}],indexes:[]};
  const b=o11(generated,[]),refused=await runDataLoad(o11Input(file(root,'o',[{Id:1,Ref:'R1'}]),['Id'],'Order'),b.channel,{journalRoot:path.join(root,'j')});
  assert.equal(refused.code,'DATA_LOAD_KEY_NOT_NATURAL');assert.equal(b.writes(),0);
});
