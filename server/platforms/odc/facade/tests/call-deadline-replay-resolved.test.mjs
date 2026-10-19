import './fixtures/isolated-profile.mjs';
// Review round 3, A1 after the gate (Integradora, 2026-10-18): the replay decides AFTER the paths are resolved, on the sha256
// of every file the call reads. On the hosted server the deadline wraps the gate: it sees agent:/ws: (or a path of the agent's
// Windows machine on a Linux server), which it cannot read, while the served handler, after the gate, sees the workspace copy
// it can read. So the served handler takes its own print whenever its arguments are not the ones the deadline saw, and one
// helper (replay-store.mjs createReplay) is the replay of a server: ssam.mjs and the hosted served handler use the same one.
// A path this server cannot read for sure gives no print (no replay, only the live join): relative (also a bare file name),
// agent:, ws:, file:, and a path of the other system. Times are scaled: the deadline (100 ms) stands for the 25 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../replay-store.mjs';
import { createCallDeadline, markRunsToEnd } from '../call-deadline.mjs';
import { runsToEnd } from '../tool-classification.mjs';
import { keepAnswer } from '../answer-size.mjs';
import { tasksDir } from '../ssam-task.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const value = result => result?.structuredContent ?? JSON.parse(result.content[0].text);
const ctx = () => ({ mcpReq: { signal: new AbortController().signal } });
const DEADLINE = 100, KEPT = 300;
const sandbox = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-resolved-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

test('A1: a path this server cannot read for sure gives no print: a bare relative file name, a path of the other system', t => {
  const root = sandbox(t);
  const job = path.join(root, 'job.json');
  fs.writeFileSync(job, '{"ops":[]}');
  const print = (args, options) => store.replayPrint(store.replaySlot('o11_deliver', args), options);
  assert.match(String(print({ module: 'Orders', job })), /^[0-9a-f]{64}$/, 'an absolute file of this system: its content');
  // relative to a root this server does not resolve here (studio_deliver: relative to the SSAM-Hybrid-ODC root)
  assert.equal(print({ module: 'Orders', job: 'orders.json' }), null, 'a bare file name');
  assert.equal(print({ module: 'Orders', job: 'jobs\\orders.json' }), null);
  // a Linux server (the hosted one) never reads a path of the agent's Windows machine
  assert.equal(print({ module: 'Orders', job: 'C:\\SSAM-Agent\\inbox\\job.json' }, { platform: 'linux' }), null);
  assert.equal(print({ module: 'Orders', job: '\\\\host\\share\\job.json' }, { platform: 'linux' }), null);
  // names that are no file stay arguments
  assert.match(String(print({ module: 'Orders.Core', feature: 'v1.2', name: 'Synthetic App' })), /^[0-9a-f]{64}$/);
});

test('A1 hosted: the served handler decides after the gate; two sessions of one token replay only the same content', async t => {
  assert.equal(typeof store.createReplay, 'function', 'one replay helper for every served handler');
  const root = sandbox(t);
  const inbox = path.join(root, 'workspace', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, 'job.json');
  const replays = store.createReplay({ folder: tasksDir(root) });
  const runs = [];
  // the hosted shape: the deadline wraps the gate, which resolves agent: to the workspace copy, then the served handler
  const served = async raw => {
    const args = { ...raw, job: path.join(inbox, raw.job.replace(/^agent:inbox\//, '')) };
    if (runsToEnd('o11_deliver', args)) { markRunsToEnd(); replays.outerPrints('o11_deliver', args); }
    const replay = replays.start('o11_deliver', args);
    if (replay?.hit) return replay.hit;
    const job = JSON.parse(fs.readFileSync(args.job, 'utf8'));
    await sleep(KEPT);
    runs.push(job.ops[0]);
    const final = reply({ ok: true, result: 'delivered', job: job.ops[0] });
    replays.keep(replay, final, answer => keepAnswer(answer, root));
    return final;
  };
  // two MCP sessions of one token: two deadlines on one task folder (CT-2)
  const session = () => createCallDeadline({ root, timeoutMs: DEADLINE, inputsOf: replays.inputsOf }).wrap('o11_deliver', served);
  const [a, b] = [session(), session()];
  const args = { module: 'Orders', job: 'agent:inbox/job.json' };
  fs.writeFileSync(file, JSON.stringify({ ops: ['X'] }));
  assert.equal(value(await a(args, ctx())).job, 'X');
  const same = value(await b(args, ctx()));
  assert.equal(same.job, 'X'); assert.match(String(same.resumedFrom), /^[0-9a-f-]{36}$/, 'the same content after the gate: the kept answer');
  fs.writeFileSync(file, JSON.stringify({ ops: ['Y'] })); // the other session writes its own job under the same name
  const other = value(await b(args, ctx()));
  assert.equal(other.job, 'Y'); assert.equal(other.resumedFrom, undefined);
  assert.deepEqual(runs, ['X', 'Y'], 'each content ran once');
});

test('Round 3b (2) hosted: a gate that resolves agent: before the deadline decides joins the same content and refuses another; without it, one refusal', async t => {
  const root = sandbox(t);
  const inbox = path.join(root, 'workspace', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, 'job.json');
  const resolve = raw => ({ ...raw, job: path.join(inbox, raw.job.replace(/^agent:inbox\//, '')) }); // the gate's pull and resolution
  const replays = store.createReplay({ folder: tasksDir(root) });
  let runs = 0;
  const served = async raw => {
    const args = resolve(raw);
    if (runsToEnd('o11_deliver', args)) { markRunsToEnd(); replays.outerPrints('o11_deliver', args); }
    const replay = replays.start('o11_deliver', args);
    if (replay?.hit) return replay.hit;
    const job = JSON.parse(fs.readFileSync(args.job, 'utf8'));
    runs++; await sleep(KEPT);
    const final = reply({ ok: true, result: 'delivered', job: job.ops[0] });
    replays.keep(replay, final, answer => keepAnswer(answer, root));
    return final;
  };
  const args = { module: 'Orders', job: 'agent:inbox/job.json' };
  // the deadline's inputs after the gate's resolution (it may pull the file first: inputsOf may answer a promise)
  const resolved = createCallDeadline({ root, timeoutMs: DEADLINE, inputsOf: async (name, raw) => { await sleep(5); return replays.inputsOf(name, resolve(raw)); } }).wrap('o11_deliver', served);
  fs.writeFileSync(file, JSON.stringify({ ops: ['X'] }));
  const first = resolved(args, ctx());
  await sleep(DEADLINE * 1.5);
  const joined = value(await resolved(args, ctx()));
  assert.equal(joined.joined, true, JSON.stringify(joined)); assert.equal(joined.job, 'X'); assert.match(String(joined.joinedTask), /^[0-9a-f-]{36}$/);
  await first;
  const second = resolved({ ...args, module: 'Next' }, ctx());
  await sleep(DEADLINE * 1.5);
  fs.writeFileSync(file, JSON.stringify({ ops: ['Y'] }));
  const changed = value(await resolved({ ...args, module: 'Next' }, ctx()));
  assert.equal(changed.code, 'DELIVERY_STILL_RUNNING'); assert.match(changed.error, /changed/);
  await second;
  assert.equal(runs, 2, 'the joined and the refused repeats started nothing');
  // without the resolution the deadline cannot compare: one refusal, never a blind join
  const raw = createCallDeadline({ root, timeoutMs: DEADLINE, inputsOf: replays.inputsOf }).wrap('o11_deliver', served);
  const third = raw({ ...args, module: 'Raw' }, ctx());
  await sleep(DEADLINE * 1.5);
  const refused = value(await raw({ ...args, module: 'Raw' }, ctx()));
  assert.equal(refused.code, 'DELIVERY_STILL_RUNNING'); assert.match(refused.error, /cannot read/); assert.equal(refused.joined, undefined);
  assert.deepEqual(refused.stop?.arguments, { id: refused.task.id, stop: true });
  await third;
  assert.equal(runs, 3);
});
