// fix/a5-lows M1 (review C:\t\revisoes\a5-lows): the profile isolation moves USERPROFILE, HOME, APPDATA and LOCALAPPDATA,
// so a test that READS a tool or recorded data installed in the real profile must build that path from the profile the
// process started with. The fixture's read-path helpers resolve there; writes stay in the temporary profile; the kernel
// CLI children read the ODC Studio caches of the original profile; the home folder keeps its name. Synthetic paths only,
// and nothing here writes outside os.tmpdir().
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as isolation from './fixtures/isolated-profile.mjs';

const fixture = fileURLToPath(new URL('./fixtures/isolated-profile.mjs', import.meta.url));
const same = (a, b) => assert.equal(path.resolve(a).toLowerCase(), path.resolve(b).toLowerCase());
const inside = (file, dir) => { const r = path.relative(dir, file); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };

// The fixture as a fresh process sees it, from a parent environment this test controls (a synthetic start profile).
function fresh(env, script) {
  const code = `import(${JSON.stringify(pathToFileURL(fixture).href)}).then(async m => { ${script} })`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', windowsHide: true }));
}
function syntheticProfile(t) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-read-paths-'));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const home = path.join(top, 'synthetic-user');
  const local = path.join(home, 'AppData', 'Local');
  const env = { ...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, APPDATA: path.join(home, 'AppData', 'Roaming'),
    TEMP: top, TMP: top };
  delete env.ANVIL_ODC_FEATURES_DIR; delete env.ANVIL_ODC_PLUGINS_DIR;
  return { top, home, local, env };
}

test('the read-path helpers resolve under the profile the process started with, not the temporary one', t => {
  assert.equal(typeof isolation.profileReadPath, 'function', 'the fixture exports profileReadPath');
  assert.equal(typeof isolation.localAppDataReadPath, 'function', 'the fixture exports localAppDataReadPath');
  const p = syntheticProfile(t);
  const seen = fresh(p.env, `process.stdout.write(JSON.stringify({ read: m.profileReadPath('.codex', 'sessions'),
    local: m.localAppDataReadPath('OutSystems', 'ODC Studio'), original: m.originalProfile, isolated: m.isolatedProfile,
    home: process.env.USERPROFILE, osHome: (await import('node:os')).default.homedir() }))`);
  same(seen.read, path.join(p.home, '.codex', 'sessions'));
  same(seen.local, path.join(p.local, 'OutSystems', 'ODC Studio'));
  same(seen.original.home, p.home);
  same(seen.original.localAppData, p.local);
  // Writes stay isolated: the variables and os.homedir() name the temporary profile, never the start profile.
  assert.ok(inside(seen.home, seen.isolated), 'USERPROFILE is the temporary profile');
  assert.ok(inside(seen.osHome, seen.isolated), 'os.homedir() is the temporary profile');
  assert.ok(!inside(seen.osHome, p.home) && path.resolve(seen.osHome) !== path.resolve(p.home));
});

test('the temporary home keeps the name of the start profile folder (the user segment the code derives from it)', t => {
  const p = syntheticProfile(t);
  const seen = fresh(p.env, `process.stdout.write(JSON.stringify({ home: process.env.USERPROFILE }))`);
  assert.equal(path.basename(seen.home), 'synthetic-user');
  // In this process too: the folder name is the start profile's.
  assert.equal(path.basename(os.homedir()), path.basename(isolation.originalProfile.home));
});

test('the kernel CLI children read the ODC Studio caches of the start profile; a variable the shell set is kept', t => {
  const p = syntheticProfile(t);
  const none = fresh(p.env, `process.stdout.write(JSON.stringify({ f: process.env.ANVIL_ODC_FEATURES_DIR ?? null, p: process.env.ANVIL_ODC_PLUGINS_DIR ?? null }))`);
  assert.deepEqual(none, { f: null, p: null }, 'no cache folder in the start profile: nothing is pinned (the kernel reports its absence as before)');
  const features = path.join(p.local, 'OutSystems', 'ODC Studio'), plugins = path.join(features, 'Plugins');
  fs.mkdirSync(plugins, { recursive: true });
  const pinned = fresh(p.env, `process.stdout.write(JSON.stringify({ f: process.env.ANVIL_ODC_FEATURES_DIR, p: process.env.ANVIL_ODC_PLUGINS_DIR, s: process.env.ANVIL_STUDIO_DIR ?? null }))`);
  same(pinned.f, features);
  same(pinned.p, plugins);
  const kept = fresh({ ...p.env, ANVIL_ODC_FEATURES_DIR: path.join(p.top, 'shell-features'), ANVIL_STUDIO_DIR: path.join(p.top, 'shell-studio') },
    `process.stdout.write(JSON.stringify({ f: process.env.ANVIL_ODC_FEATURES_DIR, s: process.env.ANVIL_STUDIO_DIR }))`);
  same(kept.f, path.join(p.top, 'shell-features'));
  same(kept.s, path.join(p.top, 'shell-studio'));
  assert.equal(pinned.s, process.env.ANVIL_STUDIO_DIR ?? null, 'ANVIL_STUDIO_DIR is never pinned (the facade ranks it above the installed Studio)');
});

// The family, not the known cases: no node test file of the checkout builds the path of a tool or recorded data installed in
// the profile (the Codex runtime and transcripts, Claude projects, the ODC and Service Studio folders, the NuGet cache) from
// os.homedir() or the moved variables. Such a line reads the temporary profile and skips or fails with a false reason.
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FOLDERS = ['tests', 'tests/bench', 'platforms/odc/facade/tests', 'platforms/odc/portal/tests', 'platforms/odc/tests', 'tools/benchmark', 'publisher/tests', 'scripts/release/license'];
const MOVED = /\bos\.homedir\(\)|\bhomedir\(\)|process\.env\.(?:USERPROFILE|HOME|LOCALAPPDATA|APPDATA)\b(?!\s*=[^=])/;
const INSTALLED = /codex-runtimes|['"`/\\]\.codex\b|['"`/\\]\.claude\b|ODC Studio|Service Studio|['"`/\\]\.nuget\b/;
// The fallback idiom of a read: the variable, else the home folder (setup-dev's Codex Node and Python before M1).
const FALLBACK = /\?\?\s*os\.homedir\(\)/;
test('no test file reads an installed tool or recorded data through the temporary profile', () => {
  const offenders = [];
  for (const folder of FOLDERS) {
    const dir = path.join(checkout, folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.test.mjs') && n !== path.basename(fileURLToPath(import.meta.url)))) {
      fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (MOVED.test(line) && (INSTALLED.test(line) || FALLBACK.test(line))) offenders.push(`${folder}/${name}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], 'build these read paths with profileReadPath / localAppDataReadPath (fixtures/isolated-profile.mjs): ' + offenders.join(', '));
});