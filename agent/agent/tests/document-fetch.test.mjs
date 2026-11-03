// document.fetch (0.3.12, r40): one integration document downloaded on this machine for a hosted server. The protocol cases are
// the native core's too (tests/native-protocol/document-fetch-cases.json, DocumentFetchTests.cs): a local HTTP server built
// from the cases' routes, no other network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkspace } from '../lib/workspace.mjs';
import { KINDS, helloKinds, createKinds } from '../lib/kinds.mjs';
import { AGENT_VERSION } from '../lib/agent.mjs';
import { DOCUMENT_FETCH_KIND, DOCUMENT_FETCH_LIMITS, createDocumentFetch, fetchPlan } from '../lib/document-fetch.mjs';

const CASES = JSON.parse(fs.readFileSync(new URL('../../tests/native-protocol/document-fetch-cases.json', import.meta.url), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// The server of the cases: each route answers as written; {base} and {hostport} are its own address.
async function casesServer(t) {
  const seen = [];
  let base = '', hostport = '';
  const fill = text => String(text).replaceAll('{base}', base).replaceAll('{hostport}', hostport);
  const server = http.createServer(async (req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    const route = CASES.routes[req.url.split('?')[0]];
    if (!route) { res.writeHead(500); res.end(); return; }
    if (route.delayMs) await new Promise(resolve => setTimeout(resolve, route.delayMs));
    const headers = { ...(route.type ? { 'content-type': route.type } : {}), ...(route.location ? { location: fill(route.location) } : {}) };
    const body = route.echoHeaders ? JSON.stringify({ cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null, userAgent: req.headers['user-agent'] ?? null })
      : route.fill ? route.prefix + route.fill.repeat(route.size - route.prefix.length) : route.body ?? '';
    if (route.chunked) { res.writeHead(route.status, headers); for (let i = 0; i < body.length; i += 256) res.write(body.slice(i, i + 256)); res.end(); return; }
    res.writeHead(route.status, { ...headers, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  hostport = '127.0.0.1:' + server.address().port;
  base = 'http://' + hostport;
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  return { seen, fill, base, bodyOf: route => Buffer.from(fill(CASES.routes[route].body)) };
}
const filled = (value, fill) => JSON.parse(fill(JSON.stringify(value)));

test('protocol cases (the native core runs the same file)', async t => {
  const server = await casesServer(t);
  const run = createDocumentFetch();
  for (const c of CASES.cases) {
    server.seen.length = 0;
    const params = filled(c.params, server.fill);
    let value = null, code = null;
    try { value = await run(params); } catch (error) { code = error.code; assert.equal(error.executed, false, c.name + ': a refusal leaves nothing on this machine'); assert.match(error.message, /^[\x20-\x7e]+$/, c.name + ': English text'); }
    if (c.expect.code) assert.equal(code, c.expect.code, c.name + ': ' + JSON.stringify(value)?.slice(0, 200));
    else {
      assert.equal(code, null, c.name);
      const want = filled(c.expect, server.fill);
      for (const key of ['status', 'finalUrl', 'contentType', 'bytes', 'contentBase64']) if (key in want) assert.equal(value[key], want[key], c.name + ': ' + key);
      const bytes = Buffer.from(value.contentBase64, 'base64');
      assert.equal(value.bytes, bytes.length, c.name + ': bytes');
      assert.equal(value.sha256, sha(bytes), c.name + ': sha256');
      if (want.bodyOf) assert.deepEqual(bytes, server.bodyOf(want.bodyOf), c.name + ': body');
      if (want.json) assert.deepEqual(JSON.parse(bytes.toString('utf8')), want.json, c.name + ': json');
      assert.deepEqual(Object.keys(value).sort(), ['bytes', 'contentBase64', 'contentType', 'finalUrl', 'sha256', 'status'], c.name + ': the answer\'s fields');
    }
    assert.equal(server.seen.length, c.requests, c.name + ': requests');
    for (const request of server.seen) assert.equal(request.method, 'GET', c.name + ': only GET');
  }
});

test('the limits of the kind are the ones the server asks for', () => {
  assert.deepEqual({ ...DOCUMENT_FETCH_LIMITS }, { maxBytes: 5 * 1024 * 1024, timeoutMs: 30000, maxRedirects: 5 });
  assert.deepEqual(Object.keys(fetchPlan({ url: 'https://example.test/a?wsdl', accept: 'xml' })).sort(), ['accept', 'maxBytes', 'sameOrigin', 'timeoutMs', 'url']);
});

test('the call deadline cuts the timeout; a passed deadline requests nothing', async () => {
  let asked = 0;
  const run = createDocumentFetch({ fetchImpl: async () => { asked++; throw new Error('no'); }, now: () => 1000 });
  await assert.rejects(run({ url: 'https://example.test/x.wsdl', accept: 'xml' }, { deadline: 999 }), { code: 'DOCUMENT_FETCH_FAILED' });
  assert.equal(asked, 0);
});

test('the hello lists document.fetch on every platform, and the kinds table runs it with its own client (never the channel\'s)', async t => {
  assert.equal(AGENT_VERSION, '0.3.13');
  assert.ok(KINDS.includes(DOCUMENT_FETCH_KIND));
  assert.ok(helloKinds(null).includes(DOCUMENT_FETCH_KIND));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-docfetch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const asked = [];
  const channel = async () => { throw new Error('the channel client was used'); };
  const documentFetch = async (url, init) => { asked.push({ url, init }); return new Response('<definitions/>', { status: 200, headers: { 'content-type': 'text/xml' } }); };
  const kinds = createKinds({ root, ws: createWorkspace(root, { platform: 'win32' }), pack: { lanes: ['o11'] }, deps: { processes: async () => [], fetch: channel, documentFetch }, platform: 'win32' });
  const value = await kinds.execute(DOCUMENT_FETCH_KIND, { url: 'https://docs.example.test/svc.wsdl', accept: 'xml' });
  assert.equal(value.status, 200);
  assert.equal(Buffer.from(value.contentBase64, 'base64').toString(), '<definitions/>');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].init.method, 'GET');
  assert.equal(asked[0].init.redirect, 'manual');
  assert.equal(asked[0].init.credentials, 'omit');
  assert.deepEqual(Object.keys(asked[0].init.headers).sort(), ['accept', 'user-agent']);
});

test('review of r40: a name that resolves to a link-local address is never requested, nor a redirect from another host into this machine', async () => {
  const asked = [];
  const lookup = (host, options, callback) => callback(null, host === 'evil.example.test' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  const answers = { 'http://docs.example.test/a.wsdl': new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8080/secret.wsdl' } }),
    'http://docs.example.test/b.wsdl': new Response('', { status: 302, headers: { location: 'http://evil.example.test/x.wsdl' } }) };
  const run = createDocumentFetch({ lookup, fetchImpl: async url => { asked.push(url); return answers[url] ?? new Response('<definitions/>', { status: 200 }); } });
  await assert.rejects(run({ url: 'http://evil.example.test/x.wsdl', accept: 'xml' }), { code: 'DOCUMENT_FETCH_URL_REFUSED' });
  await assert.rejects(run({ url: 'http://docs.example.test/a.wsdl', accept: 'xml' }), { code: 'DOCUMENT_FETCH_REDIRECT_REFUSED' });
  await assert.rejects(run({ url: 'http://docs.example.test/b.wsdl', accept: 'xml' }), { code: 'DOCUMENT_FETCH_REDIRECT_REFUSED' });
  assert.deepEqual(asked, ['http://docs.example.test/a.wsdl', 'http://docs.example.test/b.wsdl']);
  // The user's own intranet and this machine named by the job stay reachable.
  assert.equal((await run({ url: 'http://10.0.0.5/svc.wsdl', accept: 'xml' })).status, 200);
  assert.equal((await run({ url: 'http://127.0.0.1:8080/svc.wsdl', accept: 'xml' })).status, 200);
});
