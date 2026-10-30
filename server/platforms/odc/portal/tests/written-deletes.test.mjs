// R2-I round 2: every delete of an own ODC fixture end to end, with the written words alone (no approval file): the real
// destructive guard over the real OdcAccess, a fake Portal transport and SSAM's own journal on disk. The preview lists
// what the owner must name; a reply that leaves a listed name out (or, where the guard lists none, the target the tool
// binds) is refused with WORDS_MUST_NAME and nothing is sent; the reply that names them all sends once.
import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID as uuid } from 'node:crypto';
import { OdcAccess } from '../runtime/access.mjs';
import { WriteJournal, fingerprint, sha256 } from '../runtime/write-journal.mjs';
import { guardedAccess } from '../runtime/destructive-preview.mjs';
import { CONFIRM_MIN_AGE_MS } from '../../facade/destructive-operations.mjs';
import { a2aConnectionPlan } from '../runtime/a2a-connection-plan.mjs';
import { customSearchConnectionPlan } from '../runtime/custom-search-connection-plan.mjs';

const HOST = 'personal-written.outsystems.dev';
const codeOf = r => r?.error?.code ?? r?.code;
const problemCodes = r => (r?.problems ?? []).map(p => p.code);
const missingOf = r => [...(r?.problems ?? []).flatMap(p => p.missing ?? []), ...(r?.error?.missing ?? [])];

function world(t, { portal = {}, publicReads = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-deletes-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, 'receipts'); fs.mkdirSync(receiptsDir, { recursive: true });
  const receipts = new WriteJournal(receiptsDir);
  const access = new OdcAccess({ receipts, tenants: { default: HOST, tenants: { [HOST]: { class: 'personal' } } } });
  const sends = [];
  const answer = (table, key, ...args) => { const v = table[key]; return typeof v === 'function' ? v(...args) : structuredClone(v ?? { ok: false, status: 404, data: null }); };
  access.portalRead = async ({ operationId, input }) => answer(portal, operationId, input, sends);
  access.read = async ({ operationId, path: p, query }) => answer(publicReads, operationId, p, query, sends);
  access.resolvePortal = async () => ({ ok: true, path: 'vault', host: HOST, broker: { callScreenservice: async request => { sends.push(request); return { data: {} }; } } });
  let now = Date.parse('2026-10-29T12:00:00.000Z');
  const guarded = guardedAccess(access, { now: () => now, root: path.join(dir, 'destructive') });
  const seed = receipt => fs.writeFileSync(path.join(receiptsDir, receipt.operationUuid + '.json'),
    JSON.stringify({ schema: 'ssam-odc-write/1', createdAt: '2026-10-29T10:00:00.000Z', ...receipt }));
  return { guarded, sends, seed, wait: () => { now += CONFIRM_MIN_AGE_MS + 1000; } };
}
// The two calls: a preview, then the reply with its token (an item list stays in the token, never in the execution call).
async function confirm(w, method, args, reply, preview) {
  preview ??= await w.guarded[method](args);
  assert.equal(preview.ok, true, JSON.stringify(preview).slice(0, 400));
  w.wait();
  const { objects, ...rest } = args;
  return { preview, result: await w.guarded[method]({ ...rest, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: reply }) };
}
// The unnamed reply sends nothing and is refused for the missing names; the named reply (on the same token when the guard
// refused, on a new preview when the tool did) sends once.
async function onlyNamedRepliesDelete(w, method, args, { unnamed, named, missing }) {
  const first = await confirm(w, method, args, unnamed);
  assert.equal(w.sends.length, 0, JSON.stringify(first.result).slice(0, 400));
  assert.ok(problemCodes(first.result).includes('WORDS_MUST_NAME') || codeOf(first.result) === 'WORDS_MUST_NAME', JSON.stringify(first.result).slice(0, 600));
  for (const name of missing) assert.ok(missingOf(first.result).includes(name), name + ' ' + JSON.stringify(first.result).slice(0, 600));
  // What the preview listed is checked by the guard itself, before anything reaches the tool (the token stays usable).
  if ((first.preview.mustName ?? []).length) assert.ok(problemCodes(first.result).includes('WORDS_MUST_NAME'), 'the guard names every listed item: ' + JSON.stringify(first.result).slice(0, 400));
  const again = problemCodes(first.result).includes('WORDS_MUST_NAME') ? first.preview : undefined;
  const second = await confirm(w, method, args, named, again);
  assert.equal(w.sends.length, 1, JSON.stringify(second.result).slice(0, 600));
  return second.result;
}
const assetReads = (assetKey, name, stageKey) => ({
  'asset-repository-api-v1:get:/assets/{assetKey}': p => (p?.assetKey === assetKey ? { ok: true, data: { assetKey, name } } : { ok: false, status: 404 }),
  'portfolio-api-v2:get:/environments': { ok: true, data: { results: [{ key: stageKey, name: 'Development' }] } },
  'dependency-management-api-v1:get:/assets/{assetKey}/consumers': { ok: true, data: { results: [] } } });

test('entity removal of an own temporary connection: the reply names the connection and every entity that leaves', async t => {
  const entity = { EntityId: 'entity', OriginalName: 'dbo.Test', Name: 'Test', IsSelected: true }, state = { selected: [entity] };
  const w = world(t, { portal: {
    'connections.detail': () => ({ ok: true, data: { NotFound: false, Connection: { connectionId: 'connection', name: 'Fixture', providerId: 'mssql', externalMetadata: { selectedObjectCount: state.selected.length, selectedActionCount: 0 },
      stageConfigurations: [{ stageKey: 'stage', host: 'db.test', port: 1433, database: 'Test', hasAdditionalParameters: false, privateGatewayPort: null }] } } }),
    'connections.connection': { ok: true, data: { ConnectionUpdateTimestamp: '2026-10-09T12:00:00' } },
    'connections.entities': { ok: true, data: { EntityList: { List: [entity] } } },
    'connections.entityAttributes': { ok: true, data: { AttributesList: { List: [{ AttributeId: 'id', OriginalName: 'Id', Name: 'Id', DataType: 'Integer', IsPrimaryKey: true }] } } },
    'connections.selectedEntities': () => ({ ok: true, data: { SelectedEntityList_Original: { List: state.selected } } }) } });
  const origin = uuid();
  w.seed({ operationUuid: origin, state: 'accepted', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.relationalTest', target: { connectionName: 'Fixture' } },
    response: { Out_ConnectionId: 'connection' }, authorization: { wordsSha256: sha256('Create the temporary connection Fixture') } });
  const args = { tenant: HOST, action: 'remove-entities', connectionId: 'connection', providerId: 'mssql', originOperationUuid: origin, objects: ['dbo.Test'] };
  await onlyNamedRepliesDelete(w, 'externalDbConnection', args, { unnamed: 'yes, remove the 1 from Fixture', named: 'yes, remove the 1: dbo.Test from Fixture', missing: ['dbo.Test'] });
  assert.equal(w.sends[0].operationId, 'connections.importEntities');
  assert.equal(w.sends[0].input.inputParameters.DatabaseObjects.Entities.List[0].IsSelected, false);
});

test('temporary connection delete: the reply names the own connection', async t => {

  const connectionId = uuid();
  const connection = { connectionId, name: 'Fixture', providerId: 'mssql', externalMetadata: { selectedObjectCount: 0, selectedActionCount: 0 },
    stageConfigurations: [{ stageKey: 'stage', host: 'db.test', port: 1433, database: 'Test', hasAdditionalParameters: false, privateGatewayPort: null }] };
  const w = world(t, { portal: { 'connections.detail': (input, sends) => ({ ok: true, data: sends.length ? { NotFound: true } : { NotFound: false, Connection: connection } }),
    'connections.list': { ok: true, rows: [], truncated: false } } });
  const origin = uuid();
  w.seed({ operationUuid: origin, state: 'accepted', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.relationalTest', target: { connectionName: 'Fixture' } },
    response: { Out_ConnectionId: connectionId }, authorization: { wordsSha256: sha256('Create the temporary connection Fixture') } });
  const args = { tenant: HOST, action: 'delete', connectionId, providerId: 'mssql', originOperationUuid: origin };
  await onlyNamedRepliesDelete(w, 'externalDbConnection', args, { unnamed: 'yes, delete the 1 connection', named: 'yes, delete the 1: Fixture', missing: ['Fixture'] });
  assert.equal(w.sends[0].operationId, 'connections.delete');
});

test('A2A connection delete: the reply names the own connection', async t => {
  const stage = { Key: uuid(), Name: 'Development', Purpose: 'Development' };
  const card = { protocolVersion: '0.3.0', name: 'Proof', description: 'Constant response', version: '1', url: 'https://example.test/rpc', capabilities: { streaming: false },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'proof', name: 'Proof', description: 'Constant', tags: ['test'] }] };
  const plan = a2aConnectionPlan({ name: 'OwnedA2A', agentUrl: 'https://example.test/agent/', portfolioKey: uuid(), stage, card });
  const header = plan.details.ConnectionDetails_Header, config = plan.details.ConnectionDetail_StageConfig.List[0], connectionId = uuid();
  const connection = { connectionId, providerId: 'a2a', name: 'OwnedA2A', portfolioKey: header.PortfolioKey, description: header.ConnectionDescription,
    externalMetadata: { selectedObjectCount: 0, selectedActionCount: 0 },
    stageConfigurations: [{ stageKey: plan.stageKey, a2a: { configurationType: 'json', authType: 'no_auth', hasCredentialValues: false, agentCardSha256: fingerprint(card), agentUrlSha256: fingerprint(config.AgentUrl) } }] };
  const w = world(t, { portal: { 'connections.detail': (input, sends) => ({ ok: true, data: sends.length ? { NotFound: true } : { NotFound: false, Connection: connection } }),
    'connections.list': { ok: true, rows: [], truncated: false } }, publicReads: assetReads(connectionId, 'OwnedA2A', plan.stageKey) });
  const origin = uuid();
  w.seed({ operationUuid: origin, state: 'accepted', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.a2aTest' }, response: { Out_ConnectionId: connectionId },
    reconciliation: { a2aConnection: { planSha256: plan.planSha256, details: plan.details, stageKey: plan.stageKey, name: 'OwnedA2A' } }, authorization: { wordsSha256: sha256('Create OwnedA2A') } });
  await onlyNamedRepliesDelete(w, 'a2aConnectionDelete', { tenant: HOST, connectionId, originOperationUuid: origin },
    { unnamed: 'yes, delete the 1 connection', named: 'yes, delete the 1: OwnedA2A', missing: ['OwnedA2A'] });
  assert.equal(w.sends[0].operationId, 'connections.delete');
});

test('custom search connection delete: the reply names the own connection', async t => {
  const plan = customSearchConnectionPlan({ name: 'OwnedSearch', description: 'Synthetic only', portfolioKey: uuid(), stage: { Key: uuid(), Name: 'Development', Purpose: 'Development' },
    endpointURL: 'https://example-dev.outsystems.app/OwnService/rest/Search/CustomAISearch' });
  const header = plan.details.ConnectionDetails_Header, config = plan.details.ConnectionDetail_StageConfig.List[0], connectionId = uuid();
  const connection = { connectionId, providerId: 'customAISearch', name: 'OwnedSearch', description: header.ConnectionDescription, portfolioKey: header.PortfolioKey,
    externalMetadata: { selectedObjectCount: 0, selectedActionCount: 0 }, stageConfigurations: [{ stageKey: plan.stageKey, customSearch: { endpointSha256: fingerprint(config.EndpointURL) } }] };
  const w = world(t, { portal: { 'connections.detail': (input, sends) => ({ ok: true, data: sends.length ? { NotFound: true } : { NotFound: false, Connection: connection } }),
    'connections.list': { ok: true, rows: [], truncated: false } }, publicReads: assetReads(connectionId, 'OwnedSearch', plan.stageKey) });
  w.seed({ operationUuid: uuid(), state: 'accepted', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.customSearchTest' }, response: { Out_ConnectionId: connectionId },
    reconciliation: { customSearchConnection: { planSha256: plan.planSha256, details: plan.details, stageKey: plan.stageKey } }, authorization: { wordsSha256: sha256('Create OwnedSearch') } });
  const args = { tenant: HOST, operationId: 'connections.delete', input: { inputParameters: { ConnectionId: connectionId, ProviderId: 'customAISearch', ConsoleProviderId: '' } } };
  await onlyNamedRepliesDelete(w, 'portalWrite', args, { unnamed: 'yes, delete the 1 connection', named: 'yes, delete the 1: OwnedSearch', missing: ['OwnedSearch'] });
});

test('API Client fixture delete: the reply names the own API Client', async t => {
  const key = uuid(), creation = uuid(), name = 'SSAMApiClientProof20261029';
  const w = world(t, { portal: { 'apiClients.detail': { ok: true, data: { ApiClientDetails: { Key: key, Name: name } } },
    'apiClients.list': { ok: true, complete: true, requestedPageConsistencyVerified: true, requestedOffset: 0, scope: { NameContains: '', Status: '' }, rows: [], totalResults: 0 } } });
  w.seed({ operationUuid: creation, state: 'accepted', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'apiClients.create', target: { apiClientFixtureName: name } },
    reconciliation: { apiClientFixture: { name, creationOperationUuid: creation } }, authorization: { wordsSha256: sha256('Create ' + name), source: { kind: 'human-words' } },
    response: { ApiClientProof: { key, name, operationUuid: creation, vaultRef: 'urn:ssam:api-client:' + creation, vaultStored: true, rawValueExposed: false, responseProjected: true } } });
  await onlyNamedRepliesDelete(w, 'portalWrite', { tenant: HOST, operationId: 'apiClients.delete', input: { inputParameters: { Key: key }, screenVariables: {}, clientVariables: {} } },
    { unnamed: 'yes, delete the 1 client', named: 'yes, delete the 1: ' + name, missing: [name] });
});

test('knowledge base delete: the reply names the own base', async t => {
  const key = uuid(), found = { KnowledgeBaseId: key, Name: 'OwnedKB', Status: 'Ready' };
  const w = world(t, { portal: { 'knowledgeBases.list': { ok: true, data: { KBListItems: { List: [found] }, TotalCount: '1' } },
    'knowledgeBases.consumers': { ok: true, data: { ApplicationConsumers: { List: [] } } } } });
  w.seed({ operationUuid: uuid(), state: 'confirmed', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'knowledgeBases.create' }, response: { KnowledgeBaseId: key },
    reconciliation: { knowledgeBase: { name: 'OwnedKB' } }, authorization: { wordsSha256: sha256('Create OwnedKB') } });
  await onlyNamedRepliesDelete(w, 'portalWrite', { tenant: HOST, operationId: 'knowledgeBases.delete', input: { inputParameters: { KnowledgeBaseId: key } } },
    { unnamed: 'yes, delete the 1 base', named: 'yes, delete the 1: OwnedKB', missing: ['OwnedKB'] });
});

test('dataset delete: the reply names the own dataset', async t => {
  const id = uuid(), dataset = { DatasetId: id, Name: 'OwnDataset', Description: 'original' };
  const w = world(t, { portal: { 'agents.dataset': { ok: true, data: { NotFound: false, Dataset: dataset } },
    'agents.datasetEvaluations': { ok: true, data: {}, dependencyState: { verified: true, datasetId: id, hasConnectedEvaluations: false } } } });
  w.seed({ operationUuid: uuid(), state: 'accepted', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'agents.datasetCreate' }, response: { DatasetId: id },
    authorization: { wordsSha256: sha256('Create OwnDataset') } });
  await onlyNamedRepliesDelete(w, 'portalWrite', { tenant: HOST, operationId: 'agents.datasetDelete', input: { inputParameters: { DatasetId: id } } },
    { unnamed: 'yes, delete the 1 dataset', named: 'yes, delete the 1: OwnDataset', missing: ['OwnDataset'] });
});

test('trial model delete: the guard lists no name, so the tool refuses a reply without the model and sends nothing', async t => {
  const portfolioKey = uuid(), model = { Id: uuid(), Name: 'OwnTrial', PortfolioKey: portfolioKey, IsTrial: true };
  const w = world(t, { portal: { 'aiModels.list': { ok: true, data: { AIModelList: { List: [model] }, TotalCount: '1' } },
    'aiModels.detail': { ok: true, data: { NotFound: false, AIModel: { Id: model.Id, AssetKey: model.Id, PortfolioKey: portfolioKey, Name: 'OwnTrial', IsTrial: true } } } } });
  w.seed({ operationUuid: uuid(), state: 'confirmed', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'aiModels.trialCreate' }, response: { AIModelId: model.Id },
    reconciliation: { aiModelTrial: { portfolioKey, trialId: 'trial-x' } }, authorization: { wordsSha256: sha256('Create the trial'), source: { kind: 'human-words' } } });
  await onlyNamedRepliesDelete(w, 'portalWrite', { tenant: HOST, operationId: 'aiModels.trialDelete', input: { inputParameters: { AIModelId: model.Id }, screenVariables: {}, clientVariables: {} } },
    { unnamed: 'yes, delete the 1 model', named: 'yes, delete the 1: OwnTrial', missing: ['OwnTrial'] });
});

test('evaluation delete: the guard lists no name, so the tool refuses a reply without the evaluation and sends nothing', async t => {
  const evaluationId = uuid(), portfolioKey = uuid(), datasetId = uuid(), dataset = { DatasetId: datasetId, Name: 'OwnDataset' }, judge = uuid();
  const expected = { name: 'OwnEvaluation', description: 'Fixture', datasetId, portfolioKey, judgeIds: [judge], datasetSha256: sha256(JSON.stringify(dataset)) };
  const evaluation = { EvalId: evaluationId, Name: 'OwnEvaluation', Description: 'Fixture', DatasetId: datasetId, PortfolioKey: portfolioKey, LastRunAt: '1900-01-01T00:00:00', Judges: { List: [{ Id: judge }] } };
  const w = world(t, { portal: { 'agents.evaluation': { ok: true, data: { NotFound: false, Evaluation: evaluation, Dataset: { DatasetId: datasetId } } },
    'agents.dataset': { ok: true, data: { NotFound: false, Dataset: dataset } }, 'agents.evaluationOngoingRun': { ok: true, data: { OngoingRun: { IsRunning: false } } } } });
  w.seed({ operationUuid: uuid(), state: 'confirmed', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'agents.evaluationCreate' }, response: { EvalId: evaluationId },
    reconciliation: { evaluation: expected }, authorization: { wordsSha256: sha256('Create OwnEvaluation') } });
  await onlyNamedRepliesDelete(w, 'portalWrite', { tenant: HOST, operationId: 'agents.evaluationDelete', input: { inputParameters: { EvaluationId: evaluationId } } },
    { unnamed: 'yes, delete the 1 evaluation', named: 'yes, delete the 1: OwnEvaluation', missing: ['OwnEvaluation'] });
});

// R2-I round 3: the guard and the tool name by one predicate: every listed name by its own whole-word occurrence, the
// longest first (a name inside a longer listed name does not count), and by its name (not its key).
test('a listed name inside a longer listed name is not named by it; the reply names each one', async t => {
  const names = ['dbo.Orders', 'dbo.Order', 'dbo.Order Lines', 'Vendas.Ação'];
  const entities = names.map((name, i) => ({ EntityId: 'e' + i, OriginalName: name, Name: name, IsSelected: true })), state = { selected: [...entities] };
  const w = world(t, { portal: {
    'connections.detail': () => ({ ok: true, data: { NotFound: false, Connection: { connectionId: 'connection', name: 'Fixture', providerId: 'mssql', externalMetadata: { selectedObjectCount: state.selected.length, selectedActionCount: 0 },
      stageConfigurations: [{ stageKey: 'stage', host: 'db.test', port: 1433, database: 'Test', hasAdditionalParameters: false, privateGatewayPort: null }] } } }),
    'connections.connection': { ok: true, data: { ConnectionUpdateTimestamp: '2026-10-09T12:00:00' } },
    'connections.entities': { ok: true, data: { EntityList: { List: entities } } },
    'connections.entityAttributes': { ok: true, data: { AttributesList: { List: [{ AttributeId: 'id', OriginalName: 'Id', Name: 'Id', DataType: 'Integer', IsPrimaryKey: true }] } } },
    'connections.selectedEntities': () => ({ ok: true, data: { SelectedEntityList_Original: { List: state.selected } } }) } });
  const origin = uuid();
  w.seed({ operationUuid: origin, state: 'accepted', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.relationalTest', target: { connectionName: 'Fixture' } },
    response: { Out_ConnectionId: 'connection' }, authorization: { wordsSha256: sha256('Create the temporary connection Fixture') } });
  const args = { tenant: HOST, action: 'remove-entities', connectionId: 'connection', providerId: 'mssql', originOperationUuid: origin, objects: names };
  await onlyNamedRepliesDelete(w, 'externalDbConnection', args, { unnamed: 'yes, remove the 4 from Fixture: dbo.Orders, dbo.Order Lines, Vendas.Ação',
    named: 'yes, remove the 4 from Fixture: dbo.Orders, dbo.Order, dbo.Order Lines, Vendas.Acao', missing: ['dbo.Order'] });
});

test('a reply that gives the key of a listed item for its name is refused by the guard, and the token stays usable for the name', async t => {
  const connectionId = uuid();
  const connection = { connectionId, name: 'Fixture', providerId: 'mssql', externalMetadata: { selectedObjectCount: 0, selectedActionCount: 0 },
    stageConfigurations: [{ stageKey: 'stage', host: 'db.test', port: 1433, database: 'Test', hasAdditionalParameters: false, privateGatewayPort: null }] };
  const w = world(t, { portal: { 'connections.detail': (input, sends) => ({ ok: true, data: sends.length ? { NotFound: true } : { NotFound: false, Connection: connection } }),
    'connections.list': { ok: true, rows: [], truncated: false } } });
  const origin = uuid();
  w.seed({ operationUuid: origin, state: 'accepted', identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.relationalTest', target: { connectionName: 'Fixture' } },
    response: { Out_ConnectionId: connectionId }, authorization: { wordsSha256: sha256('Create the temporary connection Fixture') } });
  const args = { tenant: HOST, action: 'delete', connectionId, providerId: 'mssql', originOperationUuid: origin };
  const first = await confirm(w, 'externalDbConnection', args, 'yes, delete the 1: ' + connectionId);
  assert.ok(problemCodes(first.result).includes('WORDS_MUST_NAME'), JSON.stringify(first.result).slice(0, 400)); assert.equal(w.sends.length, 0);
  const second = await confirm(w, 'externalDbConnection', args, 'yes, delete the 1: Fixture', first.preview);
  assert.equal(w.sends.length, 1, JSON.stringify(second.result).slice(0, 400));
});
