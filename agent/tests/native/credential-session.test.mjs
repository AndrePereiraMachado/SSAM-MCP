import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { credentialRows } from '../../agent/tests/fixtures/credential-table.mjs';
import { validateCredentialRequest } from '../../agent/lib/credential-session.mjs';

test('native credential validation matches every Node request-table row', () => {
  const exe = process.env.SSAM_NATIVE_EXE;
  assert.ok(exe && fs.existsSync(exe), 'SSAM_NATIVE_EXE must name the already-built native executable; this test never invokes dotnet');
  const rows = credentialRows();
  const run = spawnSync(exe, ['check-credential-request'], { input: JSON.stringify(rows.map(row => row.request)), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  const native = JSON.parse(run.stdout);
  assert.equal(native.length, rows.length);
  for (let i = 0; i < rows.length; i++) {
    let node;
    try { validateCredentialRequest(rows[i].request); node = { ok: true }; } catch (error) { node = { error: error.code }; }
    assert.deepEqual(node, rows[i].expected, rows[i].name + ' Node');
    assert.deepEqual(native[i], node, rows[i].name + ' native');
  }
});
