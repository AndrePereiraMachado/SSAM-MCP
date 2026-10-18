// The module map over synthetic index files (the C# writer is not needed): served only when schema, extractor and the
// hash of the bytes read now match; a miss asks the lane reader ({"index":"ensure"}, mocked here); filters, detail
// hiding, paging, the byte budget and the continuations of both lanes. The warm-up spawns a detached helper with its
// own reader cache root and never waits for it.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleMap, parseMapArguments, prefetchIndex, prefetchMain, prefetchCacheRoot, readerConfig, indexFile, MAP_SCHEMA, MAP_USAGE, DEFAULT_MAP_BUDGET } from '../module-map.mjs';
import { paths } from '../lib.mjs';
import { LANES } from '../lanes.mjs';
import { LONG_NAME, NODES, moduleIndex, writeCapture, writeIndex, storeFile } from './fixtures/module-index.mjs';

const helper = fileURLToPath(new URL('../module-map.mjs', import.meta.url));
function setup(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-module-map-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  return { dir, store, env, ...writeCapture(dir, text) };
}
const noReader = async () => { throw new Error('the reader must not be called on a hit'); };
const keys = answer => answer.entries.map(e => e.key);

test('a stored index answers without .NET: entries, paths, parents, hidden detail and the ODC continuations', async t => {
  const c = setup(t);
  writeIndex(c.store, 'odc', c.sha256);
  const map = await moduleMap({ lane: 'odc', target: c.file }, { env: c.env, read: noReader, prepare: noReader });
  assert.equal(map.ok, true, map.error);
  assert.equal(map.schema, MAP_SCHEMA); assert.equal(map.answeredBy, 'module-index'); assert.equal(map.cache.index, 'hit');
  assert.equal(map.sourceSha256, c.sha256); assert.equal(map.file, c.file); assert.equal(map.index.file, storeFile(c.store, 'odc', c.sha256));
  assert.deepEqual(map.module, { name: 'Quotes', key: 'R0000000000000000000000', kind: 'ESpace' });
  // Sorted by key (ordinal), as the reader pages; the expression and the anonymous structure with its attribute are hidden.
  assert.deepEqual(keys(map), ['A1111111111111111111111', 'A2222222222222222222222', 'A3333333333333333333333', 'F1111111111111111111111',
    'P1111111111111111111111', 'P2222222222222222222222', 'R0000000000000000000000', 'S1111111111111111111111', 'S2222222222222222222222',
    'S3333333333333333333333', 'V1111111111111111111111']);
  assert.deepEqual(map.hidden.detail, 1); assert.deepEqual(map.hidden.anonymous, 2);
  assert.equal(map.count, 11); assert.equal(map.returned, 11); assert.equal(map.nextOffset, null); assert.equal(map.truncated, false);
  const byKey = Object.fromEntries(map.entries.map(e => [e.key, e]));
  assert.deepEqual(byKey.V1111111111111111111111, { key: 'V1111111111111111111111', kind: 'LocalVariable', name: 'Filter', role: 'variable',
    parentKey: 'S1111111111111111111111', path: 'MobileFlow:MainFlow/MobileScreen:Home/LocalVariable:Filter', childrenTotal: 0, dataType: 'Text' });
  assert.equal(byKey.R0000000000000000000000.parentKey, null); assert.equal(byKey.R0000000000000000000000.path, '');
  assert.equal(byKey.F1111111111111111111111.childrenTotal, 3);
  // The reader's 80-character clip of each path segment.
  assert.equal(byKey.P2222222222222222222222.path, 'ServerAction:' + LONG_NAME.slice(0, 80) + '…/InputParameter:Page');
  assert.equal(map.counts.elements, 14); assert.equal(map.counts.byKind.MobileScreen, 3); assert.equal(map.counts.byRole.action, 3);
  assert.deepEqual(map.continuations.inspect.tool, 'studio_inspect');
  assert.deepEqual(map.continuations.inspect.arguments, { target: c.file, path: '@<key>', expectedSourceSha256: c.sha256 });
  assert.equal(map.continuations.inspect.cli, undefined, 'MCP continuations only, no CLI line');
  assert.equal(map.continuations.next, null);
  assert.equal(map.hidden.note.includes('--'), false, 'the hidden note names the argument, not a CLI flag');
  assert.equal(map.searchComplete, true); assert.equal(map.kindObserved, true); assert.deepEqual(map.notices, []);
});

test('filters: kind by any name the element answers to, exact name, prefix, role, parent and key', async t => {
  const c = setup(t);
  writeIndex(c.store, 'odc', c.sha256);
  const ask = input => moduleMap({ lane: 'odc', target: c.file, ...input }, { env: c.env, read: noReader });
  assert.deepEqual(keys(await ask({ kind: 'MobileScreen' })), ['S1111111111111111111111', 'S2222222222222222222222', 'S3333333333333333333333']);
  assert.deepEqual(keys(await ask({ kind: 'WebScreen' })), keys(await ask({ kind: 'IMobileScreen' })), 'an interface the screen implements');
  assert.deepEqual(keys(await ask({ kind: 'OutSystems.Model.UI.Mobile.IMobileScreen' })).length, 3);
  assert.equal((await ask({ kind: '*' })).count, 14, 'a kind lists every row, detail included');
  assert.deepEqual(keys(await ask({ kind: 'Expression' })), ['A2222222222222222222222.#Value']);
  assert.deepEqual(keys(await ask({ name: 'getquote' })), ['A2222222222222222222222']);
  assert.deepEqual(keys(await ask({ prefix: 'getq' })), ['A1111111111111111111111', 'A2222222222222222222222']);
  assert.deepEqual(keys(await ask({ role: 'parameter' })), ['P1111111111111111111111', 'P2222222222222222222222']);
  assert.deepEqual(keys(await ask({ parent: '@F1111111111111111111111' })), ['S1111111111111111111111', 'S2222222222222222222222', 'S3333333333333333333333']);
  assert.deepEqual(keys(await ask({ parent: '@A2222222222222222222222' })), ['P1111111111111111111111'], 'the expression stays hidden');
  assert.deepEqual(keys(await ask({ parent: '@N1111111111111111111111' })), ['N1111111111111111111111.#Name'], 'asking inside an anonymous type lists it');
  assert.deepEqual(keys(await ask({ key: '@N1111111111111111111111.#Name' })), ['N1111111111111111111111.#Name']);
  const missing = await ask({ kind: 'Timer' });
  assert.equal(missing.ok, true); assert.equal(missing.count, 0); assert.equal(missing.kindObserved, false); assert.match(missing.notices[0], /No instance of the requested kind/);
  const detail = await ask({ includeDetail: true });
  assert.equal(detail.count, 14); assert.equal(detail.hidden, undefined);
  assert.match((await ask({ key: '@Z9' })).error, /Unresolved key in this capture: @Z9/);
  assert.match((await ask({ role: 'screens' })).error, /Unknown role screens; roles: module, flow, screen/);
});

test('ancestors (parentRow <= -2, as the C# writer stores an aggregate\'s DataTable) are served: in paths and as parents, never listed', async t => {
  const c = setup(t);
  const nodes = [...NODES, ['G1111111111111111111111', 'Aggregate', 'GetQuotesAgg', 'S1111111111111111111111', 'aggregate'],
    ['T1111111111111111111111', 'AddSourceOperation', 'Quote', 'G1111111111111111111111.#Table', 'other']];
  const ancestors = [['G1111111111111111111111.#Table', 'DataTable', '', 'G1111111111111111111111']];
  writeIndex(c.store, 'odc', c.sha256, moduleIndex({ lane: 'odc', sourceSha256: c.sha256, nodes, ancestors }));
  const ask = input => moduleMap({ lane: 'odc', target: c.file, ...input }, { env: c.env, read: noReader });
  const source = await ask({ kind: 'AddSourceOperation' });
  assert.equal(source.ok, true, source.error); assert.equal(source.cache.index, 'hit');
  // ModelReader.PathOf climbs Parent() through the DataTable: 'DataTable:' (empty name) sits between the aggregate and the source.
  // parentKey is the aggregate (a row), the DataTable between is parentSlot (its kind: it has no name).
  assert.deepEqual(source.entries, [{ key: 'T1111111111111111111111', kind: 'AddSourceOperation', name: 'Quote', role: 'other',
    parentKey: 'G1111111111111111111111', parentSlot: 'DataTable', childrenTotal: 0,
    path: 'MobileFlow:MainFlow/MobileScreen:Home/Aggregate:GetQuotesAgg/DataTable:/AddSourceOperation:Quote' }]);
  assert.deepEqual(keys(await ask({ parent: '@G1111111111111111111111.#Table', includeDetail: true })), ['T1111111111111111111111']);
  assert.deepEqual(keys(await ask({ parent: '@G1111111111111111111111', includeDetail: true })), ['T1111111111111111111111']);
  assert.equal((await ask({ kind: '*' })).count, 16, 'the DataTable is not a row');
  // Its key answers the aggregate that owns it, and says so.
  const table = await ask({ key: '@G1111111111111111111111.#Table' });
  assert.deepEqual(keys(table), ['G1111111111111111111111']);
  assert.match(table.notices[0], /^@G1111111111111111111111\.#Table is the DataTable of @G1111111111111111111111, an element Parent\(\) reaches and no Children list holds/);
  // An ancestor reference outside the ancestors is refused like any other malformed index.
  const broken = setup(t);
  writeIndex(broken.store, 'odc', broken.sha256, moduleIndex({ lane: 'odc', sourceSha256: broken.sha256, nodes, ancestors, overrides: { ancestors: [] } }));
  assert.match((await moduleMap({ lane: 'odc', target: broken.file }, { env: broken.env, prepare: async () => ({ ok: true }), read: async () => ({ ok: true, index: { built: false } }) })).error,
    /missing or invalid after the reader built it/);
});

// G11 (FarmaVirtual, 10/10/2026): call 121 handed out as parentKey the MobileWidget "content" placeholder of a container (85%
// of the widgets of the capture after the merge), and call 129 asked for that key with the same capture and hash: "Unresolved
// key ... map the current capture again". The placeholders here are laid out as the O11 reader stores them (ancestors).
test('G11: parentKey is the nearest row (parentSlot names the placeholder between); a placeholder key answers its owner row; an unknown key never blames the capture', async t => {
  const c = setup(t);
  const nodes = [...NODES,
    ['C1111111111111111111111', 'Container', 'Page', 'S1111111111111111111111', 'widget'],
    ['W1111111111111111111111', 'Container', 'MountEditName', 'C1111111111111111111111.#content', 'widget'],
    ['W2222222222222222222222', 'AdvancedHtml', '', 'C1111111111111111111111.#content', 'widget'],
    ['W3333333333333333333333', 'Input', 'EditNameInput', 'W1111111111111111111111.#content', 'widget'],
    ['E1111111111111111111111', 'Expression', '', 'W1111111111111111111111.#Style', 'expression']];
  // A widget's property (CustomProperty, O11 and ODC) is an ancestor too: the parent of its expression, never a placeholder.
  const ancestors = [['C1111111111111111111111.#content', 'MobileWidget', 'content', 'C1111111111111111111111'],
    ['W1111111111111111111111.#content', 'MobileWidget', 'content', 'W1111111111111111111111'],
    ['W1111111111111111111111.#Style', 'CustomProperty', 'Style', 'W1111111111111111111111']];
  writeIndex(c.store, 'o11', c.sha256, moduleIndex({ lane: 'o11', sourceSha256: c.sha256, nodes, ancestors }));
  const ask = input => moduleMap({ lane: 'o11', target: c.file, expectedSourceSha256: c.sha256, ...input }, { env: c.env, read: noReader });
  // 121: the entry names the row it sits in, and the placeholder between by name.
  const named = await ask({ name: 'MountEditName' });
  assert.equal(named.ok, true, named.error);
  assert.deepEqual(named.entries, [{ key: 'W1111111111111111111111', kind: 'Container', name: 'MountEditName', role: 'widget',
    parentKey: 'C1111111111111111111111', parentSlot: 'content', childrenTotal: 0,
    path: 'MobileFlow:MainFlow/MobileScreen:Home/Container:Page/MobileWidget:content/Container:MountEditName' }]);
  // Every parentKey the map hands out is a key the map answers, and its parent lists the entry.
  for (const entry of (await ask({ role: 'widget' })).entries) {
    const owner = await ask({ key: '@' + entry.parentKey });
    assert.equal(owner.ok, true, entry.name + ': ' + owner.error); assert.deepEqual(keys(owner), [entry.parentKey]);
    assert.ok(keys(await ask({ parent: '@' + entry.parentKey })).includes(entry.key), entry.name);
  }
  // A row as parent lists what sits in its placeholders; the placeholder as parent only that slot.
  assert.deepEqual(keys(await ask({ parent: '@C1111111111111111111111' })), ['W1111111111111111111111', 'W2222222222222222222222']);
  assert.deepEqual(keys(await ask({ parent: '@W1111111111111111111111' })), ['W3333333333333333333333']);
  assert.deepEqual(keys(await ask({ parent: '@C1111111111111111111111.#content' })), ['W1111111111111111111111', 'W2222222222222222222222']);
  // 129: the placeholder key (the parentKey of the 22nd release) answers its owner row and says what the key is.
  const slot = await ask({ key: '@C1111111111111111111111.#content' });
  assert.equal(slot.ok, true, slot.error); assert.deepEqual(keys(slot), ['C1111111111111111111111']);
  assert.deepEqual(slot.keyOwner, { key: 'C1111111111111111111111.#content', kind: 'MobileWidget', name: 'content', ownerKey: 'C1111111111111111111111' });
  assert.match(slot.notices.join(' '), /@C1111111111111111111111\.#content is the MobileWidget content of @C1111111111111111111111, an element Parent\(\) reaches and no Children list holds/);
  // A property key answers its widget and is named for what it is (review of G11: 2329 of the 4253 ancestors of the real
  // capture are CustomProperty/ReferenceCustomProperty, 273 MobileWidgetSignature; none of them is a placeholder).
  const style = await ask({ key: '@W1111111111111111111111.#Style' });
  assert.equal(style.ok, true, style.error); assert.deepEqual(keys(style), ['W1111111111111111111111']);
  assert.deepEqual(style.keyOwner, { key: 'W1111111111111111111111.#Style', kind: 'CustomProperty', name: 'Style', ownerKey: 'W1111111111111111111111' });
  assert.match(style.notices.join(' '), /^@W1111111111111111111111\.#Style is the CustomProperty Style of @W1111111111111111111111, an element Parent\(\) reaches/);
  assert.doesNotMatch(style.notices.join(' '), /placeholder/);
  const expression = (await ask({ key: '@E1111111111111111111111' })).entries[0];
  assert.deepEqual([expression.parentKey, expression.parentSlot], ['W1111111111111111111111', 'Style']);
  // An unknown key with the hash of this very capture: KEY_UNRESOLVED, and the text never sends the model to map again.
  for (const input of [{ key: '@Z9' }, { parent: '@Z9' }]) {
    const unknown = await ask(input);
    assert.equal(unknown.ok, false); assert.equal(unknown.code, 'KEY_UNRESOLVED', JSON.stringify(input));
    assert.match(unknown.error, /^Unresolved key in this capture: @Z9\b/);
    assert.match(unknown.error, /the hash given is this capture's/);
    assert.doesNotMatch(unknown.error, /map the current capture again|Keys belong to one capture/);
  }
  const unpinned = await moduleMap({ lane: 'o11', target: c.file, key: '@Z9' }, { env: c.env, read: noReader });
  assert.equal(unpinned.code, 'KEY_UNRESOLVED'); assert.doesNotMatch(unpinned.error, /map the current capture again/);
});

// U6/G12 (FarmaVirtual, 10/10/2026): call 148 asked kind "MobileTheme|MobileFlow|MobileScreen", got 0 entries ("check the
// kind spelling") and three calls followed, one per kind (150-152); and counts.byKind came in every search by name or kind
// (51.6% of the bytes of the 17 searches of the session).
test('U6: kind takes a list (A|B or A,B) and names the kinds it did not find; counts by kind only on the unfiltered listing', async t => {
  const c = setup(t);
  writeIndex(c.store, 'odc', c.sha256);
  const ask = input => moduleMap({ lane: 'odc', target: c.file, ...input }, { env: c.env, read: noReader });
  const list = await ask({ kind: 'MobileFlow|MobileScreen' });
  assert.equal(list.ok, true, list.error);
  assert.deepEqual(keys(list), ['F1111111111111111111111', 'S1111111111111111111111', 'S2222222222222222222222', 'S3333333333333333333333']);
  assert.deepEqual(keys(await ask({ kind: 'MobileFlow, MobileScreen' })), keys(list));
  assert.equal(list.kindObserved, true); assert.deepEqual(list.notices, []); assert.equal(list.kindsNotObserved, undefined);
  const partly = await ask({ kind: 'MobileTheme|MobileFlow' });
  assert.deepEqual(keys(partly), ['F1111111111111111111111']); assert.deepEqual(partly.kindsNotObserved, ['MobileTheme']);
  const none = await ask({ kind: 'MobileTheme|Timer' });
  assert.equal(none.count, 0); assert.equal(none.kindObserved, false); assert.match(none.notices[0], /No instance of the requested kind/);
  assert.deepEqual(none.kindsNotObserved, ['MobileTheme', 'Timer']);
  // The next page keeps the list as given.
  const paged = await ask({ kind: 'MobileFlow|MobileScreen', max: 2 });
  assert.equal(paged.continuations.next.arguments.kind, 'MobileFlow|MobileScreen');
  assert.deepEqual(keys(await ask(paged.continuations.next.arguments)), ['S2222222222222222222222', 'S3333333333333333333333']);
  // counts.byKind: the first page of the unfiltered listing only (detail included or not); a search by name, kind, prefix,
  // role, parent or key keeps the totals and the roles.
  assert.equal((await ask({})).counts.byKind.MobileScreen, 3);
  assert.equal((await ask({ includeDetail: true })).counts.byKind.MobileScreen, 3);
  for (const filter of [{ name: 'Home' }, { kind: 'MobileScreen' }, { kind: 'MobileFlow|MobileScreen' }, { prefix: 'Quo' }, { role: 'screen' },
    { parent: '@F1111111111111111111111' }, { key: '@F1111111111111111111111' }]) {
    const answer = await ask(filter);
    assert.equal(answer.ok, true, answer.error);
    assert.equal(answer.counts.byKind, undefined, JSON.stringify(filter)); assert.equal(answer.counts.byKindOmitted, undefined, JSON.stringify(filter));
    assert.equal(answer.counts.elements, 14); assert.equal(answer.counts.byRole.screen, 3);
  }
  // The search and uses views match one kind: a list there is refused with its words, never an empty answer; a kind that
  // names nothing is refused in every view.
  assert.match((await ask({ view: 'search', text: 'Quote', kind: 'MobileFlow|MobileScreen' })).error, /one kind/);
  assert.match((await ask({ view: 'uses', element: 'Home', kind: 'MobileFlow,MobileScreen' })).error, /one kind/);
  for (const view of ['map', 'search']) assert.match((await ask({ view, text: view === 'search' ? 'Quote' : undefined, kind: '|' })).error, /^kind must name a kind/, view);
  // The usage line says the map takes a list.
  assert.match(MAP_USAGE, /^ssam map \[--lane o11\|odc\] <capture\.oml\|Module> \[--kind K\[,K\.\.\.\]\]/);
});

test('the reader of every lane gets the store root the map reads (module-map indexRoot)', () => {
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: 'relative-store', SSAM_READER_CACHE_ROOT: path.join(os.tmpdir(), 'readers') };
  for (const lane of ['odc', 'o11']) {
    const config = readerConfig(lane, { env, entry: { cli: 'C:\\lane\\anvil.dll', root: 'C:\\kernel', lane: 'ss4' }, ssDir: 'C:\\studio' });
    assert.equal(config.indexRoot, path.resolve('relative-store'), lane);
    assert.equal(indexFile(lane, 'A'.repeat(64), env), path.join(config.indexRoot, 'v1', lane, 'a'.repeat(64) + (lane === 'odc' ? '.builder' : '.kernel') + '.json'), lane);
  }
});

test('pages follow the key order with the next page ready, and the byte budget cuts entries instead of exceeding', async t => {
  const c = setup(t);
  writeIndex(c.store, 'odc', c.sha256);
  const ask = input => moduleMap({ lane: 'odc', target: c.file, ...input }, { env: c.env, read: noReader });
  const first = await ask({ max: 4 });
  assert.equal(first.returned, 4); assert.equal(first.count, 11); assert.equal(first.nextOffset, 4); assert.equal(first.truncated, true);
  assert.equal(first.size.limitedBy, 'max'); assert.ok(first.counts.byKind, 'counts by kind on the first page');
  assert.deepEqual(first.continuations.next.arguments, { lane: 'odc', target: c.file, offset: 4, max: 4, budgetBytes: DEFAULT_MAP_BUDGET(), expectedSourceSha256: c.sha256 });
  assert.equal(first.continuations.next.tool, 'ssam_map'); assert.equal(first.continuations.next.cli, undefined);
  const second = await ask(first.continuations.next.arguments);
  assert.deepEqual(keys(second), keys(await ask({})).slice(4, 8)); assert.equal(second.counts.byKind, undefined); assert.equal(second.counts.byKindOmitted, undefined);
  const filtered = await ask({ role: 'screen', max: 1, prefix: 'Quote Form'.slice(0, 5) });
  assert.deepEqual(filtered.continuations.next.arguments, { lane: 'odc', target: c.file, prefix: 'Quote', role: 'screen', offset: 1, max: 1, budgetBytes: DEFAULT_MAP_BUDGET(), expectedSourceSha256: c.sha256 });
  // A budget below the full page returns fewer entries, never more bytes than asked.
  const full = await ask({ kind: '*', max: 500 });
  const budgetBytes = full.size.bytes - 600;
  const cut = await ask({ kind: '*', max: 500, budgetBytes });
  assert.ok(cut.returned < full.returned && cut.returned > 0, cut.returned + ' of ' + full.returned);
  assert.equal(cut.size.limitedBy, 'budget'); assert.equal(cut.nextOffset, cut.returned);
  assert.ok(Buffer.byteLength(JSON.stringify(cut)) <= budgetBytes, Buffer.byteLength(JSON.stringify(cut)) + ' > ' + budgetBytes);
  assert.match((await ask({ budgetBytes: 1000 })).error, /budgetBytes must be an integer between 2000/);
  const big = setup(t);
  writeIndex(big.store, 'odc', big.sha256, moduleIndex({ lane: 'odc', sourceSha256: big.sha256,
    overrides: { counts: { elements: 14, byKind: Object.fromEntries(Array.from({ length: 400 }, (_, i) => ['Kind' + i, i])), byRole: {} } } }));
  const reduced = await moduleMap({ lane: 'odc', target: big.file, budgetBytes: 4000 }, { env: big.env, read: noReader });
  assert.equal(reduced.ok, true, reduced.error); assert.equal(reduced.counts.byKindOmitted, 'budget');
  assert.ok(Buffer.byteLength(JSON.stringify(reduced)) <= 4000);
});

test('a miss asks the lane reader to ensure the index, then reads the file it wrote (ODC builder, O11 kernel)', async t => {
  for (const lane of ['odc', 'o11']) {
    const c = setup(t);
    const calls = []; let prepared = 0;
    const read = async config => {
      calls.push(config);
      writeIndex(c.store, lane, c.sha256);
      return { ok: true, index: { path: storeFile(c.store, lane, c.sha256), sourceSha256: c.sha256, built: true, counts: { elements: 14 } },
        cache: { modelHit: false, generation: 'g1' } };
    };
    const reader = lane === 'o11' ? { entry: { cli: 'C:\\lane\\anvil.dll', root: 'C:\\kernel', lane: 'ss4' }, ssDir: 'C:\\studio' } : {};
    const map = await moduleMap({ lane, target: c.file, kind: 'ServerAction' }, { env: c.env, read, reader, prepare: async () => { prepared++; return { ok: true }; } });
    assert.equal(map.ok, true, map.error);
    assert.equal(map.cache.index, 'ensured'); assert.equal(map.cache.built, true); assert.equal(map.count, 3);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request, { file: c.file, index: 'ensure', expectedSourceSha256: c.sha256 });
    assert.equal(calls[0].cacheRoot, path.join(c.dir, 'readers'));
    if (lane === 'odc') { assert.equal(calls[0].dll, paths.builder); assert.equal(calls[0].platform, 'odc'); assert.equal(prepared, 1); }
    else {
      assert.deepEqual([calls[0].dll, calls[0].platform, calls[0].runtimeDir], ['C:\\lane\\anvil.dll', 'ss4', 'C:\\studio']);
      assert.equal(prepared, 0, 'the O11 lane has no builder to prepare');
      assert.deepEqual(map.continuations.inspect, { tool: 'o11_inspect', arguments: { oml: c.file, path: '@<key>', expectedSourceSha256: c.sha256 } });
    }
    // The next call is a hit: no reader.
    assert.equal((await moduleMap({ lane, target: c.file }, { env: c.env, read: noReader, reader })).cache.index, 'hit');
  }
});

test('a stale, corrupt or foreign index is never served: it is a miss, and a reader that cannot fix it fails the map', async t => {
  const c = setup(t);
  const other = 'f'.repeat(64);
  const variants = {
    'another capture': moduleIndex({ lane: 'odc', sourceSha256: other }),
    'truncated JSON': '{"schema":"ssam-module-index/1","rows":[',
    'another extractor': moduleIndex({ lane: 'odc', sourceSha256: c.sha256, overrides: { extractor: 2 } }),
    'another schema': moduleIndex({ lane: 'odc', sourceSha256: c.sha256, overrides: { schema: 'ssam-module-index/2' } }),
    'another adapter': moduleIndex({ lane: 'odc', sourceSha256: c.sha256, overrides: { adapter: 'kernel' } }),
    'a row with a parent outside the rows': moduleIndex({ lane: 'odc', sourceSha256: c.sha256, overrides: { rows: [['K', 0, 'x', null, null, 7, 0, null, 0]] } }),
  };
  for (const [why, content] of Object.entries(variants)) {
    writeIndex(c.store, 'odc', c.sha256, content);
    let asked = 0;
    const refused = await moduleMap({ lane: 'odc', target: c.file }, { env: c.env, prepare: async () => ({ ok: true }), read: async () => { asked++; return { ok: true, index: { path: storeFile(c.store, 'odc', c.sha256), built: false } }; } });
    assert.equal(refused.ok, false, why); assert.equal(asked, 1, why);
    assert.match(refused.error, /missing or invalid after the reader built it/, why);
    // The reader rewrites it: served.
    const fixed = await moduleMap({ lane: 'odc', target: c.file }, { env: c.env, prepare: async () => ({ ok: true }), read: async () => { writeIndex(c.store, 'odc', c.sha256); return { ok: true, index: { built: true } }; } });
    assert.equal(fixed.ok, true, why + ': ' + fixed.error); assert.equal(fixed.cache.index, 'ensured');
    fs.rmSync(storeFile(c.store, 'odc', c.sha256));
  }
  // A reader that predates the contract answers a normal read without `index`.
  const old = await moduleMap({ lane: 'odc', target: c.file }, { env: c.env, prepare: async () => ({ ok: true }), read: async () => ({ ok: true, data: { module: 'Quotes' } }) });
  assert.match(old.error, /predate ssam-module-index\/1/);
  // A capture that changed since its keys were chosen is refused before any index or reader, with the reader's words.
  writeIndex(c.store, 'odc', c.sha256);
  const changed = await moduleMap({ lane: 'odc', target: c.file, expectedSourceSha256: other }, { env: c.env, read: noReader });
  assert.equal(changed.ok, false); assert.match(changed.error, /^Snapshot content changed: expectedSourceSha256 does not match/);
  assert.equal((await moduleMap({ lane: 'odc', target: c.file, expectedSourceSha256: c.sha256.toUpperCase() }, { env: c.env, read: noReader })).ok, true);
  // A builder that cannot be prepared refuses the miss with its own message.
  fs.rmSync(storeFile(c.store, 'odc', c.sha256));
  assert.match((await moduleMap({ lane: 'odc', target: c.file }, { env: c.env, read: noReader, prepare: async () => ({ ok: false, error: 'build failed' }) })).error, /build failed/);
});

test('a module name is snapshotted once without warming the index twice, in both lanes', async t => {
  const c = setup(t);
  writeIndex(c.store, 'odc', c.sha256);
  const seen = [];
  const capture = async (args, pid, options) => { seen.push({ args, pid, options }); return { ok: true, path: c.file, sha256: c.sha256.toUpperCase() }; };
  const map = await moduleMap({ lane: 'odc', target: 'Quotes', pid: 7 }, { env: c.env, read: noReader, capture });
  assert.equal(map.ok, true, map.error); assert.equal(map.target, 'Quotes'); assert.equal(map.file, c.file); assert.equal(map.snapshotSha256, c.sha256.toUpperCase());
  assert.deepEqual(seen, [{ args: ['snapshot', 'Quotes'], pid: 7, options: { prefetch: false } }]);
  const refused = await moduleMap({ lane: 'odc', target: 'Quotes' }, { env: c.env, capture: async () => ({ ok: false, error: 'ODC Studio is not running.' }) });
  assert.equal(refused.ok, false); assert.equal(refused.error, 'ODC Studio is not running.');
  // O11: the module open in the selected Service Studio is captured through o11_studio snapshot, never the ODC bridge.
  writeIndex(c.store, 'o11', c.sha256);
  const o11Seen = [];
  const o11 = await moduleMap({ lane: 'o11', target: 'Quotes' }, { env: c.env, read: noReader, capture: async () => { throw new Error('ODC bridge used for O11'); },
    captureO11: async module => { o11Seen.push(module); return { ok: true, path: c.file, sha256: c.sha256.toUpperCase() }; } });
  assert.equal(o11.ok, true, o11.error); assert.equal(o11.file, c.file); assert.deepEqual(o11Seen, ['Quotes']);
  const o11Refused = await moduleMap({ lane: 'o11', target: 'Quotes' }, { env: c.env, captureO11: async () => ({ ok: false, code: 'O11_NOT_CONNECTED', error: 'no bridge' }) });
  assert.equal(o11Refused.ok, false); assert.equal(o11Refused.code, 'O11_NOT_CONNECTED');
  assert.match((await moduleMap({ lane: 'sql', target: c.file }, { env: c.env })).error, /Unknown lane sql/);
  assert.match((await moduleMap({ lane: 'odc', target: path.join(c.dir, 'missing.oml') }, { env: c.env })).error, /ENOENT/);
});

test('CLI arguments of ssam map / odc map', () => {
  assert.deepEqual(parseMapArguments(['q.oml', '--kind', 'MobileScreen', '--prefix', 'Quo', '--role', 'screen', '--parent', '@F1', '--offset', '10', '--max', '5', '--budget', '9000', '--detail', '--lane', 'o11', '--expectedSourceSha256', 'a'.repeat(64)]),
    { target: 'q.oml', kind: 'MobileScreen', prefix: 'Quo', role: 'screen', parent: '@F1', offset: '10', max: '5', budgetBytes: '9000', includeDetail: true, lane: 'o11', expectedSourceSha256: 'a'.repeat(64) });
  assert.deepEqual(parseMapArguments(['--oml', 'q.oml', '--key', '@K', '--pid', '12']), { target: 'q.oml', key: '@K', pid: 12 });
  assert.throws(() => parseMapArguments([]), /ssam map \[--lane o11\|odc\]/);
  assert.throws(() => parseMapArguments(['a.oml', 'b.oml']), /one target/);
  assert.throws(() => parseMapArguments(['a.oml', '--depth', '3']), /Unknown map argument --depth/);
  assert.throws(() => parseMapArguments(['a.oml', '--kind']), /Missing value for --kind/);
  assert.throws(() => parseMapArguments(['a.oml', '--kind', 'A', '--kind', 'B']), /Duplicate --kind/);
});

test('the warm-up spawns a detached helper with its own reader cache root and never waits for it', async t => {
  const c = setup(t);
  const spawned = [];
  const spawnProcess = (exe, args, options) => { const child = { unrefed: false, on() {}, unref() { this.unrefed = true; } }; spawned.push({ exe, args, options, child }); return child; };
  const started = performance.now();
  const result = prefetchIndex(c.file, 'odc', { env: c.env, spawnProcess });
  assert.ok(!(result instanceof Promise), 'synchronous: nothing to await');
  assert.ok(performance.now() - started < 1000);
  assert.equal(result.started, true); assert.equal(result.sha256, c.sha256);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].exe, process.execPath);
  assert.deepEqual(spawned[0].args, [helper, '--prefetch', c.file, '--lane', 'odc']);
  assert.equal(spawned[0].options.detached, true); assert.equal(spawned[0].options.stdio, 'ignore'); assert.equal(spawned[0].child.unrefed, true);
  const own = spawned[0].options.env.SSAM_READER_CACHE_ROOT;
  assert.equal(own, path.join(c.dir, 'readers') + '-prefetch'); assert.equal(own, prefetchCacheRoot('odc', c.env));
  assert.notEqual(own, readerConfig('odc', { env: c.env }).cacheRoot, 'never the reader an agent is reading with');
  assert.equal(spawned[0].options.env.SSAM_MODULE_INDEX_ROOT, c.store);
  // Once per capture and process; nothing when stored, missing, not a capture, or when spawning fails.
  assert.equal(prefetchIndex(c.file, 'odc', { env: c.env, spawnProcess }).reason, 'started');
  const stored = setup(t); writeIndex(stored.store, 'o11', stored.sha256);
  assert.equal(prefetchIndex(stored.file, 'o11', { env: stored.env, spawnProcess }).reason, 'stored');
  assert.equal(prefetchIndex(path.join(c.dir, 'gone.oml'), 'odc', { env: c.env, spawnProcess }).reason, 'missing');
  assert.equal(prefetchIndex(path.join(c.dir, 'job.json'), 'odc', { env: c.env, spawnProcess }).reason, 'not a capture');
  assert.equal(spawned.length, 1);
  const failing = setup(t);
  const failed = prefetchIndex(failing.file, 'o11', { env: failing.env, spawnProcess: () => { throw new Error('spawn EPERM'); } });
  assert.deepEqual(failed, { started: false, error: 'spawn EPERM' });
});

test('the helper ensures through the reader of its own cache root, skips a stored index and never builds the ODC reader', async t => {
  const c = setup(t);
  const env = { ...c.env, SSAM_READER_CACHE_ROOT: prefetchCacheRoot('o11', c.env) };
  const calls = [];
  const read = async config => { calls.push(config); writeIndex(c.store, 'o11', c.sha256); return { ok: true, index: { built: true } }; };
  const done = await prefetchMain({ file: c.file, lane: 'o11' }, { env, read });
  assert.equal(done.ok, true); assert.deepEqual(done.index, { built: true });
  assert.equal(calls[0].cacheRoot, env.SSAM_READER_CACHE_ROOT); assert.equal(calls[0].dll, LANES.o11.cli);
  assert.deepEqual(calls[0].request, { file: c.file, index: 'ensure', expectedSourceSha256: c.sha256 });
  assert.equal((await prefetchMain({ file: c.file, lane: 'o11' }, { env, read: noReader })).skipped, 'stored');
  const stale = setup(t);
  assert.match((await prefetchMain({ file: stale.file, lane: 'odc' }, { env: stale.env, read: noReader, fresh: () => false })).skipped, /never builds/);
  assert.equal(indexFile('odc', stale.sha256, stale.env), storeFile(stale.store, 'odc', stale.sha256));
});
