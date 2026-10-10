import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Catalog } from '../runtime/catalog.mjs';
import { MAX_ROUTE_ACTIONS, MAX_ROUTE_SCREENS, OdcAccess, guardPortalTarget, guardTenant, guardTarget } from '../runtime/access.mjs';
import { WriteJournal } from '../runtime/write-journal.mjs';
import { OPERATION_STATUS, SEARCH_POSTS, TARGET_NAMES, effectOf, readable } from '../runtime/effects.mjs';
import { PORTAL_CAPTURE, PORTAL_GAPS, PORTAL_READS, PORTAL_WRITES, NEVER_EXPOSED, routeOf } from '../runtime/portal-routes.mjs';
import { sampleRequest } from './helpers.mjs';

// Offline: fakes of the ODC Studio bridge (auth-status, portal-call, portal-session), of the vault (status and an
// OdcBridge) and of the private prompt. Nothing here reaches a Studio, a vault, a tenant or a window.
const catalog = new Catalog();
const PERSONAL = 'personal-test.outsystems.dev', CORPORATE = 'corp.outsystems.dev', CLIENT = 'client.outsystems.dev', OTHER = 'other-test.outsystems.dev';
const tenants = { default: PERSONAL, tenants: {
  [PERSONAL]: { class: 'personal', portalOrigin: 'https://' + PERSONAL }, [OTHER]: { class: 'personal', portalOrigin: 'https://' + OTHER },
  [CORPORATE]: { class: 'corporate', portalOrigin: 'https://' + CORPORATE }, [CLIENT]: { class: 'client', readOnly: true, portalOrigin: 'https://' + CLIENT } } };
const WORDS = 'yes, do it on the personal tenant now';
const uuid = () => crypto.randomUUID();
const ASSETS = 'asset-repository-api-v1:get:/assets';
const ASSET = 'asset-repository-api-v1:get:/assets/{assetKey}';
const DELETE_ASSET = 'asset-repository-api-v1:delete:/assets/{assetKey}';
const PATCH_ROLE = 'user-access-management-api-v1:patch:/organization-roles/{key}';
const ROLE1 = '11111111-1111-4111-8111-111111111111', ROLE2 = '22222222-2222-4222-8222-222222222222';
const ASSET1 = '33333333-3333-4333-8333-333333333333', ENV1 = '44444444-4444-4444-8444-444444444444', DEP1 = '55555555-5555-4555-8555-555555555555';

function harness({ running = true, connected = true, sessions = [{ host: PERSONAL, loggedIn: true, user: 'dev@example.test' }], apiClient = false, portalAccount = false,
  portalCall, portalSession, vaultExecute, brokerState = {}, capabilities, hosted = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-access-'));
  const calls = [], requests = new Map(), prompts = [], vaultCalls = [], journal = [], vaultAsked = [];
  const studio = {
    running: async () => running,
    call: async args => {
      calls.push(args);
      if (!connected) throw new Error('pipe not found');
      if (args[0] === 'auth-status') return { ok: true, bridge: 'v32', sessions, portalWindows: [], ...(capabilities ? { capabilities } : {}) };
      if (args[0] === 'portal-call') return portalCall ? portalCall(requests.get(args[1]), args) : { ok: true, status: 200, contentType: 'application/json', body: { items: [] }, source: 'studio', host: args[3] };
      if (args[0] === 'portal-session') return portalSession ? portalSession(args, args[1] === 'fetch' ? requests.get(args[2]) : null) : { ok: true, host: args.at(-1), signedIn: true };
      return { ok: false, error: 'Unknown command' };
    },
  };
  const vault = {
    apiClient: async host => { vaultAsked.push(['api-client', host]); return { available: typeof apiClient === 'function' ? apiClient(host) : apiClient }; },
    portal: async (host, database, setting) => { vaultAsked.push(['portal', host, database ?? null, setting ?? null]); return { available: typeof portalAccount === 'function' ? portalAccount(host, database, setting) : portalAccount }; },
    bridge: async host => ({ execute: async (operationId, input, mode) => { vaultCalls.push({ host, operationId, input, mode });
      return vaultExecute ? vaultExecute(operationId, input, mode) : { ok: true, operationId, status: 200, data: { from: 'vault' } }; } }),
  };
  const prompt = { apiClient: async host => { prompts.push(['api-client', host]); return { opened: true }; },
    portal: async (host, database, setting) => { prompts.push(['portal', host, database ?? null, ...(setting ? [setting] : [])]); return { opened: true }; } };
  const broker = { target: 'odc3', available: false, authenticated: false, initialize: async () => {}, status: () => ({ authenticated: broker.authenticated }), ...brokerState };
  let n = 0;
  const brokers = [];
  const access = new OdcAccess({ catalog, tenants, studio, vault, prompt, portalBroker: host => { brokers.push(host); return Object.assign(broker, { origin: 'https://' + host }); },
    journal: entry => journal.push(entry), receipts: new WriteJournal(path.join(dir, 'receipts')),
    requestFile: json => { const file = path.join(dir, 'req-' + (++n) + '.json'); requests.set(file, json); return file; }, sleep: async () => {}, hosted });
  return { access, calls, requests, prompts, vaultCalls, journal, dir, broker, vaultAsked, brokers };
}
const portalCalls = calls => calls.filter(c => c[0] === 'portal-call');

test('the six read-only POST searches are exact IDs; effect classes cover every operation', () => {
  assert.equal(SEARCH_POSTS.size, 6);
  for (const id of SEARCH_POSTS) { const op = catalog.operations.get(id); assert.equal(op.method, 'POST', id); assert.equal(op.readOnly, false); assert.equal(readable(op), true); }
  const counts = {};
  for (const op of catalog.operations.values()) counts[effectOf(op)] = (counts[effectOf(op)] ?? 0) + 1;
  assert.deepEqual(counts, { read: 98, 'search-post': 6, job: 5, 'mutation-job': 5, mutation: 37, destructive: 12 });
  assert.equal(effectOf(catalog.operations.get('deployments-api-v1:post:/deployment-operations'), { operation: 'Undeploy' }), 'destructive');
});

test('resolver: the Studio session on the tenant answers first; the vault and the prompt are not touched', async () => {
  const h = harness({ apiClient: true });
  const out = await h.access.read({ operationId: ASSETS, query: { limit: 1 } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.auth, { path: 'studio', host: PERSONAL, user: 'dev@example.test' });
  const call = portalCalls(h.calls)[0];
  assert.deepEqual(call.slice(2), ['--tenant', PERSONAL]);
  const request = h.requests.get(call[1]);
  assert.equal(request.basePath, '/api/asset-repository/v1'); assert.equal(request.path, '/assets'); assert.equal(request.method, 'GET');
  assert.equal(request.query, 'limit=1'); assert.equal(request.write, false); assert.equal(request.operationUuid, undefined);
  assert.equal(h.vaultCalls.length, 0); assert.equal(h.prompts.length, 0);
  assert.match(h.journal[0].note, /\[personal-test\.outsystems\.dev\] auth=studio status=200/);
});

test('resolver: a Studio open without a session on the tenant refuses (no prompt) and says whether the vault can serve', async () => {
  const h = harness({ apiClient: true });
  const out = await h.access.read({ tenant: CORPORATE, operationId: ASSETS });
  assert.equal(out.ok, false); assert.equal(out.code, 'STUDIO_NOT_SIGNED_IN'); assert.equal(out.vaultAvailable, true);
  assert.match(out.continuation, /auth:"api-client"/);
  assert.equal(portalCalls(h.calls).length, 0); assert.equal(h.prompts.length, 0); assert.equal(h.vaultCalls.length, 0);
  const viaVault = await h.access.read({ tenant: CORPORATE, auth: 'api-client', operationId: ASSETS });
  assert.equal(viaVault.ok, true); assert.equal(viaVault.auth.path, 'vault'); assert.equal(h.vaultCalls[0].host, CORPORATE);
  const outdated = harness({ connected: false });
  assert.equal((await outdated.access.read({ tenant: PERSONAL, operationId: ASSETS })).code, 'STUDIO_NOT_CONNECTED');
  assert.equal(outdated.prompts.length, 0);
});

test('resolver: without any Studio, the vault API Client; without it, one private prompt (never two at once)', async () => {
  const withVault = harness({ running: false, apiClient: true });
  const out = await withVault.access.read({ tenant: PERSONAL, operationId: ASSETS });
  assert.equal(out.auth.path, 'vault'); assert.equal(withVault.calls.length, 0);
  const none = harness({ running: false });
  const first = await none.access.read({ tenant: PERSONAL, operationId: ASSETS });
  assert.equal(first.code, 'CREDENTIAL_PROMPT_OPENED'); assert.deepEqual(first.auth, { path: 'prompt', host: PERSONAL });
  assert.deepEqual(none.prompts, [['api-client', PERSONAL]]);
  assert.equal((await none.access.read({ tenant: PERSONAL, operationId: ASSETS })).code, 'CREDENTIAL_PROMPT_PENDING');
  assert.equal(none.prompts.length, 1);
  // api-client forced while the Studio holds that tenant: no prompt, the Studio is the path.
  const forced = harness();
  assert.equal((await forced.access.read({ tenant: PERSONAL, auth: 'api-client', operationId: ASSETS })).code, 'AUTH_NOT_CONFIGURED');
  assert.equal(forced.prompts.length, 0);
});

test('tenant per call: several Studio sessions need the tenant; each call carries its own', async () => {
  const h = harness({ sessions: [{ host: PERSONAL, loggedIn: true, user: 'a' }, { host: OTHER, loggedIn: true, user: 'b' }] });
  assert.equal((await h.access.read({ operationId: ASSETS })).error.code, 'TENANT_REQUIRED');
  const out = await h.access.read({ tenant: 'https://' + OTHER.toUpperCase() + '/', operationId: ASSETS });
  assert.equal(out.tenant, OTHER); assert.equal(out.auth.user, 'b');
  assert.deepEqual(portalCalls(h.calls).at(-1).slice(2), ['--tenant', OTHER]);
  assert.equal((await h.access.read({ tenant: 'evil.example/../x', operationId: ASSETS })).error.code, 'INPUT_INVALID');
});

test('odc_read sends the read-only POST searches and refuses every mutation before contacting anything', async () => {
  const h = harness();
  for (const id of SEARCH_POSTS) {
    const op = catalog.operations.get(id);
    const search = await h.access.read({ operationId: id, ...sampleRequest(catalog.apis.get(op.apiId), op) });
    assert.equal(search.ok, true, id + ' ' + JSON.stringify(search.error));
    const sent = h.requests.get(portalCalls(h.calls).at(-1)[1]);
    assert.equal(sent.method, 'POST'); assert.equal(sent.write, false); assert.equal(sent.operationId, id);
  }
  const before = portalCalls(h.calls).length;
  for (const op of [...catalog.operations.values()].filter(o => !readable(o))) {
    const blocked = await h.access.read({ operationId: op.id, ...sampleRequest(catalog.apis.get(op.apiId), op) });
    assert.equal(blocked.error.code, 'WRITE_BLOCKED', op.id);
  }
  assert.equal(portalCalls(h.calls).length, before);
});

test('write guard: words, UUID, read-only and corporate tenants are checked before any send or reservation', async () => {
  const h = harness({ sessions: [{ host: PERSONAL, loggedIn: true }, { host: CORPORATE, loggedIn: true }, { host: CLIENT, loggedIn: true }] });
  const write = extra => h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, operationUuid: uuid(), ...extra });
  assert.equal((await write({ tenant: PERSONAL })).error.code, 'AUTHORIZATION_REQUIRED');
  assert.equal((await write({ tenant: PERSONAL, authorize: WORDS, operationUuid: 'not-a-uuid' })).error.code, 'INPUT_INVALID');
  assert.equal((await write({ tenant: CLIENT, authorize: 'client tenant: change it' })).error.code, 'TENANT_READ_ONLY');
  assert.equal((await write({ tenant: CORPORATE, authorize: 'change the role please' })).error.code, 'CORPORATE_TENANT_GUARD');
  assert.equal((await write({ tenant: CORPORATE, authorize: 'change the role please', confirmTenant: CORPORATE })).error.code, 'CORPORATE_TENANT_GUARD');
  assert.equal((await write({ tenant: 'unknown-host.outsystems.dev', authorize: 'change the role please' })).error.code, 'CORPORATE_TENANT_GUARD');
  assert.equal(portalCalls(h.calls).length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, 'receipts')) ? fs.readdirSync(path.join(h.dir, 'receipts')).length : 0, 0);
  const allowed = await write({ tenant: CORPORATE, authorize: 'yes, on corp change that role', confirmTenant: CORPORATE });
  assert.equal(allowed.ok, true, JSON.stringify(allowed)); assert.equal(portalCalls(h.calls).length, 1);
  assert.throws(() => guardTenant({ host: CORPORATE, class: 'corporate' }, 'corp yes', undefined), { code: 'CORPORATE_TENANT_GUARD' });
  assert.throws(() => guardTarget('delete it', ['Quotes', 'k-1']), { code: 'DESTRUCTIVE_TARGET_NOT_NAMED' });
});

test('a destructive write needs words that name the target, read before the send', async () => {
  const h = harness({ portalCall: request => request.method === 'GET'
    ? { ok: true, status: 200, contentType: 'application/json', body: { assetKey: 'a-1', name: 'QuotesPortal' } }
    : { ok: true, status: 204 } });
  const refused = await h.access.write({ operationId: DELETE_ASSET, path: { assetKey: 'a-1' }, authorize: 'yes delete that app now', operationUuid: uuid() });
  assert.equal(refused.error.code, 'DESTRUCTIVE_TARGET_NOT_NAMED'); assert.deepEqual(refused.error.candidates, ['QuotesPortal', 'a-1']);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'DELETE').length, 0);
  const done = await h.access.write({ operationId: DELETE_ASSET, path: { assetKey: 'a-1' }, authorize: 'yes delete QuotesPortal now', operationUuid: uuid() });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.effect, 'destructive');
});

test('journal and receipt keep only the sha256 of the words; the request names the receipt; one UUID is one send', async () => {
  const h = harness();
  const operationUuid = uuid();
  const first = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid });
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.receipt.state, 'accepted');
  const sent = h.requests.get(portalCalls(h.calls)[0][1]);
  const wordsSha256 = crypto.createHash('sha256').update(WORDS).digest('hex');
  assert.equal(sent.write, true); assert.equal(sent.operationUuid, operationUuid); assert.equal(sent.authorizeSha256, wordsSha256);
  const receipt = fs.readFileSync(first.receipt.file, 'utf8');
  assert.match(receipt, new RegExp(wordsSha256)); assert.doesNotMatch(receipt, /do it on the personal/);
  assert.doesNotMatch(JSON.stringify(h.journal), /do it on the personal/);
  assert.match(h.journal.at(-1).note, /words=sha256:[0-9a-f]{12} receipt=/);
  const again = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid });
  assert.equal(again.existingReceipt, true); assert.equal(again.replayed, false);
  assert.equal(portalCalls(h.calls).length, 1);
  const otherTarget = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE2 }, body: {}, authorize: WORDS, operationUuid });
  assert.equal(otherTarget.error.code, 'OPERATION_UUID_REUSED');
});

test('an uncertain write is never resent: it locks its target until a read reconciles it', async () => {
  let mode = 'uncertain';
  const h = harness({ portalCall: request => request.method === 'GET' ? { ok: true, status: 200, body: { key: ROLE1, name: 'Ops' } }
    : mode === 'uncertain' ? { ok: false, code: 'UNCERTAIN' } : { ok: true, status: 200, body: {} } });
  const operationUuid = uuid();
  const out = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid });
  assert.equal(out.ok, false); assert.equal(out.receipt.state, 'uncertain'); assert.match(out.reconcile, /Never resend/);
  mode = 'ok';
  const blocked = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid: uuid() });
  assert.equal(blocked.error.code, 'TARGET_PENDING'); assert.equal(blocked.error.pendingOperationUuid, operationUuid);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).write).length, 1);
  const noWords = await h.access.receipt({ operationUuid, reconcile: { state: 'confirmed', read: { operationId: 'user-access-management-api-v1:get:/organization-roles/{key}', path: { key: ROLE1 } } } });
  assert.equal(noWords.error.code, 'AUTHORIZATION_REQUIRED');
  const settled = await h.access.receipt({ operationUuid, reconcile: { state: 'confirmed', authorize: 'the role shows the change, confirmed',
    read: { operationId: 'user-access-management-api-v1:get:/organization-roles/{key}', path: { key: ROLE1 } } } });
  assert.equal(settled.ok, true, JSON.stringify(settled)); assert.equal(settled.receipt.state, 'confirmed');
  const next = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid: uuid() });
  assert.equal(next.ok, true);
  // A 4xx means the server refused it: settled, target free, and nothing resent.
  const rejected = harness({ portalCall: () => ({ ok: true, status: 409, body: { title: 'conflict' } }) });
  const r = await rejected.access.write({ operationId: PATCH_ROLE, path: { key: ROLE2 }, body: {}, authorize: WORDS, operationUuid: uuid() });
  assert.equal(r.receipt.state, 'rejected'); assert.equal(portalCalls(rejected.calls).length, 1);
});

test('bridge v32 answers: UNCERTAIN wins over a status, a busy gate or a refusal was never sent, a 4xx write is rejected', async () => {
  const write = async answer => {
    const h = harness({ sessions: [{ host: OTHER, loggedIn: true }], portalCall: () => answer });
    const out = await h.access.write({ tenant: OTHER, operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid: uuid() });
    const sent = h.requests.get(portalCalls(h.calls)[0][1]);
    return { out, sent };
  };
  const { out: uncertain, sent } = await write({ ok: false, code: 'UNCERTAIN', reason: 'HOST_MISMATCH', status: 200 });
  assert.equal(uncertain.ok, false); assert.equal(uncertain.receipt.state, 'uncertain'); assert.equal(uncertain.error.reason, 'HOST_MISMATCH');
  // Writes to a host other than the default carry the confirmation the bridge asks for, after the facade guard.
  assert.equal(sent.confirmTenant, OTHER); assert.equal(sent.write, true);
  assert.equal((await write({ ok: false, outcome: 'gate_refused', gate: 'studio_busy' })).out.receipt.state, 'not-sent');
  assert.equal((await write({ ok: false, code: 'NOT_ALLOWED', gate: 'retry_refused' })).out.receipt.state, 'not-sent');
  const rejected = (await write({ ok: false, code: 'REMOTE_ERROR', status: 409, body: { title: 'Conflict' } })).out;
  assert.equal(rejected.receipt.state, 'rejected'); assert.equal(rejected.status, 409);
  const big = harness({ portalCall: () => ({ ok: true, status: 200, contentType: 'application/json', bodyFile: 'C:\\x\\journal\\portal\\downloads\\b.json', bytes: 5000000, sha256: 'ab' }) });
  assert.equal((await big.access.read({ operationId: ASSETS })).data.file, 'C:\\x\\journal\\portal\\downloads\\b.json');
  // The first v32 window does not resolve secretRefs: nothing is sent, and the answer says to attach the current v32
  // (never a path that would read the secret in this process).
  const refusing = gate => harness({ portalAccount: true, portalSession: (args, request) => args[1] !== 'fetch' ? { ok: true, host: args.at(-1), signedIn: true }
    : request.secretRefs ? { ok: false, code: 'BAD_REQUEST', gate }
    : request.path.endsWith('DataActionGetFilter_Stages') ? { ok: true, status: 200, body: { data: { EnvironmentList: [{ Key: 'dev', Name: 'Development', Purpose: 'Development' }] } } } : { ok: true, status: 200, body: { data: {} } } });
  for (const [gate, hint] of [['secret_refs_unsupported', /current v32/], ['secret_ref_missing', /private prompt/]]) {
    const noRefs = refusing(gate);
    noRefs.access.studioBroker(PERSONAL).metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
    const tested = await noRefs.access.externalDbConnection({ action: 'test', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales', authorize: WORDS, operationUuid: uuid() });
    assert.equal(tested.error.code, 'BAD_REQUEST'); assert.equal(tested.receipt.state, 'not-sent'); assert.match(tested.hint, hint);
    assert.equal(tested.fallback, undefined); assert.doesNotMatch(tested.hint, /portal-credential/);
  }
});

test('answers are redacted: gateway tokens, passwords and bearer strings never come back', async () => {
  const h = harness({ portalCall: () => ({ ok: true, status: 200, contentType: 'application/json',
    body: { authToken: 'SECRET-GATEWAY', nested: { password: 'SECRET-PW', note: 'Bearer SECRET.JWT.VALUE' }, url: 'https://x.test/f?signature=SECRET-SIG' } }) });
  const out = await h.access.read({ operationId: ASSETS });
  assert.doesNotMatch(JSON.stringify(out), /SECRET-/);
  const binary = harness({ portalCall: () => ({ ok: true, status: 200, contentType: 'application/zip', bodyBase64: Buffer.from('PK-binary').toString('base64') }) });
  const zipped = await binary.access.read({ operationId: ASSETS });
  assert.equal(zipped.data.contentOmitted, true); assert.equal(zipped.data.byteLength, 9);
  const rejected = harness({ portalCall: () => ({ ok: true, status: 401 }) });
  assert.equal((await rejected.access.read({ operationId: ASSETS })).error.code, 'STUDIO_SESSION_REJECTED');
  const other = harness({ portalCall: () => ({ ok: true, status: 200, host: 'evil.outsystems.dev', body: {} }) });
  assert.equal((await other.access.read({ operationId: ASSETS })).error.code, 'HOST_MISMATCH');
});

test('operation status polls the read until terminal and never repeats the start; deploy follows its own key', async () => {
  const states = ['Running', 'Running', 'Finished'];
  const h = harness({ portalCall: request => request.method === 'POST' ? { ok: true, status: 202, body: { key: DEP1, status: 'Running' } }
    : request.path.endsWith('/messages') ? { ok: true, status: 200, body: [{ message: 'done' }] } : { ok: true, status: 200, body: { key: DEP1, status: states.shift() } } });
  const out = await h.access.deploy({ assetKey: ASSET1, environmentKey: ENV1, revision: 3, authorize: WORDS, operationUuid: uuid(), waitSeconds: 60 });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.deployment.status, 'Finished', JSON.stringify(out.deployment)); assert.equal(out.deployment.terminal, true);
  assert.equal(out.deployment.reads, 3); assert.deepEqual(out.deployment.messages, [{ message: 'done' }]);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'POST').length, 1);
  const pending = harness({ portalCall: () => ({ ok: true, status: 200, body: { status: 'Running' } }) });
  const once = await pending.access.operationStatus({ kind: 'publish', operationKey: DEP1 });
  assert.equal(once.terminal, false); assert.equal(once.continuation.tool, 'odc_operation_status');
});

test('a deployment that ends FinishedWithError is refused with every message and the fix; the POST is not repeated', async () => {
  const messages = { page: { total: 2 }, results: [
    { timestamp: '2026-10-04T15:00:01Z', severity: 'Info', message: 'Deploying GameStore to QA', additionalInfo: { stepId: 'Deploy', assetKey: ASSET1 } },
    { timestamp: '2026-10-04T15:00:09Z', type: 'OS-DPL-1', severity: 'Error', message: "Setting 'ApiUrl' has no value in stage QA", additionalInfo: { stepId: 'ApplyConfigurations', assetKey: ASSET1 } }] };
  const h = harness({ portalCall: request => request.method === 'POST' ? { ok: true, status: 202, body: { key: DEP1, status: 'Running' } }
    : request.path.endsWith('/messages') ? { ok: true, status: 200, body: messages } : { ok: true, status: 200, body: { key: DEP1, status: 'FinishedWithError' } } });
  const out = await h.access.deploy({ assetKey: ASSET1, environmentKey: ENV1, revision: 3, authorize: WORDS, operationUuid: uuid(), waitSeconds: 60 });
  assert.equal(out.ok, false, JSON.stringify(out)); assert.equal(out.code, 'DEPLOYMENT_FAILED'); assert.equal(out.sent, true);
  assert.match(out.error, /FinishedWithError: 1 error\(s\), 0 warning\(s\); first error: Setting 'ApiUrl'/);
  assert.deepEqual(out.deployment.log.messages[1], { type: 'error', text: "Setting 'ApiUrl' has no value in stage QA", stage: 'deploy',
    element: { name: 'ApiUrl', key: null, kind: null, source: 'text' }, code: 'OS-DPL-1', at: '2026-10-04T15:00:09Z', stepId: 'ApplyConfigurations', assetKey: ASSET1 });
  assert.equal(out.continuation.tool, 'ssam_discover');
  assert.match(out.continuation.why, /implante de novo/);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'POST').length, 1);
  // A publish or build read with messages answers the same log shape.
  const pub = harness({ portalCall: request => request.path.endsWith('/messages') ? { ok: true, status: 200, body: messages } : { ok: true, status: 200, body: { key: DEP1, status: 'Finished' } } });
  const read = await pub.access.operationStatus({ kind: 'publish', operationKey: DEP1, messages: true });
  assert.equal(read.failed, false); assert.deepEqual(read.log.counts, { errors: 1, warnings: 0, infos: 1 }); assert.equal(read.continuation, undefined);
});

test('configurations set by name resolves keys, refuses secret settings and reads the value back', async () => {
  let value = 'https://old.test';
  const h = harness({ portalCall: request => request.method === 'PATCH' ? (value = request.body.settings[0].value, { ok: true, status: 200, body: {} })
    : { ok: true, status: 200, body: { key: 'app-1', settings: [{ key: 's-1', name: 'ServiceUrl', value }, { key: 's-2', name: 'ApiPassword', isSecret: true, value: 'x' }] } } });
  const secret = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', settings: { ApiPassword: 'nope' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(secret.error.code, 'SECRET_IN_ARGUMENTS');
  const out = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', settings: { ServiceUrl: 'https://new.test' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.readBack.verified, true);
  const patch = [...h.requests.values()].find(r => r.method === 'PATCH');
  assert.deepEqual(patch.body.settings, [{ key: 's-1', value: 'https://new.test' }]);
  assert.equal(JSON.parse(fs.readFileSync(out.receipt.file, 'utf8')).state, 'confirmed');
  const got = await h.access.configurations({ environmentKey: 'e-1', assetKey: 'app-1' });
  assert.doesNotMatch(JSON.stringify(got), /"value":"x"/);
});

test('configurations set reads timer values back, and a null value back to the default origin', async () => {
  // Live on wrightflood (Quotes, Development): Timeout 20 -> 21 is an ApplicationLevelOverride; null removes it.
  let timeout = { value: '20', valueOrigin: 'ApplicationLevelDefault' };
  const h = harness({ portalCall: request => request.method === 'PATCH'
    ? (timeout = request.body.timers[0].configs[0].value === null ? { value: '20', valueOrigin: 'ApplicationLevelDefault' }
      : { value: request.body.timers[0].configs[0].value, valueOrigin: 'ApplicationLevelOverride' }, { ok: true, status: 204 })
    : { ok: true, status: 200, body: { key: 'app-1', settings: [], timers: [{ key: 't-1', name: 'LoadData', configs: [{ key: 'Timeout', name: 'Timeout', ...timeout }] }] } } });
  const set = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1',
    patch: { timers: [{ key: 't-1', configs: [{ key: 'Timeout', value: '21' }] }] }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(set.readBack.verified, true, JSON.stringify(set));
  assert.deepEqual(set.readBack.configs, [{ group: 'timers', parent: 't-1', key: 'Timeout', name: 'Timeout', value: '21', origin: 'ApplicationLevelOverride' }]);
  assert.equal(JSON.parse(fs.readFileSync(set.receipt.file, 'utf8')).state, 'confirmed');
  assert.equal(set.receipt.state, 'confirmed', 'the answer says what the receipt file now holds');
  const reset = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1',
    patch: { timers: [{ key: 't-1', configs: [{ key: 'Timeout', value: null }] }] }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(reset.readBack.verified, true, JSON.stringify(reset));
  assert.equal(reset.readBack.configs[0].origin, 'ApplicationLevelDefault');
});

test('asset delete reads the name, needs it in the words and confirms the asset is gone', async () => {
  let deleted = false;
  const h = harness({ portalCall: request => request.method === 'DELETE' ? (deleted = true, { ok: true, status: 204 })
    : request.path.endsWith('/consumers') ? { ok: true, status: 200, body: { results: [] } }
    : deleted ? { ok: true, status: 404, body: { title: 'not found' } } : { ok: true, status: 200, body: { name: 'OldApp' } } });
  const out = await h.access.assetDelete({ assetKey: 'a-9', authorize: 'please delete OldApp for good', operationUuid: uuid() });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.readBack.gone, true);
  assert.equal(JSON.parse(fs.readFileSync(out.receipt.file, 'utf8')).state, 'confirmed');
});

// Lane extlib: an app or library that consumes the asset breaks when it goes; the words name each one, read BEFORE
// anything is reserved, or nothing happens. Before this rule the delete went straight to the DELETE.
test('asset delete with consumers: CONSUMERS_WOULD_BREAK names them, nothing reserved, no DELETE; words naming them delete', async () => {
  let deleted = false;
  const h = harness({ portalCall: request => request.method === 'DELETE' ? (deleted = true, { ok: true, status: 204 })
    : request.path.endsWith('/consumers') ? { ok: true, status: 200, body: { results: [{ key: 'c-1', name: 'OrdersApp', type: 'WebApplication' }, { key: 'c-2', name: 'Billing', type: 'LowCodeLibrary' }] } }
    : deleted ? { ok: true, status: 404, body: { title: 'not found' } } : { ok: true, status: 200, body: { name: 'SSAMTextTools' } } });
  const refused = await h.access.assetDelete({ assetKey: 'lib-1', authorize: 'delete SSAMTextTools, the external library', operationUuid: uuid() });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'CONSUMERS_WOULD_BREAK'); assert.equal(refused.sent, false);
  assert.deepEqual(refused.consumers, ['OrdersApp', 'Billing']);
  assert.deepEqual(refused.problems.map(p => [p.target, p.ssamRule]), [['OrdersApp', true], ['Billing', true]]);
  assert.match(refused.problems[0].fix, /also name OrdersApp/);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'DELETE').length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, 'receipts')) ? fs.readdirSync(path.join(h.dir, 'receipts')).length : 0, 0, 'nothing reserved');
  // One consumer named is not enough; "OrdersApp2" does not name OrdersApp (whole words).
  const partial = await h.access.assetDelete({ assetKey: 'lib-1', authorize: 'delete SSAMTextTools, OrdersApp2 and Billing', operationUuid: uuid() });
  assert.deepEqual(partial.problems.map(p => p.target), ['OrdersApp']);
  const done = await h.access.assetDelete({ assetKey: 'lib-1', authorize: 'delete SSAMTextTools even though OrdersApp and billing use it', operationUuid: uuid() });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.readBack.gone, true);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'DELETE').length, 1);
});

test('asset delete refuses when the consumers cannot be read (DEPENDENCY_CHECK_UNAVAILABLE), never blind', async () => {
  const h = harness({ portalCall: request => request.path.endsWith('/consumers') ? { ok: true, status: 500, body: { title: 'boom' } } : { ok: true, status: 200, body: { name: 'OldApp' } } });
  const out = await h.access.assetDelete({ assetKey: 'a-9', authorize: 'please delete OldApp for good', operationUuid: uuid() });
  assert.equal(out.code, 'DEPENDENCY_CHECK_UNAVAILABLE'); assert.equal(out.sent, false);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'DELETE').length, 0);
});

test('External Library routes: the generation POST answers operationKey, its delete names the library, the publish route is a listed write', () => {
  assert.equal(OPERATION_STATUS.generation.key, 'operationKey');
  assert.deepEqual(TARGET_NAMES['external-library-generation-api-v1:delete:/generation-operations/{operationKey}'],
    { read: 'external-library-generation-api-v1:get:/generation-operations/{operationKey}', fields: ['libraryName', 'filename'] });
  assert.ok(catalog.operations.has('external-library-generation-api-v1:delete:/generation-operations/{operationKey}'));
  assert.deepEqual(routeOf('externalLibraries.publishJob', true), { module: 'logic', view: 'CreateExternalLibraryWizard.createnewrevision',
    action: 'logic/CreateExternalLibraryWizard/createnewrevision/ActionExternalLibraryPublishJob', discoveryView: 'CreateExternalLibraryWizard.createnewrevision' });
  assert.equal(PORTAL_WRITES['externalLibraries.publishJob'].effect, 'mutation');
  assert.throws(() => routeOf('externalLibraries.publishJob', false), { code: 'PORTAL_OPERATION_NOT_FOUND' });
});

test('a pending External Library job is deleted only with words naming its library, read before the DELETE', async () => {
  const h = harness({ portalCall: request => request.method === 'DELETE' ? { ok: true, status: 204 }
    : { ok: true, status: 200, body: { key: 'job-1', libraryName: 'SSAMTextTools', filename: 'SSAMTextTools-0123456789abcdef.zip', status: 'ReadyForReview' } } });
  const operationId = 'external-library-generation-api-v1:delete:/generation-operations/{operationKey}';
  const refused = await h.access.write({ operationId, path: { operationKey: 'job-1' }, authorize: 'yes, discard that job now', operationUuid: uuid() });
  assert.equal(refused.error.code, 'DESTRUCTIVE_TARGET_NOT_NAMED'); assert.ok(refused.error.candidates.includes('SSAMTextTools'));
  const done = await h.access.write({ operationId, path: { operationKey: 'job-1' }, authorize: 'yes, discard the SSAMTextTools job', operationUuid: uuid() });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.effect, 'destructive');
});

test('internal Portal: Studio window first, sign-in asked once, vault broker without a Studio, prompt last', async () => {
  const notSigned = harness({ portalSession: args => ({ ok: true, host: args.at(-1), signedIn: false }) });
  const refused = await notSigned.access.portalRead({ operationId: 'monitoring.stages' });
  assert.equal(refused.code, 'WEB_SIGN_IN_REQUIRED'); assert.equal(refused.continuation.tool, 'odc_portal_login');
  const login = await notSigned.access.portalLogin({});
  assert.equal(login.ok, true); assert.equal(login.auth.path, 'studio-web');
  assert.deepEqual(notSigned.calls.at(-1), ['portal-session', 'open', '--tenant', PERSONAL]);

  const fetches = [];
  const h = harness({ portalSession: (args, request) => {
    if (args[1] !== 'fetch') return { ok: true, host: args.at(-1), signedIn: true, user: 'dev@example.test' };
    fetches.push(request);
    return { ok: true, status: 200, contentType: 'application/json', host: PERSONAL, body: { data: { EnvironmentList: { List: [{ Environment: { Key: 'dev', Name: 'Development', Purpose: 'Development' } }] } } } };
  } });
  h.access.studioBroker(PERSONAL).metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
  const stages = await h.access.portalRead({ operationId: 'monitoring.stages' });
  assert.equal(stages.ok, true, JSON.stringify(stages)); assert.equal(stages.auth.path, 'studio-web'); assert.equal(stages.rows[0].Key, 'dev');
  assert.equal(fetches[0].method, 'POST'); assert.equal(fetches[0].path, '/monitoring/screenservices/monitoring/logs/logs/DataActionGetFilter_Stages');
  assert.equal(fetches[0].write, false); assert.equal(fetches[0].body.versionInfo.apiVersion, 'a');

  const vault = harness({ running: false, portalAccount: true, brokerState: { available: true, authenticated: true,
    readScreenservice: async request => ({ target: 'odc3', origin: request.origin, body: { data: { Connections: { List: [{ ConnectionId: 'c1', Name: 'Db' }] } } } }) } });
  const list = await vault.access.portalRead({ operationId: 'connections.list' });
  assert.equal(list.auth.path, 'vault'); assert.equal(list.rows[0].ConnectionId, 'c1');
  const none = harness({ running: false });
  assert.equal((await none.access.portalRead({ operationId: 'connections.list' })).code, 'CREDENTIAL_PROMPT_OPENED');
  assert.deepEqual(none.prompts, [['portal', PERSONAL, null]]);
});

test('internal Portal writes: listed routes only, no secret arguments, never the decrypted-secrets action', async () => {
  const h = harness();
  assert.equal((await h.access.portalWrite({ operationId: 'connections.delete', input: {}, authorize: WORDS, operationUuid: uuid() })).error.code,
    Object.hasOwn(PORTAL_GAPS, 'connections.delete') ? 'PORTAL_ROUTE_UNMAPPED' : 'DESTRUCTIVE_TARGET_NOT_NAMED');
  assert.equal((await h.access.portalRead({ operationId: 'connections.decryptedSecrets' })).error.code, 'PORTAL_OPERATION_NOT_FOUND');
  const secret = await h.access.portalWrite({ operationId: 'connections.relationalSave', authorize: WORDS, operationUuid: uuid(),
    input: { inputParameters: { ConnectionDetails: { ConnectionDetail_StageConfig: { List: [{ ConnectionDetails_Common: { ConnectionPassword: 'hunter2' } }] } } } } });
  assert.equal(secret.error.code, 'SECRET_IN_ARGUMENTS'); assert.doesNotMatch(JSON.stringify(secret), /hunter2/);
  for (const [, route] of [...Object.entries(PORTAL_READS), ...Object.entries(PORTAL_WRITES).map(([k, w]) => [k, w.route])]) assert.equal(NEVER_EXPOSED.has(route[2]), false);
  assert.equal(h.calls.filter(c => c[0] === 'portal-session' && c[1] === 'fetch').length, 0);
});

test('external DB connection: the account stays in the vault, reaches the window as secretRefs, and create reads the list back', async () => {
  const missing = harness();
  const prompt = await missing.access.externalDbConnection({ action: 'test', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales', authorize: WORDS, operationUuid: uuid() });
  assert.equal(prompt.code, 'CREDENTIAL_PROMPT_OPENED'); assert.deepEqual(missing.prompts, [['portal', PERSONAL, 'SalesDb']]);
  assert.equal(prompt.credentialEntry, 'SSAM/ODC3/' + PERSONAL + '/DB/SalesDb');

  const posted = [], vaultBrokerCalls = [];
  const h = harness({ portalAccount: (host, database) => database === 'SalesDb',
    brokerState: { callScreenservice: async args => { vaultBrokerCalls.push(args); return { data: {} }; } }, portalSession: (args, request) => {
    if (args[1] !== 'fetch') return { ok: true, host: args.at(-1), signedIn: true };
    if (request.path.endsWith('DataActionGetFilter_Stages')) return { ok: true, status: 200, host: PERSONAL, body: { data: { EnvironmentList: [{ Key: 'dev', Name: 'Development', Purpose: 'Development' }] } } };
    if (request.path.endsWith('DataActionGetStatus')) return { ok: true, status: 200, host: PERSONAL, body: { data: { Status: { Results: { List: [{ StageKey: 'dev', Status: 'Success' }] } } } } };
    if (request.path.endsWith('DataActionGetConnections')) return { ok: true, status: 200, host: PERSONAL, body: { data: { Connections: [{ ConnectionId: 'c-77', Name: 'SalesDb' }] } } };
    posted.push(request);
    return { ok: true, status: 200, host: PERSONAL, body: { data: request.path.includes('Test_Wrapper') ? { Out_ConnectionId: 'c-77' } : { Saved: true } } };
  } });
  h.access.studioBroker(PERSONAL).metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
  const operationUuid = uuid();
  const created = await h.access.externalDbConnection({ action: 'create', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales', authorize: WORDS, operationUuid });
  assert.equal(created.ok, true, JSON.stringify(created)); assert.equal(created.connectionId, 'c-77'); assert.equal(created.readBack.found, true);
  assert.equal(posted.length, 2);
  const [testCall, saveCall] = posted;
  assert.equal(testCall.write, true); assert.equal(saveCall.operationUuid, operationUuid); assert.notEqual(testCall.operationUuid, operationUuid);
  assert.deepEqual(testCall.secretRefs.map(r => r.field).sort(), ['password', 'password', 'username', 'username']);
  assert.ok(testCall.secretRefs.every(r => r.target === 'SSAM/ODC3/' + PERSONAL + '/DB/SalesDb'));
  assert.equal(testCall.body.inputParameters.ValidStageConfigs.List[0].ConnectionDetails_Common.ConnectionPassword, '');
  assert.equal(saveCall.secretRefs[0].pointer, '/inputParameters/ConnectionDetails/ConnectionDetail_StageConfig/List/0/ConnectionDetails_Common/ConnectionUsername');
  assert.equal(JSON.parse(fs.readFileSync(created.receipt.file, 'utf8')).state, 'confirmed');
  // The secret never enters the facade on the Studio path: every pointer holds an empty placeholder in the request
  // file, the vault broker (which would read it here) is never used, and the answer says the bridge resolved it.
  for (const call of posted) for (const ref of call.secretRefs) {
    const value = ref.pointer.slice(1).split('/').reduce((node, part) => node?.[part], call.body);
    assert.equal(value, '', ref.pointer);
  }
  assert.equal(vaultBrokerCalls.length, 0);
  assert.deepEqual(created.secretRefs, { count: 2, entries: ['SSAM/ODC3/' + PERSONAL + '/DB/SalesDb'], resolvedBy: 'bridge, inside the ODC Studio' });
  assert.match(JSON.parse(fs.readFileSync(created.receipt.file, 'utf8')).authorization.planSha256, /^[0-9a-f]{64}$/);
  assert.match(h.journal.find(j => j.command === 'portal-write connections.relationalSave').note, /secretRefs=2$/);
  // The same create again sends nothing: both receipts answer.
  const again = await h.access.externalDbConnection({ action: 'create', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales', authorize: WORDS, operationUuid });
  assert.equal(posted.length, 2); assert.equal(again.existingReceipt, true);
});

test('external DB connection without the Studio session: refused before any prompt, reservation or send (the secret never enters this process)', async () => {
  const calls = [];
  const brokerState = { available: true, authenticated: true, readScreenservice: async () => ({ target: 'odc3', body: { data: {} } }), callScreenservice: async args => { calls.push(args); return { data: {} }; } };
  for (const options of [{ running: false, portalAccount: true, brokerState }, { portalAccount: true, brokerState, auth: 'portal-credential' }, { portalAccount: true, brokerState, sessions: [] }]) {
    const h = harness(options);
    const created = await h.access.externalDbConnection({ action: 'create', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales',
      authorize: WORDS, operationUuid: uuid(), ...(options.auth ? { auth: options.auth } : {}) });
    assert.equal(created.code, 'STUDIO_REQUIRED', JSON.stringify(created)); assert.equal(created.sent, false);
    assert.deepEqual(h.prompts, []); assert.equal(h.calls.filter(c => c[0] !== 'auth-status').length, 0);
    assert.equal(fs.existsSync(path.join(h.dir, 'receipts')) ? fs.readdirSync(path.join(h.dir, 'receipts')).length : 0, 0);
    // The same refusal on the generic internal write, before its receipt.
    const direct = await h.access.portalWrite({ operationId: 'connections.relationalTest', authorize: WORDS, operationUuid: uuid(), auth: 'portal-credential',
      input: { inputParameters: { Common: { ConnectionPassword: '' } } } }, { secretRefs: [{ pointer: '/inputParameters/Common/ConnectionPassword', target: 'SSAM/ODC3/' + PERSONAL + '/DB/SalesDb', field: 'password' }] });
    assert.equal(direct.error.code, 'STUDIO_REQUIRED', JSON.stringify(direct)); assert.equal(direct.receipt, undefined);
  }
  assert.equal(calls.length, 0, 'the vault broker never sends a secretRefs write');
});

test('auth status says whether the attached v32 reads secretRefs inside the Studio (the first v32 lists no capabilities)', async () => {
  const current = await harness({ capabilities: ['portal-call', 'portal-session', 'auth-status', 'portal-call:secretRefs', 'portal-session:secretRefs'] }).access.authStatus({ tenant: PERSONAL });
  assert.equal(current.studio.secretRefs, true); assert.ok(current.studio.capabilities.includes('portal-session:secretRefs'));
  const first = await harness().access.authStatus({ tenant: PERSONAL });
  assert.equal(first.studio.secretRefs, false); assert.deepEqual(first.studio.capabilities, []);
  assert.equal((await harness({ running: false }).access.authStatus({ tenant: PERSONAL })).studio.secretRefs, undefined);
});

test('secret settings: vaultSettings names a vault entry, the PATCH carries secretRefs only through the Studio session', async () => {
  const settings = [{ key: 's-1', name: 'ServiceUrl', value: 'https://old.test' }, { key: 's-2', name: 'ApiPassword', isSecret: true, value: '********' }];
  const h = harness({ portalAccount: (host, database, setting) => setting === 'ApiPassword-dev',
    portalCall: request => request.method === 'PATCH' ? { ok: true, status: 200, body: {} } : { ok: true, status: 200, body: { key: 'app-1', settings } } });
  const out = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', settings: { ServiceUrl: 'https://new.test' },
    vaultSettings: { ApiPassword: 'ApiPassword-dev' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(out.ok, true, JSON.stringify(out));
  const patch = [...h.requests.values()].find(r => r.method === 'PATCH');
  assert.deepEqual(patch.body.settings, [{ key: 's-1', value: 'https://new.test' }, { key: 's-2', value: '' }]);
  assert.deepEqual(patch.secretRefs, [{ pointer: '/settings/1/value', target: 'SSAM/ODC3/' + PERSONAL + '/Setting/ApiPassword-dev', field: 'password' }]);
  assert.deepEqual(out.secretRefs, { count: 1, entries: ['SSAM/ODC3/' + PERSONAL + '/Setting/ApiPassword-dev'], resolvedBy: 'bridge, inside the ODC Studio' });
  assert.deepEqual(out.readBack.vaultSettings, [{ key: 's-2', present: true, valueVerified: false }]);
  assert.equal(out.readBack.verified, false, 'the plain value was not echoed back by this fake');
  const plan = JSON.parse(fs.readFileSync(out.receipt.file, 'utf8'));
  assert.doesNotMatch(JSON.stringify(plan), /hunter2/);
  // A missing entry opens the private prompt for it; nothing is sent.
  const before = portalCalls(h.calls).length;
  const missing = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', vaultSettings: { ApiPassword: 'Other' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(missing.code, 'CREDENTIAL_PROMPT_OPENED'); assert.deepEqual(h.prompts, [['portal', PERSONAL, null, 'Other']]);
  assert.equal(missing.credentialEntry, 'SSAM/ODC3/' + PERSONAL + '/Setting/Other'); assert.equal(portalCalls(h.calls).length, before);
  // A vault value never goes to a setting the server shows in plain text, nor a secret value through the raw patch.
  assert.equal((await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', vaultSettings: { ServiceUrl: 'ApiPassword-dev' }, authorize: WORDS, operationUuid: uuid() })).error.code, 'INPUT_INVALID');
  const raw = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', patch: { settings: [{ key: 's-2', value: 'hunter2' }] }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(raw.error.code, 'SECRET_IN_ARGUMENTS'); assert.doesNotMatch(JSON.stringify(raw), /hunter2/);
  // Without the Studio session (vault API Client path), refused before any prompt or reservation.
  const vault = harness({ running: false, apiClient: true, portalAccount: true });
  const refused = await vault.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', vaultSettings: { ApiPassword: 'ApiPassword-dev' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(refused.code, 'STUDIO_REQUIRED'); assert.deepEqual(vault.prompts, []); assert.equal(vault.vaultCalls.length, 0);
  // The first v32 refuses secretRefs on portal-call too: nothing sent, the hint says which bridge to attach.
  const old = harness({ portalAccount: true, portalCall: request => request.method === 'PATCH' ? { ok: false, code: 'BAD_REQUEST', gate: 'secret_refs_unsupported' } : { ok: true, status: 200, body: { key: 'app-1', settings } } });
  const first = await old.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', vaultSettings: { ApiPassword: 'ApiPassword-dev' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(first.receipt.state, 'not-sent'); assert.match(first.hint, /current v32/);
});

test('secretRefs are checked before any reservation: this tenant\'s DB entries only, at empty placeholders', async () => {
  const h = harness({ portalAccount: true });
  const write = secretRefs => h.access.portalWrite({ operationId: 'connections.relationalTest', authorize: WORDS, operationUuid: uuid(),
    input: { inputParameters: { Common: { ConnectionPassword: '', ConnectionServer: 'db.test' } } } }, { secretRefs });
  const good = { pointer: '/inputParameters/Common/ConnectionPassword', target: 'SSAM/ODC3/' + PERSONAL + '/DB/Sales', field: 'password' };
  for (const bad of [{ ...good, target: 'SSAM/ODC3/' + OTHER + '/DB/Sales' }, { ...good, target: 'SSAM/ODC3/' + PERSONAL + '/APIClient' }, { ...good, field: 'secret' },
    { ...good, pointer: '/inputParameters/Common/ConnectionServer' }, { ...good, pointer: '/inputParameters/Common/Nope' }, { ...good, value: 'x' }]) {
    const out = await write([bad]);
    assert.equal(out.error.code, 'INPUT_INVALID', JSON.stringify(bad)); assert.equal(out.sent, false); assert.equal(out.receipt, undefined);
  }
  assert.equal(h.calls.filter(c => c[0] === 'portal-session').length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, 'receipts')) ? fs.readdirSync(path.join(h.dir, 'receipts')).length : 0, 0);
});

// W17: the timer run/pause/resume and connection delete routes arrive from another session's capture. Until then each
// id is a gap refused with its capture step; once its captured route enters PORTAL_WRITES (and leaves PORTAL_GAPS and
// PORTAL_CAPTURE, portal-routes.mjs), the other branch checks its effect. Never both, never neither.
const W17 = { 'timers.run': 'mutation', 'timers.pause': 'mutation', 'timers.resume': 'mutation', 'connections.delete': 'destructive' };
const CLI = /`odc |odc portal|internal-routes|pwsh|powershell|\.ps1|python|--match|--tenant|--view/i;
test('W17 routes: a gap refused with its capture step (odc_portal_routes), or a write with its effect, never both', async () => {
  const h = harness();
  assert.deepEqual(Object.keys(PORTAL_CAPTURE).sort(), Object.keys(PORTAL_GAPS).sort());
  for (const [id, effect] of Object.entries(W17)) {
    const gap = Object.hasOwn(PORTAL_GAPS, id), write = Object.hasOwn(PORTAL_WRITES, id);
    assert.notEqual(gap, write, id + ' is exactly one of PORTAL_GAPS or PORTAL_WRITES');
    // Only refusals are exercised here: a captured mutation would reach the (fake) Portal window.
    const out = gap || effect === 'destructive' ? await h.access.portalWrite({ operationId: id, input: {}, authorize: WORDS, operationUuid: uuid() }) : null;
    if (gap) {
      assert.equal(out.error.code, 'PORTAL_ROUTE_UNMAPPED', id); assert.equal(out.sent, false); assert.equal(out.receipt, undefined);
      assert.match(out.error.message, /Live proof: odc_portal_login .*odc_portal_routes \{module:"/, id);
      assert.doesNotMatch(out.error.message, CLI, id);
      assert.deepEqual(out.error.continuation, { tool: 'odc_portal_routes', arguments: { ...PORTAL_CAPTURE[id] }, why: out.error.continuation.why }, id);
      assert.match(out.error.continuation.why, new RegExp(id.replace('.', '\\.')));
    } else {
      assert.equal(PORTAL_WRITES[id].effect, effect, id); assert.equal(PORTAL_WRITES[id].route.length, 3, id);
      assert.ok(PORTAL_WRITES[id].route.every(part => typeof part === 'string' && part), id);
      // A destructive route needs a target the words name; odc_portal_write has none, so it is refused before any send.
      if (effect === 'destructive') assert.equal(out.error.code, 'DESTRUCTIVE_TARGET_NOT_NAMED', id);
    }
  }
  // The typed helper refuses the delete with the same capture step while it is a gap (W17 then wires OdcAccess.dbDelete).
  if (Object.hasOwn(PORTAL_GAPS, 'connections.delete')) {
    const del = await h.access.externalDbConnection({ action: 'delete', connectionId: 'c-1' });
    assert.equal(del.error.code, 'PORTAL_ROUTE_UNMAPPED'); assert.equal(del.tenant, PERSONAL);
    assert.deepEqual(del.error.continuation.arguments, { module: 'connections', view: 'Connections.connection', match: 'Delete' });
  }
  assert.equal(h.calls.filter(c => c[0] === 'portal-session').length, 0);
  // A destructive internal route, once captured, needs words naming its target, like the public deletes.
  assert.throws(() => guardPortalTarget('destructive', 'yes delete it', { connectionName: 'SalesDb' }), { code: 'DESTRUCTIVE_TARGET_NOT_NAMED' });
  assert.doesNotThrow(() => guardPortalTarget('destructive', 'yes delete SalesDb now', { connectionName: 'SalesDb' }));
  assert.doesNotThrow(() => guardPortalTarget('mutation', 'yes save it', undefined));
});

test('Portal refusals name a tool, never a command: window missing, sign-in, and the vault status without a stored account', async () => {
  const old = harness({ portalSession: () => ({ ok: false, code: 'Unknown command' }) });
  const missing = await old.access.portalRead({ operationId: 'monitoring.stages' });
  assert.equal(missing.code, 'PORTAL_WINDOW_UNAVAILABLE'); assert.deepEqual(missing.continuation.tool, 'studio_attach'); assert.equal(typeof missing.continuation.why, 'string');
  const notSigned = harness({ portalSession: args => ({ ok: true, host: args.at(-1), signedIn: false }) });
  const sign = await notSigned.access.portalRoutes({ module: 'connections' });
  assert.equal(sign.code, 'WEB_SIGN_IN_REQUIRED'); assert.deepEqual(sign.continuation.arguments, { tenant: PERSONAL }); assert.equal(typeof sign.continuation.why, 'string');
  // The vault broker's status carries a local bootstrap command; the answer carries the call that opens the same prompt.
  const vault = harness({ running: false, brokerState: { status: () => ({ authenticated: false, available: false, operatorAction: '& "pwsh.exe" -NoProfile -File "x.ps1" -Mode bootstrap',
    explanation: 'Run locally and enter your Portal account' }) } });
  const status = await vault.access.portalLogin({ action: 'status' });
  assert.equal(status.ok, true); assert.doesNotMatch(JSON.stringify(status), CLI); assert.equal(status.session.operatorAction, undefined);
  assert.deepEqual(status.continuation.arguments, { tenant: PERSONAL, auth: 'auto', action: 'open' }); assert.equal(status.continuation.tool, 'odc_portal_login');
  assert.deepEqual(vault.prompts, []);
});

test('route capture for the live proof lists a module\'s screenservice actions through the Studio Portal window, GETs only', async () => {
  const gets = [];
  const assets = {
    '/connections/moduleservices/moduleversioninfo': JSON.stringify({ versionToken: 'v-1' }),
    '/connections/': '<script src="scripts/connections._osbundle-1.index.js"></script>',
    '/connections/scripts/connections._osbundle-1.index.js': 'x={screenName:"Connections.connections"},{screenName:"Connections.connection",load:()=>import("./connections.Connections.connection.mvc.js")}',
    '/connections/scripts/connections.Connections.connection.mvc.js': '"screenservices/connections/Connections/connection/ActionConnection_Delete","av1";"screenservices/connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB","av2";import("./connections.helper.js");"screenservices/other/X/y/ActionZ","av3"',
    '/connections/scripts/connections.helper.js': '"screenservices/connections/ConnectionsCommon/Connection_GetTestStatus/DataActionGetStatus","av4"',
  };
  const h = harness({ portalSession: (args, request) => {
    if (args[1] !== 'fetch') return { ok: true, host: args.at(-1), signedIn: true };
    gets.push(request);
    return Object.hasOwn(assets, request.path) ? { ok: true, status: 200, host: PERSONAL, text: assets[request.path] } : { ok: false, code: 'REMOTE_ERROR' };
  } });
  const out = await h.access.portalRoutes({ module: 'connections', view: 'Connections.connection' });
  assert.equal(out.ok, true, JSON.stringify(out));
  // Short answer: no auth block, no asset count, no version token.
  assert.deepEqual(Object.keys(out).sort(), ['actions', 'module', 'next', 'ok', 'screens', 'tenant', 'truncated', 'view']);
  assert.deepEqual([out.tenant, out.module, out.view, out.truncated], [PERSONAL, 'connections', 'Connections.connection', false]);
  assert.deepEqual(out.screens, ['Connections.connection', 'Connections.connections']);
  assert.deepEqual(out.actions, [
    { action: 'connections/Connections/connection/ActionConnection_Delete', mapped: false },
    { action: 'connections/ConnectionsCommon/Connection_GetTestStatus/DataActionGetStatus', mapped: true },
    { action: 'connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB', mapped: true }]);
  assert.doesNotMatch(out.next, CLI);
  assert.ok(gets.every(g => g.method === 'GET' && g.write === false && g.body === undefined), 'GETs only, never a write');
  assert.equal((await h.access.portalRoutes({ module: 'connections', view: 'Connections.connection', match: 'delete' })).actions.length, 1);
  assert.match(h.journal.at(-1).note, /auth=studio-web actions=1$/);
  // Without view the entry bundle is the start; view is then absent from the answer.
  assert.equal('view' in (await h.access.portalRoutes({ module: 'connections' })), false);
  // Refused modules: checked before any tenant, Studio, session or prompt is touched.
  const before = h.calls.length;
  for (const module of ['authentication', 'identity', 'api', 'Authentication', ' api ', 'connections/../api', '', undefined]) {
    assert.equal((await h.access.portalRoutes({ module })).error.code, 'INPUT_INVALID', String(module));
  }
  assert.equal(h.calls.length, before); assert.deepEqual(h.prompts, []);
  const none = harness({ running: false });
  assert.equal((await none.access.portalRoutes({ module: 'identity' })).error.code, 'INPUT_INVALID'); assert.deepEqual(none.prompts, []);
});

test('route capture answers stay short: screens and actions capped, truncated and next say how to narrow', async () => {
  const h = harness();
  const broker = h.access.studioBroker(PERSONAL);
  let asked;
  broker.metadata.routes = async (module, options) => { asked = [module, options];
    return { module, view: null, screens: Array.from({ length: MAX_ROUTE_SCREENS + 5 }, (_, i) => 'S.s' + i), assetsInspected: 3, truncated: false,
      actions: [PORTAL_READS['connections.list'][2], ...Array.from({ length: MAX_ROUTE_ACTIONS + 10 }, (_, i) => 'apps/Fixture/f/ActionFixture' + String(i).padStart(3, '0'))].sort() }; };
  const out = await h.access.portalRoutes({ tenant: PERSONAL, module: 'apps', match: 'Fixture' });
  assert.deepEqual(asked, ['apps', { view: undefined, match: 'Fixture' }]);
  assert.equal(out.screens.length, MAX_ROUTE_SCREENS); assert.equal(out.actions.length, MAX_ROUTE_ACTIONS); assert.equal(out.truncated, true);
  assert.match(out.next, /narrow with view .* or match/); assert.equal(out.assetsInspected, undefined);
  broker.metadata.routes = async module => ({ module, view: null, screens: ['S.a'], actions: [PORTAL_READS['connections.list'][2]], assetsInspected: 48, truncated: true });
  const scan = await h.access.portalRoutes({ tenant: PERSONAL, module: 'connections' });
  assert.equal(scan.truncated, true); assert.deepEqual(scan.actions, [{ action: PORTAL_READS['connections.list'][2], mapped: true }]);
  assert.match(scan.next, /narrow/); assert.doesNotMatch(scan.next, /unmapped action/);
});

test('auth status reports the path per tenant without secrets, prompts or sends', async () => {
  const h = harness({ apiClient: host => host === CORPORATE });
  const status = await h.access.authStatus();
  const byHost = Object.fromEntries(status.tenants.map(t => [t.host, t]));
  assert.equal(byHost[PERSONAL].resolves.public, 'studio'); assert.equal(byHost[PERSONAL].studio.user, 'dev@example.test');
  assert.equal(byHost[CORPORATE].resolves.public, 'STUDIO_NOT_SIGNED_IN'); assert.equal(byHost[CORPORATE].apiClient.available, true);
  assert.equal(byHost[CLIENT].readOnly, true);
  assert.equal(h.prompts.length, 0); assert.equal(portalCalls(h.calls).length, 0);
  const noStudio = harness({ running: false, apiClient: host => host === CORPORATE });
  const offline = Object.fromEntries((await noStudio.access.authStatus()).tenants.map(t => [t.host, t.resolves.public]));
  assert.equal(offline[CORPORATE], 'vault'); assert.equal(offline[PERSONAL], 'prompt');
});

test('hosted: only the customer\'s Studio session; api-client, portal-credential, the vault and the prompt of the server are refused', async () => {
  const h = harness({ hosted: true, apiClient: true, portalAccount: true });
  const refused = await h.access.read({ tenant: PERSONAL, auth: 'api-client', operationId: ASSETS });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'HOSTED_STUDIO_SESSION_ONLY');
  // auto is the Studio session, as it is locally when the Studio is signed in.
  assert.equal((await h.access.read({ tenant: PERSONAL, operationId: ASSETS })).ok, true);
  assert.equal(portalCalls(h.calls).length, 1);
  // No session on the tenant: the Studio refusal, never the vault, the API Client or the prompt.
  const other = await h.access.read({ tenant: OTHER, operationId: ASSETS });
  assert.equal(other.code, 'STUDIO_NOT_SIGNED_IN');
  assert.equal((await h.access.portalRead({ tenant: PERSONAL, auth: 'portal-credential', operationId: 'monitoring.stages' })).code, 'HOSTED_STUDIO_SESSION_ONLY');
  assert.equal((await h.access.portalLogin({ tenant: PERSONAL, auth: 'portal-credential' })).code, 'HOSTED_STUDIO_SESSION_ONLY');
  assert.equal((await h.access.portalLogin({ tenant: OTHER })).code, 'STUDIO_NOT_SIGNED_IN');
  assert.equal((await h.access.openPrompt('portal', PERSONAL)).code, 'HOSTED_PROMPT_UNAVAILABLE');
  const noStudio = harness({ hosted: true, running: false, apiClient: true, portalAccount: true });
  const closed = await noStudio.access.read({ tenant: PERSONAL, operationId: ASSETS });
  assert.equal(closed.code, 'STUDIO_NOT_CONNECTED'); assert.doesNotMatch(closed.error.message, /vault/);
  const status = await noStudio.access.authStatus();
  for (const tenant of status.tenants) {
    assert.equal(tenant.apiClient.available, null); assert.equal(tenant.portal.account.available, null);
    assert.ok(!['vault', 'prompt'].includes(tenant.resolves.public) && !['vault', 'prompt'].includes(tenant.resolves.portal));
  }
  assert.match(status.order, /Hosted/);
  for (const x of [h, noStudio]) { assert.deepEqual(x.vaultAsked, []); assert.deepEqual(x.prompts, []); assert.deepEqual(x.vaultCalls, []); assert.deepEqual(x.brokers, []); }
});
