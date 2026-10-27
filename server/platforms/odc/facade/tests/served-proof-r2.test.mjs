// F1 correction round (review of e94eb00f): one test per finding. Each one fails on e94eb00f and passes after the round.
// Fake fetches, fake Anvil CLI and temporary folders only; synthetic names. The real ODC publish receipts are read only
// through SSAM_F1_ODC_RECEIPTS (a private copy; nothing runs when it is unset).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ORIGIN, BASE, DELIVERED, SERVED_NEW, SERVED_OLD, KERNEL, BLOCK_URL, fakeFetch, serve, setup, cssJob } from './fixtures/served-proof-fixtures.mjs';

const WORDS = 'yes, deliver and publish the sales portal';
const served = () => import('../served-proof.mjs');
const kernelDelivery = () => import('../kernel-delivery.mjs');
const deliveredJob = runAnvil => JSON.parse(fs.readFileSync(runAnvil.calls[0].args[runAnvil.calls[0].args.indexOf('--job') + 1], 'utf8'));
const oldLocate = { servedLocate: async () => ({ flow: 'Common', theme: null }) }; // e94eb00f's locator (ignored now)

test('H1: a server built without the stdio entry never reads the environment: zero requests, "unverified"', async t => {
  const original = globalThis.fetch;
  const spy = fakeFetch(() => ({ body: SERVED_NEW }));
  globalThis.fetch = spy;
  t.after(() => { globalThis.fetch = original; });
  const s = setup(t, { extra: oldLocate });
  const value = await (await serve(t, s.deps))({ module: 'SalesPortal', job: s.job('h1.json', cssJob), publish: true, authorize: WORDS, expectedEnvironment: 'env-a.example.test' });
  assert.equal(spy.calls.length, 0, 'no request left the server');
  assert.equal(value.levels.served, 'unverified');
  assert.equal(value.served.elements[0].reason, 'SERVED_READ_UNAVAILABLE');
});

test('H2: the facade never appends a touch over the job\'s own widgets (the kernel chooses it after the ops)', async t => {
  const tree = { kind: 'WebBlock', name: 'AccountMenu', key: 'blk', children: [{ kind: 'ContainerWidget', name: 'Wrap', key: 'w1', properties: { Style: '' } }] };
  const s = setup(t, { extra: { capture: async () => ({ ok: true, path: path.join(s0(t), 'capture.oml'), sha256: 'ab'.repeat(32) }), read: async () => ({ ok: true, data: { tree } }) } });
  const job = { ops: [...cssJob.ops, { op: 'set', target: 'IWebBlock:AccountMenu/Wrap', prop: 'Style', value: 'brand-wrap' }] };
  const value = await (await serve(t, s.deps))({ module: 'SalesPortal', job: s.job('h2.json', job), authorize: WORDS });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(deliveredJob(s.runAnvil).ops, job.ops, 'exactly the ops the job wrote');
});
function s0(t) { const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'h2-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('H3: the bytes sent prove the revision; the merge base proves it stale even with a refreshed reference', async () => {
  const { publishOutcomeOf } = await kernelDelivery();
  // Editor state only (the review's false refusal): the revision the server holds is the bytes the Studio sent.
  const editor = { ok: true, published: { revision: 124, sha256: 'ABC', matchesOpenModule: true, strictlyEqual: false, refreshedReferences: [], differencesOutsideReferences: [] } };
  assert.equal(publishOutcomeOf(editor, { sentSha256: 'abc', baseSha256: 'def' }).outcome, 'published');
  // A refreshed reference never explains a stylesheet the server did not take: the base revision is stale.
  const refreshed = { ok: true, published: { revision: 2, sha256: 'BASE', matchesOpenModule: true, strictlyEqual: false, refreshedReferences: ['Producer'], differencesOutsideReferences: [] } };
  assert.equal(publishOutcomeOf(refreshed, { sentSha256: 'sent', baseSha256: 'base' }).outcome, 'stale');
});

test('H3 (real receipts, SSAM_F1_ODC_RECEIPTS): only the publications that kept the merge base are stale', { skip: !process.env.SSAM_F1_ODC_RECEIPTS }, async () => {
  const { publishOutcomeOf } = await kernelDelivery();
  const root = process.env.SSAM_F1_ODC_RECEIPTS; const tally = { published: 0, stale: 0, other: 0 }; let editorOnly = 0;
  for (const dir of fs.readdirSync(root).map(d => path.join(root, d))) {
    let receipt; try { receipt = JSON.parse(fs.readFileSync(path.join(dir, 'publish-receipt.json'), 'utf8').replace(/^﻿/, '')); } catch { continue; }
    const read = file => { try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return undefined; } };
    const evidence = { sentSha256: read('before-publish.sha256')?.trim(), baseSha256: read('preview.json') ? JSON.parse(read('preview.json').replace(/^﻿/, '')).baseSha256?.toLowerCase() : undefined, dump: read('open-vs-published.txt') };
    const outcome = publishOutcomeOf(receipt, evidence).outcome;
    tally[outcome in tally ? outcome : 'other']++;
    const sha = String(receipt.published?.sha256 ?? '').toLowerCase();
    if (outcome === 'stale') assert.equal(sha, evidence.baseSha256, 'stale only when the server kept the merge base');
    if (receipt.published?.strictlyEqual === true) assert.equal(outcome, 'published');
    if (receipt.published?.strictlyEqual === false && sha === evidence.sentSha256) { editorOnly++; assert.equal(outcome, 'published'); }
  }
  assert.ok(tally.published > 100, JSON.stringify(tally)); assert.equal(tally.stale, 2, JSON.stringify(tally)); assert.equal(editorOnly, 1);
});

test('M1: a shared file is judged by the element\'s delta: a removed rule still served, or the new value from another element, is never "served"', async () => {
  const { proveServed } = await served();
  const s = await served();
  const theme = { target: 'IWebTheme:SalesTheme', kind: 'theme', name: 'SalesTheme', flavor: 'traditional', flow: null, base: '.a{color:red}', delivered: '.a{color:blue}' };
  const url = ORIGIN + '/SalesPortal/Theme.SalesTheme.css';
  // Another element of the module has .a{color:blue}; the delivered change did not reach the file (.a{color:red} is still there).
  const text = '.other .a{x:y}\n.a{color:blue}\n.a{color:red}';
  const reader = fakeFetch(u => u === url ? { body: text } : null);
  const baseline = s.servedBaseline ? await s.servedBaseline([theme], { environment: 'env-a.example.test', module: 'SalesPortal', reader }) : new Map();
  const proof = await proveServed([theme], { environment: 'env-a.example.test', module: 'SalesPortal', reader, baseline, locate: async () => ({}) });
  assert.notEqual(proof.served, true);
  assert.equal(proof.served, false, 'the file did not change between before and after: stale');
});

test('M2: the comparison uses the stylesheet the kernel read back from the candidate (Studio rewrites included); @keyframes is stable', async t => {
  const { normalizeCss } = await served();
  assert.equal(normalizeCss('@keyframes pulse{from{opacity:0}to{opacity:1}}'), normalizeCss('@keyframes pulse {\n  from { opacity: 0; }\n  to {\n    opacity: 1\n  }\n}'));
  const job = '#reactContainer .x{color:red}';
  const stored = ':is(#reactContainer, body) .x{color:red}';
  const s = setup(t, { servedFetch: fakeFetch(url => url.startsWith(BLOCK_URL) ? { body: stored } : null), extra: oldLocate,
    styleSheets: [{ ...KERNEL[0], baseStyleSheet: '', styleSheet: stored }] });
  const value = await (await serve(t, s.deps))({ module: 'SalesPortal', job: s.job('m2.json', { ops: [{ op: 'set', target: 'IWebBlock:AccountMenu', prop: 'StyleSheet', value: job }] }),
    publish: true, authorize: WORDS, expectedEnvironment: 'env-a.example.test' });
  assert.equal(value.ok, true, JSON.stringify(value)); assert.equal(value.levels.served, true);
});

test('M3: an older cache at the URL is "unverified" with a note, never stale; a non-CSS answer is "unverified"', async () => {
  const { proveServed, elementsOfKernel } = await served();
  const element = elementsOfKernel ? elementsOfKernel(KERNEL)[0] : { target: 'IWebBlock:AccountMenu', kind: 'block', name: 'AccountMenu', flavor: 'traditional', flow: 'Common', delivered: DELIVERED };
  const cache = fakeFetch(url => url === BLOCK_URL ? { body: SERVED_OLD } : url.startsWith(BLOCK_URL + '?') ? { body: SERVED_NEW } : null);
  const proof = await proveServed([element], { environment: 'env-a.example.test', module: 'SalesPortal', nonce: 'task1', reader: cache, locate: async () => ({ flow: 'Common' }) });
  assert.equal(proof.elements[0].served, 'unverified'); assert.equal(proof.served, 'unverified');
  const binary = fakeFetch({ [BLOCK_URL]: { type: 'application/octet-stream', body: SERVED_OLD } });
  const other = await proveServed([element], { environment: 'env-a.example.test', module: 'SalesPortal', reader: binary, locate: async () => ({ flow: 'Common' }) });
  assert.equal(other.elements[0].served, 'unverified'); assert.equal(other.elements[0].reason, 'SERVED_NOT_CSS');
});

test('M4: SERVED_STALE names what SSAM already did per element and never repeats the same delivery', async t => {
  const theme = { key: 't', kind: 'theme', name: 'SalesTheme', flow: null, flavor: 'traditional', baseStyleSheet: '.a{color:red}', styleSheet: '.a{color:blue}', touch: null, reason: 'a theme has no widget to change' };
  const s = setup(t, { servedFetch: fakeFetch(url => url.startsWith(BLOCK_URL) ? { body: SERVED_OLD } : url.includes('/Theme.SalesTheme.css') ? { body: '.a{color:red}' } : null),
    styleSheets: [KERNEL[0], theme], extra: oldLocate });
  const value = await (await serve(t, s.deps))({ module: 'SalesPortal', job: s.job('m4.json', { ops: [...cssJob.ops, { op: 'set', target: 'IWebTheme:SalesTheme', prop: 'StyleSheet', value: '.a{color:blue}' }] }),
    publish: true, authorize: WORDS, expectedEnvironment: 'env-a.example.test' });
  assert.equal(value.code, 'SERVED_STALE');
  assert.notEqual(value.continuation.tool, 'o11_deliver', 'not a call that repeats the same refusal');
  const remedies = Object.fromEntries(value.problems.map(p => [p.element, p.remedy]));
  assert.match(remedies['IWebTheme:SalesTheme'], /no widget change could reach it: a theme has no widget/);
  assert.match(remedies['IWebBlock:AccountMenu'], /widget of the element was changed in this delivery/);
});

test('M5: a stylesheet written through an @key target gets the proof: a job with stylesheets never shows served:null', async t => {
  const s = setup(t, { servedFetch: fakeFetch(url => url.startsWith(BLOCK_URL) ? { body: SERVED_NEW } : null), extra: oldLocate });
  const value = await (await serve(t, s.deps))({ module: 'SalesPortal', job: s.job('m5.json', { ops: [{ op: 'set', target: '@blk', prop: 'StyleSheet', value: DELIVERED }] }),
    publish: true, authorize: WORDS, expectedEnvironment: 'env-a.example.test' });
  assert.equal(value.ok, true); assert.equal(value.levels.served, true); assert.equal(value.served.elements[0].element, 'IWebBlock:AccountMenu');
});

test('LOW: the size is enforced while streaming; one time budget covers every read', async () => {
  const { readServed, proveServed, elementsOfKernel } = await served();
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024 + 1);
  const stream = { getReader: () => ({ read: async () => (pulled++ < 5 ? { done: false, value: chunk } : { done: true }), cancel: async () => {} }) };
  const fetchImpl = fakeFetch({ [BLOCK_URL]: { stream, body: undefined } });
  const huge = await readServed(BLOCK_URL, { origin: ORIGIN, fetchImpl: async (u, i) => { const r = await fetchImpl(u, i); return { ...r, text: async () => { throw new Error('the whole body was read'); } }; } });
  assert.equal(huge.reason, 'SERVED_TOO_LARGE'); assert.ok(pulled <= 3, 'stopped at the limit, pulled ' + pulled);
  const element = elementsOfKernel ? elementsOfKernel(KERNEL)[0] : null;
  const spent = await proveServed([element ?? {}], { environment: 'env-a.example.test', module: 'SalesPortal', reader: fakeFetch({ [BLOCK_URL]: { body: SERVED_NEW } }), deadline: Date.now() - 1 });
  assert.equal(spent.elements[0].reason, 'SERVED_BUDGET_SPENT');
});

test('LOW: no internals in the answers: no file names, the agent note once and only to the owner, no strictlyEqual in texts', async () => {
  const { proveServed, SERVED_COMPARED, elementsOfKernel } = await served();
  assert.doesNotMatch(SERVED_COMPARED, /\.mjs/);
  const element = elementsOfKernel ? elementsOfKernel(KERNEL)[0] : null;
  const licensee = await proveServed([element, element], { environment: 'env-a.example.test', module: 'SalesPortal', reader: null, owner: false });
  assert.ok(licensee.elements.every(e => !('agentNeeds' in e))); assert.equal(licensee.agentNeeds, undefined);
  const owner = await proveServed([element], { environment: 'env-a.example.test', module: 'SalesPortal', reader: null, owner: true });
  assert.equal(typeof owner.agentNeeds, 'string');
  const { publishOutcomeOf } = await kernelDelivery();
  const stale = publishOutcomeOf({ ok: true, published: { revision: 2, sha256: 'B', strictlyEqual: false, refreshedReferences: [], differencesOutsideReferences: [] } }, { baseSha256: 'b', sentSha256: 's' });
  assert.equal(stale.outcome, 'stale'); assert.doesNotMatch(stale.error, /strictlyEqual|matchesOpenModule/);
});

test('LOW: the housekeeping of a completed publication runs even when the stylesheet is served stale', async t => {
  const closes = [];
  const s = setup(t, { servedFetch: fakeFetch(url => url.startsWith(BLOCK_URL) ? { body: SERVED_OLD } : null), extra: { ...oldLocate,
    bridge: { ok: async (method, params) => { if (method === 'close_module') { closes.push(params); return { closed: true }; } return {}; }, call: async () => ({}) } } });
  const value = await (await serve(t, { ...s.deps, runAnvil: wrapOpen(s.runAnvil) }))({ module: 'SalesPortal', job: s.job('low.json', cssJob), publish: true, authorize: WORDS, expectedEnvironment: 'env-a.example.test' });
  assert.equal(value.code, 'SERVED_STALE');
  assert.equal(value.closedTab, true); assert.equal(closes.length, 1);
});
// The delivery opened the module's tab (open.alreadyOpen false): the publication closes it afterwards.
function wrapOpen(runAnvil) {
  const wrapped = async (args, options) => { const run = await runAnvil(args, options); if (run?.envelope?.data) run.envelope.data = { ...run.envelope.data, open: { alreadyOpen: false } }; return run; };
  wrapped.calls = runAnvil.calls;
  return wrapped;
}
export { createHash };
