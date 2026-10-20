// servidor/fase4-26 a9 follow-ups, round 2 (review C:\t\revisoes\a9-followups-line\REVISAO.md, B), on the hosted session: an
// answer of the hosted gate (PATH_OUTSIDE_WORKSPACE at any pointer, AGENT_RECONNECTING, every refusal the gate gives by itself)
// leaves by the gate's own exit, outside the hub's one rule of the owner's words, and its continuation gave the user's words back
// ready to repeat (replayed as it came, it wrote with them and the owner was never asked). Now every gate answer passes the same
// rule (the marker and askOwner): replayed as it came it is WORDS_REQUIRED and nothing is written; with the owner's new words it
// runs. The same family in the data refusals: the preview DATA_LOAD_KEYS_REQUIRED offers, and its correctedRequest (an echo the
// hub's rule does not mask), carried the words too; a preview needs none.
import './fixtures/isolated-profile.mjs';
import { AGENT_ROOT, assertNoWords, customer, downloads, markersOf, o11Cli, o11Server, odcServer, put, reconnectingAgent, said, v97Studio, withWords } from './fixtures/hosted-a9f2.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('B: a data file outside the agent folders (studio_data_insert /files/*): the continuation asks the owner, never repeats his words; as it came it writes nothing', async () => {
  const A = customer();
  const studio = v97Studio({ rows: [{ Id: '1', Name: 'existing', Age: '1' }] });
  const s = await odcServer(A, studio.data);
  const words = ['Synthetic owner words ALPHA: load c.csv into E', 'Synthetic owner words GAMMA: overwrite rows of E'];
  try {
    const args = { module: 'M', entity: 'E', files: [downloads('c.csv')], keys: ['Name'], operationId: randomUUID(), authorize: words[0],
      confirmUpdates: { previewSha256: 'a'.repeat(64), authorize: words[1] } };
    const refused = await s.call('studio_data_insert', args);
    assert.equal(refused.body.code, 'PATH_OUTSIDE_WORKSPACE', said(refused.body));
    assert.match(refused.body.fix, new RegExp('^copy c\\.csv as it is into ' + AGENT_ROOT.replaceAll('\\', '\\\\') + '\\\\inbox\\\\c\\.csv'), said(refused.body));
    assertNoWords(refused, words);
    const c = refused.body.continuation;
    assert.equal(c?.tool, 'studio_data_insert', said(refused.body));
    assert.deepEqual(markersOf(c.arguments).sort(), ['authorize', 'confirmUpdates/authorize']);
    assert.deepEqual(c.askOwner?.fields?.slice().sort(), ['authorize', 'confirmUpdates/authorize'], said(c));
    assert.match(c.why, /the owner's own words in place of the marker/);
    assert.deepEqual(c.arguments.files, ['agent:inbox/c.csv']);
    put(path.join(A.agentDir, 'inbox', 'c.csv'), 'Name,Age\nAna,30\n');
    // replayed as it came: the hub's rule, nothing written
    const asItCame = await s.call(c.tool, c.arguments);
    assert.equal(asItCame.body.code, 'WORDS_REQUIRED', said(asItCame.body));
    assert.equal(studio.writes(), 0, 'nothing written without the owner');
    // with the owner's new words in place of the markers: the load runs
    const done = await s.call(c.tool, withWords(c.arguments, 'Synthetic owner words DELTA: yes, load c.csv into E'));
    assert.equal(done.body.ok, true, said(done.body));
    assert.equal(done.body.inserted, 1, said(done.body));
  } finally { await s.close(); }
});

test('B: o11_data request.files (a nested list) and a first-level pointer (oml): no word comes back; as it came nothing reaches the CLI', async () => {
  const A = customer();
  put(path.join(A.workspace, 'o11', 'snapshots', 'Load_CS.oml'), 'synthetic offline schema fixture');
  const cli = o11Cli();
  const s = await o11Server(A, cli.runAnvil);
  const words = ['Synthetic owner words BETA: load c.csv into Item'];
  try {
    const target = { host: 'dev.example.test', module: 'Load_CS', oml: 'ws:o11/snapshots/Load_CS.oml' };
    // (a preview with the user's words: the words are noted, and the gate's continuation would have repeated them)
    const args = { ...target, request: { operation: 'insert', entity: 'Item', files: [downloads('c.csv')], keys: ['Name'], dryRun: true, authorization: words[0] } };
    const refused = await s.call('o11_data', args);
    assert.equal(refused.body.code, 'PATH_OUTSIDE_WORKSPACE', said(refused.body));
    assertNoWords(refused, words);
    const c = refused.body.continuation;
    assert.equal(c?.tool, 'o11_data', said(refused.body));
    assert.deepEqual(markersOf(c.arguments), ['request/authorization']);
    assert.deepEqual(c.askOwner?.fields, ['request/authorization'], said(c));
    put(path.join(A.agentDir, 'inbox', 'c.csv'), 'Name,Qty\nA,1\n');
    const asItCame = await s.call(c.tool, c.arguments);
    assert.equal(asItCame.body.code, 'WORDS_REQUIRED', said(asItCame.body));
    assert.equal(cli.calls.length, 0, 'nothing reached the CLI');
    const done = await s.call(c.tool, withWords(c.arguments, 'Synthetic owner words EPSILON: yes, load c.csv into Item'));
    assert.equal(done.body.ok, true, said(done.body));
    assert.equal(done.body.inserted, 1, said(done.body));
    assert.equal(cli.writes(), 0, 'a preview writes nothing');
    // the first-level pointer of the same tool: the same rule
    const oml = await s.call('o11_data', { ...target, oml: downloads('Load_CS.oml'), request: { operation: 'insert', entity: 'Item', records: [{ Name: 'B', Qty: 2 }], authorization: words[0] } });
    assert.equal(oml.body.code, 'PATH_OUTSIDE_WORKSPACE', said(oml.body));
    assertNoWords(oml, words);
    assert.deepEqual(markersOf(oml.body.continuation.arguments), ['request/authorization']);
    assert.deepEqual(oml.body.continuation.askOwner?.fields, ['request/authorization']);
  } finally { await s.close(); }
});

test('B: the other answers the gate gives by itself (a job of the user\'s machine, AGENT_RECONNECTING) never repeat the words either', async () => {
  const words = ['Synthetic owner words ZETA: deliver and publish Shop', 'Synthetic owner words ETA: insert Ana into E'];
  const A = customer();
  const s = await odcServer(A, v97Studio().data);
  try {
    const job = await s.call('studio_deliver', { module: 'Shop', job: downloads('job.json'), publish: true, authorize: words[0] });
    assert.equal(job.body.code, 'PATH_OUTSIDE_WORKSPACE', said(job.body));
    assertNoWords(job, words);
    assert.deepEqual(markersOf(job.body.continuation.arguments), ['authorize']);
    assert.deepEqual(job.body.continuation.askOwner?.fields, ['authorize']);
  } finally { await s.close(); }
  const B = customer(reconnectingAgent);
  const r = await odcServer(B, v97Studio().data);
  try {
    const away = await r.call('studio_data_insert', { module: 'M', entity: 'E', records: [{ Name: 'Ana', Age: '30' }], authorize: words[1] });
    assert.equal(away.body.code, 'AGENT_RECONNECTING', said(away.body));
    assertNoWords(away, words);
    assert.equal(away.body.continuation.tool, 'studio_data_insert');
    assert.deepEqual(markersOf(away.body.continuation.arguments), ['authorize']);
    assert.deepEqual(away.body.continuation.askOwner?.fields, ['authorize']);
  } finally { await r.close(); }
});

test('B (data refusals): DATA_LOAD_KEYS_REQUIRED offers a preview (dryRun) by the model\'s unique index; neither it nor correctedRequest repeats the words', async () => {
  const A = customer();
  put(path.join(A.workspace, 'o11', 'snapshots', 'Load_CS.oml'), 'synthetic offline schema fixture');
  put(path.join(A.agentDir, 'inbox', 'items.csv'), 'Name,Qty\nA,1\nB,2\n');
  const cli = o11Cli({ indexes: [{ name: 'NameUnique', unique: true, attributes: ['Name'] }] });
  const s = await o11Server(A, cli.runAnvil);
  const words = ['Synthetic owner words THETA: load items.csv into Item'];
  try {
    const target = { host: 'dev.example.test', module: 'Load_CS', oml: 'ws:o11/snapshots/Load_CS.oml' };
    const refused = await s.call('o11_data', { ...target, request: { operation: 'insert', entity: 'Item', files: ['agent:inbox/items.csv'], operationId: randomUUID(), authorization: words[0] } });
    assert.equal(refused.body.code, 'DATA_LOAD_KEYS_REQUIRED', said(refused.body));
    assertNoWords(refused, words);
    const c = refused.body.continuation;
    assert.equal(c?.tool, 'o11_data', said(refused.body));
    assert.deepEqual(c.arguments.request.keys, ['Name']);
    assert.equal(c.arguments.request.dryRun, true);
    assert.deepEqual(refused.body.correctedRequest, c.arguments, 'correctedRequest is the continuation\'s call');
    // the preview needs no words: as it comes, it runs and writes nothing
    const preview = await s.call(c.tool, c.arguments);
    assert.equal(preview.body.ok, true, said(preview.body));
    assert.equal(cli.writes(), 0);
  } finally { await s.close(); }
});
