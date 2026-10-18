import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { prepareNativeEntry, runNativeEntry, statusNativeEntry, classifyEffects, runMountedNativeEntry } from '../debug-odc-native-run.mjs';
import { debugRun, registerRunTools } from '../debug-run.mjs';

// Readers fixture shaped like the live model adapter: a target resolver plus usages/properties/inputs/arguments.
function readers({ deadCode = false } = {}) {
  const elements = {
    'ServerAction:Location_GetProperty': { key: 'TKEY', kind: 'ServerAction', props: { Name: 'Location_GetProperty', Public: 'False' },
      inputs: [{ name: 'Address1', dataType: 'Text', mandatory: true }, { name: 'CountryCode', dataType: 'Text', mandatory: true }, { name: 'IsManual', dataType: 'Boolean', mandatory: false }] },
    'MobileFlow:MainFlow/MobileScreen:Location/ScreenAction:ConfirmProperty': { key: 'SA', kind: 'ScreenAction', props: { Name: 'ConfirmProperty' } },
    'MobileFlow:MainFlow/MobileScreen:Location': { key: 'SCREEN', kind: 'MobileScreen', props: { Name: 'Location', Roles: '[AppRole:FloodQuotes]', AnonymousAccess: 'False' } },
  };
  const edges = deadCode ? [{ consumer: { kind: 'ExecuteServerActionNode', key: 'N', path: 'ServerAction:Priv/ExecuteServerActionNode:T' }, target: 'TKEY', arguments: null }]
    : [{ consumer: { kind: 'ExecuteServerActionNode', key: 'N1', path: 'MobileFlow:MainFlow/MobileScreen:Location/ScreenAction:ConfirmProperty/ExecuteServerActionNode:GetProperty' }, target: 'TKEY',
        arguments: [{ parameterName: 'Address1', value: 'Address1' }, { parameterName: 'CountryCode', value: '"US"' }] }];
  if (deadCode) elements['ServerAction:Priv'] = { key: 'PRIV', kind: 'ServerAction', props: { Name: 'Priv', Public: 'False' } };
  return {
    binding: { tenant: 'offline-test', module: 'FloodQuotes', app: 'FloodQuotes' },
    resolveTarget: async nameOrKey => { const e = elements['ServerAction:Location_GetProperty']; return (nameOrKey === 'Location_GetProperty' || nameOrKey === e.key) ? { key: e.key, name: e.props.Name, kind: e.kind, path: 'ServerAction:Location_GetProperty', inputs: e.inputs, closureCalls: [{ kind: 'ExecuteServerActionNode', actionKind: 'ServerActionSignature', action: 'Reference:FloodServices/ServerActionSignature:GetPropertyDetailsByAddress', external: true }, { kind: 'ExecuteServerActionNode', action: 'ServerAction:WrightFlood_GetAuthorizationToken' }] } : null; },
    usages: key => edges.filter(e => e.target === key).map(e => ({ consumer: e.consumer })),
    properties: p => { const e = elements[p]; return e ? { key: e.key, kind: e.kind, public: e.props.Public === 'True', properties: e.props } : null; },
    inputs: p => elements[p]?.inputs ?? [],
    argumentsOf: np => edges.find(e => e.consumer.path === np)?.arguments ?? null,
  };
}

test('prepare resolves the deterministic entry and validates scenarios offline', async () => {
  const r = await prepareNativeEntry({ action: 'Location_GetProperty', scenarios: [
    { name: 'invalid-country', inputs: { Address1: '100 Main', CountryCode: 'BR' } },
    { name: 'missing-is-manual', inputs: { Address1: 'x', CountryCode: 'US', IsManual: true } },
  ], persist: false }, readers());
  assert.equal(r.ok, true);
  assert.equal(r.state, 'prepared');
  assert.equal(r.entry.kind, 'MobileScreen');
  assert.equal(r.entry.name, 'Location');
  assert.equal(r.entry.distance, 2);
  assert.equal(r.scenariosValidated, 2);
  assert.deepEqual(r.effects, ['unknown-call']);
  assert.deepEqual(r.needs.acknowledgeEffects.sort(), [...r.effects].sort());
  assert.equal(r.callBoundary.schema, 'ssam-odc-native-call-boundary/1');
  assert.equal(r.callBoundary.traceScope, 'selected-local-action');
  assert.equal(r.callBoundary.boundaries[0].producerBodyPinned, false);
  assert.equal(r.callBoundary.boundaries[0].producerFramesObserved, false);
  assert.equal(r.callBoundary.propagationProved, false);
});

test('prepare refuses a dead-code private action without running', async () => {
  const r = await prepareNativeEntry({ action: 'Location_GetProperty', persist: false }, readers({ deadCode: true }));
  assert.equal(r.ok, false);
  assert.equal(r.state, 'dead-code');
  assert.match(r.error, /^dead code: no public entry reaches/);
});
test('mounted lifecycle never falls back to an isolated invocation without runtime evidence', async () => {
  let invoked = false;
  await assert.rejects(() => runNativeEntry({ action: 'Location_GetProperty', lifecycle: 'mounted',
    inputs: { Address1: 'x', CountryCode: 'US' } }, readers(), {
    login: async () => { invoked = true; }, worker: { invoke: async () => { invoked = true; } },
  }), /mount_runtime_required/);
  assert.equal(invoked, false);
  await assert.rejects(() => prepareNativeEntry({ lifecycle: 'mounted', launch: {} }, readers()), /mount_background_unsupported/);
});
test('a prepared mount reaches the authorized mount runner instead of a pending refusal', async () => {
  const prepared = { ok: true, entry: { key: 'OzK7jk5Lo0Wu2dmagSNFog', kind: 'ScreenAction' }, scenarios: [{ name: 'scenario-1', inputs: {} }],
    mount: { screenKey: 'W4JQW+OX20iILeFJFpMkqA' }, needs: { acknowledgeEffects: ['unknown-javascript'] } };
  const unacknowledged = await runMountedNativeEntry({ op: 'run', lifecycle: 'mounted', words: 'Mount in DEV' }, prepared, readers(), { requireClientInspection: true });
  assert.equal(unacknowledged.state, 'effects-not-acknowledged'); assert.deepEqual(unacknowledged.missing, ['unknown-javascript']);
  await assert.rejects(runMountedNativeEntry({ op: 'run', lifecycle: 'mounted', acknowledgeEffects: ['unknown-javascript'] }, prepared, readers(),
    { requireClientInspection: true }), /debug_odc_native_mount_explicit_authorization_required/);
  await assert.rejects(runMountedNativeEntry({ op: 'run', lifecycle: 'mounted', words: 'Mount in DEV', acknowledgeEffects: ['unknown-javascript'] }, prepared, readers(), {}),
    /debug_odc_native_mount_client_inspection_required/);
});
test('client inspector refuses a screen request adapter before login or invocation', async () => {
  let called = false;
  const r = await runNativeEntry({ action: 'Location_GetProperty', inputs: { Address1: 'x', CountryCode: 'US' }, persist: false }, readers(), {
    requireClientInspection: true, login: async () => { called = true; }, worker: { invoke: async () => { called = true; } },
  });
  assert.equal(r.error, 'debug_odc_native_client_inspection_entry_required'); assert.equal(called, false);
});

test('prepare refuses invalid inputs in prepare, before any login', async () => {
  await assert.rejects(() => prepareNativeEntry({ action: 'Location_GetProperty', inputs: { Address1: 'x' }, persist: false }, readers()), /input_mandatory_missing/);
  await assert.rejects(() => prepareNativeEntry({ action: 'Location_GetProperty', inputs: { Address1: 'x', CountryCode: 'US', Bogus: 1 }, persist: false }, readers()), /input_unknown/);
});

test('run without a worker/login returns the exact live plan and touches nothing', async () => {
  const r = await runNativeEntry({ action: 'Location_GetProperty', inputs: { Address1: 'x', CountryCode: 'US' }, acknowledgeEffects: ['unknown-call'] }, readers());
  assert.equal(r.ok, false);
  assert.equal(r.state, 'needs-live');
  assert.ok(r.livePlan.length >= 3);
  assert.match(r.livePlan[0], /secure app-user sign-in/);
});

test('run with an injected worker calls the original entry per scenario', async () => {
  const calls = [];
  const worker = { invoke: async ({ scenario, entry }) => { calls.push({ scenario: scenario.name, entry: entry.key }); return { ok: true, name: scenario.name, outputs: { Success: false } }; }, dispose: async () => {} };
  const login = async () => ({ release: async () => {} });
  const scenarios = [{ name: 'a', inputs: { Address1: 'x', CountryCode: 'US' } }, { name: 'b', inputs: { Address1: 'y', CountryCode: 'BR' } }];
  // effects prepare reports must be acknowledged before the login window opens
  let logins = 0;
  const refused = await runNativeEntry({ action: 'Location_GetProperty', scenarios }, readers(), { worker, login: async () => { logins++; return {}; } });
  assert.equal(refused.state, 'effects-not-acknowledged'); assert.equal(logins, 0); assert.equal(calls.length, 0);
  const r = await runNativeEntry({ action: 'Location_GetProperty', scenarios, acknowledgeEffects: refused.missing }, readers(), { worker, login });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'answered');
  assert.equal(r.results.length, 2);
  assert.deepEqual(calls.map(c => c.scenario), ['a', 'b']);
  assert.equal(calls[0].entry, 'SCREEN');
});

test('override is accepted only as a verified caller', async () => {
  const ok = await prepareNativeEntry({ action: 'Location_GetProperty', entry: 'SCREEN', persist: false }, readers());
  assert.equal(ok.ok, true);
  assert.equal(ok.overridden, true);
  const no = await prepareNativeEntry({ action: 'Location_GetProperty', entry: 'NOTACALLER', persist: false }, readers());
  assert.equal(no.ok, false);
  assert.equal(no.error, 'entry_override_not_a_caller');
});

test('prepare persists a receipt without the chosen input values, and status lists it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-'));
  const r = readers(); r.binding = { tenant: 'offline-test', module: 'FloodQuotes', app: 'FloodQuotes' };
  const prepared = await prepareNativeEntry({ action: 'Location_GetProperty', inputs: { Address1: 'secretish', CountryCode: 'US' } }, r);
  assert.ok(prepared.receiptPath);
  const saved = JSON.parse(fs.readFileSync(prepared.receiptPath, 'utf8'));
  assert.equal(saved.prepared.scenarios, undefined); // input values are not persisted
  assert.ok(!JSON.stringify(saved).includes('secretish'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('classifyEffects reads the closure, read-only requires nothing', () => {
  assert.deepEqual(classifyEffects([]), []);
  assert.ok(classifyEffects([{ kind: 'ExecuteServerActionNode', action: 'ServerAction:X.#Create' }]).includes('entity-write'));
});

// The MCP surface (ssam_debug_run) carries the native-entry fields of both lanes and dispatches ODC native-entry to the
// native branch (never the wrapper), O11 to its runner, without network: the readers and the O11 runner are injected.
test('ssam_debug_run MCP schema takes native-entry for both lanes and dispatches without the wrapper', async () => {
  const tools = new Map(), o11Calls = [];
  const services = { readers: readers(), journal: async () => {}, context: async () => { throw new Error('must not enter the wrapper'); },
    runO11: async value => { o11Calls.push(value); return { ok: true, state: 'prepared' }; } };
  registerRunTools({ registerTool(name, config, fn) { tools.set(name, { config, fn }); } }, value => debugRun(value, { services }), fn => fn);
  const tool = tools.get('ssam_debug_run');
  assert.match(tool.config.description, /native-entry/);
  assert.match(tool.config.description, /overrides must be reachable/);
  const odc = { op: 'prepare', lane: 'odc', execution: 'native-entry', tenant: 'offline-test', module: 'FloodQuotes', action: 'Location_GetProperty',
    scenarios: [{ name: 'a', inputs: { Address1: 'x', CountryCode: 'US' } }], trace: 'nodes', window: { around: 'A'.repeat(22) }, acknowledgeEffects: ['external-http'] };
  assert.equal(tool.config.inputSchema.safeParse(odc).success, true);
  const prepared = await tool.fn(odc);
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.entry.name, 'Location'); assert.equal(prepared.distance, 2);
  assert.equal(typeof prepared.callPath, 'string'); assert.match(prepared.algorithm, /^bfs-callers\/v2/);
  const defaultMode = await tool.fn({ ...odc, execution: undefined });
  assert.equal(defaultMode.execution, 'native-entry'); assert.equal(defaultMode.state, 'prepared');
  // module is required: the published model is read per module
  assert.equal((await tool.fn({ ...odc, module: undefined })).ok, false);
  const o11 = { op: 'prepare', lane: 'o11', execution: 'native-entry', host: 'personal.example.test', module: 'ShopUI', moduleKey: 'A'.repeat(22),
    applicationKey: 'B'.repeat(22), runtimeUrl: 'https://personal.example.test/ShopUI/', action: 'Quote_Compute', entry: '@' + 'C'.repeat(22),
    modules: [{ module: 'ShopCS', moduleKey: 'D'.repeat(22), applicationKey: 'E'.repeat(22) }], trace: 'full', window: { after: 50 },
    scenarios: [{ name: 'a', inputs: { Amount: '10.5' } }] };
  assert.equal(tool.config.inputSchema.safeParse(o11).success, true);
  assert.equal((await tool.fn(o11)).state, 'prepared');
  assert.equal(o11Calls.length, 1); assert.equal(o11Calls[0].entry, '@' + 'C'.repeat(22)); assert.equal(o11Calls[0].window.after, 50);
});
