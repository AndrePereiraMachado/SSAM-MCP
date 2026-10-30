import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moduleMap, ddlFile } from '../module-map.mjs';
import { selectBlocks } from '../module-ddl.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { functionList, registerSsamReference } from '../ssam-reference.mjs';
import { writeCapture, writeIndex } from './fixtures/module-index.mjs';
import { linked, tempKernel } from './fixtures/o11env-kernel.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-inputs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(dir, 'store') };
  const c = writeCapture(dir, 'R2 capture');
  writeIndex(env.SSAM_MODULE_INDEX_ROOT, 'odc', c.sha256);
  const blocks = ['Record', 'Totals'].map((name, i) => ({ name, key: 'K' + i, section: 'structures', kind: 'Structure', elements: 1, text: `type ${name} = { Value: Text; }` }));
  const ddl = { schema: 'ssam-ddl/1', extractor: 1, adapter: 'kernel', lane: 'odc', sourceSha256: c.sha256, module: { name: 'Sample', key: 'R0' }, elements: 2, blocks };
  const file = ddlFile('odc', c.sha256, env); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(ddl));
  return { ...c, dir, env, ddl, ask: args => moduleMap({ lane: 'odc', target: c.file, ...args }, { env, read: async () => { throw new Error('Unexpected reader'); } }) };
}
for (const element of [['Record', 'Totals'], 'Record, Totals']) test('R2 DDL accepts element list ' + JSON.stringify(element), async t => {
  const c = fixture(t), result = await c.ask({ view: 'ddl', element });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.ddl.text ?? result.text, /type Record/);
  assert.match(result.ddl.text ?? result.text, /type Totals/);
});
test('R2 selection lists preserve source order and do not duplicate blocks', () => {
  const blocks = [{ name: 'One', key: 'A' }, { name: 'Two', key: 'B' }];
  assert.deepEqual(selectBlocks({ blocks }, ['Two', '@A', 'One']), blocks);
});
test('R2 data alias returns the whole DDL with a normalization note', async t => {
  const result = await fixture(t).ask({ view: 'ddl', element: 'data' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.normalizations.length);
});
test('R2 kind arrays match the CSV form', async t => {
  const c = fixture(t), array = await c.ask({ kind: ['MobileScreen', 'ServerAction'] }), csv = await c.ask({ kind: 'MobileScreen,ServerAction' });
  assert.equal(array.ok, true, JSON.stringify(array)); assert.deepEqual(array.entries, csv.entries);
});
test('R2 HTML name alias reaches the same screen reader and is reported', async t => {
  const c = fixture(t); let selected;
  const result = await moduleMap({ lane: 'odc', target: c.file, view: 'html', name: 'Overview' }, { env: c.env, read: async ({ request }) => {
    selected = request.html;
    return { html: { schema: 'ssam-html/1', model: 'Sample', root: 'Overview', rootKey: 'S1', rootKind: 'MobileScreen', htmlSha256: 'a'.repeat(64), html: '<screen name="Overview"/>', bytes: 25, widgets: 0 } };
  } });
  assert.equal(selected, 'Overview'); assert.equal(result.ok, true, JSON.stringify(result)); assert.ok(result.normalizations.length);
});
test('R2 incompatible map fields return a usable corrected call', async t => {
  const c = fixture(t), result = await c.ask({ view: 'search', text: 'ChartPoint', includeDetail: true });
  assert.equal(result.code, 'INPUT_INVALID');
  assert.equal(result.corrected?.tool, 'ssam_map');
  assert.equal(result.corrected.arguments.includeDetail, undefined);
  assert.equal(result.corrected.arguments.text, 'ChartPoint');
});
for (const where of ['text~Details', 'element~Details', 'message~Details|path~Overview', '*~Details', 'Details']) test('R2 text evidence supports ' + where, t => {
  const c = fixture(t), file = path.join(c.dir, 'messages.json');
  fs.writeFileSync(file, JSON.stringify({ messages: ['Error in Details', 'Warning in Overview', 'Unrelated'] }));
  const reader = createEvidenceReader({ roots: [c.dir] }); const read = input => reader.read(input);
  const result = read({ file, pointer: '/messages', where });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.total, where.includes('|') ? 2 : 1);
  assert.ok(result.normalizations.length);
});
test('R2 invalid text filters return a corrected call that matches a real line', t => {
  const c = fixture(t), file = path.join(c.dir, 'messages.json'); fs.writeFileSync(file, JSON.stringify(['Error in Details']));
  const reader = createEvidenceReader({ roots: [c.dir] }); const read = input => reader.read(input);
  const result = read({ file, where: 'missing~~Details', max: 7, table: true });
  assert.equal(result.code, 'EVIDENCE_FILTER_INVALID');
  assert.equal(result.corrected.arguments.max, 7); assert.equal(result.corrected.arguments.table, true);
  assert.equal(read(result.corrected.arguments).total, 1);
});
test('R2 function query accepts a direct array', () => {
  assert.deepEqual(functionList(['CurrDate()', 'AddDays']).names, ['CurrDate', 'AddDays']);
});
test('R2 multiword example ids search with an explicit normalization note', async t => {
  const kernel = tempKernel({ cli: false }), mcp = await linked(registerSsamReference, { root: kernel.root, env: kernel.env, runAnvil: fakeAnvil({}) });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  const result = await mcp.call('ssam_reference', { lane: 'o11', kind: 'example', query: { id: 'popup upload' } });
  assert.notEqual(result.code, 'EXAMPLE_NOT_FOUND'); assert.ok(result.normalizations?.length, JSON.stringify(result));
});
test('R2 multiword UI names search and direct function arrays pass the MCP schema', async t => {
  const kernel = tempKernel({ cli: true });
  const run = fakeAnvil({
    'ui-block': args => ({ ok: true, data: { argv: args } }),
    functions: () => ({ ok: true, data: { Name: 'Function', Signature: 'Function()', Group: 'Test' } }),
  });
  const mcp = await linked(registerSsamReference, { root: kernel.root, env: kernel.env, runAnvil: run });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  const ui = await mcp.call('ssam_reference', { lane: 'o11', kind: 'ui-block', query: 'popup upload' });
  assert.equal(ui.ok, true, JSON.stringify(ui)); assert.ok(ui.normalizations?.length);
  assert.ok(ui.data.argv.includes('--find'));
  const functions = await mcp.call('ssam_reference', { lane: 'o11', kind: 'functions', query: ['CurrDate', 'AddDays'] });
  assert.equal(functions.ok, true, JSON.stringify(functions)); assert.equal(functions.asked, 2);
});
test('R2 unknown tool queries give a ready discovery call carrying the query', async t => {
  const kernel = tempKernel({ cli: false }), mcp = await linked(registerSsamReference, { root: kernel.root, env: kernel.env });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  const result = await mcp.call('ssam_reference', { lane: 'o11', kind: 'tool', query: 'replace screen stylesheet' });
  assert.equal(result.corrected?.tool, 'ssam_discover');
  assert.equal(result.corrected.arguments.intent, 'replace screen stylesheet');
});
test('R2 successful evidence containing error code names is not a refusal', t => {
  const c = fixture(t), file = path.join(c.dir, 'descriptions.json');
  const codes = ['DESTRUCTIVE_HOSTED_OFF', 'SC_LOCAL_FAILURE', 'BAD_ARGS', 'ANVIL_BASE_CACHE'];
  fs.writeFileSync(file, JSON.stringify(codes.map(code => ({ description: code }))));
  const result = createEvidenceReader({ roots: [c.dir] }).read({ file });
  assert.equal(result.ok, true); assert.equal(result.code, undefined); assert.equal(result.total, codes.length);
});
