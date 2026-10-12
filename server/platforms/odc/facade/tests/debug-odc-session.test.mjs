import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { odcSessionRequest, exchangeOdcNativeSession } from '../debug-odc-session.mjs';
const operationId = '22222222-2222-4222-8222-222222222222';
const binding = { host: 'personal-unit.outsystems.dev', pid: 42, includeToken: true, startedUtc: '2026-10-05T00:00:00.0000000Z', studioDir: 'C:\\Studio' };
const metadata = { host: binding.host, developerKey: '33333333-3333-4333-8333-333333333333', developerAuthor: 'unit-author' };
const args = { operationId, binding, pipeName: 'ssam-odc-session-' + operationId, receiptPath: '/not-present' };
function exchange(change = x => x, options = {}) {
  const writes = []; let connects = 0;
  const connect = () => {
    connects++; const peer = new EventEmitter(); peer.setEncoding = () => {}; peer.destroy = () => {};
    peer.write = (line, done) => {
      writes.push(JSON.parse(line));
      if (writes.length === 1) queueMicrotask(() => {
        if (options.disconnect) { peer.emit('error', Object.assign(new Error('private failure'), { code: 'ECONNRESET' })); return; }
        peer.emit('data', JSON.stringify(change({ ok: true, operationId, binding, metadata, token: 'private-unit-token' })) + '\n');
      });
      else if (!options.noAck) queueMicrotask(() => peer.emit('data', JSON.stringify({ ok: true, operationId, phase: 'consumed' }) + '\n'));
      done?.();
    };
    queueMicrotask(() => peer.emit('connect')); return peer;
  };
  return { result: exchangeOdcNativeSession({ ...args, ...(options.args ?? {}) }, { connect, timeoutMs: 50 }), writes, connects: () => connects };
}
test('session accepts only an explicit tenant and typed token request', () => {
  assert.deepEqual(odcSessionRequest({ host: binding.host, includeToken: false }), { host: binding.host, includeToken: false });
  for (const input of [{}, { host: 'https://' + binding.host, includeToken: true }, { host: 'evil.test', includeToken: true }, { host: binding.host, includeToken: 'true' }, { host: binding.host, includeToken: true, moduleKey: 'bad' }])
    assert.throws(() => odcSessionRequest(input), /contract_invalid/);
});
test('private reply requires matching binding and consumed acknowledgement', async () => {
  const e = exchange(); const result = await e.result;
  assert.equal(result.token, 'private-unit-token'); assert.equal(e.connects(), 1);
  assert.deepEqual(e.writes, [{ operationId, binding }, { operationId }]);
});
test('cross tenant reply is refused before acknowledgement', async () => {
  const e = exchange(r => ({ ...r, binding: { ...binding, host: 'another.outsystems.dev' } }));
  await assert.rejects(e.result, /reply_invalid/); assert.equal(e.writes.length, 1);
});
test('metadata cannot smuggle secrets into persisted receipt', async () => {
  const e = exchange(r => ({ ...r, metadata: { ...metadata, token: 'private-value' } }));
  await assert.rejects(e.result, /reply_invalid/); assert.equal(e.writes.length, 1);
});
test('metadata-only request rejects any bearer', async () => {
  const b = { ...binding, includeToken: false };
  const e = exchange(r => ({ ...r, binding: b }), { args: { binding: b } });
  await assert.rejects(e.result, /reply_invalid/);
});
test('loss after request never reconnects or resubmits', async () => {
  const e = exchange(undefined, { disconnect: true });
  await assert.rejects(e.result, /exchange_uncertain/); assert.equal(e.connects(), 1); assert.equal(e.writes.length, 1);
});
test('bearer received without final ACK confirmation remains uncertain', async () => {
  const e = exchange(undefined, { noAck: true }); await assert.rejects(e.result, /exchange_uncertain/); assert.equal(e.connects(), 1);
});
