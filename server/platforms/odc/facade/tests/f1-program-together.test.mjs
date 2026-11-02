// F1 (owner 2026-11-02, verbatim: "o ssam deve permitir que o usuario programe junto com ele.. ele deve ser capaz de fazer o
// merge e é isso"). The facade half of the hotfix: a holder task that already ended never makes the next delivery wait for
// its reservation (the kernel closes it, Delivery.Reserve); a write never sent closes without a recorded failure (production
// task c150… of 2026-11-02, killed during its capture, writeState not-sent, no error); the proof's notes and the closed
// holder reach the answer. Temporary folders only; no Studio, no kernel.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lineage from '../delivery-lineage.mjs';
import * as cycle from '../o11-cycle.mjs';

const folder = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-together-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('a holder that ended never makes the next delivery wait (holderEnded)', t => {
  const work = folder(t);
  const ended = lineage.holderEnded ?? (() => assert.fail('delivery-lineage.mjs has no holderEnded'));
  assert.equal(ended({ error: 'merge kept for review', writeState: 'applied', code: 'MERGE_CONTENT_MISMATCH' }), true);
  assert.equal(ended({ error: 'new TrueChange errors', writeState: 'applied', validation: { newErrors: 1 } }), true);
  assert.equal(ended({ closed: true, writeState: 'applied' }), true);
  assert.equal(ended({ error: 'x', writeState: 'not-applied' }), true);
  // 2a: a write never sent and no recorded failure, its run lease free (the run was killed during its capture).
  assert.equal(ended({ writeState: 'not-sent', work }), true);
  // Never: an uncertain write, a pending Studio call, an applied merge whose verification never ran, a task folder absent.
  assert.equal(ended({ error: 'x', writeState: 'unknown' }), false);
  assert.equal(ended({ error: 'x', writeState: 'intent' }), false);
  assert.equal(ended({ error: 'x', writeState: 'not-sent', pendingBridgeOperation: { operationId: 'o' } }), false);
  assert.equal(ended({ error: 'x', writeState: 'applied' }), false);
  assert.equal(ended({ writeState: 'not-sent', work: path.join(work, 'gone') }), false);
});

test('a not-sent task without a recorded failure is closable (closeState refused), production task c150…', t => {
  const work = folder(t);
  assert.equal(cycle.closeState({ taskId: 'c150ccf09d37423eaaedbb8f91daafac', writeState: 'not-sent', delivered: false, work }), 'refused');
  // a pending Studio call keeps it out of reach
  assert.equal(cycle.closeState({ writeState: 'not-sent', delivered: false, work, pendingBridgeOperation: { operationId: 'o' } }), 'unsettled');
  // an uncertain write never
  assert.equal(cycle.closeState({ writeState: 'unknown', error: 'x' }), 'uncertain');
});

test('the proof notes and the closed holder reach the delivery answer', () => {
  const fields = cycle.deliveryFields({ mergeNotes: ['3 editor-state value(s) (positions of flow nodes on the canvas) differ from the candidate'],
    previousClosed: { taskId: 'c150ccf09d37423eaaedbb8f91daafac', was: 'refused', note: 'closed with the module content as it is' } });
  assert.deepEqual(fields.mergeNotes, ['3 editor-state value(s) (positions of flow nodes on the canvas) differ from the candidate']);
  assert.equal(fields.previousClosed?.taskId, 'c150ccf09d37423eaaedbb8f91daafac');
});
