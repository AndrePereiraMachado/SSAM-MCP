// Wave 2 integration of the shared debugger entries (P11-P20): offline, fakes and temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { debugSchema, parseDebugCli } from '../debug.mjs';
import { headlessDebug } from '../debug-runtime.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
import { createServerSessionManager, serverSessionSchema } from '../debug-server-session.mjs';
import * as runEntry from '../debug-run.mjs';
const { debugRun, debugRunToolSchema, nativeEntrySchema } = runEntry, withServerScopeOwners = (...args) => runEntry.withServerScopeOwners(...args);

const KEY = c => c.repeat(22), moduleKey = KEY('A'), functionKey = KEY('B'), nodeKey = KEY('C'), nativeId = 'a'.repeat(32);
const consumer = KEY('E'), future = () => new Date(Date.now() + 60000).toISOString();
const temp = (t, prefix) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const start = { op: 'start', lane: 'o11', module: 'Fixture', moduleKey, runtimeUrl: 'https://example.invalid/Fixture/', nodeKeys: [nodeKey] };

// ---- debug.mjs ---------------------------------------------------------------------------------------------------
test('read-frame needs the observed stop; maxNodes is read-frame only (1..20000) and text starts at 0', () => {
  const read = { op: 'read-frame', sessionId: nativeId, threadId: 'T', eventId: '1' };
  assert.equal(debugSchema.safeParse(read).success, true);
  assert.equal(debugSchema.safeParse({ ...read, maxNodes: 20000, offset: 3 }).success, true);
  for (const bad of [{ threadId: undefined }, { maxNodes: 20001 }, { maxNodes: 0 }, { textOffset: 5 }])
    assert.equal(debugSchema.safeParse({ ...read, ...bad }).success, false, JSON.stringify(bad));
  assert.equal(debugSchema.safeParse({ op: 'read', sessionId: nativeId, threadId: 'T', eventId: '1', reference: 'b'.repeat(32), maxNodes: 10 }).success, false);
  const cli = parseDebugCli(['read-frame', '--session', nativeId, '--thread-id', 'T', '--event-id', '1', '--max-nodes', '500', '--offset', '2']);
  assert.equal(cli.maxNodes, 500); assert.equal(cli.offset, 2);
});

test('nodeModuleKeys names exactly the nodeKeys with the session module plus at most one partner, start/watch only', () => {
  const owned = { ...start, nodeKeys: [nodeKey, KEY('G')], nodeModuleKeys: { [nodeKey]: moduleKey, [KEY('G')]: consumer } };
  assert.equal(debugSchema.safeParse(owned).success, true);
  assert.equal(debugSchema.safeParse({ ...owned, nodeModuleKeys: { [nodeKey]: moduleKey } }).success, false, 'a node without owner');
  assert.equal(debugSchema.safeParse({ ...owned, nodeModuleKeys: { [nodeKey]: KEY('H'), [KEY('G')]: consumer } }).success, false, 'two partners');
  assert.equal(debugSchema.safeParse({ op: 'status', sessionId: nativeId, nodeModuleKeys: { [nodeKey]: moduleKey } }).success, false);
  const cli = parseDebugCli(['start', '--lane', 'o11', '--module', 'Fixture', '--module-key', moduleKey, '--runtime-url', start.runtimeUrl,
    '--node-keys', nodeKey + ',' + KEY('G'), '--node-module-keys', JSON.stringify(owned.nodeModuleKeys)]);
  assert.deepEqual(cli.nodeModuleKeys, owned.nodeModuleKeys);
});

test('inspection scopes accept the native <key>.#Preparation identity only on O11', () => {
  const inspection = { variables: [], scopes: [{ moduleKey, functionKey: functionKey + '.#Preparation', nodeKey, sourceSha256: 'a'.repeat(64) }] };
  assert.equal(debugSchema.safeParse({ ...start, autoContinue: false, inspection }).success, true);
  assert.equal(debugSchema.safeParse({ ...start, lane: 'odc', tenant: 'fixture', autoContinue: false, inspection }).success, false);
});

// ---- debug-runtime.mjs -------------------------------------------------------------------------------------------
function fakeWorker(receipt, captured) {
  return () => {
    const child = new EventEmitter(), stdout = new EventEmitter(), stdin = new EventEmitter();
    stdout.destroy = () => {}; stdin.destroy = () => {}; child.unref = () => {};
    stdin.end = text => {
      const bootstrap = JSON.parse(text); captured.bootstrap = bootstrap;
      fs.writeFileSync(bootstrap.receiptPath, JSON.stringify({ sessionId: bootstrap.sessionId, lane: 'o11', ...receipt }));
      setImmediate(() => stdout.emit('data', Buffer.from(JSON.stringify({ ok: false }) + '\n')));
    };
    Object.assign(child, { stdout, stdin }); return child;
  };
}
function runtimeServices(root, receipt, captured) {
  // A configured legacy developer sign-in (SSAM_O11_*): the lane F guard (DEBUG_DEVELOPER_AUTH_REQUIRED, port D3) refuses
  // an O11 start with none before the app-user window, and these starts are about the preflight, not the sign-in.
  return { sessionRoot: root, installation: async () => root, worker: async () => path.join(root, 'SSAM.Debugger.dll'), journal: () => {},
    legacyDeveloperAuth: () => true,
    prepareAppUser: async (input, { sessionId }) => ({ ok: true, descriptor: { credentialRef: randomUUID(), binding: appUserBinding(input, sessionId),
      expiresAt: future(), state: 'credentials-entered' } }),
    privateAppUserVault: async (_op, request) => ({ ok: true, binding: request.binding, expiresAt: request.expiresAt, kind: 'credentials', username: 'fixture-user', password: 'fixture-pass' }),
    releaseAppUser: async () => { captured.released = (captured.released ?? 0) + 1; return { ok: true }; },
    spawn: fakeWorker(receipt, captured) };
}
const preflightFailure = { state: 'stopped', startError: 'debug_start_unreachable:preflight',
  transport: { startPhase: 'preparing', stopPhase: 'not-started', startOutcome: 'not-attempted', tokenObtained: false } };

test('a failed read-only preflight before StartDebugSession is known not started: lock and lease released, owners in bootstrap', async t => {
  const root = temp(t, 'ssam-w2-runtime-'), captured = {};
  const owners = { [nodeKey]: moduleKey, [KEY('G')]: consumer };
  const result = await headlessDebug({ ...start, nodeKeys: [nodeKey, KEY('G')], nodeModuleKeys: owners, autoContinue: true, seconds: 60 },
    { services: runtimeServices(root, preflightFailure, captured) });
  assert.equal(result.state, 'stopped'); assert.equal(result.knownNotStarted, true); assert.equal(result.uncertain, false);
  assert.equal(result.transport.startOutcome, 'not-attempted');
  assert.deepEqual(captured.bootstrap.nodeModuleKeys, owners);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, result.sessionId, 'manifest.json'))).breakpointOwners, owners);
  assert.deepEqual(fs.readdirSync(root).filter(f => f.endsWith('.lock')), [], 'target lock released');
  assert.equal(captured.released, 1);
});

test('an attempted start without answer is never classified known-not-started', async t => {
  const root = temp(t, 'ssam-w2-runtime-'), captured = {};
  const result = await headlessDebug({ ...start, autoContinue: true, seconds: 60 }, { services: runtimeServices(root,
    { ...preflightFailure, startError: 'debug_start_failed', transport: { ...preflightFailure.transport, startPhase: 'rest-start', startOutcome: 'attempted' } }, captured) });
  assert.equal(result.state, 'stopped'); assert.equal(result.knownNotStarted, undefined); assert.equal(captured.bootstrap.nodeModuleKeys, undefined);
});

test('read-frame reaches the worker with maxNodes and the root offset, also in a background inspection', async t => {
  const root = temp(t, 'ssam-w2-runtime-'), requests = [];
  for (const [sessionId, extra] of [['1'.repeat(32), {}], ['2'.repeat(32), { backgroundWatch: true, backgroundInspection: { moduleKey, sourceSha256: 'a'.repeat(64) } }]]) {
    fs.mkdirSync(path.join(root, sessionId));
    fs.writeFileSync(path.join(root, sessionId, 'manifest.json'), JSON.stringify({ sessionId, lane: 'o11', lock: path.join(root, 'x.lock'),
      receiptPath: path.join(root, sessionId, 'receipt.json'), ...extra }));
    const result = await headlessDebug({ op: 'read-frame', sessionId, threadId: 'T', eventId: '1', maxNodes: 300, offset: 4 },
      { services: { sessionRoot: root, journal: () => {}, pipeRequest: async (id, request) => { requests.push(request); return { ok: true, values: [], complete: true }; } } });
    assert.equal(result.ok, true);
  }
  for (const request of requests) { assert.equal(request.op, 'read-frame'); assert.equal(request.maxNodes, 300); assert.equal(request.offset, 4); assert.equal(request.textOffset, 0); }
});

// ---- debug-server-session.mjs ------------------------------------------------------------------------------------
const serverSchema = serverSessionSchema(debugRunToolSchema), scopes = [{ functionKey, nodeKeys: [nodeKey] }];
function server(t, o = {}) {
  const root = temp(t, 'ssam-w2-server-'), lane = o.lane ?? 'odc', calls = [], reads = [], events = [], services = {};
  const source = { path: path.join(root, 'source.oml'), sha256: 'a'.repeat(64) };
  let status = { ok: true, state: 'connected', pauses: [], events: [] }, release;
  const done = new Promise(resolve => { release = resolve; });
  const debug = async (input, context) => {
    calls.push({ input, context });
    if (input.op === 'start') return o.start ? o.start(input) : { ok: true, state: 'connected', sessionId: nativeId, autoContinue: false, inspectionMode: 'interactive', expiresAt: future() };
    if (input.op === 'status') return structuredClone(status);
    if (input.op === 'stop') { status = { ok: true, state: 'stopped' }; release({ ok: false, uncertain: true }); return status; }
    if (input.op === 'scope') return { ok: true, metadataBound: true, variables: [{ reference: 'b'.repeat(32), name: 'Result', category: 'output' }],
      context: { threadId: 'T', eventId: '1', frame: 0, generation: 1, moduleKey, functionKey, nodeKey } };
    if (input.op === 'read-frame') return { ok: true, values: [{ reference: 'b'.repeat(32), name: 'Result', category: 'output', value: '1' }], complete: true };
    if (input.op === 'read') return { ok: true, reference: input.reference, value: '1' };
    if (['continue', 'step-into', 'step-over', 'step-out'].includes(input.op)) { status.pauses = []; release({ ok: true, uncertain: false }); return { ok: true }; }
    return { ok: true };
  };
  const pause = { threadId: 'T', eventId: '1', ...(o.fingerprint ? { nativeRequestIdSha256: o.fingerprint } : {}),
    stack: [{ frame: 0, module: 'Fixture', moduleKey, action: 'Action', functionKey, nodeKey }] };
  const run = async (_request, { services: given }) => {
    Object.assign(services, given);
    if (o.subscribe) given.serverInspectionEvents.subscribe(event => events.push({ ...event, paused: given.serverInspectionEvents.paused }));
    await given.prepareServerInspection({ lane, moduleKey, functionKey, source, ...o.binding });
    await given.prepareUser({}, {});
    const started = await given.debug({ op: 'start', lane, ...(lane === 'odc' ? { tenant: 'fixture' } : {}), module: 'Fixture', moduleKey,
      runtimeUrl: 'https://example.invalid/Fixture/', nodeKeys: [nodeKey], seconds: 600, autoContinue: true, trace: { mode: 'step' } });
    if (!started.ok) return { ok: false, uncertain: false };
    status.pauses = [pause];
    return done;
  };
  const manager = createServerSessionManager({ root, run, debug, pollMs: 5, o11Runner: () => () => {}, prepareUser: async () => ({ ok: true }),
    readScopes: async input => { reads.push(input); const scope = input.scopes[0];
      return { evidence: ['native-model'], coverage: input.scopes.map(s => ({ moduleKey: input.moduleKey, functionKey: s.functionKey, nodeKey: s.nodeKeys[0], previousNodeKey: null,
        sourceSha256: input.source.sha256, authority: 'installed-model-scope-and-watchability', modelScopeEnumerated: true, variableCounts: { input: 0, output: 1, local: 0, setting: 0 } })),
        variables: [{ moduleKey: input.moduleKey, functionKey: scope.functionKey, nodeKey: scope.nodeKeys[0], variableKey: KEY('D'), name: 'Result', category: 'output', path: 'Result', sourceSha256: input.source.sha256 }] }; } });
  const begin = async () => manager(serverSchema.parse({ op: 'start', run: { op: 'run', lane, module: 'Fixture', action: '@' + functionKey }, scopes: o.scopes ?? scopes }));
  const until = async (sessionId, predicate, label) => {
    let snapshot = await manager({ op: 'status', sessionId });
    for (let i = 0; i < 60 && !predicate(snapshot); i++) snapshot = await manager({ op: 'status', sessionId, afterRevision: snapshot.revision, waitMs: 200 });
    assert.ok(predicate(snapshot), label + ': ' + snapshot.state + ' ' + (snapshot.error ?? ''));
    return snapshot;
  };
  const terminal = s => ['completed', 'failed', 'uncertain'].includes(s.state);
  return { manager, begin, until, terminal, calls, reads, events, services, source, root,
    cleanup: async sessionId => { await manager({ op: 'stop', sessionId }).catch(() => {}); await until(sessionId, terminal, 'terminal'); } };
}

test('server read-frame is routed with maxNodes/offset, annotated and does not consume the generation; scope carries categories', async t => {
  const h = server(t), session = await h.begin();
  const paused = await h.until(session.sessionId, s => s.state === 'paused', 'paused');
  const token = { sessionId: session.sessionId, threadId: 'T', eventId: '1', generation: paused.pauses[0].generation };
  const scope = await h.manager({ ...token, op: 'scope' });
  assert.ok(scope.notApplicableToRuntime.includes('client')); assert.ok(scope.notApplicableToRuntime.includes('session'));
  assert.equal(scope.notApplicableReasons.session.reason, 'odc-model-refuses-session-variables');
  assert.ok(scope.emptyInModel.includes('setting')); assert.ok(!scope.notEnumerated.includes('setting'));
  const next = { ...token, generation: scope.generation };
  const frame = await h.manager({ ...next, op: 'read-frame', maxNodes: 5000, offset: 2 });
  assert.equal(frame.ok, true); assert.equal(frame.generation, next.generation, 'read-frame keeps the generation');
  const native = h.calls.find(c => c.input.op === 'read-frame').input;
  assert.equal(native.maxNodes, 5000); assert.equal(native.offset, 2); assert.equal(native.sessionId, nativeId);
  // Background values coverage evidence: the scope of the target stop and its reads stay readable.
  const evidence = await h.services.scopeEvidence();
  assert.equal(evidence.length, 1); assert.equal(evidence[0].scopeVariables[0].name, 'Result'); assert.equal(evidence[0].reads.length, 1);
  await h.manager({ ...next, op: 'continue' }); await h.until(session.sessionId, h.terminal, 'terminal');
  assert.equal(serverSchema.safeParse({ op: 'read', ...next, reference: 'b'.repeat(32), maxNodes: 10 }).success, false);
  assert.equal(serverSchema.safeParse({ op: 'read-frame', ...next, maxNodes: 20001 }).success, false);
  assert.equal(serverSchema.safeParse({ op: 'read-frame', ...next, childPath: '.X' }).success, false);
});

test('pause lines keep only a proven native request fingerprint; pause/resume events reach a pause-aware worker', async t => {
  const h = server(t, { fingerprint: 'f'.repeat(64), subscribe: true }), session = await h.begin();
  const paused = await h.until(session.sessionId, s => s.state === 'paused', 'paused');
  await h.manager({ op: 'continue', sessionId: session.sessionId, threadId: 'T', eventId: '1', generation: paused.pauses[0].generation });
  await h.until(session.sessionId, h.terminal, 'terminal');
  const line = h.services.traceRead().find(row => row.eventId === '1');
  assert.equal(line.nativeRequestIdSha256, 'f'.repeat(64)); assert.equal(line.nativeRequestIdProvenance, true); assert.equal(line.requestOwnershipProved, false);
  assert.deepEqual(h.events.map(e => [e.kind, e.paused]).slice(0, 2), [['paused', true], ['resumed', false]]);
});

test('a known-not-started ODC start is a refusal: startRefused, no native id and no second stop', async t => {
  const h = server(t, { start: () => ({ ok: false, state: 'stopped', sessionId: 'b'.repeat(32), knownNotStarted: true, uncertain: false,
    startError: 'debug_start_unreachable:preflight', transport: preflightFailure.transport }) });
  const session = await h.begin(), done = await h.until(session.sessionId, h.terminal, 'terminal');
  assert.equal(done.state, 'failed'); assert.equal(done.nativeSessionId, undefined);
  assert.deepEqual(done.startRefused, { state: 'not-started', knownNotStarted: true, uncertain: false, lockRetained: false, startError: 'debug_start_unreachable:preflight' });
  assert.equal(h.calls.filter(c => c.input.op === 'stop').length, 0);
});

test('ODC consumer-owned breakpoints: runner owner map required, native start carries per-node owners', async t => {
  const consumerScope = { moduleKey: consumer, functionKey: KEY('F'), nodeKeys: [KEY('G')] };
  const root = temp(t, 'ssam-w2-consumer-'), pinned = { path: path.join(root, 'consumer.oml'), sha256: createHash('sha256').update('consumer').digest('hex') };
  fs.writeFileSync(pinned.path, 'consumer');
  const h = server(t, { scopes: [...scopes, consumerScope], binding: { models: [{ moduleKey, source: { path: path.join(root, 'source.oml'), sha256: 'a'.repeat(64) } },
    { moduleKey: consumer, source: pinned }], nodeModuleKeys: { [nodeKey]: moduleKey, [KEY('G')]: consumer } } });
  const session = await h.begin();
  await h.until(session.sessionId, s => s.state === 'paused', 'paused');
  assert.deepEqual(h.services.serverScopeOwners, [{ moduleKey: consumer, nodeKeys: [KEY('G')] }]);
  const native = h.calls.find(c => c.input.op === 'start').input;
  assert.deepEqual(native.nodeKeys, [nodeKey, KEY('G')]); assert.deepEqual(native.nodeModuleKeys, { [nodeKey]: moduleKey, [KEY('G')]: consumer });
  assert.deepEqual(h.reads.map(r => r.moduleKey).sort(), [moduleKey, consumer].sort());
  await h.cleanup(session.sessionId);
});

test('O11 runner-derived callback scopes join the breakpoints; a caller scope naming another callback is refused', async t => {
  const callback = { moduleKey, functionKey: KEY('K'), nodeKeys: [KEY('L')], callback: 'OnAuthentication', kind: 'RestServiceAuthenticationFlow', source: 'runner-derived' };
  const binding = { derivedScopes: [callback], callbackKeys: [moduleKey + ':' + KEY('K'), moduleKey + ':' + KEY('M')], modules: [moduleKey] };
  const h = server(t, { lane: 'o11', binding }), session = await h.begin();
  await h.until(session.sessionId, s => s.state === 'paused', 'paused');
  assert.deepEqual(h.calls.find(c => c.input.op === 'start').input.nodeKeys, [nodeKey, KEY('L')]);
  const read = h.reads.find(r => r.scopes.some(s => s.functionKey === KEY('K')));
  assert.deepEqual(read.scopes.find(s => s.functionKey === KEY('K')).callback, { kind: 'RestServiceAuthenticationFlow', name: 'OnAuthentication' });
  assert.deepEqual(read.callbackFlows, [{ moduleKey, functionKey: KEY('K'), kind: 'RestServiceAuthenticationFlow', callback: 'OnAuthentication' }]);
  await h.cleanup(session.sessionId);
  const foreign = server(t, { lane: 'o11', binding, scopes: [...scopes, { functionKey: KEY('M'), nodeKeys: [KEY('N')] }] });
  const refused = await foreign.until((await foreign.begin()).sessionId, foreign.terminal, 'terminal');
  assert.equal(refused.error, 'debug_o11_native_callback_scope_not_derived'); assert.equal(foreign.calls.some(c => c.input.op === 'start'), false);
});

test('O11 Traditional runner-derived Preparation scopes are bound before the native start', async t => {
  const preparation = KEY('P') + '.#Preparation';
  assert.equal(serverSchema.safeParse({ op: 'start', run: { op: 'run', lane: 'o11', module: 'Fixture', action: '@' + functionKey },
    scopes: [{ functionKey: preparation, nodeKeys: [KEY('Q')] }] }).success, true);
  const h = server(t, { lane: 'o11', binding: { functionKey: preparation,
    derivedScopes: [{ moduleKey, functionKey: preparation, nodeKeys: [KEY('Q')], role: 'screen-preparation', source: 'runner-derived' }] } });
  const session = await h.begin();
  await h.until(session.sessionId, s => s.state === 'paused', 'paused');
  const native = h.calls.find(c => c.input.op === 'start').input;
  assert.deepEqual(native.nodeKeys, [nodeKey, KEY('Q')]);
  assert.ok(native.inspection.scopes.some(s => s.functionKey === preparation));
  await h.cleanup(session.sessionId);
});

test('session admission: O11 Run Now and endpoint-credential have their own rules', () => {
  const run = { op: 'run', lane: 'o11', module: 'Fixture', action: '@' + functionKey };
  const runNow = { ...run, contextMode: 'native-background', trigger: 'service-center-run-now', words: 'Run the fixture Timer once' };
  const ok = r => assert.equal(serverSchema.safeParse({ op: 'start', run: r, scopes }).success, true, JSON.stringify(r));
  const bad = r => assert.equal(serverSchema.safeParse({ op: 'start', run: r, scopes }).success, false, JSON.stringify(r));
  ok(runNow);
  for (const patch of [{ launch: { inputs: {} } }, { inputs: { A: 1 } }, { words: undefined }, { lane: 'odc' }, { trace: 'none' }]) bad({ ...runNow, ...patch });
  ok({ ...run, contextMode: 'endpoint-credential' });
  // Wave 3 (PX02): admitted on both lanes; the runner admits it only for an endpoint entry whose capability needs it.
  ok({ ...run, lane: 'odc', contextMode: 'endpoint-credential' });
  bad({ ...run, lane: 'odc', contextMode: 'endpoint-credential', launch: { inputs: {} } });
  bad({ ...run, contextMode: 'endpoint-credential', trace: 'none' });
});

// ---- debug-run.mjs -----------------------------------------------------------------------------------------------
test('run schemas: navigate only for mounted ODC runs; trigger and endpoint-credential are coordinator fields for O11', async () => {
  const navigate = { screen: '@' + KEY('S'), back: true };
  assert.equal(debugRunToolSchema.safeParse({ op: 'run', navigate, trigger: 'service-center-run-now', contextMode: 'endpoint-credential' }).success, true);
  assert.equal(debugRunToolSchema.safeParse({ op: 'run', navigate: { ...navigate, back: false } }).success, false);
  const entry = { op: 'run', execution: 'native-entry', tenant: 'fixture', module: 'Fixture', action: 'A' };
  assert.equal(nativeEntrySchema.safeParse({ ...entry, lifecycle: 'mounted', navigate }).success, true);
  assert.equal(nativeEntrySchema.safeParse({ ...entry, navigate }).success, false);
  const o11 = { op: 'run', lane: 'o11', host: 'dev.example.test', module: 'Jobs', moduleKey, applicationKey: KEY('Z'), runtimeUrl: 'https://dev.example.test/Jobs/',
    execution: 'native-entry', action: 'Nightly', contextMode: 'native-background', trigger: 'service-center-run-now', words: 'Run once' };
  assert.deepEqual(await debugRun(o11), { ok: false, error: 'debug_o11_run_coordinator_field_requires_server_session' });
  let seen; await debugRun(o11, { services: { runO11: async input => { seen = input; return { ok: true }; } } });
  assert.equal(seen.trigger, 'service-center-run-now');
  await debugRun({ ...o11, trigger: undefined, contextMode: 'endpoint-credential', words: undefined }, { services: { runO11: async input => { seen = input; return { ok: true }; } } });
  assert.equal(seen.contextMode, 'endpoint-credential');
});

test('explicit ODC owners become consumerNodeKeys only for the runner library-reference pair', async () => {
  const library = KEY('L'), base = { binding: { moduleKey: consumer }, traceTarget: async () => ({ nodeKeys: [nodeKey],
    producerTarget: { kind: 'library-reference', producerModuleKey: library } }) };
  assert.equal(withServerScopeOwners(base, undefined), base);
  assert.deepEqual((await withServerScopeOwners(base, [{ moduleKey: consumer, nodeKeys: [KEY('G')] }]).traceTarget()).consumerNodeKeys, [KEY('G')]);
  assert.equal((await withServerScopeOwners(base, [{ moduleKey: library, nodeKeys: [KEY('G')] }]).traceTarget()).consumerNodeKeys, undefined);
  await assert.rejects(withServerScopeOwners(base, [{ moduleKey: KEY('X'), nodeKeys: [KEY('G')] }]).traceTarget(), /debug_odc_native_breakpoint_owner_unqualified/);
  const service = { ...base, traceTarget: async () => ({ nodeKeys: [nodeKey], producerTarget: { kind: 'service-reference', producerModuleKey: library } }) };
  await assert.rejects(withServerScopeOwners(service, [{ moduleKey: library, nodeKeys: [KEY('G')] }]).traceTarget(), /owner_unqualified/);
});
