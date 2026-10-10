// Atritos 3, lane fa, C11: what makes a running MCP server old is only what its process loaded: the facade modules and
// data, the tool catalog, and the launcher its parent runs (facade-identity.mjs). A commit or a CLI build that changes only
// the kernel, the CLI or the XIF engine (they run per call) never answers RELEASE_CHANGED; the doctor says when the
// launcher reloaded the server in place. Temporary folders and fakes only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createIdentityReader, identityFiles } from '../facade-identity.mjs';
import { serverIdentity, releaseChanged } from '../server-identity.mjs';
import { createSsamServer } from '../ssam.mjs';
import { workspaceRoot } from '../workspace.mjs';
process.env.SSAM_ODC_OFFLINE = '1';

const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function checkout(t) {
  const root = temp(t, 'pa3-reload-');
  put(path.join(root, 'platforms', 'odc', 'facade', 'ssam.mjs'), 'export const a = 1;\n');
  put(path.join(root, 'platforms', 'odc', 'facade', 'catalog', 'tools.json'), '{"tools":{}}');
  put(path.join(root, 'platforms', 'odc', 'facade', 'catalog', 'fragments', 'A', 'x.json'), '{"capabilities":[]}');
  put(path.join(root, 'platforms', 'odc', 'facade', 'discovery-capabilities.json'), '{}');
  put(path.join(root, 'platforms', 'odc', 'facade', 'tests', 'x.test.mjs'), '// a test');
  put(path.join(root, 'platforms', 'odc', 'portal', 'runtime', 'portal-read.mjs'), 'export {};\n');
  put(path.join(root, 'facade', 'launch.mjs'), '// launcher');
  put(path.join(root, 'facade', 'friction-store.mjs'), '// store');
  put(path.join(root, 'facade', 'package-route.mjs'), '// route');
  put(path.join(root, 'kernel', '.local', 'cli', 'anvil.dll'), 'cli');
  return root;
}

test('C11: the identity covers the facade, the catalog and the launcher; tests, the kernel CLI and the XIF engine are not in it', t => {
  const root = checkout(t);
  const sets = identityFiles(root);
  const rel = list => list.map(f => path.relative(root, f).split(path.sep).join('/')).sort();
  assert.deepEqual(rel(sets.launcher), ['facade/friction-store.mjs', 'facade/launch.mjs']);
  assert.deepEqual(rel(sets.catalog), ['platforms/odc/facade/catalog/fragments/A/x.json', 'platforms/odc/facade/catalog/tools.json', 'platforms/odc/facade/discovery-capabilities.json']);
  assert.ok(rel(sets.facade).includes('platforms/odc/portal/runtime/portal-read.mjs'));
  assert.ok(!rel(sets.facade).some(f => f.includes('/tests/') || f.startsWith('kernel/')));
  const reader = createIdentityReader({ root, cacheMs: 0 });
  const first = reader.read();
  for (const key of ['facadeSha256', 'catalogSha256', 'launcherSha256']) assert.match(first[key], /^[a-f0-9]{64}$/);
  put(path.join(root, 'kernel', '.local', 'cli', 'anvil.dll'), 'cli 2');
  put(path.join(root, 'kernel', '.local', 'xif-engine', 'Anvil.Xif.Engine.exe'), 'engine');
  put(path.join(root, 'platforms', 'odc', 'facade', 'tests', 'x.test.mjs'), '// another test');
  assert.deepEqual(reader.read(), first, 'the CLI, the engine and the tests change nothing');
  put(path.join(root, 'platforms', 'odc', 'facade', 'ssam.mjs'), 'export const a = 2;\n');
  const facade = reader.read();
  assert.notEqual(facade.facadeSha256, first.facadeSha256); assert.equal(facade.catalogSha256, first.catalogSha256);
  put(path.join(root, 'platforms', 'odc', 'facade', 'catalog', 'tools.json'), '{"tools":{"x":{}}}');
  assert.notEqual(reader.read().catalogSha256, facade.catalogSha256);
  put(path.join(root, 'facade', 'launch.mjs'), '// launcher 2');
  assert.notEqual(reader.read().launcherSha256, first.launcherSha256);
  // The cache answers the last value within cacheMs.
  let clock = 0;
  const cached = createIdentityReader({ root, cacheMs: 2000, now: () => clock });
  const value = cached.read(); put(path.join(root, 'facade', 'launch.mjs'), '// launcher 3');
  assert.equal(cached.read(), value); clock = 2500; assert.notEqual(cached.read().launcherSha256, value.launcherSha256);
});

test('C11: releaseChanged counts the facade, the catalog and the launcher; head and cli are information only', t => {
  const root = checkout(t);
  const files = createIdentityReader({ root, cacheMs: 0 });
  const cliFile = path.join(root, 'kernel', '.local', 'cli', 'anvil.dll');
  const started = serverIdentity({ root, release: false, files, cliFile, env: {}, loaded: true });
  assert.equal(started.release.launcherSha256, null, 'not under a launcher: the launcher is not compared');
  put(cliFile, 'a new CLI build');
  const cliOnly = serverIdentity({ root, release: false, files, cliFile, env: {} });
  assert.equal(releaseChanged(started, cliOnly), null, 'a CLI build never makes the server old');
  const withHead = { ...cliOnly, release: { ...cliOnly.release, head: 'f'.repeat(40) } };
  assert.equal(releaseChanged({ ...started, release: { ...started.release, head: 'e'.repeat(40) } }, withHead), null, 'a commit that changed only the kernel');
  put(path.join(root, 'platforms', 'odc', 'facade', 'ssam.mjs'), 'export const a = 3;\n');
  const changed = releaseChanged(started, serverIdentity({ root, release: false, files, cliFile, env: {} }));
  assert.deepEqual(changed.changed, ['facade']); assert.deepEqual(changed.info, ['cli']);
  // Under the launcher: the launcher its parent loaded (SSAM_LAUNCHER_SHA256) against the one on disk.
  const underLauncher = serverIdentity({ root, release: false, files, cliFile, loaded: true,
    env: { SSAM_LAUNCHER_SHA256: files.read().launcherSha256, SSAM_RELOADED_AT: '2026-10-07T12:00:00.000Z', SSAM_RELOADED_FROM: '{"facadeSha256":"x"}' } });
  assert.equal(underLauncher.reloadedAt, '2026-10-07T12:00:00.000Z'); assert.deepEqual(underLauncher.reloadedFrom, { facadeSha256: 'x' });
  put(path.join(root, 'facade', 'launch.mjs'), '// a new launcher');
  // facade/*.mjs of the root are facade files too: a new launcher is both (the relay reloads, the child still says it).
  assert.deepEqual(releaseChanged(underLauncher, serverIdentity({ root, release: false, files, cliFile, env: {} })).changed, ['facade', 'launcher']);
});

test('C11: through the server: a CLI-only change runs the call; a facade change answers RELEASE_CHANGED; the doctor says reloadedAt', async t => {
  const root = temp(t, 'pa3-reload-server-');
  const base = { name: 'ssam', root: workspaceRoot, startedAt: '2026-10-07T12:00:00.000Z', reloadedAt: '2026-10-07T12:00:00.000Z', reloadedFrom: { facadeSha256: '0'.repeat(64) },
    release: { head: 'a'.repeat(40), facadeSha256: '1'.repeat(64), catalogSha256: '2'.repeat(64), launcherSha256: null, cli: { path: 'C:\\k\\anvil.dll', mtimeMs: 1, size: 1 } } };
  let current = base;
  let ran = 0;
  const server = await createSsamServer({ odc: false, deps: { jobTool: async () => { ran++; return { ok: true }; },
    cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil: async () => { throw new Error('no kernel'); }, assertSelected: async () => {}, tasksDir: path.join(root, 'tasks') },
    lock: { o11Root: root, odcRoot: root, connection: () => null },
    doctor: { lanes: { o11: async () => ({ lane: 'o11', ok: true, studio: { open: true } }), odc: async () => ({ lane: 'odc', ok: true, studio: { open: true } }) } },
    identity: { started: base, read: () => current, cacheMs: 0, launchCwd: workspaceRoot } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa3-reload', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  current = { ...base, release: { ...base.release, head: 'b'.repeat(40), cli: { path: 'C:\\k\\anvil.dll', mtimeMs: 2, size: 2 } } };
  const job = (await client.callTool({ name: 'ssam_job', arguments: { job: { ops: [] } } })).structuredContent;
  assert.notEqual(job?.code, 'RELEASE_CHANGED', JSON.stringify(job));
  assert.equal(ran, 1, 'a kernel or CLI change never stops a call');
  const doctor = (await client.callTool({ name: 'ssam_doctor', arguments: {} })).structuredContent;
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  assert.equal(doctor.server.reloadedAt, '2026-10-07T12:00:00.000Z');
  assert.deepEqual(doctor.server.reloadedFrom, { facadeSha256: '0'.repeat(64) });
  current = { ...current, release: { ...current.release, facadeSha256: '3'.repeat(64) } };
  const stale = (await client.callTool({ name: 'ssam_job', arguments: { job: { ops: [] } } })).structuredContent;
  assert.equal(stale.code, 'RELEASE_CHANGED'); assert.deepEqual(stale.release.changed, ['facade']);
  assert.equal(ran, 1);
});
