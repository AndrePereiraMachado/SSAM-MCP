// R1 item 2 (2026-10-28): a recipe whose file the installation does not have, or cannot read, never brings the search
// down; it is skipped and named after the recipes found ({name, path, skipped}). The O11 lane answers from the CLI
// (CommandSurface.Recipes, ReferenceMissingFileTests.cs); the ODC lane answers here, from tests/jobs-odc.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSsamReference, odcRecipe } from '../ssam-reference.mjs';

function suite(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-recipe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'tests', 'jobs-odc'); fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name + '.json'), text);
  return root;
}

test('an ODC recipe file that cannot be read is skipped and named, and the search still answers', t => {
  const root = suite(t, {
    'r1-timer-present': JSON.stringify({ description: 'A timer that runs a nightly action', ops: [{ op: 'spec', data: { ddl: 'timer Nightly action Run schedule "When Published"' } }] }),
    'r1-timer-broken': '{ "description": ',
  });
  const found = odcRecipe(root, 'timer nightly');
  assert.ok(Array.isArray(found), JSON.stringify(found));
  assert.deepEqual(found.filter(r => !r.skipped).map(r => r.name), ['r1-timer-present']);
  const skipped = found.filter(r => r.skipped);
  assert.deepEqual(skipped.map(r => r.name), ['r1-timer-broken']);
  assert.equal(skipped[0].path, 'tests/jobs-odc/r1-timer-broken.json');
  assert.match(skipped[0].skipped, /not valid JSON/);
  assert.ok(!JSON.stringify(found).includes(path.basename(root)), 'no folder of the installation in the answer');
  // A query that names another job exactly answers that job alone.
  assert.deepEqual(odcRecipe(root, 'r1-timer-present').map(r => r.name), ['r1-timer-present']);
});

import { linked } from './fixtures/o11env-kernel.mjs';
test('the ODC recipe count excludes unreadable entries', async t => {
  const root = suite(t, {
    'nightly-valid': JSON.stringify({ description: 'nightly task', ops: [] }),
    'nightly-broken': '{',
  });
  const mcp = await linked(registerSsamReference, { root });
  t.after(() => mcp.close());
  const answer = await mcp.call('ssam_reference', { lane: 'odc', kind: 'recipe', query: 'nightly' });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.data.count, 1, JSON.stringify(answer));
  assert.equal(answer.data.definitions.filter(entry => entry.skipped).length, 1);
});
