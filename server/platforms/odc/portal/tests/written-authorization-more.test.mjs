// R2-I round 2: the rest of the family of the written authorization (owner's rule, 28/10): a library setting of an own mobile
// fixture, the release revision as a whole word, one origin per journal search, the place a write lands in named in the
// words, and the paths that had no regression with the written words alone (knowledge-base file upload through the real
// access, Base64 conversion and its save, the mobile-extensibility gate of odc_configurations).
import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID as uuid } from 'node:crypto';
import { mobileBinaryUploadApproval, MOBILE_FILE_UPLOAD, MOBILE_FILE_CONVERT } from '../runtime/mobile-binary-upload.mjs';
import { mobileBinarySaveApproval } from '../runtime/mobile-binary-save.mjs';
import { libraryReleaseApproval } from '../runtime/library-release-approval.mjs';
import { a2aConnectionPlan } from '../runtime/a2a-connection-plan.mjs';
import { a2aConnectionApproval, A2A_TEST } from '../runtime/a2a-connection-approval.mjs';
import { aiModelTrialApproval, AI_TRIAL_CREATE } from '../runtime/ai-model-trial.mjs';
import { knowledgeFileUploadPlan } from '../runtime/knowledge-file-plan.mjs';
import { KB_UPLOAD } from '../runtime/knowledge-file-upload.mjs';
import { OdcAccess } from '../runtime/access.mjs';
import { WriteJournal, sha256, fingerprint } from '../runtime/write-journal.mjs';

const host = 'example.outsystems.dev';
const journal = (...receipts) => ({ lookup: key => receipts.find(r => r.operationUuid === key) ?? null, find: predicate => receipts.filter(r => predicate(r)) });
const missing = code => e => e.code === code;
const written = approval => assert.deepEqual(approval.source, { kind: 'human-words' });
const created = assetKey => ({ operationUuid: uuid(), state: 'confirmed', identity: { tenant: host, operationId: 'asset-repository-api-v1:post:/assets' }, response: { assetKey },
  authorization: { wordsSha256: sha256('Create the asset') } });
function mobile() {
  const applicationKey = uuid(), environmentKey = uuid(), settingKey = uuid(), portfolioKey = uuid(), libraryKey = uuid();
  const current = { settings: [{ key: settingKey, name: 'File', dataType: 'BinaryUrl', isSecret: false, value: null, defaultValue: null, valueOrigin: 'Default' }], libraries: [] };
  const origin = created(applicationKey), library = created(libraryKey);
  const read = async (op, p) => ({ ok: true, data: op.startsWith('asset-') ? (p?.assetKey === libraryKey ? { assetKey: libraryKey, name: 'FixtureLib', assetType: 'MobileLibrary', portfolioKey }
    : { assetKey: applicationKey, name: 'Fixture', assetType: 'MobileApplication', portfolioKey }) : current });
  const stages = flag => async () => ({ ok: true, data: { EnableNAOSBASE64Patch: flag, EnvironmentsApplicationVersion: { List: [{ Environment: { Key: environmentKey, PortfolioKey: portfolioKey, Status: 'Ready' } }] } } });
  const native = (fromLibrary = false) => ({ Setting: { Key: settingKey, Name: 'File', DataType: 'BinaryUrl', DataTypeLabel: 'Binary data', DefaultValue: '', Value: '', ValueOrigin: 'Default', IsSecret: '[REDACTED]',
    IsMandatory: false, Metadata: { Name: '', Filetype: '' } }, IsFromLibrary: fromLibrary, LibraryInfo: fromLibrary ? { Key: libraryKey, Revision: 1, Name: 'FixtureLib' } : { Key: '', Revision: 0, Name: '' } });
  const saveInput = info => { const changed = structuredClone(info); Object.assign(changed.Setting, { ValueOrigin: 'Override', IsSecret: false, Metadata: { Name: 'proof', Filetype: 'txt' } });
    return { inputParameters: { ApplicationKey: applicationKey, EnvironmentKey: environmentKey, RequiresDecoding: false, ExtensibilitySettingInfo: changed }, screenVariables: {}, clientVariables: {} }; };
  const uploaded = (expected, operationId, base64 = false) => { const operationUuid = uuid();
    return { operationUuid, state: 'confirmed', identity: { tenant: host, operationId }, authorization: { wordsSha256: sha256('upload ' + operationUuid) }, reconciliation: { mobileBinaryUpload: expected },
      response: { mobileUploadProof: { ...(base64 ? { transportMode: 'base64', objectUri: 'urn:ssam:mobile-base64:' + operationUuid }
        : { objectUri: 'https://plat-te3423068adb743c3b12fff7faf2a4b9e.s3.us-east-1.amazonaws.com/tenants/uploads/' + uuid() }),
        uploadOperationUuid: operationUuid, contentSha256: expected.contentSha256, byteLength: expected.byteLength, contentVerified: true, signedUriExposed: false } } }; };
  return { applicationKey, environmentKey, settingKey, portfolioKey, libraryKey, current, origin, library, read, stages, native, saveInput, uploaded,
    scope: { applicationKey, environmentKey, settingKey, portfolioKey } };
}

test('a binary setting of an own mobile library takes the written words naming app, library and setting; both creations recorded by SSAM, no file', async () => {
  const m = mobile();
  m.current.settings = []; m.current.libraries = [{ key: m.libraryKey, revision: 1, settings: [{ key: m.settingKey, name: 'File', dataType: 'BinaryUrl', isSecret: false, value: null, defaultValue: null, valueOrigin: 'Default' }] }];
  const raw = { inputParameters: { FileContent: Buffer.from('fixture').toString('base64') }, screenVariables: {}, clientVariables: {} };
  const args = { host, raw, read: m.read, portalRead: m.stages(false), scope: { ...m.scope, libraryKey: m.libraryKey, libraryRevision: 1 }, ...journal(m.origin, m.library) };
  const upload = await mobileBinaryUploadApproval({ ...args, words: 'Upload the file into the setting File of FixtureLib in Fixture' });
  written(upload.approval); assert.equal(upload.expected.libraryOriginOperationUuid, m.library.operationUuid);
  await assert.rejects(mobileBinaryUploadApproval({ ...args, words: 'Upload the file into the setting File of Fixture' }), e => e.code === 'WORDS_MUST_NAME' && e.details.missing.includes('FixtureLib'));
  const receipt = m.uploaded(upload.expected, MOBILE_FILE_UPLOAD);
  const saved = await mobileBinarySaveApproval({ words: 'Save the file in the setting File of FixtureLib in Fixture', host, raw: m.saveInput(m.native(true)), read: m.read,
    portalRead: async () => ({ ok: true, data: { NotFound: false, ExtensibilitySettingInfo: m.native(true) } }), ...journal(m.origin, m.library, receipt) });
  written(saved.approval); assert.equal(saved.expected.uploadOperationUuid, receipt.operationUuid);
});

test('a library release names its revision as a whole word', async () => {
  const assetKey = uuid(), publicationKey = uuid(), input = { ApplicationKey: assetKey, Revision: 3, Version: '1.0.0', ReleaseNotes: 'Proof release' };
  const revision = { assetKey, revision: 3, assetType: 'LowCodeLibrary', tag: null, name: 'Proof' }, pub = { key: publicationKey, status: 'Finished', assetKey, revision: 3, operation: 'Publish' };
  const read = async id => (id.endsWith('/publish-operations') ? { ok: true, data: { results: [pub] } } : { ok: true, data: id.includes('publish-operations') ? pub : revision });
  const release = words => libraryReleaseApproval({ words, host: 'test.outsystems.dev', raw: { inputParameters: input }, lookup: () => null, read });
  for (const words of ['Release Proof 1.0.0 on test.outsystems.dev for 3 colleagues', 'Release Proof 1.0.0 on test.outsystems.dev after 3 pm'])
    await assert.rejects(release(words), missing('WORDS_MUST_NAME'), words);
  for (const named of ['revision 3', 'rev. 3', 'r3', 'revisão 3']) written(await release('Release Proof 1.0.0 on test.outsystems.dev, ' + named));
});

test('an origin SSAM finds in its journal for the written words is exactly one; several refuse with the candidates, and the scope names one', async () => {
  const m = mobile();
  const raw = { inputParameters: { FileContent: Buffer.from('fixture').toString('base64') }, screenVariables: {}, clientVariables: {} };
  const first = await mobileBinaryUploadApproval({ words: 'Upload the file to the setting File of Fixture', host, raw, read: m.read, portalRead: m.stages(false), scope: m.scope, ...journal(m.origin) });
  const older = m.uploaded(first.expected, MOBILE_FILE_UPLOAD), newer = m.uploaded(first.expected, MOBILE_FILE_UPLOAD);
  const save = { words: 'Save the file in the setting File of Fixture', host, raw: m.saveInput(m.native()), read: m.read,
    portalRead: async () => ({ ok: true, data: { NotFound: false, ExtensibilitySettingInfo: m.native() } }), ...journal(m.origin, older, newer) };
  await assert.rejects(mobileBinarySaveApproval(save), e => e.code === 'OPERATION_RECEIPT_MISMATCH' && e.details.candidates.length === 2
    && e.details.candidates.includes(older.operationUuid) && e.details.candidates.includes(newer.operationUuid));
  const chosen = await mobileBinarySaveApproval({ ...save, scope: { uploadOperationUuid: older.operationUuid } });
  assert.equal(chosen.expected.uploadOperationUuid, older.operationUuid);
  // The A2A test in URL mode: two confirmed discoveries of the same agent URL and stage.
  const stage = { Key: uuid(), Name: 'Development', Purpose: 'Development' };
  const card = { protocolVersion: '0.3.0', name: 'Proof', description: 'Constant response', version: '1', url: 'https://example.test/rpc', capabilities: { streaming: false },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'proof', name: 'Proof', description: 'Constant', tags: ['test'] }] };
  const plan = a2aConnectionPlan({ name: 'OwnedA2A', agentUrl: 'https://example.test/agent/', portfolioKey: uuid(), stage, card, configurationType: 'url' }, { receiptCard: true });
  const discovery = () => ({ operationUuid: uuid(), state: 'confirmed', identity: { kind: 'odc-portal', tenant: host, operationId: 'connections.a2aDiscover' },
    response: { card, cardSha256: fingerprint(card) }, reconciliation: { a2aDiscovery: { name: 'OwnedA2A', stageKey: plan.stageKey, agentUrl: plan.agentUrl } }, authorization: { wordsSha256: sha256('discover') } });
  const one = discovery(), two = discovery();
  const reads = async op => (op === 'monitoring.stages' ? { ok: true, rows: [{ ...stage, Key: plan.stageKey }] } : { ok: true, truncated: false, rows: [] });
  const testArgs = { words: 'Test the A2A connection OwnedA2A', host, operationId: A2A_TEST, raw: plan.testInput, read: reads, ...journal(one, two) };
  await assert.rejects(a2aConnectionApproval(testArgs), e => e.code === 'OPERATION_RECEIPT_MISMATCH' && e.details.candidates.length === 2);
  written((await a2aConnectionApproval({ ...testArgs, scope: { discoveryOperationUuid: two.operationUuid } })).approval);
});

test('a trial creation names its portfolio in the words when only the scope gives it', async () => {
  const portfolioKey = uuid();
  const read = async op => (op === 'aiModels.list' ? { ok: true, data: { AIModelList: { List: [] }, TotalCount: '0' } } : { ok: true, data: { AIModelTrials: { List: [{ Id: 'trial-x', CurrentAIModelId: '' }] } } });
  const args = { host, operationId: AI_TRIAL_CREATE, raw: { inputParameters: { TrialId: 'trial-x' }, screenVariables: {}, clientVariables: {} }, read, scope: { portfolioKey } };
  await assert.rejects(aiModelTrialApproval({ ...args, words: 'Create the trial trial-x' }), e => e.code === 'WORDS_MUST_NAME' && e.details.missing.includes(portfolioKey));
  written(await aiModelTrialApproval({ ...args, words: 'Create the trial trial-x in portfolio ' + portfolioKey }));
});

test('a knowledge-base file upload through the access takes the written words naming base, source and file, and sends once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-kb-upload-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kb = 'personal-kb.outsystems.dev', id = uuid(), sourceId = uuid(), stageId = uuid(), portfolioKey = uuid(), originId = uuid();
  const limits = { ok: true, data: { AllowedUploadMimeTypes: 'text/plain', MaximumUploadFileSize: '20971520' } };
  const plan = knowledgeFileUploadPlan({ knowledgeBaseId: id, dataSourceId: sourceId, environmentKey: stageId, filename: 'proof.txt', mimeType: 'text/plain', base64: Buffer.from('Synthetic proof.').toString('base64'), limits });
  const receiptsDir = path.join(dir, 'receipts'); fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(path.join(receiptsDir, originId + '.json'), JSON.stringify({ schema: 'ssam-odc-write/1', operationUuid: originId, state: 'confirmed', createdAt: '2026-10-29T10:00:00.000Z',
    identity: { kind: 'odc-portal', tenant: kb, operationId: 'knowledgeBases.create', target: { inputSha256: 'x' } }, response: { KnowledgeBaseId: id },
    reconciliation: { knowledgeBase: { name: 'OwnBase', portfolioKey } }, authorization: { wordsSha256: sha256('Create the base OwnBase') } }));
  const answers = { 'knowledgeBases.uploadLimits': limits,
    'knowledgeBases.detail': { ok: true, data: { KnowledgeBaseDetails: { KnowledgeBaseId: id, Name: 'OwnBase', PortfolioKey: portfolioKey, Status: 'Ready' }, NotFound: false } },
    'knowledgeBases.dataSources': { ok: true, data: { DataSources: { List: [{ DataSourceId: sourceId, Name: 'OwnSource' }] } } },
    'knowledgeBases.sourceStages': { ok: true, data: { NotFound_KB: false, KnowledgeBaseDetails: { Name: 'OwnBase', PortfolioKey: portfolioKey }, Environments: { List: [{ Key: stageId, PortfolioKey: portfolioKey }] } } },
    'knowledgeBases.dataSource': { ok: true, data: { NotFound_DS: false, DataSource: { DataSourceId: sourceId, Name: 'OwnSource', Type: 'upload_files', LifeCycleStatus: 'Available' } } },
    'knowledgeBases.files': { ok: true, data: { Files: { List: [] }, TotalResults: '0', MaxRecords: 12 } } };
  const access = new OdcAccess({ tenants: { default: kb, tenants: { [kb]: { class: 'personal' } } }, receipts: new WriteJournal(receiptsDir) });
  let sends = 0;
  access.portalRead = async ({ operationId }) => structuredClone(answers[operationId]);
  access.resolvePortal = async () => ({ ok: true, path: 'vault', host: kb, broker: { callScreenservice: async () => { sends++; return { data: { HasError: false, ErrorTitle: '' } }; } } });
  const call = authorize => access.portalWrite({ tenant: kb, operationId: KB_UPLOAD, input: plan.input, authorize, operationUuid: uuid() });
  const refused = await call('Upload the file to OwnBase');
  assert.equal(refused.error?.code, 'WORDS_MUST_NAME', JSON.stringify(refused)); assert.deepEqual(refused.error.missing, ['OwnSource', 'proof.txt']); assert.equal(sends, 0);
  const sent = await call('Upload proof.txt to the source OwnSource of OwnBase');
  assert.equal(sent.receipt?.state, 'accepted', JSON.stringify(sent)); assert.equal(sends, 1);
});

test('a Base64 conversion and its save take the written words naming app and setting; the conversion is found in the journal', async () => {
  const m = mobile();
  const raw = { inputParameters: { BinaryData: Buffer.from('fixture').toString('base64') }, screenVariables: {}, clientVariables: {} };
  const converted = await mobileBinaryUploadApproval({ words: 'Convert the file into the setting File of Fixture', host, raw, read: m.read, portalRead: m.stages(true), scope: m.scope,
    operationId: MOBILE_FILE_CONVERT, ...journal(m.origin) });
  written(converted.approval); assert.equal(converted.expected.transportMode, 'base64');
  await assert.rejects(mobileBinaryUploadApproval({ words: 'Convert it into Fixture', host, raw, read: m.read, portalRead: m.stages(true), scope: m.scope, operationId: MOBILE_FILE_CONVERT, ...journal(m.origin) }),
    missing('WORDS_MUST_NAME'));
  const receipt = m.uploaded(converted.expected, MOBILE_FILE_CONVERT, true);
  const saved = await mobileBinarySaveApproval({ words: 'Save the file in the setting File of Fixture', host, raw: m.saveInput(m.native()), read: m.read,
    portalRead: async op => (op === 'mobileExtensibility.stages' ? m.stages(true)() : { ok: true, data: { NotFound: false, ExtensibilitySettingInfo: m.native() } }), ...journal(m.origin, receipt) });
  written(saved.approval); assert.equal(saved.expected.transportMode, 'base64'); assert.equal(saved.expected.uploadOperationUuid, receipt.operationUuid);
});

test('odc_configurations mobile-extensibility set needs the own fixture origin and the written words, no file', async () => {
  const seen = [];
  const fake = { read: async () => ({ ok: true, data: { settings: [] } }), write: async (input, options) => { seen.push(options); return { ok: true }; } };
  const call = extra => OdcAccess.prototype.configurations.call(fake, { tenant: host, action: 'set', scope: 'mobile-extensibility', environmentKey: uuid(), assetKey: uuid(),
    patch: { settings: [] }, authorize: 'Set the extensibility of Fixture', operationUuid: uuid(), ...extra });
  assert.equal((await call({ originOperationUuid: uuid() })).ok, true);
  assert.equal(seen.at(-1).mobileConfiguration, true); assert.equal(seen.at(-1).mobileConfigurationContext, undefined);
  const refused = await call({});
  assert.equal(refused.error?.code, 'INPUT_INVALID'); assert.equal(seen.length, 1);
});

// R2-I round 3: the verification reads of an own fixture (a credential status, a file download) accept the receipts the
// written words approved, by the same grant predicate: a file's conversation (the control, unchanged) or SSAM's own records.
// A receipt with no approval record stays refused. Each scope check runs before any transport: the stub transport answers
// TRANSPORT_REACHED when the check passed.
test('the verification reads of an own fixture accept the receipts the written words approved; no approval record still refuses', async () => {
  const { apiClientVaultStatus } = await import('../runtime/api-client-vault-status.mjs');
  const reached = () => { throw Object.assign(new Error('transport reached'), { code: 'TRANSPORT_REACHED' }); };
  const outcome = async fn => { try { await fn(); return 'ok'; } catch (e) { return e.code; } };
  const grants = { file: { wordsSha256: sha256('words'), proposalSha256: sha256('proposal'), source: { threadId: uuid(), messageId: uuid() } },
    words: { wordsSha256: sha256('words'), proposalSha256: sha256('proposal'), source: { kind: 'human-words' } }, none: undefined };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reads-'));
  const seen = {};
  try {
    for (const [mode, authorization] of Object.entries(grants)) {
      const creation = uuid(), name = 'SSAMApiClientProof20261029', user = 'owner@example.test';
      fs.writeFileSync(path.join(dir, creation + '.json'), JSON.stringify({ operationUuid: creation, operationId: 'apiClients.create', host, source: 'private-session-pipe', user,
        path: '/usersaccess/screenservices/usersaccess/APIClients/apiclient/ActionAPIClients_Create', authorizeSha256: authorization?.wordsSha256 }));
      const vault = await outcome(() => apiClientVaultStatus({ host, input: { creationOperationUuid: creation }, writesDir: dir, session: { loggedIn: true, host, user }, probe: async () => reached(),
        lookup: () => ({ schema: 'ssam-odc-write/1', operationUuid: creation, state: 'accepted', identity: { tenant: host, operationId: 'apiClients.create', target: { apiClientFixtureName: name } },
          reconciliation: { apiClientFixture: { name } }, authorization }) }));
      const base = uuid(), upload = uuid(), knowledgeBaseId = uuid();
      const knowledge = journal({ operationUuid: base, state: 'confirmed', identity: { tenant: host, operationId: 'knowledgeBases.create' }, response: { KnowledgeBaseId: knowledgeBaseId }, authorization },
        { operationUuid: upload, state: 'confirmed', identity: { tenant: host, operationId: 'knowledgeBases.uploadFile' }, reconciliation: { knowledgeFile: { originOperationUuid: base, knowledgeBaseId } }, authorization });
      const file = await outcome(() => OdcAccess.prototype.knowledgeFileDownloadWithinBudget.call({ receipts: knowledge, resolvePortal: async () => reached() },
        { host, auth: 'auto', input: { uploadOperationUuid: upload, fileId: uuid() } }));
      const save = uuid(), up = uuid(), objectUri = 'https://plat-te3423068adb743c3b12fff7faf2a4b9e.s3.us-east-1.amazonaws.com/tenants/uploads/' + uuid();
      const scope = { applicationKey: uuid(), environmentKey: uuid(), settingKey: uuid(), portfolioKey: uuid(), originOperationUuid: uuid(), contentSha256: sha256('content'), byteLength: 7 };
      const persisted = journal({ operationUuid: save, state: 'confirmed', identity: { tenant: host, operationId: 'mobileExtensibility.saveFile' }, reconciliation: { mobileBinarySave: { ...scope, uploadOperationUuid: up, objectUri } }, authorization },
        { operationUuid: up, state: 'confirmed', identity: { tenant: host, operationId: 'mobileExtensibility.uploadFile' }, reconciliation: { mobileBinaryUpload: scope }, authorization,
          response: { mobileUploadProof: { uploadOperationUuid: up, objectUri, contentSha256: scope.contentSha256, byteLength: 7, contentVerified: true, signedUriExposed: false } } },
        { operationUuid: scope.originOperationUuid, state: 'confirmed', identity: { tenant: host, operationId: 'asset-repository-api-v1:post:/assets' }, response: { assetKey: scope.applicationKey }, authorization });
      const binary = await outcome(() => OdcAccess.prototype.mobileFileDownloadWithinBudget.call({ receipts: persisted, resolvePortal: async () => reached() },
        { host, auth: 'auto', input: { saveOperationUuid: save } }));
      seen[mode] = [vault, file, binary];
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(seen.file, ['TRANSPORT_REACHED', 'TRANSPORT_REACHED', 'TRANSPORT_REACHED'], 'a context file approval (control)');
  assert.deepEqual(seen.words, ['TRANSPORT_REACHED', 'TRANSPORT_REACHED', 'TRANSPORT_REACHED'], 'the written words approval');
  assert.deepEqual(seen.none, ['API_CLIENT_VAULT_SCOPE_UNVERIFIED', 'KNOWLEDGE_DOWNLOAD_SCOPE_UNVERIFIED', 'MOBILE_DOWNLOAD_SCOPE_UNVERIFIED'], 'no approval record');
});

test('a verification read refuses a words-approved receipt whose related receipt carries no approval record', async () => {
  const reached = () => { throw Object.assign(new Error('transport reached'), { code: 'TRANSPORT_REACHED' }); };
  const authorization = { wordsSha256: sha256('words'), source: { kind: 'human-words' } };
  const base = uuid(), upload = uuid(), knowledgeBaseId = uuid();
  const knowledge = journal({ operationUuid: base, state: 'confirmed', identity: { tenant: host, operationId: 'knowledgeBases.create' }, response: { KnowledgeBaseId: knowledgeBaseId } },
    { operationUuid: upload, state: 'confirmed', identity: { tenant: host, operationId: 'knowledgeBases.uploadFile' }, reconciliation: { knowledgeFile: { originOperationUuid: base, knowledgeBaseId } }, authorization });
  await assert.rejects(OdcAccess.prototype.knowledgeFileDownloadWithinBudget.call({ receipts: knowledge, resolvePortal: async () => reached() },
    { host, auth: 'auto', input: { uploadOperationUuid: upload, fileId: uuid() } }), missing('KNOWLEDGE_DOWNLOAD_SCOPE_UNVERIFIED'));
});

// R2-I round 5: with the written words alone, a write that changes several items names each item that changes: the IP
// filter and every app whose binding changes (bound now or unbound), and an organization role and every permission whose
// grant changes. Items left as they are need no name; the receipt checks stay as they were.
test('an own IP filter that binds or unbinds apps names the filter and every app whose binding changes', async () => {
  const { ipFilterApproval, IP_FILTER_PATCH, IP_FILTER_CREATE } = await import('../runtime/ip-filter-approval.mjs');
  const { WRITTEN_CONTEXT } = await import('../../facade/authorization-context.mjs');
  const environmentKey = uuid(), groupKey = uuid(), originOperationUuid = uuid();
  const apps = { [uuid()]: 'Ledger', [uuid()]: 'Ledger Admin', [uuid()]: 'Kiosk' }, [ledger, admin, kiosk] = Object.keys(apps);
  const origin = { operationUuid: originOperationUuid, state: 'confirmed', identity: { tenant: host, operationId: IP_FILTER_CREATE, target: { environmentKey, name: 'OfficeOnly' } },
    response: { key: groupKey }, authorization: { wordsSha256: sha256('Create the IP filter OfficeOnly'), source: { kind: 'human-words' } } };
  const creation = (assetKey, tenant = host) => ({ operationUuid: uuid(), state: 'confirmed', identity: { tenant, operationId: 'asset-repository-api-v1:post:/assets', target: { name: apps[assetKey] } },
    response: { assetKey }, authorization: { wordsSha256: sha256('Create ' + apps[assetKey]) } });
  const approve = (words, { bound = [], appKeys, receipts = Object.keys(apps).map(k => creation(k)) }) => {
    const all = [origin, ...receipts];
    const read = async (op, p) => op.includes('{ipFilterGroupKey}') ? { ok: true, data: { key: groupKey, name: 'OfficeOnly', appKeys: [...bound], ipRules: [] } }
      : op.includes('/assets/{assetKey}') ? { ok: true, data: { assetKey: p.assetKey, assetType: 'WebApplication', name: apps[p.assetKey] } } : { ok: false };
    return ipFilterApproval({ file: WRITTEN_CONTEXT, words, host, operationId: IP_FILTER_PATCH, input: { path: { environmentKey, ipFilterGroupKey: groupKey }, body: { appKeys } },
      originOperationUuid, lookup: k => all.find(r => r.operationUuid === k) ?? null, read, find: pr => all.filter(r => pr(r)) });
  };
  const names = missingNames => e => e.code === 'WORDS_MUST_NAME' && JSON.stringify(e.details?.missing) === JSON.stringify(missingNames);
  // Binding: the words name the filter only, then the filter and the app.
  await assert.rejects(approve('Change the IP filter OfficeOnly', { appKeys: [ledger] }), names(['Ledger']));
  assert.deepEqual((await approve('Bind Ledger to the IP filter OfficeOnly', { appKeys: [ledger] })).targets, ['OfficeOnly', 'Ledger']);
  // Unbinding one app while another stays bound: only the app that leaves is named.
  await assert.rejects(approve('Change the IP filter OfficeOnly', { bound: [ledger, kiosk], appKeys: [kiosk] }), names(['Ledger']));
  assert.deepEqual((await approve('Unbind Ledger from the IP filter OfficeOnly', { bound: [ledger, kiosk], appKeys: [kiosk] })).targets, ['OfficeOnly', 'Ledger']);
  // A listed name inside a longer one does not name it (one predicate): binding both needs both names.
  await assert.rejects(approve('Bind Ledger Admin to OfficeOnly', { appKeys: [ledger, admin] }), names(['Ledger']));
  assert.deepEqual((await approve('Bind Ledger Admin and Ledger to OfficeOnly', { appKeys: [ledger, admin] })).targets.sort(), ['Ledger', 'Ledger Admin', 'OfficeOnly']);
  // An unchanged binding with another change needs only the filter.
  assert.deepEqual((await approve('Change the IP filter OfficeOnly', { bound: [kiosk], appKeys: [kiosk] })).targets, ['OfficeOnly']);
  // The receipt of each app: none, two, or of another tenant still refuse.
  for (const receipts of [[], [creation(ledger), creation(ledger)], [creation(ledger, 'other.outsystems.dev')]])
    await assert.rejects(approve('Bind Ledger to the IP filter OfficeOnly', { appKeys: [ledger], receipts }), missing('AUTHORIZATION_CONTEXT_INVALID'));
});

test('an own organization role permissions patch names the role and every permission whose grant changes', async () => {
  const { organizationRoleApproval, ORG_ROLE_PATCH, ORG_ROLE_CREATE } = await import('../runtime/organization-role-approval.mjs');
  const { WRITTEN_CONTEXT } = await import('../../facade/authorization-context.mjs');
  const roleKey = uuid(), originOperationUuid = uuid(), stage = uuid();
  const catalogue = { [uuid()]: 'Manage apps', [uuid()]: 'Manage apps and users', [uuid()]: 'View logs' }, [apps, both, logs] = Object.keys(catalogue);
  const origin = { operationUuid: originOperationUuid, state: 'confirmed', identity: { tenant: host, operationId: ORG_ROLE_CREATE, target: { name: 'AuditRole' } },
    response: { orgRoleKey: roleKey }, authorization: { wordsSha256: sha256('Create the role AuditRole'), source: { kind: 'human-words' } } };
  const approve = (words, current, permissions) => organizationRoleApproval({ file: WRITTEN_CONTEXT, words, host, operationId: ORG_ROLE_PATCH, originOperationUuid,
    input: { path: { key: roleKey }, body: { name: 'AuditRole', permissions } }, lookup: k => k === originOperationUuid ? origin : null,
    read: async (op, p) => op.endsWith('/permissions/{key}') ? { ok: true, data: { key: p.key, name: catalogue[p.key], allowedScopes: ['Organization'], allowStages: true, allowPortfolios: false } }
      : op.endsWith('/{key}/users') ? { ok: true, data: { results: [], page: { totalResults: 0 } } }
      : { ok: true, data: { key: roleKey, name: 'AuditRole', isReadOnly: false, permissions: current } } });
  const names = missingNames => e => e.code === 'WORDS_MUST_NAME' && JSON.stringify(e.details?.missing) === JSON.stringify(missingNames);
  await assert.rejects(approve('Change the role AuditRole', [], [{ permissionKey: logs }]), names(['View logs']));
  assert.deepEqual((await approve('Grant View logs to the role AuditRole', [], [{ permissionKey: logs }])).targets, ['AuditRole', 'View logs']);
  // Revoked (named by the role's own read), kept unchanged (no name), and a kept permission with other stages (named).
  const held = [{ permissionKey: logs, name: 'View logs', environmentKeys: [] }, { permissionKey: apps, name: 'Manage apps', environmentKeys: [] }];
  await assert.rejects(approve('Change the role AuditRole', held, [{ permissionKey: apps }]), names(['View logs']));
  assert.deepEqual((await approve('Revoke View logs from AuditRole', held, [{ permissionKey: apps }])).targets, ['AuditRole', 'View logs']);
  await assert.rejects(approve('Revoke View logs from AuditRole', held, [{ permissionKey: apps, environmentKeys: [stage] }]), names(['Manage apps']));
  // The longest name first: "Manage apps and users" does not name "Manage apps".
  await assert.rejects(approve('Grant Manage apps and users to AuditRole', [], [{ permissionKey: apps }, { permissionKey: both }]), names(['Manage apps']));
  assert.deepEqual((await approve('Keep the permissions of AuditRole', held, held.map(({ permissionKey, environmentKeys }) => ({ permissionKey, environmentKeys })))).targets, ['AuditRole']);
});
