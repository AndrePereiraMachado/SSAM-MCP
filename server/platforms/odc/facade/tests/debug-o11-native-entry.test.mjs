import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createO11NativeEntryBroker, readO11NativeEntryContract, o11NativePublicCode } from '../debug-o11-native-entry.mjs';
import { originalO11WorkerSuccess, o11InspectionEnableOptions } from '../debug-o11-native-entry-worker.mjs';

// Synthetic local protocol fixtures. They qualify gates and RPC, not an original OutSystems runtime.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-native-contract-'));
  t.after(() => { assert.ok(path.basename(root).startsWith('ssam-o11-native-contract-')); fs.rmSync(root, { recursive: true, force: true }); });
  const directory = path.join(root, '.local', 'debugger', randomUUID()); fs.mkdirSync(directory, { recursive: true });
  const pin = (name, value) => { const file = path.join(root, name); const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    fs.writeFileSync(file, bytes); return { path: file, sha256: sha(bytes) }; };
  const snapshot = pin('source.oml', 'explicitly synthetic snapshot');
  const target = { lane: 'o11', host: 'personal.example.test', runtimeUrl: 'https://personal.example.test/Headless_UI/', module: 'Headless_UI',
    moduleKey: 'A'.repeat(22), applicationKey: 'B'.repeat(22), publishedVersionId: 10, sourceSha256: snapshot.sha256 };
  const assets = ['OutSystems.js', 'Headless_UI.appDefinition.js', 'Headless_UI.Common.UserInfo.mvc.js'].map(name => ({ ...pin(name, '// fixture only'),
    name, execute: false, urlPath: '/Headless_UI/scripts/' + name, query: '?fixture' }));
  const moduleInfo = pin('moduleinfo.json', { manifest: { versionSequence: 10, versionToken: 'fixture',
    urlVersions: Object.fromEntries(assets.map(asset => [asset.urlPath, asset.query])) }, data: { modules: {} } });
  const publicationReceipt = pin('publication.json', { ok: true, state: 'published', versionId: 10, moduleKey: target.moduleKey, candidateSha256: target.sourceSha256 });
  const spec = { modelFactory: 'Headless_UI.Common.UserInfo.mvc$model', controllerFactory: 'Headless_UI.Common.UserInfo.mvc$controller',
    method: 'refresh$Action', viewName: 'MainFlow.Home', apiVersion: 'V'.repeat(22), endpoint: '/Headless_UI/screenservices/Headless_UI/Common/UserInfo/Refresh' };
  const profile = { schema: 'ssam-o11-native-entry-source/1', target, snapshot, moduleInfo, publicationReceipt, assets,
    nativeApplicationGuid: '11111111-1111-4111-8111-111111111111', userProvider: 'Users', applicationDefinition: 'Headless_UI.appDefinition',
    login: { ...spec, method: 'doLogin$ServerAction', endpoint: '/Headless_UI/screenservices/Headless_UI/Common/Login/Login' },
    entry: { ...spec, action: 'Refresh', actionKey: 'C'.repeat(22), kind: 'native-refresh', inputsCount: 0, dataProperty: 'data',
      outputs: [{ name: 'Accepted', attribute: 'acceptedOut', type: 'Boolean' }] } };
  const sourceContract = pin('contract.json', profile), sessionId = randomUUID().replaceAll('-', '');
  return { root, directory, pin, target, profile, sourceContract, sessionId, action: 'Refresh', timeoutSeconds: 5 };
}
function receipt(input, extra = {}) {
  return { schema: 'ssam-o11-native-entry-receipt/1', prepared: true, phase: 'prepared', target: input.target,
    sourceContract: input.sourceContract, sessionId: input.sessionId, loginSubmittedCount: 0, loginAnsweredCount: 0,
    requestSubmittedCount: 0, requestAnsweredCount: 0, loginUncertain: false, requestUncertain: false,
    memoryCleared: false, nativeContextReferencesReleased: false, ...extra };
}
function childFixture(onMessage) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  let ended = false; const end = () => { if (!ended) { ended = true; queueMicrotask(() => child.emit('exit', 0)); } };
  child.kill = () => { child.killed = true; end(); return true; }; child.stdin.on('finish', end); let buffer = '';
  const reply = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', bytes => { buffer += bytes.toString(); let end;
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      queueMicrotask(() => onMessage(JSON.parse(line), reply)); } });
  return child;
}

test('answered login refusal stays failed while successful disposal is acknowledged separately', async t => {
  for (const cleared of [true, false]) {
    const f = fixture(t); let initial;
    const failure = { ok: false, error: 'debug_o11_native_login_failed', authenticated: false,
      loginSubmittedCount: 1, loginAnsweredCount: 1, diagnostics: { errorType: 'InvalidLoginException' } };
    const child = childFixture((message, reply) => {
      if (message.op === 'prepare') { initial = message.input; reply(originalO11WorkerSuccess(message.id, {}, receipt(initial))); }
      if (message.op === 'authenticate') reply({ id: message.id, ok: false, error: failure.error, receipt: receipt(initial, failure) });
      if (message.op === 'dispose') {
        const final = receipt(initial, { ...failure, phase: 'disposed', memoryCleared: cleared, nativeContextReferencesReleased: cleared });
        reply(originalO11WorkerSuccess(message.id, final, final));
      }
    });
    const handle = await createO11NativeEntryBroker({ root: f.root, spawnImpl: () => child }).prepare(f);
    await assert.rejects(handle.authenticate({}), /debug_o11_native_login_failed/);
    const disposed = await handle.dispose();
    assert.equal(disposed.ok, cleared);
    assert.equal(disposed.workerExited, true);
    const processReceipt = JSON.parse(fs.readFileSync(path.join(f.directory, 'native-entry-process-receipt.json')));
    assert.equal(processReceipt.workerExited, true);
    assert.equal(processReceipt.nativeMemoryCleared, cleared);
    assert.equal(processReceipt.nativeContextReferencesReleased, cleared);
    assert.equal(processReceipt.sessionId, f.sessionId);
    assert.deepEqual(processReceipt.sourceContract, f.sourceContract);
    assert.equal(handle.receipt().ok, false);
    assert.equal(handle.receipt().authenticated, false);
    assert.equal(handle.receipt().diagnostics.errorType, 'InvalidLoginException');
    assert.equal(handle.receipt().requestSubmittedCount, 0);
    assert.equal((await handle.dispose()).ok, cleared);
  }
});

test('O11 broker keeps interactive invocation until the fixed server lease, then refuses renewal by another scenario', async t => {
  const f = fixture(t), now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  let invocation, send;
  const child = childFixture((message, reply) => {
    send = reply;
    if (message.op === 'invoke') { invocation = message; return; }
    reply({ id: message.id, ok: true, receipt: receipt(f),
      ...(message.op === 'configure-server-inspection' ? { configured: true, expiresAt: message.input.expiresAt } : {}) });
  });
  const handle = await createO11NativeEntryBroker({ root: f.root, spawnImpl: () => child }).prepare(f);
  const expiresAt = new Date(now + 30000).toISOString();
  await handle.configureServerInspection({ expiresAt });
  const first = handle.invoke({ beforeRequest: async () => {}, scenario: { name: 'one' } });
  await new Promise(resolve => queueMicrotask(resolve));
  t.mock.timers.tick(22000); assert.equal(child.killed, undefined);
  send({ id: invocation.id, ok: true, receipt: receipt(f), scenario: { ok: true } });
  assert.equal((await first).scenario.ok, true);
  const second = handle.invoke({ beforeRequest: async () => {}, scenario: { name: 'two' } });
  const rejected = assert.rejects(second, /worker_unavailable/);
  t.mock.timers.tick(23001); await new Promise(resolve => queueMicrotask(resolve));
  await rejected; assert.equal(child.killed, true);
});

// v2: graph-chosen entry contract (no publication receipt; published identity = inventory row + capture + moduleinfo).
function graphFixture(t) {
  const f = fixture(t);
  const inventoryProof = f.pin('inventory.json', { modules: [{ Name: 'Headless_UI', Key: f.target.moduleKey, ApplicationKey: f.target.applicationKey, VersionId: 10, IsActive: true }] });
  const endpoint = '/Headless_UI/screenservices/Headless_UI/MainFlow/Shop/ActionPlace_Order';
  const { publicationReceipt, entry, ...rest } = f.profile;
  const profile = { ...rest, schema: 'ssam-o11-native-entry-source/2', selector: 'Place_Order', inventoryProof,
    entry: { kind: 'server-stub', controller: 'Headless_UI.MainFlow.Shop.mvc$controller', moduleLevel: false, modelFactory: 'Headless_UI.MainFlow.Shop.mvc$model',
      controllerFactory: 'Headless_UI.MainFlow.Shop.mvc$controller', viewName: 'MainFlow.Shop', method: 'place_Order$ServerAction', actionKey: null, endpoint,
      apiVersion: 'P'.repeat(22), endpoints: [endpoint], endpointVersions: { [endpoint]: 'P'.repeat(22) },
      inputs: [{ name: 'Zip', param: 'zipIn', dataType: 'Text' }, { name: 'Amount', param: 'amountIn', dataType: 'Decimal' }],
      outputs: [{ name: 'OrderId', attribute: 'orderIdOut', dataType: 'LongInteger' }] } };
  return { ...f, profile, sourceContract: f.pin('contract-v2.json', profile), action: 'Place_Order' };
}
test('v2 graph contract: typed entry accepted; selector, inventory, foreign endpoint and login overlap refused', t => {
  const f = graphFixture(t);
  const policy = readO11NativeEntryContract(f.sourceContract, f.target, 'Place_Order');
  assert.equal(policy.version, 2); assert.equal(policy.entry.kind, 'server-stub'); assert.equal(policy.target.publishedVersionId, 10);
  assert.throws(() => readO11NativeEntryContract(f.sourceContract, f.target, 'Other'), /entry_unsupported/);
  const mutate = (name, change) => { const p = structuredClone(f.profile); change(p); return f.pin(name, p); };
  assert.throws(() => readO11NativeEntryContract(mutate('inv.json', p => { p.inventoryProof = f.pin('inv2.json', { modules: [{ Name: 'Headless_UI', Key: f.target.moduleKey,
    ApplicationKey: f.target.applicationKey, VersionId: 11, IsActive: true }] }); }), f.target, 'Place_Order'), /inventory_unproved/);
  assert.throws(() => readO11NativeEntryContract(mutate('foreign.json', p => { p.entry.endpoints.push('/Other/screenservices/Other/X'); }), f.target, 'Place_Order'), /abi_invalid/);
  assert.throws(() => readO11NativeEntryContract(mutate('overlap.json', p => { p.entry.endpoints.push(p.login.endpoint); }), f.target, 'Place_Order'), /abi_invalid/);
  assert.throws(() => readO11NativeEntryContract(mutate('type.json', p => { p.entry.inputs[0].dataType = 'Pointer'; }), f.target, 'Place_Order'), /abi_invalid/);
  assert.throws(() => readO11NativeEntryContract(mutate('proto.json', p => { p.entry.method = '__proto__'; }), f.target, 'Place_Order'), /abi_invalid/);
});
test('v2 scenario invoke accounts every POST with its seq and bounds submissions per scenario', async t => {
  const f = graphFixture(t); let initial; const acks = [];
  const child = childFixture((message, reply) => {
    if (message.op === 'prepare') { initial = message.input; reply({ id: message.id, ok: true, receiptPath: path.join(f.directory, 'native-entry-receipt.json'), receipt: receipt(initial) }); }
    if (message.op === 'invoke') { assert.equal(message.input.scenario.name, 's1');
      for (const seq of [1, 2]) reply({ kind: 'submission', id: message.id, seq, submission: { endpoint: '/Headless_UI/screenservices/Headless_UI/MainFlow/Shop/ActionPlace_Order' } }); }
    if (message.op === 'submission-ack') { acks.push([message.seq, message.accepted]);
      if (acks.length === 2) reply({ id: message.id, ok: true, scenario: { name: 's1', ok: true }, receipt: receipt(initial) }); }
    if (message.op === 'dispose') reply({ id: message.id, ok: true, receipt: receipt(initial, { phase: 'disposed', memoryCleared: true, nativeContextReferencesReleased: true }) });
  });
  const handle = await createO11NativeEntryBroker({ root: f.root, spawnImpl: () => child }).prepare(f);
  const seen = [];
  const result = await handle.invoke({ scenario: { name: 's1', values: {}, trace: 'none' }, beforeRequest: s => { seen.push(s.endpoint); } });
  assert.equal(result.scenario.ok, true); assert.deepEqual(acks, [[1, true], [2, true]]); assert.equal(seen.length, 2);
  await handle.dispose();
});

test('contract hashes are verified before a child or sign-in can be opened', async t => {
  const f = fixture(t); let spawns = 0;
  fs.appendFileSync(f.profile.snapshot.path, 'drift');
  await assert.rejects(createO11NativeEntryBroker({ root: f.root, spawnImpl() { spawns++; } }).prepare(f), /debug_o11_native_source_changed/);
  assert.equal(spawns, 0);
});
test('publication candidate identity and version must match the original snapshot', t => {
  const f = fixture(t); f.profile.publicationReceipt = f.pin('changed-publication.json', { ok: true, state: 'published', versionId: 11,
    moduleKey: f.target.moduleKey, candidateSha256: f.target.sourceSha256 });
  assert.throws(() => readO11NativeEntryContract(f.pin('changed-contract.json', f.profile), f.target, f.action), /publication_unproved/);
});
test('published identity is derived from the pinned profile when the public request carries only environment and module', t => {
  const f = fixture(t); const { publishedVersionId, sourceSha256, ...publicTarget } = f.target;
  const policy = readO11NativeEntryContract(f.sourceContract, publicTarget, f.action);
  assert.equal(policy.target.publishedVersionId, publishedVersionId); assert.equal(policy.target.sourceSha256, sourceSha256);
  assert.throws(() => readO11NativeEntryContract(f.sourceContract, { ...publicTarget, publishedVersionId: 999 }, f.action), /target_mismatch/);
});
test('the initial native entry refuses Integer outputs that could expose a private user identifier', t => {
  const f = fixture(t); f.profile.entry.outputs[0].type = 'Integer';
  assert.throws(() => readO11NativeEntryContract(f.pin('integer-contract.json', f.profile), f.target, f.action), /abi_invalid/);
});
test('dynamic error text with a familiar prefix cannot become a public error', () => {
  const secret = 'alphabeticprivatesentinel';
  assert.equal(o11NativePublicCode('debug_o11_native_' + secret), 'debug_o11_native_worker_failed');
  assert.equal(o11NativePublicCode('debug_o11_native_expired'), 'debug_o11_native_expired');
});
test('receipt scope mismatch rejects a child response', async t => {
  const f = fixture(t); const child = childFixture((message, reply) => reply({ id: message.id, ok: true,
    receiptPath: path.join(f.directory, 'native-entry-receipt.json'), receipt: receipt(message.input, { sessionId: '0'.repeat(32) }) }));
  await assert.rejects(createO11NativeEntryBroker({ root: f.root, spawnImpl: () => child }).prepare(f), /worker_failed/);
  assert.equal(child.killed, true);
});
test('failed preparation exposes a cleanup handle only for a scoped zero-submission receipt', async t => {
  const f = fixture(t); const child = childFixture((message, reply) => reply({ id: message.id, ok: false, error: 'debug_o11_native_source_changed',
    receiptPath: path.join(f.directory, 'native-entry-receipt.json'), receipt: receipt(message.input, { prepared: false, phase: 'disposed',
      memoryCleared: true, nativeContextReferencesReleased: true }) }));
  let failure; try { await createO11NativeEntryBroker({ root: f.root, spawnImpl: () => child }).prepare(f); } catch (error) { failure = error; }
  assert.equal(failure.message, 'debug_o11_native_source_changed');
  assert.equal(failure.nativeEntryCleanupHandle.receipt().memoryCleared, true);
  assert.equal((await failure.nativeEntryCleanupHandle.dispose()).requestSubmittedCount, 0);
});
test('cleanup cannot be inferred from a child that may have submitted a login', async t => {
  const f = fixture(t); const child = childFixture((message, reply) => reply({ id: message.id, ok: false, error: 'debug_o11_native_login_failed',
    receiptPath: path.join(f.directory, 'native-entry-receipt.json'), receipt: receipt(message.input, { prepared: false, phase: 'disposed',
      loginSubmittedCount: 1, memoryCleared: true, nativeContextReferencesReleased: true }) }));
  let failure; try { await createO11NativeEntryBroker({ root: f.root, spawnImpl: () => child }).prepare(f); } catch (error) { failure = error; }
  assert.equal(failure.nativeEntryCleanupHandle, undefined);
});
test('the outgoing request waits for accounting, and a refused accounting callback is never acknowledged', async t => {
  const f = fixture(t); const events = []; let initial;
  const child = childFixture((message, reply) => {
    if (message.op === 'prepare') { initial = message.input; reply({ id: message.id, ok: true, receiptPath: path.join(f.directory, 'native-entry-receipt.json'), receipt: receipt(initial) }); }
    if (message.op === 'invoke') { events.push('gate'); reply({ kind: 'submission', id: message.id, submission: { actionKey: 'C'.repeat(22) } }); }
    if (message.op === 'submission-ack') { events.push(message.accepted ? 'fetch' : 'refused');
      reply({ id: message.id, ok: false, error: 'debug_o11_native_submission_refused', receipt: receipt(initial) }); }
    if (message.op === 'dispose') reply({ id: message.id, ok: true, receipt: receipt(initial, { phase: 'disposed', memoryCleared: true, nativeContextReferencesReleased: true }) });
  });
  const handle = await createO11NativeEntryBroker({ root: f.root, spawnImpl: () => child }).prepare(f);
  await assert.rejects(handle.invoke({ beforeRequest() { events.push('account'); throw new Error('private callback message'); } }), /submission_refused/);
  assert.deepEqual(events, ['gate', 'account', 'refused']); await handle.dispose();
});
test('directory traversal is refused before the worker starts', async t => {
  const f = fixture(t); let spawns = 0;
  await assert.rejects(createO11NativeEntryBroker({ root: f.root, spawnImpl() { spawns++; } }).prepare({ ...f, directory: f.root }), /directory_denied/);
  assert.equal(spawns, 0);
});
test('a process that never confirms exit cannot claim cleanup or provide a cleanup capability', async t => {
  const f = fixture(t); const child = childFixture((message, reply) => reply({ id: message.id, ok: false,
    error: 'debug_o11_native_source_changed', receiptPath: path.join(f.directory, 'native-entry-receipt.json'),
    receipt: receipt(message.input, { prepared: false, phase: 'disposed', memoryCleared: true, nativeContextReferencesReleased: true }) }));
  child.stdin.removeAllListeners('finish'); child.kill = () => false;
  let failure; try { await createO11NativeEntryBroker({ root: f.root, spawnImpl: () => child }).prepare(f); } catch (error) { failure = error; }
  assert.equal(failure.nativeEntryCleanupHandle, undefined);
  const processReceipt = JSON.parse(fs.readFileSync(path.join(f.directory, 'native-entry-process-receipt.json')));
  assert.equal(processReceipt.workerExited, false);
  assert.equal(processReceipt.nativeMemoryCleared, false);
  assert.equal(processReceipt.nativeContextReferencesReleased, false);
});
test('O11 broker and worker forward a boolean pauseOnExceptions to the client inspection and refuse other values', async t => {
  const f = fixture(t), seen = [];
  const child = childFixture((message, reply) => {
    if (message.op === 'configure-inspection') { seen.push(message.input); reply({ id: message.id, ok: false, error: 'debug_o11_native_session_busy', receipt: receipt(f) }); return; }
    reply({ id: message.id, ok: true, receipt: receipt(f) });
  });
  const handle = await createO11NativeEntryBroker({ root: f.root, spawnImpl: () => child }).prepare(f);
  const options = { modules: [{ moduleKey: 'A'.repeat(22), sourceSha256: 'a'.repeat(64) }], variables: [], breakpoints: ['A'.repeat(22) + ':' + 'C'.repeat(22)], leaseMs: 5000, onEvent() {} };
  await assert.rejects(handle.configureInspection({ ...options, pauseOnExceptions: 'yes' }), /debug_o11_native_inspection_options_invalid/);
  assert.equal(seen.length, 0);
  await assert.rejects(handle.configureInspection({ ...options, pauseOnExceptions: true }), /debug_o11_native_session_busy/);
  assert.equal(seen[0].pauseOnExceptions, true); assert.equal('onEvent' in seen[0], false);
  // The worker stores only the native enable options for the original debugger switch.
  assert.deepEqual(o11InspectionEnableOptions(seen[0]), { breakpoints: options.breakpoints, pauseOnExceptions: true });
  assert.deepEqual(o11InspectionEnableOptions({}), { breakpoints: [], pauseOnExceptions: false });
  assert.throws(() => o11InspectionEnableOptions({ pauseOnExceptions: 1 }), /debug_o11_native_preparation_invalid/);
  await handle.dispose();
});
