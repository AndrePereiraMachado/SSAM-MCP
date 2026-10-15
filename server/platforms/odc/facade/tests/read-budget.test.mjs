import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedRead, readCheckpoint, readOptions } from '../read-budget.mjs';

test('an explicit Service Center budget includes the cold 45-second identity exchange',async()=>{
 const budget=await boundedRead('cold-sc-budget',()=>readOptions('authentication').timeoutMs,{timeoutMs:90000});
 assert.ok(budget>85000 && budget<=90000);
 const normal=await boundedRead('ordinary-budget',()=>readOptions().timeoutMs);
 assert.ok(normal<=29000);
});

test('concurrent identical reads share one in-flight request before the deadline', async () => {
  let release, sends = 0;
  const work = () => { sends++; return new Promise(resolve => { release = resolve; }); };
  const first = boundedRead('concurrent-before-deadline', work);
  const second = boundedRead('concurrent-before-deadline', work);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
  release({ ok: true, rows: [42] });
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true, rows: [42] }, { ok: true, rows: [42] }]);
  assert.deepEqual(await boundedRead('concurrent-before-deadline', () => ({ ok: true, fresh: true })), { ok: true, fresh: true });
});

test('concurrent reads keep the same pending handle after expiration', async () => {
  let release, sends = 0;
  const work = () => { sends++; return new Promise(resolve => { release = resolve; }); };
  const first = boundedRead('concurrent-expired', work, { timeoutMs: 5 });
  const second = boundedRead('concurrent-expired', work, { timeoutMs: 5 });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.operationId, b.operationId); assert.equal(sends, 1);
  assert.equal(a.code, 'READ_DEADLINE_EXCEEDED');
  release({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await boundedRead('concurrent-expired', () => assert.fail('no replay')), { ok: true });
});

test('reordering JSON arguments still recovers the same pending call', async () => {
  let release, sends = 0;
  const first = await boundedRead({ scope: 'reordered', args: { host: 'example.test', input: { offset: 0, limit: 10 } } },
    () => { sends++; return new Promise(resolve => { release = resolve; }); }, { timeoutMs: 5 });
  const reordered = { args: { input: { limit: 10, offset: 0 }, host: 'example.test' }, scope: 'reordered' };
  const again = await boundedRead(reordered, () => { sends++; });
  assert.equal(again.operationId, first.operationId); assert.equal(sends, 1);
  release({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await boundedRead(reordered, () => assert.fail('must not resend')), { ok: true });
});
test('deadline includes authentication and returns pending without resending or claiming cancellation', async () => {
  let release, sends = 0;
  const work = () => { sends++; readCheckpoint('authentication'); return new Promise(resolve => { release = resolve; }); };
  const result = await boundedRead('synthetic-pending', work, { timeoutMs: 5 });
  assert.equal(result.code, 'READ_DEADLINE_EXCEEDED');
  assert.equal(result.stage, 'authentication');
  assert.equal(result.remoteCancellationConfirmed, false);
  const again = await boundedRead('synthetic-pending', work, { timeoutMs: 5 });
  assert.equal(again.operationId, result.operationId); assert.equal(sends, 1);
  release({ ok: true, rows: [] }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await boundedRead('synthetic-pending', work), { ok: true, rows: [] });
  assert.equal(sends, 1);
});
test('after a timeout no continuation step can send another request', async () => {
  let resume, continued = false;
  await boundedRead('synthetic-no-followup', async () => {
    await new Promise(resolve => { resume = resolve; });
    readCheckpoint('transport'); continued = true;
  }, { timeoutMs: 5 });
  resume(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(continued, false);
  assert.equal((await boundedRead('synthetic-no-followup', () => assert.fail('must not resend'))).code, 'READ_DEADLINE_EXCEEDED');
});
