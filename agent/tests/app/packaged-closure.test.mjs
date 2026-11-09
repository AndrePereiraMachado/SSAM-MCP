// scripts/build.mjs checkPackagedClosure: the packaged app.asar must hold package-lock.json's production closure where Node looks
// for it. Windows 0.2.8 shipped electron-updater without its dependencies ("Cannot find module 'fs-extra'" at start).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolvePackage, packagedClosureProblems, asarTree, checkPackagedClosure } from '../../scripts/build.mjs';

const appDir = path.resolve(import.meta.dirname, '..', '..');
const lock = JSON.parse(fs.readFileSync(path.join(appDir, 'package-lock.json'), 'utf8'));
const required = () => Object.entries(lock.packages).filter(([key, v]) => key.startsWith('node_modules/') && !v.dev && !v.optional);

// A packaged tree laid out like the lock, or hoisted the way electron-builder hoisted the Mac build A (electron-updater's semver
// at node_modules/semver).
function tree(layout) { return { has: key => key in layout, versionOf: key => layout[key] ?? null }; }
const asLock = () => Object.fromEntries(required().map(([key, v]) => [key, v.version]));
const hoisted = () => Object.fromEntries(required().map(([key, v]) => [key.replace(/^node_modules\/[^/]+\/node_modules\//, 'node_modules/'), v.version]));

test('resolvePackage walks up the node_modules folders like Node', () => {
  const has = key => ['node_modules/a', 'node_modules/a/node_modules/b', 'node_modules/@s/c', 'node_modules/@s/c/node_modules/d'].includes(key);
  assert.equal(resolvePackage(has, '', 'a'), 'node_modules/a');
  assert.equal(resolvePackage(has, 'node_modules/a', 'b'), 'node_modules/a/node_modules/b');
  assert.equal(resolvePackage(has, 'node_modules/a/node_modules/b', 'a'), 'node_modules/a');
  assert.equal(resolvePackage(has, 'node_modules/@s/c/node_modules/d', '@s/c'), 'node_modules/@s/c');
  assert.equal(resolvePackage(has, '', 'b'), null, 'a nested package is not visible from the root');
});

test('the closure of this package-lock.json passes laid out as the lock or hoisted, and fails without fs-extra or with another version', () => {
  assert.ok(required().length >= 10, 'electron-updater and its dependencies');
  assert.deepEqual(packagedClosureProblems(lock, tree(asLock())), []);
  assert.deepEqual(packagedClosureProblems(lock, tree(hoisted())), []);
  const broken = asLock(); delete broken['node_modules/fs-extra'];
  assert.deepEqual(packagedClosureProblems(lock, tree(broken)), [`node_modules/electron-updater needs fs-extra ${lock.packages['node_modules/fs-extra'].version}, which the app.asar does not have where Node looks`]);
  // What Windows 0.2.8 shipped: electron-updater alone.
  assert.ok(packagedClosureProblems(lock, tree({ 'node_modules/electron-updater': lock.packages['node_modules/electron-updater'].version })).length >= 5);
  assert.match(packagedClosureProblems(lock, tree({ ...asLock(), 'node_modules/fs-extra': '9.0.0' })).join(), /gets fs-extra 9\.0\.0 at node_modules\/fs-extra in the app\.asar, not /);
  assert.match(packagedClosureProblems(lock, tree({})).join(), /the app needs electron-updater/);
  assert.deepEqual(packagedClosureProblems({}, tree({})), ['package-lock.json has no "packages" (lockfile v2 or v3 needed)']);
});

test('optional dependencies may be absent; devDependencies never count', () => {
  const small = { packages: { '': { dependencies: { a: '1' }, optionalDependencies: { o: '1' }, devDependencies: { d: '1' } },
    'node_modules/a': { version: '1.0.0', dependencies: { b: '1' } }, 'node_modules/b': { version: '2.0.0' }, 'node_modules/o': { version: '1.0.0', optional: true }, 'node_modules/d': { version: '1.0.0', dev: true } } };
  assert.deepEqual(packagedClosureProblems(small, tree({ 'node_modules/a': '1.0.0', 'node_modules/b': '2.0.0' })), []);
  assert.deepEqual(packagedClosureProblems(small, tree({ 'node_modules/a': '1.0.0' })), ['node_modules/a needs b 2.0.0, which the app.asar does not have where Node looks']);
});

test('checkPackagedClosure reads real app.asar files under dist and stops the build on a missing dependency', t => {
  const asar = createRequire(import.meta.url)('@electron/asar');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-closure-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = async (layout, out) => {
    const src = fs.mkdtempSync(path.join(dir, 'src-'));
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'ssam-agent-app', version: '0.2.8' }));
    for (const [key, version] of Object.entries(layout)) { fs.mkdirSync(path.join(src, ...key.split('/')), { recursive: true }); fs.writeFileSync(path.join(src, ...key.split('/'), 'package.json'), JSON.stringify({ name: key.split('node_modules/').pop(), version })); }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await asar.createPackage(src, out);
  };
  return (async () => {
    const good = path.join(dir, 'dist-good'), bad = path.join(dir, 'dist-bad');
    await make(hoisted(), path.join(good, 'mac-arm64', 'SSAM Agent.app', 'Contents', 'Resources', 'app.asar'));
    assert.deepEqual(packagedClosureProblems(lock, asarTree(path.join(good, 'mac-arm64', 'SSAM Agent.app', 'Contents', 'Resources', 'app.asar'))), []);
    checkPackagedClosure(good, appDir);
    const broken = asLock(); delete broken['node_modules/fs-extra'];
    await make(broken, path.join(bad, 'win-unpacked', 'resources', 'app.asar'));
    assert.throws(() => checkPackagedClosure(bad, appDir), /win-unpacked[\\/]resources[\\/]app\.asar: node_modules\/electron-updater needs fs-extra/);
    fs.mkdirSync(path.join(dir, 'dist-empty'));
    assert.throws(() => checkPackagedClosure(path.join(dir, 'dist-empty'), appDir), /no app\.asar under/);
  })();
});

test('the closure check runs after electron-builder, before the platform checks', () => {
  const build = fs.readFileSync(path.join(appDir, 'scripts', 'build.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const run = build.indexOf('checkPackagedClosure(dist);'), win = build.indexOf("if (options.platform === 'win') checkWindowsOutput(dist, options);");
  assert.ok(run > build.indexOf("if (result.status !== 0) throw new Error('electron-builder failed") && run < win);
});
