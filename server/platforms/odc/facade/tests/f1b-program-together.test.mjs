// F1b (owner 2026-11-02, verbatim: "o ssam deve permitir que o usuario programe junto com ele.. ele deve ser capaz de fazer o
// merge e é isso"): SSAM never stops because the person changed something in the Studio while it delivered. Each test has
// the "person" change the module between the capture and the write; at 069d4fc1 each one was a refusal, now the delivery
// merges over the module as it is (the same call), with a note. Fakes and temporary folders only: no Studio, no CLI.
//   stop 3: BASE_DRIFT (the open module changed after the capture) on ODC.
//   stop 4: the Studio busy at the merge (BRIDGE_BUSY, nothing sent) on ODC.
//   stop 5: a producer published again / its references refreshed between the capture and the merge (PRODUCER_CHANGED), ODC and O11.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as phase from '../odc-build-phase.mjs';
import { registerO11Cycle, deliverOutcome } from '../o11-cycle.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const DELIVERED = { ok: true, result: 'delivered', merged: true, strictlyEqual: true, steps: [{ step: 'build' }, { step: 'merge' }] };
const noSleep = async () => {};
// A studio_deliver whose answers come in order; asked keeps the arguments of each run.
const odc = answers => { const asked = []; return { asked, deliver: async args => { asked.push(args); return answers[asked.length - 1]; } }; };
const rules = value => (Array.isArray(value.normalizations) ? value.normalizations : value.normalizations?.items ?? []).map(n => n.rule);

test('F1b stop 3 (ODC): the person edits the open module twice during the delivery; each BASE_DRIFT is captured again and merged over, with a note', async () => {
  const drift = { ok: false, code: 'BASE_DRIFT', failed: 'merge', merged: false, continuation: { tool: 'studio_deliver', arguments: {} } };
  const { asked, deliver } = odc([drift, drift, DELIVERED]);
  const value = await phase.phasedDeliver({ module: 'App', feature: 'f', job: 'j.json', output: 'lab-1' }, {}, { deliver, sleep: noSleep });
  assert.equal(value.result, 'delivered', JSON.stringify(value));
  assert.equal(asked.length, 3);
  assert.ok(asked.slice(1).every(a => a.output === undefined), 'each redo takes a new evidence folder (a new capture)');
  assert.deepEqual(rules(value), ['BASE_DRIFT', 'BASE_DRIFT']);
  assert.match(value.normalizations[0].note, /captured the module again, with that edit/);
});

test('F1b stop 4 (ODC): the Studio busy when the merge is sent (nothing sent) waits and goes again, with a note', async () => {
  const busy = { ok: false, code: 'BRIDGE_BUSY', failed: 'merge', outcome: 'not-sent', merged: false };
  const slept = [];
  const { asked, deliver } = odc([busy, DELIVERED]);
  const value = await phase.phasedDeliver({ module: 'App', feature: 'f', job: 'j.json' }, {}, { deliver, sleep: async ms => { slept.push(ms); } });
  assert.equal(value.result, 'delivered', JSON.stringify(value));
  assert.equal(asked.length, 2);
  assert.equal(slept.length, 1);
  assert.deepEqual(rules(value), ['STUDIO_BUSY']);
});

test('F1b stop 5 (ODC): a producer that changed between the capture and the merge is built again on the version acquired, with a note', async () => {
  const changed = { ok: false, code: 'PRODUCER_CHANGED', failed: 'reference-snapshot', merged: false,
    continuation: { tool: 'studio_deliver', arguments: { feature: 'f', module: 'App', job: 'j.json', owners: ['o'], changes: ['c'], producers: { Kept: 'C:\\kept.avsig' } } } };
  const { asked, deliver } = odc([changed, DELIVERED]);
  const value = await phase.phasedDeliver({ module: 'App', feature: 'f', job: 'j.json', owners: ['o'], changes: ['c'], producers: { Kept: 'C:\\kept.avsig', Stale: 'C:\\stale.avsig' } }, {}, { deliver, sleep: noSleep });
  assert.equal(value.result, 'delivered', JSON.stringify(value));
  assert.deepEqual(asked[1].producers, { Kept: 'C:\\kept.avsig' }, 'the stale bound capture is dropped, as the refusal said');
  assert.deepEqual(rules(value), ['PRODUCER_CHANGED']);
});

test('F1b (ODC): what may have written, or what the person must see, is never redone', async () => {
  for (const answer of [
    { ok: false, code: 'MODULE_NOT_AT_BASE', failed: 'merge', merged: null, outcome: 'not-sent' },   // a cut merge may be in the module
    { ok: false, code: 'MERGE_CONFLICT', failed: 'merge' },                          // merged not proven false: never redone
    { ok: false, code: 'MERGE_CONFLICT', failed: 'merge', merged: false, afterCut: true },
    { ok: false, code: 'BASE_DRIFT', failed: 'merge', merged: false, afterCut: true },
    { ok: false, code: 'BASE_DRIFT', failed: 'merge', merged: false, continuation: { tool: 'studio_publish', arguments: { reconcile: true } } },
    { ok: false, code: 'BRIDGE_BUSY', failed: 'merge', outcome: 'incomplete', merged: true },
    { ok: false, code: 'MERGE_UNCERTAIN', failed: 'merge', outcome: 'uncertain', merged: null },
  ]) {
    const { asked, deliver } = odc([answer, DELIVERED]);
    const value = await phase.phasedDeliver({ module: 'App' }, {}, { deliver, sleep: noSleep });
    assert.equal(asked.length, 1, JSON.stringify(answer));
    assert.equal(value.code, answer.code);
    assert.equal(value.normalizations, undefined);
  }
  // Still drifting after the limit: the last refusal stands, with the notes of the redos.
  const drift = { ok: false, code: 'BASE_DRIFT', failed: 'merge', merged: false };
  const { asked, deliver } = odc([drift, drift, drift, drift, DELIVERED]);
  const value = await phase.phasedDeliver({ module: 'App' }, {}, { deliver, sleep: noSleep });
  assert.equal(asked.length, 4);
  assert.equal(value.code, 'BASE_DRIFT');
  assert.equal(rules(value).length, 3);
});

// ---- O11 (o11_deliver through the MCP server, the kernel faked).
const sha256 = data => createHash('sha256').update(data).digest('hex');
const WORDS = 'sim, pode entregar no Orders';
const TASK = 'abcdabcdabcdabcdabcdabcdabcdabcd';
function o11Box(t, replies) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f1b-program-together-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, port: 45997,
    studioDir: path.join(base, 'Studio'), authorityDir: auth }));
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  const job = path.join(base, 'jobs', 'orders.json');
  fs.mkdirSync(path.dirname(job), { recursive: true });
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'logic', data: { actions: [{ name: 'GetOrders', steps: [] }] } }] }, null, 2));
  const work = path.join(root, '.local', 'work');
  const runAnvil = fakeAnvil({ deliver: () => { const reply = replies.shift(); return typeof reply === 'function' ? reply(work) : reply; } });
  let clock = Date.parse('2026-11-02T03:00:00.000Z');
  const deps = { root, env, lane: 'ss4', now: () => new Date(clock += 1000), runAnvil, lastPublication: async () => null, assertSelected: async () => {},
    grantsFile: path.join(base, 'grants.json') };
  return { job, work, runAnvil, deps };
}
async function o11Serve(t, deps) {
  const server = new McpServer({ name: 'f1b-program-together', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'f1b-program-together-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return args => client.callTool({ name: 'o11_deliver', arguments: { authorize: WORDS, ...args } }).then(r => r.structuredContent ?? JSON.parse(r.content[0].text));
}
// The kernel's PRODUCER_CHANGED: nothing written, the task recorded as a known failure (the kernel writes task.json).
const producerChanged = work => {
  const data = { taskId: TASK, module: 'Orders_CS', writeState: 'not-sent', code: 'PRODUCER_CHANGED', stage: 'producer-attestation', delivered: false,
    error: 'VersionIdChanged: Orders_IS changed since its capture (6773 -> 6774); capture it again', producerAttestationBeforeMerge: [] };
  const dir = path.join(work, 'deliver', TASK); fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ ...data, work: dir, updatedAt: '2026-11-02T03:00:01.000Z' });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
  return { ok: true, command: 'deliver', data };
};
const O11_DELIVERED = { ok: true, command: 'deliver', data: { delivered: true, taskId: 'c0ffee00c0ffee00c0ffee00c0ffee00', writeState: 'applied', validation: { newErrors: 0 } } };

test('F1b stop 5 (O11): a producer published again between the capture and the merge is delivered again in the same call, with a note', async t => {
  const box = o11Box(t, [producerChanged, O11_DELIVERED]);
  const call = await o11Serve(t, box.deps);
  const value = await call({ module: 'Orders_CS', job: box.job });
  assert.equal(value.result, 'delivered', JSON.stringify(value));
  const delivers = box.runAnvil.calls.filter(c => c.args[0] === 'deliver');
  assert.ok(delivers.length >= 2, 'the kernel delivered twice: ' + JSON.stringify(box.runAnvil.calls).slice(0, 400));
  assert.ok(rules(value).includes('PRODUCER_CHANGED'), JSON.stringify(value.normalizations));
});

test('F1b stop 4 (O11): the waits of the kernel for a busy Studio (studioWaits) are said in the delivered answer', () => {
  const note = 'The Studio was busy with other work (its UI thread did not run this step, so nothing of it ran); SSAM waited 2 s and sent the step again.';
  const value = deliverOutcome({ envelope: { ok: true, data: { ...O11_DELIVERED.data, studioWaits: [{ code: 'STUDIO_BUSY', method: 'snapshot_module', attempt: 1, waitedMs: 2000, note }] } } },
    { trackId: 't', work: 'C:\\w', job: 'C:\\jobs\\j.json', input: { module: 'Orders_CS' } });
  assert.equal(value.result, 'delivered', JSON.stringify(value));
  const items = Array.isArray(value.normalizations) ? value.normalizations : value.normalizations?.items ?? [];
  assert.deepEqual(items.map(n => [n.rule, n.at, n.note]), [['STUDIO_BUSY', 'snapshot_module', note]]);
  // Never a note without a wait: the answers of before stay as they were.
  assert.equal(deliverOutcome({ envelope: O11_DELIVERED }, { trackId: 't', work: 'C:\\w' }).normalizations, undefined);
});

// Review F1b (4): the closed attempt's Studio write outside the merge (its Manage Dependencies) is said in the note as what it
// wrote (never an undo the owner would have to click), kept in previousAttempts; a write whose end no run saw stops the redo.
const withWrite = outcome => work => {
  const reply = producerChanged(work);
  reply.data.studioWrites = [{ command: 'Manage Dependencies', stage: 'before-merge', outcome, added: [{ element: 'Orders_IS.GetOrders' }],
    requested: [{ elements: ['Action:Orders_IS.GetOrders'] }], producers: ['Orders_IS'] }];
  return reply;
};
test('F1b review (O11): a Manage Dependencies of the closed attempt is said in the note; one still open stops the redo', async t => {
  const box = o11Box(t, [withWrite('changed'), O11_DELIVERED]);
  const call = await o11Serve(t, box.deps);
  const value = await call({ module: 'Orders_CS', job: box.job });
  assert.equal(value.result, 'delivered', JSON.stringify(value));
  const note = (Array.isArray(value.normalizations) ? value.normalizations : value.normalizations?.items ?? []).find(n => n.rule === 'PRODUCER_CHANGED');
  assert.match(note.note, /Manage Dependencies \(before-merge\) changed the module, adding Orders_IS\.GetOrders/);
  assert.doesNotMatch(note.note, /Ctrl\+Z/);
  assert.equal(value.previousAttempts?.[0]?.taskId, TASK);
  const open = o11Box(t, [withWrite('pending'), O11_DELIVERED]);
  const call2 = await o11Serve(t, open.deps);
  const refused = await call2({ module: 'Orders_CS', job: open.job });
  assert.equal(refused.code, 'PRODUCER_CHANGED', JSON.stringify(refused));
  assert.equal(open.runAnvil.calls.filter(c => c.args[0] === 'deliver').length, 1, 'no new delivery beside a write that may still change the module');
});

// C1 adversarial suite (P1): the person changed the element the delivery writes; the ODC bridge refused MERGE_CONFLICT before
// any merge (merged:false). The delivery is captured again and merged over the person's value: the delivery's value wins.
test('F1b C1 (ODC): MERGE_CONFLICT with nothing merged is captured again and merged over, with a note', async () => {
  const conflict = { ok: false, code: 'MERGE_CONFLICT', failed: 'merge', merged: false, evidence: 'C:\\lab\\1' };
  const { asked, deliver } = odc([conflict, DELIVERED]);
  const value = await phase.phasedDeliver({ module: 'App', feature: 'f', job: 'j.json', output: 'lab-1' }, {}, { deliver, sleep: noSleep });
  assert.equal(value.result, 'delivered', JSON.stringify(value));
  assert.equal(asked.length, 2); assert.equal(asked[1].output, undefined, 'a new capture');
  assert.deepEqual(rules(value), ['MERGE_CONFLICT']);
  assert.match(value.normalizations[0].note, /delivery's value of that element replaced the person's/);
  assert.equal(value.normalizations[0].from, 'C:\\lab\\1');
});