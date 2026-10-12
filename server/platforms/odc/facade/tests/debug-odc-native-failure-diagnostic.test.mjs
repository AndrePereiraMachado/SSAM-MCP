import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markOdcTraceIncomplete, runOdcNativeLive } from '../debug-odc-native-live.mjs';
import { nativeInvocationDiagnostic, nativeResponseDiagnostic } from '../debug-odc-native-host.mjs';
import { appUserBinding } from '../debug-app-user.mjs';

test('trace absence preserves broker error and exception; only a successful invocation gets a primary trace error', () => {
  const failed = { ok: false, error: 'debug_odc_native_execution_failed', diagnostic: { stage: 'native-invocation' } };
  markOdcTraceIncomplete(failed);
  assert.equal(failed.error, 'debug_odc_native_execution_failed');
  assert.equal(failed.traceError, 'debug_odc_native_trace_incomplete');
  assert.equal(failed.traceVerified, false);
  assert.deepEqual(failed.diagnostic, { stage: 'native-invocation' });
  const exception = { ok: false, exception: { type: 'SecurityException', message: 'already-redacted' } };
  markOdcTraceIncomplete(exception);
  assert.equal(exception.error, undefined);
  assert.deepEqual(exception.exception, { type: 'SecurityException', message: 'already-redacted' });
  const succeeded = { ok: true, outputs: { Value: 7 } };
  markOdcTraceIncomplete(succeeded);
  assert.equal(succeeded.ok, false);
  assert.equal(succeeded.error, 'debug_odc_native_trace_incomplete');
  assert.deepEqual(succeeded.outputs, { Value: 7 });
});
test('safe invocation diagnostic contains only stage, known class and sanitized code', () => {
  const error = new TypeError('private token, customer payload, remote URL');
  error.stack = 'private stack'; error.code = 'private code';
  assert.deepEqual(nativeInvocationDiagnostic(error, 'native-invocation'), {
    stage: 'native-invocation', exceptionClass: 'TypeError', code: 'debug_odc_native_execution_failed' });
  assert.deepEqual(nativeInvocationDiagnostic({ name: 'private-class', message: 'remote body' }, 'private stage'), {
    stage: 'unknown', exceptionClass: 'unknown', code: 'debug_odc_native_execution_failed' });
  assert.equal(nativeInvocationDiagnostic(new Error('debug_odc_native_app_session_expired'), 'identity-after-invoke').code,
    'debug_odc_native_app_session_expired');
});
test('native response and constructor family survive overwritten names without exposing the exception payload', () => {
  class Exception extends Error {}
  class ServerException extends Exception {
    constructor(specificType, message, errorCode) { super(message); this.name = specificType; this.specificType = specificType; this.errorCode = errorCode; }
  }
  const privateText = 'private-type https://private.test/path?token=secret';
  const error = new ServerException(privateText, 'private message password=secret', 'OS-BEW-00000');
  error.stack = 'private stack'; error.response = { secret: 'private body' };
  assert.deepEqual(nativeInvocationDiagnostic(error, 'native-invocation', { Exception, ServerException }), {
    stage: 'native-invocation', exceptionClass: 'unknown', code: 'debug_odc_native_execution_failed',
    nativeExceptionFamily: 'ServerException', nativeErrorCode: 'OS-BEW-00000' });
  const envelope = { clientSettingsHash: 'private hash', shouldRefreshToken: false,
    versionInfo: { hasApiVersionChanged: false, hasModuleVersionChanged: false }, status: 250,
    exception: { name: 'ServerException', specificType: privateText, message: error.message, stack: error.stack, errorCode: 'OS-BEW-00000' },
    data: { secret: 'private body' } };
  const diagnostic = nativeResponseDiagnostic(envelope);
  assert.deepEqual(diagnostic, { shape: 'native-error', status: 250, exceptionFamily: 'ServerException', errorCode: 'OS-BEW-00000', hasSpecificType: true });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|https|password|secret|stack/);
  assert.equal(envelope.exception.message, error.message);
  assert.deepEqual(nativeResponseDiagnostic({ ...envelope, exception: { name: privateText, errorCode: 'OS-BEW-99999' }, status: 999 }),
    { shape: 'native-error', status: null, exceptionFamily: 'unknown', errorCode: 'unknown', hasSpecificType: false });
  assert.deepEqual(nativeResponseDiagnostic({ ...envelope, exception: undefined }), { shape: 'native-success' });
  assert.deepEqual(nativeResponseDiagnostic({ exception: envelope.exception }), { shape: 'unclassified' });
});
test('runner persists invocation failure and separate trace error while retaining normal cleanup', async t => {
  const tmpRoot = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tmpRoot, 'odc-failure-diagnostic-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(tmpRoot + path.sep)); fs.rmSync(root, { recursive: true }); });
  const key = 'A'.repeat(22), binding = { tenant: 'dev.example.test', module: 'Store', moduleKey: 'B'.repeat(22),
    runtimeUrl: 'https://dev.example.test/Store/', revision: 1 };
  const prepared = { action: { key }, entry: { key }, path: [{ key }], bindings: [], assumptions: [],
    scenarios: [{ name: 'one', inputs: {} }, { name: 'must-not-run', inputs: {} }] };
  const member = { key, chunk: 'client.js', holder: { name: 'work', local: 'work' }, type: 'CLIENT_ACTION' };
  const readers = { binding, sourceContract: { sha256: 'f'.repeat(64) }, runtime: { moduleVersion: 'v1',
    index: { functions: { [key]: [member] }, views: {}, screens: {}, groups: {} } } };
  let calls = 0;
  const result = await runOdcNativeLive({ trace: 'full' }, prepared, readers, { root,
    prepareUser: async (input, { sessionId }) => ({ ok: true, descriptor: {
      binding: appUserBinding(input, sessionId), expiresAt: new Date(Date.now() + 60000).toISOString() } }),
    releaseUser: async () => ({ ok: true }), broker: () => ({ prepare: async () => {},
      authenticate: async () => ({ authenticated: true, identityMatches: true }),
      invoke: async call => { calls++; return { name: call.name, ok: false, error: 'debug_odc_native_execution_failed',
        diagnostic: { stage: 'native-invocation', exceptionClass: 'TypeError', code: 'debug_odc_native_execution_failed' }, uncertain: false, visits: [] }; },
      dispose: async () => ({ completed: true }) }) });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, false);
  assert.equal(result.credentialsReleased, true);
  assert.equal(result.lockRetained, false);
  const saved = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
  assert.equal(saved.results[0].error, 'debug_odc_native_execution_failed');
  assert.equal(saved.results[0].traceError, 'debug_odc_native_trace_incomplete');
  assert.equal(saved.results[0].diagnostic.stage, 'native-invocation');
});

test('authentication preserves the native permission refusal without exposing exception details', async () => {
  const {checkOdcNativeScreenPermissions}=await import('../debug-odc-native-host.mjs');
  class SecurityException extends Error {constructor(){super('private user and role');this.name='SecurityException';this.errorCode='OS-CLRT-40300';}}
  let calls=0;const report={permissionCheck:false};
  class Controller {static checkPermissions(){calls++;throw new SecurityException();}}
  assert.throws(()=>checkOdcNativeScreenPermissions(new Controller(),report,{SecurityException}),/screen_permission_check_failed/);
  assert.equal(calls,1);assert.equal(report.permissionCheck,false);
  assert.equal(report.permissionDiagnostic.nativeExceptionFamily,'SecurityException');
  assert.equal(report.permissionDiagnostic.nativeErrorCode,'OS-CLRT-40300');
  assert.doesNotMatch(JSON.stringify(report),/private user|role/);
  Controller.checkPermissions=()=>{calls++;};
  checkOdcNativeScreenPermissions(new Controller(),report,{SecurityException});
  assert.equal(report.permissionCheck,true);assert.equal(calls,2);
});
