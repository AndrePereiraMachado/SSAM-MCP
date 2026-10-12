import test from 'node:test';
import { foreignPendingReason } from '../debug-foreign-pending.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareO11BptObservation, observeO11BptFrames, runO11BptOriginalLaunch } from '../debug-o11-bpt-run.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
import { createO11NativeRun } from '../debug-o11-native-run.mjs';

const moduleKey = 'M'.repeat(22), processKey = 'P'.repeat(22), entryKey = 'E'.repeat(22), activityKey = 'A'.repeat(22), startKey = 'S'.repeat(22);
const id = key => moduleKey + '*' + key;
const node = (kind, key, children = []) => ({ kind, key, name: key === activityKey ? 'Increment' : '',
  children, childrenTotal: children.length, childrenOmitted: 0, properties: {}, propertyReferences: {} });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-bpt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'source.oml'); fs.writeFileSync(file, 'synthetic-bpt-model');
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const entry = { id: id(entryKey), key: entryKey, moduleKey, kind: 'SOAPServiceAction', entry: 'soap-method' };
  const activity = { id: id(activityKey), key: activityKey, moduleKey, kind: 'AutomaticActivityNode', processOwnerKey: processKey, startNodeKey: startKey };
  const process = { id: id(processKey), key: processKey, moduleKey, kind: 'Process', process: { launchActionKey: processKey + '.#LaunchProcess' } };
  const launch = { id: id(processKey + '.#LaunchProcess'), key: processKey + '.#LaunchProcess', moduleKey, kind: 'ProcessLaunchAction' };
  const graph = { nodes: new Map([entry, process, launch, activity].map(n => [n.id, n])),
    edges: [[entry, launch], [launch, process], [process, activity]].map(([from, to]) => ({ from: from.id, to: to.id })) };
  const tree = node('AutomaticActivityNode', activityKey, [node('StartNode', startKey), { ...node('LocalVariable', 'V'.repeat(22)), name: 'Counter' }]);
  const target = { moduleKey, module: 'Probe', applicationKey: 'B'.repeat(22), host: 'personal.example', runtimeUrl: 'https://personal.example/Probe/' };
  const owner = { target, versionId: 1, snapshot: { path: file, sha256: digest }, readings: [tree], inventoryProof: {} };
  const resolution = { state: 'background-trigger-resolved', background: { processKey },
    originalLaunch: { state: 'resolved', entry: { id: entry.id }, path: [{ id: entry.id }, { id: launch.id }] },
    path: [entry, launch, process, activity].map(({ id, kind }) => ({ id, kind })) };
  return { input: { op: 'prepare', contextMode: 'native-background', launch: { contextMode: 'anonymous', inputs: {} }, timeoutSeconds: 20 },
    target, resolution, graph, captures: [owner], root, directory: root, mode: 'full', operationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
}

test('BPT keeps native launcher and activity contexts separate and scopes the actual target', t => {
  const f = fixture(t), { plan } = prepareO11BptObservation(f);
  assert.deepEqual(plan.scopes, { [activityKey]: ['Counter'] });
  assert.equal(plan.originalEntryKey, entryKey); assert.equal(plan.activityContext, 'native-background');
  assert.equal(plan.launchContext, 'anonymous'); assert.equal(plan.requestOwnershipProved, false);
});
test('BPT refuses ambiguous activity inputs, changed model and a service boundary', t => {
  const f = fixture(t);
  assert.throws(() => prepareO11BptObservation({ ...f, input: { ...f.input, inputs: { Counter: 1 } } }), /ambiguous_activity_inputs/);
  f.graph.nodes.get(id(entryKey)).kind = 'ServiceAction';
  assert.throws(() => prepareO11BptObservation(f), /runtime_boundary_unqualified/);
  f.graph.nodes.get(id(entryKey)).kind = 'SOAPServiceAction'; fs.appendFileSync(f.captures[0].snapshot.path, 'changed');
  assert.throws(() => prepareO11BptObservation(f), /published_source_changed/);
});
test('BPT only matches ends to threads that entered the target; it never invents instance correlation', () => {
  const rows = [{ threadId: 'one', functionKey: activityKey, values: [{ path: 'Counter', value: '1' }] }, { kind: 'thread-end', threadId: 'other' }];
  assert.equal(observeO11BptFrames(rows, activityKey).traceVerified, false);
  rows.push({ kind: 'thread-end', threadId: 'one' });
  const proof = observeO11BptFrames(rows, activityKey);
  assert.equal(proof.traceVerified, true); assert.equal(proof.requestOwnershipProved, false); assert.equal(proof.executionCompleted, false);
  assert.equal(proof.requestBound, false); assert.equal(proof.instanceCorrelationProved, false);
});
test('BPT matches ThreadEnd by (threadId, request fingerprint); a reused thread with another request never attests', () => {
  const [a, b] = ['a', 'b'].map(c => c.repeat(64));
  const rows = [{ threadId: 'T', eventId: '5', functionKey: activityKey, nativeRequestIdSha256: a }, { kind: 'thread-end', threadId: 'T', eventId: '9', nativeRequestIdSha256: b }];
  const mismatch = observeO11BptFrames(rows, activityKey);
  assert.equal(mismatch.traceVerified, false); assert.equal(mismatch.observedThreadEnds, 0); assert.equal(mismatch.unmatchedEnds, 1);
  rows.push({ kind: 'thread-end', threadId: 'T', eventId: '11', nativeRequestIdSha256: a });
  const bound = observeO11BptFrames(rows, activityKey);
  assert.equal(bound.traceVerified, true); assert.equal(bound.requestBound, true); assert.deepEqual(bound.fingerprints, [a]);
  assert.equal(bound.instanceCorrelationProved, false, 'a fingerprint alone is not instance correlation');
});

function endpointContract(f, protocol, authentication = 'None') {
  const owner = f.captures[0], binding = { lane: 'o11', runtimeUrl: owner.target.runtimeUrl, module: owner.target.module,
    moduleKey, revision: owner.versionId, sourceSha256: owner.snapshot.sha256 };
  const element = (kind, key, name, properties = {}, children = []) => ({ ...node(kind, key, children), name, properties });
  if (protocol === 'rest') {
    const document = { swagger: '2.0', host: 'personal.example', basePath: '/Probe/rest/Process', schemes: ['https'],
      ...(authentication === 'Basic' ? { securityDefinitions: { basic: { type: 'basic' } }, security: [{ basic: [] }] } : {}),
      paths: { '/Launch': { post: { operationId: 'Launch', parameters: [], responses: { 204: { description: 'Accepted' } } } } } };
    const body = JSON.stringify(document);
    return { binding, entryKey, model: { schema: 'ssam-reading/1', model: 'Probe', sourceSha256: binding.sourceSha256,
      tree: element('RestService', 'R'.repeat(22), 'Process', { URL: '/Probe/rest/Process', Authentication: authentication },
        [element('RestServiceAction', entryKey, 'Launch', { HTTPMethod: 'POST', URL: '/Probe/rest/Process/Launch' })]) },
      source: { url: binding.runtimeUrl + 'rest/Process/swagger.json', body, sha256: createHash('sha256').update(body).digest('hex') } };
  }
  const body = `<w:definitions xmlns:w="http://schemas.xmlsoap.org/wsdl/" xmlns:s="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:x="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:probe" targetNamespace="urn:probe">
<w:types><x:schema targetNamespace="urn:probe" elementFormDefault="qualified"><x:element name="Launch"><x:complexType><x:sequence/></x:complexType></x:element><x:element name="LaunchResponse"><x:complexType><x:sequence/></x:complexType></x:element></x:schema></w:types>
<w:message name="Input"><w:part name="parameters" element="t:Launch"/></w:message><w:message name="Output"><w:part name="parameters" element="t:LaunchResponse"/></w:message>
<w:portType name="ProbeSoap"><w:operation name="Launch"><w:input message="t:Input"/><w:output message="t:Output"/></w:operation></w:portType>
<w:binding name="ProbeBinding" type="t:ProbeSoap"><s:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/><w:operation name="Launch"><s:operation soapAction="urn:probe/Launch"/><w:input><s:body use="literal"/></w:input><w:output><s:body use="literal"/></w:output></w:operation></w:binding>
<w:service name="Process"><w:port name="ProbeSoap" binding="t:ProbeBinding"><s:address location="https://personal.example/Probe/Process.asmx"/></w:port></w:service></w:definitions>`;
  return { binding, entryKey, model: { schema: 'ssam-reading/1', model: 'Probe', sourceSha256: binding.sourceSha256,
    tree: element('WebService', 'W'.repeat(22), 'Process', { IntegratedAuthentication: 'False', HTTPSecurity: 'SSL' },
      [element('WebServiceMethod', entryKey, 'Launch')]) },
    source: { url: binding.runtimeUrl + 'Process.asmx?WSDL', body, sha256: createHash('sha256').update(body).digest('hex') } };
}

function runnable(t, { protocol = 'soap', authentication = 'None', ...overrides } = {}) {
  const f = fixture(t), events = [], report = { state: 'resolving', results: [] };
  f.input.op = 'run'; f.input.words = 'Autorizar o lançamento original em DEV';
  if (authentication === 'Basic') f.input.launch.contextMode = 'app-user';
  const entry = f.graph.nodes.get(id(entryKey));
  entry.entry = protocol + '-method'; entry.kind = protocol === 'soap' ? 'WebServiceMethod' : 'RestServiceAction';
  const contract = endpointContract(f, protocol, authentication);
  return { ...f, events, report, contract, save: () => {},
    acquireEndpoint: async () => ({ contract }),
    endpointPublicationCheck: async () => { events.push('publication-check'); },
    prepareUser: async (target, { sessionId }) => { events.push('private-login'); return { ok: true, descriptor: {
      state: 'credentials-entered', authenticated: false, credentialRef: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      binding: appUserBinding(target, sessionId), expiresAt: new Date(Date.now() + 60000).toISOString() } }; },
    releaseUser: async () => { events.push('release-user'); return { ok: true }; },
    debug: async (request, context) => {
      events.push(request.op);
      if (request.op === 'watch') { assert.deepEqual(context, { backgroundWatch: true, contextMode: 'native-background' });
        assert.equal(request.trace.focusFunctionKey, activityKey); assert.equal(request.trace.requireFunctionKey, activityKey);
        return { ok: true, state: 'connected', sessionId: 'd'.repeat(32) }; }
      return { ok: true, state: 'stopped' };
    },
    invokeEndpoint: async request => { events.push('send-original-launch');
      assert.equal(request.protocol, protocol); assert.equal(request.timeoutSeconds, 20); assert.equal(request.contract.entryKey, entryKey);
      assert.deepEqual(request.inputs, {}); assert.equal(request.context, authentication === 'Basic' ? 'app-user' : 'explicit-anonymous');
      assert.equal(!!request.descriptor, authentication === 'Basic');
      return { ok: true, status: 204, sent: true, answered: true, uncertain: false, memoryReferencesReleased: true, result: { outputs: {} } };
    },
    observeBackground: async () => { events.push('observe'); },
    traceRead: () => [{ functionKey: activityKey, threadId: 'T', values: [{ path: 'Counter', value: '1' }] }, { kind: 'thread-end', threadId: 'T' }],
    compactServerMap: rows => rows, ...overrides };
}

test('original SOAP and REST launch once; BPT watch never calls the activity and preserves non-ownership', async t => {
  for (const protocol of ['soap', 'rest']) {
    const f = runnable(t, { protocol });
    const outcome = await runO11BptOriginalLaunch(f);
    assert.equal(outcome.uncertain, false); assert.equal(f.report.serverTrace.stopped, true);
    assert.deepEqual(f.events, ['publication-check', 'watch', 'publication-check', 'send-original-launch', 'observe', 'stop']);
    assert.equal(f.report.results[0].traceVerified, true); assert.equal(f.report.results[0].executionCompleted, false);
    assert.equal(f.report.backgroundTrace.requestOwnershipProved, false); assert.equal(f.report.backgroundTrace.appUserIdentityProved, false);
  }
});

test('REST Basic launcher uses only a bound private app-user descriptor while background watch has no app identity', async t => {
  const f = runnable(t, { protocol: 'rest', authentication: 'Basic' });
  await runO11BptOriginalLaunch(f);
  assert.equal(f.report.credentialsReleased, true);
  assert.deepEqual(f.events, ['publication-check', 'private-login', 'watch', 'publication-check', 'send-original-launch', 'observe', 'stop', 'release-user']);
  assert.equal(f.report.background.applicationUserContext, false);
});

test('original Timer Wake uses the same one-send observer and never claims ownership of scheduled execution', async t => {
  for (const uncertainReply of [false, true]) {
    const f = runnable(t), timer = f.graph.nodes.get(id(processKey)), oldLaunch = f.graph.nodes.get(id(processKey + '.#LaunchProcess'));
    timer.kind = 'Timer'; timer.timer = { wakeActionKey: processKey + '.#WakeTimer', actionKey: activityKey }; delete timer.process;
    f.graph.nodes.delete(oldLaunch.id);
    const wake = { ...oldLaunch, id: id(processKey + '.#WakeTimer'), key: processKey + '.#WakeTimer', kind: 'TimerWakeAction' };
    f.graph.nodes.set(wake.id, wake); f.graph.nodes.get(id(activityKey)).kind = 'ServerAction';
    f.graph.edges = [{ from: id(entryKey), to: wake.id }, { from: wake.id, to: timer.id, via: { kind: 'timer-wake', asynchronous: true, timerKey: processKey } },
      { from: timer.id, to: id(activityKey), via: { kind: 'timer' } }];
    f.resolution.background = { timerKey: processKey };
    f.resolution.originalLaunch.path = [{ id: id(entryKey) }, { id: wake.id }];
    f.resolution.path = [id(entryKey), wake.id, timer.id, id(activityKey)].map(id => ({ id }));
    f.captures[0].readings[0].kind = 'ServerAction';
    const invoke = f.invokeEndpoint;
    f.invokeEndpoint = async request => { assert.equal(request.scenarioId, 'timer-wake'); const result = await invoke(request);
      return uncertainReply ? { ...result, ok: false, answered: false, uncertain: true } : result; };
    const outcome = await runO11BptOriginalLaunch(f);
    assert.equal(outcome.uncertain, uncertainReply); assert.equal(f.report.background.kind, 'timer-original-wake');
    assert.equal(f.events.filter(event => event === 'send-original-launch').length, 1);
    assert.equal(f.report.serverTrace.stopped, true); assert.equal(f.report.executionCompleted, false);
    assert.equal(f.report.results[0].requestOwnershipProved, false);
    assert.equal(f.events.includes('observe'), !uncertainReply);
  }
});

test('foreign endpoint binding and duplicate owner are refused before publication check, login or watch', async t => {
  const f = runnable(t); f.contract.binding.revision = 2;
  await assert.rejects(runO11BptOriginalLaunch(f), /launcher_source_binding_mismatch/); assert.deepEqual(f.events, []);
  const g = runnable(t); g.captures.push(g.captures[0]);
  await assert.rejects(runO11BptOriginalLaunch(g), /published_module_unavailable/); assert.deepEqual(g.events, []);
  const h = runnable(t); h.graph.edges.pop();
  await assert.rejects(runO11BptOriginalLaunch(h), /native_process_path_unproved/); assert.deepEqual(h.events, []);
});

test('pre-send publication failure stops watch without marking a request sent, while send failure remains uncertain', async t => {
  let checks = 0;
  const before = runnable(t, { endpointPublicationCheck: async () => { if (++checks === 2) throw new Error('publication-changed'); } });
  await assert.rejects(runO11BptOriginalLaunch(before), /publication-changed/);
  assert.equal(before.report.uncertain, false); assert.equal(before.report.serverTrace.stopped, true);
  assert.equal(before.events.includes('send-original-launch'), false);
  const after = runnable(t, { invokeEndpoint: async () => { throw new Error('private-network-detail'); } });
  await assert.rejects(runO11BptOriginalLaunch(after), /launch_outcome_uncertain/);
  assert.equal(after.report.uncertain, true); assert.equal(after.report.serverTrace.stopped, true);
  assert.equal(after.report.state, 'uncertain'); assert.doesNotMatch(JSON.stringify(after.report), /private-network-detail/);
});

test('cleanup uncertainty survives returned outcome and thrown calls; watch start uncertainty never launches', async t => {
  for (const throwSend of [false, true]) {
    const f = runnable(t, { debug: async request => request.op === 'watch'
      ? { ok: true, state: 'connected', sessionId: 'd'.repeat(32) } : { ok: false, state: 'stop-uncertain' } });
    if (throwSend) f.invokeEndpoint = async () => { throw new Error('lost'); };
    if (throwSend) await assert.rejects(runO11BptOriginalLaunch(f), /launch_outcome_uncertain/);
    else assert.equal((await runO11BptOriginalLaunch(f)).uncertain, true);
    assert.equal(f.report.uncertain, true); assert.equal(f.report.serverTrace.stopped, false);
  }
  const g = runnable(t, { debug: async () => { throw new Error('debug_start_uncertain'); } });
  await assert.rejects(runO11BptOriginalLaunch(g), /watch_start_uncertain/);
  assert.equal(g.report.uncertain, true); assert.equal(g.events.includes('send-original-launch'), false);
});

test('expired/wrong private binding is rejected and released; unknown release prevents a clean outcome', async t => {
  for (const bad of ['expired', 'module']) {
    const f = runnable(t, { protocol: 'rest', authentication: 'Basic' }), prepare = f.prepareUser;
    f.prepareUser = async (...args) => { const entered = await prepare(...args);
      if (bad === 'expired') entered.descriptor.expiresAt = new Date(0).toISOString();
      else entered.descriptor.binding.moduleKey = 'Z'.repeat(22);
      return entered; };
    await assert.rejects(runO11BptOriginalLaunch(f), /launcher_credential_binding_invalid/);
    assert.equal(f.report.credentialsReleased, true); assert.equal(f.events.includes('send-original-launch'), false);
  }
  const f = runnable(t, { protocol: 'rest', authentication: 'Basic', releaseUser: async () => ({ ok: false }) });
  assert.equal((await runO11BptOriginalLaunch(f)).uncertain, true); assert.equal(f.report.credentialsReleased, false);
});

test('an unanswered or malformed worker ledger remains uncertain even if its uncertain flag is false', async t => {
  for (const reply of [{ sent: true, answered: false, uncertain: false, memoryReferencesReleased: true },
    { ok: true, sent: false, answered: true, uncertain: false, memoryReferencesReleased: true }]) {
    const f = runnable(t, { invokeEndpoint: async () => reply });
    if (reply.ok) await assert.rejects(runO11BptOriginalLaunch(f), /launch_outcome_uncertain/);
    else assert.equal((await runO11BptOriginalLaunch(f)).uncertain, true);
    assert.equal(f.report.uncertain, true); assert.equal(f.events.includes('observe'), false);
  }
});

test('public native runner preserves BPT uncertainty and binding lock when the helper returns or throws', async t => {
  const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-o11-bpt-native-reading.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  for (const failure of ['send-throw', 'stop-after-throw', 'stop-after-answer']) {
    const f = runnable(t), process = structuredClone(captured.tree), activity = process.children.find(n => n.kind === 'AutomaticActivityNode');
    // Keep the captured native GlobalKey's module owner, not the synthetic unit-fixture owner.
    f.target.moduleKey = process.properties.GlobalKey.split('*')[0];
    f.contract.binding.moduleKey = f.target.moduleKey;
    const method = f.contract.model.tree.children[0];
    const execute = node('ExecuteServerActionNode', 'C'.repeat(22));
    execute.propertyReferences.Action = process.propertyReferences.LaunchProcessAction;
    method.children.push(execute); method.childrenTotal++;
    let checks = 0, sends = 0, stops = 0;
    const runner = createO11NativeRun({ root: f.root,
      capture: async () => ({ versionId: 1, snapshot: f.captures[0].snapshot, inventoryProof: {}, readings: [process, f.contract.model.tree] }),
      assets: async () => { throw new Error('BPT endpoint must not read client assets'); },
      acquireEndpoint: async () => ({ contract: f.contract }),
      endpointPublicationCheck: async () => { if (++checks === 2 && failure === 'stop-after-throw') throw new Error('publication-changed'); },
      debug: async request => {
        if (request.op === 'watch') { assert.equal(request.trace.focusFunctionKey, activity.key); return { ok: true, state: 'connected', sessionId: 'd'.repeat(32) }; }
        stops++; return failure === 'send-throw' ? { ok: true, state: 'stopped' } : { ok: false, state: 'stop-uncertain' };
      },
      invokeEndpoint: async () => { sends++; if (failure === 'send-throw') throw new Error('lost');
        return { ok: true, sent: true, answered: true, uncertain: false, memoryReferencesReleased: true, result: { outputs: {} } }; },
      observeBackground: async () => {}, traceRead: () => [],
    });
    const input = { ...f.input, ...f.target, lane: 'o11', action: activity.name, trace: 'full' };
    const report = await runner(input);
    assert.equal(report.resolution.state, 'background-trigger-resolved');
    assert.equal(report.uncertain, true, report.error); assert.equal(report.lockRetained, true); assert.equal(report.ok, false);
    assert.equal(stops, 1); assert.equal(sends, failure === 'stop-after-throw' ? 0 : 1);
    const repeated = await runner(input);
    assert.equal(repeated.error, 'debug_o11_native_binding_busy'); assert.equal(stops, 1);
    assert.equal(sends, failure === 'stop-after-throw' ? 0 : 1);
  }
});

test('original background launcher side-calls cannot cross a historically uncertain breakpoint even with trace none', async t => {
  const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-o11-bpt-native-reading.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  const f = fixture(t), process = structuredClone(captured.tree), activity = process.children.find(n => n.kind === 'AutomaticActivityNode');
  const blockedModule = 'Mif02PxcH0K7KiABEHTwMg', blockedNode = 'LiCk5pmr6Ueb45499t9tNw';
  const remap = node => { if (node.properties?.GlobalKey) node.properties.GlobalKey = blockedModule + '*' + node.key;
    for (const child of node.children ?? []) remap(child); };
  remap(process);
  const side = node('ServerAction', 'Q'.repeat(22), [node('StartNode', blockedNode)]); side.name = 'ExistingSideCall';
  const launchCall = node('ExecuteServerActionNode', 'C'.repeat(22)); launchCall.propertyReferences.Action = process.propertyReferences.LaunchProcessAction;
  const sideCall = node('ExecuteServerActionNode', 'D'.repeat(22)); sideCall.propertyReferences.Action = { key: side.key, kind: side.kind, name: side.name };
  const method = node('WebServiceMethod', entryKey, [launchCall, sideCall]); method.name = 'OriginalLaunch';
  let acquired = 0;
  const runner = createO11NativeRun({ root: f.root,
    capture: async () => ({ versionId: 1, snapshot: f.captures[0].snapshot, inventoryProof: {}, readings: [process, method, side] }),
    assets: async () => { throw Error('original SOAP background entry must not load AMD'); },
    acquireEndpoint: async () => { acquired++; throw Error('must refuse before acquiring a runnable contract'); },
  });
  const result = await runner({ ...f.input, op: 'run', words: 'Run original launcher once', module: 'Probe', moduleKey: blockedModule,
    applicationKey: 'Z'.repeat(22), host: 'personal-2qqw9srv.outsystemscloud.com', runtimeUrl: 'https://personal-2qqw9srv.outsystemscloud.com/Probe/',
    action: activity.name, trace: 'none' });
  assert.equal(result.resolution.state, 'background-trigger-resolved');
  assert.equal(result.error, 'debug_o11_native_path_crosses_uncertain_breakpoint:4c7016f0a51445108b185fdcd0109586');
  assert.equal(acquired, 0); assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false);
});

function interactiveTimerFixture(t){
 const f=runnable(t),timer=f.graph.nodes.get(id(processKey)),oldLaunch=f.graph.nodes.get(id(processKey+'.#LaunchProcess'));
 timer.kind='Timer';timer.timer={wakeActionKey:processKey+'.#WakeTimer',actionKey:activityKey};delete timer.process;f.graph.nodes.delete(oldLaunch.id);
 const wake={...oldLaunch,id:id(processKey+'.#WakeTimer'),key:processKey+'.#WakeTimer',kind:'TimerWakeAction'};
 f.graph.nodes.set(wake.id,wake);f.graph.nodes.get(id(activityKey)).kind='ServerAction';
 f.graph.edges=[{from:id(entryKey),to:wake.id},{from:wake.id,to:timer.id,via:{kind:'timer-wake',asynchronous:true,timerKey:processKey}},{from:timer.id,to:id(activityKey),via:{kind:'timer'}}];
 f.resolution.background={timerKey:processKey};f.resolution.originalLaunch.path=[{id:id(entryKey)},{id:wake.id}];f.resolution.path=[id(entryKey),wake.id,timer.id,id(activityKey)].map(id=>({id}));f.captures[0].readings[0].kind='ServerAction';
 f.prepareServerInspection=async binding=>{assert.equal(binding.functionKey,activityKey);assert.deepEqual(binding.source,f.captures[0].snapshot);f.events.push('prepare-scope')};
 f.beforeServerInvocation=async()=>f.events.push('before-send');
 const debug=f.debug;f.debug=async(request,context)=>{const result=await debug(request,context);return request.op==='watch'?{...result,autoContinue:false,inspectionMode:'interactive',expiresAt:new Date(Date.now()+450000).toISOString()}:result};
 return f;
}
test('interactive original Timer prepares native scope and keeps the fixed session deadline through observed ThreadEnd',async t=>{
 const f=interactiveTimerFixture(t);let observationSeconds;f.observeBackground=async(session,key,seconds)=>{observationSeconds=seconds};
 await runO11BptOriginalLaunch(f);assert.deepEqual(f.events,['prepare-scope','publication-check','watch','publication-check','before-send','send-original-launch','stop']);
 assert.ok(observationSeconds>400&&observationSeconds<=450);assert.equal(f.report.serverTrace.inspectionMode,'interactive');assert.equal(f.report.results[0].traceVerified,true);
 assert.equal(f.report.executionCompleted,false);assert.equal(f.report.results[0].requestOwnershipProved,false);
});
test('interactive Timer refuses missing metadata, cancellation and missing target completion without replay',async t=>{
 const cancelled=interactiveTimerFixture(t);cancelled.beforeServerInvocation=async()=>{throw Error('debug_cancelled')};await assert.rejects(runO11BptOriginalLaunch(cancelled),/debug_cancelled/);assert.ok(!cancelled.events.includes('send-original-launch'));assert.ok(cancelled.events.includes('stop'));
 const incomplete=interactiveTimerFixture(t);incomplete.traceRead=()=>[{threadId:'T',functionKey:activityKey}];await runO11BptOriginalLaunch(incomplete);assert.equal(incomplete.report.results[0].ok,false);assert.match(incomplete.report.results[0].error,/interactive_trace_incomplete/);
 const bpt=runnable(t);bpt.prepareServerInspection=async()=>{throw Error('should not call')};await assert.rejects(runO11BptOriginalLaunch(bpt),/interactive_timer_required/);assert.equal(bpt.events.length,0);
});

const REQUEST='c'.repeat(64);
const boundTrace=()=>[{threadId:'T',eventId:'5',functionKey:activityKey,nativeRequestIdSha256:REQUEST,values:[{path:'Counter',value:'1'}]},{kind:'thread-end',threadId:'T',eventId:'9',nativeRequestIdSha256:REQUEST}];
const correlated=over=>({state:'correlated',instanceCorrelationProved:true,matchedFingerprint:REQUEST,requestKeySha256:REQUEST,outcome:'completed',executionCompleted:true,newExactTimerRowObserved:true,errorBound:false,newExactRows:1,...over});
function correlatedTimer(t,observe=async()=>correlated()){
 const f=interactiveTimerFixture(t);f.traceRead=boundTrace;
 f.timerInstance={baseline:async()=>{f.events.push('baseline');return {available:true,runs:[]}},observe:async args=>{f.events.push('correlate');return observe(args)}};
 return f;
}
test('original Timer Wake sets instanceCorrelationProved only from the correlator, after ThreadEnd and after the debugger stop',async t=>{
 const f=correlatedTimer(t);await runO11BptOriginalLaunch(f);
 assert.deepEqual(f.events,['prepare-scope','publication-check','watch','baseline','publication-check','before-send','send-original-launch','observe','stop','correlate']);
 assert.equal(f.report.results[0].instanceCorrelationProved,true);assert.equal(f.report.results[0].requestBound,true);
 assert.equal(f.report.instanceCorrelation.state,'correlated');assert.equal(f.report.executionCompleted,true);assert.equal(f.report.results[0].outcome,'completed');
 assert.equal(f.report.results[0].requestOwnershipProved,false);
 const unwired=interactiveTimerFixture(t);unwired.traceRead=boundTrace;await runO11BptOriginalLaunch(unwired);
 assert.equal(unwired.report.results[0].instanceCorrelationProved,false);assert.equal(unwired.report.instanceCorrelation.reason,'service_center_observer_unwired');
 assert.equal(unwired.report.executionCompleted,false);
 const foreign=correlatedTimer(t,async()=>correlated({matchedFingerprint:'d'.repeat(64)}));await runO11BptOriginalLaunch(foreign);
 assert.equal(foreign.report.results[0].instanceCorrelationProved,false);assert.equal(foreign.report.executionCompleted,false);
 const failed=correlatedTimer(t,async()=>{throw Error('private sc detail')});const outcome=await runO11BptOriginalLaunch(failed);
 assert.equal(outcome.uncertain,false);assert.equal(failed.report.instanceCorrelation.reason,'service_center_read_failed');
 assert.equal(failed.report.executionCompleted,false);assert.doesNotMatch(JSON.stringify(failed.report),/private sc detail/);
 const noBaseline=correlatedTimer(t);noBaseline.timerInstance.baseline=async()=>({available:false,reason:'incomplete-log-list'});
 await assert.rejects(runO11BptOriginalLaunch(noBaseline),/timer_instance_baseline_unavailable/);
 assert.ok(!noBaseline.events.includes('send-original-launch'));assert.equal(noBaseline.report.uncertain,false);assert.ok(noBaseline.events.includes('stop'));
});
test('interactive Timer result carries values coverage per root; Timers.* stays native-unavailable',async t=>{
 const ctx=eventId=>({runtime:'server',threadId:'T',eventId,generation:1});
 const value=(reference,path,over={})=>({reference,path,category:'local',type:'Scalar',value:'1',textOffset:0,textLength:1,nextTextOffset:null,valueComplete:true,
  redacted:false,unavailable:false,undefined:false,trimmed:false,deferred:false,nativeSummary:false,hasChildren:false,...over});
 const read=(reference,v)=>({ok:true,context:ctx('5'),reference,value:v,children:[],offset:0,nextOffset:null,availableChildren:0});
 const f=correlatedTimer(t);f.scopeEvidence=async()=>[{scopeVariables:[{reference:'r1',name:'Counter',category:'local'},{reference:'r2',name:'Timers.Probe',category:'site'}],
  reads:[read('r1',value('r1','Counter')),read('r2',value('r2','Timers.Probe',{valueComplete:false,undefined:true,value:'-undefined-'}))]}];
 await runO11BptOriginalLaunch(f);
 const coverage=f.report.results[0].valuesCoverage;
 assert.deepEqual(coverage.roots.map(r=>[r.name,r.state]),[['Counter','complete'],['Timers.Probe','native-unavailable']]);
 assert.deepEqual(coverage.nativeUnavailableRoots.map(r=>r.name),['Timers.Probe']);assert.equal(coverage.valuesComplete,false);
 assert.equal(f.report.background.valuesComplete,false);assert.equal(f.report.results[0].valuesComplete,false);
 f.scopeEvidence=async()=>[{scopeVariables:[{reference:'r1',name:'Counter',category:'local'}],reads:[read('r1',value('r1','Counter'))]}];
 const g=correlatedTimer(t);g.scopeEvidence=f.scopeEvidence;await runO11BptOriginalLaunch(g);
 assert.equal(g.report.background.valuesComplete,true);assert.equal(g.report.results[0].valuesCoverage.coverageSource,'rootCoverage');
 const bounded=runnable(t);await runO11BptOriginalLaunch(bounded);
 assert.equal(bounded.report.background.valuesComplete,false);assert.equal(bounded.report.results[0].valuesCoverage.reason,'bounded_trace_without_native_completeness');
});test('original Timer Wake composes with the real read-only Service Center correlator',{skip:foreignPendingReason('timer-observation')},async t=>{
 const {createO11TimerInstanceObserver}=await import('../debug-o11-background-instance.mjs');
 const KEY='c0ffee00-1111-4222-8333-444455556666',fp=createHash('sha256').update(KEY).digest('hex'),SC='https://sc.example.test/ServiceCenter/';
 const timerTarget=SC+'eSpace_Timer_Edit.aspx?Cyclic_Job_Key=key1';
 const row={fields:{'Time of Log':'2026-10-11 10:00:01',Timer:'Tick',Duration:'1s',Server:'s1'},links:[{href:timerTarget+'&EspaceId=577'}]};
 let timerReads=0,clock=0;const writes=[];
 const client={logs:async kind=>({complete:true,truncated:false,rows:kind==='timer'?(timerReads++?[row]:[]):kind==='general'?[{fields:{},links:[{href:SC+'GroupedRequest_Logs.aspx?RequestKey='+KEY}]}]:[]}),
  trace:async()=>({logs:{rows:[],complete:true}}),errorDetail:async()=>{throw Error('no error link')},post:()=>writes.push('post')};
 const f=interactiveTimerFixture(t);
 f.traceRead=()=>[{threadId:'T',eventId:'5',functionKey:activityKey,nativeRequestIdSha256:fp},{kind:'thread-end',threadId:'T',eventId:'9',nativeRequestIdSha256:fp}];
 f.timerInstance=createO11TimerInstanceObserver({client,identity:{host:'sc.example.test',moduleId:'577',name:'Tick',module:'Probe'},target:timerTarget,
  pollMs:1000,now:()=>Date.now()+clock,sleep:async ms=>{clock+=ms}});
 await runO11BptOriginalLaunch(f);
 assert.equal(f.report.instanceCorrelation.state,'correlated');assert.equal(f.report.results[0].instanceCorrelationProved,true);
 assert.equal(f.report.executionCompleted,true);assert.equal(f.report.instanceCorrelation.requestKeySha256,fp);
 assert.doesNotMatch(JSON.stringify(f.report),new RegExp(KEY));assert.deepEqual(writes,[]);assert.equal(f.report.serverTrace.stopped,true);
});
// Kind-specific namespace: Timer-path failures and folders are 'timer'; BPT keeps 'bpt'. Historical receipts are only read through the alias table.
const timerRunnable=(t,over={})=>{const f=interactiveTimerFixture(t);delete f.prepareServerInspection;delete f.beforeServerInvocation;return Object.assign(f,over)};
test('Timer-path failures use debug_native_background_timer_* and publication-before-timer folders; BPT keeps bpt',async t=>{
 const folders=f=>{const seen=[];f.endpointPublicationCheck=async(owner,dir)=>{seen.push(path.basename(dir))};return seen};
 const timer=timerRunnable(t),tf=folders(timer);await runO11BptOriginalLaunch(timer);
 assert.deepEqual(tf,['publication-before-timer','publication-before-timer-send']);
 const bpt=runnable(t),bf=folders(bpt);await runO11BptOriginalLaunch(bpt);
 assert.deepEqual(bf,['publication-before-bpt','publication-before-bpt-send']);
 const lost=async()=>{throw new Error('lost')};
 await assert.rejects(runO11BptOriginalLaunch(timerRunnable(t,{invokeEndpoint:lost})),{message:'debug_native_background_timer_launch_outcome_uncertain'});
 await assert.rejects(runO11BptOriginalLaunch(runnable(t,{invokeEndpoint:lost})),{message:'debug_native_background_bpt_launch_outcome_uncertain'});
 const ambiguous=timerRunnable(t);ambiguous.input.inputs={Counter:1};
 assert.throws(()=>prepareO11BptObservation(ambiguous),{message:'debug_native_background_timer_ambiguous_activity_inputs'});
 const g=fixture(t);g.input.inputs={Counter:1};
 assert.throws(()=>prepareO11BptObservation(g),{message:'debug_native_background_bpt_ambiguous_activity_inputs'});
 const noBaseline=timerRunnable(t,{traceRead:boundTrace,timerInstance:{baseline:async()=>({available:false})}});
 await assert.rejects(runO11BptOriginalLaunch(noBaseline),{message:'debug_native_background_timer_timer_instance_baseline_unavailable'});
 const {HISTORICAL_CODE_ALIASES}=await import('../debug-o11-bpt-run.mjs');
 assert.ok(Object.isFrozen(HISTORICAL_CODE_ALIASES));assert.equal(HISTORICAL_CODE_ALIASES.debug_native_background_bpt_launch_outcome_uncertain,'debug_native_background_timer_launch_outcome_uncertain');
});
test('native-background prepare on the retained SSAMDebuggerProbe binding is refused with <kind>_binding_retained before capture',async t=>{
 const retained={host:'personal-2qqw9srv.outsystemscloud.com',moduleKey:'bf7WCuRy7keTqvquautTGg'};
 const untouchable=()=>new Proxy([],{get:()=>assert.fail('capture read before the retained-binding refusal')});
 for(const [make,kind] of [[timerRunnable,'timer'],[runnable,'bpt']]){
  const f=make(t);Object.assign(f.target,retained);f.input.op='prepare';
  assert.throws(()=>prepareO11BptObservation({...f,captures:untouchable()}),{message:`debug_native_background_${kind}_binding_retained`});
  let acquired=0;const r=make(t);Object.assign(r.target,retained);r.acquireEndpoint=async()=>{acquired++;return {}};
  await assert.rejects(runO11BptOriginalLaunch({...r,captures:untouchable()}),{message:`debug_native_background_${kind}_binding_retained`});
  assert.equal(acquired,0);assert.deepEqual(r.events,[]);assert.equal(r.report.background,undefined);
 }
 const {refuseRetainedBackgroundBinding}=await import('../debug-o11-bpt-run.mjs');
 assert.throws(()=>refuseRetainedBackgroundBinding({...retained,kind:'timer'}),{message:'debug_native_background_timer_binding_retained'});
 assert.throws(()=>refuseRetainedBackgroundBinding(retained),{message:'debug_native_background_binding_retained'});
 assert.doesNotThrow(()=>refuseRetainedBackgroundBinding({host:'personal-2qqw9srv.outsystemscloud.com',moduleKey:'M'.repeat(22),kind:'bpt'}));
});

// Wave 3 integration (PX05): native BPT scope roots only with explicit scope-reader services; a failure keeps the actionModel roots.
test('BPT process launch reads native scope roots only with explicit services; a missing process node keeps the model roots', async t => {
  const plain = runnable(t, { protocol: 'rest' });
  await runO11BptOriginalLaunch(plain);
  assert.equal(plain.report.background.scopeReadError, undefined); assert.deepEqual(plain.report.background.scopes, { [activityKey]: ['Counter'] });
  let used = 0;
  const reader = { build: async () => { used++; throw new Error('no native build in tests'); }, exec: async () => { used++; throw new Error('no exec'); } };
  const wired = runnable(t, { protocol: 'rest', bptNativeScopes: reader });
  const outcome = await runO11BptOriginalLaunch(wired);
  assert.equal(outcome.uncertain, false); assert.equal(used, 0, 'no process node: the native reader is never started');
  assert.equal(wired.report.background.scopeReadError, 'debug_o11_bpt_scope_process_unavailable');
  assert.deepEqual(wired.report.background.scopes, { [activityKey]: ['Counter'] });
  assert.equal(wired.report.results[0].valuesCoverage.reason, 'bounded_trace_without_native_completeness');
});
