// Atritos 3, lane K1-c (docs/PACOTE-ATRITOS-3.md): o11_environment download and downloadModule (I11) pass the lane's
// published-OML cache to the CLI and answer cached. The fake CLI keeps the CLI's own rule (PublishedOmlCache, proven by
// Pa3K1CacheTests): a version in <cache>/<key>/<versionId>.oml is copied to the call's folder, any other is downloaded once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerO11Environment, downloadModule, environmentArguments, publishedCache } from '../o11-environment.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';

const KEY = 'WWAQZTkE5UuwES8B+6Svpg';
const value = (args, name) => args[args.indexOf(name) + 1];

// The CLI's download --cache, in miniature: the published version (812) unless --version names one.
function cachingCli() {
  const network = [];
  const runAnvil = fakeAnvil({ download: args => {
    const out = value(args, '--out'); const cache = args.includes('--cache') ? value(args, '--cache') : null;
    const version = args.includes('--version') ? Number(value(args, '--version')) : 812;
    const target = path.join(out, 'Users.oml');
    const cached = cache && path.join(cache, KEY.replace(/[^A-Za-z0-9_-]/g, '_'), version + '.oml');
    fs.mkdirSync(out, { recursive: true });
    if (cached && fs.existsSync(cached)) { fs.copyFileSync(cached, target); return { ok: true, command: 'download', data: { Name: 'Users', Key: KEY, Kind: 'eSpace', VersionId: version, FilePath: target, Status: 'ok', Cached: true } }; }
    network.push(version);
    fs.writeFileSync(target, 'oml v' + version);
    if (cached) { fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.copyFileSync(target, cached); }
    return { ok: true, command: 'download', data: { Name: 'Users', Key: KEY, Kind: 'eSpace', VersionId: version, FilePath: target, Status: 'ok', Cached: false } };
  } });
  return { runAnvil, network };
}

test('K1-c: two downloads of the same version download once; the second answers cached:true from the lane cache', async t => {
  const kernel = tempKernel(); t.after(kernel.cleanup);
  const { runAnvil, network } = cachingCli();
  let tick = Date.parse('2026-10-07T10:00:00.000Z');
  const deps = { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil, assertSelected: async () => {}, now: () => new Date(tick += 1000) };
  const cache = publishedCache(path.join(kernel.root, '.local'));
  const first = await downloadModule({ module: 'Users' }, deps);
  const second = await downloadModule({ module: 'Users' }, deps);
  assert.equal(first.ok, true); assert.equal(first.cached, false);
  assert.equal(second.ok, true); assert.equal(second.cached, true);
  assert.deepEqual(network, [812], 'one download for the version');
  // Each answer is a file of its own folder (a JobSources capture folder), never the cache file itself.
  assert.notEqual(first.file, second.file);
  assert.equal(fs.readFileSync(second.file, 'utf8'), 'oml v812');
  for (const call of runAnvil.calls) assert.equal(value(call.args, '--cache'), cache);
  // Another version is another download.
  const other = await downloadModule({ module: 'Users', version: 811 }, deps);
  assert.equal(other.cached, false); assert.deepEqual(network, [812, 811]);
});

test('K1-c: the o11_environment tool passes the same cache and answers cached', async t => {
  const kernel = tempKernel(); t.after(kernel.cleanup);
  const { runAnvil, network } = cachingCli();
  let tick = Date.parse('2026-10-07T11:00:00.000Z');
  const mcp = await linked(registerO11Environment, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil, assertSelected: async () => {},
    now: () => new Date(tick += 1000), uuid: () => '00000000-0000-4000-8000-000000000001' });
  t.after(() => mcp.close());
  const a = await mcp.call('o11_environment', { action: 'download', module: 'Users' });
  const b = await mcp.call('o11_environment', { action: 'download', module: 'Users' });
  assert.equal(a.cached, false); assert.equal(b.cached, true); assert.deepEqual(network, [812]);
  assert.equal(value(runAnvil.calls[1].args, '--cache'), publishedCache(path.join(kernel.root, '.local')));
  // A caller that gives no cache (an older caller of environmentArguments) keeps today's argv.
  assert.deepEqual(environmentArguments({ action: 'download', module: 'M' }, { out: 'O' }), ['download', '--module', 'M', '--out', 'O', '--read-only']);
});
