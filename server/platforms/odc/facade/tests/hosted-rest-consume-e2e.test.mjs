// fase4-28 r4-rest-hosted: rest-consume end to end through the hosted gate, on both lanes, with every input inline (the
// hosted input mode). Representative APIs, their samples taken from the kernel's recorded answers
// (kernel/tests/fixtures/rest-consume): a JSON GET list (IBGE states), a GET with a path input and a nested answer
// (REST Countries by code), a POST with a JSON body (JSONPlaceholder), an API with a bearer token and one with an API key
// header plus fixed headers. Each job goes through the real hosted gate (wrapHostedTool, a hosted context with a fake agent),
// then, inside that hosted context, through the documents step (integration-documents.mjs prepareIntegrationJob, confined to
// the customer's workspace) and the kernel's apply on the blank O11 service module and the ODC reactive app; the global fetch
// fails the test if anything asks for the network. Same flow as the server: the kernel runs on the server, and the agent
// only carries the capture and the merge of the result, as for any job (no new bridge verb: rest-consume makes no
// integration_import request, Delivery.cs IntegrationImport.Requests). The kernel's CLIs: SSAM_E2E_O11_CLI /
// SSAM_E2E_ODC_CLI, else this worktree's kernel/.local; without them the kernel step is skipped (said as a diagnostic).
// SSAM_E2E_VERDICT=<file>: the verdict of each run, as JSON, for the report.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { runWithExecutor } from '../executor.mjs';
import { prepareIntegrationJob } from '../integration-documents.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const recorded = name => JSON.parse(fs.readFileSync(path.join(kernel, 'tests', 'fixtures', 'rest-consume', name + '.json'), 'utf8'));
const CLI = { o11: process.env.SSAM_E2E_O11_CLI || path.join(kernel, '.local', 'cli', 'anvil.dll'),
  odc: process.env.SSAM_E2E_ODC_CLI || path.join(kernel, '.local', 'lane-odc', 'cli', 'anvil-odc.dll') };
const BASE = { o11: path.join(kernel, 'tests', 'fixtures', 'blank-service.oml'), odc: path.join(kernel, 'tests', 'fixtures', 'odc', 'insurance-reactive-r8.oml') };

const APIS = {
  'JSON GET list': { op: 'rest-consume', data: { name: 'Ibge', baseUrl: 'https://servicodados.ibge.gov.br/api/v1/localidades', methods: [
    { name: 'Estados', url: '/estados', resource: 'State', sample: recorded('ibge-estados') }] } },
  'GET with a path input': { op: 'rest-consume', data: { name: 'Countries', methods: [
    { name: 'Alpha', url: 'https://restcountries.com/v3.1/alpha/{code=BR}', resource: 'Country', sample: recorded('restcountries-alpha') }] } },
  'POST with a JSON body': { op: 'rest-consume', data: { name: 'Placeholder', methods: [
    { name: 'CreatePost', verb: 'POST', url: 'https://jsonplaceholder.typicode.com/posts', resource: 'Post', request: recorded('jsonplaceholder-post-request'), sample: recorded('jsonplaceholder-post-response') }] } },
  'bearer token': { op: 'rest-consume', data: { name: 'Acme', baseUrl: 'https://api.acme.example/v1', auth: { type: 'bearer' }, methods: [
    { name: 'Order', url: '/orders/{id=1}', sample: { id: 1, status: 'open', total: 12.5, items: [{ sku: 'A1', qty: 2 }] } }] } },
  'API key header and fixed headers': { op: 'rest-consume', data: { name: 'Weather', baseUrl: 'https://api.weather.example', auth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    headers: { Accept: 'application/json' }, methods: [
      { name: 'Forecast', url: '/forecast?lat={lat=-23.5}&lon={lon=-46.6}', headers: { 'X-Units': 'metric' }, sample: recorded('openmeteo-forecast') }] } },
};
// What the receipt must show of each API: the REST methods, the actions with their inputs, and the secret settings.
const EXPECT = {
  'JSON GET list': { methods: ['Estados'], signature: /GetIbgeEstados\(\) -> Result: State List/, configure: [] },
  'GET with a path input': { methods: ['Alpha'], signature: /GetCountriesAlpha\(Code: Text\) -> Result: Country List/, configure: [] },
  'POST with a JSON body': { methods: ['CreatePost'], signature: /\(Request: PostRequest\) -> Result: Post/, configure: [] },
  'bearer token': { methods: ['Order'], signature: /GetAcmeOrder\(Id: Integer\) -> Result: \w+/, configure: ['AcmeToken'] },
  'API key header and fixed headers': { methods: ['Forecast'], signature: /GetWeatherForecast\(Lat: Decimal, Lon: Decimal\) -> Result: \w+/, configure: ['WeatherApiKey'] },
};

function hosted() {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot });
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }), relayPort: () => 47003,
    async call(kind) { throw Object.assign(new Error('no machine call: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); } };
  const context = { id: 'ctx-rest-e2e', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  return { ...dirs, link, context };
}

// The job the gate let through, run as the server runs it: in the hosted context, the documents step, then the kernel.
async function runOnServer(h, args, t, base = BASE[args.lane]) {
  const lane = args.lane;
  const folder = path.join(h.workspace, lane, '.local', 'jobs', 'inline');
  fs.mkdirSync(folder, { recursive: true });
  const job = path.join(folder, 'job-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(job, JSON.stringify(args.job));
  const prepared = await prepareIntegrationJob(job, { lane, localRoot: path.join(h.workspace, lane, '.local'), destructive: false });
  if (prepared.ok === false) return { stage: 'documents', prepared };
  if (!fs.existsSync(CLI[lane])) { t.diagnostic(lane + ' CLI not built (' + CLI[lane] + '): the kernel step is skipped'); return { stage: 'documents', prepared, kernel: null }; }
  const out = path.join(h.workspace, lane, 'tmp', 'out.oml');
  const run = spawnSync('dotnet', [CLI[lane], 'apply', '--job', prepared.job, '--base', base, '--out', out, '--work', path.join(h.workspace, lane, 'tmp', 'work')],
    { cwd: kernel, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_NO_WARM: '1' } });
  let answer = null;
  try { answer = JSON.parse(run.stdout); } catch { /* below */ }
  if (!answer && /Service Studio|StudioAssemblies|ODC Studio/i.test(run.stdout + run.stderr)) { t.diagnostic('no Studio assemblies here: ' + (run.stderr || run.stdout).slice(0, 200)); return { stage: 'kernel', prepared, kernel: null }; }
  return { stage: 'kernel', prepared, kernel: answer, status: run.status, stderr: run.stderr.slice(-2000) };
}

const verdicts = [];
test.after(() => { if (process.env.SSAM_E2E_VERDICT) fs.writeFileSync(process.env.SSAM_E2E_VERDICT, JSON.stringify(verdicts, null, 2)); });

for (const lane of ['o11', 'odc']) {
  test(lane + ': five representative APIs, every input inline, through the hosted gate, the documents step and the kernel, with no request to the network', async t => {
    const h = hosted();
    const handled = [];
    const wrapped = wrapHostedTool('ssam_job', { inputSchema: {} }, async args => { handled.push(args); return { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } }; },
      { context: h.context, link: h.link, lanes: h.context.lanes, run: (ctx, fn) => fn(), waitMs: 10 });
    const original = globalThis.fetch;
    const asked = [];
    globalThis.fetch = async url => { asked.push(String(url)); throw new Error('the network was asked: ' + url); };
    try {
      // One job with the five APIs (one op per host), as a model writes it.
      const job = { ops: Object.values(APIS) };
      const gated = await wrapped({ lane, job }, { requestId: 1 });
      assert.notEqual(gated.isError, true, JSON.stringify(gated.structuredContent).slice(0, 400));
      assert.equal(handled.length, 1, 'the gate let the job through');
      const started = Date.now();
      const result = await runWithExecutor(h.context, () => runOnServer(h, handled[0], t));
      assert.notEqual(result.prepared.ok, false, JSON.stringify(result.prepared).slice(0, 600));
      assert.equal(result.prepared.changed, false, 'nothing to pin: every sample was given');
      const verdict = { lane, apis: Object.keys(APIS), gate: 'passed', documents: 'unchanged, nothing fetched', ms: null, kernel: null };
      if (result.kernel) {
        const data = result.kernel.data ?? {};
        assert.equal(result.kernel.ok, true, JSON.stringify(result.kernel).slice(0, 1500) + result.stderr);
        assert.equal(data.accepted, true, JSON.stringify(data.validation ?? {}).slice(0, 1500));
        assert.equal(data.isValid, true);
        const receipts = data.integration ?? [];
        assert.equal(receipts.length, Object.keys(APIS).length);
        verdict.kernel = {};
        for (const [label, op] of Object.entries(APIS)) {
          const receipt = receipts.find(r => r.client?.name === op.data.name);
          assert.ok(receipt, label + ': a receipt for ' + op.data.name);
          const methods = receipt.generated.methods;
          assert.deepEqual(methods.map(m => m.method), EXPECT[label].methods, label);
          assert.match(methods[0].action.signature, EXPECT[label].signature, label + ': ' + methods[0].action.signature);
          assert.deepEqual((receipt.configure ?? []).map(c => c.name), EXPECT[label].configure, label + ': the secret settings the user fills');
          assert.ok((receipt.configure ?? []).every(c => c.secret === true && c.default == null), label + ': no credential in the model');
          verdict.kernel[label] = { client: receipt.client.name, signature: methods[0].action.signature, http: methods[0].http, url: methods[0].url,
            configure: (receipt.configure ?? []).map(c => c.name), elements: receipt.imported.length };
        }
        verdict.ms = Date.now() - started;
      }
      verdicts.push(verdict);
    } finally { globalThis.fetch = original; }
    assert.deepEqual(asked, [], 'no request left the server');
  });
}

test('the same job without its samples is refused at the gate on both lanes, and nothing reaches the documents step or the kernel', async () => {
  const h = hosted();
  const handled = [];
  const wrapped = wrapHostedTool('ssam_job', { inputSchema: {} }, async args => { handled.push(args); return { content: [], structuredContent: { ok: true } }; },
    { context: h.context, link: h.link, lanes: h.context.lanes, run: (ctx, fn) => fn(), waitMs: 10 });
  const bare = structuredClone(Object.values(APIS));
  for (const op of bare) for (const method of op.data.methods) if (String(method.verb ?? 'GET') === 'GET') delete method.sample;
  for (const lane of ['o11', 'odc']) {
    const value = (await wrapped({ lane, job: { ops: bare } }, { requestId: 1 })).structuredContent;
    assert.equal(value.code, 'DOCUMENT_FETCH_HOSTED_REFUSED');
    assert.deepEqual(value.methods, ['Estados', 'Alpha', 'Order', 'Forecast']);
  }
  assert.deepEqual(handled, []);
});

// r4-rest-hosted (C7): the generators of mode job-only, entity-actions and screen with data.generate, called by name through
// the hosted gate and run by the server's kernel over a reactive module of each lane (the kernel's own example jobs, their
// base given apart as the server gives the capture): the gate lets them through, and the kernel writes their elements with
// no file and no request outside the workspace.
const JOB_ONLY = {
  o11: [['entity-actions', 'entity-actions.json', 'blank-service.oml'], ['gen-screen', 'screen-generate-reactive.json', 'reactive-ui.oml']],
  odc: [['entity-actions', 'entity-actions.json', 'odc/insurance-reactive-r8.oml'], ['gen-screen', 'screen-generate.json', 'odc/insurance-reactive-r8.oml']] };
for (const lane of ['o11', 'odc']) {
  test(lane + ': entity-actions and screen with data.generate called by name pass the hosted gate and the kernel applies them, with no request to the network', async t => {
    const h = hosted();
    const handled = [];
    const wrapped = wrapHostedTool('ssam_job', { inputSchema: {} }, async args => { handled.push(args); return { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } }; },
      { context: h.context, link: h.link, lanes: h.context.lanes, run: (ctx, fn) => fn(), waitMs: 10 });
    const original = globalThis.fetch;
    const asked = [];
    globalThis.fetch = async url => { asked.push(String(url)); throw new Error('the network was asked: ' + url); };
    try {
      for (const [id, file, base] of JOB_ONLY[lane]) {
        const { base: _, description: __, ...job } = JSON.parse(fs.readFileSync(path.join(kernel, 'tests', lane === 'o11' ? 'jobs' : 'jobs-odc', file), 'utf8'));
        const gated = await wrapped({ lane, job }, { requestId: 1 });
        assert.notEqual(gated.isError, true, id + ': ' + JSON.stringify(gated.structuredContent).slice(0, 400));
        const result = await runWithExecutor(h.context, () => runOnServer(h, handled.at(-1), t, path.join(kernel, 'tests', 'fixtures', base)));
        assert.notEqual(result.prepared.ok, false, id + ': ' + JSON.stringify(result.prepared).slice(0, 600));
        const verdict = { lane, generator: id, gate: 'passed', kernel: null };
        if (result.kernel) {
          assert.equal(result.kernel.ok, true, id + ': ' + JSON.stringify(result.kernel).slice(0, 1500) + result.stderr);
          assert.equal(result.kernel.data?.accepted, true, id + ': ' + JSON.stringify(result.kernel.data?.validation ?? {}).slice(0, 1500));
          verdict.kernel = { accepted: true, isValid: result.kernel.data.isValid, generated: Object.keys(result.kernel.data.entityActions ?? result.kernel.data.generated ?? {}).slice(0, 10) };
        }
        verdicts.push(verdict);
      }
    } finally { globalThis.fetch = original; }
    assert.deepEqual(asked, [], 'no request left the server');
  });
}
