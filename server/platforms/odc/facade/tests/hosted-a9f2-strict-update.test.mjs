// servidor/fase4-26 a9 follow-ups, round 2 (review C:\t\revisoes\a9-followups-line\REVISAO.md, C), on the hosted session: M1 on
// studio_data_update with insertMissing:false (an EMPTY ODC entity, bridge v97) proposed to insert the first row, against the
// user's option and without saying so; followed, the row went in and the update refused the rest. Now: the entity has no row, so
// every key is DATA_KEY_NOT_FOUND, as on an entity with rows (data-load.mjs planDataLoad); nothing is written; inserting is the
// only way, so the answer says so and asks the owner's decision, with no step to follow. The upsert (no insertMissing) keeps M1.
import './fixtures/isolated-profile.mjs';
import { customer, odcServer, put, said, v97Studio } from './fixtures/hosted-a9f2.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE = '[{"Name":"fresh","Age":5},{"Name":"other","Age":6}]';

test('C: studio_data_update insertMissing:false on an EMPTY ODC entity: every key DATA_KEY_NOT_FOUND, no insert proposed, the owner decides; nothing written', async () => {
  const A = customer();
  put(path.join(A.agentDir, 'inbox', 'u.json'), FILE);
  const studio = v97Studio();
  const s = await odcServer(A, studio.data);
  try {
    for (const write of [false, true]) {
      const args = { module: 'M', entity: 'E', files: ['agent:inbox/u.json'], keys: ['Name'], insertMissing: false,
        ...(write ? { operationId: randomUUID(), authorize: 'Synthetic owner words IOTA: update the rows of E' } : { dryRun: true }) };
      const refused = await s.call('studio_data_update', args);
      assert.equal(refused.body.ok, false, said(refused.body));
      assert.equal(refused.body.code, 'DATA_KEY_NOT_FOUND', said(refused.body));
      assert.deepEqual([...new Set(refused.body.problems.map(p => p.code))], ['DATA_KEY_NOT_FOUND'], said(refused.body.problems));
      assert.equal(refused.body.problemCount, 2, 'one per row of the files');
      assert.equal(refused.body.rowsWithProblems, 2);
      assert.match(refused.body.reason, /no rows/i, said(refused.body));
      assert.match(refused.body.reason, /insertMissing:false/);
      assert.match(refused.body.next, /nothing was written/i);
      assert.match(refused.body.next, /ask the owner/i, 'inserting is the only way: the owner decides');
      assert.equal(refused.body.continuation, undefined, 'no step to follow without the owner\'s decision: ' + said(refused.body.continuation));
      assert.equal(refused.body.nextCalls, undefined, said(refused.body.nextCalls));
      assert.doesNotMatch(refused.text, /"records"/, 'no row inline to insert');
      assert.equal(studio.writes(), 0, 'nothing written');
    }
  } finally { await s.close(); }
});

test('C (reference and control): insertMissing:false with rows gives the same DATA_KEY_NOT_FOUND; the upsert keeps the first row inline', async () => {
  const A = customer();
  put(path.join(A.agentDir, 'inbox', 'u.json'), FILE);
  const withRows = v97Studio({ rows: [{ Id: '1', Name: 'existing', Age: '1' }] });
  const s = await odcServer(A, withRows.data);
  try {
    const strict = await s.call('studio_data_update', { module: 'M', entity: 'E', files: ['agent:inbox/u.json'], keys: ['Name'], insertMissing: false, dryRun: true });
    assert.equal(strict.body.code, 'DATA_KEY_NOT_FOUND', said(strict.body));
    assert.deepEqual([...new Set(strict.body.problems.map(p => p.code))], ['DATA_KEY_NOT_FOUND']);
  } finally { await s.close(); }
  const B = customer();
  put(path.join(B.agentDir, 'inbox', 'u.json'), FILE);
  const empty = v97Studio();
  const u = await odcServer(B, empty.data);
  try {
    const upsert = await u.call('studio_data_update', { module: 'M', entity: 'E', files: ['agent:inbox/u.json'], keys: ['Name'], dryRun: true });
    assert.equal(upsert.body.continuation?.tool, 'studio_data_insert', said(upsert.body));
    assert.equal(upsert.body.continuation.arguments.records[0].Name, 'fresh');
    assert.equal(upsert.body.nextCalls?.[0]?.tool, 'studio_data_update');
    assert.equal(empty.writes(), 0);
  } finally { await u.close(); }
});
