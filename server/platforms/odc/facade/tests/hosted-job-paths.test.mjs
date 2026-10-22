// Item 1 of the 24th rehearsal (servidor/fase4-24): the paths INSIDE a hosted job are confined to the customer's
// workspace (hosted/job-paths.mjs, through the gate of hosted/policy.mjs). Every path-typed field of the kernel's job
// contracts (base, a composite part by path or job:<name>, a reference's producer, an html file, the prototype's source
// and capture, a soap WSDL and its imports, a rest OpenAPI document and its external files), in every shape a job comes in
// (an inline object, its JSON text, a job file of the workspace, a composite part file), with an absolute path of this
// server, a ..\ traversal, another customer's workspace, a UNC path and a junction inside the workspace that leads out:
// PATH_OUTSIDE_WORKSPACE naming the job pointer, and the handler never runs. A legitimate ws: path still works (inline it
// is rewritten to the absolute workspace path the kernel reads); the JSON text of a job is the job only on a job pointer;
// the prototype op and the composite rule still hold for inline text. A fake link, context and executor; no hub, agent,
// kernel or Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { createSsamServer } from '../ssam.mjs';
import { anvilRoot } from '../workspace.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const SHA = 'a'.repeat(64);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
const TOOLS = ['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job'];
const laneArgs = name => (name === 'studio_deliver' ? { feature: 'F', module: 'M' } : name === 'ssam_job' ? { lane: 'o11' } : name === 'ssam_reference' ? { lane: 'o11', kind: 'check-job' } : { module: 'M' });

function harness() {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected: true });
  const pulls = [];
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }),
    async call(kind) { throw Object.assign(new Error('no machine call: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); },
    async pullFile(value) { pulls.push(value); return write(path.join(dirs.workspace, ...value.slice(6).split('/')), 'from the agent'); } };
  const context = { id: 'ctx-job-paths', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const gate = (name, options = {}) => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, async args => { calls.push({ name, args }); return reply({ ok: true }); },
      { context, link, lanes: context.lanes, run: (ctx, fn) => fn(), waitMs: 10, ...options });
    return args => wrapped(args, { requestId: 1 });
  };
  const ws = (...p) => path.join(dirs.workspace, ...p);
  // What a hosted customer must never reach: a file of this server, another customer's workspace, and a folder outside
  // the workspace behind a junction (symbolic link elsewhere) that sits inside it.
  const other = write(path.join(dirs.root, 'server', 'customers', 'tok_other', 'inbox', 'secret.json'), '{"ops":[]}');
  const outsideDir = path.join(dirs.root, 'outside');
  write(path.join(outsideDir, 'secret.json'), '{"ops":[]}');
  fs.symlinkSync(outsideDir, ws('inbox', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  return { ...dirs, link, executor, context, calls, pulls, gate, ws, other };
}
const refusal = result => { assert.equal(result.isError, true, JSON.stringify(result).slice(0, 400)); return result.structuredContent; };

// The path-typed fields of a job: where the value goes, its pointer inside the job, and the file name a value names.
const FIELDS = [
  { name: 'base', at: '/base', doc: v => ({ base: v, ops: [{ op: 'find', name: 'x' }] }), ext: '.oml' },
  { name: 'base job:<name>', at: '/base', doc: v => ({ base: 'job:' + v.replace(/\.json$/, ''), ops: [{ op: 'find', name: 'x' }] }), ext: '.json' },
  { name: 'composite part', at: '/jobs/0', doc: v => ({ jobs: [v] }), ext: '.json' },
  { name: 'composite part job:<name>', at: '/jobs/0', doc: v => ({ jobs: ['job:' + v.replace(/\.json$/, '')] }), ext: '.json' },
  { name: 'reference producer', at: '/ops/0/producer', doc: v => ({ ops: [{ op: 'reference', producer: v, elements: ['IServerAction:A'] }] }), ext: '.oml' },
  { name: 'html file', at: '/ops/0/file', doc: v => ({ ops: [{ op: 'html', parent: '$screen', file: v }] }), ext: '.html' },
  { name: 'prototype source', at: '/ops/0/data/source', doc: v => ({ ops: [{ op: 'prototype', data: { source: v } }] }), ext: '' },
  { name: 'prototype capture', at: '/ops/0/data/capture', doc: v => ({ ops: [{ op: 'prototype', data: { source: 'ws:inbox/proto', capture: v, captureSha256: SHA } }] }), ext: '.json' },
  { name: 'soap wsdl', at: '/ops/0/data/wsdl', doc: v => ({ ops: [{ op: 'soap', data: { wsdl: v } }] }), ext: '.wsdl' },
  { name: 'soap wsdl.path', at: '/ops/0/data/wsdl/path', doc: v => ({ ops: [{ op: 'soap', data: { wsdl: { path: v, sha256: SHA } } }] }), ext: '.wsdl' },
  { name: 'soap wsdl import', at: '/ops/0/data/wsdl/imports/urn:types/path', doc: v => ({ ops: [{ op: 'soap', data: { wsdl: { path: 'ws:inbox/s.wsdl', sha256: SHA, imports: { 'urn:types': { path: v, sha256: SHA } } } } }] }), ext: '.xsd' },
  { name: 'rest openapi.path', at: '/ops/0/data/openapi/path', doc: v => ({ ops: [{ op: 'rest', data: { openapi: { path: v } } }] }), ext: '.json' },
  { name: 'rest openapi external', at: '/ops/0/data/openapi/external/types.json/path', doc: v => ({ ops: [{ op: 'rest', data: { openapi: { path: 'ws:inbox/api.json', external: { 'types.json': { path: v } } } } }] }), ext: '.json' },
];
// The values that leave the workspace (h -> {label: value}); each names a file with the field's extension.
const BAD = (h, ext) => ({
  'an absolute path of this server': path.join(anvilRoot, 'tests', 'fixtures', 'secret-of-the-server' + (ext || '-folder')),
  'a ../ traversal': '../../../state/secret' + ext,
  ...(process.platform === 'win32' ? { 'a ..\\ traversal': '..\\..\\..\\..\\..\\outside\\secret' + ext } : {}),
  "another customer's workspace": path.join(path.dirname(h.other), 'secret' + ext),
  'a UNC path': '\\\\fileserver\\share\\secret' + ext,
  'a junction inside the workspace that leads out (ws:)': 'ws:inbox/link/secret' + ext,
  'a junction inside the workspace that leads out (absolute)': h.ws('inbox', 'link', 'secret' + ext),
});
// The shapes a job comes in: inline object, its JSON text, a job file of the workspace, and a part of a composite job file.
const SHAPES = {
  'inline object': (h, doc) => ({ job: doc, prefix: '/job' }),
  'inline JSON text': (h, doc) => ({ job: JSON.stringify(doc), prefix: '/job' }),
  'a job file of the workspace': (h, doc) => { write(h.ws('inbox', 'job.json'), doc); return { job: 'ws:inbox/job.json', prefix: '/job > ' }; },
  'a composite part file': (h, doc) => { write(h.ws('inbox', 'part.json'), doc); write(h.ws('inbox', 'main.json'), { jobs: ['part.json'] }); return { job: 'ws:inbox/main.json', prefix: '/job > /jobs/0 > ' }; },
};

test('every path-typed field of a job, in every shape, outside the workspace: PATH_OUTSIDE_WORKSPACE naming the job pointer; the handler never runs', async () => {
  const h = harness();
  let checked = 0;
  for (const field of FIELDS) {
    for (const [label, value] of Object.entries(BAD(h, field.ext))) {
      for (const [shape, make] of Object.entries(SHAPES)) {
        const { job, prefix } = make(h, field.doc(value));
        // allow: the prototype switch apart (D2 answers first otherwise), so the confinement itself is what refuses
        const value_ = refusal(await h.gate('ssam_job', { prototypeOp: 'allow' })({ lane: 'o11', job }));
        const what = `${field.name} / ${label} / ${shape}: ${JSON.stringify(value_).slice(0, 300)}`;
        assert.equal(value_.code, 'PATH_OUTSIDE_WORKSPACE', what);
        assert.equal(value_.pointer, prefix + field.at, what);
        assert.match(value_.error, /^The job names, at /, what);
        checked++;
      }
    }
  }
  assert.ok(checked >= FIELDS.length * 6 * 4, 'checked ' + checked);
  assert.deepEqual(h.calls, [], 'no handler ran');
  assert.deepEqual(h.pulls, [], 'nothing was brought from the agent');
});

test('the four job tools and the check-job of ssam_reference confine the same fields (inline object and text)', async () => {
  const h = harness();
  const server = path.join(anvilRoot, 'MANIFESTO.md');
  for (const name of [...TOOLS, 'ssam_reference']) {
    for (const field of FIELDS) {
      for (const job of [field.doc(server), JSON.stringify(field.doc(server))]) {
        const args = name === 'ssam_reference' ? { ...laneArgs(name), query: job } : { ...laneArgs(name), job };
        const value = refusal(await h.gate(name, { prototypeOp: 'allow' })(args));
        assert.equal(value.code, 'PATH_OUTSIDE_WORKSPACE', name + ' ' + field.name + ': ' + JSON.stringify(value).slice(0, 300));
        assert.equal(value.pointer, (name === 'ssam_reference' ? '/query' : '/job') + field.at, name + ' ' + field.name);
      }
    }
  }
  assert.deepEqual(h.calls, []);
});

test('a file: URL is a path; a URL of a document, a binding name and the server\'s product fixtures by suite name are no paths', async () => {
  const h = harness();
  const fileUrl = pathToFileURL(path.join(anvilRoot, 'MANIFESTO.md')).href;
  assert.equal(refusal(await h.gate('o11_job')({ job: { ops: [{ op: 'soap', data: { wsdl: fileUrl } }] } })).pointer, '/job/ops/0/data/wsdl');
  assert.equal(refusal(await h.gate('o11_job')({ job: { ops: [{ op: 'html', parent: '$s', file: fileUrl }] } })).code, 'PATH_OUTSIDE_WORKSPACE');
  // A suite name with a traversal is no product fixture.
  assert.equal(refusal(await h.gate('o11_job')({ job: { base: 'tests/fixtures/../../../.local/server/tokens.oml', ops: [] } })).pointer, '/job/base');
  // A suite name that is not a product fixture (a customer capture of the suite) is a relative path like any other: inline
  // it lands under ws:o11/, never on the server's tests/fixtures.
  assert.notEqual((await h.gate('o11_job')({ job: { base: 'tests/fixtures/odc/wrightflood-personal-r8.oml', ops: [] } })).isError, true);
  assert.equal(h.calls.at(-1).args.job.base, h.ws('o11', 'tests', 'fixtures', 'odc', 'wrightflood-personal-r8.oml'));
  const job = { base: 'tests/fixtures/odc/blank-mobile.oml', ops: [{ op: 'reference', producer: 'Producer', elements: ['IServerAction:A'] },
    { op: 'reference', producer: 'tests/fixtures/odc/blank-mobile-producer.oml', elements: ['IServerAction:B'] },
    { op: 'soap', data: { wsdl: 'https://services.example.test/Orders.svc?wsdl' } }, { op: 'rest', data: { openapi: { path: 'http://api.example.test/openapi.json' } } }] };
  for (const name of TOOLS) {
    const result = await h.gate(name)({ ...laneArgs(name), job });
    assert.notEqual(result.isError, true, name + ': ' + JSON.stringify(result).slice(0, 300));
    assert.deepEqual(h.calls.at(-1).args.job, job, name + ': nothing to rewrite');
  }
});

test('a legitimate ws: path still works: inline it is rewritten to the absolute workspace path; agent:inbox keeps the mirror rule; a job file keeps its bytes', async () => {
  const h = harness();
  write(h.ws('inbox', 'frag.html'), '<div>x</div>');
  write(h.ws('inbox', 'api.json'), '{}');
  write(h.ws('o11', 'local.html'), '<p>y</p>');
  write(h.ws('inbox', 'part.json'), { ops: [{ op: 'html', parent: '$s', file: h.ws('inbox', 'frag.html') }] });
  write(h.ws('inbox', 'base-job.json'), { ops: [{ op: 'find', name: 'x' }] });
  const job = { base: 'job:ws:inbox/base-job', ops: [{ op: 'html', parent: '$s', file: 'ws:inbox/frag.html' }, { op: 'html', parent: '$s', file: 'local.html' },
    { op: 'rest', data: { openapi: { path: 'ws:inbox/api.json', external: { 'types.json': { path: 'agent:inbox/types.json' } } } } },
    { op: 'prototype', data: { source: 'ws:inbox/proto', capture: 'ws:inbox/proto/capture.json', captureSha256: SHA } }] };
  const expected = { base: 'job:' + h.ws('inbox', 'base-job'), ops: [{ op: 'html', parent: '$s', file: h.ws('inbox', 'frag.html') }, { op: 'html', parent: '$s', file: h.ws('o11', 'local.html') },
    { op: 'rest', data: { openapi: { path: h.ws('inbox', 'api.json'), external: { 'types.json': { path: h.ws('inbox', 'types.json') } } } } },
    { op: 'prototype', data: { source: h.ws('inbox', 'proto'), capture: h.ws('inbox', 'proto', 'capture.json'), captureSha256: SHA } }] };
  for (const sent of [job, JSON.stringify(job)]) {
    const result = await h.gate('ssam_job', { prototypeOp: 'allow' })({ lane: 'o11', job: sent });
    assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 400));
    assert.deepEqual(h.calls.at(-1).args.job, expected, 'the handler runs the absolute workspace paths');
  }
  assert.ok(h.pulls.includes('agent:inbox/types.json'), 'agent:inbox/<file> is brought through the executor, as a tool argument is');
  // a composite job inline: its parts rewritten too, and read where they are
  const composite = await h.gate('o11_job')({ job: JSON.stringify({ jobs: ['ws:inbox/part.json', 'job:ws:inbox/part'] }) });
  assert.notEqual(composite.isError, true, JSON.stringify(composite).slice(0, 400));
  assert.deepEqual(h.calls.at(-1).args.job, { jobs: [h.ws('inbox', 'part.json'), 'job:' + h.ws('inbox', 'part')] });
  // a job file of the workspace whose paths are inside: it passes as the file (never rewritten)
  write(h.ws('inbox', 'job.json'), { jobs: ['part.json', 'job:part'] });
  assert.notEqual((await h.gate('o11_job')({ job: 'ws:inbox/job.json' })).isError, true);
  assert.equal(h.calls.at(-1).args.job, h.ws('inbox', 'job.json'));
  // ssam_reference check-job: an inline query is the job, rewritten the same way
  assert.notEqual((await h.gate('ssam_reference')({ lane: 'o11', kind: 'check-job', query: { ops: [{ op: 'html', parent: '$s', file: 'ws:inbox/frag.html' }] } })).isError, true);
  assert.equal(h.calls.at(-1).args.query.ops[0].file, h.ws('inbox', 'frag.html'));
});

test('a file job names a file relative to its own folder only where the kernel looks there first; anything the kernel would resolve on the server is refused', async () => {
  const h = harness();
  write(h.ws('inbox', 'sub.json'), { ops: [{ op: 'find', name: 'x' }] });
  write(h.ws('inbox', 'service.wsdl'), '<definitions/>');
  write(h.ws('inbox', 'ok.json'), { jobs: ['sub.json', 'job:sub'], ops: [] });
  write(h.ws('inbox', 'soap.json'), { ops: [{ op: 'soap', data: { wsdl: 'service.wsdl' } }] });
  assert.notEqual((await h.gate('o11_job')({ job: 'ws:inbox/ok.json' })).isError, true, 'a part next to the job');
  assert.notEqual((await h.gate('o11_job')({ job: 'ws:inbox/soap.json' })).isError, true, 'a WSDL next to the job');
  // a part that is not next to the job: the kernel would go on to the repository (its tests/jobs): refused
  write(h.ws('inbox', 'missing.json'), { jobs: ['job:ex-base'] });
  assert.equal(refusal(await h.gate('o11_job', { prototypeOp: 'allow' })({ job: 'ws:inbox/missing.json' })).pointer, '/job > /jobs/0');
  // an html file relative in a file: the kernel reads it from its working directory and the repository, never the job's
  write(h.ws('inbox', 'html.json'), { ops: [{ op: 'html', parent: '$s', file: 'frag.html' }] });
  write(h.ws('inbox', 'frag.html'), '<div/>');
  assert.equal(refusal(await h.gate('o11_job')({ job: 'ws:inbox/html.json' })).pointer, '/job > /ops/0/file');
  // a relative fixture name that is not a product fixture: the kernel would take it from its own tests/fixtures
  write(h.ws('inbox', 'base.json'), { base: 'tests/fixtures/hmisjha/HMISJHA_CS-v5578.oml', ops: [] });
  assert.equal(refusal(await h.gate('o11_job')({ job: 'ws:inbox/base.json' })).pointer, '/job > /base');
  assert.equal(h.calls.length, 2);
});

test('basedOn: the base file, a partial job and a patch are confined; the job the patch makes is checked before it is written', async () => {
  const h = harness();
  const server = path.join(anvilRoot, 'MANIFESTO.md');
  write(h.ws('o11', 'jobs', 'base.json'), { base: 'Base', ops: [{ op: 'find', name: 'x' }, { op: 'reference', producer: 'Producer', elements: ['IServerAction:A'] }] });
  write(h.ws('o11', 'jobs', 'frag.html'), '<div/>');
  write(h.ws('o11', 'jobs', 'bad-base.json'), { ops: [{ op: 'html', parent: '$s', file: server }] });
  const basedOn = { job: 'ws:o11/jobs/base.json', sha256: SHA };
  for (const name of TOOLS) {
    // a patch that adds an op naming a server file, or that turns a producer into one (base itself is never patched)
    let value = refusal(await h.gate(name)({ ...laneArgs(name), basedOn, patch: [{ op: 'add', path: '/ops/-', value: { op: 'html', parent: '$s', file: server } }] }));
    assert.deepEqual([value.code, value.pointer], ['PATH_OUTSIDE_WORKSPACE', '/basedOn/job (patched) > /ops/2/file'], name);
    value = refusal(await h.gate(name)({ ...laneArgs(name), basedOn, patch: [{ op: 'replace', path: '/ops/1/producer', value: path.join(anvilRoot, 'tests', 'fixtures', 'hmisjha', 'x.oml') }] }));
    assert.deepEqual([value.code, value.pointer], ['PATH_OUTSIDE_WORKSPACE', '/basedOn/job (patched) > /ops/1/producer'], name);
    // a relative name in the job a patch makes: written elsewhere by the handler, so nothing pins it
    value = refusal(await h.gate(name)({ ...laneArgs(name), basedOn, patch: [{ op: 'add', path: '/ops/-', value: { op: 'html', parent: '$s', file: 'frag.html' } }] }));
    assert.equal(value.pointer, '/basedOn/job (patched) > /ops/2/file', name);
    // a partial job inline with a server path, and as its JSON text
    for (const job of [{ ops: [{ op: 'html', parent: '$s', file: server }] }, JSON.stringify({ ops: [{ op: 'html', parent: '$s', file: server }] })])
      assert.equal(refusal(await h.gate(name)({ ...laneArgs(name), basedOn, job })).pointer, '/job/ops/0/file', name);
    // the base file itself names a server file
    assert.equal(refusal(await h.gate(name)({ ...laneArgs(name), basedOn: { job: 'ws:o11/jobs/bad-base.json', sha256: SHA }, patch: [{ op: 'replace', path: '/ops/0/parent', value: '$t' }] })).pointer,
      '/basedOn/job > /ops/0/file', name);
  }
  // check-job {basedOn, patch, job} of ssam_reference: the same
  assert.equal(refusal(await h.gate('ssam_reference')({ lane: 'o11', kind: 'check-job', query: { basedOn, patch: [{ op: 'add', path: '/ops/-', value: { op: 'html', parent: '$s', file: server } }] } })).pointer,
    '/query/basedOn/job (patched) > /ops/2/file');
  // basedOn {taskId}: the job an O11 delivery recorded, outside the workspace
  const taskId = 'b'.repeat(32);
  write(h.ws('o11', 'work', 'deliver', taskId, 'task.json'), { request: { JobPath: h.other } });
  assert.equal(refusal(await h.gate('o11_deliver')({ module: 'M', basedOn: { taskId }, patch: [{ op: 'replace', path: '/ops/0/name', value: 'y' }] })).pointer, '/basedOn/taskId');
  assert.deepEqual(h.calls, []);
  // a correct patch over the same base passes
  assert.notEqual((await h.gate('o11_job')({ basedOn, patch: [{ op: 'add', path: '/ops/-', value: { op: 'html', parent: '$s', file: h.ws('o11', 'jobs', 'frag.html') } }] })).isError, true);
});

test('the JSON text of a job is the job only on a job pointer: anywhere else it is a path; on a job pointer a text that does not parse is refused', async () => {
  const h = harness();
  // ssam_evidence {file}: "[x]/../../.." used to pass unresolved (the text exemption held for every pointer)
  for (const file of ['[x]/../../../../../MANIFESTO.md', '{x}/../../../../../.local/server/tokens.json'])
    assert.equal(refusal(await h.gate('ssam_evidence')({ file })).code, 'PATH_OUTSIDE_WORKSPACE', file);
  // a JSON-looking text on a job pointer that is not JSON is neither a job nor a path
  for (const name of TOOLS) {
    const value = refusal(await h.gate(name)({ ...laneArgs(name), job: '[x]/../../../../MANIFESTO.md' }));
    assert.deepEqual([value.code, value.pointer], ['JOB_INVALID', '/job'], name);
  }
  // basedOn.job is always a file: its text form is resolved as a path (and refused when it leaves)
  assert.equal(refusal(await h.gate('o11_job')({ basedOn: { job: '[x]/../../../../MANIFESTO.md', sha256: SHA }, patch: [{ op: 'replace', path: '/ops/0/name', value: 'y' }] })).code, 'PATH_OUTSIDE_WORKSPACE');
  assert.deepEqual(h.calls, []);
});

test('the prototype op and the composite rule still hold for inline text (D2 first, before the paths)', async () => {
  const h = harness();
  const PROTOTYPE = { op: 'prototype', data: { source: 'C:\\Users\\someone\\prototype' } };
  write(h.ws('inbox', 'sub.json'), { ops: [PROTOTYPE] });
  write(h.ws('inbox', 'clean.json'), { ops: [{ op: 'find', name: 'x' }] });
  for (const name of TOOLS) {
    for (const job of [JSON.stringify({ jobs: ['ws:inbox/sub.json'] }), JSON.stringify({ jobs: ['job:ws:inbox/sub'] }), JSON.stringify({ jobs: [h.other] }), JSON.stringify({ ops: [PROTOTYPE] })]) {
      const value = refusal(await h.gate(name)({ ...laneArgs(name), job }));
      assert.deepEqual([value.code, value.cause], ['HOSTED_UNAVAILABLE', 'PROTOTYPE_IMPORT_DISABLED'], name + ' ' + job);
    }
    // a prototype-free composite as text passes, its part rewritten
    assert.notEqual((await h.gate(name)({ ...laneArgs(name), job: JSON.stringify({ jobs: ['ws:inbox/clean.json'] }) })).isError, true, name);
    assert.deepEqual(h.calls.at(-1).args.job, { jobs: [h.ws('inbox', 'clean.json')] }, name);
  }
  assert.equal(h.calls.length, TOOLS.length);
});

test('createSsamServer({hosted}): o11_job with a job naming a server file never reaches the job tool', async t => {
  const h = harness();
  let ran = 0;
  const session = { tokenId: 'tok_test', lanes: ['odc', 'o11'], workspace: h.workspace, agent: h.link };
  const server = await createSsamServer({ o11: false, odc: false, deps: { jobTool: async () => { ran++; return { ok: true }; } },
    hosted: { context: h.context, session, run: (ctx, fn) => fn() } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-job-paths-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const job = { ops: [{ op: 'html', parent: '$s', file: path.join(anvilRoot, 'MANIFESTO.md') }] };
  for (const sent of [job, JSON.stringify(job)]) {
    const value = refusal(await client.callTool({ name: 'o11_job', arguments: { job: sent } }));
    assert.deepEqual([value.code, value.pointer], ['PATH_OUTSIDE_WORKSPACE', '/job/ops/0/file']);
  }
  assert.equal(ran, 0, 'the job tool never ran');
});

// Finding 2 of the confinement review: a job file the gate could not parse (UTF-16 with its byte-order mark, which the
// kernel's File.ReadAllText reads; a key written twice; not JSON) passed to the kernel with none of its paths checked.
const utf16le = text => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const utf16be = text => { const le = Buffer.from(text, 'utf16le'); for (let i = 0; i < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]]; return Buffer.concat([Buffer.from([0xfe, 0xff]), le]); };
const utf32le = text => { const points = [...text].map(c => c.codePointAt(0)); const out = Buffer.alloc(4 + points.length * 4); out.set([0xff, 0xfe, 0, 0]); points.forEach((p, i) => out.writeUInt32LE(p, 4 + i * 4)); return out; };

test('a job file the gate cannot read whole as the kernel reads it is JOB_PATHS_UNCHECKED, whatever its field; UTF-16 is read as the kernel reads it', async () => {
  const h = harness();
  const server = path.join(anvilRoot, 'MANIFESTO.md');
  const bad = JSON.stringify({ ops: [{ op: 'html', parent: '$s', file: server }] });
  // UTF-16 with its byte-order mark (Windows PowerShell 5.1 writes it so): the kernel reads it, so the gate reads it too and
  // checks its paths (it used to pass unread)
  for (const [label, bytes] of [['UTF-16 LE', utf16le(bad)], ['UTF-16 BE', utf16be(bad)]]) {
    fs.writeFileSync(h.ws('inbox', 'job16.json'), bytes);
    const value = refusal(await h.gate('o11_job')({ job: 'ws:inbox/job16.json' }));
    assert.deepEqual([value.code, value.pointer], ['PATH_OUTSIDE_WORKSPACE', '/job > /ops/0/file'], label);
  }
  fs.writeFileSync(h.ws('inbox', 'clean16.json'), utf16le(JSON.stringify({ ops: [{ op: 'find', name: 'x' }] })));
  assert.notEqual((await h.gate('o11_job')({ job: 'ws:inbox/clean16.json' })).isError, true, 'a clean UTF-16 job passes');
  assert.equal(h.calls.length, 1);
  // what the gate cannot read whole, the kernel might: UTF-32, an invalid UTF-8 sequence, a text that is not JSON, a key
  // twice in one object (JSON.parse keeps the last value, here a workspace file; another reader may keep the first)
  const unreadable = {
    'UTF-32': utf32le(bad),
    'an invalid UTF-8 sequence': Buffer.concat([Buffer.from('{"ops":[{"op":"html","parent":"$s","file":"ws:inbox/frag'), Buffer.from([0xc3, 0x28]), Buffer.from('.html"}]}')]),
    'not JSON': Buffer.from('{"ops":[{"op":"html","parent":"$s","file":' + JSON.stringify(server) + ',}]}'),
    'a key twice': Buffer.from('{"ops":[{"op":"html","parent":"$s","file":' + JSON.stringify(server) + ',"file":"ws:inbox/frag.html"}]}'),
  };
  const SHA = 'c'.repeat(64);
  // every place a job file is reached: the job, a composite part (file and job:<name>), a job:<name> base or producer
  // (from a file and inline), the job of basedOn
  const places = {
    'the job': () => ({ name: 'o11_job', args: { job: 'ws:inbox/u.json' }, pointer: '/job' }),
    'a composite part': () => { write(h.ws('inbox', 'main.json'), { jobs: ['u.json'] }); return { name: 'o11_job', args: { job: 'ws:inbox/main.json' }, pointer: '/job > /jobs/0' }; },
    'a composite part job:<name>': () => ({ name: 'o11_job', args: { job: { jobs: ['job:ws:inbox/u'] } }, pointer: '/job/jobs/0' }),
    'a job:<name> base in a file': () => { write(h.ws('inbox', 'based.json'), { base: 'job:u', ops: [] }); return { name: 'ssam_job', args: { lane: 'o11', job: 'ws:inbox/based.json' }, pointer: '/job > /base' }; },
    'a job:<name> base inline': () => ({ name: 'studio_deliver', args: { feature: 'F', module: 'M', job: { base: 'job:ws:inbox/u', ops: [] } }, pointer: '/job/base' }),
    'a job:<name> producer': () => ({ name: 'o11_deliver', args: { module: 'M', job: { ops: [{ op: 'reference', producer: 'job:ws:inbox/u', elements: ['IServerAction:A'] }] } }, pointer: '/job/ops/0/producer' }),
    'the job of basedOn': () => ({ name: 'o11_job', args: { basedOn: { job: 'ws:inbox/u.json', sha256: SHA }, patch: [{ op: 'replace', path: '/ops/0/parent', value: '$t' }] }, pointer: '/basedOn/job' }),
  };
  for (const [label, bytes] of Object.entries(unreadable)) {
    for (const [place, make] of Object.entries(places)) {
      fs.writeFileSync(h.ws('inbox', 'u.json'), bytes);
      const { name, args, pointer } = make();
      // allow: the prototype switch apart (an unread part also answers D2 first), so the gate's own refusal is what answers
      const value = refusal(await h.gate(name, { prototypeOp: 'allow' })(args));
      assert.deepEqual([value.code, value.pointer], ['JOB_PATHS_UNCHECKED', pointer], `${label} / ${place}: ${JSON.stringify(value).slice(0, 300)}`);
      assert.match(value.fix, /UTF-8/, label);
    }
  }
  assert.equal(h.calls.length, 1, 'no handler ran for a job file the gate could not read');
  // a missing job file is still the tool's own answer (the kernel reads nothing either)
  assert.notEqual((await h.gate('o11_job')({ job: 'ws:inbox/missing.json' })).isError, true);
});
