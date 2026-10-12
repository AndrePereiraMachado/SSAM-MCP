import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createO11NativeRun, blockedBinding, bindingHash, BLOCKED_BINDINGS, compactServerMap, nativeRequestObservation } from '../debug-o11-native-run.mjs';

test('request observations count distinct native requests without claiming ownership or completeness',()=>{
 const row={threadId:'T',functionKey:'F',nativeRequestIdProvenance:true,nativeRequestIdSha256:'a'.repeat(64)};
 const result=nativeRequestObservation([row,{...row},{...row,threadId:'U',nativeRequestIdSha256:'b'.repeat(64)},
   {threadId:'V',functionKey:'F'}, {...row,functionKey:'OTHER',nativeRequestIdSha256:'c'.repeat(64)}],'F');
 assert.equal(result.observedRequestsAtLeast,2);assert.equal(result.observedThreads,3);
 assert.equal(result.multipleNativeRequestsObserved,true);assert.equal(result.allTargetPausesHaveRequestProvenance,false);
 assert.equal(result.requestOwnershipProved,false);
 const fallback=nativeRequestObservation([{...row,nativeRequestIdProvenance:false},{...row,nativeRequestIdSha256:'raw-private'}],'F');
 assert.equal(fallback.observedRequestsAtLeast,0);assert.equal(fallback.requestOwnershipProved,false);
 assert.doesNotMatch(JSON.stringify(fallback),/raw-private/);
 assert.equal(nativeRequestObservation([],'F').allTargetPausesHaveRequestProvenance,false);
});

test('trace compaction retains native request fingerprints and separates reused threads',()=>{
  const row={threadId:'private-thread',eventId:'1',functionKey:'function',values:[{path:'Counter',value:'0'}]};
  const first='a'.repeat(64),second='b'.repeat(64);
  const result=compactServerMap([{...row,nativeRequestIdSha256:first},{...row,nativeRequestIdSha256:first},
    {...row,nativeRequestIdSha256:second}]);
  assert.deepEqual(result[0].values,row.values);assert.deepEqual(result[1].changed,[]);
  assert.deepEqual(result[2].values,row.values);assert.equal(result[2].nativeRequestIdSha256,second);
  assert.equal(JSON.stringify(result).includes('private-thread'),false);
});

test('explicit request IDs equal to thread IDs retain provenance without proving HTTP correlation',()=>{
 const threadId='T2', fingerprint=createHash('sha256').update(threadId).digest('hex');
 const row={threadId,functionKey:'F',nativeRequestIdProvenance:true,nativeRequestIdSha256:fingerprint};
 const result=nativeRequestObservation([row,{...row},
   {...row,threadId:'T4',nativeRequestIdSha256:createHash('sha256').update('T4').digest('hex')}],'F');
 assert.equal(result.observedRequestsAtLeast,2);
 assert.equal(result.requestIdsMatchingThreadIds,2);
 assert.equal(result.allTargetPausesHaveRequestProvenance,true);
 assert.equal(result.requestIdentityScope,'native-protocol-field');
 assert.equal(result.independentRequestCorrelationProved,false);
 assert.equal(result.requestOwnershipProved,false);
 assert.equal(nativeRequestObservation([{...row,nativeRequestIdProvenance:false}],'F').requestIdsMatchingThreadIds,0);
 assert.equal(nativeRequestObservation([{...row,threadId:undefined}],'F').requestIdsMatchingThreadIds,0);
 assert.equal(JSON.stringify(result).includes('T2'),false);
});
import { createO11Runner, o11RunSchema } from '../debug-o11-run.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
import { UI, CS, KEYS, csReadings, uiReadings, uiAssets } from './fixtures/debug-o11-graph-fixture.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HOST = 'shop.example.test';
const base = { op: 'run', lane: 'o11', host: HOST, module: UI.module, moduleKey: UI.moduleKey, applicationKey: 'APPAPPAPPAPPAPPAPPAPPA',
  runtimeUrl: 'https://' + HOST + '/' + UI.module + '/', execution: 'native-entry', timeoutSeconds: 30 };

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-native-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [], invoked = [], debugCalls = [];
  const pin = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); fs.writeFileSync(file, bytes); return { path: file, sha256: sha(bytes) }; };
  const capture = async target => {
    if (overrides.captureError?.module === target.module) { overrides.captureError.calls = (overrides.captureError.calls ?? 0) + 1; throw new Error(overrides.captureError.message); }
    events.push('capture:' + target.module);
    let readings = target.module === UI.module ? uiReadings() : csReadings();
    if (overrides.linkedServer) readings = JSON.parse(JSON.stringify(readings).replaceAll('ServiceAction', 'ServerAction'));
    const versionId = target.module === UI.module ? 77 : 12;
    return { versionId: target.module === UI.module ? 77 : 12, snapshot: pin(target.module + '.oml', 'synthetic ' + target.module),
      inventoryProof: pin(target.module + '-inventory.json', { host: target.host, capturedAtUtc: new Date(Date.now() - (overrides.proofAgeMs ?? 0)).toISOString(), modules: [
        { Key: target.moduleKey, Name: target.module, ApplicationKey: target.applicationKey, VersionId: versionId + (overrides.oldProofVersionDelta ?? 0), IsActive: true },
      ] }), readings };
  };
  const assets = async ({ versionId }) => {
    events.push('assets:' + versionId);
    return { moduleInfo: pin('moduleinfo.json', { manifest: { versionSequence: versionId } }),
      pins: uiAssets().map(a => ({ name: a.name, ...pin('assets/' + a.name, a.text), urlPath: '/' + UI.module + '/scripts/' + a.name, query: '?q' })) };
  };
  let descriptor;
  const handle = {
    authenticate: async value => { events.push('login'); assert.equal(value, descriptor); return { ok: true, authenticated: true }; },
    invoke: async ({ scenario, beforeRequest }) => {
      events.push('invoke:' + scenario.name); invoked.push(scenario);
      if (overrides.invoke) return overrides.invoke({ scenario, beforeRequest, handle });
      await beforeRequest({ binding: descriptor.binding, sessionId: descriptor.binding.sessionId, sourceContractSha256: handle.contract.sha256,
        scenario: scenario.name, seq: invoked.length, endpoint: handle.endpoint });
      return { ok: true, scenario: { name: scenario.name, ok: true, outputs: { OrderId: '42' }, exception: null, durationMs: 3,
        requests: { submitted: 1, answered: 1 }, uncertain: false } };
    },
    dispose: async () => { events.push('dispose'); },
    receipt: () => ({ memoryCleared: true, requestUncertain: false, loginUncertain: false, requestSubmittedCount: invoked.length, requestAnsweredCount: invoked.length }),
  };
  const runner = createO11NativeRun({ root, capture, assets: overrides.assets ?? assets, crossModuleTrace: overrides.crossModuleTrace,
    lifecycle: { inventory: async target => {
      events.push('inventory:' + target.module);
      if (overrides.refreshError) throw new Error(overrides.refreshError);
      const versionId = (target.module === UI.module ? 77 : 12) + (overrides.refreshVersionDelta ?? 0);
      const proof = pin(target.module + '-refreshed-inventory.json', { host: target.host,
        capturedAtUtc: new Date(Date.now() - (overrides.refreshedAgeMs ?? 0)).toISOString(), modules: [
          { Key: target.moduleKey, Name: target.module, ApplicationKey: target.applicationKey, VersionId: versionId, IsActive: true },
        ] });
      if (overrides.tamperRefresh) fs.appendFileSync(proof.path, ' ');
      return { versionId, proof };
    } },
    prepareServerInspection: overrides.prepareServerInspection, beforeServerInvocation: overrides.beforeServerInvocation,
    nativeBroker: { prepare: async value => {
      events.push('broker'); handle.contract = value.sourceContract;
      const contract = JSON.parse(fs.readFileSync(value.sourceContract.path, 'utf8'));
      handle.endpoint = contract.entry.endpoints[0]; handle.spec = contract;
      assert.equal(sha(fs.readFileSync(value.sourceContract.path)), value.sourceContract.sha256);
      return handle;
    } },
    prepareUser: async (value, { sessionId }) => {
      events.push('prompt');
      if (overrides.prompt) return overrides.prompt();
      descriptor = { credentialRef: randomUUID(), state: 'credentials-entered', authenticated: false,
        binding: appUserBinding({ lane: 'o11', ...value }, sessionId), expiresAt: new Date(Date.now() + 600000).toISOString() };
      return { ok: true, descriptor };
    },
    releaseUser: async () => { events.push('release'); return { ok: true }; },
    debug: async (input, context) => { debugCalls.push({ input, context }); events.push('debug:' + input.op);
      return input.op === 'start' ? { ok: true, state: 'connected', sessionId: 'f'.repeat(32),
        ...(overrides.interactive ? { inspectionMode: 'interactive', autoContinue: false, expiresAt: new Date(Date.now() + 90000).toISOString() } : {}) } : { ok: true, state: 'stopped' }; },
    traceRead: () => invoked.length ? overrides.trace ?? [] : [], settle: async () => {},
  });
  const lock = () => path.join(root, '.local', 'debugger', 'native-runs', 'o11', HOST, UI.moduleKey + '.lock');
  return { root, runner, events, invoked, debugCalls, handle, lock };
}

test('O11 server inspection derives the published model before login and configures the request lease before invoking', async t => {
  const trace = [{ threadId: 'T', functionKey: KEYS.placeOrder, nodeKey: 'N1' }, { kind: 'thread-end', threadId: 'T' }];
  let prepared, deadline;
  const f = fixture(t, { trace, interactive: true, prepareServerInspection: async binding => {
    prepared = binding; assert.equal(f.events.includes('prompt'), false);
    assert.equal(binding.moduleKey, UI.moduleKey); assert.equal(binding.functionKey, KEYS.placeOrder);
    assert.equal(sha(fs.readFileSync(binding.source.path)), binding.source.sha256);
  }, beforeServerInvocation: async () => { assert.ok(deadline); } });
  f.handle.configureServerInspection = async options => { deadline = options.expiresAt; return { configured: true, ...options }; };
  const result = await f.runner({ ...base, action: 'Place_Order', trace: 'full', scenarios: [{ name: 'one' }] }, { traceExplicit: true });
  assert.equal(result.ok, true, result.error); assert.ok(prepared);
  assert.equal(result.serverTrace.requestDeadline, deadline); assert.equal(f.invoked.length, 1);
  const bad = fixture(t, { interactive: true, prepareServerInspection: async () => { throw new Error('debug_o11_native_scope_source_changed'); } });
  const refused = await bad.runner({ ...base, action: 'Place_Order', trace: 'full', scenarios: [{ name: 'one' }] }, { traceExplicit: true });
  assert.equal(refused.error, 'debug_o11_native_scope_source_changed'); assert.equal(bad.events.includes('prompt'), false); assert.equal(bad.invoked.length, 0);
  assert.equal(refused.uncertain, false);
});

test('status retains the resolving receipt before native capture completes or fails', async t => {
  for (const op of ['prepare', 'run']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-resolving-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let observed;
    const runner = createO11NativeRun({ root, capture: async () => {
      observed = await runner({ ...base, op: 'status' });
      assert.equal(observed.operation.state, 'resolving');
      assert.equal(observed.operation.op, op);
      assert.equal(observed.busy, op === 'run');
      const receipt = JSON.parse(fs.readFileSync(observed.operation.receiptPath, 'utf8'));
      assert.deepEqual(receipt, observed.operation);
      assert.deepEqual(receipt.results, []);
      assert.equal(JSON.stringify(receipt).includes('input-must-not-be-persisted'), false);
      throw new Error('debug_o11_native_model_read_incomplete');
    } });
    const result = await runner({ ...base, op, action: 'Place_Order', inputs: { Note: 'input-must-not-be-persisted' } });
    assert.equal(result.operationId, observed.operation.operationId);
    assert.equal(result.state, 'refused');
    assert.equal(result.uncertain, false);
    assert.equal((await runner({ ...base, op: 'status' })).busy, false);
  }
});

test('capture refusals keep safe lifecycle codes and the preparation stage, with no login, debugger or replay', async t => {
  const modules = [{ ...CS, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' }];
  for (const [message, module] of [['debug_o11_run_snapshot_scope_mismatch', UI.module], ['debug_o11_run_cli_refused', UI.module],
    ['debug_o11_run_model_read_incomplete', CS.module], ['private SDK detail', UI.module]]) {
    const captureError = { module, message }, f = fixture(t, { captureError });
    const r = await f.runner({ ...base, action: 'Rate_Lookup', modules });
    assert.equal(r.ok, false); assert.equal(r.uncertain, false); assert.equal(r.state, 'refused');
    assert.equal(r.error, message === 'private SDK detail' ? 'debug_o11_native_execution_failed' : message);
    assert.deepEqual(r.preparation, { stage: 'published-model', module });
    assert.equal(captureError.calls, 1);
    assert.deepEqual(f.events, module === UI.module ? [] : ['capture:' + UI.module]);
    assert.equal(f.debugCalls.length, 0); assert.equal(fs.existsSync(f.lock()), false);
    const receipt = JSON.parse(fs.readFileSync(r.receiptPath, 'utf8'));
    assert.equal(receipt.error, r.error); assert.deepEqual(receipt.preparation, r.preparation);
    assert.ok(!JSON.stringify(receipt).includes('private SDK detail'));
  }
});

test('asset failures name their stage after a successful model capture; status shows the stage while it runs', async t => {
  let observed;
  const f = fixture(t, { assets: async () => { observed = await f.runner({ ...base, op: 'status' }); throw new Error('private network detail'); } });
  const r = await f.runner({ ...base, op: 'prepare', action: 'Place_Order' });
  assert.equal(r.error, 'debug_o11_native_execution_failed'); assert.equal(r.state, 'refused');
  assert.deepEqual(r.preparation, { stage: 'published-assets', module: UI.module });
  assert.deepEqual(observed.operation.preparation, { stage: 'published-assets', module: UI.module });
  assert.deepEqual(f.events, ['capture:' + UI.module]);
  const ok = await fixture(t).runner({ ...base, op: 'prepare', action: 'Place_Order' });
  assert.equal(ok.ok, true, ok.error); assert.deepEqual(ok.preparation, { stage: 'entry-resolution', module: UI.module });
});

// Product guard target_runs_in_caller_process (runsInModuleKey/executingModuleKey): here the runtime boundary places the
// single session in the process that executes the target (o11Auth.entry), so the producer's own session is never used.
test('a target running in the caller process gets its session in that process; a service action moves it to the producer', async t => {
  const modules = [{ ...CS, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' }];
  const trace = [{ threadId: 'T', functionKey: KEYS.rateLookup, nodeKey: 'N1' }, { kind: 'thread-end', threadId: 'T' }];
  const run = { ...base, action: 'Rate_Lookup', modules, trace: 'nodes', scenarios: [{ name: 'a' }] };
  // Quote_Compute as a public SERVER action: O11 runs it (and Rate_Lookup) inside ShopUI.
  const linked = fixture(t, { linkedServer: true, crossModuleTrace: true, trace });
  const r = await linked.runner(run, { traceExplicit: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.tracePlan.server.allowed, true); assert.equal(r.tracePlan.server.crossModule, true);
  assert.equal(r.tracePlan.server.boundary.runtimeModuleKey, UI.moduleKey);
  assert.deepEqual(r.tracePlan.server.boundary.boundaries.map(b => [b.kind, b.runtimeModuleKey]), [['linked-action', UI.moduleKey]]);
  const starts = linked.debugCalls.filter(c => c.input.op === 'start').map(c => c.input);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].moduleKey, CS.moduleKey); // producer breakpoints...
  assert.equal(new URL(starts[0].runtimeUrl).pathname, '/' + UI.module + '/'); // ...in the caller's process
  assert.equal(starts[0].o11Auth.entry.moduleKey, UI.moduleKey);
  assert.equal(r.results[0].traceVerified, true);
  const service = fixture(t, { crossModuleTrace: true, trace });
  const s = await service.runner(run, { traceExplicit: true });
  assert.equal(s.ok, true, JSON.stringify(s.error));
  assert.equal(s.tracePlan.server.boundary.runtimeModuleKey, CS.moduleKey);
  const own = service.debugCalls.find(c => c.input.op === 'start').input;
  assert.equal(new URL(own.runtimeUrl).pathname, '/' + CS.module + '/'); assert.equal(own.o11Auth.entry, undefined);
});

test('prepare resolves the entry deterministically, writes the v2 contract and says what the run needs, without a window', async t => {
  const f = fixture(t);
  const r = await f.runner({ ...base, op: 'prepare', action: 'Place_Order', scenarios: [{ name: 'a', inputs: { Zip: '33101', Amount: '12.50' } }] });
  assert.equal(r.state, 'prepared'); assert.equal(r.ok, true);
  assert.equal(r.resolution.entry.entry, 'server-stub'); assert.equal(r.resolution.callPath, 'ShopUI.ActionPlace_Order -> ShopUI.Place_Order');
  assert.deepEqual(r.scenarios, [{ name: 'a', presence: { Zip: 'value', Amount: 'value', Note: 'omitted' } }]);
  assert.equal(r.needs.loginWindow, true); assert.match(r.needs.appUser, /Common\.Login/);
  assert.deepEqual(f.events, ['capture:ShopUI', 'assets:77']);
  const contract = JSON.parse(fs.readFileSync(r.sourceContract.path, 'utf8'));
  assert.equal(contract.schema, 'ssam-o11-native-entry-source/2'); assert.equal(contract.selector, 'Place_Order');
  assert.equal(contract.entry.kind, 'server-stub'); assert.equal(contract.entry.endpoint, '/ShopUI/screenservices/ShopUI/MainFlow/Shop/ActionPlace_Order');
  assert.deepEqual(contract.entry.inputs.map(i => i.name + ':' + i.dataType), ['Zip:Text', 'Amount:Decimal', 'Note:Text']);
  assert.equal(contract.login.endpoint, '/ShopUI/screenservices/ShopUI/Common/Login/ActionDoLogin');
  assert.deepEqual(contract.assets.map(a => a.name).slice(0, 2), ['OutSystems.js', 'Debugger.js']);
  assert.equal(contract.nativeApplicationGuid, '11111111-2222-4333-8444-555555555555');
  assert.equal(fs.existsSync(f.lock()), false);
});

test('run: one window, original entry per scenario with typed values, outputs, release, lock removed', async t => {
  const f = fixture(t);
  const r = await f.runner({ ...base, action: 'Place_Order', scenarios: [{ name: 'a', inputs: { Zip: '33101', Amount: 12.5 } }, { name: 'empty' }] });
  assert.equal(r.ok, true, JSON.stringify(r.error)); assert.equal(r.state, 'answered');
  assert.deepEqual(f.events, ['capture:ShopUI', 'assets:77', 'prompt', 'broker', 'login', 'invoke:a', 'invoke:empty', 'dispose', 'release']);
  assert.deepEqual(f.invoked.map(s => s.values), [{ Zip: '33101', Amount: '12.5' }, {}]);
  assert.deepEqual(r.results.map(x => x.outputs), [{ OrderId: '42' }, { OrderId: '42' }]);
  assert.equal(r.credentialsReleased, true); assert.equal(r.lockRetained, false); assert.equal(fs.existsSync(f.lock()), false);
  assert.ok(r.assumptions.some(a => /another user/.test(a)));
});

test('screen context is checked against the published owner before sign-in and delivered separately from action parameters', async t => {
  const f = fixture(t);
  const context = { screen: { variables: { Zip: '33101' } } };
  const prepared = await f.runner({ ...base, op: 'prepare', action: 'Place_Order', context });
  assert.equal(prepared.ok, true, prepared.error);
  assert.deepEqual(prepared.entryAbi.context.screen.variables, [{ name: 'Zip', attribute: 'zipVar', dataType: 'Text' }]);
  const invalid = await f.runner({ ...base, action: 'Place_Order', context: { screen: { variables: { NotDeclared: 1 } } } });
  assert.match(invalid.error, /context_attribute_unavailable/); assert.ok(!f.events.includes('prompt'));
  const result = await f.runner({ ...base, action: 'Place_Order', context });
  assert.equal(result.ok, true, result.error); assert.deepEqual(f.invoked[0].context, context); assert.deepEqual(f.invoked[0].values, {});
});

test('an uncertain scenario stops the batch: never resent, remaining not sent, lock retained', async t => {
  const f = fixture(t, { invoke: async ({ scenario }) => scenario.name === 'b'
    ? { ok: true, scenario: { name: 'b', ok: false, uncertain: true, requests: { submitted: 1, answered: 0 } } }
    : { ok: true, scenario: { name: scenario.name, ok: true, outputs: {}, uncertain: false, requests: { submitted: 1, answered: 1 } } } });
  const r = await f.runner({ ...base, action: 'Place_Order', scenarios: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
  assert.equal(r.ok, false); assert.equal(r.uncertain, true); assert.deepEqual(r.notSent, ['c']);
  assert.equal(f.invoked.length, 2); assert.equal(r.lockRetained, true); assert.equal(fs.existsSync(f.lock()), true);
  const again = await f.runner({ ...base, action: 'Place_Order' });
  assert.equal(again.error, 'debug_o11_native_binding_busy'); // one live session per binding
});

test('a gateway response is public transport evidence, never an answered action or a reason to replay', async t => {
  const f = fixture(t, { invoke: async ({ scenario }) => ({ ok: true, scenario: {
    name: scenario.name, ok: false, uncertain: true, requests: { submitted: 1, answered: 0 },
  } }) });
  const transport = { status: 504, durationMs: 60279, bytes: 1033, sha256: 'a'.repeat(64), nativeEnvelopeAccepted: false };
  f.handle.receipt = () => ({ memoryCleared: true, requestUncertain: true, loginUncertain: false,
    requestSubmittedCount: 1, requestAnsweredCount: 0,
    lastEntryResponse: { ...transport, body: 'private-body', headers: { authorization: 'private-header' } },
    serverInspection: { nativeTimeoutSeconds: 193, token: 'private-token' } });
  const r = await f.runner({ ...base, action: 'Place_Order', scenarios: [{ name: 'a' }, { name: 'b' }] });
  assert.deepEqual(r.worker.lastEntryResponse, transport); assert.equal(r.worker.nativeTimeoutSeconds, 193);
  assert.equal(r.worker.answered, 0); assert.equal(r.uncertain, true); assert.equal(r.lockRetained, true);
  assert.deepEqual(r.notSent, ['b']); assert.equal(f.invoked.length, 1); assert.equal(r.credentialsReleased, true);
  assert.ok(!JSON.stringify(r).includes('private-'));
  assert.ok(!fs.readFileSync(r.receiptPath, 'utf8').includes('private-'));
});

test('malformed transport metadata is not projected into the public receipt', async t => {
  const f = fixture(t);
  f.handle.receipt = () => ({ memoryCleared: true, requestUncertain: false, loginUncertain: false,
    requestSubmittedCount: 1, requestAnsweredCount: 1,
    lastEntryResponse: { status: 'private-status', durationMs: 1, bytes: 1, sha256: 'a'.repeat(64), nativeEnvelopeAccepted: true } });
  const r = await f.runner({ ...base, action: 'Place_Order' });
  assert.equal(r.ok, true); assert.equal(r.worker.lastEntryResponse, undefined);
  assert.ok(!JSON.stringify(r).includes('private-status'));
});

test('client trace requires the target frame and harness exceptions are not business results', async t => {
  for (const visits of [[], [{ functionKey: KEYS.slug, nodeKey: 'node' }]]) {
    const f = fixture(t, { invoke: async ({ scenario }) => ({ ok: true, scenario: {
      name: scenario.name, ok: true, visits, uncertain: false,
    } }) });
    const r = await f.runner({ ...base, action: 'Slugify', trace: 'full', scenarios: [
      { name: 'first', inputs: { Text: 'value' } }, { name: 'second', inputs: { Text: 'another' } },
    ] });
    assert.equal(r.ok, visits.length > 0);
    assert.equal(r.results[0].traceVerified, visits.length > 0);
    assert.equal(f.invoked.length, visits.length ? 2 : 1);
  }
  const f = fixture(t, { invoke: async ({ scenario }) => ({ ok: true, scenario: {
    name: scenario.name, ok: false, exception: { type: 'Harness', origin: 'harness' }, uncertain: false,
  } }) });
  assert.equal((await f.runner({ ...base, action: 'Slugify', inputs: { Text: 'value' } })).ok, false);
});

test('dead code, override outside the graph and an uncontrollable input refuse before any window', async t => {
  const f = fixture(t);
  const dead = await f.runner({ ...base, action: 'Ui_Unused' });
  assert.equal(dead.state, 'dead-code'); assert.equal(dead.resolution.message, 'dead code: no public entry reaches Ui_Unused');
  const override = await f.runner({ ...base, action: 'Place_Order', entry: '@' + KEYS.slug });
  assert.equal(override.state, 'override-refused');
  const owner = await f.runner({ ...base, action: 'Rate_Lookup', modules: [{ module: CS.module, moduleKey: CS.moduleKey, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' }],
    scenarios: [{ name: 'x', inputs: { Owner: 5 } }] });
  assert.equal(owner.error, 'debug_o11_native_input_not_controllable:Owner');
  assert.ok(!f.events.includes('prompt'));
});

test('server trace: same module starts SOAP on the target start node; blocked binding and cross-module without hook refuse first', async t => {
  const trace = [{ seq: 1, threadId: 'T', functionKey: KEYS.placeOrder, nodeKey: 'N1', values: [{ path: 'Zip', value: '1' }] },
    { seq: 2, threadId: 'T', functionKey: KEYS.placeOrder, nodeKey: 'N2', values: [{ path: 'Zip', value: '1' }] }, { kind: 'thread-end', threadId: 'T' }];
  const f = fixture(t, { trace });
  const r = await f.runner({ ...base, action: 'Place_Order', trace: 'nodes', scenarios: [{ name: 'a' }] }, { traceExplicit: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const start = f.debugCalls[0].input;
  assert.equal(start.module, 'ShopUI'); assert.deepEqual(start.nodeKeys, [('S' + KEYS.placeOrder.slice(0, 6) + '1').padEnd(22, 'x').slice(0, 22)]);
  assert.equal(start.trace.requireFunctionKey, KEYS.placeOrder); assert.equal(start.trace.fullValues, false); assert.deepEqual(start.trace.scopes, {});
  assert.equal(f.debugCalls[1].input.op, 'stop'); assert.equal(r.serverTrace.stopped, true);
  assert.deepEqual(r.results[0].serverMap.map(v => [v.nodeKey, v.values?.length ?? null, v.changed?.length ?? null]), [['N1', 1, null], ['N2', null, 0]]);

  // The same binding listed in the local blocked-bindings registry never gets a session: refused before the window.
  const blocked = fixture(t);
  fs.mkdirSync(path.join(blocked.root, '.local', 'debugger', 'blocked-bindings'), { recursive: true });
  fs.writeFileSync(path.join(blocked.root, '.local', 'debugger', 'blocked-bindings', bindingHash(HOST, UI.moduleKey) + '.json'), JSON.stringify({ operationId: 'synthetic' }));
  const refused = await blocked.runner({ ...base, action: 'Place_Order', trace: 'full' }, { traceExplicit: true });
  assert.equal(refused.error, 'debug_o11_native_trace_unavailable:binding_blocked'); assert.ok(!blocked.events.includes('prompt'));
  // Trace off still runs on that binding: no debugger session is involved.
  const untraced = await blocked.runner({ ...base, action: 'Place_Order', trace: 'none' });
  assert.equal(untraced.ok, true); assert.equal(blocked.debugCalls.length, 0);

  const modules = [{ module: CS.module, moduleKey: CS.moduleKey, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' }];
  const cross = fixture(t, { crossModuleTrace: false });
  const noHook = await cross.runner({ ...base, action: 'Rate_Lookup', modules, trace: 'full' }, { traceExplicit: true });
  assert.equal(noHook.error, 'debug_o11_native_trace_unavailable:cross_module_runtime_hook_missing');
  const hooked = fixture(t, { crossModuleTrace: true, trace: trace.map(v => v.functionKey ? { ...v, functionKey: KEYS.rateLookup } : v) });
  const producer = await hooked.runner({ ...base, action: 'Rate_Lookup', modules, trace: 'full', depth: 4 }, { traceExplicit: true });
  assert.equal(producer.ok, true, JSON.stringify(producer.error));
  assert.equal(hooked.debugCalls[0].input.module, 'ShopCS'); assert.equal(hooked.debugCalls[0].input.runtimeUrl, 'https://' + HOST + '/ShopCS/');
  assert.deepEqual(Object.keys(hooked.debugCalls[0].input.trace.scopes), [KEYS.rateLookup]);
  assert.equal(hooked.debugCalls[0].input.trace.depth, 4);
  assert.equal(producer.resolution.entry.name, 'LoadQuotes');
});

test('expired publication proof retains actionable error if fresh inventory is still stale', async t => {
  const f = fixture(t, {linkedServer:true,crossModuleTrace:true,proofAgeMs:901000,refreshedAgeMs:901000});
  const result = await f.runner({...base,op:'prepare',action:'Rate_Lookup',trace:'nodes',modules:[{...CS,applicationKey:'CSAPPCSAPPCSAPPCSAPPCS'}]});
  assert.equal(result.error,'debug_o11_publication_proof_stale');
  assert.equal(result.uncertain,false);
  assert.equal(f.events.includes('prompt'),false);
  assert.equal(f.debugCalls.length,0);
  assert.equal(f.invoked.length,0);
});

test('cold capture refreshes expired proofs for both modules without changing their pinned versions', async t => {
  const f = fixture(t, {linkedServer:true,crossModuleTrace:true,proofAgeMs:901000});
  const result = await f.runner({...base,op:'prepare',action:'Rate_Lookup',trace:'nodes',modules:[{...CS,applicationKey:'CSAPPCSAPPCSAPPCSAPPCS'}]});
  assert.equal(result.ok,true,result.error);
  assert.deepEqual(f.events.filter(e=>e.startsWith('inventory:')),['inventory:ShopUI','inventory:ShopCS']);
  assert.equal(f.debugCalls.length,0); assert.equal(f.invoked.length,0);
  assert.equal(f.events.includes('prompt'),false);
});

test('publication renewal refuses changed versions, tampered proofs and future timestamps before execution', async t => {
  for (const [options, expected] of [
    [{refreshVersionDelta:1},'debug_o11_native_published_version_changed'],
    [{tamperRefresh:true},'debug_o11_native_inventory_changed'],
    [{proofAgeMs:-60000},'debug_o11_publication_proof_stale'],
    [{oldProofVersionDelta:1},'debug_o11_module_scope_mismatch'],
  ]) {
    const f = fixture(t, {linkedServer:true,crossModuleTrace:true,proofAgeMs:901000,...options});
    const result = await f.runner({...base,action:'Rate_Lookup',trace:'nodes',modules:[{...CS,applicationKey:'CSAPPCSAPPCSAPPCSAPPCS'}]});
    assert.equal(result.error,expected); assert.equal(result.uncertain,false);
    assert.equal(f.events.includes('prompt'),false); assert.equal(f.debugCalls.length,0); assert.equal(f.invoked.length,0);
    if (options.proofAgeMs < 0 || options.oldProofVersionDelta) assert.equal(f.events.some(e=>e.startsWith('inventory:')),false);
  }
});

test('linked server trace keeps producer breakpoints and uses the consumer endpoint with both publication proofs', async t => {
  const f = fixture(t, { linkedServer: true, crossModuleTrace: true, trace: [
    { threadId: 'T', functionKey: KEYS.rateLookup, nodeKey: 'N1' }, { kind: 'thread-end', threadId: 'T' },
  ] });
  const r = await f.runner({ ...base, action: 'Rate_Lookup', trace: 'nodes', modules: [
    { ...CS, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' },
  ] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const start = f.debugCalls[0].input;
  assert.equal(start.module, CS.module);
  assert.equal(start.moduleKey, CS.moduleKey);
  assert.equal(start.runtimeUrl, base.runtimeUrl);
  assert.equal(start.o11Auth.entry.moduleKey, UI.moduleKey);
  assert.equal(start.o11Auth.entry.publishedVersionId, 77);
  const proof = JSON.parse(fs.readFileSync(start.o11Auth.publishedProof.path, 'utf8'));
  assert.deepEqual(proof.modules.map(m => m.Key).sort(), [CS.moduleKey, UI.moduleKey].sort());
  assert.equal(sha(fs.readFileSync(start.o11Auth.publishedProof.path)), start.o11Auth.publishedProof.sha256);

  const blocked = fixture(t, { linkedServer: true, crossModuleTrace: true });
  const registry = path.join(blocked.root, '.local', 'debugger', 'blocked-bindings');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, bindingHash(HOST, UI.moduleKey) + '.json'), JSON.stringify({ operationId: 'consumer-uncertain' }));
  const refused = await blocked.runner({ ...base, action: 'Rate_Lookup', trace: 'full', modules: [{ ...CS, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' }] });
  assert.equal(refused.ok, false);
  assert.equal(refused.tracePlan.server.blockedBy, 'consumer-uncertain');
  assert.equal(blocked.events.includes('prompt'), false);
});

test('interactive cross-module inspection binds each published consumer and producer source before login', async t => {
  for (const linkedServer of [false, true]) {
    let binding;
    const f = fixture(t, { linkedServer, crossModuleTrace: true, interactive: true,
      trace: [{ threadId: 'T', functionKey: KEYS.rateLookup, nodeKey: 'N1' }, { kind: 'thread-end', threadId: 'T' }],
      prepareServerInspection: async value => {
        binding = value;
        assert.equal(f.events.includes('prompt'), false);
        assert.equal(value.moduleKey, CS.moduleKey);
        assert.equal(value.functionKey, KEYS.rateLookup);
        assert.deepEqual(value.models.map(m => m.moduleKey), [UI.moduleKey, CS.moduleKey]);
        for (const model of value.models) assert.equal(sha(fs.readFileSync(model.source.path)), model.source.sha256);
        assert.notEqual(value.models[0].source.sha256, value.models[1].source.sha256);
        assert.deepEqual(value.models[1].source, value.source);
      } });
    f.handle.configureServerInspection = async options => ({ configured: true, ...options });
    const r = await f.runner({ ...base, action: 'Rate_Lookup', trace: 'full',
      modules: [{ ...CS, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' }] });
    assert.equal(r.ok, true, r.error); assert.ok(binding); assert.equal(f.invoked.length, 1);
  }
});

// D1 (consolidation 99d8982e, rewritten for this runner's signature): the consumer's descriptor goes to the producer
// session as redaction-only evidence (redactionOnly, no appUserEntry); the native SSO stays on the producer module.
test('cross-module server trace: the real runtime hook is detected, the consumer descriptor goes redaction-only, SSO stays on the producer', async t => {
  const trace = [{ seq: 1, threadId: 'T', functionKey: KEYS.rateLookup, nodeKey: 'N1', values: [{ path: 'Zip', value: '1' }] }, { kind: 'thread-end', threadId: 'T' }];
  const modules = [{ module: CS.module, moduleKey: CS.moduleKey, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' }];
  const f = fixture(t, { trace }); // crossModuleTrace omitted: read from debug-runtime.mjs (O11_CROSS_MODULE_REDACTION)
  const r = await f.runner({ ...base, action: 'Rate_Lookup', modules, trace: 'nodes', scenarios: [{ name: 'a' }] }, { traceExplicit: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(f.events, ['capture:ShopUI', 'capture:ShopCS', 'assets:77', 'prompt', 'broker', 'login', 'debug:start', 'invoke:a', 'debug:stop', 'dispose', 'release']);
  assert.equal(r.tracePlan.server.crossModule, true); assert.equal(r.tracePlan.server.boundary.runtimeModuleKey, CS.moduleKey);
  const { input, context } = f.debugCalls[0];
  assert.equal(input.module, CS.module); assert.equal(input.moduleKey, CS.moduleKey);
  assert.equal(input.o11Auth.applicationKey, 'CSAPPCSAPPCSAPPCSAPPCS'); assert.equal(input.o11Auth.publishedVersionId, 12);
  assert.equal(input.o11Auth.entry, undefined); // a service action runs in the producer's own process
  assert.equal(context.redactionOnly, true); assert.equal(context.appUserEntry, undefined);
  assert.equal(context.appUser.binding.module, UI.module); assert.equal(context.appUser.binding.moduleKey, UI.moduleKey);
  assert.deepEqual(r.results[0].serverMap.map(v => v.nodeKey), ['N1']);
  // Same module: the descriptor's own binding, still redaction-only, and no consumer entry.
  const same = fixture(t, { trace: [{ seq: 1, threadId: 'T', functionKey: KEYS.placeOrder, nodeKey: 'N1' }, { kind: 'thread-end', threadId: 'T' }] });
  const own = await same.runner({ ...base, action: 'Place_Order', trace: 'nodes', scenarios: [{ name: 'a' }] }, { traceExplicit: true });
  assert.equal(own.ok, true, JSON.stringify(own.error));
  assert.equal(same.debugCalls[0].input.o11Auth.entry, undefined); assert.equal(same.debugCalls[0].context.redactionOnly, true);
  assert.equal(same.debugCalls[0].context.appUser.binding.moduleKey, UI.moduleKey);
});

test('a call path through the breakpoint of the uncertain 4c operation is refused even with trace=none, before any window', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-4c-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mk = 'Mif02PxcH0K7KiABEHTwMg', host = 'personal-2qqw9srv.outsystemscloud.com', events = [];
  const target = { kind: 'ServerAction', name: 'Probe', key: 'ProbeKeyxxxxxxxxxxxxxx', path: 'ServerAction:Probe', properties: { GlobalKey: mk + '*ProbeKeyxxxxxxxxxxxxxx' }, propertyReferences: {}, children: [] };
  const data = { kind: 'DataAction', name: 'SSAM_DebugServiceContextFromServer', key: '6jUkeiRdmkqp2Hu4_nagjQ', path: 'MobileFlow:Common/MobileBlock:UserInfo/DataAction:SSAM_DebugServiceContextFromServer',
    properties: { GlobalKey: mk + '*6jUkeiRdmkqp2Hu4_nagjQ' }, propertyReferences: {}, children: [{ kind: 'StartNode', key: 'LiCk5pmr6Ueb45499t9tNw', properties: {}, children: [] },
      { kind: 'ExecuteServerActionNode', key: 'ExecProbexxxxxxxxxxxxx', propertyReferences: { Action: { kind: 'ServerAction', name: 'Probe', key: 'ProbeKeyxxxxxxxxxxxxxx' } }, children: [] }] };
  const runner = createO11NativeRun({ root, capture: async () => ({ versionId: 5811, snapshot: { path: 'x', sha256: 'a'.repeat(64) }, inventoryProof: { path: 'y', sha256: 'b'.repeat(64) },
    readings: [{ tree: target }, { tree: data }] }), assets: async () => ({ moduleInfo: {}, pins: [] }),
    prepareUser: async () => { events.push('prompt'); return { ok: false }; }, debug: async () => { events.push('debug'); } });
  const r = await runner({ ...base, host, module: 'Headless_UI', moduleKey: mk, runtimeUrl: 'https://' + host + '/Headless_UI/', action: 'Probe', trace: 'none' });
  assert.equal(r.resolution.entry.name, 'SSAM_DebugServiceContextFromServer');
  assert.equal(r.error, 'debug_o11_native_path_crosses_uncertain_breakpoint:4c7016f0a51445108b185fdcd0109586');
  assert.deepEqual(events, []);
});

test('the 4c binding is blocked in code; the graph native-entry is reached through the O11 runner without nativeEntry', async t => {
  assert.equal(blockedBinding(os.tmpdir(), 'personal-2qqw9srv.outsystemscloud.com', 'Mif02PxcH0K7KiABEHTwMg').operationId, '4c7016f0a51445108b185fdcd0109586');
  assert.equal(BLOCKED_BINDINGS.length, 1);
  assert.equal(blockedBinding(os.tmpdir(), 'personal-2qqw9srv.outsystemscloud.com', 'Kawk_WFx5USxo7qFAB0lCQ'), null);
  const calls = [];
  const runner = createO11Runner({ root: os.tmpdir(), lifecycle: {}, nativeRun: async (input, options) => { calls.push({ input, options }); return { ok: true }; } });
  await runner({ ...base, op: 'prepare', action: 'Place_Order' });
  await runner({ ...base, op: 'prepare', action: 'Place_Order', trace: 'full' });
  assert.deepEqual(calls.map(c => [c.input.trace, c.options.traceExplicit]), [[undefined, false], ['full', true]]);
  assert.equal(o11RunSchema.safeParse({ ...base, action: 'ShopCS.@' + KEYS.rateLookup }).success, true);
  assert.deepEqual(compactServerMap([{ kind: 'thread-end' }]), []);
});
