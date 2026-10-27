// servidor/fase4-27 a12 (review of 386c5bf6, Medium): on a hosted server the next call a refusal names was itself refused.
// A refusal with a certain patch named fixCall {fix:"apply"} (and made it the continuation of studio_deliver); the gate
// refuses fix "apply" and patch "verified" there (VERIFIED_PATCH_LOCAL), and a certain patch over 512 B left the answer
// (patchIn verifiedPatch, patchOmitted): the operations were only in server files no answer pointed to. Now, hosted:
//   - the fix call is the explicit patch, by name, over the same basedOn (job-patch.mjs explicitFixCall), both lanes;
//   - following it reaches the delivery handler with that patch, checked by the gate;
//   - the gate's own refusal of fix (any value) carries the kept patch of this customer's job as its continuation's patch;
//   - locally nothing changes: fixCall is still fix "apply".
// Fake CLI, fake ODC server, fake executor and agent; temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { runWithExecutor, prepareWorkspace } from '../executor.mjs';
import { serverRoots } from '../hosted/policy.mjs';
import { o11Lane } from '../workspace.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const WORDS = 'pode entregar no Orders';
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-fix-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
// The concrete case of the review: a screen html op whose certain fix is a replace of about 1.2 KB.
const LONG = '<div class="form">' + '<input k="name" value="x"/>'.repeat(45) + '</div>';
const JOB = { ops: [{ op: 'html', data: { screen: 'Orders', html: '<div>old</div>' } }] };
const PROBLEM = { phase: 'preflight', op: 0, pointer: '/ops/0/data/html', code: 'HTML_INVALID', severity: 'error', message: 'The screen html does not parse',
  fix: 'the corrected html', patch: [{ op: 'replace', path: '/ops/0/data/html', value: LONG }], patchCertain: true };

function hostedContext(root) {
  const workspace = path.join(root, 'server', 'customers', 'tok_fix');
  prepareWorkspace(workspace);
  const record = { ok: true, lane: 'o11', anvilLane: o11Lane.lane, pid: 5150, startedUtc: '2026-10-27T10:00:00.0000000Z', studioVersion: '11.55.92', port: 41997,
    authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-27T10:00:05.000Z', hosted: true };
  const executor = { id: 'fake-' + randomUUID(), hosted: true, workspace, relayPort: () => 41997, o11Connection: () => record, close: async () => {}, quota: { full: () => false },
    calls: [], async call(kind) { this.calls.push(kind); if (kind === 'studio.processes') return { processes: [] }; throw Object.assign(new Error('unexpected ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); } };
  const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', agentRoot: path.join(root, 'agent'),
    kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' }, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
  return { id: randomUUID(), hosted: true, tokenId: 'tok_fix', customer: 'Test', lanes: ['odc', 'o11'], workspace, agent, executor, close: async () => {} };
}
async function connect(t, server) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-fix-continuation', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
}
function fakeOdc(seen, replies, root) {
  return async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_deliver', { title: 'Deliver', description: 'Fake ODC delivery.', inputSchema: z.object({ feature: z.string().min(1), module: z.string().optional(),
      job: z.string().optional(), owners: z.array(z.string()).optional(), changes: z.array(z.string()).optional() }).strict() }, async args => {
      seen.push({ args, job: args.job ? JSON.parse(fs.readFileSync(path.resolve(root, args.job), 'utf8')) : null });
      const value = replies.shift();
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) };
    });
    return fake;
  };
}
const isFixOrVerified = call => call && (call.arguments?.fix !== undefined || call.arguments?.patch === 'verified');

test('hosted studio_deliver: the 1.2 KB certain fix is the explicit patch of the continuation, and following it delivers that patch', async t => {
  const root = tmp(t);
  const context = hostedContext(root);
  const odcRoot = path.join(context.workspace, 'odc');
  const seen = [], replies = [];
  const server = await runWithExecutor(context, () => createSsamServer({ o11: false, odc: true, hosted: { context, session: { agent: context.agent, lanes: context.lanes },
    presentation: { workspace: context.workspace, serverRoots: serverRoots({ tmp: '' }) } }, deps: { odcFacade: fakeOdc(seen, replies, odcRoot), odcRoot, lock: { o11Root: odcRoot, odcRoot, connection: () => null } } }));
  const call = await connect(t, server);
  replies.push({ ok: false, code: 'PREFLIGHT_REFUSED', error: 'every phase', problems: [PROBLEM] });
  const refused = await call('studio_deliver', { feature: 'F', module: 'Orders', job: JOB });
  assert.equal(refused.ok, false, JSON.stringify(refused).slice(0, 400));
  for (const next of [refused.fixCall, refused.continuation, refused.verifiedPatch?.call]) assert.ok(!isFixOrVerified(next), 'never fix or verified on hosted: ' + String(JSON.stringify(next)).slice(0, 300));
  const next = refused.continuation;
  assert.equal(next?.tool, 'studio_deliver', JSON.stringify(refused).slice(0, 600));
  assert.deepEqual(next.arguments.patch, PROBLEM.patch.map(op => ({ ...op, path: next.arguments.patch[0].path })), 'the whole 1.2 KB patch');
  assert.equal(next.arguments.patch[0].value, LONG);
  replies.push({ ok: true, merged: true, strictlyEqual: true });
  const fixed = await call(next.tool, next.arguments);
  assert.equal(fixed.result, 'delivered', JSON.stringify(fixed).slice(0, 400));
  assert.equal(seen.length, 2); assert.equal(seen[1].job.ops[0].data.html, LONG, 'the handler delivered the explicit patch');
});

test('hosted o11_deliver: the fix call is the explicit patch over the same basedOn; following it delivers', async t => {
  const root = tmp(t);
  const context = hostedContext(root);
  const replies = [{ ok: false, command: 'deliver', data: { taskId: 'a'.repeat(32), module: 'Orders', delivered: false, writeState: 'not-sent', stage: 'preflight', error: 'op #0 [HTML_INVALID]: x', problems: [PROBLEM] } },
    { ok: true, command: 'deliver', data: { delivered: true, taskId: 'b'.repeat(32), writeState: 'applied', validation: { newErrors: 0 } } }];
  const runAnvil = fakeAnvil({ deliver: () => replies.shift() });
  const server = await runWithExecutor(context, () => createSsamServer({ odc: false, hosted: { context, session: { agent: context.agent, lanes: context.lanes },
    presentation: { workspace: context.workspace, serverRoots: serverRoots({ tmp: '' }) } },
    deps: { cycle: { root: context.workspace, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil, assertSelected: async () => {}, tasksDir: path.join(context.workspace, 'o11', 'tasks'), lastPublication: async () => null },
      lock: { o11Root: root, odcRoot: root, connection: () => null } } }));
  const call = await connect(t, server);
  // the job as a file of the customer's workspace, as a hosted model sends it
  const jobFile = path.join(context.workspace, 'o11', 'jobs', 'orders.json');
  fs.mkdirSync(path.dirname(jobFile), { recursive: true }); fs.writeFileSync(jobFile, JSON.stringify(JOB));
  const refused = await call('o11_deliver', { module: 'Orders', job: 'ws:o11/jobs/orders.json', authorize: WORDS });
  assert.equal(refused.ok, false, JSON.stringify(refused).slice(0, 400));
  for (const next of [refused.fixCall, refused.continuation, refused.verifiedPatch?.call]) assert.ok(!isFixOrVerified(next), 'never fix or verified on hosted: ' + String(JSON.stringify(next)).slice(0, 300));
  assert.ok(refused.fixCall, JSON.stringify(refused).slice(0, 600));
  assert.equal(refused.fixCall.arguments.patch[0].value, LONG, 'the whole 1.2 KB patch');
  assert.deepEqual(refused.fixCall.arguments.basedOn, refused.nextBasedOn);
  const fixed = await call('o11_deliver', { ...refused.fixCall.arguments, authorize: WORDS });
  assert.equal(fixed.result, 'delivered', JSON.stringify(fixed).slice(0, 400));
  const sent = runAnvil.calls.filter(c => c.args[0] === 'deliver');
  assert.equal(sent.length, 2, 'the explicit patch reached the delivery');
  const jobOf = c => { const at = c.args.indexOf('--job'); return at >= 0 ? JSON.parse(fs.readFileSync(c.args[at + 1], 'utf8').replace(/^﻿/, '')) : null; };
  assert.equal(jobOf(sent[1])?.ops?.[0]?.data?.html, LONG, 'the delivered job carries the explicit patch');
});

test('hosted gate: fix (any value) is refused, and the refusal carries this customer\'s kept patch as its continuation\'s patch', async t => {
  const root = tmp(t);
  const context = hostedContext(root);
  const odcRoot = path.join(context.workspace, 'odc');
  const seen = [], replies = [];
  const server = await runWithExecutor(context, () => createSsamServer({ o11: false, odc: true, hosted: { context, session: { agent: context.agent, lanes: context.lanes },
    presentation: { workspace: context.workspace, serverRoots: serverRoots({ tmp: '' }) } }, deps: { odcFacade: fakeOdc(seen, replies, odcRoot), odcRoot, lock: { o11Root: odcRoot, odcRoot, connection: () => null } } }));
  const call = await connect(t, server);
  replies.push({ ok: false, code: 'PREFLIGHT_REFUSED', error: 'every phase', problems: [PROBLEM] });
  const refused = await call('studio_deliver', { feature: 'F', module: 'Orders', job: JOB });
  const basedOn = refused.nextBasedOn;
  assert.ok(basedOn?.job, JSON.stringify(refused).slice(0, 400));
  // A model that still sends fix "apply" (or any fix): the gate's refusal names the explicit patch.
  for (const fix of ['apply', true, 1, {}, null]) {
    const gated = await call('studio_deliver', { feature: 'F', module: 'Orders', basedOn, fix });
    assert.equal(gated.cause, 'VERIFIED_PATCH_LOCAL', JSON.stringify(fix) + ': ' + JSON.stringify(gated).slice(0, 300));
    assert.equal(gated.pointer, '/fix');
    assert.equal(gated.continuation.arguments.fix, undefined);
    assert.equal(gated.continuation.arguments.patch?.[0]?.value, LONG, JSON.stringify(fix) + ': the kept patch, explicit');
  }
  assert.equal(seen.length, 1, 'no refused call reached the handler');
  replies.push({ ok: true, merged: true, strictlyEqual: true });
  const gated = await call('studio_deliver', { feature: 'F', module: 'Orders', basedOn, fix: 'apply' });
  const fixed = await call(gated.continuation.tool, gated.continuation.arguments);
  assert.equal(fixed.result, 'delivered', JSON.stringify(fixed).slice(0, 400));
  assert.equal(seen[1].job.ops[0].data.html, LONG);
});
