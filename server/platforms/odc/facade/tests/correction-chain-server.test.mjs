// R1 (loop-correcao, through the whole ssam server) under the candidate's T16 rule: a refusal with certain patches names its
// fix call; the words marker is WORDS_REQUIRED at the hub for every call (the words are never inherited); and studio_deliver
// (ODC) takes fix:"apply" over the nextBasedOn of its refusal, also through ssam_code write. Fake CLI and fake ODC server;
// temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const MARKER = "<the user's own words>";
const WORDS = 'pode entregar no Orders';
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-server-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const PROBLEM = { phase: 'preflight', op: 0, pointer: '/ops/0/value', code: 'TEXT_TOO_LONG', severity: 'error', message: 'Description is too long',
  fix: 'a shorter description', patch: [{ op: 'replace', path: '/ops/0/value', value: 'short' }], patchCertain: true };
const JOB = { ops: [{ op: 'set', target: 'ServerAction:SaveOrder', prop: 'Description', value: 'a very long text' }] };
async function connect(t, server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'chain-server-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
}

// integ/proto-into-product: the candidate's T16 rule holds over the proto's R1 inheritance. The words are never inherited, a
// correction of the chain too: the marker is WORDS_REQUIRED for every call (a new write, a publication, the fix call), and the
// fix call carries the marker in authorize for the user's words. fix "apply" applies only the certain patches (patchCertain).
test('hub: the words marker is WORDS_REQUIRED on every call, a correction of the chain too; the fix call takes the user\'s words', async t => {
  const root = tmp(t);
  const replies = [{ ok: false, command: 'deliver', data: { taskId: 'a'.repeat(32), module: 'Orders', delivered: false, writeState: 'not-sent', stage: 'preflight', error: 'op #0 [TEXT_TOO_LONG]: x', problems: [PROBLEM] } },
    { ok: true, command: 'deliver', data: { delivered: true, taskId: 'b'.repeat(32), writeState: 'applied', validation: { newErrors: 0 } } }];
  const runAnvil = fakeAnvil({ deliver: () => replies.shift() });
  const server = await createSsamServer({ odc: false, deps: { cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil, assertSelected: async () => {}, tasksDir: path.join(root, 'tasks'), lastPublication: async () => null },
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const call = await connect(t, server);
  const refused = await call('o11_deliver', { module: 'Orders', job: JOB, authorize: WORDS });
  assert.equal(refused.ok, false); assert.ok(refused.fixCall);
  assert.equal(refused.fixCall.arguments.authorize, MARKER, 'the fix call asks for the words');
  assert.equal((await call('o11_deliver', { module: 'Orders', job: JOB, authorize: MARKER })).code, 'WORDS_REQUIRED', 'a new write');
  assert.equal((await call('o11_deliver', { ...refused.fixCall.arguments, publish: true })).code, 'WORDS_REQUIRED', 'a publication');
  assert.equal((await call('o11_deliver', refused.fixCall.arguments)).code, 'WORDS_REQUIRED', 'the correction: never inherited');
  assert.equal(runAnvil.calls.filter(c => c.args[0] === 'deliver').length, 1, 'nothing ran for a call without words');
  const fixed = await call('o11_deliver', { ...refused.fixCall.arguments, authorize: WORDS });
  assert.equal(fixed.result, 'delivered', JSON.stringify(fixed));
  assert.notEqual(fixed.authorization?.source, 'inherited');
  assert.equal(runAnvil.calls.filter(c => c.args[0] === 'deliver').length, 2);
  const sent = runAnvil.calls.filter(c => c.args[0] === 'deliver').at(-1);
  assert.ok(sent, 'the corrected job was delivered');
});

test('a choice (patchCertain false) is never applied for the author: no fix call, and fix "apply" over it applies nothing', async t => {
  const root = tmp(t);
  const choice = { ...PROBLEM, code: 'CREATE_USES_EXISTING', patchCertain: false, patchChoice: 'use the existing element' };
  const replies = [{ ok: false, command: 'deliver', data: { taskId: 'c'.repeat(32), module: 'Orders', delivered: false, writeState: 'not-sent', stage: 'preflight', error: 'op #0 [CREATE_USES_EXISTING]: x', problems: [choice] } }];
  const runAnvil = fakeAnvil({ deliver: () => replies.shift() });
  const server = await createSsamServer({ odc: false, deps: { cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil, assertSelected: async () => {}, tasksDir: path.join(root, 'tasks'), lastPublication: async () => null },
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const call = await connect(t, server);
  const refused = await call('o11_deliver', { module: 'Orders', job: JOB, authorize: WORDS });
  assert.equal(refused.ok, false); assert.equal(refused.fixCall, undefined);
  const none = await call('o11_deliver', { module: 'Orders', fix: 'apply', basedOn: refused.nextBasedOn, authorize: WORDS });
  assert.equal(none.ok, false); assert.equal(none.code, 'FIX_NONE', JSON.stringify(none));
  assert.equal(runAnvil.calls.filter(c => c.args[0] === 'deliver').length, 1);
});

test('studio_deliver: a refusal with patches names fixCall; fix "apply" sends the job with exactly those patches; one that does not apply is refused once', async t => {
  const odcRoot = tmp(t);
  const seen = [], replies = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_deliver', { title: 'Deliver', description: 'Fake ODC delivery.', inputSchema: z.object({ feature: z.string().min(1), module: z.string().optional(),
      job: z.string().optional(), owners: z.array(z.string()).optional(), changes: z.array(z.string()).optional() }).strict() }, async args => {
      seen.push({ args, job: args.job ? readJson(path.resolve(odcRoot, args.job)) : null });
      const value = replies.shift();
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) };
    });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot, lock: { o11Root: odcRoot, odcRoot, connection: () => null } } });
  const call = await connect(t, server);
  replies.push({ ok: false, code: 'PREFLIGHT_REFUSED', error: 'every phase', problems: [PROBLEM] });
  const refused = await call('studio_deliver', { feature: 'F', module: 'Orders', owners: ['SaveOrder'], changes: ['c'], job: JOB });
  assert.equal(refused.ok, false);
  // the delivery shaper (responses.mjs compactDelivery) keeps continuation: the fix call is it when the refusal names none
  const fixCall = refused.fixCall ?? refused.continuation;
  assert.deepEqual(fixCall.arguments, { fix: 'apply', basedOn: refused.nextBasedOn, module: 'Orders', feature: 'F', owners: ['SaveOrder'], changes: ['c'] });
  replies.push({ ok: true, merged: true, strictlyEqual: true });
  const fixed = await call(fixCall.tool, fixCall.arguments);
  assert.equal(fixed.result, 'delivered', JSON.stringify(fixed));
  if (fixed.fixesApplied) assert.deepEqual(fixed.fixesApplied, [{ code: 'TEXT_TOO_LONG', pointer: '/ops/0/value', ops: 1 }]);
  assert.equal(seen.length, 2); assert.equal(seen[1].job.ops[0].value, 'short');
  assert.equal(seen[1].args.fix, undefined, 'fix never travels to the ODC server');
  // through ssam_code write on odc: owners and changes from the refused job when not given
  replies.push({ ok: true, merged: true, strictlyEqual: true });
  const coded = await call('ssam_code', { lane: 'odc', action: 'write', module: 'Orders', fix: 'apply', basedOn: refused.nextBasedOn, feature: 'F', owners: ['SaveOrder'], changes: ['c'] });
  assert.equal(coded.result, 'delivered', JSON.stringify(coded));
  assert.equal(seen[2].job.ops[0].value, 'short');
  // a proposed patch that does not apply: refused before the relay, with the ones that do
  replies.push({ ok: false, code: 'PREFLIGHT_REFUSED', error: 'every phase', problems: [PROBLEM, { ...PROBLEM, code: 'OTHER', pointer: '/ops/7', patch: [{ op: 'remove', path: '/ops/7' }] }] });
  const again = await call('studio_deliver', { feature: 'F', module: 'Orders', owners: ['SaveOrder'], changes: ['c'], job: JOB });
  const notApplied = await call('studio_deliver', (again.fixCall ?? again.continuation).arguments);
  assert.equal(notApplied.code, 'FIX_NOT_APPLIED'); assert.deepEqual(notApplied.problems.map(n => [n.phase, n.code]), [['fix', 'OTHER']]);
  assert.deepEqual(notApplied.continuation.arguments.patch, [{ op: 'replace', path: '/ops/0/value', value: 'short' }, '<your fix of each one in notApplied>']);
  assert.equal(seen.length, 4);
  const none = await call('studio_deliver', { feature: 'F', module: 'Orders', owners: ['SaveOrder'], changes: ['c'], fix: 'apply' });
  assert.equal(none.code, 'FIX_NEEDS_BASE');
});
