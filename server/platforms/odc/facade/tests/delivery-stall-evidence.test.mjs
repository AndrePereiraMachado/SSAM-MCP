import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deliverOutcome} from '../o11-cycle.mjs';

// CX14 R4: the pending merge keeps its own evidence (pendingBridgeOperation.stall: the Studio S1 that ran it) in the kernel
// receipt; the stop of a later call (the resume's open_module in a restarted Studio S2) is `stalled`, what blocks now. The
// answer recovers from what blocks now and shows the pending operation as before (method, moduleKey, operationId).
test('an uncertain merge answers the current blocker and the pending journal, its own Studio stays in the receipt',()=>{
  const S1={pid:4242,startedUtc:'2026-10-15T00:12:00Z#S1'},S2={pid:5353,startedUtc:'2026-10-15T00:31:00Z#S2'};
  const value=deliverOutcome({envelope:{ok:false,data:{taskId:'d1c5d86c58d64c61b250ceb44617a47d',module:'Probe',delivered:false,writeState:'unknown',stage:'open',operationId:'op-1',
    error:'BridgeCallException: open_module: Studio call stopped (dialog-before): Erro inesperado; nothing was repeated',
    stalled:{verdict:'dialog-before',method:'open_module',afterMs:0,studio:S2,blockedBy:{title:'Erro inesperado',type:'DialogWindow',kind:'UnexpectedError',seenMs:0}},
    pendingBridgeOperation:{method:'merge_from_oml',moduleKey:'K',operationId:'op-1',
      stall:{verdict:'dialog',method:'merge_from_oml',afterMs:118,studio:S1,blockedBy:{title:'Unexpected Error',type:'DialogWindow',kind:'UnexpectedError',seenMs:100}}}}}},
    {trackId:'facade-task',work:fs.mkdtempSync(path.join(os.tmpdir(),'cx14-r4-'))});
  assert.equal(value.code,'DELIVERY_UNCERTAIN');assert.equal(value.writeState,'unknown');
  assert.deepEqual(value.pendingBridgeOperation,{method:'merge_from_oml',moduleKey:'K',operationId:'op-1'});
  assert.equal(value.recovery[0].arguments.args.title,'Erro inesperado');
  assert.ok(!JSON.stringify(value).includes('#S1'),'the receipt keeps the merge Studio; the answer does not repeat it');
});
