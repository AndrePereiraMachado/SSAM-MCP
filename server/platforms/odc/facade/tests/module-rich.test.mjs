// ssam_map views "search" and "uses" over synthetic stored rich indexes (the C# writer is not needed): text in expressions,
// values, arguments and names; who uses an element inside a module and across modules (a consumer's signature resolves to
// the producer by its GlobalKey); built only on request (a miss asks the lane's kernel reader {"rich":"ensure"}, mocked
// here) and said so; served only when schema, extractor, lane, adapter and the hash of the bytes read now match; every
// page inside the budget, nothing lost between pages, every continuation pinned to the same captures.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleMap, parseMapArguments, richFile, odcKernelCli, ROLES } from '../module-map.mjs';
import { RICH_EXTRACTOR, PROPERTY_TYPES, RICH_SCHEMA, SEARCH_SCHEMA, USES_SCHEMA } from '../module-rich.mjs';
import { writeCapture } from './fixtures/module-index.mjs';
import { STORE_GENERATION } from '../store-generation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelSource = path.join(here, '..', '..', '..', '..', 'kernel', 'src', 'Anvil.Core', 'Kernel', 'ModuleRichIndex.cs');
const noReader = async () => { throw new Error('the reader must not be called on a hit'); };
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-module-rich-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  return { dir, store, env, capture: text => writeCapture(dir, text) };
}

// A rich index as ModuleRichIndex.ToJson writes it. nodes: [key, kind, name, parentKey, role, props [[name, type, text]],
// refs [[targetKey, via]], global]. Rows are sorted by key; tables are built in first-use order.
function richOf({ lane = 'o11', sourceSha256, module, nodes, references = [], overrides = {} }) {
  const sorted = [...nodes].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const at = new Map(sorted.map((n, i) => [n[0], i]));
  const types = []; const names = [];
  const type = kind => { let i = types.findIndex(t => t.kind === kind); if (i < 0) { i = types.length; types.push({ kind, answers: ['I' + kind, ...(kind.endsWith('Action') ? ['IAction'] : [])] }); } return i; };
  const name = n => { let i = names.indexOf(n); if (i < 0) { i = names.length; names.push(n); } return i; };
  const rows = sorted.map(([key, kind, nm, parent, role, props = [], refs = [], global = null]) => [key, type(kind), nm, parent ? at.get(parent) : -1, ROLES.indexOf(role),
    props.map(([p, ty, text]) => [name(p), ty, text]), refs.map(([target, via]) => [at.get(target), via == null ? -1 : name(via)]), global]);
  return { schema: RICH_SCHEMA, extractor: RICH_EXTRACTOR, lane, adapter: 'kernel', sourceSha256, sourceBytes: 42, createdAt: '2026-10-10T00:00:00Z',
    module, complete: true, readErrors: 0, errorSamples: [], counts: {}, roles: ROLES, propertyTypes: PROPERTY_TYPES, types, names,
    references: references.map(([key, producer, producerKey]) => [at.get(key), producer, producerKey]), rows, ...overrides };
}
function writeRich(store, lane, sha256, rich) {
  const file = richFile(lane, sha256, { SSAM_MODULE_INDEX_ROOT: store });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof rich === 'string' ? rich : JSON.stringify(rich));
  return file;
}

// The producer: Customers_CS (module key PK) with GetCustomer (input Id) and a site property used by its own If.
const producer = sha256 => richOf({ sourceSha256: sha256, module: { name: 'Customers_CS', key: 'PK', kind: 'ESpace' }, nodes: [
  ['P0', 'ESpace', 'Customers_CS', null, 'module'],
  ['A9', 'ServerAction', 'GetCustomer', 'P0', 'action', [['Public', 'v', 'True'], ['Description', 't', 'Reads one customer by its Id.']]],
  ['A9.Id', 'InputParameter', 'Id', 'A9', 'parameter', [['DataType', 'r', 'IdentifierType:Customer Identifier']]],
  ['A9.R', 'OutputParameter', 'Strict', 'A9', 'parameter'],
  ['SP2', 'SiteProperty', 'Strict', 'P0', 'variable', [['DefaultValue', 'e', 'True']]],
  ['N9', 'IfNode', 'Strict?', 'A9', 'flowNode', [['Condition', 'e', 'Site.Strict and Id <> NullIdentifier()']], [['SP2', 'Condition'], ['A9.Id', 'Condition']]],
] });
// The consumer: Orders (module key MK) calls GetCustomer through its Reference to Customers_CS; its site property
// MaxLines is used by an If and an assignment; an aggregate filters on Order.
const consumer = sha256 => richOf({ sourceSha256: sha256, module: { name: 'Orders', key: 'MK', kind: 'ESpace' }, nodes: [
  ['M0', 'ESpace', 'Orders', null, 'module'],
  ['R1', 'Reference', 'Customers_CS', 'M0', 'reference', [['ModuleKey', 'v', 'PK']]],
  ['S1', 'ServerActionSignature', 'GetCustomer', 'R1', 'actionRef', [], [['S1.Id', null]], 'PK*A9'],
  ['S1.Id', 'InputParameterSignature', 'Id', 'S1', 'parameter', [], [], 'PK*A9.Id'],
  ['SP1', 'SiteProperty', 'MaxLines', 'M0', 'variable', [['DefaultValue', 'e', '10'], ['Description', 't', 'x'.repeat(300) + ' MaxLines ' + 'y'.repeat(300)]]],
  ['A1', 'ServerAction', 'PlaceOrder', 'M0', 'action', [['Public', 'v', 'True']]],
  ['P1', 'InputParameter', 'Code', 'A1', 'parameter'],
  ['V1', 'LocalVariable', 'Code', 'A1', 'variable'],
  ['N1', 'IfNode', 'Too many?', 'A1', 'flowNode', [['Condition', 'e', 'Lines.Count > Site.MaxLines']], [['SP1', 'Condition'], ['N2', 'TrueTarget']]],
  ['N2', 'ExecuteServerActionNode', 'Customer', 'A1', 'flowNode', [['Action', 'r', 'ServerActionSignature:GetCustomer'], ['Id', 'a', 'Code']],
    [['S1', 'Action'], ['S1.Id', 'arg:Id'], ['P1', 'arg:Id']]],
  ['N3', 'AggregateNode', 'GetOrders', 'A1', 'aggregate', [['MaxRecords', 'e', 'Site.MaxLines']], [['SP1', 'MaxRecords']]],
  ['N4', 'Filter', '', 'N3', 'other', [['Condition', 'e', 'Order.Code = Code']], [['P1', 'Condition']]],
  ['N5', 'AssignNode', 'Limit', 'A1', 'flowNode'],
  ['N6', 'Assignment', '', 'N5', 'other', [['Value', 'e', 'Site.MaxLines * 2'], ['Variable', 'e', 'Limit']], [['SP1', 'Value']]],
], references: [['R1', 'Customers_CS', 'PK']] });

test('the rich index constants are the C# ones and the file sits beside the index, kernel adapter in both lanes', () => {
  const source = fs.readFileSync(kernelSource, 'utf8');
  assert.equal(Number(source.match(/public const int Extractor = (\d+);/)[1]), RICH_EXTRACTOR);
  assert.equal(source.match(/public const string PropertyTypes = "(\w+)";/)[1], PROPERTY_TYPES);
  assert.equal(source.match(/public const string Schema = "([^"]+)";/)[1], RICH_SCHEMA);
  const env = { SSAM_MODULE_INDEX_ROOT: path.join(os.tmpdir(), 'store') };
  for (const lane of ['odc', 'o11']) assert.equal(richFile(lane, 'A'.repeat(64), env), path.join(env.SSAM_MODULE_INDEX_ROOT, STORE_GENERATION, lane, 'a'.repeat(64) + '.kernel.rich.json'));
});

test('search: text in expressions, values, arguments and names, with filters, regex and the passage of each hit', async t => {
  const c = setup(t); const a = c.capture('orders');
  writeRich(c.store, 'o11', a.sha256, consumer(a.sha256));
  const ask = input => moduleMap({ lane: 'o11', target: a.file, view: 'search', ...input }, { env: c.env, read: noReader });
  const all = await ask({ text: 'site.maxlines' });
  assert.equal(all.ok, true, all.error);
  assert.equal(all.schema, SEARCH_SCHEMA); assert.equal(all.view, 'search'); assert.equal(all.captures[0].cache.rich, 'hit');
  // Rows by key, then property: the If condition, the aggregate's MaxRecords, the assignment value.
  assert.deepEqual(all.entries.map(e => [e.key, e.property, e.type]), [['N1', 'Condition', 'expression'], ['N3', 'MaxRecords', 'expression'], ['N6', 'Value', 'expression']]);
  assert.deepEqual(all.entries[0], { module: 'Orders', key: 'N1', kind: 'IfNode', name: 'Too many?', path: 'ServerAction:PlaceOrder/IfNode:Too many?', property: 'Condition',
    type: 'expression', snippet: 'Lines.Count > Site.MaxLines' });
  assert.deepEqual(all.byModule, { Orders: 3 });
  // An argument (arg:<parameter>), a name, a value; the property filter, arg for any argument.
  assert.deepEqual((await ask({ text: 'Code', property: 'arg' })).entries.map(e => [e.key, e.property, e.type]), [['N2', 'arg:Id', 'argument']]);
  assert.deepEqual((await ask({ text: 'Code', property: 'arg:Id' })).entries.map(e => e.key), ['N2']);
  assert.deepEqual((await ask({ text: 'placeorder' })).entries.map(e => [e.key, e.property, e.type]), [['A1', 'Name', 'name']]);
  assert.deepEqual((await ask({ text: 'Code', property: 'condition' })).entries.map(e => e.key), ['N4']);
  // kind matches the interfaces an element answers; role filters by the index role.
  assert.deepEqual((await ask({ text: 'MaxLines', kind: 'IfNode' })).entries.map(e => e.key), ['N1']);
  // One kind with a stray separator is that kind (review of U6: "IfNode|" reached this view raw and answered nothing); a
  // kind that names nothing is refused.
  for (const kind of ['IfNode|', 'IfNode,', ' IfNode , ']) {
    const one = await ask({ text: 'MaxLines', kind });
    assert.deepEqual(one.entries.map(e => e.key), ['N1'], kind); assert.equal(one.query.kind, 'IfNode', kind);
  }
  for (const kind of ['|', ', ,']) assert.match((await ask({ text: 'MaxLines', kind })).error, /^kind must name a kind$/, kind);
  assert.deepEqual((await ask({ text: 'MaxLines', role: 'variable' })).entries.map(e => [e.key, e.property]), [['SP1', 'Name'], ['SP1', 'Description']]);
  // A regular expression; an invalid one is refused with its reason.
  assert.deepEqual((await ask({ text: '^Site\\.MaxLines$', regex: true })).entries.map(e => e.key), ['N3']);
  assert.match((await ask({ text: '(', regex: true })).error, /text is not a valid regular expression/);
  // A long value: the passage around the match, marked clipped with the whole length; the capture's inspect reads it.
  const long = (await ask({ text: ' MaxLines ', property: 'Description' })).entries[0];
  assert.equal(long.clipped, true); assert.equal(long.textLength, 610); assert.ok(long.snippet.startsWith('…') && long.snippet.endsWith('…') && long.snippet.includes(' MaxLines '));
  assert.deepEqual(all.captures[0].inspect, { tool: 'o11_inspect', arguments: { oml: a.file, path: '@<key>', expectedSourceSha256: a.sha256 } });
  assert.equal(all.size.bytes, bytes(all)); assert.ok(all.timings.queryMs >= 0);
});

test('uses inside one module: every consumer, the property that uses it, direct or through a descendant, internal uses left out', async t => {
  const c = setup(t); const a = c.capture('orders');
  writeRich(c.store, 'o11', a.sha256, consumer(a.sha256));
  const ask = input => moduleMap({ lane: 'o11', target: a.file, view: 'uses', ...input }, { env: c.env, read: noReader });
  const site = await ask({ element: 'MaxLines' });
  assert.equal(site.ok, true, site.error);
  assert.equal(site.schema, USES_SCHEMA);
  assert.deepEqual(site.resolved, { module: 'Orders', key: 'SP1', kind: 'SiteProperty', name: 'MaxLines', path: 'SiteProperty:MaxLines', identity: 'MK*SP1', homeModule: 'Orders',
    foundIn: [{ module: 'Orders', key: 'SP1' }] });
  assert.deepEqual(site.entries.map(e => [e.consumer.key, e.via, e.relation]), [['N1', 'Condition', 'direct'], ['N3', 'MaxRecords', 'direct'], ['N6', 'Value', 'direct']]);
  assert.equal(site.consumers, 3); assert.equal(site.crossModule, 0);
  // kind narrows the element; a stray separator ("SiteProperty,") is the same one kind.
  assert.deepEqual((await ask({ element: 'MaxLines', kind: 'SiteProperty,' })).entries, site.entries);
  // An action: its parameter's uses are uses of the action (descendant), inside the action they are not uses.
  const action = await ask({ element: 'ServerAction:PlaceOrder' });
  assert.deepEqual(action.entries, []);
  const parameter = await ask({ element: 'InputParameter:Code' });
  assert.deepEqual(parameter.entries.map(e => [e.consumer.key, e.via]), [['N2', 'arg:Id'], ['N4', 'Condition']]);
  // A name path: the call node Customer of PlaceOrder, reached by the If's True connector.
  assert.deepEqual((await ask({ element: 'PlaceOrder/Customer' })).entries.map(e => [e.consumer.key, e.via, e.relation]), [['N1', 'TrueTarget', 'direct']]);
  // The same element by @key and by Kind:Name.
  assert.deepEqual((await ask({ element: '@SP1' })).entries, site.entries);
  assert.deepEqual((await ask({ element: 'SiteProperty:MaxLines' })).entries, site.entries);
  // A name for several elements is ambiguous: the candidates and the same question by @key; no element: a search by name.
  const ambiguous = await ask({ element: 'Code' });
  assert.equal(ambiguous.ok, false); assert.equal(ambiguous.code, 'AMBIGUOUS_ELEMENT');
  assert.deepEqual(ambiguous.candidates.map(x => x.key).sort(), ['P1', 'V1']);
  const missing = await ask({ element: 'Nothing' });
  assert.equal(missing.code, 'ELEMENT_NOT_FOUND');
  assert.deepEqual(missing.continuation.arguments, { lane: 'o11', target: a.file, view: 'search', text: 'Nothing', property: 'Name', max: 100, budgetBytes: missing.continuation.arguments.budgetBytes, expectedSourceSha256: a.sha256 });
});

test('uses across modules: a consumer signature resolves to the producer element by its GlobalKey, both ways', async t => {
  const c = setup(t); const o = c.capture('orders'); const p = c.capture('customers');
  writeRich(c.store, 'o11', o.sha256, consumer(o.sha256));
  writeRich(c.store, 'o11', p.sha256, producer(p.sha256));
  const ask = (input, target = [o.file, p.file]) => moduleMap({ lane: 'o11', target, view: 'uses', ...input }, { env: c.env, read: noReader });
  // The producer's action: its call in Orders (through the signature) is a cross-module use.
  const action = await ask({ element: 'Customers_CS.GetCustomer' });
  assert.equal(action.ok, true, action.error);
  assert.equal(action.resolved.module, 'Customers_CS'); assert.equal(action.resolved.key, 'A9'); assert.equal(action.resolved.identity, 'PK*A9');
  assert.deepEqual(action.resolved.foundIn, [{ module: 'Orders', key: 'S1' }, { module: 'Customers_CS', key: 'A9' }]);
  assert.deepEqual(action.entries.map(e => [e.module, e.capture, e.consumer.key, e.via, e.relation, e.crossModule ?? false]),
    [['Orders', 0, 'N2', 'Action', 'direct', true], ['Orders', 0, 'N2', 'arg:Id', 'descendant', true]]);
  // The producer's own If on the action's input is inside the action: not a use.
  assert.equal(action.crossModule, 2); assert.deepEqual(action.byModule, { Orders: 2 });
  assert.equal(action.entries[1].target.key, 'S1.Id');
  // The consumer's own signature names the same element: the same answer.
  assert.deepEqual((await ask({ element: '@S1' })).entries, action.entries);
  // Without the producer's capture: the signature in the consumer answers for it.
  const alone = await ask({ element: 'Customers_CS.GetCustomer' }, [o.file]);
  assert.equal(alone.resolved.key, 'S1'); assert.equal(alone.resolved.homeModule, 'Customers_CS');
  assert.deepEqual(alone.entries.map(e => [e.consumer.key, e.via, e.crossModule]), [['N2', 'Action', true], ['N2', 'arg:Id', true]]);
  // A name means the top-level element first: the output parameter of the same name is left out and counted.
  const strict = await ask({ element: 'Strict' });
  assert.equal(strict.resolved.key, 'SP2'); assert.equal(strict.resolved.alsoMatched, 1); assert.match(strict.resolved.alsoMatchedNote, /by @key or by a name path/);
  assert.deepEqual(strict.entries.map(e => [e.module, e.consumer.key, e.via]), [['Customers_CS', 'N9', 'Condition']]);
  // Search over both modules names each hit's module and capture.
  const found = await moduleMap({ lane: 'o11', target: [o.file, p.file], view: 'search', text: 'Site.' }, { env: c.env, read: noReader });
  assert.deepEqual(found.entries.map(e => [e.module, e.capture, e.key]), [['Orders', 0, 'N1'], ['Orders', 0, 'N3'], ['Orders', 0, 'N6'], ['Customers_CS', 1, 'N9']]);
  assert.deepEqual(found.byModule, { Orders: 3, Customers_CS: 1 });
  assert.equal(found.continuations.inspect, 'captures[<capture>].inspect with the @key of an entry');
  assert.deepEqual(found.captures.map(x => [x.module, x.sourceSha256]), [['Orders', o.sha256], ['Customers_CS', p.sha256]]);
});

test('built on request: a miss asks the kernel reader once, says how long it took, and a bad file is never served', async t => {
  for (const lane of ['odc', 'o11']) {
    const c = setup(t); const a = c.capture('orders ' + lane);
    const calls = [];
    const read = async config => { calls.push(config); writeRich(c.store, lane, a.sha256, consumer(a.sha256).lane === lane ? consumer(a.sha256) : { ...consumer(a.sha256), lane });
      return { ok: true, sourceSha256: a.sha256.toUpperCase(), rich: { path: richFile(lane, a.sha256, c.env), built: true, bytes: 900 },
        cache: { loads: 1, generation: 'g1' }, timings: { loadMs: 1200, richMs: 3400 } }; };
    const reader = lane === 'o11' ? { entry: { cli: 'C:\\lane\\anvil.dll', root: 'C:\\kernel', lane: 'ss4' }, ssDir: 'C:\\studio' } : {};
    const first = await moduleMap({ lane, target: a.file, view: 'search', text: 'MaxLines' }, { env: c.env, read, reader });
    assert.equal(first.ok, true, first.error);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request, { file: a.file, rich: 'ensure', expectedSourceSha256: a.sha256 });
    assert.equal(calls[0].dll, lane === 'odc' ? odcKernelCli() : 'C:\\lane\\anvil.dll');
    assert.equal(first.captures[0].cache.rich, 'ensured'); assert.equal(first.captures[0].cache.built, true);
    assert.equal(first.captures[0].cache.buildMs, 3400); assert.equal(first.captures[0].cache.loadMs, 1200);
    assert.deepEqual(first.built.map(b => [b.module, b.built]), [['Orders', true]]); assert.ok(first.built[0].ensureMs >= 0 && first.timings.ensureMs >= 0);
    // The next call answers from the file (parsed once and kept): no reader, nothing built.
    const again = await moduleMap({ lane, target: a.file, view: 'uses', element: 'MaxLines' }, { env: c.env, read: noReader, reader });
    assert.equal(again.ok, true, again.error); assert.equal(again.captures[0].cache.rich, 'memory'); assert.equal(again.built, undefined);
  }
  // A plain map, the digest and a search never build each other's files: only a rich view asks for the rich index.
  const c = setup(t); const a = c.capture('orders');
  for (const [why, content] of Object.entries({ 'another capture': consumer('f'.repeat(64)), 'truncated JSON': '{"schema":"ssam-rich-index/1","rows":[',
    'another extractor': { ...consumer(a.sha256), extractor: RICH_EXTRACTOR - 1 }, 'another adapter': { ...consumer(a.sha256), adapter: 'builder' },
    'another lane': { ...consumer(a.sha256), lane: 'odc' }, 'other property types': { ...consumer(a.sha256), propertyTypes: 'et' },
    'a reference out of range': (() => { const r = consumer(a.sha256); r.rows[2][6] = [[999, -1]]; return r; })(),
    'rows out of key order': (() => { const r = consumer(a.sha256); r.rows.reverse(); return r; })() })) {
    writeRich(c.store, 'o11', a.sha256, content);
    let asked = 0;
    const refused = await moduleMap({ lane: 'o11', target: a.file, view: 'search', text: 'x' }, { env: c.env, read: async () => { asked++; return { ok: true, rich: { built: false } }; } });
    assert.equal(refused.ok, false, why); assert.equal(asked, 1, why);
    assert.match(refused.error, /rich index of this capture is missing or invalid after the reader built it/, why);
  }
  fs.rmSync(richFile('o11', a.sha256, c.env));
  assert.match((await moduleMap({ lane: 'o11', target: a.file, view: 'uses', element: 'X' }, { env: c.env, read: async () => ({ ok: true, data: { module: 'Orders' } }) })).error,
    /answered without a rich index: its binaries predate ssam-rich-index\/1/);
});

test('pages: every page inside the budget, nothing lost or repeated, every continuation pins the same captures and hashes', async t => {
  const c = setup(t); const o = c.capture('orders'); const p = c.capture('customers');
  // Many hits: 300 assignments that use MaxLines.
  const many = consumer(o.sha256);
  const extra = Array.from({ length: 300 }, (_, i) => ['X' + String(i).padStart(4, '0'), 'Assignment', '', 'M0', 'other', [['Value', 'e', 'Site.MaxLines + ' + i + ' ' + 'z'.repeat(40)]], [['SP1', 'Value']]]);
  writeRich(c.store, 'o11', o.sha256, richOf({ sourceSha256: o.sha256, module: many.module, references: [['R1', 'Customers_CS', 'PK']],
    nodes: [...consumerNodes(), ...extra] }));
  writeRich(c.store, 'o11', p.sha256, producer(p.sha256));
  const budgetBytes = 6000;
  for (const view of ['search', 'uses']) {
    const query = view === 'search' ? { text: 'Site.MaxLines' } : { element: 'MaxLines' };
    const pages = [await moduleMap({ lane: 'o11', target: [o.file, p.file], view, ...query, budgetBytes }, { env: c.env, read: noReader })];
    assert.equal(pages[0].ok, true, pages[0].error);
    while (pages.at(-1).continuations.next) {
      const next = pages.at(-1).continuations.next;
      assert.deepEqual(next.arguments, { lane: 'o11', target: [o.file, p.file], view, ...query, max: 100, budgetBytes, expectedSourceSha256: [o.sha256, p.sha256], offset: next.arguments.offset });
      pages.push(await moduleMap(next.arguments, { env: c.env, read: noReader }));
      assert.ok(pages.length < 200, 'pages end');
    }
    for (const page of pages) { assert.ok(bytes(page) <= budgetBytes, view + ' page ' + bytes(page)); assert.ok(page.returned > 0); assert.equal(page.count, pages[0].count); }
    const keys = pages.flatMap(page => page.entries.map(e => view === 'search' ? e.key + ':' + e.property : e.consumer.key + ':' + (e.target?.key ?? '') + ':' + e.via));
    assert.equal(keys.length, pages[0].count, view + ': every hit once'); assert.equal(new Set(keys).size, keys.length);
    assert.ok(pages[0].count >= 300); assert.equal(pages[0].size.limitedBy, 'budget');
  }
  // A changed capture is refused with the reader's words; one hash per target.
  const first = await moduleMap({ lane: 'o11', target: [o.file, p.file], view: 'search', text: 'Site', budgetBytes }, { env: c.env, read: noReader });
  fs.writeFileSync(p.file, 'changed');
  assert.match((await moduleMap(first.continuations.next.arguments, { env: c.env, read: noReader })).error, /^Snapshot content changed: expectedSourceSha256 does not match the source bytes \(target /);
});

function consumerNodes() {
  return [
    ['M0', 'ESpace', 'Orders', null, 'module'],
    ['R1', 'Reference', 'Customers_CS', 'M0', 'reference', [['ModuleKey', 'v', 'PK']]],
    ['S1', 'ServerActionSignature', 'GetCustomer', 'R1', 'actionRef', [], [], 'PK*A9'],
    ['SP1', 'SiteProperty', 'MaxLines', 'M0', 'variable', [['DefaultValue', 'e', '10']]],
  ];
}

test('arguments: the rich views take text or element, kind, role, offset and max; a list of targets only there', async t => {
  const c = setup(t); const a = c.capture('orders');
  writeRich(c.store, 'o11', a.sha256, consumer(a.sha256));
  const ask = input => moduleMap({ lane: 'o11', target: a.file, ...input }, { env: c.env, read: noReader });
  assert.match((await ask({ view: 'search' })).error, /view "search" needs text/);
  assert.match((await ask({ view: 'uses' })).error, /view "uses" needs element/);
  assert.match((await ask({ view: 'search', text: 'x', name: 'A', parent: '@M0' })).error, /name, parent belong to view "map"/);
  assert.match((await ask({ view: 'uses', element: 'x', text: 'y' })).error, /text belong to view "search"/);
  assert.match((await ask({ view: 'search', text: 'x', element: 'y' })).error, /element belong to view "uses"/);
  assert.match((await ask({ view: 'search', text: 'x', page: 2 })).error, /page belong to view "digest"/);
  assert.match((await ask({ text: 'x' })).error, /text belong to views "search" \(text, regex, property\) and "uses" \(element\)/);
  assert.match((await ask({ view: 'digest', element: 'x' })).error, /element belong to views/);
  assert.match((await moduleMap({ lane: 'o11', target: [a.file, a.file], view: 'map' }, { env: c.env, read: noReader })).error, /a list of targets belongs to views "search" and "uses"/);
  assert.match((await moduleMap({ lane: 'o11', target: [a.file, a.file], view: 'search', text: 'x' }, { env: c.env, read: noReader })).error, /target names the same capture twice/);
  assert.match((await moduleMap({ lane: 'o11', target: [a.file], view: 'search', text: 'x', expectedSourceSha256: [a.sha256, a.sha256] }, { env: c.env, read: noReader })).error, /one hash per target \(1\)/);
  assert.match((await ask({ view: 'search', text: 'x', role: 'nope' })).error, /Unknown role nope/);
  // The defaults the MCP schema fills are not filters: offset 0, includeDetail false, regex false.
  assert.equal((await ask({ view: 'uses', element: 'MaxLines', offset: 0, max: 100, includeDetail: false, regex: false })).ok, true);
  assert.doesNotMatch((await ask({ view: 'map', regex: false })).error ?? '', /belong/);
});

test('CLI arguments: ssam map --search / --uses over one or several captures', () => {
  assert.deepEqual(parseMapArguments(['a.oml', 'b.oml', '--search', 'Site.MaxLines', '--regex', '--property', 'Condition', '--kind', 'IfNode', '--lane', 'o11']),
    { target: ['a.oml', 'b.oml'], view: 'search', text: 'Site.MaxLines', regex: true, property: 'Condition', kind: 'IfNode', lane: 'o11' });
  assert.deepEqual(parseMapArguments(['--uses', 'Customers_CS.GetCustomer', 'a.oml']), { target: 'a.oml', view: 'uses', element: 'Customers_CS.GetCustomer' });
  assert.deepEqual(parseMapArguments(['--view', 'uses', '--element', '@K', '--oml', 'a.oml', '--oml', 'b.oml']), { target: ['a.oml', 'b.oml'], view: 'uses', element: '@K' });
  assert.throws(() => parseMapArguments(['a.oml', '--search']), /Missing value for --search/);
  assert.throws(() => parseMapArguments(['a.oml', '--digest', '--uses', 'X']), /--uses and --view digest disagree/);
  assert.throws(() => parseMapArguments(['a.oml', 'b.oml', '--digest']), /one target/);
});
