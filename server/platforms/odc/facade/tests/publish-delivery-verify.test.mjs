// B7 (port of proto 1ea02ff4, W4 item 3): the publication of o11_deliver {publish:true} runs right after the delivery's own
// settled Verify of the same tab. That evidence replaces the second get_errors; a module that got TrueChange errors since is
// still refused by the bridge (PublishHandler.cs e.IsValid, before the command starts), and that refusal reads get_errors
// once for the messages. Fake O11 bridge on an ephemeral loopback port: no Studio, nothing published.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createO11Publish, verifiedBy } from '../o11-publish.mjs';
import { deliveryVerified, publishField } from '../o11-cycle.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';
import { DEPENDENCIES_CAPABILITY } from '../o11-studio.mjs';

const WORDS = 'sim, pode publicar o Orders agora';
const HOST = 'dev.example.com';
const ok = data => ({ success: true, data, error: null });
const fail = (error, extra = {}) => ({ success: false, data: null, error, ...extra });
const ACTIVE = { name: 'Orders', key: 'k-orders', kind: 'Web', environment: HOST, isModified: false, pendingDialogs: [] };
const CLEAN = { isValid: true, errors: 0, warnings: 0, total: 0, byType: {}, messages: [], rawMessages: [] };
const PUBLISHED_REPLY = ok({ module: 'Orders', published: true, lastUploadDateTime: '2026-10-02T10:00:00', state: 'CompletedWithSuccessNotOpenedInBrowser', isValid: true, elapsedMs: 42 });
const VERIFIED = { moduleKey: 'k-orders', errors: 0, isValid: true, newErrors: 0, settled: true, at: '2026-10-27T05:57:42Z' };

async function direct(t, state = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-delivery-verify-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sub = name => { const p = path.join(base, name); fs.mkdirSync(p, { recursive: true }); return p; };
  const home = sub('home');
  const env = { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4', USERPROFILE: home, HOME: home, APPDATA: sub('appdata'),
    LOCALAPPDATA: sub('localappdata'), ANVIL_AUTHORITY_DIR: sub('authority') };
  let clock = Date.parse('2026-10-27T06:00:00.000Z');
  const requests = [];
  const s = { verdict: CLEAN, publish: PUBLISHED_REPLY, open: {}, ...state };
  let publishes = 0;
  const fake = await fakeBridge(async request => {
    requests.push(request.method);
    switch (request.method) {
      case 'open_module': return ok({ name: request.params.name, opened: true, alreadyOpen: true, selected: true, serverSilentMode: false, ...s.open });
      case 'get_active_module': return ok(ACTIVE);
      case 'get_errors': return ok(s.verdict);
      case 'bridge_manifest': return s.dialog ? ok({ capabilities: [DEPENDENCIES_CAPABILITY] }) : fail('Unknown method: bridge_manifest');
      case 'answer_dependencies_dialog': return ok({ answered: s.dialog ? [{ kind: 'DependenciesDialog', title: 'Manage Dependencies', answer: 'Cancel' }] : [], module: 'Orders', moduleKey: 'k-orders' });
      case 'list_open_modules': return ok({ modules: [{ name: 'Orders', key: 'k-orders', environment: HOST }] });
      case 'refresh_references': return ok({ module: 'Orders', committed: true, changed: true, refreshed: ['Core_CS'], upToDate: [] });
      case 'publish': return Array.isArray(s.publish) ? s.publish[Math.min(publishes++, s.publish.length - 1)] : s.publish;
      default: return fail('Unknown method: ' + request.method);
    }
  });
  t.after(() => fake.close());
  const run = createO11Publish({ root: sub('anvil'), env, lane: 'ss4', now: () => new Date(clock += 1000), bridge: o11Bridge({ port: fake.port, authorization: 'K' }),
    assertSelected: async () => {}, tasksDir: sub('tasks'), journal: () => {}, inventory: () => null, grants: { wordsFor: ({ authorize }) => ({ words: authorize }) } });
  return { requests, run: (options = {}) => run({ module: 'Orders', authorize: WORDS }, options) };
}

test('B7 W4.3: the delivery\'s clean Verify of this tab replaces the second get_errors, and the answer says what was skipped', async t => {
  const h = await direct(t);
  const value = await h.run({ verified: VERIFIED });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.ok(!h.requests.includes('get_errors'), 'no second TrueChange read: ' + h.requests.join(','));
  assert.equal(h.requests.filter(m => m === 'publish').length, 1);
  assert.deepEqual(value.trueChange, { by: 'delivery', skipped: 'get_errors', moduleKey: 'k-orders', at: '2026-10-27T05:57:42Z' });
  // The deliver answer's publish field carries it (o11-cycle.mjs publishField).
  assert.deepEqual(publishField(value).trueChange, value.trueChange);

  // Without the evidence (a separate o11_publish call), the read stays and nothing says otherwise.
  const plain = await direct(t);
  const alone = await plain.run();
  assert.equal(alone.ok, true);
  assert.ok(plain.requests.includes('get_errors'));
  assert.equal(alone.trueChange, undefined);
  assert.equal(publishField(alone).trueChange, undefined);
});

test('B7 W4.3: evidence of another tab, or not clean, or incomplete is no evidence; the read stays', async t => {
  for (const verified of [{ ...VERIFIED, settled: false }, { ...VERIFIED, settled: undefined }, { ...VERIFIED, moduleKey: 'k-other' }, { ...VERIFIED, errors: 1 }, { ...VERIFIED, errors: null }, { ...VERIFIED, isValid: false },
    { ...VERIFIED, isValid: null }, { ...VERIFIED, newErrors: 2 }, null, 'yes']) {
    assert.equal(verifiedBy(verified, ACTIVE), null, JSON.stringify(verified));
    const h = await direct(t);
    await h.run({ verified });
    assert.ok(h.requests.includes('get_errors'), JSON.stringify(verified));
  }
  assert.equal(verifiedBy(VERIFIED, { ...ACTIVE, key: null }), null);
});

test('B7 W4.3: a module that got errors after the delivery is still refused by the bridge, with the same TRUECHANGE_ERRORS and its messages', async t => {
  const errorNow = { isValid: false, errors: 1, warnings: 0, total: 1, byType: { Error: 1 }, messages: ['Error E1: broken @ Orders'],
    rawMessages: [{ id: 'E1', type: 'Error', key: 'e', path: 'Orders', detail: 'broken' }] };
  // Before (a read here): the refusal with its messages and no publish.
  const before = await direct(t, { verdict: errorNow });
  const read = await before.run();
  assert.equal(read.code, 'TRUECHANGE_ERRORS');
  assert.ok(!before.requests.includes('publish'));
  // Now (the read skipped): the bridge refuses before the command starts, and the answer is the same refusal.
  const h = await direct(t, { verdict: errorNow, publish: fail("InvalidOperationException: 'Orders' has TrueChange errors: fix them before publishing (get_errors)") });
  const refused = await h.run({ verified: VERIFIED });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, read.code);
  assert.equal(refused.errors, read.errors);
  assert.deepEqual(refused.messages, read.messages);
  assert.deepEqual(refused.continuation, read.continuation);
  assert.equal(refused.trueChange, undefined);
  assert.deepEqual(h.requests.filter(m => m === 'get_errors' || m === 'publish'), ['publish', 'get_errors']);
});

test('B7 W4.3 deliveryVerified: only a delivered task with its own Verify and a module key', () => {
  const state = { delivered: true, moduleKey: 'k-orders', updatedAt: '2026-10-27T05:57:42Z', validation: { isValid: true, errors: 0, newErrors: 0, settled: true } };
  assert.deepEqual(deliveryVerified(state), { moduleKey: 'k-orders', errors: 0, isValid: true, newErrors: 0, settled: true, at: '2026-10-27T05:57:42Z' });
  // A Verify the bridge did not settle (an older bridge ignores settle: C28) is no proof for the publication.
  assert.equal(verifiedBy(deliveryVerified({ ...state, validation: { isValid: true, errors: 0, newErrors: 0 } }), ACTIVE), null);
  assert.equal(deliveryVerified({ ...state, delivered: false }), null);
  assert.equal(deliveryVerified({ ...state, validation: undefined }), null);
  assert.equal(deliveryVerified({ ...state, moduleKey: '' }), null);
  assert.equal(deliveryVerified(null), null);
  // A Verify without an error count is no proof of zero errors.
  assert.equal(verifiedBy(deliveryVerified({ ...state, validation: { rawMessages: [] } }), ACTIVE), null);
});

// B7 review (round 2, fix 1): the skip holds only while the module is the one the delivery verified. A publication that writes to
// the module before its TrueChange read (Refresh References of an outdated module, the dependencies dialog answered at the open,
// the publication run again after a dependencies dialog) reads get_errors after that write, and never answers trueChange.
test('B7 review: an outdated module refreshed by the publication reads get_errors after the refresh, never the Verify of the delivery', async t => {
  const h = await direct(t, { open: { referencesOutdated: true } });
  const value = await h.run({ verified: VERIFIED });
  assert.equal(value.ok, true, JSON.stringify(value));
  const at = h.requests.indexOf('refresh_references');
  assert.ok(at >= 0, h.requests.join(','));
  assert.ok(h.requests.indexOf('get_errors', at) > at, 'get_errors after refresh_references: ' + h.requests.join(','));
  assert.ok(h.requests.lastIndexOf('get_errors') < h.requests.indexOf('publish'));
  assert.equal(value.trueChange, undefined);
  assert.ok(value.referencesRefreshed);
});

test('B7 review: the dependencies dialog answered at the open (referencesRefreshed) also keeps the read', async t => {
  // The open's references check stopped behind the dependencies dialog: it is answered and the module refreshed (MB2).
  const h = await direct(t, { dialog: true, open: { opened: true, alreadyOpen: false, referencesCheck: 'skipped' } });
  const value = await h.run({ verified: VERIFIED });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.ok(h.requests.includes('get_errors'), h.requests.join(','));
  assert.ok(h.requests.indexOf('get_errors') < h.requests.indexOf('publish'));
  assert.ok(h.requests.indexOf('get_errors') > h.requests.indexOf('refresh_references'), h.requests.join(','));
  assert.ok(value.referencesRefreshed, JSON.stringify(value));
  assert.equal(value.trueChange, undefined);
});

test('B7 review: a Verify the delivery did not settle keeps the read', async t => {
  const h = await direct(t);
  const value = await h.run({ verified: { ...VERIFIED, settled: false } });
  assert.equal(value.ok, true);
  assert.ok(h.requests.includes('get_errors'));
  assert.equal(value.trueChange, undefined);
});

test('B7 review: a publication run again after a dependencies dialog never answers trueChange by the delivery', async t => {
  // The bridge stopped the publication at the dependencies dialog before anything reached the server, and answered it.
  const blocked = ok({ module: 'Orders', published: false, code: 'PUBLISH_BLOCKED_BY_DIALOG', outcome: 'blocked',
    blockedBy: [{ kind: 'ManageDependencies', title: 'Manage Dependencies', module: 'Orders' }],
    dependenciesDialog: { answered: [{ kind: 'DependenciesDialog', title: 'Manage Dependencies', answer: 'Cancel' }] } });
  const h = await direct(t, { publish: [blocked, PUBLISHED_REPLY] });
  const value = await h.run({ verified: VERIFIED });
  assert.equal(h.requests.filter(m => m === 'publish').length, 2, h.requests.join(','));
  assert.ok(h.requests.includes('refresh_references'));
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.trueChange, undefined);
});
