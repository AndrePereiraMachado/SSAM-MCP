import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDataLoad} from '../data-load.mjs';
import {wrap,createFacadeServer} from '../mcp.mjs';
import {createSsamServer} from '../ssam.mjs';
import {withStudioWriteLock} from '../studio-write-lock.mjs';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';

const op='a1000000-0000-4000-8000-000000000001';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'rows.json');fs.writeFileSync(file,JSON.stringify([{Name:'A'},{Name:'B'},{Name:'C'}]));
  let writes=0;
  const input={lane:'odc',host:'synthetic.test',module:'M',entity:'E',operation:'insert',files:[file],keys:['Name'],batchSize:1,operationId:op,authorize:'write synthetic records'};
  const channel={readAll:async()=>({records:[],complete:true}),schema:async()=>({moduleKey:'module-m',entities:[{name:'E',key:'entity-E',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Name',type:'Text'}]}]}),write:async ops=>{writes+=ops.length;return ops.map(()=>({ok:true,ids:[String(writes)]}));}};
  return{root,input,channel,options:{journalRoot:path.join(root,'loads')},writes:()=>writes};
}
test('H5 concurrent identical load is refused before touching its journal or writing twice',async t=>{
  const f=fixture(t),gate=deferred(),started=deferred();let schemaCalls=0;
  const original=f.channel.schema;f.channel.schema=async()=>{schemaCalls++;started.resolve();await gate.promise;return original();};
  const first=runDataLoad(f.input,f.channel,f.options);await started.promise;
  const second=runDataLoad(f.input,f.channel,f.options);gate.resolve();
  const answers=await Promise.all([first,second]);
  assert.equal(answers.filter(v=>v.complete===true).length,1,JSON.stringify(answers));
  assert.equal(answers.find(v=>v.code==='DATA_LOAD_BUSY')?.otherOperationId,op);
  assert.equal(f.writes(),3);assert.equal(schemaCalls,1);
});
test('H5 file wrapper retains the internal work after cancellation until the current batch settles',async()=>{
  const gate=deferred(),started=deferred(),controller=new AbortController();let ended=false;
  const wrapped=wrap(async()=>{started.resolve();await gate.promise;ended=true;return{ok:true};},{drain:args=>Array.isArray(args.files)});
  let answered=false;const work=wrapped({files:['synthetic.json']},{mcpReq:{signal:controller.signal}}).then(v=>{answered=true;return v;});
  await started.promise;controller.abort();await new Promise(setImmediate);
  const early=answered;gate.resolve();await work;
  assert.equal(early,false,'outer Studio write lock must still own the internal handler');assert.equal(ended,true);
});
test('H5 cancelled load stops between batches and same operation resumes without duplicates',async t=>{
  const f=fixture(t),controller=new AbortController(),gate=deferred(),started=deferred(),write=f.channel.write;
  f.channel.write=async ops=>{started.resolve();await gate.promise;return write(ops);};
  const pending=runDataLoad(f.input,f.channel,{...f.options,signal:controller.signal});
  await started.promise;controller.abort();gate.resolve();const stopped=await pending;
  assert.equal(stopped.complete,false);assert.equal(stopped.code,'CANCELLED');assert.equal(f.writes(),1);
  const resumed=await runDataLoad(f.input,f.channel,f.options);assert.equal(resumed.complete,true,JSON.stringify(resumed));assert.equal(f.writes(),3);
});
test('H5 ODC proxy cancellation holds the outer Studio lock until the inner batch finishes',async t=>{
  const f=fixture(t),gate=deferred(),started=deferred(),controller=new AbortController();let released=0,inserts=0;
  const rows=[];
  const data=async args=>{
    if(args.op==='read')return{ok:true,tenant:'synthetic.test',moduleKey:'module-m',entityKey:'entity-e',identifier:'Id',attributes:['Id:E Identifier','Name:Text'],records:rows.slice(args.offset??0,(args.offset??0)+(args.limit??100)),more:false};
    inserts++;if(inserts===1){started.resolve();await gate.promise;}
    const reports=args.records.map((record,i)=>{const id=String(rows.length+1);rows.push({Id:id,...record});return{recordId:id,clientRecordId:`new-${i+1}`,status:'Success'};});
    return{ok:true,reports};
  };
  const server=await createSsamServer({deps:{dataRoot:f.root,odcRoot:f.root,odcDataRoot:f.options.journalRoot,
    odcFacade:()=>createFacadeServer({env:{...process.env,SSAM_ODC_OFFLINE:'1'},deps:{studioData:data,dataRoot:f.options.journalRoot}}),
    writeLock:(options,fn)=>withStudioWriteLock({...options,deps:{o11Root:path.join(f.root,'kernel'),odcRoot:f.root}},async()=>{
      try{return await fn();}finally{if(options.tool==='studio_data_insert')released++;}
    })}});
  const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'cx13-cancel-proxy',version:'1'});
  await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
  const {lane,host,operation,...args}=f.input;
  const first=client.callTool({name:'studio_data_insert',arguments:args},{signal:controller.signal}).catch(error=>error);
  await Promise.race([started.promise,first.then(value=>{throw Error(JSON.stringify(value));})]);controller.abort();await new Promise(resolve=>setTimeout(resolve,30));
  const earlyRelease=released;const second=client.callTool({name:'studio_data_insert',arguments:args});
  gate.resolve();await first;const answer=await second;
  assert.equal(earlyRelease,0,'SDK cancellation must not release while the native batch is still running');
  // CX12 in the candidate (share cancelled calls), converted: the identical second call joins the cancelled one and
  // answers its outcome (CANCELLED, resumable, nothing duplicated); the next call resumes the same load and completes it.
  const value=answer.structuredContent??JSON.parse(answer.content[0].text);
  assert.equal(value.code,'CANCELLED',JSON.stringify(value));assert.equal(value.complete,false);assert.equal(value.state,'resumable');
  assert.equal(new Set(rows.map(r=>r.Name)).size,rows.length,'nothing duplicated');
  const third=await client.callTool({name:'studio_data_insert',arguments:args});const done=third.structuredContent??JSON.parse(third.content[0].text);
  assert.equal(done.complete,true,JSON.stringify(done));assert.equal(rows.length,3);assert.equal(new Set(rows.map(r=>r.Name)).size,3);
});
test('H5 only an exited PID permits stale load lock recovery; age never steals an active PID',async t=>{
  const f=fixture(t),lock=path.join(f.options.journalRoot,'.locks',`${op}.lock`);
  fs.mkdirSync(path.dirname(lock),{recursive:true});
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token:'active',startedAt:0}));
  const refused=await runDataLoad(f.input,f.channel,f.options);
  assert.equal(refused.code,'DATA_LOAD_BUSY');assert.equal(f.writes(),0);assert.ok(fs.existsSync(lock));
  fs.writeFileSync(lock,JSON.stringify({pid:2147483647,token:'exited'}));
  const result=await runDataLoad(f.input,f.channel,f.options);
  assert.equal(result.complete,true,JSON.stringify(result));assert.equal(f.writes(),3);assert.equal(fs.existsSync(lock),false);
});
test('M1 a second open entity load names the reservation owner; finishing it allows a new load',async t=>{
  const f=fixture(t);let clock=0;const write=f.channel.write;
  f.channel.write=async ops=>{const reply=await write(ops);clock+=1000;return reply;};
  const first=await runDataLoad({...f.input,deadlineMs:1000},f.channel,{...f.options,now:()=>clock});
  assert.equal(first.complete,false);assert.equal(f.writes(),1);
  const other={...f.input,operationId:'a1000000-0000-4000-8000-000000000002'};
  const refused=await runDataLoad(other,f.channel,f.options);
  assert.equal(refused.code,'DATA_ENTITY_LOAD_BUSY');assert.equal(refused.otherOperationId,op);assert.equal(f.writes(),1);
  const completed=await runDataLoad(f.input,f.channel,f.options);
  assert.equal(completed.complete,true,JSON.stringify(completed));assert.equal(f.writes(),3);
  const next=await runDataLoad(other,f.channel,f.options);
  assert.equal(next.complete,true,JSON.stringify(next));assert.equal(f.writes(),6);
});
