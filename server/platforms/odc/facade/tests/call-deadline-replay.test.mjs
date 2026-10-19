import './fixtures/isolated-profile.mjs';
// The replay of an unconfirmed final answer (Integradora, 2026-10-18, rounds 2 and 3). No MCP answer is acknowledged, so the
// final answer of a run-to-end call kept past the deadline counts as not delivered: an identical call within the CX12 window
// (10 minutes) gets it (resumedFrom), never a second run. Round 3: the served handler decides, after the arguments are
// resolved, on the normalized arguments (a default written or not is the same call) and the sha256 of every file the call
// reads; a path it cannot read for sure (relative, agent:, ws:) turns the replay off for that call, leaving only the live
// join. Any write ends the replays of its subject (all of them without one). The window lives in the task folder and
// survives a restart. A refusal that applied nothing, or an answer without an explicit ok, is never replayed. A live
// delivery is joined only with the same inputs: other content is one refusal that names the running task, how to wait and
// how to stop it. Times are scaled: the server's deadline (200 ms) stands for the 25 s of CALL_DEADLINE_MS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { REPLAY_WINDOW_MS } from '../replay-store.mjs';
import { findCallTask, tasksDir } from '../ssam-task.mjs';
import { canonicalArguments } from '../read-budget.mjs';
import { SESSION_RULES, serverInstructions } from '../server-instructions.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const value = result => result?.structuredContent ?? JSON.parse(result.content[0].text);
const DEADLINE = 200, KEPT = 600;
const sandbox = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-to-end-replay-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const identity = root => ({ read: () => ({ root, release: { head: 'a', facadeSha256: 'a', catalogSha256: 'a' } }) });

// The ssam server with synthetic tools of the family and around it; every tool counts its runs per arguments and reads the
// job file it names, as a delivery does.
async function server(t, root, { replayWindowMs, answer } = {}) {
  const runs = new Map();
  // counted by the arguments the tool runs, the default of until left out (written or not, one call)
  const keyOf = (name, args) => name + ' ' + JSON.stringify(Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'until')));
  const count = (name, args) => { const key = keyOf(name, args); runs.set(key, (runs.get(key) ?? 0) + 1); return runs.get(key); };
  const srv = await createSsamServer({ o11: false, odc: false, deps: { answersRoot: root, callDeadlineMs: DEADLINE, identity: identity(root),
    writeLock: async (_, fn) => fn(), ...(replayWindowMs ? { replayWindowMs } : {}) } });
  const work = (name, ms = KEPT) => async args => {
    const job = typeof args.job === 'string' && path.isAbsolute(args.job) ? fs.readFileSync(args.job, 'utf8') : null;
    const n = count(name, args);
    await sleep(ms);
    return reply(answer ? answer(name, args) : { ok: true, result: 'delivered', runs: n, ...(job ? { job } : {}) });
  };
  srv.registerTool('o11_deliver', { inputSchema: z.object({ module: z.string(), job: z.string().optional(), until: z.enum(['merge', 'apply']).default('merge'), publish: z.boolean().optional() }).strict() }, work('o11_deliver'));
  srv.registerTool('o11_publish', { inputSchema: z.object({ module: z.string() }).strict() }, work('o11_publish'));
  // a write outside any delivery that names no subject (the shape of o11_access apply, which this server already serves)
  srv.registerTool('synthetic_roles', { inputSchema: z.object({ action: z.string(), manifestPath: z.string() }).strict() }, work('synthetic_roles', 10));
  srv.registerTool('odc_deploy', { inputSchema: z.object({ assetKey: z.string(), environmentKey: z.string(), operation: z.string().optional() }).strict() }, work('odc_deploy'));
  srv.registerTool('odc_configurations', { inputSchema: z.object({ action: z.string(), assetKey: z.string(), environmentKey: z.string(), settings: z.record(z.string(), z.string()) }).strict() }, work('odc_configurations', 10));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'runs-to-end-replay', version: '1' });
  await Promise.all([srv.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await srv.close(); });
  const call = async (name, args, options) => value(await client.callTool({ name, arguments: args }, options));
  return { srv, client, clientSide: b, call, runs: (name, args) => runs.get(keyOf(name, args)) ?? 0, total: name => [...runs].filter(([k]) => k.startsWith(name + ' ')).reduce((s, [, n]) => s + n, 0) };
}

test('the replay window is the CX12 10 minutes', () => assert.equal(REPLAY_WINDOW_MS, 600000));

test('a client timeout that sends no cancellation, then the identical call after the end: the kept answer, one run', async t => {
  const h = await server(t, sandbox(t));
  const sent = [], send = h.clientSide.send.bind(h.clientSide);
  h.clientSide.send = async (message, options) => { if (message.method === 'notifications/cancelled') return; sent.push(message); return send(message, options); };
  const gaveUp = await h.client.callTool({ name: 'o11_deliver', arguments: { module: 'Orders' } }, { timeout: 300 }).then(() => null, error => error);
  assert.match(String(gaveUp?.message), /timed out/i);
  await sleep(KEPT);
  const repeat = await h.call('o11_deliver', { module: 'Orders' });
  assert.equal(repeat.ok, true); assert.equal(repeat.runs, 1); assert.match(String(repeat.resumedFrom), /^[0-9a-f-]{36}$/);
  assert.equal(h.total('o11_deliver'), 1);
});

test('B1: a default written or not is the same call, finished (replay) and live (join)', async t => {
  const h = await server(t, sandbox(t));
  await h.call('o11_deliver', { module: 'Orders' });
  const written = await h.call('o11_deliver', { module: 'Orders', until: 'merge' });
  assert.ok(written.resumedFrom, JSON.stringify(written)); assert.equal(h.total('o11_deliver'), 1);
  const live = h.call('o11_deliver', { module: 'Live' });
  await sleep(DEADLINE * 1.5);
  const joined = await h.call('o11_deliver', { module: 'Live', until: 'merge' });
  await live;
  assert.equal(joined.joined, true, JSON.stringify(joined)); assert.equal(h.runs('o11_deliver', { module: 'Live' }), 1);
});

test('A1: a job file rewritten under the same name is a new call; the same content is the same call, in another session too', async t => {
  const root = sandbox(t);
  const job = path.join(root, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ ops: ['v1'] }));
  const one = await server(t, root), two = await server(t, root); // two MCP sessions of one token: one task folder
  assert.equal((await one.call('o11_deliver', { module: 'Orders', job })).job, JSON.stringify({ ops: ['v1'] }));
  const same = await two.call('o11_deliver', { module: 'Orders', job });
  assert.ok(same.resumedFrom, 'the other session, the same content: the kept answer');
  fs.writeFileSync(job, JSON.stringify({ ops: ['v2'] })); // same size and maybe the same time: only the content tells
  const fresh = await two.call('o11_deliver', { module: 'Orders', job });
  assert.equal(fresh.resumedFrom, undefined); assert.equal(fresh.job, JSON.stringify({ ops: ['v2'] }));
  assert.equal(one.total('o11_deliver') + two.total('o11_deliver'), 2);
});

test('A1: a path the server cannot read for sure (relative, agent:, ws:) turns the replay off: the call runs again', async t => {
  const h = await server(t, sandbox(t));
  for (const job of ['jobs/orders.json', 'agent:inbox/job.json', 'ws:o11/jobs/orders.json']) {
    await h.call('o11_deliver', { module: 'Orders', job });
    const again = await h.call('o11_deliver', { module: 'Orders', job });
    assert.equal(again.resumedFrom, undefined, job); assert.equal(h.runs('o11_deliver', { module: 'Orders', job }), 2, job);
  }
});

test('A2: any write ends the replays of its subject, all of them when it names none', async t => {
  const h = await server(t, sandbox(t));
  // (a publication or a deployment keeps no replay at all since round 3b: call-deadline-replay-live-state.test.mjs)
  // a write that names no subject (as o11_access apply, which delivers roles into the owner modules) ends every replay
  await h.call('o11_deliver', { module: 'Orders' });
  await h.call('synthetic_roles', { action: 'apply', manifestPath: 'C:/synthetic/manifest.json' });
  assert.equal((await h.call('o11_deliver', { module: 'Orders' })).resumedFrom, undefined);
  assert.equal(h.runs('o11_deliver', { module: 'Orders' }), 2);
  // a write that names the same subject ends its replay
  await h.call('o11_deliver', { module: 'App1' });
  await h.call('odc_configurations', { action: 'set', assetKey: 'App1', environmentKey: 'stage-1', settings: { Flag: 'on' } });
  assert.equal((await h.call('o11_deliver', { module: 'App1' })).resumedFrom, undefined);
  assert.equal(h.runs('o11_deliver', { module: 'App1' }), 2);
  // a write on another subject leaves the replay of a delivery
  await h.call('o11_deliver', { module: 'Invoices' });
  await h.call('odc_configurations', { action: 'set', assetKey: 'app-2', environmentKey: 'stage-1', settings: { Flag: 'off' } });
  assert.ok((await h.call('o11_deliver', { module: 'Invoices' })).resumedFrom);
  assert.equal(h.runs('o11_deliver', { module: 'Invoices' }), 1);
});

test('A4: the window is in the task record; after a restart the call is reserved and its identical repeat gets the kept answer', async t => {
  const root = sandbox(t);
  const before = await server(t, root);
  await before.call('o11_deliver', { module: 'Orders' });
  const hash = createHash('sha256').update(canonicalArguments({ module: 'Orders' })).digest('hex');
  const record = findCallTask(tasksDir(root), 'o11_deliver', hash);
  assert.ok(record, 'the task record reserves the call for its window');
  assert.ok(Date.parse(record.replayUntil) > Date.now());
  const after = await server(t, root); // a new server on the same folder: nothing in memory carries the replay
  const again = await after.call('o11_deliver', { module: 'Orders' });
  assert.equal(again.resumedFrom, record.id); assert.equal(after.total('o11_deliver'), 0);
});

test('B2: a replay ends with its window and leaves nothing behind', async t => {
  const root = sandbox(t);
  const h = await server(t, root, { replayWindowMs: KEPT });
  await h.call('o11_deliver', { module: 'Orders' });
  const replays = path.join(tasksDir(root), '.replays');
  assert.equal(fs.readdirSync(replays).length, 1);
  await sleep(KEPT * 1.5);
  assert.equal((await h.call('o11_deliver', { module: 'Orders' })).resumedFrom, undefined);
  assert.equal(h.runs('o11_deliver', { module: 'Orders' }), 2);
  await sleep(KEPT * 1.5);
  await h.call('o11_deliver', { module: 'Other' }); // any later write sweeps the expired ones; its own replay stays
  assert.equal(fs.readdirSync(replays).length, 1);
});

test('B3 and refusals: an answer without an explicit ok, or a refusal that applied nothing, is never replayed; a delivery whose publication failed is', async t => {
  const answers = { NoOk: { result: 'delivered' }, Refused: { ok: false, code: 'VALIDATION_REFUSED' }, Partial: { ok: false, result: 'delivered', failed: 'publish', code: 'PUBLISH_FAILED' } };
  const h = await server(t, sandbox(t), { answer: (_, args) => answers[args.module] });
  for (const module of ['NoOk', 'Refused']) {
    await h.call('o11_deliver', { module }); await h.call('o11_deliver', { module });
    assert.equal(h.runs('o11_deliver', { module }), 2, module);
  }
  await h.call('o11_deliver', { module: 'Partial', publish: true });
  assert.ok((await h.call('o11_deliver', { module: 'Partial', publish: true })).resumedFrom);
  assert.equal(h.runs('o11_deliver', { module: 'Partial', publish: true }), 1, 'never a second delivery');
});

test('B4 and A5: joining a live delivery checks what it reads; other content is one refusal naming the task, how to wait and how to stop', async t => {
  const root = sandbox(t);
  const job = path.join(root, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ ops: ['v1'] }));
  const h = await server(t, root);
  const first = h.call('o11_deliver', { module: 'Orders', job });
  await sleep(DEADLINE * 1.5);
  const joined = await h.call('o11_deliver', { module: 'Orders', job });
  assert.equal(joined.joined, true); assert.match(String(joined.joinedTask), /^[0-9a-f-]{36}$/, 'a repeat that joins names the task');
  const live = h.call('o11_deliver', { module: 'Next', job });
  await sleep(DEADLINE * 1.5);
  fs.writeFileSync(job, JSON.stringify({ ops: ['v2'] }));
  const refused = await h.call('o11_deliver', { module: 'Next', job });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'DELIVERY_STILL_RUNNING'); assert.equal(refused.outcome, 'not-sent');
  assert.equal(refused.task?.tool, 'o11_deliver'); assert.match(String(refused.task?.id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(refused.continuation?.arguments, { continueTask: refused.task.id });
  assert.deepEqual(refused.stop?.arguments, { id: refused.task.id, stop: true });
  await first; await live;
  assert.equal(h.runs('o11_deliver', { module: 'Next', job }), 1);
  // the session rules say how to list and how to stop a delivery that answers only when it ends (A5), on each profile
  // Round 3c (re-review M2): the rule never tells the model to send a delivery again after a timeout
  assert.match(SESSION_RULES.find(r => r.id === 'long-calls').text, /on timeout the same call returns it/); assert.doesNotMatch(SESSION_RULES.find(r => r.id === 'long-calls').text, /repeat/);
  assert.match(SESSION_RULES.find(r => r.id === 'stop').text, /^ssam_task lists; \{id,stop:true\} stops a delivery\.$/);
  assert.match(SESSION_RULES.find(r => r.id === 'stop-debug').text, /^ssam_doctor lists running calls; \{task:\{id,stop:true\}\} stops one\.$/);
  // B5: o11_publish answers when the publication ends; its text no longer sends the model to continueTask
  const publish = fs.readFileSync(new URL('../o11-publish.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(publish, /continueTask waits/); assert.match(publish, /answers when (?:it|the publication) ends/);
});

test('B6: every profile serves the rules it served before the change, within 2000 characters and at least 5 to spare', () => {
  // the rules the instruction of each profile carried at e90d08b2, plus the stop rule of round 3 (A5)
  const served = { app: ['tools', 'deferred', 'connect', 'discover', 'deliver', 'refusal', 'queue', 'long-calls', 'stop', 'authorize', 'links', 'data', 'detail', 'identity'],
    debug: ['tools', 'long-calls', 'stop-debug', 'authorize', 'data', 'debug'] };
  for (const [profile, ids] of Object.entries(served)) {
    const text = serverInstructions({ profile });
    assert.ok(text.length <= 1995, profile + ': ' + text.length + ' characters');
    for (const id of ids) assert.ok(text.includes(SESSION_RULES.find(r => r.id === id).text), profile + ' serves ' + id);
  }
});

test('Round 3b (2): a repeat while a delivery runs whose job this server cannot read (relative, agent:) never joins blindly: one refusal that names the task, how to wait and how to stop', async t => {
  const h = await server(t, sandbox(t));
  for (const job of ['jobs/orders.json', 'agent:inbox/job.json']) {
    const args = { module: 'Orders', job };
    const first = h.call('o11_deliver', args);
    await sleep(DEADLINE * 1.5);
    const refused = await h.call('o11_deliver', args);
    assert.equal(refused.ok, false, JSON.stringify(refused)); assert.equal(refused.code, 'DELIVERY_STILL_RUNNING'); assert.equal(refused.outcome, 'not-sent');
    assert.match(refused.error, /cannot read/); assert.equal(refused.joined, undefined);
    assert.equal(refused.task?.tool, 'o11_deliver'); assert.match(String(refused.task?.id), /^[0-9a-f-]{36}$/);
    assert.deepEqual(refused.wait, { tool: 'ssam_task', arguments: { id: refused.task.id }, why: refused.wait?.why });
    assert.deepEqual(refused.stop?.arguments, { id: refused.task.id, stop: true });
    assert.deepEqual(refused.continuation?.arguments, { continueTask: refused.task.id });
    // Round 3c (re-review M2): after its end the answer is read from the task, never by sending the same job again
    assert.doesNotMatch(refused.error, /send the call again/); assert.match(refused.error, /ssam_task \{id\}/); assert.match(refused.error, /Never send the same job again/);
    assert.equal((await first).ok, true);
    let final = refused;
    for (let i = 0; i < 20 && (final.code === 'DELIVERY_STILL_RUNNING' || final.state === 'running'); i++) final = await h.call(refused.continuation.tool, refused.continuation.arguments);
    assert.equal(final.ok, true, JSON.stringify(final)); assert.equal(final.result, 'delivered');
    assert.equal(h.runs('o11_deliver', args), 1, job + ': the refused repeat started nothing');
  }
});

test('Round 3d (re-review B1, the cause only): a job too large to look at whole is refused naming that cause, not a path it does not have', async t => {
  const root = sandbox(t);
  const job = path.join(root, 'big-data.json'); // a data load: more strings than the print looks at
  fs.writeFileSync(job, JSON.stringify({ ops: Array.from({ length: 7000 }, (_, i) => ({ op: 'row', entity: 'Orders', values: { Name: 'n' + i, Code: 'c' + i } })) }));
  const h = await server(t, root);
  const first = h.call('o11_deliver', { module: 'Orders', job });
  await sleep(DEADLINE * 1.5);
  const refused = await h.call('o11_deliver', { module: 'Orders', job });
  await first;
  assert.equal(refused.code, 'DELIVERY_STILL_RUNNING', JSON.stringify(refused).slice(0, 300));
  assert.match(refused.error, /too large/); assert.doesNotMatch(refused.error, /relative path/);
  assert.equal(h.runs('o11_deliver', { module: 'Orders', job }), 1);
});
