// B5 (the proto line's C-04, 46e5012f; F-FigmaReactive-05, F-FT-10): a delivery that changed only CSS answered "delivered", the
// publication answered "published" twice, and the runtime kept serving the old stylesheet. The line's served proof (F1,
// served-proof.mjs) covered o11_deliver publish:true only; now a delivery without publish:true leaves its changed stylesheets
// pending and o11_publish proves them with the same proof. And the read is no SSRF surface: only the person's own SSAM reads,
// only the environment its Studio is connected to, never a link-local or metadata address, never a redirect, never credentials,
// bounded in size and time; a hosted server reads nothing and keeps nothing.
// Fake bridge, fake fetch, fake Anvil CLI and temporary folders only; synthetic names.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Publish } from '../o11-publish.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { elementsOfKernel, environmentOrigin, localServedReader, readServed, servedPending, servedUrls, rememberServedPending, metadataAddress, MAX_BYTES } from '../served-proof.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';
import { BASE, DELIVERED, SERVED_NEW, SERVED_OLD, KERNEL, fakeFetch, serve, setup, cssJob } from './fixtures/served-proof-fixtures.mjs';

const WORDS = 'yes, publish the sales portal now';
const HOST = 'env-a.example.test';
const ORIGIN = 'https://' + HOST;
const BLOCK = ORIGIN + '/SalesPortal/Blocks/SalesPortal/Common/AccountMenu.css';
const ok = data => ({ success: true, data, error: null });
const fail = error => ({ success: false, data: null, error });
const PUBLISHED = ok({ module: 'SalesPortal', published: true, state: 'CompletedWithSuccessNotOpenedInBrowser', isValid: true, elapsedMs: 5 });

async function harness(t, { servedFetch, active = { name: 'SalesPortal', key: 'k-sales', kind: 'Web', environment: HOST, isModified: false, pendingDialogs: [] } } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-publish-served-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sub = name => { const p = path.join(base, name); fs.mkdirSync(p, { recursive: true }); return p; };
  const root = sub('anvil'), home = sub('home');
  const env = { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4', USERPROFILE: home, HOME: home, APPDATA: sub('appdata'), LOCALAPPDATA: sub('localappdata'), ANVIL_AUTHORITY_DIR: sub('authority') };
  const requests = [];
  const fake = await fakeBridge(async request => {
    requests.push(request);
    switch (request.method) {
      case 'open_module': return ok({ name: request.params.name, opened: true, alreadyOpen: true, selected: true, serverSilentMode: false, elapsedMs: 3 });
      case 'get_active_module': return ok(active);
      case 'get_errors': return ok({ isValid: true, errors: 0, warnings: 0, total: 0, byType: {}, messages: [], rawMessages: [] });
      case 'publish': return PUBLISHED;
      default: return fail('Unknown method: ' + request.method);
    }
  });
  let clock = Date.parse('2026-11-01T10:00:00.000Z');
  const server = new McpServer({ name: 'o11-publish-served', version: '1.0.0' });
  registerO11Publish(server, { root, env, lane: 'ss4', now: () => new Date(clock += 1000), bridge: o11Bridge({ port: fake.port, authorization: 'K' }),
    assertSelected: async () => {}, ...(servedFetch !== undefined ? { servedFetch } : {}) });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'o11-publish-served-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); await fake.close(); });
  const local = o11LaneOf('ss4', { root, env }).local;
  const call = async args => { const reply = await client.callTool({ name: 'o11_publish', arguments: args }); return reply.structuredContent ?? JSON.parse(reply.content[0].text); };
  return { local, call, sent: method => requests.filter(r => r.method === method) };
}
const where = { environment: HOST, module: 'SalesPortal' };

test('B5: a stylesheet a delivery left pending is proven by o11_publish: stale is SERVED_STALE once (published, never repeated), served clears it', async t => {
  let served = SERVED_OLD;
  const fetch = fakeFetch(url => (url.startsWith(BLOCK) ? { body: served } : null));
  const h = await harness(t, { servedFetch: fetch });
  rememberServedPending(h.local, { ...where, elements: elementsOfKernel(KERNEL) });
  assert.equal(servedPending(h.local, where).elements.length, 1);

  const stale = await h.call({ module: 'SalesPortal', authorize: WORDS });
  assert.equal(stale.ok, false); assert.equal(stale.code, 'SERVED_STALE'); assert.equal(stale.published, true);
  assert.equal(stale.served.served, false); assert.equal(stale.served.elements[0].element, 'IWebBlock:AccountMenu');
  assert.equal(stale.continuation.tool, 'ssam_friction', 'never a call that repeats the publication');
  assert.equal(h.sent('publish').length, 1);
  assert.equal(servedPending(h.local, where), null, 'a stale stylesheet is said once and leaves the pending ones');

  // Review of W3-CSS (correction 1): the next publication, with no delivery in between and the environment still serving the
  // old stylesheet, is a publication again: ok, no SERVED_STALE about the old delivery, nothing read.
  const reads = fetch.calls.length;
  const next = await h.call({ module: 'SalesPortal', authorize: WORDS });
  assert.equal(next.ok, true, JSON.stringify(next)); assert.notEqual(next.code, 'SERVED_STALE'); assert.equal(next.served, undefined);
  assert.equal(h.sent('publish').length, 2); assert.equal(fetch.calls.length, reads);

  // A new delivery of the element, then a publication that serves it: served, and nothing stays pending.
  rememberServedPending(h.local, { ...where, elements: elementsOfKernel(KERNEL) });
  served = SERVED_NEW;
  const proven = await h.call({ module: 'SalesPortal', authorize: WORDS });
  assert.equal(proven.ok, true, JSON.stringify(proven)); assert.equal(proven.served.served, true);
  assert.equal(servedPending(h.local, where), null, 'a served stylesheet leaves');
  // Every read: GET of the module's own path in the Studio's environment, no redirect followed, no credential, no cache.
  assert.ok(fetch.calls.length >= 2);
  for (const { url, init } of fetch.calls) {
    assert.ok(url.startsWith(ORIGIN + '/SalesPortal/'), url);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    assert.deepEqual(Object.keys(init.headers).map(k => k.toLowerCase()).filter(k => /cookie|authorization/.test(k)), []);
  }
  // Nothing pending: the next publication reads nothing.
  const before = fetch.calls.length;
  const plain = await h.call({ module: 'SalesPortal', authorize: WORDS });
  assert.equal(plain.ok, true); assert.equal(plain.served, undefined); assert.equal(fetch.calls.length, before);
});

test('B5: a shared file another publication already served is served, not stale', async t => {
  const theme = [{ key: 'th', kind: 'theme', name: 'SalesTheme', flow: null, flavor: 'traditional', baseStyleSheet: '.a{color:red}\n', styleSheet: '.a{color:red}\n.b{color:blue}\n', touch: null, reason: 'a theme has no widget to change' }];
  const url = ORIGIN + '/SalesPortal/Theme.SalesTheme.css';
  const fetch = fakeFetch(u => (u.startsWith(url) ? { body: '.x{top:0}\n.a{color:red}\n.b{color:blue}\n' } : null));
  const h = await harness(t, { servedFetch: fetch });
  rememberServedPending(h.local, { ...where, elements: elementsOfKernel(theme) });
  const value = await h.call({ module: 'SalesPortal', authorize: WORDS });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.served.elements[0].served, true); assert.match(value.served.elements[0].note, /earlier publication/);
  assert.equal(servedPending(h.local, where), null);
});

test('B5 hosted: a server built without the stdio entry never reads the environment and keeps nothing pending', async t => {
  const original = globalThis.fetch;
  const spy = fakeFetch(() => ({ body: SERVED_NEW }));
  globalThis.fetch = spy;
  t.after(() => { globalThis.fetch = original; });
  // o11_publish without a reader: a pending record (written by hand here) is never read, nothing is fetched.
  const h = await harness(t);
  rememberServedPending(h.local, { ...where, elements: elementsOfKernel(KERNEL) });
  const value = await h.call({ module: 'SalesPortal', authorize: WORDS });
  assert.equal(value.ok, true); assert.equal(value.served, undefined); assert.equal(spy.calls.length, 0);
  // o11_deliver without a reader: no pending record is written at all.
  const s = setup(t);
  const delivered = await (await serve(t, s.deps))({ module: 'SalesPortal', job: s.job('h.json', cssJob), authorize: WORDS, expectedEnvironment: HOST });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  assert.equal(servedPending(o11LaneOf('ss4', { root: s.root, env: s.env }).local, where), null);
  assert.equal(spy.calls.length, 0, 'no request left the server');
});

test('B5: o11_deliver without publish:true leaves its stylesheets pending (the person\'s SSAM); publish:true that proves them leaves none', async t => {
  const s = setup(t, { servedFetch: fakeFetch(u => (u.startsWith(BLOCK) ? { body: SERVED_NEW } : null)) });
  const deliver = await serve(t, s.deps);
  const local = o11LaneOf('ss4', { root: s.root, env: s.env }).local;
  assert.equal((await deliver({ module: 'SalesPortal', job: s.job('a.json', cssJob), authorize: WORDS, expectedEnvironment: HOST })).ok, true);
  const pending = servedPending(local, where);
  assert.equal(pending.elements.length, 1);
  assert.deepEqual([pending.elements[0].base, pending.elements[0].delivered], [BASE, DELIVERED]);
  const both = await deliver({ module: 'SalesPortal', job: s.job('b.json', cssJob), publish: true, authorize: WORDS, expectedEnvironment: HOST });
  assert.equal(both.levels.served, true, JSON.stringify(both.levels));
  assert.equal(servedPending(local, where), null);
});

test('B5 (review of W3-CSS, correction 1): publish:true that finds the stylesheet stale says it once; the next o11_publish is a publication again', async t => {
  const s = setup(t, { servedFetch: fakeFetch(u => (u.startsWith(BLOCK) ? { body: SERVED_OLD } : null)) });
  const deliver = await serve(t, s.deps);
  const local = o11LaneOf('ss4', { root: s.root, env: s.env }).local;
  const stale = await deliver({ module: 'SalesPortal', job: s.job('s.json', cssJob), publish: true, authorize: WORDS, expectedEnvironment: HOST });
  assert.equal(stale.code, 'SERVED_STALE', JSON.stringify(stale)); assert.equal(stale.levels.served, false);
  assert.equal(servedPending(local, where), null, 'said once: nothing stays pending');
  // The o11_publish of the same lane folder afterwards reads nothing and answers the publication.
  const fetch = fakeFetch(() => ({ body: SERVED_OLD }));
  const h = await harness(t, { servedFetch: fetch });
  assert.equal(servedPending(h.local, where), null);
  const next = await h.call({ module: 'SalesPortal', authorize: WORDS });
  assert.equal(next.ok, true, JSON.stringify(next)); assert.equal(next.served, undefined); assert.equal(fetch.calls.length, 0);
});

test('B5 SSRF: the place read is the Studio\'s environment, never a link-local or metadata address, never a path the job names', async () => {
  for (const bad of ['169.254.169.254', 'https://169.254.169.254', '[fe80::1]', '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '168.63.129.16', '100.100.100.200',
    '0.0.0.0', '[::]', '[fd00:ec2::254]', 'http://' + HOST, 'https://user:pw@' + HOST, ORIGIN + '/App', ORIGIN + '/?x=1', ORIGIN + '/#f', 'file:///etc/passwd', '', null])
    assert.equal(environmentOrigin(bad), null, String(bad));
  assert.equal(environmentOrigin(HOST), ORIGIN);
  assert.equal(environmentOrigin('10.0.0.5'), 'https://10.0.0.5', 'an on-premises environment stays readable from the person\'s machine');
  for (const ip of ['169.254.169.254', '::ffff:169.254.169.254', 'fe80::1', '168.63.129.16', 'not-an-ip']) assert.equal(metadataAddress(ip), true, ip);
  for (const ip of ['10.0.0.5', '127.0.0.1', '203.0.114.7', '::1', '0:0:0:0:0:0:0:1']) assert.equal(metadataAddress(ip), false, ip);
  assert.equal(environmentOrigin('[::1]'), 'https://[::1]', 'IPv6 loopback is allowed as 127.0.0.1 is');
  // Names a job writes (a block, a flow, the module) are encoded into the module's own path: never another origin or path.
  for (const name of ['../../x', 'a/../../b?c#d', '@evil.example', '%2e%2e']) {
    const [plan] = servedUrls({ kind: 'block', flavor: 'traditional', name, flow: name }, { origin: ORIGIN, module: name });
    const url = new URL(plan.url);
    assert.equal(url.origin, ORIGIN, plan.url); assert.equal(url.search, ''); assert.equal(url.hash, '');
    assert.ok(url.pathname.startsWith('/' + encodeURIComponent(name) + '/'), plan.url);
  }
  // The pending record is named by a hash: no environment or module name makes a path.
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'served-pending-'));
  try {
    rememberServedPending(local, { environment: HOST, module: '..\\..\\escape', elements: elementsOfKernel(KERNEL) });
    const files = fs.readdirSync(path.join(local, 'served-pending'));
    assert.equal(files.length, 1); assert.match(files[0], /^[0-9a-f]{32}\.json$/);
    assert.equal(rememberServedPending(local, { environment: '169.254.169.254', module: 'M', elements: elementsOfKernel(KERNEL) }), null, 'no record for a metadata address');
  } finally { fs.rmSync(local, { recursive: true, force: true }); }
});

test('B5 SSRF: o11_publish reads nothing when the Studio\'s environment is a metadata address', async t => {
  const fetch = fakeFetch(() => ({ body: SERVED_NEW }));
  const h = await harness(t, { servedFetch: fetch, active: { name: 'SalesPortal', key: 'k', kind: 'Web', environment: '169.254.169.254', isModified: false, pendingDialogs: [] } });
  rememberServedPending(h.local, { ...where, elements: elementsOfKernel(KERNEL) });
  const value = await h.call({ module: 'SalesPortal', authorize: WORDS });
  assert.equal(value.ok, true); assert.equal(value.served, undefined); assert.equal(fetch.calls.length, 0);
});

test('B5 SSRF: the person\'s default reader refuses a name that resolves to a metadata address when it connects, follows no redirect, cuts the size', async t => {
  const seen = [];
  const site = http.createServer((request, response) => {
    seen.push(request.headers);
    if (request.url === '/r') { response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); response.end(); return; }
    if (request.url === '/big') { response.writeHead(200, { 'content-type': 'text/css' }); response.end('a'.repeat(MAX_BYTES + 10)); return; }
    response.writeHead(200, { 'content-type': 'text/css' }); response.end('.a{color:red}');
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  t.after(() => site.close());
  const port = site.address().port;
  const metadata = localServedReader({ env: {}, lookup: (host, options, callback) => callback(null, [{ address: '169.254.169.254', family: 4 }]) });
  await assert.rejects(metadata('http://metadata.example.test:' + port + '/'), error => error.code === 'DOCUMENT_HOST_NOT_PUBLIC');
  await assert.rejects(localServedReader({ env: {} })('http://169.254.169.254/latest/meta-data/'), error => error.code === 'DOCUMENT_HOST_NOT_PUBLIC');
  const reader = localServedReader({ env: {} });
  const origin = 'http://127.0.0.1:' + port;
  const fine = await readServed(origin + '/a.css', { origin, fetchImpl: reader });
  assert.equal(fine.ok, true); assert.equal(fine.text, '.a{color:red}');
  const redirected = await readServed(origin + '/r', { origin, fetchImpl: reader });
  assert.equal(redirected.reason, 'SERVED_REDIRECTED');
  const big = await readServed(origin + '/big', { origin, fetchImpl: reader });
  assert.equal(big.reason, 'SERVED_TOO_LARGE');
  assert.equal((await readServed('http://127.0.0.2:' + port + '/a.css', { origin, fetchImpl: reader })).reason, 'SERVED_ORIGIN_REFUSED');
  assert.equal(seen.length, 3, 'the redirect was never followed and another origin never asked');
  for (const headers of seen) assert.deepEqual(Object.keys(headers).filter(k => /cookie|authorization/.test(k)), []);
  assert.equal(localServedReader({ env: { SSAM_SERVED_READ: 'off' } }), null);
});
