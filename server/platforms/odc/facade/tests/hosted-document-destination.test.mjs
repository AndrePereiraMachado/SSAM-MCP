// Destination of the integration documents on a hosted server (decision F4 of the integrator for the hosted delete
// stopgap's correction 1; finding 2.5 of the second blind proof of REST, C:\t\codex\prova-gen-rest-2\VEREDITO.md). The
// hosted line already has the lock (servidor/fase4-24, finding 3 of the confinement review: hosted/public-fetch.mjs, used
// by integration-documents.mjs prepareIntegrationJob for o11_deliver, studio_deliver, o11_job and ssam_job); this file
// proves it, case by case, for a WSDL and an OpenAPI document, their imports and $refs, and every redirect hop:
//   - the metadata address 169.254.169.254, loopback 127.0.0.1 and [::1], 10.0.0.5, 172.17.0.2, and a name the resolver
//     answers with a private address are DOCUMENT_HOST_NOT_PUBLIC, with no request to them;
//   - a public document that redirects to one of them, or imports one, is refused at that hop;
//   - DNS rebinding (first answer public, the next one private) never connects: the connection takes its address from
//     the checked resolution of the socket itself, so the address it connects to is the one approved;
//   - several blocked documents of one job come back in ONE refusal; a public document is still pinned; local use (no
//     hosted workspace) is unchanged.
// DNS and transport are stubs: a fake lookup, node:http/https request replaced by a recorder that resolves through the
// lookup the client hands it and answers from a table, globalThis.fetch replaced for local use, net.connect spied.
// Nothing leaves this process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

// ---- the stub transport, installed before the modules under test load
const require = createRequire(import.meta.url);
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const sockets = [];
net.connect = net.createConnection = (...args) => { sockets.push(args); throw new Error('no socket in this test'); };
// connects: every connection the client would open {host, address, url}; routes: {url: {status, location?, body?}}.
const transport = { connects: [], routes: {} };
function stubRequest(target, options = {}, onResponse) {
  const request = new EventEmitter();
  request.end = () => {
    const url = target.toString();
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const open = address => {
      transport.connects.push({ host, address, url });
      const route = transport.routes[url] ?? { status: 404 };
      const response = Readable.from(route.body === undefined ? [] : [Buffer.from(route.body, 'utf8')]);
      response.statusCode = route.status;
      response.headers = { 'content-type': 'text/xml', ...(route.location ? { location: route.location } : {}) };
      onResponse(response);
    };
    // As net.connect: an IP literal is connected as it is; a name through the lookup the client gave the request.
    if (net.isIP(host)) { setImmediate(() => open(host)); return; }
    options.lookup(host, {}, (error, address) => (error ? request.emit('error', error) : open(address)));
  };
  request.destroy = () => {};
  return request;
}
http.request = stubRequest;
https.request = stubRequest;
const fetched = [];
globalThis.fetch = async (url, init) => {
  fetched.push({ url: String(url), redirect: init?.redirect });
  const route = transport.routes[String(url)] ?? { status: 404 };
  const bytes = Buffer.from(route.body ?? '', 'utf8');
  return { ok: route.status >= 200 && route.status < 300, status: route.status, headers: { get: name => (name.toLowerCase() === 'location' ? route.location ?? null : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), body: { cancel: async () => {} } };
};
syncBuiltinESMExports();

const { prepareIntegrationJob } = await import('../integration-documents.mjs');
const { blockedAddress, createPublicFetch } = await import('../hosted/public-fetch.mjs');
const { hostedDirs, cleanupHostedDirs } = await import('./fixtures/fake-agent-link.mjs');
test.after(cleanupHostedDirs);

const here = path.dirname(fileURLToPath(import.meta.url));
const WSDL = fs.readFileSync(path.resolve(here, '..', '..', '..', '..', 'kernel', 'tests', 'fixtures', 'wsdl', 'calculator-two-ports.wsdl'), 'utf8');
const openApi = ref => JSON.stringify({ openapi: '3.0.1', info: { title: 'Orders', version: '1' }, paths: { '/orders/{id}': { get: { operationId: 'getOrder',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref ? { $ref: ref } : { type: 'object' } } } } } } } } });
const XSD = '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:x"/>';
const wsdlImporting = location => WSDL.replace('<wsdl:types>', `<wsdl:types><s:schema><s:import namespace="urn:x" schemaLocation="${location}"/></s:schema>`);

// The stub resolver: public names, a name that answers a private address, and a rebinding name.
const PUBLIC = '93.184.216.34';
function stubLookup() {
  const asked = [];
  let rebinds = 0;
  const table = { 'docs.example.test': [PUBLIC], 'cdn.example.test': ['93.184.216.35'], 'intranet.example.test': ['172.17.0.2'],
    'metadata.example.test': ['169.254.169.254'], 'rebind.example.test': () => (rebinds++ === 0 ? [PUBLIC] : ['10.0.0.5']) };
  const lookup = (host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    asked.push(host);
    const entry = table[host];
    const list = (typeof entry === 'function' ? entry() : entry ?? []).map(address => ({ address, family: net.isIP(address) }));
    if (!list.length) return callback(Object.assign(new Error('getaddrinfo ENOTFOUND ' + host), { code: 'ENOTFOUND' }));
    return options?.all ? callback(null, list) : callback(null, list[0].address, list[0].family);
  };
  lookup.asked = asked;
  return lookup;
}
// The destinations of the decision: by address and by a name that resolves privately.
const INTERNAL = ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8080/svc', 'http://10.0.0.5/svc', 'http://172.17.0.2/svc',
  'http://[::1]/svc', 'http://intranet.example.test/svc', 'http://metadata.example.test/computeMetadata/v1/'];
const internalConnects = () => transport.connects.filter(c => blockedAddress(c.address));
function box() {
  const dirs = hostedDirs(os.tmpdir());
  const local = path.join(dirs.workspace, 'odc', '.local');
  const write = ops => { const file = path.join(dirs.workspace, 'inbox', 'job-' + Math.random().toString(36).slice(2) + '.json'); fs.writeFileSync(file, JSON.stringify({ ops })); return file; };
  return { ...dirs, local, write };
}
const soap = url => ({ op: 'soap', data: { wsdl: url, methods: ['Add'] } });
const rest = url => ({ op: 'rest', data: { client: { name: 'OrdersApi' }, openapi: { path: url, operations: ['getOrder'] } } });
const KINDS = [['WSDL', soap, 'o11', '/ops/0/data/wsdl'], ['OpenAPI', rest, 'odc', '/ops/0/data/openapi/path']];
// prepareIntegrationJob as a hosted call runs it: the customer's workspace, the default client (createPublicFetch).
const hosted = (b, lane, lookup) => ({ lane, localRoot: b.local, destructive: false, workspace: b.workspace, lookup });
const reset = routes => { transport.connects.length = 0; transport.routes = routes; };

test('hosted: a WSDL or OpenAPI document at an internal address or name is DOCUMENT_HOST_NOT_PUBLIC, and nothing is requested there', async () => {
  for (const [kind, op, lane, pointer] of KINDS) for (const url of INTERNAL) {
    const b = box();
    reset({ [url]: { status: 200, body: kind === 'WSDL' ? WSDL : openApi() } });
    const prepared = await prepareIntegrationJob(b.write([op(url)]), hosted(b, lane, stubLookup()));
    assert.deepEqual([prepared.ok, prepared.code], [false, 'DOCUMENT_HOST_NOT_PUBLIC'], kind + ' ' + url + ': ' + JSON.stringify(prepared).slice(0, 300));
    assert.equal(prepared.problems[0].path, pointer, kind + ' ' + url);
    assert.deepEqual(transport.connects, [], kind + ' ' + url + ': no connection at all');
    assert.ok(!fs.existsSync(path.join(b.local, 'documents')), kind + ' ' + url + ': nothing pinned');
  }
  assert.deepEqual(fetched, []); assert.deepEqual(sockets, []);
});

test('hosted: a public document that redirects to an internal address, or imports/$refs one, is refused at that hop; only the public address is reached', async () => {
  const main = { WSDL: 'https://docs.example.test/svc/Calc.asmx?WSDL', OpenAPI: 'https://docs.example.test/api/openapi.json' };
  for (const [kind, op, lane] of KINDS) for (const target of INTERNAL) {
    // redirect public -> internal
    let b = box();
    reset({ [main[kind]]: { status: 302, location: target }, [target]: { status: 200, body: kind === 'WSDL' ? WSDL : openApi() } });
    let prepared = await prepareIntegrationJob(b.write([op(main[kind])]), hosted(b, lane, stubLookup()));
    assert.deepEqual([prepared.ok, prepared.code], [false, 'DOCUMENT_HOST_NOT_PUBLIC'], kind + ' redirect ' + target + ': ' + JSON.stringify(prepared).slice(0, 300));
    assert.deepEqual(transport.connects.map(c => [c.address, c.url]), [[PUBLIC, main[kind]]], kind + ' redirect ' + target);
    // import (WSDL schemaLocation) or external $ref (OpenAPI) -> internal
    b = box();
    reset({ [main[kind]]: { status: 200, body: kind === 'WSDL' ? wsdlImporting(target) : openApi(target + '#/Order') }, [target]: { status: 200, body: kind === 'WSDL' ? XSD : '{"Order":{"type":"object"}}' } });
    prepared = await prepareIntegrationJob(b.write([op(main[kind])]), hosted(b, lane, stubLookup()));
    assert.deepEqual([prepared.ok, prepared.code], [false, 'DOCUMENT_HOST_NOT_PUBLIC'], kind + ' import ' + target + ': ' + JSON.stringify(prepared).slice(0, 300));
    assert.equal(prepared.problems[0].target, target, kind + ' import ' + target);
    assert.deepEqual(transport.connects.map(c => [c.address, c.url]), [[PUBLIC, main[kind]]], kind + ' import ' + target);
  }
  assert.deepEqual(internalConnects(), []); assert.deepEqual(fetched, []); assert.deepEqual(sockets, []);
});

test('hosted: DNS rebinding (first answer public, the next private) never connects; the connection takes the address its own checked lookup approved', async () => {
  for (const [kind, op, lane] of KINDS) {
    const b = box();
    const url = kind === 'WSDL' ? 'http://rebind.example.test/svc.wsdl' : 'http://rebind.example.test/openapi.json';
    reset({ [url]: { status: 200, body: kind === 'WSDL' ? WSDL : openApi() } });
    const lookup = stubLookup();
    const prepared = await prepareIntegrationJob(b.write([op(url)]), hosted(b, lane, lookup));
    assert.deepEqual([prepared.ok, prepared.code], [false, 'DOCUMENT_HOST_NOT_PUBLIC'], kind + ': ' + JSON.stringify(prepared).slice(0, 300));
    assert.deepEqual(lookup.asked, ['rebind.example.test', 'rebind.example.test'], kind + ': the check, then the socket\'s own lookup, which refused');
    assert.deepEqual(transport.connects, [], kind + ': no connection');
  }
  // The client alone: the address handed to the connection is the one its checked lookup returned, and a public name
  // whose next answer is private is refused at connect time.
  reset({ 'https://docs.example.test/a': { status: 200, body: 'x' }, 'http://rebind.example.test/b': { status: 200, body: 'x' } });
  const lookup = stubLookup();
  const client = createPublicFetch({ lookup });
  const response = await client('https://docs.example.test/a');
  assert.equal(response.ok, true);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'x');
  assert.deepEqual(transport.connects.map(c => [c.host, c.address]), [['docs.example.test', PUBLIC]]);
  lookup('rebind.example.test', {}, () => {}); // the first (public) answer goes to a check elsewhere
  await assert.rejects(client('http://rebind.example.test/b'), error => error.code === 'DOCUMENT_HOST_NOT_PUBLIC');
  for (const literal of ['http://169.254.169.254/x', 'http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://172.17.0.2/x', 'http://[::1]/x'])
    await assert.rejects(client(literal), error => error.code === 'DOCUMENT_HOST_NOT_PUBLIC', literal);
  assert.deepEqual(transport.connects.map(c => c.address), [PUBLIC]);
  assert.deepEqual(internalConnects(), []); assert.deepEqual(fetched, []); assert.deepEqual(sockets, []);
});

test('hosted: every blocked document of a job comes back in one refusal; a public document is still pinned; local use is unchanged', async () => {
  let b = box();
  reset({});
  const many = await prepareIntegrationJob(b.write([soap('http://169.254.169.254/latest/meta-data/'), rest('http://10.0.0.5/openapi.json'), soap('http://intranet.example.test/svc')]), hosted(b, 'o11', stubLookup()));
  assert.deepEqual([many.ok, many.code], [false, 'DOCUMENT_HOST_NOT_PUBLIC']);
  assert.deepEqual(many.problems.map(p => [p.code, p.path]), [['DOCUMENT_HOST_NOT_PUBLIC', '/ops/0/data/wsdl'], ['DOCUMENT_HOST_NOT_PUBLIC', '/ops/1/data/openapi/path'], ['DOCUMENT_HOST_NOT_PUBLIC', '/ops/2/data/wsdl']]);
  assert.match(many.error, /Nothing was captured or sent/);
  assert.deepEqual(transport.connects, []);
  // public: pinned with its sha256, through the public address only, redirects followed one by one
  for (const [kind, op, lane] of KINDS) {
    b = box();
    const url = kind === 'WSDL' ? 'https://docs.example.test/svc/Calc.asmx?WSDL' : 'https://docs.example.test/api/openapi.json';
    const moved = kind === 'WSDL' ? 'https://cdn.example.test/v2/Calc.wsdl' : 'https://cdn.example.test/v2/openapi.json';
    reset({ [url]: { status: 301, location: moved }, [moved]: { status: 200, body: kind === 'WSDL' ? WSDL : openApi() } });
    const prepared = await prepareIntegrationJob(b.write([op(url)]), hosted(b, lane, stubLookup()));
    assert.equal(prepared.ok, true, kind + ': ' + JSON.stringify(prepared).slice(0, 300));
    assert.equal(prepared.documents[0].source, moved, kind);
    assert.deepEqual(transport.connects.map(c => c.address), [PUBLIC, '93.184.216.35'], kind);
  }
  // local use (no hosted workspace): the global fetch, as before, with no destination rule
  b = box();
  reset({ 'http://127.0.0.1:8080/svc.wsdl': { status: 200, body: WSDL } });
  const local = await prepareIntegrationJob(b.write([soap('http://127.0.0.1:8080/svc.wsdl')]), { lane: 'o11', localRoot: b.local, destructive: false, workspace: null });
  assert.equal(local.ok, true, JSON.stringify(local).slice(0, 300));
  assert.deepEqual(fetched, [{ url: 'http://127.0.0.1:8080/svc.wsdl', redirect: 'follow' }], 'local use reads it with the global fetch, redirects followed');
  assert.deepEqual(transport.connects, []); assert.deepEqual(sockets, []);
});
