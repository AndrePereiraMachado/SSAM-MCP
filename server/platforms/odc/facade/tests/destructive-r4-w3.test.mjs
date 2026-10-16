import './fixtures/isolated-profile.mjs';
// CX15 r4 (W-3): the approval file of the cleanup of an own fixture (N3, f7c708b8) had to keep words = the owner's literal
// reply (authorization-context.mjs compared words by equality; a file with wordsSha256, with sha256 in words or with the
// words redacted was refused, AUTHORIZATION_CONTEXT_INVALID). Now the file binds the reply by wordsSha256 (the sha256 of
// the reply the guard validated) and never keeps it; the texts say to write only wordsSha256. Each of the six approvals
// (a2a, custom search, external-library discard, owned consumers, API Client fixture, API Client pending header; the file
// is required in five of them) passes, inside the guard's validated reply, with a file WITHOUT the words; a wrong hash, the
// creation's words (literal or hashed) and a file that binds no words are refused. End to end: odc_asset_delete of an own
// library with its own consumer deletes with such a file, and no file keeps the reply. Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { withValidatedReply, OWNED_CLEANUP } from '../../portal/runtime/owned-cleanup-approval.mjs';
import { a2aDeleteApproval } from '../../portal/runtime/a2a-delete-approval.mjs';
import { A2A_TEST } from '../../portal/runtime/a2a-connection-approval.mjs';
import { customSearchDeleteApproval } from '../../portal/runtime/custom-search-delete-approval.mjs';
import { CUSTOM_SEARCH_TEST } from '../../portal/runtime/custom-search-connection-approval.mjs';
import { externalLibraryDiscardApproval, EXTERNAL_LIBRARY_DEPLOY, EXTERNAL_LIBRARY_JOB_DELETE } from '../../portal/runtime/external-library-approval.mjs';
import { ownedConsumerDeletionApproval, consumerSetHash } from '../../portal/runtime/owned-consumer-deletion-approval.mjs';
import { apiClientFixtureApproval, API_CLIENT_CREATE, API_CLIENT_DELETE } from '../../portal/runtime/api-client-fixture.mjs';
import { apiClientWriteApproval } from '../../portal/runtime/api-client-pending-cleanup.mjs';
import { fingerprint, sha256 } from '../../portal/runtime/write-journal.mjs';
import { rawInput } from '../../portal/runtime/portal-routes.mjs';
import { previewFile } from '../destructive-operations.mjs';
import { MARK, filesWithMark } from './fixtures/destructive-r4-marker.mjs';

const HOST = 'personal-r3cleanup.outsystems.dev';
const uuid = () => crypto.randomUUID();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const CREATION = 'sim, pode criar as fixtures sinteticas ' + MARK;
const REPLY = 'confirmo o 1, pode limpar a fixture sintetica ' + MARK;
const invalid = { code: 'AUTHORIZATION_CONTEXT_INVALID' };

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r4-w3-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previewId = uuid(), operationId = uuid();
  const preview = path.join(dir, 'previews', previewId + '.json'); fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, JSON.stringify({ previewId, operationId, items: [{ name: 'synthetic' }] }));
  const creationSource = { kind: 'human-conversation', threadId: uuid(), messageId: uuid(), question: 'Create the synthetic fixture?' };
  // binding: the fields that bind the words in the file (the subject of W-3).
  const approval = ({ binding, scope, constraints }) => {
    const file = path.join(dir, 'approval-' + uuid() + '.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', ...binding, source: { ...creationSource, messageId: uuid() },
      proposal: { file: preview, sha256: sha(fs.readFileSync(preview)) }, scope: [scope], ...(constraints ? { constraints } : {}) }));
    return file;
  };
  const reply = keys => ({ host: HOST, tool: 'synthetic', previewId, operationId, previewFile: preview, wordsSha256: sha(REPLY), keys });
  const creationAuthorization = { wordsSha256: sha(CREATION), proposalSha256: sha('Synthetic creation proposal'), source: creationSource };
  return { dir, approval, reply, creationSource, creationAuthorization };
}
const BINDINGS = {
  'wordsSha256 of the reply (no words in the file)': { binding: { wordsSha256: sha(REPLY) }, ok: true },
  'wordsSha256 of the reply in upper case': { binding: { wordsSha256: sha(REPLY).toUpperCase() }, ok: true },
  'the literal reply (provisional)': { binding: { words: REPLY }, ok: true },
  'a wrong hash': { binding: { wordsSha256: sha('outras palavras, o 1') }, ok: false },
  'the hash of the creation words': { binding: { wordsSha256: sha(CREATION) }, ok: false },
  'the creation words': { binding: { words: CREATION }, ok: false },
  'the reply hash with other literal words': { binding: { wordsSha256: sha(REPLY), words: 'outras palavras' }, ok: false },
  'no words bound': { binding: {}, ok: false },
  'sha256 in words': { binding: { words: sha(REPLY) }, ok: false },
};
// run(w, binding) -> the approval, inside the validated reply of REPLY, with a file of that binding.
async function family(t, { key, run }) {
  for (const [label, { binding, ok }] of Object.entries(BINDINGS)) {
    const w = world(t);
    const call = () => withValidatedReply(w.reply([key]), () => run(w, binding));
    if (ok) assert.ok(await call(), label + ': accepted');
    else await assert.rejects(async () => call(), invalid, label + ': refused');
    if (label.startsWith('wordsSha256')) assert.deepEqual(filesWithMark([w.dir]), [], label + ': no file keeps the words');
  }
}

test('W-3 (a2a): the cleanup approval binds the reply by wordsSha256', async t => {
  const connectionId = uuid(), stage = uuid(), portfolio = uuid(), url = 'https://agent.example.test/card', card = { name: 'ZZAgent', skills: [] };
  const header = { ConnectionName: 'ZZAgent', PortfolioKey: portfolio, ConnectionDescription: '' };
  const connection = { connectionId, providerId: 'a2a', name: 'ZZAgent', portfolioKey: portfolio, description: '', externalMetadata: { selectedObjectCount: 0, selectedActionCount: 0 },
    stageConfigurations: [{ stageKey: stage, a2a: { configurationType: 'json', authType: 'no_auth', hasCredentialValues: false, agentCardSha256: fingerprint(card), agentUrlSha256: fingerprint(url) } }] };
  const originId = uuid();
  await family(t, { key: connectionId, run: (w, binding) => {
    const origin = { operationUuid: originId, state: 'confirmed', identity: { kind: 'odc-portal', tenant: HOST, operationId: A2A_TEST }, response: { Out_ConnectionId: connectionId },
      authorization: w.creationAuthorization, reconciliation: { a2aConnection: { planSha256: 'synthetic-plan', details: { ConnectionDetails_Header: header,
        ConnectionDetail_StageConfig: { List: [{ TenantStage: { Key: stage }, ConfigurationType: 'json', AgentCardJson: JSON.stringify(card), AgentUrl: url }] } } } } };
    const file = w.approval({ binding, scope: { lane: 'odc', host: HOST, operation: 'connections.delete', environmentKey: stage, targets: ['ZZAgent'] },
      constraints: { originOperationUuid: originId, connectionId, expectedStateSha256: fingerprint(connection), planSha256: 'synthetic-plan' } });
    return a2aDeleteApproval({ file, words: REPLY, host: HOST, origin, originOperationUuid: originId, connectionId, detail: { NotFound: false, Connection: connection },
      dependencies: { ok: true, name: 'ZZAgent', includesPublishingDefault: true, checkedEnvironments: [stage], consumers: [] } });
  } });
});

test('W-3 (custom search): the cleanup approval binds the reply by wordsSha256', async t => {
  const connectionId = uuid(), stage = uuid(), portfolio = uuid(), url = 'https://search.example.test';
  const c = { connectionId, providerId: 'customAISearch', name: 'ZZSearch', description: '', portfolioKey: portfolio, updatedOn: '2026-10-15T11:00:00Z',
    stageConfigurations: [{ stageKey: stage, customSearch: { endpointSha256: fingerprint(url) } }], externalMetadata: { selectedObjectCount: 0, selectedActionCount: 0 } };
  const originId = uuid();
  await family(t, { key: `${connectionId}/customAISearch`, run: async (w, binding) => {
    const origin = { operationUuid: originId, state: 'confirmed', createdAt: '2026-10-15T10:00:00Z', identity: { kind: 'odc-portal', tenant: HOST, operationId: CUSTOM_SEARCH_TEST },
      response: { Out_ConnectionId: connectionId }, authorization: w.creationAuthorization,
      reconciliation: { customSearchConnection: { stageKey: stage, planSha256: 'synthetic-plan', details: { ConnectionDetails_Header: { ConnectionName: 'ZZSearch', ConnectionDescription: '', PortfolioKey: portfolio },
        ConnectionDetail_StageConfig: { List: [{ TenantStage: { Key: stage }, EndpointURL: url }] } } } } };
    const file = w.approval({ binding, scope: { lane: 'odc', host: HOST, operation: 'connections.delete', environmentKey: stage, targets: ['ZZSearch'] },
      constraints: { originOperationUuid: originId, connectionId, planSha256: 'synthetic-plan', expectedStateSha256: fingerprint(c) } });
    return customSearchDeleteApproval({ file, words: REPLY, host: HOST, raw: { inputParameters: { ConnectionId: connectionId, ProviderId: 'customAISearch', ConsoleProviderId: '' }, screenVariables: {}, clientVariables: {} },
      lookup: id => (id === originId ? origin : null), read: async () => ({ ok: true, data: { NotFound: false, Connection: c } }),
      dependencies: async () => ({ ok: true, name: 'ZZSearch', includesPublishingDefault: true, checkedEnvironments: [stage], consumers: [] }) });
  } });
});

test('W-3 (external-library discard): the cleanup approval binds the reply by wordsSha256', async t => {
  const jobKey = uuid(), originId = uuid();
  await family(t, { key: jobKey, run: async (w, binding) => {
    const origin = { operationUuid: originId, state: 'confirmed', identity: { kind: 'odc-external-library', tenant: HOST, name: 'ZZLib', packageSha256: 'synthetic-package' },
      progress: { upload: { operationKey: jobKey }, package: { fileName: 'zzlib.zip' }, authorization: { context: { operation: EXTERNAL_LIBRARY_DEPLOY, host: HOST, targets: ['ZZLib'],
        constraints: { packageSha256: 'synthetic-package' }, wordsSha256: sha(CREATION), source: w.creationSource } } } };
    const file = w.approval({ binding, scope: { lane: 'odc', host: HOST, operation: EXTERNAL_LIBRARY_JOB_DELETE, targets: ['ZZLib'] }, constraints: { originOperationUuid: originId, jobKey } });
    return externalLibraryDiscardApproval({ file, words: REPLY, host: HOST, operationId: EXTERNAL_LIBRARY_JOB_DELETE, input: { path: { operationKey: jobKey } }, originOperationUuid: originId,
      lookup: id => (id === originId ? origin : null), readJob: async () => ({ ok: true, data: { key: jobKey, libraryName: 'ZZLib', filename: 'zzlib.zip', status: 'ReadyForReview' } }) });
  } });
});

test('W-3 (owned consumers): the cleanup approval binds the reply by wordsSha256', async t => {
  const assetKey = uuid(), consumer = uuid(), consumers = [{ key: consumer, name: 'ZZConsumer' }];
  const origins = { [assetKey]: uuid(), [consumer]: uuid() };
  await family(t, { key: assetKey, run: async (w, binding) => {
    const receipts = Object.fromEntries(Object.entries(origins).map(([key, id]) => [id, { state: 'confirmed', status: 201, identity: { tenant: HOST, operationId: 'asset-repository-api-v1:post:/assets' },
      response: { assetKey: key }, authorization: w.creationAuthorization }]));
    const file = w.approval({ binding, scope: { lane: 'odc', host: HOST, operation: 'asset-repository-api-v1:delete:/assets/{assetKey}', targets: ['ZZProducer', 'ZZConsumer'] },
      constraints: { allowOwnedConsumerBreakage: true, producerAssetKey: assetKey, consumerSetSha256: consumerSetHash(consumers), ownedAssetOrigins: origins } });
    return ownedConsumerDeletionApproval({ file, words: REPLY, host: HOST, assetKey, dependents: { name: 'ZZProducer', consumers }, lookup: id => receipts[id] ?? null });
  } });
});

test('W-3 (API Client fixture): the cleanup approval binds the reply by wordsSha256', async t => {
  const creationId = uuid(), key = uuid(), name = 'SSAMApiClientProof20261015';
  const proof = { key, name, operationUuid: creationId, vaultRef: 'urn:ssam:api-client:' + creationId, vaultStored: true, rawValueExposed: false, responseProjected: true };
  await family(t, { key, run: async (w, binding) => {
    const raw = rawInput({ inputParameters: { Key: key } });
    const origin = { operationUuid: creationId, state: 'confirmed', identity: { tenant: HOST, operationId: API_CLIENT_CREATE }, authorization: w.creationAuthorization,
      reconciliation: { apiClientFixture: { name } }, response: { ApiClientProof: proof } };
    const file = w.approval({ binding, scope: { lane: 'odc', host: HOST, operation: API_CLIENT_DELETE, targets: [name] },
      constraints: { creationOperationUuid: creationId, inputSha256: sha256(JSON.stringify(raw.inputParameters)) } });
    return apiClientFixtureApproval({ file, words: REPLY, host: HOST, operationId: API_CLIENT_DELETE, operationUuid: uuid(), raw, lookup: id => (id === creationId ? origin : null) });
  } });
});

test('W-3 (API Client pending header): the cleanup approval binds the reply by wordsSha256', async t => {
  const creationId = uuid(), key = uuid(), name = 'SSAMApiClientProof20261015';
  const old = { Key: uuid(), Name: 'Existing', IsActive: false, Permissions: { List: [] } }, header = { Key: key, Name: name, IsActive: false, Permissions: { List: [] }, CreatedAt: '1900-01-01T00:00:00' };
  const inventory = rows => ({ ok: true, tenant: HOST, rows, totalResults: rows.length, requestedOffset: 0, scope: { NameContains: '', Status: '' }, complete: true, requestedPageConsistencyVerified: true });
  await family(t, { key, run: async (w, binding) => {
    const baselineFile = path.join(w.dir, 'baseline.json'); fs.writeFileSync(baselineFile, JSON.stringify(inventory([old])));
    const raw = { inputParameters: { Key: key }, screenVariables: {}, clientVariables: {} };
    const origin = { schema: 'ssam-odc-write/1', operationUuid: creationId, state: 'uncertain', createdAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T10:00:03Z',
      identity: { tenant: HOST, operationId: API_CLIENT_CREATE, target: { apiClientFixtureName: name } }, authorization: w.creationAuthorization, reconciliation: { apiClientFixture: { name } }, response: {} };
    const file = w.approval({ binding, scope: { lane: 'odc', host: HOST, operation: API_CLIENT_DELETE, targets: [name] },
      constraints: { cleanupMode: 'pending-header', creationOperationUuid: creationId, baselineFile, baselineSha256: sha256(fs.readFileSync(baselineFile, 'utf8')), inputSha256: sha256(JSON.stringify(raw.inputParameters)) } });
    return apiClientWriteApproval({ file, words: REPLY, host: HOST, operationId: API_CLIENT_DELETE, operationUuid: uuid(), raw, lookup: id => (id === creationId ? origin : null),
      readInventory: async () => inventory([old, header]),
      readDetail: async () => ({ ok: true, tenant: HOST, data: { ApiClientDetails: { ...header, IsActive: true, CreatedAt: '2026-10-15T10:00:01Z', Permissions: { List: [] } } } }) });
  } });
});

test('W-3 (the texts): the own-fixture cleanup says to write only wordsSha256, never the words', () => {
  assert.match(OWNED_CLEANUP, /wordsSha256 is the sha256/);
  assert.match(OWNED_CLEANUP, /the file never keeps the words/);
  assert.doesNotMatch(OWNED_CLEANUP, /whose words are the owner's reply/);
  const tools = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'catalog', 'tools.json'), 'utf8'));
  const all = JSON.stringify(tools);
  assert.equal(all.includes("a NEW approval whose words are the owner's reply"), false, 'no catalog text asks for the words in the file');
  assert.ok(all.split('wordsSha256 is the sha256 (64 hex of the UTF-8 bytes)').length - 1 >= 4, 'the four catalog routes say wordsSha256');
});

test('W-3 (end to end): odc_asset_delete of an own library and its own consumer deletes with an approval file without the reply', async () => {
  const { r3OdcWorld, HOST: WORLD_HOST, LIB, files } = await import('./fixtures/r3-odc-world.mjs');
  const APP = '8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c51', ASSET_CREATE = 'asset-repository-api-v1:post:/assets', DELETE = 'asset-repository-api-v1:delete:/assets/{assetKey}';
  const CONSUMERS = [{ key: APP, name: 'ZZScratchApp', type: 'App', revision: 3 }];
  const w = await r3OdcWorld({ extraAssets: { [APP]: { assetKey: APP, name: 'ZZScratchApp', revision: 3, assetType: 'App' } }, consumers: { [LIB]: CONSUMERS } });
  try {
    const source = { kind: 'human-conversation', threadId: uuid(), messageId: uuid(), question: 'Synthetic: create the fixtures?' };
    const origins = { [LIB]: uuid(), [APP]: uuid() };
    const receipts = Object.fromEntries(Object.entries(origins).map(([key, id]) => [id, { operationUuid: id, state: 'confirmed', status: 201,
      identity: { kind: 'odc-public', tenant: WORLD_HOST, operationId: ASSET_CREATE, target: {} }, response: { assetKey: key },
      authorization: { wordsSha256: sha(CREATION), proposalSha256: sha('Synthetic fixtures'), source } }]));
    const lookup = w.access.receipts.lookup.bind(w.access.receipts);
    w.access.receipts.lookup = (id, ...rest) => receipts[String(id).toLowerCase()] ?? lookup(id, ...rest);
    const preview = await w.call('odc_asset_delete', { tenant: WORLD_HOST, assetKey: LIB });
    assert.equal(preview.items?.length, 1, JSON.stringify(preview).slice(0, 300));
    w.wait();
    const reply = 'sim, pode apagar o 1: ZZScratchLib, mesmo quebrando a ZZScratchApp ' + MARK;
    const approvals = path.join(w.dir, 'approvals'); fs.mkdirSync(approvals, { recursive: true });
    const file = path.join(approvals, 'cleanup.json');
    const proposal = previewFile(preview.previewId, { root: w.root });
    fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', wordsSha256: sha(reply), source: { ...source, messageId: uuid() },
      proposal: { file: proposal, sha256: sha(fs.readFileSync(proposal)) }, scope: [{ lane: 'odc', host: WORLD_HOST, operation: DELETE, targets: ['ZZScratchLib', 'ZZScratchApp'] }],
      constraints: { allowOwnedConsumerBreakage: true, producerAssetKey: LIB, consumerSetSha256: consumerSetHash(CONSUMERS), ownedAssetOrigins: origins } }));
    const before = w.writes.filter(x => x.method === 'DELETE').length;
    const done = await w.call('odc_asset_delete', { tenant: WORLD_HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: reply, authorizationContext: file });
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 400));
    assert.equal(w.writes.filter(x => x.method === 'DELETE').length - before, 1, 'one DELETE');
    assert.equal(JSON.stringify(done).includes(MARK), false, 'the answer has no reply');
    assert.deepEqual(files(w.dir).filter(f => fs.readFileSync(f).includes(Buffer.from(MARK))), [], 'no file (approval, receipts, records, backups) keeps the reply');
  } finally { await w.close(); }
});
