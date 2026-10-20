// Owner rule of 2026-10-15 ("every text SSAM emits is English only"): the app's sources (shipped in the asar), the
// panel, the build configuration and the customer guide of the app show the licensee no Portuguese
// (agent/tests/fixtures/portuguese.mjs says what counts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { portugueseIn } from '../../agent/tests/fixtures/portuguese.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const box = path.resolve(app, '..');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

test('the app sources, the panel, the build configuration and the customer guide are English only', () => {
  const files = [...walk(path.join(app, 'src')), ...walk(path.join(app, 'ui')), ...walk(path.join(app, 'scripts')), path.join(app, 'electron-builder.yml'), path.join(app, 'package.json'),
    path.join(box, 'docs', 'AGENTE-APP.md')].filter(file => /\.(mjs|cjs|js|html|css|yml|json|md)$/.test(file));
  assert.ok(files.length > 15);
  const findings = [];
  for (const file of files) {
    for (const finding of portugueseIn(fs.readFileSync(file, 'utf8'))) findings.push(`${path.relative(box, file)}:${finding.line} "${finding.token}" in: ${finding.text}`);
  }
  assert.deepEqual(findings, []);
});
