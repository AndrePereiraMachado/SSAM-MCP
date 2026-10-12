import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveOdcProducerTarget } from '../debug-odc-producer-target.mjs';
import { debugRedactionBinding, headlessDebug } from '../debug-runtime.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
import { prepareNativeEntry, runNativeEntry } from '../debug-odc-native-run.mjs';
import { describeOdcCallBoundaries } from '../debug-odc-call-boundary.mjs';

const native = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-odc-native-library-reference.json', import.meta.url)));
test('interactive producer inspection pins native scope and rejects before worker/authentication when incompatible', async t => {
  const f = fixture(t), target = (await resolveOdcProducerTarget(f.target, f)).producerTarget;
  const sessionId = 'a'.repeat(32), binding = appUserBinding({ ...f.binding, lane: 'odc' }, sessionId);
  const descriptor = { binding, expiresAt: new Date(Date.now() + 60000).toISOString() };
  const input = { op: 'start', lane: 'odc', ...target.traceBinding, nodeKeys: ['N'.repeat(22)], autoContinue: false,
    inspection: { scopes: [{ moduleKey: target.producerModuleKey, functionKey: target.actionKey, nodeKey: 'N'.repeat(22),
      sourceSha256: target.producerSourceSha256 }], variables: [] } };
  assert.deepEqual(debugRedactionBinding(input, descriptor, sessionId, true, target), binding);
  input.inspection.sources=[{moduleKey:target.producerModuleKey,sourceSha256:target.producerSourceSha256},
    {moduleKey:target.consumer.moduleKey,sourceSha256:target.consumer.sourceSha256}];
  assert.deepEqual(debugRedactionBinding(input, descriptor, sessionId, true, target), binding);
  const foreign=structuredClone(input);foreign.inspection.sources.push({moduleKey:'Z'.repeat(22),sourceSha256:'a'.repeat(64)});
  assert.throws(()=>debugRedactionBinding(foreign,descriptor,sessionId,true,target),/redaction_binding_invalid/);
  const forged=structuredClone(input);forged.inspection.sources[1].sourceSha256='0'.repeat(64);
  assert.throws(()=>debugRedactionBinding(forged,descriptor,sessionId,true,target),/redaction_binding_invalid/);
  const { app, revision, runtimeRevision, environmentKey, ...request } = input;
  request.inspection.scopes[0].sourceSha256 = '0'.repeat(64);
  assert.throws(() => debugRedactionBinding(request, descriptor, sessionId, true, target), /redaction_binding_invalid/);
  const result = await headlessDebug(request, { appUser: descriptor, redactionOnly: true, odcProducerTrace: target,
    services: { prepareAppUser: () => assert.fail('must not prompt'), spawn: () => assert.fail('must not spawn') } });
  assert.equal(result.state, 'not-started'); assert.equal(result.failurePhase, 'producer-preflight');
  assert.equal(result.sessionId, undefined); assert.equal(result.error, 'debug_odc_producer_redaction_binding_invalid');
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-library-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = name => { const file = path.join(directory, name); fs.writeFileSync(file, name);
    return { path: file, sha256: createHash('sha256').update(name).digest('hex') }; };
  const consumer = source('consumer'), producer = source('producer');
  const binding = { tenant: 'personal.example.test', environmentKey: 'environment', module: 'Consumer', moduleKey: 'C'.repeat(22),
    revision: 293, runtimeUrl: 'https://personal.example.test/Consumer/' };
  const signature = structuredClone(native.signature), reference = structuredClone(native.reference);
  const target = { key: signature.key, path: signature.path, name: signature.name, kind: signature.kind, inputs: [],
    closureCalls: [], importedSignature: { signature, reference } };
  // Native identities above, synthetic minimal body below. This fixture does not
  // claim to execute corporate logic or reproduce its implementation.
  const action = { ...native.producer, children: [] };
  const external = { key: action.key, source: { moduleKey: reference.properties.ModuleKey, revision: 81, sha256: producer.sha256 },
    sourceContract: producer, reader: { tree: async selector => { assert.equal(selector, '@' + action.key); return action; } } };
  return { target, binding, sourceContract: consumer, readExternal: async () => external, external, action };
}
test('native imported OriginalKey selects producer while retaining consumer signature for the original caller', async t => {
  const f = fixture(t);
  f.sourceContract.sha256 = f.sourceContract.sha256.toUpperCase();
  f.external.source.sha256 = f.external.source.sha256.toUpperCase();
  f.external.sourceContract.sha256 = f.external.sourceContract.sha256.toUpperCase();
  const target = await resolveOdcProducerTarget(f.target, f);
  assert.equal(target.key, 'wgIf4K9WMk6XdwFDRZ8ZSA');
  assert.equal(target.producerTarget.actionKey, 'HioLXLyDc0ScwPMJvTMeEQ');
  assert.equal(target.producerTarget.traceBinding.runtimeUrl, f.binding.runtimeUrl);
  assert.equal(target.producerTarget.traceBinding.moduleKey, native.reference.properties.ModuleKey);
  assert.equal(target.producerTarget.producerRevision, 81);
  const caller = { key: 'D'.repeat(22), kind: 'ServerAction', path: 'ServerAction:OriginalEntry', nativeEntryKind: 'server-stub', properties: { Name: 'OriginalEntry' } };
  const screen = { key: 'E'.repeat(22), kind: 'MobileScreen', path: 'MobileScreen:OriginalScreen', properties: { Name: 'OriginalScreen' } };
  const handler = { key: 'F'.repeat(22), kind: 'ScreenAction', path: screen.path + '/ScreenAction:InvokeOriginalEntry',
    nativeEntryKind: 'client-action', properties: { Name: 'InvokeOriginalEntry' } };
  const properties = new Map([caller, screen, handler, f.target.importedSignature.signature].map(node => [node.path, node]));
  const readers = { resolveTarget: async () => target, binding: f.binding,
    properties: selector => properties.get(selector) ?? null,
    inputs: () => [], usages: key => key === target.key ? [{ consumer: { kind: 'ExecuteServerActionNode', path: caller.path + '/ExecuteServerActionNode:Imported' } }]
      : key === caller.key ? [{ consumer: { kind: 'ExecuteServerActionNode', path: handler.path + '/ExecuteServerActionNode:OriginalEntry' } }] : [],
    argumentsOf: () => [],
    closure: async () => [] };
  const prepared = await prepareNativeEntry({ action: '@' + target.key, inputs: {}, persist: false }, readers);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.entry.key, handler.key); assert.equal(prepared.distance, 2); assert.equal(prepared.overridden, false);
  assert.deepEqual(prepared.path.map(node => node.key), [handler.key, caller.key, target.key]);
  assert.equal(prepared.action.key, target.key); assert.equal(prepared.producerTarget.actionKey, f.action.key);
  assert.equal(prepared.callBoundary.traceScope, 'selected-producer-action');
  assert.equal(prepared.callBoundary.propagationProved, false);
});
test('changed producer bytes, imported revision and OriginalKey are refused', async t => {
  const f = fixture(t);
  f.external.source.revision++;
  await assert.rejects(resolveOdcProducerTarget(f.target, f), /source_binding_invalid/);
  f.external.source.revision--;
  fs.writeFileSync(f.external.sourceContract.path, 'changed');
  await assert.rejects(resolveOdcProducerTarget(f.target, f), /source_changed/);
});
test('consumer credentials redact pinned producer only and never prove propagation', async t => {
  const f = fixture(t), target = await resolveOdcProducerTarget(f.target, f), contract = target.producerTarget;
  const sessionId = 'a'.repeat(32), descriptor = { binding: appUserBinding({ ...f.binding, lane: 'odc' }, sessionId), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const input = { ...contract.traceBinding, lane: 'odc', trace: { focusFunctionKey: contract.actionKey, requireFunctionKey: contract.actionKey, scopes: { [contract.actionKey]: [] } } };
  assert.deepEqual(debugRedactionBinding(input, descriptor, sessionId, true, contract), descriptor.binding);
  assert.throws(() => debugRedactionBinding(input, descriptor, sessionId, true), /scope_mismatch/);
  assert.throws(() => debugRedactionBinding({ ...input, moduleKey: 'X'.repeat(22) }, descriptor, sessionId, true, contract), /binding_invalid/);
  assert.equal(contract.appUserIdentityProved, false); assert.equal(contract.rolesProved, false);
});
test('independent service needs deployed body; imported revision alone does not authorize any login or call', async t => {
  const f = fixture(t); f.target.kind = f.target.importedSignature.signature.kind = 'ServiceActionSignature';
  f.target.path = f.target.importedSignature.signature.path = 'Reference:FloodServices/ServiceActionSignature:GetFloodZoneAll';
  f.target.importedSignature.reference.properties.ModuleType = 'Service'; f.readExternal = async () => null;
  const target = await resolveOdcProducerTarget(f.target, f);
  assert.equal(target.producerTarget.executable, false);
  assert.equal(target.producerTarget.error, 'debug_odc_producer_service_deployment_unavailable');
  assert.equal(describeOdcCallBoundaries([], target).producerTargetSelection, 'unavailable');
});

test('independent service uses its deployed revision and runtime, never the imported library execution binding', async t => {
  const f = fixture(t); f.target.kind = f.target.importedSignature.signature.kind = 'ServiceActionSignature';
  f.target.path = f.target.importedSignature.signature.path = 'Reference:FloodServices/ServiceActionSignature:GetFloodZoneAll';
  f.target.importedSignature.reference.properties.ModuleType = 'ReactiveWeb'; f.action.kind = 'ServiceAction';
  f.external.source = { ...f.external.source, revision: 92, deployed: true };
  f.external.binding = { ...f.binding, moduleKey: f.external.source.moduleKey, module: 'Producer', revision: 92,
    runtimeUrl: 'https://personal.example.test/Producer/' };
  let checked = 0; f.external.verifyPublication = async () => { checked++; };
  const selected = await resolveOdcProducerTarget(f.target, f);
  assert.equal(selected.producerTarget.importedRevision, 81); assert.equal(selected.producerTarget.producerRevision, 92);
  assert.equal(selected.producerTarget.traceBinding.runtimeUrl, f.external.binding.runtimeUrl);
  assert.equal(selected.producerTarget.bodyInspection, 'deployed-service-revision');
  await selected.verifyProducerPublication(); assert.equal(checked, 1);
  delete f.external.verifyPublication;
  await assert.rejects(resolveOdcProducerTarget(f.target, f), /service_publication_check_unavailable/);
});

test('native unversioned app signature keeps importedRevision null and pins the current service deployment', async t => {
  const f = fixture(t);
  f.target.kind = f.target.importedSignature.signature.kind = 'ServiceActionSignature';
  f.target.path = f.target.importedSignature.signature.path = 'Reference:FloodServices/ServiceActionSignature:GetFloodZoneAll';
  f.target.importedSignature.reference.properties.ModuleType = 'Service';
  f.target.importedSignature.reference.properties.Revision = null;
  f.action.kind = 'ServiceAction';
  f.external.source = { ...f.external.source, revision: 713, deployed: true };
  f.external.binding = { ...f.binding, module: 'Producer', moduleKey: f.external.source.moduleKey, revision: 713,
    runtimeUrl: 'https://personal.example.test/Producer/' };
  f.external.verifyPublication = async () => {};
  const selected = await resolveOdcProducerTarget(f.target, f);
  assert.equal(selected.producerTarget.importedRevision, null);
  assert.equal(selected.producerTarget.producerRevision, 713);
  assert.equal(selected.producerTarget.executable, true);
  assert.equal(selected.producerTarget.appUserIdentityProved, false);
  assert.equal(selected.producerTarget.propagationProved, false);
  f.external.binding.environmentKey = 'another-environment';
  await assert.rejects(resolveOdcProducerTarget(f.target, f), /service_deployment_unavailable/);
  f.external.binding.environmentKey = f.binding.environmentKey;
  f.external.source.moduleKey = 'X'.repeat(22);
  await assert.rejects(resolveOdcProducerTarget(f.target, f), /source_binding_invalid/);
});

// Consumer + library breakpoints in one ODC session (native ExtendedBreakpointId(OwnerESpace.Key, node), see
// .local/debugger/odc-library-breakpoint-contract/findings.json): only the runner-bound consumer of a library-reference.
test('library-reference redaction admits consumer-owned scopes pinned to the consumer hash, never for a service', async t => {
  const f = fixture(t), target = (await resolveOdcProducerTarget(f.target, f)).producerTarget;
  const sessionId = 'a'.repeat(32), binding = appUserBinding({ ...f.binding, lane: 'odc' }, sessionId);
  const descriptor = { binding, expiresAt: new Date(Date.now() + 60000).toISOString() };
  const libraryNode = 'N'.repeat(22), consumerNode = 'K'.repeat(22), consumerAction = 'G'.repeat(22);
  const consumerScope = { moduleKey: target.consumer.moduleKey, functionKey: consumerAction, nodeKey: consumerNode, sourceSha256: target.consumer.sourceSha256 };
  const input = { op: 'start', lane: 'odc', ...target.traceBinding, nodeKeys: [libraryNode, consumerNode], autoContinue: false,
    nodeModuleKeys: { [libraryNode]: target.producerModuleKey, [consumerNode]: target.consumer.moduleKey },
    inspection: { scopes: [{ moduleKey: target.producerModuleKey, functionKey: target.actionKey, nodeKey: libraryNode, sourceSha256: target.producerSourceSha256 },
      consumerScope], variables: [{ moduleKey: target.consumer.moduleKey, functionKey: consumerAction, nodeKey: consumerNode,
      variableKey: 'V'.repeat(22), sourceSha256: target.consumer.sourceSha256, name: 'Result', category: 'local', path: 'Result' }] } };
  assert.deepEqual(debugRedactionBinding(input, descriptor, sessionId, true, target), binding);
  const fromScopes = structuredClone(input); delete fromScopes.nodeModuleKeys;
  assert.deepEqual(debugRedactionBinding(fromScopes, descriptor, sessionId, true, target), binding);
  const refuse = (mutate, label) => { const copy = structuredClone(input); mutate(copy);
    assert.throws(() => debugRedactionBinding(copy, descriptor, sessionId, true, target), /redaction_binding_invalid/, label); };
  refuse(c => { c.inspection.scopes[1].sourceSha256 = target.producerSourceSha256; }, 'consumer scope with the producer hash');
  refuse(c => { c.inspection.scopes[1].sourceSha256 = '0'.repeat(64); }, 'consumer scope with a forged hash');
  refuse(c => { c.inspection.scopes[1].moduleKey = 'Z'.repeat(22); c.nodeModuleKeys[consumerNode] = 'Z'.repeat(22); }, 'foreign owner');
  refuse(c => { c.nodeModuleKeys[consumerNode] = target.producerModuleKey; }, 'owner map contradicting the scope');
  refuse(c => { delete c.nodeModuleKeys[consumerNode]; }, 'owner map omitting a node');
  refuse(c => { c.inspection.variables[0].functionKey = target.actionKey; }, 'consumer variable outside its scope');
  refuse(c => { c.inspection.variables[0].sourceSha256 = target.producerSourceSha256; }, 'consumer variable with the producer hash');
  // Automatic library trace may carry the consumer breakpoint owner too, still only for the library pair.
  const trace = { ...target.traceBinding, lane: 'odc', nodeKeys: [libraryNode, consumerNode], nodeModuleKeys: input.nodeModuleKeys,
    trace: { focusFunctionKey: target.actionKey, requireFunctionKey: target.actionKey, scopes: { [target.actionKey]: [] } } };
  assert.deepEqual(debugRedactionBinding(trace, descriptor, sessionId, true, target), binding);
  assert.throws(() => debugRedactionBinding({ ...trace, nodeModuleKeys: { ...trace.nodeModuleKeys, [consumerNode]: 'Z'.repeat(22) } },
    descriptor, sessionId, true, target), /redaction_binding_invalid/);
  // A service runs in its own app runtime: consumer-owned scopes/owners are never admitted there.
  const g = fixture(t); g.target.kind = g.target.importedSignature.signature.kind = 'ServiceActionSignature';
  g.target.path = g.target.importedSignature.signature.path = 'Reference:FloodServices/ServiceActionSignature:GetFloodZoneAll';
  g.target.importedSignature.reference.properties.ModuleType = 'Service'; g.action.kind = 'ServiceAction';
  g.external.source = { ...g.external.source, revision: 92, deployed: true };
  g.external.binding = { ...g.binding, module: 'Producer', moduleKey: g.external.source.moduleKey, revision: 92, runtimeUrl: 'https://personal.example.test/Producer/' };
  g.external.verifyPublication = async () => {};
  const service = (await resolveOdcProducerTarget(g.target, g)).producerTarget;
  const serviceBinding = appUserBinding({ ...g.binding, lane: 'odc' }, sessionId);
  const serviceDescriptor = { binding: serviceBinding, expiresAt: descriptor.expiresAt };
  const serviceInput = { ...structuredClone(input), ...service.traceBinding, op: 'start', lane: 'odc' };
  serviceInput.nodeModuleKeys = { [libraryNode]: service.producerModuleKey, [consumerNode]: service.consumer.moduleKey };
  serviceInput.inspection.scopes = [{ moduleKey: service.producerModuleKey, functionKey: service.actionKey, nodeKey: libraryNode, sourceSha256: service.producerSourceSha256 },
    { ...consumerScope, moduleKey: service.consumer.moduleKey, sourceSha256: service.consumer.sourceSha256 }];
  serviceInput.inspection.variables = [];
  assert.throws(() => debugRedactionBinding(serviceInput, serviceDescriptor, sessionId, true, service), /redaction_binding_invalid/);
  const producerOnly = structuredClone(serviceInput); producerOnly.nodeKeys = [libraryNode]; delete producerOnly.nodeModuleKeys;
  producerOnly.inspection.scopes = producerOnly.inspection.scopes.slice(0, 1);
  assert.deepEqual(debugRedactionBinding(producerOnly, serviceDescriptor, sessionId, true, service), serviceBinding);
});

test('null library revision and malformed nonempty service revisions are refused before reading a producer', async t => {
  const f = fixture(t); let reads = 0;
  f.readExternal = async () => { reads++; return f.external; };
  f.target.importedSignature.reference.properties.Revision = null;
  await assert.rejects(resolveOdcProducerTarget(f.target, f), /reference_invalid/);
  f.target.kind = f.target.importedSignature.signature.kind = 'ServiceActionSignature';
  f.target.path = f.target.importedSignature.signature.path = 'Reference:FloodServices/ServiceActionSignature:GetFloodZoneAll';
  f.target.importedSignature.reference.properties.ModuleType = 'Service';
  for (const value of ['0', '-1', 'revision713', '713.5', ' 713', '9007199254740993', 713]) {
    f.target.importedSignature.reference.properties.Revision = value;
    await assert.rejects(resolveOdcProducerTarget(f.target, f), /reference_invalid/);
  }
  assert.equal(reads, 0);
});

// Local end-to-end qualification of an interactive ODC service-reference run: the public server coordinator
// (createServerSessionManager) drives runOdcNativeLive with fakes for the native worker, broker and Portal reads.
import { validateOdcProducerRedaction } from '../debug-odc-producer-target.mjs';
import { createServerSessionManager, serverSessionSchema } from '../debug-server-session.mjs';
import { debugRunToolSchema } from '../debug-run.mjs';
import { runOdcNativeLive } from '../debug-odc-native-live.mjs';
import { createAppUserAnchorRegistry } from '../debug-server-private-inspection.mjs';
async function serviceHarness(t) {
  const f = fixture(t); f.target.kind = f.target.importedSignature.signature.kind = 'ServiceActionSignature';
  f.target.path = f.target.importedSignature.signature.path = 'Reference:FloodServices/ServiceActionSignature:GetFloodZoneAll';
  f.target.importedSignature.reference.properties.ModuleType = 'Service'; f.action.kind = 'ServiceAction';
  f.external.source = { ...f.external.source, revision: 92, deployed: true };
  f.external.binding = { ...f.binding, module: 'Producer', moduleKey: f.external.source.moduleKey, revision: 92, runtimeUrl: 'https://personal.example.test/Producer/' };
  const events = [], published = { revision: 92 }, state = { intoForeign: false };
  f.external.verifyPublication = async () => { events.push('verify-service'); if (published.revision !== 92) throw new Error('debug_odc_producer_publication_changed'); };
  const selected = await resolveOdcProducerTarget(f.target, f), contract = selected.producerTarget;
  const serviceKey = contract.producerModuleKey, actionKey = contract.actionKey, consumerKey = f.binding.moduleKey;
  const node = 'N'.repeat(22), nested = 'M'.repeat(22), nestedNode = 'Q'.repeat(22), endNode = 'R'.repeat(22), foreign = 'Z'.repeat(22), handler = 'H'.repeat(22);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-service-harness-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = { action: { key: f.target.key, kind: 'ServiceActionSignature' }, entry: { key: handler, kind: 'ScreenAction' }, path: [{ key: handler }, { key: f.target.key }],
    bindings: [], assumptions: [], producerTarget: contract, scenarios: [{ name: 'scalar', inputs: {} }, { name: 'unicode-text', inputs: {} }] };
  const member = { key: handler, chunk: 'client.js', holder: { name: 'work', local: 'work' }, type: 'CLIENT_ACTION' };
  const readers = { binding: f.binding, sourceContract: f.sourceContract, runtime: { moduleVersion: 'v1', index: { functions: { [handler]: [member] }, views: {}, screens: {}, groups: {} } },
    inspectionModel: moduleKey => moduleKey === serviceKey ? { source: contract.sourceContract } : null,
    // debug-run's verifyPublication: the consumer deployment, then every selected producer, before each invocation.
    verifyPublication: async () => { events.push('verify-consumer'); await selected.verifyProducerPublication(); },
    traceTarget: async () => ({ actionKey, nodeKeys: [node], steps: 10, scopes: { [actionKey]: ['Result'] }, binding: contract.traceBinding, producerTarget: contract }) };
  const userKey = '9f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9', registry = createAppUserAnchorRegistry();
  let status = { ok: true, state: 'connected', pauses: [], events: [] }, generation = 1, thread = 0, release, started, prepareBinding;
  const pause = (eventId, functionKey, nodeKey, moduleKey = serviceKey) => ({ threadId: 'T' + thread, eventId, stack: [{ frame: 0, module: 'Producer', moduleKey, action: 'A', functionKey, nodeKey }] });
  const current = input => status.pauses.find(p => p.threadId === input.threadId && p.eventId === input.eventId)?.stack[0];
  const worker = async (input, context) => {
    if (input.op === 'start') {
      // headlessDebug's preflight: the interactive service start must satisfy the producer redaction contract.
      validateOdcProducerRedaction(input, context.appUser.binding, context.odcProducerTrace); started = { input, context };
      return { ok: true, state: 'connected', sessionId: 'a'.repeat(32), autoContinue: false, inspectionMode: 'interactive', expiresAt: new Date(Date.now() + 300000).toISOString() };
    }
    if (input.op === 'status') return structuredClone(status);
    if (input.op === 'stop') { status = { ok: true, state: 'stopped' }; return status; }
    const top = current(input), next = String(Number(input.eventId) + 1);
    if (input.op === 'step-into') { generation++;
      status.pauses = [state.intoForeign ? pause(next, 'X'.repeat(22), 'Y'.repeat(22), foreign) : pause(next, nested, nestedNode)]; return { ok: true }; }
    if (input.op === 'step-out') { generation++; status.pauses = [pause(next, actionKey, endNode)]; return { ok: true }; }
    if (input.op === 'continue') { status.pauses = []; status.events = [...status.events, { kind: 'thread-end', threadId: 'T' + thread, eventId: '99' }]; release(); return { ok: true }; }
    const ctx = { threadId: input.threadId, eventId: input.eventId, frame: 0, generation, moduleKey: top?.moduleKey, functionKey: top?.functionKey, nodeKey: top?.nodeKey };
    const bound = ctx.functionKey === actionKey;
    return { ok: true, metadataBound: bound, context: ctx, variables: bound ? [{ reference: 'b'.repeat(32) }] : [] };
  };
  const bindings = [];
  const broker = () => ({ prepare: async () => { events.push('prepare'); }, authenticate: async () => ({ authenticated: true, identityMatches: true }),
    configureServerInspection: async options => ({ configured: true, ...options }),
    invoke: async call => { thread++; events.push('invoke:' + call.name); const done = new Promise(resolve => { release = resolve; });
      status.pauses = [pause('1', actionKey, node)]; await done; return { name: call.name, ok: true }; },
    dispose: async () => ({ completed: true }) });
  const manager = createServerSessionManager({ root, debug: worker, pollMs: 5, o11Runner: () => () => {},
    prepareUser: async (input, { sessionId }) => ({ ok: true, descriptor: { credentialRef: '11111111-2222-4333-8444-555555555555', binding: appUserBinding(input, sessionId),
      expiresAt: new Date(Date.now() + 600000).toISOString(), state: 'authenticated', authenticated: true, userKey } }),
    bindScope: async input => { bindings.push(input); generation++; return { ok: true, metadataBound: true, context: { threadId: input.threadId, eventId: input.eventId, frame: 0, generation,
      moduleKey: input.scopeUpdate.moduleKey, functionKey: input.scopeUpdate.functionKey, nodeKey: input.scopeUpdate.nodeKey }, variables: [{ reference: 'c'.repeat(32) }] }; },
    readScopes: async input => ({ evidence: ['native-model'], coverage: [], variables: input.scopes.map(scope => ({ moduleKey: input.moduleKey, functionKey: scope.functionKey,
      nodeKey: scope.nodeKeys[0], variableKey: 'V'.repeat(22), name: 'Result', category: 'output', path: 'Result', sourceSha256: input.source.sha256 })) }),
    run: async (_, { services }) => runOdcNativeLive({ trace: 'full', timeoutSeconds: 30 }, prepared, readers, { ...services, root, broker,
      registerAppUserAnchor: anchor => { events.push('anchor'); registry.register(anchor); },
      prepareServerInspection: async binding => { prepareBinding = binding; return services.prepareServerInspection(binding); } }) });
  const start = await manager(serverSessionSchema(debugRunToolSchema).parse({ op: 'start', run: { op: 'run', lane: 'odc', module: 'Consumer', action: '@' + f.target.key },
    scopes: [{ functionKey: actionKey, nodeKeys: [node] }] }));
  const wait = async terminal => {
    let result;
    for (let i = 0; i < 100; i++) {
      result = await manager({ op: 'status', sessionId: start.sessionId });
      if (terminal ? ['failed', 'completed', 'uncertain'].includes(result.state) : result.state === 'paused') return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('unexpected phase ' + result.state + ' ' + (result.error ?? ''));
  };
  t.after(async () => { await manager({ op: 'stop', sessionId: start.sessionId }).catch(() => {}); });
  const token = paused => ({ sessionId: start.sessionId, threadId: paused.pauses[0].threadId, eventId: paused.pauses[0].eventId, generation: paused.pauses[0].generation });
  return { f, manager, start, wait, token, events, registry, contract, published, consumerKey, serviceKey, actionKey, nested, node, endNode, state, bindings,
    started: () => started, prepareBinding: () => prepareBinding };
}
test('interactive service-reference run: service models, redaction, Service frames, steps, per-invocation publication check, anchor', async t => {
  const h = await serviceHarness(t);
  let paused = await h.wait(false);
  // prepareServerInspection receives the consumer and the deployed service models; the trace binding is the service runtime.
  assert.equal(h.prepareBinding().moduleKey, h.serviceKey); assert.equal(h.prepareBinding().functionKey, h.actionKey);
  assert.deepEqual(h.prepareBinding().models.map(m => [m.moduleKey, m.source.sha256]), [[h.consumerKey, h.f.sourceContract.sha256], [h.serviceKey, h.contract.producerSourceSha256]]);
  const { input, context } = h.started();
  assert.equal(input.moduleKey, h.serviceKey); assert.equal(input.runtimeUrl, h.contract.traceBinding.runtimeUrl); assert.equal(input.autoContinue, false);
  assert.equal(input.trace, undefined); assert.equal(context.redactionOnly, true); assert.equal(context.odcProducerTrace, h.contract);
  assert.deepEqual(input.inspection.scopes.map(s => [s.moduleKey, s.functionKey]), [[h.serviceKey, h.actionKey]]);
  assert.equal(validateOdcProducerRedaction(input, context.appUser.binding, h.contract), true);
  // Service frame: scope/read, step-into a nested action of the Service app (lazy model from the pinned capture), step-out, continue.
  let scope = await h.manager({ ...h.token(paused), op: 'scope' }); assert.equal(scope.ok, true);
  await h.manager({ ...h.token(paused), generation: scope.generation, op: 'read', reference: scope.variables[0].reference });
  await h.manager({ ...h.token(paused), generation: scope.generation, op: 'step-into' });
  paused = await h.wait(false); assert.equal(paused.pauses[0].stack[0].functionKey, h.nested);
  scope = await h.manager({ ...h.token(paused), op: 'scope' }); assert.equal(scope.metadataBound, true);
  assert.equal(h.bindings[0].scopeUpdate.moduleKey, h.serviceKey); assert.equal(h.bindings[0].scopeUpdate.sourceSha256, h.contract.producerSourceSha256);
  await assert.rejects(h.manager({ ...h.token(paused), op: 'step-out' }), /stale_stop/, 'scope binding consumed the generation');
  await h.manager({ ...h.token(paused), generation: scope.generation, op: 'step-out' });
  paused = await h.wait(false); assert.equal(paused.pauses[0].stack[0].nodeKey, h.endNode);
  await h.manager({ ...h.token(paused), op: 'continue' });
  for (let i = 0; i < 100 && (paused = await h.wait(false)).pauses[0].threadId !== 'T2'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(paused.pauses[0].threadId, 'T2', 'the second typed scenario reaches the Service frame');
  await h.manager({ ...h.token(paused), op: 'continue' });
  const final = await h.wait(true);
  assert.equal(final.state, 'completed', final.error ?? final.runResult?.error); assert.equal(final.runResult.ok, true);
  assert.deepEqual(h.events.filter(e => e !== 'anchor'), ['verify-consumer', 'verify-service', 'prepare', 'verify-consumer', 'verify-service', 'invoke:scalar',
    'verify-consumer', 'verify-service', 'invoke:unicode-text']);
  assert.ok(h.events.indexOf('anchor') > h.events.indexOf('prepare') && h.events.indexOf('anchor') < h.events.indexOf('invoke:scalar'));
  assert.deepEqual(final.runResult.results.map(r => r.producerObservation.moduleKey), [h.serviceKey, h.serviceKey]);
  assert.deepEqual(final.runResult.appUserAnchor, { registered: true, valueReturned: false }); assert.equal(h.registry.receipt().registered, true);
  assert.doesNotMatch(JSON.stringify(final), /9f1e2d3c/i);
});
test('a changed service deployment refuses before the next scenario; a frame of an unbound module is refused', async t => {
  const h = await serviceHarness(t);
  let paused = await h.wait(false);
  h.state.intoForeign = true;
  await h.manager({ ...h.token(paused), op: 'step-into' });
  paused = await h.wait(false); assert.equal(paused.pauses[0].stack[0].moduleKey, 'Z'.repeat(22));
  await assert.rejects(h.manager({ ...h.token(paused), op: 'scope' }), /producer_model_required/);
  assert.equal(h.bindings.length, 0, 'no address of the unbound module reaches the native worker');
  h.published.revision = 93; // the Service app is redeployed while the first scenario is paused
  await h.manager({ ...h.token(paused), op: 'continue' });
  const final = await h.wait(true);
  assert.equal(final.state, 'failed'); assert.equal(final.runResult.error, 'debug_odc_producer_publication_changed');
  assert.equal(final.runResult.failurePhase, 'publication-before-invocation'); assert.deepEqual(final.runResult.notSent, ['unicode-text']);
  assert.deepEqual(final.runResult.results.map(r => r.name), ['scalar']); assert.equal(h.events.includes('invoke:unicode-text'), false);
  assert.equal(final.runResult.uncertain, false); assert.equal(final.runResult.lockRetained, false); assert.equal(final.runResult.credentialsReleased, true);
});
