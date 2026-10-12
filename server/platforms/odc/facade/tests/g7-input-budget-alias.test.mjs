// G7 of the UI-Mockup diagnosis, item 2: the answer budget has two names across the tools (o11_inspect and studio_inspect
// declare budget, in characters; ssam_discover, ssam_map and ssam_evidence budgetBytes), and the model sent the other one
// (calls 6 and 16). A read tool renames a field by itself only when the name sent is the field's but for case or
// separators, its plural, or a slip of one letter inside it: budget on ssam_discover and budgetBytes on o11_inspect are
// none of them (budgetBytes is budget and a unit, like timeoutSeconds is timeout and one) and refused. A fixed alias makes
// the two names one field on every tool that declares one of them only, read or write; the value is clamped, coerced and
// held under the answer ceiling like any other, the next step names it under the tool's own name, and a number the field
// would read as text is no alias. No Studio; the O11 CLI only for the lane index, when it is built.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { relaxTool, normalizeArguments, INPUT_INVALID } from '../tool-input.mjs';
import { createSsamServer, budgetCeiling, MAX_ANSWER_BYTES } from '../ssam.mjs';

const value = r => r.structuredContent ?? JSON.parse(r.content[0].text);

async function connect(t, server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'g7-input-budget-alias', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

// The first discover of a worktree with the O11 CLI built builds the lane index (about 50 s); without the CLI it answers
// the tools part at once. Either way the answer is the one the corrected call (11, 17) gets.
test('calls 6 and 16: ssam_discover {budget} answers the discover, with budget -> budgetBytes in inputAdjusted', { timeout: 300000 }, async t => {
  const client = await connect(t, await createSsamServer({ deps: { relayTimeoutMs: 240000 } }));
  const real = [
    { call: 6, args: { lane: 'o11', intent: 'Ler arquivo HTML local de prototipo e importar pagina completa via file html', budget: 8000 } },
    { call: 16, args: { intent: 'Ler arquivo local HTML index.html prototipo completo importar pagina scripts SVG assets arquivo file', lane: 'o11', budget: 16000 } },
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
    const { budget, ...rest } = args;
    const corrected = value(await client.callTool({ name: 'ssam_discover', arguments: { ...rest, budgetBytes: budget } }));
    // The corrected call has no entry of the layer; discover may have its own (a budget below the minimal answer raised to
    // it, U5), the same in both calls, after the layer's.
    const own = corrected.inputAdjusted ?? [];
    assert.ok(own.every(a => /^raise-/.test(a.rule)), `call ${call}: ` + JSON.stringify(own));
    if (own.length) near(v.size.budgetBytes, corrected.size.budgetBytes, `call ${call}: the budget used is the corrected call's`);
    else assert.equal(v.size.budgetBytes, budget, `call ${call}: the budget sent is the budget used`);
    assert.deepEqual(steady(v.inputAdjusted), steady([{ path: '/budget', to: '/budgetBytes', rule: 'alias' }, ...own]));
    assert.deepEqual(comparable(v), comparable(corrected), `call ${call}: the same answer as the corrected call`);
  }
});

test('every tool of the server with one budget field takes the other name, in any case or separators: an alias, never a refusal', async t => {
  const client = await connect(t, await createSsamServer({ deps: { relayTimeoutMs: 5000 } }));
  const budgeted = (await client.listTools()).tools.filter(x => ['budget', 'budgetBytes'].some(k => x.inputSchema?.properties?.[k]));
  for (const name of ['o11_inspect', 'ssam_discover', 'ssam_map', 'ssam_evidence']) assert.ok(budgeted.some(x => x.name === name), name);
  for (const tool of budgeted) {
    const props = tool.inputSchema.properties;
    assert.ok(!(props.budget && props.budgetBytes), tool.name + ' has one of the two');
    const own = props.budget ? 'budget' : 'budgetBytes';
    const required = Object.fromEntries((tool.inputSchema.required ?? []).map(r => [r, 'x']));
    for (const other of own === 'budget' ? ['budgetBytes', 'budget_bytes', 'BudgetBytes'] : ['budget', 'Budget']) {
      const n = normalizeArguments(tool.inputSchema, { ...required, [other]: 8000 });
      assert.deepEqual(n.violations, [], `${tool.name} {${other}}`);
      assert.deepEqual(n.adjusted, [{ path: '/' + other, to: '/' + own, rule: 'alias' }], `${tool.name} {${other}}`);
      assert.equal(n.args[own], 8000); assert.equal(Object.hasOwn(n.args, other), false);
    }
  }
});

const probeSchema = () => z.object({
  target: z.string().min(1).optional(),
  budgetBytes: z.number().int().min(4096).max(1048576).default(40960),
  job: z.object({ budget: z.number().optional() }).strict().optional(),
}).strict();

test('the alias holds on a tool that writes or declares nothing; the aliased value is clamped and coerced; both names sent still refuse', async t => {
  const server = new McpServer({ name: 'g7-alias-probe', version: '1' });
  const seen = [];
  for (const [name, annotations] of [['probe_write', { readOnlyHint: false, destructiveHint: true }], ['probe_plain', null], ['probe_read', { readOnlyHint: true }]]) {
    const r = relaxTool(name, { description: name, inputSchema: probeSchema(), ...(annotations ? { annotations } : {}) },
      async args => { seen.push([name, args]); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; });
    server.registerTool(name, r.config, r.handler);
  }
  const client = await connect(t, server);
  for (const name of ['probe_write', 'probe_plain', 'probe_read']) {
    const v = value(await client.callTool({ name, arguments: { target: 'x', budget: 8000 } }));
    assert.equal(v.code, undefined, name + ': ' + JSON.stringify(v));
    assert.deepEqual(v.inputAdjusted, [{ path: '/budget', to: '/budgetBytes', rule: 'alias' }], name);
  }
  assert.deepEqual(seen.map(([, a]) => a.budgetBytes), [8000, 8000, 8000]);
  const low = value(await client.callTool({ name: 'probe_write', arguments: { budget: 1000 } }));
  assert.deepEqual(low.inputAdjusted, [{ path: '/budget', to: '/budgetBytes', rule: 'alias' }, { path: '/budgetBytes', from: 1000, to: 4096, rule: 'clamp' }]);
  // a coercion is still a problem on a write; on a read it runs
  const text = value(await client.callTool({ name: 'probe_write', arguments: { budget: '8000' } }));
  assert.equal(text.code, INPUT_INVALID); assert.deepEqual(text.continuation.arguments, { budgetBytes: 8000 });
  const read = value(await client.callTool({ name: 'probe_read', arguments: { budget: '8000' } }));
  assert.deepEqual(read.inputAdjusted, [{ path: '/budget', to: '/budgetBytes', rule: 'alias' }, { path: '/budgetBytes', from: '8000', to: 8000, rule: 'coerce' }]);
  // both names: no alias, the extra one is refused; a payload (job) is never touched
  const both = value(await client.callTool({ name: 'probe_read', arguments: { budget: 8000, budgetBytes: 9000 } }));
  assert.equal(both.code, INPUT_INVALID); assert.equal(both.violations[0].path, '/budget');
  const payload = value(await client.callTool({ name: 'probe_write', arguments: { job: { budgetBytes: 1 } } }));
  assert.equal(payload.code, INPUT_INVALID); assert.equal(payload.violations[0].path, '/job/budgetBytes');
  assert.equal(seen.length, 5);
});

test('a budget sent under the other name is held under the answer ceiling, on a tool that writes too', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const received = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_probe_write', { description: 'Fake write with a byte budget.', annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({ target: z.string(), budgetBytes: z.number().int().optional() }).strict() }, async args => {
      received.push(args.budgetBytes);
      const v = { ok: true, budgetBytes: args.budgetBytes };
      return { content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v };
    });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot: root, answersRoot: root, writeLock: (_options, run) => run(),
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const client = await connect(t, server);
  const v = value(await client.callTool({ name: 'studio_probe_write', arguments: { target: 'C:\\m.oml', budget: 100000 } }));
  assert.equal(v.code, undefined, JSON.stringify(v));
  assert.equal(v.budgetBytes, budgetCeiling(MAX_ANSWER_BYTES));
  assert.deepEqual(v.inputAdjusted, [{ path: '/budget', to: '/budgetBytes', rule: 'alias' }]);
  assert.deepEqual(received, [budgetCeiling(MAX_ANSWER_BYTES)]);
});

// Review of round 3 (1): studio_inspect {budgetBytes: 20000} ran budget 20000, yet the next page was built from the name
// sent and left the budget out (back to the default 60000). The next step names the budget the tool ran, under its name.
test('the next page of a read names the budget the tool ran under its own name, held under the ceiling', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-alias-next-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const OML = 'C:\caps\Orders.oml', SHA = 'ab'.repeat(32);
  const ran = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_inspect', { description: 'Fake paged read with a budget.', annotations: { readOnlyHint: true },
      inputSchema: z.object({ target: z.string(), kind: z.string().optional(), offset: z.number().int().min(0).default(0),
        max: z.number().int().min(1).max(500).default(60), budget: z.number().int().min(1000).default(60000), expectedSourceSha256: z.string().optional() }).strict() }, async args => {
      ran.push(args);
      const v = { ok: true, file: OML, sourceSha256: SHA, count: 30, returned: 10, nextOffset: args.offset + 10, entries: [] };
      return { content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v };
    });
    return fake;
  };
  const client = await connect(t, await createSsamServer({ o11: false, odc: true,
    deps: { odcFacade, odcRoot: root, answersRoot: root, lock: { o11Root: root, odcRoot: root, connection: () => null } } }));
  const ceiling = budgetCeiling(MAX_ANSWER_BYTES);
  for (const [sent, budget] of [[20000, 20000], [100000, ceiling]]) {
    ran.length = 0;
    const v = value(await client.callTool({ name: 'studio_inspect', arguments: { target: OML, kind: 'ServerAction', budgetBytes: sent, max: 10 } }));
    assert.equal(v.code, undefined, JSON.stringify(v));
    assert.deepEqual(v.inputAdjusted, [{ path: '/budgetBytes', to: '/budget', rule: 'alias' }]);
    assert.equal(ran[0].budget, budget);
    assert.deepEqual(v.next, [{ tool: 'studio_inspect', arguments: { target: OML, kind: 'ServerAction', max: 10, budget, offset: 10, expectedSourceSha256: SHA } }],
      `{budgetBytes: ${sent}}: the next page under the budget the call ran`);
  }
});

// Review of round 3 (2): a value moved to another name keeps its kind; the alias too. On a field that reads the budget as
// text (no tool of the server has one), a number is no alias: the name sent refuses with the field as its closest name.
test('a number the aliased field would read as text is no alias: refused with the closest name, as before', () => {
  const schema = z.toJSONSchema(z.object({ target: z.string().optional(), budget: z.string().optional() }).strict(), { target: 'draft-2020-12', io: 'input' });
  const number = normalizeArguments(schema, { budgetBytes: 8000 });
  assert.deepEqual(number.adjusted, []);
  assert.deepEqual(number.violations.map(v => [v.path, v.message]), [['/budgetBytes', 'is not a field here; closest: budget']]);
  assert.equal(number.corrections, null);
  const text = normalizeArguments(schema, { budgetBytes: '8000' });
  assert.deepEqual(text.violations, []);
  assert.deepEqual(text.adjusted, [{ path: '/budgetBytes', to: '/budget', rule: 'alias' }]);
  assert.deepEqual(text.args, { budget: '8000' });
});
