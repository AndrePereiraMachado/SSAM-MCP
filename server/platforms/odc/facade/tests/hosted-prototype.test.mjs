// D2 of PLANO-24-PRODUCAO (G4, risk R2): in hosted mode the prototype op (the importer) is refused at the gate, before any
// capture, in the four tools that take a job (o11_deliver, studio_deliver, ssam_job, o11_job): its capture runs the
// prototype's JavaScript on the server machine. One switch, HOSTED_PROTOTYPE_OP in hosted/policy.mjs ('refuse' in 24.0),
// lets it through when set to 'allow' (its data.source then confined like every path of a job, item 1). A fake link,
// context and executor; no hub, agent or Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { wrapHostedTool, namesPrototype, HOSTED_PROTOTYPE_OP, PROTOTYPE_TOOLS } from '../hosted/policy.mjs';
import { createSsamServer } from '../ssam.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';
import { portuguese } from './fixtures/portuguese.mjs';

test.after(cleanupHostedDirs);
const TOOLS = ['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job'];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const PROTOTYPE = { op: 'prototype', data: { source: 'C:\\Users\\someone\\prototype' } };

function harness({ connected = true } = {}) {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected });
  const pulls = [];
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }),
    async call(kind) { throw Object.assign(new Error('no machine call: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); },
    async pullFile(value) { pulls.push(value); const file = path.join(dirs.workspace, ...value.slice(6).split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(link.agentFile(value), file); return file; } };
  const context = { id: 'ctx-proto', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const gate = (name, options = {}) => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, async args => { calls.push({ name, args }); return reply({ ok: true }); },
      { context, link, lanes: context.lanes, run: (ctx, fn) => fn(), waitMs: 10, ...options });
    return args => wrapped(args, { requestId: 1 });
  };
  const lane = name => (name === 'studio_deliver' ? { feature: 'F', module: 'M' } : name === 'ssam_job' ? { lane: 'o11' } : { module: 'M' });
  return { ...dirs, link, executor, context, calls, pulls, gate, lane };
}
const refusedAsPrototype = (result, name) => {
  const value = result.structuredContent;
  assert.equal(result.isError, true, name);
  assert.equal(value.code, 'HOSTED_UNAVAILABLE', name + ': ' + JSON.stringify(value).slice(0, 300));
  assert.equal(value.cause, 'PROTOTYPE_IMPORT_DISABLED', name);
  assert.equal(value.policy, 'HOSTED_PROTOTYPE_OP', name + ': the answer names the switch');
  assert.equal(value.outcome, 'not-sent');
  assert.match(value.error, /The prototype import is turned off/, name + ': English');
  assert.deepEqual(portuguese(value.error), [], name + ': English only, no pt-BR half (owner rule of 2026-10-15)');
  assert.deepEqual([value.continuation.tool, value.continuation.arguments.action, value.continuation.arguments.part], ['ssam_code', 'grammar', 'html'], name + ': the next call is the html grammar');
  assert.ok(!JSON.stringify(value.continuation).includes('"prototype"'), 'the continuation never leads back to the prototype op');
};

test('the switch: one constant, refuse in 24.0, for the four job tools', () => {
  assert.equal(HOSTED_PROTOTYPE_OP, 'refuse');
  assert.deepEqual([...PROTOTYPE_TOOLS].sort(), [...TOOLS].sort());
});

test('an inline job with the prototype op is refused in the four tools before the agent, the lane and any capture', async () => {
  for (const connected of [true, false]) {
    const h = harness({ connected });
    for (const name of TOOLS) {
      for (const job of [{ ops: [PROTOTYPE] }, [PROTOTYPE], { ops: [{ op: 'html', data: {} }, { ...PROTOTYPE, op: 'Prototype' }] }, JSON.stringify({ ops: [PROTOTYPE] })])
        refusedAsPrototype(await h.gate(name)({ ...h.lane(name), job }), name);
      // a partial job, a patch that adds the op, a patch that turns an op into it
      refusedAsPrototype(await h.gate(name)({ ...h.lane(name), job: { ops: [PROTOTYPE] }, basedOn: { job: 'ws:o11/jobs/base.json', sha256: 'a'.repeat(64) } }), name);
      refusedAsPrototype(await h.gate(name)({ ...h.lane(name), patch: [{ op: 'add', path: '/ops/-', value: PROTOTYPE }], basedOn: { job: 'ws:o11/jobs/base.json', sha256: 'a'.repeat(64) } }), name);
      refusedAsPrototype(await h.gate(name)({ ...h.lane(name), patch: [{ op: 'replace', path: '/ops/0/op', value: 'prototype' }], basedOn: { job: 'ws:o11/jobs/base.json', sha256: 'a'.repeat(64) } }), name);
    }
    assert.deepEqual(h.calls, [], 'no handler ran');
    assert.deepEqual(h.pulls, [], 'nothing was brought from the agent');
    assert.deepEqual(h.link.calls, [], 'nothing reached the agent');
  }
});

test('a job file of the workspace (ws:, agent:inbox, the job of basedOn) with the prototype op is refused before the handler', async () => {
  const h = harness();
  write(path.join(h.workspace, 'inbox', 'proto.json'), { ops: [PROTOTYPE] });
  write(path.join(h.workspace, 'o11', 'jobs', 'base.json'), { ops: [{ op: 'entity', data: {} }, PROTOTYPE] });
  write(path.join(h.workspace, 'odc', 'lab', 'plain.json'), { ops: [{ op: 'entity', data: { name: 'Order' } }] });
  h.link.writeAgent('agent:inbox/from-agent.json', JSON.stringify([PROTOTYPE]));
  for (const name of TOOLS) {
    refusedAsPrototype(await h.gate(name)({ ...h.lane(name), job: 'ws:inbox/proto.json' }), name);
    refusedAsPrototype(await h.gate(name)({ ...h.lane(name), job: 'agent:inbox/from-agent.json' }), name);
    refusedAsPrototype(await h.gate(name)({ ...h.lane(name), patch: [{ op: 'replace', path: '/ops/0/data/name', value: 'X' }], basedOn: { job: 'ws:o11/jobs/base.json', sha256: 'b'.repeat(64) } }), name);
  }
  assert.deepEqual(h.calls, []);
  // A job without the op passes, inline or as a file.
  for (const name of TOOLS) {
    assert.notEqual((await h.gate(name)({ ...h.lane(name), job: { ops: [{ op: 'entity', data: { name: 'Prototype' } }] } })).isError, true, name + ': a name is no op');
    assert.notEqual((await h.gate(name)({ ...h.lane(name), job: 'ws:odc/lab/plain.json' })).isError, true, name);
  }
  assert.equal(h.calls.length, 2 * TOOLS.length);
});

test('a COMPOSITE job whose part carries the prototype op is refused; the part is read strictly inside the workspace', async () => {
  const h = harness();
  const outside = path.join(h.root, 'server', 'customers', 'tok_other', 'odc', 'capture.json'); // another customer's file
  // main -> sub (a prototype op whose data.capture points outside this workspace): the kernel's CollectOps would
  // concatenate the sub's op and PrototypeCapture.Load would read data.capture on the server. The gate follows the part.
  write(path.join(h.workspace, 'inbox', 'sub.json'), { ops: [{ op: 'prototype', data: { source: 'x', capture: outside, captureSha256: 'a'.repeat(64) } }] });
  write(path.join(h.workspace, 'inbox', 'main.json'), { jobs: ['sub.json'] });
  // a two-level composite (main2 -> mid -> sub) proves the recursion, and a job: spec of a part in the same folder
  write(path.join(h.workspace, 'inbox', 'mid.json'), { jobs: ['job:sub'] });
  write(path.join(h.workspace, 'inbox', 'main2.json'), { jobs: ['mid.json'] });
  // a composite whose part sits OUTSIDE the workspace: the gate cannot read it there, so it fails closed
  write(path.join(h.workspace, 'inbox', 'escape.json'), { jobs: ['C:\\Windows\\win.ini'] });
  // a plain composite whose parts are all prototype-free passes
  write(path.join(h.workspace, 'inbox', 'clean-a.json'), { ops: [{ op: 'entity', data: { name: 'Order' } }] });
  write(path.join(h.workspace, 'inbox', 'clean.json'), { jobs: ['clean-a.json'] });
  for (const name of TOOLS) {
    refusedAsPrototype(await h.gate(name)({ ...h.lane(name), job: 'ws:inbox/main.json' }), name + ': composite file part');
    refusedAsPrototype(await h.gate(name)({ ...h.lane(name), job: 'ws:inbox/main2.json' }), name + ': nested composite, job: spec');
    refusedAsPrototype(await h.gate(name)({ ...h.lane(name), job: 'ws:inbox/escape.json' }), name + ': part outside the workspace fails closed');
    // the composite as the job of basedOn is followed too
    refusedAsPrototype(await h.gate(name)({ ...h.lane(name), patch: [{ op: 'replace', path: '/ops/0/data/name', value: 'X' }], basedOn: { job: 'ws:inbox/main.json', sha256: 'c'.repeat(64) } }), name + ': composite basedOn');
    // an inline composite object with an absolute part outside the workspace fails closed too
    refusedAsPrototype(await h.gate(name)({ ...h.lane(name), job: { jobs: [outside] } }), name + ': inline composite, absolute part outside');
  }
  assert.deepEqual(h.calls, [], 'no handler ran for a composite that names (or cannot rule out) the prototype op');
  assert.equal(h.pulls.length, 0, 'the gate reads the workspace, never the server file the part named');
  // a prototype-free composite is not refused for the prototype op
  for (const name of TOOLS) assert.notEqual((await h.gate(name)({ ...h.lane(name), job: 'ws:inbox/clean.json' })).isError, true, name + ': a clean composite passes');
  assert.equal(h.calls.length, TOOLS.length);
});

test('the switch set to allow lets the same calls through (the 24.x road: the folder by agent:inbox, a capture pool per customer)', async () => {
  const h = harness();
  // fase4-24 item 1: even allowed, data.source is a path of the job, confined like every other one: a folder of the
  // customer's workspace passes (inline, rewritten to its absolute path), the user's own C:\... folder does not.
  const source = path.join(h.workspace, 'inbox', 'prototype');
  fs.mkdirSync(source, { recursive: true });
  const inside = { op: 'prototype', data: { source: 'ws:inbox/prototype' } };
  write(path.join(h.workspace, 'inbox', 'proto.json'), { ops: [{ op: 'prototype', data: { source } }] });
  for (const name of TOOLS) {
    assert.notEqual((await h.gate(name, { prototypeOp: 'allow' })({ ...h.lane(name), job: { ops: [inside] } })).isError, true, name);
    assert.equal(h.calls.at(-1).args.job.ops[0].data.source, source, name + ': the handler gets the absolute workspace folder');
    assert.notEqual((await h.gate(name, { prototypeOp: 'allow' })({ ...h.lane(name), job: 'ws:inbox/proto.json' })).isError, true, name);
    const outside = await h.gate(name, { prototypeOp: 'allow' })({ ...h.lane(name), job: { ops: [PROTOTYPE] } });
    assert.equal(outside.structuredContent.code, 'PATH_OUTSIDE_WORKSPACE', name);
    assert.equal(outside.structuredContent.pointer, '/job/ops/0/data/source', name);
  }
  assert.equal(h.calls.length, 2 * TOOLS.length);
  // Only the four job tools are concerned: a read tool with a "prototype" text is never refused for it.
  assert.notEqual((await h.gate('ssam_discover')({ intent: 'import the prototype', lane: 'odc' })).isError, true);
});

test('namesPrototype: ops anywhere in a job, a patch that turns an op into it, JSON text; never a mere name or text', () => {
  assert.equal(namesPrototype({ jobs: [{ ops: [PROTOTYPE] }] }), true, 'a part of a composite job');
  assert.equal(namesPrototype([{ op: 'replace', path: 'ops.2.op', value: ' PROTOTYPE ' }]), true);
  assert.equal(namesPrototype('[{"op":"prototype"}]'), true);
  assert.equal(namesPrototype({ ops: [{ op: 'html', data: { html: '<div>{"op":"prototype"}</div>' } }] }), false, 'a text inside an op is data');
  assert.equal(namesPrototype({ ops: [{ op: 'entity', data: { name: 'prototype' } }] }), false);
  assert.equal(namesPrototype(null), false); assert.equal(namesPrototype('C:\\jobs\\prototype.json'), false);
});

test('createSsamServer({hosted}): o11_job and ssam_job with the prototype op never reach the job tool', async t => {
  const h = harness();
  let ran = 0;
  const session = { tokenId: 'tok_test', lanes: ['odc', 'o11'], workspace: h.workspace, agent: h.link };
  const server = await createSsamServer({ o11: false, odc: false, deps: { jobTool: async () => { ran++; return { ok: true }; } },
    hosted: { context: h.context, session, run: (ctx, fn) => fn() } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-prototype-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  for (const name of ['o11_job', 'ssam_job']) {
    const result = await client.callTool({ name, arguments: { job: { ops: [PROTOTYPE] } } });
    refusedAsPrototype(result, name);
  }
  assert.equal(ran, 0, 'the job tool never ran');
  const plain = await client.callTool({ name: 'o11_job', arguments: { job: { ops: [{ op: 'find', kind: 'Entity' }] } } });
  assert.notEqual(plain.isError, true, JSON.stringify(plain).slice(0, 300));
  assert.equal(ran, 1);
});
