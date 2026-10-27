// servidor/fase4-25, finding A1 of the quick review of the marco-a5 server line (C:\t\vps-a5\conf-rapida\RELATORIO.md):
// patch "verified" makes the handler apply the operations kept in <job of basedOn>.verified-patch.json, a file the gate never
// read; patchJob threw on the string, the gate's catch dropped the job it could not build and let the call through
// unchecked. A licensed customer who planted x.json and x.json.verified-patch.json (agent:inbox brings both to <ws>/inbox)
// reached the handler with a pending generator, the prototype op, or a reference producer of another customer. Now:
//   - patch "verified" is refused at the gate (HOSTED_UNAVAILABLE, cause VERIFIED_PATCH_LOCAL), in the four job tools and in
//     ssam_reference check-job, for basedOn {job} and {taskId}, before the agent brings anything;
//   - confineJobs fails closed: a patch or partial job the gate cannot build is refused with the handler's own code, a patch
//     that is not an array is refused, and a basedOn {taskId} whose job the gate cannot read is refused;
//   - control: the explicit patch is still checked (the same ops are refused), and a legitimate one reaches the handler.
// A fake link, context and executor; no hub, agent, kernel or Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { PATCH_MAX_OPS } from '../job-patch.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const TOOLS = ['o11_job', 'ssam_job', 'o11_deliver', 'studio_deliver'];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const lane = name => (name === 'studio_deliver' ? { feature: 'F', module: 'M' } : name === 'ssam_job' ? { lane: 'o11' } : { module: 'M' });

function harness() {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected: true });
  const pulls = [];
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }),
    async call(kind) { throw Object.assign(new Error('no machine call: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); },
    async pullFile(value) { pulls.push(value); const file = path.join(dirs.workspace, ...value.slice(6).split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(link.agentFile(value), file); return file; } };
  const context = { id: 'ctx-verified', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const gate = name => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, async args => { calls.push({ name, args }); return reply({ ok: true }); },
      { context, link, lanes: context.lanes, run: (ctx, fn) => fn(), waitMs: 10 });
    return args => wrapped(args, { requestId: 1 });
  };
  const ws = (...p) => path.join(dirs.workspace, ...p);
  // another customer's capture, beside this one's workspace
  const other = write(path.join(dirs.root, 'server', 'customers', 'tok_other', 'o11', 'captures', 'Other.oml'), 'not this customer');
  return { ...dirs, link, executor, context, calls, pulls, gate, ws, other };
}
const refused = (result, label) => { assert.equal(result.structuredContent?.ok, false, label + ': ' + JSON.stringify(result).slice(0, 400)); return result.structuredContent; };

// The three operations the review planted: a pending generator, the prototype op, a producer of another customer.
const planted = h => ({
  'rest-consume': { op: 'rest-consume', data: { name: 'Api', methods: [{ name: 'Get', url: 'https://api.example.test/items' }] } },
  prototype: { op: 'prototype', data: { source: path.join(h.root, 'server') } },
  'reference producer of another customer': { op: 'reference', producer: h.other, elements: ['IServerAction:A'] },
});
const BASE = { ops: [{ op: 'logic', data: { flow: ['server action A @a1'] } }] };
const plant = (h, file, op) => {
  const base = write(file, BASE);
  write(base + '.verified-patch.json', { schema: 'ssam-verified-patch/1', job: base, jobSha256: sha(base), patch: [{ op: 'add', path: '/ops/-', value: op }] });
  return base;
};
// carried (a12): the patch the continuation sends explicitly, read from this customer's own files; null: none there.
const verifiedRefusal = (value, name, label, pointer = '/patch', carried = null) => {
  assert.equal(value.code, 'HOSTED_UNAVAILABLE', label);
  assert.equal(value.cause, 'VERIFIED_PATCH_LOCAL', label);
  assert.equal(value.policy, 'HOSTED_VERIFIED_PATCH', label);
  assert.equal(value.pointer, pointer, label);
  assert.equal(value.outcome, 'not-sent', label);
  assert.equal(value.continuation?.tool, name, label);
  const args = pointer.startsWith('/query/') ? value.continuation?.arguments?.query : value.continuation?.arguments;
  if (carried) { assert.deepEqual(args?.patch, carried, label + ': the continuation sends the kept patch explicitly'); assert.equal(value.continuation.add, undefined, label); return; }
  assert.equal(args?.patch, undefined, label + ': the continuation drops patch "verified"');
  assert.match(JSON.stringify(value.continuation?.add ?? {}), /JSON Patch operations themselves/, label);
};
// The gate's own check of each planted op once it is sent explicitly.
const plantedCause = { 'rest-consume': 'GENERATOR_PENDING', prototype: 'PROTOTYPE_IMPORT_DISABLED', 'reference producer of another customer': 'PATH_OUTSIDE_WORKSPACE' };

test('patch "verified" over basedOn {job} is refused at the gate in the four job tools, whatever the planted patch carries', async () => {
  const h = harness();
  for (const [label, op] of Object.entries(planted(h))) {
    const base = plant(h, h.ws('o11', 'jobs', 'base.json'), op);
    for (const name of TOOLS) {
      const value = refused(await h.gate(name)({ ...lane(name), basedOn: { job: 'ws:o11/jobs/base.json', sha256: sha(base) }, patch: 'verified' }), name + ' ' + label);
      // a12: the customer's own verified patch, sent explicitly by the continuation, is then checked like any patch.
      verifiedRefusal(value, name, name + ' ' + label, '/patch', [{ op: 'add', path: '/ops/-', value: op }]);
      assert.deepEqual(value.continuation.arguments.basedOn, { job: 'ws:o11/jobs/base.json', sha256: sha(base) }, name);
      const followed = refused(await h.gate(name)(value.continuation.arguments), name + ' ' + label + ' followed');
      assert.equal(followed.cause ?? followed.code, plantedCause[label], name + ' ' + label + ' followed: ' + JSON.stringify(followed).slice(0, 300));
    }
  }
  assert.deepEqual(h.calls, [], 'the handler never ran');
});

test('patch "verified" planted in the agent inbox: refused before the agent brings the job or its verified patch', async () => {
  const h = harness();
  for (const [label, op] of Object.entries(planted(h))) {
    const base = plant(h, h.link.agentFile('agent:inbox/x.json'), op);
    // and the same pair already brought to <ws>/inbox by an earlier call
    plant(h, h.ws('inbox', 'x.json'), op);
    for (const name of TOOLS) {
      for (const variant of ['verified', 'VERIFIED', ' verified ']) {
        const value = refused(await h.gate(name)({ ...lane(name), basedOn: { job: 'agent:inbox/x.json', sha256: sha(base) }, patch: variant }), name + ' ' + label + ' ' + variant);
        verifiedRefusal(value, name, name + ' ' + label);
      }
    }
  }
  assert.deepEqual(h.pulls, [], 'nothing brought from the agent');
  assert.deepEqual(h.calls, [], 'the handler never ran');
});

test('patch "verified" over basedOn {taskId} is refused in the four job tools; check-job of ssam_reference too', async () => {
  const h = harness();
  const taskId = 'c'.repeat(32);
  for (const [label, op] of Object.entries(planted(h))) {
    const base = plant(h, h.ws('o11', 'jobs', 'task-job.json'), op);
    write(h.ws('o11', 'work', 'deliver', taskId, 'task.json'), { request: { JobPath: base }, sources: [{ path: base, sha256: sha(base) }] });
    for (const name of TOOLS) verifiedRefusal(refused(await h.gate(name)({ ...lane(name), basedOn: { taskId }, patch: 'verified' }), name + ' ' + label), name, name + ' taskId ' + label);
    const value = refused(await h.gate('ssam_reference')({ lane: 'o11', kind: 'check-job', query: { basedOn: { job: 'ws:o11/jobs/task-job.json', sha256: sha(base) }, patch: 'verified' } }), 'check-job ' + label);
    verifiedRefusal(value, 'ssam_reference', 'check-job ' + label, '/query/patch', [{ op: 'add', path: '/ops/-', value: op }]);
    assert.equal(value.continuation.arguments.kind, 'check-job');
  }
  assert.deepEqual(h.calls, [], 'the handler never ran');
});

test('control: the same operations as an explicit patch are checked and refused; a legitimate explicit patch reaches the handler', async () => {
  const h = harness();
  const base = write(h.ws('o11', 'jobs', 'base.json'), BASE);
  const basedOn = { job: 'ws:o11/jobs/base.json', sha256: sha(base) };
  const ops = planted(h);
  for (const name of TOOLS) {
    assert.equal(refused(await h.gate(name)({ ...lane(name), basedOn, patch: [{ op: 'add', path: '/ops/-', value: ops['rest-consume'] }] }), name).cause, 'GENERATOR_PENDING', name);
    assert.equal(refused(await h.gate(name)({ ...lane(name), basedOn, patch: [{ op: 'add', path: '/ops/-', value: ops.prototype }] }), name).cause, 'PROTOTYPE_IMPORT_DISABLED', name);
    const outside = refused(await h.gate(name)({ ...lane(name), basedOn, patch: [{ op: 'add', path: '/ops/-', value: ops['reference producer of another customer'] }] }), name);
    assert.deepEqual([outside.code, outside.pointer], ['PATH_OUTSIDE_WORKSPACE', '/basedOn/job (patched) > /ops/1/producer'], name);
  }
  assert.deepEqual(h.calls, []);
  for (const name of TOOLS) {
    const result = await h.gate(name)({ ...lane(name), basedOn, patch: [{ op: 'replace', path: '/ops/0/data/flow/0', value: 'server action B @b1' }] });
    assert.equal(result.structuredContent?.ok, true, name + ': ' + JSON.stringify(result).slice(0, 300));
  }
  assert.deepEqual(h.calls.map(c => c.name), TOOLS, 'each legitimate explicit patch reached its handler');
  assert.deepEqual(h.calls.map(c => c.args.patch[0].value), TOOLS.map(() => 'server action B @b1'));
});

test('fail closed: a patch or partial job the gate cannot build is refused with the handler\'s own code, never let through unchecked', async () => {
  const h = harness();
  const base = write(h.ws('o11', 'jobs', 'base.json'), BASE);
  const basedOn = { job: 'ws:o11/jobs/base.json', sha256: sha(base) };
  // One more than the product's bound (job-patch.mjs PATCH_MAX_OPS: 500 since the proto line, 50 before).
  const tooMany = Array.from({ length: PATCH_MAX_OPS + 1 }, () => ({ op: 'add', path: '/ops/-', value: { op: 'find', name: 'x' } }));
  const cases = [
    ['more than PATCH_MAX_OPS operations', { patch: tooMany }, 'PATCH_INVALID', '/patch'],
    ['an empty patch', { patch: [] }, 'PATCH_INVALID', '/patch'],
    ['a patch that is not an array', { patch: { op: 'add', path: '/ops/-', value: { op: 'find', name: 'x' } } }, 'PATCH_INVALID', '/patch'],
    ['a patch string other than verified', { patch: 'all' }, 'PATCH_INVALID', '/patch'],
    ['a failing test operation', { patch: [{ op: 'test', path: '/ops/0/op', value: 'other' }] }, null, '/patch'],
  ];
  for (const name of TOOLS) {
    for (const [label, extra, code, pointer] of cases) {
      const value = refused(await h.gate(name)({ ...lane(name), basedOn, ...extra }), name + ' ' + label);
      if (code) assert.equal(value.code, code, name + ' ' + label);
      else assert.match(value.code, /^PATCH_/, name + ' ' + label);
      assert.equal(value.pointer, pointer, name + ' ' + label);
      assert.match(value.error, /could not build and check the job/, name + ' ' + label);
    }
    // basedOn {taskId} the gate cannot read: no task state in the customer's work folder
    const value = refused(await h.gate(name)({ ...lane(name), basedOn: { taskId: 'd'.repeat(32) }, patch: [{ op: 'replace', path: '/ops/0/op', value: 'logic' }] }), name + ' taskId');
    assert.deepEqual([value.code, value.pointer], ['JOB_PATHS_UNCHECKED', '/basedOn/taskId'], name);
  }
  assert.deepEqual(h.calls, [], 'the handler never ran');
});

// servidor/fase4-27 a11: fix "apply" (o11_deliver, studio_deliver, ssam_code) makes the handler apply the patches a refusal
// of the job of basedOn kept on the server (job-patch.mjs proposedPatch), files the gate never reads: before this rule it
// reached the handler unchecked. The same family rule as patch "verified" (job-paths.mjs UNREAD_PATCH_FORMS), the same
// refusal, at /fix; the explicit patch is still checked, and a legitimate one still reaches the handler.
const FIX_TOOLS = ['o11_deliver', 'studio_deliver', 'ssam_code'];
const fixLane = name => (name === 'ssam_code' ? { lane: 'o11', action: 'write', module: 'M' } : lane(name));
for (const name of FIX_TOOLS) test('fix "apply" over basedOn is refused at the gate in ' + name + ', as patch "verified" is', async () => {
  const h = harness();
  const base = write(h.ws('o11', 'jobs', 'base.json'), BASE);
  const basedOn = { job: 'ws:o11/jobs/base.json', sha256: sha(base) };
  {
    for (const extra of [{ fix: 'apply' }, { fix: ' APPLY ' }, { fix: 'apply', patch: [{ op: 'replace', path: '/ops/0/data/flow/0', value: 'server action B @b1' }] },
      { fix: 'apply', authorize: '<the user\'s words>' }]) {
      const label = name + ' ' + JSON.stringify(extra);
      const value = refused(await h.gate(name)({ ...fixLane(name), basedOn, ...extra }), label);
      assert.equal(value.code, 'HOSTED_UNAVAILABLE', label);
      assert.equal(value.cause, 'VERIFIED_PATCH_LOCAL', label);
      assert.equal(value.policy, 'HOSTED_VERIFIED_PATCH', label);
      assert.equal(value.pointer, '/fix', label);
      assert.equal(value.outcome, 'not-sent', label);
      assert.match(value.error, /^fix "apply" is available only in local use for now: .* Nothing ran\.$/, label);
      assert.equal(value.continuation?.tool, name, label);
      assert.equal(value.continuation.arguments.fix, undefined, label + ': the continuation drops fix "apply"');
      assert.equal(value.continuation.arguments.patch, undefined, label + ': the explicit patch carries the call\'s own operations');
      assert.deepEqual(value.continuation.arguments.basedOn, basedOn, label);
      if (extra.authorize) assert.equal(value.continuation.arguments.authorize, extra.authorize, label);
      assert.match(value.continuation.add?.patch ?? '', /^the JSON Patch operations themselves: .*then your own/, label);
    }
  }
  // through the agent inbox too: refused before the agent brings anything
  const inbox = write(h.link.agentFile('agent:inbox/x.json'), BASE);
  refused(await h.gate(name)({ ...fixLane(name), basedOn: { job: 'agent:inbox/x.json', sha256: sha(inbox) }, fix: 'apply' }), name + ' inbox');
  assert.deepEqual(h.pulls, [], 'nothing brought from the agent');
  assert.deepEqual(h.calls, [], 'the handler never ran');
});

test('control for fix "apply": the explicit patch with operations passes the gate in o11_deliver, studio_deliver and ssam_code', async () => {
  const h = harness();
  const base = write(h.ws('o11', 'jobs', 'base.json'), BASE);
  const basedOn = { job: 'ws:o11/jobs/base.json', sha256: sha(base) };
  for (const name of FIX_TOOLS) {
    assert.equal(refused(await h.gate(name)({ ...fixLane(name), basedOn, patch: [{ op: 'add', path: '/ops/-', value: planted(h).prototype }] }), name).cause, 'PROTOTYPE_IMPORT_DISABLED', name + ': the explicit patch is checked');
    const result = await h.gate(name)({ ...fixLane(name), basedOn, patch: [{ op: 'replace', path: '/ops/0/data/flow/0', value: 'server action B @b1' }] });
    assert.equal(result.structuredContent?.ok, true, name + ': ' + JSON.stringify(result).slice(0, 400));
  }
  assert.deepEqual(h.calls.map(c => c.name), FIX_TOOLS, 'each explicit patch reached its handler');
  assert.ok(h.calls.every(c => c.args.fix === undefined && c.args.patch[0].value === 'server action B @b1'));
});

// a12 (review of 386c5bf6, Low): any fix sent is refused on hosted, not only the string "apply": the gate never leans on
// the schema's const.
test('a fix that is not the string "apply" (true, 1, {}, null, "other") is refused at the gate in o11_deliver, studio_deliver and ssam_code', async () => {
  const h = harness();
  const base = write(h.ws('o11', 'jobs', 'base.json'), BASE);
  const basedOn = { job: 'ws:o11/jobs/base.json', sha256: sha(base) };
  for (const name of FIX_TOOLS) for (const fix of [true, 1, {}, null, 'other', []]) {
    const value = refused(await h.gate(name)({ ...fixLane(name), basedOn, fix }), name + ' ' + JSON.stringify(fix));
    assert.deepEqual([value.cause, value.pointer], ['VERIFIED_PATCH_LOCAL', '/fix'], name + ' ' + JSON.stringify(fix));
  }
  assert.deepEqual(h.calls, [], 'the handler never ran');
});
