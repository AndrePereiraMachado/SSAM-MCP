import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { createFacadeServer } from '../mcp.mjs';
import { createSsamServer } from '../ssam.mjs';
import { runWithExecutor, prepareWorkspace } from '../executor.mjs';
import { publishWithGrant } from '../studio-publish-log.mjs';
import { registerO11Cycle } from '../o11-cycle.mjs';
import { registerO11Publish, createO11Publish } from '../o11-publish.mjs';
import { createWorkerFirstRunner } from '../anvil-worker.mjs';
import { checkJobKernel, deliverKernel } from '../kernel-delivery.mjs';
import * as writeLock from '../studio-write-lock.mjs';
const { withStudioWriteLock, enterApplyPhase, studioWriteTarget } = writeLock;
// Run the same named regressions on the integration base, before these capabilities existed.
const missingCapability = () => assert.fail('The integration base does not implement this capability.');
const ownsStudioWrite = writeLock.ownsStudioWrite ?? missingCapability;
const { coalescePublication, hasPendingMerge } = await import('../studio-work-order.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('studio-work-order.mjs')) throw error;
  return { coalescePublication: missingCapability, hasPendingMerge: missingCapability };
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const words = 'Publish the sample module for the review regression';
function fixture(t, runner, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-review-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = path.join(root, 'authority'); fs.mkdirSync(authority);
  const env = { ANVIL_WORKER: '0', ANVIL_LANE: 'ss4', ANVIL_AUTHORITY_DIR: authority, SSAM_UI_PRECHECK: '0' };
  const lock = { o11Root: root, odcRoot: root, o11Lane: 'ss4', env, queueMs: 600, connection: () => ({ pid: process.pid, port: 45801, authorityDir: authority }) };
  const job = path.join(root, 'job.json'); fs.writeFileSync(job, '{"ops":[{"op":"get","target":"ServerAction:Read"}]}');
  const state = { environment: 'sample.example.test', preflight: { valid: true }, apply: { isValid: true, accepted: true }, commands: [] };
  const bridge = { ok: async (method, args = {}, options = {}) => {
    state.commands.push(method);
    if (method === 'list_open_modules') return { modules: state.closed ? [] : [{ name: 'Sample', key: 'key', environment: state.environment }] };
    if (method === 'snapshot_module') { fs.mkdirSync(path.dirname(args.path), { recursive: true }); fs.writeFileSync(args.path, 'model'); return { path: args.path, key: 'key' }; }
    if (method === 'bridge_manifest') return { capabilities: ['merge_from_oml:module_key'] };
    if (method === 'get_active_module') return { name: 'Sample', key: 'key', environment: state.environment };
    if (method === 'get_errors') return { isValid: true, errors: 0 };
    if (method === 'open_module') return { name: 'Sample', opened: true, alreadyOpen: true };
    if (method === 'publish') return state.onPublish ? state.onPublish(options.signal) : { published: true, module: 'Sample' };
    return {};
  } };
  const run = runner ?? (async args => ({ envelope: { ok: true, data: args[0] === 'check-job' ? state.preflight : state.apply } }));
  const handlers = new Map(); const server = { registerTool: (name, config, handler) => handlers.set(name, handler) };
  const deps = { root, env, lane: 'ss4', bridge, runAnvil: run, buildRunner: () => run, assertSelected: async () => {}, registerTask: false, registerGrant: false, lock, ...overrides };
  registerO11Cycle(server, deps); registerO11Publish(server, deps);
  const call = args => withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Sample', job, authorize: words, ...args }, lane: 'o11', deps: lock, phased: true, deferReservation: true },
    () => handlers.get('o11_deliver')({ module: 'Sample', job, authorize: words, ...args }));
  return { root, authority, env, lock, job, state, bridge, handlers, call, deps };
}
const valueOf = result => result.structuredContent ?? result;

test('review 1: hosted publisher uses the hub lock directory and cannot overlap its merge', async t => {
  const f = fixture(t), ready = gate(), release = gate(); t.after(release.resolve);
  const workspace = path.join(f.root, 'customer'); prepareWorkspace(workspace);
  const context = { id: 'review', tokenId: 'review', hosted: true, workspace, executor: { hosted: true, workspace, call: async () => ({}) } };
  await runWithExecutor(context, async () => {
    const args = { module: 'Sample', pid: 7 };
    const hub = { tool: 'studio_deliver', args, lane: 'odc', deps: {} };
    assert.equal(studioWriteTarget(hub).dir, path.join(workspace, 'state', 'locks'));
    const holder = withStudioWriteLock(hub, async () => { ready.resolve(); await release.promise; }); await ready.promise;
    let published = false, seen;
    const manifest = path.join(workspace, 'odc', 'manifest.json');
    const pending = publishWithGrant({ manifest, authorize: words, pid: 7 }, { root: path.join(workspace, 'odc'),
      readManifest: () => ({ module: 'Sample', tenant: 'sample.example.test' }),
      studio: async ([step]) => step === 'status' ? { ok: true, pid: 7, modules: [{ name: 'Sample', key: 'key', host: 'sample.example.test' }] } : { ok: true },
      publish: async () => { published = true; seen = ownsStudioWrite(hub); return { ok: true }; } });
    await sleep(35); assert.equal(published, false); release.resolve(); await holder; await pending;
    assert.equal(seen, true);
  });
});

test('review 3: the actual ODC MCP handler propagates cancellation into its owned queue', async t => {
  const f = fixture(t), ready = gate(), release = gate(), abort = new AbortController(); t.after(release.resolve);
  const manifest = path.join(f.root, 'manifest.json'); fs.writeFileSync(manifest, '{"module":"Sample","tenant":"sample.test"}');
  let handler, mutations = 0;
  const original = McpServer.prototype.registerTool;
  McpServer.prototype.registerTool = function(name, config, fn) {
    if (name === 'studio_publish') handler = fn;
    return original.call(this, name, config, fn);
  };
  let server;
  try {
    server = await createFacadeServer({ deps: { lock: f.lock,
      studio: async ([step]) => {
        if (step === 'status') return { ok: true, pid: 3, modules: [{ name: 'Sample', key: 'key', host: 'sample.test' }] };
        mutations++; return { ok: true };
      } } });
  } finally { McpServer.prototype.registerTool = original; }
  t.after(() => server.close()); assert.equal(typeof handler, 'function');
  const holder = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample', pid: 3 }, lane: 'odc', deps: f.lock }, async () => { ready.resolve(); await release.promise; });
  await ready.promise;
  const pending = handler({ manifest, authorize: words, pid: 3 }, { mcpReq: { signal: abort.signal } });
  await sleep(20); abort.abort();
  const answer = await Promise.race([pending, sleep(200).then(() => null)]);
  assert.equal(valueOf(answer ?? {}).code, 'CANCELLED');
  release.resolve(); await holder; await pending; await sleep(70); assert.equal(mutations, 0);
});

test('review 2: an intent-waiting publish yields the queue to another module and the pending merge', async t => {
  const f = fixture(t), building = gate(), release = gate(); t.after(release.resolve); const order = [];
  const merge = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'M', job: [] }, lane: 'o11', deps: f.lock, phased: true }, async () => {
    building.resolve(); await release.promise; const turn = await enterApplyPhase(); if (turn.ok) order.push('merge'); return turn;
  }); await building.promise;
  const publication = withStudioWriteLock({ tool: 'o11_publish', args: { module: 'M' }, lane: 'o11', deps: f.lock }, async () => { order.push('publish'); return { ok: true }; });
  await sleep(20);
  const other = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'X', close: 'test' }, lane: 'o11', deps: f.lock }, async () => { order.push('other'); return { ok: true }; });
  await sleep(25); release.resolve(); const results = await Promise.all([merge, publication, other]);
  assert.ok(results.every(r => r.ok), JSON.stringify(results)); assert.ok(order.indexOf('merge') < order.indexOf('publish'));
});

test('review 3: ODC cancellation reaches its queue and prevents publication', async t => {
  const f = fixture(t), ready = gate(), release = gate(), abort = new AbortController(); t.after(release.resolve);
  const args = { module: 'Sample', pid: 3 }, lock = { tool: 'studio_merge', args, lane: 'odc', deps: f.lock };
  const holder = withStudioWriteLock(lock, async () => { ready.resolve(); await release.promise; }); await ready.promise;
  let published = 0;
  const pending = publishWithGrant({ manifest: path.join(f.root, 'manifest.json'), authorize: words, pid: 3 }, { root: f.root, lock: f.lock,
    readManifest: () => ({ module: 'Sample' }), studio: async ([step]) => step === 'status' ? { ok: true, pid: 3, modules: [{ name: 'Sample', key: 'key', host: 'sample.test' }] } : { ok: true },
    publish: async () => { published++; return { ok: true }; } }, { signal: abort.signal });
  await sleep(20); abort.abort();
  const cancelled = await Promise.race([pending, sleep(200).then(() => null)]);
  assert.equal(cancelled?.code, 'CANCELLED'); release.resolve(); await holder; await pending; assert.equal(published, 0);
});

test('review 3: a sole caller cancellation after dispatch reaches the operation', async t => {
  const started = gate(), finish = gate(), abort = new AbortController(); t.after(finish.resolve);
  const pending = coalescePublication('review-single-active', async (start, signal) => {
    start(); started.resolve(); signal.addEventListener('abort', finish.resolve, { once: true });
    await finish.promise; return { ok: false, code: signal.aborted ? 'CANCELLED' : 'NOT_CANCELLED' };
  }, { signal: abort.signal });
  await started.promise; abort.abort();
  const result = await Promise.race([pending, sleep(200).then(() => null)]); assert.equal(result?.code, 'CANCELLED');
});

test('review 3: the sole O11 publication forwards cancellation after its bridge call starts', async t => {
  const f = fixture(t), started = gate(), release = gate(), abort = new AbortController(); t.after(release.resolve);
  f.state.onPublish = async signal => {
    signal.addEventListener('abort', release.resolve, { once: true }); started.resolve(); await release.promise;
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED', executed: true });
    return { published: true, module: 'Sample' };
  };
  const publisher = createO11Publish({ root: f.root, env: f.env, bridge: f.bridge, lock: f.lock, assertSelected: async () => {} });
  const pending = publisher({ module: 'Sample', authorize: words }, { signal: abort.signal });
  await started.promise; abort.abort();
  const result = await Promise.race([pending, sleep(200).then(() => null)]); assert.equal(result?.code, 'CANCELLED');
});

test('review 4: default O11 preflight avoids a busy worker without an injected checkRunner', async t => {
  const busy = gate(); t.after(busy.resolve); let avoided = false;
  const runner = createWorkerFirstRunner({ worker: { run: async (_args, options) => {
    if (options.avoidBusy) { avoided = true; return { used: false }; } await busy.promise; return { used: false };
  } }, cold: async () => ({ envelope: { ok: false, data: { valid: false, static: { complete: true }, problems: [{ code: 'JSON_SHAPE', severity: 'error' }] } } }) });
  const f = fixture(t, runner);
  const result = await Promise.race([f.call(), sleep(250).then(() => null)]);
  assert.equal(valueOf(result ?? {}).code, 'PREFLIGHT_REFUSED'); assert.equal(avoided, true);
});

test('review 4: ODC preflight runs in its own process instead of queuing on the worker', async t => {
  const f = fixture(t); let consulted = false, cold = false;
  const answer = await checkJobKernel({ job: f.job }, { cli: f.job,
    runOnWorker: async () => { consulted = true; return { used: true, envelope: { ok: true, data: { valid: true } } }; },
    exec: async () => { cold = true; return { stdout: JSON.stringify({ ok: true, data: { valid: true } }) }; } });
  assert.equal(answer.ok, true); assert.equal(consulted, false); assert.equal(cold, true);
});

test('review 5: O11 returns static and base problems together when preflight is incomplete', async t => {
  const f = fixture(t);
  f.state.preflight = { valid: false, static: { complete: false }, problems: [{ code: 'STATIC_PROBLEM', phase: 'static', severity: 'error', op: 0, pointer: '/ops/0', message: 'static problem' }] };
  f.state.apply = { isValid: false, accepted: false, problems: [{ code: 'BASE_PROBLEM', phase: 'base', severity: 'error', op: 1, pointer: '/ops/1', message: 'base problem' }] };
  const result = valueOf(await f.call()); const codes = result.problems?.map(p => p.code) ?? [];
  assert.ok(codes.includes('STATIC_PROBLEM') && codes.includes('BASE_PROBLEM'), JSON.stringify(result));
});

test('review 5: ODC returns static and base problems together when preflight is incomplete', async t => {
  const f = fixture(t);
  const result = await deliverKernel({ module: 'Sample', feature: 'review', job: f.job, owners: ['Screen'], changes: ['Change'] }, {
    root: f.root, nextLabDir: () => path.join(f.root, 'attempt'), journal: () => {},
    check: async () => ({ ok: false, static: { complete: false }, problems: [{ code: 'STATIC_PROBLEM', phase: 'static', message: 'static problem' }] }),
    studio: async () => ({ ok: true, path: f.job, sha256: 'hash', host: 'sample.test' }),
    apply: async () => ({ ok: false, problems: [{ code: 'BASE_PROBLEM', phase: 'base', message: 'base problem' }], error: 'base problem' }), prepareManifest: async () => ({ ok: true }) });
  const codes = result.problems?.map(p => p.code) ?? []; assert.ok(codes.includes('STATIC_PROBLEM') && codes.includes('BASE_PROBLEM'), JSON.stringify(result));
});

test('review 6: unreadable intents age out after the lock grace period', t => {
  const f = fixture(t), target = studioWriteTarget({ tool: 'studio_publish', args: { module: 'Sample' }, lane: 'odc', deps: f.lock });
  fs.mkdirSync(target.dir, { recursive: true }); const file = path.join(target.dir, 'merge-broken.intent'); fs.writeFileSync(file, '{');
  assert.equal(hasPendingMerge(target), true); const old = new Date(Date.now() - 31000); fs.utimesSync(file, old, old);
  assert.equal(hasPendingMerge(target), false); assert.equal(fs.existsSync(file), false);
});

test('review 7: the early reservation wait lets its owner pass and resumes after release', async t => {
  const f = fixture(t); f.lock.env.SSAM_RESERVATION_QUEUE_MS = '400';
  const directory = path.join(f.authority, 'reservations'); fs.mkdirSync(directory);
  const file = path.join(directory, 'held.json'); fs.writeFileSync(file, JSON.stringify({ owner: 'a'.repeat(32), moduleKey: 'Sample' }));
  let ran = false;
  const pending = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Sample', job: [] }, lane: 'o11', deps: f.lock, phased: true }, async () => { ran = true; return { ok: true }; });
  await sleep(25); assert.equal(ran, false);
  await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Sample', closePrevious: 'a'.repeat(32) }, lane: 'o11', deps: f.lock, phased: true }, async () => fs.writeFileSync(file, '{"owner":null}'));
  const result = await pending; assert.equal(result.ok, true); assert.equal(ran, true); assert.ok(result.queue.waitedMs >= 20);
});

test('review 8: a coalesced O11 success keeps its note in the JSON text', async t => {
  const f = fixture(t), ready = gate(), release = gate(); t.after(release.resolve);
  const holder = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample' }, lane: 'o11', deps: f.lock }, async () => { ready.resolve(); await release.promise; }); await ready.promise;
  const calls = [1, 2].map(() => f.handlers.get('o11_publish')({ module: 'Sample', authorize: words }));
  await sleep(25); release.resolve(); await holder; const results = await Promise.all(calls);
  for (const result of results) { assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent); assert.equal(result.structuredContent.note, 'coalesced with 2 requests'); }
});

test('round 2 item 1: the registered O11 publish handler cancels an SDK v2 queued request without publishing', async t => {
  const f = fixture(t), ready = gate(), release = gate(), abort = new AbortController(); t.after(release.resolve);
  const holder = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample' }, lane: 'o11', deps: f.lock }, async () => { ready.resolve(); await release.promise; });
  await ready.promise;
  const pending = f.handlers.get('o11_publish')({ module: 'Sample', authorize: words }, { mcpReq: { signal: abort.signal } });
  await sleep(25); abort.abort();
  const early = await Promise.race([pending, sleep(200).then(() => null)]);
  release.resolve(); await holder; const final = await pending;
  assert.equal(valueOf(early ?? {}).code, 'CANCELLED'); assert.equal(valueOf(final).outcome, 'not-sent');
  assert.equal(f.state.commands.filter(c => c === 'publish').length, 0);
});

function reserve(f) {
  f.lock.env.SSAM_RESERVATION_QUEUE_MS = '1500';
  f.lock.queueMs = 3000;
  const directory = path.join(f.authority, 'reservations'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'held.json'), JSON.stringify({ owner: 'a'.repeat(32), moduleKey: 'Sample' }));
}
function queueFiles(f) {
  const directory = path.join(f.authority, 'studio-locks');
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(n => /\.(guard|q|intent)$/.test(n)) : [];
}
test('round 2 item 2: a complete static refusal precedes foreign reservation waiting and creates no queue files', async t => {
  let checked = false;
  const run = { valid: false, static: { complete: true }, problems: [{ code: 'STATIC_PROBLEM', severity: 'error', message: 'Invalid job' }] };
  // The observed runner, rather than elapsed time alone, proves that the pure check ran.
  const g = fixture(t, async args => { if (args[0] === 'check-job') checked = true; return { envelope: { data: run } }; }); reserve(g);
  const handlers = new Map();
  const server = await createSsamServer({ o11: true, odc: false, deps: { cycle: g.deps, lock: g.lock,
    exposure: { profile: 'owner' }, registerTool: (name, config, handler) => handlers.set(name, handler) } });
  t.after(() => server.close());
  const start = performance.now(); const result = valueOf(await handlers.get('o11_deliver')({ module: 'Sample', job: g.job, authorize: words }));
  assert.equal(result.code, 'PREFLIGHT_REFUSED'); assert.equal(checked, true); assert.ok(performance.now() - start < 300);
  assert.deepEqual(queueFiles(g), []); assert.deepEqual(g.state.commands, []);
});
test('round 2 item 2: a valid preflight still waits outside the queue until the reservation deadline', async t => {
  let checked = false;
  const f = fixture(t, async args => { if (args[0] === 'check-job') checked = true; return { envelope: { data: { valid: true } } }; }); reserve(f);
  const start = performance.now(); const pending = f.call(); await sleep(100);
  assert.equal(checked, true); assert.deepEqual(queueFiles(f), []); assert.deepEqual(f.state.commands, []);
  const result = valueOf(await pending); assert.equal(result.code, 'MODULE_RESERVED');
  assert.ok(performance.now() - start >= 1500); assert.deepEqual(f.state.commands, []);
});
test('round 2 item 3: a normal O11 publish retains lastPublication in the text answer', async t => {
  const f = fixture(t); const answer = await f.handlers.get('o11_publish')({ module: 'Sample', authorize: words });
  assert.ok(answer.structuredContent.lastPublication); assert.deepEqual(JSON.parse(answer.content[0].text), answer.structuredContent);
});
test('round 2 item 4: a document refusal carries incomplete static problems in one answer', async t => {
  const f = fixture(t, undefined, { prepareIntegrationJob: async () => ({ ok: false, code: 'DOCUMENT_REFUSED', error: 'The integration document is invalid.' }) });
  f.state.preflight = { valid: false, static: { complete: false }, problems: [{ code: 'STATIC_PROBLEM', severity: 'error', message: 'Static problem' }] };
  const answer = valueOf(await f.call()); assert.equal(answer.code, 'DOCUMENT_REFUSED'); assert.equal(answer.stage, 'documents');
  assert.equal((answer.problems ?? answer.static?.problems)?.filter(p => p.code === 'STATIC_PROBLEM').length, 1);
  assert.deepEqual(f.state.commands, []);
});

test('review 8: unavailable validation offers explicit open and rejects a different environment', async t => {
  const f = fixture(t); f.state.closed = true;
  const closed = valueOf(await f.call({ until: 'apply' })); assert.equal(closed.continuation.arguments.command, 'open-module');
  assert.equal(closed.continuation.arguments.args.name, 'Sample'); assert.equal(f.state.commands.includes('open_module'), false);
  f.state.closed = false;
  const other = valueOf(await f.call({ until: 'apply', expectedEnvironment: 'other.test' }));
  assert.equal(other.code, 'VALIDATION_CAPTURE_UNAVAILABLE'); assert.equal(f.state.commands.includes('snapshot_module'), false);
});
