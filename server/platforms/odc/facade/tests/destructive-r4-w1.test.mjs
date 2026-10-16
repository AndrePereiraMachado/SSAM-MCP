import './fixtures/isolated-profile.mjs';
// CX15 r4 (W-1): the read-only reconciliation continuations of odc_a2a_connection_delete and of odc_portal_write (the
// custom search deletion) carried authorize = the owner's original words, and the why said "quote the original
// authorization": the words came back to the model in clear, and above the answer budget the fitter kept the whole answer
// in .local\answers. Now the same operationUuid WITHOUT authorize reconciles the receipt (read-only, never a new delete),
// the continuation carries no words, and another identity with the same UUID is still refused. Through the real MCP
// handler (registerAccessTools + wrap + the destructive guard), then the hub's shaper and fitter, with the default and a
// reduced budget (deps.answerBudgets). Fakes only, synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';
import { WriteJournal, sha256 } from '../../portal/runtime/write-journal.mjs';
import { rawInput } from '../../portal/runtime/portal-routes.mjs';
import { guardedAccess } from '../../portal/runtime/destructive-preview.mjs';
import { registerAccessTools } from '../odc-access.mjs';
import { wrap } from '../mcp.mjs';
import { shapeToolResult } from '../responses.mjs';
import { fitResult, ANSWER_BUDGETS } from '../answer-size.mjs';
import { MARK, ownerWords, count, inValue, filesWithMark } from './fixtures/destructive-r4-marker.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const HOST = 'personal-zzr4w1.outsystems.dev';
const uuid = () => crypto.randomUUID();
const SMALL = { ...ANSWER_BUDGETS, other: 600, refusal: 600, receipt: 600 };

async function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r4-w1-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const studio = { running: async () => true, call: async args => args[0] === 'auth-status'
    ? { ok: true, bridge: 'v38', sessions: [{ host: HOST, loggedIn: true, user: 'dev@example.test' }], portalWindows: [], capabilities: ['portal-call'] }
    : { ok: false, error: 'Unknown command ' + args[0] } };
  let n = 0;
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: HOST, tenants: { [HOST]: { class: 'personal' } } }, studio,
    vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('no vault'); } },
    prompt: { apiClient: async () => ({ opened: true }), portal: async () => ({ opened: true }) },
    portalBroker: () => ({ available: false, authenticated: false, initialize: async () => {} }),
    receipts: new WriteJournal(path.join(dir, 'receipts')), sleep: async () => {}, requestFile: () => path.join(dir, 'req-' + (++n) + '.json') });
  const sends = [];
  access.resolvePortal = async () => ({ ok: true, path: 'vault', broker: { callScreenservice: async r => { sends.push(r.operationId); throw new Error('no send in this test'); } } });
  const present = {};
  access.portalRead = async ({ operationId, input }) => {
    if (operationId === 'connections.detail') {
      const id = input?.connectionId ?? input?.screenVariables?.ConnectionId, c = present[id];
      return c ? { ok: true, data: { NotFound: false, Connection: { connectionId: id, name: c.name, providerId: c.providerId, stageConfigurations: [{ stageKey: 'dev' }] } } }
        : { ok: true, data: { NotFound: true, Connection: null } };
    }
    if (operationId === 'connections.list') return { ok: true, truncated: false, rows: Object.entries(present).map(([id, c]) => ({ ConnectionId: id, Name: c.name })) };
    return { ok: false, error: { code: 'UNEXPECTED_READ', message: operationId } };
  };
  const server = new McpServer({ name: 'cx15r4-w1', version: '1.0.0' });
  registerAccessTools(server, guardedAccess(access, { root: path.join(dir, 'destructive') }), wrap);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r4-w1-client', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const answers = path.join(dir, 'answers-default'), small = path.join(dir, 'answers-small');
  // The hub's path (ssam.mjs): shaper, then fitter with the default budgets and with reduced ones (deps.answerBudgets).
  const call = async (tool, args) => {
    const reply = await client.callTool({ name: tool, arguments: args });
    const text = reply.content?.[0]?.text ?? '';
    const value = reply.structuredContent ?? JSON.parse(text);
    const shaped = shapeToolResult(tool, args, reply, { lane: 'odc' });
    const fitted = fitResult(tool, args, shaped, { root: answers });
    const fittedSmall = fitResult(tool, args, shaped, { root: small, budgets: SMALL });
    return { value, text, fittedText: fitted.content?.[0]?.text ?? '', fittedSmallText: fittedSmall.content?.[0]?.text ?? '' };
  };
  return { dir, access, sends, present, call, answers, small };
}
const noWords = (r, label) => {
  assert.equal(count(r.text), 0, label + ': the MCP text has no owner words');
  assert.equal(inValue(r.value), 0, label + ': the structured answer has no owner words');
  assert.equal(count(r.fittedText), 0, label + ': the fitted answer (default budget) has no owner words');
  assert.equal(count(r.fittedSmallText), 0, label + ': the fitted answer (reduced budget) has no owner words');
};

test('W-1 (odc_a2a_connection_delete): the reconciliation continuation carries no words; the same UUID without words only reads; another identity is refused', async t => {
  const w = await world(t);
  const connectionId = uuid(), originOperationUuid = uuid(), operationUuid = uuid(), WORDS = ownerWords('ZZOwnedAgent');
  const origin = w.access.receipts.reserve({ operationUuid: originOperationUuid, identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.a2aTest', target: { connectionName: 'ZZOwnedAgent', step: 'test' } },
    wordsSha256: sha256('outras palavras sinteticas da criacao'), plan: {}, reconciliation: { a2aConnection: { name: 'ZZOwnedAgent' } } });
  w.access.receipts.settle(origin, { state: 'accepted', response: { Out_ConnectionId: connectionId } });
  const del = w.access.receipts.reserve({ operationUuid, identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.delete', target: { connectionId, connectionName: 'ZZOwnedAgent', originOperationUuid } },
    wordsSha256: sha256(WORDS), plan: {} });
  w.access.receipts.settle(del, { state: 'accepted' });
  w.present[connectionId] = { name: 'ZZOwnedAgent', providerId: 'a2a' };

  // The model still quotes the words once (as the old continuation told it): the answer gives them back no more.
  const first = await w.call('odc_a2a_connection_delete', { tenant: HOST, auth: 'auto', connectionId, originOperationUuid, operationUuid, authorize: WORDS });
  assert.equal(first.value.receipt?.state, 'accepted', JSON.stringify(first.value).slice(0, 400));
  const c = first.value.continuation;
  assert.equal(c?.tool, 'odc_a2a_connection_delete');
  assert.equal(c.arguments.authorize, undefined, 'the continuation carries no authorize');
  assert.equal(c.arguments.operationUuid, operationUuid);
  assert.doesNotMatch(c.why, /quote/i);
  noWords(first, 'first');
  // The continuation as it came (no words): a read-only reconciliation, accepted.
  const again = await w.call(c.tool, c.arguments);
  assert.equal(again.value.receipt?.state, 'accepted', JSON.stringify(again.value).slice(0, 400));
  assert.notEqual(again.value.error?.code, 'AUTHORIZATION_REQUIRED');
  assert.equal(again.value.continuation?.arguments?.authorize, undefined);
  noWords(again, 'again');
  // The deletion becomes visible: the same call settles the receipt; still no send.
  delete w.present[connectionId];
  const settled = await w.call(c.tool, c.arguments);
  assert.equal(settled.value.receipt?.state, 'confirmed', JSON.stringify(settled.value).slice(0, 400));
  assert.equal(settled.value.ok, true);
  // Another identity with the same UUID: refused, with or without words.
  const foreign = await w.call(c.tool, { ...c.arguments, connectionId: uuid() });
  assert.equal(foreign.value.ok, false); assert.equal(foreign.value.error?.code ?? foreign.value.code, 'OPERATION_UUID_REUSED', JSON.stringify(foreign.value).slice(0, 300));
  const otherWords = await w.call(c.tool, { ...c.arguments, authorize: 'outras palavras sinteticas quaisquer' });
  assert.equal(otherWords.value.ok, false); assert.equal(otherWords.value.error?.code ?? otherWords.value.code, 'AUTHORIZATION_CONTEXT_INVALID');
  // Without a receipt, the unguarded tool still needs the words (a new UUID is a write, never a reconciliation).
  const fresh = await w.access.a2aConnectionDelete({ tenant: HOST, connectionId, originOperationUuid, operationUuid: uuid() });
  assert.equal(fresh.error?.code, 'AUTHORIZATION_REQUIRED');
  assert.deepEqual(w.sends, [], 'no delete was ever sent');
  assert.deepEqual(filesWithMark([w.answers, w.small]), [], '.local\\answers keeps no owner words');
});

test('W-1 (odc_portal_write, custom search deletion): the reconciliation continuation carries no words; the same UUID without words only reads; another input is refused', async t => {
  const w = await world(t);
  const connectionId = uuid(), operationUuid = uuid(), WORDS = ownerWords('ZZOwnedSearch');
  const input = { inputParameters: { ConnectionId: connectionId, ProviderId: 'customAISearch', ConsoleProviderId: '' } };
  const identity = { kind: 'odc-portal', tenant: HOST, operationId: 'connections.delete', target: { inputSha256: sha256(JSON.stringify(rawInput(input).inputParameters)) } };
  const del = w.access.receipts.reserve({ operationUuid, identity, wordsSha256: sha256(WORDS), plan: {},
    reconciliation: { customSearchDeletion: { connectionId, providerId: 'customAISearch', connectionName: 'ZZOwnedSearch' } } });
  w.access.receipts.settle(del, { state: 'accepted' });
  w.present[connectionId] = { name: 'ZZOwnedSearch', providerId: 'customAISearch' };

  const first = await w.call('odc_portal_write', { tenant: HOST, auth: 'auto', operationId: 'connections.delete', input, operationUuid, authorize: WORDS });
  assert.equal(first.value.receipt?.state, 'accepted', JSON.stringify(first.value).slice(0, 400));
  const c = first.value.continuation;
  assert.equal(c?.tool, 'odc_portal_write');
  assert.equal(c.arguments.authorize, undefined, 'the continuation carries no authorize');
  assert.doesNotMatch(c.why, /quote/i);
  noWords(first, 'first');
  const again = await w.call(c.tool, c.arguments);
  assert.equal(again.value.receipt?.state, 'accepted', JSON.stringify(again.value).slice(0, 400));
  assert.equal(again.value.continuation?.arguments?.authorize, undefined);
  noWords(again, 'again');
  delete w.present[connectionId];
  const settled = await w.call(c.tool, c.arguments);
  assert.equal(settled.value.receipt?.state, 'confirmed', JSON.stringify(settled.value).slice(0, 400));
  // Another input with the same UUID: refused.
  const foreign = await w.call(c.tool, { ...c.arguments, input: { inputParameters: { ...input.inputParameters, ConnectionId: uuid() } } });
  assert.equal(foreign.value.ok, false); assert.equal(foreign.value.error?.code ?? foreign.value.code, 'OPERATION_UUID_REUSED', JSON.stringify(foreign.value).slice(0, 300));
  // The unguarded write with a NEW UUID and no words: still AUTHORIZATION_REQUIRED.
  const fresh = await w.access.portalWrite({ tenant: HOST, operationId: 'connections.delete', input, operationUuid: uuid() });
  assert.equal(fresh.error?.code, 'AUTHORIZATION_REQUIRED');
  assert.deepEqual(w.sends, [], 'no delete was ever sent');
  assert.deepEqual(filesWithMark([w.answers, w.small]), [], '.local\\answers keeps no owner words');
});

test('W-1 (the family, in the source): no continuation of the portal runtime gives authorize back', () => {
  const dir = path.join(import.meta.dirname, '..', '..', 'portal', 'runtime');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // continuation = {tool, arguments: {... authorize ...}} (authorize as a shorthand or a key), in any spelling of the spaces.
    for (const m of src.matchAll(/continuation\s*[:=]\s*\{\s*tool\s*:[^;]*?arguments\s*:\s*\{([^}]*)\}/g))
      if (/(^|[,{\s])authorize\s*([,:}]|$)/.test(m[1])) hits.push(f + ': ' + m[0].slice(0, 120));
  }
  assert.deepEqual(hits, []);
});
