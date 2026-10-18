// fix/a5-lows (R4-3, review C:\t\revisoes\odc-defaults-4 and -5): no node test of the checkout writes under the user's profile,
// whatever the calling shell exports. node --test runs each file in its own process; the harness is the first import of every
// test file, fixtures/isolated-profile.mjs, which points USERPROFILE, HOME, APPDATA, LOCALAPPDATA and ANVIL_AUTHORITY_DIR of the
// process (and of every child it starts) at a temporary profile. This guard fails when a test file does not start with it, and
// when a write root of the facade would still resolve under the REAL profile (the account's, read by
// scripts/release/profile-guard.mjs from os.userInfo and the registry, never from the environment). Reads only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import { realProfile } from '../../../../scripts/release/profile-guard.mjs';
import { userRoot } from '../release-layout.mjs';
import { debugStateBase } from '../debug-state-root.mjs';
import { destructiveRoot } from '../destructive-operations.mjs';
import { stateDir } from '../service-center/auth.mjs';
import { downloadRoots } from '../service-center/download-context.mjs';
import { defaultVendorCache } from '../prototype/vendor.mjs';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const fixture = path.join(checkout, 'platforms', 'odc', 'facade', 'tests', 'fixtures', 'isolated-profile.mjs');
// The node test files of the checkout (the suites npm test runs, the benchmark, the publisher, the release license); the
// frozen evaluation copies under docs/evidence are records, not suites.
const FOLDERS = ['tests', 'tests/bench', 'platforms/odc/facade/tests', 'platforms/odc/portal/tests', 'platforms/odc/tests', 'tools/benchmark', 'publisher/tests', 'scripts/release/license'];
const under = (file, folder) => { const r = path.relative(folder, file); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

test('every node test file imports the profile isolation first', () => {
  const missing = [];
  let count = 0;
  for (const folder of FOLDERS) {
    const dir = path.join(checkout, folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.test.mjs'))) {
      count++;
      const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, '');
      const first = /^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/m.exec(text);
      const resolved = first ? path.resolve(dir, first[1]) : null;
      if (resolved?.toLowerCase() !== fixture.toLowerCase()) missing.push(folder + '/' + name + (first ? ' (first import: ' + first[1] + ')' : ' (no import)'));
    }
  }
  assert.ok(count > 500, 'the guard found ' + count + ' test files: its folders moved');
  assert.deepEqual(missing, [], missing.length + ' test file(s) do not import the profile isolation first; add as their FIRST line: import \'<relative path>/platforms/odc/facade/tests/fixtures/isolated-profile.mjs\';');
});

test('the isolated profile is not the real one, and every write root of the facade resolves inside it', () => {
  const real = realProfile();
  for (const name of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ANVIL_AUTHORITY_DIR'])
    assert.ok(under(process.env[name], isolatedProfile), name + ' = ' + process.env[name] + ' is outside the isolated profile');
  assert.notEqual(path.resolve(process.env.USERPROFILE).toLowerCase(), path.resolve(real.home).toLowerCase());
  const roots = { userRoot: userRoot(), debugState: debugStateBase(), destructive: destructiveRoot(), serviceCenterState: stateDir(),
    serviceCenterDownloads: downloadRoots().root ?? downloadRoots(), prototypeVendor: defaultVendorCache() };
  for (const [name, root] of Object.entries(roots)) {
    assert.equal(typeof root, 'string', name);
    assert.ok(under(path.resolve(root), isolatedProfile), name + ' resolves to ' + root + ', outside the isolated profile');
    // the real %USERPROFILE%\.ssam*, .anvil and %LOCALAPPDATA% outside its Temp folder (where the temporary profile lives)
    const full = path.resolve(root);
    const hit = [real.ssamHybrid, real.ssam, real.anvil].find(f => under(full, f))
      ?? (under(full, real.localAppData) && !under(full, os.tmpdir()) && !under(full, path.join(real.localAppData, 'Temp')) ? real.localAppData : null);
    assert.equal(hit, null, name + ' resolves to ' + root + ', under the real profile (' + hit + ')');
  }
});
