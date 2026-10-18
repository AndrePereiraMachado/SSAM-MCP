// Atritos 3, lane fa, C07: the Studio write lock per module. o11_data writes records through the bridge's environment
// session (no tab, no model) and never takes the Studio key; narrowStudioWrite (contract I2) swaps the Studio lock of a
// running write for the lock of its module, so a write of another module runs while a publish still runs; the queue keeps
// its order except for a write that only waits behind a module it does not touch. Temporary folders only; no Studio.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as lock from '../studio-write-lock.mjs';

const { withStudioWriteLock, studioWriteTarget, QUEUE_TIMEOUT_CODE } = lock;
const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'pa3-lock-'));
const depsFor = root => ({ o11Root: path.join(root, 'kernel'), odcRoot: path.join(root, 'odc'), o11Lane: 'ss4' });
// A module in a lock file: the sha256 (16 hex) of its lowercase name, never the name.
const tag = name => createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 16);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const insert = module => ({ module, host: 'h.test', oml: 'C:\\m.oml', request: { operation: 'insert', entity: 'E', records: [{}], authorization: 'pode' } });
const locks = deps => (fs.existsSync(path.join(deps.o11Root, '.local', 'locks')) ? fs.readdirSync(path.join(deps.o11Root, '.local', 'locks')).filter(n => n.endsWith('.lock')).sort() : []);

test('C07: an o11_data insert runs while an o11_deliver holds the Studio; it has its own lane plus the module', async () => {
  const deps = depsFor(tmp());
  const gate = deferred();
  const delivery = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Orders', job: [{ op: 'x' }] }, lane: 'o11', deps }, async () => { await gate.promise; return 'delivered'; });
  await new Promise(r => setImmediate(r));
  const data = await withStudioWriteLock({ tool: 'o11_data', args: insert('Orders'), lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => ({ ok: true, inserted: 1 }));
  assert.deepEqual(data, { ok: true, inserted: 1 }, 'the record write never waits behind the delivery');
  assert.deepEqual(studioWriteTarget({ tool: 'o11_data', args: insert('Orders'), lane: 'o11', deps }),
    { lane: 'o11-data-ss4', id: 'm-' + tag('Orders'), dir: path.join(deps.o11Root, '.local', 'locks') });
  assert.equal(studioWriteTarget({ tool: 'o11_data', args: { request: { operation: 'insert' } }, deps }).id, null, 'no module: the whole data lane');
  gate.resolve();
  assert.equal(await delivery, 'delivered');
});

test('C07: two record writes of the same module stay in series; another module runs beside them', async () => {
  const deps = depsFor(tmp());
  const gate = deferred();
  const first = withStudioWriteLock({ tool: 'o11_data', args: insert('Orders'), lane: 'o11', deps }, async () => { await gate.promise; return 'primeiro'; });
  await new Promise(r => setImmediate(r));
  const same = await withStudioWriteLock({ tool: 'o11_data', args: insert('orders'), lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => 'segundo');
  assert.equal(same.code, QUEUE_TIMEOUT_CODE, 'same module (any case): in series');
  assert.equal(await withStudioWriteLock({ tool: 'o11_data', args: insert('Customers'), lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => 'outro'), 'outro');
  const queued = withStudioWriteLock({ tool: 'o11_data', args: insert('Orders'), lane: 'o11', deps }, async () => 'na vez');
  gate.resolve();
  assert.equal(await first, 'primeiro');
  assert.equal(await queued, 'na vez');
});

test('C07, I2: after narrowStudioWrite({module:"A"}) a write of module B runs and one of A (or of no module) waits', async () => {
  const deps = depsFor(tmp());
  const narrowed = deferred(); const gate = deferred();
  let answer;
  const publish = withStudioWriteLock({ tool: 'o11_publish', args: { module: 'A' }, lane: 'o11', deps }, async () => {
    answer = lock.narrowStudioWrite({ module: 'A' });
    assert.deepEqual(lock.narrowStudioWrite({ module: 'A' }), answer, 'idempotent');
    narrowed.resolve();
    await gate.promise;
    return 'published';
  });
  await narrowed.promise;
  assert.equal(answer.narrowed, true);
  assert.equal(answer.key, 'o11-ss4~~m-' + tag('A'));
  assert.deepEqual(locks(deps), ['o11-ss4~~m-' + tag('A') + '.lock'], 'the Studio lock became the module lock');
  assert.equal(fs.readFileSync(path.join(deps.o11Root, '.local', 'locks', locks(deps)[0]), 'utf8').includes('"A"'), false, 'never the module name');
  assert.equal(await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'B', job: [] }, lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => 'B entregue'), 'B entregue');
  assert.equal((await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'a', job: [] }, lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => 'x')).code, QUEUE_TIMEOUT_CODE);
  assert.equal((await withStudioWriteLock({ tool: 'o11_studio', args: { command: 'dismiss-dialog' }, lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => 'x')).code, QUEUE_TIMEOUT_CODE,
    'a write that names no module conflicts with every module lock');
  const afterwards = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [] }, lane: 'o11', deps }, async () => 'A entregue');
  gate.resolve();
  assert.equal(await publish, 'published');
  assert.equal(await afterwards, 'A entregue');
  assert.deepEqual(locks(deps), [], 'the end of the call released the module lock');
});

test('C07, I2: narrowStudioWrite outside a write, or without a module, changes nothing', async () => {
  assert.deepEqual(lock.narrowStudioWrite({ module: 'A' }), { narrowed: false, key: null });
  const deps = depsFor(tmp());
  const value = await withStudioWriteLock({ tool: 'o11_studio', args: { command: 'login' }, lane: 'o11', deps }, async () => lock.narrowStudioWrite({}));
  assert.deepEqual(value, { narrowed: false, key: null });
  // The module the write named is used when the call names none.
  const named = await withStudioWriteLock({ tool: 'o11_publish', args: { module: 'Orders' }, lane: 'o11', deps }, async () => lock.narrowStudioWrite());
  assert.equal(named.narrowed, true); assert.equal(named.key, 'o11-ss4~~m-' + tag('Orders'));
  // A record write never narrows (it never held the Studio).
  assert.deepEqual(await withStudioWriteLock({ tool: 'o11_data', args: insert('X'), lane: 'o11', deps }, async () => lock.narrowStudioWrite({ module: 'X' })), { narrowed: false, key: null });
});

test('C07: a module lock of another process excludes only that module', async () => {
  const deps = depsFor(tmp());
  const dir = path.join(deps.o11Root, '.local', 'locks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'o11-ss4~~m-' + tag('A') + '.lock'), JSON.stringify({ schema: lock.LOCK_SCHEMA, pid: process.ppid, tool: 'studio_publish', startedAt: new Date().toISOString(),
    lane: 'o11-ss4', studio: null, module: { name: tag('A'), key: null }, kind: 'module', token: 'outro' }));
  const refused = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [] }, lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => 'x');
  assert.equal(refused.code, QUEUE_TIMEOUT_CODE); assert.equal(refused.holder.tool, 'studio_publish');
  assert.equal(await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'B', job: [] }, lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => 'B'), 'B');
});

test('C07: a write of module B passes an earlier write of module A that only waits for the lock of A', async () => {
  const deps = depsFor(tmp());
  const narrowed = deferred(); const gate = deferred(); const order = [];
  const publish = withStudioWriteLock({ tool: 'o11_publish', args: { module: 'A' }, lane: 'o11', deps }, async () => {
    lock.narrowStudioWrite({ module: 'A' }); narrowed.resolve(); await gate.promise; order.push('publish A'); return 'published';
  });
  await narrowed.promise;
  const waitingA = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [] }, lane: 'o11', deps }, async () => { order.push('deliver A'); return 'A'; });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'B', job: [] }, lane: 'o11', deps: { ...deps, queueMs: 2000 } }, async () => { order.push('deliver B'); return 'B'; }), 'B');
  gate.resolve();
  await publish; await waitingA;
  assert.deepEqual(order, ['deliver B', 'publish A', 'deliver A']);
});

test('C07, I2: the narrowing reaches a handler behind the in-memory MCP relay (the ODC facade server of ssam.mjs)', async t => {
  const deps = depsFor(tmp());
  const inner = new McpServer({ name: 'inner', version: '1.0.0' });
  inner.registerTool('studio_deliver', { description: 'fake' }, async () => {
    const value = lock.narrowStudioWrite({ module: 'Shop' });
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'relay', version: '1.0.0' });
  await Promise.all([inner.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await inner.close(); });
  const value = await withStudioWriteLock({ tool: 'studio_deliver', args: { feature: 'f', module: 'Shop', pid: 7 }, lane: 'odc', deps },
    async () => (await client.callTool({ name: 'studio_deliver', arguments: {} })).structuredContent);
  assert.equal(value.narrowed, true, JSON.stringify(value));
  assert.equal(value.key, 'odc~pid7~m-' + tag('Shop'));
});
