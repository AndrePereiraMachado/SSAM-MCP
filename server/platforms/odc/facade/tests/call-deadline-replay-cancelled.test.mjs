import './fixtures/isolated-profile.mjs';
// Round 3c (re-review M1, Integradora, 2026-10-18): Esc before the deadline on a delivery that still ends ok, then the
// identical repeat: one delivery, also when the deadline cannot read the job as it came. CX12 delivered such a cancelled
// definitive answer once; the round 3 content check must keep that:
//  - the deadline's inputs resolve the paths a tool reads exactly as the tool resolves them (studio_deliver: job and a
//    patch's basedOn.job relative to the ODC lane root), so a relative job is read and joined or replayed by its content;
//  - the seam for a hosted gate: createReplay({resolve}) maps the arguments as the gate does (ws: to the workspace), and
//    the served handler keeps the applied answer of a cancelled call too, decided on the content after the gate.
// Times are scaled: the server's deadline (200 ms) stands for the 25 s of CALL_DEADLINE_MS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import * as store from '../replay-store.mjs';
import { createCallDeadline, markRunsToEnd } from '../call-deadline.mjs';
import { runsToEnd } from '../tool-classification.mjs';
import { keepAnswer } from '../answer-size.mjs';
import { tasksDir } from '../ssam-task.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const value = result => result?.structuredContent ?? JSON.parse(result.content[0].text);
const DEADLINE = 200;
const sandbox = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cancelled-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const deliverSchema = z.object({ feature: z.string(), module: z.string(), job: z.string(), owners: z.array(z.string()), changes: z.array(z.string()) }).strict();

// A served studio_deliver that reads its job relative to the ODC lane root, as the real one does; the first run ignores the
// cancellation and ends ok (its merge was done).
async function local(t) {
  const root = sandbox(t), odcRoot = path.join(root, 'odc');
  fs.mkdirSync(path.join(odcRoot, 'jobs'), { recursive: true });
  const srv = await createSsamServer({ o11: false, odc: false, deps: { answersRoot: root, odcRoot, callDeadlineMs: DEADLINE,
    identity: { read: () => ({ root, release: { head: 'a', facadeSha256: 'a', catalogSha256: 'a' } }) }, writeLock: async (_, fn) => fn() } });
  const runs = [];
  let release = () => {}, began = () => {};
  srv.registerTool('studio_deliver', { inputSchema: deliverSchema }, async args => {
    const job = JSON.parse(fs.readFileSync(path.resolve(odcRoot, args.job), 'utf8'));
    runs.push(job.ops[0]); began();
    if (runs.length === 1) await new Promise(resolve => { release = resolve; });
    else await sleep(DEADLINE * 2);
    return reply({ ok: true, result: 'delivered', job: job.ops[0], run: runs.length });
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'replay-cancelled', version: '1' });
  await Promise.all([srv.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await srv.close(); });
  const write = ops => fs.writeFileSync(path.join(odcRoot, 'jobs', 'orders.json'), JSON.stringify({ ops }));
  return { runs, write, call: (args, options) => client.callTool({ name: 'studio_deliver', arguments: args }, options).then(value),
    started: () => new Promise(resolve => { began = resolve; }), release: () => release() };
}

test('M1 local: a relative studio_deliver job, Esc before 25 s, the delivery ends ok: the identical repeat gets its answer, one delivery; a rewritten job runs', async t => {
  const h = await local(t);
  const args = { feature: 'f', module: 'Orders', job: 'jobs/orders.json', owners: ['Orders'], changes: ['c'] };
  h.write(['v1']);
  const controller = new AbortController(), started = h.started();
  const pending = h.call(args, { signal: controller.signal }).then(() => null, error => error);
  await started; controller.abort('Esc'); await pending; h.release();
  await sleep(100);
  const repeat = await h.call(args);
  assert.deepEqual(h.runs, ['v1'], 'one delivery of the same job'); assert.equal(repeat.job, 'v1');
  h.write(['v2']); // a new job in the same file: another call
  assert.equal((await h.call(args)).job, 'v2');
  assert.deepEqual(h.runs, ['v1', 'v2']);
});

test('M1 local: a repeat while a relative studio_deliver job runs joins it by its content (read under the ODC lane root)', async t => {
  const h = await local(t);
  const args = { feature: 'f', module: 'Orders', job: 'jobs/orders.json', owners: ['Orders'], changes: ['c'] };
  h.write(['v1']);
  const started = h.started();
  const first = h.call(args);
  await started; await sleep(DEADLINE * 1.5);
  const joinedCall = h.call(args);
  await sleep(50); h.release();
  const joined = await joinedCall; await first;
  assert.equal(joined.joined, true, JSON.stringify(joined)); assert.deepEqual(h.runs, ['v1']);
});

test('M1 hosted seam: createReplay({resolve}) reads the arguments as the gate resolves them, and the served handler keeps a cancelled applied answer', async t => {
  assert.equal(typeof store.resolveRelativePaths, 'function');
  const root = sandbox(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'o11', 'jobs'), { recursive: true });
  const file = path.join(workspace, 'o11', 'jobs', 'orders.json');
  const gate = raw => ({ ...raw, job: raw.job.replace(/^ws:/, workspace.replace(/\\/g, '/') + '/') }); // ws: to the workspace
  for (const seam of ['resolve', 'none']) {
    // resolve: the seam the hosted line wires; none: the deadline sees ws: raw, the served handler decides after the gate
    const replays = store.createReplay({ folder: tasksDir(root), ...(seam === 'resolve' ? { resolve: (name, args) => gate(args) } : {}) });
    let runs = 0, release, began;
    const served = async raw => {
      const args = gate(raw);
      if (runsToEnd('o11_deliver', args)) { markRunsToEnd(); replays.outerPrints('o11_deliver', args); }
      const replay = replays.start('o11_deliver', args);
      if (replay?.hit) return replay.hit;
      const job = JSON.parse(fs.readFileSync(args.job, 'utf8'));
      runs++; began?.();
      if (runs === 1) await new Promise(resolve => { release = resolve; });
      const final = reply({ ok: true, result: 'delivered', job: job.ops[0] });
      replays.keep(replay, final, answer => keepAnswer(answer, root));
      return final;
    };
    const deadline = createCallDeadline({ root: path.join(root, seam), timeoutMs: DEADLINE, inputsOf: replays.inputsOf });
    const run = deadline.wrap('o11_deliver', served);
    const args = { module: 'Orders' + seam, job: 'ws:o11/jobs/orders.json' };
    if (seam === 'resolve') assert.match(String(replays.inputsOf('o11_deliver', args)?.print), /^[0-9a-f]{64}$/, 'the deadline reads the job the gate resolves');
    else assert.equal(replays.inputsOf('o11_deliver', args)?.print, null);
    fs.writeFileSync(file, JSON.stringify({ ops: ['X'] }));
    const controller = new AbortController(), started = new Promise(resolve => { began = resolve; });
    const pending = run(args, { mcpReq: { signal: controller.signal } }).then(() => null, error => error);
    await started; controller.abort('Esc'); await pending; release();
    await sleep(50);
    const repeat = value(await run(args, { mcpReq: { signal: new AbortController().signal } }));
    assert.equal(runs, 1, seam + ': one delivery of the same job'); assert.equal(repeat.job, 'X');
    fs.writeFileSync(file, JSON.stringify({ ops: ['Y'] }));
    assert.equal(value(await run(args, { mcpReq: { signal: new AbortController().signal } })).job, 'Y'); assert.equal(runs, 2, seam);
  }
  // the helper the local product uses: a relative path of the listed fields, under a root; absolute paths and schemes stay
  const resolved = store.resolveRelativePaths({ job: 'jobs/a.json', basedOn: { job: 'jobs/b.json', sha256: 'x' }, output: 'lab/out' }, root, ['job', 'basedOn.job']);
  assert.deepEqual(resolved, { job: path.resolve(root, 'jobs/a.json'), basedOn: { job: path.resolve(root, 'jobs/b.json'), sha256: 'x' }, output: 'lab/out' });
  assert.deepEqual(store.resolveRelativePaths({ job: 'agent:inbox/a.json' }, root, ['job']), { job: 'agent:inbox/a.json' });
});
