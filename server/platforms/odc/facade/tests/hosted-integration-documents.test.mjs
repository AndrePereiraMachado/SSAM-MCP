// Finding 1 of the confinement review of the 24th release (servidor/fase4-24): the gate confined the document fields of a
// soap/rest op (job-paths.mjs), but the pinning step (integration-documents.mjs pin/readDocument, run after the gate by
// ssam_job/o11_job, studio_deliver and o11_deliver) then followed the xsd/wsdl imports and the OpenAPI $ref written INSIDE
// a document and read them from the server's disk: an absolute path, a file: URL, a ../ name relative to the document, a
// link inside the workspace that leads out, even a local path named by a document fetched by URL. The bytes were copied
// into the customer's .local/documents and their source, sha256 and size answered. Hosted (a workspace, given or taken
// from the hosted call), every local file is inside the visible area of the workspace by its lexical and its real path,
// or PATH_OUTSIDE_WORKSPACE naming the job pointer and the reference, and nothing is read or pinned. Also here: the job
// copy the pinning writes elsewhere keeps naming the files its job:<name> base and producers and its relative documents
// named from the job's folder (the kernel would go on to the server's repository), and a pinned import never lands
// outside <localRoot>/documents/<sha256>/ (a name like x/../../../evil.xsd). A fake fetch and lookup: no network.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareIntegrationJob } from '../integration-documents.mjs';
import { runWithExecutor } from '../executor.mjs';
import { hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const WSDL = fs.readFileSync(path.join(kernel, 'tests', 'fixtures', 'wsdl', 'calculator-two-ports.wsdl'), 'utf8');
const ORDERS = fs.readFileSync(path.join(kernel, 'tests', 'fixtures', 'openapi', 'orders-3.0.json'), 'utf8');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const SECRET = '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:server-secret"/>';
const SECRET_JSON = JSON.stringify({ Order: { type: 'object', description: 'server secret' } });
const PUBLIC = (host, options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const wsdlImporting = location => WSDL.replace('<wsdl:types>', `<wsdl:types><s:schema><s:import namespace="urn:x" schemaLocation="${location}"/></s:schema>`);
const openApiReferring = ref => { const doc = JSON.parse(ORDERS); doc.components.schemas.Order = { $ref: ref + '#/Order' }; return JSON.stringify(doc); };

function box() {
  const dirs = hostedDirs(os.tmpdir());
  const ws = (...p) => path.join(dirs.workspace, ...p);
  // What a hosted customer must never read: a file of this server, another customer's file, a folder behind a link inside
  // the workspace that leads out of it.
  const outside = path.join(dirs.root, 'outside');
  const secret = write(path.join(outside, 'secret.xsd'), SECRET);
  write(path.join(outside, 'secret.json'), SECRET_JSON);
  const other = write(path.join(dirs.root, 'server', 'customers', 'tok_other', 'inbox', 'secret.xsd'), SECRET);
  fs.symlinkSync(outside, ws('inbox', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const local = ws('odc', '.local');
  const job = (ops, extra = {}, name = 'job.json') => write(ws('inbox', name), { ...extra, ops });
  const hosted = { lane: 'o11', localRoot: local, destructive: false, workspace: dirs.workspace, lookup: PUBLIC };
  return { ...dirs, ws, outside, secret, other, local, job, hosted };
}
// The references a document may write that leave the workspace, as seen from <ws>/inbox/svc/<document>.
function escapes(b, ext) {
  const target = path.join(b.outside, 'secret' + ext);
  return {
    'an absolute path of this server': target,
    'a file: URL': pathToFileURL(target).href,
    'a ../ name relative to the document': path.relative(b.ws('inbox', 'svc'), target).replace(/\\/g, '/'),
    "another customer's file": ext === '.xsd' ? b.other : path.join(path.dirname(b.other), 'secret' + ext),
    'a link inside the workspace that leads out': '../link/secret' + ext,
    ...(process.platform === 'win32' ? { 'a UNC path': '\\\\fileserver\\share\\secret' + ext } : {}),
  };
}
const refused = (prepared, pointer, reference, what) => {
  assert.equal(prepared.ok, false, what + ': ' + JSON.stringify(prepared).slice(0, 300));
  assert.equal(prepared.code, 'PATH_OUTSIDE_WORKSPACE', what + ': ' + JSON.stringify(prepared).slice(0, 300));
  const p = prepared.problems.find(x => x.code === 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(p.path, pointer, what);
  if (reference !== undefined) assert.equal(p.target ?? p.reference, reference, what);
  for (const content of [SECRET, SECRET_JSON]) assert.ok(!JSON.stringify(prepared).includes(sha256(content)), what + ': the answer never carries a server file\'s hash');
};
const pinnedHashes = local => {
  const out = [];
  const walk = dir => { for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else out.push(sha256(fs.readFileSync(f))); } };
  walk(path.join(local, 'documents'));
  return out;
};

test('hosted: an import of a workspace WSDL that leads out of the workspace is PATH_OUTSIDE_WORKSPACE with the job pointer and the reference; nothing is read or pinned', async () => {
  const b = box();
  let checked = 0;
  for (const [label, reference] of Object.entries(escapes(b, '.xsd'))) {
    write(b.ws('inbox', 'svc', 'service.wsdl'), wsdlImporting(reference));
    const job = b.job([{ op: 'soap', data: { wsdl: b.ws('inbox', 'svc', 'service.wsdl'), methods: ['Add'] } }]);
    refused(await prepareIntegrationJob(job, b.hosted), '/ops/0/data/wsdl', reference, label);
    // the same from the hosted call itself (no workspace option): the context's workspace confines
    const context = { hosted: true, workspace: b.workspace, executor: { call: async () => { throw new Error('no machine call'); } } };
    refused(await runWithExecutor(context, () => prepareIntegrationJob(job, { lane: 'o11', localRoot: b.local, destructive: false })), '/ops/0/data/wsdl', reference, label + ' (hosted context)');
    checked++;
  }
  assert.ok(checked >= 5);
  assert.ok(!pinnedHashes(b.local).includes(sha256(SECRET)), 'no server file was pinned into the workspace');
  assert.ok(!fs.existsSync(path.join(b.local, 'documents')), 'nothing pinned at all');
});

test('hosted: an OpenAPI $ref that leads out of the workspace is PATH_OUTSIDE_WORKSPACE with the job pointer and the reference', async () => {
  const b = box();
  for (const [label, reference] of Object.entries(escapes(b, '.json'))) {
    if (label === "another customer's file") write(reference, SECRET_JSON);
    write(b.ws('inbox', 'svc', 'openapi.json'), openApiReferring(reference));
    const job = b.job([{ op: 'rest', data: { client: { name: 'OrdersApi' }, openapi: { path: b.ws('inbox', 'svc', 'openapi.json'), operations: ['getOrder'] } } }]);
    refused(await prepareIntegrationJob(job, { ...b.hosted, lane: 'odc' }), '/ops/0/data/openapi/path', reference, label);
  }
  assert.ok(!pinnedHashes(b.local).includes(sha256(SECRET_JSON)));
});

test('hosted: the main document outside the workspace, or a relative one the job\'s folder does not have, is refused (the gate bypassed)', async () => {
  const b = box();
  refused(await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: b.secret, methods: ['Add'] } }]), b.hosted), '/ops/0/data/wsdl', undefined, 'absolute');
  refused(await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: pathToFileURL(b.secret).href, methods: ['Add'] } }]), b.hosted), '/ops/0/data/wsdl', undefined, 'file: URL');
  refused(await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: b.ws('inbox', 'link', 'secret.xsd'), methods: ['Add'] } }]), b.hosted), '/ops/0/data/wsdl', undefined, 'through a link');
  // a relative name the kernel would look up in its repository (tests/fixtures/wsdl/...): local use leaves it to the kernel
  const suite = b.job([{ op: 'soap', data: { wsdl: 'tests/fixtures/wsdl/calculator-two-ports.wsdl', methods: ['Add'] } }]);
  refused(await prepareIntegrationJob(suite, b.hosted), '/ops/0/data/wsdl', undefined, 'relative, not in the job\'s folder');
  assert.equal((await prepareIntegrationJob(suite, { ...b.hosted, workspace: null })).changed, false, 'local use: the kernel resolves it');
});

test('hosted: a document read by URL names only URLs: a file: or drive-letter reference is refused, a root-relative one is its server\'s URL', async () => {
  const b = box();
  const calls = [];
  const table = {};
  const fetchImpl = async url => { calls.push(String(url)); const body = table[String(url)];
    return body === undefined ? { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
      : { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => { const x = Buffer.from(body); return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength); } }; };
  const url = 'https://docs.example.test/svc/Calc.asmx?WSDL';
  for (const reference of [pathToFileURL(b.secret).href, 'C:\\server\\secret.xsd', 'C:/server/secret.xsd']) {
    table[url] = wsdlImporting(reference);
    calls.length = 0;
    const prepared = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: url, methods: ['Add'] } }]), { ...b.hosted, fetchImpl });
    refused(prepared, '/ops/0/data/wsdl', reference, reference);
    assert.match(prepared.problems[0].message, /names only URLs/);
    assert.deepEqual(calls, [url], 'only the document itself was fetched');
  }
  // a root-relative name is a URL of the document's own server, never a file of this one
  table[url] = wsdlImporting('/schemas/types.xsd');
  table['https://docs.example.test/schemas/types.xsd'] = '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:x"/>';
  const prepared = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: url, methods: ['Add'] } }]), { ...b.hosted, fetchImpl });
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 300));
  assert.deepEqual(prepared.documents.map(d => d.source), [url, 'https://docs.example.test/schemas/types.xsd']);
});

test('hosted: a WSDL and its imports inside the workspace are pinned as before, into the workspace', async () => {
  const b = box();
  const xsd = '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:x"/>';
  write(b.ws('inbox', 'svc', 'types', 'common.xsd'), xsd);
  write(b.ws('inbox', 'svc', 'service.wsdl'), wsdlImporting('types/common.xsd'));
  const prepared = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: b.ws('inbox', 'svc', 'service.wsdl'), methods: ['Add'] } }]), b.hosted);
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 300));
  assert.deepEqual(prepared.documents.map(d => d.source), [b.ws('inbox', 'svc', 'service.wsdl'), b.ws('inbox', 'svc', 'types', 'common.xsd')]);
  for (const d of prepared.documents) assert.ok(d.path.startsWith(b.local + path.sep), d.path);
  // a WSDL next to the job, named relative to it (the gate accepts it there): read from the job's folder
  write(b.ws('inbox', 'service.wsdl'), WSDL);
  assert.equal((await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: 'service.wsdl', methods: ['Add'] } }]), b.hosted)).ok, true);
});

test('the job copy keeps naming, from the job\'s folder, its job:<name> base and producers and the documents of its other ops', async () => {
  const b = box();
  write(b.ws('inbox', 'service.wsdl'), WSDL);
  write(b.ws('inbox', 'ex-base.json'), { ops: [] });
  write(b.ws('inbox', 'prod.json'), { ops: [] });
  // a document already pinned ({path, sha256}) is not pinned again: the kernel resolves its path against the job's folder
  const pinned = write(b.ws('inbox', 'pinned.wsdl'), WSDL);
  const job = b.job([{ op: 'soap', data: { wsdl: 'service.wsdl', methods: ['Add'] } }, { op: 'reference', producer: 'job:prod', elements: ['IServerAction:A'] },
    { op: 'soap', data: { wsdl: { path: 'pinned.wsdl', sha256: sha256(WSDL) }, methods: ['Subtract'] } }], { base: 'job:ex-base' });
  const prepared = await prepareIntegrationJob(job, b.hosted);
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 300));
  assert.notEqual(path.dirname(prepared.job), path.dirname(job), 'the copy lives in the lane\'s folder');
  const copy = JSON.parse(fs.readFileSync(prepared.job, 'utf8'));
  // otherwise the kernel looks for <name>.json next to the copy, then in the repository's tests/jobs (the server's)
  assert.equal(copy.base, 'job:' + b.ws('inbox', 'ex-base'));
  assert.equal(copy.ops[1].producer, 'job:' + b.ws('inbox', 'prod'));
  assert.equal(copy.ops[2].data.wsdl.path, pinned);
});

test('a pinned import never lands outside its documents folder (a relative name that climbs through a/../../..)', async () => {
  const b = box();
  // hosted: a WSDL deep in the workspace imports a file of the workspace by a name that, joined to the pinned folder, would climb out
  const deep = b.ws('inbox', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6');
  write(b.ws('inbox', 't.xsd'), '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t"/>');
  const climbing = 'x/' + '../'.repeat(7) + 't.xsd';
  write(path.join(deep, 'service.wsdl'), wsdlImporting(climbing));
  const prepared = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: path.join(deep, 'service.wsdl'), methods: ['Add'] } }]), b.hosted);
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 300));
  const folder = path.dirname(prepared.documents[0].path);
  for (const d of prepared.documents) assert.ok(d.path.startsWith(folder + path.sep), d.path + ' inside ' + folder);
  assert.ok(!fs.existsSync(path.join(b.root, 'server', 't.xsd')), 'nothing written outside the workspace');
  // local use too: a document read by URL decides the bytes, and its name decided where they were written
  const fetchImpl = async url => { const body = String(url).endsWith('evil.xsd') ? '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"/>' : wsdlImporting('x/' + '../'.repeat(12) + 'evil.xsd');
    const x = Buffer.from(body); return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) }; };
  const local = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: 'https://example.invalid/a/b/c/d/e/f/g/h/i/j/svc.wsdl', methods: ['Add'] } }]), { ...b.hosted, workspace: null, fetchImpl });
  assert.equal(local.ok, true, JSON.stringify(local).slice(0, 300));
  const pinned = path.dirname(local.documents[0].path);
  for (const d of local.documents) assert.ok(d.path.startsWith(pinned + path.sep), d.path);
  assert.ok(!fs.existsSync(path.join(b.root, 'evil.xsd')) && !fs.existsSync(path.join(path.parse(b.root).root, 'evil.xsd')));
});

// servidor/fase4-25 (G1 of C:\t\vps-a5\CORRECAO.md): the rest-consume op of marco-a5 reads one GET sample per method
// without one. Hosted, that GET goes through the public-only client like every document of the job (hosted/public-fetch.mjs),
// never through the global fetch of the server: an internal address answers REST_CONSUME_SAMPLE_FETCH_FAILED and nothing is
// pinned in the job.
test('hosted: a rest-consume sample is read only by the public-only client, never by the global fetch (no internal address)', async () => {
  const b = box();
  const job = b.job([{ op: 'rest-consume', data: { name: 'Internal', methods: [{ name: 'Probe', url: 'http://127.0.0.1:9/internal' }] } }]);
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, options) => { asked.push({ url: String(url), redirect: options?.redirect ?? null }); return new Response('{"internal":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  let result;
  try { result = await prepareIntegrationJob(job, { ...b.hosted, localRoot: b.ws('o11', '.local') }); }
  finally { globalThis.fetch = original; }
  assert.deepEqual(asked, [], 'the global fetch of the server was never called');
  assert.equal(result.ok, false);
  const sample = (result.problems ?? []).find(p => p.code === 'REST_CONSUME_SAMPLE_FETCH_FAILED');
  assert.ok(sample, JSON.stringify(result.problems));
  assert.match(sample.message ?? sample.error ?? JSON.stringify(sample), /not public|127\.0\.0\.1/);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(job, 'utf8'))).includes('"internal"'), false, 'no sample was written into the job');
});
