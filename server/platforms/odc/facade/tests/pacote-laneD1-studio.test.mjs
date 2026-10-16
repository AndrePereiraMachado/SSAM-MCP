// Lane D1 of the 2026-10-05 session package: o11_studio, the write lock and o11_publish rules with fake bridges (no
// Studio, no port unless a fake one). C31 (idle, waits, cancellation), C41 (module names by the inventory), C26
// (refresh-references, consumers), C10 (dialogsSeen), I7 (signal), C24 (o11_data batch is a write).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { o11Studio, matchModuleName, readInventory, lastPublicationOf } from '../o11-studio.mjs';
import { withStudioWriteLock, isWrite, studioWriteHolder, CANCELLED_CODE } from '../studio-write-lock.mjs';
import { createO11Publish, publishOutcome, consumerNames } from '../o11-publish.mjs';
import { BridgeError } from '../o11-bridge.mjs';

// A fake bridge client: ok(method, params, options) answers from the table (a value, or a function of the params).
function bridge(table) {
  const calls = [];
  return { calls, async ok(method, params = {}, options) {
    calls.push({ method, params });
    const entry = table[method];
    if (entry === undefined) throw new BridgeError('Unknown method: ' + method, { code: 'BRIDGE_ERROR', method, reply: { success: false } });
    return typeof entry === 'function' ? entry(params, options) : entry;
  } };
}
const fastClock = () => { let t = 0; return { now: () => t, delay: async ms => { t += ms; } }; };

// ---- C31: idle
test('wait idle is not idle while a server operation runs or an SSAM write holds the Studio', async () => {
  let running = true;
  const fake = bridge({ ui_alive: { alive: true }, list_open_modules: () => ({ modules: [{ name: 'Orders', hasESpace: true, serverOperation: running ? { running: true, verb: 'Publish' } : null }] }) });
  const clock = fastClock();
  const busy = await o11Studio({ bridge: fake, assertSelected: async () => {}, ...clock, writeHolder: () => null })({ command: 'wait', args: { condition: 'idle', timeoutSeconds: 2 } });
  assert.equal(busy.ok, false); assert.equal(busy.code, 'WAIT_TIMEOUT');
  assert.deepEqual(busy.last.serverOperations, [{ module: 'Orders', verb: 'Publish' }]);
  running = false;
  const locked = await o11Studio({ bridge: fake, assertSelected: async () => {}, ...fastClock(), writeHolder: () => ({ tool: 'o11_publish', startedAt: 'now' }) })
    ({ command: 'wait', args: { condition: 'idle', timeoutSeconds: 2 } });
  assert.equal(locked.ok, false); assert.deepEqual(locked.last.writeLock, { tool: 'o11_publish', startedAt: 'now' });
  const idle = await o11Studio({ bridge: fake, assertSelected: async () => {}, ...fastClock(), writeHolder: () => null })({ command: 'wait', args: { condition: 'idle', timeoutSeconds: 2 } });
  assert.equal(idle.ok, true);
  const status = await o11Studio({ bridge: bridge({ ping: { pid: 1, bridge: 'anvil', version: 'x' }, bridge_manifest: { protocolVersion: 2 }, get_active_module: { name: 'Orders', key: 'k' },
    list_open_modules: { modules: [{ name: 'Orders', hasESpace: true, serverOperation: { running: true, verb: 'Publish' } }] }, ui_alive: { alive: true } }), assertSelected: async () => {} })({ command: 'status' });
  assert.equal(status.busy, true); assert.deepEqual(status.serverOperations, [{ module: 'Orders', verb: 'Publish' }]);
});

test('the idle wait reads the write lock of the Studio: a write held in this process makes it busy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-d1-lock-'));
  const deps = { o11Root: root, odcRoot: path.join(root, 'odc'), o11Lane: 'ss4' };
  let release; const holding = new Promise(resolve => { release = resolve; });
  const write = withStudioWriteLock({ tool: 'o11_publish', args: { module: 'M-SYNTH-ARG-0001', authorize: 'SYNTH-WORDS-0001' }, lane: 'o11', deps }, () => holding);
  // A08: the holder names its process too ({tool, pid, startedAt}), never its arguments. CX14 (declared): it also says how
  // long it holds the Studio and in which state (heldMs, state: running | stalled | pending-in-studio); the CX14 fields
  // that may follow come from a whitelist (task ids, operation, blockedBy {title, kind}), never arguments or user words.
  assert.deepEqual(Object.keys(studioWriteHolder({ lane: 'ss4', deps }) ?? {}).sort(), ['heldMs', 'pid', 'startedAt', 'state', 'tool']);
  assert.equal(studioWriteHolder({ lane: 'ss4', deps }).state, 'running');
  assert.ok(!/SYNTH-(ARG|WORDS)/.test(JSON.stringify(studioWriteHolder({ lane: 'ss4', deps }))));
  for (const file of fs.readdirSync(path.join(root, '.local', 'locks'))) assert.ok(!/SYNTH-(ARG|WORDS)/.test(fs.readFileSync(path.join(root, '.local', 'locks', file), 'utf8')), file);
  assert.equal(studioWriteHolder({ lane: 'ss4', deps }).pid, process.pid);
  assert.equal(studioWriteHolder({ lane: 'ss4', deps }).tool, 'o11_publish');
  release(); await write;
  assert.equal(studioWriteHolder({ lane: 'ss4', deps }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- I7 / C31: cancellation
test('a cancelled call never starts a write, and a cancelled wait answers CANCELLED at once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-d1-cancel-'));
  const deps = { o11Root: root, odcRoot: path.join(root, 'odc'), o11Lane: 'ss4' };
  const controller = new AbortController(); controller.abort();
  let ran = false;
  const refused = await withStudioWriteLock({ tool: 'o11_publish', args: { module: 'M' }, lane: 'o11', deps, signal: controller.signal }, async () => { ran = true; });
  assert.equal(refused.code, CANCELLED_CODE); assert.equal(ran, false);
  // A wait cancelled while it waits: the delay ends on abort, the answer is CANCELLED/uncertain, the lock of the call ends with it.
  const waiting = new AbortController();
  const fake = bridge({ ui_alive: { alive: false }, list_open_modules: { modules: [] } });
  const run = o11Studio({ bridge: fake, assertSelected: async () => {}, delay: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 50))) });
  const pending = withStudioWriteLock({ tool: 'o11_studio', args: { command: 'wait', args: { condition: 'open', module: 'M' } }, lane: 'o11', deps },
    () => run({ command: 'wait', args: { condition: 'idle', timeoutSeconds: 600 } }, { signal: waiting.signal }));
  setTimeout(() => waiting.abort(), 30);
  const cancelled = await pending;
  assert.equal(cancelled.code, 'CANCELLED'); assert.equal(cancelled.outcome, 'uncertain');
  assert.equal(studioWriteHolder({ lane: 'ss4', deps }), null, 'the lock is released');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a publication cancelled while it waits for the Studio answers CANCELLED/uncertain and frees the lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-d1-pubcancel-'));
  const deps = { o11Root: root, odcRoot: path.join(root, 'odc'), o11Lane: 'ss4' };
  const controller = new AbortController();
  const fake = bridge({ open_module: { name: 'Orders', opened: true, alreadyOpen: true, selected: true }, get_active_module: { name: 'Orders', key: 'k', environment: 'h.example', pendingDialogs: [] },
    get_errors: { isValid: true, errors: 0, rawMessages: [] },
    publish: (params, options) => new Promise((resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new BridgeError('Bridge publish cancelled', { code: 'CANCELLED', method: 'publish' })))) });
  const run = createO11Publish({ root, env: { ANVIL_LANE: 'ss4' }, lane: 'ss4', bridge: fake, assertSelected: async () => {}, journal: () => {}, tasksDir: path.join(root, 'tasks'),
    grants: { findGrant: () => null }, inventory: () => null });
  const pending = withStudioWriteLock({ tool: 'o11_publish', args: { module: 'Orders' }, lane: 'o11', deps }, () => run({ module: 'Orders', authorize: 'pode publicar o Orders' }, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 30);
  const value = await pending;
  assert.equal(value.code, 'CANCELLED'); assert.equal(value.outcome, 'uncertain');
  assert.equal(studioWriteHolder({ lane: 'ss4', deps }), null);
  assert.equal(publishOutcome({ error: { code: 'CANCELLED', executed: false } }, { name: 'Orders' }).outcome, 'not-sent');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- C41: module names by the inventory
test('open-module with an unknown name is refused at once with suggestions, without open_module; a label reaches the module', async () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-d1-inventory-'));
  const folder = path.join(local, 'environment', 'inventory', '20261005T100000');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'inventory.json'), JSON.stringify({ host: 'dev.example.com', capturedAtUtc: '2026-10-05T10:00:00Z',
    modules: [{ name: 'GameStore_CS', key: 'k1', applicationName: 'GameStore' }, { name: 'GameStore', key: 'k2', applicationName: 'GameStore' }, { name: 'OfficePet', key: 'k3', applicationName: 'OfficePet' }] }));
  const inventory = readInventory({ local });
  assert.equal(inventory.host, 'dev.example.com'); assert.equal(inventory.modules.length, 3);
  const fake = bridge({ list_open_modules: { modules: [] }, open_module: params => ({ name: params.name, opened: true, selected: true }) });
  const run = o11Studio({ bridge: fake, assertSelected: async () => {}, inventory: async () => inventory });
  const started = Date.now();
  const unknown = await run({ command: 'open-module', args: { name: 'GameStor_CZ' } });
  assert.ok(Date.now() - started < 1000);
  assert.equal(unknown.code, 'MODULE_NOT_FOUND'); assert.ok(unknown.suggestions.includes('GameStore_CS'), JSON.stringify(unknown));
  assert.equal(fake.calls.filter(c => c.method === 'open_module').length, 0);
  const label = await run({ command: 'open-module', args: { name: 'GameStore CS' } });
  assert.equal(label.ok, true, JSON.stringify(label));
  assert.equal(fake.calls.find(c => c.method === 'open_module').params.name, 'GameStore_CS');
  assert.deepEqual(matchModuleName('officepet', ['OfficePet', 'OfficePetMobile']), { name: 'OfficePet' });
  fs.rmSync(local, { recursive: true, force: true });
});

// ---- C26: refresh-references
test('refresh-references runs the bridge verb on the module; an older bridge refuses with BRIDGE_OUTDATED', async () => {
  const fake = bridge({ open_module: { name: 'Consumer', opened: true, selected: true }, get_active_module: { name: 'Consumer', key: 'kc', environment: 'h.example' },
    refresh_references: params => ({ module: 'Consumer', changed: true, refreshed: ['Producer'], upToDate: [], missing: [], newErrors: 0, undo: 'Ctrl+Z', echo: params }) });
  const run = o11Studio({ bridge: fake, assertSelected: async () => {}, inventory: async () => null });
  const value = await run({ command: 'refresh-references', args: { module: 'Consumer', producers: ['Producer'] } });
  assert.equal(value.ok, true); assert.deepEqual(value.refreshed, ['Producer']); assert.equal(value.changed, true);
  const sent = fake.calls.find(c => c.method === 'refresh_references').params;
  assert.deepEqual(sent, { module_key: 'kc', environment: 'h.example', producers: ['Producer'], timeout: 600 });
  const old = bridge({ get_active_module: { name: 'Consumer', key: 'kc' } });
  const outdated = await o11Studio({ bridge: old, assertSelected: async () => {} })({ command: 'refresh-references' });
  assert.equal(outdated.code, 'BRIDGE_OUTDATED'); assert.equal(outdated.continuation.tool, 'ssam_doctor');
});

test('consumers:true refreshes and publishes every consumer with one outcome each; dialogsSeen and STUDIO_BUSY_TIMEOUT come back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-d1-consumers-'));
  let active = 'Producer';
  const fake = bridge({ open_module: params => { active = params.name; return { name: params.name, opened: true, selected: true }; },
    get_active_module: () => ({ name: active, key: 'k-' + active, environment: 'h.example', pendingDialogs: [] }), get_errors: { isValid: true, errors: 0, rawMessages: [] },
    refresh_references: () => ({ module: active, changed: true, refreshed: ['Producer'] }),
    publish: () => ({ module: active, published: true, dialogsSeen: active === 'Producer' ? ['login: Sign in'] : [] }) });
  const run = createO11Publish({ root, env: { ANVIL_LANE: 'ss4' }, lane: 'ss4', bridge: fake, assertSelected: async () => {}, journal: () => {}, tasksDir: path.join(root, 'tasks'),
    grants: { findGrant: () => null }, inventory: () => null, consumersOf: async () => ({ data: { rows: [{ Name: 'ConsumerA' }, { Name: 'ConsumerB' }, { Name: 'Producer' }] } }) });
  const value = await run({ module: 'Producer', authorize: 'pode publicar o Producer e os consumidores', consumers: true });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.consumers, [{ module: 'ConsumerA', outcome: 'published' }, { module: 'ConsumerB', outcome: 'published' }]);
  assert.deepEqual(value.dialogsSeen, ['login: Sign in']);
  assert.equal(fake.calls.filter(c => c.method === 'refresh_references').length, 2);
  assert.equal(fake.calls.filter(c => c.method === 'publish').length, 3);
  assert.deepEqual(consumerNames([{ ConsumerName: 'B' }, { ConsumerName: 'A' }], 'X'), ['A', 'B']);
  // The bridge waited for the operation already running and the wait expired: STUDIO_BUSY_TIMEOUT with the verb.
  const busy = publishOutcome({ error: new BridgeError("'Orders' has a server operation running (Publish) that did not end within 600 s; nothing was published",
    { code: 'BRIDGE_ERROR', method: 'publish', reply: { success: false } }) }, { name: 'Orders' });
  assert.equal(busy.code, 'STUDIO_BUSY_TIMEOUT'); assert.equal(busy.verb, 'Publish');
  assert.deepEqual(lastPublicationOf({ found: true, status: 'failed', triggeredBy: 'studio', endedAt: 'e' }), { at: 'e', status: 'failed', version: null, author: null, by: 'person', source: 'publish-log' });
  assert.equal(lastPublicationOf({ found: false }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- C24: o11_data batch
test('an o11_data batch with any write is a write of the Studio; a read-only batch is not', () => {
  assert.equal(isWrite('o11_data', { request: { batch: [{ operation: 'read', entity: 'E' }, { operation: 'update', entity: 'E', records: [] }] } }), true);
  assert.equal(isWrite('o11_data', { request: { authorization: 'x', batch: [{ operation: 'read-all', entity: 'E' }] } }), false);
  assert.equal(isWrite('ssam_grant', { action: 'grant' }), false);
  assert.equal(isWrite('ssam_task', { id: 'a'.repeat(32), close: { reason: 'r' } }), true);
  assert.equal(isWrite('o11_studio', { command: 'refresh-references' }), true);
});
