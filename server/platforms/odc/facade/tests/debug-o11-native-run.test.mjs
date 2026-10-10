import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createO11NativeRun, blockedBinding, bindingHash, BLOCKED_BINDINGS, compactServerMap, executingModuleKey, readO11GraphTree } from '../debug-o11-native-run.mjs';
import { createO11Runner, o11RunSchema } from '../debug-o11-run.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
import { UI, CS, KEYS, csReadings, uiReadings, uiAssets } from './fixtures/debug-o11-graph-fixture.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HOST = 'shop.example.test';
const base = { op: 'run', lane: 'o11', host: HOST, module: UI.module, moduleKey: UI.moduleKey, applicationKey: 'APPAPPAPPAPPAPPAPPAPPA',
  runtimeUrl: 'https://' + HOST + '/' + UI.module + '/', execution: 'native-entry', timeoutSeconds: 30 };

test('graph reader avoids unsupported collection getters but preserves parameter children and call references', async () => {
  const source = { file: 'synthetic.oml', sha256: 'a'.repeat(64) };
  const tree = { kind: 'ScreenAction', name: 'HideMenu', children: [
    { kind: 'InputParameter', name: 'Id', properties: { DataType: 'Integer' }, children: [] },
    { kind: 'ExecuteClientActionNode', propertyReferences: { Action: { key: 'b'.repeat(22) } }, children: [] },
  ] };
  const result = await readO11GraphTree(source, '@' + 'c'.repeat(22), async args => {
    const props = args[args.indexOf('--properties') + 1].split(',');
    const errors = props.includes('OutputParameters') || !args.includes('--properties')
      ? { OutputParameters: 'The method or operation is not implemented.' } : {};
    assert.ok(props.includes('Action') && props.includes('DataType'));
    return { ok: true, data: { sourceSha256: source.sha256.toUpperCase(), tree: { ...tree, propertyErrors: errors } } };
  });
  assert.deepEqual(result.children, tree.children);
  for (const data of [
    { sourceSha256: 'b'.repeat(64), tree },
    { sourceSha256: source.sha256, tree: { ...tree, childrenOmitted: 1 } },
    { sourceSha256: source.sha256, tree: { ...tree, propertyErrors: { Action: 'failed' } } },
    { sourceSha256: source.sha256, tree: { ...tree, children: [{ propertiesOmitted: { Value: true } }] } },
  ]) await assert.rejects(readO11GraphTree(source, '@' + 'c'.repeat(22), async () => ({ ok: true, data })), /model_read_incomplete/);
});

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-native-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [], invoked = [], debugCalls = [];
  const pin = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); fs.writeFileSync(file, bytes); return { path: file, sha256: sha(bytes) }; };
  const capture = async target => {
    events.push('capture:' + target.module);
    return { versionId: target.module === UI.module ? 77 : 12, snapshot: pin(target.module + '.oml', 'synthetic ' + target.module),
      inventoryProof: pin(target.module + '-inventory.json', { modules: [] }), readings: target.module === UI.module ? uiReadings() : (overrides.csReadings ?? csReadings)() };
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
  const runner = createO11NativeRun({ root, capture: overrides.capture ?? capture, assets: overrides.assets ?? assets, crossModuleTrace: overrides.crossModuleTrace,
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
      return input.op === 'start' ? { ok: true, state: 'connected', sessionId: 'f'.repeat(32) } : { ok: true, state: 'stopped' }; },
    traceRead: () => invoked.length ? overrides.trace ?? [] : [], settle: async () => {},
  });
  const lock = () => path.join(root, '.local', 'debugger', 'native-runs', 'o11', HOST, UI.moduleKey + '.lock');
  return { root, runner, events, invoked, debugCalls, handle, lock };
}

test('capture refusals retain safe lifecycle codes and preparation stage without login or replay', async t => {
  for (const message of ['debug_o11_run_snapshot_scope_mismatch', 'debug_o11_run_cli_refused', 'private SDK detail']) {
    let calls = 0;
    const f = fixture(t, { capture: async () => { calls++; throw new Error(message); } });
    const r = await f.runner({ ...base, op: 'prepare', action: 'Place_Order' });
    assert.equal(r.ok, false);
    assert.equal(r.uncertain, false);
    assert.equal(r.error, message === 'private SDK detail' ? 'debug_o11_native_execution_failed' : message);
    assert.deepEqual(r.preparation, { stage: 'published-model', module: UI.module });
    assert.equal(calls, 1);
    assert.deepEqual(f.events, []);
    const receipt = JSON.parse(fs.readFileSync(r.receiptPath, 'utf8'));
    assert.equal(receipt.error, r.error);
    assert.ok(!JSON.stringify(receipt).includes('private SDK detail'));
  }
});

test('asset failures identify their phase after a successful model capture', async t => {
  const f = fixture(t, { assets: async () => { throw new Error('private network detail'); } });
  const r = await f.runner({ ...base, op: 'prepare', action: 'Place_Order' });
  assert.equal(r.error, 'debug_o11_native_execution_failed');
  assert.deepEqual(r.preparation, { stage: 'published-assets', module: UI.module });
  assert.deepEqual(f.events, ['capture:' + UI.module]);
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

  assert.equal(f.debugCalls[0].context.appUserEntry, undefined); // same module: the descriptor's own binding

  const modules = [{ module: CS.module, moduleKey: CS.moduleKey, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' }];
  const cross = fixture(t, { crossModuleTrace: false });
  const noHook = await cross.runner({ ...base, action: 'Rate_Lookup', modules, trace: 'full' }, { traceExplicit: true });
  assert.equal(noHook.error, 'debug_o11_native_trace_unavailable:cross_module_runtime_hook_missing');
  const hooked = fixture(t, { crossModuleTrace: true, trace });
  const producer = await hooked.runner({ ...base, action: 'Rate_Lookup', modules, trace: 'full' }, { traceExplicit: true });
  assert.equal(producer.ok, true, JSON.stringify(producer.error));
  assert.equal(hooked.debugCalls[0].input.module, 'ShopCS'); assert.equal(hooked.debugCalls[0].input.runtimeUrl, 'https://' + HOST + '/ShopCS/');
  assert.deepEqual(Object.keys(hooked.debugCalls[0].input.trace.scopes), [KEYS.rateLookup]);
  assert.equal(producer.resolution.entry.name, 'LoadQuotes');
});

test('cross-module server trace: the real runtime hook is detected, the consumer descriptor goes as redaction entry, SSO stays on the producer', async t => {
  const trace = [{ seq: 1, threadId: 'T', functionKey: KEYS.rateLookup, nodeKey: 'N1', values: [{ path: 'Zip', value: '1' }] }, { kind: 'thread-end', threadId: 'T' }];
  const modules = [{ module: CS.module, moduleKey: CS.moduleKey, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' }];
  const f = fixture(t, { trace }); // crossModuleTrace omitted: read from debug-runtime.mjs (O11_CROSS_MODULE_REDACTION)
  const r = await f.runner({ ...base, action: 'Rate_Lookup', modules, trace: 'nodes', scenarios: [{ name: 'a' }] }, { traceExplicit: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(f.events, ['capture:ShopUI', 'capture:ShopCS', 'assets:77', 'prompt', 'broker', 'login', 'debug:start', 'invoke:a', 'debug:stop', 'dispose', 'release']);
  assert.equal(r.tracePlan.server.crossModule, true); assert.equal(r.tracePlan.server.runsInModuleKey, CS.moduleKey);
  const { input, context } = f.debugCalls[0];
  assert.equal(input.module, CS.module); assert.equal(input.moduleKey, CS.moduleKey);
  assert.deepEqual(input.o11Auth.applicationKey, 'CSAPPCSAPPCSAPPCSAPPCS'); assert.equal(input.o11Auth.publishedVersionId, 12);
  assert.deepEqual(context.appUserEntry, { module: UI.module, moduleKey: UI.moduleKey });
  assert.equal(context.appUser.binding.module, UI.module); assert.equal(context.appUser.binding.moduleKey, UI.moduleKey);
  assert.deepEqual(r.results[0].serverMap.map(v => v.nodeKey), ['N1']);
});

test('cross-module server trace is refused when the target runs in the caller process (server action reached without a service action)', async t => {
  // Same graph, but Quote_Compute is a public SERVER action: O11 runs it inside ShopUI, so a ShopCS session never hits.
  const asServer = () => csReadings().map(r => r.tree.name === 'Quote_Compute' ? { ...r, tree: { ...r.tree, kind: 'ServerAction' } } : r);
  const modules = [{ module: CS.module, moduleKey: CS.moduleKey, applicationKey: 'CSAPPCSAPPCSAPPCSAPPCS' }];
  const f = fixture(t, { crossModuleTrace: true, csReadings: asServer });
  const r = await f.runner({ ...base, action: 'Rate_Lookup', modules, trace: 'nodes' }, { traceExplicit: true });
  assert.equal(r.state, 'refused'); assert.equal(r.error, 'debug_o11_native_trace_unavailable:target_runs_in_caller_process');
  assert.equal(r.tracePlan.server.runsInModuleKey, UI.moduleKey);
  assert.ok(!f.events.includes('prompt')); assert.equal(f.debugCalls.length, 0);
  const g = { nodes: new Map([['a', { kind: 'DataAction', moduleKey: 'U' }], ['b', { kind: 'ServiceAction', moduleKey: 'C' }], ['c', { kind: 'ServerAction', moduleKey: 'C' }]]) };
  assert.equal(executingModuleKey(g, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'U'), 'C');
  assert.equal(executingModuleKey(g, [{ id: 'a' }, { id: 'c' }], 'U'), 'U');
  assert.equal(executingModuleKey(g, [{ id: 'a' }], 'U'), 'U');
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
