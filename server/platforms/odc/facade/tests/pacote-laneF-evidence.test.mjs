import './fixtures/isolated-profile.mjs';
// Lane F of the 2026-10-05 package (docs/PACOTE-SESSOES-NOVO.md): ssam_evidence reads the headless debugger's own
// receipts (C05 1: <workspace>/.local/debugger is a root; session dd2b79c0 got OUTSIDE_ROOTS for the receipt ssam_debug
// had just returned) and a where clause with only the field (C21: "error" = exists and not false/null/empty,
// "!error" = the others; it was BAD_WHERE). Synthetic files in a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEvidenceReader, evidenceRoots } from '../ssam-evidence.mjs';
import { workspaceRoot } from '../workspace.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-laneF-evidence-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; };
const workspace = path.join(tmp, 'workspace'), kernel = path.join(workspace, 'kernel'), odc = path.join(workspace, 'platforms', 'odc');
const roots = evidenceRoots({ anvil: kernel, odc, workspace });
const read = input => createEvidenceReader({ roots }).read(input);

test('ssam_evidence reads a receipt the debugger wrote under <workspace>/.local/debugger', () => {
  assert.ok(evidenceRoots().map(r => path.resolve(r)).includes(path.resolve(workspaceRoot, '.local', 'debugger')), 'the installation roots include the debugger folder');
  const receipt = put(path.join(workspace, '.local', 'debugger', 'b70f54df944b4359bf161c2d635b66c1', 'receipt.json'),
    { ok: false, sessionId: 'b70f54df944b4359bf161c2d635b66c1', lane: 'o11', state: 'stopped', error: 'debug_start_failed_or_uncertain', events: [{ kind: 'stopped' }] });
  const answer = read({ file: receipt, select: ['state', 'error'] });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.values, { state: 'stopped', error: 'debug_start_failed_or_uncertain' });
  // Only the folders an answer names (debugger, preview, friction, module-index since the 2026-10-06 package, A21): the
  // rest of the workspace .local stays outside.
  const other = put(path.join(workspace, '.local', 'scratch', 'events.json'), { note: 'not evidence of a tool' });
  assert.equal(read({ file: other }).code, 'OUTSIDE_ROOTS');
});

test('a where clause with only the field keeps the items where it exists and is not empty; "!field" the others', () => {
  const file = put(path.join(kernel, '.local', 'work', 'deliver', 't1', 'result.json'), { items: [
    { name: 'a', error: 'boom' }, { name: 'b', error: null }, { name: 'c' }, { name: 'd', error: '' }, { name: 'e', error: false },
    { name: 'f', error: { code: 'X' } }, { name: 'g', error: [] }, { name: 'h', error: 0 },
  ] });
  const failed = read({ file, pointer: '/items', where: 'error', fields: ['name'] });
  assert.equal(failed.ok, true, JSON.stringify(failed));
  assert.deepEqual(failed.items.map(i => i.name), ['a', 'f', 'h']);
  const clean = read({ file, pointer: '/items', where: '!error', fields: ['name'] });
  assert.deepEqual(clean.items.map(i => i.name), ['b', 'c', 'd', 'e', 'g']);
  // A bare field combines with the other clauses, and a dotted path or a JSON Pointer works the same.
  assert.deepEqual(read({ file, pointer: '/items', where: ['error', 'name!=a'], fields: ['name'] }).items.map(i => i.name), ['f', 'h']);
  assert.deepEqual(read({ file, pointer: '/items', where: '/error/code', fields: ['name'] }).items.map(i => i.name), ['f']);
  // Text with spaces and no operator is still refused, with the grammar and a clause built from the rows (C29, atritos 3:
  // EVIDENCE_FILTER_INVALID, it was BAD_WHERE).
  const refused = read({ file, pointer: '/items', where: 'error Invalid' });
  assert.equal(refused.code, 'EVIDENCE_FILTER_INVALID');
  assert.match(refused.grammar, /bare field/);
  assert.equal(refused.continuation.arguments.where, 'name~a');
});
