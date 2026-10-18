import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { debugSchema, parseDebugCli, registerDebugTools } from '../debug.mjs';
import { headlessDebug, o11DebugRequest } from '../debug-runtime.mjs';
import { appUserBinding } from '../debug-app-user.mjs';

const moduleKey = 'A'.repeat(22), applicationKey = 'B'.repeat(22), nodeKey = 'D'.repeat(22);
const userKey = '22345678-1234-4234-8234-123456789abc';
const credentialRef = '12345678-1234-4234-8234-123456789abc';
const base = { op: 'watch', lane: 'odc', tenant: 'fixture-tenant', module: 'Fixture', moduleKey,
  runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/', nodeKeys: [nodeKey] };
const cli = input => ['watch', '--lane', input.lane, ...(input.tenant ? ['--tenant', input.tenant] : []),
  '--module', input.module, '--module-key', input.moduleKey, '--runtime-url', input.runtimeUrl, '--node-keys', input.nodeKeys.join(',')];

function fixture(lane = 'odc') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-debug-watch-'));
  const selected = { pid: 12345, startedUtc: '2026-10-02T12:00:00Z', studioDir: path.join(dir, 'studio') };
  const input = { ...base, lane, nodeKeys: [...base.nodeKeys] };
  if (lane === 'o11') {
    delete input.tenant;
    input.runtimeUrl = 'https://fixture.outsystemscloud.com/Fixture/';
    const proof = Buffer.from(JSON.stringify({ host: 'fixture.outsystemscloud.com', capturedAtUtc: new Date().toISOString(),
      modules: [{ Name: input.module, Key: moduleKey, ApplicationKey: applicationKey, VersionId: 7, IsActive: true }] }));
    const proofPath = path.join(dir, 'inventory.json'); fs.writeFileSync(proofPath, proof);
    input.o11Auth = { applicationKey, publishedVersionId: 7, publishedProof: { path: proofPath, sha256: createHash('sha256').update(proof).digest('hex') } };
  }
  const events = [], journals = [], commands = [], released = [];
  let descriptor, bootstrap, nativeStatus;
  const services = {
    sessionRoot: path.join(dir, 'sessions'),
    getOdcDebugToken: async () => { events.push('developer-debug-token'); return 'synthetic-developer-token'; },
    selectedO11Studio: async () => selected,
    installation: async () => selected.studioDir,
    worker: async () => path.join(dir, 'SSAM.Debugger.dll'),
    prepareAppUser: async (request, { sessionId }) => {
      events.push('private-app-login');
      descriptor = { credentialRef, binding: appUserBinding(request, sessionId), expiresAt: new Date(Date.now() + 60000).toISOString(),
        ...(lane === 'odc' ? { state: 'authenticated', authenticated: true, userKey } : { state: 'credentials-entered' }) };
      return { ok: true, descriptor };
    },
    privateAppUserVault: async (mode, request) => {
      assert.equal(mode, 'read'); events.push('private-vault-read');
      return { ok: true, binding: request.binding, expiresAt: request.expiresAt,
        ...(lane === 'odc' ? { kind: 'session', session: { binding: request.binding, expiresAt: request.expiresAt, userKey,
          accessToken: 'synthetic-app-access', idToken: 'synthetic-app-id', refreshToken: 'synthetic-app-refresh' } }
          : { kind: 'credentials', username: 'synthetic-app-user', password: 'synthetic-app-password' }) };
    },
    getO11DebugToken: async request => {
      events.push('developer-sso-token');
      const { binding } = o11DebugRequest(input, request.sessionId, selected, request.operationId);
      return { ok: true, operationId: request.operationId, binding, newAuthentication: true, path: 'identity-service',
        token: 'synthetic-developer-token', soapUser: 'synthetic-studio-user', soapSecret: 'synthetic-studio-id',
        preflight: { pingSucceeded: true, inDebug: true, debuggerVersion: 1 } };
    },
    spawn: (exe, args, options) => {
      assert.equal(exe, 'dotnet'); assert.equal(options.windowsHide, true);
      assert.doesNotMatch(JSON.stringify(args), /synthetic-/); events.push('debugger-worker');
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.destroy = () => {};
      child.stdin = new EventEmitter(); child.stdin.destroy = () => {}; child.unref = () => {};
      child.stdin.end = text => {
        bootstrap = JSON.parse(text); events.push('private-bootstrap');
        nativeStatus = { ok: true, state: 'connected', trace: bootstrap.trace ? { mode: bootstrap.trace.mode, count: 0, steps: bootstrap.trace.steps } : null };
        fs.writeFileSync(bootstrap.receiptPath, JSON.stringify(nativeStatus));
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify(nativeStatus) + '\n')));
      };
      return child;
    },
    pipeRequest: async (sessionId, command) => {
      commands.push({ sessionId, ...command });
      if (command.op === 'stop') {
        nativeStatus = { ...nativeStatus, state: 'stopped' };
        fs.writeFileSync(bootstrap.receiptPath, JSON.stringify(nativeStatus));
      }
      return structuredClone(nativeStatus);
    },
    releaseAppUser: async value => { released.push(value); return { ok: true }; },
    journal: value => journals.push(value),
  };
  return { dir, input, services, events, journals, commands, released,
    get descriptor() { return descriptor; }, get bootstrap() { return bootstrap; },
    count(value) { nativeStatus.trace.count = value; },
    expire() { fs.writeFileSync(bootstrap.receiptPath, JSON.stringify({ ...nativeStatus, state: 'stopped' })); },
    close() { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('watch CLI and MCP use the existing target/lifetime contract, automatic trace and no new CLI trace flag', () => {
  assert.equal(parseDebugCli(cli(base)).op, 'watch');
  assert.equal(debugSchema.parse(base).seconds, 120);
  assert.equal(debugSchema.parse(base).autoContinue, true);
  const nodes = Array.from({ length: 200 }, (_, i) => String(i).padStart(22, 'A'));
  assert.equal(debugSchema.safeParse({ ...base, nodeKeys: nodes }).success, true);
  assert.equal(debugSchema.safeParse({ ...base, op: 'start', nodeKeys: nodes.slice(0, 21) }).success, false);
  for (const invalid of [{ ...base, nodeKeys: [...nodes, 'Z'.repeat(22)] }, { ...base, nodeKeys: [nodeKey, nodeKey] },
    { ...base, autoContinue: false }, { ...base, seconds: 601 }, { ...base, sessionId: 'c'.repeat(32) },
    { ...base, tenant: undefined }, { ...base, password: 'must-not-be-an-argument' }])
    assert.equal(debugSchema.safeParse(invalid).success, false);
  assert.throws(() => parseDebugCli([...cli(base), '--manual']));
  assert.throws(() => parseDebugCli([...cli(base), '--trace', 'fixture.json']), /Invalid debugger option/);
  assert.equal(parseDebugCli(['start', ...cli(base).slice(1), '--manual']).autoContinue, false);
});

for (const lane of ['odc', 'o11']) test(`watch ${lane} opens the private app login and starts only the debugger, preserving separate developer auth`, async () => {
  const f = fixture(lane);
  try {
    const result = await headlessDebug(f.input, { services: f.services });
    assert.equal(result.ok, true); assert.equal(result.mode, 'watch'); assert.equal(result.watch.state, 'waiting-for-app-use');
    assert.equal(result.watch.automaticInvocation, false); assert.equal(result.watch.userRequestIsolationProved, false);
    assert.equal(result.watch.appRequestIdentityProved, false);
    assert.deepEqual(f.bootstrap.trace, { mode: 'step', steps: 200, depth: 2, fullValues: false, scopes: {} });
    assert.equal(f.bootstrap.seconds, 120); assert.equal(f.bootstrap.autoContinue, true);
    for (const name of ['op', 'mode', 'action', 'inputs', 'request', 'payload', 'appUser']) assert.equal(f.bootstrap[name], undefined);
    assert.equal(f.events.filter(value => value === 'private-app-login').length, 1);
    assert.equal(f.commands.length, 0); assert.equal(f.released.length, 0);
    if (lane === 'o11') assert.ok(f.events.indexOf('private-app-login') < f.events.indexOf('developer-sso-token'));
    const manifest = JSON.parse(fs.readFileSync(path.join(f.services.sessionRoot, result.sessionId, 'manifest.json')));
    assert.equal(manifest.mode, 'watch'); assert.deepEqual(manifest.trace, f.bootstrap.trace); assert.equal(manifest.seconds, 120);
    assert.equal(f.journals[0].command, 'watch');
    for (const value of [result, manifest, f.journals, JSON.parse(fs.readFileSync(result.receiptPath))])
      assert.doesNotMatch(JSON.stringify(value), /synthetic-(?:developer|app|studio)-/);
    await assert.rejects(headlessDebug(f.input, { services: f.services }), /debug_target_has_session/);
    assert.equal(f.events.filter(value => value === 'private-app-login').length, 1);
    if (lane === 'o11') {
      const file = path.join(f.dir, 'o11-auth.json'); fs.writeFileSync(file, JSON.stringify(f.input.o11Auth));
      assert.deepEqual(parseDebugCli([...cli(f.input), '--o11-auth', file]).o11Auth, f.input.o11Auth);
    }
  } finally { f.close(); }
});

test('watch status projects native visit quota and stop releases only its private identity/lock', async () => {
  const f = fixture();
  try {
    const result = await headlessDebug({ ...f.input, seconds: 45, trace: { steps: 2, scopes: { [moduleKey]: ['Result.Value'] } } }, { services: f.services });
    assert.equal(f.bootstrap.trace.fullValues, false); assert.deepEqual(f.bootstrap.trace.scopes, { [moduleKey]: ['Result.Value'] });
    f.count(1);
    const status = await headlessDebug({ op: 'status', sessionId: result.sessionId }, { services: f.services });
    assert.equal(status.watch.state, 'tracing'); assert.equal(status.watch.seconds, 45);
    f.count(2);
    const exhausted = await headlessDebug({ op: 'status', sessionId: result.sessionId }, { services: f.services });
    assert.equal(exhausted.watch.state, 'trace-limit-reached'); assert.equal(exhausted.state, 'connected');
    assert.equal(exhausted.watch.userRequestIsolationProved, false);
    const stopped = await headlessDebug({ op: 'stop', sessionId: result.sessionId }, { services: f.services });
    assert.equal(stopped.watch.state, 'stopped'); assert.equal(stopped.credentialCleanup.state, 'released');
    assert.deepEqual(f.commands.map(value => value.op), ['status', 'status', 'stop']);
    assert.equal(f.released.length, 1); assert.deepEqual(f.released[0], f.descriptor);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.services.sessionRoot, result.sessionId, 'manifest.json')));
    assert.equal(fs.existsSync(manifest.lock), false);
  } finally { f.close(); }
});

test('expired watch answers from the final native receipt without restarting the worker', async () => {
  const f = fixture();
  try {
    const result = await headlessDebug(f.input, { services: f.services }); f.expire();
    f.services.pipeRequest = async () => { throw new Error('debug_session_unreachable'); };
    const status = await headlessDebug({ op: 'status', sessionId: result.sessionId }, { services: f.services });
    assert.equal(status.state, 'stopped'); assert.equal(status.watch.state, 'stopped');
    assert.equal(status.watch.automaticInvocation, false); assert.equal(status.watch.userRequestIsolationProved, false);
    assert.equal(f.events.filter(value => value === 'debugger-worker').length, 1); assert.equal(f.released.length, 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.services.sessionRoot, result.sessionId, 'manifest.json')));
    assert.equal(fs.existsSync(manifest.lock), false);
  } finally { f.close(); }
});

test('cancelled watch never starts or invokes; uncertain O11 authentication retains its lock and is not retried', async () => {
  const cancelled = fixture(), uncertain = fixture('o11');
  try {
    cancelled.services.prepareAppUser = async () => ({ ok: false, state: 'cancelled' });
    const cancelResult = await headlessDebug(cancelled.input, { services: cancelled.services });
    assert.equal(cancelResult.watch.state, 'not-watching'); assert.equal(cancelResult.watch.automaticInvocation, false);
    assert.equal(cancelled.events.includes('debugger-worker'), false);
    assert.equal(fs.readdirSync(cancelled.services.sessionRoot).some(name => name.endsWith('.lock')), false);
    let tokenCalls = 0;
    uncertain.services.getO11DebugToken = async () => { tokenCalls++; throw new Error('debug_o11_token_exchange_uncertain'); };
    uncertain.services.authOperationPhase = () => 'uncertain';
    uncertain.services.pipeRequest = async () => { throw new Error('debug_session_unreachable'); };
    const result = await headlessDebug(uncertain.input, { services: uncertain.services });
    assert.equal(result.state, 'token-uncertain'); assert.equal(result.watch.state, 'uncertain');
    const manifest = JSON.parse(fs.readFileSync(path.join(uncertain.services.sessionRoot, result.sessionId, 'manifest.json')));
    for (const op of ['status', 'stop']) {
      const answer = await headlessDebug({ op, sessionId: result.sessionId }, { services: uncertain.services });
      assert.equal(answer.watch.state, 'uncertain'); assert.equal(answer.ok, false); assert.equal(fs.existsSync(manifest.lock), true);
    }
    await assert.rejects(headlessDebug(uncertain.input, { services: uncertain.services }), /debug_target_has_session/);
    assert.equal(tokenCalls, 1); assert.equal(uncertain.events.includes('debugger-worker'), false); assert.equal(uncertain.released.length, 0);
  } finally { cancelled.close(); uncertain.close(); }
});

test('ordinary start stays unchanged and the registered MCP tool describes watch without promising request isolation', async () => {
  const f = fixture(), tools = new Map();
  try {
    const result = await headlessDebug({ ...f.input, op: 'start' }, { services: f.services });
    assert.equal(result.mode, undefined); assert.equal(result.watch, undefined); assert.equal(f.bootstrap.trace, undefined);
    registerDebugTools({ registerTool(name, config, fn) { tools.set(name, { config, fn }); } }, async input => input, fn => fn);
    const tool = tools.get('ssam_debug');
    assert.equal(tool.config.inputSchema.safeParse(base).success, true);
    for (const phrase of ['watch enables automatic trace', 'never invokes an action', 'userRequestIsolationProved=false', 'automaticInvocation=false']) {
      assert.ok(tool.config.description.includes(phrase), phrase);
    }
    assert.equal((await tool.fn(base)).op, 'watch');
  } finally { f.close(); }
});

test('internal O11 background watch uses native SSO without an app login and never proves ownership or identity', async () => {
  const f = fixture('o11');
  try {
    f.input.trace = { focusFunctionKey: moduleKey, requireFunctionKey: moduleKey };
    const result = await headlessDebug(f.input, { services: f.services, backgroundWatch: true, contextMode: 'native-background' });
    assert.equal(result.ok, true); assert.equal(result.contextMode, 'native-background'); assert.equal(result.appUser, undefined);
    for (const flag of ['requestOwnershipProved', 'appUserIdentityProved', 'rolesProved', 'executionCompleted']) assert.equal(result[flag], false);
    assert.deepEqual(f.events, ['developer-sso-token', 'debugger-worker', 'private-bootstrap']);
    assert.deepEqual(f.bootstrap.privateValues, []); assert.equal(f.bootstrap.trace.fullValues, false);
    assert.equal(f.bootstrap.token, 'synthetic-developer-token'); assert.equal(f.bootstrap.soapSecret, 'synthetic-studio-id');
    const manifest = JSON.parse(fs.readFileSync(path.join(f.services.sessionRoot, result.sessionId, 'manifest.json')));
    assert.equal(manifest.appUser, undefined); assert.equal(manifest.backgroundWatch, true);
    assert.doesNotMatch(JSON.stringify(manifest), /synthetic-/);
    const stopped = await headlessDebug({ op: 'stop', sessionId: result.sessionId }, { services: f.services });
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.appUser, undefined); assert.equal(stopped.requestOwnershipProved, false);
    assert.equal(f.released.length, 0); assert.deepEqual(f.commands.map(c => c.op), ['stop']); assert.equal(fs.existsSync(manifest.lock), false);
  } finally { f.close(); }
});

test('background full trace preserves the private native auth/redaction bootstrap and permits only status or stop afterwards', async () => {
  const f = fixture('o11');
  try {
    f.input.trace = { fullValues: true, depth: 4, focusFunctionKey: moduleKey, requireFunctionKey: moduleKey,
      scopes: { [moduleKey]: ['Count', 'Password', 'Lookup'] } };
    const result = await headlessDebug(f.input, { services: f.services, backgroundWatch: true, contextMode: 'native-background' });
    assert.equal(result.ok, true); assert.equal(result.valuesComplete, false); assert.equal(result.propagationProved, false);
    assert.deepEqual(f.events, ['developer-sso-token', 'debugger-worker', 'private-bootstrap']);
    assert.equal(f.bootstrap.trace.fullValues, true); assert.equal(f.bootstrap.trace.depth, 4);
    assert.deepEqual(f.bootstrap.trace.scopes, f.input.trace.scopes); assert.deepEqual(f.bootstrap.privateValues, []);
    // DebugSession adds exactly these private bootstrap values to its existing per-session DebugPolicy.
    assert.equal(f.bootstrap.token, 'synthetic-developer-token'); assert.equal(f.bootstrap.soapUser, 'synthetic-studio-user');
    assert.equal(f.bootstrap.soapSecret, 'synthetic-studio-id');
    for (const op of ['variables', 'step-into', 'step-over', 'step-out', 'continue'])
      await assert.rejects(headlessDebug({ op, sessionId: result.sessionId, threadId: 'T', eventId: '1', paths: ['Foreign.Value'] },
        { services: f.services }), /background_watch_command_invalid/);
    assert.equal(f.commands.length, 0);
    const status = await headlessDebug({ op: 'status', sessionId: result.sessionId }, { services: f.services });
    assert.equal(status.requestOwnershipProved, false); assert.equal(status.valuesComplete, false);
    assert.equal((await headlessDebug({ op: 'stop', sessionId: result.sessionId }, { services: f.services })).state, 'stopped');
    const manifest = JSON.parse(fs.readFileSync(path.join(f.services.sessionRoot, result.sessionId, 'manifest.json')));
    assert.doesNotMatch(JSON.stringify(manifest), /synthetic-/); assert.equal(f.released.length, 0);
    assert.equal(fs.existsSync(manifest.lock), false);
  } finally { f.close(); }
});

test('background watch refuses unbound scopes, app identity, another lane or operation before native authentication', async () => {
  const f = fixture('o11');
  try {
    const context = { services: f.services, backgroundWatch: true, contextMode: 'native-background' };
    const full = { fullValues: true, focusFunctionKey: moduleKey, requireFunctionKey: moduleKey, scopes: { [moduleKey]: ['Count'] } };
    f.input.trace = { focusFunctionKey: moduleKey, requireFunctionKey: moduleKey };
    for (const [input, extra] of [[{ ...f.input, op: 'start' }, {}], [{ ...f.input, lane: 'odc', tenant: 'fixture' }, {}],
      [{ ...f.input, trace: { fullValues: true } }, {}], [{ ...f.input, trace: { scopes: { [moduleKey]: ['Private'] } } }, {}],
      [{ ...f.input, trace: { ...full, scopes: {} } }, {}],
      [{ ...f.input, trace: { ...full, scopes: { [nodeKey]: ['Count'] } } }, {}],
      [{ ...f.input, trace: { ...full, scopes: { [moduleKey]: ['Count', 'Count'] } } }, {}],
      [{ ...f.input, trace: { ...full, scopes: { [moduleKey]: ['Foreign.Value'] } } }, {}],
      [{ ...f.input, trace: { ...full, requireFunctionKey: nodeKey } }, {}],
      [{ ...f.input, trace: { ...full, mode: 'breakpoints' } }, {}],
      [{ ...f.input, paths: ['Count'], trace: full }, {}],
      [{ ...f.input, trace: undefined }, {}],
      [f.input, { appUser: {} }], [f.input, { redactionOnly: true }], [f.input, { contextMode: undefined }]])
      await assert.rejects(headlessDebug(input, { ...context, ...extra }));
    assert.deepEqual(f.events, []); assert.equal(fs.existsSync(f.services.sessionRoot), false);
  } finally { f.close(); }
});

test('anonymous original-entry watch keeps its explicit context, uses only debugger SSO and restricts later commands', async () => {
  for (const fullValues of [false, true]) {
    const f = fixture('o11');
    try {
      f.input.trace = { fullValues, depth: 4, focusFunctionKey: moduleKey, requireFunctionKey: moduleKey,
        scopes: fullValues ? { [moduleKey]: ['Count', 'Result', 'Password'] } : {} };
      const result = await headlessDebug(f.input, { services: f.services, anonymousWatch: true, contextMode: 'anonymous' });
      assert.equal(result.ok, true); assert.equal(result.contextMode, 'anonymous'); assert.equal(result.appUser, undefined);
      for (const flag of ['requestOwnershipProved', 'appUserIdentityProved', 'rolesProved', 'propagationProved', 'executionCompleted'])
        assert.equal(result[flag], false);
      assert.deepEqual(f.events, ['developer-sso-token', 'debugger-worker', 'private-bootstrap']);
      assert.deepEqual(f.bootstrap.privateValues, []); assert.deepEqual(f.bootstrap.trace.scopes, f.input.trace.scopes);
      assert.equal(f.bootstrap.token, 'synthetic-developer-token'); assert.equal(f.bootstrap.soapSecret, 'synthetic-studio-id');
      const manifest = JSON.parse(fs.readFileSync(path.join(f.services.sessionRoot, result.sessionId, 'manifest.json')));
      assert.equal(manifest.contextMode, 'anonymous'); assert.equal(manifest.anonymousWatch, true);
      assert.equal(manifest.appUser, undefined); assert.equal(manifest.backgroundWatch, undefined);
      assert.doesNotMatch(JSON.stringify(manifest), /synthetic-/);
      for (const op of ['variables', 'continue', 'step-into', 'step-over', 'step-out'])
        await assert.rejects(headlessDebug({ op, sessionId: result.sessionId, threadId: 'T', eventId: '1', paths: ['Foreign.Value'] },
          { services: f.services }), /anonymous_watch_command_invalid/);
      assert.equal(f.commands.length, 0);
      const status = await headlessDebug({ op: 'status', sessionId: result.sessionId }, { services: f.services });
      assert.equal(status.contextMode, 'anonymous'); assert.equal(status.appUserIdentityProved, false);
      const stopped = await headlessDebug({ op: 'stop', sessionId: result.sessionId }, { services: f.services });
      assert.equal(stopped.state, 'stopped'); assert.equal(stopped.contextMode, 'anonymous');
      assert.equal(f.released.length, 0); assert.equal(fs.existsSync(manifest.lock), false);
    } finally { f.close(); }
  }
});

test('anonymous watch refuses mixed contexts, injected identity and unbound roots before authentication', async () => {
  const f = fixture('o11');
  try {
    const full = { fullValues: true, focusFunctionKey: moduleKey, requireFunctionKey: moduleKey, scopes: { [moduleKey]: ['Count'] } };
    f.input.trace = full;
    const context = { services: f.services, anonymousWatch: true, contextMode: 'anonymous' };
    for (const [input, extra] of [[f.input, { backgroundWatch: true }], [f.input, { contextMode: 'native-background' }],
      [f.input, { contextMode: undefined }], [f.input, { appUser: {} }], [f.input, { redactionOnly: true }],
      [{ ...f.input, op: 'start' }, {}], [{ ...f.input, lane: 'odc', tenant: 'fixture' }, {}],
      [{ ...f.input, trace: { ...full, requireFunctionKey: nodeKey } }, {}],
      [{ ...f.input, trace: { ...full, scopes: { [nodeKey]: ['Count'] } } }, {}],
      [{ ...f.input, trace: { ...full, scopes: { [moduleKey]: ['Foreign.Value'] } } }, {}],
      [{ ...f.input, trace: { ...full, scopes: { [moduleKey]: ['Count', 'Count'] } } }, {}],
      [{ ...f.input, trace: { ...full, scopes: {} } }, {}], [{ ...f.input, paths: ['Count'] }, {}],
      [{ ...f.input, trace: { ...full, mode: 'breakpoints' } }, {}]])
      await assert.rejects(headlessDebug(input, { ...context, ...extra }));
    assert.deepEqual(f.events, []); assert.equal(fs.existsSync(f.services.sessionRoot), false);
  } finally { f.close(); }
});

test('ODC background watch uses its native developer token, with exact action roots and no app-user session', async () => {
  const f = fixture('odc');
  try {
    const context = { services: f.services, backgroundWatch: true, contextMode: 'native-background' };
    f.input.trace = { fullValues: true, focusFunctionKey: moduleKey, requireFunctionKey: moduleKey, scopes: { [moduleKey]: ['Count', 'Result'] } };
    for (const [input, extra] of [[f.input, { appUser: {} }], [f.input, { redactionOnly: true }],
      [f.input, { contextMode: 'anonymous' }], [{ ...f.input, trace: { ...f.input.trace, requireFunctionKey: nodeKey } }, {}],
      [{ ...f.input, trace: { ...f.input.trace, scopes: { [moduleKey]: ['Foreign.Value'] } } }, {}],
      [{ ...f.input, paths: ['Result'] }, {}]])
      await assert.rejects(headlessDebug(input, { ...context, ...extra }), /debug_odc_background_watch_context_invalid/);
    assert.deepEqual(f.events, []);
    const result = await headlessDebug(f.input, context);
    assert.equal(result.contextMode, 'native-background'); assert.equal(result.appUser, undefined);
    for (const flag of ['requestOwnershipProved', 'appUserIdentityProved', 'rolesProved', 'propagationProved', 'executionCompleted'])
      assert.equal(result[flag], false);
    assert.deepEqual(f.events, ['developer-debug-token', 'debugger-worker', 'private-bootstrap']);
    assert.deepEqual(f.bootstrap.privateValues, []); assert.equal(f.bootstrap.token, 'synthetic-developer-token');
    assert.equal(f.bootstrap.soapUser, undefined); assert.equal(f.bootstrap.soapSecret, undefined);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.services.sessionRoot, result.sessionId, 'manifest.json')));
    assert.equal(manifest.backgroundWatch, true); assert.equal(manifest.appUser, undefined); assert.equal(manifest.o11Auth, undefined);
    assert.doesNotMatch(JSON.stringify(manifest), /synthetic-/);
    await assert.rejects(headlessDebug({ op: 'variables', sessionId: result.sessionId, threadId: 'T', eventId: '1', paths: ['Result'] },
      { services: f.services }), /debug_odc_background_watch_command_invalid/);
    const stopped = await headlessDebug({ op: 'stop', sessionId: result.sessionId }, { services: f.services });
    assert.equal(stopped.contextMode, 'native-background'); assert.equal(stopped.executionCompleted, false);
    assert.equal(f.released.length, 0); assert.equal(fs.existsSync(manifest.lock), false);
  } finally { f.close(); }
});

for(const [lane,background] of [['o11',false],['o11',true],['odc',true],['odc',false]]) test(`original ${lane} ${background?'timer':'anonymous endpoint'} inspection uses bound metadata and no invented app identity`, async () => {
 const f=fixture(lane);try{
  const sourceSha256='e'.repeat(64),binding={moduleKey,functionKey:moduleKey,sourceSha256};
  const scope={...binding,nodeKey},inspection={sources:[{moduleKey,sourceSha256}],scopes:[scope],variables:[{...scope,variableKey:'F'.repeat(22),name:'Count',category:'local',path:'Count'}]};
  const input={...f.input,op:'start',autoContinue:false,inspection};
  const field=background?'backgroundInspection':'anonymousInspection',context={services:f.services,[background?'backgroundWatch':'anonymousWatch']:true,contextMode:background?'native-background':'anonymous',[field]:binding};
  for(const [request,extra] of [[input,{[background?'anonymousWatch':'backgroundWatch']:true}],[input,{appUser:{}}],[input,{contextMode:'app-user'}],
   [input,{[field]:{...binding,sourceSha256:'f'.repeat(64)}}],
   [{...input,inspection:{...inspection,sources:[]}},{}],
   [{...input,inspection:{...inspection,scopes:[{...scope,functionKey:nodeKey}]}},{}]])
    await assert.rejects(headlessDebug(request,{...context,...extra}),/anonymous_inspection_context_invalid/);
  assert.equal(f.events.length,0);
  const secondScope={...scope,functionKey:nodeKey};
  const multiple={...input,inspection:{...inspection,scopes:[scope,secondScope]}};
  for(const keys of [[],[nodeKey],[moduleKey,'invalid']])
    await assert.rejects(headlessDebug(multiple,{...context,[field]:{...binding,functionKeys:keys}}),/anonymous_inspection_context_invalid/);
  const started=await headlessDebug(multiple,{...context,[field]:{...binding,functionKeys:[moduleKey,nodeKey]}});assert.equal(started.ok,true);assert.equal(started.contextMode,background?'native-background':'anonymous');assert.equal(started.appUserIdentityProved,false);
  assert.ok(!f.events.includes('private-app-login'));assert.ok(!f.events.includes('private-vault-read'));
  assert.equal(f.bootstrap.autoContinue,false);assert.equal(f.bootstrap.trace,undefined);assert.deepEqual(f.bootstrap.inspection,multiple.inspection);
  for(const op of ['scope','step-into','step-over','step-out','continue'])await headlessDebug({op,sessionId:started.sessionId,threadId:'T',eventId:'1'},{services:f.services});
  await assert.rejects(headlessDebug({op:'variables',sessionId:started.sessionId,threadId:'T',eventId:'1',paths:['Foreign.Value']},{services:f.services}),/anonymous_watch_command_invalid/);
  const stopped=await headlessDebug({op:'stop',sessionId:started.sessionId},{services:f.services});assert.equal(stopped.state,'stopped');assert.equal(stopped.rolesProved,false);
 }finally{f.close();}
});
