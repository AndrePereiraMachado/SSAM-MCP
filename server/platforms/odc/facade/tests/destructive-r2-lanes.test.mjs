import './fixtures/isolated-profile.mjs';
// CX15 r2, family F1 in the other lanes: no text the server wrote for a preview confirms it (T1) in o11_data,
// studio_data_delete and the odc_* guard; an own-fixture approval is no exemption (F, provisional decision "strict"); the
// O11 and ODC approvals follow the same rule (M4). Offline: the real OdcAccess over a fake bridge (the reviewer's pattern
// of C:\t\revisoes\cx15\bypass\...\bypass-review-odc.test.mjs), a fake O11 kernel runner, a fake bridge data service, the
// Service Center fake bridge, fake clocks, synthetic names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { studioDataDelete } from '../data-delete-gate.mjs';
import { registerAccessTools } from '../odc-access.mjs';
import { guardedAccess } from '../../portal/runtime/destructive-preview.mjs';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';
import { WriteJournal } from '../../portal/runtime/write-journal.mjs';
import * as destructive from '../destructive-operations.mjs';
import { Journal } from '../service-center/client.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { CATALOG, FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock as scClock, noBackup } from './fixtures/destructive-flow.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const { CONFIRM_MIN_AGE_MS, previewFile } = destructive;
// (Read through the namespace so the suite runs, and fails on behavior, on the commit before the fix.)
const OWNER_REPLY = destructive.OWNER_REPLY ?? "<the owner's next message after the list, verbatim>";
const WORDS_RULE = destructive.WORDS_RULE ?? "The words are the owner's next message after the list, copied whole";
const T0 = Date.parse('2026-10-15T12:00:00Z');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
const codes = answer => (answer?.problems ?? []).map(p => p.code).sort();
// Every string the server wrote in an answer (recursively): the candidates a model could copy as the owner's words.
const strings = (value, out = new Set()) => {
  if (typeof value === 'string') { if (value.trim()) out.add(value); }
  else if (Array.isArray(value)) value.forEach(v => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, out));
  return [...out];
};
const placeholders = (count, name) => [OWNER_REPLY, `<the owner's reply: the number ${count} and ${name}>`, `${WORDS_RULE} ${count} ${name}`];

// ---- o11_data (the ssam server, a fake kernel runner: reads by ids, deletes remove the rows)
async function o11Data(t) {
  const table = new Map([1, 2, 3].map(id => [String(id), { Id: String(id), Name: 'Customer ' + id }]));
  const dataRoot = tmp('cx15r2-data-'), root = tmp('cx15r2-data-root-');
  let now = T0; const clock = () => now;
  const deletes = [];
  const resultOf = op => (op.operation === 'read' ? { ok: true, records: (op.ids ?? []).map(String).filter(id => table.has(id)).map(id => table.get(id)), operation: 'read', entity: op.entity }
    : op.operation === 'delete' ? (deletes.push(op), op.ids.forEach(id => table.delete(String(id))), { ok: true, reports: op.ids.map(id => ({ recordId: String(id), status: 'Success', error: null })), operation: 'delete', entity: op.entity })
      : { ok: true, operation: op.operation });
  const runAnvil = async args => {
    const request = JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8'));
    const results = (Array.isArray(request.batch) ? request.batch : [request]).map(resultOf);
    return { ok: true, exitCode: 0, via: 'worker', wallMs: 1, stderr: [], envelope: { ok: true, command: 'data', data: { ok: true, host: 'dev.example.test', module: 'Orders_CS', submitted: results.length, total: results.length, results } } };
  };
  const server = await createSsamServer({ odc: false, deps: { runAnvil, dataRoot, answersRoot: dataRoot, lock: { o11Root: dataRoot, odcRoot: dataRoot, connection: () => null },
    destructive: { now: clock, root, uuid } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r2-data', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); for (const d of [dataRoot, root]) fs.rmSync(d, { recursive: true, force: true }); });
  const target = { host: 'dev.example.test', module: 'Orders_CS', oml: 'C:\\captures\\Orders_CS.oml' };
  const call = async request => valueOf(await client.callTool({ name: 'o11_data', arguments: { ...target, request } }));
  return { call, deletes, wait: () => { now += CONFIRM_MIN_AGE_MS + 1000; } };
}

test('T1 (o11_data): no text of the preview confirms the delete; the owner\'s words with the number and the entity do', async t => {
  const h = await o11Data(t);
  const preview = await h.call({ operation: 'delete', entity: 'Customer', ids: ['1', '2'] });
  assert.equal(preview.count, 2);
  h.wait();
  const next = preview.continuation.arguments.request;
  for (const words of [...strings(preview), ...placeholders(2, 'Customer')]) {
    const answer = await h.call({ ...next, authorization: words });
    assert.notEqual(answer.ok, true, 'a server text confirmed: ' + words);
    assert.deepEqual(h.deletes, [], 'nothing deleted for: ' + words);
  }
  const done = await h.call({ ...next, authorization: 'pode apagar os 2 registros de Customer' });
  assert.equal(done.ok, true, JSON.stringify(done).slice(0, 600));
  assert.equal(h.deletes.length, 1);
});

test('T1 (studio_data_delete): no text of the preview confirms the delete; the owner\'s words with the number and the entity do', async () => {
  const rows = [1, 2, 3].map(i => ({ Id: String(i), Name: 'Product ' + i }));
  const deletes = [];
  const studioData = async ({ op, offset = 0, limit = 100, ids }) => {
    if (op === 'read') { const page = rows.slice(offset, offset + limit); return { ok: true, module: 'Shop', entity: 'Product', tenant: 'personal-test.outsystems.dev', count: page.length, more: false, records: page }; }
    deletes.push(ids); for (const id of ids) rows.splice(rows.findIndex(r => r.Id === String(id)), 1);
    return { ok: true, reports: ids.map(id => ({ recordId: String(id), status: 'Success', error: null })) };
  };
  const root = tmp('cx15r2-sdd-');
  try {
    const preview = await studioDataDelete({ module: 'Shop', entity: 'Product', ids: ['1', '2'] }, { studioData, now: T0, root, uuid });
    assert.equal(preview.count, 2);
    const at = T0 + CONFIRM_MIN_AGE_MS + 1000;
    const call = words => studioDataDelete({ ...preview.continuation.arguments, authorize: words }, { studioData, now: at, root, uuid });
    for (const words of [...strings(preview), ...placeholders(2, 'Product')]) {
      const answer = await call(words);
      assert.notEqual(answer.ok, true, 'a server text confirmed: ' + words);
      assert.deepEqual(deletes, [], 'nothing deleted for: ' + words);
    }
    const done = await call('pode apagar os 2 registros de Product');
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 600));
    assert.deepEqual(deletes, [['1', '2']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- odc_* (the real OdcAccess over a fake bridge, behind the destructive guard)
const PERSONAL = 'personal-r2lanes.outsystems.dev';
const ASSET = '7d1c4f2a-0b6e-4c55-9a51-2f6b8d9e1a11', SCRATCH = '2b2b2b2b-3c3c-4d4d-8e8e-5f5f5f5f5f5f';
const DELETE_ASSET = 'asset-repository-api-v1:delete:/assets/{assetKey}';
function realAccess() {
  const dir = tmp('cx15r2-odc-');
  const root = path.join(dir, 'destructive');
  const assets = { [ASSET]: { assetKey: ASSET, name: 'OrdersLib', revision: 2, assetType: 'Library' }, [SCRATCH]: { assetKey: SCRATCH, name: 'ScratchLib', revision: 1, assetType: 'Library' } };
  const writes = [], requests = new Map(); let n = 0;
  const reply = (body, status = 200) => ({ ok: true, status, contentType: 'application/json', body, host: PERSONAL });
  const tenantCall = request => {
    const route = request.basePath + request.path; let m;
    if (request.method !== 'GET') writes.push(request.method + ' ' + route);
    if (route === '/api/portfolios/v2/environments') return reply({ results: [{ key: 'dev' }, { key: 'qa' }] });
    if (/^\/api\/dependency-management\/v1\/assets\/([^/]+)\/consumers$/.test(route)) return reply({ results: [] });
    if (/\/sources?\b|\/revisions\/\d+\/source/.test(route)) return { ok: true, status: 200, contentType: 'application/octet-stream', body: 'OML synthetic', host: PERSONAL };
    if ((m = /^\/api\/asset-repository\/v1\/assets\/([^/]+)$/.exec(route))) {
      if (request.method === 'DELETE') { delete assets[m[1]]; return { ok: true, status: 204, host: PERSONAL }; }
      return assets[m[1]] ? reply(assets[m[1]]) : reply({ title: 'not found' }, 404);
    }
    return reply({ title: 'unexpected ' + request.method + ' ' + route }, 400);
  };
  const studio = { running: async () => true, call: async args => {
    if (args[0] === 'auth-status') return { ok: true, bridge: 'v38', sessions: [{ host: PERSONAL, loggedIn: true, user: 'dev@example.test' }], portalWindows: [], capabilities: ['portal-call'] };
    if (args[0] === 'portal-call') return tenantCall(requests.get(args[1]));
    return { ok: false, error: 'Unknown command ' + args[0] };
  } };
  const receipts = new WriteJournal(path.join(dir, 'receipts'));
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: PERSONAL, tenants: { [PERSONAL]: { class: 'personal' } } }, studio,
    vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('no vault in this test'); } },
    prompt: { apiClient: async () => ({ opened: true }), portal: async () => ({ opened: true }) }, portalBroker: () => ({ available: false, authenticated: false, initialize: async () => {} }),
    receipts, sleep: async () => {}, requestFile: json => { const file = 'req-' + (++n); requests.set(file, structuredClone(json)); return file; } });
  const clock = { t: T0 }; clock.now = () => clock.t; clock.wait = () => { clock.t += CONFIRM_MIN_AGE_MS + 1000; };
  const tools = new Map();
  registerAccessTools({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, guardedAccess(access, { now: clock.now, root }), fn => fn);
  // A text the tool's own schema refuses never reaches the guard: a refusal too.
  const call = async (name, args) => { const parsed = tools.get(name).config.inputSchema.safeParse(args);
    return parsed.success ? tools.get(name).handler(parsed.data) : { ok: false, code: 'INPUT_SCHEMA', problems: [] }; };
  return { dir, root, writes, receipts, clock, call, deletes: () => writes.filter(w => w.startsWith('DELETE')) };
}

test('T1 (odc_asset_delete): no text of the preview confirms the delete; the owner\'s words with the number and the name do', async () => {
  const h = realAccess();
  const preview = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: SCRATCH });
  assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 400));
  h.clock.wait();
  const args = { tenant: PERSONAL, assetKey: SCRATCH, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId };
  for (const words of [...strings(preview), ...placeholders(1, 'ScratchLib')]) {
    const answer = await h.call('odc_asset_delete', { ...args, authorize: words });
    assert.notEqual(answer.ok, true, 'a server text confirmed: ' + words);
    assert.deepEqual(h.deletes(), [], 'nothing deleted for: ' + words);
  }
  // The continuation copied whole never confirms either.
  const copied = await h.call('odc_asset_delete', preview.continuation.arguments);
  assert.notEqual(copied.ok, true); assert.deepEqual(h.deletes(), []);
  const done = await h.call('odc_asset_delete', { ...args, authorize: 'pode apagar o 1, ScratchLib' });
  assert.equal(done.ok, true, JSON.stringify(done).slice(0, 600));
  assert.deepEqual(h.deletes(), ['DELETE /api/asset-repository/v1/assets/' + SCRATCH]);
});

// An approval "of an own fixture" whose origin is ANY receipt of the journal, written with the words of the request.
function approvalOf(h, { words, origin }) {
  const proposal = path.join(h.dir, 'proposal.md'); fs.writeFileSync(proposal, 'Delete ScratchLib.');
  const file = path.join(h.dir, 'approval-' + crypto.randomUUID() + '.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', words,
    source: { kind: 'human-conversation', threadId: crypto.randomUUID(), messageId: crypto.randomUUID(), question: 'May I delete it?' },
    proposal: { file: proposal, sha256: sha(fs.readFileSync(proposal)) }, scope: [{ lane: 'odc', host: PERSONAL, operation: DELETE_ASSET, targets: ['ScratchLib'] }],
    constraints: { originOperationUuid: origin } }));
  return file;
}
function anyReceipt(h) {
  const id = crypto.randomUUID();
  const r = h.receipts.reserve({ operationUuid: id, identity: { kind: 'odc-public', tenant: PERSONAL, operationId: 'user-access-management-api-v1:patch:/users/{key}', target: { key: 'u-1' } }, wordsSha256: sha('x'), plan: {} });
  h.receipts.settle(r, { state: 'confirmed' });
  return id;
}

test('F: an approval of an "own fixture" (any receipt of the journal) plus the words of the request (said before the list, no number) deletes nothing', async () => {
  for (const ownOrigin of [false, true]) {
    const h = realAccess();
    const request = 'ok apaga o ScratchLib';
    const approval = approvalOf(h, { words: request, origin: ownOrigin ? anyReceipt(h) : crypto.randomUUID() });
    const preview = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: SCRATCH, authorize: request, authorizationContext: approval });
    assert.equal(preview.code, 'CONFIRMATION_REQUIRED');
    h.clock.wait();
    const done = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: SCRATCH, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: request, authorizationContext: approval });
    assert.notEqual(done.ok, true);
    assert.deepEqual(codes(done), ['CONFIRMATION_COUNT_MISMATCH', 'WORDS_BEFORE_PREVIEW'], 'ownOrigin=' + ownOrigin);
    assert.deepEqual(h.writes, [], 'nothing deleted, ownOrigin=' + ownOrigin);
  }
});

// ---- M4: the O11 approval (Service Center delete with --authorization-context) and the ODC one follow the same rule.
function o11Environment() {
  const s = { apps: [{ key: 'scratch', name: 'ScratchApp' }], dir: temp(), clock: scClock() };
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.root = path.join(s.dir, 'destructive');
  s.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => s.apps.filter(a => !a.gone).map(a => ({ Key: a.key, Name: a.name })), ListEspaces: [], ListExtensions: [], GetConsumers: [],
    DeleteApplication: args => { if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] };
      for (const a of s.apps) if (a.key === args.appKey) a.gone = true; return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: [] }; } } });
  s.run = (...argv) => runServiceCenter([...argv, '--host=personal-0000test.outsystemscloud.com'], { journal: s.journal, locate: () => s.bridge, present: async () => false,
    running: async () => false, opener: () => assert.fail('no prompt'), exports: s.dir, registry: path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json'),
    sleep: async () => {}, uuid: () => '11111111-2222-4333-8444-555555555555', clock: s.clock, destructiveRoot: s.root, backup: noBackup });
  s.sent = () => s.bridge.calls.filter(c => c[0] === 'api' && c[2] === 'DeleteApplication' && c[4] && c[3].simulate === false);
  s.approval = (preview, words) => {
    const proposal = previewFile(preview.previewId, { root: s.root }), file = path.join(s.dir, 'approval-' + crypto.randomUUID() + '.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', words,
      source: { kind: 'human-conversation', threadId: crypto.randomUUID(), messageId: crypto.randomUUID(), question: 'May I delete it?' },
      proposal: { file: proposal, sha256: sha(fs.readFileSync(proposal)) }, scope: [{ lane: 'o11', host: 'personal-0000test.outsystemscloud.com', operation: 'delete', targets: ['ScratchApp'] }] }));
    return file;
  };
  return s;
}

test('M4: with an approval, the O11 and the ODC lanes refuse the same words with the same codes and accept the owner\'s reply after the list with the number', async () => {
  const request = 'ok apaga o ScratchApp';
  // O11: the request's words (said with the preview call, no number) in the approval.
  const s = o11Environment();
  const preview = await s.run('delete', '--target=application:ScratchApp', '--words=' + request);
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const o11 = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=' + request, '--authorization-context=' + s.approval(preview, request));
  assert.notEqual(o11.ok, true); assert.deepEqual(s.sent(), []);
  // ODC: the same shape.
  const h = realAccess();
  const odcRequest = 'ok apaga o ScratchLib';
  const approval = approvalOf(h, { words: odcRequest, origin: anyReceipt(h) });
  const p = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: SCRATCH, authorize: odcRequest, authorizationContext: approval });
  h.clock.wait();
  const odc = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: SCRATCH, confirmationToken: p.confirmationToken, operationUuid: p.operationId, authorize: odcRequest, authorizationContext: approval });
  assert.notEqual(odc.ok, true); assert.deepEqual(h.writes, []);
  const rule = ['CONFIRMATION_COUNT_MISMATCH', 'WORDS_BEFORE_PREVIEW'];
  assert.deepEqual(codes(o11).filter(c => rule.includes(c)), rule, 'O11: ' + codes(o11));
  assert.deepEqual(codes(odc).filter(c => rule.includes(c)), rule, 'ODC: ' + codes(odc));
  // The owner's reply after the list, with the number and the name, in an approval of its own: both lanes delete once.
  const o11Reply = 'sim, pode apagar o 1, ScratchApp';
  const o11Done = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=' + o11Reply, '--authorization-context=' + s.approval(preview, o11Reply));
  assert.equal(o11Done.state, 'confirmed', JSON.stringify(o11Done.problems ?? o11Done.error));
  assert.equal(s.sent().length, 1);
  const odcReply = 'sim, pode apagar o 1, ScratchLib';
  const odcDone = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: SCRATCH, confirmationToken: p.confirmationToken, operationUuid: p.operationId, authorize: odcReply,
    authorizationContext: approvalOf(h, { words: odcReply, origin: anyReceipt(h) }) });
  assert.equal(odcDone.ok, true, JSON.stringify(odcDone).slice(0, 600));
  assert.deepEqual(h.deletes(), ['DELETE /api/asset-repository/v1/assets/' + SCRATCH]);
});
