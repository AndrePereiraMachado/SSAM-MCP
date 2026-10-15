import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Catalog } from '../runtime/catalog.mjs';
import { OdcAccess } from '../runtime/access.mjs';
import { WriteJournal, sha256, fingerprint } from '../runtime/write-journal.mjs';
import { A2A_TEST } from '../runtime/a2a-connection-approval.mjs';
import { A2A_DISCOVER } from '../runtime/a2a-discovery.mjs';
import { registerAccessTools } from '../../facade/odc-access.mjs';
import { a2aConnectionPlan } from '../runtime/a2a-connection-plan.mjs';
import { redactValues } from '../runtime/errors.mjs';

const tenant = 'fixture.outsystems.dev', origin = 'https://' + tenant;
const catalog = new Catalog();
const descriptions = {
  plain: 'Fixture agent', bearer: 'Premium skills need Bearer authentication',
  signedUrl: 'Docs: https://docs.example.test/run?api_key=YOUR_KEY_HERE',
  invalidPort: 'Docs: https://example.test:99999/x',
};
const userinfoDescriptions = {
  userAndPassword: 'Docs: https://u:p@example.test/x',
  userOnly: 'Docs: https://u@example.test/x',
};

for(const [label,description] of Object.entries(userinfoDescriptions)) {
  test(`R4-2: URL userinfo projection retains an encoded marker (${label})`, () => {
    const shown=redactValues(description);
    assert.equal(shown==='Docs: https://%5BREDACTED%5D@example.test/x',true,
      'URL userinfo projection must retain the encoded marker and clear the password');
  });
  for(const configurationType of ['json','url'])
  test(`R4-2: facade refuses displayed userinfo card in ${configurationType} mode (${label})`,async t=>{
    const h=fixture(t,description),{result}=await h.discover();
    await assert.rejects(h.call('odc_a2a_connection_plan',{...h.planInput,configurationType,card:result.data.card}),
      {code:'A2A_CARD_REDACTED_COPY'});
    assert.equal(h.sent.filter(r=>r.operationId===A2A_TEST).length,0);
  });
  test(`R4-2: manually prepared displayed userinfo card is refused without a receipt (${label})`,async t=>{
    const h=fixture(t,description),{result}=await h.discover();
    const plan=a2aConnectionPlan({...h.planInput,card:result.data.card},{receiptCard:true});
    h.approve(A2A_TEST,plan.testInput,{planSha256:plan.planSha256});
    const tested=await h.call('odc_portal_write',{tenant,operationId:A2A_TEST,input:plan.testInput,
      authorize:h.words,operationUuid:randomUUID(),authorizationContext:h.file});
    assert.equal(tested.ok,false);
    assert.equal(tested.error?.code,'A2A_CARD_REDACTED_COPY');
    assert.equal(h.sent.filter(r=>r.operationId===A2A_TEST).length,0);
  });
}
function fixture(t, description) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-discovery-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stage = { Key: randomUUID(), Name: 'Development', Purpose: 'Development' };
  const card = { protocolVersion: '0.3.0', name: 'Own', description, version: '1', url: 'https://example.test/rpc',
    capabilities: { streaming: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'proof', name: 'Proof', description: 'Constant', tags: [], examples: [description] }] };
  const sent = [];
  const broker = { target: 'odc3', origin, authenticated: true,
    readScreenservice: async r => ({ target: 'odc3', origin, body: { data: r.operationId === 'monitoring.stages'
      ? { EnvironmentList: { List: [{ Environment: stage }] } } : { Connections: { List: [] }, TotalResults: 0 } } }),
    callScreenservice: async r => {
      sent.push(structuredClone(r));
      return { data: r.operationId === A2A_DISCOVER ? { AgentCard: JSON.stringify(card) } : { Out_ConnectionId: randomUUID() } };
    } };
  const access = new OdcAccess({ catalog, tenants: { default: tenant, tenants: { [tenant]: { class: 'personal', portalOrigin: origin } } },
    studio: {}, vault: {}, prompt: {}, portalBroker: () => broker, receipts: new WriteJournal(path.join(dir, 'receipts')),
    requestFile: () => path.join(dir, 'request.json'), sleep: async () => {} });
  // Only the remote transport resolver is replaced. Reads, approvals, writes,
  // receipt reservation, settlement and facade projection remain production code.
  access.resolvePortal = async () => ({ path: 'vault', host: tenant, broker });
  const handlers = new Map(), schemas = new Map();
  registerAccessTools({ registerTool: (name, config, handler) => { handlers.set(name, handler); schemas.set(name, config.inputSchema); } }, access, fn => fn);
  const call = (name, input) => handlers.get(name)(schemas.get(name).parse(input));
  const file = path.join(dir, 'approval.json'), proposal = path.join(dir, 'proposal.md');
  fs.writeFileSync(proposal, 'Synthetic owned discovery and test');
  const words = 'Synthetic owned discovery and test grant';
  const source = { kind: 'human-conversation', threadId: randomUUID(), messageId: randomUUID(), question: 'Approve fixture' };
  const approve = (operation, raw, constraints) => fs.writeFileSync(file, JSON.stringify({
    schema: 'ssam-authorization-context/1', decision: 'approved', words, source,
    proposal: { file: proposal, sha256: sha256(fs.readFileSync(proposal, 'utf8')) },
    scope: [{ lane: 'odc', host: tenant, operation, environmentKey: stage.Key, targets: ['Own'] }],
    constraints: { ...constraints, inputSha256: sha256(JSON.stringify(raw.inputParameters)) },
  }));
  const planInput = { name: 'Own', agentUrl: 'https://example.test/agent/', portfolioKey: randomUUID(), stage };
  async function discover() {
    const discoveryOperationUuid = randomUUID(), raw = { inputParameters: { AgentDiscovery: { url: planInput.agentUrl, environmentId: stage.Key } } };
    approve(A2A_DISCOVER, raw, { connectionName: 'Own', agentUrl: planInput.agentUrl });
    const request = { tenant, operationId: A2A_DISCOVER, input: raw, authorize: words,
      operationUuid: discoveryOperationUuid, authorizationContext: file };
    const result = await call('odc_portal_write', request);
    assert.equal(result.ok, true, result.error?.code);
    return { discoveryOperationUuid, result, request };
  }
  return { call, access, sent, card, planInput, approve, file, words, discover };
}

for (const configurationType of ['url', 'json']) for (const [label, description] of Object.entries({...descriptions,...userinfoDescriptions}))
test(`C1: ${configurationType} discovery receipt -> facade plan -> approved native test (${label})`, async t => {
  const h = fixture(t, description), { discoveryOperationUuid } = await h.discover();
  const plan = await h.call('odc_a2a_connection_plan', { ...h.planInput, configurationType, discoveryOperationUuid });
  const receipt = h.access.receipts.lookup(discoveryOperationUuid);
  assert.equal(receipt.state, 'confirmed');
  assert.deepEqual(receipt.response.card, h.card);
  assert.equal(plan.agentCardSha256, sha256(JSON.stringify(receipt.response.card)));
  h.approve(A2A_TEST, plan.testInput, { planSha256: plan.planSha256, discoveryOperationUuid });
  const testOperationUuid = randomUUID();
  const tested = await h.call('odc_portal_write', { tenant, operationId: A2A_TEST, input: plan.testInput,
    authorize: h.words, operationUuid: testOperationUuid, authorizationContext: h.file });
  assert.equal(tested.ok, true, tested.error?.code);
  assert.equal(h.sent.filter(r => r.operationId === A2A_TEST).length, 1);
  const approved = h.access.receipts.lookup(testOperationUuid).reconciliation.a2aConnection;
  assert.equal(approved.planSha256, plan.planSha256);
  assert.equal(approved.discoveryOperationUuid, discoveryOperationUuid);
  if (configurationType === 'json') {
    const native = h.sent.find(r => r.operationId === A2A_TEST).input.inputParameters.ValidStageConfigs.List[0].AgentCardJson;
    assert.equal(native, JSON.stringify(receipt.response.card));
  } else assert.deepEqual(plan.card, receipt.response.card);
});

for (const [label, description] of Object.entries(descriptions).filter(([label]) => label !== 'plain'))
test(`C1-J: copied displayed JSON card is refused before any native test (${label})`, async t => {
  const h = fixture(t, description), { result } = await h.discover();
  await assert.rejects(h.call('odc_a2a_connection_plan', { ...h.planInput, card: result.data.card }),
    { code: 'A2A_CARD_REDACTED_COPY' });
  assert.equal(h.sent.filter(r => r.operationId === A2A_TEST).length, 0);
});

test('C1-J: explicit cards report every marked text path in one refusal in both modes', async t => {
  const h = fixture(t, descriptions.plain);
  const card = structuredClone(h.card);
  card.description = '[REDACTED]'; card.skills[0].examples = ['%5bREDACTED%5d', '[INVALID URL]'];
  card.extra = { deeper: ['text [REDACTED]'] };
  for (const configurationType of ['json', 'url']) {
    await assert.rejects(h.call('odc_a2a_connection_plan', { ...h.planInput, configurationType, card }), error => {
      assert.equal(error.code, 'A2A_CARD_REDACTED_COPY');
      assert.deepEqual(error.details.markedFields, ['card.description', 'card.skills[0].examples[0]', 'card.skills[0].examples[1]', 'card.extra.deeper[0]']);
      assert.match(error.message, /discoveryOperationUuid/);
      return true;
    });
  }
  assert.equal(h.sent.length, 0);
});

test('C1-J: confirmed discovery offers a card-free receipt-plan continuation', async t => {
  const h = fixture(t, descriptions.signedUrl), { discoveryOperationUuid, result, request } = await h.discover();
  assert.equal(result.continuation?.tool, 'odc_a2a_connection_plan');
  assert.deepEqual(result.continuation.arguments, { discoveryOperationUuid, name: h.planInput.name,
    agentUrl: h.planInput.agentUrl, stage: h.planInput.stage });
  assert.equal(Object.hasOwn(result.continuation.arguments, 'card'), false);
  const observed=await h.call('odc_receipt',{operationUuid:discoveryOperationUuid});
  assert.deepEqual(observed.continuation,result.continuation);
  const replayed=await h.call('odc_portal_write',request);
  assert.deepEqual(replayed.continuation,result.continuation);
  assert.equal(h.sent.length,1);
  for (const configurationType of ['url', 'json']) {
    const plan = await h.call(result.continuation.tool, { ...result.continuation.arguments,
      portfolioKey: h.planInput.portfolioKey, configurationType });
    assert.equal(plan.agentCardSha256, sha256(JSON.stringify(h.access.receipts.lookup(discoveryOperationUuid).response.card)));
  }
});

test('C1-J: approval citing discovery refuses a different unmarked JSON card with its own code', async t => {
  const h = fixture(t, descriptions.plain), { discoveryOperationUuid } = await h.discover();
  const card = structuredClone(h.card); card.description = 'Different unmarked description';
  const plan = a2aConnectionPlan({ ...h.planInput, card });
  h.approve(A2A_TEST, plan.testInput, { planSha256: plan.planSha256, discoveryOperationUuid });
  const tested = await h.call('odc_portal_write', { tenant, operationId: A2A_TEST, input: plan.testInput,
    authorize: h.words, operationUuid: randomUUID(), authorizationContext: h.file });
  assert.equal(tested.ok, false);
  assert.equal(tested.error?.code, 'A2A_DISCOVERY_CARD_MISMATCH');
  assert.equal(h.sent.filter(r => r.operationId === A2A_TEST).length, 0);
});

test('C1-J: approval citing discovery refuses a copied masked JSON card before native send', async t => {
  const h = fixture(t, descriptions.signedUrl), { discoveryOperationUuid, result } = await h.discover();
  // Reproduce an old prepared native request without exposing a public bypass.
  const plan = a2aConnectionPlan({ ...h.planInput, card: result.data.card }, { receiptCard: true });
  h.approve(A2A_TEST, plan.testInput, { planSha256: plan.planSha256, discoveryOperationUuid });
  const tested = await h.call('odc_portal_write', { tenant, operationId: A2A_TEST, input: plan.testInput,
    authorize: h.words, operationUuid: randomUUID(), authorizationContext: h.file });
  assert.equal(tested.ok, false);
  assert.equal(tested.error?.code, 'A2A_DISCOVERY_CARD_MISMATCH');
  assert.equal(h.sent.filter(r => r.operationId === A2A_TEST).length, 0);
});

test('C1: URL plans require discovery and mismatched copied cards are explicitly refused', async t => {
  const h = fixture(t, descriptions.signedUrl);
  await assert.rejects(h.call('odc_a2a_connection_plan', { ...h.planInput, configurationType: 'url', card: h.card }),
    { code: 'A2A_DISCOVERY_REQUIRED' });
  const { discoveryOperationUuid, result } = await h.discover();
  assert.notEqual(fingerprint(result.data.card), fingerprint(h.card));
  for (const configurationType of ['url', 'json']) {
    await assert.rejects(h.call('odc_a2a_connection_plan', { ...h.planInput, configurationType, discoveryOperationUuid, card: result.data.card }),
      { code: 'A2A_CARD_REDACTED_COPY' });
    const plan = await h.call('odc_a2a_connection_plan', { ...h.planInput, configurationType, discoveryOperationUuid, card: h.card });
    assert.equal(plan.agentCardSha256, sha256(JSON.stringify(h.access.receipts.lookup(discoveryOperationUuid).response.card)));
  }
  assert.equal(h.sent.length, 1);
});

test('C1: receipt plans refuse wrong identity, scope, state and corrupted card hash without sending', async t => {
  const h = fixture(t, descriptions.plain), { discoveryOperationUuid } = await h.discover();
  const original = h.access.receipts.lookup(discoveryOperationUuid);
  for (const mutate of [r => r.state = 'accepted', r => r.identity.operationId = A2A_TEST,
    r => r.identity.kind = 'odc-public', r => r.response.cardSha256 = '0'.repeat(64),
    r => r.reconciliation.a2aDiscovery.stageKey = randomUUID(), r => r.reconciliation.a2aDiscovery.name = 'Other',
    r => r.reconciliation.a2aDiscovery.agentUrl = 'https://other.example.test/']) {
    const changed = structuredClone(original); mutate(changed); h.access.receipts.write(changed);
    await assert.rejects(h.call('odc_a2a_connection_plan', { ...h.planInput, configurationType: 'url', discoveryOperationUuid }),
      { code: 'A2A_DISCOVERY_INVALID' });
  }
  h.access.receipts.write(original);
  await assert.rejects(h.call('odc_a2a_connection_plan', { ...h.planInput, configurationType: 'json', discoveryOperationUuid, tenant: 'other.outsystems.dev' }),
    { code: 'A2A_DISCOVERY_INVALID' });
  assert.equal(h.sent.length, 1);
});
