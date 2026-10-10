// Lane B of the 2026-10-06 frictions (Astra item 2): parallel ssam_map calls by O11 module name answered
// STUDIO_WRITE_BUSY because the read took the exclusive Studio write lock. Now a capture of a module already open in a
// tab is a read by its key (snapshot_module module_key, no tab selected, no lock), so concurrent reads and a running
// delivery never refuse it. Since the atritos 2 package (A29, A08) a closed or system module is read from its published
// OML (never a tab) and only selecting an open module stays an exclusive write, waiting its turn in the Studio's write
// queue. A fake O11 bridge, a fake download and a fake ODC lane server in process; temporary folders only; no Studio,
// port or process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as lock from '../studio-write-lock.mjs';
import * as map from '../module-map.mjs';
import { createSsamServer } from '../ssam.mjs';
import { registerO11Cycle } from '../o11-cycle.mjs';
import { o11Studio } from '../o11-studio.mjs';
import { sha256, writeIndex } from './fixtures/module-index.mjs';

const { isWrite, withStudioWriteLock, BUSY_CODE } = lock;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const noReader = async () => { throw new Error('the reader must not be called on a stored index'); };
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
const TEXT = name => 'capture of ' + name;

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atritos-b-map-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'); fs.mkdirSync(root, { recursive: true });
  const store = path.join(base, 'store');
  const env = { ...process.env, USERPROFILE: path.join(base, 'home'), SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(base, 'readers'), ANVIL_LANE: 'ss4' };
  // Every module's capture has its index stored: the map answers from the store, no reader runs.
  for (const name of ['A', 'B', 'C', 'D']) writeIndex(store, 'o11', sha256(Buffer.from(TEXT(name))));
  // o11-environment.mjs downloadModule (contract I7) as a fake: the published OML of a module, in its own folder.
  const downloads = [];
  const download = async ({ module }) => {
    downloads.push(module);
    const folder = path.join(root, '.local', 'environment', 'download', String(downloads.length));
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, module + '.oml'); fs.writeFileSync(file, TEXT(module));
    return { ok: true, file, module, key: 'P' + module, versionId: 7, folder };
  };
  return { base, root, env, download, downloads, lockDeps: { o11Root: root, odcRoot: root, o11Lane: 'ss4', connection: () => null } };
}

// The O11 bridge as the Studio answers: open tabs with their keys; snapshot_module by module_key captures that tab
// (C41) unless older (then only the active tab); open_module selects a tab (and opens it).
function fakeBridge({ open = [], active = null, older = false, holdFirstSnapshot = null } = {}) {
  const state = { open: [...open], active, calls: [], opening: 0, maxOpening: 0, snapshotsInFlight: 0, firstSnapshot: deferred() };
  let snapshots = 0;
  const client = {
    async ok(method, params = {}) {
      state.calls.push({ method, params });
      switch (method) {
        case 'list_open_modules':
          return { count: state.open.length, modules: state.open.map(name => ({ name, key: 'K' + name, hasESpace: true, hasOpenedActiveESpace: true, serverSilentMode: false, environment: 'env.test' })) };
        case 'open_module': {
          state.opening++; state.maxOpening = Math.max(state.maxOpening, state.opening);
          await new Promise(resolve => setTimeout(resolve, 20));
          if (!state.open.includes(params.name)) state.open.push(params.name);
          state.active = params.name; state.opening--;
          return { opened: true, name: params.name, alreadyOpen: false, elapsedMs: 20 };
        }
        case 'get_active_module': return { name: state.active, key: 'K' + state.active, environment: 'env.test' };
        case 'snapshot_module': {
          const name = String(params.module_key).slice(1);
          if (!state.open.includes(name)) throw Object.assign(new Error('Requested module identity is not open in any Studio tab; nothing was executed'), { code: 'BRIDGE_ERROR' });
          if (older && name !== state.active) throw Object.assign(new Error('Requested module identity is no longer active; nothing was executed'), { code: 'BRIDGE_ERROR' });
          snapshots++;
          if (snapshots === 1) state.firstSnapshot.resolve();
          if (snapshots === 1 && holdFirstSnapshot) await holdFirstSnapshot;
          fs.mkdirSync(path.dirname(params.path), { recursive: true });
          fs.writeFileSync(params.path, TEXT(name));
          return { path: params.path, sha256: sha256(Buffer.from(TEXT(name))).toUpperCase(), name, key: params.module_key, environment: 'env.test', snapshot_id: 's' + snapshots };
        }
        default: throw new Error('unexpected bridge call ' + method);
      }
    },
  };
  return { client, state, opened: () => state.calls.filter(c => c.method === 'open_module').map(c => c.params.name) };
}

// The capture of a module name over the fake bridge. A build without captureO11Module captured through the o11_studio
// snapshot (open_module, then the active tab), as its moduleMap did: the same fake answers it, so these rules fail there
// for the reason the sessions saw (STUDIO_WRITE_BUSY, a tab opened under a delivery), not for a missing export.
const captureWith = (s, bridge, extra = {}) => module => (typeof map.captureO11Module === 'function'
  ? map.captureO11Module(module, { env: s.env, lane: 'ss4', root: s.root, bridge: bridge.client, assertSelected: async () => {}, lockDeps: s.lockDeps, download: s.download, ...extra })
  : o11Studio({ bridge: bridge.client, assertSelected: extra.assertSelected ?? (async () => {}), lane: 'ss4', root: s.root, env: s.env })({ command: 'snapshot', args: { module } }));

// The ssam server with its real registerTool wrapper (the write lock of ssam.mjs) and a fake ODC lane server whose ssam_map
// is the real moduleMap over the fake bridge, as mcp.mjs registers it.
async function ssamWithMap(t, s, bridge) {
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('ssam_map', { description: 'Module map.', inputSchema: z.object({ lane: z.string(), target: z.string() }).strict() }, async args => {
      const value = await map.moduleMap(args, { env: s.env, read: noReader, captureO11: captureWith(s, bridge) });
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok ? {} : { isError: true }) };
    });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot: s.root, lock: s.lockDeps, answersRoot: s.root } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'atritos-b-map', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return target => client.callTool({ name: 'ssam_map', arguments: { lane: 'o11', target } }).then(valueOf);
}

test('classification: a map, discover or inspect naming an O11 module is not a write of the wrapper; opening one still is', () => {
  for (const [name, args] of [['ssam_map', { lane: 'o11', target: 'Orders' }], ['ssam_map', { lane: 'ss5', target: 'Orders_CS' }],
    ['ssam_discover', { lane: 'o11', intent: 'x', app: 'Orders' }], ['o11_inspect', { module: 'Orders' }], ['o11_inspect', { module: 'Orders', path: '@k' }]])
    assert.equal(isWrite(name, args), false, name + ' ' + JSON.stringify(args));
  assert.equal(isWrite('o11_studio', { command: 'open-module', args: { name: 'Orders' } }), true);
  assert.equal(isWrite('o11_studio', { command: 'snapshot', args: { module: 'Orders' } }), true);
  assert.equal(isWrite('o11_deliver', { module: 'Orders', until: 'apply' }), true);
});

test('two concurrent ssam_map calls by open module name both answer; neither opens nor locks anything', async t => {
  const s = sandbox(t);
  const hold = deferred();
  const bridge = fakeBridge({ open: ['A', 'B'], active: 'A', holdFirstSnapshot: hold.promise });
  const call = await ssamWithMap(t, s, bridge);
  const first = call('A');
  await Promise.race([bridge.state.firstSnapshot.promise, first]); // A's capture is in flight (or A already answered without one)
  const second = await call('B');
  hold.resolve();
  const a = await first;
  assert.equal(second.ok, true, JSON.stringify(second)); assert.equal(a.ok, true, JSON.stringify(a));
  assert.notEqual(second.code, BUSY_CODE);
  assert.deepEqual([a.sourceSha256, second.sourceSha256], [sha256(Buffer.from(TEXT('A'))), sha256(Buffer.from(TEXT('B')))]);
  // Each capture named its own tab by key; no tab was selected and the active one stayed A.
  assert.deepEqual(bridge.state.calls.filter(c => c.method === 'snapshot_module').map(c => c.params.module_key).sort(), ['KA', 'KB']);
  assert.deepEqual(bridge.opened(), []); assert.equal(bridge.state.active, 'A');
  assert.deepEqual(fs.existsSync(path.join(s.root, '.local', 'locks')) ? fs.readdirSync(path.join(s.root, '.local', 'locks')) : [], []);
});

test('a map during a delivery answers from a fresh capture of an open module; a closed one from its published OML; nothing opens', async t => {
  const s = sandbox(t);
  const bridge = fakeBridge({ open: ['A', 'B'], active: 'A' });
  const call = await ssamWithMap(t, s, bridge);
  const gate = deferred();
  const delivery = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [{ op: 'x' }], authorize: 'pode' }, lane: 'o11', deps: s.lockDeps },
    async () => { await gate.promise; return 'entregue'; });
  // The open module B (and A, the one being delivered) is read by key while the delivery holds the lock.
  const b = await call('B'); const a = await call('A');
  assert.equal(b.ok, true, JSON.stringify(b)); assert.equal(a.ok, true, JSON.stringify(a));
  // C is not open (A29): its published OML answers while the delivery runs; no tab is selected or opened, no lock waits.
  const c = await call('C');
  assert.equal(c.ok, true, JSON.stringify(c)); assert.equal(c.capturedBy, map.PUBLISHED_CAPTURE);
  assert.notEqual(c.code, BUSY_CODE);
  assert.deepEqual(bridge.opened(), []); assert.equal(bridge.state.active, 'A');
  gate.resolve(); assert.equal(await delivery, 'entregue');
});

test('two concurrent maps of open modules an older bridge must select both answer: the selects wait in the queue, one at a time', async t => {
  const s = sandbox(t);
  const bridge = fakeBridge({ open: ['A', 'C', 'D'], active: 'A', older: true });
  const call = await ssamWithMap(t, s, bridge);
  const [c, d] = await Promise.all([call('C'), call('D')]);
  assert.equal(c.ok, true, JSON.stringify(c)); assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(bridge.opened().sort(), ['C', 'D']);
  assert.equal(bridge.state.maxOpening, 1, 'one open at a time on the Studio');
});

test('captureO11Module: an older bridge that captures only the selected tab and a module still opening go the select way; OutSystemsUI its published OML', async t => {
  const s = sandbox(t);
  // older bridge: the key of a tab that is not selected is refused before anything runs; the capture selects it under the lock
  const older = fakeBridge({ open: ['A', 'B'], active: 'A', older: true });
  const shot = await captureWith(s, older)('B');
  assert.equal(shot.ok, true, JSON.stringify(shot)); assert.equal(shot.module, 'B'); assert.deepEqual(older.opened(), ['B']);
  // the open tab of the current bridge: read by key, marked as such
  const current = fakeBridge({ open: ['A', 'B'], active: 'A' });
  const read = await captureWith(s, current)('b'); // the name in another case reaches the open tab (studio-module.mjs rules)
  assert.deepEqual([read.ok, read.module, read.key, read.capturedBy], [true, 'B', 'KB', map.OPEN_TAB_CAPTURE]);
  assert.deepEqual(current.opened(), []);
  // a tab still opening is not read: the select way waits for it
  const opening = fakeBridge({ open: ['A'], active: 'A' });
  const list = opening.client.ok;
  opening.client.ok = async (method, params) => method === 'list_open_modules'
    ? { modules: [{ name: 'A', key: 'KA', hasESpace: true, hasOpenedActiveESpace: false }] } : list(method, params);
  assert.equal((await captureWith(s, opening)('A')).ok, true); assert.deepEqual(opening.opened(), ['A']);
  // OutSystemsUI is never captured as an editable module (A29): its published OML, without any bridge call of the capture
  const osui = fakeBridge({ open: ['OutSystemsUI'], active: 'OutSystemsUI' });
  const published = await captureWith(s, osui)('OutSystems UI');
  assert.deepEqual([published.ok, published.module, published.capturedBy], [true, 'OutSystemsUI', map.PUBLISHED_CAPTURE]);
  assert.deepEqual(osui.state.calls.map(c => c.method), []);
  // a selected Studio that changed is not read: refused as o11_studio refuses it, nothing asked of the bridge
  const moved = fakeBridge({ open: ['A'], active: 'A' });
  const notSelected = await map.captureO11Module('A', { env: s.env, lane: 'ss4', root: s.root, bridge: moved.client, lockDeps: s.lockDeps,
    assertSelected: async () => { throw new Error('The selected Studio was restarted.'); } });
  assert.equal(notSelected.code, 'O11_NOT_SELECTED'); assert.deepEqual(moved.state.calls, []);
});

test('o11_inspect {module} reads an open module by key beside a running delivery; it never opens one under it', async t => {
  const s = sandbox(t);
  const bridge = fakeBridge({ open: ['A', 'B'], active: 'A' });
  const reads = [];
  const server = new McpServer({ name: 'atritos-b-inspect', version: '1' });
  registerO11Cycle(server, { root: s.root, env: s.env, lane: 'ss4', tasksDir: path.join(s.base, 'tasks'), readerCheck: null, bridge: bridge.client,
    assertSelected: async () => {}, lock: s.lockDeps,
    read: async (entry, args) => { reads.push(args); return { ok: true, data: { schema: 'ssam-reading/1', path: '/', tree: { kind: 'ESpace', name: 'B' } } }; } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const gate = deferred();
  const delivery = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [{ op: 'x' }] }, lane: 'o11', deps: s.lockDeps }, () => gate.promise);
  const read = valueOf(await client.callTool({ name: 'o11_inspect', arguments: { module: 'B' } }));
  assert.equal(read.capture?.module, 'B', JSON.stringify(read));
  assert.equal(reads.length, 1); assert.deepEqual(bridge.opened(), []);
  // A closed module (A29) is read from its published OML, never opened under the delivery: pa2-f4-read.test.mjs, with an
  // injected download (this registration would reach the real o11-environment.mjs download).
  assert.deepEqual(bridge.opened(), []);
  gate.resolve(); await delivery;
});
