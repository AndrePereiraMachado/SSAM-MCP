import test from 'node:test';
import assert from 'node:assert/strict';
import { debugRedactionBinding } from '../debug-runtime.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
const sid = 'f'.repeat(32);
const consumer = { lane: 'o11', host: 'dev.example.test', module: 'UI', moduleKey: 'A'.repeat(22), runtimeUrl: 'https://dev.example.test/UI/' };
const producer = { ...consumer, module: 'CS', moduleKey: 'B'.repeat(22), runtimeUrl: 'https://dev.example.test/CS/', o11Auth: { applicationKey: 'C'.repeat(22) } };
const descriptor = () => ({ binding: appUserBinding(consumer, sid), expiresAt: new Date(Date.now() + 60000).toISOString() });
test('cross module redaction borrows only the same environment/session; it does not authorize the producer', () => {
  const d = descriptor(); assert.equal(debugRedactionBinding(producer, d, sid, true), d.binding);
  assert.throws(() => debugRedactionBinding(producer, d, sid), /scope_mismatch/);
  assert.throws(() => debugRedactionBinding(producer, d, 'b'.repeat(32), true), /scope_mismatch/);
  assert.throws(() => debugRedactionBinding({ ...producer, host: 'other.example.test', runtimeUrl: 'https://other.example.test/CS/' }, d, sid, true), /scope_mismatch/);
  assert.throws(() => debugRedactionBinding(producer, { ...d, expiresAt: '2000-01-01' }, sid, true), /scope_mismatch/);
  assert.throws(() => debugRedactionBinding({ ...producer, o11Auth: undefined }, d, sid, true), /scope_mismatch/);
});
