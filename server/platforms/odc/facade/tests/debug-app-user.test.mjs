import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appUserBinding, sameAppUserTarget, prepareDebugAppUser, appUserSummary, privateAppUserVault } from '../debug-app-user.mjs';
import { authenticatePrivateAppUser, invokePrivateWrapper, publicWrapperBody } from '../debug-app-user-worker.mjs';
import { APP_USER_HEADERS, APP_USER_FIELDS } from '../debug-wrapper.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const input = { lane: 'odc', module: 'Producer', moduleKey: 'A'.repeat(22), runtimeUrl: 'https://fixture-dev.outsystems.app/App/', seconds: 120 };
const binding = appUserBinding(input, 'a'.repeat(32));
const userKey = '11111111-2222-3333-4444-555555555555';
const descriptor = { credentialRef: '12345678-1234-1234-1234-123456789abc', binding, expiresAt: new Date(Date.now() + 300000).toISOString() };
const privateRecord = () => ({ ok: true, kind: 'credentials', ...descriptor, username: 'fixture-user', password: 'fixture-private-password' });
const session = () => ({ binding, userKey, roles: ['real-claim'], accessToken: 'fixture-private-access-token', idToken: 'fixture-private-id-token', refreshToken: 'fixture-private-refresh-token', expiresAt: descriptor.expiresAt });

test('binding separates app entry from producer and refuses unsafe URLs or another session', () => {
  assert.equal(binding.app, 'App'); assert.equal(binding.module, 'Producer');
  assert.equal(appUserBinding({ ...input, runtimeUrl: input.runtimeUrl.slice(0, -1) }, binding.sessionId).runtimeUrl, input.runtimeUrl);
  for (const bad of ['http://fixture.dev/App/', 'https://user:password@fixture.dev/App/', 'https://fixture.dev/App/?token=x', 'https://fixture.dev/App/Screen', 'https://fixture.dev/']) assert.throws(() => appUserBinding({ ...input, runtimeUrl: bad }, binding.sessionId));
  for (const changed of [{ lane: 'o11' }, { module: 'Other' }, { app: 'Other' }, { moduleKey: 'B'.repeat(22) }, { sessionId: 'b'.repeat(32) }]) assert.equal(sameAppUserTarget(binding, { ...binding, ...changed }), false);
});

test('new ODC session prompts once, authenticates privately and exposes only safe metadata', async () => {
  const calls = [];
  const result = await prepareDebugAppUser(input, { sessionId: binding.sessionId,
    vault: async (mode, request) => { calls.push([mode, request]); return { ok: true, ...descriptor, credentialRef: request.credentialRef }; },
    authenticate: async (op, request) => { calls.push([op, request]); return { ok: true, state: 'authenticated', binding, userKey, password: 'must-not-escape', accessToken: 'must-not-escape' }; },
    expire: value => calls.push(['expiry', value]),
  });
  assert.deepEqual(calls.map(([op]) => op), ['prompt', 'expiry', 'authenticate']);
  assert.equal(calls[0][1].binding.sessionId, binding.sessionId);
  assert.equal(result.descriptor.authenticated, true);
  assert.doesNotMatch(JSON.stringify(result), /must-not-escape|password|accessToken|username/);
  assert.deepEqual(appUserSummary(result.descriptor), { state: 'authenticated', authenticated: true, expiresAt: descriptor.expiresAt, userKey });
});

test('Cancel performs no authentication, expiry scheduling or credential use', async () => {
  const calls = [];
  const result = await prepareDebugAppUser(input, { sessionId: binding.sessionId,
    vault: async mode => { calls.push(mode); return mode === 'prompt' ? { ok: false, cancelled: true } : { ok: true }; },
    authenticate: async () => assert.fail('must not authenticate'), expire: () => assert.fail('must not schedule'),
  });
  assert.equal(result.state, 'cancelled'); assert.equal(result.ok, false);
  assert.deepEqual(calls, ['prompt', 'forget']);
});

test('failed authentication cleans up and never exposes a private exception', async () => {
  const calls = [];
  await assert.rejects(prepareDebugAppUser(input, { sessionId: binding.sessionId,
    vault: async (mode, request) => { calls.push(mode); return { ok: true, ...descriptor, credentialRef: request.credentialRef }; },
    authenticate: async () => { throw new Error('fixture-private-password'); }, expire: () => {},
  }), error => error.message === 'debug_app_user_authentication_failed');
  assert.deepEqual(calls, ['prompt', 'forget']);
});

test('a mismatched authenticated target is refused and its private credentials are erased', async () => {
  const calls = [];
  await assert.rejects(prepareDebugAppUser(input, { sessionId: binding.sessionId,
    vault: async (mode, request) => { calls.push(mode); return { ok: true, ...descriptor, credentialRef: request.credentialRef }; },
    authenticate: async () => ({ ok: true, state: 'authenticated', binding: { ...binding, module: 'Other' }, userKey }), expire: () => {},
  }), /scope_mismatch/);
  assert.deepEqual(calls, ['prompt', 'forget']);
});

test('O11 credential entry is represented separately from successful app authentication', async () => {
  const o11 = { ...input, lane: 'o11' }, target = appUserBinding(o11, binding.sessionId);
  const result = await prepareDebugAppUser(o11, { sessionId: target.sessionId,
    vault: async (mode, request) => ({ ok: true, ...descriptor, credentialRef: request.credentialRef, binding: target }),
    authenticate: async () => ({ ok: true, state: 'credentials-entered', binding: target }), expire: () => {},
  });
  assert.equal(result.descriptor.authenticated, false);
  assert.equal(result.descriptor.state, 'credentials-entered');
});

test('an interrupted prompt is cleaned using its preallocated reference even without a response', async () => {
  const calls = [];
  await assert.rejects(prepareDebugAppUser(input, { sessionId: binding.sessionId,
    vault: async (mode, request) => {
      calls.push([mode, request]);
      if (mode === 'prompt') throw new Error('dialog process ended');
      return { ok: true };
    }, authenticate: async () => assert.fail(), expire: () => assert.fail(),
  }), /authentication_failed/);
  assert.deepEqual(calls.map(([mode]) => mode), ['prompt', 'forget']);
  assert.match(calls[0][1].credentialRef, /^[a-f0-9-]{36}$/);
  assert.equal(calls[0][1].credentialRef, calls[1][1].credentialRef);
  assert.deepEqual(calls[0][1].binding, calls[1][1].binding);
});

test('the authenticated token can shorten but never extend the private credential lifetime', async () => {
  const shorter = new Date(Date.now() + 30000).toISOString();
  for (const tokenExpiry of [shorter, new Date(Date.now() + 900000).toISOString()]) {
    const result = await prepareDebugAppUser(input, { sessionId: binding.sessionId,
      vault: async (mode, request) => ({ ok: true, ...descriptor, credentialRef: request.credentialRef }),
      authenticate: async () => ({ ok: true, state: 'authenticated', binding, userKey, expiresAt: tokenExpiry }), expire: () => {},
    });
    assert.equal(result.descriptor.expiresAt, tokenExpiry === shorter ? shorter : descriptor.expiresAt);
  }
});

test('failed expiry scheduling prevents authentication and erases the submitted credentials', async () => {
  const calls = [];
  await assert.rejects(prepareDebugAppUser(input, { sessionId: binding.sessionId,
    vault: async (mode, request) => { calls.push(mode); return { ok: true, ...descriptor, credentialRef: request.credentialRef }; },
    authenticate: async () => assert.fail('must not authenticate'),
    expire: async () => { calls.push('expiry'); throw new Error('debug_app_user_expiry_unavailable'); },
  }), /expiry_unavailable/);
  assert.deepEqual(calls, ['prompt', 'expiry', 'forget']);
});

test('public status never represents an expired app sign-in as authenticated', () => {
  assert.deepEqual(appUserSummary({ ...descriptor, state: 'authenticated', authenticated: true, userKey, expiresAt: '2000-01-01T00:00:00Z' }), {
    state: 'expired', authenticated: false, userKey, expiresAt: '2000-01-01T00:00:00Z',
  });
});

test('private ODC login replaces the password with protected tokens and returns no credentials', async () => {
  const calls = [], record = privateRecord();
  const result = await authenticatePrivateAppUser(descriptor, {
    vault: async (mode, request) => { calls.push([mode, request]); return mode === 'read' ? record : { ok: true }; },
    login: async request => { assert.equal(request.credentials.password, 'fixture-private-password'); return session(); },
  });
  assert.deepEqual(calls.map(([mode]) => mode), ['read', 'seal-session']);
  assert.equal(calls[1][1].session.accessToken, 'fixture-private-access-token');
  assert.equal(record.password, ''); assert.equal(record.username, '');
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|password|accessToken|refreshToken/);
  assert.equal(result.userKey, userKey);
});

test('a refused password never seals a session or supplies app context', async () => {
  const record = privateRecord(), calls = [];
  await assert.rejects(authenticatePrivateAppUser(descriptor, {
    vault: async mode => { calls.push(mode); return record; },
    login: async () => { const error = new Error('private provider details'); error.code = 'debug_app_auth_rejected'; throw error; },
  }), error => error.message === 'debug_app_user_authentication_rejected');
  assert.deepEqual(calls, ['read']); assert.equal(record.password, '');
});

test('wrapper transport uses the bound runtime, carries native auth privately and redacts echoed secrets', async () => {
  let count = 0;
  const result = await invokePrivateWrapper({ descriptor, module: 'Producer', action: 'Target', token: 'f'.repeat(48), body: { Input: 1 }, timeoutSeconds: 5 }, {
    vault: async () => ({ ok: true, kind: 'session', ...descriptor, session: session() }),
    fetchImpl: async (url, request) => {
      count++; assert.equal(url, 'https://fixture-dev.outsystems.app/Producer/rest/SSAMDebug/Target');
      assert.equal(request.headers.Authorization, 'Bearer fixture-private-access-token');
      assert.equal(request.headers[APP_USER_HEADERS.expectedUserId], userKey); assert.equal(request.redirect, 'error');
      assert.doesNotMatch(request.body, /access-token|password/);
      return new Response(JSON.stringify({ Output: 7, Details: 'echo fixture-private-access-token', Password: 'x' }), { status: 200 });
    },
  });
  assert.equal(count, 1); assert.equal(result.body.Output, 7);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-access-token/); assert.equal(result.body.Password, '[private]');
});

test('expired or cross-producer credentials cannot send a wrapper request', async () => {
  for (const bad of [{ ...descriptor, expiresAt: '2000-01-01T00:00:00Z' }, descriptor]) {
    await assert.rejects(invokePrivateWrapper({ descriptor: bad, module: bad === descriptor ? 'Other' : 'Producer', action: 'Target', token: 'f'.repeat(48), body: {}, timeoutSeconds: 5 }, {
      vault: async () => assert.fail('must not open'), fetchImpl: async () => assert.fail('must not send'),
    }));
  }
});

test('lost invocation response remains uncertain and is never sent a second time', async () => {
  let count = 0;
  const result = await invokePrivateWrapper({ descriptor, module: 'Producer', action: 'Target', token: 'f'.repeat(48), body: {}, timeoutSeconds: 5 }, {
    vault: async () => ({ ok: true, kind: 'session', ...descriptor, session: session() }),
    fetchImpl: async () => { count++; throw new Error('private network details'); },
  });
  assert.equal(count, 1); assert.equal(result.state, 'uncertain'); assert.equal(result.status, null);
});

test('O11 sends Unicode app credentials only in its private UTF-8 request body', async () => {
  const target = appUserBinding({ ...input, lane: 'o11' }, binding.sessionId), o11 = { ...descriptor, binding: target };
  const record = { ...privateRecord(), ...o11, username: 'tést@example.test', password: 'senha-🔒-漢字' };
  const result = await invokePrivateWrapper({ descriptor: o11, module: 'Producer', action: 'Target', token: 'f'.repeat(48), body: { Input: 1 }, timeoutSeconds: 5 }, {
    vault: async () => record,
    fetchImpl: async (_url, request) => {
      const sent = JSON.parse(request.body);
      assert.equal(sent[APP_USER_FIELDS.username], record.username);
      assert.equal(sent[APP_USER_FIELDS.password], record.password);
      assert.equal(sent.Input, 1);
      assert.doesNotMatch(JSON.stringify(request.headers), /tést|senha|漢字/);
      return new Response(JSON.stringify({ Result: record.password, [record.username]: 'private-key' }), { status: 200 });
    },
  });
  assert.equal(result.body.Result, '[private]');
  assert.equal(record.username, ''); assert.equal(record.password, '');
  assert.doesNotMatch(JSON.stringify(result), /tést|senha|漢字|private-key/);
});

test('a 200 response with an invalid wrapper body is not reported as a completed call', async () => {
  for (const body of ['<html>Sign In</html>', '[]', 'null']) {
    const result = await invokePrivateWrapper({ descriptor, module: 'Producer', action: 'Target', token: 'f'.repeat(48), body: {}, timeoutSeconds: 5 }, {
      vault: async () => ({ ok: true, kind: 'session', ...descriptor, session: session() }),
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
    assert.equal(result.ok, false); assert.equal(result.status, 200); assert.equal(result.state, 'invalid-response');
  }
});

for (const mode of ['seal-session', 'prompt']) test(`private ${mode} helper keeps input on stdin and hides only the console`, async () => {
  const sentinel = 'fixture-private-stdin-only'; let argv, options, sent;
  const result = await privateAppUserVault(mode, { ...descriptor, session: { accessToken: sentinel } }, {
    spawnImpl: (_command, args, opts) => {
      argv = args; options = opts;
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
      const chunks = []; child.stdin.on('data', bytes => chunks.push(bytes)); child.stdin.on('finish', () => {
        sent = Buffer.concat(chunks).toString(); child.stdout.end('{"ok":true}'); setImmediate(() => child.emit('close', 0));
      });
      return child;
    },
  });
  assert.equal(result.ok, true); assert.equal(options.windowsHide, mode !== 'prompt'); assert.ok(argv.includes('-STA'));
  if (mode === 'prompt') assert.equal(argv[argv.indexOf('-WindowStyle') + 1], 'Hidden');
  assert.ok(sent.includes(sentinel)); assert.ok(!argv.join(' ').includes(sentinel));
  // CreateProcess permits at most 32767 UTF-16 code units. Embedding the actual helper exceeded it.
  assert.ok(argv.reduce((size, arg) => size + arg.length + 3, 64) < 32767, 'private helper must fit Windows process argv limit');
});

test('redaction covers secret field names and arbitrary nested exception strings', () => {
  assert.deepEqual(publicWrapperBody({ errors: [{ message: 'p@ss was echoed', cookie: 'x' }], ok: false }, ['p@ss']), {
    errors: [{ message: '[private] was echoed', cookie: '[private]' }], ok: false,
  });
});

test('actual prompt timer expiry has a distinct safe error and cleans the exact preallocated reference', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = []; let killed = 0;
  const result = prepareDebugAppUser(input, { sessionId: binding.sessionId,
    vault: async (mode, request) => {
      calls.push([mode, request]);
      if (mode === 'forget') return { ok: true };
      return privateAppUserVault(mode, request, { spawnImpl: (command, args) => {
        assert.equal(command, 'powershell.exe'); assert.equal(args.at(-1), 'prompt');
        const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
        child.kill = () => { killed++; child.emit('close', null); };
        return child;
      } });
    }, authenticate: () => assert.fail('timeout must not authenticate'), expire: () => assert.fail('timeout must not arm an authenticated lease'),
  });
  const rejected = assert.rejects(result, /^Error: debug_app_user_prompt_timeout$/);
  t.mock.timers.tick(299999); assert.equal(killed, 0);
  t.mock.timers.tick(1); await rejected;
  assert.equal(killed, 1); assert.deepEqual(calls.map(([mode]) => mode), ['prompt', 'forget']);
  assert.equal(calls[0][1].credentialRef, calls[1][1].credentialRef);
  assert.deepEqual(calls[0][1].binding, calls[1][1].binding);
});

test('other helper failures retain the generic error rather than reporting a prompt timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const scenario of ['non-prompt-timeout', 'oversize', 'invalid-json', 'process-error']) {
    let child, killed = 0;
    const pending = privateAppUserVault(scenario === 'non-prompt-timeout' ? 'read' : 'prompt', descriptor, { spawnImpl: () => {
      child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => { killed++; child.emit('close', null); };
      return child;
    } });
    const rejected = assert.rejects(pending, /^Error: debug_app_user_credentials_unavailable$/);
    if (scenario === 'non-prompt-timeout') { t.mock.timers.tick(15000); assert.equal(killed, 1); }
    else if (scenario === 'oversize') { child.stdout.write('x'.repeat(1048577)); assert.equal(killed, 1); }
    else if (scenario === 'invalid-json') { child.stdout.end('{'); child.emit('close', 0); }
    else child.emit('error', new Error('synthetic private process detail'));
    await rejected;
  }
});
