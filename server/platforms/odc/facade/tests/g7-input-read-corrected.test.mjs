// G7 of the UI-Mockup diagnosis (FarmaVirtual session, 2026-10-10): calls 6 and 16 sent ssam_discover {budget} and got
// INPUT_INVALID "/budget is not a field here; closest: budgetBytes" with the corrected call as continuation; the model
// had to send it again (6 -> 11, 16 -> 17). A read-only tool (readOnlyHint true) whose every argument problem has a
// deterministic fix (a field renamed to the one name it surely is, a lossless type coercion) now runs the corrected
// arguments and says so in inputAdjusted; a tool that writes keeps refusing, as before. A name surely is a field when it
// is the field's but for case and separators, its plural, or a slip of one letter inside a name of five or more; anything
// wider is a guess and refuses as before: a name the field extends or that extends a field (budget is not budgetBytes but
// by the fixed alias of g7-input-budget-alias, timeout is not timeoutSeconds, maxDepth is not max), a wider edit, an
// identifier under another name (id is not pid), a number or a boolean the field would read as text (messages true is not
// message "true"). The order of the keys sent never decides, a budget renamed or coerced is held under the answer ceiling
// like one sent right, the next step and the continuation of the answer name what the tool ran, and the tool's own
// inputAdjusted is kept beside the layer's. Real server for the real arguments and schemas, an in-process McpServer for
// the rule. No Studio; the O11 CLI only for the lane index, when it is built.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { relaxTool, normalizeArguments, withInputAdjusted, INPUT_INVALID } from '../tool-input.mjs';
import { createSsamServer, budgetCeiling, MAX_ANSWER_BYTES } from '../ssam.mjs';

const value = r => r.structuredContent ?? JSON.parse(r.content[0].text);

async function connect(t, server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'g7-input-read-corrected', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

// The first discover of a worktree with the O11 CLI built builds the lane index (about 50 s); without the CLI it answers
// the tools part at once. Either way the answer is the one the corrected call gets.
test('ssam_discover runs a read whose every problem has a deterministic fix (lanes, "8000"), with the answer of the corrected call; a write tool still refuses', { timeout: 300000 }, async t => {
  const client = await connect(t, await createSsamServer({ deps: { relayTimeoutMs: 240000 } }));
  // The intent of calls 6 and 16, under names and types the layer fixes beyond doubt: a plural and a number as text.
  const real = [
    { call: 6, args: { lanes: 'o11', intent: 'Ler arquivo HTML local de prototipo e importar pagina completa via file html', budgetBytes: '8000' } },
    { call: 16, args: { intent: 'Ler arquivo local HTML index.html prototipo completo importar pagina scripts SVG assets arquivo file', lanes: 'o11', budgetBytes: '16000' } },
  ];
  // elapsedMs (and the sizes that count its digits) is the only part that changes between two calls: a budget discover raised
  // to its minimal answer (U5) counts those digits too, so it is compared within their width, and a raise without its `to`.
  const comparable = v => ({ ok: v.ok, schemaVersion: v.schemaVersion, lane: v.lane, intent: v.intent, tools: v.tools, identity: v.identity,
    matches: (v.matches ?? []).map(m => m.id), status: v.size?.status });
  const steady = list => (list ?? []).map(({ to, ...a }) => (/^raise-/.test(a.rule) ? a : { ...a, to }));
  const near = (a, b, why) => assert.ok(Math.abs(a - b) <= 16, `${why}: ${a} vs ${b}`);
  for (const { call, args } of real) {
    const r = await client.callTool({ name: 'ssam_discover', arguments: args });
    const v = value(r);
    assert.notEqual(v.code, INPUT_INVALID, `call ${call}: ` + JSON.stringify(v).slice(0, 300));
    assert.equal(r.isError, undefined, `call ${call}: ` + JSON.stringify(v).slice(0, 300));
    assert.equal(v.ok, true); assert.equal(v.schemaVersion, 'ssam-discovery/4'); assert.equal(v.lane, 'o11'); assert.equal(v.intent, args.intent);
    const { lanes, budgetBytes, ...rest } = args;
    const budget = Number(budgetBytes);
    const corrected = value(await client.callTool({ name: 'ssam_discover', arguments: { ...rest, lane: lanes, budgetBytes: budget } }));
    // The corrected call has no entry of the layer; discover may have its own (a budget below the minimal answer raised to
    // it, U5), the same in both calls, after the layer's.
    const own = corrected.inputAdjusted ?? [];
    assert.ok(own.every(a => /^raise-/.test(a.rule)), `call ${call}: ` + JSON.stringify(own));
    if (own.length) near(v.size.budgetBytes, corrected.size.budgetBytes, `call ${call}: the budget used is the corrected call's`);
    else assert.equal(v.size.budgetBytes, budget, `call ${call}: the budget sent is the budget used`);
    assert.deepEqual(steady(v.inputAdjusted), steady([{ path: '/budgetBytes', from: budgetBytes, to: budget, rule: 'coerce' }, { path: '/lanes', to: '/lane', rule: 'rename' }, ...own]));
    assert.deepEqual(comparable(v), comparable(corrected), `call ${call}: the same answer as the corrected call`);
  }
  // ssam_task writes (close): the same kind of problem (an unknown field with one closest name) still refuses, nothing runs.
  const write = value(await client.callTool({ name: 'ssam_task', arguments: { closes: { reason: 'nada aplicado' } } }));
  assert.equal(write.code, INPUT_INVALID);
  assert.match(write.violations[0].message, /not a field here; closest: close/);
  assert.deepEqual(write.continuation.arguments, { close: { reason: 'nada aplicado' } });
  assert.equal(write.inputAdjusted, undefined);
});

// Review of round 1 (A): the prefix measure took the field a longer name starts with, though the rest of the name points
// at another field of the same tool. These are the server's own read tools: each name still refuses, with the closest name
// of before; a name the field extends, or its plural, still runs.
test('the server\'s read tools: a longer name sent is never renamed alone to the shorter field it starts with (maxDepth, namePrefix, keyPrefix, pageSize, limitBytes)', async t => {
  const client = await connect(t, await createSsamServer({ deps: { relayTimeoutMs: 5000 } }));
  const tools = Object.fromEntries((await client.listTools()).tools.map(x => [x.name, x]));
  const guesses = [
    ['o11_inspect', { maxDepth: 2 }, 'max', 'depth'], ['studio_inspect', { target: 'x', maxDepth: 2 }, 'max', 'depth'],
    ['ssam_evidence', { file: 'x', maxDepth: 2 }, 'max', 'depth'],
    ['ssam_map', { target: 'x', namePrefix: 'Get' }, 'name', 'prefix'], ['ssam_map', { target: 'x', keyPrefix: 'k' }, 'key', 'prefix'],
    ['ssam_map', { target: 'x', pageSize: 50 }, 'page', 'max'], ['ssam_discover', { limitBytes: 8000 }, 'limit', 'budgetBytes'],
  ];
  for (const [name, args, closestName, other] of guesses) {
    const tool = tools[name];
    assert.ok(tool, name + ' is served');
    assert.equal(tool.annotations?.readOnlyHint, true, name);
    assert.ok(tool.inputSchema.properties[closestName] && tool.inputSchema.properties[other], `${name} declares ${closestName} and ${other}`);
    const n = normalizeArguments(tool.inputSchema, args);
    assert.equal(n.corrections, null, `${name} ${JSON.stringify(args)}: ` + JSON.stringify(n.corrections));
    assert.match(n.violations[0].message, new RegExp('not a field here; closest: ' + closestName + '$'), name);
  }
  // The shorter field sent too: the name is still that field and more, never renamed alone to another free field (with key
  // taken, keyPrefix is a small edit away from prefix, the name prefix).
  for (const [name, args] of [['ssam_map', { target: 'x', key: 'k', keyPrefix: 'k' }], ['o11_inspect', { max: 5, maxDepth: 2 }],
    ['ssam_map', { target: 'x', name: 'A', namePrefix: 'Get' }], ['ssam_map', { target: 'x', page: 1, pageSize: 50 }]]) {
    const n = normalizeArguments(tools[name].inputSchema, args);
    assert.equal(n.corrections, null, `${name} ${JSON.stringify(args)}: ` + JSON.stringify(n.corrections));
    assert.equal(n.violations.length, 1, name);
  }
  // Through the server: the refusal, nothing run.
  const refused = value(await client.callTool({ name: 'ssam_discover', arguments: { limitBytes: 8000 } }));
  assert.equal(refused.code, INPUT_INVALID); assert.equal(refused.inputAdjusted, undefined);
  assert.deepEqual(refused.continuation.arguments, { limit: 8000 }, 'the refusal keeps the closest name of before');
  // Still deterministic: the name sent is the field's plural, or the field's but for case and separators (an identifier
  // too).
  assert.deepEqual(normalizeArguments(tools.ssam_map.inputSchema, { target: 'x', kinds: 'Entity' }).corrections, [{ path: '/kinds', to: '/kind', rule: 'rename' }]);
  assert.deepEqual(normalizeArguments(tools.studio_data.inputSchema, { module: 'M', entity: 'E', PID: 42 }).corrections, [{ path: '/PID', to: '/pid', rule: 'rename' }]);
});

// Review of round 2: every field name of this server sent to every read tool that lacks it ran 102 renames or aliases,
// and some of them ran another value: a field another tool declares taken for the read's own (id ran the Studio pid,
// newModule captured another module, producers ran process), or a unit or count the field adds (timeout 30000 ms ran
// timeoutSeconds 1800, max ran up to 100 pages). Each refuses now, with the same closest name, and nothing runs.
test('the server\'s read tools: a name of another tool is never run as a field it is not (an identifier, a wider edit, a unit or count the field adds)', async t => {
  const client = await connect(t, await createSsamServer({ deps: { relayTimeoutMs: 5000 } }));
  const tools = Object.fromEntries((await client.listTools()).tools.map(x => [x.name, x]));
  const action = tools.o11_service_center_read.inputSchema.properties.action.enum[0];
  const guesses = [
    ['studio_data', { module: 'M', entity: 'E', id: 42 }, 'id', 'pid'], ['ssam_map', { target: 'x', id: 7 }, 'id', 'pid'],
    ['ssam_app_url', { app: 'A', id: 7 }, 'id', 'pid'],
    ['o11_service_center_read', { action, producers: 'Core' }, 'producers', 'process'],
    ['o11_service_center_read', { action, dbServer: 'db1' }, 'dbServer', 'server'],
    ['o11_service_center_read', { action, toApplication: 'App' }, 'toApplication', 'application'],
    ['o11_service_center_read', { action, max: 100 }, 'max', 'maxPages'],
    ['ssam_evidence', { file: 'x.json', keep: true }, 'keep', 'deep'],
    ['o11_inspect', { oml: 'x.oml', newModule: 'Other' }, 'newModule', 'module'],
    ['studio_wait', { condition: 'idle', timeout: 30000 }, 'timeout', 'timeoutSeconds'],
    ['odc_operation_status', { kind: 'deployment', operationKey: 'k', wait: 30 }, 'wait', 'waitSeconds'],
  ];
  for (const [name, args, sent, closestName] of guesses) {
    const tool = tools[name];
    assert.equal(tool?.annotations?.readOnlyHint, true, name);
    assert.ok(tool.inputSchema.properties[closestName], `${name} declares ${closestName}`);
    const n = normalizeArguments(tool.inputSchema, args);
    assert.equal(n.corrections, null, `${name} ${JSON.stringify(args)}: ` + JSON.stringify(n.corrections));
    assert.deepEqual(n.violations.map(v => [v.path, v.message]), [['/' + sent, 'is not a field here; closest: ' + closestName]], `${name} ${JSON.stringify(args)}`);
  }
  // Through the server: the refusal with the closest name, nothing run.
  const pid = value(await client.callTool({ name: 'studio_data', arguments: { module: 'M', entity: 'E', id: 42 } }));
  assert.equal(pid.code, INPUT_INVALID); assert.equal(pid.inputAdjusted, undefined);
  assert.deepEqual(pid.continuation.arguments, { module: 'M', entity: 'E', pid: 42 });
  const wait = value(await client.callTool({ name: 'studio_wait', arguments: { condition: 'idle', timeout: 30000 } }));
  assert.equal(wait.code, INPUT_INVALID); assert.equal(wait.inputAdjusted, undefined);
});

// Review of round 3 (2): a rename and then a coercion ran a value of another tool as a field it is not, its type the tell:
// o11_service_center_read {messages: true} (the switch of odc_operation_status) ran the text filter message "true". A value
// moved to another name keeps its kind: a number or a boolean the field would read as text refuses, with the closest name
// of before; a text, a switch renamed to a switch and a text wrapped in its list still run.
test('the server\'s read tools: a number or a boolean is never renamed into a field that reads it as text', async t => {
  const client = await connect(t, await createSsamServer({ deps: { relayTimeoutMs: 5000 } }));
  const tools = Object.fromEntries((await client.listTools()).tools.map(x => [x.name, x]));
  const action = tools.o11_service_center_read.inputSchema.properties.action.enum[0];
  const guesses = [
    ['o11_service_center_read', { action, messages: true }, 'messages', 'message'],
    ['o11_service_center_read', { action, names: 42 }, 'names', 'name'],
    ['o11_inspect', { oml: 'x.oml', modules: true }, 'modules', 'module'],
    ['ssam_map', { target: 'x', keys: 7 }, 'keys', 'key'],
  ];
  // Normalized again as the layer does for a read (two passes): the first pass already has no deterministic fix.
  const chained = (schema, args) => { const n = normalizeArguments(schema, args); return n.corrections ? normalizeArguments(schema, n.corrected) : n; };
  for (const [name, args, sent, closestName] of guesses) {
    const tool = tools[name];
    assert.equal(tool.annotations?.readOnlyHint, true, name);
    assert.equal(tool.inputSchema.properties[closestName].type, 'string', `${name} reads ${closestName} as text`);
    const n = chained(tool.inputSchema, args);
    assert.equal(n.corrections, null, `${name} ${JSON.stringify(args)}: ` + JSON.stringify(n.corrections));
    assert.deepEqual(n.violations.map(v => [v.path, v.message]), [['/' + sent, 'is not a field here; closest: ' + closestName]], `${name} ${JSON.stringify(args)}`);
  }
  const messages = value(await client.callTool({ name: 'o11_service_center_read', arguments: { action, messages: true } }));
  assert.equal(messages.code, INPUT_INVALID); assert.equal(messages.inputAdjusted, undefined);
  assert.deepEqual(messages.continuation.arguments, { action, message: true }, 'the refusal of before');
  // Still run: the same names with a text, a switch renamed to a switch, a text wrapped in its list.
  assert.deepEqual(normalizeArguments(tools.o11_service_center_read.inputSchema, { action, messages: 'Timeout' }).corrections, [{ path: '/messages', to: '/message', rule: 'rename' }]);
  assert.deepEqual(normalizeArguments(tools.odc_operation_status.inputSchema, { kind: 'deployment', operationKey: 'k', message: true }).corrections,
    [{ path: '/message', to: '/messages', rule: 'rename' }]);
  const listed = normalizeArguments(tools.o11_dependencies.inputSchema, { action: tools.o11_dependencies.inputSchema.properties.action.enum?.[0] ?? 'x', element: 'GetOrders' });
  assert.deepEqual(listed.corrections, [{ path: '/element', to: '/elements', rule: 'rename' }]);
  assert.deepEqual(normalizeArguments(tools.o11_dependencies.inputSchema, listed.corrected).corrections, [{ path: '/elements', from: 'GetOrders', to: ['GetOrders'], rule: 'coerce' }]);
  // Every text field of every read tool, sent under its plural: a text is renamed, a boolean or a number never is.
  let checked = 0;
  for (const tool of Object.values(tools).filter(x => x.annotations?.readOnlyHint === true)) {
    const props = tool.inputSchema.properties ?? {};
    const required = {};
    for (const r of tool.inputSchema.required ?? []) { const p = props[r] ?? {}; required[r] = p.enum ? p.enum[0] : p.type === 'integer' || p.type === 'number' ? 1 : p.type === 'boolean' ? true : p.type === 'array' ? ['x'] : 'x'; }
    for (const [field, s] of Object.entries(props)) {
      if (s.type !== 'string' || s.enum || Object.hasOwn(props, field + 's') || Object.hasOwn(required, field)) continue;
      const renamed = args => (normalizeArguments(tool.inputSchema, { ...required, ...args }).corrections ?? []).some(c => c.rule === 'rename' && c.to === '/' + field);
      if (!renamed({ [field + 's']: 'abc' })) continue;
      for (const other of [true, 7]) assert.equal(renamed({ [field + 's']: other }), false, `${tool.name} {${field}s: ${other}}`);
      checked++;
    }
  }
  assert.ok(checked >= 50, `${checked} text fields renamed from their plural`);
});

// Review of round 3 (1): the shaper read the arguments as sent while the tool ran them renamed: the `next` of a paged read
// lost its filter ({kinds} ran kind; the next page listed everything) and a Studio call lost its Studio ({PID} ran pid; the
// next step and the studio_busy continuation named none). The lane, the Studio lock and the shaper read what the tool ran.
test('the next step and the continuation of a read name what the tool ran: the renamed filter, the renamed Studio pid', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-next-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const OML = 'C:\\caps\\Orders.oml', SHA = 'ab'.repeat(32), MANIFEST = 'C:\\m\\manifest.json';
  const ran = [];
  const answer = v => ({ content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v, ...(v.ok ? {} : { isError: true }) });
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    // The filters of studio_inspect the next page repeats, and a paged answer.
    fake.registerTool('studio_inspect', { description: 'Fake paged read.', annotations: { readOnlyHint: true },
      inputSchema: z.object({ target: z.string(), path: z.string().optional(), kind: z.string().optional(), name: z.string().optional(),
        offset: z.number().int().min(0).default(0), max: z.number().int().min(1).max(500).default(60), expectedSourceSha256: z.string().optional(),
        pid: z.number().int().optional() }).strict() }, async args => {
      ran.push(args);
      return answer({ ok: true, file: OML, sourceSha256: SHA, count: 30, returned: 10, nextOffset: args.offset + 10, entries: [] });
    });
    fake.registerTool('studio_check_base', { description: 'Fake check-base.', annotations: { readOnlyHint: true },
      inputSchema: z.object({ manifest: z.string(), pid: z.number().int().optional() }).strict() }, async args => {
      ran.push(args);
      return answer(args.manifest === MANIFEST ? { ok: true, gate: 'pass' } : { ok: false, gate: 'studio_busy', error: 'a dialog holds the Studio' });
    });
    return fake;
  };
  const client = await connect(t, await createSsamServer({ o11: false, odc: true,
    deps: { odcFacade, odcRoot: root, answersRoot: root, lock: { o11Root: root, odcRoot: root, connection: () => null } } }));
  const call = async (name, args) => { ran.length = 0; const v = value(await client.callTool({ name, arguments: args })); return { v, ran: ran.slice() }; };
  for (const [right, sent] of [[{ kind: 'ServerAction' }, { kinds: 'ServerAction' }], [{ kind: 'ServerAction' }, { Kind: 'ServerAction' }],
    [{ name: 'Get' }, { names: 'Get' }], [{ path: '@k1' }, { paths: '@k1' }]]) {
    const expected = await call('studio_inspect', { target: OML, ...right, max: 10 });
    const renamed = await call('studio_inspect', { target: OML, ...sent, max: 10 });
    assert.equal(renamed.v.code, undefined, JSON.stringify(sent) + ': ' + JSON.stringify(renamed.v));
    assert.equal(renamed.v.inputAdjusted?.[0]?.rule, 'rename', JSON.stringify(sent));
    assert.deepEqual(renamed.ran, expected.ran, JSON.stringify(sent) + ': the read sent right ran');
    // The next page of the listing the call read, as the call sent right gets it.
    assert.deepEqual(renamed.v.next, expected.v.next, JSON.stringify(sent));
    assert.deepEqual(renamed.v.next.at(-1), { tool: 'studio_inspect', arguments: { target: OML, ...right, max: 10, offset: 10, expectedSourceSha256: SHA } });
  }
  const base = await call('studio_check_base', { manifest: MANIFEST, PID: 4242 });
  assert.deepEqual(base.ran, [{ manifest: MANIFEST, pid: 4242 }]);
  assert.deepEqual(base.v.inputAdjusted, [{ path: '/PID', to: '/pid', rule: 'rename' }]);
  assert.deepEqual(base.v.next, [{ tool: 'studio_preview', arguments: { manifest: MANIFEST, pid: 4242 } }], 'the preview of the Studio the call ran on');
  const busy = await call('studio_check_base', { manifest: 'C:\\m\\other.json', PID: 4242 });
  assert.deepEqual(busy.ran, [{ manifest: 'C:\\m\\other.json', pid: 4242 }]);
  assert.equal(busy.v.gate, 'studio_busy');
  assert.equal(busy.v.continuation?.tool, 'studio_status', JSON.stringify(busy.v));
  assert.deepEqual(busy.v.continuation.arguments, { pid: 4242 }, 'the status of the Studio the call ran on');
});

const probeSchema = () => z.object({
  intent: z.string().max(500).default(''),
  lane: z.enum(['o11', 'odc']).default('odc'),
  limit: z.number().int().min(1).max(30).default(8),
  budgetBytes: z.number().int().min(4096).max(1048576).default(40960),
  authorize: z.string().min(1).optional(),
  pageA: z.number().int().optional(), pageB: z.number().int().optional(),
  target: z.string().min(1).optional(),
  pid: z.number().int().optional(), timeoutSeconds: z.number().int().max(1800).optional(), maxPages: z.number().int().min(1).max(100).optional(),
  deep: z.boolean().optional(), server: z.string().optional(), names: z.array(z.string()).optional(),
}).strict();

async function probes(t, answer = args => ({ ok: true, args })) {
  const server = new McpServer({ name: 'g7-probe', version: '1' });
  const calls = { read: [], write: [], plain: [] };
  const register = (name, annotations, list) => {
    const r = relaxTool(name, { description: name, inputSchema: probeSchema(), ...(annotations ? { annotations } : {}) },
      async args => { list.push(args); const v = answer(args); return { content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v }; });
    server.registerTool(name, r.config, r.handler);
  };
  register('probe_read', { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, calls.read);
  register('probe_write', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, calls.write);
  register('probe_plain', null, calls.plain);
  return { client: await connect(t, server), calls };
}

test('read-only: renames and lossless coercions run the corrected arguments; the renamed value is normalized too', async t => {
  const { client, calls } = await probes(t);
  const r = await client.callTool({ name: 'probe_read', arguments: { lanes: 'o11', limit: '5', targets: 'Haiku_UI' } });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual(calls.read, [{ intent: '', lane: 'o11', limit: 5, budgetBytes: 40960, target: 'Haiku_UI' }], 'one run, the tool\'s own defaults applied');
  assert.deepEqual(value(r).inputAdjusted, [{ path: '/limit', from: '5', to: 5, rule: 'coerce' }, { path: '/lanes', to: '/lane', rule: 'rename' },
    { path: '/targets', to: '/target', rule: 'rename' }]);
  // the renamed value goes through the layer like any other: clamped to the edge, or coerced
  const high = await client.callTool({ name: 'probe_read', arguments: { limits: 50 } });
  assert.deepEqual(value(high).inputAdjusted, [{ path: '/limits', to: '/limit', rule: 'rename' }, { path: '/limit', from: 50, to: 30, rule: 'clamp' }]);
  const text = await client.callTool({ name: 'probe_read', arguments: { limits: '5' } });
  assert.deepEqual(value(text).inputAdjusted, [{ path: '/limits', to: '/limit', rule: 'rename' }, { path: '/limit', from: '5', to: 5, rule: 'coerce' }]);
  assert.deepEqual(calls.read.map(c => c.limit), [5, 30, 5]);
});

test('read-only: a required field sent under a near name is filled by its rename, no placeholder left; with no near name it refuses', async () => {
  const seen = [];
  const r = relaxTool('probe_required', { inputSchema: z.object({ target: z.string().min(1), budgetBytes: z.number().int().min(2000).default(60000) }).strict(),
    annotations: { readOnlyHint: true } }, async args => { seen.push(args); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; });
  const out = await r.handler({ targt: 'Haiku_UI', budgetBytes: 8000 }, {});
  assert.deepEqual(seen, [{ target: 'Haiku_UI', budgetBytes: 8000 }]);
  assert.deepEqual(out.structuredContent.inputAdjusted, [{ path: '/targt', to: '/target', rule: 'rename' }]);
  const missing = await r.handler({ budgetBytes: 8000 }, {});
  assert.equal(missing.structuredContent.code, INPUT_INVALID); assert.equal(missing.structuredContent.corrected.target, '<target>');
  assert.equal(seen.length, 1);
});

test('read-only: a fix that is a guess still refuses, whole, as before (ambiguous name, longer name, unit or count, wider edit, identifier, key order, rounding, enum, a list in a text, the user\'s words, a removal, a placeholder)', async t => {
  const { client, calls } = await probes(t);
  const refusals = {
    ambiguous: { pageC: 2 }, // pageA and pageB are equally close
    longer: { limitBytes: 8000 }, // starts with limit, says more than it
    longerName: { targetName: 'x' },
    longerTaken: { target: 'x', targetBytes: 9000 }, // target taken: a small edit away from budgetBytes, yet target and more
    unit: { timeout: 30000 }, // timeoutSeconds is timeout and a unit: 30000 ms is not 1800 s
    count: { max: 100 }, // maxPages is max and what it counts
    shorter: { targe: 'x' }, // the field extends it by one letter, like timeout by Seconds
    wider: { dbServer: 'db1' }, // two edits away from server
    short: { keep: true }, // one letter from deep, in a name of four
    identifier: { id: 42 }, // one letter from pid: another process is not a nearer name
    identifierPlural: { pids: 42 }, // an identifier is renamed only from its own name but for case and separators
    orderFirst: { page_a: 1, pageC: 2 }, // pageA renamed first leaves pageB alone, yet pageC is as close to both
    orderLast: { pageC: 2, page_a: 1 },
    rounding: { limit: 8.5 },
    enum: { lane: 'ODC' },
    list: { names: 'GetA,GetB' }, // one item or two: never wrapped by itself
    words: { autorize: 'sim, pode' }, // a rename into authorize is never a guess the layer makes
    removal: { lanes: 'o11', zzz: 1 }, // one problem without a fix: nothing of the call runs
    minimum: { target: '' },
  };
  for (const [why, args] of Object.entries(refusals)) {
    const v = value(await client.callTool({ name: 'probe_read', arguments: args }));
    assert.equal(v.code, INPUT_INVALID, why + ': ' + JSON.stringify(v));
    assert.equal(v.inputAdjusted, undefined, why);
  }
  assert.equal(calls.read.length, 0, 'nothing ran');
  // the closest name of the refusal is the one of before
  const near = { unit: 'timeoutSeconds', count: 'maxPages', shorter: 'target', wider: 'server', short: 'deep', identifier: 'pid', identifierPlural: 'pid' };
  const schema = z.toJSONSchema(probeSchema(), { target: 'draft-2020-12', io: 'input' });
  for (const [why, name] of Object.entries(near)) assert.match(normalizeArguments(schema, refusals[why]).violations[0].message, new RegExp('closest: ' + name + '$'), why);
  // the same keys in either order: no deterministic fix either way (the suggestion of the refusal may differ, as before)
  for (const args of [refusals.orderFirst, refusals.orderLast]) assert.equal(normalizeArguments(schema, args).corrections, null, JSON.stringify(args));
  // still sure: a slip of one letter inside the name, an identifier but for case, one name wrapped in its list
  assert.deepEqual(normalizeArguments(schema, { taregt: 'x' }).corrections, [{ path: '/taregt', to: '/target', rule: 'rename' }]);
  assert.deepEqual(normalizeArguments(schema, { PID: 42 }).corrections, [{ path: '/PID', to: '/pid', rule: 'rename' }]);
  assert.deepEqual(normalizeArguments(schema, { names: 'GetA' }).corrections, [{ path: '/names', from: 'GetA', to: ['GetA'], rule: 'coerce' }]);
});

// Review of round 1 (D): the refusal of a read whose corrected arguments still have a problem names it, and corrects it.
test('read-only: a problem left in the corrected arguments refuses with the violations of every pass and the call that fixes them', async t => {
  const { client, calls } = await probes(t);
  const rounded = value(await client.callTool({ name: 'probe_read', arguments: { limits: 8.5 } }));
  assert.equal(rounded.code, INPUT_INVALID);
  assert.deepEqual(rounded.violations.map(v => v.path), ['/limits', '/limit']);
  assert.deepEqual(rounded.continuation.arguments, { limit: 9 }, 'the continuation is a call that passes');
  const cased = value(await client.callTool({ name: 'probe_read', arguments: { lanes: 'ODC' } }));
  assert.deepEqual(cased.violations.map(v => v.path), ['/lanes', '/lane']);
  assert.deepEqual(cased.continuation.arguments, { lane: 'odc' });
  const wrong = value(await client.callTool({ name: 'probe_read', arguments: { limits: 'abc' } }));
  assert.deepEqual(wrong.violations.map(v => v.path), ['/limits', '/limit']);
  assert.match(wrong.violations[1].message, /expected integer, received string/);
  assert.equal(wrong.continuation, undefined, 'no fix for "abc": no call to repeat');
  assert.deepEqual(wrong.corrected, { limit: 'abc' });
  assert.equal(calls.read.length, 0, 'nothing ran');
});

test('a tool that writes (readOnlyHint false) or declares nothing refuses the same arguments as before, with the corrected call', async t => {
  const { client, calls } = await probes(t);
  for (const name of ['probe_write', 'probe_plain']) {
    const r = await client.callTool({ name, arguments: { lanes: 'o11', limit: '5', targets: 'Haiku_UI' } });
    const v = value(r);
    assert.equal(r.isError, true, name); assert.equal(v.code, INPUT_INVALID, name);
    assert.deepEqual(v.violations.map(x => x.path), ['/limit', '/lanes', '/targets'], name);
    assert.deepEqual(v.continuation.arguments, { lane: 'o11', limit: 5, target: 'Haiku_UI' }, name);
  }
  assert.equal(calls.write.length + calls.plain.length, 0, 'nothing ran');
});

// Coordination with U5: discover puts its own inputAdjusted (raise-to-minimal) in its answer; the layer's entries join it.
test('the tool\'s own inputAdjusted is kept: the layer\'s entries come first, then the tool\'s, in one list', async t => {
  const raise = budgetBytes => ({ path: '/budgetBytes', from: budgetBytes, to: 14139, rule: 'raise-to-minimal' });
  const { client } = await probes(t, args => ({ ok: true, size: { budgetBytes: 14139 }, inputAdjusted: [raise(args.budgetBytes)] }));
  const renamed = value(await client.callTool({ name: 'probe_read', arguments: { lanes: 'o11' } }));
  assert.deepEqual(renamed.inputAdjusted, [{ path: '/lanes', to: '/lane', rule: 'rename' }, raise(40960)]);
  const clamped = value(await client.callTool({ name: 'probe_write', arguments: { budgetBytes: 1000 } }));
  assert.deepEqual(clamped.inputAdjusted, [{ path: '/budgetBytes', from: 1000, to: 4096, rule: 'clamp' }, raise(4096)]);
  // the text-only answer and a repeated entry
  const layer = [{ path: '/budgetBytes', from: 1000, to: 4096, rule: 'clamp' }];
  const textOnly = withInputAdjusted({ content: [{ type: 'text', text: JSON.stringify({ ok: true, inputAdjusted: [raise(4096), layer[0]] }) }] }, layer);
  assert.deepEqual(JSON.parse(textOnly.content[0].text).inputAdjusted, [layer[0], raise(4096)]);
  const none = { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true, inputAdjusted: [raise(9000)] } };
  assert.equal(withInputAdjusted(none, []), none, 'nothing adjusted by the layer: the answer as the tool gave it');
});

// Review of round 1 (B): the ceiling held only a budget sent under its exact name as a number. A read tool now runs
// {budgetBytes:"100000"}, {budget_bytes:100000} and {BudgetBytes:100000}: the budget it gets is held the same way.
test('a budget the layer coerced or renamed is held under the answer ceiling, like one sent right', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-ceiling-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const received = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_inspect', { description: 'Fake read with a byte budget.', annotations: { readOnlyHint: true },
      inputSchema: z.object({ target: z.string(), budgetBytes: z.number().int().optional() }).strict() }, async args => {
      received.push(args.budgetBytes);
      const v = { ok: true, budgetBytes: args.budgetBytes };
      return { content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v };
    });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot: root, answersRoot: root, lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const client = await connect(t, server);
  const ceiling = budgetCeiling(MAX_ANSWER_BYTES);
  const forms = [
    [{ budgetBytes: 100000 }, undefined],
    [{ budgetBytes: '100000' }, [{ path: '/budgetBytes', from: '100000', to: 100000, rule: 'coerce' }]],
    [{ budget_bytes: 100000 }, [{ path: '/budget_bytes', to: '/budgetBytes', rule: 'rename' }]],
    [{ BudgetBytes: 100000 }, [{ path: '/BudgetBytes', to: '/budgetBytes', rule: 'rename' }]],
  ];
  for (const [args, adjusted] of forms) {
    const v = value(await client.callTool({ name: 'studio_inspect', arguments: { target: 'C:\\m.oml', ...args } }));
    assert.equal(v.code, undefined, JSON.stringify(args) + ': ' + JSON.stringify(v));
    assert.equal(v.budgetBytes, ceiling, JSON.stringify(args));
    assert.deepEqual(v.inputAdjusted, adjusted, JSON.stringify(args));
    assert.equal(v.paged, undefined);
  }
  assert.deepEqual(received, [ceiling, ceiling, ceiling, ceiling]);
});
