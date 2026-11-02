// fase4-28 r4-f3-import (criterion C3): the WSDL or OpenAPI document of a hosted job comes from the customer, never from a fetch
// of the server (hosted-document-fetch.test.mjs): a workspace file, or inline. Inline ({"content": "<text>", "name"?}) is
// written once under <localRoot>/documents/inline/<sha256>/<name> and pinned like a file, so the kernel and the bridge of the
// customer's Service Studio read the same bytes by path and sha256; "content" never reaches the kernel. An inline document is
// self-contained (a file it imports is not there and is refused naming it), and the DTD/ENTITY and size rules of a file apply.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareIntegrationJob } from '../integration-documents.mjs';
import { hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', '..', '..', '..', 'kernel', 'tests', 'fixtures');
const WSDL = fs.readFileSync(path.join(fixtures, 'wsdl', 'calculator-two-ports.wsdl'), 'utf8');
const OPENAPI = fs.readFileSync(path.join(fixtures, 'openapi', 'orders-3.0.json'), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const noFetch = async url => { throw new Error('the hosted server fetched ' + url); };
function box() {
  const dirs = hostedDirs(os.tmpdir());
  const local = path.join(dirs.workspace, 'o11', '.local');
  const job = ops => write(path.join(dirs.workspace, 'inbox', 'job-' + Math.random().toString(36).slice(2) + '.json'), { ops });
  return { ...dirs, local, job, hosted: { lane: 'o11', localRoot: local, destructive: false, workspace: dirs.workspace, fetchImpl: noFetch } };
}
const readJob = prepared => JSON.parse(fs.readFileSync(prepared.job, 'utf8'));
const soap = wsdl => [{ op: 'soap', data: { wsdl, port: 'CalculatorSoap', methods: ['Add'] } }];

test('hosted: an inline WSDL is pinned under the documents folder and the op names it by path and sha256', async () => {
  const b = box();
  const prepared = await prepareIntegrationJob(b.job(soap({ content: WSDL, name: 'Calc.wsdl' })), b.hosted);
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 400));
  const wsdl = readJob(prepared).ops[0].data.wsdl;
  assert.equal(wsdl.sha256, sha(WSDL));
  assert.equal(wsdl.source, 'inline');
  assert.equal(wsdl.content, undefined);
  assert.equal(wsdl.name, undefined);
  assert.equal(fs.readFileSync(wsdl.path, 'utf8'), WSDL);
  assert.ok(wsdl.path.startsWith(path.join(b.local, 'documents')), wsdl.path);
  assert.equal(path.basename(wsdl.path), 'Calc.wsdl');
  assert.ok(!fs.existsSync(path.join(b.local, 'documents', 'inline')), 'review M1: no second copy');
  // The same text again: the same pinned document.
  const again = await prepareIntegrationJob(b.job(soap({ content: WSDL, name: 'Calc.wsdl' })), b.hosted);
  assert.equal(readJob(again).ops[0].data.wsdl.sha256, wsdl.sha256);
});

test('hosted: an inline OpenAPI document of a rest op is pinned and keeps its operations; content never reaches the kernel', async () => {
  const b = box();
  const prepared = await prepareIntegrationJob(b.job([{ op: 'rest', data: { client: { name: 'Orders' }, openapi: { content: OPENAPI, operations: ['getOrder', 'POST /orders'] } } }]), b.hosted);
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 400));
  const openapi = readJob(prepared).ops[0].data.openapi;
  assert.deepEqual(Object.keys(openapi).sort(), ['operations', 'path', 'sha256', 'source']);
  assert.equal(openapi.sha256, sha(OPENAPI));
  assert.equal(openapi.source, 'inline');
  assert.deepEqual(openapi.operations, ['getOrder', 'POST /orders']);
  assert.equal(path.basename(openapi.path), 'openapi.json');
  assert.equal(fs.readFileSync(openapi.path, 'utf8'), OPENAPI);
});

test('hosted: an inline document that is empty, also names a path, declares a DTD or imports a file is refused', async () => {
  const b = box();
  const cases = [
    [{ content: '' }, 'DOCUMENT_INLINE_INVALID'],
    [{ content: 42 }, 'DOCUMENT_INLINE_INVALID'],
    [{ content: WSDL, path: path.join(b.workspace, 'inbox', 'Calc.wsdl') }, 'DOCUMENT_INLINE_INVALID'],
    [{ content: '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + WSDL }, 'UNSAFE_WSDL_XML'],
    // review B1: an inline document names no file at all (relative, climbing to inbox/, or by URL), and says where files go.
    [{ content: WSDL.replace('<wsdl:types>', '<wsdl:types><s:schema><s:import namespace="urn:x" schemaLocation="types/common.xsd"/></s:schema>') }, 'DOCUMENT_INLINE_INVALID'],
    [{ content: WSDL.replace('<wsdl:types>', '<wsdl:types><s:schema><s:import namespace="urn:x" schemaLocation="../../../../inbox/x.xsd"/></s:schema>') }, 'DOCUMENT_INLINE_INVALID'],
    [{ content: WSDL.replace('<wsdl:types>', '<wsdl:types><s:schema><s:import namespace="urn:x" schemaLocation="https://docs.example.test/t.xsd"/></s:schema>') }, 'DOCUMENT_INLINE_INVALID'],
    [{ content: JSON.stringify({ openapi: '3.0.0', paths: {}, components: { schemas: { A: { $ref: './a.json#/A' } } } }) }, 'DOCUMENT_INLINE_INVALID', 'openapi'],
  ];
  for (const [doc, code, kind = 'wsdl'] of cases) {
    const ops = kind === 'wsdl' ? soap(doc) : [{ op: 'rest', data: { client: { name: 'A' }, openapi: { ...doc, operations: ['x'] } } }];
    const prepared = await prepareIntegrationJob(b.job(ops), b.hosted);
    assert.equal(prepared.ok, false, code);
    assert.ok(prepared.problems.some(p => p.code === code), code + ': ' + JSON.stringify(prepared.problems).slice(0, 300));
    assert.ok(prepared.problems.every(p => String(p.path ?? '').startsWith('/ops/0/data/' + kind)), JSON.stringify(prepared.problems));
    if (code === 'DOCUMENT_INLINE_INVALID' && prepared.problems[0].target) {
      assert.ok(prepared.problems[0].fix.includes('agent:inbox/<folder>/'), prepared.problems[0].fix);
      assert.doesNotMatch(prepared.problems[0].message + prepared.problems[0].fix, /documents[\\/]inline|\.local/);
    }
  }
  // review M1: nothing of a refused job stays pinned.
  assert.deepEqual(fs.existsSync(path.join(b.local, 'documents')) ? fs.readdirSync(path.join(b.local, 'documents')) : [], []);
});

// review M1: an inline document is written once (no inline/ copy), counts against the workspace quota, and a refused job
// leaves none of the documents it pinned.
test('hosted: an inline document is written once, within the workspace quota; a refused job removes what it pinned', async () => {
  const b = box();
  const ok = await prepareIntegrationJob(b.job(soap({ content: WSDL })), b.hosted);
  assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 300));
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
  walk(path.join(b.local, 'documents'));
  assert.deepEqual(files.map(f => path.relative(path.join(b.local, 'documents'), f).split(path.sep).join('/')), [sha(WSDL) + '/service.wsdl'], 'one copy only');
  // a quota with less room than the document: WORKSPACE_FULL, nothing written
  const added = [];
  const quota = { limitBytes: 1024, used: () => 1000, add: n => added.push(n), full(extra = 0) { return this.used() + extra > this.limitBytes; } };
  const other = WSDL.replace('<wsdl:types>', '<!-- another --><wsdl:types>');
  const full = await prepareIntegrationJob(b.job(soap({ content: other })), { ...b.hosted, quota });
  assert.deepEqual([full.ok, full.code], [false, 'WORKSPACE_FULL'], JSON.stringify(full).slice(0, 300));
  assert.ok(!fs.existsSync(path.join(b.local, 'documents', sha(other))));
  assert.deepEqual(added, []);
  // room enough: the bytes are added to the quota
  const roomy = { ...quota, limitBytes: 10 * 1024 * 1024 };
  const third = WSDL.replace('<wsdl:types>', '<!-- third --><wsdl:types>');
  assert.equal((await prepareIntegrationJob(b.job(soap({ content: third })), { ...b.hosted, quota: roomy })).ok, true);
  assert.deepEqual(added, [Buffer.byteLength(third)]);
  // a job refused for another op still pinned its inline document first: removed again
  const fourth = WSDL.replace('<wsdl:types>', '<!-- fourth --><wsdl:types>');
  const refused = await prepareIntegrationJob(b.job([...soap({ content: fourth }), { op: 'soap', data: { wsdl: 'https://docs.example.test/x?wsdl', methods: ['Add'] } }]), b.hosted);
  assert.equal(refused.ok, false);
  assert.ok(!fs.existsSync(path.join(b.local, 'documents', sha(fourth))), 'the refused job left its pinned document');
  assert.ok(fs.existsSync(path.join(b.local, 'documents', sha(WSDL), 'service.wsdl')), 'a document pinned before stays');
});

test('hosted: a WSDL file of the workspace with its import next to it is pinned as before, with no fetch', async () => {
  const b = box();
  const main = WSDL.replace('<wsdl:types>', '<wsdl:types><s:schema><s:import namespace="urn:x" schemaLocation="types/common.xsd"/></s:schema>');
  const file = write(path.join(b.workspace, 'inbox', 'calc', 'Calc.wsdl'), main);
  write(path.join(b.workspace, 'inbox', 'calc', 'types', 'common.xsd'), '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"/>');
  const prepared = await prepareIntegrationJob(b.job(soap(file)), b.hosted);
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 400));
  const wsdl = readJob(prepared).ops[0].data.wsdl;
  assert.deepEqual(Object.keys(wsdl.imports), ['types/common.xsd']);
  assert.equal(path.relative(path.dirname(wsdl.path), wsdl.imports['types/common.xsd'].path).split(path.sep).join('/'), 'types/common.xsd');
});

// review A1: every WSDL import, at every level, must be a name relative to the WSDL inside its folder; anything else is
// DOCUMENT_NAME_INVALID before anything is pinned (the Studio's importer resolves the name next to the pinned WSDL).
test('hosted and local: a WSDL import outside the WSDL folder (../, absolute, file:, nested) is DOCUMENT_NAME_INVALID; inside is pinned with its layout', async () => {
  const b = box();
  const xsd = '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"/>';
  const importing = name => WSDL.replace('<wsdl:types>', '<wsdl:types><s:schema><s:import namespace="urn:x" schemaLocation="' + name + '"/></s:schema>');
  const common = write(path.join(b.workspace, 'inbox', 'common', 'types.xsd'), xsd);
  for (const name of ['../common/types.xsd', common, pathToFileURL(common).href]) {
    const file = write(path.join(b.workspace, 'inbox', 'calc', 'Calc.wsdl'), importing(name));
    for (const options of [b.hosted, { ...b.hosted, workspace: null }]) {
      const prepared = await prepareIntegrationJob(b.job(soap(file)), options);
      assert.deepEqual([prepared.ok, prepared.code], [false, 'DOCUMENT_NAME_INVALID'], name + ': ' + JSON.stringify(prepared).slice(0, 300));
      assert.equal(prepared.problems[0].target, name);
      assert.match(prepared.problems[0].fix, /relative to the WSDL, inside its folder/);
    }
  }
  // nested: an import inside the folder that itself imports a file out of the WSDL's folder
  write(path.join(b.workspace, 'inbox', 'calc', 'types', 'a.xsd'), xsd.replace('/>', '><s:import namespace="urn:y" schemaLocation="../../common/types.xsd"/></s:schema>'));
  const nested = write(path.join(b.workspace, 'inbox', 'calc', 'Calc.wsdl'), importing('types/a.xsd'));
  const refused = await prepareIntegrationJob(b.job(soap(nested)), b.hosted);
  assert.deepEqual([refused.ok, refused.code], [false, 'DOCUMENT_NAME_INVALID'], JSON.stringify(refused).slice(0, 300));
  assert.equal(refused.problems[0].target, '../../common/types.xsd');
  // nested and still inside: types/a.xsd imports ../b.xsd (the WSDL's own folder): pinned as b.xsd next to the WSDL
  write(path.join(b.workspace, 'inbox', 'calc', 'b.xsd'), xsd);
  write(path.join(b.workspace, 'inbox', 'calc', 'types', 'a.xsd'), xsd.replace('/>', '><s:import namespace="urn:y" schemaLocation="../b.xsd"/></s:schema>'));
  const fine = await prepareIntegrationJob(b.job(soap(nested)), b.hosted);
  assert.equal(fine.ok, true, JSON.stringify(fine).slice(0, 300));
  const folder = path.dirname(readJob(fine).ops[0].data.wsdl.path);
  assert.deepEqual(fine.documents.map(d => path.relative(folder, d.path).split(path.sep).join('/')).sort(), ['Calc.wsdl', 'b.xsd', 'types/a.xsd']);
});

test('local use: an inline WSDL is pinned the same way (no workspace needed)', async () => {
  const b = box();
  const prepared = await prepareIntegrationJob(b.job(soap({ content: WSDL })), { ...b.hosted, workspace: null });
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 400));
  assert.equal(path.basename(readJob(prepared).ops[0].data.wsdl.path), 'service.wsdl');
});
