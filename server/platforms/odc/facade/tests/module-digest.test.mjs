// ssam_map view "digest" over synthetic stored digests (the C# writer is not needed): served only when schema, extractor,
// lane, adapter and the hash of the bytes read now match; a miss asks the lane's kernel reader ({"digest":"ensure"},
// mocked here); one page when the whole digest fits, else the overview first and the bodies after, with nothing dropped,
// every cut said at both ends, every page inside the budget and every continuation pinned to the same capture.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleMap, parseMapArguments, digestFile, digestReaderConfig, odcKernelCli, readerConfig } from '../module-map.mjs';
import { DIGEST_EXTRACTOR, DIGEST_SECTIONS, DIGEST_PAGE_SCHEMA, FOLD_RECORDS, digestText, indexLine } from '../module-digest.mjs';
import { paths } from '../lib.mjs';
import { writeCapture } from './fixtures/module-index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelSource = path.join(here, '..', '..', '..', '..', 'kernel', 'src', 'Anvil.Core', 'Kernel', 'ModuleDigest.cs');

function setup(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-module-digest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  return { dir, store, env, ...writeCapture(dir, text) };
}
const noReader = async () => { throw new Error('the reader must not be called on a hit'); };
const block = (key, kind, name, text, extra = {}) => ({ key, kind, name, text, ...extra });

// A digest as ModuleDigest.ToJson writes it. size 'small' fits one page; 'large' has a static entity with many records,
// many actions with calls, a block longer than a page and a line longer than a page.
function digestOf({ lane = 'odc', sourceSha256, size = 'small', overrides = {} }) {
  const large = size === 'large';
  const records = large ? 40 : 3;
  const status = ['static entity Status @E2', '  Label: Text(50)', ...Array.from({ length: records }, (_, i) => '  record R' + String(i).padStart(3, '0') + ': Label="Value ' + i + '"')].join('\n');
  const actions = Array.from({ length: large ? 60 : 2 }, (_, i) => ({ key: 'A' + i, kind: 'ServerAction', name: 'Action' + i, section: 'actions',
    ...(i % 3 === 0 ? { folder: 'Folder' + (i % 2) } : {}), public: i % 2 === 0, function: false, in: 'Id: Long Integer; Filter?: Text', out: 'Result: Text',
    calls: i > 0 ? ['Action' + (i - 1)] : [], calledBy: i + 1 < (large ? 60 : 2) ? ['Action' + (i + 1)] : [] }));
  const body = i => ['server action Action' + i + ' @A' + i + (i % 2 === 0 ? ' public' : ''), '  in Id: Long Integer; Filter?: Text', '  out Result: Text',
    ...(i > 0 ? ['  Result = Action' + (i - 1) + '(Id)'] : []), ...(large ? Array.from({ length: 30 }, (_, j) => '  step ' + j + ' of Action' + i + ': ' + 'x'.repeat(40)) : [])].join('\n');
  const huge = ['screen MainFlow/Huge @S9', ...Array.from({ length: large ? 400 : 1 }, (_, j) => '    widget line ' + j + ' ' + 'y'.repeat(30))].join('\n');
  const longLine = 'screen MainFlow/Long @S8\n  expr ' + 'z'.repeat(large ? 20000 : 10);
  const sections = {
    module: { title: 'module and references', count: 1, blocks: [block('R0', 'ESpace', 'Quotes', 'ssam-digest/1 module=Quotes type=Service lane=' + lane + ' key=@R0\nlegend: …'),
      block('Ref1', 'Reference', 'Customers', 'reference Customers @Ref1 (Service)\n  ServerAction: GetCustomer')] },
    entities: { title: 'entities', count: 2, blocks: [block('E1', 'Entity', 'Quote', 'entity Quote @E1\n  Id: Long Integer auto\n  Name: Text(50) req'),
      block('E2', 'StaticEntity', 'Status', status, { records })] },
    structures: { title: 'structures', count: 1, blocks: [block('T1', 'Structure', 'Line', 'structure Line @T1\n  Qty: Integer')] },
    variables: { title: 'site properties and client/session variables', count: 0, blocks: [] },
    roles: { title: 'roles', count: 1, blocks: [block('Ro1', 'Role', 'Manager', 'role Manager @Ro1 public')] },
    exceptions: { title: 'user exceptions', count: 0, blocks: [] },
    actions: { title: 'actions', count: actions.length, blocks: actions.map((a, i) => block(a.key, a.kind, a.name, body(i), a.folder ? { folder: a.folder } : {})) },
    timers: { title: 'timers', count: 0, blocks: [] },
    integrations: { title: 'REST and SOAP, consumed and exposed', count: 0, blocks: [] },
    ui: { title: 'screens, blocks and emails', count: 2, blocks: [block('S8', 'MobileScreen', 'Long', longLine), block('S9', 'MobileScreen', 'Huge', huge)] },
    coverage: { title: 'coverage', count: 99, blocks: [block('R0', 'ESpace', 'coverage', 'elements 99: rendered 99, values 0, folded 0, not rendered 0\nclipped texts 0; property read errors 0.')] },
  };
  return { schema: 'ssam-digest/1', extractor: DIGEST_EXTRACTOR, lane, adapter: 'kernel', sourceSha256, sourceBytes: 42, createdAt: '2026-10-10T00:00:00Z',
    module: { name: 'Quotes', key: 'R0', kind: 'Service' }, elements: 99, notRendered: 0, clipped: 0, readErrors: 0,
    sections: DIGEST_SECTIONS.map(id => ({ id, ...sections[id] })), actions, ...overrides };
}
function writeDigest(store, lane, sha256, digest = digestOf({ lane, sourceSha256: sha256 })) {
  const file = path.join(store, 'v1', lane, sha256 + '.kernel.digest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof digest === 'string' ? digest : JSON.stringify(digest));
  return file;
}
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('the digest constants are the C# ones (extractor, sections) and the store sits beside the index, kernel adapter in both lanes', () => {
  const source = fs.readFileSync(kernelSource, 'utf8');
  assert.equal(Number(source.match(/public const int Extractor = (\d+);/)[1]), DIGEST_EXTRACTOR);
  assert.deepEqual([...source.match(/SectionIds = \[([^\]]+)\]/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]), DIGEST_SECTIONS);
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(os.tmpdir(), 'store') };
  for (const lane of ['odc', 'o11'])
    assert.equal(digestFile(lane, 'A'.repeat(64), env), path.join(env.SSAM_MODULE_INDEX_ROOT, 'v1', lane, 'a'.repeat(64) + '.kernel.digest.json'));
  // ODC: the kernel's reader writes it (anvil-odc read-serve), never the builder; O11: the lane reader of the map.
  const odc = digestReaderConfig('odc', { env });
  assert.equal(odc.dll, odcKernelCli()); assert.notEqual(odc.dll, paths.builder); assert.equal(odc.indexRoot, path.resolve(env.SSAM_MODULE_INDEX_ROOT));
  const entry = { cli: 'C:\\lane\\anvil.dll', root: 'C:\\kernel', lane: 'ss4' };
  assert.deepEqual(digestReaderConfig('o11', { entry, ssDir: 'C:\\studio', env }), readerConfig('o11', { entry, ssDir: 'C:\\studio', env }));
});

test('a digest that fits is one page, the digest as written, from the store without any reader', async t => {
  const c = setup(t);
  writeDigest(c.store, 'odc', c.sha256);
  const page = await moduleMap({ lane: 'odc', target: c.file, view: 'digest' }, { env: c.env, read: noReader, prepare: noReader });
  assert.equal(page.ok, true, page.error);
  assert.equal(page.schema, DIGEST_PAGE_SCHEMA); assert.equal(page.answeredBy, 'module-digest'); assert.equal(page.cache.digest, 'hit');
  assert.equal(page.page, 1); assert.equal(page.pages, 1); assert.equal(page.digest.layout, 'single page: the whole digest');
  assert.equal(page.text, digestText(digestOf({ lane: 'odc', sourceSha256: c.sha256 })));
  assert.equal(page.sourceSha256, c.sha256); assert.equal(page.file, c.file); assert.deepEqual(page.module, { name: 'Quotes', key: 'R0', kind: 'Service' });
  assert.equal(page.continuations.next, null);
  assert.deepEqual(page.continuations.inspect, { tool: 'studio_inspect', arguments: { target: c.file, path: '@<key>', expectedSourceSha256: c.sha256 } });
  assert.deepEqual(page.contents.map(p => p.part), ['module', 'entities', 'structures', 'roles', 'actions', 'ui', 'coverage']);
  assert.equal(page.size.bytes, bytes(page)); assert.ok(page.size.bytes <= page.size.budgetBytes);
});

test('a large digest: overview first, bodies after, nothing dropped, every cut said at both ends, every page inside the budget', async t => {
  const c = setup(t);
  const digest = digestOf({ lane: 'o11', sourceSha256: c.sha256, size: 'large' });
  writeDigest(c.store, 'o11', c.sha256, digest);
  const budgetBytes = 12000;
  const ask = page => moduleMap({ lane: 'o11', target: c.file, view: 'digest', budgetBytes, ...(page ? { page } : {}) }, { env: c.env, read: noReader });
  const first = await ask();
  assert.equal(first.ok, true, first.error);
  assert.ok(first.pages > 5, 'pages ' + first.pages);
  const pages = [first];
  for (let n = 2; n <= first.pages; n++) {
    const next = pages.at(-1).continuations.next;
    // Every continuation pins the same capture, the same budget and the next page.
    assert.deepEqual(next, { tool: 'ssam_map', arguments: { lane: 'o11', target: c.file, view: 'digest', budgetBytes, expectedSourceSha256: c.sha256, page: n } });
    pages.push(await moduleMap(next.arguments, { env: c.env, read: noReader }));
  }
  assert.equal(pages.at(-1).continuations.next, null);
  for (const p of pages) {
    assert.equal(p.ok, true, p.error);
    assert.ok(bytes(p) <= budgetBytes, `page ${p.page}: ${bytes(p)} > ${budgetBytes}`);
    assert.equal(p.sourceSha256, c.sha256); assert.equal(p.file, c.file);
    assert.equal(p.contents != null, p.page === 1, 'contents only on page 1');
    assert.equal(p.note != null, p.page === 1, 'fixed reading note only on page 1');
  }
  // Page 1: the header, the entities with the records folded, the structures, the whole action index (with calls and
  // callers), and no action body.
  const text1 = first.text;
  assert.ok(text1.startsWith('ssam-digest/1 module=Quotes'));
  assert.match(text1, /## entities \(2\)\nentity Quote @E1/);
  const recordsAt = first.contents.find(p => p.part === 'records').pages[0];
  assert.ok(text1.includes('  record R009: Label="Value 9"') && !text1.includes('  record R010'), 'the first ' + FOLD_RECORDS + ' records on the overview');
  assert.ok(text1.includes('  … 30 more records (11-40 of 40) on page ' + recordsAt + ', part "static entity records"'));
  const all = pages.map(p => p.text).join('');
  assert.ok(pages[recordsAt - 1].text.includes('static entity Status @E2: records 11-40 of 40\n  record R010: Label="Value 10"'), 'the rest where the note says');
  const indexPages = first.contents.find(p => p.part === 'actionIndex').pages;
  const indexText = pages.slice(indexPages[0] - 1, indexPages[1]).map(p => p.text).join('');
  for (const a of digest.actions) assert.ok(indexText.includes(indexLine(a)), a.name);
  assert.ok(indexText.includes('server action Action5 @A5 (Id: Long Integer; Filter?: Text) -> (Result: Text) calls: Action4 | called by: Action6'));
  assert.ok(!text1.includes('step 0 of Action0'), 'no body on the overview');
  // Contents names every part in page order, and each part's lines are on its pages.
  assert.deepEqual(first.contents.map(p => p.part), ['header', 'entities', 'structures', 'actionIndex', 'coverage', 'references', 'roles', 'actions', 'ui', 'records']);
  for (const part of first.contents) assert.ok(part.pages[0] >= 1 && part.pages[1] <= first.pages && part.pages[0] <= part.pages[1], part.part);
  assert.ok(pages[first.contents.find(p => p.part === 'ui').pages[0] - 1].text.includes('## screens, blocks and emails (2)'));
  // Nothing dropped: every line of every block is on some page (the long line in pieces that join back).
  const stripped = all.replace(/ …\(this line continues on page \d+\)\n…\(line continued from page \d+\)\n/g, '');
  for (const s of digest.sections) for (const b of s.blocks) for (const line of b.text.split('\n')) assert.ok(stripped.includes(line), s.id + ': ' + line.slice(0, 60));
  // A block cut by a page says so where it stops and where it continues, with the block's first line.
  assert.match(all, /…\(this block continues on page (\d+)\)\n/);
  assert.match(all, /\n## screens, blocks and emails \(continued from page \d+\)\n…\(continued from page \d+\) screen MainFlow\/Huge @S9\n/);
  assert.match(all, / …\(this line continues on page \d+\)\n/);
  // Bodies by folder: the actions without a folder first, then each folder once.
  const bodies = pages.slice(first.contents.find(p => p.part === 'actions').pages[0] - 1).map(p => p.text).join('');
  assert.equal((bodies.match(/### folder Folder0/g) ?? []).length, 1); assert.ok(bodies.indexOf('server action Action1 @A1') < bodies.indexOf('### folder Folder0'));
  // The same pages for the same capture and budget, whatever the call: a module name, the file, a later call.
  const again = await ask(3);
  assert.equal(again.text, pages[2].text);
  assert.match((await ask(first.pages + 1)).error, new RegExp('page ' + (first.pages + 1) + ' does not exist: the module digest of this capture has ' + first.pages + ' page'));
});

test('a miss asks the lane kernel reader to ensure the digest, then reads the file it wrote; a bad file is never served', async t => {
  for (const lane of ['odc', 'o11']) {
    const c = setup(t);
    const calls = []; let prepared = 0;
    const read = async config => { calls.push(config); writeDigest(c.store, lane, c.sha256); return { ok: true, sourceSha256: c.sha256.toUpperCase(),
      digest: { path: digestFile(lane, c.sha256, c.env), built: true, bytes: 900 }, cache: { loads: 1, generation: 'g1' } }; };
    const reader = lane === 'o11' ? { entry: { cli: 'C:\\lane\\anvil.dll', root: 'C:\\kernel', lane: 'ss4' }, ssDir: 'C:\\studio' } : {};
    const page = await moduleMap({ lane, target: c.file, view: 'digest' }, { env: c.env, read, reader, prepare: async () => { prepared++; return { ok: true }; } });
    assert.equal(page.ok, true, page.error);
    assert.deepEqual(page.cache, { digest: 'ensured', built: true, loads: 1, generation: 'g1' });
    assert.equal(calls.length, 1); assert.equal(prepared, 0, 'the digest never builds the ODC builder');
    assert.deepEqual(calls[0].request, { file: c.file, digest: 'ensure', expectedSourceSha256: c.sha256 });
    assert.equal(calls[0].dll, lane === 'odc' ? odcKernelCli() : 'C:\\lane\\anvil.dll');
    assert.equal((await moduleMap({ lane, target: c.file, view: 'digest' }, { env: c.env, read: noReader, reader })).cache.digest, 'hit', 'the next call is a hit');
  }
  const c = setup(t);
  const other = 'f'.repeat(64);
  for (const [why, content] of Object.entries({
    'another capture': digestOf({ sourceSha256: other }), 'truncated JSON': '{"schema":"ssam-digest/1","sections":[',
    'another extractor': digestOf({ sourceSha256: c.sha256, overrides: { extractor: DIGEST_EXTRACTOR - 1 } }),
    'another adapter': digestOf({ sourceSha256: c.sha256, overrides: { adapter: 'builder' } }),
    'another lane': digestOf({ lane: 'o11', sourceSha256: c.sha256 }),
    'a section missing': digestOf({ sourceSha256: c.sha256, overrides: { sections: digestOf({ sourceSha256: c.sha256 }).sections.slice(1) } }),
    'records beyond the block': digestOf({ sourceSha256: c.sha256, overrides: { sections: digestOf({ sourceSha256: c.sha256 }).sections.map(s => s.id !== 'entities' ? s
      : { ...s, blocks: s.blocks.map(b => ({ ...b, records: 99 })) }) } }) })) {
    writeDigest(c.store, 'odc', c.sha256, content);
    let asked = 0;
    const refused = await moduleMap({ lane: 'odc', target: c.file, view: 'digest' }, { env: c.env, read: async () => { asked++; return { ok: true, digest: { built: false } }; } });
    assert.equal(refused.ok, false, why); assert.equal(asked, 1, why);
    assert.match(refused.error, /module digest of this capture is missing or invalid after the reader built it/, why);
  }
  // A reader that predates the digest answers a plain read.
  fs.rmSync(digestFile('odc', c.sha256, c.env));
  assert.match((await moduleMap({ lane: 'odc', target: c.file, view: 'digest' }, { env: c.env, read: async () => ({ ok: true, data: { module: 'Quotes' } }) })).error,
    /answered without a module digest: its binaries predate ssam-digest\/1/);
});

test('the digest view: the same target rules as the map, a capture pinned by its hash, and its own arguments', async t => {
  const c = setup(t);
  writeDigest(c.store, 'odc', c.sha256, digestOf({ sourceSha256: c.sha256, size: 'large' }));
  // A module name is captured once; every continuation then names the capture file and its hash, never the module again.
  const seen = [];
  const capture = async (args, pid) => { seen.push(args); return { ok: true, path: c.file, sha256: c.sha256 }; };
  const first = await moduleMap({ lane: 'odc', target: 'Quotes', view: 'digest' }, { env: c.env, read: noReader, capture });
  assert.equal(first.ok, true, first.error); assert.deepEqual(seen, [['snapshot', 'Quotes']]); assert.equal(first.target, 'Quotes');
  assert.equal(first.continuations.next.arguments.target, c.file); assert.equal(first.continuations.next.arguments.expectedSourceSha256, c.sha256);
  assert.deepEqual(first.continuations.page.arguments, { lane: 'odc', target: c.file, view: 'digest', budgetBytes: first.size.budgetBytes, expectedSourceSha256: c.sha256, page: '<n>' });
  const second = await moduleMap(first.continuations.next.arguments, { env: c.env, read: noReader, capture: noReader });
  assert.equal(second.ok, true, second.error); assert.equal(second.page, 2); assert.equal(seen.length, 1, 'no second capture');
  // A capture that changed since page 1 is refused with the reader's words.
  fs.writeFileSync(c.file, 'changed bytes');
  assert.match((await moduleMap(first.continuations.next.arguments, { env: c.env, read: noReader })).error, /^Snapshot content changed: expectedSourceSha256 does not match/);
  // view and its arguments.
  const ask = input => moduleMap({ lane: 'odc', target: c.file, ...input }, { env: c.env, read: noReader });
  assert.match((await ask({ view: 'summary' })).error, /view must be one of: map, digest/);
  assert.match((await ask({ view: 'digest', kind: 'ServerAction', role: 'action' })).error, /view "digest" pages the whole module digest; kind, role belong to view "map"/);
  assert.match((await ask({ view: 'digest', offset: 5 })).error, /offset belong to view "map"/);
  assert.match((await ask({ page: 2 })).error, /page belongs to view "digest"/);
  assert.match((await ask({ view: 'digest', page: 0 })).error, /page must be an integer between 1 and 100000/);
  // The defaults the MCP schema fills (offset 0, max, includeDetail false) are not map filters: the call reaches the store
  // (the changed bytes have no digest, so it asks the reader).
  assert.match((await ask({ view: 'digest', offset: 0, max: 100, includeDetail: false })).error, /the reader must not be called/);
});

test('CLI arguments: ssam map --digest [--page n]', () => {
  assert.deepEqual(parseMapArguments(['q.oml', '--digest', '--page', '3', '--budget', '20000', '--lane', 'o11']),
    { target: 'q.oml', view: 'digest', page: '3', budgetBytes: '20000', lane: 'o11' });
  assert.deepEqual(parseMapArguments(['--view', 'digest', 'q.oml']), { target: 'q.oml', view: 'digest' });
  assert.throws(() => parseMapArguments(['q.oml', '--view', 'map', '--digest']), /--digest and --view map disagree/);
  assert.throws(() => parseMapArguments(['q.oml', '--page']), /Missing value for --page/);
});
