// Package 3, lane mb2 (owner rule 2026-10-07): the Service Studio dialog "Incompatible or missing dependencies found" never
// stops a call. With a bridge that offers dialogs:dependencies_auto, o11_studio open-module, wait, status and
// refresh-references, and o11_publish answer it (Cancel, answer_dependencies_dialog), refresh every producer of the module
// by its key (refresh_references) and go on, listing the dialog and referencesRefreshed; an older bridge keeps the dialog
// for the person. Also (live 2026-10-07, DCIPS): a module whose tab is in the Studio's second window is published,
// captured and refreshed by its key instead of MODULE_NOT_ACTIVE. Fake bridges on loopback ports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { o11Studio } from '../o11-studio.mjs';
import { createO11Publish } from '../o11-publish.mjs';
import { deliverOutcome } from '../o11-cycle.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

const HOST = 'dev.example.com';
const ok = data => ({ success: true, data, error: null });
const fail = (error, extra = {}) => ({ success: false, data: null, error, ...extra });
const DEPENDENCIES = { kind: 'WebDialog', type: 'DialogWindow', title: '', source: 'window', contentKind: 'web', texts: [], hint: 'a web dialog is open in the Studio' };
const ANSWERED = { kind: 'DependenciesDialog', title: 'Incompatible or missing dependencies found', answer: 'Cancel', text: 'Incompatible or missing dependencies found' };
const CAPABLE = ['dialogs:dependencies_auto', 'merge_from_oml:module_key', 'refresh_references'];

function folders(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-mb2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sub = name => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); return p; };
  return { root: sub('root'), env: { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4', USERPROFILE: sub('home'), HOME: path.join(dir, 'home'),
    APPDATA: sub('appdata'), LOCALAPPDATA: sub('localappdata'), ANVIL_AUTHORITY_DIR: sub('authority') }, dir };
}

// A Studio with Consumer (key kc) open and the dependencies dialog showing until the bridge answers it. state.capabilities:
// what bridge_manifest offers; state.active: the selected tab; state.modules: the tabs of every window.
async function studio(t, initial = {}) {
  const s = { capabilities: CAPABLE, dialog: true, active: 'Consumer', blockOpen: false, refreshFails: false, publishes: [],
    modules: [{ name: 'Consumer', key: 'kc', hasESpace: true, hasOpenedActiveESpace: true, environment: HOST, window: 0, pendingDialogs: [] }], ...initial };
  const requests = [];
  const tab = name => s.modules.find(m => m.name === name);
  const fake = await fakeBridge(async request => {
    requests.push(request);
    const p = request.params ?? {};
    switch (request.method) {
      case 'bridge_manifest': return ok({ bridge: 'anvil', protocolVersion: 2, capabilities: s.capabilities });
      case 'ping': return ok({ pid: 1, bridge: 'anvil', version: '9' });
      case 'ui_alive': return ok({ alive: true });
      case 'open_module':
        if (s.blockOpen && s.dialog) return ok({ name: p.name, opened: false, blockedBy: [DEPENDENCIES], hint: 'a web dialog is open in the Studio; then call open_module again' });
        return ok({ name: p.name, opened: true, alreadyOpen: true, selected: true, elapsedMs: 3, referencesCheck: s.check ?? (s.dialog ? 'skipped' : 'complete') });
      case 'answer_dependencies_dialog': {
        const answered = s.dialog ? [ANSWERED] : [];
        s.dialog = false;
        return ok({ answered, count: answered.length, module: null, moduleKey: null });
      }
      case 'get_active_module': {
        const m = tab(s.active) ?? { name: s.active, key: 'k-' + s.active, environment: HOST };
        return ok({ name: m.name, key: m.key, environment: HOST, pendingDialogs: s.dialog ? [DEPENDENCIES] : [] });
      }
      case 'list_open_modules': return ok({ count: s.modules.length, modules: s.modules, environments: [HOST], dialogs: s.dialog ? [DEPENDENCIES] : [] });
      case 'windows': return ok({ count: 0, windows: [] });
      case 'refresh_references':
        if (s.dialog && !p.answer_dependencies) return fail("InvalidOperationException: refresh_references: 'Consumer' has a dialog or merge editor pending in the Studio (WebDialog); nothing was refreshed", { executed: false });
        if (s.refreshFails) return fail("refresh_references: 'Consumer' did not end within 600 s; its outcome is unknown.");
        return ok({ module: 'Consumer', moduleKey: p.module_key, changed: true, refreshed: ['Producer'], upToDate: ['Other'], newErrors: 0 });
      case 'get_errors': return ok({ isValid: true, errors: 0, warnings: 0, total: 0, byType: {}, messages: [], rawMessages: [] });
      case 'snapshot_module': return ok({ path: p.path, sha256: 'ab'.repeat(32), name: 'Consumer', key: p.module_key, environment: HOST, snapshot_id: 's1' });
      case 'publish':
        s.publishes.push(p);
        if (s.dialog) return ok({ module: 'Consumer', published: false, code: 'PUBLISH_BLOCKED_BY_DIALOG', outcome: 'not-started', blockedBy: [{ ...DEPENDENCIES, kind: 'ManageDependencies' }], dialogsSeen: [] });
        return ok({ module: 'Consumer', published: true, state: 'CompletedWithSuccessNotOpenedInBrowser' });
      default: return fail('Unknown method: ' + request.method);
    }
  });
  t.after(() => fake.close());
  const f = folders(t);
  let clock = Date.UTC(2026, 9, 7, 18, 20, 0);
  const client = () => o11Bridge({ port: fake.port, authorization: 'K' });
  const run = o11Studio({ bridge: client, assertSelected: async () => {}, lane: 'ss4', root: f.root, env: f.env,
    now: () => clock, delay: async ms => { clock += ms; }, inventory: async () => null, writeHolder: () => null });
  const publish = createO11Publish({ root: f.root, env: f.env, lane: 'ss4', now: () => new Date(clock += 1000), bridge: client,
    assertSelected: async () => {}, tasksDir: path.join(f.dir, 'tasks'), journal: () => {}, grants: { findGrant: () => null, wordsFor: () => ({ words: '' }) } });
  return { s, run, publish, f, methods: () => requests.map(r => r.method), sent: method => requests.filter(r => r.method === method).map(r => r.params ?? {}) };
}

test('MB2: open-module answers the dependencies dialog that stopped the open, opens again and refreshes every producer by key', async t => {
  const h = await studio(t, { blockOpen: true });
  const value = await h.run({ command: 'open-module', args: { name: 'Consumer' } });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.dependenciesDialog.answered.map(a => a.answer), ['Cancel']);
  assert.deepEqual(value.referencesRefreshed.refreshed, ['Producer']);
  assert.equal(value.referencesOutdated, undefined);
  const refresh = h.sent('refresh_references')[0];
  assert.equal(refresh.module_key, 'kc'); assert.equal(refresh.producers, undefined);   // every producer, by the tab's key
  assert.deepEqual(h.methods(), ['open_module', 'bridge_manifest', 'answer_dependencies_dialog', 'open_module', 'list_open_modules', 'refresh_references']);
});

test('MB2: an older bridge keeps the dialog for the person: DIALOG_BLOCKING as before, nothing answered', async t => {
  const h = await studio(t, { blockOpen: true, capabilities: ['refresh_references'] });
  const value = await h.run({ command: 'open-module', args: { name: 'Consumer' } });
  assert.equal(value.ok, false); assert.equal(value.code, 'DIALOG_BLOCKING');
  assert.ok(!h.methods().includes('answer_dependencies_dialog'));
  assert.ok(!h.methods().includes('refresh_references'));
});

test('MB2: a dialog left open after the load (its check skipped) is answered by open-module too', async t => {
  const h = await studio(t);
  const value = await h.run({ command: 'open-module', args: { name: 'Consumer' } });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.dependenciesDialog.answered.length, 1);
  assert.equal(h.s.dialog, false);
  assert.equal(h.sent('refresh_references')[0].module_key, 'kc');
});

test('MB2: wait no-dialogs and status answer the dialog and refresh the module, never wait for the person', async t => {
  const h = await studio(t);
  const waited = await h.run({ command: 'wait', args: { condition: 'no-dialogs', timeoutSeconds: 5 } });
  assert.equal(waited.ok, true, JSON.stringify(waited));
  assert.deepEqual(waited.dialogs, []);
  assert.equal(waited.dependenciesDialog.answered[0].answer, 'Cancel');
  assert.equal(waited.referencesRefreshed.module, 'Consumer');
  const again = await studio(t);
  const status = await again.run({ command: 'status' });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.deepEqual(status.pendingDialogs, []);
  assert.deepEqual(status.referencesRefreshed.refreshed, ['Producer']);
  assert.equal(again.methods().filter(m => m === 'bridge_manifest').length, 1, 'status reads the manifest once');
});

test('MB2: a refresh that fails answers REFERENCES_REFRESH_FAILED with the module and the next call, never a silent wait', async t => {
  const h = await studio(t, { refreshFails: true });
  const value = await h.run({ command: 'wait', args: { condition: 'no-dialogs', timeoutSeconds: 5 } });
  assert.equal(value.ok, false); assert.equal(value.code, 'REFERENCES_REFRESH_FAILED');
  assert.equal(value.module, 'Consumer');
  assert.deepEqual(value.continuation.arguments, { command: 'refresh-references', args: { module: 'Consumer' } });
});

test('MB2: refresh-references refused by the pending dialog answers it and refreshes in the same call', async t => {
  // The open's own reference check completed, so only the refresh meets the dialog (the bridge refuses it as pending).
  const h = await studio(t, { check: 'complete' });
  const value = await h.run({ command: 'refresh-references', args: { module: 'Consumer' } });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(h.s.dialog, false);
  assert.deepEqual(value.refreshed, ['Producer']);
  assert.equal(value.dependenciesDialog.answered[0].answer, 'Cancel');
  assert.equal(h.sent('refresh_references').length, 2);
});

test('MB2: o11_publish answers the dialog in the active tab, refreshes and publishes in one call', async t => {
  const h = await studio(t);
  h.s.dialog = true;
  const value = await h.publish({ module: 'Consumer', authorize: 'sim, publique o Consumer' });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.dependenciesDialog.answered[0].answer, 'Cancel');
  assert.deepEqual(value.referencesRefreshed.refreshed, ['Producer']);
  assert.equal(h.s.publishes.length, 1);
});

test('MB2: a publication the dialog stopped before the server is answered, refreshed and published again once', async t => {
  const h = await studio(t, { dialog: false });
  let shown = false;
  // The dialog shows only when the publication starts (the open and the reads saw none).
  const original = h.s.publishes;
  h.s.publishes = new Proxy(original, { get: (target, key) => { if (key === 'push' && !shown) { shown = true; h.s.dialog = true; } return Reflect.get(target, key); } });
  const value = await h.publish({ module: 'Consumer', authorize: 'sim, publique o Consumer' });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(original.length, 2);
  assert.equal(original[1].answer_dependencies, true);
  assert.equal(value.dependenciesDialog.answered.length, 1);
  assert.equal(h.sent('refresh_references')[0].module_key, 'kc');
});

test('DCIPS: o11_publish publishes a module of the second window by its key instead of MODULE_NOT_ACTIVE', async t => {
  const modules = [{ name: 'DCIPS_Staff_Common', key: 'kx', hasESpace: true, hasOpenedActiveESpace: true, environment: HOST, window: 0, pendingDialogs: [] },
    { name: 'Consumer', key: 'kc', hasESpace: true, hasOpenedActiveESpace: true, environment: HOST, window: 1, pendingDialogs: [] }];
  const h = await studio(t, { dialog: false, active: 'DCIPS_Staff_Common', modules });
  const value = await h.publish({ module: 'Consumer', authorize: 'sim, publique o Consumer' });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(h.sent('publish')[0].module_key, 'kc');
  assert.equal(h.sent('get_errors')[0].module_key, 'kc');
  // snapshot and refresh-references {module} go by the same key
  const snap = await h.run({ command: 'snapshot', args: { module: 'Consumer', path: path.join(h.f.dir, 'c.oml') } });
  assert.equal(snap.ok, true, JSON.stringify(snap)); assert.equal(h.sent('snapshot_module')[0].module_key, 'kc');
  const refreshed = await h.run({ command: 'refresh-references', args: { module: 'Consumer' } });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed)); assert.equal(h.sent('refresh_references').at(-1).module_key, 'kc');
});

test('DCIPS: two tabs of the name are MODULE_TAB_AMBIGUOUS; a bridge without module_key still answers MODULE_NOT_ACTIVE', async t => {
  const twins = [{ name: 'Other', key: 'ko', hasESpace: true, environment: HOST, pendingDialogs: [] },
    { name: 'Consumer', key: 'k1', hasESpace: true, environment: HOST, pendingDialogs: [] }, { name: 'Consumer', key: 'k2', hasESpace: true, environment: HOST, pendingDialogs: [] }];
  const a = await studio(t, { dialog: false, active: 'Other', modules: twins });
  const ambiguous = await a.publish({ module: 'Consumer', authorize: 'sim, publique o Consumer' });
  assert.equal(ambiguous.code, 'MODULE_TAB_AMBIGUOUS', JSON.stringify(ambiguous));
  assert.equal(a.sent('publish').length, 0);
  const one = [{ name: 'Other', key: 'ko', hasESpace: true, environment: HOST, pendingDialogs: [] }, { name: 'Consumer', key: 'kc', hasESpace: true, environment: HOST, pendingDialogs: [] }];
  const old = await studio(t, { dialog: false, active: 'Other', modules: one, capabilities: [] });
  const refused = await old.publish({ module: 'Consumer', authorize: 'sim, publique o Consumer' });
  assert.equal(refused.code, 'MODULE_NOT_ACTIVE', JSON.stringify(refused));
  assert.equal(old.sent('publish').length, 0);
});

test('MB2: o11_deliver lists referencesRefreshed of the receipt, and a failed refresh carries its next call', () => {
  const delivered = deliverOutcome({ envelope: { data: { delivered: true, writeState: 'applied', taskId: 'a'.repeat(32),
    referencesRefreshed: [{ stage: 'open', module: 'Consumer', moduleKey: 'kc', changed: true, refreshed: ['Producer'], upToDate: [], dialog: [ANSWERED] }] } } },
  { trackId: 't', work: os.tmpdir(), job: null, taskId: null });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  assert.deepEqual(delivered.referencesRefreshed, [{ stage: 'open', module: 'Consumer', changed: true, refreshed: ['Producer'],
    dialog: [{ kind: 'DependenciesDialog', title: ANSWERED.title, answer: 'Cancel' }] }]);
  const next = { tool: 'o11_studio', arguments: { command: 'refresh-references', args: { module: 'Consumer' } }, why: 'x' };
  const refused = deliverOutcome({ envelope: { data: { delivered: false, writeState: 'not-sent', stage: 'refresh-references', taskId: 'b'.repeat(32),
    code: 'REFERENCES_REFRESH_FAILED', error: 'The Studio showed the dependencies dialog for Consumer', referencesRefreshFailed: { module: 'Consumer', next } } } },
  { trackId: 't', work: os.tmpdir(), job: null, taskId: null });
  assert.equal(refused.code, 'REFERENCES_REFRESH_FAILED');
  assert.deepEqual(refused.continuation, next);
});
