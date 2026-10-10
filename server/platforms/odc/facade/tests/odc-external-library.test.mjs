// odc_external_library (lane extlib): the whole tool over the real tenant-aware access (portal/runtime/access.mjs), the
// real deployer and uploaders, with fakes at every boundary: the ODC Studio bridge (auth-status, portal-call,
// portal-session, portal-upload), the vault (status and the API Client's OdcBridge), the private prompt, the ODC kernel
// (external-library build) and a small in-memory tenant. Nothing reaches a Studio, a vault, a tenant or a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createExternalLibraryTool, validateExternalLibrarySpec } from '../odc-external-library.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { WriteJournal } from '../../portal/runtime/write-journal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', '..', '..', '..', 'kernel', 'tests', 'fixtures', 'external-library');
const PERSONAL = 'personal-test.outsystems.dev', CORP = 'corp.outsystems.dev';
const LIBKEY = '7d1c4f2a-0b6e-4c55-9a51-2f6b8d9e1a11', CONSUMER = '0f3e2d1c-4b5a-4968-8776-5a4b3c2d1e0f';
const SPEC = { name: 'SSAMTextTools', actions: [{ name: 'Reverse', inputs: [{ name: 'Text', type: 'Text' }], outputs: [{ name: 'Result', type: 'Text' }], body: 'Result = new string(Text.Reverse().ToArray());' }] };
const WORDS = 'yes, deploy SSAMTextTools to the personal tenant';
const catalog = new Catalog();
const uuid = () => crypto.randomUUID();
const PUB = n => '9a8b7c6d-0000-4000-8000-' + String(n).padStart(12, '0'); // publication keys are UUIDs in the contract

// The in-memory tenant: assets, consumers, published elements, generation jobs, publications and tags.
function tenantFake({ assets = [], consumers = {}, elements = {}, jobs = [], highest = {}, jobStatuses = ['Generating', 'ReadyForReview'], publishStatuses = ['Running', 'Finished'],
  contents, log = [], runtime = 'NET10' } = {}) {
  const t = { assets: structuredClone(assets), jobs: structuredClone(jobs), publications: [], tags: {}, reads: [], writes: [], jobReads: 0 };
  const json = (body, status = 200) => ({ ok: true, status, contentType: 'application/json', body, host: PERSONAL });
  const notFound = () => json({ title: 'not found' }, 404);
  t.createJob = fileName => {
    const job = { key: 'job-' + (t.jobs.length + 1), filename: fileName, libraryName: null, libraryKey: assets[0]?.assetKey ?? LIBKEY, isNewLibrary: !assets.length, statuses: [...jobStatuses], status: 'Generating', createdAt: '2026-10-05T00:00:00Z' };
    t.jobs.push(job); return job;
  };
  t.publish = jobKey => {
    const job = t.jobs.find(j => j.key === jobKey);
    const asset = t.assets.find(a => a.assetKey === job.libraryKey) ?? (t.assets.push({ assetKey: job.libraryKey, name: 'SSAMTextTools', assetType: 'ExternalLibrary', revision: 0 }), t.assets.at(-1));
    asset.revision += 1;
    const op = { key: PUB(t.publications.length + 1), assetKey: asset.assetKey, revision: asset.revision, statuses: [...publishStatuses], status: 'Running' };
    t.publications.push(op); return op;
  };
  t.call = request => {
    const route = request.basePath + request.path, query = new URLSearchParams(request.query ?? '');
    (request.method === 'GET' ? t.reads : t.writes).push(request.method + ' ' + route);
    let m;
    if (route === '/api/asset-repository/v1/assets') return json({ results: t.assets.filter(a => a.name.toLowerCase().includes(String(query.get('nameContains')).toLowerCase())) });
    if ((m = /^\/api\/asset-repository\/v1\/assets\/([^/]+)\/highest-tag-revision$/.exec(route))) return highest[m[1]] ? json({ tag: highest[m[1]] }) : notFound();
    if ((m = /^\/api\/asset-repository\/v1\/assets\/([^/]+)\/revisions$/.exec(route))) return json({ results: Object.entries(t.tags).filter(([, tag]) => tag === query.get('tag')).map(([revision, tag]) => ({ revision: Number(revision), tag })) });
    if ((m = /^\/api\/asset-repository\/v1\/assets\/([^/]+)\/revisions\/(\d+)\/metadata$/.exec(route))) return json({ runtime });
    if ((m = /^\/api\/asset-repository\/v1\/assets\/([^/]+)\/revisions\/(\d+)$/.exec(route))) {
      if (request.method === 'PATCH') { t.tags[m[2]] = request.body.tag; return json({}); }
      return json({ assetKey: m[1], revision: Number(m[2]), tag: t.tags[m[2]] ?? null });
    }
    if ((m = /^\/api\/asset-repository\/v1\/assets\/([^/]+)$/.exec(route))) { const a = t.assets.find(x => x.assetKey === m[1]); return a ? json(a) : notFound(); }
    if ((m = /^\/api\/dependency-management\/v1\/assets\/([^/]+)\/consumers$/.exec(route))) return json({ results: consumers[m[1]] ?? [] });
    if ((m = /^\/api\/dependency-management\/v1\/assets\/([^/]+)\/revisions\/(\d+)\/public-elements$/.exec(route))) return json({ results: elements[m[1]] ?? [] });
    if (route === '/api/external-libraries/v1/generation-operations') return json({ results: t.jobs.map(({ statuses, ...j }) => j) });
    if ((m = /^\/api\/external-libraries\/v1\/generation-operations\/([^/]+)\/contents$/.exec(route))) return json(contents ?? { actions: [{ name: 'Reverse', changeType: 'Added', parameters: [{ name: 'Text', dataType: 'Text', parameterType: 'Input' }, { name: 'Result', dataType: 'Text', parameterType: 'Output' }] }], structures: [] });
    if ((m = /^\/api\/external-libraries\/v1\/generation-operations\/([^/]+)\/log-messages$/.exec(route))) return json({ validationMessages: log });
    if ((m = /^\/api\/external-libraries\/v1\/generation-operations\/([^/]+)$/.exec(route))) {
      const job = t.jobs.find(j => j.key === m[1]);
      if (!job) return notFound();
      if (request.method === 'DELETE') { t.jobs = t.jobs.filter(j => j !== job); return { ok: true, status: 204, host: PERSONAL }; }
      t.jobReads++;
      if (job.statuses?.length) job.status = job.statuses.shift();
      if (job.status === 'ReadyForReview') job.libraryName = 'SSAMTextTools';
      const { statuses, ...rest } = job; return json(rest);
    }
    if (route === '/api/deployments/v1/publish-operations') return json({ results: t.publications.filter(p => p.assetKey === query.get('assetKey')).map(({ statuses, ...p }) => p) });
    if ((m = /^\/api\/deployments\/v1\/publish-operations\/([^/]+)\/messages$/.exec(route))) return json({ results: [] });
    if ((m = /^\/api\/deployments\/v1\/publish-operations\/([^/]+)$/.exec(route))) {
      const op = t.publications.find(p => p.key === m[1]); if (!op) return notFound();
      if (op.statuses.length) op.status = op.statuses.shift();
      const { statuses, ...rest } = op; return json(rest);
    }
    return json({ title: 'unexpected ' + request.method + ' ' + route }, 400);
  };
  return t;
}

function harness({ tenant = tenantFake(), signedIn = true, capabilities = ['portal-call', 'portal-session', 'auth-status', 'portal-upload', 'reference-snapshot:external-library'],
  apiClient = false, upload, metadata, grants = { findGrant: () => null } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-extlib-'));
  const requests = new Map(), calls = [], kernelCalls = [], vaultFetches = [];
  let n = 0;
  const studio = {
    running: async () => true,
    call: async args => {
      calls.push(args);
      if (args[0] === 'auth-status') return { ok: true, bridge: 'v38', sessions: [{ host: PERSONAL, loggedIn: true, user: 'dev@example.test' }, { host: CORP, loggedIn: true, user: 'dev@example.test' }], portalWindows: [], capabilities };
      if (args[0] === 'portal-call') return tenant.call(requests.get(args[1]));
      if (args[0] === 'portal-session') {
        if (args[1] !== 'fetch') return { ok: true, host: args.at(-1), signedIn };
        const request = requests.get(args[2]);
        if (/ActionExternalLibraryPublishJob$/.test(request.path)) { const op = tenant.publish(request.body.inputParameters.JobKey); return { ok: true, status: 200, host: PERSONAL, body: { data: { PublicationKey: op.key } } }; }
        return { ok: false, code: 'BAD_REQUEST' };
      }
      if (args[0] === 'portal-upload') {
        const request = requests.get(args[1]);
        assert.ok(fs.existsSync(request.file) && path.dirname(request.file) === path.join(dir, 'journal', 'portal', 'uploads'), 'the package is staged in journal/portal/uploads');
        if (upload) return upload(request);
        const job = tenant.createJob(request.fileName);
        return { ok: true, operationKey: job.key, bytes: fs.statSync(request.file).size, sha256: request.sha256, fileName: request.fileName, write: true };
      }
      return { ok: false, error: 'Unknown command ' + args[0] };
    },
  };
  const vault = {
    apiClient: async () => ({ available: apiClient }),
    portal: async () => ({ available: false }),
    bridge: async host => ({ config: { origin: 'https://' + host }, auth: { getToken: async () => 'vault-token' },
      fetch: async (url, options) => {
        vaultFetches.push({ url: String(url), method: options.method, authorization: options.headers?.authorization ?? null, redirect: options.redirect });
        if (options.method === 'GET') return Response.json({ uploadUrl: 'https://bucket.s3.amazonaws.com/u?X-Amz-Signature=1', downloadUrl: 'https://bucket.s3.amazonaws.com/d?X-Amz-Signature=2' });
        if (options.method === 'PUT') return new Response(null, { status: 200 });
        const job = tenant.createJob(JSON.parse(options.body).fileName);
        return Response.json({ operationKey: job.key });
      } }),
  };
  const prompt = { apiClient: async () => ({ opened: true }), portal: async () => ({ opened: true }) };
  const access = new OdcAccess({ catalog, tenants: { default: PERSONAL, tenants: { [PERSONAL]: { class: 'personal' }, [CORP]: { class: 'corporate' } } }, studio, vault, prompt,
    portalBroker: () => ({ target: 'odc3', available: false, authenticated: false, initialize: async () => {} }), receipts: new WriteJournal(path.join(dir, 'receipts')),
    requestFile: json => { const file = 'req-' + (++n); requests.set(file, structuredClone(json)); return file; }, sleep: async () => {} });
  for (const host of [PERSONAL, CORP]) access.studioBroker(host).metadata.resolve = metadata ?? (async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action }));
  const kernel = async args => {
    kernelCalls.push(args);
    const spec = JSON.parse(fs.readFileSync(args[args.indexOf('--spec') + 1], 'utf8'));
    const out = args[args.indexOf('--out') + 1];
    fs.mkdirSync(out, { recursive: true });
    const bytes = Buffer.from('PK fake package of ' + spec.name);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = path.join(out, spec.name + '-' + sha256.slice(0, 16) + '.zip');
    fs.writeFileSync(file, bytes);
    const contents = { actions: spec.actions.map(a => ({ name: a.name, parameters: [...(a.inputs ?? []).map(p => ({ name: p.name, dataType: p.type, direction: 'Input' })), ...(a.outputs ?? []).map(p => ({ name: p.name, dataType: p.type, direction: 'Output' }))] })),
      structures: (spec.structures ?? []).map(s => ({ name: s.name, attributes: s.attributes.map(x => ({ name: x.name, dataType: x.type })) })) };
    return { ok: true, envelope: { ok: true, command: 'external-library', data: { ok: true, name: spec.name, package: { path: file, fileName: path.basename(file), sha256, bytes: bytes.length },
      contents, sdk: { package: 'OutSystems.ExternalLibraries.SDK', version: '1.5.0' }, targetFramework: 'net10.0', runtime: 'linux-x64' } } };
  };
  const tool = createExternalLibraryTool({ access, kernel, grants, portalRoot: dir, evidenceRoot: path.join(dir, 'evidence'), sleep: async () => {}, waits: { pollMs: 1, readbackSeconds: 5 } });
  const sent = () => calls.filter(c => c[0] === 'portal-upload' || (c[0] === 'portal-call' && requests.get(c[1]).method !== 'GET') || (c[0] === 'portal-session' && c[1] === 'fetch' && requests.get(c[2]).write));
  const receipts = () => (fs.existsSync(path.join(dir, 'receipts')) ? fs.readdirSync(path.join(dir, 'receipts')) : []);
  return { tool, access, tenant, calls, requests, kernelCalls, vaultFetches, sent, receipts, dir };
}
const deploy = (h, extra = {}) => h.tool({ action: 'deploy', spec: SPEC, tenant: PERSONAL, authorize: WORDS, operationUuid: uuid(), ...extra });

test('1. a spec with bad identifiers, a duplicate action, an unknown type, an undeclared structure and a package without version: five problems, zero calls', async () => {
  const h = harness();
  const spec = JSON.parse(fs.readFileSync(path.join(fixtures, 'spec-invalid.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'spec-invalid.expected.json'), 'utf8')).problems;
  // The same five as the kernel's ExternalLibrarySpec (OdcExternalLibraryTests reads the same two files).
  assert.deepEqual(validateExternalLibrarySpec(spec).map(p => ({ code: p.code, path: p.path })), expected);
  const out = await h.tool({ action: 'deploy', spec, tenant: PERSONAL, authorize: 'yes, deploy Text Tools now', operationUuid: uuid() });
  assert.equal(out.ok, false); assert.equal(out.code, 'EXTERNAL_LIBRARY_SPEC_INVALID');
  assert.deepEqual(out.problems.map(p => ({ code: p.code, path: p.path })), expected);
  assert.ok(out.problems.every(p => typeof p.fix === 'string' && p.fix));
  assert.equal(h.calls.length, 0); assert.equal(h.kernelCalls.length, 0); assert.deepEqual(h.tenant.reads, []);
  const built = await h.tool({ action: 'build', spec });
  assert.equal(built.code, 'EXTERNAL_LIBRARY_SPEC_INVALID'); assert.equal(h.kernelCalls.length, 0);
});

test('2. words without the library name, no words without a grant, a corporate tenant without confirmTenant: refused, zero sends, no receipt', async () => {
  const h = harness();
  const unnamed = await deploy(h, { authorize: 'yes, deploy the text library now' });
  assert.equal(unnamed.code, 'WORDS_MUST_NAME_LIBRARY'); assert.equal(unnamed.problems[0].ssamRule, true);
  const none = await deploy(h, { authorize: undefined });
  assert.equal(none.code, 'WORDS_MUST_NAME_LIBRARY');
  const corporate = await deploy(h, { tenant: CORP, authorize: 'yes, deploy SSAMTextTools on corp' });
  assert.equal(corporate.code, 'CORPORATE_TENANT_GUARD'); assert.equal(corporate.sent, false);
  assert.deepEqual(h.sent(), []); assert.deepEqual(h.receipts(), []); assert.equal(h.kernelCalls.length, 0);
  // A standing publish grant of the library stands for the words.
  const granted = harness({ grants: { findGrant: q => (q.app === 'SSAMTextTools' && q.verb === 'publish' ? { grantId: 'g-1', words: 'publique o SSAMTextTools sempre' } : null) } });
  const viaGrant = await deploy(granted, { authorize: undefined });
  assert.equal(viaGrant.ok, true, JSON.stringify(viaGrant)); assert.deepEqual(viaGrant.authorization, { source: 'standing-grant', grantId: 'g-1' });
});

test('3. the Portal window not signed in, or the publish route missing from the Portal: refused before any portal-upload', async () => {
  const h = harness({ signedIn: false });
  const out = await deploy(h);
  assert.equal(out.code, 'WEB_SIGN_IN_REQUIRED'); assert.equal(out.continuation.tool, 'odc_portal_login'); assert.equal(out.sent, false);
  assert.equal(h.calls.filter(c => c[0] === 'portal-upload').length, 0); assert.deepEqual(h.receipts(), []);
  const changed = harness({ metadata: async () => { const e = new Error('The exact allowed action was not found in its current view.'); e.code = 'PORTAL_CONTRACT_CHANGED'; throw e; } });
  const refused = await deploy(changed);
  assert.equal(refused.code, 'PORTAL_CONTRACT_CHANGED'); assert.equal(refused.continuation.tool, 'odc_portal_routes');
  assert.deepEqual(changed.sent(), []); assert.deepEqual(changed.receipts(), []);
});

test('4. a bridge without portal-upload: the vault API Client uploads (the PUT carries no Authorization); without it BRIDGE_UPGRADE_REQUIRED, nothing sent', async () => {
  const old = ['portal-call', 'portal-session', 'auth-status'];
  const h = harness({ capabilities: old, apiClient: true });
  const out = await deploy(h);
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.upload.auth, 'vault');
  assert.deepEqual(h.vaultFetches.map(f => f.method), ['GET', 'PUT', 'POST']);
  const put = h.vaultFetches[1];
  assert.equal(put.authorization, null); assert.equal(put.redirect, 'manual'); assert.match(put.url, /amazonaws/);
  assert.equal(h.vaultFetches[0].authorization, 'Bearer vault-token'); assert.equal(h.vaultFetches[2].authorization, 'Bearer vault-token');
  assert.doesNotMatch(JSON.stringify(out), /amazonaws|uploadUrl|downloadUrl|X-Amz/);
  const none = harness({ capabilities: old, apiClient: false });
  const refused = await deploy(none);
  assert.equal(refused.code, 'BRIDGE_UPGRADE_REQUIRED'); assert.equal(refused.continuation.tool, 'studio_attach');
  assert.deepEqual(none.sent(), []); assert.deepEqual(none.receipts(), []); assert.deepEqual(none.vaultFetches, []);
});

test('5. a library with consumers and an action removed: CONSUMERS_WOULD_BREAK; words naming each consumer deploy and list them as outdated', async () => {
  const existing = () => tenantFake({ assets: [{ assetKey: LIBKEY, name: 'SSAMTextTools', assetType: 'ExternalLibrary', revision: 3 }], highest: { [LIBKEY]: '1.0.2' },
    consumers: { [LIBKEY]: [{ key: CONSUMER, name: 'OrdersApp', type: 'WebApplication', revision: 9 }] },
    elements: { [LIBKEY]: [{ name: 'Reverse', type: 'ServerAction' }, { name: 'Upper', type: 'ServerAction' }] },
    contents: { actions: [{ name: 'Reverse', changeType: 'Unchanged', parameters: [{ name: 'Text', dataType: 'Text', parameterType: 'Input' }, { name: 'Result', dataType: 'Text', parameterType: 'Output' }] },
      { name: 'Upper', changeType: 'Removed', parameters: [] }], structures: [] } });
  const h = harness({ tenant: existing() });
  const refused = await deploy(h);
  assert.equal(refused.code, 'CONSUMERS_WOULD_BREAK'); assert.deepEqual(refused.consumers, ['OrdersApp']);
  assert.deepEqual(refused.problems.map(p => [p.code, p.target, p.ssamRule]), [['CONSUMERS_WOULD_BREAK', 'OrdersApp', true]]);
  assert.deepEqual(refused.contractDiff.removed, [{ kind: 'action', name: 'Upper' }]);
  assert.deepEqual(h.sent(), []); assert.deepEqual(h.receipts(), []);
  const named = harness({ tenant: existing() });
  const out = await deploy(named, { authorize: 'yes, deploy SSAMTextTools; OrdersApp may break, I will fix it' });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.tag, '1.0.3'); assert.equal(out.revision, 4);
  assert.deepEqual(out.consumers.map(c => [c.name, c.outdated, c.steps.map(s => s.tool)]), [['OrdersApp', true, ['studio_refresh_references', 'studio_publish']]]);
  // A standing grant never covers a change that breaks consumers.
  const grant = harness({ tenant: existing(), grants: { findGrant: () => ({ grantId: 'g-2', words: 'publique o SSAMTextTools e o OrdersApp sempre' }) } });
  assert.equal((await deploy(grant, { authorize: undefined })).code, 'CONSUMERS_WOULD_BREAK');
});

test('6. an open job of the same library is GENERATION_PENDING with its jobKey; a used tag is TAG_TAKEN with the next one', async () => {
  const h = harness({ tenant: tenantFake({ jobs: [{ key: 'job-old', filename: 'SSAMTextTools-aaaaaaaaaaaaaaaa.zip', libraryName: 'SSAMTextTools', status: 'ReadyForReview' }] }) });
  const pending = await deploy(h);
  assert.equal(pending.code, 'GENERATION_PENDING'); assert.equal(pending.jobKey, 'job-old');
  assert.equal(pending.continuation.tool, 'odc_external_library'); assert.equal(pending.continuation.arguments.action, 'discard'); assert.equal(pending.continuation.arguments.jobKey, 'job-old');
  assert.deepEqual(h.sent(), []);
  const tagged = harness({ tenant: tenantFake({ assets: [{ assetKey: LIBKEY, name: 'SSAMTextTools', assetType: 'ExternalLibrary', revision: 4 }], highest: { [LIBKEY]: '1.0.3' },
    elements: { [LIBKEY]: [{ name: 'Reverse', type: 'ServerAction' }] } }) });
  const taken = await deploy(tagged, { releaseTag: '1.0.2' });
  assert.equal(taken.code, 'TAG_TAKEN'); assert.equal(taken.nextTag, '1.0.4'); assert.deepEqual(tagged.sent(), []);
  // Both at once: one refusal with every problem.
  const both = harness({ tenant: tenantFake({ assets: [{ assetKey: LIBKEY, name: 'SSAMTextTools', assetType: 'ExternalLibrary', revision: 4 }, { assetKey: CONSUMER, name: 'ssamtexttools', assetType: 'WebApplication', revision: 1 }],
    highest: { [LIBKEY]: '1.0.3' }, elements: { [LIBKEY]: [] }, jobs: [{ key: 'job-old', filename: 'SSAMTextTools-a.zip', libraryName: 'SSAMTextTools', status: 'Generating' }] }) });
  const all = await deploy(both, { releaseTag: '1.0.3' });
  assert.equal(all.code, 'DEPLOY_REFUSED');
  assert.deepEqual(all.problems.map(p => p.code).sort(), ['GENERATION_PENDING', 'NAME_TAKEN_BY_OTHER_ASSET', 'TAG_TAKEN']);
});

test('7. the happy path: build, upload, two reads until ReadyForReview, publishJob, Finished, the tag, the NET10 readback, one answer without URLs', async () => {
  const h = harness();
  const out = await deploy(h);
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.state, 'released');
  assert.deepEqual(out.library, { name: 'SSAMTextTools', key: LIBKEY, created: true });
  assert.equal(out.revision, 1); assert.equal(out.tag, '1.0.0'); assert.equal(out.runtime, 'NET10');
  assert.equal(h.kernelCalls.length, 1); assert.deepEqual(h.kernelCalls[0].slice(0, 2), ['external-library', 'build']);
  assert.equal(h.calls.filter(c => c[0] === 'portal-upload').length, 1);
  assert.equal(h.tenant.jobReads, 2, 'two reads of the job: Generating, then ReadyForReview');
  const publishes = h.calls.filter(c => c[0] === 'portal-session' && c[1] === 'fetch').map(c => h.requests.get(c[2]));
  assert.equal(publishes.length, 1); assert.equal(publishes[0].body.inputParameters.JobKey, 'job-1'); assert.equal(publishes[0].write, true);
  assert.deepEqual(h.tenant.writes, ['PATCH /api/asset-repository/v1/assets/' + LIBKEY + '/revisions/1']);
  assert.equal(h.tenant.tags['1'], '1.0.0');
  assert.equal(out.receipt.state, 'confirmed');
  assert.deepEqual(out.references, ['IServerAction:Reverse']);
  assert.equal(out.continuation.tool, 'studio_deliver');
  assert.deepEqual(JSON.parse(fs.readFileSync(out.continuation.arguments.job, 'utf8')), { ops: [{ op: 'reference', producer: 'SSAMTextTools', elements: ['IServerAction:Reverse'] }] });
  assert.doesNotMatch(JSON.stringify(out), /uploadUrl|downloadUrl|amazonaws/);
  // The words are kept only as their sha256.
  const receipt = fs.readFileSync(out.receipt.file, 'utf8');
  assert.doesNotMatch(receipt, /deploy SSAMTextTools to the personal/); assert.match(receipt, new RegExp(crypto.createHash('sha256').update(WORDS).digest('hex')));
  // The same operationUuid again reads the receipt: nothing is sent again.
  const before = h.sent().length;
  const again = await h.tool({ action: 'deploy', spec: SPEC, tenant: PERSONAL, authorize: WORDS, operationUuid: out.receipt.operationUuid });
  assert.equal(again.existingReceipt, true); assert.equal(h.sent().length, before);
});

test('8. GenerationError is GENERATION_FAILED with no publish; FinishedWithError is PUBLISH_FAILED with no tag', async () => {
  const failed = harness({ tenant: tenantFake({ jobStatuses: ['Generating', 'GenerationError'], log: [{ type: 'Error', errorCode: 'EL-1001', message: 'The interface ISSAMTextTools has no OSInterface attribute.' }] }) });
  const generation = await deploy(failed);
  assert.equal(generation.code, 'GENERATION_FAILED'); assert.equal(generation.messages[0].code, 'EL-1001'); assert.match(generation.error, /no OSInterface/);
  assert.equal(failed.calls.filter(c => c[0] === 'portal-session' && c[1] === 'fetch').length, 0);
  assert.deepEqual(failed.tenant.writes, []);
  const publish = harness({ tenant: tenantFake({ publishStatuses: ['Running', 'FinishedWithError'] }) });
  const out = await deploy(publish);
  assert.equal(out.code, 'PUBLISH_FAILED'); assert.equal(out.publishKey, PUB(1));
  assert.deepEqual(publish.tenant.writes, [], 'no PATCH of the tag');
  assert.equal(publish.calls.filter(c => c[0] === 'portal-upload').length, 1);
});

test('9. a lost portal-upload answer is UNCERTAIN, never resent; the same operationUuid settles it by the file name; two such jobs are AMBIGUOUS', async () => {
  let h;
  h = harness({ upload: request => { h.tenant.createJob(request.fileName); throw new Error('pipe broken'); } });
  const operationUuid = uuid();
  const lost = await h.tool({ action: 'deploy', spec: SPEC, tenant: PERSONAL, authorize: WORDS, operationUuid });
  assert.equal(lost.ok, false); assert.equal(lost.code, 'UNCERTAIN'); assert.equal(lost.state, 'uncertain'); assert.equal(lost.step, 'upload');
  assert.equal(lost.continuation.tool, 'odc_external_library'); assert.equal(lost.continuation.arguments.operationUuid, operationUuid);
  assert.doesNotMatch(JSON.stringify(lost.continuation), /deploy SSAMTextTools to the personal/);
  const settled = await h.tool({ action: 'deploy', spec: SPEC, tenant: PERSONAL, authorize: WORDS, operationUuid });
  assert.equal(settled.ok, true, JSON.stringify(settled)); assert.equal(settled.upload.jobKey, 'job-1');
  assert.equal(h.calls.filter(c => c[0] === 'portal-upload').length, 1, 'the upload was never sent again');
  let a;
  a = harness({ upload: request => { a.tenant.createJob(request.fileName); a.tenant.createJob(request.fileName); throw new Error('pipe broken'); } });
  const id = uuid();
  assert.equal((await a.tool({ action: 'deploy', spec: SPEC, tenant: PERSONAL, authorize: WORDS, operationUuid: id })).code, 'UNCERTAIN');
  const ambiguous = await a.tool({ action: 'deploy', spec: SPEC, tenant: PERSONAL, authorize: WORDS, operationUuid: id });
  assert.equal(ambiguous.code, 'AMBIGUOUS'); assert.deepEqual(ambiguous.candidates.map(e => e.key), ['job-1', 'job-2']);
  assert.equal(a.calls.filter(c => c[0] === 'portal-upload').length, 1);
});

test('status reads the library, its revisions, runtime, consumers and open jobs; discard deletes an open job with words naming the library', async () => {
  const tenant = tenantFake({ assets: [{ assetKey: LIBKEY, name: 'SSAMTextTools', assetType: 'ExternalLibrary', revision: 2, tag: '1.0.1' }],
    consumers: { [LIBKEY]: [{ key: CONSUMER, name: 'OrdersApp' }] }, jobs: [{ key: 'job-9', filename: 'SSAMTextTools-bbbbbbbbbbbbbbbb.zip', libraryName: 'SSAMTextTools', status: 'ReadyForReview' }] });
  const h = harness({ tenant });
  const status = await h.tool({ action: 'status', library: 'SSAMTextTools', tenant: PERSONAL });
  assert.equal(status.ok, true); assert.equal(status.exists, true); assert.equal(status.runtime, 'NET10');
  assert.deepEqual(status.consumers, ['OrdersApp']); assert.deepEqual(status.jobs.map(j => [j.jobKey, j.pending]), [['job-9', true]]);
  assert.deepEqual(h.sent(), []);
  const refused = await h.tool({ action: 'discard', library: 'SSAMTextTools', jobKey: 'job-9', tenant: PERSONAL, authorize: 'yes, throw that job away', operationUuid: uuid() });
  assert.equal(refused.code, 'WORDS_MUST_NAME_LIBRARY'); assert.deepEqual(h.sent(), []);
  const done = await h.tool({ action: 'discard', jobKey: 'job-9', tenant: PERSONAL, authorize: 'yes, discard the SSAMTextTools job', operationUuid: uuid() });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.readBack.gone, true);
  assert.deepEqual(tenant.writes, ['DELETE /api/external-libraries/v1/generation-operations/job-9']);
});

test('the tool refuses unknown fields per action and build needs no tenant', async () => {
  const h = harness();
  assert.equal((await h.tool({ action: 'build', spec: SPEC, tenant: PERSONAL })).code, 'UNKNOWN_FIELD');
  const built = await h.tool({ action: 'build', spec: SPEC });
  assert.equal(built.ok, true); assert.equal(built.package.fileName.startsWith('SSAMTextTools-'), true); assert.equal(h.calls.length, 0);
  assert.equal(built.next.tool, 'odc_external_library');
});
