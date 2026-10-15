import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { ANSWER_BUDGETS, answerKind, answerEnvelope, fitAnswer, fitResult } from '../answer-size.mjs';
import { createEvidenceReader, parsePath, redact } from '../ssam-evidence.mjs';
import { discoverAll } from '../tool-routing.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';
import { createReplay } from './answer-replay.mjs';
import { createSsamServer } from '../ssam.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const tempRoot = t => {
  const base = path.join(workspace, '.local', 'answer-size-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
// The fixed fixture is expensive to produce (the offline CLI describes its grammar).
// Every invariant sees the same immutable source answers; each fit writes into its own test root.
let replayRows;
const replay = root => replayRows ??= createReplay({ root });
const fullOf = row => row.rawValue ?? row.value;
const label = row => `${row.id ?? row.tool} (${row.args?.lane ?? '-'})`;
const adjusted = (row, root) => fitAnswer(row.tool, row.args ?? {}, fullOf(row), { root });
const at = (value, pointer) => parsePath(pointer).reduce((v, k) => v[k], value);
const problemCount = value => (value.problems ?? []).reduce((n, p) => n + (p.count ?? 1), 0);
const transported = value => JSON.parse(JSON.stringify(value));

function familyRows() {
  const rows = [];
  for (const lane of ['o11', 'odc']) {
    const tool = lane === 'o11' ? 'o11_deliver' : 'studio_deliver';
    for (const count of [1, 3, 30]) for (const mixed of [false, true]) {
      const problems = Array.from({ length: count }, (_, i) => ({
        code: mixed ? `FAMILY_${i % 3}` : 'FAMILY_INVALID', phase: 'preflight', pointer: `/actions/Action${i}/steps/0`,
        message: `Action Action${i} uses an invalid value that must be corrected before the job can run.`,
        fix: `Set Action${i} to the declared type before applying this complete job.`, empty: [], absent: null,
      }));
      rows.push({ id: `family-${lane}-${count}-${mixed ? 'mixed' : 'same'}`, tool, args: { lane }, value: {
        ok: false, code: 'JOB_REFUSED', error: problems[0].message, problems,
      } });
    }
    rows.push({ id: `family-${lane}-verified-patch`, tool, args: { lane }, value: {
      ok: false, code: 'JOB_REFUSED', problems: [{ code: 'TYPE_INVALID', phase: 'check', pointer: '/actions/A',
        message: 'The action has a type mismatch that must be corrected before the job can run.',
        fix: 'Apply the verified patch to correct every invalid assignment in this action.' }],
      verifiedPatch: { file: 'verified-patch.json', sha256: '1'.repeat(64) },
      patch: Array.from({ length: 30 }, (_, i) => ({ op: 'replace', path: `/actions/A/steps/${i}/type`, value: 'Text' })),
    } });
    rows.push({ id: `family-${lane}-receipt`, tool, args: { lane }, value: {
      ok: true, result: 'entregue', module: 'Module', nextBasedOn: { job: 'job.json', sha256: '2'.repeat(64) },
      highWarnings: [{ code: 'A03', message: 'The delivered action changes a public contract used by existing consumers.' }],
      removed: Array.from({ length: 12 }, (_, i) => ({ name: `Removed${i}`, kind: 'Action' })),
      summary: { actions: 12, detail: 'A complete summary of delivery changes. '.repeat(150) }, warnings: [],
    } });
  }
  return rows;
}

// Calls carry identities (paths, intents, hashes) verbatim. Those strings are not repeated prose.
// Reading payloads are likewise protected: the requested source must never be rewritten for deduplication.
function repeatedProse(value) {
  const found = new Map(), duplicates = [];
  const walk = (node, keys = []) => {
    if (typeof node === 'string' && node.length >= 40) {
      // Exact identities are data even when two fields expose the same reference.
      if (/^(?:[A-Za-z]:[\\/]|https?:\/\/|[0-9a-f]{32,64}$|[0-9a-f-]{36}$)/i.test(node)) return;
      if (found.has(node)) duplicates.push({ first: found.get(node), again: keys.join('.'), text: node });
      else found.set(node, keys.join('.'));
    } else if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...keys, i]));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
      if (k === 'arguments' && typeof node.tool === 'string') continue;
      walk(v, [...keys, k]);
    }
  };
  walk(value);
  return duplicates;
}

function callsIn(omitted) {
  if (!omitted) return [];
  if (Array.isArray(omitted)) return omitted.flatMap(callsIn);
  return [omitted, ...(omitted.more ?? []).flatMap(callsIn)];
}

// Follow the reader's explicit pagination. A depth-truncated value is not silently accepted as exact.
function readWhole(reader, args, expected) {
  const first = reader.read(args);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.notEqual(first.truncated, true, `reader truncated ${args.pointer ?? ''}`);
  if (Object.hasOwn(first, 'value')) {
    if (typeof first.value !== 'string' || first.next === undefined) return first.value;
    let text = first.value, page = first;
    while (page.next !== undefined) {
      page = reader.read({ ...args, offset: page.next });
      assert.equal(page.ok, true); text += page.value;
    }
    return text;
  }
  assert.ok(Array.isArray(first.items), 'exact continuations must return values or items, not lossy tables');
  const items = [...first.items]; let page = first;
  while (page.next !== undefined) {
    page = reader.read({ ...args, offset: page.next });
    assert.equal(page.ok, true); assert.notEqual(page.truncated, true);
    items.push(...page.items);
  }
  if (Array.isArray(expected)) return items;
  return Object.fromEntries(items.map(item => [parsePath(item.at).at(-1), item.value]));
}

function sectionOf(value, section) {
  // A reduction stage can cover several properties of one match, rather than a JSON pointer.
  const fields = {
    'matches.notes': ['notes'], 'matches.limits': ['limits'], 'matches.summary': ['summary'],
    'matches.operations': ['operations', 'native', 'differences', 'guidance', 'negative', 'focus'],
    'matches.operations.focused': ['operations', 'native'], 'matches.operations.proofs': ['operations'],
    'matches.direct.minimal': ['category', 'why', 'proofs', 'depends', 'context', 'contract', 'negative', 'lanes', 'native', 'shared', 'score', 'summary', 'title'],
  }[section];
  if (fields) return (value.matches ?? []).map(m => ({ id: m.id, ...Object.fromEntries(fields.filter(k => Object.hasOwn(m, k)).map(k => [k, m[k]])) }));
  if (section.startsWith('matches.')) return value.matches;
  if (section === 'envelope') return Object.fromEntries(['validation', 'routes', 'lexical', 'terms', 'coverage', 'continuation', 'unavailable'].map(k => [k, value[k]]));
  if (section === 'notes') return Object.fromEntries(['coverage', 'lexical', 'continuation', 'routes'].map(k => [k, value[k]]));
  if (section === 'evidenceRule') return { evidenceRule: value.evidenceRule, matches: value.matches?.map(m => m.evidenceRule) };
  if (section.endsWith('.all')) return value[section.slice(0, -4)];
  return section.split('.').reduce((v, k) => v?.[k], value);
}

async function checkReachability(row, value, root, { discoverCuts = true } = {}) {
  const reader = createEvidenceReader({ roots: [root] }); let count = 0;
  const discoveries = new Map();
  const discover = async args => {
    const key = JSON.stringify(args);
    if (!discoveries.has(key)) discoveries.set(key, discoverAll({ ...args, sources: snapshotSources(args.lane ?? row.args?.lane) }));
    return discoveries.get(key);
  };
  for (const call of callsIn(value.omitted)) {
    assert.equal(call.tool, 'ssam_evidence', label(row));
    assert.ok(path.isAbsolute(call.arguments?.file), label(row));
    const saved = JSON.parse(fs.readFileSync(call.arguments.file, 'utf8'));
    assert.deepEqual(saved, transported(fullOf(row)), `${label(row)}: the saved answer is the entire original`);
    const expected = redact(structuredClone(at(saved, call.arguments.pointer))).value;
    assert.deepEqual(readWhole(reader, call.arguments, expected), expected, `${label(row)} ${call.arguments.pointer ?? ''}`);
    count++;
  }
  for (const entry of discoverCuts ? value.size?.truncated ?? [] : []) {
    assert.equal(entry.call?.tool, 'ssam_discover', `${label(row)} ${entry.section}: exact call`);
    const args = entry.call.arguments;
    const recovered = await discover(args);
    const whole = await discover({ ...args, budgetBytes: 1_000_000 });
    assert.equal(recovered.ok, true, `${label(row)} ${entry.section}`);
    assert.deepEqual(sectionOf(recovered, entry.section), sectionOf(whole, entry.section), `${label(row)} ${entry.section}: full section`);
    count++;
  }
  return count;
}

test('T1: the fixed R1–R4 replay fits every answer kind (readings keep their payload)', async t => {
  const root = tempRoot(t), rows = await replay(root);
  assert.ok(rows.length > 20, 'the replay includes all four families, not a single hand-picked case');
  for (const row of rows) {
    const full = fullOf(row), value = adjusted(row, root), kind = answerKind(row.tool, row.args ?? {}, full);
    const measured = bytes(kind === 'read' ? answerEnvelope(value) : value);
    assert.ok(measured <= ANSWER_BUDGETS[kind] || value.size?.status === 'inputAdjusted', `${label(row)} ${kind}: ${measured} > ${ANSWER_BUDGETS[kind]}`);
    if (kind === 'read') for (const key of ['text', 'lines', 'entries', 'elements', 'items', 'sections', 'actions', 'contents', 'html', 'flow', 'ddl', 'data', 'value']) {
      if (Object.hasOwn(full, key)) assert.deepEqual(value[key], full[key], `${label(row)}: requested ${key} stays whole`);
    }
  }
});

test('T2: every omitted part and discover reduction has an exact offline continuation', async t => {
  const root = tempRoot(t), rows = await replay(root); let count = 0;
  for (const row of rows) count += await checkReachability(row, adjusted(row, root), root);
  assert.ok(count > 0, 'the corpus exercises actual omissions');
  t.diagnostic(`${count} omitted/reduced parts checked and reachable`);
});

test('T3: adjusted replay answers carry each long prose string once', async t => {
  const root = tempRoot(t);
  for (const row of await replay(root)) {
    const value = adjusted(row, root), kind = answerKind(row.tool, row.args ?? {}, fullOf(row));
    assert.deepEqual(repeatedProse(kind === 'read' ? answerEnvelope(value) : value), [], label(row));
  }
});

test('T4: fitting an already fitted replay answer preserves object identity', async t => {
  const root = tempRoot(t);
  for (const row of await replay(root)) {
    const value = adjusted(row, root);
    assert.equal(fitAnswer(row.tool, row.args ?? {}, value, { root }), value, label(row));
  }
});

test('T1/T2/T4: explicit discover budgets bound the MCP result with exact omissions', async t => {
  const root = tempRoot(t); let parts = 0;
  for (const lane of ['o11', 'odc']) for (const budgetBytes of [2048, 5120, 12000]) {
    const args = { lane, intent: 'inspect the module data and logic', budgetBytes };
    const full = { ok: true, schemaVersion: 'ssam-discovery/1', lane, intent: args.intent,
      matches: Array.from({ length: 90 }, (_, i) => ({ id: `capability.${i}`, via: 'match',
        summary: `Capability ${i} describes the data and logic contract available to the module, including its supported inputs and outputs.`,
        operations: { inspect: { description: `Read operation ${i} returns the complete structure and the exact continuation for further details.` } } })),
      size: { budgetBytes: 40960, bytes: 0, status: 'within', truncated: [] } };
    const row = { id: `explicit-discover-${lane}-${budgetBytes}`, tool: 'ssam_discover', args, value: full };
    const raw = { content: [{ type: 'text', text: JSON.stringify(full) }], structuredContent: full };
    const fitted = fitResult(row.tool, args, raw, { root });
    const text = fitted.content.find(item => item.type === 'text').text;
    assert.ok(Buffer.byteLength(text, 'utf8') <= budgetBytes, `${row.id}: the serialized MCP answer respects the explicit budget`);
    assert.deepEqual(JSON.parse(text), transported(fitted.structuredContent), `${row.id}: text and structured content agree`);
    assert.ok(fitted.structuredContent.omitted, `${row.id}: omitted content is reachable`);
    assert.equal(fitResult(row.tool, args, fitted, { root }), fitted, `${row.id}: the second MCP exit preserves identity`);
    assert.equal(fitAnswer(row.tool, args, fitted.structuredContent, { root }), fitted.structuredContent, `${row.id}: the value also preserves identity`);
    parts += await checkReachability(row, fitted.structuredContent, root);
  }
  t.diagnostic(`6 explicit-budget MCP answers, ${parts} exact continuations checked`);
});

test('T2/T4: large arrays and objects recover exactly through bounded pagination', async t => {
  const root = tempRoot(t); let parts = 0;
  const rows = Array.from({ length: 1000 }, (_, i) => ({ index: i,
    description: `Record ${i} contains the complete original detail returned by the operation, with enough text to require pagination while retaining every field and every character.` }));
  for (const history of [rows, { rows, count: rows.length }]) {
    const row = { id: Array.isArray(history) ? 'large-array' : 'large-object', tool: 'ssam_task', args: {}, value: { ok: true, history } };
    assert.ok(bytes(row.value) > 100_000, 'the fixture exceeds the evidence reader single-page budget');
    const value = adjusted(row, root);
    assert.ok(bytes(value) <= ANSWER_BUDGETS.other, `${row.id}: small answer envelope`);
    assert.ok(callsIn(value.omitted).length <= 3, `${row.id}: paginated collections do not expand to one call per row`);
    assert.equal(fitAnswer(row.tool, row.args, value, { root }), value);
    parts += await checkReachability(row, value, root);
  }
  t.diagnostic(`2 large answers, ${parts} exact paginated continuations checked`);
});

test('T4: ssam_code write and its nested delivery create one omission envelope', async t => {
  const root = tempRoot(t);
  const answer = { ok: false, code: 'INPUT_INVALID', error: 'The proposed change has validation problems that must be corrected before delivery.',
    problems: [{ code: 'INPUT_INVALID', phase: 'validate', message: 'The proposed change has validation problems that must be corrected before delivery.', fix: 'Supply a valid definition with an explicit attribute type.' }],
    phases: [{ phase: 'validate', detail: 'Detailed validation context. '.repeat(80) }] };
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'answer-size-fake', version: '1' });
    fake.registerTool('studio_deliver', { description: 'Offline delivery fixture.', inputSchema: z.object({ feature: z.string(), module: z.string().optional(), job: z.string().optional(), owners: z.array(z.string()).optional(), changes: z.array(z.string()).optional(), until: z.string().optional(), publish: z.boolean().optional(), authorize: z.string().optional() }).strict() },
      async () => ({ content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: true }));
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot: root, answersRoot: root,
    answerBudgets: { ...ANSWER_BUDGETS, refusal: 1200 }, lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'answer-size-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'write', part: 'ddl', module: 'M', text: 'create entity A (Id Long Integer identifier auto required);' } });
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.equal(value.ok, false);
  assert.ok(bytes(value) <= 1200, 'the dependency-injected answer budget applies through both server exits');
  assert.equal(value.phases, undefined, 'the configured budget removes the detailed phase output');
  assert.ok(value.omitted && !Array.isArray(value.omitted), JSON.stringify(value));
  const nested = [];
  const walk = node => { if (!node || typeof node !== 'object') return; for (const [key, child] of Object.entries(node)) { if (key === 'omitted') nested.push(child); walk(child); } };
  walk(value);
  assert.equal(nested.length, 1);
});

test('T1–T5: family corpus conserves problems, patches, warnings and deletion counts', async t => {
  const root = tempRoot(t); let parts = 0;
  for (const row of familyRows()) {
    const value = adjusted(row, root), kind = answerKind(row.tool, row.args, row.value);
    assert.ok(bytes(value) <= ANSWER_BUDGETS[kind], `${row.id}: within ${kind} budget`);
    assert.equal(fitAnswer(row.tool, row.args, value, { root }), value, `${row.id}: same object on second pass`);
    assert.deepEqual(repeatedProse(value), [], `${row.id}: unique prose`);
    parts += await checkReachability(row, value, root);
    if (kind === 'refusal') {
      assert.equal(problemCount(value), row.value.problems.length, `${row.id}: every problem represented`);
      assert.equal(value.problemsTotal, undefined);
      if (row.value.problems.length > 1) assert.ok(value.problems.length < row.value.problems.length || new Set(row.value.problems.map(p => p.code)).size === row.value.problems.length,
        `${row.id}: equivalent problems are grouped`);
      if (row.value.verifiedPatch) {
        assert.deepEqual(value.verifiedPatch, row.value.verifiedPatch);
        assert.equal(value.patch, undefined);
        assert.equal(value.patchIn, 'verifiedPatch');
      }
    } else {
      assert.equal(value.counts?.actions ?? value.summary?.actions, row.value.summary.actions, `${row.id}: summary counts survive`);
      assert.deepEqual(value.highWarnings, row.value.highWarnings, `${row.id}: A03 is never hidden`);
      assert.equal(value.removed.length, 5);
      assert.equal(value.removedTotal, row.value.removed.length);
      assert.deepEqual(value.removed, row.value.removed.slice(0, 5));
    }
  }
  assert.ok(parts > 0);
  t.diagnostic(`${familyRows().length} family inputs, ${parts} exact continuations checked`);
});

test('T1/T2: top-level arrays and text use the same budget and exact continuation', async t => {
  const root = tempRoot(t);
  const rows = [Array.from({ length: 1000 }, (_, i) => ({ id: i, text: `Entry ${i} ` + 'x'.repeat(100) })), 'source text '.repeat(10000)];
  for (const [i, full] of rows.entries()) {
    const row = { id: `top-level-${i}`, tool: 'ssam_task', args: {}, value: full };
    const value = adjusted(row, root);
    assert.ok(bytes(value) <= ANSWER_BUDGETS.other);
    assert.equal(fitAnswer(row.tool, row.args, value, { root }), value);
    assert.equal(await checkReachability(row, value, root), 1);
  }
  t.diagnostic('2 top-level payload continuations checked');
});

test('structural URLs and business values are preserved when two fields share them', t => {
  const root = tempRoot(t), url = 'https://example.invalid/application/operations/overview';
  const row = { ok: true, url, screenUrl: url, values: ['a business value '.repeat(4), 'a business value '.repeat(4)] };
  assert.equal(fitAnswer('ssam_app_url', {}, row, { root }), row);
  const text = 'An unstructured text answer. '.repeat(3000);
  const result = fitResult('ssam_task', {}, { content: [{ type: 'text', text }] }, { root });
  assert.ok(Buffer.byteLength(result.content[0].text) <= ANSWER_BUDGETS.other);
  const value = JSON.parse(result.content[0].text);
  assert.equal(JSON.parse(fs.readFileSync(value.omitted.arguments.file, 'utf8')), text);
});

test('T5: every refusal preserves the total number of input problems in both lanes', async t => {
  const root = tempRoot(t), lanes = new Set();
  for (const row of [...await replay(root), ...familyRows()]) {
    const full = fullOf(row);
    if (full.ok !== false || !full.problems?.length) continue;
    lanes.add(row.args?.lane ?? (row.tool.startsWith('o11') ? 'o11' : 'odc'));
    const value = adjusted(row, root);
    assert.equal(problemCount(value), problemCount(full), label(row));
    assert.equal(value.problemsTotal, undefined, 'problems are grouped, never replaced by a total');
  }
  assert.deepEqual([...lanes].sort(), ['o11', 'odc']);
});

test('T6: recorded real answers retain reachable cuts and unique prose', { skip: !process.env.SSAM_ANSWER_CORPUS }, async t => {
  const root = tempRoot(t), dir = process.env.SSAM_ANSWER_CORPUS;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  assert.ok(files.length, 'the real corpus must not be empty'); let count = 0;
  for (const file of files) {
    const row = { id: file, ...JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) };
    const value = adjusted(row, root), kind = answerKind(row.tool, row.args ?? {}, fullOf(row));
    if (fullOf(row)?.schemaVersion === 'ssam-packet/1') {
      assert.equal(value, fullOf(row), 'explicit work packets retain their requested representation');
      t.diagnostic(`${file}: ${bytes(fullOf(row))} bytes, explicit work packet measured only`);
      continue;
    }
    // Historical captures contain no call arguments and cannot regenerate cuts made by the old server.
    // T2 exercises every new discovery continuation on R1; here every cut made by fitAnswer is checked.
    count += await checkReachability(row, value, root, { discoverCuts: false });
    assert.deepEqual(repeatedProse(kind === 'read' ? answerEnvelope(value) : value), [], file);
    t.diagnostic(`${file}: ${bytes(fullOf(row))} -> ${bytes(value)} bytes`);
  }
  t.diagnostic(`${files.length} real answers, ${count} omitted/reduced parts checked`);
});

// Integration marco-a2 (CX7 x CX4): the input problems of ssam_code write ({at, error, lines}) have no code. The exit groups
// them only when the error text is the same, and the group keeps that error; different ones stay whole, with their lines.
test('code-less input problems group only with the same error text and keep it', t => {
  const root = tempRoot(t);
  const lines = [{ line: 10, text: '  assign A = 1 @n1' }];
  const problems = [{ at: 'edits/0', error: 'overlapping edit with edits/1', lines }, { at: 'edits/1', error: 'overlapping edit with edits/0', lines },
    { at: 'files/0', error: 'file is empty' }, { at: 'files/1', error: 'file is empty' }];
  const value = fitAnswer('ssam_code', { action: 'write' }, { ok: false, code: 'INPUT_INVALID', error: '4 problems in the input', problems }, { root });
  assert.deepEqual(value.problems.slice(0, 2), problems.slice(0, 2));
  assert.deepEqual(value.problems[2], { count: 2, error: 'file is empty', pointers: ['files/0', 'files/1'] });
  assert.equal(value.problems.length, 3);
  assert.equal(problemCount(value), 4);
});

// Integration marco-a2 (X1 x CX7): the answer of ssam_code plan is the launch of its subagents, and the receipts of the
// generators keep what the person acts on (rest-consume configure, the entity-actions counts and kept actions).
test('a plan keeps every launch at the exit; generator receipts keep configure and the entity-actions counts', async t => {
  const root = tempRoot(t);
  const dir = 'C:/Users/someone/SSAM/.local/lane-odc/plans/0123456789abcdef';
  const check = i => ({ tool: 'ssam_code', arguments: { lane: 'odc', action: 'check', module: 'Tickets', base: 'C:/captures/Tickets.oml', files: [dir + '/data.ddl', `${dir}/batch-${i}.flow`], stubs: [`${dir}/stubs-${i}.flow`] } });
  const launchPrompt = file => `Read ${file} and do exactly what it says; answer only the path(s)`;
  const batches = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, items: [`Ticket${i}.Save`, `Ticket${i}.Load`, `Ticket${i}.Close`], estimateBytes: 2400 + i,
    files: [`${dir}/batch-${i + 1}.flow`], promptFile: `${dir}/batch-${i + 1}.prompt.md`, promptBytes: 7100 + i, launchPrompt: launchPrompt(`${dir}/batch-${i + 1}.prompt.md`), check: check(i + 1) }));
  const plan = { ok: true, lane: 'odc', module: 'Tickets', action: 'plan', planId: '0123456789abcdef', dir,
    capture: { path: 'C:/captures/Tickets.oml', sha256: 'a'.repeat(64), model: 'b'.repeat(64), at: '2026-10-13T00:00:00.000Z', ageSeconds: 3 },
    data: { file: dir + '/data.ddl', files: [dir + '/data.ddl'], promptFile: dir + '/data.prompt.md', promptBytes: 5000, launchPrompt: launchPrompt(dir + '/data.prompt.md'), check: check(0) },
    batches, final: { tool: 'ssam_code', arguments: { lane: 'odc', action: 'write', module: 'Tickets', files: [dir + '/data.ddl', ...batches.map(b => b.files[0])] } },
    launch: 'Write data first; then launch these 8 subagents now, in parallel (Claude Code: Agent tool; Codex: spawn_agent), each with its launchPrompt; when all answer, send final.' };
  assert.ok(bytes(plan) > ANSWER_BUDGETS.plan, `the fixture is above the budget (${bytes(plan)} bytes)`);
  const row = { id: 'plan-8-batches', tool: 'ssam_code', args: { lane: 'odc', action: 'plan' }, value: plan };
  assert.equal(answerKind(row.tool, row.args, plan), 'plan');
  const value = adjusted(row, root);
  assert.ok(bytes(value) <= ANSWER_BUDGETS.plan, `${bytes(value)} bytes`);
  assert.deepEqual(value.batches.map(b => [b.id, b.items, b.launchPrompt]), batches.map(b => [b.id, b.items, b.launchPrompt]));
  assert.deepEqual([value.data.file, value.data.launchPrompt, value.final, value.launch, value.planId, value.dir], [plan.data.file, plan.data.launchPrompt, plan.final, plan.launch, plan.planId, plan.dir]);
  assert.ok(await checkReachability(row, value, root) >= 1, 'what the exit left out of the plan is recovered exactly');

  const where = name => `Service Center > Factory > Modules > Vc_IS > Site Properties > ${name} (each environment)`;
  const configure = ['BrasilApiUser', 'BrasilApiPassword'].map(name => ({ name, kind: 'Site Property', secret: true, fill: 'the ' + name.slice(9).toLowerCase(), default: null, where: where(name) }));
  const receipt = { ok: true, result: 'entregue', module: 'Vc_IS',
    integration: [{ op: 'rest-consume', client: { name: 'BrasilApi', key: 'k1', created: true }, imported: Array.from({ length: 40 }, (_, i) => `IRestStructure:BrasilApiFeriado${i}`),
      skipped: [], updated: [], removed: [], consumersBroken: [], warnings: [], unchanged: [],
      generated: { client: 'BrasilApi', baseUrl: 'https://brasilapi.com.br/api', methods: Array.from({ length: 6 }, (_, i) => ({ name: `GetBrasilApiMethod${i}`, signature: `GetBrasilApiMethod${i}(Ano: Integer) -> Result: BrasilApiFeriado${i} List` })) },
      configure, changed: true }],
    entityActions: { created: 40, unchanged: 0, actions: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Entity${i}`, ['Get%List', 'Get%ById', 'Save%', 'Remove%'].map(a => a.replace('%', `Entity${i}`))])),
      kept: [{ name: 'SaveEntity0', entity: 'Entity0', why: 'an action of the same name exists and was kept' }] } };
  assert.ok(bytes(receipt) > ANSWER_BUDGETS.receipt, `the receipt fixture is above the budget (${bytes(receipt)} bytes)`);
  const receiptRow = { id: 'generators-receipt', tool: 'o11_deliver', args: { lane: 'o11' }, value: receipt };
  const fitted = adjusted(receiptRow, root);
  assert.ok(bytes(fitted) <= ANSWER_BUDGETS.receipt, `${bytes(fitted)} bytes`);
  assert.deepEqual([fitted.integration[0].op, fitted.integration[0].client, fitted.integration[0].configure], ['rest-consume', receipt.integration[0].client, configure]);
  assert.deepEqual([fitted.entityActions.created, fitted.entityActions.unchanged, fitted.entityActions.kept], [40, 0, receipt.entityActions.kept]);
  assert.ok(await checkReachability(receiptRow, fitted, root) >= 1, 'what the exit left out of the receipt is recovered exactly');
});
