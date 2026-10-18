// Package 3, lane mb: the O11 Studio interaction. C10: one dialog detector for wait, status and o11_publish (a Manage
// Dependencies presenter of another tab is seen), a publication the bridge stopped behind a dialog answers
// PUBLISH_BLOCKED_BY_DIALOG with the next call, and outdated references are refreshed before the publication. C22:
// close-module closes a tab through the bridge's guard; status names the windows. Fake bridges on loopback ports only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { o11Studio, allDialogs } from '../o11-studio.mjs';
import { createO11Publish, publishOutcome } from '../o11-publish.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { studioBridge } from './fixtures/o11-studio-bridge.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

const HOST = 'dev.example.com';
const ok = data => ({ success: true, data, error: null });
const fail = error => ({ success: false, data: null, error });
const REFERENCES = { kind: 'ManageDependencies', type: 'AddRemoveReferencesPresenter', source: 'presenter', hint: 'the references dialog is open' };

function folders(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-mb-studio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sub = name => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); return p; };
  return { root: sub('root'), env: { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4', USERPROFILE: sub('home'), HOME: path.join(dir, 'home'),
    APPDATA: sub('appdata'), LOCALAPPDATA: sub('localappdata'), ANVIL_AUTHORITY_DIR: sub('authority') }, dir };
}
async function studioRunner(t, initial) {
  const fake = await studioBridge(initial);
  t.after(() => fake.close());
  const f = folders(t);
  let clock = Date.UTC(2026, 9, 7, 12, 0, 0);
  const run = o11Studio({ bridge: o11Bridge({ port: fake.port, authorization: 'K' }), assertSelected: async () => {}, lane: 'ss4', root: f.root, env: f.env,
    now: () => clock, delay: async ms => { clock += ms; }, inventory: async () => null, writeHolder: () => null });
  return { fake, run, sent: method => fake.seen.filter(r => r.method === method) };
}

test('C10: wait no-dialogs sees a references dialog of another tab, which the active tab does not show', async t => {
  const modules = [{ name: 'Producer', key: 'kp', hasESpace: true, pendingDialogs: [] }, { name: 'Consumer', key: 'kc', hasESpace: true, pendingDialogs: [REFERENCES] }];
  const s = await studioRunner(t, { active: { name: 'Producer', key: 'kp', environment: HOST }, dialogs: [], modules,
    replies: { list_open_modules: () => ok({ count: 2, modules, environments: [HOST] }) } });
  const waited = await s.run({ command: 'wait', args: { condition: 'no-dialogs', timeoutSeconds: 2 } });
  assert.equal(waited.ok, false, JSON.stringify(waited));
  assert.equal(waited.code, 'WAIT_TIMEOUT');
  assert.deepEqual(waited.last.dialogs.map(d => [d.kind, d.module]), [['ManageDependencies', 'Consumer']]);
  // status shows the same dialog, with its module
  const status = await s.run({ command: 'status' });
  assert.deepEqual(status.pendingDialogs.map(d => [d.kind, d.module]), [['ManageDependencies', 'Consumer']]);
});

test('C10: the union names each dialog once, from the active tab, its otherDialogs and every listed module', () => {
  const window = { kind: 'Recovery', type: 'DialogWindow', title: 'Recover', source: 'window' };
  const union = allDialogs({ name: 'A', pendingDialogs: [window], otherDialogs: [window, { ...REFERENCES, module: 'B' }] },
    { modules: [{ name: 'B', pendingDialogs: [REFERENCES] }, { name: 'A', pendingDialogs: [] }], dialogs: [window] });
  assert.deepEqual(union.map(d => [d.kind, d.module ?? null]), [['Recovery', null], ['ManageDependencies', 'B']]);
});

test('C22: status names the windows and the tab each one holds', async t => {
  const modules = [{ name: 'Orders', key: 'k1', hasESpace: true, window: 0, pendingDialogs: [] }, { name: 'Orders', key: 'k2', hasESpace: true, window: 1, pendingDialogs: [] }];
  const windows = [{ index: 0, title: 'Service Studio', environment: HOST, modules: ['Orders'] }, { index: 1, title: 'Service Studio (2)', environment: HOST, modules: ['Orders'] }];
  const s = await studioRunner(t, { active: { name: 'Orders', key: 'k1', environment: HOST }, modules,
    replies: { list_open_modules: () => ok({ count: 2, modules, environments: [HOST], windows }) } });
  const status = await s.run({ command: 'status' });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.deepEqual(status.windows.map(w => [w.index, w.modules]), [[0, ['Orders']], [1, ['Orders']]]);
  assert.deepEqual(status.openModules.map(m => m.window), [0, 1]);
});

test('C22: close-module closes the tab through the bridge; a tab with unsaved changes is MODULE_TAB_NOT_CLOSABLE with the next call', async t => {
  let dirty = false;
  const s = await studioRunner(t, { replies: { close_module: p => dirty
    ? fail('InvalidOperationException: close_module: tab has unsaved changes, is opening, or has a pending operation; save or resolve it in Studio first')
    : ok({ name: p.name, closed: true }) } });
  const closed = await s.run({ command: 'close-module', args: { module: 'Orders' } });
  assert.deepEqual(closed, { ok: true, module: 'Orders', closed: true });
  assert.deepEqual(s.sent('close_module')[0].params, { name: 'Orders' });
  dirty = true;
  const refused = await s.run({ command: 'close-module', args: { name: 'Orders', moduleKey: 'k2' } });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'MODULE_TAB_NOT_CLOSABLE'); assert.equal(refused.outcome, 'not-sent');
  assert.deepEqual(refused.continuation, { tool: 'o11_publish', arguments: { module: 'Orders' }, why: refused.continuation.why });
  assert.deepEqual(s.sent('close_module')[1].params, { name: 'Orders', module_key: 'k2' });
});

// o11_publish over a programmable bridge (the shape of o11-publish.test.mjs).
async function publisher(t, { open, publish, active } = {}) {
  const f = folders(t);
  const requests = [];
  const fake = await fakeBridge(async request => {
    requests.push(request);
    switch (request.method) {
      case 'open_module': return ok({ name: request.params.name, opened: true, alreadyOpen: true, selected: true, elapsedMs: 3, ...open });
      case 'get_active_module': return ok({ name: 'Consumer', key: 'kc', kind: 'Web', environment: HOST, pendingDialogs: [], ...active });
      case 'refresh_references': return ok({ module: 'Consumer', changed: true, refreshed: [{ name: 'Producer', from: 3, to: 4 }] });
      case 'get_errors': return ok({ isValid: true, errors: 0, warnings: 0, total: 0, byType: {}, messages: [], rawMessages: [] });
      case 'publish': return ok(publish ?? { module: 'Consumer', published: true, state: 'CompletedWithSuccessNotOpenedInBrowser' });
      default: return fail('Unknown method: ' + request.method);
    }
  });
  t.after(() => fake.close());
  let clock = Date.parse('2026-10-07T12:00:00Z');
  const run = createO11Publish({ root: f.root, env: f.env, lane: 'ss4', now: () => new Date(clock += 1000), bridge: o11Bridge({ port: fake.port, authorization: 'K' }),
    assertSelected: async () => {}, tasksDir: path.join(f.dir, 'tasks'), journal: () => {}, grants: { findGrant: () => null, wordsFor: () => ({ words: '' }) } });
  return { run, methods: () => requests.map(r => r.method) };
}

test('C10: outdated references are refreshed before the errors and the publication, in the same call', async t => {
  const p = await publisher(t, { open: { referencesOutdated: true } });
  const value = await p.run({ module: 'Consumer', authorize: 'sim, publique o Consumer' });
  assert.equal(value.ok, true, JSON.stringify(value));
  const order = p.methods().filter(m => ['refresh_references', 'get_errors', 'publish'].includes(m));
  assert.deepEqual(order, ['refresh_references', 'get_errors', 'publish']);
  assert.deepEqual(value.referencesRefreshed.refreshed, [{ name: 'Producer', from: 3, to: 4 }]);
});

test('C10: a publication the bridge stopped behind a dialog answers its code, the dialog and the call that clears it', async t => {
  const blockedBy = [{ ...REFERENCES, module: 'Consumer' }];
  const p = await publisher(t, { publish: { module: 'Consumer', published: false, code: 'PUBLISH_BLOCKED_BY_DIALOG', outcome: 'not-started', blockedBy, dialogsSeen: [] } });
  const value = await p.run({ module: 'Consumer', authorize: 'sim, publique o Consumer' });
  assert.equal(value.ok, false); assert.equal(value.code, 'PUBLISH_BLOCKED_BY_DIALOG'); assert.equal(value.outcome, 'blocked');
  assert.deepEqual(value.blockedBy, [{ kind: 'ManageDependencies', module: 'Consumer' }]);
  assert.deepEqual(value.continuation.arguments, { command: 'refresh-references', args: { module: 'Consumer' } });
  // started before the dialog: it may still finish; any other dialog: the status read
  const started = publishOutcome({ data: { published: false, code: 'PUBLISH_BLOCKED_BY_DIALOG', outcome: 'uncertain', blockedBy: [{ kind: 'Recovery', source: 'window' }] } }, { name: 'Consumer' });
  assert.equal(started.outcome, 'uncertain'); assert.deepEqual(started.continuation.arguments, { command: 'status' });
});

test('C10: a references dialog of another tab, in get_active_module.otherDialogs, keeps o11_publish from starting', async t => {
  const p = await publisher(t, { active: { otherDialogs: [{ ...REFERENCES, module: 'Producer' }] } });
  const value = await p.run({ module: 'Consumer', authorize: 'sim, publique o Consumer' });
  assert.equal(value.code, 'DIALOG_BLOCKING', JSON.stringify(value));
  assert.deepEqual(value.dialogs, [{ kind: 'ManageDependencies', module: 'Producer' }]);
  assert.ok(!p.methods().includes('publish'));
});
