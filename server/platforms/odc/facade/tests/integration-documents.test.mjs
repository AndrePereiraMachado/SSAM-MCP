// The documents of the integration ops (integration-documents.mjs, interface I6): a WSDL or OpenAPI document is read
// once with its imports, pinned under <localRoot>/documents/<sha256>/ and the op rewritten to {path, sha256, source};
// the limits (5 MB, DTD/ENTITY, schemes) refuse before anything else. A fake fetch only: no network.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareIntegrationJob, wsdlImports, openApiReferences, MAX_DOCUMENT_BYTES, wrapData, DATA_KEYS, DATA_WRAPPED } from '../integration-documents.mjs';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const WSDL = path.join(kernel, 'tests', 'fixtures', 'wsdl', 'calculator-two-ports.wsdl');
const ORDERS = path.join(kernel, 'tests', 'fixtures', 'openapi', 'orders-3.0.json');
const sha256 = data => createHash('sha256').update(data).digest('hex');

function box(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-documents-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const local = path.join(base, '.local');
  const job = (ops, extra = {}) => { const file = path.join(base, 'jobs', Math.random().toString(16).slice(2) + '.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...extra, ops })); return file; };
  return { base, local, job };
}

// A fetch that answers from a table {url: body | {status, body, headers}} and records every call.
function fakeFetch(table) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    const entry = table[String(url)];
    if (entry === undefined) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = typeof entry === 'string' || Buffer.isBuffer(entry) ? entry : entry.body;
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    return { ok: (entry.status ?? 200) < 400, status: entry.status ?? 200, headers: { get: name => entry.headers?.[name.toLowerCase()] ?? null },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('a local WSDL is pinned and the op rewritten to {path, sha256, source}', async t => {
  const b = box(t);
  const original = b.job([{ op: 'soap', data: { wsdl: WSDL, port: 'CalculatorSoap', methods: ['Add'] } }], { base: 'tests/fixtures/blank-service.oml' });
  const prepared = await prepareIntegrationJob(original, { lane: 'o11', localRoot: b.local, destructive: false });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.changed, true);
  assert.notEqual(prepared.job, original);
  const digest = sha256(fs.readFileSync(WSDL));
  const op = JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops[0];
  assert.deepEqual(Object.keys(op.data.wsdl).sort(), ['path', 'sha256', 'source']);
  assert.equal(op.data.wsdl.sha256, digest);
  assert.equal(op.data.wsdl.source, WSDL);
  assert.equal(op.data.wsdl.path, path.join(b.local, 'documents', digest, 'calculator-two-ports.wsdl'));
  assert.equal(sha256(fs.readFileSync(op.data.wsdl.path)), digest);
  assert.deepEqual(prepared.documents.map(d => d.sha256), [digest]);
  // The same call again: the same pinned bytes and the same job copy (a resume reads what was planned).
  const again = await prepareIntegrationJob(original, { lane: 'o11', localRoot: b.local, destructive: false });
  assert.equal(again.job, prepared.job);
  // A job already pinned ({path, sha256}) and a job without integration ops are left as they are.
  assert.equal((await prepareIntegrationJob(prepared.job, { lane: 'o11', localRoot: b.local })).changed, false);
  const plain = b.job([{ op: 'get', target: 'IServerAction:X' }]);
  assert.deepEqual(await prepareIntegrationJob(plain, { localRoot: b.local }), { ok: true, job: plain, changed: false, documents: [] });
});

test('a .wso page is retried at its ?WSDL companion', async t => {
  const b = box(t);
  const wsdl = fs.readFileSync(WSDL, 'utf8');
  const fetchImpl = fakeFetch({ 'https://example.invalid/Calc.wso': '<html><body>DataFlex service page</body></html>', 'https://example.invalid/Calc.wso?WSDL': wsdl });
  const prepared = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: 'https://example.invalid/Calc.wso', methods: ['Add'] } }]), { localRoot: b.local, fetchImpl, destructive: false });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.deepEqual(fetchImpl.calls, ['https://example.invalid/Calc.wso', 'https://example.invalid/Calc.wso?WSDL']);
  const op = JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops[0];
  assert.equal(op.data.wsdl.source, 'https://example.invalid/Calc.wso?WSDL');
  assert.equal(op.data.wsdl.sha256, sha256(Buffer.from(wsdl, 'utf8')));
});

test('the imports of a WSDL are pinned next to it with their relative names', async t => {
  const b = box(t);
  const main = fs.readFileSync(WSDL, 'utf8').replace('<wsdl:types>', '<wsdl:types><s:schema><s:import namespace="urn:x" schemaLocation="types/common.xsd"/></s:schema>');
  const xsd = '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:x"/>';
  const fetchImpl = fakeFetch({ 'https://example.invalid/svc/Calc.asmx?WSDL': main, 'https://example.invalid/svc/types/common.xsd': xsd });
  const prepared = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: 'https://example.invalid/svc/Calc.asmx?WSDL', methods: ['Add'] } }]), { localRoot: b.local, fetchImpl, destructive: false });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const pinned = JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops[0].data.wsdl;
  assert.deepEqual(Object.keys(pinned.imports), ['types/common.xsd']);
  assert.equal(pinned.imports['types/common.xsd'].path, path.join(path.dirname(pinned.path), 'types', 'common.xsd'));
  assert.equal(pinned.imports['types/common.xsd'].sha256, sha256(Buffer.from(xsd, 'utf8')));
  assert.deepEqual(wsdlImports(main), ['types/common.xsd']);
});

test('the limits refuse before anything: 5 MB, DTD/ENTITY, an unsupported scheme, a missing file', async t => {
  const b = box(t);
  const big = fakeFetch({ 'https://example.invalid/big.wsdl': Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x20) });
  const tooLarge = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: 'https://example.invalid/big.wsdl', methods: ['Add'] } }]), { localRoot: b.local, fetchImpl: big, destructive: false });
  assert.equal(tooLarge.code, 'DOCUMENT_TOO_LARGE');
  const declared = fakeFetch({ 'https://example.invalid/declared.wsdl': { body: '<x/>', headers: { 'content-length': String(MAX_DOCUMENT_BYTES + 10) } } });
  assert.equal((await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: 'https://example.invalid/declared.wsdl', methods: ['Add'] } }]), { localRoot: b.local, fetchImpl: declared, destructive: false })).code, 'DOCUMENT_TOO_LARGE');
  const dtd = path.join(b.base, 'dtd.wsdl'); fs.writeFileSync(dtd, '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY e "x">]><definitions/>');
  const unsafe = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: dtd, methods: ['Add'] } }]), { localRoot: b.local, destructive: false });
  assert.equal(unsafe.code, 'UNSAFE_WSDL_XML');
  const scheme = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: 'ftp://example.invalid/Calc.wsdl', methods: ['Add'] } }]), { localRoot: b.local, destructive: false });
  assert.equal(scheme.code, 'UNSUPPORTED_DOCUMENT_SCHEME');
  const missing = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: path.join(b.base, 'nope.wsdl'), methods: ['Add'] } }]), { localRoot: b.local, destructive: false });
  assert.equal(missing.code, 'DOCUMENT_NOT_FOUND');
  // Every problem of the job at once, and nothing pinned.
  const both = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: dtd, methods: ['Add'] } }, { op: 'soap', data: { wsdl: 'ftp://x/y', methods: ['Add'] } }]), { localRoot: b.local, destructive: false });
  assert.deepEqual(both.problems.map(p => p.code), ['UNSAFE_WSDL_XML', 'UNSUPPORTED_DOCUMENT_SCHEME']);
  assert.ok(!fs.existsSync(path.join(b.local, 'documents')));
  // SOAP is not an ODC operation.
  assert.equal((await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: WSDL, methods: ['Add'] } }]), { lane: 'odc', localRoot: b.local, destructive: false })).code, 'SOAP_LANE_UNSUPPORTED');
});

test('an OpenAPI document is pinned with its external $ref bundled for the kernel', async t => {
  const b = box(t);
  const doc = JSON.parse(fs.readFileSync(ORDERS, 'utf8'));
  doc.components.schemas.Order = { $ref: './schemas/order.json#/Order' };
  const order = JSON.stringify({ Order: { type: 'object', properties: { id: { type: 'integer' } } } });
  const fetchImpl = fakeFetch({ 'https://example.invalid/api/openapi.json': JSON.stringify(doc), 'https://example.invalid/api/schemas/order.json': order });
  const prepared = await prepareIntegrationJob(b.job([{ op: 'rest', data: { client: { name: 'OrdersApi' }, openapi: { path: 'https://example.invalid/api/openapi.json', operations: ['getOrder'] } } }]), { lane: 'odc', localRoot: b.local, fetchImpl });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const openapi = JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops[0].data.openapi;
  assert.equal(openapi.source, 'https://example.invalid/api/openapi.json');
  assert.deepEqual(openapi.operations, ['getOrder']);
  assert.deepEqual(Object.keys(openapi.external), ['./schemas/order.json']);
  assert.equal(openapi.external['./schemas/order.json'].sha256, sha256(Buffer.from(order, 'utf8')));
  assert.equal(fs.readFileSync(openapi.external['./schemas/order.json'].path, 'utf8'), order);
  assert.deepEqual(openApiReferences(doc), ['./schemas/order.json']);
  assert.equal(fetchImpl.calls.length, 2);
});

// ---- F7 (25/10/2026): an op written without data (OP_DATA_WRAPPED) ---------------------------------------------------

test('a soap op without data has its WSDL pinned as the same op with data, and the job keeps the op as sent', async t => {
  const b = box(t);
  const wsdl = fs.readFileSync(WSDL, 'utf8');
  const fetchImpl = fakeFetch({ 'https://example.invalid/Calc.asmx?WSDL': wsdl });
  const bare = await prepareIntegrationJob(b.job([{ op: 'soap', wsdl: 'https://example.invalid/Calc.asmx?WSDL', port: 'CalculatorSoap', methods: ['Add'] }]), { localRoot: b.local, fetchImpl, destructive: false });
  const wrapped = await prepareIntegrationJob(b.job([{ op: 'soap', data: { wsdl: 'https://example.invalid/Calc.asmx?WSDL', port: 'CalculatorSoap', methods: ['Add'] } }]), { localRoot: b.local, fetchImpl, destructive: false });
  assert.equal(bare.ok, true, JSON.stringify(bare));
  assert.deepEqual(bare.normalizations, [{ rule: DATA_WRAPPED, path: '/ops/0', from: 'wsdl, port, methods', to: 'data',
    message: 'soap: wsdl, port, methods are keys of the op\'s data and went into "data": {...} (the op\'s only shape)' }]);
  assert.equal(wrapped.normalizations, undefined);
  const sent = JSON.parse(fs.readFileSync(bare.job, 'utf8')).ops[0];
  const written = JSON.parse(fs.readFileSync(wrapped.job, 'utf8')).ops[0];
  // The same pinned document; the op stays as sent, so the kernel wraps it itself and lists the same entry in its receipt.
  assert.deepEqual(sent.wsdl, written.data.wsdl);
  assert.equal(sent.data, undefined);
  assert.deepEqual({ op: sent.op, data: { wsdl: sent.wsdl, port: sent.port, methods: sent.methods } }, written);
  assert.deepEqual(bare.documents.map(d => d.sha256), wrapped.documents.map(d => d.sha256));
});

test('a document named relatively by an op without data keeps naming its file when the job moves to the lane folder', async t => {
  const b = box(t);
  const wsdl = fs.readFileSync(WSDL, 'utf8');
  const fetchImpl = fakeFetch({ 'https://example.invalid/Calc.asmx?WSDL': wsdl });
  const job = b.job([{ op: 'soap', wsdl: { path: 'local.wsdl', sha256: sha256(wsdl) }, port: 'CalculatorSoap', methods: ['Add'] },
    { op: 'soap', wsdl: 'https://example.invalid/Calc.asmx?WSDL', port: 'CalculatorSoap', methods: ['Add'], client: 'Second' }]);
  fs.writeFileSync(path.join(path.dirname(job), 'local.wsdl'), wsdl);
  const prepared = await prepareIntegrationJob(job, { localRoot: b.local, fetchImpl, destructive: false });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const first = JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops[0];
  assert.equal(first.data, undefined);
  assert.ok(path.isAbsolute(first.wsdl.path), first.wsdl.path);
  assert.equal(fs.readFileSync(first.wsdl.path, 'utf8'), wsdl);
});

test('the remove of an op without data needs the words as the same op with data', async t => {
  const b = box(t);
  const job = b.job([{ op: 'soap', wsdl: WSDL, port: 'CalculatorSoap', remove: ['Subtract'] }]);
  const refused = await prepareIntegrationJob(job, { localRoot: b.local, words: 'atualize a calculadora' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'INTEGRATION_DELETE_WORDS');
  assert.equal(refused.normalizations[0].rule, DATA_WRAPPED);
  const named = await prepareIntegrationJob(job, { localRoot: b.local, words: 'remova o metodo Subtract' });
  assert.equal(named.ok, true, JSON.stringify(named));
});

test('wrapData moves only the data keys of soap, rest and rest-expose, as the kernel does', () => {
  const ops = [{ op: 'rest-expose', service: { name: 'Svc' }, methods: [], color: 'blue' }, { op: 'soap', data: { wsdl: 'x' }, client: 'Y' },
    { op: 'rest-consume', name: 'Api', methods: [] }, { op: 'logic', flow: [] }];
  const done = wrapData(ops);
  assert.deepEqual(done.map(d => [d.path, d.from]), [['/ops/0', 'service, methods']]);
  assert.deepEqual(ops[0], { op: 'rest-expose', color: 'blue', data: { service: { name: 'Svc' }, methods: [] } });
  assert.equal(ops[1].client, 'Y');
  assert.equal(ops[2].data, undefined);
  assert.equal(ops[3].data, undefined);
});

test('DATA_KEYS are the kernel\'s data keys of each op (anvil api --op)', t => {
  const cli = path.join(kernel, '.local', 'cli', 'anvil.dll');
  if (!fs.existsSync(cli)) { t.diagnostic('kernel/.local/cli/anvil.dll not built: compared only when it is'); return; }
  for (const op of Object.keys(DATA_KEYS)) {
    const run = spawnSync('dotnet', [cli, 'api', '--op', op], { cwd: kernel, encoding: 'utf8', timeout: 120000, env: { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_NO_WARM: '1' } });
    if (run.status !== 0) { t.diagnostic(`api --op ${op}: ${(run.stderr || run.stdout).slice(0, 200)}`); return; }
    const answer = JSON.parse(run.stdout);
    assert.deepEqual([...DATA_KEYS[op]], (answer.data ?? answer).data, op);
  }
});
