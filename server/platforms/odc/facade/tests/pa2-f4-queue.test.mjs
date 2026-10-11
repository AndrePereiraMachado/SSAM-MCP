// Atritos 2, lane F4, A08: the Studio write queue between processes (studio-write-lock.mjs). The real case (Cardapio,
// 2026-10-06 13:38-13:51): two agents wrote two modules of one Service Studio; the UI got STUDIO_WRITE_BUSY 5 times, the BO
// twice ("uma escrita ja esta rodando neste Studio: espere a resposta dela e repita esta chamada") and polled. Now a write
// waits its turn (first in, first out, across processes) and answers its own result; only a wait that runs out refuses
// (STUDIO_WRITE_QUEUE_TIMEOUT, holder and position); a cancelled wait leaves the queue. Child node processes and
// temporary folders only; no Studio, bridge, port or worker.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { odcRoot } from '../workspace.mjs';
import * as lock from '../studio-write-lock.mjs';
import { createSsamServer } from '../ssam.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const { withStudioWriteLock, busyToolResult } = lock;
const QUEUE_TIMEOUT = 'STUDIO_WRITE_QUEUE_TIMEOUT';
const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'queue-'));
const depsFor = root => ({ o11Root: path.join(root, 'kernel'), odcRoot: path.join(root, 'odc'), o11Lane: 'ss4' });
const locks = deps => path.join(deps.o11Root, '.local', 'locks');
const files = (dir, ext) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith(ext)).sort() : []);
// The queue entries that read whole (a file still being written by its process is skipped).
const entries = dir => files(dir, '.queue').flatMap(n => { try { return [JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))]; } catch { return []; } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(10); }
}

// A child SSAM process writing a module of the same O11 Studio: o11_deliver through withStudioWriteLock. It prints
// "start <ms>" when its write runs, then holds until stdin says go (HOLD=stdin) or for 150 ms, then prints its answer.
const MODULE = pathToFileURL(path.join(odcRoot, 'facade', 'studio-write-lock.mjs')).href;
const CHILD = `
const { withStudioWriteLock } = await import(process.env.LOCK_MODULE);
const value = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: process.env.CHILD_MODULE, job: [{ op: 'x' }], authorize: 'segredo do filho' },
  lane: 'o11', deps: JSON.parse(process.env.LOCK_DEPS) }, async () => {
  const start = Date.now(); process.stdout.write('start ' + start + '\\n');
  if (process.env.HOLD === 'stdin') await new Promise(resolve => process.stdin.once('data', resolve));
  else await new Promise(resolve => setTimeout(resolve, 150));
  return { ok: true, result: 'entregue', module: process.env.CHILD_MODULE, start, end: Date.now() };
});
process.stdout.write('result ' + JSON.stringify(value) + '\\n');
process.stdin.destroy();
`;
function writer(deps, module, hold) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', LOCK_MODULE: MODULE, LOCK_DEPS: JSON.stringify(deps), CHILD_MODULE: module, HOLD: hold ?? '' } });
  const io = { out: '', err: '' };
  child.stdout.on('data', chunk => { io.out += chunk; });
  child.stderr.on('data', chunk => { io.err += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (io.out.includes('start ')) resolve(); });
    child.once('exit', code => reject(new Error(module + ' exited (' + code + ') before its write ran: ' + io.out + io.err)));
  });
  started.catch(() => {});
  const result = () => { const line = io.out.split('\n').find(l => l.startsWith('result ')); return line ? JSON.parse(line.slice(7)) : null; };
  return { child, started, exited, io, result };
}

test('queueWaitMs: SSAM_WRITE_QUEUE_MS in ms, 0 allowed; anything else is the default of 240 s', () => {
  assert.equal(lock.DEFAULT_QUEUE_MS, 240000);
  assert.equal(lock.queueWaitMs({}), 240000);
  assert.equal(lock.queueWaitMs({ SSAM_WRITE_QUEUE_MS: '' }), 240000);
  assert.equal(lock.queueWaitMs({ SSAM_WRITE_QUEUE_MS: 'x' }), 240000);
  assert.equal(lock.queueWaitMs({ SSAM_WRITE_QUEUE_MS: '-5' }), 240000);
  assert.equal(lock.queueWaitMs({ SSAM_WRITE_QUEUE_MS: '5000' }), 5000);
  assert.equal(lock.queueWaitMs({ SSAM_WRITE_QUEUE_MS: '0' }), 0);
});

test('two processes writing two modules of one Studio: the later writes wait and run in the order they arrived; no STUDIO_WRITE_BUSY', { timeout: 60000 }, async () => {
  const deps = depsFor(tmp());
  const ui = writer(deps, 'Cardapio_UI', 'stdin');
  await ui.started;
  const bo = writer(deps, 'Cardapio_BackOffice');
  await until(() => entries(locks(deps)).some(e => e.pid === bo.child.pid), 'the BackOffice write in the queue');
  const cs = writer(deps, 'Cardapio_CS');
  await until(() => entries(locks(deps)).some(e => e.pid === cs.child.pid), 'the CS write in the queue');
  // one file per waiting write, in arrival order, with the tool and process only (never the arguments)
  const queued = entries(locks(deps));
  assert.deepEqual(queued.map(e => e.pid), [bo.child.pid, cs.child.pid]);
  assert.ok(queued[0].seq < queued[1].seq);
  for (const e of queued) {
    // C07 (atritos 3): the module of the write, as the sha256 of its name (never the name), lets a write pass one that waits for another module.
    assert.deepEqual(Object.keys(e).sort(), ['enqueuedAt', 'lane', 'module', 'pid', 'schema', 'seq', 'studio', 'token', 'tool']);
    assert.equal(e.tool, 'o11_deliver'); assert.equal(JSON.stringify(e).includes('segredo'), false); assert.equal(JSON.stringify(e).includes('Cardapio'), false);
  }
  await sleep(200);
  assert.doesNotMatch(bo.io.out + cs.io.out, /start /, 'nothing ran while the UI write held the Studio');
  ui.child.stdin.write('go\n');
  for (const w of [ui, bo, cs]) assert.equal(await w.exited, 0, w.io.err);
  const [a, b, c] = [ui.result(), bo.result(), cs.result()];
  for (const value of [a, b, c]) assert.equal(value.result, 'entregue', JSON.stringify(value));
  assert.ok(b.start >= a.end, 'the BackOffice ran after the UI ended');
  assert.ok(c.start >= b.end, 'the CS ran after the BackOffice ended: first in, first out');
  assert.equal(a.queue, undefined, 'the first write never waited');
  assert.deepEqual([b.queue.position, b.queue.holder.tool, b.queue.holder.pid], [1, 'o11_deliver', ui.child.pid]);
  assert.equal(c.queue.position, 2);
  assert.ok(b.queue.waitedMs >= 200 && c.queue.waitedMs >= 0);
  assert.doesNotMatch(ui.io.out + bo.io.out + cs.io.out, /STUDIO_WRITE_BUSY|espere a resposta dela e repita/);
  assert.deepEqual(files(locks(deps), '.lock'), []); assert.deepEqual(files(locks(deps), '.queue'), []);
});

test('a wait that runs out answers STUDIO_WRITE_QUEUE_TIMEOUT with the holder and the position; its entry leaves the queue', { timeout: 60000 }, async () => {
  const deps = depsFor(tmp());
  const holder = writer(deps, 'Cardapio_UI', 'stdin');
  await holder.started;
  let first = false, second = false;
  const waiting = withStudioWriteLock({ tool: 'o11_publish', args: { module: 'Cardapio_UI' }, lane: 'o11', deps }, async () => { first = true; return { ok: true, result: 'publicado' }; });
  await until(() => entries(locks(deps)).length === 1, 'the first waiter in the queue');
  // SSAM_WRITE_QUEUE_MS bounds the wait of this call
  const started = Date.now();
  const timedOut = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Cardapio_BackOffice', authorize: 'pode' }, lane: 'o11',
    deps: { ...deps, env: { SSAM_WRITE_QUEUE_MS: '300' } }, onBusy: busyToolResult }, async () => { second = true; });
  assert.ok(Date.now() - started >= 250, 'it waited before refusing');
  assert.equal(second, false, 'nothing of the timed-out write ran');
  assert.equal(timedOut.isError, true);
  const value = timedOut.structuredContent;
  assert.equal(value.code, QUEUE_TIMEOUT);
  assert.equal(value.outcome, 'not-sent');
  assert.deepEqual([value.holder.tool, value.holder.pid], ['o11_deliver', holder.child.pid]);
  assert.ok(Number.isFinite(Date.parse(value.holder.startedAt)));
  assert.equal(value.position, 2, 'the running write and the waiter ahead');
  assert.equal(value.queueMs, 300); assert.ok(value.waitedMs >= 250);
  assert.deepEqual([value.continuation.tool, value.continuation.arguments], ['o11_studio', { command: 'status' }]);
  assert.equal(JSON.stringify(value).includes('pode'), false);
  assert.deepEqual(entries(locks(deps)).map(e => e.tool), ['o11_publish'], 'only the first waiter is still queued');
  holder.child.stdin.write('go\n');
  assert.equal(await holder.exited, 0, holder.io.err);
  const after = await waiting;
  assert.equal(first, true); assert.equal(after.result, 'publicado'); assert.equal(after.queue.holder.pid, holder.child.pid);
  assert.deepEqual(files(locks(deps), '.queue'), []);
});

test('a cancelled wait leaves the queue at once, nothing of it runs, and the write behind it takes its place', { timeout: 60000 }, async () => {
  const deps = depsFor(tmp());
  const holder = writer(deps, 'Cardapio_UI', 'stdin');
  await holder.started;
  const controller = new AbortController();
  let cancelledRan = false;
  const cancelled = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Cardapio_BackOffice' }, lane: 'o11', deps, signal: controller.signal },
    async () => { cancelledRan = true; });
  await until(() => entries(locks(deps)).length === 1, 'the first waiter in the queue');
  const behind = withStudioWriteLock({ tool: 'o11_publish', args: { module: 'Cardapio_CS' }, lane: 'o11', deps }, async () => ({ ok: true, result: 'publicado' }));
  await until(() => entries(locks(deps)).length === 2, 'the second waiter in the queue');
  const at = Date.now();
  controller.abort();
  const value = await cancelled;
  assert.ok(Date.now() - at < 2000, 'the cancellation answers at once');
  assert.deepEqual([value.code, value.outcome], ['CANCELLED', 'not-sent']);
  assert.equal(value.continuation.tool, 'o11_studio');
  assert.equal(cancelledRan, false);
  assert.deepEqual(entries(locks(deps)).map(e => e.tool), ['o11_publish'], 'the cancelled entry left the queue');
  holder.child.stdin.write('go\n');
  assert.equal(await holder.exited, 0, holder.io.err);
  const next = await behind;
  assert.equal(next.result, 'publicado');
  assert.equal(next.queue.position, 2, 'it entered behind the running write and the cancelled one');
  assert.deepEqual(files(locks(deps), '.queue'), []); assert.deepEqual(files(locks(deps), '.lock'), []);
});

test('the entry of a dead process leaves the queue; a live foreign waiter ahead is waited for', async () => {
  const deps = depsFor(tmp()); const dir = locks(deps);
  fs.mkdirSync(dir, { recursive: true });
  const entry = (seq, pid) => ({ schema: lock.QUEUE_SCHEMA, pid, tool: 'o11_deliver', enqueuedAt: new Date().toISOString(), seq, lane: 'o11-ss4', studio: null, token: 't' + seq });
  const write = (seq, pid) => fs.writeFileSync(path.join(dir, 'o11-ss4~q' + String(seq).padStart(12, '0') + '.queue'), JSON.stringify(entry(seq, pid)));
  // a dead process (injected) waiting first: dropped, and the write runs at once without waiting
  write(1, 999999);
  const ran = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'M' }, lane: 'o11', deps: { ...deps, alive: pid => pid !== 999999 } }, async () => ({ ok: true }));
  assert.deepEqual(ran, { ok: true });
  assert.deepEqual(files(dir, '.queue'), []);
  // a live foreign process (the test runner) waiting first: this write waits behind it, here until its short limit
  write(1, process.ppid);
  const timedOut = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'M' }, lane: 'o11', deps: { ...deps, queueMs: 80 } }, async () => ({ ok: true }));
  assert.equal(timedOut.code, QUEUE_TIMEOUT);
  assert.deepEqual([timedOut.holder.tool, timedOut.holder.pid, timedOut.position], ['o11_deliver', process.ppid, 1]);
  assert.deepEqual(files(dir, '.queue'), ['o11-ss4~q000000000001.queue'], 'the foreign entry stays; this one left');
  // an entry of this process that no write of it waits for (a leftover) is stale too
  fs.unlinkSync(path.join(dir, 'o11-ss4~q000000000001.queue'));
  write(3, process.pid);
  assert.deepEqual(await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'M' }, lane: 'o11', deps }, async () => ({ ok: true })), { ok: true });
  assert.deepEqual(files(dir, '.queue'), []);
});

test('through the ssam server: a second o11_deliver on the same Studio waits for the first and answers entregue with queue', async t => {
  const root = tmp();
  let entered; const reached = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  let delivers = 0;
  const runAnvil = fakeAnvil({ deliver: async () => { const n = ++delivers; if (n === 1) { entered(); await gate; }
    return { ok: true, command: 'deliver', data: { delivered: true, taskId: 't' + n, writeState: 'applied' } }; } });
  // No bridge at all: a fake that refuses every call, and no last-publication read (nothing reaches a lane port).
  const bridge = { ok: async method => { throw Object.assign(new Error('no bridge in this test: ' + method), { code: 'BRIDGE_NOT_LISTENING' }); } };
  const server = await createSsamServer({ odc: false, deps: { cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil, assertSelected: async () => {},
    tasksDir: path.join(root, 'tasks'), bridge, lastPublication: async () => null, lock: { connection: () => null } },
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f4-queue', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { release(); await client.close(); await server.close(); });
  const words = 'pode entregar, Ana 0912';
  const job = { ops: [{ op: 'rename', from: 'A', to: 'B' }] };
  const first = client.callTool({ name: 'o11_deliver', arguments: { module: 'Cardapio_UI', job, authorize: words } });
  await reached;
  const second = client.callTool({ name: 'o11_deliver', arguments: { module: 'Cardapio_BackOffice', job, authorize: words } });
  await sleep(150);
  assert.equal(delivers, 1, 'the second delivery waits its turn: never two on the Studio at once, never refused');
  release();
  assert.equal(JSON.parse((await first).content[0].text).result, 'entregue');
  const after = await second;
  assert.notEqual(after.isError, true, JSON.stringify(after));
  const texts = after.content.map(c => c.text).join('\n');
  assert.match(texts, /entregue/);
  const queue = after.structuredContent?.queue ?? JSON.parse(after.content.find(c => /"queue"/.test(c.text)).text).queue;
  assert.deepEqual([queue.position, queue.holder.tool, queue.holder.pid], [1, 'o11_deliver', process.pid]);
  assert.doesNotMatch(texts, /Ana 0912|STUDIO_WRITE_BUSY/);
  assert.equal(delivers, 2);
  assert.deepEqual(files(path.join(root, '.local', 'locks'), '.lock'), []); assert.deepEqual(files(path.join(root, '.local', 'locks'), '.queue'), []);
});

test('ODC: two Studios (pids) have their own queues; a lane-wide write waits for both', async () => {
  const deps = depsFor(tmp());
  const gate = { resolve: null }; const held = new Promise(resolve => { gate.resolve = resolve; });
  const a = withStudioWriteLock({ tool: 'studio_merge', args: { pid: 101 }, lane: 'odc', deps }, () => held);
  // another Studio runs at once
  assert.equal(await withStudioWriteLock({ tool: 'studio_merge', args: { pid: 202 }, lane: 'odc', deps }, async () => 'outro Studio'), 'outro Studio');
  const order = [];
  const whole = withStudioWriteLock({ tool: 'studio_open', args: {}, lane: 'odc', deps }, async () => { order.push('lane'); return { ok: true }; });
  const same = withStudioWriteLock({ tool: 'studio_publish', args: { pid: 101 }, lane: 'odc', deps }, async () => { order.push('101'); return { ok: true }; });
  await sleep(60);
  assert.deepEqual(order, []);
  gate.resolve(); await a;
  const [w, s] = await Promise.all([whole, same]);
  assert.deepEqual(order, ['lane', '101'], 'first in, first out across the two levels');
  assert.deepEqual([w.queue.position, s.queue.position], [1, 2]);
});
