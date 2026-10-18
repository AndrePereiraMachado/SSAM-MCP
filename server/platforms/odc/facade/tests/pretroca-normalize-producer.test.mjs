// Pre-swap check (15/10, question 2): the handler's normalizeCodeOps (ssam-code.mjs normalizeOp, RAW_VERB_KEYS) lifts the
// keys of a raw verb out of data, so {op:"reference", data:{producer}} becomes {op:"reference", producer}. The gate
// (hosted/job-paths.mjs pathFields/opFields) reads op.producer only, never data.producer, so it lets the job through and the
// handler then runs a producer outside the customer's workspace. Inline job, job file of the workspace, and basedOn+patch.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { normalizeCodeOps } from '../ssam-code.mjs';
import { resolvePatchedJob } from '../job-patch.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });

function harness() {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected: true });
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }),
    async call(kind) { throw Object.assign(new Error('no machine call: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); },
    async pullFile() { throw new Error('no pull'); } };
  const context = { id: 'ctx-pretroca', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const gate = name => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, async args => { calls.push({ name, args }); return reply({ ok: true }); },
      { context, link, lanes: context.lanes, run: (ctx, fn) => fn(), waitMs: 10 });
    return args => wrapped(args, { requestId: 1 });
  };
  // Another customer's capture: what a hosted customer must never reach.
  const other = write(path.join(dirs.root, 'server', 'customers', 'tok_other', 'o11', 'Secret_CS.oml'), 'other customer');
  return { ...dirs, calls, gate, other };
}
const inside = (ws, file) => !path.relative(ws, file).startsWith('..') && !path.isAbsolute(path.relative(ws, file));

test('control: reference with producer at the op level, outside the workspace, is refused (PATH_OUTSIDE_WORKSPACE)', async () => {
  const h = harness();
  const result = await h.gate('ssam_job')({ lane: 'o11', job: { ops: [{ op: 'reference', producer: h.other, elements: ['GetSecret'] }] } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(h.calls.length, 0);
});

test('inline: reference with producer inside data (lifted by normalizeCodeOps) outside the workspace is refused', async () => {
  const h = harness();
  const result = await h.gate('ssam_job')({ lane: 'o11', job: { ops: [{ op: 'reference', data: { producer: h.other, elements: ['GetSecret'] } }] } });
  assert.equal(result.isError, true, 'the gate let it through; the handler would run ' + JSON.stringify(h.calls[0]?.args ?? null).slice(0, 300));
  assert.equal(result.structuredContent.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(h.calls.length, 0);
});

test('job file of the workspace: reference with producer inside data outside the workspace is refused', async () => {
  const h = harness();
  const file = write(path.join(h.workspace, 'o11', 'jobs', 'ref.json'), { ops: [{ op: 'reference', data: { producer: h.other, elements: ['GetSecret'] } }] });
  const result = await h.gate('o11_deliver')({ module: 'M', job: 'ws:o11/jobs/ref.json' });
  assert.equal(result.isError, true, 'the gate let it through; the handler would run ' + JSON.stringify(h.calls[0]?.args ?? null).slice(0, 300));
  assert.equal(result.structuredContent.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(h.calls.length, 0);
});

test('basedOn + explicit patch: an added reference with producer inside data outside the workspace is refused', async () => {
  const h = harness();
  const base = write(path.join(h.workspace, 'o11', 'jobs', 'base.json'), { ops: [{ op: 'find', name: 'x' }] });
  const sha = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(base)).digest('hex');
  const patch = [{ op: 'add', path: '/ops/-', value: { op: 'reference', data: { producer: h.other, elements: ['GetSecret'] } } }];
  const result = await h.gate('o11_job')({ module: 'M', basedOn: { job: 'ws:o11/jobs/base.json', sha256: sha }, patch });
  assert.equal(result.isError, true, 'the gate let it through; the handler would run ' + JSON.stringify(h.calls[0]?.args ?? null).slice(0, 300));
  assert.equal(result.structuredContent.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(h.calls.length, 0);
});

// servidor/fase4-25 (second HIGH finding before the VPS swap): the same hole in the other inline paths, and the form the
// handler receives.
test('inline in studio_deliver and o11_deliver, and a partial job over basedOn: producer inside data outside the workspace is refused', async () => {
  const h = harness();
  const op = { op: 'reference', data: { producer: h.other, elements: ['GetSecret'] } };
  for (const [name, args] of [['studio_deliver', { feature: 'F', module: 'M' }], ['o11_deliver', { module: 'M' }], ['o11_job', { module: 'M' }]]) {
    const result = await h.gate(name)({ ...args, job: { ops: [op] } });
    assert.equal(result.isError, true, name + ': the gate let it through; the handler would run ' + JSON.stringify(h.calls.at(-1)?.args ?? null).slice(0, 300));
    assert.equal(result.structuredContent.code, 'PATH_OUTSIDE_WORKSPACE', name);
  }
  const base = write(path.join(h.workspace, 'o11', 'jobs', 'base.json'), { ops: [{ op: 'find', name: 'x' }] });
  const sha = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(base)).digest('hex');
  const partial = await h.gate('ssam_job')({ lane: 'o11', basedOn: { job: 'ws:o11/jobs/base.json', sha256: sha }, job: { ops: [op] } });
  assert.equal(partial.isError, true, 'partial job: ' + JSON.stringify(h.calls.at(-1)?.args ?? null).slice(0, 300));
  assert.equal(partial.structuredContent.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(h.calls.length, 0);
});

test('inline: a producer inside data in the workspace runs, handed to the handler in the form it runs (op level, absolute ws path)', async () => {
  const h = harness();
  const own = write(path.join(h.workspace, 'o11', 'producers', 'Own_CS.oml'), 'own capture');
  for (const name of ['ssam_job', 'studio_deliver']) {
    const args = name === 'ssam_job' ? { lane: 'o11' } : { feature: 'F', module: 'M' };
    const result = await h.gate(name)({ ...args, job: { ops: [{ op: 'reference', data: { producer: 'ws:o11/producers/Own_CS.oml', elements: ['GetOwn'] } }] } });
    assert.notEqual(result.isError, true, name + ': ' + JSON.stringify(result.structuredContent).slice(0, 300));
    const ran = h.calls.at(-1).args.job.ops[0];
    assert.equal(ran.producer, own, name);
    assert.ok(inside(h.workspace, ran.producer), name);
    assert.equal(ran.data?.producer, undefined, name + ': the lifted form');
  }
});

test('evidence: what the handler runs (normalizeCodeOps) has the producer at op level, from data', () => {
  const out = normalizeCodeOps({ ops: [{ op: 'reference', data: { producer: 'C:\elsewhere\Secret_CS.oml', elements: ['GetSecret'] } }] });
  assert.equal(out.changed, true);
  assert.equal(out.job.ops[0].producer, 'C:\elsewhere\Secret_CS.oml');
  assert.equal(out.job.ops[0].data, undefined);
});
