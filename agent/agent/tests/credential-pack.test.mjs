import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('pack scanner permits only exact public identity hosts and records the exception', { skip: process.platform !== 'win32' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'r40-identity-scan-'));
  const entries = new Map([
    ['public-community.txt', 'https://os-community-id.outsystems.app/'],
    ['public-id.txt', 'https://id.outsystems.dev/'],
    ['prefixed.txt', 'https://tenant.id.outsystems.dev/'],
    ['suffixed.txt', 'https://id.outsystems.dev.evil.example/'],
    ['community-suffixed.txt', 'https://os-community-id.outsystems.app.evil.example/'],
    ['lookalike.txt', 'https://os-communlty-id.outsystems.app/'],
    ['tenant.txt', 'https://test-customer.outsystems.dev/'],
    ['utf16-tenant.txt', Buffer.from('https://test-customer.outsystems.dev/', 'utf16le')],
  ]);
  const files = path.join(work, 'files'); fs.mkdirSync(files);
  for (const [name, body] of entries) fs.writeFileSync(path.join(files, name), body);
  const zip = path.join(work, 'test.zip'), script = path.join(work, 'zip.ps1');
  const literal = text => "'" + text.replaceAll("'", "''") + "'";
  fs.writeFileSync(script, `Add-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::CreateFromDirectory(${literal(files)},${literal(zip)})\n`);
  const packed = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr);
  const scan = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/pack-ip-scan.ps1'), '-Zip', zip], { encoding: 'utf8', windowsHide: true });
  assert.equal(scan.status, 1, scan.stderr);
  const report = JSON.parse(scan.stdout);
  for (const [name] of entries) {
    const found = report.findings.filter(item => item.entry === name && item.rule === 'customer-pattern');
    if (name.startsWith('public-')) {
      assert.equal(found.length, 0, name);
      assert.ok(report.allowed.some(item => item.entry === name && item.rule === 'public-identity-host' && item.why), name + ' carries an explicit note');
    } else assert.ok(found.length > 0, name + ' remains blocked');
  }
});
