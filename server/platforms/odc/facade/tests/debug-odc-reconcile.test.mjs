import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as P from '../debug-odc-portal.mjs';
import { debugRun, runSchema, debugRunSchema, registerRunTools, parseRunCli, moduleKeyOf } from '../debug-run.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

const id = '12345678-1234-4234-8234-123456789abc';
const publishKey = '12345678-1234-4234-8234-123456789abd';
const creator = '12345678-1234-4234-8234-123456789abe';
const deployer = '12345678-1234-4234-8234-123456789abf';
const binding = { tenant: 'fixture.outsystems.dev', portalOrigin: 'https://fixture.outsystems.dev',
  assetKey: '12345678-1234-4234-8234-123456789aba', environmentKey: '12345678-1234-4234-8234-123456789abb',
  module: 'Fixture', moduleKey: moduleKeyOf('12345678-1234-4234-8234-123456789aba'), modelAuthor: '12345678-1234-4234-8234-123456789ab1' };
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const page = results => ({ page: { offset: 0, limit: 100, nextPageOffset: null }, results });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-odc-reconcile-'));
  const base = Buffer.from('original source bound to model author ' + binding.modelAuthor);
  const candidate = Buffer.from('candidate source bound to model author ' + binding.modelAuthor);
  const candidateFile = path.join(dir, 'candidate.oml'); fs.writeFileSync(candidateFile, candidate);
  const operation = P.writeOperation(binding, 'create', { baseRevision: 7, baseSha256: P.sha256(base), candidateSha256: P.sha256(candidate) }, { id });
  Object.assign(operation, { phase: 'publish-accepted', revision: 8, expectedCreatedByHash: P.sha256(Buffer.from(creator)),
    publication: { phase: 'accepted', submittedAt: new Date().toISOString(), operationKey: publishKey, expectedDeployedByHash: P.sha256(Buffer.from(deployer)) } });
  operation.recordFile = path.join(dir, 'operation.json');
  const revision = { assetKey: binding.assetKey, name: binding.module, revision: 8, createdBy: creator,
    createdAt: new Date().toISOString(), commitMessage: operation.comment };
  const publication = { key: publishKey, status: 'Finished', assetKey: binding.assetKey, revision: 8, operation: 'Publish', deployedBy: deployer };
  const state = { revisions: [revision], publications: [publication], detail: publication, developmentRevision: 8, candidate, base };
  const reads = [], downloads = [], writes = [];
  const portal = { host: binding.tenant, origin: binding.portalOrigin,
    write: async (...args) => { writes.push(args); throw new Error('unexpected mutation'); },
    direct: async () => { throw new Error('unexpected direct request'); },
    read: async (api, input) => {
      reads.push({ api, input });
      if (api === 'asset-repository-api-v1:get:/assets/{assetKey}/revisions') {
        assert.equal(input.path.assetKey, binding.assetKey); assert.equal(input.query.commitMessage, operation.comment);
        return page(state.revisions);
      }
      if (api === 'portfolio-api-v2:get:/deployed-assets') {
        assert.equal(input.query.environmentKey, binding.environmentKey); assert.equal(input.query.key, binding.assetKey);
        return { results: [{ key: binding.assetKey, type: 'WebApplication', deployments: [{ environmentKey: binding.environmentKey, revision: state.developmentRevision }] }] };
      }
      if (api === 'deployments-api-v1:get:/publish-operations') {
        assert.equal(input.query.environmentKey, binding.environmentKey); assert.equal(input.query.assetKey, binding.assetKey);
        assert.equal(input.query.revision, 8); assert.equal(input.query.createdDateSince, operation.publication.submittedAt);
        return page(state.publications);
      }
      if (api === 'deployments-api-v1:get:/publish-operations/{operationKey}') {
        assert.equal(input.path.operationKey, publishKey); return state.detail;
      }
      throw new Error('unexpected read');
    },
  };
  const download = async (target, assetKey, revisionNumber, file) => {
    assert.equal(target, portal); assert.equal(assetKey, binding.assetKey);
    downloads.push(revisionNumber);
    const bytes = revisionNumber === 7 ? state.base : state.candidate;
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    return { file, sha256: P.sha256(bytes), bytes: bytes.length };
  };
  const leasePath = path.join(dir, 'lease.json');
  const lease = { state: 'uncertain', token: 'synthetic-private-wrapper-token', wrapperRevision: 8, writeOperation: operation,
    reaperPid: 987654, lastCallAt: '2026-10-02T12:00:00Z', idleMinutes: 30 };
  const persist = () => { save(operation.recordFile, operation); save(leasePath, lease); };
  persist();
  const context = { portal: { ...portal, tenant: { studioAuthor: binding.modelAuthor } }, assetKey: binding.assetKey,
    moduleKey: binding.moduleKey, stage: { key: binding.environmentKey }, runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/' };
  // Preserve object identity for the download seam; context uses the same target, with only public author metadata.
  portal.tenant = context.portal.tenant; context.portal = portal;
  return { dir, operation, candidateFile, state, portal, download, reads, downloads, writes, leasePath, lease, context, persist,
    close() { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('write operation binds a unique comment, both source hashes, model author and DEV; no credentials or generic comment adoption', () => {
  const f = fixture();
  try {
    assert.ok(f.operation.comment.includes(id)); assert.ok(f.operation.comment.includes(f.operation.candidateSha256));
    assert.ok(f.operation.comment.includes(f.operation.baseSha256)); assert.ok(f.operation.comment.includes(binding.modelAuthor));
    assert.doesNotMatch(f.operation.comment, /synthetic-private|Bearer|https:/);
    const another = P.writeOperation(binding, 'create', f.operation);
    assert.notEqual(another.comment, f.operation.comment); assert.equal(another.expectedCreatedByHash, null);
    assert.notEqual(P.writeOperation(binding, 'remove', f.operation).comment, f.operation.comment);
    assert.throws(() => P.writeOperation({ ...binding, modelAuthor: undefined }, 'create', f.operation), /binding_invalid/);
    assert.throws(() => P.writeOperation({ ...binding, moduleKey: 'A'.repeat(22) }, 'create', f.operation), /binding_invalid/);
  } finally { f.close(); }
});

test('all mutation phases are persisted before send; create and publish cannot be repeated with the same operation', async () => {
  const f = fixture(), sends = [];
  try {
    const operation = P.writeOperation(binding, 'create', f.operation, { id });
    const record = path.join(f.dir, 'submitted.json'), onStage = value => save(record, value);
    const before = expected => { assert.equal(JSON.parse(fs.readFileSync(record)).phase, expected); sends.push(expected); };
    const portal = { host: binding.tenant, origin: binding.portalOrigin,
      direct: async method => { assert.equal(method, 'POST'); before('upload-request-submitted');
        fs.writeFileSync(f.candidateFile, 'changed after the input snapshot'); return { uploadUrl: 'https://upload.invalid/private-capability' }; },
      write: async (api, input) => {
        if (api === 'asset-repository-api-v1:post:/assets') {
          before('revision-submitted'); assert.equal(input.body.commitMessage, operation.comment);
          return { ok: true, data: { applicationKey: binding.assetKey, revision: 8, revisionUserKey: creator } };
        }
        before('publish-submitted'); assert.deepEqual(Object.keys(input.body).sort(), ['assetKey', 'environmentKey', 'operation', 'revision']);
        return { ok: true, data: { key: publishKey, deployedBy: deployer, status: 'Running' } };
      },
    };
    await assert.rejects(P.createRevision(portal, f.candidateFile, operation.comment, { operation }), /journal_required/);
    assert.equal(sends.length, 0);
    const created = await P.createRevision(portal, f.candidateFile, operation.comment, { operation, onStage,
      fetchImpl: async (url, options) => { before('upload-put-submitted'); assert.equal(options.method, 'PUT');
        assert.equal(P.sha256(options.body), operation.candidateSha256); return { ok: true }; } });
    assert.equal(created.state, 'created'); assert.equal(operation.expectedCreatedByHash, P.sha256(Buffer.from(creator)));
    await assert.rejects(P.createRevision(portal, f.candidateFile, operation.comment, { operation }), /already_submitted/);
    await assert.rejects(P.publish(portal, binding.assetKey, 8, binding.environmentKey, { operation }), /journal_required/);
    const published = await P.publish(portal, binding.assetKey, 8, binding.environmentKey, { operation, onStage, timeoutMs: 0 });
    assert.equal(published.state, 'uncertain'); assert.equal(operation.publication.expectedDeployedByHash, P.sha256(Buffer.from(deployer)));
    await assert.rejects(P.publish(portal, binding.assetKey, 8, binding.environmentKey, { operation }), /already_submitted/);
    assert.deepEqual(sends, ['upload-request-submitted', 'upload-put-submitted', 'revision-submitted', 'publish-submitted']);
    assert.doesNotMatch(fs.readFileSync(record, 'utf8'), /private-capability|synthetic-private|Bearer/);
  } finally { f.close(); }
});

test('a lost create response remains uncertain and never deduces Portal author from the model author', async () => {
  const f = fixture(); let writes = 0;
  try {
    const operation = P.writeOperation(binding, 'create', f.operation, { id });
    const portal = { ...f.portal, direct: async () => ({ uploadUrl: 'https://upload.invalid/private-capability' }),
      write: async () => { writes++; throw new Error('synthetic-private-native-error'); } };
    const result = await P.createRevision(portal, f.candidateFile, operation.comment, { operation,
      onStage: value => save(path.join(f.dir, 'submitted.json'), value), fetchImpl: async () => ({ ok: true }) });
    assert.deepEqual(result, { state: 'uncertain', stage: 'create-revision' }); assert.equal(writes, 1);
    await assert.rejects(P.createRevision(portal, f.candidateFile, operation.comment, { operation }), /already_submitted/);
    const reconciled = await P.reconcileWrite(f.portal, operation, binding, { directory: f.dir, download: f.download });
    assert.equal(reconciled.reason, 'revision-author-unproved'); assert.equal(reconciled.state, 'uncertain');
    assert.equal(f.downloads.length, 0); assert.equal(writes, 1);
    assert.doesNotMatch(JSON.stringify([result, reconciled, operation]), /synthetic-private-native-error|private-capability/);
  } finally { f.close(); }
});

test('reconciliation confirms only exact metadata/authors/source hashes/DEV and can observe an older publication without redeploying', async () => {
  const f = fixture();
  try {
    const result = await P.reconcileWrite(f.portal, f.operation, binding, { directory: f.dir, download: f.download });
    assert.equal(result.state, 'published'); assert.equal(result.currentlyDeployed, true); assert.equal(result.portalAuthorsConfirmed, true);
    assert.deepEqual(f.downloads, [7, 8]); assert.equal(f.writes.length, 0);
    f.state.developmentRevision = 99;
    const historical = await P.reconcileWrite(f.portal, f.operation, binding, { directory: f.dir, download: f.download });
    assert.equal(historical.state, 'published'); assert.equal(historical.currentlyDeployed, false); assert.equal(historical.developmentRevision, 99);
    assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('zero, ambiguity, generic comments, mismatched metadata/authors/hashes and incomplete reads always keep uncertainty', async () => {
  const cases = [
    ['zero revisions', f => { f.state.revisions = []; }],
    ['ambiguous revisions', f => { f.state.revisions.push({ ...f.state.revisions[0], revision: 9 }); }],
    ['generic historical comment', f => { f.state.revisions[0].commitMessage = 'SSAM Debug REST Create'; }],
    ['wrong asset', f => { f.state.revisions[0].assetKey = binding.environmentKey; }],
    ['wrong model name', f => { f.state.revisions[0].name = 'Another'; }],
    ['wrong revision author', f => { f.state.revisions[0].createdBy = deployer; }],
    ['unknown revision author', f => { f.operation.expectedCreatedByHash = null; }],
    ['wrong candidate hash', f => { f.state.candidate = Buffer.from('changed candidate'); }],
    ['wrong base hash', f => { f.state.base = Buffer.from('changed base'); }],
    ['zero publications', f => { f.state.publications = []; }],
    ['ambiguous publications', f => { f.state.publications.push({ ...f.state.publications[0], key: creator }); }],
    ['wrong publication author', f => { f.state.publications[0].deployedBy = creator; }],
    ['unknown publication author', f => { f.operation.publication.expectedDeployedByHash = null; }],
    ['wrong detail', f => { f.state.detail = { ...f.state.publications[0], revision: 9 }; }],
    ['nonterminal publication', f => { f.state.publications[0].status = 'Running'; }],
    ['read failure', f => { f.portal.read = async () => { throw new Error('synthetic-private-read-error'); }; }],
  ];
  for (const [name, patch] of cases) {
    const f = fixture();
    try {
      patch(f);
      const result = await P.reconcileWrite(f.portal, f.operation, binding, { directory: f.dir, download: f.download });
      assert.equal(result.state, 'uncertain', name); assert.equal(f.writes.length, 0, name);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private-read-error/);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    const result = await P.reconcileWrite(f.portal, f.operation, { ...binding, environmentKey: creator }, { directory: f.dir, download: f.download });
    assert.equal(result.reason, 'binding-mismatch'); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('paginated contains search is fully read and never treated as exact match on a truncated page', async () => {
  const f = fixture(), original = f.portal.read;
  try {
    f.portal.read = async (api, input) => api.startsWith('asset-repository') && input.query.offset === 0
      ? { page: { nextPageOffset: 100 }, results: [{ ...f.state.revisions[0], commitMessage: 'prefix ' + f.operation.comment }] }
      : original(api, input);
    assert.equal((await P.reconcileWrite(f.portal, f.operation, binding, { directory: f.dir, download: f.download })).state, 'published');
    assert.equal((await P.reconcileWrite(f.portal, f.operation, binding, { directory: f.dir, download: f.download, maxPages: 1 })).state, 'uncertain');
    assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('official reconcile is explicit, read-only and updates only the tracked current operation; idle fields and other wrappers are preserved', async () => {
  const f = fixture();
  const services = { context: async () => f.context, leasePath: f.leasePath, journal: () => {},
    reconcile: (portal, operation, target, options) => P.reconcileWrite(portal, operation, target, { ...options, download: f.download }) };
  const input = { op: 'reconcile', tenant: binding.tenant, module: binding.module, operationId: id };
  try {
    assert.equal(runSchema.safeParse({ ...input, operationId: undefined }).success, false);
    assert.equal(runSchema.safeParse({ ...input, op: 'release' }).success, false);
    const request = path.join(f.dir, 'request.json'); save(request, input);
    assert.equal(parseRunCli(['reconcile', '--request', request]).operationId, id);
    const adopted = await debugRun(input, { services });
    assert.equal(adopted.ok, true); assert.equal(adopted.adopted, true); assert.equal(adopted.lease.state, 'active');
    const saved = JSON.parse(fs.readFileSync(f.leasePath));
    for (const field of ['token', 'reaperPid', 'lastCallAt', 'idleMinutes']) assert.equal(saved[field], f.lease[field]);
    assert.doesNotMatch(JSON.stringify(adopted), /synthetic-private-wrapper-token/);
    f.lease.state = 'uncertain'; f.state.developmentRevision = 99; f.persist();
    const historical = await debugRun(input, { services });
    assert.equal(historical.ok, true); assert.equal(historical.adopted, false); assert.equal(historical.lease.state, 'uncertain');
    const own = { ...f.operation, id: creator };
    f.lease.writeOperation = own; f.lease.writeHistory = [f.operation]; f.lease.wrapperRevision = 100; f.lease.state = 'active'; f.persist();
    const earlier = await debugRun(input, { services });
    assert.equal(earlier.adopted, false); assert.equal(earlier.lease.wrapperRevision, 100); assert.equal(earlier.lease.state, 'active');
    f.lease.writeOperation = undefined; f.lease.writeHistory = []; f.persist();
    const count = f.reads.length;
    const untracked = await debugRun(input, { services });
    assert.equal(untracked.error, 'debug_wrapper_reconcile_untracked_operation'); assert.equal(f.reads.length, count); assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('the common runner requires explicit O11 selection, validates its strict schema, and dispatches without ODC context or writes', async () => {
  const input = { op: 'prepare', lane: 'o11', host: 'personal.example.test', module: 'Fixture', moduleKey: 'A'.repeat(22),
    applicationKey: 'B'.repeat(22), runtimeUrl: 'https://personal.example.test/Fixture/', action: 'Original' };
  assert.equal(debugRunSchema.safeParse(input).success, true);
  assert.equal(debugRunSchema.safeParse({ ...input, lane: undefined }).success, false);
  assert.equal(debugRunSchema.safeParse({ ...input, tenant: binding.tenant }).success, false);
  assert.equal(debugRunSchema.parse({ op: 'status', tenant: binding.tenant, module: binding.module }).lane, 'odc');
  const calls = [], tools = new Map();
  const services = { runO11: async value => { calls.push(value); return { ok: true, lane: 'o11', state: 'prepared' }; },
    context: async () => { throw new Error('must not enter ODC'); } };
  registerRunTools({ registerTool(name, config, fn) { tools.set(name, { config, fn }); } }, value => debugRun(value, { services }), fn => fn);
  const tool = tools.get('ssam_debug_run');
  assert.equal(tool.config.inputSchema.safeParse(input).success, true);
  assert.equal((await tool.fn(input)).state, 'prepared'); assert.equal(calls.length, 1);
  assert.equal(calls[0].keep, false); assert.deepEqual(calls[0].inputs, {});
  await assert.rejects(debugRun({ ...input, password: 'invalid-public-field' }, { services }));
  assert.equal(calls.length, 1);
});

test('real MCP stdio exposes both runner schemas and rejects incomplete O11 preparation before any native operation', async () => {
  const client = new Client({ name: 'debug-reconcile-contract-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../ssam.mjs', import.meta.url)), 'mcp'], stderr: 'ignore' }));
  try {
    const tool = (await client.listTools()).tools.find(value => value.name === 'ssam_debug_run');
    assert.ok(tool); const schema = JSON.stringify(tool.inputSchema);
    assert.ok(schema.includes('operationId')); assert.ok(schema.includes('applicationKey')); assert.ok(schema.includes('o11'));
    const result = await client.callTool({ name: 'ssam_debug_run', arguments: { op: 'prepare', lane: 'o11' } });
    assert.equal(result.isError, true);
  } finally { await client.close(); }
});
