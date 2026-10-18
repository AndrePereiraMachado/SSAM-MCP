// Atritos 3, lane wp (the OML writer pool, 2026-10-07): a phased delivery builds without the Studio lock and takes it at
// its first Studio write (studio-write-lock.mjs "Build and apply phases"). Two deliveries to different modules of the
// same Studio overlap their builds while their applies serialize; two deliveries of the same module are ordered by the
// module guard; a write nested in a build takes the Studio for the rest of the call; a turn that does not come refuses
// with nothing applied. Temporary folders only; no Studio.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as lock from '../studio-write-lock.mjs';

const { withStudioWriteLock, enterApplyPhase, phaseOfCall, studioMoment, notePhase, isPhased, phaseGuard, StudioTurnRefused,
  QUEUE_TIMEOUT_CODE, BUILD_QUEUE_TIMEOUT_CODE } = lock;
const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'pa3-wp-'));
const depsFor = root => ({ o11Root: path.join(root, 'kernel'), odcRoot: path.join(root, 'odc'), o11Lane: 'ss4', connection: () => null });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const files = (dir, ext) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith(ext)).sort() : []);

// A fake delivery: a build of buildMs (no Studio), then the first Studio write, then an apply of applyMs.
function delivery(deps, module, { buildMs = 120, applyMs = 60, log }) {
  return withStudioWriteLock({ tool: 'o11_deliver', args: { module, job: [{ op: 'x' }] }, lane: 'o11', deps, phased: true }, async () => {
    const build = { module, start: Date.now() };
    assert.deepEqual(phaseOfCall(), { promoted: false, tool: 'o11_deliver' }, 'the build runs without the Studio');
    await sleep(buildMs);
    build.end = Date.now(); log.builds.push(build);
    notePhase({ built: true });
    const entered = await enterApplyPhase();
    assert.equal(entered.ok, true);
    const apply = { module, start: Date.now() };
    await sleep(applyMs);
    apply.end = Date.now(); log.applies.push(apply);
    return { ok: true, result: 'delivered', module };
  });
}

test('wp: o11_deliver and studio_deliver (merge) are phased; close, until=apply and the reads are not', () => {
  assert.equal(isPhased('o11_deliver', { module: 'A', job: [] }), true);
  assert.equal(isPhased('o11_deliver', { resume: '0'.repeat(32) }), true, 'resume: its first CLI call takes the Studio');
  assert.equal(isPhased('o11_deliver', { close: { taskId: '0'.repeat(32), reason: 'r' } }), false);
  assert.equal(isPhased('o11_deliver', { module: 'A', until: 'apply' }), false);
  assert.equal(isPhased('studio_deliver', { module: 'A' }), true);
  assert.equal(isPhased('studio_deliver', { module: 'A', until: 'build' }), false, 'until=build is a read');
  assert.equal(isPhased('o11_publish', { module: 'A' }), false);
});

test('wp: two deliveries to different modules of one Studio overlap their builds; their applies never overlap', async () => {
  const deps = depsFor(tmp());
  const log = { builds: [], applies: [] };
  const [a, b] = await Promise.all([delivery(deps, 'Orders', { log }), delivery(deps, 'Customers', { log })]);
  assert.deepEqual([a.result, b.result], ['delivered', 'delivered']);
  assert.ok(overlap(log.builds[0], log.builds[1]), 'the builds ran at the same time: ' + JSON.stringify(log.builds));
  assert.ok(!overlap(log.applies[0], log.applies[1]), 'the applies ran one after the other: ' + JSON.stringify(log.applies));
  for (const answer of [a, b]) {
    assert.ok(answer.phases, JSON.stringify(answer));
    assert.ok(answer.phases.buildMs >= 100, 'buildMs ' + answer.phases.buildMs);
    assert.ok(answer.phases.applyMs >= 50, 'applyMs ' + answer.phases.applyMs);
    assert.equal(typeof answer.phases.queuedMs, 'number');
  }
  const waited = [a, b].find(x => x.queue);
  assert.ok(waited, 'one apply waited for the other in the Studio queue');
  assert.ok(waited.phases.queuedMs >= 30, 'the wait is counted: ' + JSON.stringify(waited.phases));
  assert.deepEqual(files(path.join(deps.o11Root, '.local', 'locks'), '.lock'), []);
  assert.deepEqual(files(path.join(deps.o11Root, '.local', 'locks'), '.guard'), []);
});

test('wp: two deliveries of the same module: the second builds only after the first applied (module guard)', async () => {
  const deps = depsFor(tmp());
  const log = { builds: [], applies: [] };
  const [first, second] = await Promise.all([delivery(deps, 'Orders', { log }), delivery(deps, 'orders', { log })]);
  assert.equal(log.builds.length, 2);
  assert.ok(log.builds[1].start >= log.applies[0].end, 'the second build starts on the module the first one applied: ' + JSON.stringify(log));
  assert.ok(second.phases.moduleQueue, 'the second answer says it waited for the module: ' + JSON.stringify(second.phases));
  assert.equal(first.phases.moduleQueue, undefined);
});

test('wp: a write nested in the build takes the Studio for the rest of the call; a call that never writes holds nothing', async () => {
  const deps = depsFor(tmp());
  const nested = deferred(); const gate = deferred();
  const phased = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [] }, lane: 'o11', deps, phased: true }, async () => {
    // During the build another write of the same Studio runs at once.
    const beside = await withStudioWriteLock({ tool: 'o11_studio', args: { command: 'dismiss-dialog' }, lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => 'beside');
    // A nested Studio write (the select of a capture) is this call's first write.
    const inner = await withStudioWriteLock({ tool: 'o11_studio', args: { command: 'open-module', module: 'A' }, lane: 'o11', deps }, async () => 'opened');
    nested.resolve({ beside, inner, phase: phaseOfCall() });
    await gate.promise;
    return { ok: true, result: 'delivered' };
  });
  const seen = await nested.promise;
  assert.deepEqual([seen.beside, seen.inner, seen.phase.promoted], ['beside', 'opened', true]);
  const blocked = await withStudioWriteLock({ tool: 'o11_studio', args: { command: 'dismiss-dialog' }, lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => 'x');
  assert.equal(blocked.code, QUEUE_TIMEOUT_CODE, 'from its first write the call holds the Studio');
  gate.resolve();
  assert.equal((await phased).result, 'delivered');
});

test('wp: a guarded Studio call whose turn does not come refuses the call with nothing applied (STUDIO_WRITE_QUEUE_TIMEOUT)', async () => {
  const deps = depsFor(tmp());
  const gate = deferred(); const holding = deferred();
  const holder = withStudioWriteLock({ tool: 'o11_publish', args: { module: 'B' }, lane: 'o11', deps }, async () => { holding.resolve(); await gate.promise; return 'published'; });
  await holding.promise;
  let applied = false;
  const merge = phaseGuard(async () => { applied = true; return 'merged'; });
  const answer = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [] }, lane: 'o11', deps: { ...deps, queueMs: 60 }, phased: true }, async () => {
    notePhase({ built: true });
    try { await merge(); return { ok: true, result: 'delivered' }; }
    catch (error) { assert.ok(error instanceof StudioTurnRefused); return { ok: false, error: 'handler saw ' + error.code }; }
  });
  assert.equal(applied, false, 'nothing after the build ran');
  assert.equal(answer.code, QUEUE_TIMEOUT_CODE);
  assert.equal(answer.outcome, 'not-sent');
  assert.equal(answer.holder.tool, 'o11_publish');
  assert.ok(answer.phases && answer.phases.applyMs === 0, JSON.stringify(answer.phases));
  gate.resolve(); await holder;
});

test('wp: the module guard that does not come refuses BUILD_QUEUE_TIMEOUT with the holder and nothing run', async () => {
  const deps = depsFor(tmp());
  const gate = deferred(); const building = deferred();
  const first = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [] }, lane: 'o11', deps, phased: true }, async () => { building.resolve(); await gate.promise; return { ok: true }; });
  await building.promise;
  let ran = false;
  const second = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [] }, lane: 'o11', deps: { ...deps, queueMs: 50 }, phased: true }, async () => { ran = true; return { ok: true }; });
  assert.equal(ran, false);
  assert.deepEqual([second.ok, second.code, second.outcome, second.waitedFor, second.position, second.queueMs], [false, BUILD_QUEUE_TIMEOUT_CODE, 'not-sent', 'module', 1, 50]);
  assert.ok(second.waitedMs >= 50);
  assert.equal(second.continuation.tool, 'o11_studio');
  assert.equal(JSON.stringify(second).includes('"A"'), false, 'never the module name in the answer of the guard');
  gate.resolve(); await first;
});

test('wp: studioMoment takes the Studio for the read only; outside a phased call it just reads', async () => {
  const deps = depsFor(tmp());
  assert.equal(await studioMoment(async () => 'plain'), 'plain');
  const inMoment = deferred(); const release = deferred();
  const call = withStudioWriteLock({ tool: 'studio_deliver', args: { module: 'App', pid: 7 }, lane: 'odc', deps, phased: true }, async () => {
    const read = await studioMoment(async () => { inMoment.resolve(); await release.promise; return 'snapshot'; });
    assert.equal(phaseOfCall().promoted, false, 'the moment gave the Studio back');
    const other = await withStudioWriteLock({ tool: 'studio_merge', args: { pid: 7 }, lane: 'odc', deps: { ...deps, queueMs: 0 } }, async () => 'other merge');
    return { ok: true, read, other };
  });
  await inMoment.promise;
  const during = await withStudioWriteLock({ tool: 'studio_merge', args: { pid: 7 }, lane: 'odc', deps: { ...deps, queueMs: 0 } }, async () => 'x');
  assert.equal(during.code, QUEUE_TIMEOUT_CODE, 'during the moment the Studio is held');
  release.resolve();
  assert.deepEqual(await call, { ok: true, read: 'snapshot', other: 'other merge' });
});

test('wp: a phased call that built stamps its phases into the receipts it named', async () => {
  const root = tmp(); const deps = depsFor(root);
  const receipt = path.join(root, 'evidence', 'deliver-result.json');
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify({ ok: true, module: 'A' }));
  const sidecar = path.join(root, 'task', 'phases.json');
  const answer = await withStudioWriteLock({ tool: 'studio_deliver', args: { module: 'A' }, lane: 'odc', deps, phased: true }, async () => {
    notePhase({ built: true, receipt }); notePhase({ receipt: sidecar });
    await enterApplyPhase();
    return { content: [{ type: 'text', text: 'delivered' }] };
  });
  assert.equal(answer.content[0].text, 'delivered', 'the plain answer stays first');
  const extra = JSON.parse(answer.content[1].text);
  assert.deepEqual(Object.keys(extra.phases).sort(), ['applyMs', 'buildMs', 'queuedMs']);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')).phases, extra.phases);
  assert.deepEqual(JSON.parse(fs.readFileSync(sidecar, 'utf8')).phases, extra.phases);
});

test('wp: without phased:true a delivery holds the Studio for the whole call, as before', async () => {
  const deps = depsFor(tmp());
  const gate = deferred(); const running = deferred();
  const whole = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [] }, lane: 'o11', deps }, async () => { running.resolve(phaseOfCall()); await gate.promise; return 'delivered'; });
  assert.equal(await running.promise, null, 'not a phased call');
  const other = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'B', job: [] }, lane: 'o11', deps: { ...deps, queueMs: 0 } }, async () => 'x');
  assert.equal(other.code, QUEUE_TIMEOUT_CODE);
  gate.resolve(); assert.equal(await whole, 'delivered');
});
