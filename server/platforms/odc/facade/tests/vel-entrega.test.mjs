// Speed lane vel-entrega (lentidão 2026-10-12): the O11 build phase reuses a capture the server holds when the tab's model
// is the same (no capture, no upload), deliveries record their snapshots as known captures, o11_environment answers a
// network failure of the Studio as ENVIRONMENT_UNREACHABLE (a read already asked again by the kernel, a write uncertain),
// caches templates per environment, writes the modules a creation made into the cached inventory, and o11_studio
// open-module reads the inventory once more when it is older than the last creation. Fake bridges and a fake CLI only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureByKey, afterApply } from '../o11-build-phase.mjs';
import { modelSha256, rememberCapture, findCapture, rememberDelivery, capturesFile, PER_MODULE } from '../o11-capture-store.mjs';
import { registerO11Environment, environmentArguments, addCreatedToInventory, lastModuleCreation, readTemplatesCache } from '../o11-environment.mjs';
import { o11Studio, readInventory } from '../o11-studio.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { envelopes, tempKernel, linked } from './fixtures/o11env-kernel.mjs';

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const oml = (header, model) => { const head = Buffer.from(header); const length = Buffer.alloc(4); length.writeUInt32LE(head.length); return Buffer.concat([Buffer.from('OML'), length, head, Buffer.from(model)]); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// A fake O11 bridge client: ok(method, params) from a table (a value, or a function of the params), every call recorded.
function bridge(table) {
  const calls = [];
  return { calls, async ok(method, params = {}) {
    calls.push({ method, params });
    const entry = table[method];
    if (entry === undefined) throw new Error('Unknown method: ' + method);
    return typeof entry === 'function' ? entry(params) : entry;
  } };
}

test('the model hash ignores the window-state header, and a capture is found only while its file still has that model', () => {
  const local = tmp('vel-capture-');
  try {
    const a = path.join(local, 'a.oml'); fs.writeFileSync(a, oml('{tree:1}', 'MODEL'));
    const b = path.join(local, 'b.oml'); fs.writeFileSync(b, oml('{tree:2,selection:"X"}', 'MODEL'));
    assert.equal(modelSha256(a), modelSha256(b));
    assert.equal(modelSha256(a), sha(Buffer.from('MODEL')));
    const raw = path.join(local, 'raw.bin'); fs.writeFileSync(raw, 'not an oml');
    assert.equal(modelSha256(raw), sha(Buffer.from('not an oml')));
    const model = rememberCapture(local, { moduleKey: 'k1', module: 'Orders_CS', file: a, source: 'build' });
    assert.equal(model, modelSha256(a));
    assert.equal(findCapture(local, { moduleKey: 'k1', model }).path, path.resolve(a));
    assert.equal(findCapture(local, { moduleKey: 'other', model }), null, 'another module never reuses it');
    fs.writeFileSync(a, oml('{tree:1}', 'CHANGED'));
    assert.equal(findCapture(local, { moduleKey: 'k1', model }), null, 'a file that changed is never reused');
    for (let i = 0; i < PER_MODULE + 3; i++) { const f = path.join(local, i + '.oml'); fs.writeFileSync(f, oml('h', 'M' + i)); rememberCapture(local, { moduleKey: 'k1', file: f }); }
    assert.equal(JSON.parse(fs.readFileSync(capturesFile(local), 'utf8')).modules.k1.length, PER_MODULE);
    assert.equal(rememberCapture(local, { moduleKey: 'k1', file: path.join(local, 'missing.oml') }), null);
  } finally { fs.rmSync(local, { recursive: true, force: true }); }
});

test('captureByKey copies a capture the server holds when the tab has the same model: no snapshot_module, no upload', async () => {
  const local = tmp('vel-build-');
  try {
    const held = path.join(local, 'work', 'deliver', 't1', 'delivered-1.oml');
    fs.mkdirSync(path.dirname(held), { recursive: true }); fs.writeFileSync(held, oml('{after merge}', 'MODEL-1'));
    rememberDelivery(local, { moduleKey: 'k1', deliveredSnapshot: { path: held, key: 'k1', name: 'Orders_CS' } });
    const tab = model => ({ modules: [{ name: 'Orders_CS', key: 'k1', hasESpace: true, hasOpenedActiveESpace: true, serverSilentMode: false, ...(model ? { modelSha256: model } : {}) }] });
    const snapshot = params => { fs.writeFileSync(params.path, oml('{fresh}', 'MODEL-2')); return { path: params.path, key: 'k1' }; };

    const same = bridge({ list_open_modules: tab(sha(Buffer.from('MODEL-1'))), snapshot_module: snapshot });
    const reused = await captureByKey('Orders_CS', { bridge: () => same, local });
    assert.deepEqual(same.calls.map(c => c.method), ['list_open_modules'], 'nothing was captured');
    assert.deepEqual(same.calls[0].params, { model_sha256_of: 'Orders_CS' });
    assert.equal(reused.reused.from, path.resolve(held));
    assert.equal(modelSha256(reused.path), sha(Buffer.from('MODEL-1')));
    assert.notEqual(path.resolve(reused.path), path.resolve(held), 'the build gets its own copy');

    // Another model, or a bridge without the fingerprint: captured as before, and the capture is recorded for the next call.
    const other = bridge({ list_open_modules: tab(sha(Buffer.from('MODEL-9'))), snapshot_module: snapshot });
    const captured = await captureByKey('Orders_CS', { bridge: () => other, local });
    assert.deepEqual(other.calls.map(c => c.method), ['list_open_modules', 'snapshot_module']);
    assert.equal(captured.reused, undefined);
    const older = bridge({ list_open_modules: tab(null), snapshot_module: snapshot });
    await captureByKey('Orders_CS', { bridge: () => older, local });
    assert.deepEqual(older.calls.map(c => c.method), ['list_open_modules', 'snapshot_module']);
    const again = bridge({ list_open_modules: tab(sha(Buffer.from('MODEL-2'))), snapshot_module: snapshot });
    assert.ok((await captureByKey('Orders_CS', { bridge: () => again, local })).reused, 'the capture of a refused call is reused by its correction');
    assert.deepEqual(again.calls.map(c => c.method), ['list_open_modules']);
  } finally { fs.rmSync(local, { recursive: true, force: true }); }
});

test('afterApply records the delivery snapshots of the kernel state as known captures, with or without a build phase', () => {
  const local = tmp('vel-after-');
  try {
    const base = path.join(local, 'base.oml'); fs.writeFileSync(base, oml('h', 'BEFORE'));
    const delivered = path.join(local, 'delivered.oml'); fs.writeFileSync(delivered, oml('h', 'AFTER'));
    afterApply({ envelope: { ok: true, data: { moduleKey: 'k2', snapshot: { path: base, key: 'k2' }, deliveredSnapshot: { path: delivered, key: 'k2' } } } }, null, { work: local, local });
    assert.equal(findCapture(local, { moduleKey: 'k2', model: sha(Buffer.from('AFTER')) }).source, 'delivered');
    assert.equal(findCapture(local, { moduleKey: 'k2', model: sha(Buffer.from('BEFORE')) }).source, 'deliver-base');
    // A snapshot of another module key is never recorded under this task's module.
    rememberDelivery(local, { moduleKey: 'k3', snapshot: { path: base, key: 'k9' } });
    assert.equal(findCapture(local, { moduleKey: 'k9', model: sha(Buffer.from('BEFORE')) }), null);
  } finally { fs.rmSync(local, { recursive: true, force: true }); }
});

// ---- o11_environment ------------------------------------------------------------------------------------------------------
async function harness(t, handlers) {
  const kernel = tempKernel({ cli: true });
  const run = fakeAnvil({ ...envelopes, ...handlers });
  const deps = { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, now: () => new Date('2026-10-12T03:10:00.000Z'),
    uuid: () => '00000000-0000-4000-8000-000000000001', assertSelected: async () => {} };
  const mcp = await linked(registerO11Environment, deps);
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  return { ...mcp, run, root: kernel.root, local: path.join(kernel.root, '.local') };
}
const WORDS = 'Sim, crie o app FolhaPonto';
const NETWORK = 'BridgeCallException: environment_session: CommunicationException: An error occurred while sending the request.';

test('a network failure of the Studio is ENVIRONMENT_UNREACHABLE: a read says it may be asked again, a write is uncertain and never repeated', async t => {
  const h = await harness(t, {
    inventory: () => ({ ok: false, command: 'inventory', code: 'ENVIRONMENT_UNREACHABLE', error: 'EnvironmentUnreachableException: The Service Studio could not reach the OutSystems environment p.example for \'modules\' (the network of the Studio\'s PC; asked twice, on two requests); nothing was changed. Last failure: ' + NETWORK }),
    templates: () => ({ ok: false, command: 'templates', error: NETWORK }),
    'update-app': () => ({ ok: false, command: 'update-app', error: NETWORK }),
    'create-module': () => ({ ok: false, command: 'create-module', error: 'SocketException: No connection could be made because the target machine actively refused it. 127.0.0.1:4516' }),
  });
  const inventory = await h.call('o11_environment', { action: 'inventory', host: 'p.example' });
  assert.equal(inventory.code, 'ENVIRONMENT_UNREACHABLE'); assert.notEqual(inventory.code, 'CLI_REFUSED');
  assert.match(inventory.error, /could not reach the OutSystems environment/);
  assert.equal(inventory.network.repeated, true);
  assert.deepEqual(inventory.continuation, { tool: 'o11_environment', arguments: { action: 'inventory', host: 'p.example' }, why: inventory.continuation.why });
  const templates = await h.call('o11_environment', { action: 'templates' });
  assert.equal(templates.code, 'ENVIRONMENT_UNREACHABLE', 'an older kernel answers the bare text');
  const write = await h.call('o11_environment', { action: 'update-app', name: 'Demo', color: '#112233', authorize: WORDS });
  assert.equal(write.code, 'ENVIRONMENT_UNREACHABLE'); assert.equal(write.outcome, 'uncertain');
  assert.equal(write.continuation.arguments.action, 'inventory');
  assert.equal(h.run.calls.filter(c => c.args[0] === 'update-app').length, 1, 'never repeated');
  // A socket error of the local bridge connection is the bridge, not the environment.
  const local = await h.call('o11_environment', { action: 'create-module', app: 'Demo', name: 'Demo_UI2', authorize: WORDS });
  assert.equal(local.code, 'UNCERTAIN');
});

test('templates are cached per environment: a read with host answers from the cache, create-app passes it to the CLI', async t => {
  const rows = [{ Key: 'tpl-phone', Label: 'PhoneApp', Description: null, IsMobile: true, ApplicationKind: 'Mobile' }];
  const h = await harness(t, { templates: args => ({ ok: true, command: 'templates', data: args.includes('--with-host') ? { host: 'p.example', templates: rows } : rows }) });
  const first = await h.call('o11_environment', { action: 'templates', host: 'p.example' });
  assert.deepEqual(h.run.calls[0].args, ['templates', '--with-host', '--host', 'p.example', '--read-only']);
  assert.deepEqual(first.templates, [{ key: 'tpl-phone', label: 'PhoneApp', kind: 'Mobile' }]);
  assert.equal(first.cached, undefined);
  const second = await h.call('o11_environment', { action: 'templates', host: 'P.example' });
  assert.equal(second.cached, true); assert.deepEqual(second.templates, first.templates);
  assert.equal(h.run.calls.length, 1, 'served from the cache');
  await h.call('o11_environment', { action: 'templates', host: 'p.example', refresh: true });
  assert.equal(h.run.calls.length, 2, 'refresh reads the server');
  const cache = readTemplatesCache(h.local, 'p.example', new Date('2026-10-12T03:10:00.000Z'));
  await h.call('o11_environment', { action: 'create-app', name: 'FolhaPonto', kind: 'Mobile', modules: [{ name: 'FolhaPonto_UI', kind: 'Mobile' }], host: 'p.example', authorize: WORDS });
  const created = h.run.calls.at(-1).args;
  assert.equal(created[created.indexOf('--templates') + 1], cache.file);
  await h.call('o11_environment', { action: 'create-app', name: 'FolhaPonto', kind: 'Mobile', modules: [{ name: 'FolhaPonto_UI', kind: 'Mobile' }], templateKey: 'tpl-phone', host: 'p.example', authorize: WORDS });
  assert.ok(!h.run.calls.at(-1).args.includes('--templates'), 'a templateKey given needs no cache');
  // Older than a day: read again.
  assert.equal(readTemplatesCache(h.local, 'p.example', new Date('2026-10-13T04:00:00.000Z')), null);
  assert.deepEqual(environmentArguments({ action: 'templates' }, { withHost: true }), ['templates', '--with-host', '--read-only']);
});

test('the modules a creation made go into the cached inventory, so open-module resolves them without reading the environment', async t => {
  const h = await harness(t, {
    'create-app': () => ({ ok: true, command: 'create-app', data: { ApplicationName: 'FolhaPonto', ApplicationKey: 'app-f', ApplicationOk: true, Succeeded: true, Host: 'p.example',
      Modules: [{ Name: 'FolhaPonto_UI', Key: 'k-ui', Succeeded: true }, { Name: 'FolhaPonto_CS', Key: 'k-cs', Succeeded: true }] } }),
  });
  const folder = path.join(h.local, 'environment', 'inventory', '20261012T031053000Z');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'inventory.json'), JSON.stringify({ host: 'p.example', capturedAtUtc: '2026-10-12T03:10:53Z',
    applications: [{ Name: 'Demo', Key: 'app-1' }], modules: [{ Name: 'Demo_CS', Key: 'mod-1', ApplicationName: 'Demo' }] }));
  const created = await h.call('o11_environment', { action: 'create-app', name: 'FolhaPonto', modules: [{ name: 'FolhaPonto_UI', kind: 'Mobile' }, { name: 'FolhaPonto_CS', kind: 'Service' }], authorize: WORDS });
  assert.equal(created.ok, true); assert.equal(created.host, 'p.example');
  assert.ok(created.inventory && fs.existsSync(created.inventory), JSON.stringify(created));
  const inventory = readInventory({ local: h.local, host: 'p.example' });
  assert.deepEqual(inventory.modules.map(m => m.name).sort(), ['Demo_CS', 'FolhaPonto_CS', 'FolhaPonto_UI']);
  assert.equal(JSON.parse(fs.readFileSync(created.inventory, 'utf8')).derivedFrom, path.join(folder, 'inventory.json'));
  assert.ok(Date.parse(lastModuleCreation(h.local)) >= Date.parse('2026-10-12T03:10:00Z'));
  // No inventory of that environment yet: nothing to complete.
  assert.equal(addCreatedToInventory(h.local, { host: 'other.example', app: 'X', modules: [{ name: 'X_CS', key: 'kx' }] }), null);
});

test('open-module reads the inventory once more when it is older than the last creation, and only then', async () => {
  const old = { host: 'p.example', at: '2026-10-12T03:10:53Z', modules: [{ name: 'Demo_CS' }] };
  const fresh = { host: 'p.example', at: '2026-10-12T03:13:00Z', modules: [{ name: 'Demo_CS' }, { name: 'FolhaPonto_CS' }] };
  const make = lastCreation => {
    let current = old; const rereads = [];
    const fake = bridge({ list_open_modules: { modules: [] }, open_module: params => ({ name: params.name, opened: true, selected: true }) });
    const run = o11Studio({ bridge: fake, assertSelected: async () => {}, inventory: async () => current, lastCreation: () => lastCreation,
      rereadInventory: async ({ host }) => { rereads.push(host); current = fresh; return { ok: true }; } });
    return { run, fake, rereads };
  };
  const after = make('2026-10-12T03:11:55Z');
  const opened = await after.run({ command: 'open-module', args: { name: 'FolhaPonto_CS' } });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.deepEqual(after.rereads, ['p.example']);
  assert.equal(after.fake.calls.find(c => c.method === 'open_module').params.name, 'FolhaPonto_CS');
  const before = make('2026-10-12T03:00:00Z');
  const refused = await before.run({ command: 'open-module', args: { name: 'FolhaPonto_CS' } });
  assert.equal(refused.code, 'MODULE_NOT_FOUND'); assert.deepEqual(before.rereads, []);
  const none = make(null);
  assert.equal((await none.run({ command: 'open-module', args: { name: 'FolhaPonto_CS' } })).code, 'MODULE_NOT_FOUND');
  assert.deepEqual(none.rereads, []);
});
