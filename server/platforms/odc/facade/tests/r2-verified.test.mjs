import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { hostedCheck } from '../hosted/checks.mjs';
import { buildBeforeApply, withCheckedCandidate } from '../o11-build-phase.mjs';
import { withStudioWriteLock } from '../studio-write-lock.mjs';
import { modelSha256 } from '../o11-capture-store.mjs';
import { createBuildPool } from '../build-pool.mjs';
import { codeCheck } from '../code-check.mjs';
import { runWithExecutor } from '../executor.mjs';
import { customerStateDir } from '../hosted/storage.mjs';
import { registerPrivateCheck } from '../hosted/verified-store.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';
test.after(cleanupHostedDirs);
const sha = value => createHash('sha256').update(value).digest('hex');
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
function harness() {
  const dirs = hostedDirs(os.tmpdir()), agent = fakeAgentLink({ agentRoot: dirs.agentRoot, connected: true });
  const context = { workspace: dirs.workspace, agent, lanes: ['o11'], executor: { o11Connection: () => ({ pid: 6001 }), quota: { full: () => false } } };
  const calls = [];
  const gate = wrapHostedTool('o11_deliver', { inputSchema: {} }, async args => { calls.push(args); return reply({ ok: true }); }, { context, run: (_, fn) => fn() });
  const file = path.join(dirs.workspace, 'o11', 'job.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'logic', data: { flow: ['server action Lookup @a1'] } }] }));
  return { ...dirs, context, calls, file, gate: args => gate({ module: 'Inventory', ...args }, {}) };
}
test('R2 private verified patches pass the gate and remain bound to their job', async () => {
  const store = await import('../hosted/verified-store.mjs');
  const h = harness(), jobSha256 = sha(fs.readFileSync(h.file));
  const patch = [{ op: 'replace', path: '/ops/0/data/flow', value: ['server action Lookup @a1\n  end'] }];
  const ref = store.keepVerified(h.workspace, 'patch', { jobSha256, patch });
  const result = await h.gate({ basedOn: { job: h.file, sha256: jobSha256 }, patch: { verified: ref } });
  assert.equal(result.structuredContent.ok, true, JSON.stringify(result));
  assert.deepEqual(h.calls[0].patch, patch);
  const wrong = await h.gate({ basedOn: { job: h.file, sha256: 'b'.repeat(64) }, patch: { verified: ref } });
  assert.equal(wrong.structuredContent.code, 'PATCH_INVALID');
  const other = harness();
  assert.equal((await other.gate({ basedOn: { job: other.file, sha256: jobSha256 }, patch: { verified: ref } })).structuredContent.code, 'PATCH_INVALID');
});
test('R2 a private patch cannot bypass producer confinement or prototype policy', async () => {
  const store = await import('../hosted/verified-store.mjs');
  for (const op of [{ op: 'prototype', data: { source: 'C:/outside' } }, { op: 'reference', producer: 'C:/outside/Other.oml', elements: ['IServerAction:Lookup'] }]) {
    const h = harness(), jobSha256 = sha(fs.readFileSync(h.file));
    const ref = store.keepVerified(h.workspace, 'patch', { jobSha256, patch: [{ op: 'add', path: '/ops/-', value: op }] });
    assert.equal((await h.gate({ basedOn: { job: h.file, sha256: jobSha256 }, patch: { verified: ref } })).structuredContent.ok, false);
    assert.equal(h.calls.length, 0);
  }
});
test('R2 a hosted check preserves an immutable candidate before cleanup', async () => {
  const h = harness(), dir = path.join(customerStateDir(h.workspace), 'checks', 'one'); fs.mkdirSync(dir, { recursive: true });
  const files = Object.fromEntries(['path', 'base', 'job', 'result'].map(k => [k, path.join(dir, k === 'path' ? 'candidate.oml' : k === 'result' ? 'candidate.oml.result.json' : k + '.json')]));
  for (const k of ['path', 'base', 'job']) fs.writeFileSync(files[k], k === 'job' ? '{"ops":[]}' : k);
  fs.writeFileSync(files.result, JSON.stringify({ isValid: true, accepted: true, sources: [{ path: files.job }] }));
  const candidate = { ...files, sha256: sha('path'), baseSha256: sha('base'), baseModelSha256: 'a'.repeat(64), producers: {} };
  const check = hostedCheck(h.context, async () => { registerPrivateCheck(dir); return { ok: true, job: files.job, [Symbol.for('ssam.check.candidate')]: candidate }; });
  const answer = await check({ lane: 'o11', module: 'Inventory' });
  assert.match(answer.candidateRef, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(files.path), false);
  const store = await import('../hosted/verified-store.mjs');
  const offer = store.candidateOffer(h.workspace, answer.candidateRef, { lane: 'o11', module: 'Inventory' });
  assert.equal(fs.readFileSync(offer.candidate.path, 'utf8'), 'path');
  assert.throws(() => store.candidateOffer(h.workspace, answer.candidateRef, { lane: 'o11', module: 'Other' }));
});

test('R2 hosted validation writes its job base and candidate in private state', async () => {
  const h = harness(); h.context.hosted = true;
  h.context.executor.call = async () => { throw new Error('No machine call is allowed.'); };
  const base = path.join(h.workspace, 'o11', 'base.oml'); fs.writeFileSync(base, 'capture');
  let seen;
  const answer = await runWithExecutor(h.context, () => codeCheck({ lane: 'o11', module: 'Inventory', base }, {
    root: h.workspace, local: path.join(h.workspace, 'o11'), odcRoot: path.join(h.workspace, 'odc'),
    env: { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' },
    writeCall: () => ({ tool: 'o11_deliver', arguments: { job: { ops: [] } } }),
    runJob: async input => {
      seen = input;
      for (const field of ['job', 'base', 'out']) assert.ok(input[field].startsWith(path.join(customerStateDir(h.workspace), 'checks') + path.sep), field);
      fs.writeFileSync(input.out, 'validated candidate');
      fs.writeFileSync(input.out.replace(/\.oml$/, '.kernel-result.json'), JSON.stringify({ isValid: true, accepted: true, sources: [{ path: input.job }] }));
      return { ok: true, job: input.job };
    },
  }));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.ok(answer.job.startsWith(path.join(h.workspace, 'o11', 'jobs', 'check')));
  assert.notEqual(answer.job, seen.job);
  assert.equal(fs.readFileSync(answer[Symbol.for('ssam.check.candidate')].path, 'utf8'), 'validated candidate');
});

test('R2 a retained preview skips apply on the same base and rebuilds on a changed base', async () => {
  const store = await import('../hosted/verified-store.mjs');
  const h = harness(), dir = path.join(customerStateDir(h.workspace), 'builds', 'preview'); fs.mkdirSync(dir, { recursive: true });
  const oml = model => { const header = Buffer.from('{}'), n = Buffer.alloc(4); n.writeUInt32LE(header.length); return Buffer.concat([Buffer.from('OML'), n, header, Buffer.from(model)]); };
  const file = (name, bytes) => { const p = path.join(dir, name); fs.writeFileSync(p, bytes); return p; };
  const base = file('base.oml', oml('base')), job = file('job.json', '{"ops":[]}'), candidate = file('candidate.oml', oml('changed'));
  const result = file('result.json', JSON.stringify({ isValid: true, accepted: true, sources: [{ path: job, sha256: sha(fs.readFileSync(job)) }] }));
  const manifest = file('manifest.json', JSON.stringify({ base, job, candidate, result, candidateSha256: sha(fs.readFileSync(candidate)), baseSha256: sha(fs.readFileSync(base)), baseModelSha256: modelSha256(base), producers: {} }));
  const ref = store.keepPreview(h.workspace, 'Inventory', manifest);
  fs.writeFileSync(candidate, 'planted bytes in the agent-visible folder');
  for (const model of ['base', 'another base']) {
    const offer = store.candidateOffer(h.workspace, ref, { lane: 'o11', module: 'Inventory' });
    let applies = 0;
    const lane = { local: path.join(dir, model, 'local'), work: path.join(dir, model, 'work'), name: 'ss4' };
    const ctx = { root: h.workspace, env: {}, now: () => new Date(), buildPool: createBuildPool({ dir: path.join(dir, model, 'pool'), size: 1 }),
      bridge: () => ({ async ok(method, args) {
        if (method === 'list_open_modules') return { modules: [{ name: 'Inventory', key: 'K', hasESpace: true }] };
        fs.mkdirSync(path.dirname(args.path), { recursive: true }); fs.writeFileSync(args.path, oml(model)); return { path: args.path, key: 'K' };
      } }), buildRunner: () => async args => { applies++; const out = args[args.indexOf('--out') + 1]; fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, oml('rebuilt')); return { envelope: { ok: true, data: { isValid: true, accepted: true } } }; } };
    await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Inventory', job }, lane: 'o11', deps: { o11Root: path.join(dir, 'kernel'), odcRoot: path.join(dir, 'odc'), connection: () => null }, phased: true },
      () => withCheckedCandidate(offer, () => buildBeforeApply({ input: { module: 'Inventory' }, job, ctx, lane, task: { id: 'T1' } })));
    assert.equal(applies, model === 'base' ? 0 : 1);
    assert.equal(offer.outcome.reused, model === 'base');
  }
});
