import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { fitAnswer, fitResult, normalizeOutputWarnings, ANSWER_BUDGETS } from '../answer-size.mjs';
import { createSsamServer } from '../ssam.mjs';
import { createReplay } from './answer-replay.mjs';
import { warningFields } from '../delivery-warnings.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rootOf = t => {
  const base = path.join(workspace, '.local', 'output-warnings-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const message = 'Related entities are read and used together by the same action; use one aggregate with a join.';
const high = [
  { id: 'AGGREGATES_MERGEABLE', severity: 'high', message, detail: message, fix: message, owner: 'QrSummary', suggestion: { get: 'QrOrder', sources: ['QrLine'] } },
  { id: 'QUERY_IN_LOOP', severity: 'high', message, detail: message, fix: message, owner: 'Legacy' },
];
const low = { id: 'UnusedElement', severity: 'warning', detail: 'The candidate contains an unused element that can be removed later.', count: 3 };
const source = () => ({ ok: true, highWarnings: structuredClone(high), warnings: [...structuredClone(high), structuredClone(low)] });

function assertWarningContract(value, expectedHigh = high) {
  assert.deepEqual(value.highWarnings, expectedHigh, 'every HIGH entry stays complete');
  for (const warning of value.warnings ?? []) {
    assert.equal(value.highWarnings.some(item => {
      try { assert.deepEqual(item, warning); return true; } catch { return false; }
    }), false, 'warnings never repeats an entry of highWarnings');
  }
}

test('B6: both lane receipts and refusals obey the warning policy through MCP', async t => {
  const root = rootOf(t);
  const rows = (await createReplay({ root, includeDiscover: false, includeExtended: true })).filter(row => row.source === 'R6');
  assert.equal(rows.length, 4);
  const selected = new Map();
  const server = await createSsamServer({ o11: false, odc: false, deps: {
    answersRoot: root, writeLock: async (_request, execute) => execute(),
    identity: { read: () => ({ name: 'ssam', root: workspace, release: { facadeSha256: 'fixed', catalogSha256: 'fixed', launcherSha256: 'fixed' } }) },
  } });
  for (const tool of ['o11_deliver', 'studio_deliver']) server.registerTool(tool, {
    description: 'Offline fixture of a final delivery response.', inputSchema: z.object({ lane: z.enum(['o11', 'odc']) }),
  }, async () => reply(structuredClone(selected.get(tool))));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'output-warnings-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  for (const row of rows) {
    const input = structuredClone(row.rawValue), before = structuredClone(input);
    selected.set(row.tool, input);
    const result = await client.callTool({ name: row.tool, arguments: { lane: row.id.includes('-o11-') ? 'o11' : 'odc' } });
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.equal(value.ok, input.ok, row.id);
    assertWarningContract(value, input.highWarnings);
    assert.deepEqual(input, before, `${row.id}: source unchanged`);
    assert.equal(fitAnswer(row.tool, row.args, value, { root }), value, `${row.id}: second pass preserves identity`);
    assert.deepEqual(fitAnswer(row.tool, row.args, value, { root }), value);
  }
});

test('B6: normalize only the response envelope; warning totals include each HIGH once', () => {
  const original = source(), snapshot = structuredClone(original);
  const value = normalizeOutputWarnings(original);
  assertWarningContract(value);
  assert.deepEqual(value.warnings, [low]);
  assert.equal(value.highWarnings, original.highWarnings);
  assert.equal(value.warningsTotal, undefined, 'all warnings remain represented by warnings plus highWarnings');
  assert.equal(normalizeOutputWarnings(value), value);
  assert.deepEqual(original, snapshot);
  for (const total of [1, 5, 30]) {
    const withTotal = normalizeOutputWarnings({ ...source(), warningsTotal: total });
    assert.equal(withTotal.warningsTotal, Math.max(total, 5));
  }
  const reversed = Object.fromEntries(Object.entries(high[0]).reverse());
  assert.deepEqual(normalizeOutputWarnings({ highWarnings: [high[0]], warnings: [reversed] }).warnings, []);
  for (const total of [undefined, 1, 20]) {
    const grouped = { highWarnings: [structuredClone(high[0])], warnings: [{ ...reversed, count: 3 }, low], ...(total === undefined ? {} : { warningsTotal: total }) };
    const groupedSnapshot = structuredClone(grouped);
    const normalized = normalizeOutputWarnings(grouped);
    assert.deepEqual(normalized.warnings, [low], 'count is multiplicity, not warning identity');
    assert.deepEqual(normalized.highWarnings, grouped.highWarnings);
    assert.equal(normalized.warningsTotal, Math.max(total ?? 0, 6), 'three HIGH occurrences plus three LOW occurrences');
    assert.equal(normalizeOutputWarnings(normalized), normalized);
    assert.deepEqual(grouped, groupedSnapshot);
  }
  const nestedCount = { highWarnings: [{ ...high[0], suggestion: { count: 2 } }], warnings: [{ ...high[0], count: 3, suggestion: { count: 4 } }] };
  assert.equal(normalizeOutputWarnings(nestedCount), nestedCount, 'business count inside nested data remains part of identity');
  const ordinary = { warnings: [low] };
  assert.equal(normalizeOutputWarnings(ordinary), ordinary);
  const nested = { ok: true, value: source() };
  assert.equal(normalizeOutputWarnings(nested), nested, 'requested JSON content stays byte-for-byte intact');
  const fields = warningFields([high[0], low]);
  assert.deepEqual(fields.highWarnings, [high[0]]);
  assert.ok(fields.warnings.some(item => item.id === high[0].id), 'warningFields source contract remains unchanged');
});

test('B6: every output family applies the rule before early returns and keeps HIGH prose complete', t => {
  const root = rootOf(t);
  for (const [tool, args, extra] of [
    ['o11_deliver', {}, {}], ['studio_deliver', {}, { ok: false, error: 'refused' }],
    ['ssam_map', {}, {}], ['ssam_reference', {}, {}], ['unknown_future_tool', {}, {}],
    ['ssam_discover', {}, {}], ['ssam_discover', { packet: true }, { schemaVersion: 'ssam-packet/1' }],
    ['ssam_map', {}, { paged: { schema: 'fixture' } }],
    ['ssam_map', {}, { omitted: { tool: 'ssam_evidence', arguments: { file: 'fixture.json' } } }],
    ['ssam_evidence', {}, { value: source() }], ['ssam_query_test', {}, {}],
  ]) {
    const full = { ...source(), ...extra }, snapshot = structuredClone(full);
    const value = fitAnswer(tool, args, full, { root });
    assertWarningContract(value);
    assert.equal(fitAnswer(tool, args, value, { root }), value, `${tool}: same identity`);
    assert.deepEqual(fitAnswer(tool, args, value, { root }), value);
    assert.deepEqual(full, snapshot, `${tool}: input untouched`);
    if (full.value) assert.deepEqual(value.value, full.value, 'evidence inner source stays exact');
    const result = fitResult(tool, args, reply(full), { root });
    assertWarningContract(result.structuredContent);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
});

test('B6: warning cuts preserve total and recover the original source; HIGH is never prose-deduplicated', t => {
  const root = rootOf(t);
  const full = { ...source(), warnings: [...high, ...Array.from({ length: 40 }, (_, index) => ({ id: `LOW_${index}`, detail: `${index}: ` + 'non-blocking warning content '.repeat(20) }))] };
  const snapshot = structuredClone(full);
  const value = fitAnswer('o11_deliver', {}, full, { root });
  assertWarningContract(value);
  assert.equal(value.warnings, undefined);
  assert.equal(value.warningsTotal, 42);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= ANSWER_BUDGETS.receipt);
  assert.ok(value.omitted?.arguments?.file);
  assert.deepEqual(JSON.parse(fs.readFileSync(value.omitted.arguments.file, 'utf8')), full, 'evidence keeps the unmodified input');
  assert.equal(fitAnswer('o11_deliver', {}, value, { root }), value);
  assert.deepEqual(full, snapshot);
});

test('B6: HIGH prose still removes duplicate LOW prose, with exact original recovery', t => {
  const root = rootOf(t);
  const lowDistinct = { id: 'LOW_DISTINCT', severity: 'warning', detail: message, fix: 'Review the distinct LOW condition.' };
  const full = { ok: false, error: message, highWarnings: structuredClone(high), warnings: [...structuredClone(high), lowDistinct] };
  const snapshot = structuredClone(full);
  const value = fitAnswer('o11_deliver', {}, full, { root });
  assertWarningContract(value);
  assert.equal(value.warnings[0].id, 'LOW_DISTINCT');
  assert.equal(value.warnings[0].detail, undefined, 'LOW repeats HIGH prose and follows the existing CX7 rule');
  assert.equal(value.error, undefined, 'repeated error prose follows the existing CX7 rule');
  assert.ok(value.omitted?.arguments?.file);
  assert.deepEqual(JSON.parse(fs.readFileSync(value.omitted.arguments.file, 'utf8')), full);
  assert.equal(fitAnswer('o11_deliver', {}, value, { root }), value);
  assert.deepEqual(full, snapshot);
  const argumentText = 'A call argument is executable data and must not be seeded as editorial prose from HIGH warnings.';
  const withArguments = { ok: true, highWarnings: [{ id: 'HIGH_CALL', tool: 'fixture', arguments: { detail: argumentText } }], warnings: [{ id: 'LOW_KEPT', detail: argumentText }] };
  const argumentsKept = fitAnswer('o11_deliver', {}, withArguments, { root });
  assert.deepEqual(argumentsKept.highWarnings, withArguments.highWarnings);
  assert.equal(argumentsKept.warnings[0].detail, argumentText, 'HIGH call arguments are excluded from the seed');
  const indexed = { ok: true, highWarnings: structuredClone(high), warnings: [...structuredClone(high), { id: 'LOW_DESCRIPTION', description: message }] };
  const indexedResult = fitAnswer('o11_deliver', {}, indexed, { root });
  assert.equal(indexedResult.warnings[0].description, undefined);
  assert.equal(indexedResult.omitted.arguments.pointer, '/warnings', 'recovery indexes address the original warning list');
  const indexedSource = JSON.parse(fs.readFileSync(indexedResult.omitted.arguments.file, 'utf8'));
  assert.deepEqual(indexedSource.warnings, indexed.warnings);
});

test('prebudgeted packet parts pass through exactly and idempotently', t => {
  const root = rootOf(t);
  const part = { ok: true, schemaVersion: 'ssam-packet-part/1', lane: 'o11', section: 'text',
    value: { description: message.repeat(15), note: message.repeat(15) }, size: { budgetBytes: 8192 } };
  const snapshot = structuredClone(part);
  const value = fitAnswer('ssam_discover', { expand: 'packet:fixture:text' }, part, { root });
  assert.equal(value, part);
  assert.deepEqual(value, snapshot);
  assert.equal(fitAnswer('ssam_discover', { expand: 'packet:fixture:text' }, value, { root }), value);
  const result = reply(part);
  assert.equal(fitResult('ssam_discover', { expand: 'packet:fixture:text' }, result, { root }), result);
});
