// servidor/fase4-25 (D2 of C:\t\vps-a5\PLANO.md, section 3.2-E): the generator ops of marco-a5 that are still pending their
// blind test (generators.mjs GENERATOR_APPROVAL: entity-actions, rest-consume, the op screen with data.generate) are never
// offered by ssam_discover, but locally an op called by name still runs. In hosted mode the gate refuses them in the four
// tools that take a job (o11_deliver, studio_deliver, ssam_job, o11_job), before the agent, the lane checks and any
// capture: HOSTED_UNAVAILABLE, cause GENERATOR_PENDING, policy HOSTED_GENERATOR_OPS. One switch ('refuse'); a generator the
// owner approves is let through like any op. A fake link, context and executor; no hub, agent or Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrapHostedTool, namesGenerator, HOSTED_GENERATOR_OPS, GENERATOR_TOOLS } from '../hosted/policy.mjs';
import { withGeneratorStates } from '../generators.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';
import { portuguese } from './fixtures/portuguese.mjs';

test.after(cleanupHostedDirs);
const TOOLS = ['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job'];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const ENTITY_ACTIONS = { op: 'entity-actions', data: { entities: 'all' } };
const REST_CONSUME = { op: 'rest-consume', data: { name: 'Api', methods: [{ name: 'Get', url: 'https://api.example.test/items' }] } };
const GEN_SCREEN = { op: 'screen', data: { generate: { entities: ['Customer'] } } };
const BASED_ON = { job: 'ws:o11/jobs/base.json', sha256: 'a'.repeat(64) };

function harness({ connected = true } = {}) {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected });
  const pulls = [];
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }),
    async call(kind) { throw Object.assign(new Error('no machine call: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); },
    async pullFile(value) { pulls.push(value); const file = path.join(dirs.workspace, ...value.slice(6).split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(link.agentFile(value), file); return file; } };
  const context = { id: 'ctx-gen', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const gate = (name, options = {}) => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, async args => { calls.push({ name, args }); return reply({ ok: true }); },
      { context, link, lanes: context.lanes, run: (ctx, fn) => fn(), waitMs: 10, ...options });
    return args => wrapped(args, { requestId: 1 });
  };
  const lane = name => (name === 'studio_deliver' ? { feature: 'F', module: 'M' } : name === 'ssam_job' ? { lane: 'o11' } : { module: 'M' });
  return { ...dirs, link, executor, context, calls, pulls, gate, lane };
}
const refusedAsGenerator = (result, name, generator) => {
  const value = result.structuredContent;
  assert.equal(result.isError, true, name);
  assert.equal(value.code, 'HOSTED_UNAVAILABLE', name + ': ' + JSON.stringify(value).slice(0, 300));
  assert.equal(value.cause, 'GENERATOR_PENDING', name);
  assert.equal(value.policy, 'HOSTED_GENERATOR_OPS', name + ': the answer names the switch');
  if (generator) assert.equal(value.generator, generator, name);
  assert.equal(value.outcome, 'not-sent');
  assert.match(value.error, /blind test/, name + ': English');
  assert.deepEqual(portuguese(value.error), [], name + ': English only, no pt-BR half (owner rule of 2026-10-15)');
  assert.equal(value.continuation.tool, 'ssam_discover');
};

test('the switch: one constant, refuse, for the four job tools', () => {
  assert.equal(HOSTED_GENERATOR_OPS, 'refuse');
  assert.deepEqual([...GENERATOR_TOOLS].sort(), [...TOOLS].sort());
});

test('namesGenerator finds each pending generator op, its patch forms and JSON text; other ops are not generators', () => {
  assert.equal(namesGenerator({ ops: [ENTITY_ACTIONS] }), 'entity-actions');
  assert.equal(namesGenerator([{ op: 'html', data: {} }, { ...REST_CONSUME, op: 'Rest-Consume' }]), 'rest-consume');
  assert.equal(namesGenerator({ ops: [GEN_SCREEN] }), 'gen-screen');
  assert.equal(namesGenerator(JSON.stringify({ ops: [ENTITY_ACTIONS] })), 'entity-actions');
  assert.equal(namesGenerator([{ op: 'replace', path: '/ops/0/op', value: 'rest-consume' }]), 'rest-consume');
  assert.equal(namesGenerator([{ op: 'add', path: '/ops/2/data/generate', value: { entities: ['Order'] } }]), 'gen-screen');
  assert.equal(namesGenerator({ ops: [{ op: 'screen', data: { name: 'Home', html: '<div/>' } }, { op: 'entity', data: { name: 'Order' } }] }), null);
  assert.equal(namesGenerator({ ops: [{ op: 'rest', data: { openapi: { path: 'ws:inbox/a.json' } } }] }), null);
});

test('an inline job, a partial job or a patch with a pending generator is refused in the four tools before the agent and any capture', async () => {
  for (const connected of [true, false]) {
    const h = harness({ connected });
    for (const name of TOOLS) {
      for (const [op, id] of [[ENTITY_ACTIONS, 'entity-actions'], [REST_CONSUME, 'rest-consume'], [GEN_SCREEN, 'gen-screen']]) {
        refusedAsGenerator(await h.gate(name)({ ...h.lane(name), job: { ops: [{ op: 'entity', data: { name: 'Order' } }, op] } }), name, id);
        refusedAsGenerator(await h.gate(name)({ ...h.lane(name), job: JSON.stringify({ ops: [op] }) }), name, id);
        refusedAsGenerator(await h.gate(name)({ ...h.lane(name), job: { ops: [op] }, basedOn: BASED_ON }), name, id);
        refusedAsGenerator(await h.gate(name)({ ...h.lane(name), patch: [{ op: 'add', path: '/ops/-', value: op }], basedOn: BASED_ON }), name, id);
      }
    }
    assert.deepEqual(h.calls, [], 'no handler ran');
    assert.deepEqual(h.pulls, [], 'nothing was brought from the agent');
    assert.deepEqual(h.link.calls, [], 'nothing reached the agent');
  }
});

test('a job FILE of the workspace (ws:, the job of basedOn, a composite part) with a pending generator is refused before the handler', async () => {
  const h = harness();
  write(path.join(h.workspace, 'inbox', 'gen.json'), { ops: [REST_CONSUME] });
  write(path.join(h.workspace, 'o11', 'jobs', 'base.json'), { ops: [{ op: 'entity', data: {} }, ENTITY_ACTIONS] });
  write(path.join(h.workspace, 'odc', 'lab', 'part.json'), { ops: [GEN_SCREEN] });
  write(path.join(h.workspace, 'odc', 'lab', 'composite.json'), { jobs: ['part.json'] });
  for (const name of TOOLS) {
    refusedAsGenerator(await h.gate(name)({ ...h.lane(name), job: 'ws:inbox/gen.json' }), name, 'rest-consume');
    refusedAsGenerator(await h.gate(name)({ ...h.lane(name), job: { ops: [{ op: 'entity', data: { name: 'X' } }] }, basedOn: BASED_ON }), name, 'entity-actions');
    refusedAsGenerator(await h.gate(name)({ ...h.lane(name), job: 'ws:odc/lab/composite.json' }), name, 'gen-screen');
  }
  assert.deepEqual(h.calls, []);
});

test('jobs without a generator op run; the switch at allow, or an approved generator, lets the op through', async () => {
  const h = harness();
  for (const name of TOOLS) {
    const plain = await h.gate(name)({ ...h.lane(name), job: { ops: [{ op: 'entity', data: { name: 'Order' } }, { op: 'screen', data: { name: 'Home' } }] } });
    assert.notEqual(plain.isError, true, name + ': ' + JSON.stringify(plain.structuredContent).slice(0, 300));
    const allowed = await h.gate(name, { generatorOps: 'allow' })({ ...h.lane(name), job: { ops: [ENTITY_ACTIONS] } });
    assert.notEqual(allowed.isError, true, name + ' with the switch at allow');
  }
  await withGeneratorStates({ 'entity-actions': { state: 'approved' } }, async () => {
    const approved = await h.gate('o11_deliver')({ module: 'M', job: { ops: [ENTITY_ACTIONS] } });
    assert.notEqual(approved.isError, true, 'an approved generator runs like any op');
    refusedAsGenerator(await h.gate('o11_deliver')({ module: 'M', job: { ops: [ENTITY_ACTIONS, REST_CONSUME] } }), 'o11_deliver', 'rest-consume');
  });
  assert.equal(h.calls.length, TOOLS.length * 2 + 1);
});

test('the other tools are not touched by the switch (a read that names an op is no job)', async () => {
  const h = harness();
  const result = await h.gate('ssam_discover')({ intent: 'entity-actions', lane: 'o11' });
  assert.notEqual(result.structuredContent?.cause, 'GENERATOR_PENDING');
});
