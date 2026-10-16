import './fixtures/isolated-profile.mjs';
// CX15 r3, CT-2 (subagent SC): in the O11 Service Center engine the record of an operation opens in execute(), after the
// gate, the listings, the simulations and the checks of the execution. During that window an execution already accepted
// (token + the owner's words) must never read as a bare "previewed, executed:false" in ssam_task: the engine notes the
// requested execution (pid) at its start, so ssam_task {id} (operationId or previewId) says a call with the token is
// running; once the record opens it reads the record; a call that ends without one (a refusal) leaves no note. The same
// for o11_environment delete-app (the same engine). Offline: async fake bridge with hooks, fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIRM_MIN_AGE_MS } from '../destructive-operations.mjs';
import { PERSONAL, engineWorld, tools } from './fixtures/r3-sc-world.mjs';

const marker = (w, operationId) => path.join(w.root, 'operations', operationId + '.requested');

test('CT-2: during the 3rd simulation of an accepted execution, ssam_task {id} never answers a bare executed:false; then the record answers; no note is left', async () => {
  const w = engineWorld();
  const t = tools(w);
  const preview = await t.call({ action: 'delete', host: PERSONAL, prefix: 'ZZC' });
  assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 300));
  w.clock.advance(CONFIRM_MIN_AGE_MS);
  let sims = 0; const seen = [];
  w.onApi = async (operation, args) => {
    if (operation === 'DeleteApplication' && args.simulate && ++sims === 3)
      seen.push(await t.task({ id: preview.operationId }), await t.task({ id: preview.previewId }));
  };
  const done = await t.call({ action: 'delete', host: PERSONAL, confirmationToken: preview.confirmationToken, words: 'sim, apaga os 4 ZZC' });
  w.onApi = null;
  assert.equal(seen.length, 2, 'the execution ran its simulations');
  for (const answer of seen) {
    const state = answer.destructiveOperation;
    assert.ok(state, JSON.stringify(answer).slice(0, 300));
    assert.notEqual(state.executed, false, 'never a bare executed:false while the accepted execution runs: ' + JSON.stringify(state).slice(0, 400));
    assert.deepEqual([state.state, state.executed, state.pid], ['execution-requested', 'unknown', process.pid]);
    assert.match(state.note, /never tell the owner nothing happened/);
  }
  assert.deepEqual([done.state, w.sends()], ['confirmed', ['k-a', 'k-b', 'k-c', 'k-d']], JSON.stringify(done).slice(0, 300));
  assert.equal(fs.existsSync(marker(w, preview.operationId)), false, 'the note goes once the record opens');
  const after = await t.task({ id: preview.operationId });
  assert.deepEqual([after.destructiveOperation.state, after.destructiveOperation.counts], ['completed', { deleted: 4 }]);
});

test('CT-2: an execution refused by its checks leaves no note: ssam_task says previewed with the caveat, never "execution-requested"', async () => {
  const w = engineWorld();
  const t = tools(w);
  const preview = await t.call({ action: 'delete', host: PERSONAL, prefix: 'ZZC' });
  w.clock.advance(CONFIRM_MIN_AGE_MS);
  let during = null;
  w.onApi = async (operation, args) => { if (operation === 'DeleteApplication' && args.simulate && !during) during = await t.task({ id: preview.operationId }); };
  const refused = await t.call({ action: 'delete', host: PERSONAL, confirmationToken: preview.confirmationToken, words: 'vai la' });
  w.onApi = null;
  assert.equal(refused.code, 'DELETE_REFUSED');
  assert.deepEqual([during?.destructiveOperation?.state, during?.destructiveOperation?.executed], ['execution-requested', 'unknown'], JSON.stringify(during).slice(0, 300));
  assert.equal(fs.existsSync(marker(w, preview.operationId)), false, 'no note after the call');
  const after = (await t.task({ id: preview.operationId })).destructiveOperation;
  assert.deepEqual([after.state, after.executed], ['previewed', false]);
  assert.match(after.note, /may be starting/);
  assert.deepEqual(w.sends(), []);
});

test('CT-2: a token of another tool or an unknown token writes no note', async () => {
  const w = engineWorld();
  const t = tools(w);
  const preview = await t.call({ action: 'delete', host: PERSONAL, prefix: 'ZZC' });
  w.clock.advance(CONFIRM_MIN_AGE_MS);
  const other = tools(w, { tool: 'o11_environment' });
  let seen = null;
  w.onApi = async operation => { if (operation === 'ListApplications' && !seen) seen = fs.existsSync(marker(w, preview.operationId)); };
  const refused = await other.call({ action: 'delete', host: PERSONAL, confirmationToken: preview.confirmationToken, words: 'sim, apaga os 4 ZZC' });
  w.onApi = null;
  assert.equal(seen, false, 'no note for a preview of another tool');
  assert.ok(refused.problems?.some(p => p.code === 'PREVIEW_OTHER_TARGET'), JSON.stringify(refused).slice(0, 300));
  assert.deepEqual(w.sends(), []);
});
