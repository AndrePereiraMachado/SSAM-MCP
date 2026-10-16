import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createWarmServer, snapshotTool, toolsSnapshotKey, toolsSnapshotPath } from '../warm-start.mjs';
import { createCallDeadline } from '../call-deadline.mjs';
import { continuationInput, relaxTool } from '../tool-input.mjs';

const identity = { release: { head: 'head', facadeSha256: 'facade', catalogSha256: 'catalog' } };
const env = { SSAM_NO_WARM: '1', SSAM_MCP_LANES: 'o11,odc', SSAM_APP_HOOK_TOOLS: '0' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// InMemoryTransport keeps undefined optional SDK fields; JSON-RPC over stdio omits them.
const stableTools = tools => JSON.parse(JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name))));
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fakeServer({ title = 'Echo', second = false, meta = true, output = false, structured = true, invalidOutput = false, canRequestInput = false, doctor = false } = {}, supplied, registerLive) {
  const server = supplied ?? new McpServer({ name: 'warm-test', version: '1' }, { instructions: 'saved instructions' });
  const register = registerLive ?? server.registerTool.bind(server);
  server.ssamInstructions = 'saved instructions';
  server.ssamTools = [];
  server.ssamHandlers = new Map(); server.ssamConfigs = new Map();
  const add = name => {
    const config = { title, description: 'A fake', inputSchema: z.object({ value: z.string() }).strict(),
      annotations: { readOnlyHint: true }, ...(meta || canRequestInput ? { _meta: { ...(meta ? { source: 'fake' } : {}), ...(canRequestInput ? { canRequestInput: true } : {}) } } : {}),
      ...(output ? { outputSchema: z.object({ ok: z.boolean(), name: z.string(), value: z.string() }) } : {}) };
    const handler = async args => { const value = { ok: true, name, value: invalidOutput ? 42 : args.value }; return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(structured ? { structuredContent: value } : {}) }; };
    register(name, config, handler);
    server.ssamConfigs.set(name, config);
    server.ssamTools.push(snapshotTool(name, config)); server.ssamHandlers.set(name, handler);
  };
  add('echo'); if (second) add('second'); if (doctor) add('ssam_doctor');
  return server;
}
async function connect(t, server) {
  const client = new Client({ name: 'warm-start-test', version: '1' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
async function prime(root, options = {}) {
  const cold = await createWarmServer({ root, identity, env, build: async (server, registerLive) => fakeServer(options, server, registerLive) });
  await cold.server.close();
  return JSON.parse(fs.readFileSync(toolsSnapshotPath(root, toolsSnapshotKey(identity, env)), 'utf8'));
}

function contractServer(server, registerLive, { alias = false, transforms = false, validationThrow = false, observed = () => {} } = {}) {
  server ??= new McpServer({ name: 'contract-test', version: '1' });
  const register = registerLive ?? server.registerTool.bind(server);
  observed(server);
  const valueSchema = validationThrow ? z.string().transform(() => { throw new Error('validation transform failed'); }) : transforms ? z.string().trim().default('default value') : z.string();
  let config = { inputSchema: z.object(alias ? { budgetBytes: z.number() } : { value: valueSchema }).strict(), annotations: { readOnlyHint: true } };
  let handler = async args => ({ content: [{ type: 'text', text: JSON.stringify(args) }], structuredContent: args });
  if (alias) ({ config, handler } = relaxTool('strict_input', config, handler));
  config = continuationInput(config);
  register('strict_input', config, handler);
  server.ssamInstructions = '';
  server.ssamTools = [snapshotTool('strict_input', config)];
  server.ssamHandlers = new Map([['strict_input', handler]]);
  server.ssamConfigs = new Map([['strict_input', config]]);
  return server;
}

test('cached assembly populates the same McpServer instance that is already connected', async t => {
  const root = sandbox(t);
  const cold = await createWarmServer({ root, identity, env, build: contractServer }); await cold.server.close();
  let assembled, registered, updates = 0;
  const register = McpServer.prototype.registerTool;
  McpServer.prototype.registerTool = function (name, ...args) { registered = register.call(this, name, ...args); return registered; };
  t.after(() => { McpServer.prototype.registerTool = register; });
  const cached = await createWarmServer({ root, identity, env,
    build: async (server, registerLive) => { await delay(50); return contractServer(server, registerLive, { observed: value => { assembled = value; } }); } });
  const update = registered.update.bind(registered);
  registered.update = (...args) => { updates++; return update(...args); };
  const client = await connect(t, cached.server), notifications = [];
  client.setNotificationHandler('notifications/tools/list_changed', () => notifications.push('changed'));
  await cached.ready; await delay(0);
  assert.equal(assembled, cached.server);
  assert.equal(await cached.ready, cached.server);
  assert.deepEqual(notifications, [], 'an equal cached list does not notify');
  assert.equal(updates, 0, 'an existing equal name binds no new registration or callback');
});

test('invalid strict input before and after cached readiness equals the cold SDK refusal byte for byte', async t => {
  const root = sandbox(t);
  const cold = await createWarmServer({ root, identity, env, build: contractServer });
  const direct = await connect(t, cold.server);
  const invalid = [{}, { value: 7 }, { value: 'valid', unknown: 1 }];
  const expected = [];
  for (const args of invalid) expected.push(await direct.callTool({ name: 'strict_input', arguments: args }));
  assert.ok(expected.every(answer => answer.isError));
  const cached = await createWarmServer({ root, identity, env,
    build: async (server, registerLive) => { await delay(100); return contractServer(server, registerLive); } });
  const client = await connect(t, cached.server);
  const before = await Promise.all(invalid.map(args => client.callTool({ name: 'strict_input', arguments: args })));
  assert.deepEqual(before, expected);
  await cached.ready;
  for (let i = 0; i < invalid.length; i++) assert.deepEqual(await client.callTool({ name: 'strict_input', arguments: invalid[i] }), expected[i]);
});

test('adjustable aliases before and after cached readiness equal the cold input layer', async t => {
  const root = sandbox(t);
  const make = (server, registerLive) => contractServer(server, registerLive, { alias: true });
  const cold = await createWarmServer({ root, identity, env, build: make });
  const direct = await connect(t, cold.server);
  const args = { budget: 8000 };
  const expected = await direct.callTool({ name: 'strict_input', arguments: args });
  assert.equal(expected.structuredContent.budgetBytes, 8000);
  assert.ok(expected.structuredContent.inputAdjusted.some(entry => entry.rule === 'alias'));
  const cached = await createWarmServer({ root, identity, env,
    build: async (server, registerLive) => { await delay(100); return make(server, registerLive); } });
  const client = await connect(t, cached.server);
  assert.deepEqual(await client.callTool({ name: 'strict_input', arguments: args }), expected);
  await cached.ready;
  assert.deepEqual(await client.callTool({ name: 'strict_input', arguments: args }), expected);
});

test('live SDK defaults and transforms run identically before and after cached readiness', async t => {
  const root = sandbox(t);
  const make = (server, registerLive) => contractServer(server, registerLive, { transforms: true });
  const cold = await createWarmServer({ root, identity, env, build: make });
  const direct = await connect(t, cold.server);
  const args = [{ value: '  trimmed  ' }, {}];
  const expected = await Promise.all(args.map(arguments_ => direct.callTool({ name: 'strict_input', arguments: arguments_ })));
  assert.equal(expected[0].structuredContent.value, 'trimmed');
  assert.equal(expected[1].structuredContent.value, 'default value');
  const cached = await createWarmServer({ root, identity, env,
    build: async (server, registerLive) => { await delay(100); return make(server, registerLive); } });
  const client = await connect(t, cached.server);
  assert.deepEqual(await Promise.all(args.map(arguments_ => client.callTool({ name: 'strict_input', arguments: arguments_ }))), expected);
  await cached.ready;
  assert.deepEqual(await Promise.all(args.map(arguments_ => client.callTool({ name: 'strict_input', arguments: arguments_ }))), expected);
});

test('a thrown input validator before and after cached readiness equals the cold SDK error', async t => {
  const root = sandbox(t);
  const make = (server, registerLive) => contractServer(server, registerLive, { validationThrow: true });
  const cold = await createWarmServer({ root, identity, env, build: make });
  const direct = await connect(t, cold.server), args = { value: 'throws in validation' };
  const expected = await direct.callTool({ name: 'strict_input', arguments: args });
  assert.deepEqual(expected, { content: [{ type: 'text', text: 'validation transform failed' }], isError: true });
  const deadline = createCallDeadline({ root, timeoutMs: 150, env });
  const cached = await createWarmServer({ root, identity, env, wrap: (name, handler) => deadline.wrap(name, handler),
    build: async (server, registerLive) => { await delay(50); return make(server, registerLive); } });
  const client = await connect(t, cached.server);
  assert.deepEqual(await client.callTool({ name: 'strict_input', arguments: args }), expected);
  await cached.ready;
  assert.deepEqual(await client.callTool({ name: 'strict_input', arguments: args }), expected);
});

test('snapshot tools are the SDK list, and a cold start writes the complete list', async t => {
  const root = sandbox(t);
  const result = await createWarmServer({ root, identity, env, build: async (server, registerLive) => fakeServer({ second: true }, server, registerLive) });
  assert.equal(result.snapshotUsed, false);
  const client = await connect(t, result.server);
  const live = (await client.listTools()).tools;
  assert.deepEqual(stableTools(result.server.ssamTools), stableTools(live));
  const saved = JSON.parse(fs.readFileSync(toolsSnapshotPath(root, toolsSnapshotKey(identity, env)), 'utf8'));
  assert.deepEqual(saved.tools, stableTools(live));
  assert.equal(saved.instructions, client.getInstructions());
});

test('a saved list initializes and lists before a real build delayed two seconds', async t => {
  const root = sandbox(t); const saved = await prime(root);
  let built = false;
  const result = await createWarmServer({ root, identity, env, build: async (server, registerLive) => { await delay(2000); built = true; return fakeServer({}, server, registerLive); } });
  assert.equal(result.snapshotUsed, true);
  const started = performance.now();
  const client = await connect(t, result.server);
  assert.ok(performance.now() - started < 200, 'initialize does not await the real build');
  assert.deepEqual(stableTools((await client.listTools()).tools), saved.tools);
  assert.ok(performance.now() - started < 200, 'tools/list does not await the real build');
  assert.equal(built, false);
  const answer = await client.callTool({ name: 'echo', arguments: { value: 'before ready' } });
  assert.deepEqual(answer.structuredContent, { ok: true, name: 'echo', value: 'before ready' });
  await result.ready;
});

test('a call awaiting ready is covered by the deadline and accepts continueTask with required inputs intact', async t => {
  const root = sandbox(t); await prime(root);
  const deadline = createCallDeadline({ root, timeoutMs: 200, env });
  const result = await createWarmServer({ root, identity, env,
    wrap: (name, handler) => deadline.wrap(name, handler),
    build: async (server, registerLive) => { await delay(550); return fakeServer({}, server, registerLive); } });
  const client = await connect(t, result.server);
  const listed = (await client.listTools()).tools.find(tool => tool.name === 'echo');
  assert.deepEqual(listed.inputSchema.required, ['value']);
  const started = performance.now();
  let answer = await client.callTool({ name: 'echo', arguments: { value: 'delayed' } });
  assert.ok(performance.now() - started <= 230);
  assert.equal(answer.structuredContent.state, 'running');
  while (answer.structuredContent.state === 'running') {
    const next = answer.structuredContent.continuation;
    answer = await client.callTool({ name: next.tool, arguments: next.arguments });
  }
  assert.deepEqual(answer.structuredContent, { ok: true, name: 'echo', value: 'delayed' });
});

test('a stale list updates existing registrations, adds tools, clears old metadata, notifies once and rewrites', async t => {
  const root = sandbox(t); await prime(root);
  const friction = [], notifications = [];
  const register = McpServer.prototype.registerTool, registrations = [];
  let counting = false;
  McpServer.prototype.registerTool = function (name, ...args) { if (counting) registrations.push(name); return register.call(this, name, ...args); };
  t.after(() => { McpServer.prototype.registerTool = register; });
  const result = await createWarmServer({ root, identity, env,
    onStale: value => friction.push(value), build: async (server, registerLive) => { await delay(100); return fakeServer({ title: 'New Echo', second: true, meta: false }, server, registerLive); } });
  counting = true;
  const client = await connect(t, result.server);
  client.setNotificationHandler('notifications/tools/list_changed', () => notifications.push('changed'));
  await result.ready; await delay(0);
  const live = stableTools((await client.listTools()).tools);
  assert.deepEqual(live, stableTools((await result.ready).ssamTools));
  assert.equal(live[0].title, 'New Echo'); assert.equal('_meta' in live[0], false);
  assert.equal(friction.length, 1); assert.equal(friction[0].code, 'TOOL_LIST_SNAPSHOT_STALE');
  assert.equal(notifications.length, 1);
  assert.deepEqual(registrations, ['second'], 'existing names update without a second SDK registration');
  const saved = JSON.parse(fs.readFileSync(toolsSnapshotPath(root, toolsSnapshotKey(identity, env)), 'utf8'));
  assert.deepEqual(saved.tools, live);
});

test('the snapshot identity separates lanes and app hook tools; incomplete identity and disable never cache', async t => {
  const root = sandbox(t);
  const key = toolsSnapshotKey(identity, env);
  assert.notEqual(key, toolsSnapshotKey(identity, { ...env, SSAM_MCP_LANES: 'o11' }));
  assert.notEqual(key, toolsSnapshotKey(identity, { ...env, SSAM_APP_HOOK_TOOLS: '1' }));
  assert.notEqual(toolsSnapshotKey(identity, env, ['--profile', 'app']), toolsSnapshotKey(identity, env, ['--profile', 'developer']));
  assert.notEqual(key, toolsSnapshotKey(identity, env, ['--profile', 'app']));
  assert.equal(toolsSnapshotKey({ release: { ...identity.release, head: null } }, env), null);
  let builds = 0;
  for (const options of [{ identity: { release: { ...identity.release, facadeSha256: null } } }, { env: { ...env, SSAM_TOOLS_SNAPSHOT_DISABLE: '1' } }]) {
    const result = await createWarmServer({ root, identity, env, ...options, build: async (server, registerLive) => { builds++; return fakeServer({}, server, registerLive); } });
    assert.equal(result.snapshotUsed, false); await result.server.close();
  }
  assert.equal(builds, 2); assert.equal(fs.existsSync(path.join(root, '.local', 'mcp')), false);
});

test('tools removed by the real assembly disappear from a stale cached surface', async t => {
  const root = sandbox(t); await prime(root, { second: true });
  const result = await createWarmServer({ root, identity, env, build: async (server, registerLive) => { await delay(50); return fakeServer({}, server, registerLive); } });
  const client = await connect(t, result.server);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'second'));
  await result.ready;
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo']);
});

test('the real SSAM registration snapshot matches the entire SDK list and cached calls use its internal handlers', async t => {
  const root = sandbox(t);
  const { createSsamServer } = await import('../ssam.mjs');
  const make = (server, registerLive) => createSsamServer({ o11: false, odc: true, deps: { server, registerTool: registerLive,
    identity: { read: () => identity }, answersRoot: root, odcRoot: root,
    lock: { o11Root: root, odcRoot: root, connection: () => null },
    odcFacade: async () => {
      const fake = new McpServer({ name: 'fake-odc', version: '1' });
      fake.registerTool('studio_echo', { description: 'Fake read', inputSchema: z.object({ value: z.string() }), annotations: { readOnlyHint: true } }, async args => {
        const value = { ok: true, echoed: args.value }; return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      });
      return fake;
    }
  } });
  const cold = await createWarmServer({ root, identity, env, build: make });
  const direct = await connect(t, cold.server);
  const live = stableTools((await direct.listTools()).tools);
  assert.deepEqual(stableTools(cold.server.ssamTools), live, 'every locally registered tool is captured exactly');
  assert.ok(live.every(tool => tool.inputSchema.properties.continueTask));
  const expected = await direct.callTool({ name: 'studio_echo', arguments: { value: 'same handler' } });
  const cached = await createWarmServer({ root, identity, env, build: async (server, registerLive) => { await delay(100); return make(server, registerLive); } });
  assert.equal(cached.snapshotUsed, true);
  const client = await connect(t, cached.server);
  assert.deepEqual(stableTools((await client.listTools()).tools), live);
  const final = await client.callTool({ name: 'studio_echo', arguments: { value: 'same handler' } });
  assert.deepEqual(final, expected, 'the cached surface invokes the existing internal handler, preserving the answer');
  await cached.ready;
});

test('removing an output schema clears its SDK projection and permits the new text-only response', async t => {
  const root = sandbox(t); await prime(root, { output: true });
  const register = McpServer.prototype.registerTool;
  let registered;
  McpServer.prototype.registerTool = function (name, ...args) {
    const value = register.call(this, name, ...args); if (name === 'echo') registered = value; return value;
  };
  let result;
  try { result = await createWarmServer({ root, identity, env, build: async (server, registerLive) => { await delay(50); return fakeServer({ structured: false }, server, registerLive); } }); }
  finally { McpServer.prototype.registerTool = register; }
  const client = await connect(t, result.server);
  assert.ok((await client.listTools()).tools[0].outputSchema);
  await result.ready;
  assert.equal((await client.listTools()).tools[0].outputSchema, undefined);
  // Inspect the public RegisteredTool returned by registerTool, including its memoised projection schema.
  assert.equal(registered.outputSchema, undefined);
  assert.equal(registered.outputSchemaJson, undefined);
  const answer = await client.callTool({ name: 'echo', arguments: { value: 'text only' } });
  assert.notEqual(answer.isError, true, 'the old schema would refuse a response without structuredContent');
  assert.equal(answer.structuredContent, undefined);
  assert.deepEqual(JSON.parse(answer.content[0].text), { ok: true, name: 'echo', value: 'text only' });
});

test('a cached output schema still validates the real internal handler response', async t => {
  const root = sandbox(t); await prime(root, { output: true });
  const result = await createWarmServer({ root, identity, env, build: async (server, registerLive) => fakeServer({ output: true, invalidOutput: true }, server, registerLive) });
  const client = await connect(t, result.server);
  const answer = await client.callTool({ name: 'echo', arguments: { value: 'invalid fake response' } });
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /Output validation error/);
});

test('a slow stale diagnostic runs in the background and records failure without exposing its raw error', { timeout: 2000 }, async t => {
  const root = sandbox(t); await prime(root);
  const deadline = createCallDeadline({ root, timeoutMs: 150, env });
  const logs = [];
  let diagnosed;
  const diagnosticDone = new Promise(resolve => { diagnosed = resolve; });
  const result = await createWarmServer({ root, identity, env, wrap: (name, handler) => deadline.wrap(name, handler),
    build: async (server, registerLive) => { await delay(40); return fakeServer({ title: 'Updated title' }, server, registerLive); },
    onStale: async () => { await delay(300); throw new Error('private-diagnostic-detail'); },
    log: value => { logs.push(value); diagnosed(); } });
  const client = await connect(t, result.server);
  const answer = await client.callTool({ name: 'echo', arguments: { value: 'ready without diagnostic' } });
  assert.deepEqual(answer.structuredContent, { ok: true, name: 'echo', value: 'ready without diagnostic' }, 'the diagnostic must not consume the call deadline');
  await diagnosticDone;
  assert.ok(logs.some(value => value.code === 'TOOL_LIST_SNAPSHOT_DIAGNOSTIC_FAILED'));
  assert.doesNotMatch(JSON.stringify(logs), /private-diagnostic-detail/);
});

test('cached strict output schemas accept a deadline running envelope and still require the original final result', async t => {
  const root = sandbox(t);
  const make = (supplied, registerLive) => {
    const server = supplied ?? new McpServer({ name: 'strict-output', version: '1' }, { instructions: 'strict result' });
    const register = registerLive ?? server.registerTool.bind(server);
    // Use the same schema extension as the real served registration. The cache must not extend it a second time.
    const config = continuationInput({ inputSchema: z.object({}), outputSchema: z.object({ result: z.number() }).strict(), annotations: { readOnlyHint: true } });
    const handler = async () => ({ content: [{ type: 'text', text: '{"result":42}' }], structuredContent: { result: 42 } });
    register('strict_result', config, handler);
    server.ssamConfigs = new Map([['strict_result', config]]);
    server.ssamInstructions = 'strict result'; server.ssamTools = [snapshotTool('strict_result', config)]; server.ssamHandlers = new Map([['strict_result', handler]]);
    return server;
  };
  const cold = await createWarmServer({ root, identity, env, build: make }); await cold.server.close();
  const deadline = createCallDeadline({ root, timeoutMs: 150, env });
  const cached = await createWarmServer({ root, identity, env, wrap: (name, handler) => deadline.wrap(name, handler),
    build: async (server, registerLive) => { await delay(350); return make(server, registerLive); } });
  const client = await connect(t, cached.server);
  let answer = await client.callTool({ name: 'strict_result', arguments: {} });
  assert.equal(answer.structuredContent?.state, 'running', 'the output schema must permit the envelope that carries continueTask');
  const joined = await client.callTool({ name: 'strict_result', arguments: {} });
  assert.equal(joined.structuredContent?.state, 'running');
  assert.equal(joined.structuredContent?.joined, true, 'joined metadata belongs to the announced running schema');
  while (answer.structuredContent?.state === 'running') {
    const next = answer.structuredContent.continuation;
    answer = await client.callTool({ name: next.tool, arguments: next.arguments });
  }
  assert.deepEqual(answer.structuredContent, { result: 42 });
});

test('a strict cached output accepts resumedFrom metadata while the original final schema stays strict', async t => {
  const root = sandbox(t);
  let invalid = false;
  const make = (supplied, registerLive) => {
    const server = supplied ?? new McpServer({ name: 'strict-output', version: '1' }, { instructions: 'strict result' });
    const register = registerLive ?? server.registerTool.bind(server);
    const config = continuationInput({ inputSchema: z.object({}), outputSchema: z.object({ result: z.number() }).strict(), annotations: { readOnlyHint: true } });
    const handler = async () => {
      const value = { result: invalid ? 'not a number' : 42 };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    };
    register('strict_result', config, handler);
    server.ssamConfigs = new Map([['strict_result', config]]);
    server.ssamInstructions = 'strict result'; server.ssamTools = [snapshotTool('strict_result', config)]; server.ssamHandlers = new Map([['strict_result', handler]]);
    return server;
  };
  const cold = await createWarmServer({ root, identity, env, build: make }); await cold.server.close();
  const deadline = createCallDeadline({ root, timeoutMs: 150, env });
  const cached = await createWarmServer({ root, identity, env, wrap: (name, handler) => deadline.wrap(name, handler),
    build: async (server, registerLive) => { await delay(200); return make(server, registerLive); } });
  const client = await connect(t, cached.server);
  const first = await client.callTool({ name: 'strict_result', arguments: {} });
  assert.equal(first.structuredContent?.state, 'running');
  await cached.ready; await delay(0);
  const resumed = await client.callTool({ name: 'strict_result', arguments: {} });
  assert.equal(resumed.structuredContent?.result, 42);
  assert.equal(resumed.structuredContent?.resumedFrom, first.structuredContent.task.id);
  invalid = true;
  const bad = await client.callTool({ name: 'strict_result', arguments: {} });
  assert.equal(bad.isError, true, 'accepting deadline metadata must not permit invalid original final results');
  assert.match(bad.content[0].text, /Output validation error/);
});

test('the direct SSAM deadline preserves continuation and final results for a strict output schema', async t => {
  const root = sandbox(t);
  const { createSsamServer } = await import('../ssam.mjs');
  const server = await createSsamServer({ o11: true, odc: false, deps: {
    callDeadlineMs: 150, identity: { read: () => identity }, answersRoot: root,
    lock: { o11Root: root, odcRoot: root, connection: () => null },
    registerAppSession: local => local.registerTool('strict_result', { inputSchema: z.object({}), outputSchema: z.object({ result: z.number() }).strict(), annotations: { readOnlyHint: true } },
      async () => { await delay(350); return { content: [{ type: 'text', text: '{"result":42}' }], structuredContent: { result: 42 } }; })
  } });
  const client = await connect(t, server);
  let answer = await client.callTool({ name: 'strict_result', arguments: {} });
  assert.equal(answer.structuredContent?.state, 'running');
  while (answer.structuredContent?.state === 'running') {
    const next = answer.structuredContent.continuation;
    answer = await client.callTool({ name: next.tool, arguments: next.arguments });
  }
  assert.deepEqual(answer.structuredContent, { result: 42 });
});

test('staged warm assembly leaves an IO window for initialize and list before a synchronous build starts', async t => {
  const root = sandbox(t); const saved = await prime(root);
  let builds = 0;
  const started = performance.now();
  const result = await createWarmServer({ root, identity, env, startAfterConnect: true, build: (server, registerLive) => {
    builds++;
    const until = performance.now() + 300;
    while (performance.now() < until) { /* simulate synchronous schema/debug registration */ }
    return fakeServer({}, server, registerLive);
  } });
  // Real stdio receives initialize on an IO turn; an immediate build used to occupy that turn.
  await delay(30);
  assert.equal(builds, 0, 'the caller controls start until the transport is connected');
  const client = await connect(t, result.server);
  assert.deepEqual(stableTools((await client.listTools()).tools), saved.tools);
  assert.ok(performance.now() - started < 200, 'initialize/list finish before synchronous assembly');
  const timer = setTimeout(result.start, 100); t.after(() => clearTimeout(timer));
  const answer = await client.callTool({ name: 'echo', arguments: { value: 'after staged start' } });
  assert.deepEqual(answer.structuredContent, { ok: true, name: 'echo', value: 'after staged start' });
  result.start(); assert.equal(builds, 1, 'starting is idempotent');
});

test('cached tool configuration reaches the deadline wrapper so input-capable tools remain exempt generically', async t => {
  const root = sandbox(t); await prime(root, { canRequestInput: true });
  const deadline = createCallDeadline({ root, timeoutMs: 150, env });
  let marker;
  const result = await createWarmServer({ root, identity, env,
    wrap: (name, handler, config) => { marker = config?._meta?.canRequestInput; return deadline.wrap(name, handler, { exempt: marker === true }); },
    build: async (server, registerLive) => { await delay(350); return fakeServer({ canRequestInput: true }, server, registerLive); } });
  const client = await connect(t, result.server);
  const answer = await client.callTool({ name: 'echo', arguments: { value: 'input capable' } });
  assert.equal(marker, true);
  assert.deepEqual(answer.structuredContent, { ok: true, name: 'echo', value: 'input capable' }, 'input capability exempts the call regardless of its name');
});


test('failed cached assembly refuses every listed tool including doctor with its cause and restart next step', async t => {
  const root = sandbox(t);
  const saved = await prime(root, { second: true, output: true, doctor: true });
  let builds = 0;
  const logs = [];
  const result = await createWarmServer({ root, identity, env,
    build: async () => { builds++; await delay(50); throw new Error('fake dynamic import failed'); },
    log: value => logs.push(value) });
  const client = await connect(t, result.server);
  const pendingDoctor = client.callTool({ name: 'ssam_doctor', arguments: {} });
  await assert.rejects(result.ready, /fake dynamic import failed/);
  assert.equal((await pendingDoctor).structuredContent?.code, 'MCP_ASSEMBLY_FAILED', 'a doctor call already awaiting ready receives the same refusal');
  // Missing required input and strict output schemas must not hide the assembly failure.
  for (const tool of saved.tools) {
    for (const args of [{}, { value: 'valid input' }]) {
      const answer = await client.callTool({ name: tool.name, arguments: args });
      assert.equal(answer.isError, true);
      assert.equal(answer.structuredContent?.code, 'MCP_ASSEMBLY_FAILED', tool.name);
      assert.equal(answer.structuredContent.ok, false);
      assert.equal(answer.structuredContent.cause, 'fake dynamic import failed');
      assert.match(answer.structuredContent.next, /reinicie este servidor MCP/);
      assert.deepEqual(JSON.parse(answer.content[0].text), answer.structuredContent);
    }
  }
  assert.equal(builds, 1, 'refusals never retry the failed assembly');
  assert.ok(logs.some(value => value.code === 'TOOL_LIST_WARM_BUILD_FAILED'));
});

test('failed cached assembly invalidates its identity snapshot and the third start follows the cold path', async t => {
  const root = sandbox(t);
  await prime(root);
  const file = toolsSnapshotPath(root, toolsSnapshotKey(identity, env));
  assert.equal(fs.existsSync(file), true, 'first successful start saved a list');
  const failed = await createWarmServer({ root, identity, env, build: async () => { throw new Error('same identity failed'); } });
  assert.equal(failed.snapshotUsed, true, 'second start used the saved list');
  await assert.rejects(failed.ready, /same identity failed/);
  assert.equal(fs.existsSync(file), false, 'a failed ready removes the list for this identity');
  await failed.server.close();
  let coldBuilds = 0;
  const third = await createWarmServer({ root, identity, env,
    build: async (server, registerLive) => {
      coldBuilds++;
      assert.equal(server, undefined, 'the third build receives no cached connected instance');
      return fakeServer({}, server, registerLive);
    } });
  assert.equal(third.snapshotUsed, false);
  assert.equal(coldBuilds, 1);
  assert.equal(fs.existsSync(file), true, 'the successful cold build can save a fresh list');
  await third.server.close();
});
