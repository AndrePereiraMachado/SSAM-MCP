import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { qualifyStaticReadModel, qualifyStaticReadRuntime, qualifyStaticReadHistory } from '../debug-odc-native-static-read.mjs';
import { runOdcNativeLive } from '../debug-odc-native-live.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
import { reconcileOdcProducerPreflight } from '../debug-odc-native-preflight-reconcile.mjs';
const key = c => c.repeat(22), sha = data => createHash('sha256').update(data).digest('hex');
function model() {
  const n = (kind, key, properties = {}, children = [], propertyReferences = {}) => ({ kind, key, name: properties.Name,
    properties, children, propertyReferences, childrenOmitted: 0 });
  const expr = (owner, field, value) => ({ ...n('TextBasedExpression', owner + '.#' + field), name: value });
  const arg = (id, parameter, value, extra = {}) => n('Argument', id, { Value: value }, [expr(id, 'Value', value)], { Parameter: { key: parameter }, ...extra });
  const link = (node, next) => { node.propertyReferences.Target = { key: next.key }; node.children.push(n('ActionConnector', node.key + '-link', {}, [], { Target: { key: next.key } })); };
  const entity = n('StaticEntity', key('E'), { Name: 'Color' }, [n('StaticEntityRecord', 'one', { Identifier: 'Red' }),
    n('EntityActionSignature', key('E') + '.#GetEntity', {}, [n('InputParameterSignature', key('E') + '.#GetEntity.#Id'), n('OutputParameterSignature', key('E') + '.#GetEntity.#Record')])]);
  const append = n('ServerActionSignature', key('L'), { OriginalKey: key('Z') }, [n('InputParameterSignature', 'list', { Name: 'List' }), n('InputParameterSignature', 'element', { Name: 'Element' })]);
  const start = n('StartNode', key('S')), end = n('EndNode', key('T'));
  const read = n('ExecuteServerActionNode', key('G'), { Name: 'GetColor' }, [arg('id', entity.key + '.#GetEntity.#Id', 'Entities.Color.Red')],
    { Action: { key: entity.key + '.#GetEntity', kind: 'EntityActionSignature' } });
  const add = n('ExecuteServerActionNode', key('H'), { Name: 'Append' }, [arg('l', 'list', 'Rows'), arg('e', 'element', 'GetColor.Record', { ConcreteParameterType: { key: entity.key } })],
    { Action: { key: append.key, kind: 'ServerActionSignature' } });
  link(start, read); link(read, add); link(add, end);
  const producer = n('ServerAction', key('P'), {}, [n('OutputParameter', 'out', { Name: 'Rows' }, [], { DataType: { kind: 'ListType' } }), start, read, add, end]);
  const s = n('StartNode', key('U')), e = n('EndNode', key('V'));
  const call = n('ExecuteServerActionNode', key('C'), { Name: 'ReadColors' }, [], { Action: { key: key('I') } });
  const assignment = n('Assignment', 'assignment', { Variable: 'Rows', Value: 'ReadColors.Rows' },
    [expr('assignment', 'Variable', 'Rows'), expr('assignment', 'Value', 'ReadColors.Rows')]);
  const assign = n('AssignNode', key('D'), {}, [assignment]); link(s, call); link(call, assign); link(assign, e);
  const entry = n('DataAction', key('A'), {}, [n('OutputParameter', 'entry-out', { Name: 'Rows' }, [], { DataType: { kind: 'ListType' } }),
    n('UILifeCycleEvent', 'after'), s, call, assign, e]);
  const prepared = { entry: { key: entry.key, kind: 'DataAction' }, action: { key: key('I'), kind: 'ServerActionSignature', inputs: [] },
    producerTarget: { kind: 'library-reference', executable: true, signatureKey: key('I'), actionKey: producer.key, producerModuleKey: key('M'),
      sourceContract: { sha256: 'f'.repeat(64) }, consumer: { runtimeUrl: 'https://dev.example.test/Store/' } },
    path: [{ key: entry.key }, { key: key('I') }], bindings: [], assumptions: [], scenarios: [{ name: 'read', inputs: {} }],
    runtimeRequestKeys: [entry.key], effectEvidence: [
      { kind: 'ExecuteServerActionNode', actionKey: key('I') }, { kind: 'ExecuteServerActionNode', actionKey: entity.key + '.#GetEntity' },
      { kind: 'ExecuteServerActionNode', actionKey: append.key, bodyUnavailable: 'system-model-unavailable',
        reference: { originalActionKey: key('Z'), moduleKey: key('Y'), consumerSourceSha256: 'f'.repeat(64) }, producer: { moduleKey: key('Y') } }] };
  const endpoint = 'screenservices/Store/Main/Block/DataActionRead';
  const plan = { member: { key: entry.key, call: { kind: 'data-action', endpoint, apiVersion: '1' } }, invocation: 'data-action',
    view: { key: 'view' }, screen: { key: 'screen' }, inputs: [], endpoints: { [endpoint]: '1' } };
  return { prepared, entry, producer, append, entity, builtinListAppend: key('Z'), plan };
}
test('only complete static GetEntity plus installed ListAppend chains qualify; no expression evaluation', () => {
  const f = model(), proof = qualifyStaticReadModel(f); assert.equal(proof.staticReads, 1); assert.equal(proof.writesBusinessData, false);
  assert.equal(qualifyStaticReadRuntime(f.prepared, f.plan, proof).endpoint, '/Store/' + f.plan.member.call.endpoint);
  for (const change of [
    f => f.append.properties.OriginalKey = key('Q'),
    f => f.prepared.effectEvidence[2].bodyUnavailable = null,
    f => f.entity.childrenOmitted = 1,
    f => f.producer.children.push({ kind: 'InputParameter', key: 'input', children: [] }),
    f => f.producer.children[2].children[0].properties.Value = 'GetSecret()',
    f => f.producer.children[3].children[0].properties.Value = 'Global.Rows',
    f => f.entry.children[1].children.push({ kind: 'ScreenAction', key: 'handler', children: [] }),
    f => f.entry.children[4].children[0].properties.Variable = 'Global.Rows',
    f => f.producer.children[2].propertyReferences.Target.key = key('S'),
    f => f.prepared.effectEvidence.push({ kind: 'SQLNode' }),
    f => f.prepared.producerTarget.kind = 'service-reference',
  ]) { const bad = model(); change(bad); assert.throws(() => qualifyStaticReadModel(bad), /debug_odc_native_static_read_/); }
  const side = model(); side.plan.endpoints.other = '1'; assert.throws(() => qualifyStaticReadRuntime(side.prepared, side.plan, proof), /runtime_unsupported/);
});
function fixture(t, sidecall = false, scalar = false) {
  const f = model(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-static-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, data) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); return file; };
  const binding = { tenant: 'dev.example.test', module: 'Store', app: 'Store', moduleKey: key('B'), runtimeUrl: 'https://dev.example.test/Store/', revision: 1 };
  const operationId = '40448a18-0401-4ae0-9731-11cc80ac08a0', sessionId = 'a'.repeat(32);
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }); assert.equal(dead.status, 0);
  const old = { schema: 'ssam-odc-native-run/1', lane: 'odc', operationId, sessionId, binding, entry: { key: key('O') }, path: [{ key: key('O') }],
    uncertain: true, lockRetained: true, credentialsReleased: true, serverTrace: { sessionId, stopped: true } };
  const oldFile = write('.local/debugger/native-runs/odc/' + operationId + '/receipt.json', old);
  const debugFile = write('.local/debugger/' + sessionId + '/receipt.json', { ok: true, state: 'stopped', sessionId, lane: 'odc', expiresAt: '2025-01-01T00:00:00Z', processId: dead.pid });
  const manifest = write('.local/debugger/' + sessionId + '/manifest.json', { sessionId, lane: 'odc', appUser: {
    binding: appUserBinding({ ...binding, lane: 'odc' }, sessionId), expiresAt: '2025-01-01T00:00:00Z' } });
  const bindingHash = sha('odc|' + binding.runtimeUrl + '|' + binding.moduleKey);
  const lock = write('.local/debugger/native-runs/' + bindingHash + '.lock', { operationId, sessionId });
  const latest = write('.local/debugger/native-runs/odc/' + bindingHash + '.json', old);
  const protectedFiles = [oldFile, debugFile, manifest, lock, latest], pins = protectedFiles.map(file => sha(fs.readFileSync(file)));
  const source = write('model.oml', 'synthetic model'), producerSource = write('producer.oml', 'synthetic producer');
  const producerHash = sha(fs.readFileSync(producerSource)); f.prepared.producerTarget.sourceContract = { path: producerSource, sha256: producerHash };
  f.prepared.effectEvidence[2].reference.consumerSourceSha256 = producerHash;
  let scalarOwner;
  if (scalar) {
    scalarOwner = { kind: 'MobileScreen', key: 'screen', name: 'Probe', path: 'MobileFlow:Tests/MobileScreen:Probe', children: [] };
    const output = { kind: 'OutputParameter', key: 'scalar-output', name: 'Result', properties: { DataType: 'BasicType:Integer' }, children: [] };
    const start = structuredClone(f.entry.children[2]), assign = structuredClone(f.entry.children[4]), end = structuredClone(f.entry.children[5]);
    start.propertyReferences.Target.key = assign.key; start.children[0].propertyReferences.Target.key = assign.key;
    const assignment = assign.children.find(n => n.kind === 'Assignment');
    assignment.properties.Variable = 'Result'; assignment.properties.Value = '42';
    for (const child of assignment.children) child.name = child.key.endsWith('.#Variable') ? 'Result' : '42';
    f.entry.name = 'ReadValue'; f.entry.path = scalarOwner.path + '/DataAction:ReadValue';
    f.entry.children = [output, start, assign, end];
    delete f.prepared.producerTarget; f.prepared.action = { key: f.entry.key, kind: 'DataAction', inputs: [] };
    f.prepared.path = [{ key: f.entry.key }]; f.prepared.effectEvidence = []; f.prepared.effects = [];
  }
  const member = { ...f.plan.member, chunk: 'entry.js', holder: { name: 'read' }, controllerFactory: 'controller' };
  const view = { key: 'screen', displayName: 'Main', chunk: 'entry.js', controllerFactory: 'controller' };
  const readers = { binding, sourceContract: { path: source, sha256: sha(fs.readFileSync(source)) },
    runtime: { moduleVersion: 'v1', index: { functions: { [f.entry.key]: [member] }, views: { screen: [view] }, screens: { Main: {} }, groups: {} } },
    tree: async selector => scalar && selector === '@screen' ? scalarOwner : f.entry, inspectionModel: () => ({ source: f.prepared.producerTarget.sourceContract, reader: {
      tree: async selector => [f.producer, f.entity, f.append].find(n => '@' + n.key === selector) } }), verifyPublication: async () => {} };
  const history = { operationId, receiptSha256: pins[0], debugReceiptSha256: pins[1], manifestSha256: pins[2] };
  const events = []; let currentSession;
  const services = { root, independentStaticRead: history,
    staticReadScopes: async () => ({ nativeBuiltins: { listAppend: key('Z') }, evidence: [] }),
    prepareUser: async (input, { sessionId }) => { currentSession = sessionId; events.push('login'); return { ok: true, descriptor: {
      binding: appUserBinding(input, sessionId), expiresAt: new Date(Date.now() + 600000).toISOString() } }; }, releaseUser: async () => ({ ok: true }),
    broker: ({ beforeRequest }) => ({ prepare: async () => events.push('prepare'), authenticate: async () => ({ authenticated: true, identityMatches: true }),
      invoke: async () => { events.push('invoke'); const metadata = { probeId: 'scenario-1-read', path: '/Store/' + f.plan.member.call.endpoint,
        bindingSessionId: currentSession, privateEvidenceConfirmed: true, nativeCallContextSha256: null };
        assert.equal(await beforeRequest(metadata), true);
        if (sidecall) assert.equal(await beforeRequest({ ...metadata, probeId: 'scenario-1-extra', path: '/Store/screenservices/Other' }), false);
        return { ok: true, uncertain: false }; }, dispose: async () => ({ completed: true }) }) };
  return { ...f, readers, services, events, root, binding, history, protectedFiles, pins };
}
test('a distinct static read keeps all historical evidence and the write mutex; extra requests fail the run', async t => {
  const f = fixture(t);
  const result = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services);
  assert.equal(result.ok, true, result.error); assert.equal(result.independentStaticRead.historyUnchangedAfterRun, true);
  assert.equal(result.independentStaticRead.executionOutcomeReconciled, false); assert.equal(result.requestEvidence.length, 1);
  assert.deepEqual(f.protectedFiles.map(file => sha(fs.readFileSync(file))), f.pins);
  const ordinary = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, { ...f.services, independentStaticRead: undefined });
  assert.equal(ordinary.error, 'debug_odc_native_binding_busy'); assert.equal(f.events.filter(e => e === 'invoke').length, 1);
  const bad = fixture(t, true), blocked = await runOdcNativeLive({ trace: 'none' }, bad.prepared, bad.readers, bad.services);
  assert.equal(blocked.ok, false); assert.equal(blocked.results[0].error, 'debug_odc_native_static_read_request_unproved');
  assert.equal(blocked.staticReadRequestsRefused, 1); assert.deepEqual(bad.protectedFiles.map(file => sha(fs.readFileSync(file))), bad.pins);
});
test('same historical entry, changed evidence, extra scenarios and writes refuse before login', async t => {
  const f = fixture(t);
  const changed = structuredClone(f.prepared); changed.entry.key = key('O');
  assert.throws(() => qualifyStaticReadHistory(f.root, f.binding, f.history, changed), /historical_entry_not_independent/);
  assert.throws(() => qualifyStaticReadHistory(f.root, f.binding, { ...f.history, receiptSha256: '0'.repeat(64) }, f.prepared), /evidence_changed/);
  f.prepared.scenarios.push({ name: 'second', inputs: {} });
  const refused = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services);
  assert.equal(refused.error, 'debug_odc_native_static_read_scenario_unsupported'); assert.deepEqual(f.events, []);
  const write = fixture(t); write.producer.children[2].propertyReferences.Action.key = key('E') + '.#UpdateEntity';
  const rejected = await runOdcNativeLive({ trace: 'none' }, write.prepared, write.readers, write.services);
  assert.equal(rejected.ok, false); assert.deepEqual(write.events, []);
});

test('scalar Data Action uses the same single-request barrier and preserves historical receipts and lock', async t => {
  const f = fixture(t, false, true);
  const result = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.independentStaticRead.qualification.classification, 'native-scalar-data-read');
  assert.equal(result.independentStaticRead.historyUnchangedAfterRun, true);
  assert.equal(result.requestEvidence.length, 1);
  assert.deepEqual(f.protectedFiles.map(file => sha(fs.readFileSync(file))), f.pins);
  const bad = fixture(t, true, true);
  const refused = await runOdcNativeLive({ trace: 'none' }, bad.prepared, bad.readers, bad.services);
  assert.equal(refused.ok, false); assert.equal(refused.staticReadRequestsRefused, 1);
  assert.deepEqual(bad.protectedFiles.map(file => sha(fs.readFileSync(file))), bad.pins);
});
test('known producer preflight is reconciled only with zero requests, no native session and verified cleanup; original evidence remains', async t => {
  const f = fixture(t), operationId = '22222222-2222-4222-8222-222222222222', sessionId = 'b'.repeat(32);
  const dir = path.join(f.root, '.local/debugger/native-runs/odc', operationId); fs.mkdirSync(dir);
  const lock = path.join(f.root, '.local/debugger/native-runs', sha('odc|' + f.binding.runtimeUrl + '|' + f.binding.moduleKey) + '.static-read.lock');
  fs.writeFileSync(lock, JSON.stringify({ operationId, sessionId }));
  const report = { schema: 'ssam-odc-native-run/1', operationId, sessionId, binding: f.binding, state: 'uncertain',
    error: 'debug_odc_producer_redaction_binding_invalid', serverTrace: { state: 'start-outcome-unknown' }, results: [],
    credentialsReleased: true, finishedAt: new Date().toISOString(), lockRetained: true,
    independentStaticRead: { ...qualifyStaticReadHistory(f.root, f.binding, f.history, f.prepared), historyUnchangedAfterRun: true },
    cleanup: { completed: true, receipt: { cleanupConfirmed: true, authenticationSyncUncertain: false, nativeResponses: [],
      transport: { uncertain: false, probes: [], networkRequests: 0, executeRequestSubmissions: 0, negotiations: 0,
        socketConnections: 0, longPollingConnections: 0, longPollingSendRequests: 0 } } } };
  const file = path.join(dir, 'receipt.json'), session = { lane: 'odc', state: 'uncertain', runResult: report };
  const persist = () => fs.writeFileSync(file, JSON.stringify(report));
  for (const field of ['networkRequests', 'executeRequestSubmissions', 'negotiations', 'socketConnections']) {
    report.cleanup.receipt.transport[field] = 1; persist();
    assert.throws(() => reconcileOdcProducerPreflight(f.root, session), /request_or_channel_observed/);
    assert.equal(fs.existsSync(lock), true); report.cleanup.receipt.transport[field] = 0;
  }
  const nativeDir = path.join(f.root, '.local/debugger', sessionId); fs.mkdirSync(nativeDir); persist();
  assert.throws(() => reconcileOdcProducerPreflight(f.root, session), /native_session_observed/);
  fs.rmdirSync(nativeDir); persist(); const original = fs.readFileSync(file);
  const result = reconcileOdcProducerPreflight(f.root, session);
  assert.equal(result.state, 'reconciled-not-started'); assert.equal(result.businessRequestsSubmitted, 0);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(result.archive), true);
  assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(f.protectedFiles.map(file => sha(fs.readFileSync(file))), f.pins);
  assert.equal(reconcileOdcProducerPreflight(f.root, session).state, 'reconciled-not-started');
});
