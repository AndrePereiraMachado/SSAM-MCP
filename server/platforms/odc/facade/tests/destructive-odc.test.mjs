import './fixtures/isolated-profile.mjs';
// CX15 W5: the destructive ODC tools take two calls (portal\runtime\destructive-preview.mjs), at the entry of the tools:
// odc_asset_delete, odc_write/odc_deploy (DELETE, Undeploy), odc_portal_write (routes with effect 'destructive'),
// odc_a2a_connection_delete, odc_external_db_connection delete/remove-entities, odc_external_library discard, the CLI
// (.\odc portal write/internal-write use the same guardedAccess; .\odc studio refuses the destructive bridge commands).
// A fake server captures the handlers of registerAccessTools (inputs parsed by their own strict schemas); the access is a
// fake with the public methods of OdcAccess, except the last suite, which runs the real OdcAccess over a fake bridge.
// Clock, destructive root and the record are injected: nothing reaches a Studio, a vault, a tenant or the real profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerAccessTools } from '../odc-access.mjs';
import { createExternalLibraryTool, registerExternalLibrary } from '../odc-external-library.mjs';
import { guardedAccess, unguarded, OWNER_REPLY, TWO_CALLS } from '../../portal/runtime/destructive-preview.mjs';
import { CONFIRM_MIN_AGE_MS, DESTRUCTIVE_BRIDGE_COMMANDS, destructiveRoot, normalizeWords, readOperation } from '../destructive-operations.mjs';
import { PORTAL_WRITES } from '../../portal/runtime/portal-routes.mjs';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';
import { WriteJournal } from '../../portal/runtime/write-journal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PERSONAL = 'personal-w5test.outsystems.dev', CORP = 'corp-w5test.outsystems.dev';
const ASSET = '7d1c4f2a-0b6e-4c55-9a51-2f6b8d9e1a11', OTHER_ASSET = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const USER = 'aa11bb22-cc33-4d44-8e55-ff66aa77bb88', ENV_QA = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const CONN = 'c0ffee00-feed-4bee-8bad-decafbadbeef', A2A = 'a2a00000-aaaa-4bbb-8ccc-dddddddddddd', ORIGIN = 'beadbead-beef-4bed-8bad-cafecafecafe';
const APPROVAL = 'C:/private/w5-approval.json';
const DELETE_ASSET = 'asset-repository-api-v1:delete:/assets/{assetKey}', GET_ASSET = 'asset-repository-api-v1:get:/assets/{assetKey}';
const DELETE_USER = 'user-access-management-api-v1:delete:/users/{key}', GET_USER = 'user-access-management-api-v1:get:/users/{key}';
const PATCH_USER = 'user-access-management-api-v1:patch:/users/{key}', DEPLOY = 'deployments-api-v1:post:/deployment-operations';
const ENVIRONMENTS = 'portfolio-api-v2:get:/environments';
const JOBS = 'external-library-generation-api-v1:get:/generation-operations', JOB_GET = 'external-library-generation-api-v1:get:/generation-operations/{operationKey}';
const JOB_DELETE = 'external-library-generation-api-v1:delete:/generation-operations/{operationKey}';
const OPS = { [DELETE_ASSET]: 'DELETE', [GET_ASSET]: 'GET', [DELETE_USER]: 'DELETE', [GET_USER]: 'GET', [PATCH_USER]: 'PATCH', [DEPLOY]: 'POST', [ENVIRONMENTS]: 'GET',
  [JOBS]: 'GET', [JOB_GET]: 'GET', [JOB_DELETE]: 'DELETE' };
const uuid = () => crypto.randomUUID();
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// Every owner sentence of this file (the last test scans every preview, record, seen-words line and backup for them).
const SAID = new Set();
const say = words => { SAID.add(words); return words; };
const roots = [];

// The in-memory tenant behind the fake access: assets with consumers, a user, an External Library job, connections and
// the Portal fixtures; a write is "sent" once per operationUuid (a repeated UUID answers its receipt, as OdcAccess does).
function fakeAccess({ apiClient = true, sourceFails = false, consumers = ['OrdersApp'], studioSignedOut = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-fake-'));
  const state = {
    assets: { [ASSET]: { name: 'OrdersLib', revision: 3, assetType: 'Library', consumers: [...consumers] }, [OTHER_ASSET]: { name: 'BillingLib', revision: 1, assetType: 'Library', consumers: [] } },
    users: { [USER]: { key: USER, name: 'Jane Synthetic', email: 'jane@example.test' } },
    jobs: { 'job-9': { key: 'job-9', libraryName: 'SSAMTextTools', filename: 'SSAMTextTools-bbbbbbbbbbbbbbbb.zip', status: 'ReadyForReview' } },
    connections: { [CONN]: { name: 'SSAM search fixture', providerId: 'customAISearch' }, [A2A]: { name: 'SSAM agent fixture', providerId: 'a2a' },
      'db-1': { name: 'SSAM SQL fixture', providerId: 'mssql' } },
  };
  const events = [], sends = [], reads = [], receipts = new Map();
  const sendOnce = (kind, input, answer = {}) => {
    const id = String(input.operationUuid ?? '').toLowerCase();
    if (receipts.has(id)) return { ok: true, existingReceipt: true, receipt: receipts.get(id), ...answer };
    sends.push({ kind, input }); events.push('send:' + kind);
    const receipt = { operationUuid: id, state: 'confirmed', file: path.join(dir, id + '.json') };
    receipts.set(id, receipt);
    return { ok: true, receipt, ...answer };
  };
  // The approvals of own fixtures stay with the unguarded tool: a wrong approval is refused there, nothing sent.
  const approved = (input, kind, answer) => (input.authorizationContext === APPROVAL ? sendOnce(kind, input, answer)
    : { ok: false, sent: false, code: 'AUTHORIZATION_CONTEXT_INVALID', error: { code: 'AUTHORIZATION_CONTEXT_INVALID', message: 'The approval record does not cover this exact proposal.' } });
  const json = data => ({ ok: true, status: 200, data });
  const access = {
    catalog: { get: id => { if (!OPS[id]) throw Object.assign(new Error('Operation ID is not in the pinned public API catalog.'), { code: 'OPERATION_NOT_FOUND' });
      return { operation: { id, method: OPS[id], readOnly: OPS[id] === 'GET' } }; } },
    tenantInfo: host => ({ host, known: true, class: host === CORP ? 'corporate' : 'personal', readOnly: false, label: null }),
    pickTenant: async tenant => tenant ?? PERSONAL,
    resolvePublic: async (host, auth) => (studioSignedOut && auth !== 'api-client'
      ? { ok: false, code: 'STUDIO_NOT_SIGNED_IN', error: { code: 'STUDIO_NOT_SIGNED_IN', message: 'No Studio session on ' + host + '.' }, host, continuation: 'Repeat with auth:"api-client" to use the API Client stored in the vault.' }
      : { path: auth === 'api-client' ? 'vault' : 'studio', host }),
    apiClientAvailable: async () => apiClient,
    dependentsOf: async (host, resolved, key) => {
      reads.push('consumers:' + key);
      const a = state.assets[key];
      return a ? { ok: true, name: a.name, consumers: a.consumers.map(n => ({ key: 'k-' + n, name: n })), checkedEnvironments: ['dev', 'qa'], includesPublishingDefault: true }
        : { ok: false, code: 'DEPENDENCY_CHECK_UNAVAILABLE', message: 'The asset identity or complete consumer scope could not be verified; nothing was reserved or deleted.' };
    },
    read: async ({ operationId, path: p = {} }) => {
      reads.push(operationId);
      if (operationId === GET_ASSET) { const a = state.assets[p.assetKey]; return a ? json({ assetKey: p.assetKey, name: a.name, revision: a.revision, assetType: a.assetType }) : { ok: false, status: 404 }; }
      if (operationId === GET_USER) return state.users[p.key] ? json(state.users[p.key]) : { ok: false, status: 404 };
      if (operationId === ENVIRONMENTS) return json({ results: [{ key: 'env-dev', name: 'Development' }, { key: ENV_QA, name: 'QA' }] });
      if (operationId === JOBS) return json({ results: Object.values(state.jobs) });
      if (operationId === JOB_GET) return state.jobs[p.operationKey] ? json(state.jobs[p.operationKey]) : { ok: false, status: 404 };
      return { ok: false, status: 400 };
    },
    portalRead: async ({ operationId, input = {} }) => {
      reads.push(operationId);
      if (operationId === 'connections.detail') { const c = state.connections[input.connectionId]; return c ? json({ Connection: { name: c.name, providerId: c.providerId } }) : { ok: false, error: { code: 'PORTAL_NOT_FOUND', message: 'No such connection.' } }; }
      if (operationId === 'apiClients.detail') return json({ APIClient: { Key: input.screenVariables?.id, Name: 'ssam-fixture-client' } });
      if (operationId === 'knowledgeBases.list') return json({ List: [{ KnowledgeBaseId: 'kb-other', Name: 'Other base' }, { KnowledgeBaseId: 'kb-1', Name: 'SSAM KB fixture' }] });
      if (operationId === 'agents.dataset') return json({ Dataset: { Id: input.screenVariables?.id, Name: 'SSAM dataset fixture' } });
      return { ok: false, error: { code: 'PORTAL_OPERATION_NOT_FOUND', message: operationId } };
    },
    targetNames: async (host, resolved, operation, input) => {
      if (operation.id === DEPLOY) return [state.assets[input.body.assetKey]?.name, input.body.assetKey].filter(Boolean);
      if (operation.id === DELETE_USER) { const u = state.users[input.path.key]; return [...(u ? [u.name, u.email] : []), input.path.key]; }
      if (operation.id === DELETE_ASSET) return [state.assets[input.path.assetKey]?.name, input.path.assetKey].filter(Boolean);
      return Object.values(input.path ?? {}).slice(-1).map(String);
    },
    assetSource: async ({ assetKey, revisionNumber }) => {
      events.push('source:' + assetKey + ':r' + revisionNumber);
      if (sourceFails) return { ok: false, error: { code: 'SOURCE_DOWNLOAD_FAILED', message: 'The source download failed.' } };
      const file = path.join(dir, assetKey + '-r' + revisionNumber + '.bin');
      fs.writeFileSync(file, 'OML synthetic source r' + revisionNumber);
      return { ok: true, file, byteLength: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    },
    receipts: { lookup: id => receipts.get(String(id).toLowerCase()) ?? null },
    assetDelete: async input => sendOnce('assetDelete', input, { readBack: { gone: true } }),
    write: async (input, options) => sendOnce('write', { ...input, options }),
    deploy: async input => sendOnce('deploy', input),
    portalWrite: async (input, options) => (PORTAL_WRITES[input.operationId]?.effect === 'destructive' ? approved(input, 'portalWrite', {}) : sendOnce('portalWrite', input)),
    a2aConnectionDelete: async input => approved(input, 'a2a', { readBack: { absent: true } }),
    externalDbConnection: async input => {
      if (['delete', 'remove-entities'].includes(input.action)) return approved(input, 'db:' + input.action, {});
      if (input.action === 'entities') return { ok: true, entities: [{ Name: 'Orders', Selected: true }, { Name: 'Lines', Selected: true }] };
      return { ok: true, action: input.action, passthrough: true };
    },
  };
  return { access, state, events, sends, reads, receipts, dir, sendOnce };
}
function clockAt() {
  const c = { t: Date.parse('2026-10-15T12:00:00.000Z') };
  c.now = () => c.t; c.wait = (ms = CONFIRM_MIN_AGE_MS + 1000) => { c.t += ms; };
  return c;
}
// The handlers of registerAccessTools on a fake server, each input parsed by its own strict schema as the SDK does.
function harness(options = {}) {
  const fake = fakeAccess(options);
  const clock = clockAt();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-destructive-')); roots.push(root);
  const guarded = guardedAccess(fake.access, { now: clock.now, root });
  const tools = new Map();
  const server = { registerTool: (name, config, handler) => tools.set(name, { config, handler }) };
  registerAccessTools(server, guarded, fn => fn);
  // odc_external_library over the same access; its deployer's discard is the fake tenant's job DELETE.
  class Deployer { async discard(args) { return fake.sendOnce('discard', args, { jobKey: args.jobKey, readBack: { gone: true } }); } }
  registerExternalLibrary(server, { access: guarded, wrap: fn => fn, portalRuntime: { deployer: { ExternalLibraryDeployer: Deployer }, uploads: {} }, uploaders: {} });
  const call = async (name, args) => { const tool = tools.get(name); return budget(await tool.handler(tool.config.inputSchema.parse(args))); };
  const previews = () => { try { return fs.readdirSync(path.join(root, 'previews')).filter(n => n.endsWith('.json')); } catch { return []; } };
  return { ...fake, clock, root, guarded, call, tools, previews };
}
// answer-size.mjs budgets (plan 4096 B, refusal 8192 B): every preview and every refusal of this suite fits, names whole.
const SIZES = { preview: [], refusal: [] };
function budget(answer) {
  if (answer?.state === 'previewed') { SIZES.preview.push(bytes(answer)); assert.ok(bytes(answer) <= 4096, 'preview ' + bytes(answer) + ' B'); }
  else if (answer?.ok === false && Array.isArray(answer.problems)) { SIZES.refusal.push(bytes(answer)); assert.ok(bytes(answer) <= 8192, 'refusal ' + bytes(answer) + ' B'); }
  return answer;
}
test.after(() => { if (process.env.W5_SIZES) fs.writeFileSync(process.env.W5_SIZES, JSON.stringify({ preview: Math.max(...SIZES.preview), refusal: Math.max(...SIZES.refusal), previews: SIZES.preview.length, refusals: SIZES.refusal.length })); });
// The second call of a preview: its token, its operationId as operationUuid and the owner's reply.
const confirm = (preview, args, words) => ({ ...args, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: say(words) });
const codes = answer => (answer.problems ?? []).map(p => p.code);

test('odc_asset_delete: the call is a preview (ok without words, CONFIRMATION_REQUIRED with them), nothing sent; the reply after 5 s deletes once, the source backed up before the DELETE', async () => {
  const h = harness();
  const plain = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET });
  assert.equal(plain.ok, true, JSON.stringify(plain)); assert.equal(plain.state, 'previewed'); assert.equal(plain.count, 1); assert.equal(plain.sent, false);
  assert.deepEqual(plain.items.map(i => [i.kind, i.key, i.name, i.consumers]), [['asset', ASSET, 'OrdersLib', ['OrdersApp']]]);
  assert.deepEqual(plain.mustName, ['OrdersLib', 'OrdersApp']); assert.deepEqual(plain.backupPlan.possible, ['OrdersLib']);
  assert.match(plain.items[0].backup.how, /revision 3/); assert.deepEqual(plain.consumers, ['OrdersApp']);
  assert.match(plain.confirmationToken, /^[0-9a-f-]{36}\.[0-9a-f]{16}$/); assert.match(plain.operationId, /^[0-9a-f-]{36}$/);
  assert.ok(bytes(plain) <= 4096, 'a preview fits the plan budget: ' + bytes(plain));

  const request = say('ok apaga o OrdersLib e o OrdersApp');
  const withWords = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET, authorize: request });
  assert.equal(withWords.ok, false); assert.equal(withWords.code, 'CONFIRMATION_REQUIRED'); assert.equal(withWords.error, TWO_CALLS);
  assert.equal(withWords.state, 'previewed'); assert.deepEqual(withWords.items.map(i => i.name), ['OrdersLib']);
  assert.deepEqual(withWords.continuation, { tool: 'odc_asset_delete', arguments: { tenant: PERSONAL, assetKey: ASSET, auth: 'auto', confirmationToken: withWords.confirmationToken,
    operationUuid: withWords.operationId, authorize: OWNER_REPLY }, why: withWords.continuation.why });
  assert.doesNotMatch(JSON.stringify(withWords), new RegExp(request));
  assert.deepEqual(h.sends, []); assert.equal(h.receipts.size, 0); assert.equal(h.events.length, 0, 'no download and no send in a preview');

  h.clock.wait();
  const done = await h.call('odc_asset_delete', confirm(withWords, { tenant: PERSONAL, assetKey: ASSET }, 'sim, apaga os 1: OrdersLib e OrdersApp'));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(h.sends.length, 1); assert.equal(h.sends[0].input.operationUuid, withWords.operationId); assert.equal(h.sends[0].input.assetKey, ASSET);
  assert.equal(h.sends[0].input.authorize, 'sim, apaga os 1: OrdersLib e OrdersApp'); assert.equal('confirmationToken' in h.sends[0].input, false);
  assert.deepEqual(h.events, ['source:' + ASSET + ':r3', 'send:assetDelete'], 'the source of the current revision is saved BEFORE the DELETE');
  const file = done.backup[0].files[0];
  assert.equal(path.dirname(file.path), path.join(h.root, 'backups', withWords.operationId));
  assert.equal(file.sha256, crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex')); assert.equal(file.revision, 3);
  assert.deepEqual([done.operation.state, done.operation.counts, done.operation.deleted], ['completed', { deleted: 1 }, ['OrdersLib']]);
  const record = readOperation(withWords.operationId, { root: h.root });
  assert.equal(record.items[0].state, 'deleted'); assert.equal(record.items[0].backup.files[0].sha256, file.sha256); assert.equal(record.items[0].receipt.operationUuid, withWords.operationId);

  // The same token again never sends: the existing receipt answers (read only).
  const again = await h.call('odc_asset_delete', confirm(withWords, { tenant: PERSONAL, assetKey: ASSET }, 'sim, apaga os 1: OrdersLib e OrdersApp'));
  assert.equal(again.alreadyExecuted, true); assert.equal(again.existingReceipt, true); assert.equal(h.sends.length, 1);
  // The same operationUuid without a token reads its receipt through the unguarded tool, never a new preview or send.
  const reconcile = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET, operationUuid: withWords.operationId, authorize: 'sim, apaga os 1: OrdersLib e OrdersApp' });
  assert.equal(reconcile.existingReceipt, true); assert.equal(h.sends.length, 1); assert.equal(h.previews().length, 2);
});

test('odc_asset_delete execution: every problem in one refusal and nothing sent (too soon, words seen before, count, consumers, target, operationUuid, tool, tenant)', async () => {
  const h = harness();
  const ownerRequest = say('apaga a biblioteca OrdersLib de teste');
  const words = say('ok, pode apagar OrdersLib');
  const preview = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET, authorize: words, ownerRequest });
  const args = { tenant: PERSONAL, assetKey: ASSET };

  const soon = await h.call('odc_asset_delete', confirm(preview, args, 'sim, apaga os 1: OrdersLib e OrdersApp'));
  assert.equal(soon.ok, false); assert.ok(codes(soon).includes('CONFIRMATION_TOO_SOON'), JSON.stringify(soon)); assert.equal(soon.sent, false);
  assert.equal(soon.continuation.arguments.confirmationToken, preview.confirmationToken, 'the same token once the problems are solved');
  h.clock.wait();
  const before = await h.call('odc_asset_delete', confirm(preview, args, words));
  assert.deepEqual(codes(before).sort(), ['CONFIRMATION_COUNT_MISMATCH', 'CONSUMERS_WOULD_BREAK', 'WORDS_BEFORE_PREVIEW'].sort());
  assert.ok(codes(await h.call('odc_asset_delete', confirm(preview, args, ownerRequest))).includes('WORDS_BEFORE_PREVIEW'), 'the owner request never confirms');
  const noCount = await h.call('odc_asset_delete', confirm(preview, args, 'sim, apaga OrdersLib e OrdersApp'));
  assert.deepEqual(codes(noCount), ['CONFIRMATION_COUNT_MISMATCH']); assert.equal(noCount.problems[0].expected, 1);
  const consumer = await h.call('odc_asset_delete', confirm(preview, args, 'sim, apaga os 1 OrdersLib'));
  assert.deepEqual(codes(consumer), ['CONSUMERS_WOULD_BREAK']); assert.equal(consumer.problems[0].target, 'OrdersApp');
  const unnamed = await h.call('odc_asset_delete', confirm(preview, args, 'sim, apaga os 1 e o OrdersApp'));
  assert.deepEqual(codes(unnamed), ['DESTRUCTIVE_TARGET_NOT_NAMED']);
  const other = await h.call('odc_asset_delete', confirm(preview, { ...args, assetKey: OTHER_ASSET }, 'sim, apaga os 1: OrdersLib e OrdersApp'));
  assert.ok(codes(other).includes('PREVIEW_OTHER_TARGET'));
  const wrongUuid = await h.call('odc_asset_delete', { ...confirm(preview, args, 'sim, apaga os 1: OrdersLib e OrdersApp'), operationUuid: uuid() });
  assert.deepEqual(codes(wrongUuid), ['PREVIEW_OTHER_TARGET']); assert.equal(wrongUuid.problems[0].path, '/operationUuid');
  const { operationUuid, ...missing } = confirm(preview, args, 'sim, apaga os 1: OrdersLib e OrdersApp');
  assert.deepEqual(codes(await h.call('odc_asset_delete', missing)), ['INPUT_INVALID']);
  const unknown = await h.call('odc_asset_delete', { ...confirm(preview, args, 'sim, apaga os 1: OrdersLib e OrdersApp'), confirmationToken: uuid() + '.0123456789abcdef' });
  assert.deepEqual(codes(unknown), ['PREVIEW_UNKNOWN']); assert.equal(unknown.continuation.arguments.confirmationToken, undefined, 'a new preview, without token');
  // The token of another tool: an odc_write preview never deletes an asset.
  const user = await h.call('odc_write', { tenant: PERSONAL, operationId: DELETE_USER, path: { key: USER } });
  h.clock.wait();
  const crossed = await h.call('odc_asset_delete', confirm(user, args, 'sim, apaga os 1: OrdersLib e OrdersApp'));
  assert.ok(codes(crossed).includes('PREVIEW_OTHER_TARGET')); assert.equal(crossed.problems.find(p => p.code === 'PREVIEW_OTHER_TARGET').previewOf.tool, 'odc_write');
  // Corporate tenant: the reply names the tenant and confirmTenant carries it, as today, in the same refusal.
  const corp = await h.call('odc_asset_delete', { tenant: CORP, assetKey: ASSET });
  h.clock.wait();
  const guarded = await h.call('odc_asset_delete', confirm(corp, { tenant: CORP, assetKey: ASSET }, 'sim, apaga os 1: OrdersLib e OrdersApp'));
  assert.deepEqual(codes(guarded), ['CORPORATE_TENANT_GUARD']);
  for (const answer of [soon, before, noCount, consumer, other, wrongUuid, unknown, crossed, guarded]) {
    assert.equal(answer.sent, false); assert.ok(bytes(answer) <= 8192, 'a refusal fits its budget: ' + bytes(answer));
    assert.match(answer.error, /^\d+ problem\(s\); nothing was sent$/);
  }
  assert.deepEqual(h.sends, []); assert.equal(h.events.length, 0);
});

test('odc_asset_delete: a consumer that appeared after the preview is PREVIEW_STALE with a new preview in the same answer; nothing sent', async () => {
  const h = harness();
  const preview = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET });
  h.state.assets[ASSET].consumers.push('BillingApp');
  h.clock.wait();
  const stale = await h.call('odc_asset_delete', confirm(preview, { tenant: PERSONAL, assetKey: ASSET }, 'sim, apaga os 1: OrdersLib, OrdersApp e BillingApp'));
  assert.equal(stale.ok, false); assert.ok(codes(stale).includes('PREVIEW_STALE'), JSON.stringify(stale));
  assert.deepEqual(stale.problems.find(p => p.code === 'PREVIEW_STALE').diff.consumersChanged, ['OrdersLib']);
  assert.notEqual(stale.preview.confirmationToken, preview.confirmationToken); assert.deepEqual(stale.preview.items[0].consumers, ['OrdersApp', 'BillingApp']);
  assert.equal(stale.continuation.arguments.confirmationToken, stale.preview.confirmationToken); assert.equal(stale.continuation.arguments.operationUuid, stale.preview.operationId);
  assert.ok(bytes(stale) <= 8192); assert.deepEqual(h.sends, []);
  h.clock.wait();
  const done = await h.call('odc_asset_delete', confirm(stale.preview, { tenant: PERSONAL, assetKey: ASSET }, 'confirmo, apaga os 1: OrdersLib, OrdersApp e BillingApp'));
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(h.sends.length, 1);
});

test('odc_asset_delete without an API Client: the preview says backup possible:false and why; the confirmed list deletes with no download', async () => {
  const h = harness({ apiClient: false });
  const preview = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET });
  assert.equal(preview.items[0].backup.possible, false); assert.match(preview.items[0].backup.why, /no API Client stored/);
  assert.deepEqual(preview.backupPlan.notPossible.map(n => n.name), ['OrdersLib']);
  h.clock.wait();
  const done = await h.call('odc_asset_delete', confirm(preview, { tenant: PERSONAL, assetKey: ASSET }, 'sim, apaga os 1: OrdersLib e OrdersApp'));
  assert.equal(done.ok, true); assert.equal(h.sends.length, 1); assert.deepEqual(h.events, ['send:assetDelete']); assert.equal(done.backup, undefined);
});

test('a refusal of the identity read (no Studio session) answers the retry as a call step without the owner\'s words; nothing previewed or sent', async () => {
  const h = harness({ studioSignedOut: true });
  const ownerRequest = say('apaga a OrdersLib do tenant pessoal agora');
  const out = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET, ownerRequest, authorize: say('ok, apaga a OrdersLib') });
  assert.equal(out.ok, false); assert.equal(out.code, 'STUDIO_NOT_SIGNED_IN'); assert.equal(out.confirmationToken, undefined); assert.deepEqual(h.previews(), []);
  assert.deepEqual(out.continuation.arguments, { tenant: PERSONAL, assetKey: ASSET, auth: 'api-client' });
  assert.doesNotMatch(JSON.stringify(out), /apaga a OrdersLib/); assert.deepEqual(h.sends, []);
  const retried = await h.call(out.continuation.tool, out.continuation.arguments);
  assert.equal(retried.state, 'previewed', JSON.stringify(retried));
});

test('a backup that fails stops the item before its DELETE: BACKUP_FAILED, the record says backup-failed, nothing sent', async () => {
  const h = harness({ sourceFails: true });
  const preview = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET });
  h.clock.wait();
  const failed = await h.call('odc_asset_delete', confirm(preview, { tenant: PERSONAL, assetKey: ASSET }, 'sim, apaga os 1: OrdersLib e OrdersApp'));
  assert.equal(failed.ok, false); assert.equal(failed.code, 'BACKUP_FAILED'); assert.equal(failed.problems[0].cause, 'SOURCE_DOWNLOAD_FAILED');
  assert.deepEqual(h.sends, []); assert.deepEqual(h.events, ['source:' + ASSET + ':r3']);
  const record = readOperation(preview.operationId, { root: h.root });
  assert.equal(record.state, 'refused'); assert.equal(record.items[0].state, 'backup-failed');
  // Spent: the same token answers by the record and sends nothing.
  const again = await h.call('odc_asset_delete', confirm(preview, { tenant: PERSONAL, assetKey: ASSET }, 'sim, apaga os 1: OrdersLib e OrdersApp'));
  assert.equal(again.alreadyExecuted, true); assert.equal(again.sent, false); assert.equal(again.continuation.arguments.confirmationToken, undefined); assert.deepEqual(h.sends, []);
});

test('odc_write: a DELETE previews its target (targetNames and the detail read) and sends once after the reply; a PATCH is sent as today, with no preview', async () => {
  const h = harness();
  const patch = { tenant: PERSONAL, operationId: PATCH_USER, path: { key: USER }, body: { name: 'Jane Renamed' }, authorize: say('pode renomear a Jane Synthetic'), operationUuid: uuid() };
  const changed = await h.call('odc_write', patch);
  assert.equal(changed.ok, true); assert.equal(h.sends.length, 1); assert.equal(h.sends[0].input.operationUuid, patch.operationUuid); assert.deepEqual(h.previews(), [], 'a non-destructive write never previews');
  const preview = await h.call('odc_write', { tenant: PERSONAL, operationId: DELETE_USER, path: { key: USER } });
  assert.equal(preview.ok, true); assert.deepEqual(preview.items.map(i => [i.kind, i.key, i.name]), [['users', USER, 'Jane Synthetic']]);
  assert.deepEqual(preview.mustName, ['Jane Synthetic', 'jane@example.test', USER]); assert.deepEqual(preview.backupPlan.possible, ['Jane Synthetic']);
  assert.deepEqual(preview.continuation.arguments.path, { key: USER }); assert.equal(h.sends.length, 1);
  h.clock.wait();
  const unnamed = await h.call('odc_write', confirm(preview, { tenant: PERSONAL, operationId: DELETE_USER, path: { key: USER } }, 'sim, apaga os 1 usuarios'));
  assert.deepEqual(codes(unnamed), ['DESTRUCTIVE_TARGET_NOT_NAMED']); assert.equal(h.sends.length, 1);
  const done = await h.call('odc_write', confirm(preview, { tenant: PERSONAL, operationId: DELETE_USER, path: { key: USER } }, 'sim, apaga os 1: a Jane Synthetic'));
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(h.sends.length, 2); assert.equal(h.sends[1].input.operationUuid, preview.operationId);
  assert.deepEqual(JSON.parse(fs.readFileSync(done.backup[0].files[0].path, 'utf8')), h.state.users[USER], 'the detail read is the backup');
  // An approval file of a typed context goes back into the call that repeats it (the handler moved it into options).
  const contextual = await h.call('odc_write', { tenant: PERSONAL, operationId: DELETE_USER, path: { key: USER }, authorizationContext: APPROVAL, originOperationUuid: ORIGIN });
  assert.equal(contextual.continuation.arguments.authorizationContext, APPROVAL); assert.equal(contextual.continuation.arguments.originOperationUuid, ORIGIN);
  // An Undeploy through odc_write is destructive by its body (effects.mjs): a preview.
  const undeploy = await h.call('odc_write', { tenant: PERSONAL, operationId: DEPLOY, body: { operation: 'Undeploy', assetKey: ASSET, environmentKey: ENV_QA } });
  assert.equal(undeploy.state, 'previewed'); assert.equal(undeploy.items[0].key, ASSET + '@' + ENV_QA); assert.equal(h.sends.length, 2);
});

test('odc_deploy: Undeploy previews the app and its stage, then one deploy call; Deploy is unchanged', async () => {
  const h = harness();
  const deploy = { tenant: PERSONAL, assetKey: ASSET, environmentKey: ENV_QA, authorize: say('pode publicar OrdersLib em QA'), operationUuid: uuid() };
  assert.equal((await h.call('odc_deploy', deploy)).ok, true); assert.equal(h.sends.length, 1); assert.deepEqual(h.previews(), []);
  const preview = await h.call('odc_deploy', { tenant: PERSONAL, assetKey: ASSET, environmentKey: ENV_QA, operation: 'Undeploy' });
  assert.equal(preview.ok, true); assert.deepEqual(preview.items.map(i => [i.kind, i.name, i.stage]), [['deployment', 'OrdersLib', 'QA']]); assert.equal(h.sends.length, 1);
  h.clock.wait();
  const done = await h.call('odc_deploy', confirm(preview, { tenant: PERSONAL, assetKey: ASSET, environmentKey: ENV_QA, operation: 'Undeploy' }, 'sim, tira os 1: OrdersLib de QA'));
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(h.sends.length, 2);
  assert.deepEqual([h.sends[1].input.operation, h.sends[1].input.operationUuid, h.sends[1].input.assetKey], ['Undeploy', preview.operationId, ASSET]);
});

// The inputs of every Portal route whose effect is destructive; a new one makes this table (and the guard's) fail first.
const ROUTES = {
  'apiClients.delete': [{ Key: 'aaaabbbb-cccc-4ddd-8eee-ffffaaaabbbb' }, 'ssam-fixture-client'],
  'aiModels.trialDelete': [{ AIModelId: 'bbbbcccc-dddd-4eee-8fff-aaaabbbbcccc' }, null],
  'knowledgeBases.delete': [{ KnowledgeBaseId: 'kb-1' }, 'SSAM KB fixture'],
  'connections.delete': [{ ConnectionId: CONN, ProviderId: 'customAISearch' }, 'SSAM search fixture'],
  'agents.datasetDelete': [{ DatasetId: 'ds-1' }, 'SSAM dataset fixture'],
  'agents.evaluationDelete': [{ EvaluationId: 'ev-1' }, null],
};
test('odc_portal_write: every destructive route previews (0 writes) and runs once with its own approval; without it, or with a wrong one, nothing is sent; other routes unchanged', async () => {
  assert.deepEqual(Object.keys(ROUTES).sort(), Object.entries(PORTAL_WRITES).filter(([, r]) => r.effect === 'destructive').map(([id]) => id).sort());
  const h = harness();
  for (const [operationId, [inputParameters, name]] of Object.entries(ROUTES)) {
    const args = { tenant: PERSONAL, operationId, input: { inputParameters } };
    const preview = await h.call('odc_portal_write', args);
    assert.equal(preview.ok, true, operationId + ' ' + JSON.stringify(preview)); assert.equal(preview.items[0].name, name ?? Object.values(inputParameters).join('/'), operationId);
    assert.equal(preview.items[0].backup.possible, name !== null, operationId);
    const sent = h.sends.length;
    h.clock.wait();
    const missing = await h.call('odc_portal_write', confirm(preview, args, 'sim, apaga os 1 fixtures sem aprovação, ' + operationId));
    assert.deepEqual(codes(missing), ['DESTRUCTIVE_TARGET_NOT_NAMED'], operationId); assert.equal(h.sends.length, sent);
    const done = await h.call('odc_portal_write', confirm(preview, { ...args, authorizationContext: APPROVAL }, 'sim, apaga os 1 fixtures, ' + operationId));
    assert.equal(done.ok, true, operationId + ' ' + JSON.stringify(done)); assert.equal(h.sends.length, sent + 1, operationId);
    assert.deepEqual([h.sends.at(-1).input.authorizationContext, h.sends.at(-1).input.operationUuid], [APPROVAL, preview.operationId], operationId);
  }
  // The approval itself is still decided by the unguarded tool: a wrong one refuses there, nothing sent, the token spent.
  const args = { tenant: PERSONAL, operationId: 'agents.datasetDelete', input: { inputParameters: { DatasetId: 'ds-1' } } };
  const preview = await h.call('odc_portal_write', args);
  h.clock.wait();
  const sent = h.sends.length;
  const wrong = await h.call('odc_portal_write', confirm(preview, { ...args, authorizationContext: 'C:/private/other.json' }, 'sim, apaga os 1 SSAM dataset fixture'));
  assert.equal(wrong.code, 'AUTHORIZATION_CONTEXT_INVALID'); assert.equal(h.sends.length, sent);
  assert.equal(wrong.operation.state, 'refused'); assert.equal(wrong.continuation.arguments.confirmationToken, undefined, 'a new preview: the token is spent');
  // A route that is not destructive goes straight through.
  const timer = { tenant: PERSONAL, operationId: 'timers.run', input: { inputParameters: { StageKey: ENV_QA, ApplicationKey: ASSET, TimerKey: USER } }, authorize: say('pode rodar o timer'), operationUuid: uuid() };
  assert.equal((await h.call('odc_portal_write', timer)).ok, true); assert.equal(h.sends.length, sent + 1); assert.equal(h.sends.at(-1).input.operationId, 'timers.run');
});

test('odc_a2a_connection_delete: the owned connection previews by its detail; the reply with the approval deletes once; another connection is refused', async () => {
  const h = harness();
  const args = { tenant: PERSONAL, connectionId: A2A, originOperationUuid: ORIGIN };
  const preview = await h.call('odc_a2a_connection_delete', args);
  assert.equal(preview.ok, true); assert.deepEqual(preview.items.map(i => [i.kind, i.name]), [['a2a-connection', 'SSAM agent fixture']]); assert.deepEqual(h.sends, []);
  h.clock.wait();
  const other = await h.call('odc_a2a_connection_delete', confirm(preview, { ...args, connectionId: CONN, authorizationContext: APPROVAL }, 'sim, apaga os 1: SSAM agent fixture'));
  assert.ok(codes(other).includes('PREVIEW_OTHER_TARGET')); assert.deepEqual(h.sends, []);
  const noApproval = await h.call('odc_a2a_connection_delete', confirm(preview, args, 'sim, apaga os 1: SSAM agent fixture'));
  assert.deepEqual(codes(noApproval), ['AUTHORIZATION_CONTEXT_INVALID']); assert.deepEqual(h.sends, []);
  const done = await h.call('odc_a2a_connection_delete', confirm(preview, { ...args, authorizationContext: APPROVAL }, 'sim, apaga os 1: SSAM agent fixture'));
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(h.sends.length, 1); assert.equal(h.sends[0].input.operationUuid, preview.operationId);
  assert.deepEqual(JSON.parse(fs.readFileSync(done.backup[0].files[0].path, 'utf8')), { Connection: { name: 'SSAM agent fixture', providerId: 'a2a' } });
});

// CX15 r2 (F, M4; provisional decision "strict", the owner may revert it): an own fixture (its approval's origin receipt is
// in SSAM's journal) no longer keeps the words of its approval: the standing consent is a word said before the list and
// has no count, so it never confirms; the owner's reply after the list, with the count, deletes once; the answer still
// says ownFixture. A foreign origin gets the same rules.
test('an own fixture gets every rule of the execution (strict, as in the O11 lane): its standing consent never confirms; the reply after the list with the count deletes once', async () => {
  const h = harness();
  h.receipts.set(ORIGIN, { operationUuid: ORIGIN, state: 'confirmed' });
  const standing = say('Standing consent for the fixtures SSAM creates in this proof');
  const args = { tenant: PERSONAL, connectionId: A2A, originOperationUuid: ORIGIN, authorizationContext: APPROVAL, authorize: standing };
  const preview = await h.call('odc_a2a_connection_delete', args);
  assert.equal(preview.code, 'CONFIRMATION_REQUIRED'); assert.deepEqual(h.sends, []);
  const soon = await h.call('odc_a2a_connection_delete', { ...args, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId });
  assert.deepEqual(codes(soon).sort(), ['CONFIRMATION_COUNT_MISMATCH', 'CONFIRMATION_TOO_SOON', 'WORDS_BEFORE_PREVIEW']); assert.deepEqual(h.sends, []);
  h.clock.wait();
  const standingAgain = await h.call('odc_a2a_connection_delete', { ...args, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId });
  assert.deepEqual(codes(standingAgain).sort(), ['CONFIRMATION_COUNT_MISMATCH', 'WORDS_BEFORE_PREVIEW']); assert.deepEqual(h.sends, []);
  const done = await h.call('odc_a2a_connection_delete', confirm(preview, args, 'sim, apaga os 1: SSAM agent fixture'));
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.ownFixture, true); assert.equal(h.sends.length, 1);
  const foreign = { ...args, originOperationUuid: uuid() };
  const second = await h.call('odc_a2a_connection_delete', foreign);
  h.clock.wait();
  const strict = await h.call('odc_a2a_connection_delete', { ...foreign, confirmationToken: second.confirmationToken, operationUuid: second.operationId });
  assert.deepEqual(codes(strict).sort(), ['CONFIRMATION_COUNT_MISMATCH', 'WORDS_BEFORE_PREVIEW']); assert.equal(h.sends.length, 1);
});

test('odc_external_db_connection: delete and remove-entities preview; objects come only in the preview; the execution takes them from the token; reads unchanged', async () => {
  const h = harness();
  assert.equal((await h.call('odc_external_db_connection', { tenant: PERSONAL, action: 'list' })).passthrough, true); assert.deepEqual(h.previews(), []);
  const del = { tenant: PERSONAL, action: 'delete', connectionId: 'db-1', providerId: 'mssql', originOperationUuid: ORIGIN };
  const preview = await h.call('odc_external_db_connection', del);
  assert.equal(preview.ok, true); assert.deepEqual(preview.items.map(i => [i.kind, i.name]), [['db-connection', 'SSAM SQL fixture']]);
  h.clock.wait();
  const done = await h.call('odc_external_db_connection', confirm(preview, { ...del, authorizationContext: APPROVAL }, 'sim, apaga os 1: SSAM SQL fixture'));
  assert.equal(done.ok, true, JSON.stringify(done)); assert.deepEqual(h.sends.map(s => s.kind), ['db:delete']);

  const remove = { tenant: PERSONAL, action: 'remove-entities', connectionId: 'db-1', originOperationUuid: ORIGIN, objects: ['Orders', 'Lines'] };
  const listed = await h.call('odc_external_db_connection', remove);
  assert.equal(listed.count, 2); assert.deepEqual(listed.items.map(i => [i.name, i.application]), [['Orders', 'SSAM SQL fixture'], ['Lines', 'SSAM SQL fixture']]);
  assert.equal(listed.continuation.arguments.objects, undefined, 'the confirmation call carries no list');
  h.clock.wait();
  const reply = 'sim, tira as 2 entidades Orders e Lines';
  const selected = await h.call('odc_external_db_connection', confirm(listed, { ...remove, authorizationContext: APPROVAL }, reply));
  assert.deepEqual(codes(selected), ['SELECTION_ONLY_IN_PREVIEW']); assert.equal(h.sends.length, 1);
  const { objects, ...rest } = remove;
  const otherConnection = await h.call('odc_external_db_connection', confirm(listed, { ...rest, connectionId: CONN, authorizationContext: APPROVAL }, 'ok, tira as 2 entidades Orders e Lines'));
  assert.deepEqual(codes(otherConnection), ['PREVIEW_OTHER_TARGET']); assert.equal(h.sends.length, 1);
  const removed = await h.call('odc_external_db_connection', confirm(listed, { ...rest, authorizationContext: APPROVAL }, 'confirmo, tira as 2 entidades Orders e Lines'));
  assert.equal(removed.ok, true, JSON.stringify(removed)); assert.equal(h.sends.length, 2); assert.deepEqual(h.sends[1].input.objects, ['Orders', 'Lines']);
  assert.deepEqual(removed.operation.counts, { deleted: 2 }); assert.deepEqual(JSON.parse(fs.readFileSync(removed.backup[0].files[0].path, 'utf8')), { Name: 'Orders', Selected: true });
});

test('odc_external_library discard: preview of the open job, the reply naming the library with the count discards once; words without the library refuse; the deployer gets the unguarded access', async () => {
  const fake = fakeAccess(), clock = clockAt();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-extlib-')); roots.push(root);
  const seenAccess = [];
  class FakeDeployer { constructor({ access }) { seenAccess.push(access); } async discard(args) { return fake.access.receipts.lookup(args.operationUuid) ? { ok: true, existingReceipt: true, receipt: fake.receipts.get(args.operationUuid), jobKey: args.jobKey }
    : (fake.sends.push({ kind: 'discard', input: args }), fake.receipts.set(args.operationUuid, { operationUuid: args.operationUuid, state: 'confirmed' }), { ok: true, receipt: fake.receipts.get(args.operationUuid), jobKey: args.jobKey, readBack: { gone: true } }); } }
  const guarded = guardedAccess(fake.access, { now: clock.now, root });
  const tools = new Map();
  registerExternalLibrary({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) },
    { access: guarded, wrap: fn => fn, portalRuntime: { deployer: { ExternalLibraryDeployer: FakeDeployer }, uploads: {} }, uploaders: {} });
  const call = async args => budget(await tools.get('odc_external_library').handler(tools.get('odc_external_library').config.inputSchema.parse(args)));
  const preview = await call({ action: 'discard', tenant: PERSONAL, library: 'SSAMTextTools' });
  assert.equal(preview.ok, true, JSON.stringify(preview)); assert.deepEqual(preview.items.map(i => [i.kind, i.key, i.name]), [['external-library-job', 'job-9', 'SSAMTextTools']]);
  assert.equal(preview.jobKey, 'job-9'); assert.equal(preview.continuation.arguments.action, 'discard'); assert.deepEqual(fake.sends, []);
  clock.wait();
  const unnamed = await call(confirm(preview, { action: 'discard', tenant: PERSONAL }, 'sim, descarta os 1 jobs'));
  assert.deepEqual(codes(unnamed).sort(), ['DESTRUCTIVE_TARGET_NOT_NAMED', 'WORDS_MUST_NAME_LIBRARY']); assert.deepEqual(fake.sends, []);
  const done = await call(confirm(preview, { action: 'discard', tenant: PERSONAL }, 'sim, descarta os 1 job do SSAMTextTools'));
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(fake.sends.length, 1);
  assert.deepEqual([fake.sends[0].input.jobKey, fake.sends[0].input.operationUuid], ['job-9', preview.operationId]);
  assert.equal(seenAccess[0], fake.access, 'the deployer writes through the unguarded access'); assert.equal(unguarded(guarded), fake.access);
  // The same guard without the wiring (registerExternalLibrary over a raw access) still previews: the entry is guarded.
  const raw = createExternalLibraryTool({ access: fake.access, portalRuntime: { deployer: { ExternalLibraryDeployer: FakeDeployer }, uploads: {} }, uploaders: {}, destructive: { now: clock.now, root } });
  assert.equal((await raw({ action: 'discard', tenant: PERSONAL, jobKey: 'job-9' })).state, 'previewed'); assert.equal(fake.sends.length, 1);
});

// Every destructive ODC tool (inventory lines 9-14): the call with words is CONFIRMATION_REQUIRED with the preview and
// writes nothing; the target renamed before the execution is PREVIEW_STALE with a new preview; its confirmation writes once.
const STALE = [
  ['odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET }, s => { s.assets[ASSET].name = 'OrdersLibV2'; }, 'sim, apaga os 1: OrdersLibV2 e OrdersApp'],
  ['odc_write', { tenant: PERSONAL, operationId: DELETE_USER, path: { key: USER } }, s => { s.users[USER].name = 'Jane Renamed'; }, 'sim, apaga os 1: Jane Renamed'],
  ['odc_deploy', { tenant: PERSONAL, assetKey: ASSET, environmentKey: ENV_QA, operation: 'Undeploy' }, s => { s.assets[ASSET].name = 'OrdersLibV2'; }, 'sim, tira os 1: OrdersLibV2'],
  ['odc_portal_write', { tenant: PERSONAL, operationId: 'connections.delete', input: { inputParameters: { ConnectionId: CONN, ProviderId: 'customAISearch' } }, authorizationContext: APPROVAL },
    s => { s.connections[CONN].name = 'SSAM search renamed'; }, 'sim, apaga os 1: SSAM search renamed'],
  ['odc_a2a_connection_delete', { tenant: PERSONAL, connectionId: A2A, originOperationUuid: ORIGIN, authorizationContext: APPROVAL }, s => { s.connections[A2A].name = 'SSAM agent renamed'; }, 'sim, apaga os 1: SSAM agent renamed'],
  ['odc_external_db_connection', { tenant: PERSONAL, action: 'delete', connectionId: 'db-1', providerId: 'mssql', originOperationUuid: ORIGIN, authorizationContext: APPROVAL },
    s => { s.connections['db-1'].name = 'SSAM SQL renamed'; }, 'sim, apaga os 1: SSAM SQL renamed'],
  ['odc_external_library', { action: 'discard', tenant: PERSONAL, jobKey: 'job-9' }, s => { s.jobs['job-9'].libraryName = 'SSAMTextToolsV2'; }, 'sim, descarta os 1 job do SSAMTextToolsV2'],
];
for (const [name, args, rename, reply] of STALE) test(name + ': words without a token only preview (0 writes); a renamed target is PREVIEW_STALE with a new preview; its confirmation writes exactly once', async () => {
  const h = harness();
  const preview = await h.call(name, { ...args, authorize: say('ok, pode apagar isso via ' + name) });
  assert.equal(preview.code, 'CONFIRMATION_REQUIRED', JSON.stringify(preview)); assert.equal(preview.count, 1); assert.deepEqual(h.sends, []);
  rename(h.state); h.clock.wait();
  const stale = await h.call(name, confirm(preview, args, say(reply)));
  assert.ok(codes(stale).includes('PREVIEW_STALE'), JSON.stringify(stale)); assert.equal(stale.problems.find(p => p.code === 'PREVIEW_STALE').diff.renamed.length, 1);
  assert.ok(stale.preview.confirmationToken && stale.preview.confirmationToken !== preview.confirmationToken); assert.deepEqual(h.sends, []);
  h.clock.wait();
  const done = await h.call(name, confirm(stale.preview, args, 'confirmo a lista nova, ' + reply));
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(h.sends.length, 1); assert.equal(h.sends[0].input.operationUuid, stale.preview.operationId);
  assert.equal(readOperation(stale.preview.operationId, { root: h.root }).items[0].state, 'deleted');
});

test('.\\odc studio refuses the four destructive bridge commands without calling the bridge', async () => {
  const cli = path.resolve(here, '..', 'odc.mjs');
  const run = args => new Promise(resolve => execFile(process.execPath, [cli, 'studio', ...args], { env: { ...process.env, SSAM_ODC_OFFLINE: '1' }, windowsHide: true, timeout: 60000 },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })));
  for (const command of [...DESTRUCTIVE_BRIDGE_COMMANDS, 'Data-Delete']) {
    const out = await run(['--pid', '4242', command, '--module', 'Orders', '--ids', '1']);
    const answer = JSON.parse(out.stdout);
    assert.equal(out.code, 1, command); assert.equal(answer.code, 'DESTRUCTIVE_NEEDS_DEDICATED_TOOL', command); assert.equal(answer.outcome, 'not-sent');
    assert.equal(answer.command, command.toLowerCase()); assert.match(answer.error, /\.\\odc studio never runs/); assert.equal(typeof answer.continuation.tool, 'string');
  }
});

test('the strict schemas of the destructive tools take confirmationToken and ownerRequest; authorize and operationUuid serve only the execution', async () => {
  const h = harness();
  for (const name of ['odc_asset_delete', 'odc_write', 'odc_portal_write', 'odc_deploy', 'odc_a2a_connection_delete', 'odc_external_db_connection']) {
    const shape = h.tools.get(name).config.inputSchema.shape;
    for (const field of ['confirmationToken', 'ownerRequest', 'authorize', 'operationUuid']) assert.equal(shape[field].isOptional(), true, name + '.' + field);
  }
  assert.throws(() => h.tools.get('odc_asset_delete').config.inputSchema.parse({ assetKey: ASSET, confirmationTokens: 'x' }), /confirmationTokens|unrecognized/i);
});

// The real OdcAccess over a fake ODC Studio bridge (portal-call) and an in-memory tenant: the whole asset delete.
test('real OdcAccess: the preview sends nothing, the confirmed reply sends exactly one DELETE, the same token never again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-real-'));
  const root = path.join(dir, 'destructive'); roots.push(root);
  const assets = { [ASSET]: { assetKey: ASSET, name: 'OrdersLib', revision: 2, assetType: 'Library' } };
  const writes = [], requests = new Map(); let n = 0;
  const reply = (body, status = 200) => ({ ok: true, status, contentType: 'application/json', body, host: PERSONAL });
  const tenantCall = request => {
    const route = request.basePath + request.path; let m;
    if (request.method !== 'GET') writes.push(request.method + ' ' + route);
    if (route === '/api/portfolios/v2/environments') return reply({ results: [{ key: 'dev' }, { key: 'qa' }] });
    if ((m = /^\/api\/dependency-management\/v1\/assets\/([^/]+)\/consumers$/.exec(route))) return reply({ results: [] });
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
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: PERSONAL, tenants: { [PERSONAL]: { class: 'personal' } } }, studio,
    vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('no vault in this test'); } },
    prompt: { apiClient: async () => ({ opened: true }), portal: async () => ({ opened: true }) }, portalBroker: () => ({ available: false, authenticated: false, initialize: async () => {} }),
    receipts: new WriteJournal(path.join(dir, 'receipts')), sleep: async () => {}, requestFile: json => { const file = 'req-' + (++n); requests.set(file, structuredClone(json)); return file; } });
  const clock = clockAt();
  const tools = new Map();
  registerAccessTools({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, guardedAccess(access, { now: clock.now, root }), fn => fn);
  const call = async args => budget(await tools.get('odc_asset_delete').handler(tools.get('odc_asset_delete').config.inputSchema.parse(args)));
  const preview = await call({ tenant: PERSONAL, assetKey: ASSET, authorize: say('apaga a OrdersLib') });
  assert.equal(preview.code, 'CONFIRMATION_REQUIRED', JSON.stringify(preview)); assert.deepEqual(preview.items.map(i => [i.name, i.consumers]), [['OrdersLib', []]]);
  const receiptFiles = () => (fs.existsSync(path.join(dir, 'receipts')) ? fs.readdirSync(path.join(dir, 'receipts')).filter(f => f.endsWith('.json')) : []);
  assert.equal(preview.items[0].backup.possible, false); assert.deepEqual(writes, []); assert.deepEqual(receiptFiles(), []);
  clock.wait();
  const done = await call(confirm(preview, { tenant: PERSONAL, assetKey: ASSET }, 'sim, apaga os 1: OrdersLib'));
  assert.equal(done.ok, true, JSON.stringify(done)); assert.deepEqual(writes, ['DELETE /api/asset-repository/v1/assets/' + ASSET]);
  assert.equal(done.receipt.operationUuid, preview.operationId); assert.equal(done.receipt.state, 'confirmed'); assert.equal(done.readBack.gone, true);
  assert.equal(done.operation.state, 'completed');
  const again = await call(confirm(preview, { tenant: PERSONAL, assetKey: ASSET }, 'sim, apaga os 1: OrdersLib'));
  assert.equal(again.alreadyExecuted, true); assert.equal(writes.length, 1, 'the same token never sends again'); assert.deepEqual(receiptFiles(), [preview.operationId + '.json']);
});

// The wiring the principal applies in mcp.mjs (registerAccessTools and registerExternalLibrary over guardedAccess), through
// the MCP SDK and the wrap of mcp.mjs: the preview with words is an error answer (isError) carrying the whole preview.
test('through the MCP SDK and the wrap of mcp.mjs: CONFIRMATION_REQUIRED is an error answer with the preview; the reply executes once', async () => {
  const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const { wrap } = await import('../mcp.mjs');
  const fake = fakeAccess(), clock = clockAt();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-sdk-')); roots.push(root);
  const server = new McpServer({ name: 't', version: '0' });
  const destructiveAccess = guardedAccess(fake.access, { now: clock.now, root });
  registerAccessTools(server, destructiveAccess, wrap);
  registerExternalLibrary(server, { access: destructiveAccess, wrap });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const preview = await client.callTool({ name: 'odc_asset_delete', arguments: { tenant: PERSONAL, assetKey: ASSET, authorize: say('pode apagar a OrdersLib inteira') } });
    assert.equal(preview.isError, true); assert.equal(preview.structuredContent.code, 'CONFIRMATION_REQUIRED');
    assert.equal(preview.structuredContent.continuation.tool, 'odc_asset_delete'); assert.deepEqual(fake.sends, []);
    clock.wait();
    const done = await client.callTool({ name: 'odc_asset_delete', arguments: confirm(preview.structuredContent, { tenant: PERSONAL, assetKey: ASSET }, 'sim, apaga os 1: OrdersLib e OrdersApp') });
    assert.equal(done.isError, undefined, JSON.stringify(done.structuredContent)); assert.equal(fake.sends.length, 1);
    const discard = await client.callTool({ name: 'odc_external_library', arguments: { action: 'discard', tenant: PERSONAL, jobKey: 'job-9' } });
    assert.equal(discard.structuredContent.state, 'previewed'); assert.equal(fake.sends.length, 1);
  } finally { await client.close(); await server.close(); }
});

test('no preview, record, seen-words line or backup holds the owner\'s words (only their sha256)', () => {
  const files = [];
  const walk = dir => { if (!fs.existsSync(dir)) return; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); entry.isDirectory() ? walk(full) : files.push(full); } };
  for (const root of [...roots, destructiveRoot()]) walk(root);
  assert.ok(files.length > 20, 'the suite wrote previews, records, seen-words and backups: ' + files.length);
  assert.ok(files.some(f => f.includes(path.sep + 'seen-words' + path.sep)) && files.some(f => f.includes(path.sep + 'backups' + path.sep)));
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const words of SAID) {
      assert.equal(content.includes(words.toLowerCase()), false, file + ' holds: ' + words);
      assert.equal(content.includes(normalizeWords(words)), false, file + ' holds the normalized form of: ' + words);
    }
  }
});
