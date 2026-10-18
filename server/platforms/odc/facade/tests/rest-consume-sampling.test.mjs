// rest-consume (the generator, kernel RestConsume.cs): a GET method without a sample is sampled once by the facade
// (integration-documents.mjs sampleRestConsume) and the sample pinned in the op; the kernel never reads the network.
// A local HTTP stub on 127.0.0.1 only: the url path end to end, offline. When the worktree's O11 CLI is built
// (kernel/.local/cli/anvil.dll) the pinned job is also applied to the blank service module and must be accepted.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareIntegrationJob, sampleUrl, trimSample, fetchSample, SAMPLE_LIST_ITEMS, SAMPLE_MAX_BYTES } from '../integration-documents.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const fixture = name => fs.readFileSync(path.join(kernel, 'tests', 'fixtures', 'rest-consume', name + '.json'), 'utf8');

function box(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-consume-sampling-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const local = path.join(base, '.local');
  const job = (ops, extra = {}) => { const file = path.join(base, 'jobs', Math.random().toString(16).slice(2) + '.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...extra, ops })); return file; };
  return { base, local, job };
}

// The stub: the routes of the gate's APIs answer the fixtures; /text answers HTML, /big more than the cap, /fail a 503.
async function stub(t) {
  const hits = [];
  const routes = {
    '/api/feriados/v1/2026': () => [200, 'application/json', fixture('brasilapi-feriados')],
    '/latest?from=BRL': () => [200, 'application/json', fixture('frankfurter-latest')],
    '/localidades/estados': () => [200, 'application/json', fixture('ibge-estados')],
    '/localidades/estados/SP/municipios': () => [200, 'application/json', JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ ...JSON.parse(fixture('ibge-municipios'))[0], id: 3500000 + i })))],
    '/text': () => [200, 'text/html', '<html>not json</html>'],
    '/big': () => [200, 'application/json', JSON.stringify({ blob: 'x'.repeat(SAMPLE_MAX_BYTES + 10) })],
    '/fail': () => [503, 'application/json', '{}'],
  };
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, method: req.method, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
    const route = routes[req.url];
    const [status, type, body] = route ? route() : [404, 'text/plain', 'no'];
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}

test('the url of a sample: the base, the examples written in the url, try', () => {
  assert.deepEqual(sampleUrl({}, { name: 'F', url: 'https://h.example/api/f/{ano=2026}' }), { url: 'https://h.example/api/f/2026' });
  assert.deepEqual(sampleUrl({ baseUrl: 'https://h.example/api/' }, { name: 'F', url: '/x/{id}?q={q=a b}', try: { id: 7 } }), { url: 'https://h.example/api/x/7?q=a%20b' });
  const missing = sampleUrl({}, { name: 'F', url: 'https://h.example/x/{id}' }, '/ops/0/data/methods/0');
  assert.equal(missing.problem.code, 'REST_CONSUME_TRY_MISSING');
  assert.equal(missing.problem.path, '/ops/0/data/methods/0/url');
  assert.equal(sampleUrl({}, { name: 'F', url: '/x' }).problem.code, 'REST_CONSUME_URL_INVALID');
  const { value, trimmed } = trimSample({ a: Array.from({ length: 50 }, (_, i) => ({ i, inner: Array.from({ length: 30 }, (_, j) => j) })) });
  assert.equal(trimmed, true);
  assert.equal(value.a.length, SAMPLE_LIST_ITEMS);
  assert.equal(value.a[0].inner.length, SAMPLE_LIST_ITEMS);
});

test('the gate through the url: one GET per method on the local stub, the samples pinned in the op, no credentials', async t => {
  const b = box(t);
  const s = await stub(t);
  const ops = [
    { op: 'rest-consume', data: { name: 'BrasilApi', methods: [{ name: 'Feriados', url: `${s.origin}/api/feriados/v1/{ano=2026}` }] } },
    { op: 'rest-consume', data: { name: 'Frankfurter', methods: [{ name: 'Latest', url: `${s.origin}/latest?from=BRL` }] } },
    { op: 'rest-consume', data: { name: 'Ibge', baseUrl: `${s.origin}/localidades`, methods: [{ name: 'Estados', url: '/estados' }, { name: 'Municipios', url: '/estados/{uf}/municipios', try: { uf: 'SP' } }] } },
    // A method with its own sample and a DELETE are never requested.
    { op: 'rest-consume', data: { name: 'Given', methods: [{ name: 'One', url: `${s.origin}/never`, sample: { a: 1 } }, { name: 'Drop', verb: 'DELETE', url: `${s.origin}/never/{id=1}` }] } },
  ];
  const original = b.job(ops, { base: 'tests/fixtures/blank-service.oml', expectValid: true });
  const prepared = await prepareIntegrationJob(original, { lane: 'o11', localRoot: b.local, destructive: false });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.changed, true);
  assert.deepEqual(s.hits.map(h => `${h.method} ${h.url}`), ['GET /api/feriados/v1/2026', 'GET /latest?from=BRL', 'GET /localidades/estados', 'GET /localidades/estados/SP/municipios']);
  assert.ok(s.hits.every(h => h.authorization === null && h.cookie === null));
  const pinned = JSON.parse(fs.readFileSync(prepared.job, 'utf8')).ops;
  assert.deepEqual(pinned[0].data.methods[0].sample, JSON.parse(fixture('brasilapi-feriados')));
  assert.equal(pinned[0].data.methods[0].sampledFrom.url, `${s.origin}/api/feriados/v1/2026`);
  assert.equal(pinned[0].data.methods[0].sampledFrom.status, 200);
  assert.match(pinned[0].data.methods[0].sampledFrom.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pinned[2].data.methods[1].sample.length, SAMPLE_LIST_ITEMS);
  assert.equal(pinned[2].data.methods[1].sampledFrom.trimmedTo, SAMPLE_LIST_ITEMS);
  assert.deepEqual(pinned[3].data.methods[0].sample, { a: 1 });
  assert.equal(pinned[3].data.methods[1].sample, undefined);
  // The original job file is untouched; the pinned copy is what the kernel runs.
  assert.equal(JSON.parse(fs.readFileSync(original, 'utf8')).ops[0].data.methods[0].sample, undefined);

  // End to end with the kernel when the worktree's O11 CLI is built: the pinned job is accepted on the blank service module.
  const cli = path.join(kernel, '.local', 'cli', 'anvil.dll');
  if (!fs.existsSync(cli)) { t.diagnostic('kernel/.local/cli/anvil.dll not built: the apply is skipped'); return; }
  const out = path.join(b.base, 'gate.oml');
  const run = spawnSync('dotnet', [cli, 'apply', '--job', prepared.job, '--base', path.join(kernel, 'tests', 'fixtures', 'blank-service.oml'), '--out', out, '--work', path.join(b.base, 'work')],
    { cwd: kernel, encoding: 'utf8', timeout: 300000, env: { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_NO_WARM: '1' } });
  if (/Service Studio|StudioAssemblies|not found/i.test(run.stdout + run.stderr) && run.status !== 0 && !fs.existsSync(out)) { t.diagnostic('no Service Studio here: ' + (run.stderr || run.stdout).slice(0, 200)); return; }
  const answer = JSON.parse(run.stdout);
  assert.equal(answer.ok, true, run.stdout.slice(0, 2000));
  assert.equal(answer.data.accepted, true);
  assert.equal(answer.data.isValid, true);
  assert.deepEqual(answer.data.integration.map(r => r.client.name), ['BrasilApi', 'Frankfurter', 'Ibge', 'Given']);
});

test('what cannot be sampled is refused at once, with the fix, before anything is sent', async t => {
  const b = box(t);
  const s = await stub(t);
  const job = b.job([{ op: 'rest-consume', data: { name: 'Bad', methods: [
    { name: 'Html', url: `${s.origin}/text` }, { name: 'Big', url: `${s.origin}/big` }, { name: 'Down', url: `${s.origin}/fail` }, { name: 'NoValue', url: `${s.origin}/x/{id}` }] } }]);
  const prepared = await prepareIntegrationJob(job, { lane: 'odc', localRoot: b.local, destructive: false });
  assert.equal(prepared.ok, false);
  assert.deepEqual(prepared.problems.map(p => p.code), ['REST_CONSUME_SAMPLE_NOT_JSON', 'REST_CONSUME_SAMPLE_TOO_LARGE', 'REST_CONSUME_SAMPLE_FETCH_FAILED', 'REST_CONSUME_TRY_MISSING']);
  assert.ok(prepared.problems.every(p => p.fix && /\/ops\/0\/data\/methods\/\d\/url$/.test(p.path)), JSON.stringify(prepared.problems));
  assert.match(prepared.error, /Nothing was captured or sent/);
});

test('an authenticated API is never sampled: no request, one problem per method without a sample', async t => {
  const b = box(t);
  const s = await stub(t);
  const job = b.job([{ op: 'rest-consume', data: { name: 'Acme', auth: { type: 'bearer' }, methods: [
    { name: 'Latest', url: `${s.origin}/latest?from=BRL` }, { name: 'Given', url: `${s.origin}/given`, sample: { a: 1 } },
    { name: 'Create', verb: 'POST', url: `${s.origin}/items`, request: { a: 1 } }] } }]);
  const prepared = await prepareIntegrationJob(job, { lane: 'o11', localRoot: b.local, destructive: false });
  assert.equal(prepared.ok, false);
  assert.deepEqual(prepared.problems.map(p => [p.code, p.path]), [['REST_CONSUME_SAMPLE_MISSING', '/ops/0/data/methods/0/sample']]);
  assert.match(prepared.problems[0].message, /authenticated \(auth bearer\)/);
  assert.equal(s.hits.length, 0);
});

test('basic on O11 gets the BinaryData reference its runtime encoding needs; ODC and the other modes get none', async t => {
  const b = box(t);
  const basic = { op: 'rest-consume', data: { name: 'Acme', auth: { type: 'basic' }, methods: [{ name: 'Ping', url: 'https://x.example/ping', sample: { ok: true } }] } };
  const o11 = await prepareIntegrationJob(b.job([structuredClone(basic)]), { lane: 'o11', localRoot: b.local, destructive: false });
  assert.equal(o11.ok, true);
  assert.equal(o11.changed, true);
  const ops = JSON.parse(fs.readFileSync(o11.job, 'utf8')).ops;
  assert.equal(ops[0].op, 'rest-consume'); // no op of the model moves: the reference is appended
  assert.deepEqual(ops[1], { op: 'reference', producer: 'BinaryData', elements: ['IServerAction:TextToBinaryData', 'IServerAction:BinaryToBase64'] });
  // An op that already references BinaryData gets the missing elements, no second op.
  const tickets = { op: 'reference', producer: 'BinaryData', elements: ['IServerActionSignature:BinaryDataSize'] };
  const merged = JSON.parse(fs.readFileSync((await prepareIntegrationJob(b.job([tickets, structuredClone(basic)]), { lane: 'o11', localRoot: b.local, destructive: false })).job, 'utf8')).ops;
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].elements, ['IServerActionSignature:BinaryDataSize', 'IServerAction:TextToBinaryData', 'IServerAction:BinaryToBase64']);
  // ODC keeps the Base64 setting; a bearer op needs nothing: the job is left as it is.
  assert.equal((await prepareIntegrationJob(b.job([structuredClone(basic)]), { lane: 'odc', localRoot: b.local, destructive: false })).changed, false);
  const bearer = structuredClone(basic); bearer.data.auth.type = 'bearer';
  assert.equal((await prepareIntegrationJob(b.job([bearer]), { lane: 'o11', localRoot: b.local, destructive: false })).changed, false);
});

test('fetchSample answers a refusal, never throws, when the network fails', async () => {
  const failing = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const read = await fetchSample('https://nowhere.invalid/x', { fetchImpl: failing, at: '/x' });
  assert.equal(read.problem.code, 'REST_CONSUME_SAMPLE_FETCH_FAILED');
});
