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
