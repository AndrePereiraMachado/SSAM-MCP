import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stallRecovery } from '../studio-recovery.mjs';
const resume={tool:'o11_deliver',arguments:{resume:'same-task'},why:'reconcilie pelo diário'};
test('error reports recover by exact title, then reconcile the same operation',()=>{
  const recovery=stallRecovery({verdict:'dialog',blockedBy:{title:'Erro inesperado',kind:'Modal'}},resume);
  assert.deepEqual(recovery[0].arguments,{command:'dismiss-dialog',args:{title:'Erro inesperado'}});
  assert.equal(recovery[1],resume);
});
test('a native Yes/No question is for the person even though classified MessageBox',()=>{
  const question='Save changes? Yes | No';
  const recovery=stallRecovery({verdict:'dialog',blockedBy:{title:'Save changes?',kind:'MessageBox',question,buttons:['Yes','No']}},resume);
  assert.equal(recovery[0].question,question);
  assert.equal(recovery[0].arguments.command,'wait');
  assert.equal(recovery[1],resume);
});
test('positive close-only evidence allows native recovery and gone means connect',()=>{
  assert.equal(stallRecovery({verdict:'dialog',blockedBy:{title:'Information',kind:'MessageBox',buttons:['OK']}},resume)[0].arguments.command,'dismiss-dialog');
  assert.deepEqual(stallRecovery({verdict:'studio-gone'},resume)[0].arguments,{lane:'o11'});
  assert.deepEqual(stallRecovery(null,resume),[resume]);
});
