// fase4-28 r4-rest-hosted: rest-consume on a hosted server. Its kernel op is pure (RestConsume.cs reads no file and no
// network: the plan is built from the op's data); the one server-side read it had was the facade's sample GET of a job's
// url (integration-documents.mjs sampleRestConsume), the server's own network. Hosted, the generator runs in its input mode
// 'inline-samples' (generators.mjs GENERATOR_APPROVAL hosted): every input is in the job, a GET method carries its
// "sample", and the gate refuses a job that lacks one (DOCUMENT_FETCH_HOSTED_REFUSED, policy HOSTED_GENERATOR_OPS) in every
// form a job reaches it, before the agent, any path brought and any capture; the documents step never fetches either.
// A job FILE is confined like any other (ws:, agent:inbox; a server path, .., UNC, a link out, another customer's folder are
// PATH_OUTSIDE_WORKSPACE). discover still never offers it (the owner's rule: only an approved generator is offered); by
// name, a hosted answer describes the hosted mode with a call that carries its samples. Fakes only: no hub, agent or Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrapHostedTool, restConsumeUnsampled } from '../hosted/policy.mjs';
import { describeGenerator, generatorFor, offered, hostedGeneratorMode } from '../generators.mjs';
import { HOSTED_INSTRUCTIONS, HOSTED_INSTRUCTIONS_CODE_OFF } from '../ssam.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';
import { portuguese } from './fixtures/portuguese.mjs';
import { watchNetwork } from './fixtures/no-network.mjs';

test.after(cleanupHostedDirs);
const TOOLS = ['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job'];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
// The URLs a hostile job names: the server itself, cloud metadata, private and link-local ranges, IPv6 loopback, a file: URL
// and a UNC-looking one. None may ever be requested by the server.
const HOSTILE = ['http://127.0.0.1:9/internal', 'http://localhost:2375/containers/json', 'http://169.254.169.254/latest/meta-data/iam/',
  'http://metadata.google.internal/computeMetadata/v1/', 'http://10.0.0.1/admin', 'http://[::1]:8080/', 'http://0x7f000001/', 'file:///etc/passwd',
  '\\\\fileserver\\share\\api.json'];
const unsampled = (name = 'Internal', urls = HOSTILE) => ({ op: 'rest-consume', data: { name, methods: urls.map((url, i) => ({ name: 'M' + i, url })) } });
const SAMPLED = { op: 'rest-consume', data: { name: 'Shop', baseUrl: 'https://api.shop.example', auth: { type: 'bearer' }, headers: { Accept: 'application/json' }, methods: [
  { name: 'Products', url: '/products?limit={limit=20}', sample: [{ id: 1, title: 'Pen', price: 1.5 }] },
  { name: 'Product', url: '/products/{id=1}', sample: { id: 1, title: 'Pen', price: 1.5 } },
  { name: 'AddProduct', verb: 'POST', url: '/products', request: { title: 'Pen', price: 1.5 }, sample: { id: 2 } },
  { name: 'DropProduct', verb: 'DELETE', url: '/products/{id=1}' }] } };

function harness({ connected = true } = {}) {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected });
  const pulls = [];
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }),
    async call(kind) { throw Object.assign(new Error('no machine call: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); },
    async pullFile(value) { pulls.push(value); const file = path.join(dirs.workspace, ...value.slice(6).split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(link.agentFile(value), file); return file; } };
  const context = { id: 'ctx-rest', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const gate = name => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, async args => { calls.push({ name, args }); return reply({ ok: true }); },
      { context, link, lanes: context.lanes, run: (ctx, fn) => fn(), waitMs: 10 });
    return args => wrapped(args, { requestId: 1 });
  };
  const lane = name => (name === 'studio_deliver' ? { feature: 'F', module: 'M' } : name === 'ssam_job' ? { lane: 'o11' } : { module: 'M' });
  const ws = (...p) => path.join(dirs.workspace, ...p);
  return { ...dirs, link, executor, context, calls, pulls, gate, lane, ws };
}
// No request leaves this process while fn runs: the global fetch records and fails.
// No request leaves this process while fn runs (review B4: fetch, node:http/https, net and DNS; fixtures/no-network.mjs).
async function noNetwork(fn) {
  const watch = watchNetwork();
  try { await fn(); } finally { watch.restore(); }
  return watch.asked;
}
const sampleRefusal = (result, label) => {
  const value = result.structuredContent;
  assert.equal(result.isError, true, label);
  assert.equal(value.code, 'DOCUMENT_FETCH_HOSTED_REFUSED', label + ': ' + JSON.stringify(value).slice(0, 400));
  assert.equal(value.cause, 'REST_CONSUME_SAMPLE_MISSING', label);
  assert.equal(value.policy, 'HOSTED_GENERATOR_OPS', label);
  assert.equal(value.generator, 'rest-consume', label);
  assert.equal(value.outcome, 'not-sent', label);
  assert.equal(typeof value.pointer, 'string', label);
  assert.match(value.error, /never calls an API a job names/, label);
  assert.match(value.fix, /"sample"/, label);
  assert.deepEqual(portuguese(value.error + ' ' + value.fix), [], label + ': English only');
  assert.equal(value.continuation.tool, 'ssam_reference', label);
  return value;
};

test('the table: no generator is offered (blind test pending); rest-consume runs hosted in inline-samples, entity-actions and gen-screen in job-only', () => {
  for (const id of ['rest-consume', 'entity-actions', 'gen-screen']) assert.equal(offered(id), false, id);
  assert.equal(hostedGeneratorMode('rest-consume'), 'inline-samples');
  assert.equal(hostedGeneratorMode('entity-actions'), 'job-only');
  assert.equal(hostedGeneratorMode('gen-screen'), 'job-only');
  assert.equal(generatorFor('consume the REST API https://brasilapi.com.br/api/cep/v1/01001000'), null, 'discover never offers a generator that is not approved');
});

test('restConsumeUnsampled: each GET method without sample (absent or null), any case and alias, JSON text, patch values', () => {
  assert.deepEqual(restConsumeUnsampled({ ops: [SAMPLED] }), []);
  assert.deepEqual(restConsumeUnsampled({ ops: [{ op: 'rest', data: { client: { name: 'X' }, methods: [{ name: 'A', url: '/a' }] } }] }), [], 'op rest is not the generator');
  assert.deepEqual(restConsumeUnsampled({ ops: [{ op: 'Gen-Rest', data: { methods: [{ name: 'A', url: 'https://x.example/a', sample: null }, { name: 'B', verb: 'get', url: 'https://x.example/b' }, { name: 'C', verb: 'POST', url: 'https://x.example/c', request: { a: 1 } }] } }] }),
    [{ path: '/ops/0/data/methods/0', method: 'A' }, { path: '/ops/0/data/methods/1', method: 'B' }]);
  assert.deepEqual(restConsumeUnsampled(JSON.stringify([unsampled('X', ['https://x.example/a'])]), '/job'), [{ path: '/job/0/data/methods/0', method: 'M0' }]);
  assert.deepEqual(restConsumeUnsampled([{ op: 'add', path: '/ops/-', value: unsampled('X', ['https://x.example/a']) }], '/patch'), [{ path: '/patch/0/value/data/methods/0', method: 'M0' }]);
});

test('an unsampled GET is refused in the four job tools and ssam_code, in every form a job reaches the gate: nothing ran, nothing was fetched or brought', async () => {
  for (const connected of [true, false]) {
    const h = harness({ connected });
    const base = write(h.ws('o11', 'jobs', 'base.json'), { ops: [{ op: 'entity', data: { name: 'Order' } }, SAMPLED] });
    const basedOn = { job: 'ws:o11/jobs/base.json', sha256: 'a'.repeat(64) };
    write(h.ws('inbox', 'rc.json'), { ops: [unsampled()] });
    write(h.ws('odc', 'lab', 'part.json'), { ops: [unsampled('Part', ['https://api.example.com/x'])] });
    write(h.ws('odc', 'lab', 'composite.json'), { jobs: ['part.json'] });
    const asked = await noNetwork(async () => {
      for (const name of TOOLS) {
        const forms = {
          'inline job': { job: { ops: [{ op: 'entity', data: { name: 'Order' } }, unsampled()] } },
          'job as JSON text': { job: JSON.stringify({ ops: [unsampled()] }) },
          'alias gen-rest, any case': { job: { ops: [{ ...unsampled(), op: 'GEN-REST' }] } },
          'sample null': { job: { ops: [{ op: 'rest-consume', data: { name: 'N', methods: [{ name: 'A', url: 'https://api.example.com/a', sample: null }] } }] } },
          // The shapes the blind test passed through the gate (the kernel then refused them; the gate now refuses first).
          'methods at the op, no data': { job: { ops: [{ op: 'rest-consume', name: 'N', methods: [{ name: 'A', url: 'http://127.0.0.1:9/a' }] }] } },
          'data as JSON text': { job: { ops: [{ op: 'rest-consume', data: JSON.stringify({ name: 'N', methods: [{ name: 'A', url: 'http://127.0.0.1:9/a' }] }) }] } },
          'a method as JSON text': { job: { ops: [{ op: 'rest-consume', data: { name: 'N', methods: [JSON.stringify({ name: 'A', url: 'http://127.0.0.1:9/a' })] } }] } },
          'data that is no object': { job: { ops: [{ op: 'rest-consume', data: 'GET http://127.0.0.1:9/a' }] } },
          'partial job over basedOn': { job: { ops: [unsampled()] }, basedOn },
          'patch adding the op': { patch: [{ op: 'add', path: '/ops/-', value: unsampled() }], basedOn },
          'patch adding a GET method to a sampled op of the base': { patch: [{ op: 'add', path: '/ops/1/data/methods/-', value: { name: 'Meta', url: 'http://169.254.169.254/latest/meta-data/' } }], basedOn },
          'patch removing a sample of the base': { patch: [{ op: 'remove', path: '/ops/1/data/methods/0/sample' }], basedOn },
          'patch renaming an op of the base into rest-consume': { patch: [{ op: 'replace', path: '/ops/0', value: { op: 'entity', data: { name: 'Order' } } },
            { op: 'add', path: '/ops/-', value: { op: 'entity', data: {} } }, { op: 'replace', path: '/ops/2/op', value: 'rest-consume' }, { op: 'add', path: '/ops/2/data/methods', value: [{ name: 'X', url: 'http://10.0.0.1/' }] }], basedOn },
          'a job file of the workspace': { job: 'ws:inbox/rc.json' },
          'a composite part of the workspace': { job: 'ws:odc/lab/composite.json' },
        };
        // The forms read inline are refused before the agent; the ones the gate builds from files (a job file, a part, the job a
        // patch makes) after the agent check, as every check of the job files: disconnected, the agent refusal comes first.
        const late = /^patch adding a GET|^patch removing|^patch renaming|job file|composite/;
        for (const [label, args] of Object.entries(forms)) {
          const result = await h.gate(name)({ ...h.lane(name), ...args });
          // (a headless ssam_job needs no agent: its own refusal answers there too)
          if (!connected && late.test(label) && result.structuredContent.code === 'AGENT_NOT_CONNECTED') continue;
          sampleRefusal(result, name + ' ' + label);
        }
      }
      for (const action of ['write', 'check']) {
        sampleRefusal(await h.gate('ssam_code')({ lane: 'odc', action, module: 'M', ops: [unsampled()] }), 'ssam_code ' + action);
        if (connected) sampleRefusal(await h.gate('ssam_code')({ lane: 'o11', action, module: 'M', files: ['ws:inbox/rc.json'] }), 'ssam_code ' + action + ' files');
      }
    });
    assert.ok(fs.existsSync(base));
    assert.deepEqual(asked, [], 'no request left the server');
    assert.deepEqual(h.calls, [], 'no handler ran');
    assert.deepEqual(h.pulls, [], 'nothing was brought from the agent');
    assert.deepEqual(h.link.calls, [], 'nothing reached the agent');
  }
});

test('a rest-consume job FILE outside the workspace is PATH_OUTSIDE_WORKSPACE: a server path, .., UNC, a link out, another customer\'s folder', async () => {
  const h = harness();
  const outside = write(path.join(h.root, 'outside', 'rc.json'), { ops: [SAMPLED] });
  const other = write(path.join(h.root, 'server', 'customers', 'tok_other', 'inbox', 'rc.json'), { ops: [SAMPLED] });
  fs.symlinkSync(path.dirname(outside), h.ws('inbox', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  // A symbolic link (file and directory) where the platform lets this process make one (Windows: developer mode or admin).
  const symlinks = {};
  try { fs.symlinkSync(outside, h.ws('inbox', 'file-link.json'), 'file'); symlinks['a file symlink inside the workspace that leads out'] = 'ws:inbox/file-link.json'; } catch { /* EPERM */ }
  try { fs.symlinkSync(path.dirname(other), h.ws('o11', 'other-link'), 'dir'); symlinks['a directory symlink to another customer\'s folder'] = 'ws:o11/other-link/rc.json'; } catch { /* EPERM */ }
  const paths = {
    'a server path': outside,
    'another customer\'s job': other,
    'ws: climbing out with ..': 'ws:../tok_other/inbox/rc.json',
    'ws: inbox climbing out with ..': 'ws:inbox/../../tok_other/inbox/rc.json',
    'a link inside the workspace that leads out': 'ws:inbox/link/rc.json',
    ...(process.platform === 'win32' ? { 'a UNC path': '\\\\fileserver\\share\\rc.json', 'a device path': '\\\\?\\' + outside } : {}),
    ...symlinks,
  };
  const asked = await noNetwork(async () => {
    for (const name of TOOLS) for (const [label, job] of Object.entries(paths)) {
      const result = (await h.gate(name)({ ...h.lane(name), job })).structuredContent;
      assert.equal(result.ok, false, name + ' ' + label);
      assert.ok(['PATH_OUTSIDE_WORKSPACE', 'PATH_FORBIDDEN', 'PATH_NOT_AGENT'].includes(result.code), name + ' ' + label + ': ' + JSON.stringify(result).slice(0, 300));
      assert.equal(JSON.stringify(result).includes('"price"'), false, name + ' ' + label + ': nothing of the file is answered');
    }
    // A composite part reached through the junction: refused before the handler (D2 of fase4-25 answers it as an unreadable
    // prototype first, as the blind test saw; a path refusal otherwise).
    write(h.ws('odc', 'lab', 'via-link.json'), { jobs: ['../../inbox/link/rc.json'] });
    for (const name of TOOLS) {
      const part = (await h.gate(name)({ ...h.lane(name), job: 'ws:odc/lab/via-link.json' })).structuredContent;
      assert.ok(part.code === 'PATH_OUTSIDE_WORKSPACE' || part.cause === 'PROTOTYPE_IMPORT_DISABLED', name + ' composite part through a junction: ' + JSON.stringify(part).slice(0, 300));
    }
    // The job of basedOn outside the workspace, with an explicit patch.
    for (const name of TOOLS) {
      const result = (await h.gate(name)({ ...h.lane(name), basedOn: { job: outside, sha256: 'a'.repeat(64) }, patch: [{ op: 'add', path: '/ops/-', value: SAMPLED }] })).structuredContent;
      assert.equal(result.ok, false, name + ' basedOn outside');
      assert.equal(result.code, 'PATH_OUTSIDE_WORKSPACE', name + ' basedOn outside: ' + JSON.stringify(result).slice(0, 300));
    }
  });
  // A URL at the job argument (file:, http:) is no path of this account: PATH_OUTSIDE_WORKSPACE (the blind test of
  // r4-rest-hosted found a file: URL taken as a relative name under ws:o11/), never the server file it spells.
  for (const name of TOOLS) for (const job of ['file:///' + outside.replace(/\\/g, '/'), 'file:' + outside, 'http://127.0.0.1:9/job.json', 'https://example.com/job.json']) {
    const url = (await h.gate(name)({ ...h.lane(name), job })).structuredContent;
    assert.equal(url.code, 'PATH_OUTSIDE_WORKSPACE', name + ' ' + job + ': ' + JSON.stringify(url).slice(0, 300));
    assert.equal(JSON.stringify(url).includes(h.root), false, 'no server path in the answer');
  }
  assert.deepEqual(asked, []);
  assert.deepEqual(h.calls, [], 'no handler ran');
});

test('a rest-consume job with every input inline runs in the four job tools and ssam_code: inline, a workspace job file, a patch; the samples reach the handler unchanged', async () => {
  const h = harness();
  write(h.ws('inbox', 'shop.json'), { ops: [SAMPLED] });
  write(h.ws('o11', 'jobs', 'base.json'), { ops: [{ op: 'entity', data: { name: 'Order' } }] });
  const basedOn = { job: 'ws:o11/jobs/base.json', sha256: 'a'.repeat(64) };
  // A sample that looks like a path is data, never a file: it reaches the kernel as written (which reads it as JSON text).
  const pathLike = { op: 'rest-consume', data: { name: 'Odd', methods: [{ name: 'A', url: 'https://api.example.com/a', sample: 'C:\\Windows\\win.ini' },
    { name: 'B', url: 'https://api.example.com/b', sample: 'ws:inbox/../../tok_other/secret.json' }] } };
  const asked = await noNetwork(async () => {
    for (const name of TOOLS) {
      for (const [label, args] of Object.entries({ inline: { job: { ops: [SAMPLED] } }, 'job file': { job: 'ws:inbox/shop.json' },
        patch: { patch: [{ op: 'add', path: '/ops/-', value: SAMPLED }], basedOn }, 'path-like samples': { job: { ops: [pathLike] } } })) {
        const result = await h.gate(name)({ ...h.lane(name), ...args });
        assert.notEqual(result.isError, true, name + ' ' + label + ': ' + JSON.stringify(result.structuredContent).slice(0, 400));
      }
    }
    const code = await h.gate('ssam_code')({ lane: 'odc', action: 'write', module: 'M', ops: [SAMPLED] });
    assert.notEqual(code.isError, true, JSON.stringify(code.structuredContent).slice(0, 400));
  });
  assert.deepEqual(asked, []);
  assert.equal(h.calls.length, TOOLS.length * 4 + 1);
  const inline = h.calls.find(c => c.name === 'o11_deliver' && c.args.job?.ops);
  assert.deepEqual(inline.args.job.ops[0], SAMPLED, 'the op is handed on as sent');
  const odd = h.calls.find(c => c.name === 'ssam_job' && c.args.job?.ops?.[0]?.data?.name === 'Odd');
  assert.equal(odd.args.job.ops[0].data.methods[0].sample, 'C:\\Windows\\win.ini', 'a path-like sample is not rewritten or read');
});

test('by name, a hosted answer describes the hosted mode with a call that carries its samples; the local answer is unchanged', () => {
  const local = describeGenerator('rest-consume', 'o11');
  assert.match(local.use, /until an independent blind test approves it/);
  assert.equal(local.call.arguments.ops[0].data.methods[0].sample, undefined);
  const hosted = describeGenerator('rest-consume', 'o11', { hosted: true });
  assert.match(hosted.use, /this hosted server runs it called explicitly/);
  assert.match(hosted.use, /"sample"/);
  assert.deepEqual(restConsumeUnsampled(hosted.call.arguments.ops), [], 'the hosted call passes the gate as it is');
  assert.deepEqual(portuguese(hosted.use), []);
  for (const id of ['entity-actions', 'gen-screen']) {
    const jobOnly = describeGenerator(id, 'o11', { hosted: true });
    assert.equal(jobOnly.use, 'not offered by ssam_discover; this hosted server runs it called explicitly with its op (ssam_job, o11_job, o11_deliver, ssam_code write ops)', id);
    assert.match(describeGenerator(id, 'o11').use, /until an independent blind test approves it/, id + ': the local answer is unchanged');
  }
});

test('the hosted instructions (ssam_code on and off) say the generator ops run called by name, rest-consume with its samples inline', () => {
  for (const text of [HOSTED_INSTRUCTIONS, HOSTED_INSTRUCTIONS_CODE_OFF]) {
    assert.match(text, /The generator ops entity-actions, rest-consume and screen with data\.generate are not offered by ssam_discover but run here when a job names their op/);
    assert.match(text, /rest-consume needs every input in the job: "sample" \(the JSON response\) in each GET method, as this server never calls the API/);
    assert.doesNotMatch(text, /GENERATOR_PENDING|are refused \(GENERATOR/);
    assert.deepEqual(portuguese(text), []);
  }
});
