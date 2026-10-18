import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cognitoLogin, createCognitoTransport } from '../runtime/cognito-login.mjs';
import { AuthenticationDetails, CognitoUser, CognitoUserPool } from 'amazon-cognito-identity-js';
import { OdcError, publicError } from '../runtime/errors.mjs';
const config = { Region: 'us-east-1', PoolKey: 'us-east-1_TestPool', AmplifyClientKey: 'publicclient123', AuthFlow: 'USER_SRP_AUTH' };
const jwt = 'test.' + Buffer.from(JSON.stringify({ sub: 'synthetic-user', iat: 1700000000, exp: 4700000000 })).toString('base64url') + '.synthetic';
const success = { AuthenticationResult: { AccessToken: jwt, IdToken: jwt, RefreshToken: 'SYNTHETIC_REFRESH',
  NewDeviceMetadata: { DeviceKey: 'us-east-1_SYNTHETIC_DEVICE', DeviceGroupKey: 'SYNTHETIC_GROUP' } } };
const passwordVerifier = { ChallengeName: 'PASSWORD_VERIFIER', Session: 'SYNTHETIC_SESSION',
  ChallengeParameters: { USER_ID_FOR_SRP: 'test-user', SRP_B: '2', SALT: '1', SECRET_BLOCK: Buffer.from('synthetic-block').toString('base64') } };

test('unmodified SDK reproduces the former generic guard at ConfirmDevice after successful SRP', { timeout: 10000 }, async () => {
  const values = new Map(), operations = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const pool = new CognitoUserPool({ UserPoolId: config.PoolKey, ClientId: config.AmplifyClientKey, Storage: storage });
  const user = new CognitoUser({ Username: 'test-user', Pool: pool, Storage: storage });
  user.client.request = (operation, params, callback) => {
    operations.push(operation);
    if (!['InitiateAuth', 'RespondToAuthChallenge'].includes(operation)) {
      callback(new OdcError('PORTAL_LOGIN_CHALLENGE_REQUIRED', 'Additional authentication/device operations require explicit support.')); return;
    }
    callback(null, structuredClone(operation === 'InitiateAuth' ? passwordVerifier : success));
  };
  await assert.rejects(new Promise((resolve, reject) => user.authenticateUser(new AuthenticationDetails({ Username: 'test-user', Password: 'SYNTHETIC_PASSWORD' }),
    { onSuccess: resolve, onFailure: reject })), error => error.code === 'PORTAL_LOGIN_CHALLENGE_REQUIRED');
  assert.deepEqual(operations, ['InitiateAuth', 'RespondToAuthChallenge', 'ConfirmDevice']);
  values.clear();
});

test('completed SRP sign-in ignores optional new-device registration without making a device mutation', { timeout: 10000 }, async () => {
  const operations = [];
  const tokens = await cognitoLogin({ config, username: 'test-user', password: 'SYNTHETIC_PASSWORD', signal: AbortSignal.timeout(9000), request: async (url, options) => {
    const operation = options.headers['X-Amz-Target'].split('.').at(-1); operations.push(operation);
    return { status: 200, text: JSON.stringify(operation === 'InitiateAuth' ? passwordVerifier : success) };
  } });
  assert.deepEqual(operations, ['InitiateAuth', 'RespondToAuthChallenge']);
  assert.equal(tokens.AccessToken, jwt); assert.equal(tokens.RefreshToken, 'SYNTHETIC_REFRESH');
  assert.equal('NewDeviceMetadata' in tokens, false);
});

test('a real MFA challenge stays rejected even if a response contains a token-shaped extra field', { timeout: 10000 }, async () => {
  const operations = [];
  await assert.rejects(cognitoLogin({ config, username: 'test-user', password: 'SYNTHETIC_PASSWORD', signal: AbortSignal.timeout(9000), request: async (url, options) => {
    const operation = options.headers['X-Amz-Target'].split('.').at(-1); operations.push(operation);
    return { status: 200, text: JSON.stringify(operation === 'InitiateAuth' ? passwordVerifier
      : { ...success, ChallengeName: 'SMS_MFA', Session: 'SYNTHETIC_SESSION', ChallengeParameters: {} }) };
  } }), error => error.code === 'PORTAL_LOGIN_CHALLENGE_REQUIRED' && error.details.reason === 'AUTH_CHALLENGE_RETURNED');
  assert.deepEqual(operations, ['InitiateAuth', 'RespondToAuthChallenge']);
});

test('operation denial, call budget and cancellation have distinct safe diagnostic reasons', async () => {
  let sent = 0;
  const request = async () => { sent++; return { status: 200, text: '{}' }; };
  const transport = createCognitoTransport({ request });
  const invoke = (operation, params = {}) => new Promise((resolve, reject) => transport(operation, params, (error, body) => error ? reject(error) : resolve(body)));
  await assert.rejects(invoke('ConfirmDevice', { AccessToken: 'PRIVATE_TOKEN' }), error => {
    assert.deepEqual(publicError(error), { code: 'PORTAL_LOGIN_OPERATION_BLOCKED', message: 'The SDK requested an operation outside the sign-in allowlist; nothing was sent.', operation: 'ConfirmDevice', reason: 'OPERATION_NOT_ALLOWED' }); return true;
  });
  await assert.rejects(invoke('PRIVATE_UNKNOWN_OPERATION', { Password: 'PRIVATE_PASSWORD' }), error => {
    assert.equal(error.details.operation, 'unsupported');
    assert.equal(JSON.stringify(publicError(error)).includes('PRIVATE_'), false); return true;
  });
  await invoke('InitiateAuth'); await invoke('RespondToAuthChallenge');
  await assert.rejects(invoke('RespondToAuthChallenge'), error => error.code === 'PORTAL_LOGIN_REQUEST_BUDGET' && error.details.reason === 'REQUEST_BUDGET_EXCEEDED');
  assert.equal(sent, 2);
  const controller = new AbortController(); controller.abort();
  const cancelled = createCognitoTransport({ request, signal: controller.signal });
  await assert.rejects(new Promise((resolve, reject) => cancelled('InitiateAuth', {}, error => error ? reject(error) : resolve())),
    error => error.code === 'PORTAL_TIMEOUT' && error.details.reason === 'AUTH_ABORTED');
  await assert.rejects(cognitoLogin({ config, username: 'u', password: 'p', request, signal: controller.signal }), error => error.code === 'PORTAL_TIMEOUT');
  assert.equal(sent, 2);
});

test('AWS SDK SRP sends a proof request, not a plaintext password, and does not retry rejection', async () => {
  const calls = [];
  await assert.rejects(cognitoLogin({ config, username: 'test-user', password: 'PRIVATE_PASSWORD', signal: AbortSignal.timeout(10000),
    request: async (url, options) => { calls.push({ url, options }); return { status: 400, text: 'do-not-expose-server-error' }; },
  }), error => error.code === 'PORTAL_LOGIN_REJECTED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cognito-idp.us-east-1.amazonaws.com/');
  assert.equal(calls[0].options.body.AuthFlow, 'USER_SRP_AUTH');
  assert.ok(calls[0].options.body.AuthParameters.SRP_A);
  assert.equal(JSON.stringify(calls).includes('PRIVATE_PASSWORD'), false);
});

test('unverified Cognito region/pool/flow is rejected without sending credentials', async () => {
  let requests = 0;
  for (const change of [{ Region: 'eu-west-1' }, { Region: 'us-east-2' }, { PoolKey: 'us-east-2_TestPool' }, { AuthFlow: 'USER_PASSWORD_AUTH' }, { PoolKey: 'https://evil.invalid' }]) {
    await assert.rejects(cognitoLogin({ config: { ...config, ...change }, username: 'u', password: 'p', request: async () => { requests++; } }),
      error => error.code === 'PORTAL_LOGIN_PROVIDER_UNSUPPORTED');
  }
  assert.equal(requests, 0);
});

test('personal region us-east-2 completes the same bounded SRP exchange only at its regional endpoint', { timeout: 10000 }, async () => {
  const calls = [];
  const tokens = await cognitoLogin({ config: { ...config, Region: 'us-east-2', PoolKey: 'us-east-2_TestPool' },
    username: 'test-user', password: 'SYNTHETIC_PASSWORD', signal: AbortSignal.timeout(9000), request: async (url, options) => {
      const operation = options.headers['X-Amz-Target'].split('.').at(-1); calls.push({ url, operation });
      return { status: 200, text: JSON.stringify(operation === 'InitiateAuth' ? passwordVerifier : success) };
    } });
  assert.deepEqual(calls, ['InitiateAuth', 'RespondToAuthChallenge'].map(operation => ({ url: 'https://cognito-idp.us-east-2.amazonaws.com/', operation })));
  assert.equal(tokens.AccessToken, jwt);
});
