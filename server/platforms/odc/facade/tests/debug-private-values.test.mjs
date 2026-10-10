import test from 'node:test';
import assert from 'node:assert/strict';
import { privateAppUserValues } from '../debug-runtime.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
import { debugSchema } from '../debug.mjs';

const id = 'c'.repeat(32), credentialRef = '12345678-1234-4234-8234-123456789abc';
const target = lane => appUserBinding({ lane, module: 'Fixture', moduleKey: 'A'.repeat(22), runtimeUrl: 'https://fixture.outsystemscloud.com/Fixture/' }, id);
const expiresAt = new Date(Date.now() + 600000).toISOString();
const descriptor = lane => ({ credentialRef, binding: target(lane), expiresAt, state: lane === 'odc' ? 'authenticated' : 'credentials-entered',
  ...(lane === 'odc' ? { authenticated: true, userKey: '22345678-1234-4234-8234-123456789abc' } : {}) });
const credentials = () => ({ ok: true, kind: 'credentials', binding: target('o11'), expiresAt,
  username: 'app-user@fixture.invalid', password: 'cópia-ç-"-🔒' });
const session = () => ({ ok: true, kind: 'session', binding: target('odc'), expiresAt,
  session: { binding: target('odc'), expiresAt, userKey: descriptor('odc').userKey, accessToken: 'opaque-access-value',
    idToken: 'a.' + Buffer.from(JSON.stringify({ email: 'fixture-mail@example.invalid', preferred_username: 'fixture-app-user' })).toString('base64url') + '.c',
    refreshToken: 'opaque-refresh-value' } });

test('bound O11 username/password travel privately and opened record references are released', async () => {
  const record = credentials(); let request;
  const values = await privateAppUserValues(descriptor('o11'), target('o11'), { vault: async (mode, input) => { assert.equal(mode, 'read'); request = input; return record; } });
  assert.deepEqual(values, ['app-user@fixture.invalid', 'cópia-ç-"-🔒']);
  assert.equal(record.username, ''); assert.equal(record.password, '');
  assert.deepEqual(Object.keys(request).sort(), ['binding', 'credentialRef', 'expiresAt']);
  assert.doesNotMatch(JSON.stringify(request), /app-user@fixture|cópia/);
});

test('ODC uses only the bound existing token session and identity strings; never restores discarded password', async () => {
  const record = session(); record.password = 'discarded-password-must-stay-discarded';
  const tokens = [record.session.accessToken, record.session.idToken, record.session.refreshToken];
  const values = await privateAppUserValues(descriptor('odc'), target('odc'), { vault: async () => record });
  assert.deepEqual(values, [...tokens, 'fixture-mail@example.invalid', 'fixture-app-user']);
  assert.equal(values.includes('discarded-password-must-stay-discarded'), false);
  for (const key of ['accessToken', 'idToken', 'refreshToken']) assert.equal(record.session[key], '');
  assert.equal(record.password, '');
});

test('invalid/expired descriptor is refused before any private read, on every binding dimension', async () => {
  for (const patch of [ { credentialRef: 'invalid' }, { expiresAt: 'invalid' }, { expiresAt: new Date(0).toISOString() },
    ...['lane', 'runtimeUrl', 'app', 'sessionId', 'module', 'moduleKey'].map(key => ({ binding: { ...target('o11'), [key]: 'other' } })) ]) {
    let reads = 0;
    await assert.rejects(privateAppUserValues({ ...descriptor('o11'), ...patch }, target('o11'), { vault: async () => { reads++; return credentials(); } }),
      /^Error: debug_app_user_scope_mismatch$/);
    assert.equal(reads, 0);
  }
});

test('private record mismatch/expiry/failure fails closed with constant error and clears its secrets', async () => {
  for (const patch of [ { ok: false }, { kind: 'session' }, { username: '' }, { password: '' }, { expiresAt: new Date(0).toISOString() },
    ...['lane', 'runtimeUrl', 'app', 'sessionId', 'module', 'moduleKey'].map(key => ({ binding: { ...target('o11'), [key]: 'other' } })) ]) {
    const record = { ...credentials(), ...patch };
    await assert.rejects(privateAppUserValues(descriptor('o11'), target('o11'), { vault: async () => record }), /^Error: debug_app_user_credentials_unavailable$/);
    assert.equal(record.password, ''); assert.equal(record.username, '');
  }
  await assert.rejects(privateAppUserValues(descriptor('o11'), target('o11'), { vault: async () => { throw new Error('UNTRUSTED password body headers'); } }),
    /^Error: debug_app_user_credentials_unavailable$/);
});

test('ODC token/session identity and expiry must agree with the exact authenticated descriptor', async () => {
  for (const patch of [ { binding: target('o11') }, { expiresAt: new Date(0).toISOString() }, { accessToken: '' }, { accessToken: 'token\n' },
    { idToken: 'x'.repeat(65537) }, { refreshToken: 123 },
    { userKey: '32345678-1234-4234-8234-123456789abc' } ]) {
    const record = session(); Object.assign(record.session, patch);
    await assert.rejects(privateAppUserValues(descriptor('odc'), target('odc'), { vault: async () => record }), /^Error: debug_app_user_credentials_unavailable$/);
    assert.equal(record.session.accessToken, '');
  }
  const record = session();
  await assert.rejects(privateAppUserValues({ ...descriptor('odc'), authenticated: false }, target('odc'), { vault: async () => record }),
    /^Error: debug_app_user_credentials_unavailable$/);
});

test('public debug schema refuses private session values and app credentials', () => {
  const input = { op: 'start', lane: 'o11', module: 'Fixture', moduleKey: 'A'.repeat(22), runtimeUrl: target('o11').runtimeUrl, nodeKeys: ['B'.repeat(22)] };
  for (const patch of [{ privateValues: ['do-not-echo'] }, { username: 'do-not-echo' }, { password: 'do-not-echo' }, { soapSecret: 'do-not-echo' }])
    assert.equal(debugSchema.safeParse({ ...input, ...patch }).success, false);
});
