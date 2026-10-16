// o11_publish on a real McpServer over InMemoryTransport, against the fake O11 bridge on an ephemeral loopback port.
// No Studio, no dotnet, no Python, nothing published; every folder is temporary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Publish, publishOutcome, withPublishLog, publishConsumersOf, DEFAULT_MESSAGE } from '../o11-publish.mjs';
import { o11Bridge, BridgeError } from '../o11-bridge.mjs';
import { WORDS_MARKER } from '../o11-cycle.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const WORDS = 'sim, pode publicar o Orders agora';
const HOST = 'dev.example.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHELL = /python|\.py\b|\.ps1|dotnet |ssam (connect|deliver|publish|doctor)|odc (attach|studio)|cdp_pages/i;
const STATUS = { tool: 'o11_studio', arguments: { command: 'status' } };
const ok = data => ({ success: true, data, error: null });
const fail = (error, extra = {}) => ({ success: false, data: null, error, ...extra });
const ACTIVE = { name: 'Orders', key: 'k-orders', kind: 'Web', environment: HOST, isModified: false, pendingDialogs: [] };
const CLEAN = { isValid: true, errors: 0, warnings: 1, total: 1, byType: { Warning: 1 }, messages: ['Warning W1: unused @ Orders'],
  rawMessages: [{ id: 'W1', type: 'Warning', key: 'w', path: 'Orders', detail: 'unused' }] };
const PUBLISHED_REPLY = ok({ module: 'Orders', published: true, lastUploadDateTime: '2026-10-02T10:00:00', state: 'CompletedWithSuccessNotOpenedInBrowser', isValid: true, elapsedMs: 42 });

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-publish-'));
  const sub = name => { const p = path.join(base, name); fs.mkdirSync(p, { recursive: true }); return p; };
  const root = sub('anvil'); const home = sub('home');
  const env = { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4', USERPROFILE: home, HOME: home, APPDATA: sub('appdata'),
    LOCALAPPDATA: sub('localappdata'), ANVIL_AUTHORITY_DIR: sub('authority') };
  let clock = Date.parse('2026-10-02T10:15:00.000Z');
  return { base, root, env, journal: path.join(root, '.local', 'journal', 'o11_publish.jsonl'), tasks: path.join(root, '.local', 'tasks'),
    now: () => new Date(clock += 1000), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// A programmable Studio: open_module selects, get_active_module / get_errors read the state, publish answers state.publish
// (an object, a function of the request, or undefined to stay silent). Every request is kept, in order, with the gate.
async function harness(t, state = {}, { publishTimeoutMs, assertSelected, port } = {}) {
  const box = sandbox(); t.after(box.cleanup);
  const events = []; const requests = [];
  const s = { active: ACTIVE, verdict: CLEAN, publish: PUBLISHED_REPLY, ...state };
  const fake = await fakeBridge(async request => {
    events.push(request.method); requests.push(request);
    switch (request.method) {
      case 'open_module': return s.open ?? ok({ name: request.params.name, opened: true, alreadyOpen: true, selected: true, serverSilentMode: false, elapsedMs: 3 });
      case 'get_active_module': return ok(s.active);
      case 'get_errors': return ok(s.verdict);
      case 'publish': return typeof s.publish === 'function' ? s.publish(request, box) : s.publish;
      case 'publish_log': return s.publishLog ?? fail('Unknown method: publish_log');
      default: return fail('Unknown method: ' + request.method);
    }
  });
  const real = o11Bridge({ port: port ?? fake.port, authorization: 'K' });
  // Only the test shortens the client's wait for the publish reply (the product waits timeoutSeconds + 60 s).
  const bridge = publishTimeoutMs ? { ...real, ok: (method, params, options) => real.ok(method, params, method === 'publish' ? { timeoutMs: publishTimeoutMs } : options) } : real;
  const server = new McpServer({ name: 'o11-publish-test', version: '1.0.0' });
  registerO11Publish(server, { root: box.root, env: box.env, lane: 'ss4', now: box.now, bridge,
    assertSelected: assertSelected ?? (async () => { events.push('assertSelected'); }) });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'o11-publish-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); await fake.close(); });
  const raw = args => client.callTool({ name: 'o11_publish', arguments: args }).catch(error => ({ isError: true, content: [{ type: 'text', text: error.message }], thrown: true }));
  const call = async args => {
    const reply = await raw(args);
    const value = JSON.parse(reply.content[0].text);
    assert.equal(reply.isError === true, value.ok === false, reply.content[0].text);
    assert.deepEqual(reply.structuredContent, value);
    assert.doesNotMatch(reply.content[0].text, SHELL);
    assert.ok(!reply.content[0].text.includes(WORDS), 'the words never come back');
    return value;
  };
  const journal = () => { try { return fs.readFileSync(box.journal, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const tasks = () => { try { return fs.readdirSync(box.tasks).map(n => JSON.parse(fs.readFileSync(path.join(box.tasks, n), 'utf8'))); } catch { return []; } };
  return { box, events, requests, call, raw, client, journal, tasks, sent: method => requests.filter(r => r.method === method) };
}

test('the tool is listed with its schema, destructive annotations and a description without shell', async t => {
  const h = await harness(t);
  const tool = (await h.client.listTools()).tools.find(x => x.name === 'o11_publish');
  assert.ok(tool, 'missing o11_publish');
  const schema = tool.inputSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['authorize', 'consumers', 'expectedEnvironment', 'message', 'module', 'refreshReferences', 'timeoutSeconds']);
  // authorize: the user's words, or absent when a standing grant covers the module for publish (contract I6).
  assert.ok(schema.required.includes('module') && !schema.required.includes('authorize'));
  assert.equal(schema.properties.consumers.type, 'boolean');
  assert.ok(!schema.required.includes('message') && !schema.required.includes('expectedEnvironment'));
  assert.equal(schema.properties.timeoutSeconds.minimum, 1); assert.equal(schema.properties.timeoutSeconds.maximum, 1800);
  assert.equal(schema.properties.timeoutSeconds.default, 600);
  assert.equal(schema.additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(schema), /password|secret|token|credential/i);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.match(tool.description, /"publicado"/); assert.match(tool.description, /TrueChange/); assert.match(tool.description, /never repeated/);
  assert.doesNotMatch(tool.description, SHELL);
  // Unknown keys and out-of-range values are refused before anything runs.
  for (const args of [{ module: 'Orders', authorize: WORDS, password: 'x' }, { module: 'Orders', authorize: WORDS, timeoutSeconds: 0 },
    { module: 'Orders', authorize: WORDS, timeoutSeconds: 1801 }, { module: 'Orders', authorize: WORDS, expectedEnvironment: 'https://dev.example.com' }, { module: '', authorize: WORDS }]) {
    const reply = await h.raw(args);
    assert.equal(reply.isError, true, JSON.stringify(args));
  }
  assert.deepEqual(h.events, []);
});

test('without the user\'s words nothing runs: no gate, no bridge', async t => {
  const h = await harness(t);
  const missing = await h.raw({ module: 'Orders' });
  assert.equal(missing.isError, true);
  for (const authorize of ['', '   ', WORDS_MARKER, '<words>']) {
    const value = await h.call({ module: 'Orders', authorize });
    assert.equal(value.code, 'WORDS_REQUIRED');
    assert.deepEqual(value.continuation.arguments, { module: 'Orders', authorize: WORDS_MARKER });
    assert.equal(value.continuation.tool, 'o11_publish');
  }
  assert.deepEqual(h.events, []); assert.deepEqual(h.journal(), []); assert.deepEqual(h.tasks(), []);
});

test('assertSelected runs before anything; a changed selection refuses with ssam_connect and no bridge call', async t => {
  const h = await harness(t, {}, { assertSelected: async () => { throw new Error('The selected Studio was restarted. Call ssam_connect {lane:"o11"} again before continuing.'); } });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.equal(value.code, 'STUDIO_NOT_SELECTED');
  assert.deepEqual(value.continuation.arguments, { lane: 'o11' }); assert.equal(value.continuation.tool, 'ssam_connect');
  assert.deepEqual(h.events, []);
});

test('published: the answer is "publicado" with lastPublication, after select, active module and TrueChange, with the words kept as a hash', async t => {
  let journalAtPublish = null;
  const h = await harness(t, { publish: (request, box) => { journalAtPublish = fs.readFileSync(box.journal, 'utf8'); return PUBLISHED_REPLY; } });
  const reply = await h.client.callTool({ name: 'o11_publish', arguments: { module: 'Orders', authorize: WORDS, expectedEnvironment: HOST } });
  // Section 3.2: the publication answers its lastPublication (by SSAM, from the publish result).
  assert.deepEqual(reply.structuredContent, { ok: true, result: 'publicado', lastPublication: { at: '2026-10-02T10:15:03.000Z', status: 'succeeded',
    version: null, author: null, by: 'ssam', source: 'publish-result' } });
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
  assert.equal(reply.isError, undefined);
  // The gate first, then the bridge in order, publish exactly once.
  assert.equal(h.events[0], 'assertSelected');
  assert.deepEqual(h.events.slice(1,4).sort(), ['bridge_manifest', 'ping', 'windows']);
  assert.deepEqual(h.events.slice(4), ['open_module', 'get_active_module', 'get_errors', 'ping', 'windows', 'publish']);
  assert.deepEqual(h.sent('open_module')[0].params, { name: 'Orders', environment: HOST, timeout: 120, silent: true });
  assert.deepEqual(h.sent('get_errors')[0].params, { max: 60, module_key: 'k-orders' });
  assert.deepEqual(h.sent('publish')[0].params, { message: DEFAULT_MESSAGE, timeout: 600, module_key: 'k-orders', environment: HOST });
  // The journal line exists before publish leaves, and holds only the sha256 of the words.
  assert.ok(journalAtPublish && journalAtPublish.includes(sha256(WORDS)));
  const lines = h.journal();
  assert.deepEqual(lines.map(l => l.event), ['start', 'end']);
  assert.match(lines[0].operationId, UUID); assert.equal(lines[1].operationId, lines[0].operationId);
  assert.equal(lines[0].wordsSha256, sha256(WORDS)); assert.equal(lines[0].module, 'Orders'); assert.equal(lines[0].moduleKey, 'k-orders');
  assert.equal(lines[1].outcome, 'published');
  const all = fs.readFileSync(h.box.journal, 'utf8') + JSON.stringify(h.tasks());
  assert.ok(!all.includes(WORDS), 'the words are never written');
  const [task] = h.tasks();
  assert.equal(task.tool, 'o11_publish'); assert.equal(task.state, 'ok'); assert.equal(task.result.result, 'publicado');
  assert.equal(task.summary.operationId, lines[0].operationId);
});

test('message and timeoutSeconds reach the bridge publish', async t => {
  const h = await harness(t);
  const reply = await h.client.callTool({ name: 'o11_publish', arguments: { module: 'orders', authorize: WORDS, message: 'Pedidos v2', timeoutSeconds: 900 } });
  assert.equal(reply.structuredContent.result, 'publicado');
  assert.deepEqual(h.sent('publish')[0].params, { message: 'Pedidos v2', timeout: 900, module_key: 'k-orders', environment: HOST });
  assert.deepEqual(h.sent('open_module')[0].params, { name: 'orders', timeout: 120, silent: true });
});

test('another module active after the selection: refused, nothing read further, nothing published', async t => {
  const h = await harness(t, { active: { ...ACTIVE, name: 'Customers', key: 'k-c' } });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.equal(value.code, 'MODULE_NOT_ACTIVE'); assert.match(value.error, /Customers/);
  assert.deepEqual(value.continuation.arguments, { command: 'open-module', args: { name: 'Orders' } });
  // Package 3, MB2 (DCIPS): the tabs of every window are read once for a tab of Orders to publish by key; none here.
  assert.equal(h.events[0], 'assertSelected');
  assert.deepEqual(h.events.slice(1,4).sort(), ['bridge_manifest', 'ping', 'windows']);
  assert.deepEqual(h.events.slice(4), ['open_module', 'get_active_module', 'list_open_modules']);
  assert.deepEqual(h.journal(), []); assert.deepEqual(h.tasks(), []);
});

test('the Studio on another environment: refused before TrueChange and publish', async t => {
  const h = await harness(t);
  const value = await h.call({ module: 'Orders', authorize: WORDS, expectedEnvironment: 'PROD.example.com' });
  assert.equal(value.code, 'ENVIRONMENT_MISMATCH'); assert.match(value.error, /dev\.example\.com/); assert.match(value.error, /prod\.example\.com/);
  assert.deepEqual(value.continuation, { tool: 'o11_studio', arguments: { command: 'status' }, why: value.continuation.why });
  assert.equal(h.sent('open_module')[0].params.environment, 'prod.example.com');
  assert.equal(h.events[0], 'assertSelected');
  assert.deepEqual(h.events.slice(1,4).sort(), ['bridge_manifest', 'ping', 'windows']);
  assert.deepEqual(h.events.slice(4), ['open_module', 'get_active_module']);
});

test('a pending dialog in the Studio: refused with the wait for the person', async t => {
  const h = await harness(t, { active: { ...ACTIVE, pendingDialogs: [{ kind: 'MessageBox', title: 'Unsaved changes', source: 'window' }] } });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.equal(value.code, 'DIALOG_BLOCKING'); assert.deepEqual(value.dialogs, [{ kind: 'MessageBox', title: 'Unsaved changes' }]);
  assert.deepEqual(value.continuation.arguments, { command: 'wait', args: { condition: 'no-dialogs' } });
  assert.equal(h.sent('publish').length, 0);
});

test('TrueChange errors come back and publish is NOT called', async t => {
  const verdict = { isValid: false, errors: 2, warnings: 1, total: 3, byType: { Error: 2, Warning: 1 },
    messages: ['Error E1: Required Value @ Orders / SaveOrder (ServerAction)', 'Error E2: Invalid Expression @ Orders / Total (Expression)', 'Warning W1: unused @ Orders'],
    rawMessages: [{ id: 'E1', type: 'Error', key: 'a', path: 'Orders / SaveOrder (ServerAction)', detail: 'Required Value' },
      { id: 'E2', type: 'Error', key: 'b', path: 'Orders / Total (Expression)', detail: 'Invalid Expression' },
      { id: 'W1', type: 'Warning', key: 'c', path: 'Orders', detail: 'unused' }] };
  const h = await harness(t, { verdict });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.equal(value.code, 'TRUECHANGE_ERRORS'); assert.equal(value.errors, 2); assert.equal(value.module, 'Orders');
  assert.deepEqual(value.messages, ['Error E1: Required Value @ Orders / SaveOrder (ServerAction)', 'Error E2: Invalid Expression @ Orders / Total (Expression)']);
  assert.match(value.error, /nothing was published/);
  assert.deepEqual(value.continuation.arguments, { command: 'errors' });
  assert.equal(h.sent('publish').length, 0);
  assert.equal(h.events[0], 'assertSelected');
  assert.deepEqual(h.events.slice(1,4).sort(), ['bridge_manifest', 'ping', 'windows']);
  assert.deepEqual(h.events.slice(4), ['open_module', 'get_active_module', 'get_errors']);
  assert.deepEqual(h.journal(), []); assert.deepEqual(h.tasks(), []);
});

test('a refusal of the bridge before running (executed:false) is short, with code and continuation', async t => {
  const h = await harness(t, { publish: fail('InvalidOperationException: the bridge refused this request', { executed: false }) });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.deepEqual(Object.keys(value).sort(), ['code', 'continuation', 'error', 'ok']);
  assert.equal(value.code, 'PUBLISH_REFUSED'); assert.equal(value.error, 'the bridge refused this request');
  assert.equal(value.continuation.tool, 'o11_studio');
  assert.equal(h.sent('publish').length, 1);
  assert.equal(h.journal().at(-1).outcome, 'refused'); assert.equal(h.tasks()[0].state, 'failed');
});

test('the checks of PublishHandler before the command started are refusals, not uncertain', async t => {
  const cases = [
    ['InvalidOperationException: Requested module identity is no longer active; nothing was executed', 'TARGET_CHANGED'],
    ['InvalidOperationException: \'Orders\' has TrueChange errors: fix them before publishing (get_errors)', 'TRUECHANGE_ERRORS'],
    ['InvalidOperationException: \'Orders\' already has a server operation running: Publish', 'STUDIO_BUSY'],
    ['InvalidOperationException: Publish.(IAggregatorPresenter, IPresenter, string) not found in this build', 'PUBLISH_UNSUPPORTED'],
  ];
  for (const [error, code] of cases) {
    const h = await harness(t, { publish: fail(error) });
    const value = await h.call({ module: 'Orders', authorize: WORDS });
    assert.equal(value.code, code, error); assert.equal(value.outcome, undefined); assert.ok(value.continuation?.tool, code);
    assert.doesNotMatch(value.error, /get_errors/);
  }
});

test('a failure reported by the Studio after running is a failed publication, never "publicado"', async t => {
  const h = await harness(t, { publish: fail('publish: \'Orders\' completed with failure; an upload is not a successful publication. Check the server compilation/deployment messages.') });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.equal(value.code, 'PUBLISH_FAILED'); assert.equal(value.outcome, 'failed'); assert.match(value.operationId, UUID);
  assert.deepEqual(value.continuation.arguments, { command: 'status' });
  assert.equal(h.sent('publish').length, 1);
});

// What PublishHandler.Failed attaches (data.publishLog, built by PublishLog.Project from the Studio's 1-Click Publish tab).
const ORDERS_LOG = {
  found: true, module: 'Orders', moduleKey: 'k-orders', environment: HOST, serverOperationId: 3, operation: 'Publish', status: 'failed',
  state: 'CompletedWithFailure', stage: 'compile', failedStage: 'compile', triggeredBy: 'bridge', errors: 2, warnings: 1,
  steps: [{ stage: 'upload', text: 'Uploading' }, { stage: 'compile', text: 'Compiling Orders' }],
  messages: [
    { type: 'Warning', stage: 'compile', text: 'Deprecated function used' },
    { type: 'Error', stage: 'compile', text: "Invalid SQL in 'GetOrders'", detail: "Incorrect syntax near 'FROM'.", id: 'SQLInvalid',
      element: { name: 'GetOrders', key: 'act-9', kind: 'ServerAction', path: 'GetOrders (ServerAction)', source: 'model' } },
    { type: 'Error', stage: 'compile', text: 'Code generation failed', extraInfo: 'step 4' }],
  omitted: 0,
};
const FAILED_TEXT = 'publish: \'Orders\' completed with failure; an upload is not a successful publication.';

test('a failed publication carries every message the Studio showed, errors first, and a continuation to the element to fix', async t => {
  const h = await harness(t, { publish: fail(FAILED_TEXT + " compile error: Invalid SQL in 'GetOrders'", { data: { publishLog: ORDERS_LOG } }) });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.equal(value.code, 'PUBLISH_FAILED'); assert.equal(value.outcome, 'failed'); assert.match(value.operationId, UUID);
  assert.equal(value.failedStage, 'compile'); assert.equal(value.errors, 2); assert.equal(value.warnings, 1); assert.equal(value.serverOperationId, 3);
  assert.deepEqual(value.messages.map(m => m.type), ['Error', 'Error', 'Warning']);
  assert.deepEqual(value.messages[0], { type: 'Error', stage: 'compile', text: "Invalid SQL in 'GetOrders'", detail: "Incorrect syntax near 'FROM'.",
    element: { name: 'GetOrders', key: 'act-9', kind: 'ServerAction', path: 'GetOrders (ServerAction)' } });
  assert.equal(value.messages[1].extraInfo, 'step 4');
  assert.match(value.error, /failed at compile: Invalid SQL in 'GetOrders'; it is not published/);
  assert.deepEqual(value.continuation, { tool: 'ssam_map', arguments: { lane: 'o11', target: 'Orders', name: 'GetOrders' },
    why: value.continuation.why });
  assert.match(value.continuation.why, /Corrija em GetOrders.*o11_publish com as palavras do usuário/);
  assert.equal(h.sent('publish').length, 1); assert.equal(h.sent('publish_log').length, 0, 'the messages came with the refusal');
  assert.equal(h.journal().at(-1).outcome, 'failed');
});

test('a failure without messages reads them once with publish_log (an older reply); an older bridge keeps the short refusal', async t => {
  const h = await harness(t, { publish: fail(FAILED_TEXT + ' Check the server compilation/deployment messages.'), publishLog: ok(ORDERS_LOG) });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.equal(value.code, 'PUBLISH_FAILED'); assert.equal(value.messages.length, 3); assert.equal(value.continuation.tool, 'ssam_map');
  assert.deepEqual(h.sent('publish_log').map(r => r.params), [{ module: 'Orders', max: 200 }]);
  assert.equal(h.sent('publish').length, 1);
  const other = await harness(t, { publish: fail(FAILED_TEXT), publishLog: ok({ ...ORDERS_LOG, module: 'Customers' }) });
  const mismatch = await other.call({ module: 'Orders', authorize: WORDS });
  assert.equal(mismatch.messages, undefined, 'the log of another module is never attached');
  assert.deepEqual(mismatch.continuation.arguments, { command: 'status' });
});

test('a server message that quotes a pre-start sentence is still a failed publication', async t => {
  const h = await harness(t, { publish: fail(FAILED_TEXT + ' compile error: Requested module identity is no longer active; nothing was executed', { data: { publishLog: ORDERS_LOG } }) });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.equal(value.code, 'PUBLISH_FAILED'); assert.equal(value.outcome, 'failed');
});

test('withPublishLog: errors are never cut, warnings fill the limit, a log not found changes nothing', () => {
  const base = { ok: false, code: 'PUBLISH_FAILED', outcome: 'failed', error: 'x', continuation: STATUS };
  const many = { ...ORDERS_LOG, messages: [...Array.from({ length: 5 }, (_, i) => ({ type: 'Error', stage: 'deploy', text: 'e' + i })),
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'Warning', stage: 'deploy', text: 'w' + i })), { type: 'Info', stage: 'deploy', text: 'i' }], omitted: 2 };
  const value = withPublishLog(base, many, 'Orders', 6);
  assert.deepEqual(value.messages.map(m => m.text), ['e0', 'e1', 'e2', 'e3', 'e4', 'w0']);
  assert.equal(value.messagesOmitted, 7);
  assert.deepEqual(value.continuation.arguments, { command: 'publish-log', args: { module: 'Orders' } });
  assert.equal(withPublishLog(base, { found: false, reason: 'closed' }, 'Orders'), base);
  assert.equal(withPublishLog(base, undefined, 'Orders'), base);
});

test('a timeout after the request left is uncertain: never repeated, check the Studio first', async t => {
  const h = await harness(t, { publish: () => undefined }, { publishTimeoutMs: 200 });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.equal(value.ok, false); assert.equal(value.outcome, 'uncertain'); assert.equal(value.code, 'PUBLISH_UNCERTAIN');
  assert.deepEqual({ tool: value.continuation.tool, arguments: value.continuation.arguments }, STATUS);
  assert.match(value.continuation.why, /antes de qualquer nova tentativa/);
  assert.match(value.error, /Nothing was repeated/);
  assert.equal(h.sent('publish').length, 1, 'publish is sent once and never repeated');
  const lines = h.journal();
  assert.deepEqual(lines.map(l => l.event), ['start', 'end']); assert.equal(lines[1].outcome, 'uncertain'); assert.equal(value.operationId, lines[0].operationId);
  assert.equal(h.tasks()[0].state, 'uncertain');
});

test('an unconfirmed end reported by the bridge is uncertain too', async t => {
  for (const error of ['InvalidOperationException: publish: \'Orders\' still Running after 600 s',
    'publish: \'Orders\' has no observed publication process; completion is unknown. Reconcile the server version before retrying.',
    'InvalidOperationException: Publish process belongs to another module; result is unknown']) {
    const h = await harness(t, { publish: fail(error) });
    const value = await h.call({ module: 'Orders', authorize: WORDS });
    assert.equal(value.outcome, 'uncertain', error); assert.equal(value.code, 'PUBLISH_UNCERTAIN');
    assert.deepEqual(value.continuation.arguments, { command: 'status' });
    assert.equal(h.sent('publish').length, 1);
  }
});

test('no bridge on the lane: refused with ssam_connect, nothing published', async t => {
  const closed = await fakeBridge(() => undefined); const port = closed.port; await closed.close();
  const h = await harness(t, {}, { port });
  const value = await h.call({ module: 'Orders', authorize: WORDS });
  assert.equal(value.code, 'O11_NOT_CONNECTED'); assert.equal(value.continuation.tool, 'ssam_connect');
  assert.deepEqual(h.journal(), []);
});

// I11: the cascade of a producer that is not a Studio tab (an extension published by o11_extension).
test('publishConsumersOf publishes each consumer of a non-tab producer and stops at the first uncertain one', async t => {
  const box = sandbox(); t.after(box.cleanup);
  const requests = []; let active = null;
  const fake = await fakeBridge(async request => {
    requests.push(request);
    switch (request.method) {
      case 'open_module': active = request.params.name; return ok({ name: active, opened: true, alreadyOpen: true, selected: true, serverSilentMode: false, elapsedMs: 3 });
      case 'get_active_module': return ok({ ...ACTIVE, name: active, key: 'k-' + active });
      case 'get_errors': return ok(CLEAN);
      case 'refresh_references': return ok({ module: active, changed: true, refreshed: request.params.producers });
      case 'publish': return active === 'Sales' ? fail('InvalidOperationException: publish: \'Sales\' still Running after 600 s') : ok({ module: active, published: true });
      default: return fail('Unknown method: ' + request.method);
    }
  });
  t.after(() => fake.close());
  const seen = [];
  const deps = { root: box.root, env: box.env, lane: 'ss4', now: box.now, bridge: o11Bridge({ port: fake.port, authorization: 'K' }), assertSelected: async () => {},
    consumersOf: async request => { seen.push(request); return { rows: [{ Name: 'Billing' }, { Name: 'ZZHybridXifLab' }, { Name: 'Sales' }, { Name: 'Shipping' }] }; } };
  const value = await publishConsumersOf({ producer: { name: 'ZZHybridXifLab', key: 'ext-key-1', environment: HOST }, words: 'pode publicar ZZHybridXifLab, Billing, Sales e Shipping', message: 'xif v2' }, deps);
  assert.deepEqual(seen, [{ module: 'ZZHybridXifLab', moduleKey: 'ext-key-1', host: HOST }]);
  assert.equal(value.ok, false); assert.equal(value.code, 'CONSUMERS_UNCERTAIN');
  assert.deepEqual(value.consumers, [{ module: 'Billing', outcome: 'published' }, { module: 'Sales', outcome: 'uncertain', code: 'PUBLISH_UNCERTAIN' }, { module: 'Shipping', outcome: 'skipped' }]);
  // Each consumer is refreshed against the producer before its publish; Shipping is never touched; nothing is repeated.
  assert.deepEqual(requests.filter(r => r.method === 'refresh_references').map(r => r.params.producers), [['ZZHybridXifLab'], ['ZZHybridXifLab']]);
  assert.deepEqual(requests.filter(r => r.method === 'publish').map(r => [r.params.module_key, r.params.message]), [['k-Billing', 'xif v2'], ['k-Sales', 'xif v2']]);
  assert.ok(!requests.some(r => r.params?.name === 'Shipping'));
  // Every consumer published: ok; consumers unreadable: CONSUMERS_UNKNOWN and nothing touched.
  const all = await publishConsumersOf({ producer: { name: 'ZZHybridXifLab', key: 'ext-key-1', environment: HOST }, words: 'pode' },
    { ...deps, consumersOf: async () => ({ rows: [{ Name: 'Billing' }] }) });
  assert.deepEqual(all, { ok: true, consumers: [{ module: 'Billing', outcome: 'published' }] });
  const before = requests.length;
  const unknown = await publishConsumersOf({ producer: { name: 'ZZHybridXifLab', key: 'ext-key-1', environment: HOST }, words: 'pode' },
    { ...deps, consumersOf: async () => { throw new Error('GetConsumers failed'); } });
  assert.equal(unknown.code, 'CONSUMERS_UNKNOWN'); assert.equal(requests.length, before);
});

test('publishOutcome: the pure classification', () => {
  const active = { name: 'Orders' };
  assert.deepEqual(publishOutcome({ data: { module: 'Orders', published: true } }, active), { ok: true, result: 'publicado' });
  assert.equal(publishOutcome({ data: { module: 'Orders', published: false } }, active).outcome, 'uncertain');
  assert.equal(publishOutcome({ data: { module: 'Customers', published: true } }, active).outcome, 'uncertain');
  assert.equal(publishOutcome({ error: new BridgeError('connect ECONNREFUSED', { code: 'BRIDGE_NOT_LISTENING', executed: false }) }, active).code, 'O11_NOT_CONNECTED');
  assert.equal(publishOutcome({ error: new BridgeError('Bridge closed publish without a reply', { code: 'BRIDGE_NO_REPLY' }) }, active).outcome, 'uncertain');
  const untrusted = new BridgeError('UnauthorizedAccessException: not a trusted Hybrid controller', { code: 'BRIDGE_REFUSED', executed: false, reply: { success: false, executed: false } });
  assert.equal(publishOutcome({ error: untrusted }, active).code, 'O11_NOT_AUTHORIZED');
});
