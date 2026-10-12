// Finding 3 of the confinement review of the 24th release (servidor/fase4-24): the gate takes an http(s) URL of a WSDL or
// OpenAPI document as "never a path", and integration-documents.mjs then fetched it FROM THE SERVER, redirects followed,
// and pinned the answer into the customer's workspace with its sha256 and size: a hosted customer could read the server's
// loopback services, its private network and the cloud metadata address. Hosted, every URL (the document, each redirect
// hop, each import) must reach a public address (hosted/public-fetch.mjs): an IP literal or every address of the name,
// checked before the request and again at connect time by the default client (DNS rebinding), redirects followed one by
// one and re-checked. DOCUMENT_HOST_NOT_PUBLIC, and nothing is requested there. Local use is unchanged. A fake lookup and a
// fake fetch, and one HTTP server on 127.0.0.1 that must never be reached in hosted use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareIntegrationJob, MAX_DOCUMENT_BYTES } from '../integration-documents.mjs';
import { blockedAddress, createPublicFetch, publicUrlProblem } from '../hosted/public-fetch.mjs';
import { hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const here = path.dirname(fileURLToPath(import.meta.url));
const WSDL = fs.readFileSync(path.resolve(here, '..', '..', '..', '..', 'kernel', 'tests', 'fixtures', 'wsdl', 'calculator-two-ports.wsdl'), 'utf8');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
// A lookup that answers from a table {name: [address...]} (dns.lookup's signature) and records the names asked.
function fakeLookup(table) {
  const asked = [];
  const lookup = (host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    asked.push(host);
    const next = table[host];
    const list = (typeof next === 'function' ? next() : next ?? []).map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
    if (!list.length) return callback(Object.assign(new Error('getaddrinfo ENOTFOUND ' + host), { code: 'ENOTFOUND' }));
    return options?.all ? callback(null, list) : callback(null, list[0].address, list[0].family);
  };
  lookup.asked = asked;
  return lookup;
}
// A fetch that answers from a table {url: body | {status, location}} and records every call.
function fakeFetch(table) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), redirect: init?.redirect });
    const entry = table[String(url)];
    if (entry === undefined) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    if (typeof entry === 'object') return { ok: false, status: entry.status, headers: { get: name => (name.toLowerCase() === 'location' ? entry.location : null) }, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = Buffer.from(entry, 'utf8');
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
function box() {
  const dirs = hostedDirs(os.tmpdir());
  const local = path.join(dirs.workspace, 'odc', '.local');
  const job = wsdl => write(path.join(dirs.workspace, 'inbox', 'job.json'), { ops: [{ op: 'soap', data: { wsdl, methods: ['Add'] } }] });
  return { ...dirs, local, job, hosted: { lane: 'o11', localRoot: local, destructive: false, workspace: dirs.workspace } };
}
// One HTTP server on loopback that counts the requests it gets (the server's own services, as the customer would see them).
async function loopbackServer(t, body = WSDL) {
  const seen = [];
  const server = http.createServer((request, response) => { seen.push(request.url); response.writeHead(200, { 'content-type': 'text/xml' }); response.end(body); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, seen };
}

test('blockedAddress: loopback, private, link-local, shared, reserved and the cloud metadata addresses are not public; IPv6 forms that carry them too', () => {
  for (const ip of ['127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.100.100.200',
    '0.0.0.0', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '168.63.129.16', '::1', '::', 'fe80::1', 'fe80::1%eth0', 'fc00::1',
    'fd00:ec2::254', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::1', '2002:a9fe:a9fe::', 'ff02::1',
    '2001:db8::1', '2001::1', 'not-an-address', ''])
    assert.equal(blockedAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '64:ff9b::808:808'])
    assert.equal(blockedAddress(ip), false, ip);
});

test('publicUrlProblem: an IP literal in every spelling, a name with one address that is not public, a scheme other than http(s)', async () => {
  const lookup = fakeLookup({ 'docs.example.test': ['93.184.216.34'], 'intranet.example.test': ['10.0.0.5'], 'mixed.example.test': ['93.184.216.34', '127.0.0.1'],
    'metadata.google.internal': ['169.254.169.254'], 'v6.example.test': ['2606:4700::1111'] });
  for (const url of ['http://127.0.0.1/x', 'http://2130706433/x', 'http://0x7f.1/x', 'http://127.1/x', 'http://[::1]:8080/x', 'http://[::ffff:127.0.0.1]/x',
    'http://169.254.169.254/latest/meta-data/', 'http://[0:0:0:0:0:ffff:a9fe:a9fe]/', 'http://10.0.0.1/', 'http://intranet.example.test/svc?wsdl',
    'http://mixed.example.test/svc?wsdl', 'http://metadata.google.internal/computeMetadata/v1/', 'https://0.0.0.0/'])
    assert.equal((await publicUrlProblem(url, { lookup }))?.code, 'DOCUMENT_HOST_NOT_PUBLIC', url);
  for (const url of ['file:///etc/passwd', 'ftp://docs.example.test/x', 'gopher://docs.example.test/'])
    assert.equal((await publicUrlProblem(url, { lookup }))?.code, 'UNSUPPORTED_DOCUMENT_SCHEME', url);
  assert.equal((await publicUrlProblem('http://nowhere.example.test/', { lookup }))?.code, 'DOCUMENT_NOT_FOUND');
  assert.equal(await publicUrlProblem('https://docs.example.test/svc?wsdl', { lookup }), null);
  assert.equal(await publicUrlProblem('https://v6.example.test/svc?wsdl', { lookup }), null);
});

test('hosted: a document URL that is not public is DOCUMENT_HOST_NOT_PUBLIC before any request; a public one is pinned as before', async () => {
  const b = box();
  const lookup = fakeLookup({ 'docs.example.test': ['93.184.216.34'], 'intranet.example.test': ['10.0.0.5'] });
  for (const url of ['http://127.0.0.1:8080/svc.wsdl', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', 'http://[::1]/svc.wsdl',
    'http://2130706433/svc.wsdl', 'http://intranet.example.test/Calc.asmx?WSDL']) {
    const fetchImpl = fakeFetch({ [url]: WSDL });
    const prepared = await prepareIntegrationJob(b.job(url), { ...b.hosted, lookup, fetchImpl });
    assert.deepEqual([prepared.ok, prepared.code], [false, 'DOCUMENT_HOST_NOT_PUBLIC'], url + ': ' + JSON.stringify(prepared).slice(0, 300));
    assert.equal(prepared.problems[0].path, '/ops/0/data/wsdl');
    assert.deepEqual(fetchImpl.calls, [], url + ': nothing was requested');
  }
  assert.ok(!fs.existsSync(path.join(b.local, 'documents')));
  const url = 'https://docs.example.test/Calc.asmx?WSDL';
  const fetchImpl = fakeFetch({ [url]: WSDL });
  const prepared = await prepareIntegrationJob(b.job(url), { ...b.hosted, lookup, fetchImpl });
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 300));
  assert.deepEqual(fetchImpl.calls, [{ url, redirect: 'manual' }], 'hosted, the client never follows a redirect by itself');
});

test('hosted: each redirect hop is checked; a redirect to the metadata address, to loopback, to file: or a chain over the limit is refused there', async () => {
  const b = box();
  const lookup = fakeLookup({ 'docs.example.test': ['93.184.216.34'], 'cdn.example.test': ['93.184.216.35'] });
  const url = 'https://docs.example.test/Calc.asmx?WSDL';
  for (const location of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:9000/admin', 'http://[::1]/', 'file:///etc/passwd']) {
    const fetchImpl = fakeFetch({ [url]: { status: 302, location }, [location]: WSDL });
    const prepared = await prepareIntegrationJob(b.job(url), { ...b.hosted, lookup, fetchImpl });
    assert.equal(prepared.ok, false, location);
    assert.ok(['DOCUMENT_HOST_NOT_PUBLIC', 'UNSUPPORTED_DOCUMENT_SCHEME'].includes(prepared.code), location + ': ' + prepared.code);
    assert.deepEqual(fetchImpl.calls.map(c => c.url), [url], location + ': the target of the redirect was never requested');
  }
  // a redirect to another public host is followed (and its relative imports resolve against the final URL)
  const moved = 'https://cdn.example.test/v2/Calc.wsdl';
  const followed = fakeFetch({ [url]: { status: 301, location: moved }, [moved]: WSDL });
  const prepared = await prepareIntegrationJob(b.job(url), { ...b.hosted, lookup, fetchImpl: followed });
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 300));
  assert.equal(prepared.documents[0].source, moved);
  // more hops than the limit
  const table = {};
  for (let i = 0; i < 8; i++) table[`https://docs.example.test/${i}`] = { status: 307, location: `/${i + 1}` };
  const loop = fakeFetch(table);
  const chain = await prepareIntegrationJob(b.job('https://docs.example.test/0'), { ...b.hosted, lookup, fetchImpl: loop });
  assert.equal(chain.code, 'DOCUMENT_NOT_FOUND');
  assert.match(chain.error, /redirected more than 5 times/);
  assert.equal(loop.calls.length, 6);
});

test('hosted: an import or $ref of a public document that points at a private address is refused before it is requested', async () => {
  const b = box();
  const lookup = fakeLookup({ 'docs.example.test': ['93.184.216.34'], 'internal.example.test': ['192.168.10.4'] });
  const url = 'https://docs.example.test/svc/Calc.asmx?WSDL';
  for (const location of ['http://169.254.169.254/latest/user-data', 'http://internal.example.test/types.xsd', 'http://[fd00:ec2::254]/latest/']) {
    const main = WSDL.replace('<wsdl:types>', `<wsdl:types><s:schema><s:import namespace="urn:x" schemaLocation="${location}"/></s:schema>`);
    const fetchImpl = fakeFetch({ [url]: main, [location]: '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"/>' });
    const prepared = await prepareIntegrationJob(b.job(url), { ...b.hosted, lookup, fetchImpl });
    assert.deepEqual([prepared.ok, prepared.code], [false, 'DOCUMENT_HOST_NOT_PUBLIC'], location);
    assert.equal(prepared.problems[0].target, location);
    assert.deepEqual(fetchImpl.calls.map(c => c.url), [url], location);
  }
});

test('hosted, the default client: loopback by name or by address is never connected, even when the name turns private after the check (DNS rebinding); local use still reads it', async t => {
  const b = box();
  const target = await loopbackServer(t);
  // the real resolver: localhost is loopback; an address literal too
  for (const url of [`http://localhost:${target.port}/svc.wsdl`, `http://127.0.0.1:${target.port}/svc.wsdl`]) {
    const prepared = await prepareIntegrationJob(b.job(url), b.hosted);
    assert.deepEqual([prepared.ok, prepared.code], [false, 'DOCUMENT_HOST_NOT_PUBLIC'], url + ': ' + JSON.stringify(prepared).slice(0, 300));
  }
  // a name whose first answer is public and whose next is loopback: the check passes, the connection is refused
  let answers = 0;
  const rebinding = fakeLookup({ 'rebind.example.test': () => (answers++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']) });
  const prepared = await prepareIntegrationJob(b.job(`http://rebind.example.test:${target.port}/svc.wsdl`), { ...b.hosted, lookup: rebinding });
  assert.deepEqual([prepared.ok, prepared.code], [false, 'DOCUMENT_HOST_NOT_PUBLIC'], JSON.stringify(prepared).slice(0, 300));
  assert.ok(answers >= 2, 'the connection asked the name again and was refused');
  assert.deepEqual(target.seen, [], 'the loopback server never got a request');
  // local use (no workspace): the global fetch, as before
  const local = await prepareIntegrationJob(b.job(`http://127.0.0.1:${target.port}/svc.wsdl`), { ...b.hosted, workspace: null });
  assert.equal(local.ok, true, JSON.stringify(local).slice(0, 300));
  assert.deepEqual(target.seen, ['/svc.wsdl']);
});

test('createPublicFetch: connects to the address its lookup approved, answers the 3xx as it is and cuts a body over its limit', async t => {
  const big = await loopbackServer(t, 'x'.repeat(4096));
  const lookup = fakeLookup({ 'docs.example.test': ['127.0.0.1'] });
  // a policy that lets loopback through, only to see the client work end to end against the local server
  const open = createPublicFetch({ lookup, blocked: () => false, maxBytes: 1000 });
  const response = await open(`http://docs.example.test:${big.port}/a`, { headers: { 'user-agent': 'test' } });
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('Content-Type'), 'text/xml');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 1000 && bytes.length <= 4096, 'cut after the limit: ' + bytes.length);
  assert.deepEqual(big.seen, ['/a']);
  // a redirect comes back as it is (the document reader checks its target before following it)
  const seen = [];
  const redirecting = http.createServer((request, response) => { seen.push(request.url); response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); response.end(); });
  await new Promise(resolve => redirecting.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => redirecting.close(resolve)));
  const moved = await open(`http://docs.example.test:${redirecting.address().port}/r`);
  assert.deepEqual([moved.status, moved.ok, moved.headers.get('location')], [302, false, 'http://169.254.169.254/latest/meta-data/']);
  await moved.body.cancel();
  assert.deepEqual(seen, ['/r'], 'the client never followed it');
  // with the real policy the same name is refused at connect time
  await assert.rejects(createPublicFetch({ lookup })(`http://docs.example.test:${big.port}/b`), error => error.code === 'DOCUMENT_HOST_NOT_PUBLIC');
  await assert.rejects(createPublicFetch({ lookup })(`http://[::1]:${big.port}/c`), error => error.code === 'DOCUMENT_HOST_NOT_PUBLIC');
  assert.deepEqual(big.seen, ['/a']);
  assert.ok(MAX_DOCUMENT_BYTES > 1000);
});
