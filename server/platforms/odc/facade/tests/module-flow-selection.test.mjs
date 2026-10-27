// S10 (24/10/2026): the selective reading of actions. Without a stored flow, ssam_map view "flow" by element (and
// ssam_code read part logic, and the packet's ownerReadings) asks the reader for those actions only ({"flowElements"}):
// the answer is partial, says what was not built, stores no flow file, keeps the read of each served action (the base of
// the three-way merge) and serves the same text and textSha as the whole reading. An element that names no single action
// among all of the capture's, the list of the actions and a reader of before take the whole reading, exactly as before;
// the views search and uses never read a selection. The C# side (same text from another load, never stored, the merge
// on a selective read) is FlowReadSelectiveScenarios in both test projects.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moduleMap, ownerReadings, flowFile } from '../module-map.mjs';
import { codeRead } from '../ssam-code.mjs';
import { FLOW_EXTRACTOR, FLOW_SELECTION_SCHEMA, findActions, textSha, validFlowSelection, selectionFlow } from '../module-flow.mjs';
import { writeCapture } from './fixtures/module-index.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-flow-selection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  return { dir, store, env, ...writeCapture(dir) };
}

const actionText = (name, key, lines = 3) => ['server action ' + name + ' @' + key, '  in Id: Long Integer @p1',
  ...Array.from({ length: lines }, (_, i) => '  assign Total = Total + ' + i + ' @n' + (i + 1)), '  end @n' + (lines + 1)].join('\n') + '\n';
// The whole flow as ModuleFlow.ToJson writes it.
function flowOf({ lane = 'odc', sourceSha256 }) {
  const action = (name, key, kind = 'ServerAction', extra = {}) => ({ key, kind, name, fixedPoint: true, nodes: 5, digestBytes: 100,
    text: actionText(name.replace(/^.*\//, ''), key), ids: { start: 'S' + key, n1: 'N1' + key }, problems: [], ...extra });
  return { schema: 'ssam-flow/1', extractor: FLOW_EXTRACTOR, lane, adapter: 'kernel', sourceSha256, sourceBytes: 42, createdAt: '2026-10-24T00:00:00Z',
    module: { name: 'Quotes', key: 'R0' }, notWritten: { 'InputParameter.Type (derived from DataType)': 3 },
    actions: [action('GetQuote', 'A1'), action('MainFlow/Home/Search', 'A2', 'ScreenAction'), action('MainFlow/Detail/Search', 'A3', 'ScreenAction'),
      action('Broken', 'A4', 'ServerAction', { fixedPoint: false, problems: ['not printed: something'] }), action('SaveQuote', 'A5')] };
}
// ModuleFlow.BuildSelected over that flow: the actions a selector may name (ModuleFlow.MayName: key, or a name that ends
// with the selector or its Owner/Action form, without case), digestBytes 0, the catalog of all of them.
function selectionOf(flow, elements) {
  const may = (a, s) => {
    const text = s.trim(); if (a.key === text.replace(/^@/, '')) return true; if (text.startsWith('@')) return false;
    const dot = text.lastIndexOf('.'); const tails = ['/' + text, ...(dot > 0 && !text.startsWith('(') ? ['/' + text.slice(0, dot) + '/' + text.slice(dot + 1)] : [])];
    return tails.some(t => ('/' + a.name).toLowerCase().endsWith(t.toLowerCase()));
  };
  const built = flow.actions.filter(a => elements.some(e => may(a, e))).map(a => ({ ...a, digestBytes: 0 }));
  return { ...flow, schema: FLOW_SELECTION_SCHEMA, partial: true, actions: built, notWritten: {},
    scope: { completeModule: false, availableActions: flow.actions.length, builtActions: built.length, notBuilt: { actions: flow.actions.length - built.length }, requested: elements },
    catalog: flow.actions.map(a => ({ key: a.key, kind: a.kind, name: a.name })) };
}
// A reader of now: a selection for {"flowElements"}, the whole flow written for {"flow":"ensure"} alone.
function reader(c, lane, requests, flow = flowOf({ lane, sourceSha256: c.sha256 })) {
  return async config => {
    requests.push(config.request);
    if (config.request.flowElements) return { ok: true, flowSelection: selectionOf(flow, config.request.flowElements), cache: { loads: 1, queryHit: false } };
    const file = flowFile(lane, c.sha256, c.env);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(flow));
    return { ok: true, flow: { path: file, built: true } };
  };
}
const readingFile = (c, lane, sha) => path.join(path.dirname(flowFile(lane, c.sha256, c.env)), c.sha256 + '.kernel.flow-' + sha + '.json');
// The same answer as the whole reading gives (the store written first), for comparison.
async function wholeAnswer(t, lane, input) {
  const c = setup(t);
  const file = flowFile(lane, c.sha256, c.env);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(flowOf({ lane, sourceSha256: c.sha256 })));
  const answer = await moduleMap({ ...input, lane, target: c.file }, { env: c.env, read: async () => { throw new Error('the stored flow serves'); } });
  return { c, answer };
}

test('one action without a stored flow is read alone: partial, what was not built said, no flow file, its read kept, the text and textSha of the whole reading', async t => {
  for (const lane of ['o11', 'odc']) {
    const c = setup(t); const requests = [];
    const page = await moduleMap({ lane, target: c.file, view: 'flow', element: 'GetQuote' }, { env: c.env, read: reader(c, lane, requests) });
    assert.equal(page.ok, true, page.error);
    assert.deepEqual(requests, [{ file: c.file, flow: 'ensure', flowElements: ['GetQuote'], expectedSourceSha256: c.sha256 }]);
    assert.equal(page.partial, true); assert.equal(page.cache.flow, 'selected'); assert.equal(page.cache.built, false);
    assert.equal(page.store.file, null);
    assert.deepEqual(page.flow, { actions: 5, fixedPoint: null, nodes: null });
    assert.deepEqual(page.built, { actions: 1, fixedPoint: 1, nodes: 5 });
    assert.equal(page.notBuilt.actions, 4); assert.match(page.notBuilt.note, /not built/);
    assert.equal(fs.existsSync(flowFile(lane, c.sha256, c.env)), false, 'a selection is never stored as the module flow');
    const whole = flowOf({ lane, sourceSha256: c.sha256 }).actions[0];
    assert.equal(page.text, whole.text); assert.equal(page.action.textSha, textSha(whole.text));
    // The base of the three-way merge is kept, as for a read of the whole flow (the folder is created when missing).
    const kept = JSON.parse(fs.readFileSync(readingFile(c, lane, page.action.textSha), 'utf8'));
    assert.equal(kept.text, whole.text); assert.deepEqual(kept.ids, whole.ids); assert.equal(kept.textSha, page.action.textSha);
    // The same answer the whole reading gives, but for what says partial.
    const { answer: full } = await wholeAnswer(t, lane, { view: 'flow', element: 'GetQuote' });
    for (const key of ['action', 'text', 'page', 'pages', 'module']) assert.deepEqual(page[key], full[key], key);
    assert.equal(full.partial, undefined); assert.equal(full.flow.actions, 5); assert.equal(full.flow.fixedPoint, 4);
    // Once the whole flow is stored, it serves (no reader call).
    await moduleMap({ lane, target: c.file, view: 'flow' }, { env: c.env, read: reader(c, lane, requests) });
    const hit = await moduleMap({ lane, target: c.file, view: 'flow', element: 'GetQuote' }, { env: c.env, read: async () => { throw new Error('no reader on a hit'); } });
    assert.equal(hit.cache.flow, 'hit'); assert.equal(hit.partial, undefined); assert.equal(hit.text, page.text);
  }
});

test('a list of actions is read alone too, each with the textSha of the whole reading; ssam_code read part logic takes the same way', async t => {
  const c = setup(t); const requests = [];
  const deps = { env: c.env, read: reader(c, 'o11', requests) };
  const list = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: ['SaveQuote', 'Home.Search'] }, deps);
  assert.equal(list.ok, true, list.error);
  assert.equal(list.partial, true); assert.equal(list.notBuilt.actions, 3);
  assert.deepEqual(list.actions.map(a => a.name), ['SaveQuote', 'MainFlow/Home/Search']);
  const whole = flowOf({ lane: 'o11', sourceSha256: c.sha256 });
  for (const a of list.actions) {
    assert.equal(a.textSha, textSha(whole.actions.find(w => w.key === a.key).text));
    assert.ok(fs.existsSync(readingFile(c, 'o11', a.textSha)));
  }
  const code = await codeRead({ lane: 'o11', action: 'read', part: 'logic', target: c.file, element: 'SaveQuote' }, { map: input => moduleMap(input, deps) });
  assert.equal(code.ok, true, code.error); assert.equal(code.partial, true);
  assert.equal(code.continuations.edit.arguments.basedOn, textSha(whole.actions[4].text));
  assert.ok(requests.every(r => Array.isArray(r.flowElements)), 'only selective requests');
  assert.equal(fs.existsSync(flowFile('o11', c.sha256, c.env)), false);
});

test('an element that names no single action among all of the capture\'s takes the whole reading and answers exactly as before', async t => {
  for (const element of ['Search', 'Nope', ['GetQuote', 'Search']]) {
    const c = setup(t); const requests = [];
    const answer = await moduleMap({ lane: 'odc', target: c.file, view: 'flow', element }, { env: c.env, read: reader(c, 'odc', requests) });
    assert.deepEqual(requests.map(r => Boolean(r.flowElements)), [true, false], JSON.stringify(element));
    const { answer: full } = await wholeAnswer(t, 'odc', { view: 'flow', element });
    assert.equal(answer.ok, false);
    for (const key of ['code', 'error', 'candidates', 'misses']) assert.deepEqual(answer[key], full[key], key);
    assert.ok(fs.existsSync(flowFile('odc', c.sha256, c.env)), 'the whole flow was built and stored');
  }
  // The list of the actions is never selective.
  const c = setup(t); const requests = [];
  const listed = await moduleMap({ lane: 'odc', target: c.file, view: 'flow' }, { env: c.env, read: reader(c, 'odc', requests) });
  assert.equal(listed.ok, true, listed.error); assert.equal(listed.count, 5); assert.equal(listed.partial, undefined);
  assert.deepEqual(requests, [{ file: c.file, flow: 'ensure', expectedSourceSha256: c.sha256 }]);
});

test('a reader of before answers the whole flow to a selective request; a selection of another capture or request is refused', async t => {
  const c = setup(t); const requests = [];
  const before = async config => {
    requests.push(config.request);
    const file = flowFile('o11', c.sha256, c.env);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(flowOf({ lane: 'o11', sourceSha256: c.sha256 })));
    return { ok: true, flow: { path: file, built: true } };
  };
  const page = await moduleMap({ lane: 'o11', target: c.file, view: 'flow', element: 'GetQuote' }, { env: c.env, read: before });
  assert.equal(page.ok, true, page.error); assert.equal(page.cache.flow, 'ensured'); assert.equal(page.partial, undefined);
  assert.equal(requests.length, 1);
  const d = setup(t);
  const other = async config => ({ ok: true, flowSelection: { ...selectionOf(flowOf({ lane: 'o11', sourceSha256: d.sha256 }), config.request.flowElements), sourceSha256: 'f'.repeat(64) } });
  const refused = await moduleMap({ lane: 'o11', target: d.file, view: 'flow', element: 'GetQuote' }, { env: d.env, read: other });
  assert.equal(refused.ok, false); assert.match(refused.error, /does not match this capture and request/);
  // The checks themselves.
  const flow = flowOf({ lane: 'o11', sourceSha256: d.sha256 });
  const good = selectionOf(flow, ['GetQuote']);
  assert.equal(validFlowSelection(good, 'o11', d.sha256, ['GetQuote']), true);
  assert.equal(validFlowSelection(good, 'o11', d.sha256, ['SaveQuote']), false);
  assert.equal(validFlowSelection({ ...good, partial: false }, 'o11', d.sha256, ['GetQuote']), false);
  assert.equal(validFlowSelection({ ...good, schema: 'ssam-flow/1' }, 'o11', d.sha256, ['GetQuote']), false);
  assert.equal(validFlowSelection({ ...good, catalog: good.catalog.slice(1) }, 'o11', d.sha256, ['GetQuote']), false);
  assert.equal(selectionFlow(selectionOf(flow, ['Search']), ['Search']), null, 'two actions: ambiguous among all of them');
  // The element resolves among ALL the actions (the catalog): an action the reader did not build is never served in its place.
  const home = selectionOf(flow, ['Home.Search']);
  assert.deepEqual(home.actions.map(a => a.key), ['A2']);
  assert.equal(selectionFlow(home, ['Home.Search']), home);
  assert.equal(selectionFlow({ ...home, actions: [] }, ['Home.Search']), null);
  assert.equal(selectionFlow(home, ['GetQuote']), null, 'GetQuote names one action, but it was not built');
  assert.deepEqual(findActions({ actions: good.catalog }, 'detail.search').matches.map(a => a.key), ['A3']);
});

test('ownerReadings reads the owners alone without a stored flow and a contract without its body; search and uses never read a selection', async t => {
  const c = setup(t); const requests = [];
  const read = async config => {
    requests.push(config.request);
    if (config.request.signatureElements) return { ok: true, flowSignatures: { schema: 'ssam-action-signatures/1', sourceSha256: c.sha256, partial: true, complete: true,
      scope: { completeModule: false, bodiesRead: false, availableActions: 5 },
      actions: [{ key: 'A5', kind: 'ServerAction', name: 'SaveQuote', owner: '', contractSha256: 'c'.repeat(64), inputs: [{ key: 'P1', name: 'Id', type: 'Long Integer', mandatory: true, default: null }], outputs: [], problems: [] }] } };
    return reader(c, 'odc', [])(config);
  };
  const owned = await ownerReadings({ lane: 'odc', file: c.file, sourceSha256: c.sha256,
    targets: [{ kind: 'flow', name: 'GetQuote', key: 'A1' }, { kind: 'signature', name: 'SaveQuote' }] }, { env: c.env, read });
  assert.equal(owned.ok, true, JSON.stringify(owned.errors)); assert.deepEqual(owned.errors, []);
  assert.deepEqual(requests.map(r => r.flowElements ?? r.signatureElements), [['@A1'], ['SaveQuote']]);
  const flow = owned.readings.find(r => r.kind === 'flow');
  assert.equal(flow.textSha, textSha(flowOf({ lane: 'odc', sourceSha256: c.sha256 }).actions[0].text));
  assert.ok(fs.existsSync(readingFile(c, 'odc', flow.textSha)), 'the merge base is kept');
  assert.equal(fs.existsSync(flowFile('odc', c.sha256, c.env)), false);
  const contract = owned.readings.find(r => r.kind === 'signature');
  assert.deepEqual(contract, { kind: 'signature', name: 'SaveQuote', key: 'A5', actionKind: 'ServerAction', contractSha256: 'c'.repeat(64),
    inputs: [{ key: 'P1', name: 'Id', type: 'Long Integer', mandatory: true, default: null }], outputs: [] });
  // A reader that answers no contracts: an error of that target, never a throw.
  const old = await ownerReadings({ lane: 'odc', file: c.file, sourceSha256: c.sha256, targets: [{ kind: 'signature', name: 'SaveQuote' }] },
    { env: c.env, read: async () => ({ ok: true, data: {} }) });
  assert.equal(old.ok, true); assert.match(old.errors[0].error, /ssam-action-signatures/);
  // search and uses ask for the rich index, never a selection or a contract.
  for (const input of [{ view: 'search', text: 'Quote' }, { view: 'uses', element: 'GetQuote' }]) {
    const seen = [];
    await moduleMap({ lane: 'odc', target: c.file, ...input }, { env: c.env, read: async config => { seen.push(config.request); throw new Error('stop after the request'); } });
    assert.ok(seen.length >= 1, input.view);
    assert.ok(seen.every(r => r.flowElements == null && r.signatureElements == null && r.flow == null), JSON.stringify(seen));
    assert.ok(seen.some(r => r.rich === 'ensure'), JSON.stringify(seen));
  }
});
