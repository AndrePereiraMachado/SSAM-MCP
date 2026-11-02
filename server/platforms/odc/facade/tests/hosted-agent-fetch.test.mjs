// r40 (agent fetch): on a hosted server a WSDL, an OpenAPI document, what they import and the sample GET of rest-consume, named by
// URL, are downloaded by the customer's SSAM Agent ON THE USER'S MACHINE (kind document.fetch), never by the server. The bytes the
// agent answers are read as the bytes of a URL read locally (imports against the final URL, names inside the WSDL's folder,
// MAX_DOCUMENTS, DTD/ENTITY, the quota, the pin) after the server checks them again; each download is a note on the answer.
// An agent without the kind (the apps 0.2.1/0.2.2), or none, keeps DOCUMENT_FETCH_HOSTED_REFUSED with a fix that says to
// update or connect it. Fakes only: a fake agent (a table of URL -> answer), the real AgentExecutor over a fake link, and every
// way of this process to the network watched (no-network.mjs): any request of the server fails the test.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
// A namespace import, so each test runs (and fails by its own assertion) on a line without the r40 exports.
import * as documents from '../integration-documents.mjs';
const { prepareIntegrationJob, MAX_DOCUMENTS } = documents;
const DOCUMENT_FETCH_KIND = 'document.fetch', DOCUMENT_DOWNLOADED_BY_AGENT = 'DOCUMENT_DOWNLOADED_BY_AGENT', AGENT_FETCH_INVALID = 'DOCUMENT_FETCH_AGENT_INVALID';
const downloadNotes = list => documents.downloadNotes(list);
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { CALL_KINDS, HELLO_ONLY_KINDS } from '../call-kinds.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';
import { watchNetwork } from './fixtures/no-network.mjs';
import { createQuota } from '../hosted/mirror.mjs';

test.after(cleanupHostedDirs);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const WSDL = (imports = []) => `<?xml version="1.0"?><definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" name="Calc"><types><xsd:schema>`
  + imports.map(i => `<xsd:import schemaLocation="${i}"/>`).join('') + '</xsd:schema></types></definitions>';
const XSD = (includes = []) => '<?xml version="1.0"?><xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">' + includes.map(i => `<xsd:include schemaLocation="${i}"/>`).join('') + '</xsd:schema>';

// The fake agent of one customer: answers document.fetch from a table {url: text | {status, finalUrl?, body?} | {code, message}},
// as the kind does (the agent follows redirects: finalUrl). bad(value) lets a test change the answer (a hostile agent).
function fakeAgent(table, { state = 'ready', bad = value => value } = {}) {
  const asked = [];
  return { asked, documentFetchState: () => state,
    async documentFetch(params) {
      asked.push(params);
      const entry = table[params.url];
      if (entry && typeof entry === 'object' && entry.code) throw Object.assign(new Error(entry.message ?? 'refused'), { code: entry.code, executed: false });
      const status = entry === undefined ? 404 : typeof entry === 'object' ? entry.status ?? 200 : 200;
      const body = Buffer.from(entry === undefined || (typeof entry === 'object' && status >= 300) ? '' : typeof entry === 'object' ? entry.body : entry, 'utf8');
      return bad({ finalUrl: (typeof entry === 'object' && entry.finalUrl) || params.url, status, contentType: 'text/xml', bytes: body.length, sha256: sha(body), contentBase64: body.toString('base64') });
    } };
}
function box() {
  const dirs = hostedDirs(os.tmpdir());
  const local = path.join(dirs.workspace, 'o11', '.local');
  const job = ops => write(path.join(dirs.workspace, 'inbox', 'job-' + Math.random().toString(36).slice(2) + '.json'), { ops });
  const soap = wsdl => job([{ op: 'soap', data: { wsdl, client: { name: 'Calc' }, methods: ['Add'] } }]);
  return { ...dirs, local, job, soap, hosted: { lane: 'o11', localRoot: local, destructive: false, workspace: dirs.workspace } };
}
// Every case runs with the network watched and a server-side client that fails the test when called.
async function offline(fn) {
  const watch = watchNetwork();
  const serverFetch = async url => { throw new Error('the server fetched ' + url); };
  let calls = 0;
  const counted = async (...args) => { calls++; return serverFetch(...args); };
  try { return await fn(counted); } finally { watch.restore(); assert.deepEqual(watch.asked, [], 'no request left the server'); assert.equal(calls, 0, 'the server\'s HTTP client was never called'); }
}

test('the kind: in the closed list, sent only to an agent whose Hello lists it', () => {
  assert.equal(documents.DOCUMENT_FETCH_KIND, DOCUMENT_FETCH_KIND);
  assert.equal(CALL_KINDS.at(-1), DOCUMENT_FETCH_KIND);
  assert.ok(HELLO_ONLY_KINDS.has(DOCUMENT_FETCH_KIND));
});

test('a WSDL by URL with its imports: downloaded by the agent, pinned with the names relative to it, one note per URL, the server asks nothing', async () => {
  const b = box();
  const agent = fakeAgent({ 'http://www.dneonline.com/calculator.asmx?WSDL': WSDL(['types/a.xsd']), 'http://www.dneonline.com/types/a.xsd': XSD(['b.xsd']), 'http://www.dneonline.com/types/b.xsd': XSD() });
  const prepared = await offline(fetchImpl => prepareIntegrationJob(b.soap('http://www.dneonline.com/calculator.asmx?WSDL'), { ...b.hosted, agent, fetchImpl }));
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 600));
  assert.deepEqual(agent.asked.map(a => [a.url, a.accept, a.maxBytes, a.timeoutMs]), [
    ['http://www.dneonline.com/calculator.asmx?WSDL', 'xml', 5 * 1024 * 1024, 30000], ['http://www.dneonline.com/types/a.xsd', 'xml', 5 * 1024 * 1024, 30000], ['http://www.dneonline.com/types/b.xsd', 'xml', 5 * 1024 * 1024, 30000]]);
  const op = JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops[0];
  assert.equal(op.data.wsdl.source, 'http://www.dneonline.com/calculator.asmx?WSDL');
  assert.equal(op.data.wsdl.sha256, sha(Buffer.from(WSDL(['types/a.xsd']))));
  const folder = path.join(b.local, 'documents', op.data.wsdl.sha256);
  assert.equal(path.dirname(op.data.wsdl.path), folder);
  assert.deepEqual(Object.keys(op.data.wsdl.imports).sort(), ['b.xsd', 'types/a.xsd']);
  assert.equal(fs.readFileSync(path.join(folder, 'types', 'a.xsd'), 'utf8'), XSD(['b.xsd']));
  assert.equal(fs.readFileSync(path.join(folder, 'types', 'b.xsd'), 'utf8'), XSD());
  assert.deepEqual(prepared.notes.map(n => n.rule), [DOCUMENT_DOWNLOADED_BY_AGENT, DOCUMENT_DOWNLOADED_BY_AGENT, DOCUMENT_DOWNLOADED_BY_AGENT]);
  assert.match(prepared.notes[0].note, /^http:\/\/www\.dneonline\.com\/calculator\.asmx\?WSDL was downloaded by the SSAM Agent on the user's machine: \d+ bytes, sha256 [0-9a-f]{64}; the SSAM server made no request$/);
  assert.equal(prepared.notes[0].at, '/ops/0/data/wsdl');
});

test('a redirect the agent followed: the document is its final URL, and its imports resolve against it', async () => {
  const b = box();
  const agent = fakeAgent({ 'http://svc.example.test/calc?WSDL': { body: WSDL(['types.xsd']), finalUrl: 'https://cdn.example.test/v2/calc.wsdl' }, 'https://cdn.example.test/v2/types.xsd': XSD() });
  const prepared = await offline(fetchImpl => prepareIntegrationJob(b.soap('http://svc.example.test/calc?WSDL'), { ...b.hosted, agent, fetchImpl }));
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 600));
  assert.deepEqual(agent.asked.map(a => a.url), ['http://svc.example.test/calc?WSDL', 'https://cdn.example.test/v2/types.xsd']);
  const op = JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops[0];
  assert.equal(op.data.wsdl.source, 'https://cdn.example.test/v2/calc.wsdl');
  assert.match(prepared.notes[0].note, /\(final URL https:\/\/cdn\.example\.test\/v2\/calc\.wsdl\)/);
});

test('the rules of a URL read locally hold for the agent\'s bytes: names outside the folder, DTD/ENTITY, MAX_DOCUMENTS, 404, the quota', async () => {
  const b = box();
  const cases = [
    ['an import that climbs out of the folder', { 'http://h.example.test/s/svc?wsdl': WSDL(['../x.xsd']) }, 'DOCUMENT_NAME_INVALID'],
    ['an import on another server', { 'http://h.example.test/s/svc?wsdl': WSDL(['http://other.example.test/x.xsd']) }, 'DOCUMENT_NAME_INVALID'],
    ['a DTD the agent let through', { 'http://h.example.test/s/svc?wsdl': '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x "y">]><definitions/>' }, 'UNSAFE_WSDL_XML'],
    ['an imported ENTITY', { 'http://h.example.test/s/svc?wsdl': WSDL(['a.xsd']), 'http://h.example.test/s/a.xsd': '<!ENTITY x "y"><xsd:schema/>' }, 'UNSAFE_WSDL_XML'],
    ['a 404 on the user\'s machine', {}, 'DOCUMENT_NOT_FOUND'],
    ['the agent\'s own refusal', { 'http://h.example.test/s/svc?wsdl': { code: 'DOCUMENT_FETCH_FAILED', message: 'GET failed: ENOTFOUND' } }, 'DOCUMENT_FETCH_FAILED'],
  ];
  for (const [label, table, code] of cases) {
    const agent = fakeAgent(table);
    const prepared = await offline(fetchImpl => prepareIntegrationJob(b.soap('http://h.example.test/s/svc?wsdl'), { ...b.hosted, agent, fetchImpl }));
    assert.deepEqual([prepared.ok, prepared.code], [false, code], label + ': ' + JSON.stringify(prepared).slice(0, 400));
    assert.ok(prepared.problems.every(p => typeof p.fix === 'string' && p.fix), label + ': a fix');
  }
  const many = Object.fromEntries([['http://h.example.test/s/svc?wsdl', WSDL(Array.from({ length: MAX_DOCUMENTS + 2 }, (_, i) => `x${i}.xsd`))],
    ...Array.from({ length: MAX_DOCUMENTS + 2 }, (_, i) => [`http://h.example.test/s/x${i}.xsd`, XSD()])]);
  const tooMany = await offline(fetchImpl => prepareIntegrationJob(b.soap('http://h.example.test/s/svc?wsdl'), { ...b.hosted, agent: fakeAgent(many), fetchImpl }));
  assert.deepEqual([tooMany.ok, tooMany.code], [false, 'DOCUMENT_TOO_LARGE']);
  assert.match(tooMany.error, /imports more than 32 documents/);
  const quota = createQuota(b.workspace, { limitBytes: 10 });
  const full = await offline(fetchImpl => prepareIntegrationJob(b.soap('http://h.example.test/s/svc?wsdl'), { ...b.hosted, agent: fakeAgent({ 'http://h.example.test/s/svc?wsdl': WSDL() }), fetchImpl, quota }));
  assert.equal(full.ok, false);
  assert.equal(full.code, 'WORKSPACE_FULL');
  assert.ok(!fs.existsSync(path.join(b.local, 'documents', sha(Buffer.from(WSDL())))), 'nothing pinned past the quota');
});

test('the server checks the agent\'s answer again: size, sha256, base64 and fields; a lying agent\'s bytes are never pinned', async () => {
  const b = box();
  const url = 'http://h.example.test/svc?wsdl';
  const lies = [
    ['a sha256 that is not the bytes\'', v => ({ ...v, sha256: 'f'.repeat(64) }), AGENT_FETCH_INVALID],
    ['a size that is not the bytes\'', v => ({ ...v, bytes: v.bytes + 1 }), AGENT_FETCH_INVALID],
    ['content that is not base64', v => ({ ...v, contentBase64: '***' }), AGENT_FETCH_INVALID],
    ['a final URL that is a file', v => ({ ...v, finalUrl: 'file:///C:/Windows/win.ini' }), AGENT_FETCH_INVALID],
    ['a final URL with a password', v => ({ ...v, finalUrl: 'http://u:p@h.example.test/svc' }), AGENT_FETCH_INVALID],
    ['more than 5 MB', v => { const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x3c); return { ...v, bytes: big.length, sha256: sha(big), contentBase64: big.toString('base64') }; }, 'DOCUMENT_TOO_LARGE'],
  ];
  for (const [label, bad, code] of lies) {
    const prepared = await offline(fetchImpl => prepareIntegrationJob(b.soap(url), { ...b.hosted, agent: fakeAgent({ [url]: WSDL() }, { bad }), fetchImpl }));
    assert.deepEqual([prepared.ok, prepared.code], [false, code], label + ': ' + JSON.stringify(prepared).slice(0, 300));
    assert.equal(prepared.notes, undefined, label + ': no download is listed for bytes that were not used');
  }
  assert.ok(!fs.existsSync(path.join(b.local, 'documents')) || fs.readdirSync(path.join(b.local, 'documents')).length === 0);
});

test('an OpenAPI document by URL with an external $ref: downloaded as JSON by the agent and pinned with its external file', async () => {
  const b = box();
  const api = JSON.stringify({ openapi: '3.0.0', info: { title: 'Orders', version: '1' }, paths: { '/orders/{id}': { get: { operationId: 'getOrder', responses: { 200: { content: { 'application/json': { schema: { $ref: 'schemas/order.json#/Order' } } } } } } } } });
  const order = JSON.stringify({ Order: { type: 'object', properties: { id: { type: 'integer' } } } });
  const agent = fakeAgent({ 'https://api.example.test/v1/openapi.json': api, 'https://api.example.test/v1/schemas/order.json': order });
  const job = b.job([{ op: 'rest', data: { client: { name: 'Orders' }, openapi: { path: 'https://api.example.test/v1/openapi.json', operations: ['getOrder'] } } }]);
  const prepared = await offline(fetchImpl => prepareIntegrationJob(job, { ...b.hosted, agent, fetchImpl }));
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 600));
  assert.deepEqual(agent.asked.map(a => [a.url, a.accept]), [['https://api.example.test/v1/openapi.json', 'json'], ['https://api.example.test/v1/schemas/order.json', 'json']]);
  const op = JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops[0];
  assert.equal(op.data.openapi.sha256, sha(Buffer.from(api)));
  assert.deepEqual(Object.keys(op.data.openapi.external), ['schemas/order.json']);
  assert.equal(prepared.notes.length, 2);
  assert.equal(prepared.notes[0].at, '/ops/0/data/openapi/path');
});

test('rest-consume: a GET method without a sample is sampled by the agent (JSON, 10 s, 2 MB) and pinned in the op; the server asks nothing', async () => {
  const b = box();
  const url = 'https://date.nager.at/api/v3/PublicHolidays/2026/BR';
  const items = Array.from({ length: 30 }, (_, i) => ({ date: '2026-01-' + String(i + 1).padStart(2, '0'), name: 'H' + i }));
  const agent = fakeAgent({ [url]: JSON.stringify(items), 'https://api.example.test/text': 'plain text', 'https://api.example.test/gone': { status: 500 } });
  const job = b.job([{ op: 'rest-consume', data: { name: 'Nager', baseUrl: 'https://date.nager.at/api/v3', methods: [
    { name: 'Holidays', url: '/PublicHolidays/{year=2026}/{country=BR}' }, { name: 'Given', url: '/given', sample: { a: 1 } }, { name: 'Create', verb: 'POST', url: '/x', request: { a: 1 } }] } }]);
  const prepared = await offline(fetchImpl => prepareIntegrationJob(job, { ...b.hosted, agent, fetchImpl }));
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 600));
  assert.deepEqual(agent.asked, [{ url, accept: 'json', maxBytes: 2 * 1024 * 1024, timeoutMs: 10000 }]);
  const method = JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops[0].data.methods[0];
  assert.equal(method.sample.length, 20);
  assert.deepEqual(method.sampledFrom, { url, status: 200, bytes: Buffer.byteLength(JSON.stringify(items)), sha256: sha(Buffer.from(JSON.stringify(items))), trimmedTo: 20 });
  assert.deepEqual(prepared.notes.map(n => [n.rule, n.at]), [[DOCUMENT_DOWNLOADED_BY_AGENT, '/ops/0/data/methods/0']]);
  // Its refusals keep the sample codes; an authenticated API is never asked (no credential is ever sent).
  const refused = await offline(fetchImpl => prepareIntegrationJob(b.job([{ op: 'rest-consume', data: { name: 'X', methods: [
    { name: 'Text', url: 'https://api.example.test/text' }, { name: 'Gone', url: 'https://api.example.test/gone' }] } },
  { op: 'rest-consume', data: { name: 'Auth', auth: { type: 'basic' }, methods: [{ name: 'Me', url: 'https://api.example.test/me' }] } }]), { ...b.hosted, agent, fetchImpl }));
  assert.deepEqual(refused.problems.map(p => [p.code, p.path]), [['REST_CONSUME_SAMPLE_NOT_JSON', '/ops/0/data/methods/0/url'], ['REST_CONSUME_SAMPLE_FETCH_FAILED', '/ops/0/data/methods/1/url'],
    ['REST_CONSUME_SAMPLE_MISSING', '/ops/1/data/methods/0/sample']]);
  assert.ok(!agent.asked.some(a => a.url === 'https://api.example.test/me'));
});

test('an agent without the kind (the apps 0.2.1/0.2.2) or none connected: the refusal of before, its fix says to update or connect the agent, nothing is asked', async () => {
  const b = box();
  for (const [state, hint] of [['update', /update the SSAM Agent to let it download on the user's machine/], ['absent', /connect the SSAM Agent on the user's machine .* to let it download there/]]) {
    const agent = fakeAgent({}, { state });
    const started = Date.now();
    const soap = await offline(fetchImpl => prepareIntegrationJob(b.soap('http://www.dneonline.com/calculator.asmx?WSDL'), { ...b.hosted, agent, fetchImpl }));
    assert.deepEqual([soap.ok, soap.code], [false, 'DOCUMENT_FETCH_HOSTED_REFUSED']);
    assert.match(soap.problems[0].fix, hint, state);
    const sample = await offline(fetchImpl => prepareIntegrationJob(b.job([{ op: 'rest-consume', data: { name: 'N', methods: [{ name: 'A', url: 'https://api.example.test/a' }] } }]), { ...b.hosted, agent, fetchImpl }));
    assert.deepEqual([sample.ok, sample.code, sample.problems[0].cause], [false, 'DOCUMENT_FETCH_HOSTED_REFUSED', 'REST_CONSUME_SAMPLE_MISSING']);
    assert.match(sample.problems[0].fix, hint, state);
    assert.deepEqual(agent.asked, [], state + ': nothing asked of the agent');
    assert.ok(Date.now() - started < 5000, state + ': no wait');
  }
});

test('the AgentExecutor: the state from the link (connected, the Hello\'s kinds), the call through the link only, a lost link is the hosted refusal', async () => {
  const dirs = hostedDirs(os.tmpdir());
  const calls = [];
  const link = (over = {}) => ({ tokenId: 'tok_fetch', connected: () => true, supports: kind => kind === 'document.fetch', info: () => ({}),
    call: async (kind, params, options) => { calls.push({ kind, params, options }); return { finalUrl: params.url, status: 200, contentType: 'text/xml', bytes: 0, sha256: sha(Buffer.alloc(0)), contentBase64: '' }; }, ...over });
  const executor = new AgentExecutor({ link: link(), workspace: dirs.workspace });
  assert.equal(executor.documentFetchState(), 'ready');
  assert.equal(new AgentExecutor({ link: link({ supports: () => false }), workspace: dirs.workspace }).documentFetchState(), 'update');
  assert.equal(new AgentExecutor({ link: link({ connected: () => false }), workspace: dirs.workspace }).documentFetchState(), 'absent');
  assert.equal(new AgentExecutor({ link: link({ connected: () => { throw new Error('x'); } }), workspace: dirs.workspace }).documentFetchState(), 'absent');
  await executor.documentFetch({ url: 'https://h.example.test/a.wsdl', accept: 'xml', maxBytes: 10, timeoutMs: 30000, extra: 'dropped' });
  assert.deepEqual(calls, [{ kind: 'document.fetch', params: { url: 'https://h.example.test/a.wsdl', accept: 'xml', maxBytes: 10, timeoutMs: 30000 }, options: { timeoutMs: 90000 } }]);
  // A link that loses the agent during the call: the hosted refusal, cause the link's code.
  const lost = new AgentExecutor({ link: link({ call: async () => { throw Object.assign(new Error('The SSAM agent of this account is not connected.'), { code: 'AGENT_NOT_CONNECTED', executed: false }); } }), workspace: dirs.workspace });
  const b = box();
  const prepared = await offline(fetchImpl => prepareIntegrationJob(b.soap('https://h.example.test/a.wsdl'), { ...b.hosted, agent: lost, fetchImpl }));
  assert.deepEqual([prepared.ok, prepared.code, prepared.problems[0].cause], [false, 'DOCUMENT_FETCH_HOSTED_REFUSED', 'AGENT_NOT_CONNECTED']);
});

test('the gate: an agent whose Hello lists document.fetch lets an unsampled rest-consume through to the documents step; any other keeps the refusal, with the update in its fix', async () => {
  for (const fetches of [true, false]) {
    const dirs = hostedDirs(os.tmpdir());
    const link = fakeAgentLink({ agentRoot: dirs.agentRoot, fetches });
    const executor = { id: 'fake', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }), async call(kind) { throw Object.assign(new Error(kind), { code: 'KIND_NOT_ALLOWED', executed: false }); } };
    const context = { id: 'ctx-fetch', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
    const handled = [];
    const wrapped = wrapHostedTool('ssam_job', { inputSchema: {} }, async args => { handled.push(args); return { content: [], structuredContent: { ok: true } }; },
      { context, link, lanes: context.lanes, run: (ctx, fn) => fn(), waitMs: 10 });
    const value = (await wrapped({ lane: 'o11', job: { ops: [{ op: 'rest-consume', data: { name: 'N', methods: [{ name: 'A', url: 'https://api.example.test/a' }] } }] } }, { requestId: 1 })).structuredContent;
    if (fetches) { assert.equal(handled.length, 1, JSON.stringify(value).slice(0, 300)); continue; }
    assert.equal(value.code, 'DOCUMENT_FETCH_HOSTED_REFUSED');
    assert.equal(handled.length, 0);
    assert.match(value.fix, /update the SSAM Agent to let it download on the user's machine/);
  }
});

test('downloadNotes: one English note per URL, with its bytes and sha256', () => {
  assert.deepEqual(downloadNotes([{ url: 'http://a.test/x', finalUrl: 'http://a.test/x', status: 200, bytes: 3, sha256: 'a'.repeat(64), at: '/ops/1/data/wsdl' }]),
    [{ rule: DOCUMENT_DOWNLOADED_BY_AGENT, at: '/ops/1/data/wsdl', note: `http://a.test/x was downloaded by the SSAM Agent on the user's machine: 3 bytes, sha256 ${'a'.repeat(64)}; the SSAM server made no request` }]);
  assert.deepEqual(downloadNotes(undefined), []);
});

// The answers of the job tools (job-runner.mjs): the notes of the documents step, on the delivery and on its refusal.
test('o11_job/ssam_job: the notes of the URLs the agent downloaded are on the answer, refused or not', async t => {
  const { runJob } = await import('../job-runner.mjs');
  const { fakeAnvil } = await import('./fixtures/fake-anvil.mjs');
  const { odcRoot } = await import('../workspace.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-fetch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tests', 'jobs'), { recursive: true });
  const job = path.join(root, 'tests', 'jobs', 'soap.json');
  fs.writeFileSync(job, JSON.stringify({ base: 'tests/fixtures/blank-service.oml', ops: [{ op: 'soap', data: { wsdl: 'http://www.dneonline.com/calculator.asmx?WSDL', methods: ['Add'] } }] }));
  const auth = path.join(root, 'auth'); fs.mkdirSync(auth);
  const env = { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root, ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const envelope = JSON.parse(fs.readFileSync(path.join(odcRoot, 'facade', 'tests', 'fixtures', 'jobs-apply-envelope.json'), 'utf8')); envelope.data.accepted = true;
  const notes = downloadNotes([{ url: 'http://www.dneonline.com/calculator.asmx?WSDL', finalUrl: 'http://www.dneonline.com/calculator.asmx?WSDL', status: 200, bytes: 10, sha256: 'b'.repeat(64), at: '/ops/0/data/wsdl' }]);
  const deps = prepare => ({ root, env, o11Lane: 'ss4', runAnvil: fakeAnvil({ apply: () => ({ envelope }) }), prepareIntegrationJob: prepare });
  const ok = await runJob({ lane: 'o11', job }, deps(async () => ({ ok: true, job, changed: false, documents: [], notes })));
  assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 400));
  const listed = Array.isArray(ok.normalizations) ? ok.normalizations : ok.normalizations?.items ?? [];
  assert.deepEqual(listed.filter(n => n.rule === DOCUMENT_DOWNLOADED_BY_AGENT), notes);
  const refused = await runJob({ lane: 'o11', job }, deps(async () => ({ ok: false, code: 'UNSAFE_WSDL_XML', error: 'x', problems: [{ code: 'UNSAFE_WSDL_XML', message: 'x', fix: 'y' }], notes })));
  assert.deepEqual([refused.ok, refused.code, refused.stage], [false, 'UNSAFE_WSDL_XML', 'documents']);
  assert.deepEqual(refused.normalizations, notes);
  assert.equal(refused.notes, undefined);
});

test('a .wso service page: its HTML (refused by the agent, or not a WSDL) gives way to its ?WSDL companion, as locally; only the WSDL is listed', async () => {
  const b = box();
  for (const page of [{ code: 'DOCUMENT_FETCH_UNSAFE_XML', message: 'the XML declares a DTD or ENTITY' }, '<html><body>CountryInfoService</body></html>']) {
    const agent = fakeAgent({ 'http://webservices.example.test/countryinfo/CountryInfoService.wso': page, 'http://webservices.example.test/countryinfo/CountryInfoService.wso?WSDL': WSDL() });
    const prepared = await offline(fetchImpl => prepareIntegrationJob(b.soap('http://webservices.example.test/countryinfo/CountryInfoService.wso'), { ...b.hosted, agent, fetchImpl }));
    assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 400));
    assert.deepEqual(agent.asked.map(a => a.url), ['http://webservices.example.test/countryinfo/CountryInfoService.wso', 'http://webservices.example.test/countryinfo/CountryInfoService.wso?WSDL']);
    assert.equal(JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops[0].data.wsdl.source, 'http://webservices.example.test/countryinfo/CountryInfoService.wso?WSDL');
    assert.deepEqual(prepared.notes.map(n => n.note.split(' ')[0]), ['http://webservices.example.test/countryinfo/CountryInfoService.wso?WSDL']);
  }
});

test('what a downloaded document names on another server (an intranet one included) is never asked of the agent', async () => {
  const b = box();
  const api = JSON.stringify({ openapi: '3.0.0', info: { title: 'X', version: '1' }, paths: { '/a': { get: { operationId: 'getA', responses: { 200: { content: { 'application/json': { schema: { $ref: 'http://192.168.0.1/admin/config.json#/A' } } } } } } } } });
  const agent = fakeAgent({ 'https://api.example.test/openapi.json': api, 'http://192.168.0.1/admin/config.json': '{"A":{}}' });
  const job = b.job([{ op: 'rest', data: { client: { name: 'X' }, openapi: { path: 'https://api.example.test/openapi.json', operations: ['getA'] } } }]);
  const prepared = await offline(fetchImpl => prepareIntegrationJob(job, { ...b.hosted, agent, fetchImpl }));
  assert.deepEqual([prepared.ok, prepared.code], [false, 'DOCUMENT_FETCH_OTHER_SERVER']);
  assert.deepEqual(agent.asked.map(a => a.url), ['https://api.example.test/openapi.json']);
  assert.match(prepared.problems[0].fix, /agent:inbox\/<folder>\//);
});
