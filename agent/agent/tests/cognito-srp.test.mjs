import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
test('Windows SRP helper validates proofs, tokens and callbacks without password replay', { skip: process.platform !== 'win32' }, () => {
  const output = execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./fixtures/cognito-srp-flow.ps1', import.meta.url)), '-Library', fileURLToPath(new URL('../lib/', import.meta.url))], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const cases = JSON.parse(output.trim());
  assert.equal(cases.length, 6); assert.ok(cases.every(c => c.passed));
  assert.ok(!output.includes('synthetic-password'));
});
