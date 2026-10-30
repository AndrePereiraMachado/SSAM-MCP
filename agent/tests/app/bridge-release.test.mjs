import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const source = process.env.SSAM_REVIEW_BASE ? path.join(process.env.SSAM_REVIEW_BASE, 'agent') : path.resolve(import.meta.dirname, '../..');
test('R5.2 Windows app builds require --native before preparing any pack', () => {
  const result = spawnSync(process.execPath, [path.join(source, 'scripts/build.mjs'), '--platform', 'win', '--pack-only', '--no-updates'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /Windows app builds require --native/);
});
test('R5.3 release qualification documents offline roots and clean Windows VM', () => {
  const doc = fs.readFileSync(path.join(source, 'docs/AUTO-BRIDGES.md'), 'utf8');
  assert.match(doc, /CA root already trusted on every target machine/); assert.match(doc, /offline and uses the local certificate cache/); assert.match(doc, /clean Windows VM with the real owner certificate/);
});
