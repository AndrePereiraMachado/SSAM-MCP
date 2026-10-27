// ssam_map view "html" (ssam-html/1, C1 of the plan "Texto do SSAM") over a mocked kernel reader: the request it sends,
// the list of screens and blocks, one screen in pages of whole lines that never exceed the budget and join back to the
// text the reader wrote, every continuation pinned to the same capture, the keys inline only on request, and the
// arguments that belong to other views refused with their own words.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAnswer, answerEnvelope, ANSWER_BUDGETS } from '../answer-size.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleMap, mapRefusal, parseMapArguments, htmlPages, HTML_SCHEMA, VIEWS } from '../module-map.mjs';
import { writeCapture } from './fixtures/module-index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelSource = path.join(here, '..', '..', '..', '..', 'kernel', 'src', 'Anvil.Core', 'Kernel', 'ScreenHtml.cs');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-module-html-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(dir, 'store'), SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  return { dir, env, ...writeCapture(dir, 'capture ' + Math.random()) };
}

// A screen as the kernel writes it: one element per line, attributes with quotes (JSON doubles their bytes).
const screenText = lines => ['<screen name="Orders" actions="Refresh">',
  ...Array.from({ length: lines }, (_, i) => ' <div k="w' + (i + 1) + '" class="row r' + i + '" onclick="Open(Id = ' + i + ')">{{ "Row " + ' + i + ' }}</div>'),
  '</screen>', ''].join('\n');
const roots = [{ name: 'Orders', kind: 'MobileScreen', key: 'S1' }, { name: 'Card', kind: 'MobileBlock', key: 'B1' }];

function reader(text = screenText(3)) {
  const requests = [];
  const read = async ({ request }) => {
    requests.push(request);
    if (request.html === '') return { ok: true, html: { schema: HTML_SCHEMA, model: 'Shop', roots } };
    if (request.html !== 'Orders') throw new Error("No screen or block named '" + request.html + "'. MobileScreen:Orders @S1; MobileBlock:Card @B1");
    return { ok: true, timings: { readMs: 3.2 }, html: { schema: HTML_SCHEMA, model: 'Shop', root: 'Orders', rootKey: 'S1', rootKind: 'MobileScreen',
      htmlSha256: 'h'.repeat(64), bytes: Buffer.byteLength(text), widgets: 3, opaqueWidgets: 0, elements: 3, html: text,
      keys: { '': 'S1', w1: 'K1', w2: 'K2' }, keysFile: 'C:\\store\\v1\\odc\\x.kernel.html-h.json' } };
  };
  return { read, requests };
}
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('the schema is the kernel\'s and html is a view of ssam_map', () => {
  const source = fs.readFileSync(kernelSource, 'utf8');
  assert.equal(source.match(/public const string Schema = "([^"]+)";/)[1], HTML_SCHEMA);
  assert.ok(VIEWS.includes('html'));
});

test('transport keeps pinned HTML edit and pagination routes for both lanes', async t => {
  for (const lane of ['o11', 'odc']) {
    const c = setup(t); const r = reader(screenText(120));
    const args = { lane, target:c.file, view:'html', screen:'Orders', budgetBytes:6000 };
    const full = await moduleMap(args, {env:c.env, read:r.read});
    full.note += ' repeated guidance'.repeat(200);
    const answer = fitAnswer('ssam_map', args, full, {root:path.dirname(c.file)});
    assert.deepEqual(answer.continuations.edit, full.continuations.edit);
    assert.deepEqual(answer.continuations.next, full.continuations.next);
    assert.equal(answer.html, full.html);
    assert.deepEqual(answer.basedOn, full.basedOn);
    assert.ok(bytes(answerEnvelope(answer)) <= ANSWER_BUDGETS.read);
    assert.ok(answer.omitted, 'optional metadata has an evidence continuation');
  }
});

test('without screen: the screens and blocks of the capture, with the continuation that reads one', async t => {
  const c = setup(t); const r = reader();
  const answer = await moduleMap({ lane: 'odc', target: c.file, view: 'html' }, { env: c.env, read: r.read });
  assert.equal(answer.ok, true, answer.error);
  assert.deepEqual(r.requests, [{ file: c.file, html: '', keys: false, expectedSourceSha256: c.sha256 }]);
  assert.deepEqual(answer.roots, roots); assert.equal(answer.count, 2); assert.equal(answer.module, 'Shop');
  assert.deepEqual(answer.continuations.screen, { tool: 'ssam_map', arguments: { lane: 'odc', target: c.file, view: 'html', expectedSourceSha256: c.sha256, screen: '<name>' } });
});

test('one screen fits one page: the text as the kernel wrote it, its keys file and basedOn', async t => {
  const c = setup(t); const r = reader();
  const answer = await moduleMap({ lane: 'o11', target: c.file, view: 'html', screen: 'Orders' }, { env: c.env, read: r.read });
  assert.equal(answer.ok, true, answer.error);
  assert.equal(r.requests[0].html, 'Orders');
  assert.equal(answer.html, screenText(3));
  assert.equal(answer.page, 1); assert.equal(answer.pages, 1); assert.deepEqual(answer.lines, { from: 1, to: 5, total: 5 });
  assert.deepEqual(answer.basedOn, { capture: c.sha256, html: 'h'.repeat(64) });
  assert.equal(answer.keysFile, 'C:\\store\\v1\\odc\\x.kernel.html-h.json');
  assert.equal(answer.keys, undefined, 'the keys are inline only on request');
  assert.deepEqual(answer.continuations.keys.arguments, { lane: 'o11', target: c.file, view: 'html', expectedSourceSha256: c.sha256, screen: 'Orders', keys: true });
  assert.deepEqual(answer.continuations.inspect, { tool: 'o11_inspect', arguments: { oml: c.file, path: '@<key>', expectedSourceSha256: c.sha256 } });
  assert.equal(answer.continuations.next, null);
  // C2: the delivery of an edit of this reading, pinned to it (the html op in its edit form).
  assert.deepEqual(answer.continuations.edit, { tool: 'o11_deliver', arguments: { module: 'Shop', job: { ops: [{ op: 'html', data: { screen: 'Orders',
    basedOn: { capture: c.sha256, html: 'h'.repeat(64) }, edits: [{ set: '<k>', attributes: { '<attribute>': '<value>' } }, { find: '<exact text>', with: '<new text>' }] } }] } } });
  assert.match(answer.note, /only the elements you changed, each whole with its k/);
  assert.equal(answer.timings.kernelReadMs, 3.2);
  assert.equal(answer.size.bytes, bytes(answer));
  const withKeys = await moduleMap({ lane: 'o11', target: c.file, view: 'html', screen: 'Orders', keys: true }, { env: c.env, read: r.read });
  assert.deepEqual(withKeys.keys, { '': 'S1', w1: 'K1', w2: 'K2' }); assert.equal(withKeys.continuations.keys, null);
  assert.equal(r.requests[1].keys, true);
});

test('a long screen: pages of whole lines inside the budget that join back to the whole text', async t => {
  const c = setup(t); const text = screenText(400); const r = reader(text);
  const budgetBytes = 6000;
  const first = await moduleMap({ lane: 'odc', target: c.file, view: 'html', screen: 'Orders', budgetBytes }, { env: c.env, read: r.read });
  assert.equal(first.ok, true, first.error);
  assert.ok(first.pages > 5, 'pages ' + first.pages);
  const pages = [first];
  while (pages.at(-1).continuations.next) {
    const next = pages.at(-1).continuations.next;
    assert.deepEqual(next.arguments, { lane: 'odc', target: c.file, view: 'html', expectedSourceSha256: c.sha256, screen: 'Orders', page: pages.length + 1 });
    pages.push(await moduleMap({ ...next.arguments, budgetBytes }, { env: c.env, read: r.read }));
  }
  assert.equal(pages.length, first.pages);
  for (const p of pages) {
    assert.equal(p.ok, true, p.error);
    assert.ok(bytes(p) <= budgetBytes, `page ${p.page}: ${bytes(p)} > ${budgetBytes}`);
    assert.equal(p.size.bytes, bytes(p));
  }
  assert.equal(pages.map(p => p.html).join(''), text);
  assert.equal(pages.at(-1).lines.to, pages.at(-1).lines.total);
  const beyond = await moduleMap({ lane: 'odc', target: c.file, view: 'html', screen: 'Orders', budgetBytes, page: first.pages + 1 }, { env: c.env, read: r.read });
  assert.match(beyond.error, new RegExp('page ' + (first.pages + 1) + ' does not exist: this screen has ' + first.pages + ' page'));
});

test('htmlPages: lines measured as JSON, a line longer than the budget alone on its page', () => {
  const long = '<p k="w1">' + 'x'.repeat(3000) + '</p>';
  const { lines, pages } = htmlPages(['<screen name="A">', long, '<i k="w2"/>', '</screen>', ''].join('\n'), 1000);
  assert.equal(lines.length, 4);
  assert.deepEqual(pages, [[0, 1], [1, 2], [2, 4]]);
  // Quotes count twice: 100 lines of 10 quotes each do not fit where their raw bytes would.
  const quoted = Array.from({ length: 100 }, () => '""""""""""').join('\n');
  assert.equal(htmlPages(quoted, 1200).pages.length, 2);
});

test('an unknown screen answers the kernel\'s refusal with the screens that exist', async t => {
  const c = setup(t); const r = reader();
  const answer = await moduleMap({ lane: 'odc', target: c.file, view: 'html', screen: 'Ordres' }, { env: c.env, read: r.read });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /No screen or block named 'Ordres'\. MobileScreen:Orders @S1/);
  // Goal list of 2026-10-20, item 2: its own code, the candidates the kernel lists and the call that lists every screen (never the
  // generic SSAM_MAP_FAILED of refusal-codes.mjs toolCode).
  assert.equal(answer.code, 'ELEMENT_NOT_FOUND');
  assert.equal(answer.screen, 'Ordres');
  assert.deepEqual(answer.candidates, [{ kind: 'MobileScreen', name: 'Orders', key: '@S1' }, { kind: 'MobileBlock', name: 'Card', key: '@B1' }]);
  assert.deepEqual(answer.continuation.arguments, { lane: 'odc', target: c.file, view: 'html' });
});

test('the other errors the map knows carry their own code; an unknown one carries none', async t => {
  const c = setup(t); const r = reader();
  const ask = input => moduleMap({ lane: 'odc', target: c.file, ...input }, { env: c.env, read: r.read });
  assert.equal((await ask({ view: 'map', screen: 'Orders' })).code, 'INPUT_INVALID');
  assert.equal((await ask({ view: 'html', screen: 'Orders', page: 99 })).code, 'PAGE_NOT_FOUND');
  assert.equal((await ask({ view: 'html', screen: 'Orders', expectedSourceSha256: 'f'.repeat(64) })).code, 'CAPTURE_CHANGED');
  const ambiguous = mapRefusal(new Error("Ambiguous screen or block 'Card'. MobileBlock:Card @B1; WebBlock:Card @B2"), { lane: 'odc', target: c.file, view: 'html' });
  assert.equal(ambiguous.code, 'AMBIGUOUS_ELEMENT');
  assert.equal(ambiguous.continuation.arguments.screen, '<Kind:Name or @key of one candidate>');
  assert.equal(mapRefusal(new Error('The odc reader answered without ssam-html/1: its binaries predate it; rebuild the reader'), { lane: 'odc', view: 'html' }).code, 'READER_UNAVAILABLE');
  assert.deepEqual(mapRefusal(new Error('something else'), { lane: 'odc', view: 'html' }), { error: 'something else' });
  assert.equal(mapRefusal(new Error(''), { lane: 'odc' }).error, 'Error', 'an empty message never answers an empty error');
  const carried = mapRefusal(Object.assign(new Error('refused'), { refusal: { code: 'MODULE_NOT_OPEN', openModules: [] } }), { lane: 'odc' });
  assert.deepEqual(carried, { code: 'MODULE_NOT_OPEN', openModules: [], error: 'refused' });
});

test('arguments of other views are refused with their own words, and the CLI names the view', async t => {
  const c = setup(t); const r = reader();
  const ask = input => moduleMap({ lane: 'odc', target: c.file, ...input }, { env: c.env, read: r.read });
  assert.match((await ask({ view: 'map', screen: 'Orders' })).error, /screen and keys belong to view "html"/);
  assert.match((await ask({ view: 'digest', keys: true })).error, /screen and keys belong to view "html"/);
  assert.match((await ask({ view: 'html', screen: 'Orders', kind: 'Container' })).error, /kind belong to view "map"/);
  assert.match((await ask({ view: 'html', page: 2 })).error, /page needs screen/);
  assert.equal(r.requests.length, 0, 'nothing reached the reader');
  assert.deepEqual(parseMapArguments(['q.oml', '--html', '--screen', 'Orders', '--page', '2', '--keys', '--lane', 'o11']),
    { target: 'q.oml', view: 'html', screen: 'Orders', page: '2', keys: true, lane: 'o11' });
  assert.deepEqual(parseMapArguments(['q.oml', '--html']), { target: 'q.oml', view: 'html' });
});
