import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runDataLoad} from '../data-load.mjs';
import {withDataEntityReservation} from '../data-load-lock.mjs';

// S1 (review 5): a reservation without a validated plan whose process died (an inline insert/update killed inside its
// native call, or a load killed between acquireEntity and plan.json) is removed, so the entity is never blocked
// forever. The BUSY refusal of a live owner without a plan says how to get out. Real processes, killed from outside.
const holder=fileURLToPath(new URL('./helpers/data-load-hold-reservation.mjs',import.meta.url));
const entity={name:'E',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'}],indexes:[]};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t,lane){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r5s-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const rows=path.join(root,'rows.json');fs.writeFileSync(rows,JSON.stringify([{Code:'A'},{Code:'B'}]));
  const db=[];let writes=0;
  const identity={lane,host:'synthetic.test',tenant:'synthetic.test',moduleKey:'module-m',entityKey:'entity-e',module:'M',entity:'E'};
  const channel={identity:async()=>identity,schema:async()=>({entities:[entity]}),check:async()=>({ok:true}),readAll:async()=>({records:db.map(r=>({...r})),complete:true}),
    write:async ops=>ops.map(op=>({ok:true,ids:op.records.map(record=>{writes++;const row={...record,Id:String(db.length+1)};db.push(row);return row.Id;})}))};
  return{root,rows,db,identity,channel,journalRoot:path.join(root,'loads'),writes:()=>writes,
    input:n=>({lane,host:'synthetic.test',module:'M',entity:'E',operation:'insert',files:[rows],keys:['Code'],operationId:`f0000000-0000-4000-8000-0000000000${String(n).padStart(2,'0')}`,authorization:'load synthetic rows'})};
}
async function killHolder(f,mode){
  const marker=path.join(f.root,`${mode}.entered`);
  const child=spawn(process.execPath,[holder,mode,f.journalRoot,f.identity.lane,marker,f.rows],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  for(let i=0;i<400&&!fs.existsSync(marker)&&child.exitCode===null;i++)await sleep(25);
  assert.ok(fs.existsSync(marker),`the holder entered its call: ${stderr}`);
  const reservations=fs.readdirSync(path.join(f.journalRoot,'.entities'));assert.equal(reservations.length,1,'the dead holder leaves its reservation');
  child.kill('SIGKILL');await new Promise(resolve=>child.exitCode!==null||child.signalCode?resolve():child.once('exit',resolve));
  return child.pid;
}
for(const lane of ['o11','odc']){
  for(const mode of ['inline','load'])test(`S1 ${lane}: a ${mode} holder killed before any plan never blocks the entity`,async t=>{
    const f=fixture(t,lane);await killHolder(f,mode);
    const load=await runDataLoad(f.input(1),f.channel,{journalRoot:f.journalRoot});
    assert.equal(load.complete,true,JSON.stringify(load));assert.equal(f.writes(),2);
    let ran=false;const inline=await withDataEntityReservation(f.identity,{journalRoot:f.journalRoot},async()=>{ran=true;return{ok:true};});
    assert.equal(inline.ok,true);assert.equal(ran,true);
  });
  test(`S1 ${lane}: a live owner without a plan is BUSY with the way out, and frees the entity when it ends`,async t=>{
    const f=fixture(t,lane);let release;const inside=new Promise(resolve=>{release=resolve;});let entered;const started=new Promise(resolve=>{entered=resolve;});
    const holding=withDataEntityReservation(f.identity,{journalRoot:f.journalRoot},()=>{entered();return inside;});
    await started;
    const busy=await runDataLoad(f.input(2),f.channel,{journalRoot:f.journalRoot});
    assert.equal(busy.code,'DATA_ENTITY_LOAD_BUSY');assert.equal(busy.ownerHasPlan,false);assert.equal(busy.otherPid,process.pid);
    assert.match(busy.next,/retry/i);assert.match(busy.next,/exited|dead|ended/i);assert.doesNotMatch(busy.next,/inspect its receipt/i);
    assert.equal(busy.continuation?.arguments?.operationId,f.input(2).operationId,'the way out is this same call again');
    release({ok:true});await holding;
    assert.equal((await runDataLoad(f.input(2),f.channel,{journalRoot:f.journalRoot})).complete,true);
  });
}
