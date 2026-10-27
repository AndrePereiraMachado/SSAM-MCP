// R1 (plano 24/10): the correction chain of a write (authorization-context.mjs): a refused write recorded with the sha256 of
// its words, found again by the job it ran, its kernel taskId or an ancestor of the job, on the same module and lane only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordChainWrite, chainOrigin, problemSignature, sameSignature, CHAIN_FILE } from '../authorization-context.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), W = 'd'.repeat(64);
const TASK = '0123456789abcdef0123456789abcdef';
function journal(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('a refused write is found by its job, its taskId or an ancestor, on its module and lane; never without words', t => {
  const dir = journal(t);
  assert.equal(recordChainWrite(dir, { lane: 'o11', module: 'Orders CS', job: '/j/a.json', jobSha256: A, taskId: TASK, outcome: 'refused',
    authorization: { source: 'words', wordsSha256: W }, problems: ['X|/ops/0'] }), true);
  assert.equal(recordChainWrite(dir, { lane: 'o11', module: 'Orders', jobSha256: B, authorization: { source: 'words' } }), false, 'no words, no line');
  assert.equal(chainOrigin(dir, { sha256s: [A], module: 'orders_cs', lane: 'o11' }).authorization.wordsSha256, W, 'the module by letters and digits');
  assert.equal(chainOrigin(dir, { taskId: TASK.toUpperCase(), module: 'Orders CS' }).jobSha256, A);
  assert.equal(chainOrigin(dir, { sha256s: [C], module: 'Orders CS', ancestorsOf: h => (h === C ? [B, A] : []) }).jobSha256, A);
  assert.equal(chainOrigin(dir, { sha256s: [A], module: 'Billing' }), null, 'another module');
  assert.equal(chainOrigin(dir, { sha256s: [A], module: 'Orders CS', lane: 'odc' }), null, 'another lane');
  assert.equal(chainOrigin(dir, { sha256s: [A], module: 'Orders CS', outcomes: ['uncertain'] }), null);
  assert.equal(chainOrigin(dir, { sha256s: [A] }).module, 'Orders CS', 'no module named: the write\'s own');
  assert.equal(chainOrigin(dir, { sha256s: [B], module: 'Orders' }), null);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, CHAIN_FILE), 'utf8'), /"words":/, 'only the sha256 of the words');
});

test('the problems of a refusal as a multiset of code and pointer: grouped problems count each pointer', () => {
  const one = problemSignature([{ code: 'X', pointer: '/ops/1' }, { code: 'Y', pointers: ['/ops/0', '/ops/2'] }]);
  assert.deepEqual(one, ['X|/ops/1', 'Y|/ops/0', 'Y|/ops/2']);
  assert.ok(sameSignature(one, problemSignature([{ code: 'Y', items: [{ pointer: '/ops/2' }, { pointer: '/ops/0' }] }, { code: 'X', pointer: '/ops/1' }])));
  assert.ok(!sameSignature(one, problemSignature([{ code: 'X', pointer: '/ops/1' }])));
  assert.ok(!sameSignature([], []), 'no problems is never a repeat');
});
