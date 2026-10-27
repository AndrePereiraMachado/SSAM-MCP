// L3a: the native probes of the discover in ONE CLI process per lane (`api --op native --types`, NativeProbe.cs) instead of
// one cold process per type. Each type answers exactly what its own `--type` process answers (20 types per lane, among
// them the ones only a model plugin defines and short names several assemblies share, compared byte for byte); the index
// and the discover answers built from the batch are the ones the process-per-type path builds (20 intents per lane);
// a CLI without `--types` (an older build) or a type the batch failed falls back to its own process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Every CLI process the code under test starts, counted before discovery.mjs binds execFile (it promisifies it once).
const launched = [];
const execFile = cp.execFile;
const note = args => { if (Array.isArray(args) && /anvil(-odc)?\.dll$/i.test(args[0] ?? '')) launched.push(args.slice(1)); };
cp.execFile = function (file, args, ...rest) { note(args); return execFile.call(this, file, args, ...rest); };
cp.execFile[promisify.custom] = (file, args, ...rest) => { note(args); return execFile[promisify.custom](file, args, ...rest); };
syncBuiltinESMExports();
const { buildIndex, laneSources, nativeBatch, nativeCacheKey } = await import('../discovery.mjs');
const { discoverAll } = await import('../tool-routing.mjs');
const { snapshotSources } = await import('./fixtures/discovery-results.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const INTENTS = Object.values(JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'text-routes-phrases.json'), 'utf8')).routes).flat().map(p => p.intent).slice(0, 20);
// First the names a fresh process does NOT find among the assemblies it starts with (an unknown one, the REST plugin
// types): they make it load the model plugins, so a batch that looked the later types up among what it loaded by then
// would answer them differently. Then short names several assemblies share, a name without the I, and the lane's own.
const LEADING = ['INoSuchNativeType', 'ServiceStudio.Plugin.REST.IRestAction', 'ServiceStudio.Plugin.RESTService.IRestService', 'IRestStructure', 'IImage', 'IForm', 'ILabel', 'IEntity', 'StaticEntity',
  'ServiceStudio.Plugin.NRWidgets.IButton', 'OutSystems.Model.Data.IStaticEntity', 'OutSystems.Model.Logic.IServerAction', 'OutSystems.Model.IExtendedProperty', 'OutSystems.Model.Processes.ITimer'];
const TYPES = {
  odc: [...LEADING, 'OutSystems.Model.Logic.Nodes.IAggregateNode', 'OutSystems.Model.Logic.Aggregates.IAggregatedAttribute', 'OutSystems.Model.UI.Mobile.IMobileScreen', 'OutSystems.Model.UI.Mobile.Widgets.IIfWidget', 'OutSystems.Model.Logic.IAgent', 'OutSystems.Model.Data.ISiteProperty'],
  o11: [...LEADING, 'ServiceStudio.Plugin.Widgets.IEditableTable', 'OutSystems.Model.UI.Web.IWebScreen', 'OutSystems.Model.UI.Web.Widgets.ITableRecordsWidget', 'OutSystems.Model.Logic.Aggregates.IAggregateAttribute', 'OutSystems.Model.Processes.IProcess', 'ServiceStudio.Model.EntityIndex'],
};
const cliRun = (sources, args) => run(sources.dotnet ?? 'dotnet', [sources.cli, ...args], { windowsHide: true, maxBuffer: 256 * 1024 * 1024, cwd: sources.kernel, env: sources.env });
const privateSources = lane => {
  const live = laneSources(lane, { studio: { connection: () => null } });
  return snapshotSources(lane, { studioDir: live.studioDir, env: live.env, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), `ssam-native-batch-${lane}-`)) });
};
// The clock stands still while an index is built and answered from (apiMs, buildMs, elapsedMs); builtAt is the one
// wall-clock value two builds never share, so it is the only thing normalized.
async function frozen(run) {
  const now = performance.now;
  performance.now = () => 0;
  try { return await run(); } finally { performance.now = now; }
}
const withEnv = async (name, value, run) => {
  const before = process.env[name]; process.env[name] = value;
  try { return await run(); } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
};

for (const lane of ['odc', 'o11']) {
  const cliBuilt = fs.existsSync(laneSources(lane).cli);
  test(`${lane}: --types answers each of ${TYPES[lane].length} types byte for byte as its own --type process`, { skip: !cliBuilt && `the ${lane} CLI is not built`, timeout: 900000 }, async t => {
    const sources = privateSources(lane);
    try {
      const types = TYPES[lane];
      assert.equal(types.length, 20);
      let started = performance.now();
      const batch = JSON.parse((await cliRun(sources, ['api', '--op', 'native', '--types', types.join(',')])).stdout);
      const batchMs = performance.now() - started;
      assert.equal(batch.ok, true); assert.equal(batch.data.types, types.length);
      assert.deepEqual(Object.keys(batch.data.results), types);
      started = performance.now();
      const single = {}; const queue = [...types];
      await Promise.all([0, 1, 2].map(async () => { while (queue.length) { const type = queue.shift(); single[type] = JSON.parse((await cliRun(sources, ['api', '--op', 'native', '--type', type])).stdout); } }));
      const singleMs = performance.now() - started;
      const differ = types.filter(type => single[type].ok !== true || batch.data.results[type].ok !== true
        || JSON.stringify(single[type].data) !== JSON.stringify(batch.data.results[type].data));
      assert.deepEqual(differ, []);
      // The comparison covers what the probes found: plugin types, a short name with several candidates, an unknown name.
      const answer = type => batch.data.results[type].data;
      assert.equal(answer('INoSuchNativeType').candidates.length, 0);
      assert.equal(answer('ServiceStudio.Plugin.REST.IRestAction').candidates[0].assembly.file, `${lane === 'odc' ? 'OutSystems.Model' : 'ServiceStudio'}.Plugin.REST.dll`);
      assert.ok(types.some(type => answer(type).candidates.length > 1), 'a short name shared by several assemblies');
      t.diagnostic(`${lane}: ${types.length} types, one batch process ${Math.round(batchMs)} ms, a process per type (3 at a time) ${Math.round(singleMs)} ms`);
    } finally { fs.rmSync(sources.cacheDir, { recursive: true, force: true }); }
  });

  test(`${lane}: the index and ${INTENTS.length} discover answers built from the batch are the process-per-type ones`, { skip: !cliBuilt && `the ${lane} CLI is not built`, timeout: 900000 }, async t => {
    const batched = privateSources(lane); const single = privateSources(lane);
    try {
      launched.length = 0;
      let started = performance.now();
      const a = await frozen(() => buildIndex(lane, { sources: batched }));
      const batchedMs = performance.now() - started;
      const natives = launched.filter(args => args[0] === 'api' && args[2] === 'native');
      assert.equal(natives.length, 1, 'one CLI process probes every native type');
      assert.equal(natives[0][3], '--types');
      launched.length = 0;
      started = performance.now();
      const b = await withEnv('SSAM_DISCOVERY_NATIVE_BATCH', '0', () => frozen(() => buildIndex(lane, { sources: single })));
      const singleMs = performance.now() - started;
      assert.equal(launched.filter(args => args[0] === 'api' && args[2] === 'native').length, b.index.identity.nativeRuntime.probes.probed);
      // The same identity, the same native answers file byte for byte, the same index but for the build time.
      assert.equal(a.index.key, b.index.key);
      const nativeFile = dir => path.join(dir, `native-${nativeCacheKey(batched)}.json`);
      assert.equal(nativeCacheKey(batched), nativeCacheKey(single));
      assert.equal(fs.readFileSync(nativeFile(batched.cacheDir), 'utf8'), fs.readFileSync(nativeFile(single.cacheDir), 'utf8'));
      // The process-per-type path lists nativeRuntime in the order its 3 concurrent probes finished (a race); the batch
      // in the order of the types, which is the order of an index built from the stored answers (no probe at all).
      const sorted = native => Object.fromEntries(Object.entries(native).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
      const unstamped = index => JSON.stringify({ ...index, builtAt: null, nativeRuntime: sorted(index.nativeRuntime) });
      assert.equal(unstamped(a.index), unstamped(b.index));
      fs.rmSync(a.cache.file);
      const stored = await frozen(() => buildIndex(lane, { sources: batched }));
      assert.equal(stored.index.identity.nativeRuntime.probes.probed, 0);
      assert.deepEqual(Object.keys(a.index.nativeRuntime), Object.keys(stored.index.nativeRuntime));
      assert.equal(Object.values(a.index.nativeRuntime).filter(n => n.error).length, 0);
      const differ = [];
      for (const intent of INTENTS) {
        const one = JSON.stringify(await frozen(() => discoverAll({ lane, intent, sources: batched }))).replaceAll(stored.index.builtAt, '<builtAt>');
        const other = JSON.stringify(await frozen(() => discoverAll({ lane, intent, sources: single }))).replaceAll(b.index.builtAt, '<builtAt>');
        if (one !== other) differ.push(intent);
      }
      assert.deepEqual(differ, []);
      t.diagnostic(`${lane}: index with ${a.index.identity.nativeRuntime.types} native types, batch ${Math.round(batchedMs)} ms, a process per type ${Math.round(singleMs)} ms`);
    } finally { for (const s of [batched, single]) fs.rmSync(s.cacheDir, { recursive: true, force: true }); }
  });
}

// An older CLI (no --types) and a batch where one type failed, without a Studio: a fake CLI in place of the lane's.
const fakeCli = body => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-batch-fake-'));
  const file = path.join(dir, 'anvil.mjs');
  fs.writeFileSync(file, `const args = process.argv.slice(2); const opt = n => args[args.indexOf(n) + 1];\n${body}\n`);
  return { dir, sources: { lane: 'odc', dotnet: process.execPath, cli: file, kernel: dir, env: process.env } };
};
test('a CLI without --types answers no type in batch: every type goes to its own process', async () => {
  // What the CLIs before L3a print for `api --op native --types ...`: `--type` is missing.
  const { dir, sources } = fakeCli(`if (!args.includes('--type')) { console.log(JSON.stringify({ ok: false, command: 'api', error: 'System.ArgumentException: missing --type' })); process.exit(1); }`);
  try { assert.deepEqual(await nativeBatch(sources, ['IEntity', 'IAction']), {}); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('a type the batch failed is left to its own process; the others are kept', async () => {
  const { dir, sources } = fakeCli(`const results = {}; for (const t of opt('--types').split(',')) results[t] = t === 'IBroken' ? { ok: false, command: 'api', error: 'System.InvalidOperationException: boom' } : { ok: true, data: { platform: 'ODC', ideVersion: '1', candidates: [] } };
console.log(JSON.stringify({ ok: true, command: 'api', data: { op: 'native', types: Object.keys(results).length, results } }));`);
  try {
    const answered = await nativeBatch(sources, ['IEntity', 'IBroken', 'IAction']);
    assert.deepEqual(Object.keys(answered), ['IEntity', 'IAction']);
    assert.equal(answered.IEntity.ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('a batch process that fails or prints no results answers no type', async () => {
  for (const body of ['process.exit(3);', "console.log('not json');", "console.log(JSON.stringify({ ok: true, data: { op: 'native' } }));"]) {
    const { dir, sources } = fakeCli(body);
    try { assert.deepEqual(await nativeBatch(sources, ['IEntity']), {}, body); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
