// Lane B of the 2026-10-06 frictions (Astra item 1): a delivery refused at preflight answers its taskId, job and jobSha256,
// and the next call corrects it with patch + basedOn {taskId} in one call. The kernel's checkpoint of a refused preflight
// keeps no sources (the same task re-validates on resume) but records the job it checked (Delivery.JobIdentity:
// job {path, sha256}); basedOn {taskId} reads the hash there. A fake Anvil CLI writes that checkpoint as the kernel does;
// temporary folders only, no process, no Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle } from '../o11-cycle.mjs';
import { resolvePatchedJob } from '../job-patch.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const WORDS = 'sim, pode entregar no Orders';
const TASK = '526b54fe422a44cb96da5d5e313aa01b';
const JOB = { ops: [{ op: 'create', parent: '@espace', type: 'ServerAction', name: 'SaveOrder', as: '$save' },
  { op: 'set', target: '$save', prop: 'Description', value: 'Saves' }] };
const PROBLEMS = [{ op: 1, pointer: '/ops/1/value', code: 'A_CODE', severity: 'error', message: 'first', fix: 'use x' }];

// The checkpoint Delivery.Run writes for a refused preflight (DurableJson envelope): request, the job record, no sources.
function refusedPreflightTask(work, id, jobFile, module = 'Orders') {
  const state = { taskId: id, request: { Module: module, JobPath: jobFile, WorkDirectory: work, Checks: [] }, module, work: path.join(work, 'deliver', id),
    delivered: false, writeState: 'not-sent', history: [], job: { path: path.resolve(jobFile), sha256: sha256(fs.readFileSync(jobFile)) },
    preflight: { valid: false, errors: ['op #1 (set): first'] }, code: 'PREFLIGHT_REFUSED', problems: PROBLEMS, stage: 'preflight',
    error: 'Job refused by the preflight before any Studio call; nothing was sent. op #1 (set): first' };
  const payload = JSON.stringify(state);
  fs.mkdirSync(path.join(work, 'deliver', id), { recursive: true });
  fs.writeFileSync(path.join(work, 'deliver', id, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
  return state;
}

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atritos-b-basedon-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home');
  for (const dir of [root, home]) fs.mkdirSync(dir, { recursive: true });
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  const job = path.join(base, 'jobs', 'save-order.json');
  fs.mkdirSync(path.dirname(job), { recursive: true });
  fs.writeFileSync(job, JSON.stringify(JOB, null, 2));
  let clock = Date.parse('2026-10-06T10:00:00.000Z');
  return { base, root, env, job, local: path.join(root, '.local'), work: path.join(root, '.local', 'work'), now: () => new Date(clock += 1000) };
}

async function serve(t, deps) {
  const server = new McpServer({ name: 'atritos-b-basedon', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'atritos-b-basedon-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return args => client.callTool({ name: 'o11_deliver', arguments: args })
    .then(reply => reply.content[0].text === 'entregue' ? { ok: true, result: 'entregue' } : reply.structuredContent ?? JSON.parse(reply.content[0].text));
}

const argOf = (args, flag) => args[args.indexOf(flag) + 1];

test('job-patch: basedOn {taskId} of a refused preflight reads the job record of the kernel task, in one call', t => {
  const s = sandbox(t);
  const inlineDir = path.join(s.local, 'jobs', 'inline');
  refusedPreflightTask(s.work, TASK, s.job);
  const patch = [{ op: 'replace', path: '/ops/1/value', value: 'Saves the order' }];
  const patched = resolvePatchedJob({ patch, basedOn: { taskId: TASK } }, { inlineDir, work: s.work, uuid: () => 'fixed-1' });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  assert.deepEqual(patched.basedOn, { job: path.resolve(s.job), sha256: sha256(fs.readFileSync(s.job)), taskId: TASK });
  assert.equal(JSON.parse(fs.readFileSync(patched.path, 'utf8')).ops[1].value, 'Saves the order');
  // The record guards the base like the sources do: a job changed after the refusal is refused, never patched blind.
  fs.writeFileSync(s.job, JSON.stringify({ ...JOB, ops: JOB.ops.slice(0, 1) }));
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: TASK } }, { inlineDir, work: s.work, uuid: () => 'fixed-2' }).code, 'BASE_CHANGED');
  // A record of another file or without a valid hash proves nothing: only an explicit sha256 verifies that task.
  const other = 'b2'.repeat(16);
  const state = refusedPreflightTask(s.work, other, s.job);
  const payload = JSON.stringify({ ...state, job: { path: path.join(s.base, 'jobs', 'other.json'), sha256: state.job.sha256 } });
  fs.writeFileSync(path.join(s.work, 'deliver', other, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: other } }, { inlineDir, work: s.work, uuid: () => 'fixed-3' }).code, 'BASE_UNVERIFIED');
  const broken = 'c3'.repeat(16);
  const garbled = JSON.stringify({ ...refusedPreflightTask(s.work, broken, s.job), job: { path: s.job, sha256: 'not-a-hash' } });
  fs.writeFileSync(path.join(s.work, 'deliver', broken, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(garbled), payload: garbled }));
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: broken } }, { inlineDir, work: s.work, uuid: () => 'fixed-4' }).code, 'BASE_UNVERIFIED');
});

test('o11_deliver: refused at preflight, then patch + basedOn {taskId} delivers the corrected job in the next call', async t => {
  const s = sandbox(t);
  const delivered = [];
  // The first deliver is refused by the kernel's preflight and leaves the checkpoint the kernel leaves; the second delivers.
  const runAnvil = fakeAnvil({ deliver: args => {
    const job = argOf(args, '--job'); const work = argOf(args, '--work');
    if (delivered.length === 0) {
      delivered.push({ job, refused: true });
      return { ok: false, command: 'deliver', data: refusedPreflightTask(work, TASK, job) };
    }
    delivered.push({ job, refused: false });
    return { ok: true, command: 'deliver', data: { taskId: 'd4'.repeat(16), delivered: true, writeState: 'applied', validation: { newErrors: 0 } } };
  } });
  const call = await serve(t, { root: s.root, env: s.env, lane: 'ss4', now: s.now, runAnvil, assertSelected: async () => {}, lastPublication: async () => null,
    grantsFile: path.join(s.base, 'grants.json') });
  const refused = await call({ module: 'Orders', job: s.job, authorize: WORDS });
  assert.equal(refused.code, 'PREFLIGHT_REFUSED'); assert.equal(refused.taskId, TASK);
  assert.equal(refused.job, path.resolve(s.job)); assert.equal(refused.jobSha256, sha256(fs.readFileSync(s.job)));
  // The correction names only the task: no job path, no hash carried by hand.
  const fixed = await call({ patch: [{ op: 'replace', path: '/ops/1/value', value: 'Saves the order' }], basedOn: { taskId: TASK }, authorize: WORDS });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal(delivered.length, 2);
  assert.notEqual(delivered[1].job, delivered[0].job, 'the patched job is a new file; the base is never rewritten');
  assert.equal(JSON.parse(fs.readFileSync(delivered[1].job, 'utf8')).ops[1].value, 'Saves the order');
  assert.deepEqual(JSON.parse(fs.readFileSync(s.job, 'utf8')), JOB);
  // The module came from the refused task.
  const second = runAnvil.calls.filter(c => c.args[0] === 'deliver')[1].args;
  assert.equal(argOf(second, '--module'), 'Orders');
});
