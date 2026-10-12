import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Journal,Client} from '../service-center/client.mjs';
import {createHash} from 'node:crypto';
const base={host:'proof.example.test',connection:'Temporary'};
const plan={...base,action:'db-connection-delete',connectionId:'30',dbms:'SQL Server',parameters:{server:'sql,1433',database:'Disposable'},usedBy:[],authorizationContext:{operation:'db-connection-delete'}};
async function fixture(state='uncertain',override={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-db-cleanup-')), journal=new Journal(dir), id=randomUUID();
  await journal.reserve(id,{...base,action:'db-connection-test'},'approved',{},null,async receipt=>{
    Object.assign(receipt,{state,plan:{...plan,...override},ok:false});return receipt;
  });
  return {dir,journal,id};
}
test('approved unchanged unused SQL cleanup preserves unknown test outcome without replay',async()=>{
  const f=await fixture();
  try {
    const cleanup=randomUUID(); f.journal.supersedeTestForCleanup({...base,action:'db-connection-delete'},plan,cleanup);
    const previous=f.journal.lookup(f.id);
    assert.equal(previous.state,'superseded'); assert.equal(previous.testOutcome,'unverified');
    assert.equal(previous.supersededBy,cleanup); assert.equal(previous.ok,false);
    assert.equal(f.journal.holder(base),null);
  } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('cleanup refuses active send, changed scope, consumers, missing approval and invalid operation',async()=>{
  for(const [state,override,changed,id] of [
    ['sending',{}, {},randomUUID()],['uncertain',{connectionId:'31'},{},randomUUID()],
    ['uncertain',{}, {usedBy:['BusinessExtension']},randomUUID()],
    ['uncertain',{}, {authorizationContext:null},randomUUID()],
    ['uncertain',{}, {parameters:{server:'other',database:'Disposable'}},randomUUID()],
    ['uncertain',{}, {},'not-a-uuid']
  ]) {
    const f=await fixture(state,override);
    try {
      assert.throws(()=>f.journal.supersedeTestForCleanup({...base,action:'db-connection-delete'},{...plan,...changed},id));
      assert.equal(f.journal.holder(base),f.id); assert.notEqual(f.journal.lookup(f.id).state,'superseded');
    } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
  }
});


test('test reconciliation reads the original hashed feedback without repeating HTTP',async()=>{
  for(const passed of [true,false]) {
    const f=await fixture();
    try {
      const body=Buffer.from(JSON.stringify({outers:{wt1_wtFeedback:{inner:`<span id="wt1_wtFeedback"><div class="alert ${passed?'alert-success':'alert-danger'}">private text</div></span>`}}}));
      const file=path.join(f.dir,'db-test-reply-fixture.txt');fs.writeFileSync(file,body);
      const receipt=f.journal.lookup(f.id);receipt.plan.target='https://proof.example.test/ServiceCenter/DatabaseConnection_Edit.aspx';
      receipt.responseEvidence={file,size:body.length,sha256:createHash('sha256').update(body).digest('hex')};f.journal.rewrite(receipt);
      const client=new Client({host:base.host},{},f.dir);
      const result=await client.verify(receipt,f.journal);
      assert.equal(result.state,'confirmed');assert.equal(result.testPassed,passed);assert.equal(result.replayed,false);
      assert.equal(result.responseVerification,'original-reply-sha256');assert.equal(f.journal.holder(base),null);
      assert.ok(!JSON.stringify(result).includes('private text'));
      fs.appendFileSync(file,'tamper');
      await assert.rejects(client.verify(receipt,f.journal),/evidence changed/);
    } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
  }
});
