import './fixtures/isolated-profile.mjs';
// CX15 r6 (M-1): r5's mask puts the words marker ('<palavras do usuário>') in the continuations, and several gates took the
// marker as words (they only asked for a nonempty text): replaying a continuation as it is ran the write, and the kernel or
// the journal kept the sha256 of the marker. Now every gate that takes authorization words refuses a marker, a <template>
// (WORDS_ECHO, OWNER_REPLY, "<the user's ...>"), a sha256:<hex> and a text with no words (only punctuation) with ONE
// WORDS_REQUIRED, before anything is sent; a masked step says so (why "...; <field>: the owner's own words in place of the marker" since r7,
// askOwner). The two scenarios of the review (C:\t\revisoes\cx15-5\review\repros\marker-replay.test.mjs) replayed as they are
// run nothing; with the owner's words they run and the kernel / journal get the sha256 of THOSE words. Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createFacadeServer } from '../mcp.mjs';
import * as ops from '../destructive-operations.mjs'; // a namespace: at the base each test fails on its own rule, not at import
import { publishAuthorization } from '../kernel-delivery.mjs';
import { registerO11Environment } from '../o11-environment.mjs';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';
import { WriteJournal } from '../../portal/runtime/write-journal.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { envelopes, tempKernel, linked } from './fixtures/o11env-kernel.mjs';
import { fakeBridge, delivery, BRIDGE_PID as PID } from './fixtures/destructive-r5-bridge.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
// The marker is English since 16/10 (owner rule of 15/10); the marker of the releases before stays refused as words (input alias).
const MARKER = "<the user's own words>", LEGACY_MARKER = '<palavras do usuário>', OWNER_REPLY = "<the owner's next message after the list, verbatim>";
const SERVER_TEXTS = { marker: MARKER, legacyMarker: LEGACY_MARKER, ownerReply: OWNER_REPLY, template: "<the user's literal words>", hash: 'sha256:' + 'a'.repeat(64), punctuation: '!!! ... ??? !!!' };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const target = { host: 'dev.example.test', module: 'Orders_CS', oml: 'C:\\captures\\Orders_CS.oml' };

async function o11Hub(t, { destructiveRoot } = {}) {
  let now = Date.parse('2026-10-15T12:00:00Z'), seq = 0;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r6-m1-')); t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const calls = [];
  const runAnvil = async args => {
    const request = JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8')); calls.push(request);
    const list = Array.isArray(request.batch) ? request.batch : [request];
    const results = list.map(op => op.operation === 'read' ? { ok: true, records: (op.ids ?? []).map(id => ({ Id: String(id), Name: 'Customer ' + id })), operation: 'read', entity: op.entity }
      : op.operation === 'delete' ? { ok: true, reports: op.ids.map(id => ({ recordId: String(id), status: 'Success', error: null })), operation: 'delete', entity: op.entity }
        : { ok: true, ids: ['n0'], operation: op.operation, entity: op.entity });
    return { ok: true, exitCode: 0, via: 'worker', wallMs: 1, stderr: [], envelope: { ok: true, command: 'data', data: { ok: true, host: target.host, module: target.module, submitted: results.length, total: results.length, results } } };
  };
  const server = await createSsamServer({ odc: false, deps: { runAnvil, dataRoot, answersRoot: dataRoot, lock: { o11Root: dataRoot, odcRoot: dataRoot, connection: () => null },
    destructive: { now: () => now, root: destructiveRoot ?? path.join(dataRoot, 'destructive'), uuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}` } } });
  const [s, c] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'cx15r6-m1', version: '1' });
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async request => { const r = await client.callTool({ name: 'o11_data', arguments: { ...target, request } }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  return { call, calls, advance: ms => { now += ms; } };
}

test('M-1 (o11_data, the mixed preview): its continuation replayed as it is gives WORDS_REQUIRED and sends nothing; with the owner\'s words the kernel gets their sha256', async t => {
  const h = await o11Hub(t);
  const WORDS = 'grava o cliente novo e apaga o 4';
  const preview = await h.call({ authorization: WORDS, batch: [
    { step: 'new', operation: 'insert', entity: 'Customer', operationId: '7a1c4e1e-2222-4222-8222-222222222222', records: [{ Name: 'Novo' }] },
    { step: 'gone', operation: 'delete', entity: 'Customer', ids: ['4'] }] });
  assert.equal(preview.code, 'CONFIRMATION_REQUIRED');
  assert.equal(preview.continuation.arguments.request.authorization, MARKER);
  const request = structuredClone(preview.continuation.arguments.request);
  request.batch[1].authorization = 'sim, apaga o 1 registro de Customer'; // the only template the answer names (OWNER_REPLY)
  h.advance(6000);
  const before = h.calls.length;
  const replayed = await h.call(structuredClone(request));
  assert.equal(replayed.code, 'WORDS_REQUIRED', JSON.stringify(replayed).slice(0, 300));
  assert.equal(h.calls.length, before, 'nothing reached the kernel');
  // The step says the owner must fill the marker (after the replay, so an older tree fails on the replay itself).
  assert.match(preview.continuation.why, /; request\/authorization: the owner's own words in place of the marker$/ /* CX15 r7 (L-8, converted): English */);
  assert.deepEqual(preview.continuation.askOwner?.fields, ['request/authorization']);
  request.authorization = WORDS; // the owner's words where the marker is
  const done = await h.call(request);
  assert.equal(done.ok, true, JSON.stringify(done).slice(0, 300));
  assert.equal(h.calls.at(-1).authorization, 'sha256:' + ops.wordsSha256(WORDS), 'the kernel gets the sha256 of the owner\'s words');
});

test('M-1 (o11_data): a write whose words are a marker, a template, a sha256 or no words is WORDS_REQUIRED before anything; one refusal for every field', async t => {
  const h = await o11Hub(t);
  for (const [kind, value] of Object.entries(SERVER_TEXTS)) {
    const refused = await h.call({ operation: 'insert', entity: 'Customer', operationId: crypto.randomUUID(), records: [{ Name: 'X' }], authorization: value });
    assert.equal(refused.code, 'WORDS_REQUIRED', kind + ' ' + JSON.stringify(refused).slice(0, 200));
  }
  const two = await h.call({ authorization: MARKER, batch: [{ step: 'a', operation: 'insert', entity: 'E', operationId: crypto.randomUUID(), records: [{ X: 1 }] },
    { step: 'b', operation: 'update', entity: 'E', operationId: crypto.randomUUID(), ids: ['1'], records: [{ X: 2 }], authorization: OWNER_REPLY }] });
  // (the hub's shaper groups problems of one code: {count})
  assert.equal(two.code, 'WORDS_REQUIRED'); assert.equal(two.problems.reduce((n, p) => n + (p.count ?? 1), 0), 2, 'one refusal with both fields');
  assert.deepEqual(two.askOwner.fields, ['request/authorization', 'request/batch/1/authorization']);
  assert.equal(h.calls.length, 0, 'nothing reached the kernel');
  const ok = await h.call({ operation: 'insert', entity: 'Customer', operationId: crypto.randomUUID(), records: [{ Name: 'X' }], authorization: 'grava o cliente X' });
  assert.equal(ok.ok, true); assert.equal(h.calls.length, 1);
});

test('M-1 (o11_environment, BLANK_UI_MODULE): its continuation replayed as it is gives WORDS_REQUIRED and runs nothing; with the owner\'s words the journal keeps their sha256', async t => {
  const kernel = tempKernel({ cli: true }); const run = fakeAnvil(envelopes);
  const mcp = await linked(registerO11Environment, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, now: () => new Date('2026-10-06T12:57:39.000Z'),
    uuid: () => '00000000-0000-4000-8000-000000000001', assertSelected: async () => {} });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  const WORDS = 'Sim, pode criar o app Cardapio';
  const refused = await mcp.call('o11_environment', { action: 'create-app', name: 'Cardapio', modules: [{ name: 'Cardapio_UI', kind: 'Reactive' }], blank: true, authorize: WORDS });
  assert.equal(refused.code, 'BLANK_UI_MODULE');
  assert.equal(refused.continuation.arguments.authorize, MARKER);
  const replay = await mcp.call('o11_environment', refused.continuation.arguments);
  assert.equal(replay.code, 'WORDS_REQUIRED', JSON.stringify(replay).slice(0, 300));
  assert.equal(run.calls.length, 0, 'the CLI was never called');
  assert.deepEqual(refused.continuation.askOwner?.fields, ['authorize']);
  for (const [kind, value] of Object.entries(SERVER_TEXTS)) assert.equal((await mcp.call('o11_environment', { ...refused.continuation.arguments, authorize: value })).code, 'WORDS_REQUIRED', kind);
  const done = await mcp.call('o11_environment', { ...refused.continuation.arguments, authorize: WORDS });
  assert.equal(done.ok, true, JSON.stringify(done).slice(0, 300)); assert.equal(run.calls.length, 1);
  const journal = fs.readdirSync(kernel.root, { recursive: true }).map(String).filter(f => f.endsWith('o11_environment.jsonl')).map(f => fs.readFileSync(path.join(kernel.root, f), 'utf8')).join('');
  assert.ok(journal.includes(sha(WORDS)) || journal.includes(ops.wordsSha256(WORDS)), 'the journal keeps the sha256 of the owner\'s words');
  assert.equal(journal.includes(sha(MARKER)) || journal.includes(ops.wordsSha256(MARKER)), false, 'never the sha256 of the marker');
});

test('M-1 (studio_publish, studio_data_insert, studio_data_update, studio_deliver publish): a server text as the words is WORDS_REQUIRED and nothing crosses the bridge', async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r6-m1-odc-')); t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const bridge = fakeBridge();
  const facade = await createFacadeServer({ deps: { studio: bridge.studio, destructive: { root: path.join(out, 'destructive') } } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'cx15r6-m1-odc', version: '1' });
  await Promise.all([facade.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await facade.close(); });
  const call = async (tool, args) => { const r = await client.callTool({ name: tool, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const D = delivery(out, 'p', 'ZZAppP');
  for (const [kind, value] of Object.entries(SERVER_TEXTS)) {
    assert.equal((await call('studio_publish', { manifest: D.manifest, authorize: value, wait: true, minutes: 1, pid: PID })).code, 'WORDS_REQUIRED', 'studio_publish ' + kind);
    assert.equal((await call('studio_data_insert', { module: 'SynthOrders', entity: 'SynthCustomer', records: [{ Name: 'X' }], authorize: value, pid: PID })).code, 'WORDS_REQUIRED', 'studio_data_insert ' + kind);
    assert.equal((await call('studio_data_update', { module: 'SynthOrders', entity: 'SynthCustomer', records: [{ Id: '1', Name: 'X' }], authorize: value, pid: PID })).code, 'WORDS_REQUIRED', 'studio_data_update ' + kind);
    const delivered = await publishAuthorization({ authorize: value, module: 'ZZAppP' }, { findGrant: async () => ({ grantId: 'g', words: 'pode publicar sempre o ZZAppP' }) });
    assert.equal(delivered?.refused?.code, 'WORDS_REQUIRED', 'studio_deliver publish:true ' + kind + ': never the grant instead');
  }
  assert.deepEqual(bridge.lines, [], 'nothing crossed the bridge');
  assert.equal(JSON.parse(fs.readFileSync(D.manifest, 'utf8')).publishAuthorization, undefined);
  // The owner's words still publish.
  assert.notEqual((await call('studio_publish', { manifest: D.manifest, authorize: 'pode publicar o ZZAppP agora', wait: true, minutes: 1, pid: PID })).ok, false);
});

test('M-1 (the portal writes and odc_receipt reconcile): a server text as authorize is WORDS_REQUIRED and nothing is sent', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r6-m1-portal-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const HOST = 'personal-zzr6.outsystems.dev';
  const studio = { running: async () => true, call: async args => args[0] === 'auth-status' ? { ok: true, bridge: 'v38', sessions: [{ host: HOST, loggedIn: true, user: 'dev@example.test' }], portalWindows: [], capabilities: ['portal-call'] } : { ok: false } };
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: HOST, tenants: { [HOST]: { class: 'personal' } } }, studio,
    vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('no vault'); } },
    prompt: { apiClient: async () => ({ opened: true }), portal: async () => ({ opened: true }) }, portalBroker: () => ({ available: false, authenticated: false, initialize: async () => {} }),
    receipts: new WriteJournal(path.join(dir, 'receipts')), sleep: async () => {}, requestFile: () => path.join(dir, 'req.json') });
  const sends = [];
  access.resolvePortal = async () => ({ ok: true, path: 'vault', broker: { callScreenservice: async r => { sends.push(r.operationId); return { data: {} }; } } });
  for (const [kind, value] of Object.entries(SERVER_TEXTS)) {
    const w = await access.portalWrite({ tenant: HOST, operationId: 'timers.run', input: { inputParameters: { StageKey: crypto.randomUUID(), ApplicationKey: crypto.randomUUID(), TimerKey: crypto.randomUUID() } }, authorize: value, operationUuid: crypto.randomUUID() });
    const code = w.error?.code ?? w.code;
    assert.ok(['WORDS_REQUIRED', 'AUTHORIZATION_REQUIRED'].includes(code), kind + ' ' + JSON.stringify(w).slice(0, 200));
    if (value.trim().length >= 8) assert.equal(code, 'WORDS_REQUIRED', kind);
  }
  assert.deepEqual(sends, [], 'nothing was sent');
  // odc_receipt reconcile with a server text: refused before any read.
  const id = crypto.randomUUID(); const r = access.receipts.reserve({ operationUuid: id, identity: { kind: 'odc-portal', tenant: HOST, operationId: 'timers.run', target: { x: 1 } }, wordsSha256: sha('w'), plan: {} });
  access.receipts.settle(r, { state: 'uncertain' });
  const rec = await access.receipt({ operationUuid: id, reconcile: { state: 'confirmed', read: { operationId: 'zz' }, authorize: MARKER } });
  assert.equal(rec.error?.code ?? rec.code, 'WORDS_REQUIRED', JSON.stringify(rec).slice(0, 200));
});

test('M-1 (the predicate): wordsGiven refuses every server text and keeps the owner\'s words', () => {
  assert.equal(typeof ops.wordsGiven, 'function', 'destructive-operations.mjs exports wordsGiven');
  for (const [kind, value] of Object.entries(SERVER_TEXTS)) assert.equal(ops.wordsGiven(value), false, kind);
  for (const value of [undefined, null, '', '   ', 42, 'sim ' + MARKER, 'sim ' + LEGACY_MARKER]) assert.equal(ops.wordsGiven(value), false, String(value));
  for (const value of ['sim, pode criar o app Cardapio', 'ok', 'pode apagar os 3: ZZA, ZZB, ZZC']) assert.equal(ops.wordsGiven(value), true, value);
});
