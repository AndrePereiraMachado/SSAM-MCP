// R2-I (owner's rule, 28/10): the O11 Service Center cleanup of a connection whose test ended uncertain takes the user's
// written words naming the connection (no approval file); every check of the cleanup stays.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectionTestCleanupApproval } from '../service-center/db-approval.mjs';
import { Journal } from '../service-center/client.mjs';

test('a connection delete after an uncertain connection test takes the written words naming it; the same-connection, plan, consumer and sending checks stay', async t => {
  const base = { host: 'proof.example.test', connection: 'Temporary' };
  const plan = { ...base, action: 'db-connection-delete', connectionId: '30', dbms: 'SQL Server', parameters: { server: 'sql,1433', database: 'Disposable' }, usedBy: [] };
  const fixture = async (state = 'uncertain', override = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-db-written-')), journal = new Journal(dir), id = randomUUID();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    await journal.reserve(id, { ...base, action: 'db-connection-test' }, 'approved', {}, null, async receipt => {
      Object.assign(receipt, { state, plan: { ...plan, action: 'db-connection-test', ...override }, ok: false }); return receipt; });
    return { journal, id };
  };
  const identity = { ...base, action: 'db-connection-delete' };
  const f = await fixture();
  const approval = connectionTestCleanupApproval(f.journal, identity, { ...plan }, 'Delete the connection Temporary', Journal.targetOf);
  assert.deepEqual(approval.source, { kind: 'human-words' }); assert.deepEqual(approval.targets, ['Temporary']);
  const cleanup = randomUUID();
  f.journal.supersedeTestForCleanup(identity, { ...plan, authorizationContext: approval }, cleanup);
  const previous = f.journal.lookup(f.id);
  assert.equal(previous.state, 'superseded'); assert.equal(previous.testOutcome, 'unverified'); assert.equal(previous.supersededBy, cleanup);
  assert.equal(f.journal.holder(base), null);
  // Words that do not name the connection, consumers or another endpoint: no approval, and the pending test keeps the target.
  for (const [words, changed] of [['Delete it', {}], ['Delete the connection Temporary', { usedBy: ['BusinessExtension'] }], ['Delete the connection Temporary', { dbms: 'Oracle' }]]) {
    const g = await fixture();
    assert.equal(connectionTestCleanupApproval(g.journal, identity, { ...plan, ...changed }, words, Journal.targetOf), null);
    assert.equal(g.journal.holder(base), g.id);
  }
  // With the written approval, the cleanup still refuses another connection, a test being sent or consumers.
  for (const [state, override, changed] of [['sending', {}, {}], ['uncertain', { connectionId: '31' }, {}], ['uncertain', {}, { parameters: { server: 'other', database: 'Disposable' } }]]) {
    const g = await fixture(state, override);
    const written = { ...plan, ...changed };
    written.authorizationContext = connectionTestCleanupApproval(g.journal, identity, written, 'Delete the connection Temporary', Journal.targetOf);
    if (written.authorizationContext) assert.throws(() => g.journal.supersedeTestForCleanup(identity, written, randomUUID()));
    assert.equal(g.journal.holder(base), g.id); assert.notEqual(g.journal.lookup(g.id).state, 'superseded');
  }
  // A context file already on the plan stays as it was.
  assert.deepEqual(connectionTestCleanupApproval(f.journal, identity, { ...plan, authorizationContext: { operation: 'db-connection-delete' } }, 'x', Journal.targetOf), { operation: 'db-connection-delete' });
});
