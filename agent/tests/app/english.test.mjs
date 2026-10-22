// Owner rule of 2026-10-15 ("every text SSAM emits is English only"): the app's sources (shipped in the asar), the
// panel, the app's scripts, the build configuration and the customer guide of the app show the licensee no Portuguese
// (agent/tests/fixtures/portuguese.mjs says what counts). The box's other scripts (agent-pack.ps1 and friends) are the
// owner's and stay out of this scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { portugueseIn } from '../../agent/tests/fixtures/portuguese.mjs';

const box = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
const APP_SCRIPTS = ['build.mjs', 'zip.mjs', 'verify-pack.mjs', 'make-icons.mjs'];

test('the app sources, the panel, the app scripts, the build configuration and the customer guide are English only', () => {
  // src/: the main process, the preload and the React panel (src/renderer).
  const files = [...walk(path.join(box, 'src')), ...APP_SCRIPTS.map(name => path.join(box, 'scripts', name)), path.join(box, 'electron.vite.config.mjs'),
    path.join(box, 'electron-builder.yml'), path.join(box, 'package.json'), path.join(box, 'docs', 'AGENTE-APP.md')].filter(file => /\.(mjs|cjs|js|jsx|html|css|yml|json|md)$/.test(file));
  assert.ok(files.length > 15);
  const findings = [];
  for (const file of files) {
    for (const finding of portugueseIn(fs.readFileSync(file, 'utf8'))) findings.push(`${path.relative(box, file)}:${finding.line} "${finding.token}" in: ${finding.text}`);
  }
  assert.deepEqual(findings, []);
});
