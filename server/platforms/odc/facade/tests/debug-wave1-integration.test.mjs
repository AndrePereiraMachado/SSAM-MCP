// Wave 1 integration: the shared entries (server/client sessions, debug-run, the O11 runner,
// the inspection CLI and ssam.mjs) wired to the package modules. Offline fakes only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServerSessionManager, serverSessionSchema } from '../debug-server-session.mjs';
import { createClientSessionManager, clientSessionSchema } from '../debug-client-session.mjs';
import { debugRunToolSchema, debugRun, nativeEntrySchema } from '../debug-run.mjs';
import { runInspectionCli } from '../debug-inspection-cli.mjs';
import { scenarioPlan } from '../debug-o11-native-run.mjs';
import { parseO11Assets } from '../debug-o11-native-abi.mjs';
import { typedModelAssets } from './fixtures/debug-o11-typed-model-fixture.mjs';
import { serverCapabilities } from '../debug-server-capabilities.mjs';
import { inputCapabilities } from '../debug-input-capabilities.mjs';
import { o11GatewayEvidence } from '../debug-o11-request-hold.mjs';
import { workspaceRoot } from '../workspace.mjs';

const moduleKey = 'A'.repeat(22), functionKey = 'B'.repeat(22), nodeKey = 'C'.repeat(22);
const firstNative = 'f'.repeat(32), renewedNative = 'e'.repeat(32);
const uuid = '12345678-1234-4234-8234-123456789abc', roleKey = '0f8fad5b-d9cb-469f-a165-70867728950e';
const handle = c => 'pc_' + c.repeat(32);
const scopes = [{ functionKey, nodeKeys: [nodeKey] }];
const serverSchema = serverSessionSchema(debugRunToolSchema), clientSchema = clientSessionSchema(debugRunToolSchema);
const frame = { frame: 0, module: 'Fixture', moduleKey, action: 'Action', functionKey, nodeKey };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function serverHarness(t, { lane = 'odc', run, onDebug, run2, root: given, managerOptions = {}, runFields = {} } = {}) {
  const root = given ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-wave1-server-'));
  const calls = [], internals = [], scopeReads = [], requests = [];
  let status = { ok: true, state: 'connected', pauses: [], events: [] }, starts = 0;
  const h = { root, calls, internals, scopeReads, requests,
    setPauses: (pauses, events = []) => { status = { ...status, pauses, events }; } };
  const debug = async (input, context, internal) => {
    calls.push(input); internals.push(internal);
    const custom = await onDebug?.(input, h);
    if (custom !== undefined) return custom;
    if (input.op === 'start') { starts++; status = { ok: true, state: 'connected', pauses: [], events: [] };
      return { ok: true, state: 'connected', sessionId: starts === 1 ? firstNative : renewedNative, autoContinue: false,
        inspectionMode: 'interactive', expiresAt: new Date(Date.now() + 60000).toISOString() }; }
    if (input.op === 'status') return structuredClone(status);
    if (input.op === 'stop') { status = { ok: true, state: 'stopped' }; return { ok: true, state: 'stopped' }; }
    if (['continue', 'step-into', 'step-over', 'step-out'].includes(input.op)) { status = { ...status, pauses: [] }; return { ok: true }; }
    return { ok: true, metadataBound: true, context: { threadId: input.threadId, eventId: input.eventId, frame: 0, generation: 1, moduleKey, functionKey, nodeKey },
      variables: [] };
  };
  const binding = { lane, moduleKey, functionKey, source: { path: path.join(root, 'source.oml'), sha256: 'a'.repeat(64) } };
  h.prepare = async services => { await services.prepareServerInspection(binding); await services.prepareUser({}, {}); };
  h.start = services => services.debug({ op: 'start', lane, tenant: 'fixture', module: 'Fixture', moduleKey, runtimeUrl: 'https://example.invalid/Fixture/',
    nodeKeys: [nodeKey], seconds: 600, autoContinue: true, trace: { mode: 'step' } });
  const manager = createServerSessionManager({ root, debug, pollMs: 5, o11Runner: () => () => {}, prepareUser: async () => ({ ok: true }),
    run: async (request, context) => { requests.push(request); return run(request, context, h); },
    readScopes: async input => {
      scopeReads.push(input);
      return { evidence: ['native-model'], coverage: [{ moduleKey: input.moduleKey, functionKey: input.scopes[0].functionKey, nodeKey: input.scopes[0].nodeKeys[0],
        previousNodeKey: null, sourceSha256: input.source.sha256, authority: 'installed-model-scope-and-watchability', modelScopeEnumerated: true,
        variableCounts: { session: 1 } }], variables: [{ moduleKey: input.moduleKey, functionKey: input.scopes[0].functionKey, nodeKey: input.scopes[0].nodeKeys[0],
        variableKey: 'D'.repeat(22), name: 'Counter', category: 'session', path: 'Session.Counter', sourceSha256: input.source.sha256 }] };
    }, ...managerOptions });
  h.manager = manager;
  h.begin = async () => {
    h.session = await manager(serverSchema.parse({ op: 'start', scopes,
      run: { op: 'run', lane, module: 'Fixture', action: '@' + functionKey, ...(lane === 'o11' ? { host: 'personal-fixture.outsystemscloud.com' } : { tenant: 'fixture.example' }), ...runFields } }));
    return h.session;
  };
  h.status = () => manager({ op: 'status', sessionId: h.session.sessionId });
  h.until = async (predicate, label) => {
    let result = await h.status();
    for (let i = 0; i < 80 && !predicate(result); i++) result = await manager({ op: 'status', sessionId: h.session.sessionId, afterRevision: result.revision, waitMs: 50 });
    if (!predicate(result)) assert.fail('session did not reach ' + label + ': ' + result.state);
    return result;
  };
  t.after(async () => {
    if (h.session) { await manager({ op: 'stop', sessionId: h.session.sessionId }).catch(() => {});
      await h.until(s => ['completed', 'failed', 'uncertain'].includes(s.state), 'terminal').catch(() => {}); }
    if (!given) fs.rmSync(root, { recursive: true, force: true });
  });
  return h;
}

test('wave1 server schema: private-compare, resume, hold and role cycle admission', () => {
  const ok = v => assert.equal(serverSchema.safeParse(v).success, true, JSON.stringify(v));
  const bad = v => assert.equal(serverSchema.safeParse(v).success, false, JSON.stringify(v));
  ok({ op: 'private-compare', sessionId: uuid, handles: [handle('a'), handle('b')] });
  ok({ op: 'private-compare', sessionId: uuid, handles: [handle('a'), handle('b')], mode: 'identity' });
  ok({ op: 'private-compare', sessionId: uuid, handles: [handle('a')], anchor: 'app-user' });
  for (const patch of [{ handles: [handle('a')] }, { handles: [handle('a'), handle('a')] }, { handles: ['secret', 'other'] },
    { handles: [handle('a'), handle('b')], threadId: 'T', eventId: '1', generation: 1 }, { handles: [handle('a'), handle('b')], value: 'private' },
    { handles: Array.from({ length: 9 }, (_, i) => 'pc_' + String(i).repeat(32)) }])
    bad({ op: 'private-compare', sessionId: uuid, ...patch });
  ok({ op: 'resume', sessionId: uuid, afterRevision: 3 }); bad({ op: 'resume', sessionId: uuid });
  const run = { op: 'run', lane: 'odc', tenant: 'fixture.example', module: 'Fixture', action: '@' + functionKey };
  ok({ op: 'start', run: { ...run, holdBetweenScenarios: true }, scopes });
  bad({ op: 'start', run: { ...run, lane: 'o11', holdBetweenScenarios: true }, scopes });
  bad({ op: 'start', run: { ...run, holdBetweenScenarios: true }, scopes, independentStaticRead: { operationId: uuid, receiptSha256: 'a'.repeat(64),
    debugReceiptSha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64) } });
  ok({ op: 'start', run: { ...run, roleCycle: { roleKey, words: 'Grant the Tester role for one debug run' } }, scopes });
  bad({ op: 'start', run: { ...run, lane: 'o11', roleCycle: { roleKey, words: 'Grant the Tester role for one debug run' } }, scopes });
  // Registry-driven admission keeps the original refusals.
  bad({ op: 'start', run: { ...run, execution: 'rest-wrapper' }, scopes }); bad({ op: 'start', run: { ...run, trace: 'none' }, scopes });
  ok({ op: 'start', run: { ...run, contextMode: 'anonymous' }, scopes });
});

for (const lane of ['o11', 'odc']) test(lane + ': server status advertises capabilities and caps; private-compare returns booleans and ends at stop', async t => {
  const release = deferred(), minted = {};
  const h = serverHarness(t, { lane, run: async (request, { services }, h) => {
    await h.prepare(services); await h.start(services);
    const compare = h.internals.find((_, i) => h.calls[i].op === 'start')?.privateCompare;
    const member = compare.member(firstNative);
    const envelope = value => ({ context: { sessionId: firstNative, platform: lane, runtime: 'server' }, value });
    minted.equal = [member.fingerprint(envelope({ type: 'Scalar', value: '42' })), member.fingerprint(envelope({ type: 'Scalar', value: '42' }))];
    minted.other = member.fingerprint(envelope({ type: 'Scalar', value: '7' }));
    h.setPauses([{ threadId: 'T', eventId: '1', stack: [frame] }]);
    await release.promise; return { ok: true, uncertain: false, credentialsReleased: true };
  } });
  await h.begin();
  const paused = await h.until(s => s.state === 'paused', 'paused');
  assert.deepEqual(paused.capabilities, serverCapabilities(lane));
  assert.deepEqual(paused.inputCapabilities, inputCapabilities(lane, 'server'));
  const equal = await h.manager({ op: 'private-compare', sessionId: h.session.sessionId, handles: minted.equal });
  assert.deepEqual(equal, { ok: true, sessionId: h.session.sessionId, op: 'private-compare', equal: true, bothNonEmpty: true, sameNativeType: true, valueType: 'Scalar', count: 2 });
  const different = await h.manager({ op: 'private-compare', sessionId: h.session.sessionId, handles: [minted.equal[0], minted.other] });
  // The random sessionId may contain "42"; only the rest of the answer must not leak values or digests.
  const { sessionId: _sessionId, ...answer } = different;
  assert.equal(different.equal, false); assert.doesNotMatch(JSON.stringify(answer), /42|"7"|mac|hash/);
  await assert.rejects(h.manager({ op: 'private-compare', sessionId: h.session.sessionId, handles: [minted.equal[0], handle('c')] }),
    /debug_server_session_private_compare_handle_unavailable/);
  await h.manager({ op: 'stop', sessionId: h.session.sessionId }); release.resolve();
  await h.until(s => ['completed', 'failed', 'uncertain'].includes(s.state), 'terminal');
  await assert.rejects(h.manager({ op: 'private-compare', sessionId: h.session.sessionId, handles: minted.equal }), /stale_stop/);
  assert.equal(h.calls.filter(c => c.op === 'stop').length, 1);
});

test('odc: hold between scenarios waits for resume at the current revision, renews the native session and refuses old tokens', async t => {
  const gate1 = deferred(), gate2 = deferred(), events = [];
  const h = serverHarness(t, { runFields: { holdBetweenScenarios: true }, run: async (request, { services }, h) => {
    events.push('hold-requested:' + request.holdBetweenScenarios);
    await h.prepare(services); await h.start(services);
    h.setPauses([{ threadId: 'T', eventId: '1', stack: [frame] }]);
    await gate1.promise;
    h.setPauses([]);
    const stopped = await services.debug({ op: 'stop', sessionId: firstNative }); events.push('stop:' + stopped.state);
    let marks = [];
    services.activeBinding?.({ paused: flag => marks.push(flag), mark: () => {}, release: () => ({}) });
    await services.holdBetweenScenarios({ scenario: 'scenario-1', next: 'scenario-2', notSent: ['second'] });
    events.push('resumed');
    const renewed = await h.start(services); services.nativeSessionRenewed(renewed.sessionId);
    h.setPauses([{ threadId: 'T', eventId: '1', stack: [frame] }]);
    await gate2.promise; h.marks = marks;
    return { ok: true, uncertain: false, credentialsReleased: true };
  } });
  await h.begin();
  const first = await h.until(s => s.state === 'paused', 'first pause');
  assert.equal(h.requests[0].roleCycle, undefined);
  const oldToken = { sessionId: h.session.sessionId, threadId: 'T', eventId: '1', generation: first.pauses[0].generation };
  gate1.resolve();
  const held = await h.until(s => s.state === 'held', 'held');
  assert.deepEqual(held.held.notSent, ['second']);
  await assert.rejects(h.manager({ op: 'resume', sessionId: h.session.sessionId, afterRevision: held.revision - 1 }), /resume_requires_current_held_revision/);
  const resumed = await h.manager({ op: 'resume', sessionId: h.session.sessionId, afterRevision: held.revision });
  assert.equal(resumed.state, 'resuming');
  const second = await h.until(s => s.state === 'paused' && s.nativeSessionId === renewedNative, 'renewed pause');
  assert.deepEqual(second.nativeSessions.map(n => [n.nativeSessionId, n.stopped]), [[firstNative, true]]);
  assert.ok(second.pauses[0].generation > oldToken.generation);
  await assert.rejects(h.manager({ ...oldToken, op: 'read', reference: 'b'.repeat(32) }), /stale_stop/);
  const fresh = await h.manager({ ...oldToken, generation: second.pauses[0].generation, op: 'read', reference: 'b'.repeat(32) });
  assert.equal(fresh.nativeSessionId, renewedNative);
  gate2.resolve();
  const final = await h.until(s => ['completed', 'failed', 'uncertain'].includes(s.state), 'terminal');
  assert.equal(final.state, 'completed');
  assert.deepEqual(events, ['hold-requested:true', 'stop:stopped', 'resumed']);
  assert.deepEqual(h.calls.filter(c => c.op === 'stop').map(c => c.sessionId), [firstNative, renewedNative]);
  assert.ok(h.marks.includes(true));
});

test('odc: stop during a hold cancels without a native start', async t => {
  const outcome = deferred();
  const h = serverHarness(t, { runFields: { holdBetweenScenarios: true }, run: async (request, { services }, h) => {
    await h.prepare(services); await h.start(services);
    await services.debug({ op: 'stop', sessionId: firstNative });
    try { await services.holdBetweenScenarios({ scenario: 'scenario-1', next: 'scenario-2', notSent: ['second'] }); }
    catch (error) { outcome.resolve(error.message); return { ok: false, uncertain: false, state: 'cancelled', notSent: ['second'] }; }
    await h.start(services); return { ok: true, uncertain: false };
  } });
  await h.begin();
  await h.until(s => s.state === 'held', 'held');
  await h.manager({ op: 'stop', sessionId: h.session.sessionId });
  assert.equal(await outcome.promise, 'debug_server_session_cancelled');
  const final = await h.until(s => ['completed', 'failed', 'uncertain'].includes(s.state), 'terminal');
  assert.equal(final.state, 'failed');
  assert.equal(h.calls.filter(c => c.op === 'start').length, 1); assert.equal(h.calls.filter(c => c.op === 'stop').length, 1);
});

test('o11: request hold budget is measured from submission and refuses inspection near the gateway cut', async t => {
  const evidence = path.join(workspaceRoot, ...o11GatewayEvidence.path.split('/'));
  if (!fs.existsSync(evidence)) { t.skip('pinned item13 audit is not present in this checkout'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-wave1-hold-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copy = path.join(root, ...o11GatewayEvidence.path.split('/'));
  fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.copyFileSync(evidence, copy);
  const release = deferred();
  const h = serverHarness(t, { lane: 'o11', root, run: async (request, { services }, h) => {
    await h.prepare(services); await h.start(services);
    await services.beforeServerInvocation({ requestId: 'scenario-0', nativeDeadlineAt: Date.now() + 5000 });
    h.setPauses([{ threadId: 'T', eventId: '1', stack: [frame] }]);
    await release.promise; services.afterServerInvocation?.({ requestId: 'scenario-0' });
    return { ok: true, uncertain: false, credentialsReleased: true };
  } });
  await h.begin();
  const paused = await h.until(s => s.state === 'paused', 'paused');
  assert.equal(paused.requestHold.source, 'native-deadline'); assert.ok(paused.requestHold.budgetMs <= 5000);
  const token = { sessionId: h.session.sessionId, threadId: 'T', eventId: '1', generation: paused.pauses[0].generation };
  await assert.rejects(h.manager({ ...token, op: 'read', reference: 'b'.repeat(32) }), /debug_server_session_request_hold_budget_low/);
  assert.equal((await h.manager({ ...token, op: 'continue' })).ok, true);
  release.resolve();
  await h.until(s => ['completed', 'failed', 'uncertain'].includes(s.state), 'terminal');
});

test('o11: without the pinned gateway evidence the hold is reported unavailable, never invented', async t => {
  const release = deferred();
  const h = serverHarness(t, { lane: 'o11', run: async (request, { services }, h) => {
    await h.prepare(services); await h.start(services);
    await services.beforeServerInvocation({ requestId: 'scenario-0', nativeDeadlineAt: Date.now() + 5000 });
    h.setPauses([{ threadId: 'T', eventId: '1', stack: [frame] }]);
    await release.promise; return { ok: true, uncertain: false, credentialsReleased: true };
  } });
  await h.begin();
  const paused = await h.until(s => s.state === 'paused', 'paused');
  assert.equal(paused.requestHold, undefined); assert.match(paused.requestHoldUnavailable, /^debug_/);
  release.resolve();
});

test('server reads of session values carry cross-stop change flags; locals do not', async t => {
  const done = deferred();
  const h = serverHarness(t, { run: async (request, { services }, h) => {
    await h.prepare(services); await h.start(services);
    h.setPauses([{ threadId: 'T', eventId: '1', stack: [frame] }]);
    return done.promise;
  }, onDebug: (input, h) => {
    const context = { threadId: 'T', eventId: input.eventId, frame: 0, generation: 1, moduleKey, functionKey, nodeKey };
    if (input.op === 'scope') return { ok: true, metadataBound: true, context, variables: [
      { reference: 'b'.repeat(32), category: 'session', moduleKey, variableKey: 'D'.repeat(22), name: 'Counter' },
      { reference: 'c'.repeat(32), category: 'local', moduleKey, variableKey: 'E'.repeat(22), name: 'Tick' }] };
    if (input.op === 'read') return { ok: true, reference: input.reference, context,
      value: { path: input.reference === 'b'.repeat(32) ? 'Session.Counter' : 'Tick', type: 'Integer', value: input.eventId === '1' ? '0' : '-17', valueComplete: true,
        category: input.reference === 'b'.repeat(32) ? 'session' : 'local' } };
    if (input.op === 'continue') {
      if (input.eventId === '1') h.setPauses([{ threadId: 'T', eventId: '2', stack: [frame] }]);
      else { h.setPauses([]); done.resolve({ ok: true, uncertain: false, credentialsReleased: true }); }
      return { ok: true };
    }
  } });
  await h.begin();
  const read = async eventId => {
    const s = await h.until(x => x.pauses?.some(p => p.eventId === eventId), 'stop ' + eventId);
    const token = { sessionId: h.session.sessionId, threadId: 'T', eventId, generation: s.pauses[0].generation };
    await h.manager({ ...token, op: 'scope' });
    const session = await h.manager({ ...token, op: 'read', reference: 'b'.repeat(32) });
    const local = await h.manager({ ...token, op: 'read', reference: 'c'.repeat(32) });
    await h.manager({ ...token, op: 'continue' });
    return { session, local };
  };
  const one = await read('1'), two = await read('2');
  assert.equal(one.session.previousStop, null); assert.equal(one.session.changedSincePreviousStop, null);
  assert.equal(two.session.previousStop, '1'); assert.equal(two.session.changedSincePreviousStop, true);
  assert.equal('changedSincePreviousStop' in two.local, false);
});

test('server lazy scope passes the native frame functionType; a frameless suspension is exposed as reason suspend', async t => {
  const release = deferred();
  const lazyFunction = 'F'.repeat(22), lazyNode = 'G'.repeat(22);
  const h = serverHarness(t, { run: async (request, { services }, h) => {
    await h.prepare(services); await h.start(services);
    h.setPauses([{ threadId: 'S', eventId: '9', stack: [] }], [{ kind: 'paused', reason: 'suspend', stop: { threadId: 'S', eventId: '9', stack: [] } }]);
    await release.promise; return { ok: true, uncertain: false, credentialsReleased: true };
  }, onDebug: input => {
    if (input.op === 'scope') return { ok: true, metadataBound: false, context: { threadId: 'S', eventId: '9', frame: 0, generation: 1, moduleKey,
      functionKey: lazyFunction, nodeKey: lazyNode, functionType: 'NRNodes.WebScreenDataSet' }, variables: [] };
  }, managerOptions: { bindScope: async () => ({ ok: true, metadataBound: true }) } });
  await h.begin();
  const paused = await h.until(s => s.state === 'paused', 'suspended');
  assert.equal(paused.pauses[0].reason, 'suspend');
  await h.manager({ sessionId: h.session.sessionId, threadId: 'S', eventId: '9', generation: paused.pauses[0].generation, op: 'scope' }).catch(() => {});
  assert.deepEqual(h.scopeReads.at(-1).scopes, [{ functionKey: lazyFunction, nodeKeys: [lazyNode], functionType: 'NRNodes.WebScreenDataSet' }]);
  release.resolve();
});

test('odc: run.roleCycle grants before the app-user sign-in, restores after the run and never reaches the runner request', async t => {
  const order = []; let granted = false;
  const access = { role: async key => ({ key, name: 'Tester' }), readRoles: async () => granted ? [roleKey] : [],
    grant: async () => { order.push('grant'); granted = true; return { ok: true }; },
    revoke: async () => { order.push('revoke'); granted = false; return { ok: true }; } };
  const h = serverHarness(t, { runFields: { roleCycle: { roleKey, words: 'Grant the Tester role for one debug run' } },
    managerOptions: { roleCycleAccess: async () => access, prepareUser: async () => { order.push('sign-in:' + granted); return { ok: true }; } },
    run: async (request, { services }) => { await services.prepareUser({ lane: 'odc' }, {}); return { ok: true, uncertain: false, credentialsReleased: true }; } });
  await h.begin();
  const final = await h.until(s => ['completed', 'failed', 'uncertain'].includes(s.state), 'terminal');
  assert.deepEqual(order, ['grant', 'sign-in:true', 'revoke']);
  assert.equal(final.state, 'completed'); assert.equal(final.runResult.roleCycle.restored, true);
  assert.equal(h.requests[0].roleCycle, undefined);
});

test('wave1 client schema: private-compare, mount-lifecycle scopes, role cycle and refused hold', () => {
  const ok = v => assert.equal(clientSchema.safeParse(v).success, true, JSON.stringify(v));
  const bad = v => assert.equal(clientSchema.safeParse(v).success, false, JSON.stringify(v));
  ok({ op: 'private-compare', sessionId: uuid, stop: 1, generation: 1, handles: [handle('a'), handle('b')] });
  bad({ op: 'private-compare', sessionId: uuid, handles: [handle('a'), handle('b')] });
  bad({ op: 'private-compare', sessionId: uuid, stop: 1, generation: 1, handles: [handle('a')] });
  const run = { op: 'run', lane: 'odc', tenant: 'fixture.example', module: 'Fixture', action: '@' + functionKey, trace: 'none' };
  ok({ op: 'start', run: { ...run, lifecycle: 'mounted', words: 'Mount the default screen', acknowledgeEffects: [] }, scopesFrom: 'mount-lifecycle' });
  bad({ op: 'start', run, scopesFrom: 'mount-lifecycle' });
  bad({ op: 'start', run: { ...run, lifecycle: 'mounted' }, scopes, scopesFrom: 'mount-lifecycle' });
  bad({ op: 'start', run: { ...run, lane: 'o11', lifecycle: 'mounted' }, scopesFrom: 'mount-lifecycle' });
  ok({ op: 'start', run: { ...run, roleCycle: { roleKey, words: 'Grant the Tester role for one debug run' } }, scopes });
  bad({ op: 'start', run: { ...run, lane: 'o11', roleCycle: { roleKey, words: 'Grant the Tester role for one debug run' } }, scopes });
  bad({ op: 'start', run: { ...run, holdBetweenScenarios: true }, scopes });
});

function clientHarness(t, { lane = 'odc', mount = false, start = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-wave1-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = 'A'.repeat(22), sha = 'a'.repeat(64), source = { path: path.join(root, 'source.oml'), sha256: sha };
  const handler = 'I'.repeat(22), startNode = 'S'.repeat(22), endNode = 'N'.repeat(22);
  const calls = [], scopeReads = [], trees = []; let configured, resolveRun;
  const completed = new Promise(resolve => { resolveRun = resolve; });
  const native = Object.freeze({
    prepare: async () => ({}), prepareBrowser: async () => ({ prepared: true }), authenticate: async () => ({ authenticated: true }),
    configureInspection: async config => { configured = config; },
    invoke: async () => { configured.onEvent({ kind: 'paused', stop: 1, generation: 1, sessionId: 'native', frame: 0, frames: [] }); return completed; },
    inspection: async input => {
      calls.push(input);
      if (input.op === 'private-compare') return { op: 'private-compare', equal: true, bothNonEmpty: true, sameNativeType: true, valueType: 'Text', count: 2 };
      if (input.op === 'stop') resolveRun({ ok: false, uncertain: true });
      return { sessionId: 'native', stop: 1, generation: 1 };
    }, dispose: async () => {},
  });
  const prepared = { sourceContract: source, ...(mount ? { mount: { views: [{ key: 'V'.repeat(22), handlers: [{ handler: 'OnInitialize', actionKey: handler }] }] } } : {}) };
  const run = async (input, { services }) => {
    const broker = services.broker({});
    try { await broker[mount ? 'prepareBrowser' : 'prepare']({ prepared, binding: { moduleKey: key } });
      await broker.authenticate({ expiresAt: new Date(Date.now() + 25000).toISOString() }); return await broker.invoke({}); }
    finally { await broker.dispose(); }
  };
  const manager = createClientSessionManager({ root, run, odcBroker: () => native,
    readMountTree: async selector => { trees.push(selector); return { key: handler, children: [{ kind: 'StartNode', key: startNode }, { kind: 'EndNode', key: endNode }] }; },
    readScopes: async input => { scopeReads.push(input);
      return { modules: [{ moduleKey: key, sourceSha256: sha }], variables: [], evidence: ['native-model-scope'],
        functionHashes: input.scopes.map(s => ({ moduleKey: key, functionKey: s.functionKey, sourceSha256: sha, debuggerHash: 'H'.repeat(22) })),
        breakpoints: input.scopes.flatMap(s => s.nodeKeys.map(n => key + ':' + n)) }; } });
  const h = { manager, calls, scopeReads, trees, configured: () => configured, handler, startNode, endNode, key };
  h.begin = async () => { h.session = await manager(clientSchema.parse({ op: 'start', ...start,
    run: { op: 'run', lane, tenant: 'fixture.example', module: 'Fixture', action: '@' + key, ...(start.run ?? {}) } })); return h.session; };
  h.until = async (predicate, label) => {
    let result = await manager({ op: 'status', sessionId: h.session.sessionId });
    for (let i = 0; i < 40 && !predicate(result); i++) result = await manager({ op: 'status', sessionId: h.session.sessionId, afterRevision: result.revision, waitMs: 100 });
    if (!predicate(result)) assert.fail('client session did not reach ' + label + ': ' + result.state);
    return result;
  };
  return h;
}

test('client private-compare is forwarded to the paused inspector with only its handles; status advertises client caps', async t => {
  const h = clientHarness(t, { start: { scopes: [{ functionKey: 'A'.repeat(22), nodeKeys: ['B'.repeat(22)] }] } });
  await h.begin();
  const paused = await h.until(s => s.state === 'paused', 'paused');
  assert.deepEqual(paused.inputCapabilities, inputCapabilities('odc', 'client'));
  const result = await h.manager({ op: 'private-compare', sessionId: h.session.sessionId, stop: 1, generation: 1, handles: [handle('a'), handle('b')] });
  assert.equal(result.equal, true);
  assert.deepEqual(h.calls.find(c => c.op === 'private-compare'), { op: 'private-compare', handles: [handle('a'), handle('b')] });
  await h.manager({ op: 'stop', sessionId: h.session.sessionId });
  await h.until(s => ['completed', 'failed', 'uncertain'].includes(s.state), 'terminal');
});

test('client scopesFrom mount-lifecycle derives Start/End breakpoints of declared handlers and reuses that one model read', async t => {
  const h = clientHarness(t, { mount: true, start: { scopesFrom: 'mount-lifecycle', run: { lifecycle: 'mounted', words: 'Mount the default screen', acknowledgeEffects: [] } } });
  await h.begin();
  const paused = await h.until(s => s.state === 'paused', 'paused');
  assert.deepEqual(h.trees, ['@' + h.handler]);
  assert.equal(h.scopeReads.length, 1);
  assert.deepEqual(h.scopeReads[0].scopes, [{ functionKey: h.handler, nodeKeys: [h.startNode, h.endNode] }]);
  assert.deepEqual(h.configured().breakpoints, [h.key + ':' + h.startNode, h.key + ':' + h.endNode]);
  assert.equal(paused.derivedScopes.scopesFrom, 'mount-lifecycle');
  await h.manager({ op: 'stop', sessionId: h.session.sessionId });
  await h.until(s => ['completed', 'failed', 'uncertain'].includes(s.state), 'terminal');
});

test('ssam_debug_run: op locks is read-only, native-entry status/prepare carry inputCapabilities, rest-wrapper is legacy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-wave1-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(debugRunToolSchema.safeParse({ op: 'locks', lane: 'o11' }).success, true);
  const locks = await debugRun({ op: 'locks', lane: 'o11' }, { services: { root } });
  assert.equal(locks.ok, true); assert.equal(locks.readOnly, true); assert.equal(locks.schema, 'ssam-debugger-lock-inventory/1'); assert.deepEqual(locks.locks, []);
  assert.equal(fs.readdirSync(root).length, 0);
  const refused = await debugRun({ op: 'locks', module: 'Fixture' }, { services: { root } });
  assert.equal(refused.ok, false); assert.equal(refused.error, 'debug_locks_field_invalid:module');
  const o11 = await debugRun({ op: 'status', lane: 'o11', host: 'fixture.example', module: 'Fixture', moduleKey, applicationKey: 'J'.repeat(22),
    runtimeUrl: 'https://fixture.example/Fixture/' }, { services: { runO11: async () => ({ ok: true, lane: 'o11' }) } });
  assert.deepEqual(o11.inputCapabilities, { server: inputCapabilities('o11', 'server'), client: inputCapabilities('o11', 'client') });
  const odc = await debugRun({ op: 'status', tenant: 'offline.invalid', module: 'Wave1Absent' }, { services: { journal: async () => {} } });
  assert.equal(odc.inputCapabilities.server.maxBinaryInputBytes, 786432);
  const legacy = await debugRun({ op: 'status', execution: 'rest-wrapper', tenant: 'fixture.invalid', module: 'Fixture' },
    { services: { context: async () => ({ portal: { host: 'fixture.invalid' } }), leasePath: path.join(root, 'absent.json'), journal: async () => {} } });
  assert.equal(legacy.ok, true); assert.match(legacy.legacy, /^LEGACY execution:'rest-wrapper'/);
});

test('ODC native-entry schema accepts holdBetweenScenarios only for an isolated run and never accepts roleCycle', () => {
  const base = { op: 'run', execution: 'native-entry', tenant: 'fixture.example', module: 'Fixture', action: 'Do' };
  assert.equal(nativeEntrySchema.safeParse({ ...base, holdBetweenScenarios: true }).success, true);
  for (const patch of [{ lifecycle: 'mounted' }, { contextMode: 'native-background', launch: { inputs: {} }, words: 'Run timer now' }])
    assert.equal(nativeEntrySchema.safeParse({ ...base, holdBetweenScenarios: true, ...patch }).success, false);
  assert.equal(nativeEntrySchema.safeParse({ ...base, roleCycle: { roleKey, words: 'Grant the Tester role for one debug run' } }).success, false);
});

test('O11 scenario plan types identifiers by their entity base and records by the published schema', () => {
  const parsed = parseO11Assets(typedModelAssets(), 'ShopUI');
  const resolution = { path: [{ name: 'Save' }], bindings: [{ input: 'Order', entryInput: 'Order', controllable: true }, { input: 'OrderId', entryInput: 'OrderId', controllable: true }],
    targetInputs: [{ name: 'Order', modelType: 'ServerEntity:Order', dataType: 'Record' }, { name: 'OrderId', modelType: 'IdentifierType:Order', identifierBase: 'LongInteger' }] };
  const [plan] = scenarioPlan(resolution, { inputs: { Order: { Id: 5 }, OrderId: '42' } }, undefined, { parsed, module: 'ShopUI' });
  assert.deepEqual(plan.values, { Order: { Id: '5' }, OrderId: '42' });
  assert.throws(() => scenarioPlan(resolution, { inputs: { Order: { Nope: 1 } } }, undefined, { parsed, module: 'ShopUI' }), /unknown_attribute:Order\.Nope/);
  assert.throws(() => scenarioPlan({ ...resolution, targetInputs: [resolution.targetInputs[0], { name: 'OrderId', modelType: 'IdentifierType:Order' }] },
    { inputs: { OrderId: '42' } }, undefined, { parsed, module: 'ShopUI' }), /identifier_base_unresolved/);
});

test('inspection CLI routes resume and private-compare through the shared schema', async () => {
  const lines = [{ id: 'r', request: { op: 'resume', sessionId: uuid, afterRevision: 1 } },
    { id: 'c', request: { op: 'private-compare', sessionId: uuid, handles: [handle('a'), handle('b')] } }].map(v => JSON.stringify(v)).join('\n') + '\n';
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); } });
  await runInspectionCli({ runtime: 'server', input: Readable.from([lines]), output });
  const replies = chunks.join('').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies.map(r => [r.id, r.result.error]), [['r', 'debug_server_session_owner_unavailable'], ['c', 'debug_server_session_owner_unavailable']]);
});

test('ssam debug locks prints the read-only inventory of one lane', { timeout: 120000 }, () => {
  const node = process.execPath, ssam = fileURLToPath(new URL('../ssam.mjs', import.meta.url));
  const result = spawnSync(node, [ssam, 'debug', 'locks', '--lane', 'odc'], { encoding: 'utf8', timeout: 110000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(result.stdout);
  assert.equal(inventory.readOnly, true); assert.equal(inventory.lane, 'odc'); assert.ok(inventory.locks.every(l => l.lane === 'odc'));
});
