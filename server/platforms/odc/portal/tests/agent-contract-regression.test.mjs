import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerAccessTools, ACCESS_TOOLS } from '../../facade/odc-access.mjs';
import { registerOdcTools } from '../runtime/server.mjs';
import { OdcBridge } from '../runtime/bridge.mjs';
import { a2aConnectionPlan } from '../runtime/a2a-connection-plan.mjs';
import { a2aConnectionApproval, A2A_TEST } from '../runtime/a2a-connection-approval.mjs';
import { sha256, fingerprint } from '../runtime/write-journal.mjs';

const plannerInput = () => ({ name: 'OwnedA2A', description: 'Synthetic fixture', agentUrl: 'https://example.test/agent/',
  portfolioKey: randomUUID(), stage: { Key: randomUUID(), Name: 'Development', Purpose: 'Development' },
  card: { protocolVersion: '0.3.0', name: 'Proof', description: 'Constant response', version: '1', url: 'https://example.test/rpc',
    capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'proof', name: 'Proof', description: 'Constant', tags: ['test'] }] } });
const host = () => { const handlers = new Map(); return { handlers, server: { registerTool: (name, _config, handler) => handlers.set(name, handler) } }; };

test('A1: the facade A2A plan remains identical and its displayed native input passes approval', async t => {
  const input = plannerInput(), raw = a2aConnectionPlan(input), h = host();
  registerAccessTools(h.server, {}, handler => handler);
  const shown = await h.handlers.get('odc_a2a_connection_plan')(input);
  assert.deepEqual(shown, raw);
  assert.equal(fingerprint(shown.testInput.inputParameters), fingerprint(raw.testInput.inputParameters));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const proposal = path.join(dir, 'proposal.md'), file = path.join(dir, 'approval.json');
  const words = 'Synthetic fixture approval', tenant = 'example.outsystems.dev';
  fs.writeFileSync(proposal, 'Synthetic A2A proposal');
  fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', words,
    source: { kind: 'human-conversation', threadId: randomUUID(), messageId: randomUUID(), question: 'Approve fixture' },
    proposal: { file: proposal, sha256: sha256(fs.readFileSync(proposal, 'utf8')) },
    scope: [{ lane: 'odc', host: tenant, operation: A2A_TEST, environmentKey: shown.stageKey, targets: [input.name] }],
    constraints: { planSha256: shown.planSha256, inputSha256: sha256(JSON.stringify(shown.testInput.inputParameters)) } }));
  const approved = await a2aConnectionApproval({ file, words, host: tenant, operationId: A2A_TEST, raw: shown.testInput,
    read: async op => op === 'monitoring.stages' ? { ok: true, rows: [input.stage] } : { ok: true, truncated: false, rows: [] } });
  assert.equal(approved.expected.planSha256, shown.planSha256);
  assert.deepEqual(approved.expected.details, shown.details);
});

const metadata = () => ({ ok: true, credentialsExposed: false, credentialPresent: false, portalCredentialAvailable: false,
  secretRefs: { resolvedBy: 'studio', supported: true }, credentialEntry: 'SSAM/ODC3/example/Portal',
  token: { type: 'string', description: 'public schema' }, ClientSecret: '', AccessTokenURL: '', APIKeySecret: '', Password: '',
  description: 'Studio Bearer is not a Portal credential', vault: { available: false, credentialPresent: false } });

test('M5: every registered facade tool preserves credential-free metadata and status booleans', async () => {
  const h = host(), raw = metadata();
  const access = new Proxy({}, { get: () => async () => structuredClone(raw) });
  registerAccessTools(h.server, access, handler => handler);
  assert.deepEqual([...h.handlers.keys()].sort(), [...ACCESS_TOOLS].sort());
  for (const [name, handler] of h.handlers) {
    if (name === 'odc_a2a_connection_plan') {
      const input = plannerInput(); assert.deepEqual(await handler(input), a2aConnectionPlan(input), name);
    } else assert.deepEqual(await handler({}), raw, name);
  }
});

test('M5: standalone tools preserve local inventory and all 163 pinned operation contracts', async () => {
  const h = host(), bridge = new OdcBridge(), raw = metadata();
  bridge.status = () => structuredClone(raw); bridge.execute = async () => structuredClone(raw);
  bridge.config.allowedWriteOperations.add('synthetic');
  // odc_portal_capabilities answers pages (capabilities.page) since the library-release discovery.
  const capabilities = { status: () => structuredClone(raw), list: () => structuredClone(raw), page: () => structuredClone(raw), describe: () => structuredClone(raw) };
  const portalRead = { target: 'odc3', status: () => structuredClone(raw), execute: async () => structuredClone(raw) };
  registerOdcTools(h.server, bridge, { capabilities, portalRead });
  const expected = {
    odc_status: { ...raw, portalCapabilities: raw, portalRead: raw }, odc_portal_capabilities: raw,
    odc_describe_capability: raw, odc_portal_read: raw, odc_read: raw, odc_write: raw,
    odc_search_operations: bridge.catalog.list({}),
    odc_list_apis: { sourceCommit: bridge.catalog.raw.sourceCommit, apis: [...bridge.catalog.apis.values()].map(api => ({
      id: api.id, title: api.title, version: api.version, operationCount: api.operations.length,
      deprecated: api.operations.every(o => o.deprecated), source: api.source })) },
  };
  assert.deepEqual([...h.handlers.keys()].sort(), [...Object.keys(expected), 'odc_describe_operation'].sort());
  for (const [name, value] of Object.entries(expected)) {
    const output = await h.handlers.get(name)({});
    assert.deepEqual(output.structuredContent, value, name);
    assert.deepEqual(JSON.parse(output.content[0].text), value, name);
  }
  assert.equal(bridge.catalog.operations.size, 163);
  for (const operationId of bridge.catalog.operations.keys()) {
    const output = await h.handlers.get('odc_describe_operation')({ operationId });
    const contract = bridge.catalog.describe(operationId);
    assert.deepEqual(output.structuredContent, contract, operationId);
    assert.deepEqual(JSON.parse(output.content[0].text), contract, operationId);
  }
});
