import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEvidenceReader, evidenceRoots, registerSsamEvidence, parsePath, parseClause, DEFAULT_BUDGET } from '../ssam-evidence.mjs';
import { linked } from './fixtures/o11env-kernel.mjs';

// A temporary installation: the O11 kernel (.local) and the ODC platform (journal, lab, snapshots), with evidence in
// the shapes SSAM writes (inspect out, deliver result.json, journals, lab receipts, snapshot catalog and sidecars).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-evidence-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const kernel = path.join(tmp, 'kernel'), odc = path.join(tmp, 'odc'), outside = path.join(tmp, 'outside');
const roots = evidenceRoots({ anvil: kernel, odc });
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); return file; };
const lines = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

const js = 'function init(map) {\n' + '  // pin logic\n'.repeat(400) + '}\n';
const tree = {
  kind: 'MobileScreen', name: 'Location', key: 'k0', childrenTotal: 5,
  properties: { Title: 'Location' },
  children: [
    { kind: 'LocalVariable', name: 'Current', properties: { DataType: 'Structure:Indication' }, children: [] },
    { kind: 'LocalVariable', name: 'Busy', properties: { DataType: 'BasicType:Boolean' }, children: [] },
    { kind: 'ScreenAction', name: 'LoadMap', properties: {}, children: [
      { kind: 'JavaScriptNode', name: 'InitializeMaps', properties: { JavaScript: js }, children: [] },
      { kind: 'ExecuteClientActionNode', name: 'Call1', properties: { Action: 'ClientAction:StateRead' }, children: [] },
    ] },
    { kind: 'ScreenAction', name: 'ConfirmLocation', properties: {}, children: [
      { kind: 'ExecuteClientActionNode', name: 'Call2', properties: { Action: 'ClientAction:StateRead' }, children: [] },
      { kind: 'If', name: 'Check', properties: { Condition: 'CanAdjustPin and Ready' }, children: [] },
    ] },
    { kind: 'Container', name: 'Panel', properties: { Visible: 'True', Style: 'card' }, children: [
      { kind: 'Container', name: 'Inner', properties: { Visible: 'Busy' }, children: [] },
    ] },
  ],
};
const inspect = put(path.join(kernel, '.local', 'reading', 'inspect-1b2c3d4e-0000-4000-8000-000000000001.json'), { module: 'Quotes', sourceSha256: 'AB12', tree });
const odcInspect = put(path.join(odc, 'journal', 'inspect', 'Quotes.MobileScreen-Location.d2.json'), { module: 'Quotes', tree });
const result = put(path.join(kernel, '.local', 'work', 'deliver', 'task1', 'result.json'), {
  taskId: 'task1', ok: false, delivered: false, stage: 'validate-job', writeState: 'not-sent', module: 'Orders_CS',
  validation: { new: 3, fixed: 0, total: 3 },
  newErrors: Array.from({ length: 12 }, (_, i) => ({ id: 'E' + i, message: i % 4 === 0 ? 'Invalid expression in If' : 'Required connector missing', element: 'Action' + i })),
  merge: { state: 'skipped', hasConflicts: false },
  next: 'fix the job and deliver again',
});
const journal = put(path.join(odc, 'journal', 'operations.jsonl'), lines([
  { ts_start: '2026-09-16T18:10:00Z', tool: 'bridge', command: 'status', outcome: 'ok', gate: 'none' },
  { ts_start: '2026-09-16T18:25:00Z', tool: 'bridge', command: 'snapshot', outcome: 'ok', gate: 'none' },
  { ts_start: '2026-09-16T18:40:00Z', tool: 'builder', command: 'deliver', outcome: 'error', error: 'merge refused', gate: 'words', authorize: 'sim, pode entregar' },
  { ts_start: '2026-09-16T19:05:00Z', tool: 'bridge', command: 'publish', outcome: 'ok', gate: 'words' },
]) + '{"ts_start":"2026-09-16T19:06:00Z","tool":"bri');
const o11Journal = put(path.join(kernel, '.local', 'journal', 'o11_deliver.jsonl'), lines([{ at: 1, phase: 'start', authorizeSha256: 'c0ffee' }, { at: 2, phase: 'end', delivered: true }]));
const receipt = put(path.join(odc, 'lab', '27-data-create', 'builder-receipt.json'), { feature: 'lab-data-create', ok: true, elapsedMs: 16229, candidateErrors: [], validationErrors: [], checks: 4 });
const checks = put(path.join(odc, 'lab', '27-data-create', 'feature-checks.json'), { informative: true, feature: 'lab-data-create', passed: ['a', 'b', 'c', 'd'] });
const modules = put(path.join(odc, 'snapshots', 'modules.json'), { tenant: 'example.outsystems.dev', modules: { Quotes: { key: 'q1', kind: 'CrossDevice' }, Orders: { key: 'o1', kind: 'Service' }, Utils: { key: 'u1', kind: 'Service' } } });
const jobResult = put(path.join(kernel, '.local', 'lane-odc', 'jobs', 'probe.result.json'), { ok: true, data: { results: [{ op: 'get', result: { properties: { StyleSheet: 'x'.repeat(50) } } }] } });
const studioReceipt = put(path.join(kernel, '.local', 'work', 'receipts', 'studio-publish-Orders_UI-20260916.json'), { module: 'Orders_UI', published: true, state: 'CompletedWithSuccess', elapsedMs: 12940 });
const secrets = put(path.join(kernel, '.local', 'data', 'requests', 'r1.json'), {
  operation: 'insert', authorization: 'sim, pode inserir', authorize: 'palavras do usuario',
  connection: { host: 'h', password: 'hunter2', apiKey: 'k-123', token: 'tok-abc', Cookie: 'sid=1', outputTokens: 42, authorized: true },
  header: 'Bearer abcdefghijklmnopqrstuvwxyz123456', note: 'plain text',
});
put(path.join(outside, 'secret.json'), { password: 'outside' });
put(path.join(outside, 'data.json'), { leaked: 'outside data' });

const reader = createEvidenceReader({ roots });
const read = input => reader.read(input);
const within = (value, budget = DEFAULT_BUDGET) => assert.ok(Buffer.byteLength(JSON.stringify(value)) <= budget, 'answer of ' + Buffer.byteLength(JSON.stringify(value)) + ' bytes: ' + JSON.stringify(value).slice(0, 300));
// A shell command in an answer: an interpreter, a script, or the ssam/odc CLI with a verb (lowercase, as typed).
const SHELL = { test: text => /python|node\s+-e|powershell|pwsh|\.ps1|ConvertFrom-Json|dotnet\s/i.test(text) || /(^|[\s"'`])(ssam|odc)(\.cmd)?\s+[a-z]/.test(text) };

test('paths: pointers and dotted paths, where clauses', () => {
  assert.deepEqual(parsePath('/tree/children/0'), ['tree', 'children', '0']);
  assert.deepEqual(parsePath('tree.children[0].name'), ['tree', 'children', '0', 'name']);
  assert.deepEqual(parsePath('/a~1b/c~0d'), ['a/b', 'c~d']);
  assert.deepEqual(parsePath(''), []); assert.deepEqual(parsePath('/'), []);
  assert.deepEqual(parseClause('kind=JavaScriptNode'), { field: 'kind', keys: ['kind'], op: '=', value: 'JavaScriptNode', lower: 'javascriptnode' });
  assert.equal(parseClause('ts_start>=2026-09-16').op, '>=');
  assert.equal(parseClause('note~a=b').op, '~'); assert.equal(parseClause('note~a=b').value, 'a=b');
  assert.equal(parseClause('~CanAdjust').keys, null);
  assert.equal(parseClause('name="A B"').value, 'A B');
  // A bare field is a clause of its own (C21): exists and is not empty; "!field" the opposite; text with spaces is not.
  assert.deepEqual(parseClause('nothing'), { field: 'nothing', keys: ['nothing'], op: 'present', value: '', lower: '' });
  assert.equal(parseClause('!nothing').op, 'absent');
  assert.equal(parseClause('nothing at all'), null);
});

// ---- the top patterns of tests/bench/baseline/scripts-improvisados.mjs, one by one
test('inspect -> shape: without arguments an object shows what fits, nested parts summarized', () => {
  const value = read({ file: inspect });
  assert.equal(value.ok, true); within(value);
  assert.equal(value.value.module, 'Quotes');
  assert.equal(value.truncated, true, 'the tree does not fit whole');
  assert.ok(JSON.stringify(value.value.tree).length < 1500);
});

test('inspect -> fields and nested paths: select reads several paths at once', () => {
  const value = read({ file: inspect, select: ['/module', 'tree.kind', 'tree.childrenTotal', '/tree/children/2/name', 'tree.nothing'] });
  assert.deepEqual(value.values, { '/module': 'Quotes', 'tree.kind': 'MobileScreen', 'tree.childrenTotal': 5, '/tree/children/2/name': 'LoadMap' });
  assert.deepEqual(value.missing, ['tree.nothing']);
});

test('inspect -> tree walk + filter: deep finds nodes by kind at any depth, with their pointers', () => {
  const value = read({ file: inspect, deep: true, where: 'kind=ExecuteClientActionNode', fields: ['name', 'properties.Action'] });
  assert.equal(value.total, 2);
  assert.deepEqual(value.items, [
    { at: '/tree/children/2/children/1', name: 'Call1', 'properties.Action': 'ClientAction:StateRead' },
    { at: '/tree/children/3/children/0', name: 'Call2', 'properties.Action': 'ClientAction:StateRead' },
  ]);
  const node = read({ file: inspect, pointer: value.items[1].at, select: ['kind', 'name'] });
  assert.deepEqual(node.values, { kind: 'ExecuteClientActionNode', name: 'Call2' });
  // two clauses, a contains and an equality on an ODC inspect under journal/inspect
  const both = read({ file: odcInspect, pointer: '/tree', deep: true, where: ['kind=Container', 'properties.Visible~busy'], fields: ['name'] });
  assert.deepEqual(both.items, [{ at: '/tree/children/4/children/0', name: 'Inner' }]);
});

test('inspect -> text search: a node is found by text in its own properties, not each ancestor', () => {
  const value = read({ file: inspect, deep: true, where: '~CanAdjustPin' });
  assert.equal(value.total, 1);
  assert.equal(value.items[0].at, '/tree/children/3/children/1/properties');
});

test('inspect -> counts and group counts: max 0 answers only the total; groupBy counts by field', () => {
  assert.deepEqual(read({ file: inspect, deep: true, where: 'kind=ScreenAction', max: 0 }), { ok: true, total: 2 });
  const groups = read({ file: inspect, pointer: '/tree/children', groupBy: 'kind' });
  assert.deepEqual(groups, { ok: true, total: 5, distinct: 3, groups: [['LocalVariable', 2], ['ScreenAction', 2], ['Container', 1]] });
});

test('inspect -> outline: deep + fields [kind, name] + depth lists the levels asked, without property bags', () => {
  const value = read({ file: inspect, pointer: '/tree', deep: true, depth: 1, fields: ['kind', 'name'] });
  assert.equal(value.total, 5);
  assert.deepEqual(value.items.map(i => i.name), ['Current', 'Busy', 'LoadMap', 'ConfirmLocation', 'Panel']);
  assert.equal(read({ file: inspect, pointer: '/tree', deep: true, fields: ['kind', 'name'], max: 0 }).total, 10);
});

test('inspect -> a long string (JavaScript of a node) pages by characters and comes back whole', () => {
  const pointer = '/tree/children/2/children/0/properties/JavaScript';
  let offset = 0, text = '', calls = 0;
  for (;;) {
    const part = read({ file: inspect, pointer, ...(offset ? { offset } : {}) });
    within(part); calls++;
    assert.equal(part.total, js.length);
    text += part.value;
    if (part.next === undefined) break;
    offset = part.next;
  }
  assert.equal(text, js); assert.ok(calls > 2);
});

test('delivery result -> fields, first N, text search and the whole file under the budget', () => {
  const fields = read({ file: result, select: ['/ok', '/delivered', '/stage', '/writeState', '/validation/new'] });
  assert.deepEqual(fields.values, { '/ok': false, '/delivered': false, '/stage': 'validate-job', '/writeState': 'not-sent', '/validation/new': 3 });
  const first = read({ file: result, pointer: '/newErrors', max: 3 });
  assert.equal(first.total, 12); assert.equal(first.items.length, 3); assert.equal(first.next, 3); assert.equal(first.items[0].id, 'E0');
  const search = read({ file: result, pointer: '/newErrors', where: 'message~invalid expression', fields: ['id'] });
  assert.deepEqual(search.items, [{ at: '/newErrors/0', id: 'E0' }, { at: '/newErrors/4', id: 'E4' }, { at: '/newErrors/8', id: 'E8' }]);
  const whole = read({ file: result });
  within(whole); assert.equal(whole.value.taskId, 'task1');
  const job = read({ file: jobResult, select: ['/data/results/0/op', '/data/results/-1/result/properties/StyleSheet'] });
  assert.deepEqual(job.values, { '/data/results/0/op': 'get', '/data/results/-1/result/properties/StyleSheet': 'x'.repeat(50) });
});

test('journal (JSONL) -> tail, filter, time range, group count; a torn last line is skipped and counted', () => {
  const tail = read({ file: journal, offset: -2 });
  assert.equal(tail.total, 4); assert.equal(tail.offset, 2); assert.equal(tail.badLines, 1);
  assert.deepEqual(tail.items.map(i => i.command), ['deliver', 'publish']);
  assert.equal(tail.items[0].authorize, '[redacted]', 'the user words never come back');
  const errors = read({ file: journal, where: 'outcome=error', fields: ['command', 'error'] });
  assert.deepEqual(errors.items, [{ at: '/2', command: 'deliver', error: 'merge refused' }]);
  const range = read({ file: journal, where: ['ts_start>=2026-09-16T18:20', 'ts_start<2026-09-16T19:00'], fields: ['command'] });
  assert.deepEqual(range.items.map(i => i.command), ['snapshot', 'deliver']);
  assert.deepEqual(read({ file: journal, groupBy: 'tool' }).groups, [['bridge', 3], ['builder', 1]]);
  const o11 = read({ file: o11Journal, where: 'phase=end' });
  assert.deepEqual(o11.items, [{ at: '/1', value: { at: 2, phase: 'end', delivered: true } }]);
  assert.equal(read({ file: o11Journal, pointer: '/0/authorizeSha256' }).value, 'c0ffee', 'a hash of the words is not the words');
});

test('lab receipt, checks, snapshot catalog and studio receipts', () => {
  assert.deepEqual(read({ file: receipt, select: ['feature', 'ok', 'elapsedMs', 'checks'] }).values, { feature: 'lab-data-create', ok: true, elapsedMs: 16229, checks: 4 });
  assert.equal(read({ file: checks, pointer: '/passed', max: 0 }).total, 4);
  const services = read({ file: modules, pointer: '/modules', where: 'kind=Service', fields: ['key'] });
  assert.deepEqual(services.items, [{ at: '/modules/Orders', key: 'o1' }, { at: '/modules/Utils', key: 'u1' }]);
  assert.deepEqual(read({ file: studioReceipt, select: ['published', 'state'] }).values, { published: true, state: 'CompletedWithSuccess' });
});

test('secrets are redacted before any filter, including the user words; numbers and booleans stay', () => {
  const value = read({ file: secrets, budgetBytes: 4000 });
  assert.equal(value.ok, true);
  const text = JSON.stringify(value);
  for (const secret of ['hunter2', 'k-123', 'tok-abc', 'sid=1', 'sim, pode inserir', 'palavras do usuario', 'abcdefghijklmnop']) assert.ok(!text.includes(secret), secret);
  assert.equal(value.value.connection.password, '[redacted]');
  assert.equal(value.value.connection.outputTokens, 42); assert.equal(value.value.connection.authorized, true);
  assert.equal(value.value.note, 'plain text');
  assert.equal(value.redacted, 7);
  // a where clause cannot probe a secret
  assert.equal(read({ file: secrets, deep: true, where: 'password~hunter', max: 0 }).total, 0);
  assert.equal(read({ file: secrets, deep: true, where: '~hunter2', max: 0 }).total, 0);
  assert.equal(read({ file: secrets, pointer: '/connection/apiKey' }).value, '[redacted]');
});

test('refused outside the roots: relative, .., another folder, a junction or symlink leading out, UNC, streams', () => {
  const codes = {
    relative: read({ file: 'kernel/.local/reading/x.json' }).code,
    dotdot: read({ file: path.join(kernel, '.local', '..', '..', 'outside', 'data.json') }).code,
    other: read({ file: path.join(outside, 'data.json') }).code,
    unc: read({ file: '\\\\server\\share\\x.json' }).code,
    notJson: read({ file: path.join(kernel, '.local', 'reading', 'notes.txt') }).code,
    secretName: read({ file: path.join(kernel, '.local', 'work', 'credentials.json') }).code,
    missing: read({ file: path.join(kernel, '.local', 'reading', 'missing.json') }).code,
  };
  assert.deepEqual(codes, { relative: 'PATH_NOT_ABSOLUTE', dotdot: 'OUTSIDE_ROOTS', other: 'OUTSIDE_ROOTS', unc: 'PATH_NOT_LOCAL', notJson: 'NOT_JSON', secretName: 'SECRET_FILE', missing: 'FILE_NOT_FOUND' });
  if (process.platform === 'win32') assert.equal(read({ file: inspect + ':hidden.json' }).code, 'BAD_PATH');
  // a junction inside a root that points outside
  const junction = path.join(kernel, '.local', 'reading', 'escape');
  fs.symlinkSync(outside, junction, 'junction');
  const viaJunction = read({ file: path.join(junction, 'data.json') });
  assert.equal(viaJunction.code, 'OUTSIDE_ROOTS'); assert.ok(!JSON.stringify(viaJunction).includes('outside data'));
  // a file symlink (needs the privilege on Windows: skipped without it)
  const link = path.join(kernel, '.local', 'reading', 'link.json');
  let linked = true;
  try { fs.symlinkSync(path.join(outside, 'data.json'), link, 'file'); } catch (error) { if (error.code === 'EPERM') linked = false; else throw error; }
  if (linked) assert.equal(read({ file: link }).code, 'OUTSIDE_ROOTS');
  // every refusal continues with an MCP call, never a shell command
  for (const value of [viaJunction, read({ file: 'x.json' }), read({ file: path.join(outside, 'data.json') })]) {
    assert.equal(value.ok, false); assert.equal(value.continuation.tool, 'ssam_evidence'); assert.ok(!SHELL.test(JSON.stringify(value)));
  }
});

test('a root reached through a junction still reads (roots are compared by their real path)', () => {
  const real = path.join(tmp, 'real-odc');
  put(path.join(real, 'lab', 'x', 'manifest.json'), { feature: 'x', candidateSha256: 'AA' });
  const alias = path.join(tmp, 'alias-odc');
  fs.symlinkSync(real, alias, 'junction');
  const viaAlias = createEvidenceReader({ roots: evidenceRoots({ anvil: kernel, odc: alias }) });
  assert.equal(viaAlias.read({ file: path.join(alias, 'lab', 'x', 'manifest.json'), pointer: '/feature' }).value, 'x');
  assert.equal(viaAlias.read({ file: path.join(real, 'lab', 'x', 'manifest.json'), pointer: '/feature' }).value, 'x');
});

test('pagination: pages under the budget cover every item exactly once', () => {
  const file = put(path.join(kernel, '.local', 'reading', 'list.json'), { items: Array.from({ length: 240 }, (_, i) => ({ i, name: 'item-' + i, note: 'n'.repeat(i % 7 * 10) })) });
  const seen = []; let offset = 0, pages = 0;
  for (;;) {
    const part = read({ file, pointer: '/items', ...(offset ? { offset } : {}) });
    within(part); pages++;
    seen.push(...part.items.map(item => item.i));
    if (part.next === undefined) break;
    assert.equal(part.next, offset + part.items.length);
    offset = part.next;
  }
  assert.deepEqual(seen, Array.from({ length: 240 }, (_, i) => i)); assert.ok(pages > 4);
  const big = read({ file, pointer: '/items', budgetBytes: 20000, max: 1000 });
  within(big, 20000); assert.ok(big.items.length > 100);
});

test('a key named __proto__ stays data; a wide object pages by entries; select shrinks to the budget', () => {
  const odd = put(path.join(kernel, '.local', 'reading', 'odd.json'), '{"__proto__": {"x": 1}, "a": 2}');
  assert.deepEqual(Object.keys(read({ file: odd }).value), ['__proto__', 'a']);
  assert.equal(read({ file: odd, select: ['/__proto__/x'] }).values['/__proto__/x'], 1);
  assert.equal({}.x, undefined);
  const wide = put(path.join(kernel, '.local', 'reading', 'wide.json'), Object.fromEntries(Array.from({ length: 400 }, (_, i) => ['key' + i, 'value ' + i])));
  const first = read({ file: wide });
  within(first); assert.equal(first.total, 400); assert.ok(first.next > 10); assert.deepEqual(first.items[0], { at: '/key0', value: 'value 0' });
  const big = read({ file: inspect, select: ['/tree', '/module'] });
  within(big); assert.equal(big.truncated, true); assert.equal(big.values['/module'], 'Quotes');
});

test('a large file: deep search and tail stay under the budget; the second read comes from the cache', () => {
  const node = (depth, i) => ({ kind: depth % 2 ? 'Container' : 'Expression', name: 'N' + depth + '_' + i, properties: { Value: 'v'.repeat(40), Style: 's' + i },
    children: depth < 4 ? Array.from({ length: 8 }, (_, j) => node(depth + 1, i * 8 + j)) : [] });
  const file = put(path.join(kernel, '.local', 'reading', 'inspect-big.json'), { module: 'Big', tree: { kind: 'MobileScreen', name: 'Big', children: Array.from({ length: 10 }, (_, i) => node(0, i)) } });
  const jsonl = put(path.join(odc, 'journal', 'big.jsonl'), lines(Array.from({ length: 50000 }, (_, i) => ({ i, command: i % 3 ? 'status' : 'snapshot', outcome: 'ok' }))));
  assert.ok(fs.statSync(file).size > 4 * 1024 * 1024, 'a few MB of tree');
  let started = performance.now();
  const found = read({ file, deep: true, where: ['kind=Expression', 'name~_7'], fields: ['name'] });
  const cold = performance.now() - started;
  within(found); assert.ok(found.total > 10); assert.ok(found.next > 0);
  started = performance.now();
  const again = read({ file, deep: true, where: ['kind=Expression', 'name~_7'], fields: ['name'], offset: found.next });
  const warm = performance.now() - started;
  within(again); assert.equal(again.offset, found.next);
  assert.ok(warm < cold, `cache: cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms`);
  assert.ok(cold < 5000, 'cold read in ' + cold.toFixed(0) + ' ms');
  const tail = read({ file: jsonl, offset: -3 });
  assert.deepEqual(tail.items.map(i => i.i), [49997, 49998, 49999]);
  assert.deepEqual(read({ file: jsonl, groupBy: 'command' }).groups, [['status', 33333], ['snapshot', 16667]]);
  const small = createEvidenceReader({ roots, maxBytes: 1024 });
  const refused = small.read({ file });
  assert.equal(refused.code, 'FILE_TOO_LARGE'); assert.equal(refused.continuation.tool, 'ssam_evidence');
});

test('a .json file holding JSON lines reads as JSONL; broken JSON is refused without quoting the file', () => {
  const asLines = put(path.join(kernel, '.local', 'reading', 'lines.json'), lines([{ a: 1 }, { a: 2 }, { a: 3 }]));
  assert.equal(read({ file: asLines, where: 'a>1', max: 0 }).total, 2);
  const torn = put(path.join(kernel, '.local', 'reading', 'torn.json'), '{"user": "x", "password": "hunter2", "list": [1, 2');
  const value = read({ file: torn });
  assert.equal(value.code, 'INVALID_JSON'); assert.ok(!JSON.stringify(value).includes('hunter2'));
  const bom = put(path.join(kernel, '.local', 'reading', 'bom.json'), '﻿{"ok": true}');
  assert.equal(read({ file: bom, pointer: '/ok' }).value, true);
  const utf16 = path.join(kernel, '.local', 'reading', 'utf16.json');
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('{"ok": "sim"}', 'utf16le')]));
  assert.equal(read({ file: utf16, pointer: 'ok' }).value, 'sim');
});

test('refusals name the next call: unknown pointer, clause without operator, select mixed with a list option', () => {
  const missing = read({ file: result, pointer: '/validation/nothing/deeper' });
  assert.equal(missing.code, 'POINTER_NOT_FOUND'); assert.equal(missing.at, '/validation');
  assert.deepEqual(missing.keys, ['new', 'fixed', 'total']);
  assert.deepEqual(missing.continuation.arguments, { file: result, pointer: '/validation' });
  // A bare field is a clause (exists and not empty); text with spaces and no operator is still refused.
  assert.equal(read({ file: result, pointer: '/newErrors', where: 'message Invalid' }).code, 'EVIDENCE_FILTER_INVALID'); // C29: was BAD_WHERE
  assert.equal(read({ file: result, select: ['/ok'], where: 'ok=true' }).code, 'BAD_ARGUMENTS');
});

test('MCP: ssam_evidence is registered read-only, answers short, refuses with isError and a strict schema', async t => {
  const mcp = await linked(registerSsamEvidence, { roots });
  t.after(() => mcp.close());
  const { tools } = await mcp.client.listTools();
  const tool = tools.find(x => x.name === 'ssam_evidence');
  assert.ok(tool); assert.equal(tool.annotations.readOnlyHint, true);
  const answer = await mcp.call('ssam_evidence', { file: inspect, deep: true, where: 'kind=JavaScriptNode', fields: ['name'] });
  assert.equal(answer.isError, false); assert.deepEqual(answer.items, [{ at: '/tree/children/2/children/0', name: 'InitializeMaps' }]);
  const refused = await mcp.call('ssam_evidence', { file: path.join(outside, 'data.json') });
  assert.equal(refused.isError, true); assert.equal(refused.code, 'OUTSIDE_ROOTS');
  const strict = await mcp.raw('ssam_evidence', { file: inspect, unknown: 1 });
  assert.equal(strict.isError, true);
});

test('a kernel durable envelope {format, sha256, payload} is read as its payload: redaction, pointers and where reach inside it', async () => {
  const { createHash } = await import('node:crypto');
  const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
  const envelope = value => { const payload = JSON.stringify(value); return { format: 1, sha256: hash(payload), payload }; };
  const state = { taskId: 't9', stage: 'merge', writeState: 'applied', authorize: 'minhas palavras secretas', token: 'tok-123456789',
    request: { Module: 'Orders', JobPath: 'C:\\j.json' }, sessionId: 's-1' };
  const task = put(path.join(kernel, '.local', 'work', 'deliver', 't9', 'task.json'), JSON.stringify(envelope(state)));
  const whole = read({ file: task });
  assert.equal(whole.ok, true); assert.equal(whole.envelope, 'verified');
  assert.equal(whole.value.stage, 'merge'); assert.equal(whole.value.authorize, '[redacted]'); assert.equal(whole.value.token, '[redacted]');
  assert.equal(whole.value.sessionId, '[redacted]');
  assert.doesNotMatch(JSON.stringify(whole), /minhas palavras|tok-123456789|s-1/);
  assert.deepEqual(read({ file: task, pointer: '/stage' }).value, 'merge');
  assert.deepEqual(read({ file: task, select: ['stage', 'request.Module'] }).values, { stage: 'merge', 'request.Module': 'Orders' });
  // the words cannot be probed by a where clause any more
  assert.equal(read({ file: task, pointer: '', where: '~palavras' }).total, 0);
  // a payload that does not match its hash is still read, and says so; one that is not JSON is never shown
  const tampered = put(path.join(kernel, '.local', 'work', 'deliver', 't10', 'task.json'), JSON.stringify({ ...envelope(state), sha256: 'ab'.repeat(32) }));
  assert.deepEqual([read({ file: tampered }).envelope, read({ file: tampered, pointer: '/stage' }).value], ['sha256-differs', 'merge']);
  const broken = put(path.join(kernel, '.local', 'work', 'deliver', 't11', 'task.json'), JSON.stringify({ format: 1, sha256: 'x', payload: '{"authorize":"minhas palavras secretas"' }));
  const hidden = read({ file: broken });
  assert.equal(hidden.envelope, 'payload-not-json'); assert.doesNotMatch(JSON.stringify(hidden), /minhas palavras/);
  // JSONL of envelopes (a ledger): each line opened
  const ledger = put(path.join(kernel, '.local', 'access', 'ledger.jsonl'), lines([envelope({ n: 1, words: 'palavras' }), envelope({ n: 2, words: 'outras' })]));
  const rows = read({ file: ledger, fields: ['n', 'words'] });
  assert.deepEqual(rows.items, [{ n: 1, words: '[redacted]' }, { n: 2, words: '[redacted]' }]);
  // an object that only looks like one (other keys) stays as written
  const plain = put(path.join(kernel, '.local', 'work', 'other.json'), { format: 1, payload: '{}', extra: true });
  assert.equal(read({ file: plain }).envelope, undefined);
});
