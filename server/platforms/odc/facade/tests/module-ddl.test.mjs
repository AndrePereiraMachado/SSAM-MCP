// ssam_map view "ddl" over synthetic stored data texts (the C# writer is not needed): served only when schema, extractor,
// lane, adapter and the hash of the bytes read now match; a miss asks the lane's kernel reader ({"ddl":"ensure"}, mocked
// here); one page when the whole text fits, else whole blocks per page with nothing dropped and every cut said at both
// ends as a comment the text's parser skips; element reads one block by name or @key; every continuation is pinned.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleMap, parseMapArguments, ddlFile, odcKernelCli } from '../module-map.mjs';
import { DDL_EXTRACTOR, DDL_SECTIONS, DDL_PAGE_SCHEMA, ddlText, ddlHeader } from '../module-ddl.mjs';
import { writeCapture } from './fixtures/module-index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelSource = path.join(here, '..', '..', '..', '..', 'kernel', 'src', 'Anvil.Core', 'Kernel', 'DataDdl.cs');

function setup(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-module-ddl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  return { dir, store, env, ...writeCapture(dir, text) };
}
const noReader = async () => { throw new Error('the reader must not be called on a hit'); };
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

// A data text as DataDdl.ToJson writes it. 'large' has a static entity with many records (a block longer than a page),
// many structures and a record line longer than a page.
function ddlOf({ lane = 'odc', sourceSha256, size = 'small', overrides = {} }) {
  const large = size === 'large';
  const records = Array.from({ length: large ? 400 : 3 }, (_, i) => '  R' + String(i).padStart(3, '0') + ' (Id = ' + (i + 1) + ', Label = "Value ' + i + '", Order = ' + i + ')'
    + (i < (large ? 399 : 2) ? ',' : ';') + ' -- @r' + i).join('\n');
  const status = 'create static entity Status ( -- @E2\n  Id Integer identifier auto required, -- @E2a\n  Label Text(50) required, -- @E2b\n  Order Integer -- @E2c\n)\nvalues\n' + records;
  const quote = '/// A quote.\ncreate entity Quote public ( -- @E1\n  Id Long Integer identifier auto required, -- @E1a\n  Name Text(50) required default "" -- @E1b\n);';
  const structures = Array.from({ length: large ? 60 : 1 }, (_, i) => ({ key: 'T' + i, kind: 'Structure', name: 'Line' + i, section: 'structures', elements: 3,
    text: 'type Line' + i + ' public = { -- @T' + i + '\n  Qty: Integer; -- @T' + i + 'a\n  Note: Text(' + (i + 1) + ') json "note"; -- @T' + i + 'b\n}' }));
  const blocks = [
    { key: 'E1', kind: 'ServerEntity', name: 'Quote', section: 'entities', elements: 3, text: quote },
    { key: 'E2', kind: 'StaticEntity', name: 'Status', section: 'entities', elements: 4 + (large ? 400 : 3), text: status },
    ...structures,
    { key: 'V1', kind: 'SiteProperty', name: 'MaxLines', section: 'variables', elements: 1, text: 'setting MaxLines: Integer folder Quotes = ' + (large ? 'Long("' + 'z'.repeat(20000) + '")' : '10') + ' -- @V1' },
    { key: 'M1', kind: 'Timer', name: 'Nightly', section: 'timers', elements: 1, text: 'timer Nightly action PlaceOrder schedule "When Published" -- @M1' },
  ];
  return { schema: 'ssam-ddl/1', extractor: DDL_EXTRACTOR, lane, adapter: 'kernel', sourceSha256, sourceBytes: 42, createdAt: '2026-10-11T00:00:00Z',
    module: { name: 'Quotes', key: 'R0' }, elements: blocks.reduce((n, b) => n + b.elements, 0), blocks, ...overrides };
}
function writeDdl(store, lane, sha256, ddl = ddlOf({ lane, sourceSha256: sha256 })) {
  const file = path.join(store, 'v1', lane, sha256 + '.kernel.ddl.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof ddl === 'string' ? ddl : JSON.stringify(ddl));
  return file;
}

test('the data text constants are the C# ones (extractor, sections, header) and the store sits beside the index, kernel adapter in both lanes', () => {
  const source = fs.readFileSync(kernelSource, 'utf8');
  assert.equal(Number(source.match(/public const int Extractor = (\d+);/)[1]), DDL_EXTRACTOR);
  assert.deepEqual([...source.match(/SectionIds = \[([^\]]+)\]/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]), DDL_SECTIONS);
  // DataDdl.Header, field for field.
  assert.match(source, /"-- " \+ Schema \+ " module=" \+ ModuleName \+ " lane=" \+ Lane \+ " key=@" \+ ModuleKey \+ " sourceSha256=" \+ SourceSha256\s*\+ " elements=" \+ Elements \+ "\\n"/);
  assert.equal(ddlHeader({ module: { name: 'Q', key: 'K' }, lane: 'o11', sourceSha256: 'ab', elements: 3 }), '-- ssam-ddl/1 module=Q lane=o11 key=@K sourceSha256=ab elements=3\n');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(os.tmpdir(), 'store') };
  for (const lane of ['odc', 'o11'])
    assert.equal(ddlFile(lane, 'A'.repeat(64), env), path.join(env.SSAM_MODULE_INDEX_ROOT, 'v1', lane, 'a'.repeat(64) + '.kernel.ddl.json'));
});

test('a data text that fits is one page, the text as written, from the store without any reader', async t => {
  const c = setup(t);
  writeDdl(c.store, 'odc', c.sha256);
  const page = await moduleMap({ lane: 'odc', target: c.file, view: 'ddl' }, { env: c.env, read: noReader, prepare: noReader });
  assert.equal(page.ok, true, page.error);
  assert.equal(page.schema, DDL_PAGE_SCHEMA); assert.equal(page.answeredBy, 'data-ddl'); assert.equal(page.cache.ddl, 'hit');
  assert.equal(page.page, 1); assert.equal(page.pages, 1); assert.equal(page.ddl.layout, 'single page: the whole text');
  assert.equal(page.text, ddlText(ddlOf({ lane: 'odc', sourceSha256: c.sha256 })));
  assert.ok(page.text.startsWith('-- ssam-ddl/1 module=Quotes lane=odc key=@R0 sourceSha256=' + c.sha256));
  assert.deepEqual(page.contents.map(p => p.section), ['entities', 'structures', 'variables', 'timers']);
  assert.equal(page.continuations.next, null);
  assert.deepEqual(page.continuations.element, { tool: 'ssam_map', arguments: { lane: 'odc', target: c.file, view: 'ddl', budgetBytes: page.size.budgetBytes,
    expectedSourceSha256: c.sha256, element: '<name or @key>' } });
  assert.deepEqual(page.continuations.inspect, { tool: 'studio_inspect', arguments: { target: c.file, path: '@<key>', expectedSourceSha256: c.sha256 } });
  assert.equal(page.size.bytes, bytes(page)); assert.ok(page.size.bytes <= page.size.budgetBytes);
});

test('a large data text: whole blocks per page, nothing dropped, every cut said at both ends as a comment, every page inside the budget', async t => {
  const c = setup(t);
  const ddl = ddlOf({ lane: 'o11', sourceSha256: c.sha256, size: 'large' });
  writeDdl(c.store, 'o11', c.sha256, ddl);
  const budgetBytes = 12000;
  const ask = page => moduleMap({ lane: 'o11', target: c.file, view: 'ddl', budgetBytes, ...(page ? { page } : {}) }, { env: c.env, read: noReader });
  const first = await ask();
  assert.equal(first.ok, true, first.error);
  assert.ok(first.pages > 5, 'pages ' + first.pages);
  const pages = [first];
  for (let n = 2; n <= first.pages; n++) {
    const next = pages.at(-1).continuations.next;
    assert.deepEqual(next, { tool: 'ssam_map', arguments: { lane: 'o11', target: c.file, view: 'ddl', budgetBytes, expectedSourceSha256: c.sha256, page: n } });
    pages.push(await moduleMap(next.arguments, { env: c.env, read: noReader }));
  }
  assert.equal(pages.at(-1).continuations.next, null);
  for (const p of pages) {
    assert.equal(p.ok, true, p.error);
    assert.ok(bytes(p) <= budgetBytes, `page ${p.page}: ${bytes(p)} > ${budgetBytes}`);
    assert.equal(p.contents != null, p.page === 1, 'contents only on page 1');
  }
  const all = pages.map(p => p.text).join('');
  // Nothing dropped: without the cut comments the pages are the text, line for line.
  const joined = all.replace(/ -- …\(this line continues on page \d+\)\n-- …\(line continued from page \d+\)\n/g, '')
    .replace(/-- …\(\w+ continues on page \d+\)\n-- …\(\w+ continued from page \d+\)\n/g, '');
  assert.equal(joined, ddlText(ddl));
  // The static entity's records are cut between pages and say so at both ends; a structure is never cut.
  assert.match(all, /-- …\(Status continues on page (\d+)\)\n/);
  assert.match(all, /\n-- …\(Status continued from page \d+\)\n/);
  assert.doesNotMatch(all, /Line\d+ continues/);
  assert.match(all, / -- …\(this line continues on page \d+\)\n/);
  for (const part of first.contents) assert.ok(part.pages[0] >= 1 && part.pages[1] <= first.pages && part.pages[0] <= part.pages[1], part.section);
  assert.match((await ask(first.pages + 1)).error, new RegExp('page ' + (first.pages + 1) + ' does not exist: the data text has ' + first.pages + ' page'));
});

test('element reads one block by name (any case) or @key, pinned in every continuation; an unknown one names its near candidates', async t => {
  const c = setup(t);
  writeDdl(c.store, 'odc', c.sha256, ddlOf({ sourceSha256: c.sha256, size: 'large' }));
  const ask = input => moduleMap({ lane: 'odc', target: c.file, view: 'ddl', ...input }, { env: c.env, read: noReader });
  const quote = await ask({ element: 'quote' });
  assert.equal(quote.ok, true, quote.error);
  assert.equal(quote.element, 'quote'); assert.equal(quote.pages, 1); assert.equal(quote.ddl.blocks, 1);
  assert.equal(quote.text, ddlHeader(ddlOf({ sourceSha256: c.sha256, size: 'large' })) + '\n/// A quote.\ncreate entity Quote public ( -- @E1\n  Id Long Integer identifier auto required, -- @E1a\n  Name Text(50) required default "" -- @E1b\n);\n');
  assert.equal((await ask({ element: '@T7' })).text.includes('type Line7 public = { -- @T7'), true);
  const status = await ask({ element: 'Status', budgetBytes: 12000 });
  assert.ok(status.pages > 1);
  assert.deepEqual(status.continuations.next.arguments, { lane: 'odc', target: c.file, view: 'ddl', budgetBytes: 12000, expectedSourceSha256: c.sha256, element: 'Status', page: 2 });
  const missing = await ask({ element: 'Lin' });
  assert.equal(missing.ok, false); assert.equal(missing.code, 'ELEMENT_NOT_FOUND');
  assert.ok(missing.candidates.length > 0 && missing.candidates.every(x => x.name.startsWith('Line')));
});

test('a miss asks the lane kernel reader to ensure the data text, then reads the file it wrote; a bad file is never served', async t => {
  for (const lane of ['odc', 'o11']) {
    const c = setup(t);
    const calls = []; let prepared = 0;
    const read = async config => { calls.push(config); writeDdl(c.store, lane, c.sha256); return { ok: true, sourceSha256: c.sha256.toUpperCase(),
      ddl: { path: ddlFile(lane, c.sha256, c.env), built: true, bytes: 900 }, cache: { loads: 1, generation: 'g1' } }; };
    const reader = lane === 'o11' ? { entry: { cli: 'C:\\lane\\anvil.dll', root: 'C:\\kernel', lane: 'ss4' }, ssDir: 'C:\\studio' } : {};
    const page = await moduleMap({ lane, target: c.file, view: 'ddl' }, { env: c.env, read, reader, prepare: async () => { prepared++; return { ok: true }; } });
    assert.equal(page.ok, true, page.error);
    assert.deepEqual(page.cache, { ddl: 'ensured', built: true, loads: 1, generation: 'g1' });
    assert.equal(calls.length, 1); assert.equal(prepared, 0, 'the data text never builds the ODC builder');
    assert.deepEqual(calls[0].request, { file: c.file, ddl: 'ensure', expectedSourceSha256: c.sha256 });
    assert.equal(calls[0].dll, lane === 'odc' ? odcKernelCli() : 'C:\\lane\\anvil.dll');
    assert.equal((await moduleMap({ lane, target: c.file, view: 'ddl' }, { env: c.env, read: noReader, reader })).cache.ddl, 'hit', 'the next call is a hit');
  }
  const c = setup(t);
  for (const [why, content] of Object.entries({
    'another capture': ddlOf({ sourceSha256: 'f'.repeat(64) }), 'truncated JSON': '{"schema":"ssam-ddl/1","blocks":[',
    'another extractor': ddlOf({ sourceSha256: c.sha256, overrides: { extractor: DDL_EXTRACTOR - 1 } }),
    'another adapter': ddlOf({ sourceSha256: c.sha256, overrides: { adapter: 'builder' } }),
    'another lane': ddlOf({ lane: 'o11', sourceSha256: c.sha256 }),
    'an unknown section': ddlOf({ sourceSha256: c.sha256, overrides: { blocks: [{ key: 'X', kind: 'Role', name: 'X', section: 'roles', elements: 1, text: 'role X' }] } }) })) {
    writeDdl(c.store, 'odc', c.sha256, content);
    let asked = 0;
    const refused = await moduleMap({ lane: 'odc', target: c.file, view: 'ddl' }, { env: c.env, read: async () => { asked++; return { ok: true, ddl: { built: false } }; } });
    assert.equal(refused.ok, false, why); assert.equal(asked, 1, why);
    assert.match(refused.error, /data text of this capture is missing or invalid after the reader built it/, why);
  }
  fs.rmSync(ddlFile('odc', c.sha256, c.env));
  assert.match((await moduleMap({ lane: 'odc', target: c.file, view: 'ddl' }, { env: c.env, read: async () => ({ ok: true, data: { module: 'Quotes' } }) })).error,
    /answered without a data text: its binaries predate ssam-ddl\/1/);
});

test('the ddl view takes element and page; the map filters are refused with the view they belong to; CLI --ddl', async t => {
  const c = setup(t);
  writeDdl(c.store, 'odc', c.sha256);
  const ask = input => moduleMap({ lane: 'odc', target: c.file, view: 'ddl', ...input }, { env: c.env, read: noReader });
  assert.match((await ask({ kind: 'ServerEntity' })).error, /view "ddl" pages the data text by whole blocks; kind belong to view "map"/);
  assert.match((await ask({ text: 'Quote' })).error, /text belong to views "search"/);
  assert.match((await ask({ page: 0 })).error, /page must be an integer between 1 and 100000/);
  assert.equal((await ask({ offset: 0, max: 100, includeDetail: false })).ok, true, 'the MCP defaults are not map filters');
  assert.match((await moduleMap({ lane: 'odc', target: c.file, element: 'Quote' }, { env: c.env, read: noReader })).error, /element belong to views "search" \(text, regex, property\) and "uses" \(element\)/);
  assert.deepEqual(parseMapArguments(['q.oml', '--ddl', '--element', 'Quote', '--page', '2', '--lane', 'o11']),
    { target: 'q.oml', view: 'ddl', element: 'Quote', page: '2', lane: 'o11' });
  assert.throws(() => parseMapArguments(['q.oml', '--digest', '--ddl']), /--ddl and --view digest disagree|disagree/);
});
