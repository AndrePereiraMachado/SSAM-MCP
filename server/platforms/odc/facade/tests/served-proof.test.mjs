// F1 "the receipt tells the truth" (2026-10-22): the served proof of the stylesheets a delivery changed, read back from the
// environment after the publication, its wiring into o11_deliver {publish:true} and the ODC publication whose server
// revision is the one the delivery started from. Fake fetches and temporary folders only; synthetic names.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { elementsOfKernel, normalizeCss, cssDelta, judgeServed, servedUrls, environmentOrigin, localServedReader, readServed, proveServed, servedBaseline, levelsOf,
  servedRefusal, pageStyles, jobWritesStyleSheets } from '../served-proof.mjs';
import { publishOutcomeOf, publishedRevisionProof, staleRevisionNext, dumpDifferences } from '../kernel-delivery.mjs';
import { ORIGIN, BASE, DELIVERED, SERVED_NEW, SERVED_OLD, KERNEL, BLOCK_URL, fakeFetch, serve, setup, cssJob } from './fixtures/served-proof-fixtures.mjs';

const block = elementsOfKernel(KERNEL)[0];

test('the normal form, the delta and the verdict of an element\'s own file', () => {
  assert.equal(normalizeCss(DELIVERED), normalizeCss(SERVED_NEW));
  assert.deepEqual([...cssDelta(BASE, DELIVERED).values()], [1, 1], 'two rules added');
  assert.equal(judgeServed({ base: BASE, delivered: DELIVERED, served: SERVED_NEW, kind: 'own' }).served, true);
  const stale = judgeServed({ base: BASE, delivered: DELIVERED, served: SERVED_OLD, kind: 'own' });
  assert.equal(stale.served, false); assert.match(stale.firstMissing, /max-width:600px|title>span/);
  assert.equal(judgeServed({ base: BASE, delivered: DELIVERED, served: '.other{a:b}', kind: 'own' }).served, 'unverified', 'neither base nor delivered: never stale');
  assert.equal(judgeServed({ base: BASE, delivered: BASE, served: SERVED_OLD, kind: 'own' }).reason, 'SERVED_NOTHING_TO_COMPARE');
});

test('elements come from the kernel report; URLs, origin and page styles', () => {
  assert.deepEqual([block.target, block.flow, block.flavor, block.touch.key], ['IWebBlock:AccountMenu', 'Common', 'traditional', 'w2']);
  assert.deepEqual(servedUrls(block, { origin: ORIGIN, module: 'SalesPortal' }), [{ url: BLOCK_URL, kind: 'own' }]);
  assert.deepEqual(servedUrls({ ...block, flow: null }, { origin: ORIGIN, module: 'SalesPortal' }), []);
  assert.equal(servedUrls({ ...block, kind: 'screen', name: 'Orders' }, { origin: ORIGIN, module: 'SalesPortal' })[0].kind, 'page');
  assert.equal(servedUrls({ ...block, flavor: 'reactive' }, { origin: ORIGIN, module: 'Shop', theme: 'ShopTheme' })[0].url, ORIGIN + '/Shop/css/Shop.ShopTheme.extra.css');
  assert.equal(environmentOrigin('env-a.example.test'), ORIGIN);
  for (const bad of ['http://env-a.example.test', 'https://user:pw@env-a.example.test', 'https://env-a.example.test/App', '', null]) assert.equal(environmentOrigin(bad), null, String(bad));
  assert.deepEqual(pageStyles('<link rel="stylesheet" href="/SalesPortal/Theme.T.css?7"><link rel=stylesheet href="https://elsewhere.test/x.css"><style>.p{q:r}</style>', ORIGIN + '/SalesPortal/Orders.aspx', ORIGIN),
    { links: [ORIGIN + '/SalesPortal/Theme.T.css?7'], inline: ['.p{q:r}'] });
  assert.equal(jobWritesStyleSheets({ ops: [{ op: 'set', target: '@k', prop: 'StyleSheet', value: '' }] }), true);
  assert.equal(jobWritesStyleSheets({ ops: [{ op: 'set', target: '@k', prop: 'Label', value: '' }] }), false);
  // T18: the keyed css op writes a stylesheet through the same kernel path (its read-back is in apply.styleSheets).
  assert.equal(jobWritesStyleSheets({ ops: [{ op: 'css', target: 'IWebBlock:AccountMenu', basedOn: '0'.repeat(64), edits: [{ append: '.a{b:c}' }] }] }), true);
  assert.equal(localServedReader({ env: { SSAM_SERVED_READ: 'off' }, fetchImpl: async () => null }), null);
});

test('positive and negative proofs; the request carries no credential and revalidates every cache', async () => {
  const good = fakeFetch({ [BLOCK_URL]: { body: SERVED_NEW } });
  const proof = await proveServed([block], { environment: 'env-a.example.test', module: 'SalesPortal', reader: good });
  assert.equal(proof.served, true); assert.equal(proof.elements[0].compared, 'own');
  const [call] = good.calls;
  assert.equal(call.init.redirect, 'manual'); assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.cache, 'no-store');
  assert.equal(call.init.headers['cache-control'], 'no-cache'); assert.equal(call.init.headers.pragma, 'no-cache');
  assert.ok(!('cookie' in call.init.headers) && !('authorization' in call.init.headers));
  const stale = await proveServed([block], { environment: 'env-a.example.test', module: 'SalesPortal', nonce: 'task1', reader: fakeFetch(url => url.startsWith(BLOCK_URL) ? { body: SERVED_OLD } : null) });
  assert.equal(stale.served, false);
  const refusal = servedRefusal(stale, { module: 'SalesPortal', elements: [block] });
  assert.equal(refusal.code, 'SERVED_STALE'); assert.match(refusal.error, /IWebBlock:AccountMenu expected sha256 [0-9a-f]{12}, served [0-9a-f]{12}/);
  assert.match(refusal.problems[0].remedy, /widget of the element was changed in this delivery \(Row\)/);
  assert.equal(levelsOf({ built: true, validated: true, merged: true, published: true, served: stale }).served, false);
});

test('unreachable, redirected, not CSS, unknown place, no reader, another origin -> "unverified", never "served"', async () => {
  const run = (reader, extra = {}) => proveServed([block], { environment: 'env-a.example.test', module: 'SalesPortal', reader, ...extra });
  assert.equal((await run(fakeFetch(() => new Error('getaddrinfo ENOTFOUND')))).elements[0].reason, 'SERVED_UNREACHABLE');
  assert.equal((await run(fakeFetch({ [BLOCK_URL]: { status: 302, location: '/SalesPortal/Login.aspx' } }))).elements[0].reason, 'SERVED_REDIRECTED');
  assert.equal((await run(fakeFetch({ [BLOCK_URL]: { type: 'text/html', body: '<!DOCTYPE html>' } }))).elements[0].reason, 'SERVED_NOT_CSS');
  assert.equal((await run(fakeFetch({}))).elements[0].reason, 'SERVED_HTTP_404');
  assert.equal((await proveServed([{ ...block, flow: null }], { environment: 'env-a.example.test', module: 'SalesPortal', reader: fakeFetch({}) })).elements[0].reason, 'SERVED_URL_UNKNOWN');
  assert.equal((await run(fakeFetch({}), { environment: null })).elements[0].reason, 'SERVED_ORIGIN_UNKNOWN');
  assert.equal((await run(null)).elements[0].reason, 'SERVED_READ_UNAVAILABLE');
  const spy = fakeFetch({});
  for (const url of ['https://elsewhere.example.test/x.css', 'https://user:pw@env-a.example.test/x.css', 'http://env-a.example.test/x.css'])
    assert.equal((await readServed(url, { origin: ORIGIN, fetchImpl: spy })).reason, 'SERVED_ORIGIN_REFUSED', url);
  assert.equal(spy.calls.length, 0);
});

test('a shared file and a page are judged by the delta between before and after the publication', async () => {
  const theme = elementsOfKernel([{ key: 't', kind: 'theme', name: 'SalesTheme', flavor: 'traditional', baseStyleSheet: '.a{color:red}', styleSheet: '.a{color:blue}', touch: null, reason: 'a theme has no widget to change' }])[0];
  const url = ORIGIN + '/SalesPortal/Theme.SalesTheme.css';
  const other = '.other{color:blue}\n';
  let now = other + '.a{color:red}';
  const reader = fakeFetch(u => u === url ? { body: now } : null);
  const baseline = await servedBaseline([theme], { environment: 'env-a.example.test', module: 'SalesPortal', reader });
  now = other + '.a{color:blue}';
  assert.equal((await proveServed([theme], { environment: 'env-a.example.test', module: 'SalesPortal', reader, baseline })).served, true);
  now = other + '.a{color:red}';
  assert.equal((await proveServed([theme], { environment: 'env-a.example.test', module: 'SalesPortal', reader, baseline })).served, false, 'the file did not change: stale');
  assert.equal((await proveServed([theme], { environment: 'env-a.example.test', module: 'SalesPortal', reader })).elements[0].reason, 'SERVED_NO_BASELINE');
  const screen = elementsOfKernel([{ key: 's', kind: 'screen', name: 'Orders', flavor: 'traditional', baseStyleSheet: '', styleSheet: '.p{q:r}', touch: null, reason: 'x' }])[0];
  const page = fakeFetch({ [ORIGIN + '/SalesPortal/Orders.aspx']: { type: 'text/html', body: '<html><style>.other{a:b}</style></html>' } });
  const pageBaseline = await servedBaseline([screen], { environment: 'env-a.example.test', module: 'SalesPortal', reader: page });
  assert.equal((await proveServed([screen], { environment: 'env-a.example.test', module: 'SalesPortal', reader: page, baseline: pageBaseline })).elements[0].reason, 'SERVED_PAGE_UNPROVEN', 'a page never claims stale');
});

const WORDS = 'yes, deliver and publish the sales portal';
test('o11_deliver publish:true: served true only with the proof; stale -> SERVED_STALE; no reader -> "unverified"', async t => {
  const fresh = setup(t, { servedFetch: fakeFetch(url => url.startsWith(BLOCK_URL) ? { body: SERVED_NEW } : null) });
  const ok = await (await serve(t, fresh.deps))({ module: 'SalesPortal', job: fresh.job('a.json', cssJob), publish: true, authorize: WORDS, expectedEnvironment: 'env-a.example.test' });
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.deepEqual(ok.levels, { built: true, validated: true, merged: true, published: true, served: true });
  const stale = setup(t, { servedFetch: fakeFetch(url => url.startsWith(BLOCK_URL) ? { body: SERVED_OLD } : null) });
  const refused = await (await serve(t, stale.deps))({ module: 'SalesPortal', job: stale.job('b.json', cssJob), publish: true, authorize: WORDS, expectedEnvironment: 'env-a.example.test' });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'SERVED_STALE'); assert.equal(refused.publish.outcome, 'published'); assert.equal(refused.levels.served, false);
  assert.equal(refused.continuation.tool, 'ssam_friction', 'no call that repeats the same delivery');
  const none = setup(t);
  const unsure = await (await serve(t, none.deps))({ module: 'SalesPortal', job: none.job('c.json', cssJob), publish: true, authorize: WORDS, expectedEnvironment: 'env-a.example.test' });
  assert.equal(unsure.ok, true); assert.equal(unsure.levels.served, 'unverified'); assert.equal(unsure.served.elements[0].reason, 'SERVED_READ_UNAVAILABLE');
  const plain = setup(t, { styleSheets: null });
  const value = await (await serve(t, plain.deps))({ module: 'SalesPortal', job: plain.job('d.json', { ops: [{ op: 'get', target: 'X:Y' }] }), publish: true, authorize: WORDS });
  assert.equal(value.levels.served, null); assert.equal(value.served, undefined);
});

test('ODC: the server revision is the bytes sent (published), the merge base (stale), or unproven; old bridges stay published', () => {
  const receipt = { ok: true, published: { revision: 2, sha256: 'AAA', matchesOpenModule: true, strictlyEqual: false, refreshedReferences: [], differencesOutsideReferences: [] } };
  const stale = publishOutcomeOf(receipt, { sentSha256: 'bbb', baseSha256: 'aaa' });
  assert.equal(stale.outcome, 'stale'); assert.equal(stale.code, 'PUBLISHED_REVISION_DIFFERS'); assert.doesNotMatch(stale.error, /strictlyEqual/);
  assert.equal(publishOutcomeOf(receipt, { sentSha256: 'aaa', baseSha256: 'ccc' }).outcome, 'published', 'the bytes sent');
  assert.equal(publishOutcomeOf({ ok: true, published: { revision: 4 } }).outcome, 'published', 'an older bridge without the comparison');
  assert.equal(publishedRevisionProof({ error: 'download failed' }).proven, null);
  assert.equal(publishOutcomeOf({ ...receipt, published: { ...receipt.published, strictlyEqual: true } }, {}).outcome, 'published');
  assert.deepEqual(dumpDifferences('(Object Library) L [DifferenceInLocalMergeUnit]\n+-- (Object Block) B [DifferenceInLocalMergeUnit]\n|    +-- (Object Style Sheet) Style Sheet [ChangedInLocal]\n|    |    >> Style Sheet[.a {\n}] / Style Sheet[.b{}] [ChangedInLocal]').length, 1);
  const next = staleRevisionNext(path.join(os.tmpdir(), 'no-lab', 'delivery', 'manifest.json'));
  assert.equal(next.tool, 'studio_status', 'no pointer into a receipt that is not there');
});
