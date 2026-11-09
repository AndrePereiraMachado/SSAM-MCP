// scripts/build.mjs checkPackagedClosure: the packaged app.asar must hold package-lock.json's production closure where Node looks
// for it. Windows 0.2.8 shipped electron-updater without its dependencies ("Cannot find module 'fs-extra'" at start).
// Review R4: each package found must also hold the file Node loads for it (packageEntries), not only its package.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolvePackage, packagedClosureProblems, packageEntries, asarTree, checkPackagedClosure } from '../../scripts/build.mjs';

const appDir = path.resolve(import.meta.dirname, '..', '..');
const lock = JSON.parse(fs.readFileSync(path.join(appDir, 'package-lock.json'), 'utf8'));
const required = () => Object.entries(lock.packages).filter(([key, v]) => key.startsWith('node_modules/') && !v.dev && !v.optional);

// A packaged tree laid out like the lock, or hoisted the way electron-builder hoisted the Mac build A (electron-updater's semver
// at node_modules/semver). layout: key -> version (a package.json with no main, so its entry is index.js, present) or the whole
// package.json (then only the files listed are there); files: the entry files present besides <key>/index.js of each package
// given by version (missing: those taken away).
function tree(layout, { files = [], missing = [] } = {}) {
  const manifest = key => typeof layout[key] === 'string' ? { version: layout[key] } : layout[key] ?? null;
  return {
    has: key => key in layout,
    manifestOf: manifest,
    hasFile: file => !missing.includes(file) && (files.includes(file) || Object.entries(layout).some(([key, value]) => typeof value === 'string' && file === key + '/index.js')),
  };
}
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

test('packageEntries gives the files Node loads for a package: exports for "." (require and import), else main, else index', () => {
  const index = ['index.js', 'index.json', 'index.node'];
  assert.deepEqual(packageEntries({ version: '1.0.0' }), [index]);
  assert.deepEqual(packageEntries(null), [index]);
  assert.deepEqual(packageEntries({ main: './lib/index.js' }), [['lib/index.js', 'lib/index.js.js', 'lib/index.js.json', 'lib/index.js.node', 'lib/index.js/index.js', 'lib/index.js/index.json', 'lib/index.js/index.node', ...index]]);
  assert.deepEqual(packageEntries({ main: './index' })[0].slice(0, 2), ['index', 'index.js'], 'ms: "./index"');
  assert.deepEqual(packageEntries({ main: 'lib/' })[0].slice(0, 5), ['lib', 'lib.js', 'lib.json', 'lib.node', 'lib/index.js']);
  // js-yaml 4.3.2: import and require differ, both must be there.
  assert.deepEqual(packageEntries({ main: 'ignored.js', exports: { '.': { import: './dist/js-yaml.mjs', require: './index.js' }, './package.json': './package.json' } }), [['index.js'], ['dist/js-yaml.mjs']]);
  assert.deepEqual(packageEntries({ exports: './x.js' }), [['x.js']]);
  assert.deepEqual(packageEntries({ exports: { node: { require: './n.cjs', default: './n.mjs' }, default: './d.js' } }), [['n.cjs'], ['n.mjs']]);
  assert.deepEqual(packageEntries({ exports: { '.': [{ worker: './w.js' }, './a.js'] } }), [['a.js']]);
  assert.deepEqual(packageEntries({ exports: { browser: './b.js', default: './d.js' } }), [['d.js']]);
  assert.deepEqual(packageEntries({ exports: { './sub': './sub.js' } }), [[]], 'no "." export: nothing can satisfy it');
  assert.deepEqual(packageEntries({ exports: { browser: './b.js' } }), [[]]);
});

test('a package found without the file Node loads for it is refused', () => {
  const fsExtra = 'node_modules/fs-extra';
  const real = { ...asLock(), [fsExtra]: { version: lock.packages[fsExtra].version, main: './lib/index.js' } };
  assert.deepEqual(packagedClosureProblems(lock, tree(real, { files: [fsExtra + '/lib/index.js'] })), []);
  assert.deepEqual(packagedClosureProblems(lock, tree(real)), [`${fsExtra} in the app.asar has no lib/index.js, the file Node loads for fs-extra`]);
  assert.deepEqual(packagedClosureProblems(lock, tree(asLock(), { missing: ['node_modules/electron-updater/index.js'] })), ['node_modules/electron-updater in the app.asar has no index.js, the file Node loads for electron-updater']);
  const yaml = Object.keys(asLock()).find(key => key.endsWith('/js-yaml'));
  const both = { ...asLock(), [yaml]: { version: asLock()[yaml], exports: { '.': { import: './dist/js-yaml.mjs', require: './index.js' } } } };
  assert.deepEqual(packagedClosureProblems(lock, tree(both, { files: [yaml + '/index.js', yaml + '/dist/js-yaml.mjs'] })), []);
  assert.deepEqual(packagedClosureProblems(lock, tree(both, { files: [yaml + '/index.js'] })), [`${yaml} in the app.asar has no dist/js-yaml.mjs, the file Node loads for js-yaml`]);
  assert.deepEqual(packagedClosureProblems(lock, tree(both, { files: [yaml + '/dist/js-yaml.mjs'] })), [`${yaml} in the app.asar has no index.js, the file Node loads for js-yaml`]);
  assert.deepEqual(packagedClosureProblems(lock, tree({ ...asLock(), [yaml]: { version: asLock()[yaml], exports: { './sub': './sub.js' } } })), [`${yaml} in the app.asar has no file its "exports" gives for ".", the file Node loads for js-yaml`]);
});

test('checkPackagedClosure reads real app.asar files under dist and stops the build on a missing dependency', t => {
  const asar = createRequire(import.meta.url)('@electron/asar');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-closure-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Each package: its package.json (main ./lib/main.js) and, unless noEntry names it, lib/main.js.
  const make = async (layout, out, noEntry = []) => {
    const src = fs.mkdtempSync(path.join(dir, 'src-'));
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'ssam-agent-app', version: '0.2.8' }));
    for (const [key, version] of Object.entries(layout)) {
      fs.mkdirSync(path.join(src, ...key.split('/'), 'lib'), { recursive: true });
      fs.writeFileSync(path.join(src, ...key.split('/'), 'package.json'), JSON.stringify({ name: key.split('node_modules/').pop(), version, main: './lib/main.js' }));
      if (!noEntry.includes(key)) fs.writeFileSync(path.join(src, ...key.split('/'), 'lib', 'main.js'), 'module.exports = {};\n');
    }
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
    // fs-extra's package.json is there, its lib/main.js is not (a lib folder with nothing in it is no entry file).
    const noEntry = path.join(dir, 'dist-noentry');
    await make(asLock(), path.join(noEntry, 'win-unpacked', 'resources', 'app.asar'), ['node_modules/fs-extra']);
    assert.throws(() => checkPackagedClosure(noEntry, appDir), /app\.asar: node_modules\/fs-extra in the app\.asar has no lib\/main\.js, the file Node loads for fs-extra/);
    fs.mkdirSync(path.join(dir, 'dist-empty'));
    assert.throws(() => checkPackagedClosure(path.join(dir, 'dist-empty'), appDir), /no app\.asar under/);
  })();
});

test('the closure check runs after electron-builder, before the platform checks', () => {
  const build = fs.readFileSync(path.join(appDir, 'scripts', 'build.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const run = build.indexOf('checkPackagedClosure(dist);'), win = build.indexOf("if (options.platform === 'win') checkWindowsOutput(dist, options);");
  assert.ok(run > build.indexOf("if (result.status !== 0) throw new Error('electron-builder failed") && run < win);
});
