import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as budget from '../context-budget.mjs';
import { createSsamServer, pageAnswer } from '../ssam.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { answerKind, fitAnswer } from '../answer-size.mjs';

const facade = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bytes = v => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v));
const valueOf = r => r.structuredContent ?? JSON.parse(r.content[0].text);
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

test('B5a: no obsolete answer ceilings remain in production facade modules', () => {
  const visit = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? e.name === 'tests' ? [] : visit(path.join(dir, e.name)) : e.name.endsWith('.mjs') ? [path.join(dir, e.name)] : []);
  for (const file of visit(facade)) {
    if (file.endsWith('context-budget.mjs')) continue;
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\b(?:40960|38912)\b|40\s*\*\s*1024/, path.relative(facade, file));
  }
});

test('B5b: one source owns every answer family budget and its headroom', () => {
  assert.equal(budget.ANSWER_CEILING_BYTES, 30720);
  assert.equal(budget.MAX_ANSWER_BYTES, budget.ANSWER_CEILING_BYTES);
  // R4 (24/10/2026): at 8 KB the packet was mostly cuts and next; 24 KB holds scope, text and the owner's reading.
  assert.equal(budget.PACKET_DEFAULT_BYTES, 24576);
  assert.equal(budget.ANSWER_BUDGETS.packet, budget.PACKET_DEFAULT_BYTES);
  assert.equal(budget.PACKET_MAX_BYTES, budget.budgetCeiling());
  assert.equal(budget.EXPANSION_DEFAULT_BYTES, budget.budgetCeiling());
  assert.ok(budget.RECOVERY_PART_BYTES <= budget.budgetCeiling());
  for (const [kind, n] of Object.entries(budget.ANSWER_BUDGETS)) assert.ok(n <= budget.budgetCeiling(), kind);
  assert.equal(budget.maxAnswerBytes({}), budget.ANSWER_CEILING_BYTES);
  assert.equal(budget.maxAnswerBytes({ SSAM_MAX_ANSWER_BYTES: '65536' }), budget.ANSWER_CEILING_BYTES);
  assert.equal(budget.maxAnswerBytes({ SSAM_MAX_ANSWER_BYTES: '8192' }), 8192);
  assert.equal(answerKind('ssam_discover', { packet: true }, { ok: true }), 'packet');
});

test('B5c: all answer families, including evidence and native SQL, obey the ceiling through MCP', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx11-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = Array.from({ length: 1200 }, (_, i) => ({ id: i, text: 'row ' + i + ': ' + 'é'.repeat(80) }));
  let full = { ok: true, rows };
  assert.ok(bytes(full) > 100000);
  const server = await createSsamServer({ o11: false, odc: false, deps: {
    answersRoot: root, queryTest: { o11: async () => full }, evidence: { reader: { read: () => full } }, codePlan: async () => full,
    lock: { o11Root: root, odcRoot: root, connection: () => null },
  } });
  for (const name of ['ssam_discover', 'ssam_map', 'o11_deliver', 'studio_deliver', 'budget_probe']) {
    server.registerTool(name, { description: 'Budget fixture.', inputSchema: z.object({ packet: z.boolean().optional(), expand: z.string().optional() }) }, async () => reply(full));
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx11-budget', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const cases = [
    ['ssam_discover', {}, 'discoverFirst'], ['ssam_discover', { packet: true }, 'packet'],
    ['ssam_discover', { expand: 'logic' }, 'other'], ['ssam_map', {}, 'read'],
    ['o11_deliver', {}, 'receipt'], ['studio_deliver', {}, 'receipt'], ['budget_probe', {}, 'other'],
    ['ssam_code', { lane: 'odc', action: 'plan', items: [] }, 'plan'],
    ['ssam_evidence', { file: path.join(root, 'fixture.json') }, 'other'],
    ['ssam_query_test', { lane: 'o11', op: 'status', operationId: '72df438d-5510-41e8-9839-66247a99e13b' }, 'other'],
  ];
  for (const [name, args, kind] of cases) {
    full = { ok: true, rows };
    assert.equal(answerKind(name, args, full), kind);
    const result = await client.callTool({ name, arguments: args });
    assert.ok(bytes(result.content[0].text) <= budget.ANSWER_CEILING_BYTES, name);
    const value = valueOf(result), recovery = value.omitted ?? value.continuation;
    assert.equal(recovery?.tool, 'ssam_evidence', name + ': exact evidence call');
    assert.deepEqual(JSON.parse(fs.readFileSync(recovery.arguments.file, 'utf8')).rows, rows, name + ': original rows');
    const reader = createEvidenceReader({ roots: [root] });
    const recovered = reader.read({ file: recovery.arguments.file, pointer: '/rows/1199/id' });
    assert.equal(recovered.value, 1199, name + ': call points to readable evidence');
  }
  full = { ok: false, code: 'FIXTURE_REFUSED', diagnostics: rows };
  const refused = await client.callTool({ name: 'studio_deliver', arguments: {} });
  assert.equal(valueOf(refused).ok, false);
  assert.ok(bytes(refused.content[0].text) <= budget.ANSWER_CEILING_BYTES);
  const call = valueOf(refused).omitted ?? valueOf(refused).continuation;
  assert.equal(call.tool, 'ssam_evidence');
  assert.deepEqual(JSON.parse(fs.readFileSync(call.arguments.file, 'utf8')).diagnostics, rows);
});

test('B5c: safety paging preserves exact continuations for arrays and long scalar text', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx11-scalar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const full of [Array.from({ length: 3000 }, (_, i) => ({ i, text: 'x'.repeat(50) })), { ok: true, text: 'é'.repeat(60000) }, 'x'.repeat(100000)]) {
    const result = pageAnswer(reply(full), { root });
    const value = valueOf(result);
    assert.ok(bytes(result.content[0].text) <= budget.ANSWER_CEILING_BYTES);
    assert.equal(value.paged.complete, false);
    assert.equal(value.continuation.tool, 'ssam_evidence');
    assert.equal(value.continuation.arguments.pointer, Array.isArray(full) || typeof full === 'string' ? '' : '/text');
    assert.deepEqual(JSON.parse(fs.readFileSync(value.paged.file, 'utf8')), full);
  }
});

test('B5c: wide documents cannot exceed the ceiling through recovery metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx11-wide-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const full = { ok: false, code: 'WIDE_REFUSAL', ...Object.fromEntries(Array.from({ length: 2000 }, (_, i) => ['field' + i, { value: 'x'.repeat(60) }])) };
  for (const maxBytes of [4096, budget.ANSWER_CEILING_BYTES]) {
    const result = pageAnswer({ ...reply(full), isError: true }, { root, maxBytes });
    assert.ok(bytes(result.content[0].text) <= maxBytes);
    const value = valueOf(result);
    assert.equal(value.ok, false);
    assert.equal(result.isError, true);
    assert.equal(value.continuation.tool, 'ssam_evidence');
    assert.deepEqual(JSON.parse(fs.readFileSync(value.paged.file, 'utf8')), full);
  }
});

test('B5d: the MCP discover proxy preserves an omitted budget for both lanes', async t => {
  const { McpServer } = await import('@modelcontextprotocol/server');
  const forwarded = [];
  const facade = new McpServer({ name: 'budget-fixture', version: '1' });
  facade.registerTool('ssam_discover', { description: 'Offline budget fixture.', inputSchema: z.object({
    lane: z.enum(['o11', 'odc']), intent: z.string(), packet: z.boolean().optional(), budgetBytes: z.number().optional(),
  }) }, async args => { forwarded.push(args); return reply({ ok: true, receivedBudget: args.budgetBytes ?? null }); });
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade: async () => facade,
    identity: { read: () => ({ facadeSha256: 'fixed', catalogSha256: 'fixed' }) },
  } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx11-default', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); await facade.close(); });
  for (const lane of ['o11', 'odc']) {
    const result = await client.callTool({ name: 'ssam_discover', arguments: { lane, intent: 'create an entity', packet: true } });
    assert.equal(valueOf(result).receivedBudget, null);
    assert.equal(Object.hasOwn(forwarded.at(-1), 'budgetBytes'), false, lane);
    await client.callTool({ name: 'ssam_discover', arguments: { lane, intent: 'create an entity', packet: true, budgetBytes: 12000 } });
    assert.equal(forwarded.at(-1).budgetBytes, 12000, lane);
  }
  assert.equal(forwarded.length, 4);
});


test('B5 explicit expansion keeps every named part while a late model envelope fits its requested budget', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx11-expanded-envelope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const full = { ok: true, schemaVersion: 'ssam-discovery/4', lane: 'o11', intent: 'model and named expansion',
    matches: Array.from({ length: 100 }, (_, i) => ({ id: i, data: 'model'.repeat(50) })),
    expansions: { 'ui.fixture': { contract: { tags: ['input', 'select'], required: ['name'] } } },
    continuations: { next: { tool: 'ssam_discover', arguments: { lane: 'o11', expand: 'ui.fixture:example' } } },
    size: { budgetBytes: 16000, bytes: 0, truncated: [{ section: 'fixture', call: { tool: 'ssam_discover', arguments: { lane: 'o11', intent: 'model and named expansion', budgetBytes: 60000 } } }] } };
  const fitted = fitAnswer('ssam_discover', { expand: 'ui.fixture:contract', budgetBytes: 16000 }, full, { root });
  assert.ok(bytes(fitted) <= 16000);
  assert.deepEqual(fitted.expansions, full.expansions);
  assert.deepEqual(fitted.continuations, full.continuations);
  assert.strictEqual(fitAnswer('ssam_discover', { expand: 'ui.fixture:contract', budgetBytes: 16000 }, fitted, { root }), fitted);
  assert.equal(fitted.omitted.tool, 'ssam_evidence');
  const saved = JSON.parse(fs.readFileSync(fitted.omitted.arguments.file, 'utf8'));
  assert.deepEqual(saved, full);
  const reader = createEvidenceReader({ roots: [root] });
  assert.deepEqual(reader.read({ file: fitted.omitted.arguments.file, pointer: '/matches/99' }).value, full.matches[99]);
  const catalog = { ok: true, toolGroups: { fixtures: Array.from({ length: 100 }, (_, i) => ({ id: i, native: 'x'.repeat(100) })) } };
  assert.deepEqual(fitAnswer('ssam_discover', { catalog: true, budgetBytes: 4096 }, catalog, { root }).toolGroups, catalog.toolGroups);
  const refusal = { ok: false, code: 'ALL_PROBLEMS', problems: Array.from({ length: 100 }, (_, i) => ({ code: 'P' + i, message: 'Unique problem ' + i + ' ' + 'x'.repeat(100) })) };
  const refused = fitAnswer('ssam_discover', { expand: 'ui.fixture:contract', budgetBytes: 4096 }, refusal, { root });
  assert.equal(refused.code, refusal.code);
  assert.deepEqual(refused.problems.map(p => p.code).sort(), refusal.problems.map(p => p.code).sort());
});
