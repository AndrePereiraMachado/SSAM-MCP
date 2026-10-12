import test from 'node:test';
import { foreignPendingReason } from '../debug-foreign-pending.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appUserBinding } from '../debug-app-user.mjs';
import { authenticatePrivateAppUser } from '../debug-app-user-worker.mjs';
import { createCognitoTransport } from '../../portal/runtime/cognito-login.mjs';

test('private authentication persists bounded fixed phase evidence, preserves rejection and never records private inputs', { skip: foreignPendingReason('cognito-provider-error') }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssam-auth-diagnostic-'));
  const binding = appUserBinding({ lane: 'odc', module: 'Producer', moduleKey: 'A'.repeat(22), runtimeUrl: 'https://fixture-dev.outsystems.app/App/' }, 'a'.repeat(32));
  const descriptor = { credentialRef: '12345678-1234-1234-1234-123456789abc', binding, expiresAt: new Date(Date.now() + 60000).toISOString() };
  const record = { ok: true, kind: 'credentials', ...descriptor, username: 'private-login', password: 'private-password' };
  const calls = [];
  try {
    await assert.rejects(authenticatePrivateAppUser(descriptor, {
      diagnosticsRoot: root,
      vault: async mode => { calls.push(mode); return record; },
      login: async ({ observer }) => {
        calls.push('login');
        observer({ event: 'stage', stage: 'runtime-config', username: record.username, password: record.password, credentialRef: descriptor.credentialRef });
        observer({ event: 'http', stage: 'srp-signin', endpoint: 'cognito_srp', method: 'POST', status: 400,
          url: 'https://private-url.test/?token=private-token', body: 'private-body', identity: 'private-identity' });
        observer({ event: 'failure', stage: 'private-stage', detail: 'private-detail', code: 'private-error' });
        observer({ event: 'http', stage: 'srp-signin', endpoint: 'cognito_srp', method: 'POST', status: 999 });
        observer({ event: 'provider-error', stage: 'srp-signin', code: 'private-provider-error' });
        observer({ event: 'provider-error', stage: 'user-profile', code: 'NotAuthorizedException' });
        observer({ event: 'provider-error', stage: 'srp-signin', code: 'NotAuthorizedException', reason: 'private-reason' });
        observer({ event: 'provider-error', stage: 'srp-signin', code: 'InvalidParameterException', reason: 'invalid-credentials' });
        let requests = 0;
        const transport = createCognitoTransport({ observer, request: async () => {
          requests++;
          return { status: 400, text: JSON.stringify({ __type: 'com.amazonaws.cognitoidentityprovider#NotAuthorizedException', message: 'private-password', body: 'private-body' }) };
        } });
        await assert.rejects(new Promise((resolve, reject) => transport('RespondToAuthChallenge', {}, error => error ? reject(error) : resolve())),
          error => error.code === 'PORTAL_LOGIN_REJECTED' && !error.message.includes('private-'));
        assert.equal(requests, 1);
        const names = await readdir(join(root, binding.sessionId));
        assert.equal(names.length, 1);
        const partial = JSON.parse(await readFile(join(root, binding.sessionId, names[0]), 'utf8'));
        assert.equal(partial.completed, false); assert.equal(partial.events.length, 3);
        assert.deepEqual(partial.events[2], { event: 'provider-error', stage: 'srp-signin', code: 'NotAuthorizedException', reason: 'unknown' });
        const expected = [];
        for (const [code, message, reason] of [
          ['NotAuthorizedException', 'Incorrect username or password.', 'invalid-credentials'],
          ['NotAuthorizedException', 'Password attempts exceeded: private-login', 'too-many-failed-attempts'],
          ['NotAuthorizedException', 'User is disabled. private-login', 'unknown'],
          ['NotAuthorizedException', 'Invalid session for the user. private-token', 'unknown'],
          ['NotAuthorizedException', 'Timestamp / SecretHash private-token', 'unknown'],
          ['InvalidParameterException', 'Incorrect username or password.', 'unknown'],
          ['LimitExceededException', 'private-provider-detail', 'too-many-failed-attempts'],
        ]) {
          let attempts = 0;
          const classified = createCognitoTransport({ observer, request: async () => {
            attempts++; return { status: 400, text: JSON.stringify({ __type: code, message }) };
          } });
          await assert.rejects(new Promise((resolve, reject) => classified('RespondToAuthChallenge', {}, error => error ? reject(error) : resolve())),
            error => error.code === 'PORTAL_LOGIN_REJECTED' && !error.message.includes('private-'));
          assert.equal(attempts, 1);
          expected.push({ event: 'provider-error', stage: 'srp-signin', code, reason });
        }
        observer({ event: 'http', stage: 'runtime-config', endpoint: 'runtime_client_settings', method: 'GET', status: 200, body: 'private-body' });
        const classifiedReceipt = JSON.parse(await readFile(join(root, binding.sessionId, names[0]), 'utf8'));
        assert.deepEqual(classifiedReceipt.events.slice(3, -1), expected);
        assert.deepEqual(classifiedReceipt.events.at(-1), { event: 'http', stage: 'runtime-config', endpoint: 'runtime_client_settings', method: 'GET', status: 200 });
        for (let i = 0; i < 80; i++) observer({ event: 'stage', stage: 'srp-signin' });
        observer({ event: 'failure', stage: 'srp-signin', detail: 'stage-contract', code: 'debug_app_auth_rejected', message: 'private-exception' });
        const error = new Error('private-exception'); error.code = 'debug_app_auth_rejected'; throw error;
      },
    }), error => error.message === 'debug_app_user_authentication_rejected');
    assert.deepEqual(calls, ['read', 'login']); // No retry and no sealed authentication after rejection.
    assert.equal(record.password, ''); assert.equal(record.username, '');
    assert.deepEqual(await readdir(root), [binding.sessionId]);
    const files = await readdir(join(root, binding.sessionId)); assert.equal(files.length, 1);
    const text = await readFile(join(root, binding.sessionId, files[0]), 'utf8'), receipt = JSON.parse(text);
    assert.equal(receipt.sessionId, binding.sessionId); assert.equal(receipt.completed, true); assert.equal(receipt.truncated, true);
    assert.equal(receipt.events.length, 64); assert.equal(receipt.events[1].status, 400);
    assert.deepEqual(receipt.events.at(-1), { event: 'failure', stage: 'srp-signin', detail: 'stage-contract', code: 'debug_app_auth_rejected' });
    assert.doesNotMatch(text, /private-|credentialRef|username|password|body|identity|url|12345678/);
    assert.ok(Buffer.byteLength(text) < 12000);
    // An unavailable receipt directory must not change the authentication result.
    const blocked = join(root, 'not-a-directory'); await writeFile(blocked, 'fixture');
    const result = await authenticatePrivateAppUser(descriptor, {
      diagnosticsRoot: blocked,
      vault: async mode => mode === 'read' ? { ...record, username: 'private-login', password: 'private-password' } : { ok: true },
      login: async ({ observer }) => {
        observer({ event: 'stage', stage: 'session-complete' });
        return { binding, userKey: '11111111-2222-3333-4444-555555555555', accessToken: 'private-token', expiresAt: descriptor.expiresAt };
      },
    });
    assert.equal(result.state, 'authenticated'); assert.doesNotMatch(JSON.stringify(result), /private-|diagnostic|credentialRef/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
