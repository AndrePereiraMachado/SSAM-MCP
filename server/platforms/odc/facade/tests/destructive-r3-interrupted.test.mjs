import './fixtures/isolated-profile.mjs';
// CX15 r3 (CT-5, common part): the refusal of a token whose operation was interrupted (its process died) says that THIS
// call sent nothing and what the interrupted operation did, item by item (deleted, uncertain, not sent), and carries the
// record, so no lane can answer "nothing was reserved or sent" with deleted:[] after a crash that deleted A.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beginOperation, checkExecute, createPreview, markItem, readPreview } from '../destructive-operations.mjs';

const HOST = 'personal-0000r3int.outsystemscloud.com';
const T0 = Date.parse('2026-10-15T12:00:00Z');

test('CT-5: OPERATION_INTERRUPTED says this call sent nothing and names what the dead process deleted, left uncertain and never sent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r3-int-'));
  const items = ['ZZSynth Alpha', 'ZZSynth Beta', 'ZZSynth Gamma'].map((name, i) => ({ kind: 'application', key: 'k' + i, name }));
  const block = createPreview({ tool: 'o11_service_center_write', lane: 'o11', host: HOST, operation: 'delete', items, now: T0, root });
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const record = beginOperation({ preview: readPreview(block.previewId, { root }), now: T0 + 6000, root, pid: dead, words: 'synthetic reply one' });
  markItem(record, items[0], { state: 'deleted' }, { now: T0 + 7000, root });
  markItem(record, items[1], { state: 'sending' }, { now: T0 + 8000, root });
  const check = checkExecute({ token: block.confirmationToken, tool: 'o11_service_center_write', host: HOST, operation: 'delete', words: 'synthetic reply two for the 3', now: T0 + 60000, root });
  const p = check.problems.find(x => x.code === 'OPERATION_INTERRUPTED');
  assert.ok(p, JSON.stringify(check.problems.map(x => x.code)));
  assert.match(p.message, /This call sent nothing/);
  assert.match(p.message, /deleted ZZSynth Alpha/);
  assert.match(p.message, /ZZSynth Beta is uncertain/);
  assert.match(p.message, /ZZSynth Gamma was not sent/);
  assert.equal(check.operation?.operationId, block.operationId);
  assert.deepEqual(check.operation.items.map(i => i.state), ['deleted', 'uncertain', 'not-started']);
});
