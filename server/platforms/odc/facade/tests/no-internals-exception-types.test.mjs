import './fixtures/isolated-profile.mjs';
// Review vps-a9, E2 (C:\t\revisoes\vps-a9\REVISAO.md): the name of an exception type of SSAM reached a licensee. The kernel
// writes "<Type>: <message>" (Errors.Envelope and Errors.Text, Verbs.Apply's Unwrap, its " <- <Type>: " cause and
// EndOfApplyFailure), so an html refusal said "op #0 (html Login): KernelRefusalException: Login is not the reading...", and
// job-guidance.mjs failureOf kept the type in a field of its own, discovery.failure.exception. The family, in one place
// (exposure.mjs) for every type: no "<Type>Exception: " in the prose served to a licensee, and no failure.exception; the
// message stays whole. The exception of the customer's app (the debugger's exception field) and the OutSystems exceptions a
// customer's flow raises (UserException, DatabaseException...) stay. The owner's answers are as the tools built them.
// Here on the real path (the kernel's envelope -> job-runner -> the hub's exit -> exposure, through ssam_job on a fake CLI),
// on the exposure rule, and on the guard's detector (fixtures/internal-text.mjs), which now finds the family.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobTool } from '../job-runner.mjs';
import { failureOf, GUIDANCE_SCHEMA } from '../job-guidance.mjs';
import { exposedResult } from '../exposure.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { findings } from './fixtures/internal-text.mjs';
import { servedBytesStore } from '../served-bytes.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-exception-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const brief = value => JSON.stringify(value).slice(0, 1500);
const TYPE = /\b[A-Z][A-Za-z0-9]*Exception:/;
// Every string of an answer with where it is, outside the debugger's exception field (the customer's app).
function typedStrings(value, at = '') {
  if (typeof value === 'string') return TYPE.test(value) ? [at + ': ' + value.slice(0, 160)] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => typedStrings(v, at + '/' + i));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => (k === 'exception' && typeof v === 'object' ? [] : typedStrings(v, at + '/' + k)));
  return [];
}

const MESSAGE = 'Login is not the reading aaaaaaaaaaaa the edits were written on (now 80d54ce08485), and that reading is not kept here';
const ERROR = 'op #0 (html Login): KernelRefusalException: ' + MESSAGE + ' <- InvalidOperationException: the reading is gone';
async function session(t, exposure) {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  const env = { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const problem = { phase: 'apply', op: 0, pointer: '/basedOn', code: 'HTML_BASE_CHANGED', severity: 'error', message: 'KernelRefusalException: ' + MESSAGE,
    fix: 'write the edits again on the current text (basedOn.html ' + '8'.repeat(64) + '); it is current.text of this problem' };
  const runAnvil = fakeAnvil({ apply: () => ({ exitCode: 1, envelope: { ok: false, command: 'apply', elapsedMs: 5, code: 'HTML_BASE_CHANGED', error: ERROR, problems: [problem],
    stack: '   at Anvil.Core.ModelSession.Apply()' } }) });
  // The guidance of a failed job without its discovery index (job-guidance.mjs jobGuidance, index unavailable): the failure as
  // failureOf reads it, whole.
  const guidance = async (lane, job, result) => ({ ...result, discovery: { schemaVersion: GUIDANCE_SCHEMA, available: false, lane, failure: failureOf(result), reason: 'discovery index unavailable: not built here' } });
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) });
  const server = await createSsamServer({ profile: 'all', o11: false, odc: false, deps: { answersRoot: root,
    jobTool: input => jobTool(input, { root, env, o11Lane: 'ss4', runAnvil, guidance }),
    exposure: { profile: exposure, caller: () => 'exception-' + exposure + '-' + process.pid, store, dayBytes: 500 * 1024 * 1024 } } });
  const client = new Client({ name: 'no-internals-exception', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  let body = await once('ssam_job', { lane: 'o11', job: { ops: [{ op: 'get', target: 'Screen:Login' }] } });
  for (let i = 0; i < 240; i++) {
    const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
    if (!next) break;
    await sleep(100); body = await once(next.tool, next.arguments);
  }
  return body;
}

test('E2: a licensee\'s refused job names no exception type of SSAM (error, problems, discovery.failure); the message stays whole', async t => {
  const body = await session(t, 'licensee');
  assert.equal(body.ok, false, brief(body));
  assert.deepEqual(typedStrings(body), [], brief(body));
  assert.ok(String(body.error).includes(MESSAGE.slice(0, 60)) || body.problems?.[0]?.message?.includes(MESSAGE.slice(0, 60)), 'the message stays: ' + brief(body));
  assert.ok(body.discovery?.failure, 'the failure is served: ' + brief(body.discovery));
  assert.equal(body.discovery.failure.exception, undefined, 'no exception field: ' + brief(body.discovery));
  assert.equal(body.discovery.failure.op, 0);
  assert.match(body.discovery.failure.message, /^Login is not the reading/);
  assert.match(body.discovery.failure.message, /<- the reading is gone/, 'the cause stays, without its type');
  assert.deepEqual(findings(body).filter(f => f.family === 'exception type'), []);
});

test('E2: the owner\'s answer is as the tools built it (the rule is the licensee\'s)', async t => {
  const body = await session(t, 'owner');
  assert.match(JSON.stringify(body), /KernelRefusalException/);
  assert.equal(body.discovery?.failure?.exception, 'KernelRefusalException', brief(body.discovery));
});

test('E2: the exposure rule takes every exception type of SSAM out of the prose, keeps the customer\'s exception and the platform\'s', () => {
  const answer = { ok: false, code: 'KERNEL_REFUSED',
    error: 'System.InvalidOperationException: the apply failed; op #2 (set Name): ArgumentException: unknown property <- KeyNotFoundException: Name',
    message: 'the Studio\'s check at the end of the apply failed: NullReferenceException: Object reference not set to an instance of an object.',
    problems: [{ code: 'APPLY_FAILED', message: 'JobPreflightException: 2 problems', fix: 'fix the op (FormatException: input string was not in a correct format)' }],
    discovery: { schemaVersion: GUIDANCE_SCHEMA, available: false, failure: { stage: 'kernel', op: 2, verb: 'set', exception: 'ArgumentException', message: 'unknown property <- KeyNotFoundException: Name' } },
    // the customer's app: its exception (the debugger), and a flow's own OutSystems exception in SSAM's prose
    results: [{ name: 's1', status: 500, exception: { type: 'System.NullReferenceException', message: 'System.NullReferenceException: Object reference not set' } }],
    note: 'the scenario raised UserException: Order is closed, and DatabaseException: duplicate key' };
  const out = exposedResult({ content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer }, { exposure: 'licensee', tool: 'ssam_job', args: {} }).structuredContent;
  assert.equal(out.error, 'the apply failed; op #2 (set Name): unknown property <- Name');
  assert.equal(out.message, 'the Studio\'s check at the end of the apply failed: Object reference not set to an instance of an object.');
  assert.equal(out.problems[0].message, '2 problems');
  assert.equal(out.problems[0].fix, 'fix the op (input string was not in a correct format)');
  assert.equal(out.discovery.failure.exception, undefined);
  assert.equal(out.discovery.failure.message, 'unknown property <- Name');
  assert.deepEqual(out.results, answer.results, 'the exception of the customer\'s app stays whole');
  assert.equal(out.note, answer.note, 'an OutSystems exception a flow raises is the customer\'s');
  const owner = exposedResult({ content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer }, { exposure: 'owner', tool: 'ssam_job', args: {} }).structuredContent;
  assert.deepEqual(owner, answer);
});

test('E2: the guard\'s detector finds the family (an exception type of SSAM in a licensee\'s text), not the customer\'s exception', () => {
  assert.deepEqual(findings({ error: 'op #0 (html Login): KernelRefusalException: x' }).map(f => f.family), ['exception type']);
  assert.deepEqual(findings({ fix: 'cause <- System.IO.IOException: disk' }).map(f => f.family), ['exception type']);
  assert.deepEqual(findings({ results: [{ exception: { type: 'System.NullReferenceException', message: 'System.NullReferenceException: Object reference not set' } }] }), []);
  assert.deepEqual(findings({ note: 'the flow raised UserException: Order is closed' }), []);
});
