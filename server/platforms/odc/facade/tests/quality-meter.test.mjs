// quality-meter.mjs (design ssam-quality/1 sections 2.7 and 3.5): the call context, the three attribution rules, `shared`
// only for a span given to two calls, a late span dropped, union and kernelOwn of what it hands over, approx above 1024
// spans, the bounds (spans per call, open calls per token, noted answers, the 2 h sweep), kernelStart inside and outside a
// hosted context, the off switch and reset; and the kernel leaves (anvil-cli, anvil-worker, kernel-delivery, lib): one span per
// run, a worker miss and its cold run being one span.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as meter from '../quality-meter.mjs';
import { timesFromSpans } from '../quality-record.mjs';
import { runWithExecutor } from '../executor.mjs';

const TOKEN = 'tok_0000000a1fa0', OTHER = 'tok_0000000b2fb1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let clock = 1_000_000;
const now = () => clock;
test.beforeEach(() => { meter.reset(); clock = 1_000_000; meter.configure({ active: true, now }); });
test.after(() => meter.reset());
const hosted = (tokenId, fn) => runWithExecutor({ hosted: true, tokenId, workspace: '/w', executor: { call: async () => null } }, fn);
const span = (startMs, ms, extra = {}) => ({ cat: 'studio', label: 'o11.bridge:open_module', startMs, ms, ok: true, ...extra });
const times = key => { const c = meter.endCall(key, clock); return c && timesFromSpans(c.spans, { ms: clock - c.beginMs, window: [c.beginMs, clock], approx: c.approx, shared: c.shared }); };

test('the call context follows awaits and timers, and is null outside', async () => {
  assert.equal(meter.currentCall(), null);
  await meter.withCall('s\u00001', async () => {
    assert.equal(meter.currentCall(), 's\u00001');
    await new Promise(r => setTimeout(r, 1));
    assert.equal(meter.currentCall(), 's\u00001');
    await Promise.all([meter.withCall('s\u00002', async () => { await null; assert.equal(meter.currentCall(), 's\u00002'); }), (async () => { await null; assert.equal(meter.currentCall(), 's\u00001'); })()]);
  });
  assert.equal(meter.currentCall(), null);
});

test('rule 1: a span with the key of an open call goes to that call only, even beside other calls of the token', () => {
  meter.beginCall(TOKEN, 'a', clock); meter.beginCall(TOKEN, 'b', clock);
  assert.deepEqual(meter.addSpan(TOKEN, span(clock, 100, { callKey: 'a' })), ['a']);
  clock += 500;
  const a = meter.endCall('a', clock), b = meter.endCall('b', clock);
  assert.equal(a.spans.length, 1); assert.equal(a.shared, false);
  assert.equal(b.spans.length, 0); assert.equal(b.shared, false);
  assert.equal(a.spans[0].callKey, undefined, 'the key is not kept in the span');
});

test('rule 2: a relay span (no key) goes to the call whose kernel run is in progress; two such calls share it', async () => {
  meter.beginCall(TOKEN, 'deliver', clock); meter.beginCall(TOKEN, 'read', clock);
  const end = await hosted(TOKEN, () => meter.withCall('deliver', () => meter.kernelStart({ lane: 'o11' })));
  clock += 100;
  assert.deepEqual(meter.addSpan(TOKEN, span(clock, 300)), ['deliver'], 'the parallel read is not charged');
  clock += 400;
  end();
  // A relay span that started while the run was in progress but was reported after it ended still goes to it.
  assert.deepEqual(meter.addSpan(TOKEN, span(clock - 50, 40)), ['deliver']);
  const deliver = meter.endCall('deliver', clock), read = meter.endCall('read', clock);
  assert.equal(deliver.shared, false); assert.equal(read.shared, false);
  assert.deepEqual(deliver.spans.map(s => s.cat).sort(), ['kernel', 'studio', 'studio']);
  assert.equal(read.spans.length, 0);

  meter.beginCall(TOKEN, 'x', clock); meter.beginCall(TOKEN, 'y', clock);
  const ex = await hosted(TOKEN, () => meter.withCall('x', () => meter.kernelStart({})));
  const ey = await hosted(TOKEN, () => meter.withCall('y', () => meter.kernelStart({})));
  clock += 10;
  assert.deepEqual(meter.addSpan(TOKEN, span(clock, 5)).sort(), ['x', 'y']);
  ex(); ey();
  assert.equal(meter.endCall('x', clock).shared, true);
  assert.equal(meter.endCall('y', clock).shared, true);
});

test('rule 3: without a key and without a kernel run, every call of the token open when the span started', () => {
  meter.beginCall(TOKEN, 'one', clock);
  clock += 10;
  assert.deepEqual(meter.addSpan(TOKEN, span(clock, 5)), ['one'], 'one open call: not shared');
  meter.beginCall(TOKEN, 'two', clock + 20);
  meter.beginCall(OTHER, 'foreign', clock);
  assert.deepEqual(meter.addSpan(TOKEN, span(clock + 10, 5)), ['one'], 'a call that began after the span started is not charged; another token never');
  assert.deepEqual(meter.addSpan(TOKEN, span(clock + 30, 5)).sort(), ['one', 'two']);
  const one = meter.endCall('one', clock + 40), two = meter.endCall('two', clock + 40), foreign = meter.endCall('foreign', clock + 40);
  assert.equal(one.spans.length, 3); assert.equal(one.shared, true);
  assert.equal(two.spans.length, 1); assert.equal(two.shared, true);
  assert.equal(foreign.spans.length, 0); assert.equal(foreign.shared, false);
  assert.deepEqual(meter.addSpan('tok_00000000dead', span(clock, 1)), [], 'a token without calls');
});

test('a span reported after its call ended is dropped', () => {
  meter.beginCall(TOKEN, 'gone', clock);
  meter.endCall('gone', clock + 5);
  assert.deepEqual(meter.addSpan(TOKEN, span(clock, 1, { callKey: 'gone' })), []);
  assert.deepEqual(meter.addSpan(TOKEN, span(clock, 1)), []);
  assert.equal(meter.endCall('gone'), null);
  assert.deepEqual(meter.sizes(), { calls: 0, tokens: 0, notes: 0, runs: 0 });
});

test('what a call hands over gives the union, kernelOwn and rest', async () => {
  meter.beginCall(TOKEN, 'k', clock);
  const end = await hosted(TOKEN, () => meter.withCall('k', () => meter.kernelStart({ lane: 'o11', via: 'worker' })));
  meter.addSpan(TOKEN, { cat: 'studio', label: 'o11.bridge:merge_from_oml', startMs: clock + 2000, ms: 3000, ok: true });
  clock += 10000; end({ via: 'worker' });
  meter.addSpan(TOKEN, { cat: 'transfer', label: 'file.get', startMs: clock, ms: 500, ok: true, bytes: 42, callKey: 'k' });
  clock += 1000;
  const got = times('k');
  assert.deepEqual(got.t, { studio: 3000, transfer: 500, kernel: 10000, kernelOwn: 7000, rest: 500 });
  assert.deepEqual(got.kernel, { runs: 1, cold: 0, worker: 1, ms: 10000 });
  assert.deepEqual(got.agent, { n: 2, failed: 0, bytes: 42, shared: false, top: [['o11.bridge:merge_from_oml', 1, 3000], ['file.get', 1, 500]] });
});

test('kernelStart: no-op outside a hosted context or when off; end runs once; ran:false (a worker miss) leaves no span', async () => {
  meter.beginCall(TOKEN, 'c', clock);
  const outside = meter.withCall('c', () => meter.kernelStart({}));
  assert.equal(outside.noop, true);
  outside();
  const end = await hosted(TOKEN, () => meter.withCall('c', () => meter.kernelStart({ via: 'worker' })));
  end({ ran: false });
  const cold = await hosted(TOKEN, () => meter.withCall('c', () => meter.kernelStart({ via: 'cold' })));
  clock += 50; cold(); cold(); cold({ via: 'worker' });
  const c = meter.endCall('c', clock);
  assert.equal(c.spans.length, 1, 'the miss and the cold run are one span, ended once');
  assert.equal(c.spans[0].via, 'cold'); assert.equal(c.spans[0].ms, 50);
  meter.configure({ active: false });
  assert.equal(hosted(TOKEN, () => meter.kernelStart({})).noop, true);
  meter.beginCall(TOKEN, 'off', clock);
  assert.equal(meter.endCall('off'), null, 'off: no call is opened');
  meter.noteAnswer('off', 't', {}, { content: [], structuredContent: { ok: false, problems: [{ code: 'X_Y' }] } });
  assert.equal(meter.takeAnswer('off'), null);
});

test('more than 1024 spans: approx, the rest aggregated per label (sums only)', () => {
  meter.beginCall(TOKEN, 'busy', clock);
  for (let i = 0; i < 1100; i++) meter.addSpan(TOKEN, { cat: 'transfer', label: 'file.get', startMs: clock + i, ms: 1, ok: i % 100 !== 0, bytes: 10, callKey: 'busy' });
  clock += 2000;
  const c = meter.endCall('busy', clock);
  assert.equal(c.approx, true);
  assert.equal(c.spans.length, 1025);
  const got = timesFromSpans(c.spans, { ms: 2000, approx: true });
  assert.deepEqual(got.agent, { n: 1100, failed: 11, bytes: 11000, shared: false, approx: true, top: [['file.get', 1100, 1100]] });
  assert.deepEqual(got.t, { transfer: 1100, rest: 900 });
});

test('bounds: 64 open calls per token, 1024 noted answers, a 2 h sweep; reset clears everything', () => {
  for (let i = 0; i < 70; i++) meter.beginCall(TOKEN, 'c' + i, clock);
  assert.equal(meter.sizes().calls, 64);
  assert.equal(meter.endCall('c0'), null, 'the oldest open call left first');
  assert.ok(meter.endCall('c69'));
  for (let i = 0; i < 1030; i++) meter.noteAnswer('n' + i, 'o11_deliver', {}, { content: [], structuredContent: { ok: false, problems: [{ code: 'EXPR_UNKNOWN_IDENTIFIER' }] } });
  assert.equal(meter.sizes().notes, 1024);
  assert.equal(meter.takeAnswer('n0'), null);
  const summary = meter.takeAnswer('n1029');
  assert.equal(summary.scan, 'full'); assert.deepEqual(summary.problems.byCode, { EXPR_UNKNOWN_IDENTIFIER: 1 });
  assert.equal(meter.takeAnswer('n1029'), null, 'taken once');
  clock += 2 * 60 * 60 * 1000 + 1;
  meter.beginCall(OTHER, 'fresh', clock);
  assert.deepEqual(meter.sizes(), { calls: 1, tokens: 1, notes: 0, runs: 0 }, 'everything older than 2 h was swept');
  meter.reset();
  assert.deepEqual(meter.sizes(), { calls: 0, tokens: 0, notes: 0, runs: 0 });
  assert.equal(meter.isActive(), false);
});

// ---- the kernel leaves (2.7): each run reports exactly one span, at its leaf; a worker miss and its cold run are one.
const kernelTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-quality-kernel-'));
test.after(() => fs.rmSync(kernelTmp, { recursive: true, force: true }));
let wsCount = 0;
// A hosted context as executor.mjs builds one (workspace, the O11 relay port), enough for the hosted spawn environment.
function hostedContextOf({ relayKey = false } = {}) {
  const workspace = path.join(kernelTmp, 'ws' + (++wsCount));
  fs.mkdirSync(path.join(workspace, 'state', 'relay-authority'), { recursive: true });
  if (relayKey) fs.writeFileSync(path.join(workspace, 'state', 'relay-authority', 'bridge.key'), 'k'.repeat(43));
  return { hosted: true, id: 'ctx' + wsCount, tokenId: TOKEN, customer: 'Cliente Alfa', lanes: ['o11', 'odc'], workspace,
    executor: { call: async () => null, o11Connection: () => ({ port: 4321 }), relayPort: () => 4321 }, o11: { studioDir: null, lane: 'ss4' } };
}
// Runs fn as a tool call of the token runs it (hosted context, call context) and returns the kernel spans it left.
async function kernelSpansOf(fn, options) {
  meter.configure({ now: () => Date.now() });
  const key = 'session\u0000' + JSON.stringify(++wsCount);
  meter.beginCall(TOKEN, key, Date.now());
  const value = await runWithExecutor(hostedContextOf(options), () => meter.withCall(key, fn));
  const spans = meter.endCall(key, Date.now()).spans.filter(s => s.cat === 'kernel');
  return { value, spans };
}
const fakeExecFile = (stdout, ms = 20) => (cmd, argv, options, callback) => { setTimeout(() => callback(null, stdout, ''), ms); return { stdin: null }; };

test('kernel leaf, O11: a worker miss followed by the cold run is one span (cold); a worker that ran is one span (worker)', async () => {
  const { createWorkerFirstRunner } = await import('../anvil-worker.mjs');
  const { createAnvilRunner } = await import('../anvil-cli.mjs');
  let coldRuns = 0;
  const cold = createAnvilRunner({ execFileFn: (...a) => { coldRuns++; return fakeExecFile(JSON.stringify({ ok: true, data: {} }), 30)(...a); } });
  // No relay key in the workspace: the customer's worker cannot be specified, so the request runs nothing there (a miss).
  const missed = await kernelSpansOf(() => createWorkerFirstRunner({ cold, env: {} }, { hostedWorkers: { run: async () => { throw new Error('not reached'); } } })(['inspect', '--x']));
  assert.equal(missed.value.ok, true); assert.equal(coldRuns, 1);
  assert.equal(missed.spans.length, 1, 'one span: ' + JSON.stringify(missed.spans));
  assert.equal(missed.spans[0].via, 'cold'); assert.ok(missed.spans[0].ms >= 20);
  // The pool answers executed:false (another controller's key): ran nothing there, the cold run is the span.
  const refused = await kernelSpansOf(() => createWorkerFirstRunner({ cold, env: {} }, { hostedWorkers: { run: async () => ({ used: true, envelope: { ok: false, executed: false, error: 'key' } }) } })(['inspect']),
    { relayKey: true });
  assert.deepEqual(refused.spans.map(s => s.via), ['cold']); assert.equal(coldRuns, 2);
  // The customer's worker ran it: one span, worker; no cold run.
  const served = await kernelSpansOf(() => createWorkerFirstRunner({ cold, env: {} }, { hostedWorkers: { run: async () => { await sleep(25); return { used: true, envelope: { ok: true, data: {} } }; } } })(['inspect']),
    { relayKey: true });
  assert.equal(served.value.via, 'worker'); assert.equal(coldRuns, 2);
  assert.deepEqual(served.spans.map(s => [s.via, s.ok]), [['worker', true]]); assert.ok(served.spans[0].ms >= 20);
  // Outside a hosted call (stdio, CLI, local mode): no span, the same runner.
  meter.beginCall(TOKEN, 'local', Date.now());
  await meter.withCall('local', () => createAnvilRunner({ root: kernelTmp, execFileFn: fakeExecFile(JSON.stringify({ ok: true })) })(['x'], { cli: path.join(kernelTmp, 'anvil.dll') }));
  assert.equal(meter.endCall('local').spans.length, 0);
});

test('kernel leaf, ODC: apply on the worker or cold, check-job cold, the manifest builder resident or cold; one span each', async () => {
  const { applyKernel, checkJobKernel, requiredFlowLayoutEngine } = await import('../kernel-delivery.mjs');
  const { prepareManifest } = await import('../lib.mjs');
  const cli = path.join(kernelTmp, 'anvil-odc.dll'); fs.writeFileSync(cli, 'cli');
  const base = path.join(kernelTmp, 'base.oml'); fs.writeFileSync(base, 'capture');
  const snapshot = { path: base, sha256: createHash('sha256').update('capture').digest('hex'), developerId: 'dev', host: 'h', moduleKey: 'k', contentSha256: 'c'.repeat(64) };
  const accepted = { ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine } };
  let execs = 0;
  const exec = async () => { execs++; await sleep(20); return { stdout: JSON.stringify(accepted), stderr: '' }; };
  const output = () => { const d = path.join(kernelTmp, 'out' + (++wsCount)); fs.mkdirSync(d, { recursive: true }); return d; };
  const worker = run => ({ ensure: async () => ({ status: { capabilities: ['apply:developer-id'] } }), run });
  const miss = await kernelSpansOf(() => applyKernel({ job: 'job.json', snapshot, output: output() }, { cli, exec, worker: worker(async () => ({ used: false, note: 'miss' })) }));
  assert.equal(miss.value.ok, true, JSON.stringify(miss.value)); assert.equal(miss.value.kernel.via, 'cold'); assert.equal(execs, 1);
  assert.deepEqual(miss.spans.map(s => s.via), ['cold'], 'the miss and the cold apply are one span');
  const onWorker = await kernelSpansOf(() => applyKernel({ job: 'job.json', snapshot, output: output() }, { cli, exec,
    worker: worker(async () => { await sleep(20); return { used: true, envelope: accepted }; }) }));
  assert.equal(onWorker.value.kernel.via, 'worker'); assert.equal(execs, 1);
  assert.deepEqual(onWorker.spans.map(s => [s.via, s.ok]), [['worker', true]]);
  const check = await kernelSpansOf(() => checkJobKernel({ job: 'job.json' }, { cli, exec, worker: null }));
  assert.equal(check.value.ok, true); assert.deepEqual(check.spans.map(s => s.via), ['cold']); assert.equal(execs, 2);
  const manifestArgs = { base: 'snapshots/a.oml', candidate: 'lab/c.oml', output: 'lab/out', feature: 'f', owners: ['x'], changes: ['y'] };
  const resident = await kernelSpansOf(() => prepareManifest(manifestArgs, { resident: async () => { await sleep(20); return { used: true, value: { ok: true, manifest: 'm' } }; }, builder: async () => { throw new Error('not reached'); } }));
  assert.equal(resident.value.manifest, 'm'); assert.deepEqual(resident.spans.map(s => [s.via, s.ok]), [['resident', true]]);
  const fallback = await kernelSpansOf(() => prepareManifest(manifestArgs, { resident: async () => ({ used: false }), builder: async () => { await sleep(20); return { ok: false, error: 'x' }; } }));
  assert.deepEqual(fallback.spans.map(s => [s.via, s.ok]), [['cold', false]], 'a resident miss and the cold builder are one span');
});
