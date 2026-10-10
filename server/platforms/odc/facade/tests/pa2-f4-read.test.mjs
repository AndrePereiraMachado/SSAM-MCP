// Atritos 2, lane F4, A29: an O11 module named by ssam_map / o11_inspect is never opened in a Studio tab. The real case
// (Cardapio, 2026-10-06 13:28:29): ssam_map {target:"Users"} held the Studio write lock for 31 s and opened Users; the user:
// "abri o módulo Users não é correto". Now a closed or system module (Users, OutSystemsUI, System) is read from its
// published OML (o11-environment.mjs downloadModule, contract I7, injected here), an open module is captured by its key,
// and o11_studio refuses to open a system module (SYSTEM_MODULE_NOT_OPENABLE, continuation ssam_map). A fake bridge, a
// fake download and temporary folders only; no Studio, CLI or port.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as map from '../module-map.mjs';
import { o11Studio } from '../o11-studio.mjs';
import * as studioModule from '../studio-module.mjs'; // a namespace: a build without systemModuleName fails on the assertions
import { sha256, writeIndex } from './fixtures/module-index.mjs';

const TEXT = name => 'published oml of ' + name;
const noReader = async () => { throw new Error('the reader must not be called on a stored index'); };

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pa2-f4-read-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'); fs.mkdirSync(root, { recursive: true });
  const store = path.join(base, 'store');
  const env = { ...process.env, USERPROFILE: path.join(base, 'home'), SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(base, 'readers'), ANVIL_LANE: 'ss4' };
  for (const name of ['Users', 'OutSystemsUI', 'System', 'Cardapio_IS', 'Cardapio_CS']) writeIndex(store, 'o11', sha256(Buffer.from(TEXT(name))));
  const downloads = [];
  // o11-environment.mjs downloadModule(input, options) as the contract I7 says: {ok, file, module, key, versionId, folder}
  const download = async (input, options) => {
    downloads.push({ input, options });
    const folder = path.join(root, '.local', 'environment', 'download', '20261006T162952193Z');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, input.module + '.oml'); fs.writeFileSync(file, TEXT(input.module));
    return { ok: true, file, module: input.module, key: 'K-' + input.module, versionId: 41, folder };
  };
  return { base, root, env, store, download, downloads, lockDeps: { o11Root: root, odcRoot: root, o11Lane: 'ss4', connection: () => null } };
}

// The bridge as the Studio answers: the open tabs with their keys; snapshot_module by key captures that tab.
function fakeBridge(open = []) {
  const calls = [];
  const client = {
    async ok(method, params = {}) {
      calls.push({ method, params });
      if (method === 'list_open_modules') return { modules: open.map(name => ({ name, key: 'T' + name, hasESpace: true, hasOpenedActiveESpace: true, serverSilentMode: false })) };
      if (method === 'snapshot_module') {
        const name = String(params.module_key).slice(1);
        fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, TEXT(name));
        return { path: params.path, sha256: sha256(Buffer.from(TEXT(name))), name, key: params.module_key, environment: 'env.test', snapshot_id: 's1' };
      }
      if (method === 'open_module') throw new Error('open_module must never be called by a read');
      throw new Error('unexpected bridge call ' + method);
    },
  };
  return { client, calls, methods: () => calls.map(c => c.method) };
}
// A build without the published-OML read ignores deps.o11 and would reach the lane's real bridge port: refuse it before any call.
const guard = () => assert.equal(typeof map.PUBLISHED_CAPTURE, 'string', 'this build reads a closed module by opening it (no published-OML read)');
const mapWith = (s, bridge, extra = {}) => target => (guard(), map.moduleMap({ lane: 'o11', target }, { env: s.env, read: noReader,
  o11: { lane: 'ss4', root: s.root, bridge: bridge.client, assertSelected: async () => {}, download: s.download, lockDeps: s.lockDeps, ...extra } }));
const lockFolder = s => path.join(s.root, '.local', 'locks');
const noLocks = s => assert.deepEqual(fs.existsSync(lockFolder(s)) ? fs.readdirSync(lockFolder(s)) : [], [], 'no lock or queue file was ever needed');

test('systemModuleName: Users, OutSystemsUI and System in any spelling; any other module is not one', () => {
  for (const [name, canonical] of [['Users', 'Users'], ['users', 'Users'], ['OutSystems UI', 'OutSystemsUI'], ['outsystems_ui', 'OutSystemsUI'],
    ['OutSystemsUI', 'OutSystemsUI'], ['System', 'System'], ['(System)', 'System']]) assert.equal(studioModule.systemModuleName?.(name), canonical, name);
  for (const name of ['Cardapio_IS', 'UsersCS', 'OutSystemsUIWeb', 'Systems', '', null]) assert.equal(studioModule.systemModuleName?.(name), null, String(name));
});

test('ssam_map {target:"Users"} with Users closed calls the injected downloadModule and never open_module (the 13:28:29 case)', async t => {
  const s = sandbox(t);
  const bridge = fakeBridge(['Cardapio_CS', 'Cardapio_IS']);
  const answer = await mapWith(s, bridge)('Users');
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.capturedBy, map.PUBLISHED_CAPTURE); assert.equal(answer.versionId, 41);
  assert.equal(answer.sourceSha256, sha256(Buffer.from(TEXT('Users'))));
  assert.equal(path.basename(answer.file), 'Users.oml');
  assert.deepEqual(s.downloads.map(d => d.input), [{ module: 'Users' }]);
  assert.deepEqual([s.downloads[0].options.lane, s.downloads[0].options.root], ['ss4', s.root]);
  assert.deepEqual(bridge.methods(), [], 'a system module is never looked for in the tabs, opened or selected');
  noLocks(s);
});

test('a system module is read from its published OML even when a tab has it; any spelling reaches the canonical name', async t => {
  const s = sandbox(t);
  const bridge = fakeBridge(['Users', 'OutSystemsUI']);
  for (const name of ['users', 'OutSystems UI', '(System)']) assert.equal((await mapWith(s, bridge)(name)).ok, true, name);
  assert.deepEqual(s.downloads.map(d => d.input.module), ['Users', 'OutSystemsUI', 'System']);
  assert.deepEqual(bridge.methods(), []);
});

test('an open module is captured by its key without selecting it; a module no tab has comes from its published OML', async t => {
  const s = sandbox(t);
  const bridge = fakeBridge(['Cardapio_CS', 'Cardapio_IS']);
  const open = await mapWith(s, bridge)('Cardapio_IS');
  assert.equal(open.ok, true, JSON.stringify(open)); assert.equal(open.capturedBy, undefined);
  assert.deepEqual(bridge.calls.filter(c => c.method === 'snapshot_module').map(c => c.params.module_key), ['TCardapio_IS']);
  assert.deepEqual(s.downloads, [], 'an open module is never downloaded');
  const closed = await map.captureO11Module('Cardapio_BackOffice', { lane: 'ss4', root: s.root, env: s.env, bridge: bridge.client, assertSelected: async () => {},
    download: s.download, lockDeps: s.lockDeps });
  assert.deepEqual([closed.ok, closed.capturedBy, closed.reason, closed.module, closed.key], [true, map.PUBLISHED_CAPTURE, 'not-open', 'Cardapio_BackOffice', 'K-Cardapio_BackOffice']);
  assert.ok(!bridge.methods().includes('open_module'));
  noLocks(s);
});

test('without downloadModule (a build before it): MODULE_NOT_OPEN with the o11_environment download continuation; nothing opens', async t => {
  const s = sandbox(t);
  const bridge = fakeBridge(['Cardapio_CS']);
  for (const name of ['Users', 'Cardapio_BackOffice']) {
    const refused = await mapWith(s, bridge, { download: null })(name);
    assert.deepEqual([refused.ok, refused.code], [false, 'MODULE_NOT_OPEN'], JSON.stringify(refused));
    assert.deepEqual([refused.continuation.tool, refused.continuation.arguments], ['o11_environment', { action: 'download', module: name }]);
  }
  assert.ok(!bridge.methods().includes('open_module'));
  noLocks(s);
});

test('a refused download comes back with its own code and continuation; a Studio that does not answer is refused as o11_studio refuses', async t => {
  guard();
  const s = sandbox(t);
  const notSelected = { ok: false, code: 'STUDIO_NOT_SELECTED', error: 'no Studio selected', continuation: { tool: 'ssam_connect', arguments: { lane: 'o11' } } };
  const refused = await mapWith(s, fakeBridge([]), { download: async () => notSelected })('Users');
  assert.deepEqual([refused.ok, refused.code, refused.continuation.tool], [false, 'STUDIO_NOT_SELECTED', 'ssam_connect']);
  const down = { client: { ok: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'BRIDGE_NOT_LISTENING' }); } } };
  const offline = await map.captureO11Module('Cardapio_IS', { lane: 'ss4', root: s.root, env: s.env, bridge: down.client, assertSelected: async () => {},
    download: async () => assert.fail('nothing is downloaded when the open tabs cannot be read'), lockDeps: s.lockDeps });
  assert.deepEqual([offline.ok, offline.code, offline.continuation.tool], [false, 'O11_NOT_CONNECTED', 'ssam_connect']);
  noLocks(s);
});

test('o11_studio open-module, snapshot, wait open and refresh-references of a system module: SYSTEM_MODULE_NOT_OPENABLE with ssam_map, nothing asked of the Studio', async () => {
  guard();
  const calls = []; let selections = 0;
  const run = o11Studio({ bridge: { ok: async method => { calls.push(method); throw new Error('no bridge call expected'); } },
    assertSelected: async () => { selections++; }, lane: 'ss4', root: os.tmpdir(), env: process.env, inventory: async () => null });
  for (const [command, args, target] of [['open-module', { name: 'System' }, 'System'], ['open-module', { module: 'Users' }, 'Users'],
    ['snapshot', { module: 'OutSystems UI' }, 'OutSystemsUI'], ['wait', { condition: 'open', module: 'users' }, 'Users'],
    ['refresh-references', { module: '(System)' }, 'System']]) {
    const value = await run({ command, args });
    assert.deepEqual([value.ok, value.code, value.outcome], [false, 'SYSTEM_MODULE_NOT_OPENABLE', 'not-sent'], command + ' ' + JSON.stringify(value));
    assert.deepEqual(value.continuation.tool, 'ssam_map');
    assert.deepEqual(value.continuation.arguments, { lane: 'o11', target });
  }
  assert.deepEqual(calls, []); assert.equal(selections, 0);
});
