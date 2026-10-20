// servidor/fase4-26 a9 follow-ups, round 2 (review C:\t\revisoes\a9-followups-line\REVISAO.md, D), on the hosted session: M1 on a
// write load (an EMPTY ODC entity, bridge v97) answered nextCalls without the words; followed as it came, it was a second refusal
// (INPUT_INVALID /authorization) with no fix and no step. Now every write step of the load carries the words marker with
// askOwner (the continuation, nextCalls; and, the same family, the write continuation of a dryRun preview): complete once the
// owner answers, WORDS_REQUIRED replayed as it came, and the refusal of a write without the words says how to go on. Without a
// row that can be inserted as it is (G), the answer names no step it does not carry.
import './fixtures/isolated-profile.mjs';
import { assertNoWords, customer, markersOf, odcServer, put, said, v97Studio, withWords } from './fixtures/hosted-a9f2.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('D: a write load into an EMPTY entity: the continuation, then nextCalls[0], each with the owner\'s words in place of the marker, complete the load', async () => {
  const A = customer();
  put(path.join(A.agentDir, 'inbox', 'rows.json'), '[{"Name":"alpha","Age":5},{"Name":"beta","Age":6}]');
  const studio = v97Studio();
  const s = await odcServer(A, studio.data);
  const words = ['Synthetic owner words KAPPA: load rows.json into E'];
  try {
    const load = { module: 'M', entity: 'E', files: ['agent:inbox/rows.json'], keys: ['Name'], operationId: randomUUID(), authorize: words[0] };
    const refused = await s.call('studio_data_insert', load);
    assert.equal(refused.body.ok, false, said(refused.body));
    assertNoWords(refused, words);
    assert.equal(studio.writes(), 0);
    const c = refused.body.continuation, [again] = refused.body.nextCalls ?? [];
    assert.equal(again?.tool, 'studio_data_insert', said(refused.body));
    assert.deepEqual(markersOf(again.arguments), ['authorize'], 'the repeated load needs the owner\'s words too: ' + said(again));
    assert.deepEqual(again.askOwner?.fields, ['authorize'], said(again));
    assert.deepEqual(markersOf(c.arguments), ['authorize']);
    assert.deepEqual(c.askOwner?.fields, ['authorize'], said(c));
    assert.match(refused.body.next, /own words again/, said(refused.body.next));
    // the first row, with the owner's words
    const first = await s.call(c.tool, withWords(c.arguments, 'Synthetic owner words LAMBDA: insert the first row'));
    assert.notEqual(first.body.ok, false, said(first.body));
    assert.equal(studio.db.length, 1);
    // nextCalls[0] as it came: the hub's rule, nothing written
    const asItCame = await s.call(again.tool, again.arguments);
    assert.equal(asItCame.body.code, 'WORDS_REQUIRED', said(asItCame.body));
    assert.equal(studio.db.length, 1, 'nothing more written');
    // without the field at all: the refusal says how to go on (it had no fix and no step)
    const { authorize: _dropped, ...withoutField } = again.arguments;
    const dropped = await s.call(again.tool, withoutField);
    assert.equal(dropped.body.code, 'INPUT_INVALID', said(dropped.body));
    assert.match(JSON.stringify(dropped.body.problems), /ask the owner and pass his own words, verbatim, in authorize/, said(dropped.body.problems));
    assert.equal(studio.db.length, 1, 'nothing more written');
    // with the owner's words: the load completes
    const done = await s.call(again.tool, withWords(again.arguments, 'Synthetic owner words MU: load the rest of rows.json'));
    assert.equal(done.body.ok, true, said(done.body));
    assert.equal(done.body.inserted, 1, said(done.body));
    assert.equal(done.body.unchanged, 1, said(done.body));
    assert.deepEqual(studio.db.map(r => r.Name).sort(), ['alpha', 'beta']);
  } finally { await s.close(); }
});

test('D (the family): the dryRun path; the write continuation of the preview carries the marker, and no good row cites no step', async () => {
  const A = customer();
  put(path.join(A.agentDir, 'inbox', 'rows.json'), '[{"Name":"alpha","Age":5},{"Name":"beta","Age":6}]');
  const studio = v97Studio();
  const s = await odcServer(A, studio.data);
  try {
    const refused = await s.call('studio_data_insert', { module: 'M', entity: 'E', files: ['agent:inbox/rows.json'], keys: ['Name'], dryRun: true });
    const c = refused.body.continuation, [again] = refused.body.nextCalls ?? [];
    assert.equal(again?.arguments?.dryRun, true, 'the preview again: it needs no words');
    assert.deepEqual(markersOf(again.arguments), []);
    await s.call(c.tool, withWords(c.arguments, 'Synthetic owner words NU: insert the first row'));
    const preview = await s.call(again.tool, again.arguments);
    assert.equal(preview.body.ok, true, said(preview.body));
    const write = preview.body.continuation;
    assert.equal(write?.arguments?.dryRun, undefined, said(write));
    assert.deepEqual(markersOf(write.arguments), ['authorize'], 'the write of the preview asks the owner\'s words: ' + said(write));
    assert.deepEqual(write.askOwner?.fields, ['authorize'], said(write));
    const asItCame = await s.call(write.tool, write.arguments);
    assert.equal(asItCame.body.code, 'WORDS_REQUIRED', said(asItCame.body));
    const done = await s.call(write.tool, withWords(write.arguments, 'Synthetic owner words XI: load the rest of rows.json'));
    assert.equal(done.body.ok, true, said(done.body));
    assert.deepEqual([done.body.inserted, done.body.unchanged], [1, 1], said(done.body));
  } finally { await s.close(); }
  // no row of the files can be inserted as it is: the answer cites no continuation nor nextCalls it does not carry
  const B = customer();
  put(path.join(B.agentDir, 'inbox', 'bad.json'), '[{"Name":"alpha","Age":"abc"}]');
  const u = await odcServer(B, v97Studio().data);
  try {
    const bad = await u.call('studio_data_insert', { module: 'M', entity: 'E', files: ['agent:inbox/bad.json'], keys: ['Name'], dryRun: true });
    assert.equal(bad.body.ok, false, said(bad.body));
    assert.equal(bad.body.continuation, undefined);
    assert.equal(bad.body.nextCalls, undefined);
    assert.doesNotMatch(bad.body.next, /continuation|nextCalls/, said(bad.body.next));
    assert.doesNotMatch(JSON.stringify(bad.body.problems), /\(the continuation\)|\(nextCalls\)/, said(bad.body.problems));
  } finally { await u.close(); }
});
