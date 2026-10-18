// Wave 3 integration of the shared debugger entries (P21-P28, PX02-PX07): offline, fakes and temp folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import { foreignPendingReason } from '../debug-foreign-pending.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServerSessionManager, serverSessionSchema, serverSessionDescription } from '../debug-server-session.mjs';
import { clientSessionSchema } from '../debug-client-session.mjs';
import { debugRunToolSchema, nativeEntrySchema } from '../debug-run.mjs';
import { prepareNativeEntry } from '../debug-odc-native-run.mjs';
import { runOdcNativeEndpoint } from '../debug-odc-native-endpoint-run.mjs';
import { createO11NativeRun } from '../debug-o11-native-run.mjs';
import { endpointCredentialBinding } from '../debug-app-user.mjs';
import { admissionRules, ADAPTERS } from '../debug-adapter-registry.mjs';
import { expandMountLifecycleScopes } from '../debug-odc-mount-scopes.mjs';
import { parseSurfaceProofScript } from '../debug-surface-proof.mjs';
import { restFixture } from './fixtures/debug-native-rest-fixture.mjs';
import { basicFixture } from './fixtures/debug-native-basic-fixture.mjs';

const KEY = c => c.repeat(22), moduleKey = KEY('A'), functionKey = KEY('B'), nodeKey = KEY('C'), nativeId = 'a'.repeat(32), ref = 'b'.repeat(32);
const future = () => new Date(Date.now() + 60000).toISOString();
const temp = (t, prefix) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const serverSchema = serverSessionSchema(debugRunToolSchema), clientSchema = clientSessionSchema(debugRunToolSchema);
const scopes = [{ functionKey, nodeKeys: [nodeKey] }];
const RETAINED = { host: 'personal-2qqw9srv.outsystemscloud.com', moduleKey: 'bf7WCuRy7keTqvquautTGg', operationId: '60aa32e5-1100-4e1f-9d5a-7d74e5bc5ce2' };

// ---- schemas --------------------------------------------------------------------------------------------------------
test('server schema: read-scope fields, verify only on reconcile, portal-wake and endpoint-credential on both lanes', () => {
  const token = { sessionId: randomUUID(), threadId: 'T', eventId: '1', generation: 1 };
  assert.equal(serverSchema.safeParse({ op: 'read-scope', ...token, maxNodes: 20000, depth: 2, textLimit: 100 }).success, true);
  for (const bad of [{ maxNodes: 20001 }, { childPath: '.X' }, { references: [ref] }, { generation: undefined }])
    assert.equal(serverSchema.safeParse({ op: 'read-scope', ...token, ...bad }).success, false, JSON.stringify(bad));
  assert.equal(serverSchema.safeParse({ op: 'reconcile', sessionId: token.sessionId, verify: true }).success, true);
  assert.equal(serverSchema.safeParse({ op: 'status', sessionId: token.sessionId, verify: true }).success, false);
  const wake = { op: 'run', lane: 'odc', module: 'Fixture', action: 'Nightly', contextMode: 'native-background', trigger: 'portal-wake', words: 'Wake the fixture Timer once' };
  const ok = run => assert.equal(serverSchema.safeParse({ op: 'start', run, scopes }).success, true, JSON.stringify(run));
  const bad = run => assert.equal(serverSchema.safeParse({ op: 'start', run, scopes }).success, false, JSON.stringify(run));
  ok(wake);
  for (const patch of [{ words: undefined }, { launch: { inputs: {} } }, { inputs: { A: 1 } }, { workflow: { module: 'Flow' } }, { lane: 'o11' },
    { trace: 'none' }, { contextMode: 'app-user' }]) bad({ ...wake, ...patch });
  ok({ op: 'run', lane: 'odc', module: 'Fixture', action: 'Echo', contextMode: 'endpoint-credential' });
  bad({ op: 'run', lane: 'odc', module: 'Fixture', action: 'Echo', contextMode: 'endpoint-credential', trigger: 'portal-wake' });
  // The credential scheme never comes from the request.
  assert.equal(debugRunToolSchema.safeParse({ op: 'run', contextMode: 'endpoint-credential', credentialScheme: 'basic' }).success, false);
  assert.match(serverSessionDescription(), /read-scope/); assert.match(serverSessionDescription(), /portal-wake/);
});

test('client schema: read-scope fields and interactions only with an ODC mounted run', () => {
  const token = { sessionId: randomUUID(), stop: 1, generation: 1 };
  assert.equal(clientSchema.safeParse({ op: 'read-scope', ...token, maxNodes: 500, textLimit: 65536, detail: 2 }).success, true);
  assert.equal(clientSchema.safeParse({ op: 'read-scope', ...token, maxNodes: 0 }).success, false);
  assert.equal(clientSchema.safeParse({ op: 'scope', ...token, maxNodes: 5 }).success, false);
  const interactions = [{ target: '@' + KEY('W'), event: 'click' }];
  const run = { op: 'run', lane: 'odc', module: 'Fixture', action: 'Home', lifecycle: 'mounted', words: 'Mount in DEV', interactions };
  assert.equal(clientSchema.safeParse({ op: 'start', run, scopes }).success, true);
  assert.equal(clientSchema.safeParse({ op: 'start', run: { ...run, lifecycle: undefined }, scopes }).success, false);
  assert.equal(clientSchema.safeParse({ op: 'start', run: { ...run, lane: 'o11' }, scopes }).success, false);
});

test('run schemas: interactions need mounted; portal-wake trigger needs native-background without launch or inputs', async () => {
  const entry = { op: 'run', execution: 'native-entry', tenant: 'fixture', module: 'Fixture', action: 'A' };
  const interactions = [{ target: 'SaveButton', event: 'click' }];
  assert.equal(nativeEntrySchema.safeParse({ ...entry, lifecycle: 'mounted', interactions }).success, true);
  assert.equal(nativeEntrySchema.safeParse({ ...entry, interactions }).success, false);
  assert.equal(nativeEntrySchema.safeParse({ ...entry, lifecycle: 'mounted', interactions: [{ target: 'Save', event: 'hover' }] }).success, false);
  assert.equal(nativeEntrySchema.safeParse({ ...entry, lifecycle: 'mounted', interactions: Array(11).fill(interactions[0]) }).success, false);
  const wake = { ...entry, contextMode: 'native-background', trigger: 'portal-wake', words: 'Wake once' };
  assert.equal(nativeEntrySchema.safeParse(wake).success, true);
  for (const patch of [{ launch: { inputs: {} } }, { inputs: {} }, { contextMode: 'app-user' }, { lifecycle: 'mounted' }, { words: undefined }])
    assert.equal(nativeEntrySchema.safeParse({ ...wake, ...patch }).success, false, JSON.stringify(patch));
  assert.equal(debugRunToolSchema.safeParse({ op: 'run', trigger: 'portal-wake' }).success, true);
  assert.equal(debugRunToolSchema.safeParse({ op: 'run', trigger: 'other' }).success, false);
  await assert.rejects(prepareNativeEntry({ ...entry, op: 'prepare', interactions, persist: false }, {}), /debug_odc_native_interactions_require_mount/);
});

test('registry: the Portal wake is admitted only with its trigger; the Timer launch plan has its own refusal code', { skip: foreignPendingReason('timer-background') }, () => {
  const rules = admissionRules('odc', 'server');
  assert.deepEqual(rules.admit({ op: 'run', lane: 'odc', contextMode: 'native-background', trigger: 'portal-wake', words: 'go' }).adapters, ['portal-timer-wake']);
  assert.equal(rules.admit({ op: 'run', lane: 'odc', contextMode: 'native-background', words: 'go' }).ok, false);
  const plans = ADAPTERS.filter(r => r.lane === 'o11' && /launch-plan$/.test(r.adapter)).map(r => [r.adapter, r.refusalCode, r.branches]);
  assert.deepEqual(plans, [['background-launch-plan', 'debug_native_background_bpt_original_launcher_contract_required', ['background:process-original-launch']],
    ['timer-launch-plan', 'debug_native_background_timer_original_launcher_contract_required', ['background:timer-original-wake']]]);
});

// ---- debug-server-session.mjs ---------------------------------------------------------------------------------------
function server(t, o = {}) {
  const root = temp(t, 'ssam-w3-server-'), lane = o.lane ?? 'odc', calls = [], reads = [], services = {};
  const source = { path: path.join(root, 'source.oml'), sha256: 'a'.repeat(64) };
  let status = { ok: true, state: 'connected', pauses: [], events: [] }, release;
  const done = new Promise(resolve => { release = resolve; });
  const context = { threadId: 'T', eventId: '1', frame: 0, generation: 1, moduleKey, functionKey, nodeKey };
  const debug = async (input, ctx) => {
    calls.push({ input, context: ctx });
    if (['start', 'watch'].includes(input.op)) return { ok: true, state: 'connected', sessionId: nativeId, autoContinue: false, inspectionMode: 'interactive', expiresAt: future() };
    if (input.op === 'status') return structuredClone(status);
    if (input.op === 'stop') { status = { ok: true, state: 'stopped' }; release(o.result ?? { ok: false, uncertain: true }); return status; }
    if (input.op === 'scope') return { ok: true, metadataBound: true, variables: [{ reference: ref, name: 'Result', category: 'output' }], context };
    if (input.op === 'read-frame') return { ok: true, context, pending: [], values: [{ reference: ref, value: { type: 'Scalar', value: '1' }, children: [], context }] };
    if (['continue', 'step-into', 'step-over', 'step-out'].includes(input.op)) { status.pauses = []; release(o.result ?? { ok: true, uncertain: false }); return { ok: true }; }
    return { ok: true, context };
  };
  const pause = { threadId: 'T', eventId: '1', stack: [{ frame: 0, module: 'Fixture', moduleKey, action: 'Action', functionKey, nodeKey }] };
  const run = async (request, { services: given }) => {
    Object.assign(services, given, { request });
    if (o.beforePrepare) await o.beforePrepare(given, request);
    await given.prepareServerInspection({ lane, moduleKey, functionKey, source, ...o.binding });
    const started = await given.debug(o.watch ? { op: 'watch', lane, tenant: 'fixture', module: 'Fixture', moduleKey, runtimeUrl: 'https://example.invalid/Fixture/',
      nodeKeys: [nodeKey], seconds: 600, autoContinue: true, trace: { mode: 'step' } } : { op: 'start', lane, ...(lane === 'odc' ? { tenant: 'fixture' } : {}),
      module: 'Fixture', moduleKey, runtimeUrl: 'https://example.invalid/Fixture/', nodeKeys: [nodeKey], seconds: 600, autoContinue: true, trace: { mode: 'step' } },
    o.watch ? { backgroundWatch: true } : undefined);
    if (!started.ok) return { ok: false, uncertain: false };
    status.pauses = [pause];
    return done;
  };
  const manager = createServerSessionManager({ root, run, debug, pollMs: 5, o11Runner: () => () => {}, prepareUser: async () => ({ ok: true }),
    readScopes: async input => { reads.push(input);
      return { evidence: ['native-model'], coverage: input.scopes.map(s => ({ moduleKey: input.moduleKey, functionKey: s.functionKey, nodeKey: s.nodeKeys[0], previousNodeKey: null,
        sourceSha256: input.source.sha256, authority: 'installed-model-scope-and-watchability', modelScopeEnumerated: true, variableCounts: { input: 0, output: 1, local: 0, setting: 0 } })),
        variables: input.scopes.map(s => ({ moduleKey: input.moduleKey, functionKey: s.functionKey, nodeKey: s.nodeKeys[0], variableKey: KEY('D'), name: 'Result', category: 'output', path: 'Result', sourceSha256: input.source.sha256 })) }; } });
  const runRequest = { op: 'run', lane, module: 'Fixture', action: '@' + functionKey, ...o.run };
  const begin = async () => manager(serverSchema.parse({ op: 'start', run: runRequest, scopes: o.scopes ?? scopes }));
  const until = async (sessionId, predicate, label) => {
    let snapshot = await manager({ op: 'status', sessionId });
    for (let i = 0; i < 60 && !predicate(snapshot); i++) snapshot = await manager({ op: 'status', sessionId, afterRevision: snapshot.revision, waitMs: 200 });
    assert.ok(predicate(snapshot), label + ': ' + snapshot.state + ' ' + (snapshot.error ?? ''));
    return snapshot;
  };
  const terminal = s => ['completed', 'failed', 'uncertain'].includes(s.state);
  return { manager, begin, until, terminal, calls, reads, services, root,
    cleanup: async sessionId => { await manager({ op: 'stop', sessionId }).catch(() => {}); await until(sessionId, terminal, 'terminal'); } };
}

test('server read-scope: scope then native read-frame in one queued command, complete, generation returned; a stale token is refused', async t => {
  const h = server(t), session = await h.begin();
  const paused = await h.until(session.sessionId, s => s.state === 'paused', 'paused');
  const token = { sessionId: session.sessionId, threadId: 'T', eventId: '1', generation: paused.pauses[0].generation };
  const result = await h.manager(serverSchema.parse({ op: 'read-scope', ...token, maxNodes: 100 }));
  assert.equal(result.sessionId, session.sessionId); assert.equal(result.nativeSessionId, nativeId);
  assert.equal(result.generation, token.generation); assert.equal(result.readFrameUsed, true);
  assert.ok(result.scopeCompleteness, 'scopeCompleteness is computed'); assert.equal(result.budget.exhausted, false);
  assert.deepEqual(h.calls.filter(c => ['scope', 'read-frame', 'read-many', 'read'].includes(c.input.op)).map(c => c.input.op), ['scope', 'read-frame']);
  const frame = h.calls.find(c => c.input.op === 'read-frame').input;
  assert.equal(frame.maxNodes, 100); assert.equal(frame.threadId, 'T'); assert.equal(frame.sessionId, nativeId);
  await assert.rejects(h.manager({ op: 'read-scope', ...token, generation: token.generation + 5 }), /debug_server_session_stale_stop/);
  await h.manager({ op: 'continue', ...token }); await h.until(session.sessionId, h.terminal, 'terminal');
});

test('ODC runner-derived REST callback scopes join the breakpoints; a caller scope naming an underived callback is refused', async t => {
  const callback = { moduleKey, functionKey: KEY('K'), nodeKeys: [KEY('L')], callback: 'OnRequest', kind: 'RestServiceCallbackActionFlow', source: 'runner-derived' };
  const binding = { derivedScopes: [callback], callbackKeys: [moduleKey + ':' + KEY('K'), moduleKey + ':' + KEY('M')], modules: [moduleKey] };
  const h = server(t, { binding }), session = await h.begin();
  await h.until(session.sessionId, s => s.state === 'paused', 'paused');
  const native = h.calls.find(c => c.input.op === 'start').input;
  assert.deepEqual(native.nodeKeys, [nodeKey, KEY('L')]); assert.equal(native.nodeModuleKeys, undefined, 'same-module callbacks carry no explicit owner');
  const read = h.reads.find(r => r.scopes.some(s => s.functionKey === KEY('K')));
  assert.deepEqual(read.scopes.find(s => s.functionKey === KEY('K')).callback, { kind: 'RestServiceCallbackActionFlow', name: 'OnRequest' });
  assert.deepEqual(read.callbackFlows, [{ moduleKey, functionKey: KEY('K'), kind: 'RestServiceCallbackActionFlow', callback: 'OnRequest' }]);
  await h.cleanup(session.sessionId);
  const foreign = server(t, { binding, scopes: [...scopes, { functionKey: KEY('M'), nodeKeys: [KEY('N')] }] });
  const refused = await foreign.until((await foreign.begin()).sessionId, foreign.terminal, 'terminal');
  assert.equal(refused.error, 'debug_odc_native_callback_scope_not_derived'); assert.equal(foreign.calls.some(c => c.input.op === 'start'), false);
});

test('ODC sessions expose the app-user anchor hook and producer parity; never for anonymous runs or O11', async t => {
  const anchor = { kind: 'app-user', lane: 'odc', seal: seal => seal('00000000-0000-4000-8000-000000000001') };
  const h = server(t, { beforePrepare: given => { given.registerAppUserAnchor(anchor); },
    result: { ok: true, uncertain: false, results: [{ name: 's1', ok: true, producerOutputParity: { schema: 'ssam-producer-output-parity/1', complete: false,
      reason: 'producer-end-not-captured', compared: 0, unequal: 0, missing: 0, extra: 0, typeDifferences: 0, parityEqual: false } }] } });
  const session = await h.begin();
  const paused = await h.until(session.sessionId, s => s.state === 'paused', 'paused');
  assert.equal(typeof h.services.producerOutputParity?.begin, 'function'); assert.equal(typeof h.services.producerOutputParity?.compare, 'function');
  await h.manager({ op: 'continue', sessionId: session.sessionId, threadId: 'T', eventId: '1', generation: paused.pauses[0].generation });
  const done = await h.until(session.sessionId, h.terminal, 'terminal');
  assert.equal(done.state, 'completed'); assert.equal(done.producerOutputParity[0].reason, 'producer-end-not-captured');
  assert.equal(JSON.stringify(done).includes('00000000-0000-4000-8000-000000000001'), false, 'the anchor value never reaches the snapshot');
  const anonymous = server(t, { run: { contextMode: 'anonymous' }, beforePrepare: given => given.registerAppUserAnchor(anchor) });
  const refused = await anonymous.until((await anonymous.begin()).sessionId, anonymous.terminal, 'terminal');
  assert.equal(refused.error, 'debug_server_session_anchor_context_refused');
  const o11 = server(t, { lane: 'o11', beforePrepare: given => { assert.equal(given.registerAppUserAnchor, undefined); assert.equal(given.producerOutputParity, undefined); } });
  const o11Session = await o11.begin(); await o11.until(o11Session.sessionId, s => s.state === 'paused', 'paused'); await o11.cleanup(o11Session.sessionId);
});

test('ODC Portal wake: the coordinator admits its background watch without a launch', async t => {
  const h = server(t, { watch: true, run: { contextMode: 'native-background', trigger: 'portal-wake', words: 'Wake the fixture Timer once' } });
  const session = await h.begin();
  await h.until(session.sessionId, s => s.state === 'paused', 'paused');
  const watch = h.calls.find(c => c.input.op === 'start');
  assert.ok(watch, 'the background watch reached the native start'); assert.equal(watch.input.autoContinue, false);
  assert.equal(watch.context.backgroundInspection.functionKey, functionKey);
  await h.cleanup(session.sessionId);
});

test('reconcile: verify is O11 only; a lock retained by user decision is refused before any reconciler check', async t => {
  const h = server(t), dir = path.join(h.root, '.local', 'debugger', 'server-sessions'); fs.mkdirSync(dir, { recursive: true });
  const write = value => { const id = randomUUID(); fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ sessionId: id, ...value })); return id; };
  await assert.rejects(h.manager({ op: 'reconcile', sessionId: write({ lane: 'odc', state: 'uncertain' }), verify: true }), /debug_server_session_reconcile_verify_o11_only/);
  const retained = write({ lane: 'o11', state: 'uncertain', pauses: [], runResult: { operationId: RETAINED.operationId,
    target: { host: RETAINED.host, moduleKey: RETAINED.moduleKey }, error: 'debug_o11_native_login_rejected' } });
  await assert.rejects(h.manager({ op: 'reconcile', sessionId: retained }), /^Error: debug_lock_retained_by_decision$/);
  await assert.rejects(h.manager({ op: 'reconcile', sessionId: retained, verify: true }), /debug_lock_retained_by_decision/);
});

// ---- debug-odc-native-run.mjs / debug-odc-native-endpoint-run.mjs ----------------------------------------------------
function odcRest(t) {
  const f = restFixture('odc', 'None'), root = temp(t, 'ssam-w3-odc-rest-');
  const source = path.join(root, 'published.oml'); fs.writeFileSync(source, f.oml);
  const signature = [{ name: 'Value', key: f.model.tree.children[0].children[0].key, dataType: 'Text', mandatory: true }];
  const readers = { binding: f.binding, sourceContract: { path: source, sha256: f.binding.sourceSha256 },
    resolveTarget: async () => ({ ...f.entry, inputs: signature, closureCalls: [] }), usages: () => [],
    properties: selector => selector === 'RestService:Api' ? { ...f.model.tree, path: selector } : { ...f.model.tree.children[0], path: f.entry.path }, inputs: () => signature };
  return { f, readers, input: { op: 'prepare', lane: 'odc', execution: 'native-entry', tenant: f.binding.tenant, module: 'App', action: f.entry.key,
    inputs: { Value: 'hello' }, contextMode: 'anonymous', trace: 'none', persist: false } };
}

test('ODC prepare: an InternalAccess=Yes endpoint is a typed platform restriction before any GET or dialog', async t => {
  const r = odcRest(t); let gets = 0;
  r.readers.prepareEndpoint = async () => { gets++; throw new Error('debug_native_endpoint_internal_access_only'); };
  const prepared = await prepareNativeEntry(r.input, r.readers);
  assert.equal(prepared.ok, false); assert.equal(prepared.state, 'entry-not-runnable');
  assert.equal(prepared.error, 'debug_native_endpoint_internal_access_only'); assert.equal(prepared.platformRestriction, true);
  assert.equal(prepared.adapter.authentication.platformRestriction, true); assert.equal(gets, 1);
  r.readers.prepareEndpoint = async () => { throw new Error('debug_native_endpoint_other_failure'); };
  await assert.rejects(prepareNativeEntry(r.input, r.readers), /debug_native_endpoint_other_failure/);
});

test('ODC endpoint runner: a qualified ODC Basic binds the Basic scheme in the private dialog target', async t => {
  const b = basicFixture({ lane: 'odc' }), root = temp(t, 'ssam-w3-odc-basic-');
  const source = path.join(root, 'published.oml'); fs.writeFileSync(source, b.oml);
  const readers = { binding: { ...b.binding, tenant: 'dev.example.test' }, sourceContract: { path: source, sha256: b.binding.sourceSha256 } };
  const prepared = { endpointContract: b.contract(), action: { key: b.action.key }, entry: { key: b.action.key, entryKind: 'rest-method' },
    scenarios: [{ name: 'first', inputs: { Value: { value: 'hello' } } }], bindings: [] };
  const prompts = [], sends = [];
  const result = await runOdcNativeEndpoint({ op: 'run', lane: 'odc', execution: 'native-entry', tenant: 'dev.example.test', module: 'Store', action: b.action.key,
    contextMode: 'endpoint-credential', trace: 'none' }, prepared, readers, { root,
    prepareUser: async () => assert.fail('the app-user dialog is not the endpoint credential'),
    prepareEndpointCredential: async (target, { sessionId }) => { prompts.push(target);
      return { ok: true, credentialSource: 'private-dialog', descriptor: { credentialRef: randomUUID(), binding: endpointCredentialBinding(target, sessionId),
        expiresAt: future(), kind: 'endpoint-credential', state: 'credentials-entered', authenticated: false } }; },
    releaseEndpointCredential: async () => ({ ok: true }),
    invokeEndpoint: async args => { sends.push(args); return { ok: true, sent: true, answered: true, uncertain: false, memoryReferencesReleased: true }; } });
  assert.equal(result.ok, true, result.error); assert.equal(prompts.length, 1);
  assert.equal(prompts[0].scheme, 'basic'); assert.deepEqual(prompts[0].headers, ['Authorization']);
  assert.equal(sends[0].context, 'endpoint-credential'); assert.equal(sends[0].descriptor.binding.scheme, 'basic');
  const refusedNeeds = await runOdcNativeEndpoint({ op: 'run', lane: 'odc', execution: 'native-entry', tenant: 'dev.example.test', module: 'Store', action: b.action.key,
    contextMode: 'anonymous', trace: 'none' }, prepared, readers, { root });
  assert.equal(refusedNeeds.error, 'debug_native_endpoint_context_explicit_required'); assert.equal(refusedNeeds.needs.endpointCredential.credentialScheme, 'basic');
});

test('ODC mount-lifecycle scopes include the navigation target handlers', async () => {
  const M = KEY('M'), sha = 'a'.repeat(64), k = (p, i) => (p + String(i).padStart(4, '0')).padEnd(22, 'x').slice(0, 22);
  const view = (v, handlers) => ({ key: k('View', v), handlers: handlers.map((handler, i) => ({ handler, actionKey: k('Act' + v + '_', i) })), absentHandlers: [] });
  const mounted = view(0, ['onReadyEventHandler']), target = view(1, ['onInitializeEventHandler', 'onDestroyEventHandler']);
  const prepared = { sourceContract: { path: 'C:/published/model.oml', sha256: sha }, mount: { screenKey: mounted.key, views: [mounted], navigation: { views: [target, mounted] } } };
  const tree = actionKey => ({ key: actionKey, kind: 'ScreenAction', children: [{ key: k('S' + actionKey.slice(3, 9), 0), kind: 'StartNode', properties: { IsDisabled: 'False' } },
    { key: k('E' + actionKey.slice(3, 9), 0), kind: 'EndNode', properties: { IsDisabled: 'False' } }] });
  const result = await expandMountLifecycleScopes(prepared, async input => ({ modules: [{ moduleKey: input.moduleKey, sourceSha256: sha }], variables: [], evidence: [],
    functionHashes: input.scopes.map(sc => ({ moduleKey: input.moduleKey, functionKey: sc.functionKey, debuggerHash: 'h'.repeat(22), sourceSha256: sha })),
    breakpoints: input.scopes.flatMap(sc => sc.nodeKeys.map(n => input.moduleKey + ':' + n)) }), { readTree: async selector => tree(selector.slice(1)), moduleKey: M, directory: 'C:/session' });
  assert.deepEqual(result.roots.map(r => r.handler), ['onReadyEventHandler', 'onInitializeEventHandler', 'onDestroyEventHandler']);
  assert.equal(result.scopes.length, 3, 'a view in both lists is derived once');
});

test('surface proof: odc_deploy is a write hook only at held, with authorization', () => {
  const words = 'private run words 4711', grant = 'grant hook words 0815';
  const script = hook => ({ schema: 'ssam-debug-surface-proof-script/1', name: 'fake-server', runtime: 'server', lane: 'odc',
    start: { seconds: 600, scopes: [{ functionKey: KEY('F'), nodeKeys: [KEY('N')] }],
      run: { op: 'run', lane: 'odc', module: 'Fixture', action: '@' + KEY('F'), execution: 'native-entry', trace: 'full', holdBetweenScenarios: true, words } },
    expectedStops: { min: 1, max: 1 }, perStop: [{ op: 'scope' }, { op: 'step', kind: 'over' }], hooks: [hook], statusWaitMs: 0, replyTimeoutMs: 3000, cleanupMs: 3000, deadlineMs: 20000 });
  const hook = at => ({ at, tool: 'odc_deploy', arguments: { action: 'apply-configs' }, authorization: grant, authorizationField: 'words' });
  const parse = h => { try { parseSurfaceProofScript(script(h)); return 'ok'; } catch (error) { return error.message; } };
  assert.equal(parse(hook('held')), 'ok');
  assert.match(parse(hook('before-start')), /hook_at/);
  assert.match(parse({ ...hook('held'), authorization: undefined }), /hook_authorization/);
});

// ---- debug-o11-native-run.mjs ---------------------------------------------------------------------------------------
test('O11 native-background on the retained binding is refused before capture; InternalAccess REST is a typed restriction', async t => {
  const root = temp(t, 'ssam-w3-o11-'); let captured = 0;
  const runner = createO11NativeRun({ root, capture: async () => { captured++; throw new Error('capture must not run'); } });
  const retained = await runner({ op: 'prepare', lane: 'o11', host: RETAINED.host, module: 'SSAMDebuggerProbe', moduleKey: RETAINED.moduleKey, applicationKey: KEY('Z'),
    runtimeUrl: 'https://' + RETAINED.host + '/SSAMDebuggerProbe/', action: 'Tick', contextMode: 'native-background', words: 'go' });
  assert.equal(retained.error, 'debug_native_background_binding_retained'); assert.equal(captured, 0);
  const runNow = await runner({ op: 'prepare', lane: 'o11', host: RETAINED.host, module: 'SSAMDebuggerProbe', moduleKey: RETAINED.moduleKey, applicationKey: KEY('Z'),
    runtimeUrl: 'https://' + RETAINED.host + '/SSAMDebuggerProbe/', action: 'Tick', contextMode: 'native-background', trigger: 'service-center-run-now', words: 'go' });
  assert.equal(runNow.error, 'debug_native_background_timer_binding_retained'); assert.equal(captured, 0);
  // InternalAccess=Yes REST endpoint.
  const hash = value => createHash('sha256').update(value).digest('hex');
  const pin = (name, value) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), file = path.join(root, name);
    fs.writeFileSync(file, bytes); return { path: file, sha256: hash(bytes) }; };
  const input = { op: 'prepare', lane: 'o11', host: 'dev.example.test', module: 'Api', moduleKey: KEY('a'), applicationKey: KEY('z'),
    runtimeUrl: 'https://dev.example.test/Api/', action: 'Echo', inputs: { Text: 'hello' }, timeoutSeconds: 30, trace: 'none' };
  const node = (kind, name, id, properties = {}, children = []) => ({ kind, name, key: KEY(id), properties, children,
    childrenTotal: children.length, childrenOmitted: 0, propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [] });
  const action = node('RestServiceAction', 'Echo', 'b', { URL: '/Api/rest/Service/Echo', HTTPMethod: 'POST' }, [
    node('RestServiceActionInput', 'Text', 'c', { ReceiveIn: 'Body', IsMandatory: 'True', DataType: 'BasicType:Text' }), node('StartNode', '', 'e')]);
  action.path = 'RestService:Service/RestServiceAction:Echo';
  const snapshot = pin('published.oml', 'synthetic'); let acquired = 0;
  const rest = createO11NativeRun({ root,
    capture: async target => ({ versionId: 7, target, snapshot, inventoryProof: pin('inventory.json', { host: input.host, capturedAtUtc: new Date().toISOString(),
      modules: [{ Name: 'Api', Key: input.moduleKey, ApplicationKey: input.applicationKey, VersionId: 7, IsActive: true }] }), readings: [{ tree: action }] }),
    assets: async () => { throw Error('REST must not load Reactive AMD assets'); },
    acquireEndpoint: async () => { acquired++; throw new Error('debug_native_endpoint_internal_access_only'); } });
  const refused = await rest(input);
  assert.equal(refused.state, 'entry-not-runnable'); assert.equal(refused.error, 'debug_native_endpoint_internal_access_only');
  assert.equal(refused.platformRestriction, true); assert.equal(refused.entryAbi.authentication.native, 'rest');
  assert.equal(refused.entryAbi.authentication.capability.platformRestriction, true); assert.equal(acquired, 1);
});
