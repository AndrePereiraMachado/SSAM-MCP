// ssam_map view "flow" over synthetic stored flow files (the C# writer is not needed): served only when schema, extractor,
// lane, adapter and the hash of the bytes read now match; a miss asks the lane's kernel reader ({"flow":"ensure"}, mocked
// here); one action by element (@key, full name or last segment), its text in pages inside the budget with nothing
// dropped, the id table on request; without element the list of the actions; a name that matches several actions or
// none answers the candidates.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleMap, parseMapArguments, flowFile, flowReadingFile } from '../module-map.mjs';
import { FLOW_EXTRACTOR, FLOW_PAGE_SCHEMA, FLOW_INDEX_SCHEMA, FLOW_NOTE, FLOW_READING_SCHEMA, flowPages, findActions, textSha } from '../module-flow.mjs';
import { writeCapture } from './fixtures/module-index.mjs';
import { STORE_GENERATION } from '../store-generation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelSource = path.join(here, '..', '..', '..', '..', 'kernel', 'src', 'Anvil.Core', 'Kernel', 'ModuleFlow.cs');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-module-flow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  return { dir, store, env, ...writeCapture(dir) };
}
const noReader = async () => { throw new Error('the reader must not be called on a hit'); };
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

const actionText = (name, key, lines = 3) => ['server action ' + name + ' @' + key, '  in Id: Long Integer @p1',
  ...Array.from({ length: lines }, (_, i) => '  assign Total = Total + ' + i + ' @n' + (i + 1)), '  end @n' + (lines + 1)].join('\n') + '\n';
// A flow file as ModuleFlow.ToJson writes it.
function flowOf({ lane = 'odc', sourceSha256, large = false }) {
  const action = (name, key, kind = 'ServerAction', lines = 3, extra = {}) => ({ key, kind, name, fixedPoint: true, nodes: lines + 2, digestBytes: 100,
    text: actionText(name.replace(/^.*\//, ''), key, lines), ids: { start: 'S' + key, n1: 'N1' + key }, problems: [], ...extra });
  return { schema: 'ssam-flow/1', extractor: FLOW_EXTRACTOR, lane, adapter: 'kernel', sourceSha256, sourceBytes: 42, createdAt: '2026-10-11T00:00:00Z',
    module: { name: 'Quotes', key: 'R0' }, notWritten: { 'InputParameter.Type (derived from DataType)': 3 },
    actions: [action('GetQuote', 'A1', 'ServerAction', large ? 2000 : 3), action('MainFlow/Home/Search', 'A2', 'ScreenAction'), action('MainFlow/Detail/Search', 'A3', 'ScreenAction'),
      action('Broken', 'A4', 'ServerAction', 1, { fixedPoint: false, problems: ['not printed: something'] })] };
}
function writeFlow(store, lane, sha256, flow = flowOf({ lane, sourceSha256: sha256 })) {
  const file = path.join(store, STORE_GENERATION, lane, sha256 + '.kernel.flow.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof flow === 'string' ? flow : JSON.stringify(flow));
  return file;
}

test('the flow constants are the C# ones and the store sits beside the digest, kernel adapter in both lanes', () => {
  const source = fs.readFileSync(kernelSource, 'utf8');
  assert.equal(Number(source.match(/public const int Extractor = (\d+);/)[1]), FLOW_EXTRACTOR);
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(os.tmpdir(), 'store') };
  for (const lane of ['odc', 'o11'])
    assert.equal(flowFile(lane, 'A'.repeat(64), env), path.join(env.SSAM_MODULE_INDEX_ROOT, STORE_GENERATION, lane, 'a'.repeat(64) + '.kernel.flow.json'));
});

test('one action by its name, its key or its full path, whole, from the store without any reader; the ids only on request', async t => {
  const c = setup(t);
  writeFlow(c.store, 'o11', c.sha256);
  for (const element of ['GetQuote', '@A1', 'A1', 'getquote']) {
    const page = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element }, { env: c.env, read: noReader });
    assert.equal(page.ok, true, page.error);
    assert.equal(page.schema, FLOW_PAGE_SCHEMA); assert.equal(page.answeredBy, 'module-flow'); assert.equal(page.cache.flow, 'hit');
    assert.deepEqual(page.action, { key: 'A1', kind: 'ServerAction', name: 'GetQuote', fixedPoint: true, nodes: 5, bytes: Buffer.byteLength(actionText('GetQuote', 'A1')),
      textSha: textSha(actionText('GetQuote', 'A1')) });
    assert.equal(page.text, actionText('GetQuote', 'A1'));
    assert.equal(page.page, 1); assert.equal(page.pages, 1); assert.equal(page.continuations.next, null);
    assert.deepEqual(page.flow, { actions: 4, fixedPoint: 3, nodes: 5 + 5 + 5 + 3 });
    assert.equal(page.ids, undefined);
    assert.deepEqual(page.continuations.inspect, { tool: 'o11_inspect', arguments: { oml: c.file, path: '@<key>', expectedSourceSha256: c.sha256 } });
    assert.equal(page.size.bytes, bytes(page)); assert.ok(page.size.bytes <= page.size.budgetBytes);
  }
  const detailed = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: 'MainFlow/Home/Search', includeDetail: true }, { env: c.env, read: noReader });
  assert.equal(detailed.action.key, 'A2'); assert.deepEqual(detailed.ids, { start: 'SA2', n1: 'N1A2' });
  // An action that is not a fixed point is still read, with its problems.
  const broken = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: 'Broken' }, { env: c.env, read: noReader });
  assert.equal(broken.action.fixedPoint, false); assert.deepEqual(broken.action.problems, ['not printed: something']);
});

test('a name of several actions or of none answers the candidates and a continuation; the list pages every action', async t => {
  const c = setup(t);
  writeFlow(c.store, 'odc', c.sha256);
  const ambiguous = await moduleMap({ lane: 'odc', target: c.file, view: 'flow', element: 'Search' }, { env: c.env, read: noReader });
  assert.equal(ambiguous.ok, false); assert.equal(ambiguous.code, 'AMBIGUOUS_ELEMENT');
  assert.deepEqual(ambiguous.candidates.map(a => a.name), ['MainFlow/Home/Search', 'MainFlow/Detail/Search']);
  assert.equal(ambiguous.continuation.arguments.element, 'MainFlow/Home/Search');
  const missing = await moduleMap({ lane: 'odc', target: c.file, view: 'flow', element: 'Quote' }, { env: c.env, read: noReader });
  assert.equal(missing.code, 'ELEMENT_NOT_FOUND'); assert.deepEqual(missing.candidates.map(a => a.name), ['GetQuote']);
  const list = await moduleMap({ lane: 'odc', target: c.file, view: 'flow', max: 3 }, { env: c.env, read: noReader });
  assert.equal(list.ok, true, list.error); assert.equal(list.schema, FLOW_INDEX_SCHEMA);
  assert.equal(list.count, 4); assert.equal(list.returned, 3); assert.equal(list.nextOffset, 3);
  assert.deepEqual(list.entries[0], { name: 'GetQuote', kind: 'ServerAction', key: 'A1', bytes: Buffer.byteLength(actionText('GetQuote', 'A1')), fixedPoint: true });
  const rest = await moduleMap(list.continuations.next.arguments, { env: c.env, read: noReader });
  assert.deepEqual(rest.entries.map(e => e.name), ['Broken']); assert.equal(rest.nextOffset, null);
  // The map's own filters and the search words belong to other views.
  for (const extra of [{ kind: 'ServerAction' }, { text: 'x' }, { page: 2 }])
    assert.match((await moduleMap({ lane: 'odc', target: c.file, view: 'flow', ...extra }, { env: c.env, read: noReader })).error, /belong/);
  assert.deepEqual(parseMapArguments(['C:\\c\\Q.oml', '--lane', 'o11', '--flow', '--element', 'GetQuote', '--page', '2']),
    { target: 'C:\\c\\Q.oml', lane: 'o11', view: 'flow', element: 'GetQuote', page: '2' });
});

test('a long action comes in pages inside the budget, nothing dropped, each continuation pinned to the same capture', async t => {
  const c = setup(t);
  const flow = flowOf({ lane: 'o11', sourceSha256: c.sha256, large: true });
  writeFlow(c.store, 'o11', c.sha256, flow);
  const budgetBytes = 9000;
  const first = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: 'GetQuote', budgetBytes }, { env: c.env, read: noReader });
  assert.equal(first.ok, true, first.error);
  assert.ok(first.pages > 5, 'pages ' + first.pages);
  const pages = [first];
  for (let n = 2; n <= first.pages; n++) {
    const next = pages.at(-1).continuations.next;
    assert.deepEqual(next, { tool: 'ssam_map', arguments: { lane: 'o11', target: c.file, view: 'flow', budgetBytes, expectedSourceSha256: c.sha256, element: 'GetQuote', page: n } });
    pages.push(await moduleMap(next.arguments, { env: c.env, read: noReader }));
  }
  for (const p of pages) { assert.equal(p.ok, true, p.error); assert.ok(bytes(p) <= budgetBytes, `page ${p.page}: ${bytes(p)} > ${budgetBytes}`); }
  assert.equal(pages.map(p => p.text).join(''), flow.actions[0].text);
  // A line longer than a page is cut at characters and joins back.
  const long = 'x'.repeat(5000);
  const cut = flowPages('a\n' + long + '\nb\n', 2000);
  assert.ok(cut.length >= 3);
  assert.equal(cut.join('').replace(/ …\(this line continues on page \d+\)\n…\(line continued from page \d+\) /g, ''), 'a\n' + long + '\nb\n');
});

test('flow pages keep every line across a cold-cache first page, warm continuations and detail metadata', async t => {
  const c = setup(t);
  const flow = flowOf({ lane: 'o11', sourceSha256: c.sha256, large: true });
  const first = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: 'GetQuote', budgetBytes: 9000, includeDetail: true }, {
    env: c.env, read: async () => {
      writeFlow(c.store, 'o11', c.sha256, flow);
      return { ok: true, flow: { path: flowFile('o11', c.sha256, c.env), built: true }, cache: { loads: 1, generation: 123456789 } };
    } });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.cache.flow, 'ensured');
  const pages = [first];
  while (pages.at(-1).continuations.next) {
    const next = pages.at(-1).continuations.next.arguments;
    assert.equal(next.includeDetail, true);
    const page = await moduleMap(next, { env: c.env, read: noReader });
    assert.equal(page.ok, true, JSON.stringify(page));
    assert.equal(page.pages, first.pages);
    assert.ok(bytes(page) <= 9000);
    pages.push(page);
  }
  assert.equal(pages.map(p => p.text).join(''), flow.actions[0].text);
});

test('a miss asks the lane kernel reader for {"flow":"ensure"} and serves what it wrote; another capture or version is a miss', async t => {
  const c = setup(t);
  const requests = [];
  const read = async config => {
    requests.push(config.request);
    writeFlow(c.store, 'odc', c.sha256);
    return { ok: true, flow: { path: flowFile('odc', c.sha256, c.env), built: true } };
  };
  const page = await moduleMap({ lane: 'odc', target: c.file, view: 'flow', element: 'GetQuote' }, { env: c.env, read });
  assert.equal(page.ok, true, page.error); assert.equal(page.cache.flow, 'ensured'); assert.equal(page.cache.built, true);
  // S10: the request names the element (a reader of before reads it as {"flow":"ensure"}, as this one does).
  assert.deepEqual(requests, [{ file: c.file, flow: 'ensure', flowElements: ['GetQuote'], expectedSourceSha256: c.sha256 }]);
  // A stored file of another extractor or another capture is never served.
  writeFlow(c.store, 'odc', c.sha256, { ...flowOf({ lane: 'odc', sourceSha256: c.sha256 }), extractor: FLOW_EXTRACTOR + 1 });
  const stale = await moduleMap({ lane: 'odc', target: c.file, view: 'flow', element: 'GetQuote' }, { env: c.env, read: async () => ({ ok: true, flow: { path: 'nowhere', built: true } }) });
  assert.equal(stale.ok, false); assert.match(stale.error, /missing or invalid/);
  assert.deepEqual(findActions(flowOf({ sourceSha256: c.sha256 }), '@A9').matches, []);
});

test('an element written as the header writes a screen action (Owner.Action, Flow/Owner.Action) names that one action', () => {
  const flow = flowOf({ sourceSha256: 'ab' });
  assert.deepEqual(findActions(flow, 'Home.Search').matches.map(a => a.key), ['A2']);
  assert.equal(findActions(flow, 'Home.Search').by, 'owner');
  assert.deepEqual(findActions(flow, 'MainFlow/Detail.Search').matches.map(a => a.key), ['A3']);
  assert.deepEqual(findActions(flow, 'detail.search').matches.map(a => a.key), ['A3']);
  // The last segment alone still names both.
  assert.deepEqual(findActions(flow, 'Search').matches.map(a => a.key), ['A2', 'A3']);
  assert.match(FLOW_NOTE, /action Owner\.Name/);
});

test('textSha is the kernel\'s (16 hex of the sha256 of the text) and the note says how the edited text goes back', () => {
  // ModuleFlow.TextSha("abc") in the kernel tests (FlowApplyTests) pins the same value.
  assert.equal(textSha('abc'), 'ba7816bf8f01cfea');
  assert.match(FLOW_NOTE, /"op":"logic","data":\{"flow":<text>,"basedOn":<textSha>\}/);
});

test('a list of elements reads those actions whole in one answer, in that order, the rest of the budget in continuations', async t => {
  const c = setup(t);
  writeFlow(c.store, 'o11', c.sha256);
  const both = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: ['MainFlow/Home/Search', 'GetQuote'] }, { env: c.env, read: noReader });
  assert.equal(both.ok, true, both.error);
  assert.deepEqual(both.actions.map(a => [a.name, a.textSha, a.text]), [
    ['MainFlow/Home/Search', textSha(actionText('Search', 'A2')), actionText('Search', 'A2')], ['GetQuote', textSha(actionText('GetQuote', 'A1')), actionText('GetQuote', 'A1')]]);
  assert.equal(both.returned, 2); assert.equal(both.continuations.next, null);
  assert.ok(bytes(both) <= both.size.budgetBytes);
  // What does not fit the budget comes next, by name; every miss is answered at once with candidates.
  const big = flowOf({ lane: 'o11', sourceSha256: c.sha256 });
  big.actions[1].text = actionText('Search', 'A2', 60);
  writeFlow(c.store, 'o11', c.sha256, big);
  // The budget of GetQuote alone (and a little more): the long Search does not fit beside it.
  const alone = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: ['GetQuote'] }, { env: c.env, read: noReader });
  const budgetBytes = alone.size.bytes + 600;
  const tight = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: ['GetQuote', 'MainFlow/Home/Search'], budgetBytes }, { env: c.env, read: noReader });
  assert.equal(tight.ok, true, tight.error);
  assert.deepEqual(tight.actions.map(a => a.name), ['GetQuote']);
  assert.deepEqual(tight.continuations.next.arguments.element, ['MainFlow/Home/Search']);
  const misses = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: ['Search', 'Quote', 'GetQuote'] }, { env: c.env, read: noReader });
  assert.equal(misses.ok, false); assert.equal(misses.code, 'ELEMENTS_NOT_FOUND');
  assert.deepEqual(misses.misses.map(m => [m.element, m.code]), [['Search', 'AMBIGUOUS_ELEMENT'], ['Quote', 'ELEMENT_NOT_FOUND']]);
  assert.deepEqual(misses.continuation.arguments.element, ['MainFlow/Home/Search', 'GetQuote', 'GetQuote']);
  // The CLI repeats --element for a list; a list belongs to --flow only, and a page to one element.
  assert.deepEqual(parseMapArguments(['Q.oml', '--flow', '--element', 'A', '--element', 'B']), { target: 'Q.oml', view: 'flow', element: ['A', 'B'] });
  assert.throws(() => parseMapArguments(['Q.oml', '--uses', 'A', '--element', 'B']), /Duplicate --element/);
  assert.match((await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: ['GetQuote'], page: 2 }, { env: c.env, read: noReader })).error, /page belongs to one element/);
});

test('every served action keeps its read beside the flow file, named by its textSha (the base of the three-way merge of an edit of it)', async t => {
  const c = setup(t);
  const flowPath = writeFlow(c.store, 'o11', c.sha256);
  const reading = sha => path.join(path.dirname(flowPath), c.sha256 + '.kernel.flow-' + sha + '.json');
  const page = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: 'GetQuote' }, { env: c.env, read: noReader });
  assert.equal(page.ok, true, page.error);
  assert.equal(flowReadingFile('o11', c.sha256, page.action.textSha, c.env), reading(page.action.textSha));
  const kept = JSON.parse(fs.readFileSync(reading(page.action.textSha), 'utf8'));
  // The C# FlowReading.Parse checks: schema, extractor, lane, adapter, the text of that textSha, the action and its ids.
  assert.deepEqual(kept, { schema: FLOW_READING_SCHEMA, extractor: FLOW_EXTRACTOR, lane: 'o11', adapter: 'kernel', sourceSha256: c.sha256,
    action: { key: 'A1', kind: 'ServerAction', name: 'GetQuote' }, textSha: page.action.textSha, text: page.text, ids: { start: 'SA1', n1: 'N1A1' } });
  assert.equal(textSha(kept.text), kept.textSha);
  // The answer is the same with the read kept (nothing of it goes in the answer).
  const again = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: 'GetQuote' }, { env: c.env, read: noReader });
  assert.equal(again.text, page.text); assert.deepEqual(again.action, page.action);
  // A list keeps the read of every action it serves; an action that is not a fixed point keeps none (it is never written back).
  const both = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: ['MainFlow/Home/Search', 'Broken'] }, { env: c.env, read: noReader });
  assert.equal(both.ok, true, both.error);
  for (const action of both.actions) assert.equal(fs.existsSync(reading(action.textSha)), action.fixedPoint, action.name);
  // The C# side looks for the same file name and schema.
  const store = fs.readFileSync(path.join(here, '..', '..', '..', '..', 'kernel', 'src', 'Anvil.Core', 'Kernel', 'ModuleIndex.cs'), 'utf8');
  assert.match(store, /"\.flow-" \+ textSha\.ToLowerInvariant\(\) \+ "\.json"/);
  assert.match(fs.readFileSync(kernelSource, 'utf8'), new RegExp('Schema = "' + FLOW_READING_SCHEMA + '"'));
});
