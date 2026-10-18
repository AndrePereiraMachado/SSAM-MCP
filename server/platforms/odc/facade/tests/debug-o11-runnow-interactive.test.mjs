import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runO11TimerRunNowInteractive, runNowStartAdmission, runNowBindingRefused, RUN_NOW_TRIGGER } from '../debug-o11-runnow-interactive.mjs';
import { createO11RequestHold } from '../debug-o11-request-hold.mjs';
import { bindingHash } from '../debug-o11-native-run.mjs';

const key = c => c.repeat(22), sha = v => createHash('sha256').update(v).digest('hex');
const REQUEST = sha('native-request-1');
function fixture(t, over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-runnow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'source.oml'); fs.writeFileSync(file, 'synthetic-timer-model');
  const snapshot = { path: file, sha256: sha(fs.readFileSync(file)) };
  const host = over.host ?? 'dev.example.test', moduleKey = over.moduleKey ?? key('a');
  const target = { host, module: 'Jobs', moduleKey, applicationKey: key('z'), runtimeUrl: 'https://' + host + '/Jobs/' };
  const binding = { lane: 'o11', runtimeUrl: target.runtimeUrl, module: 'Jobs', moduleKey, revision: 7, sourceSha256: snapshot.sha256 };
  const plan = { schema: 'ssam-native-background-entry/1', executable: true, trigger: 'o11-service-center-timer-run', nativeAuthenticationQualified: true,
    binding, entryKey: key('b'), actionKey: key('c'), moduleId: '7', name: 'Nightly', kind: 'Timer' };
  const events = [], report = { state: 'resolving', results: [] }, watches = [];
  const receipt = { operationId: '11111111-2222-4333-8444-555555555555', ok: true, state: 'accepted', executionCompleted: false };
  const f = { root, directory: root, operationId: receipt.operationId, mode: 'full', report, events, watches, save: () => {},
    input: { op: 'run', lane: 'o11', trigger: RUN_NOW_TRIGGER, contextMode: 'native-background', words: 'Run Nightly now once in DEV', timeoutSeconds: 30 },
    target, owner: { target, versionId: 7, snapshot, inventoryProof: {} }, plan,
    traceAction: { key: key('c'), startNodeKey: key('d') }, scopes: { [key('c')]: ['Count'] }, omittedScopeRoots: 0,
    endpointPublicationCheck: async () => events.push('publication'),
    prepareServerInspection: async binding => { assert.equal(binding.functionKey, key('c')); assert.deepEqual(binding.source, snapshot); events.push('prepare-scope'); },
    // Run Now returns at once and the Timer runs on the scheduler thread: no gateway-bound request hold is opened.
    beforeServerInvocation: async info => { assert.equal(info, undefined); events.push('before-send'); },
    debug: async (request, context) => {
      events.push(request.op);
      if (request.op === 'watch') { watches.push(request); assert.deepEqual(context, { backgroundWatch: true, contextMode: 'native-background' });
        return { ok: true, state: 'connected', sessionId: 'e'.repeat(32), inspectionMode: 'interactive', autoContinue: false,
          expiresAt: new Date(Date.now() + 450000).toISOString() }; }
      return { ok: true, state: 'stopped' };
    },
    adapter: { run: async (_plan, request) => { events.push('run-now'); assert.equal(request.context, 'native-background');
      assert.deepEqual(request.inputs, {}); assert.equal(request.authorizationWords, f.input.words);
      return { ok: false, accepted: true, scheduled: true, outcome: 'scheduled', executionCompleted: false, receipt }; } },
    observeBackground: async (_session, functionKey, seconds) => { assert.equal(functionKey, key('c')); assert.ok(seconds > 400 && seconds <= 450); events.push('observe'); },
    traceRead: () => [{ threadId: 'T', eventId: '5', functionKey: key('c'), nativeRequestIdSha256: REQUEST, values: [] },
      { kind: 'thread-end', threadId: 'T', eventId: '9', nativeRequestIdSha256: REQUEST }],
    compactServerMap: rows => rows,
    timerInstance: { baseline: async () => { events.push('baseline'); return { available: true, runs: [] }; },
      observe: async ({ threadOutcome }) => { events.push('correlate'); assert.equal(threadOutcome.requestBound, true);
        return { state: 'correlated', instanceCorrelationProved: true, matchedFingerprint: REQUEST, requestKeySha256: REQUEST,
          outcome: 'completed', executionCompleted: true, newExactTimerRowObserved: true, errorBound: false, newExactRows: 1 }; } },
    ...over.services };
  return f;
}

test('interactive Run Now binds the scope before submission and keeps the fixed debugger deadline without autoContinue', async t => {
  const f = fixture(t), outcome = await runO11TimerRunNowInteractive(f);
  assert.equal(outcome.uncertain, false);
  assert.deepEqual(f.events, ['prepare-scope', 'publication', 'watch', 'baseline', 'publication', 'before-send', 'run-now', 'observe', 'stop', 'correlate']);
  assert.equal(f.watches[0].autoContinue, false); assert.equal(f.watches[0].seconds, 600); assert.deepEqual(f.watches[0].nodeKeys, [key('d')]);
  assert.equal(f.report.serverTrace.inspectionMode, 'interactive'); assert.equal(f.report.serverTrace.stopped, true);
  assert.equal(f.report.state, 'answered'); assert.equal(f.report.results[0].ok, true); assert.equal(f.report.results[0].traceVerified, true);
  assert.equal(f.report.results[0].requests.submitted, 1);
  assert.equal(f.report.background.trigger, RUN_NOW_TRIGGER); assert.equal(f.report.background.launch, undefined);
  assert.equal(f.report.backgroundTrace.requestBound, true);
  assert.equal(f.report.instanceCorrelation.instanceCorrelationProved, true);
  assert.equal(f.report.executionCompleted, true); assert.equal(f.report.background.result.outcome, 'completed');
  // Scheduling, ThreadEnd and completion stay separate fields; identity is never claimed.
  assert.equal(f.report.background.result.scheduled, true); assert.equal(f.report.background.result.requestOwnershipProved, false);
  assert.equal(f.report.background.valuesComplete, false);
});

test('accepted-unverified keeps the lock as uncertain and never re-submits', async t => {
  const f = fixture(t), run = f.adapter.run;
  f.adapter = { run: async (...args) => ({ ...(await run(...args)), accepted: false, scheduled: false, outcome: 'uncertain',
    receipt: { state: 'accepted-unverified', ok: false } }) };
  const outcome = await runO11TimerRunNowInteractive(f);
  assert.equal(outcome.uncertain, true); assert.equal(f.report.uncertain, true); assert.equal(f.report.state, 'uncertain');
  assert.equal(f.events.filter(e => e === 'run-now').length, 1); assert.equal(f.report.serverTrace.stopped, true);
  assert.equal(f.report.executionCompleted, false, 'an uncertain submission never reports completion');
  const thrown = fixture(t); thrown.adapter = { run: async () => { thrown.events.push('run-now'); throw Error('lost'); } };
  await assert.rejects(runO11TimerRunNowInteractive(thrown), /trigger_outcome_uncertain/);
  assert.equal(thrown.report.uncertain, true); assert.equal(thrown.events.filter(e => e === 'run-now').length, 1);
  assert.ok(thrown.events.includes('stop'));
});

test('the blocked Core20261009 and SSAMDebuggerProbe bindings are refused before scope preparation and Run Now', async t => {
  const core = fixture(t, { host: 'personal-2qqw9srv.outsystemscloud.com', moduleKey: 'pVAfAKUEu0qw8Yxu+bBfBw' });
  await assert.rejects(runO11TimerRunNowInteractive(core), /binding_blocked/); assert.deepEqual(core.events, []);
  // The never-list matches the module key on any host, without a registry file.
  const probe = fixture(t, { moduleKey: 'bf7WCuRy7keTqvquautTGg' });
  await assert.rejects(runO11TimerRunNowInteractive(probe), /binding_blocked/); assert.deepEqual(probe.events, []);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-runnow-')); t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  // Callable by the runner before adapter.prepare (no Service Center read for a blocked binding).
  assert.equal(runNowBindingRefused(empty, 'any.example.test', 'bf7WCuRy7keTqvquautTGg'), true);
  assert.equal(runNowBindingRefused(empty, 'dev.example.test', 'pVAfAKUEu0qw8Yxu+bBfBw'), true);
  assert.equal(runNowBindingRefused(empty, 'dev.example.test', key('a')), false);
  const registry = fixture(t), folder = path.join(registry.root, '.local', 'debugger', 'blocked-bindings');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, bindingHash(registry.target.host, registry.target.moduleKey) + '.json'), JSON.stringify({ operationId: 'x' }));
  await assert.rejects(runO11TimerRunNowInteractive(registry), /binding_blocked/); assert.deepEqual(registry.events, []);
});

test('Run Now refuses launch, inputs, missing words and a non-interactive watch before submission', async t => {
  for (const change of [{ launch: { contextMode: 'app-user', inputs: {} } }, { inputs: { A: 1 } }, { trigger: 'other' }, { contextMode: 'app-user' }]) {
    const f = fixture(t); Object.assign(f.input, change);
    await assert.rejects(runO11TimerRunNowInteractive(f), /run_now_contract_invalid/); assert.deepEqual(f.events, []);
  }
  const words = fixture(t); delete words.input.words;
  await assert.rejects(runO11TimerRunNowInteractive(words), /explicit_background_authorization_required/);
  assert.deepEqual(words.events, ['prepare-scope']);
  const prepared = fixture(t); prepared.input.op = 'prepare';
  assert.equal((await runO11TimerRunNowInteractive(prepared)).uncertain, false); assert.equal(prepared.report.state, 'prepared');
  assert.deepEqual(prepared.events, ['prepare-scope']);
  const auto = fixture(t), debug = auto.debug;
  auto.debug = async (request, context) => { const r = await debug(request, context); return request.op === 'watch' ? { ...r, autoContinue: true } : r; };
  await assert.rejects(runO11TimerRunNowInteractive(auto), /interactive_deadline_invalid/);
  assert.equal(auto.events.includes('run-now'), false); assert.ok(auto.events.includes('stop'));
  const noBaseline = fixture(t); noBaseline.timerInstance.baseline = async () => ({ available: false, reason: 'incomplete-log-list' });
  await assert.rejects(runO11TimerRunNowInteractive(noBaseline), /timer_instance_baseline_unavailable/);
  assert.equal(noBaseline.events.includes('run-now'), false); assert.equal(noBaseline.report.uncertain, false);
});

test('values coverage comes from native scope evidence and is never forced', async t => {
  const ctx = eventId => ({ runtime: 'server', threadId: 'T', eventId, generation: 1 });
  const value = over => ({ reference: 'r1', path: 'Count', category: 'local', type: 'Scalar', value: '1', textOffset: 0, textLength: 1, nextTextOffset: null,
    valueComplete: true, redacted: false, unavailable: false, undefined: false, trimmed: false, deferred: false, nativeSummary: false, hasChildren: false, ...over });
  const f = fixture(t, { services: { scopeEvidence: async () => [{ scopeVariables: [{ reference: 'r1', name: 'Count', category: 'local' }],
    reads: [{ ok: true, context: ctx('5'), reference: 'r1', value: value(), children: [], offset: 0, nextOffset: null, availableChildren: 0 }] }] } });
  await runO11TimerRunNowInteractive(f);
  assert.equal(f.report.background.valuesComplete, true); assert.equal(f.report.results[0].valuesCoverage.roots[0].state, 'complete');
  const g = fixture(t); await runO11TimerRunNowInteractive(g);
  assert.equal(g.report.background.valuesComplete, false); assert.equal(g.report.results[0].valuesCoverage.reason, 'native_scope_reads_unavailable');
});

test('server-session start admission accepts O11 Run Now only with words and without launch or inputs', () => {
  const run = { op: 'run', lane: 'o11', execution: 'native-entry', trace: 'full', contextMode: 'native-background', trigger: RUN_NOW_TRIGGER, words: 'Run once' };
  assert.equal(runNowStartAdmission(run).ok, true);
  for (const change of [{ words: ' ' }, { words: undefined }, { launch: { contextMode: 'app-user', inputs: {} } }, { inputs: { A: 1 } },
    { scenarios: [{ inputs: {} }] }, { lane: 'odc' }, { trace: 'nodes' }, { contextMode: 'app-user' }, { op: 'prepare' }])
    assert.equal(runNowStartAdmission({ ...run, ...change }).ok, false, JSON.stringify(change));
  assert.equal(runNowStartAdmission({ ...run, trigger: undefined }).ok, false);
});

test('Run Now opens no gateway request hold: later scope reads stay admitted on a cloud host', async t => {
  let clock = 1_000_000;
  const hold = createO11RequestHold({ host: 'personal-2qqw9srv.outsystemscloud.com', now: () => clock });
  const f = fixture(t, { services: {
    // Mirrors debug-server-session.mjs: a requestId plus nativeDeadlineAt opens the hold; nothing ever closes it here.
    beforeServerInvocation: async info => { if (typeof info?.requestId === 'string' && Number.isFinite(info.nativeDeadlineAt))
      hold.submitted({ requestId: info.requestId, at: clock, nativeDeadlineAt: clock + 450000 }); },
    observeBackground: async () => { clock += 45000; } } });
  await runO11TimerRunNowInteractive(f);
  assert.equal(hold.snapshot(), null); assert.deepEqual(hold.classify('read'), { allowed: true }); assert.deepEqual(hold.classify('scope'), { allowed: true });
});

test('the debugger is stopped before the Service Center correlation, so the poll never outlives the native lease', async t => {
  const f = fixture(t), observe = f.timerInstance.observe;
  f.timerInstance.observe = async args => { assert.ok(f.events.includes('stop'), 'stopped first'); assert.equal(f.report.serverTrace.stopped, true); return observe(args); };
  const outcome = await runO11TimerRunNowInteractive(f);
  assert.equal(outcome.uncertain, false); assert.equal(f.events.filter(e => e === 'stop').length, 1);
  assert.equal(f.report.executionCompleted, true);
  // A failed stop keeps the run uncertain; correlation (read-only) still runs once and never upgrades it.
  const g = fixture(t), debug = g.debug;
  g.debug = async (request, context) => request.op === 'stop' ? (g.events.push('stop'), { ok: false, state: 'unknown' }) : debug(request, context);
  assert.equal((await runO11TimerRunNowInteractive(g)).uncertain, true);
  assert.equal(g.events.filter(e => e === 'stop').length, 1); assert.equal(g.report.executionCompleted, false); assert.equal(g.report.state, 'uncertain');
});
