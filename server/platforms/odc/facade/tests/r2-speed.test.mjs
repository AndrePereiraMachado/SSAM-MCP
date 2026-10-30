import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerO11Cycle } from '../o11-cycle.mjs';
import { createO11Publish } from '../o11-publish.mjs';
import { withStudioWriteLock, enterApplyPhase, notePhase, phaseOfCall } from '../studio-write-lock.mjs';
import { buildBeforeApply, afterApply } from '../o11-build-phase.mjs';
import { publishWithGrant } from '../studio-publish-log.mjs';
import { codeOf } from '../quality-line.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const hash = value => createHash('sha256').update(value).digest('hex');
const words = 'Publish the requested module for this regression test';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-speed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = path.join(root, '.local'), authority = path.join(root, 'authority');
  fs.mkdirSync(authority, { recursive: true });
  const connection = { pid: 12345, port: 45800, authorityDir: authority };
  const env = { ANVIL_WORKER: '0', ANVIL_LANE: 'ss4', ANVIL_AUTHORITY_DIR: authority, SSAM_UI_PRECHECK: '0' };
  const lock = { o11Root: root, o11Lane: 'ss4', env, connection: () => connection, queueMs: 1000 };
  const job = path.join(root, 'job.json'); fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'get', target: 'ServerAction:Compute' }] }));
  const state = { model: 'initial model', key: 'module-1', environment: 'personal.example.test', published: 0, open: 0,
    commands: [], active: 0, peak: 0, beforeApply: null, preflightValid: true, order: [] };
  const bridge = { ok: async (method, args = {}) => {
    state.commands.push(method);
    if (method === 'list_open_modules') return { modules: state.missing ? [] : [{ name: 'Sample', key: state.key, environment: state.environment }] };
    if (method === 'snapshot_module') { fs.mkdirSync(path.dirname(args.path), { recursive: true }); fs.writeFileSync(args.path, state.model); return { key: state.key, path: args.path }; }
    if (method === 'open_module') { state.open++; return { opened: true, alreadyOpen: true, name: 'Sample' }; }
    if (method === 'get_active_module') return { name: 'Sample', key: state.key, environment: state.environment, pendingDialogs: [] };
    if (method === 'get_errors') return { isValid: true, errors: 0, messages: [] };
    if (method === 'publish') { state.published++; state.order.push('publish'); return state.publishResult ?? { module: 'Sample', published: true }; }
    if (method === 'publish_log') return { found: false };
    if (method === 'bridge_manifest') return { capabilities: ['merge_from_oml:module_key'] };
    if (method === 'ping' || method === 'windows') return {};
    throw new Error('Unexpected bridge method: ' + method);
  } };
  const runAnvil = async args => {
    if (args[0] === 'deliver' && state.deliverKernel) return state.deliverKernel(args);
    if (args[0] === 'check-job' && state.checkRunner) return state.checkRunner(args);
    if (args[0] === 'check-job') return { envelope: { ok: state.preflightValid, data: { valid: state.preflightValid, static: { complete: !state.preflightValid },
      problems: state.preflightValid ? [] : [{ op: 0, code: 'JSON_SHAPE', severity: 'error', message: 'An operation must be an object.' }] } } };
    assert.equal(args[0], 'apply');
    state.active++; state.peak = Math.max(state.peak, state.active);
    try { if (state.beforeApply) await state.beforeApply(args); else await sleep(40); }
    finally { state.active--; }
    return { envelope: { ok: true, data: { isValid: true, accepted: true } } };
  };
  const handlers = new Map();
  registerO11Cycle({ registerTool: (name, config, handler) => handlers.set(name, { config, handler }) }, {
    root, env, lane: 'ss4', bridge, runAnvil, checkRunner: runAnvil, assertSelected: async () => {}, registerTask: false,
    buildRunner: () => args => state.buildRunner ? state.buildRunner(args) : runAnvil(args),
  });
  const call = async (input = {}) => {
    const args = { module: 'Sample', job, authorize: words, ...input };
    const { handler } = handlers.get('o11_deliver');
    return withStudioWriteLock({ tool: 'o11_deliver', args, lane: 'o11', deps: lock, phased: true, deferReservation: true }, () => handler(args));
  };
  const publish = createO11Publish({ root, env, lane: 'ss4', bridge, lock, assertSelected: async () => {} });
  return { root, local, authority, job, env, lock, bridge, state, call, publish };
}

test('speed: four validations of one module overlap, use keyed captures and expose their hash', async t => {
  const f = fixture(t), start = performance.now();
  const replies = await Promise.all(Array.from({ length: 4 }, () => f.call({ until: 'apply' })));
  t.diagnostic(JSON.stringify({ benchmark: 'four validations', wallMs: performance.now() - start, peak: f.state.peak }));
  assert.equal(f.state.peak, 4);
  assert.equal(f.state.open, 0);
  assert.equal(new Set(replies.map(r => r.structuredContent.capture?.path)).size, 4);
  for (const reply of replies) {
    assert.equal(reply.structuredContent.valid, true, JSON.stringify(reply));
    assert.equal(reply.structuredContent.capture.sha256, hash(f.state.model));
  }
});

test('speed: an unavailable validation capture refuses without selecting a tab', async t => {
  const f = fixture(t); f.state.missing = true;
  const reply = await f.call({ until: 'apply' });
  assert.equal(reply.structuredContent.code, 'VALIDATION_CAPTURE_UNAVAILABLE');
  assert.equal(reply.structuredContent.continuation.tool, 'o11_studio');
  assert.equal(f.state.open, 0);
});

test('speed: static refusal returns while a long merge still owns the Studio', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const holder = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample' }, lane: 'o11', deps: f.lock }, async () => { entered.resolve(); await release.promise; });
  await entered.promise; f.state.preflightValid = false;
  try {
    const pending = f.call();
    const reply = await Promise.race([pending, sleep(300).then(() => null)]);
    assert.ok(reply, 'static refusal must not wait for the long merge');
    assert.equal(reply.structuredContent?.code ?? reply.code, 'PREFLIGHT_REFUSED');
    assert.equal(f.state.open, 0);
  } finally { release.resolve(); await holder; }
});

test('speed: compiled kernel preflight refuses malformed syntax without entering the Studio queue', async t => {
  const cli = process.env.SSAM_TEST_COMPILED_CLI;
  if (!cli || !fs.existsSync(cli)) return t.skip('Set SSAM_TEST_COMPILED_CLI to an already compiled kernel; this test never builds one.');
  const f = fixture(t), entered = deferred(), release = deferred();
  fs.writeFileSync(f.job, '{"ops":[null]}');
  const holding = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample' }, lane: 'o11', deps: f.lock }, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try {
    let output;
    try { output = await promisify(execFile)(process.env.SSAM_TEST_DOTNET ?? 'dotnet', [cli, 'check-job', '--job', f.job, '--basis-fresh', 'false'], { windowsHide: true, timeout: 30000, env: process.env }); }
    catch (error) { if (!error.stdout) throw error; output = error; }
    const envelope = JSON.parse(output.stdout.trim());
    assert.equal(envelope.data?.valid ?? envelope.valid, false, JSON.stringify(envelope));
    if (envelope.data?.static?.complete !== true) return t.skip('The compiled kernel predates static.complete; its syntax check ran, but it cannot prove the early-stop contract.');
    f.state.checkRunner = async () => ({ envelope });
    const result = await f.call();
    assert.equal(result.structuredContent?.code ?? result.code, 'PREFLIGHT_REFUSED');
    assert.equal(f.state.open, 0);
  } finally { release.resolve(); await holding; }
});

test('speed: a known reservation times out outside the module guard and Studio queue', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  f.lock.env.SSAM_RESERVATION_QUEUE_MS = '60';
  fs.mkdirSync(path.join(f.authority, 'reservations'));
  fs.writeFileSync(path.join(f.authority, 'reservations', 'held.json'), JSON.stringify({ owner: 'a'.repeat(32), moduleKey: 'Sample', environment: f.state.environment }));
  const holder = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample' }, lane: 'o11', deps: f.lock }, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try {
    const result = await Promise.race([f.call(), sleep(300).then(() => null)]);
    const reply = result?.structuredContent ?? result;
    assert.ok(reply); assert.equal(reply.code, 'MODULE_RESERVED');
    assert.equal(reply.continuation.tool, 'ssam_task');
    assert.ok(reply.waitedMs >= 60); assert.equal(reply.position, 1);
  } finally { release.resolve(); await holder; }
});

test('speed: a reservation created during build is confirmed again before merge', async t => {
  const f = fixture(t); f.lock.env.SSAM_RESERVATION_QUEUE_MS = '30';
  const result = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Sample', job: [] }, lane: 'o11', deps: f.lock, phased: true }, async () => {
    fs.mkdirSync(path.join(f.authority, 'reservations'));
    fs.writeFileSync(path.join(f.authority, 'reservations', 'raced.json'), JSON.stringify({ owner: 'c'.repeat(32), moduleKey: 'Sample' }));
    return enterApplyPhase();
  });
  assert.equal(result.code, 'MODULE_RESERVED');
  assert.ok(!fs.readdirSync(path.join(f.authority, 'studio-locks')).some(name => name.endsWith('.intent')));
});

test('speed: new refusals remain classified in the shared quality registry', () => {
  for (const code of ['PREFLIGHT_UNAVAILABLE', 'PUBLISH_AUTHORIZATION_CHANGED', 'PUBLISH_TARGET_CHANGED', 'VALIDATION_CAPTURE_UNAVAILABLE']) assert.equal(codeOf(code), code);
});

test('speed: builds of one module overlap, only their merge phases serialize', async t => {
  const f = fixture(t); let building = 0, peak = 0, merging = 0, mergePeak = 0;
  const run = () => withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Sample', job: [] }, lane: 'o11', deps: f.lock, phased: true }, async () => {
    building++; peak = Math.max(peak, building); await sleep(40); building--;
    assert.equal((await enterApplyPhase()).ok, true); merging++; mergePeak = Math.max(mergePeak, merging); await sleep(30); merging--;
    return { ok: true };
  });
  await Promise.all([run(), run()]); assert.equal(peak, 2); assert.equal(mergePeak, 1);
});

test('speed: three queued publications share one result after the last pending merge', async t => {
  const f = fixture(t), started = deferred(), release = deferred();
  t.after(() => release.resolve());
  const merge = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Sample', job: [] }, lane: 'o11', deps: f.lock, phased: true }, async () => {
    started.resolve(); await release.promise; await enterApplyPhase(); f.state.order.push('merge');
  });
  await started.promise;
  const publications = Array.from({ length: 3 }, () => f.publish({ module: 'Sample', authorize: words }));
  await sleep(30); assert.equal(f.state.published, 0);
  release.resolve(); await merge;
  const results = await Promise.all(publications);
  assert.equal(f.state.published, 1); assert.deepEqual(f.state.order, ['merge', 'publish']);
  for (const result of results) { assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.note, 'coalesced with 3 requests'); }
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
});

test('speed: different authorization words never join a publication batch', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const holding = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample' }, lane: 'o11', deps: f.lock }, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const calls = [f.publish({ module: 'Sample', authorize: words }), f.publish({ module: 'Sample', authorize: words + ' separately' })];
  await sleep(30); release.resolve(); await holding; const results = await Promise.all(calls);
  assert.equal(f.state.published, 2); assert.ok(results.every(r => !r.coalesced));
});

test('speed: a publication waits for a merge that arrives after it was queued', async t => {
  const f = fixture(t), ready = deferred(), release = deferred(), laterRelease = deferred();
  t.after(() => { release.resolve(); laterRelease.resolve(); });
  const first = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample' }, lane: 'o11', deps: f.lock }, async () => { ready.resolve(); await release.promise; });
  await ready.promise;
  const publication = f.publish({ module: 'Sample', authorize: words }); await sleep(20);
  const later = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Sample', job: [] }, lane: 'o11', deps: f.lock, phased: true }, async () => {
    await laterRelease.promise; await enterApplyPhase(); f.state.order.push('later-merge');
  });
  release.resolve(); await first; await sleep(30); assert.equal(f.state.published, 0);
  laterRelease.resolve(); await later; await publication;
  assert.deepEqual(f.state.order, ['later-merge', 'publish']);
});

test('speed: environment and module-key changes keep queued publications separate', async t => {
  for (const field of ['environment', 'key']) {
    const f = fixture(t), ready = deferred(), release = deferred(); t.after(() => release.resolve());
    const holding = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample' }, lane: 'o11', deps: f.lock }, async () => { ready.resolve(); await release.promise; });
    await ready.promise;
    const first = f.publish({ module: 'Sample', authorize: words }); await sleep(20);
    f.state[field] += '-changed';
    const second = f.publish({ module: 'Sample', authorize: words }); await sleep(20);
    release.resolve(); await holding; const results = await Promise.all([first, second]);
    assert.equal(results[0].code, 'PUBLISH_TARGET_CHANGED'); assert.equal(results[1].ok, true);
    assert.ok(results.every(r => !r.coalesced)); assert.equal(f.state.published, 1);
  }
});

test('speed: cancelling one queued caller keeps the remaining publication alive', async t => {
  const f = fixture(t), ready = deferred(), release = deferred(), abort = new AbortController(); t.after(() => release.resolve());
  const holding = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample' }, lane: 'o11', deps: f.lock }, async () => { ready.resolve(); await release.promise; });
  await ready.promise;
  const cancelled = f.publish({ module: 'Sample', authorize: words }, { signal: abort.signal });
  const remaining = f.publish({ module: 'Sample', authorize: words }); await sleep(20); abort.abort();
  assert.equal((await cancelled).code, 'CANCELLED'); release.resolve(); await holding;
  assert.equal((await remaining).ok, true); assert.equal(f.state.published, 1);
});

test('speed: a completed uncertain publication is never cached or joined by a later call', async t => {
  const f = fixture(t); f.state.publishResult = { published: false };
  const first = await f.publish({ module: 'Sample', authorize: words });
  const second = await f.publish({ module: 'Sample', authorize: words });
  assert.equal(first.outcome, 'uncertain'); assert.equal(second.outcome, 'uncertain');
  assert.equal(f.state.published, 2); assert.ok(!first.coalesced && !second.coalesced);
});

test('speed: ODC publications share only a queued operation with the same live identity and words', async t => {
  const f = fixture(t), ready = deferred(), release = deferred(); t.after(() => release.resolve());
  const manifest = path.join(f.root, 'manifest.json');
  const document = { module: 'Sample', tenant: f.state.environment }; fs.writeFileSync(manifest, JSON.stringify(document));
  const lock = { odcRoot: f.root, queueMs: 1000 };
  const holding = withStudioWriteLock({ tool: 'studio_merge', args: { module: 'Sample', pid: 12345 }, lane: 'odc', deps: lock }, async () => { ready.resolve(); await release.promise; });
  await ready.promise;
  let published = 0;
  const deps = { root: f.root, lab: f.root, lock, readManifest: () => document,
    studio: async args => args[0] === 'status' ? { ok: true, pid: 12345, modules: [{ name: 'Sample', key: 'key', host: f.state.environment }] } : { ok: true },
    publish: async () => { published++; return { ok: true }; } };
  const calls = Array.from({ length: 3 }, () => publishWithGrant({ manifest, authorize: words, pid: 12345 }, deps));
  await sleep(20); assert.equal(published, 0); release.resolve(); await holding;
  const results = await Promise.all(calls); assert.equal(published, 1); assert.ok(results.every(r => r.note === 'coalesced with 3 requests'));
});

test('speed: facade forwards a captured candidate and records kernel revalidation after base drift', async t => {
  const f = fixture(t), work = path.join(f.local, 'work'), task = { id: 'b'.repeat(32) };
  const lane = { work, local: f.local, root: f.root, name: 'ss4' };
  let applied = 0;
  const ctx = { root: f.root, env: f.env, bridge: () => f.bridge, now: () => new Date(),
    buildRunner: () => async args => {
      applied++; const candidate = args[args.indexOf('--out') + 1]; fs.mkdirSync(path.dirname(candidate), { recursive: true }); fs.writeFileSync(candidate, 'candidate');
      fs.writeFileSync(candidate.replace(/\.oml$/, '.result.json'), JSON.stringify({ isValid: true, accepted: true }));
      return { envelope: { ok: true, data: { isValid: true, accepted: true } } };
    } };
  const answer = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Sample', job: [] }, lane: 'o11', deps: f.lock, phased: true }, async () => {
    const built = await buildBeforeApply({ input: { module: 'Sample' }, job: f.job, ctx, lane, task });
    assert.ok(built?.manifest, JSON.stringify(built));
    const manifest = JSON.parse(fs.readFileSync(built.manifest)); assert.equal(manifest.baseModelSha256, hash('initial model'));
    f.state.model = 'changed by a concurrent merge'; await enterApplyPhase();
    // The compiled kernel owns the recheck. The facade must pass the prebuilt manifest intact and preserve its verdict.
    assert.deepEqual(built.args, ['--prebuilt', built.manifest]);
    const revalidated = { envelope: { data: { apply: { prebuilt: { reused: false, reason: 'base-changed' } } } } };
    afterApply(revalidated, built, lane); notePhase({ built: true }); return { ok: true };
  });
  assert.equal(applied, 1); assert.deepEqual(answer.phases.rebased, { reason: 'base-changed' });
});

test('speed: delivery handler sends the prebuilt base to the kernel after concurrent drift and returns its revalidation', async t => {
  const f = fixture(t); let builds = 0, revalidated = 0;
  f.state.buildRunner = async args => {
    builds++;
    const candidate = args[args.indexOf('--out') + 1];
    fs.mkdirSync(path.dirname(candidate), { recursive: true }); fs.writeFileSync(candidate, 'candidate from initial model');
    fs.writeFileSync(candidate.replace(/\.oml$/, '.result.json'), JSON.stringify({ isValid: true, accepted: true }));
    f.state.model = 'model changed by another merge';
    return { envelope: { ok: true, data: { isValid: true, accepted: true } } };
  };
  f.state.deliverKernel = async args => {
    assert.equal(phaseOfCall()?.promoted, true, 'the kernel recheck and merge run under the application lock');
    const manifestPath = args[args.indexOf('--prebuilt') + 1]; assert.ok(manifestPath);
    const candidate = JSON.parse(fs.readFileSync(manifestPath));
    assert.equal(candidate.baseModelSha256, hash('initial model'));
    assert.notEqual(candidate.baseModelSha256, hash(f.state.model));
    // Contract response of PrebuiltCandidate.TryReuse/Apply: reject old base, rebuild, then merge the fresh candidate.
    revalidated++;
    return { envelope: { ok: true, data: { taskId: 'd'.repeat(32), module: 'Sample', delivered: true, writeState: 'applied', stage: 'complete',
      merge: { merged: true }, validation: { newErrors: 0, new: [] },
      apply: { isValid: true, accepted: true, prebuilt: { reused: false, reason: 'base-changed' } }, checks: [], failures: [] } } };
  };
  const reply = await f.call();
  assert.equal(reply.structuredContent?.ok, true, JSON.stringify(reply));
  assert.equal(builds, 1); assert.equal(revalidated, 1);
  assert.deepEqual(reply.structuredContent.phases.rebased, { reason: 'base-changed' });
});
