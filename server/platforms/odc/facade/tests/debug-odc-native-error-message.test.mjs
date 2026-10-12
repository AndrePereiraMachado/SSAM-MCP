import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeNativeErrorMessage, nativeDotNetExceptionCategory } from '../debug-odc-native-error-message.mjs';
import { nativeInvocationDiagnostic, nativeResponseDiagnostic } from '../debug-odc-native-host.mjs';

test('native error text preserves technical detail while removing credentials before the bounded output', () => {
  const userKey = '12345678-1234-1234-1234-123456789abc';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljU2lnbmF0dXJl';
  const privateValues = ['known-Pass wörd+$', 'native-refresh-token-value'];
  // Each short sample must redact before any clipping; the long combined
  // example below cannot accidentally hide a faulty rule beyond character600.
  const cases = [
    ['known-Pass wörd+$', 'known-Pass wörd+$'],
    [encodeURIComponent(privateValues[0]), encodeURIComponent(privateValues[0])],
    ['Bearer opaque-access-token', 'opaque-access-token'],
    [jwt, jwt],
    ['Password: "unknown secret with spaces"', 'unknown secret with spaces'],
    ['clientSecret=another-secret;', 'another-secret'],
    ['refresh_token="refresh-value"', 'refresh-value'],
    ['api_key=opaque-api-key', 'opaque-api-key'],
    ['cookie=sid-secret;', 'sid-secret'],
    ['Authorization: Basic YWxwaGE6YmV0YQ==', 'YWxwaGE6YmV0YQ=='],
    ['Set-Cookie: sid=opaque-session; Secure; HttpOnly', 'opaque-session'],
    ['https://urluser:urlpassword@dev.example.test/Quotes/Action', 'urlpassword'],
    ['https://dev.example.test/Quotes/Action?payload=query-secret', 'query-secret'],
    ['https://dev.example.test/Quotes/Action#fragment-secret', 'fragment-secret'],
    ['User person@example.test', 'person@example.test'],
    ['User ' + userKey, userKey],
  ];
  for (const [text, secret] of cases) {
    const sample = sanitizeNativeErrorMessage('Technical failure: ' + text, { privateValues, userKey });
    assert.equal(sample.truncated, false);
    assert.equal(sample.message.includes(secret), false, secret);
    assert.match(sample.message, /^Technical failure:/);
  }
  const result = sanitizeNativeErrorMessage([
    'System.InvalidOperationException: Cannot invoke Quotes/ActionSSAMDbgReadUserContext: service unavailable.',
    'Endpoint https://dev.example.test/Quotes/screenservices/ActionSSAMDbgReadUserContext?token=opaque-secret&user=' + userKey,
    'Bearer opaque-access-token', jwt, 'refresh_token="native-refresh-token-value"',
    'Password: "unknown secret with spaces"; clientSecret=another-secret; cookie=sid-secret;',
    'Authorization: Basic YWxwaGE6YmV0YQ==',
    'Set-Cookie: sid=opaque-session; Secure; HttpOnly',
    'User person@example.test ' + userKey,
    'Known known-Pass wörd+$ and encoded ' + encodeURIComponent(privateValues[0]),
  ].join('\n'), { privateValues, userKey, specificType: 'System.InvalidOperationException' });
  assert.equal(result.exceptionCategory, 'System.InvalidOperationException');
  assert.match(result.message, /Cannot invoke Quotes\/ActionSSAMDbgReadUserContext: service unavailable/);
  assert.match(result.message, /https:\/\/dev\.example\.test\/Quotes\/screenservices\/ActionSSAMDbgReadUserContext\?\[private\]/);
  for (const secret of [...privateValues, encodeURIComponent(privateValues[0]), userKey, jwt, 'opaque-secret',
    'opaque-access-token', 'unknown secret with spaces', 'another-secret', 'sid-secret', 'YWxwaGE6YmV0YQ==', 'opaque-session', 'person@example.test']) {
    assert.equal(result.message.includes(secret), false, secret);
  }
  const boundarySecret = 'complete-secret-crossing-output-boundary';
  const bounded = sanitizeNativeErrorMessage('x'.repeat(590) + boundarySecret + 'z'.repeat(40), { privateValues: [boundarySecret] });
  assert.equal(bounded.truncated, true);
  assert.equal(Array.from(bounded.message).length, 600);
  assert.equal(bounded.message.includes('complete-'), false);
  assert.match(bounded.message, /\[private\]/);
  assert.equal(sanitizeNativeErrorMessage('safe technical detail').truncated, false);
  assert.equal(nativeDotNetExceptionCategory('Tenant.PrivateException: password=secret'), 'unknown');
  assert.equal(nativeDotNetExceptionCategory('System.InvalidOperationException, PrivateAssembly'), 'unknown');
  assert.equal(sanitizeNativeErrorMessage('https://user:password@dev.example.test/Quotes/Action?private=data').message,
    'https://[private]@dev.example.test/Quotes/Action?[private]');
  class Exception extends Error {}
  class ServerException extends Exception {
    constructor() { super('Cannot invoke Quotes/Action: password="native secret"; User ' + userKey); this.name = 'System.InvalidOperationException'; this.specificType = this.name; }
  }
  const native = new ServerException(), privateContext = { privateValues, userKey };
  const fromError = nativeInvocationDiagnostic(native, 'native-invocation', { Exception, ServerException }, privateContext);
  assert.equal(fromError.nativeExceptionFamily, 'ServerException');
  assert.equal(fromError.safeErrorText.exceptionCategory, 'System.InvalidOperationException');
  assert.match(fromError.safeErrorText.message, /Cannot invoke Quotes\/Action/);
  assert.doesNotMatch(fromError.safeErrorText.message, /native secret|12345678/);
  const envelope = { clientSettingsHash: 'opaque', shouldRefreshToken: false, status: 250,
    versionInfo: { hasApiVersionChanged: false, hasModuleVersionChanged: false },
    exception: { name: 'ServerException', specificType: native.specificType, message: native.message } };
  assert.deepEqual(nativeResponseDiagnostic(envelope, privateContext).safeErrorText, fromError.safeErrorText);
  assert.equal(nativeResponseDiagnostic({ ...envelope, exception: { ...envelope.exception, name: 'PrivateCustomException' } }, privateContext).safeErrorText, undefined);
  assert.equal(nativeInvocationDiagnostic(new Error('native secret'), 'native-invocation', undefined, privateContext).safeErrorText, undefined);
});
