import './fixtures/isolated-profile.mjs';
// Lane F of the 2026-10-05 package (docs/PACOTE-SESSOES-NOVO.md, C05): a failed sign-in of the headless debugger answers
// what failed, for whom, where and the exact next step (DEBUG_APP_USER_SIGN_IN_FAILED with user, provider, environment,
// next) instead of a bare private code; an O11 start with no developer login at all is refused before the app-user window
// (the debug_native_error of session dd2b79c0, 02:15); native failures name their cause and the receipt read; the three
// tool descriptions carry the rule against writing diagnostics into business tables. Offline: fakes for the vault, the
// identity provider, the worker and the native process; synthetic names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { headlessDebug } from '../debug-runtime.mjs';
import { debugRun, registerRunTools } from '../debug-run.mjs';
import { registerDebugTools } from '../debug.mjs';
import { registerInvokeTools } from '../debug-invoke.mjs';
import { prepareDebugAppUser } from '../debug-app-user.mjs';
import { authenticatePrivateAppUser } from '../debug-app-user-worker.mjs';
import { DIAGNOSTICS_RULE, maskUser, nativeFailure } from '../debug-guidance.mjs';

const moduleKey = 'A'.repeat(22), applicationKey = 'B'.repeat(22), nodeKey = 'D'.repeat(22);
const USER = 'app.user@example.com', PASSWORD = 'synthetic-app-password';
const odcInput = { op: 'start', lane: 'odc', tenant: 'fixture-tenant', module: 'Fixture', moduleKey,
  runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/', nodeKeys: [nodeKey] };
const o11Input = { op: 'start', lane: 'o11', module: 'Fixture', moduleKey, runtimeUrl: 'https://fixture.outsystemscloud.com/Fixture/', nodeKeys: [nodeKey] };

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-laneF-debug-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The private vault and worker of the real sign-in, in memory: the prompt "stores" the typed user, the worker opens it
// and the identity provider rejects it, exactly as debug-app-user-worker.mjs main() answers its parent.
function privateSignIn({ reject = 'debug_app_auth_rejected' } = {}) {
  const records = new Map();
  const vault = async (mode, input) => {
    if (mode === 'prompt') { records.set(input.credentialRef, input); return { ok: true, credentialRef: input.credentialRef, binding: input.binding,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString() }; }
    if (mode === 'read') { const r = records.get(input.credentialRef); return { ok: true, binding: r.binding, expiresAt: input.expiresAt, kind: 'credentials', username: USER, password: PASSWORD }; }
    return { ok: true };
  };
  const login = async () => { const error = new Error('rejected'); error.code = reject; throw error; };
  const authenticate = async (op, descriptor) => {
    try { return await authenticatePrivateAppUser(descriptor, { vault, login }); }
    catch (error) { return { ok: false, error: error.message, ...(typeof error.userHint === 'string' ? { userHint: error.userHint } : {}) }; }
  };
  return (input, options) => prepareDebugAppUser(input, { ...options, vault, authenticate, expire: async () => {} });
}

test('a refused app-user sign-in answers DEBUG_APP_USER_SIGN_IN_FAILED with user, provider, environment and next', async t => {
  const dir = sandbox(t), journals = [];
  const result = await headlessDebug(odcInput, { services: { sessionRoot: path.join(dir, 'sessions'), journal: value => journals.push(value),
    getOdcDebugToken: async () => 'synthetic-developer-token', installation: async () => path.join(dir, 'studio'),
    worker: async () => path.join(dir, 'SSAM.Debugger.dll'), prepareAppUser: privateSignIn(), releaseAppUser: async () => ({ ok: true }),
    spawn: () => assert.fail('nothing starts after a refused sign-in') } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEBUG_APP_USER_SIGN_IN_FAILED');
  assert.equal(result.cause, 'debug_app_user_authentication_rejected');
  assert.equal(result.user, 'ap***r@example.com');
  assert.equal(result.provider, 'ODC built-in identity provider');
  assert.match(result.environment, /fixture-dev\.outsystems\.app/);
  assert.match(result.environment, /tenant fixture-tenant/);
  assert.match(result.next, /^Sign in at https:\/\/fixture-dev\.outsystems\.app\/Fixture\/ in a browser with that user/);
  assert.equal(result.continuation.tool, 'ssam_debug');
  assert.equal(result.continuation.arguments.module, 'Fixture');
  const text = JSON.stringify(result);
  for (const secret of [USER, PASSWORD, 'app.user', 'synthetic-developer-token']) assert.ok(!text.includes(secret), secret);
  // Nothing ran: the receipt says not-started and the target lock is gone.
  assert.equal(JSON.parse(fs.readFileSync(result.receiptPath, 'utf8')).state, 'not-started');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sessions')).filter(f => f.endsWith('.lock')), []);
});

test('an O11 start without any developer login is refused before the app-user window, with the call that has the Studio SSO', async t => {
  const dir = sandbox(t);
  const result = await headlessDebug(o11Input, { services: { sessionRoot: path.join(dir, 'sessions'), journal: () => {},
    legacyDeveloperAuth: () => false, prepareAppUser: () => assert.fail('no sign-in window opens'), worker: () => assert.fail('no build'),
    installation: () => assert.fail('no installation lookup') } });
  assert.equal(result.code, 'DEBUG_DEVELOPER_AUTH_REQUIRED');
  assert.match(result.error, /no sign-in window opened/);
  assert.deepEqual([result.continuation.tool, result.continuation.arguments.execution, result.continuation.arguments.op], ['ssam_debug_run', 'native-entry', 'prepare']);
  assert.equal(result.environment, 'fixture.outsystemscloud.com');
  assert.equal(fs.existsSync(path.join(dir, 'sessions')), false, 'no session folder or lock');
});

test('a native start failure names its cause, the next step and the receipt read instead of a bare debug_native_error', async t => {
  const dir = sandbox(t);
  const credentials = path.join(dir, 'developer-private.json');
  const result = await headlessDebug({ ...o11Input, credentials }, { services: { sessionRoot: path.join(dir, 'sessions'), journal: () => {},
    installation: async () => path.join(dir, 'studio'), worker: async () => path.join(dir, 'SSAM.Debugger.dll'),
    prepareAppUser: async (request, { sessionId }) => ({ ok: true, descriptor: { credentialRef: randomUUID(), binding: { lane: 'o11', runtimeUrl: request.runtimeUrl, app: 'Fixture', sessionId,
      module: request.module, moduleKey: request.moduleKey }, expiresAt: new Date(Date.now() + 60000).toISOString(), state: 'credentials-entered' } }),
    privateAppUserVault: async (mode, request) => ({ ok: true, binding: request.binding, expiresAt: request.expiresAt, kind: 'credentials', username: 'synthetic-app-user', password: PASSWORD }),
    releaseAppUser: async () => ({ ok: true }),
    spawn: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.destroy = () => {};
      child.stdin = new EventEmitter(); child.stdin.destroy = () => {}; child.unref = () => {};
      child.stdin.end = text => {
        const bootstrap = JSON.parse(text);
        fs.writeFileSync(bootstrap.receiptPath, JSON.stringify({ ok: false, state: 'stopped', error: 'debug_developer_credentials_required' }));
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, error: 'debug_developer_credentials_required', exceptionType: 'DebugFailure' }) + '\n')));
      };
      return child;
    } } });
  assert.equal(result.code, 'DEBUG_DEVELOPER_AUTH_REQUIRED');
  assert.equal(result.cause, 'debug_developer_credentials_required');
  assert.match(result.next, /o11Auth/);
  assert.deepEqual([result.continuation.tool, result.continuation.arguments.file], ['ssam_evidence', result.receiptPath]);
  const generic = nativeFailure({ ok: false, error: 'debug_native_error', exceptionType: 'InvalidOperationException', receiptPath: 'C:\\fixture\\receipt.json' }, o11Input);
  assert.deepEqual([generic.code, generic.environment, generic.continuation.tool], ['DEBUG_NATIVE_ERROR', 'fixture.outsystemscloud.com', 'ssam_evidence']);
  assert.deepEqual(nativeFailure({ ok: true, state: 'connected' }, o11Input), { ok: true, state: 'connected' });
});

test('an O11 run refused at the app-user sign-in answers the same structured failure and keeps its own fields', async () => {
  const raw = { op: 'run', lane: 'o11', execution: 'native-entry', host: 'fixture.outsystemscloud.com', module: 'Fixture', moduleKey, applicationKey,
    runtimeUrl: 'https://fixture.outsystemscloud.com/Fixture/', action: 'Recalculate' };
  const result = await debugRun(raw, { services: { runO11: async () => ({ ok: false, state: 'failed-or-uncertain', error: 'debug_o11_native_login_rejected',
    signInUser: maskUser('Planner'), receiptPath: 'C:\\fixture\\receipt.json' }) } });
  assert.equal(result.code, 'DEBUG_APP_USER_SIGN_IN_FAILED');
  assert.deepEqual([result.user, result.provider, result.environment, result.app], ['Pl***r', 'Users (O11 user provider of the app)', 'fixture.outsystemscloud.com', 'Fixture']);
  assert.match(result.next, /reset its password in the Users app https:\/\/fixture\.outsystemscloud\.com\/Users\//);
  assert.deepEqual([result.state, result.receiptPath, result.signInUser], ['failed-or-uncertain', 'C:\\fixture\\receipt.json', undefined]);
  assert.equal(result.continuation.tool, 'ssam_debug_run');
  // Any other failure passes unchanged.
  const other = await debugRun(raw, { services: { runO11: async () => ({ ok: false, error: 'debug_o11_native_trace_unavailable:no_frames' }) } });
  assert.deepEqual(other, { ok: false, error: 'debug_o11_native_trace_unavailable:no_frames' });
});

test('the user is named masked: enough to tell the account, never the whole name', () => {
  assert.equal(maskUser(USER), 'ap***r@example.com');
  assert.equal(maskUser('Planner'), 'Pl***r');
  assert.equal(maskUser('ab'), 'a***');
  assert.equal(maskUser(''), null);
});

test('the debugger tool descriptions carry the rule: never write diagnostics into business tables', () => {
  const tools = new Map();
  const server = { registerTool(name, config) { tools.set(name, config); } };
  registerDebugTools(server, async () => ({}), fn => fn);
  registerRunTools(server, async () => ({}), fn => fn);
  registerInvokeTools(server, async () => ({}), fn => fn);
  for (const name of ['ssam_debug', 'ssam_debug_run', 'ssam_debug_invoke']) {
    assert.ok(tools.get(name).description.startsWith(DIAGNOSTICS_RULE), name);
    assert.match(tools.get(name).description, /Never write diagnostics into business tables/);
  }
});
