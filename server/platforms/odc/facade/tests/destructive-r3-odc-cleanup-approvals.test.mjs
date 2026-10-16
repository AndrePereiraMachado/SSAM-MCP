import './fixtures/isolated-profile.mjs';
// CX15 r3, N3 (F4.2): the six approvals of own-fixture cleanups (a2a, custom search, external-library discard, owned
// consumers, API Client fixture, API Client pending header) through the ONE helper (owned-cleanup-approval.mjs). Inside
// the guard's validated execution (withValidatedReply: what destructive-preview.mjs sets right before it calls the
// access) each accepts a NEW approval whose words are the validated reply and whose proposal is the preview file, bound to
// the creation receipt of THIS target, without the creation's words or message. Refused, in that context: an origin of
// another target, a proposal that is not the preview, words that are not the validated reply. Outside the context the
// same new approval is refused (the creation-bound rule of each approval is unchanged). Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { withValidatedReply } from '../../portal/runtime/owned-cleanup-approval.mjs';
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

const HOST = 'personal-r3cleanup.outsystems.dev';
const uuid = () => crypto.randomUUID();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const CREATION = 'sim, pode criar as fixtures sinteticas';
const REPLY = 'confirmo o 1, pode limpar a fixture sintetica';
const invalid = { code: 'AUTHORIZATION_CONTEXT_INVALID' };

// A temporary folder with the preview the owner was shown, the creation's proposal and an approval writer.
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r3-cleanup-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previewId = uuid(), operationId = uuid();
  const preview = path.join(dir, 'previews', previewId + '.json'); fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, JSON.stringify({ previewId, operationId, items: [{ name: 'synthetic' }] }));
  const creationProposal = path.join(dir, 'creation.md'); fs.writeFileSync(creationProposal, 'Synthetic creation proposal');
  const creationSource = { kind: 'human-conversation', threadId: uuid(), messageId: uuid(), question: 'Create the synthetic fixture?' };
  const approval = ({ words = REPLY, proposal = preview, scope, constraints, source = { ...creationSource, messageId: uuid() } }) => {
    const file = path.join(dir, 'approval-' + uuid() + '.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', words, source, proposal: { file: proposal, sha256: sha(fs.readFileSync(proposal)) },
      scope: [scope], ...(constraints ? { constraints } : {}) }));
    return file;
  };
  const replyOf = (keys, words = REPLY) => ({ host: HOST, tool: 'synthetic', previewId, operationId, previewFile: preview, wordsSha256: sha(words), keys });
  const creationAuthorization = { wordsSha256: sha(CREATION), proposalSha256: sha(fs.readFileSync(creationProposal)), source: creationSource };
  return { dir, preview, creationProposal, creationSource, creationAuthorization, approval, replyOf };
}
// Every approval: inside the validated reply it passes; outside, the same new approval is refused; inside, an origin of
// another target, the creation's proposal instead of the preview, and words that are not the reply are refused.
async function family(t, { run, key, foreign }) {
  const w = world(t);
  const ok = await withValidatedReply(w.replyOf([key]), () => run(w, {}));
  assert.ok(ok, 'the new approval of the validated reply passes');
  await assert.rejects(async () => run(w, {}), invalid, 'outside the guard, the creation-bound rule refuses it');
  await assert.rejects(async () => withValidatedReply(w.replyOf([key]), () => run(w, { origin: foreign })), invalid, 'an origin of another target');
  await assert.rejects(async () => withValidatedReply(w.replyOf([key]), () => run(w, { proposal: w.creationProposal })), invalid, 'a proposal that is not the preview');
  await assert.rejects(async () => withValidatedReply(w.replyOf([key], 'outras palavras, o 1'), () => run(w, {})), invalid, 'words that are not the validated reply');
  await assert.rejects(async () => withValidatedReply(w.replyOf([uuid()]), () => run(w, {})), invalid, 'a target the preview did not list');
}

test('N3 (a2a): the A2A cleanup after the preview', async t => {
  const connectionId = uuid(), stage = uuid(), portfolio = uuid(), url = 'https://agent.example.test/card', card = { name: 'ZZAgent', skills: [] };
  const header = { ConnectionName: 'ZZAgent', PortfolioKey: portfolio, ConnectionDescription: '' };
  const connection = { connectionId, providerId: 'a2a', name: 'ZZAgent', portfolioKey: portfolio, description: '', externalMetadata: { selectedObjectCount: 0, selectedActionCount: 0 },
    stageConfigurations: [{ stageKey: stage, a2a: { configurationType: 'json', authType: 'no_auth', hasCredentialValues: false, agentCardSha256: fingerprint(card), agentUrlSha256: fingerprint(url) } }] };
  const originId = uuid();
  await family(t, { key: connectionId,
    foreign: { response: { Out_ConnectionId: uuid() } },
    run: (w, { origin = {}, proposal }) => {
      const base = { operationUuid: originId, state: 'confirmed', identity: { kind: 'odc-portal', tenant: HOST, operationId: A2A_TEST }, response: { Out_ConnectionId: connectionId },
        authorization: w.creationAuthorization, reconciliation: { a2aConnection: { planSha256: 'synthetic-plan', details: { ConnectionDetails_Header: header,
          ConnectionDetail_StageConfig: { List: [{ TenantStage: { Key: stage }, ConfigurationType: 'json', AgentCardJson: JSON.stringify(card), AgentUrl: url }] } } } } };
      const scope = { lane: 'odc', host: HOST, operation: 'connections.delete', environmentKey: stage, targets: ['ZZAgent'] };
      const file = w.approval({ proposal, scope, constraints: { originOperationUuid: originId, connectionId, expectedStateSha256: fingerprint(connection), planSha256: 'synthetic-plan' } });
      const words = fs.readFileSync(file, 'utf8') && JSON.parse(fs.readFileSync(file, 'utf8')).words;
      return a2aDeleteApproval({ file, words, host: HOST, origin: { ...base, ...origin }, originOperationUuid: originId, connectionId, detail: { NotFound: false, Connection: connection },
        dependencies: { ok: true, name: 'ZZAgent', includesPublishingDefault: true, checkedEnvironments: [stage], consumers: [] } });
    } });
});

test('N3 (custom search): the custom search cleanup after the preview (the preview key is ConnectionId/ProviderId)', async t => {
  const connectionId = uuid(), stage = uuid(), portfolio = uuid(), url = 'https://search.example.test';
  const c = { connectionId, providerId: 'customAISearch', name: 'ZZSearch', description: '', portfolioKey: portfolio, updatedOn: '2026-10-15T11:00:00Z',
    stageConfigurations: [{ stageKey: stage, customSearch: { endpointSha256: fingerprint(url) } }], externalMetadata: { selectedObjectCount: 0, selectedActionCount: 0 } };
  const originId = uuid();
  const w0 = { key: `${connectionId}/customAISearch` };
  await family(t, { key: w0.key,
    foreign: { response: { Out_ConnectionId: uuid() } },
    run: async (w, { origin = {}, proposal }) => {
      const base = { operationUuid: originId, state: 'confirmed', createdAt: '2026-10-15T10:00:00Z', identity: { kind: 'odc-portal', tenant: HOST, operationId: CUSTOM_SEARCH_TEST },
        response: { Out_ConnectionId: connectionId }, authorization: w.creationAuthorization,
        reconciliation: { customSearchConnection: { stageKey: stage, planSha256: 'synthetic-plan', details: { ConnectionDetails_Header: { ConnectionName: 'ZZSearch', ConnectionDescription: '', PortfolioKey: portfolio },
          ConnectionDetail_StageConfig: { List: [{ TenantStage: { Key: stage }, EndpointURL: url }] } } } } };
      const file = w.approval({ proposal, scope: { lane: 'odc', host: HOST, operation: 'connections.delete', environmentKey: stage, targets: ['ZZSearch'] },
        constraints: { originOperationUuid: originId, connectionId, planSha256: 'synthetic-plan', expectedStateSha256: fingerprint(c) } });
      const words = JSON.parse(fs.readFileSync(file, 'utf8')).words;
      return customSearchDeleteApproval({ file, words, host: HOST, raw: { inputParameters: { ConnectionId: connectionId, ProviderId: 'customAISearch', ConsoleProviderId: '' }, screenVariables: {}, clientVariables: {} },
        lookup: id => (id === originId ? { ...base, ...origin } : null), read: async () => ({ ok: true, data: { NotFound: false, Connection: c } }),
        dependencies: async () => ({ ok: true, name: 'ZZSearch', includesPublishingDefault: true, checkedEnvironments: [stage], consumers: [] }) });
    } });
});

test('N3 (external-library discard): the discard of an own job after the preview', async t => {
  const jobKey = uuid(), originId = uuid();
  await family(t, { key: jobKey,
    foreign: { progress: { upload: { operationKey: uuid() } } },
    run: async (w, { origin = {}, proposal }) => {
      const base = { operationUuid: originId, state: 'confirmed', identity: { kind: 'odc-external-library', tenant: HOST, name: 'ZZLib', packageSha256: 'synthetic-package' },
        progress: { upload: { operationKey: jobKey }, package: { fileName: 'zzlib.zip' }, authorization: { context: { operation: EXTERNAL_LIBRARY_DEPLOY, host: HOST, targets: ['ZZLib'],
          constraints: { packageSha256: 'synthetic-package' }, wordsSha256: sha(CREATION), source: w.creationSource } } } };
      const merged = { ...base, ...origin, progress: { ...base.progress, ...(origin.progress ?? {}) } };
      const file = w.approval({ proposal, scope: { lane: 'odc', host: HOST, operation: EXTERNAL_LIBRARY_JOB_DELETE, targets: ['ZZLib'] }, constraints: { originOperationUuid: originId, jobKey } });
      const words = JSON.parse(fs.readFileSync(file, 'utf8')).words;
      return externalLibraryDiscardApproval({ file, words, host: HOST, operationId: EXTERNAL_LIBRARY_JOB_DELETE, input: { path: { operationKey: jobKey } }, originOperationUuid: originId,
        lookup: id => (id === originId ? merged : null), readJob: async () => ({ ok: true, data: { key: jobKey, libraryName: 'ZZLib', filename: 'zzlib.zip', status: 'ReadyForReview' } }) });
    } });
});

test('N3 (owned consumers): the delete of an asset and its own consumer after the preview', async t => {
  const assetKey = uuid(), consumer = uuid(), consumers = [{ key: consumer, name: 'ZZConsumer' }];
  const origins = { [assetKey]: uuid(), [consumer]: uuid() };
  await family(t, { key: assetKey,
    foreign: { response: { assetKey: uuid() } },
    run: async (w, { origin = {}, proposal }) => {
      const receipts = Object.fromEntries(Object.entries(origins).map(([key, id]) => [id, { state: 'confirmed', status: 201, identity: { tenant: HOST, operationId: 'asset-repository-api-v1:post:/assets' },
        response: { assetKey: key }, authorization: w.creationAuthorization, ...(key === assetKey ? origin : {}) }]));
      const file = w.approval({ proposal, scope: { lane: 'odc', host: HOST, operation: 'asset-repository-api-v1:delete:/assets/{assetKey}', targets: ['ZZProducer', 'ZZConsumer'] },
        constraints: { allowOwnedConsumerBreakage: true, producerAssetKey: assetKey, consumerSetSha256: consumerSetHash(consumers), ownedAssetOrigins: origins } });
      const words = JSON.parse(fs.readFileSync(file, 'utf8')).words;
      return ownedConsumerDeletionApproval({ file, words, host: HOST, assetKey, dependents: { name: 'ZZProducer', consumers }, lookup: id => receipts[id] ?? null });
    } });
});

test('N3 (API Client fixture): the delete bound to creationOperationUuid after the preview', async t => {
  const creationId = uuid(), key = uuid(), name = 'SSAMApiClientProof20261015';
  const proof = { key, name, operationUuid: creationId, vaultRef: 'urn:ssam:api-client:' + creationId, vaultStored: true, rawValueExposed: false, responseProjected: true };
  await family(t, { key,
    foreign: { response: { ApiClientProof: { ...proof, key: uuid() } } },
    run: async (w, { origin = {}, proposal }) => {
      const raw = rawInput({ inputParameters: { Key: key } });
      const base = { operationUuid: creationId, state: 'confirmed', identity: { tenant: HOST, operationId: API_CLIENT_CREATE }, authorization: w.creationAuthorization,
        reconciliation: { apiClientFixture: { name } }, response: { ApiClientProof: proof } };
      const file = w.approval({ proposal, scope: { lane: 'odc', host: HOST, operation: API_CLIENT_DELETE, targets: [name] },
        constraints: { creationOperationUuid: creationId, inputSha256: sha256(JSON.stringify(raw.inputParameters)) } });
      const words = JSON.parse(fs.readFileSync(file, 'utf8')).words;
      return apiClientFixtureApproval({ file, words, host: HOST, operationId: API_CLIENT_DELETE, operationUuid: uuid(), raw, lookup: id => (id === creationId ? { ...base, ...origin } : null) });
    } });
});

test('N3 (API Client pending header): the cleanup of a partial creation after the preview', async t => {
  const creationId = uuid(), key = uuid(), name = 'SSAMApiClientProof20261015';
  const old = { Key: uuid(), Name: 'Existing', IsActive: false, Permissions: { List: [] } }, header = { Key: key, Name: name, IsActive: false, Permissions: { List: [] }, CreatedAt: '1900-01-01T00:00:00' };
  const inventory = rows => ({ ok: true, tenant: HOST, rows, totalResults: rows.length, requestedOffset: 0, scope: { NameContains: '', Status: '' }, complete: true, requestedPageConsistencyVerified: true });
  await family(t, { key,
    foreign: { identity: { tenant: HOST, operationId: API_CLIENT_CREATE, target: { apiClientFixtureName: 'SSAMApiClientProof20261099' } } },
    run: async (w, { origin = {}, proposal }) => {
      const baselineFile = path.join(w.dir, 'baseline.json'); fs.writeFileSync(baselineFile, JSON.stringify(inventory([old])));
      const raw = { inputParameters: { Key: key }, screenVariables: {}, clientVariables: {} };
      const base = { schema: 'ssam-odc-write/1', operationUuid: creationId, state: 'uncertain', createdAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T10:00:03Z',
        identity: { tenant: HOST, operationId: API_CLIENT_CREATE, target: { apiClientFixtureName: name } }, authorization: w.creationAuthorization, reconciliation: { apiClientFixture: { name } }, response: {} };
      const file = w.approval({ proposal, scope: { lane: 'odc', host: HOST, operation: API_CLIENT_DELETE, targets: [name] },
        constraints: { cleanupMode: 'pending-header', creationOperationUuid: creationId, baselineFile, baselineSha256: sha256(fs.readFileSync(baselineFile, 'utf8')), inputSha256: sha256(JSON.stringify(raw.inputParameters)) } });
      const words = JSON.parse(fs.readFileSync(file, 'utf8')).words;
      return apiClientWriteApproval({ file, words, host: HOST, operationId: API_CLIENT_DELETE, operationUuid: uuid(), raw, lookup: id => (id === creationId ? { ...base, ...origin } : null),
        readInventory: async () => inventory([old, header]),
        readDetail: async () => ({ ok: true, tenant: HOST, data: { ApiClientDetails: { ...header, IsActive: true, CreatedAt: '2026-10-15T10:00:01Z', Permissions: { List: [] } } } }) });
    } });
});

test('N3 (discard continuations): the step that discards an open job is its preview, never a call with a placeholder for the owner\'s words or a new operationUuid', async () => {
  const { ExternalLibraryDeployer } = await import('../../portal/runtime/external-library.mjs');
  const step = ExternalLibraryDeployer.prototype.discardStep.call(null, HOST, 'ZZLib', 'job-1', 'then the same deploy again');
  assert.deepEqual(step.arguments, { action: 'discard', tenant: HOST, jobKey: 'job-1' });
  assert.match(step.why, /preview/);
  assert.ok(!/authorize|<|new uuid/.test(JSON.stringify(step.arguments)));
});
