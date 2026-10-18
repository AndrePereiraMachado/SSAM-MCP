import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Odc3PortalBroker } from '../runtime/odc3-context.mjs';
import { PORTAL_READS, routeOf } from '../runtime/portal-routes.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AI_TRIAL_CREATE, AI_TRIAL_DELETE, aiModelInventory, aiModelTrialApproval, aiModelTrialObservation, observeAiModelTrial } from '../runtime/ai-model-trial.mjs';
import { sha256 } from '../runtime/write-journal.mjs';

test('trial observation carries the recorded portfolio into its detail read',async()=>{
 const portfolioKey=crypto.randomUUID(),id=crypto.randomUUID();
 const receipt={identity:{operationId:AI_TRIAL_CREATE},response:{AIModelId:id},reconciliation:{aiModelTrial:{portfolioKey}}};
 const seen=[];
 const observation=await observeAiModelTrial(receipt,async(operationId,input)=>{
  seen.push(operationId);assert.equal(input.screenVariables.ActivePortfolioKey,portfolioKey);
  return operationId==='aiModels.list'?{ok:true,data:{AIModelList:{List:[{Id:id,PortfolioKey:'',Name:'Trial',IsTrial:true}]},TotalCount:'1'}}
   :{ok:true,data:{NotFound:false,AIModel:{Id:id,AssetKey:id,PortfolioKey:portfolioKey,Name:'Trial',IsTrial:true}}};
 });
 assert.equal(observation.verified,true);assert.deepEqual(seen,['aiModels.list','aiModels.detail']);
});

test('AI model prerequisites use read-only screenservices and preserve their context', async () => {
  const origin = 'https://tenant.example.test';
  const broker = new Odc3PortalBroker({ origin });
  broker.authenticated = true;
  const calls = [];
  broker.metadata.resolve = async (module, view, action) => ({ moduleVersion: 'current', apiVersion: 'current', action });
  broker.request = async (url, options) => {
    calls.push({ url, body: options.body });
    return { status: 200, text: JSON.stringify({ data: { AIModels: { List: [] } } }) };
  };
  for (const id of ['list', 'stages', 'providers', 'trials', 'detail']) {
    const operationId = `aiModels.${id}`;
    const [module, view, action] = PORTAL_READS[operationId];
    await broker.readScreenservice({ target: 'odc3', origin, readOnly: true, operationId,
      module, view, action, inputParameters: {}, screenVariables: { portfolioid: 'portfolio' }, clientVariables: {} });
  }
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.match(call.url, /\/aimodels\/screenservices\/aimodels\//);
    assert.equal(call.body.screenData.variables.portfolioid, 'portfolio');
  }
});

test('trial creation binds an available unconfigured trial and deletion binds the original receipt', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-trial-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'context.json'), proposal = path.join(dir, 'proposal.md');
  fs.writeFileSync(proposal, 'Create/delete one own trial without inference or apps.');
  const host = 'tenant.example.test', words = 'Synthetic grant', portfolioKey = crypto.randomUUID(), key = crypto.randomUUID();
  const source = { kind: 'human-conversation', threadId: crypto.randomUUID(), messageId: crypto.randomUUID(), question: 'Own trial cycle' };
  const p = { TrialId: 'Amazon-Nova-Pro' }, inventory = rows => ({ ok: true, data: { AIModelList: { List: rows }, TotalCount: String(rows.length) } });
  const record = { schema: 'ssam-authorization-context/1', decision: 'approved', words, source,
    proposal: { file: proposal, sha256: sha256(fs.readFileSync(proposal)) },
    scope: [{ lane: 'odc', host, operation: AI_TRIAL_CREATE, targets: [p.TrialId] }],
    constraints: { portfolioKey, inputSha256: sha256(JSON.stringify(p)), expectedInventorySha256: sha256('[]') } };
  // sha256 helper hashes strings/JSON; proposal checksum is over the file bytes.
  record.proposal.sha256 = crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex');
  const save = () => fs.writeFileSync(file, JSON.stringify(record)); save();
  const args = { file, words, host, operationId: AI_TRIAL_CREATE, raw: { inputParameters: p, screenVariables: {}, clientVariables: {} },
    read: async id => id === 'aiModels.list' ? inventory([]) : { ok: true, data: { AIModelTrials: { List: [{ Id: p.TrialId, CurrentAIModelId: '' }] } } } };
  const approval = await aiModelTrialApproval(args);
  assert.equal(approval.operation, AI_TRIAL_CREATE);
  await assert.rejects(aiModelTrialApproval({ ...args, file: undefined }));
  await assert.rejects(aiModelTrialApproval({ ...args, read: async () => ({ ok: true, data: {} }) }));
  await assert.rejects(aiModelTrialApproval({ ...args, raw: { ...args.raw, inputParameters: { ...p, ApiKey: 'not-allowed' } } }));
  const found = { Id: key, Name: 'TrialAmazonNovaPro', PortfolioKey: '', IsTrial: true }, originId = crypto.randomUUID();
  await assert.rejects(aiModelTrialApproval({ ...args, read: async id => id === 'aiModels.list' ? inventory([found]) : args.read(id) }), error => error.code === 'AI_MODEL_BASELINE_NOT_EMPTY');
  const origin = { state: 'confirmed', identity: { tenant: host, operationId: AI_TRIAL_CREATE }, response: { AIModelId: key },
    authorization: { source, wordsSha256: sha256(words), proposalSha256: record.proposal.sha256 }, reconciliation: { aiModelTrial: { portfolioKey } } };
  const deletionInput = { AIModelId: key };
  record.scope = [{ lane: 'odc', host, operation: AI_TRIAL_DELETE, targets: [found.Name] }];
  record.constraints = { portfolioKey, originOperationUuid: originId, aiModelId: key,
    expectedModelSha256: sha256(JSON.stringify(found)), inputSha256: sha256(JSON.stringify(deletionInput)) }; save();
  const deletion = { ...args, operationId: AI_TRIAL_DELETE, raw: { ...args.raw, inputParameters: deletionInput },
    lookup: () => origin, read: async id => id === 'aiModels.detail' ? { ok: true, data: { NotFound: false, AIModel: { ...found, AssetKey: key, PortfolioKey: portfolioKey } } } : inventory([found]) };
  assert.equal((await aiModelTrialApproval(deletion)).operation, AI_TRIAL_DELETE);
  for (const change of [{ lookup: () => null }, { lookup: () => ({ ...origin, state: 'uncertain' }) },
    { lookup: () => ({ ...origin, response: { AIModelId: crypto.randomUUID() } }) },
    { read: async () => inventory([{ ...found, IsTrial: false }]) }, { read: async () => inventory([{ ...found, Name: 'Changed' }]) }])
    await assert.rejects(aiModelTrialApproval({ ...deletion, ...change }));
  const receipt = { ...origin, identity: { operationId: AI_TRIAL_DELETE }, reconciliation: { aiModelTrial: { portfolioKey, key } } };
  assert.equal(aiModelTrialObservation(receipt, inventory([])).verified, true);
  assert.equal(aiModelTrialObservation(receipt, inventory([found])).verified, false);
  const detail = { ok: true, data: { NotFound: false, AIModel: { ...found, AssetKey: key, PortfolioKey: portfolioKey } } };
  assert.equal(aiModelTrialObservation(origin, inventory([found]), detail).verified, true);
  assert.equal(aiModelTrialObservation(origin, inventory([found])).verified, false);
  assert.equal(aiModelTrialObservation(origin, inventory([found]), { ...detail, data: { ...detail.data, AIModel: { ...detail.data.AIModel, PortfolioKey: crypto.randomUUID() } } }).verified, false);
  assert.throws(() => aiModelInventory({ ...inventory([]), data: { AIModelList: { List: [] }, TotalCount: '1' } }, portfolioKey));
  assert.throws(() => aiModelInventory(inventory([{ ...found, PortfolioKey: crypto.randomUUID() }]), portfolioKey));
});

test('AI model mutation and environment wake-up are never accepted as reads', () => {
  for (const action of ['ActionUI_AIModelTrial_Create', 'ActionUI_AIModel_Delete', 'ActionUI_WakeUpEnvironments']) {
    assert.ok(!Object.values(PORTAL_READS).some(route => route[2].endsWith('/' + action)));
  }
  assert.throws(() => routeOf('aiModels.trialCreate', false), error => error.code === 'PORTAL_OPERATION_NOT_FOUND');
});
