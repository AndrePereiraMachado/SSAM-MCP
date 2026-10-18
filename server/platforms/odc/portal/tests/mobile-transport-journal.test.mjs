import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {WriteJournal} from '../runtime/write-journal.mjs';
test('an uncertain native file preparation blocks the alternative transport on the same target',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'binary-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const journal=new WriteJournal(dir);
 const common={kind:'odc-portal',tenant:'proof.outsystems.dev',target:{applicationKey:crypto.randomUUID(),environmentKey:crypto.randomUUID(),settingKey:crypto.randomUUID()}};
 const signed={...common,operationId:'mobileExtensibility.uploadFile'},converted={...common,operationId:'mobileExtensibility.convertFile'};
 const reserve=identity=>journal.reserve({operationUuid:crypto.randomUUID(),identity,wordsSha256:'a'.repeat(64),plan:{}});
 for(const [first,other]of [[signed,converted],[converted,signed]]){
  const receipt=reserve(first);journal.settle(receipt,{state:'uncertain'});
  assert.throws(()=>reserve(other),e=>e.code==='TARGET_PENDING');
  const observed=journal.lookup(receipt.operationUuid);journal.reconcile(observed,{state:'not-applied',observation:{readProof:'fixture-only'}});
  const next=reserve(other);journal.settle(next,{state:'confirmed'});
 }
});
