import './fixtures/isolated-profile.mjs';
// CX15 r5 (N-3): the debugger's authorization files kept the user's words in clear and nothing deletes them: the four
// runners (O11 mount, ODC mount, BPT background, Run Now: authorization.json, background-authorization.json,
// run-now-authorization.json) and four writers of the same kind found by reading (debug-invoke-runtime authorization.json,
// the O11 wrapper grant of debug-o11-run, the O11 lifecycle authorization.json, the ODC wrapper grant of debug-run, which
// also answered the words). Now each keeps wordsSha256 (and authorizationSha256 stays the sha of the file); the readers
// (lifecycle, final matrix, neutralization, republish reconcile) accept it. (1) the family in the source; (2) the O11
// wrapper grant -> run -> removal flow with a marker in the words: the grant, the run's authorization.json, the receipts
// and the answers keep no words, and the run still works. The fixture is the one of debug-o11-run.test.mjs. Synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { o11WrapperFixture as fixture, target, action } from './fixtures/destructive-r5-o11-wrapper.mjs';
import { o11Read } from '../debug-o11-lifecycle.mjs';
import { MARK, count, filesWithMark, filesUnder } from './fixtures/destructive-r4-marker.mjs';

// The 8 of the review, and 2 more the scan below found (debug-odc-workflow-run.mjs receipt, portal timer-background.mjs).
const WRITERS = ['debug-o11-native-mount-run.mjs', 'debug-odc-native-mount-run.mjs', 'debug-o11-bpt-run.mjs', 'debug-o11-runnow-interactive.mjs',
  'debug-invoke-runtime.mjs', 'debug-o11-run.mjs', 'debug-o11-lifecycle.mjs', 'debug-run.mjs', 'debug-odc-workflow-run.mjs', 'timer-background.mjs'];
test('N-3 (the family, in the source): no debugger writer keeps the words in a file; each keeps wordsSha256', () => {
  const dir = path.join(import.meta.dirname, '..'), runtime = path.join(dir, '..', 'portal', 'runtime');
  const hits = [], hashed = [];
  const files = [...fs.readdirSync(dir).filter(f => /^debug-.*\.mjs$/.test(f)).map(f => path.join(dir, f)), ...fs.readdirSync(runtime).filter(f => /^(timer-|debug-).*\.mjs$/.test(f)).map(f => path.join(runtime, f))];
  for (const file of files) {
    const f = path.basename(file), src = fs.readFileSync(file, 'utf8');
    // words: <the call's words> as a property of a record (input.words, input.authorization, authorization.words, or the
    // shorthand { words, ... } of a grant).
    for (const m of src.matchAll(/\bwords\s*:\s*(input\.words|input\.authorization|authorization\.words|authorizationWords|raw\.words)\b|\{\s*words\s*,\s*grantedAt/g)) hits.push(f + ': ' + m[0]);
    if (WRITERS.includes(f) && /wordsSha256\s*:/.test(src)) hashed.push(f);
  }
  // Declared (CX15 r5): the one path that needs the words themselves is the Service Center timer-run that
  // debug-native-background.mjs calls in memory (its gate checks the words); it writes no file with them, and the engine's
  // receipt keeps only wordsSha256 (service-center/client.mjs, authorization.wordsSha256).
  const NEEDS_WORDS_IN_MEMORY = ['debug-native-background.mjs: words: authorizationWords'];
  assert.deepEqual(hits.filter(h => !NEEDS_WORDS_IN_MEMORY.includes(h)), []);
  assert.deepEqual(hashed.sort(), [...WRITERS].sort(), 'every writer keeps wordsSha256');
});


test('N-3 (O11 wrapper): the grant, the run authorization and the receipts keep wordsSha256, never the words; the run still works', async t => {
  const f = fixture(t);
  const words = 'Publish and remove the debug wrapper ' + MARK;
  const granted = await f.runner({ ...target, op: 'authorize', words });
  assert.equal(count(JSON.stringify(granted)), 0, 'the authorize answer has no words');
  const grant = o11Read(path.join(f.root, '.local', 'debugger', 'wrappers', 'o11', target.host, target.moduleKey + '.authorization.json'));
  assert.equal(grant.words, undefined);
  assert.equal(grant.wordsSha256, createHash('sha256').update(words).digest('hex'));
  const result = await f.runner({ ...target, op: 'run', action: action.name });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300)); assert.equal(result.wrapper.state, 'removed');
  assert.equal(count(JSON.stringify(result)), 0, 'the run answer has no words');
  // (the fixture's lifecycle is a fake: the lifecycle's own authorization.json is covered by the source scan above)
  const auths = filesUnder(f.root).filter(p => path.basename(p) === 'authorization.json');
  for (const p of auths) assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).wordsSha256, grant.wordsSha256);
  assert.deepEqual(filesWithMark([f.root, process.env.USERPROFILE]), [], 'no file keeps the words');
});
