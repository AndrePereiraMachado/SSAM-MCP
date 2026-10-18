import './fixtures/isolated-profile.mjs';
import { foreignImport, gatedTest } from './fixtures/debug-foreign-gate.mjs';
import { foreignPendingReason } from '../debug-foreign-pending.mjs';
// Port D7: timer-background pending in the consolidation; the tests that reach it skip by name (fixtures/debug-foreign-gate.mjs).
const test = gatedTest(undefined, foreignPendingReason('timer-background')); // every test runs the original wake/workflow runner
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { debugRun, debugRunToolSchema, nativeEntrySchema } from '../debug-run.mjs';
import { prepareNativeEntry } from '../debug-odc-native-run.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
const { runOdcWorkflowEvent, observeOdcWorkflow } = await foreignImport('../debug-odc-workflow-run.mjs', import.meta.url, 'timer-background');

const source = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-odc-workflow-native-reading.json', import.meta.url)));
const SERVICE = 'YtJpu_pKR0a2xAv3zsPA_A', EMITTER = '5QuK3N0Ox0qmhouoNbTXIQ', EVENT = 'oH6LwRgokka+eFKXJ+jdTQ';
const FP = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const flatten = node => [node, ...node.children.flatMap(flatten)];
function screenCaller(trees) {
  // The original projection predates a screen caller. Add a synthetic typed
  // ScreenAction in this test only; keep the native producer/Workflow unchanged.
  const client = trees.find(n => n.kind === 'ClientAction'), screenPath = 'MobileFlow:Probe/MobileScreen:Probe/ScreenAction:RunWorkflowProbe';
  const keys = new Map(flatten(client).map(n => [n.key, createHash('sha256').update('screen:' + n.key).digest().subarray(0, 16).toString('base64').replaceAll('/', '_').replace(/=+$/, '')]));
  let json = JSON.stringify(client);
  for (const [oldKey, newKey] of [...keys].sort((a, b) => b[0].length - a[0].length)) json = json.replaceAll(oldKey, newKey);
  const tree = JSON.parse(json.replaceAll(client.path, screenPath).replaceAll('ExecuteServerActionNode:EmitWorkflowProbe', 'ExecuteClientActionNode:LaunchWorkflowProbe'));
  tree.kind = 'ScreenAction'; tree.name = 'RunWorkflowProbe'; tree.properties.Name = tree.name;
  const call = tree.children.find(n => n.kind === 'ExecuteServerActionNode');
  call.kind = 'ExecuteClientActionNode'; call.name = client.name;
  call.propertyReferences.Action = { kind: client.kind, name: client.name, key: client.key, reference: '@' + client.key, path: client.path };
  for (const argument of call.children.filter(n => n.kind === 'Argument')) {
    const parameter = client.children.find(n => n.kind === 'InputParameter' && n.name === argument.propertyReferences.Parameter.name);
    argument.propertyReferences.Parameter = { kind: parameter.kind, name: parameter.name, key: parameter.key, reference: '@' + parameter.key, path: parameter.path };
  }
  trees.push(tree); return tree.key;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trees = structuredClone(source.trees), screenEntry = screenCaller(trees), all = trees.flatMap(flatten);
  const get = selector => all.find(n => n.key === selector.replace(/^@/, '') || n.path === selector || n.name === selector);
  // Publication metadata is synthetic; the fixture itself remains the untouched
  // native model projection of an unpublished candidate (no live claim).
  get('Reference:SSAMDbgWorkflowProducer').properties.Revision = '7';
  const inputRows = selector => get(selector).children.filter(n => n.kind === 'InputParameter').map(n => ({
    key: n.key, name: n.name, mandatory: n.properties.IsMandatory === 'True', dataType: n.propertyReferences.DataType.label }));
  const args = selector => get(selector).children.filter(n => n.kind === 'Argument').map(n => ({
    parameterName: n.propertyReferences.Parameter.name, parameter: n.propertyReferences.Parameter.key, value: n.properties.Value }));
  const sourceContract = name => {
    const file = path.join(root, name + '.oml'); fs.writeFileSync(file, name);
    return { path: file, sha256: createHash('sha256').update(name).digest('hex') };
  };
  const usage = key => all.filter(n => n.propertyReferences?.Event?.key === key || n.propertyReferences?.Action?.key === key)
    .map(n => ({ consumer: { kind: n.kind, key: n.key, path: n.path } }));
  const readers = { async: true, tree: async selector => get(selector), properties: async selector => {
    const node = get(selector); return { ...node, nativeEntryKind: ['ScreenAction', 'ClientAction'].includes(node?.kind) ? 'client-action' : null };
  },
    inputs: async selector => inputRows(selector), argumentsOf: async selector => args(selector), usages: async key => usage(key),
    closure: async () => [], resolveTarget: async selector => {
      const n = get(selector); return n && { key: n.key, kind: n.kind, name: n.name, path: n.path, inputs: inputRows('@' + n.key), closureCalls: [] };
    }, binding: { tenant: 'dev.example.test', module: 'SSAMDbgWorkflowProducer', moduleKey: 'yxrq9gPJC0qKPoiEdBf4UA',
      environmentKey: 'dev', revision: 7, runtimeUrl: 'https://dev.example.test/SSAMDbgWorkflowProducer/' },
    runtime: { moduleVersion: 'v7' }, sourceContract: sourceContract('producer'), verifyPublication: async () => {} };
  readers.workflow = { binding: { tenant: readers.binding.tenant, module: 'SSAMDbgWorkflow', moduleKey: 'kJTxWihYQEe6EPTnHAqrFQ', environmentKey: 'dev', revision: 2 },
    reader: { ...readers, list: async kind => trees.filter(n => n.kind === kind) }, sourceContract: sourceContract('workflow'), verifyPublication: async () => {} };
  const input = { op: 'run', lane: 'odc', execution: 'native-entry', tenant: readers.binding.tenant, module: readers.binding.module,
    action: '@' + SERVICE, entry: '@' + screenEntry, workflow: { module: readers.workflow.binding.module }, contextMode: 'native-background',
    launch: { contextMode: 'app-user', inputs: { Correlation: 'synthetic-correlation', Seed: 41 } }, trace: 'full', depth: 4,
    timeoutSeconds: 5, acknowledgeEffects: ['workflow-start'], words: 'Run this diagnostic Workflow in DEV', persist: false };
  const events = []; let approved = 0, workerSession, hook;
  const services = { root, journal: async () => {},
    resolveRuntime: prepared => ({ member: { key: prepared.entry.key }, inputs: inputRows('@' + prepared.entry.key) }),
    prepareUser: async (binding, { sessionId }) => {
      events.push('login'); return { ok: true, descriptor: { binding: appUserBinding(binding, sessionId), expiresAt: new Date(Date.now() + 60000).toISOString() } };
    }, releaseUser: async () => { events.push('release'); return { ok: true }; },
    debug: async (request, privateContext) => {
      events.push(request.op);
      if (request.op === 'stop') return { ok: true, state: 'stopped' };
      assert.deepEqual(privateContext, { backgroundWatch: true, contextMode: 'native-background' });
      assert.equal(request.trace.depth, 4); assert.equal(request.trace.focusFunctionKey, SERVICE);
      assert.deepEqual(Object.keys(request.trace.scopes), [SERVICE]);
      return { ok: true, state: 'connected', sessionId: 'workflow-trace' };
    },
    traceRead: () => [{ functionKey: SERVICE, nodeKey: 'X4cdhxU4CkqXGm2RZk8Jbw', threadId: 17, eventId: '5', nativeRequestIdSha256: FP, values: [] },
      { kind: 'thread-end', threadId: 17, eventId: '9', nativeRequestIdSha256: FP }],
    observeWorkflow: async () => { events.push('observe'); },
    broker: ({ beforeRequest }) => {
      hook = beforeRequest;
      return { prepare: async args => { events.push('prepare'); workerSession = args.sessionId;
        assert.equal(args.prepared.action.key, EMITTER); assert.equal(args.calls.length, 1); assert.equal(args.calls[0].trace, 'none'); },
      authenticate: async () => ({ authenticated: true, identityMatches: true }),
      invoke: async call => {
        assert.equal(await hook({ bindingSessionId: workerSession, probeId: call.id + '-1', privateEvidenceConfirmed: true, nativeCallContextSha256: null }), true);
        approved++; events.push('invoke'); return { ok: true, uncertain: false, name: call.name };
      }, dispose: async () => { events.push('dispose'); return { completed: true, receipt: { transport: { executeRequestSubmissions: approved, uncertain: false } } }; } };
    } };
  return { input, readers, services, events, get, root, approval: () => approved, hook: () => hook, workerSession: () => workerSession };
}

test('native Workflow projection qualifies original imported keys, emitter inputs and service scopes', async t => {
  const f = fixture(t), p = await prepareNativeEntry(f.input, f.readers);
  assert.equal(p.adapter.kind, 'workflow-event'); assert.equal(p.adapter.eventKey, EVENT);
  assert.equal(p.adapter.serviceReference.originalKey, SERVICE); assert.notEqual(p.adapter.serviceReference.key, SERVICE);
  assert.equal(p.emission.action.key, EMITTER); assert.equal(p.scenarios[0].inputs.Seed.value, 41);
  assert.deepEqual(p.tracePlan.scopes[SERVICE], ['Correlation', 'Seed', 'Observed', 'Result', 'CorrelationEcho']);
  assert.equal(p.tracePlan.depth, 4); assert.deepEqual(p.effects, ['workflow-start']);
  assert.equal(p.adapter.instanceCorrelationProved, false); assert.equal(p.adapter.rolesProved, false);
});

test('native uppercase source hashes qualify while malformed and changed hashes still refuse', async t => {
  const f = fixture(t);
  f.readers.sourceContract.sha256 = f.readers.sourceContract.sha256.toUpperCase();
  f.readers.workflow.sourceContract.sha256 = f.readers.workflow.sourceContract.sha256.toUpperCase();
  assert.equal((await prepareNativeEntry(f.input, f.readers)).adapter.kind, 'workflow-event');
  for (const hash of ['Z'.repeat(64), '0'.repeat(64), 'abc']) {
    f.readers.sourceContract.sha256 = hash;
    await assert.rejects(prepareNativeEntry(f.input, f.readers), /published_source_changed/);
  }
});

test('public schema preserves Workflow/launch/words and rejects ambiguous or anonymous emission', () => {
  const request = { op: 'prepare', lane: 'odc', execution: 'native-entry', tenant: 'dev.example.test', module: 'Producer', action: '@' + SERVICE,
    workflow: { module: 'Flow', process: 'AQi7rNY+cUG8IbcjOun+sA' }, contextMode: 'native-background', launch: { inputs: { Seed: 41 } }, depth: 4 };
  const parsed = nativeEntrySchema.parse(debugRunToolSchema.parse(request));
  assert.deepEqual(parsed.workflow, request.workflow); assert.equal(parsed.launch.contextMode, 'app-user'); assert.equal(parsed.depth, 4);
  for (const extra of [{ inputs: {} }, { scenarios: [] }, { contextMode: 'app-user' }, { launch: { contextMode: 'anonymous', inputs: {} } }])
    assert.equal(nativeEntrySchema.safeParse({ ...request, ...extra }).success, false);
  assert.equal(nativeEntrySchema.safeParse({ ...request, workflow: undefined }).success, false);
});

test('dynamic app revisions stay null while invalid bindings and unpinned library references refuse before login', async t => {
  for (const revision of [undefined, null, '', '6']) {
    const f = fixture(t); f.get('Reference:SSAMDbgWorkflowProducer').properties.Revision = revision;
    const prepared = await prepareNativeEntry(f.input, f.readers);
    assert.equal(prepared.adapter.serviceReference.importedRevision, revision === '6' ? 6 : null);
    assert.equal(prepared.adapter.serviceReference.revision, 7);
    assert.equal(prepared.adapter.serviceReference.revisionBinding, 'deployed-app');
    assert.equal(prepared.adapter.eventReference.importedRevision, revision === '6' ? 6 : null);
    assert.deepEqual(f.events, []);
  }
  for (const change of [p => p.Revision = 'garbage', p => p.Revision = '0', p => p.Revision = '9007199254740992',
    p => p.ModuleKey = 'B'.repeat(22), p => { p.ModuleType = 'ReactiveLibrary'; delete p.Revision; },
    p => { p.ModuleType = 'ReactiveLibrary'; p.Revision = '6'; }]) {
    const f = fixture(t); change(f.get('Reference:SSAMDbgWorkflowProducer').properties);
    await assert.rejects(prepareNativeEntry(f.input, f.readers), /original_reference_mismatch/); assert.deepEqual(f.events, []);
  }
  const f = fixture(t); delete f.get('Reference:SSAMDbgWorkflowProducer').properties.Revision; f.readers.binding.revision = null;
  await assert.rejects(prepareNativeEntry(f.input, f.readers), /original_reference_mismatch/);
});

test('changed import signature, duplicate argument and disabled trigger remain explicit refusals', async t => {
  const f = fixture(t); f.get('Reference:SSAMDbgWorkflowProducer/ServiceActionSignature:ObserveWorkflowValue').children[0].properties.OriginalKey = 'Q'.repeat(22);
  await assert.rejects(prepareNativeEntry(f.input, f.readers), /imported_signature_changed/);
  const g = fixture(t), a = g.get('BusinessProcess:SSAMDbgWorkflow/AutomaticActivityNode:ObserveWorkflowValue').children.filter(n => n.kind === 'Argument');
  a[1].propertyReferences.Parameter = structuredClone(a[0].propertyReferences.Parameter);
  await assert.rejects(prepareNativeEntry(g.input, g.readers), /event_to_activity_inputs_unqualified/);
  const h = fixture(t); h.get('ServerAction:EmitWorkflowProbe/TriggerGlobalNode:TriggerWorkflowProbe').properties.IsDisabled = 'True';
  await assert.rejects(prepareNativeEntry(h.input, h.readers), /emitter_flow_unqualified/);
});

test('MCP to public runner emits once as app user, observes background and cleans both identities', async t => {
  const f = fixture(t), { persist: _p, ...request } = f.input;
  const result = await debugRun(debugRunToolSchema.parse(request), { services: { ...f.services, readers: f.readers } });
  assert.equal(result.ok, true); assert.equal(result.eventEmissionAnswered, true); assert.equal(f.approval(), 1);
  assert.equal(result.lockRetained, false); assert.equal(result.credentialsReleased, true); assert.equal(result.serverTrace.stopped, true);
  assert.equal(result.backgroundTrace.traceVerified, true); assert.equal(result.instanceCorrelationProved, false);
  assert.equal(result.backgroundTrace.requestBound, true); assert.equal(result.instanceCorrelation, undefined);
  assert.equal(result.valuesComplete, false); assert.equal(result.valuesCoverage.reason, 'bounded_trace_without_native_completeness');
  assert.equal(result.rolesProved, false); assert.equal(result.executionCompleted, false);
  assert.deepEqual(f.events, ['prepare', 'login', 'watch', 'invoke', 'observe', 'stop', 'dispose', 'release']);
  assert.equal(await f.hook()({ bindingSessionId: f.workerSession(), probeId: 'event-1-2', privateEvidenceConfirmed: true, nativeCallContextSha256: null }), false);
  assert.equal(fs.readFileSync(result.receiptPath, 'utf8').includes('synthetic-correlation'), false);
});

test('interactive Timer integration does not admit a Workflow through the same runner', async t=>{
  const f=fixture(t),{persist:_p,...request}=f.input;
  const result=await debugRun(debugRunToolSchema.parse(request),{services:{...f.services,readers:f.readers,prepareServerInspection:async()=>assert.fail('must refuse before metadata')}});
  assert.equal(result.ok,false);assert.equal(result.error,'debug_odc_native_server_inspection_entry_required');
  assert.deepEqual(f.events,[]);
});

test('unrelated thread end does not attest observed activity completion', () => {
  const r = observeOdcWorkflow([{ functionKey: SERVICE, threadId: 3 }, { kind: 'thread-end', threadId: 9 }], SERVICE);
  assert.equal(r.captured, true); assert.equal(r.traceVerified, false); assert.equal(r.observedThreadEnds, 0);
  // Thread ids are reused: the same threadId ending another native request never attests this one.
  const reused = observeOdcWorkflow([{ functionKey: SERVICE, threadId: 3, eventId: '5', nativeRequestIdSha256: FP },
    { kind: 'thread-end', threadId: 3, eventId: '9', nativeRequestIdSha256: OTHER }], SERVICE);
  assert.equal(reused.traceVerified, false); assert.equal(reused.requestBound, false); assert.equal(reused.observedThreadEnds, 0);
  assert.equal(reused.unmatchedEnds, 1); assert.equal(reused.executionCompleted, false);
  const bound = observeOdcWorkflow([{ functionKey: SERVICE, threadId: 3, eventId: '5', nativeRequestIdSha256: FP },
    { kind: 'thread-end', threadId: 3, eventId: '9', nativeRequestIdSha256: FP }], SERVICE);
  assert.equal(bound.requestBound, true); assert.deepEqual(bound.endedFingerprints, [FP]); assert.equal(bound.instanceCorrelationProved, false);
});

test('Workflow report.ok needs a request-bound ThreadEnd; a fingerprint-less end stays traceVerified only', async t => {
  for (const [lines, verified] of [[[{ functionKey: SERVICE, threadId: 17, eventId: '5' }, { kind: 'thread-end', threadId: 17, eventId: '9' }], true],
    [[{ functionKey: SERVICE, threadId: 17, eventId: '5', nativeRequestIdSha256: FP }, { kind: 'thread-end', threadId: 17, eventId: '9', nativeRequestIdSha256: OTHER }], false]]) {
    const f = fixture(t); f.services.traceRead = () => lines;
    const result = await runOdcWorkflowEvent(f.input, await prepareNativeEntry(f.input, f.readers), f.readers, f.services);
    assert.equal(result.eventEmissionAnswered, true); assert.equal(result.backgroundTrace.traceVerified, verified);
    assert.equal(result.backgroundTrace.requestBound, false); assert.equal(result.ok, false);
    assert.equal(result.error, 'debug_odc_workflow_request_bound_thread_end_missing');
    assert.equal(result.lockRetained, false); assert.equal(result.uncertain, false);
  }
});

test('publication changed after authentication refuses the reservation without emitting', async t => {
  const f = fixture(t); let checks = 0;
  f.readers.workflow.verifyPublication = async () => { if (++checks === 2) throw new Error('debug_odc_workflow_publication_changed'); };
  const result = await runOdcWorkflowEvent(f.input, await prepareNativeEntry(f.input, f.readers), f.readers, f.services);
  assert.equal(result.ok, false); assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false); assert.equal(f.approval(), 0);
  assert.equal(result.serverTrace.stopped, true);
});

test('known original-host refusal before request reservation stays clean', async t => {
  const f = fixture(t);
  f.services.broker = () => ({ prepare: async () => { throw new Error('debug_odc_native_auth_provider_unavailable'); },
    dispose: async () => ({ completed: true }) });
  const result = await runOdcWorkflowEvent(f.input, await prepareNativeEntry(f.input, f.readers), f.readers, f.services);
  assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false); assert.equal(f.approval(), 0);
  assert.deepEqual(f.events, []);
});

test('lost response after reservation keeps lock and refuses replay', async t => {
  const f = fixture(t), original = f.services.broker;
  f.services.broker = options => { const b = original(options), invoke = b.invoke; b.invoke = async call => { await invoke(call); throw new Error('lost'); }; return b; };
  const prepared = await prepareNativeEntry(f.input, f.readers);
  const result = await runOdcWorkflowEvent(f.input, prepared, f.readers, f.services);
  assert.equal(result.uncertain, true); assert.equal(result.lockRetained, true); assert.equal(f.approval(), 1);
  const replay = await runOdcWorkflowEvent(f.input, prepared, f.readers, f.services);
  assert.equal(replay.error, 'debug_odc_workflow_binding_blocked'); assert.equal(f.approval(), 1);
});

test('unknown debugger start or failed cleanup retains lock without a second start/send', async t => {
  const f = fixture(t); f.services.debug = async () => { throw new Error('start response lost'); };
  const result = await runOdcWorkflowEvent(f.input, await prepareNativeEntry(f.input, f.readers), f.readers, f.services);
  assert.equal(result.uncertain, true); assert.equal(result.lockRetained, true); assert.equal(f.approval(), 0);
  const g = fixture(t), original = g.services.debug;
  g.services.debug = async (q, c) => q.op === 'stop' ? { ok: false } : original(q, c);
  const failed = await runOdcWorkflowEvent(g.input, await prepareNativeEntry(g.input, g.readers), g.readers, g.services);
  assert.equal(failed.uncertain, true); assert.equal(failed.lockRetained, true); assert.equal(g.approval(), 1);
});

test('effects gate runs before broker/login and source hash changes refuse without send', async t => {
  const f = fixture(t), { persist: _p, ...request } = f.input;
  const result = await debugRun({ ...request, acknowledgeEffects: [] }, { services: { ...f.services, readers: f.readers } });
  assert.equal(result.state, 'effects-not-acknowledged'); assert.deepEqual(f.events, []);
  fs.appendFileSync(f.readers.sourceContract.path, 'changed');
  await assert.rejects(prepareNativeEntry(f.input, f.readers), /published_source_changed/);
});

test('automatic service effects are acknowledged independently of event-emitter effects', async t => {
  const f = fixture(t), resolve = f.readers.resolveTarget;
  f.readers.resolveTarget = async selector => {
    const target = await resolve(selector);
    if (target.key === SERVICE) target.closureCalls = [{ kind: 'ExecuteActionNode', action: 'Entity:Audit#CreateAudit' }];
    return target;
  };
  const prepared = await prepareNativeEntry(f.input, f.readers);
  assert.deepEqual(prepared.effects, ['entity-write', 'workflow-start']);
});
