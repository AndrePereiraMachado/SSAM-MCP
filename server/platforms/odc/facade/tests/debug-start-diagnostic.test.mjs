import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { debugBootstrapTimeoutMs, debugSessionDiagnostic } from '../debug-runtime.mjs';
import { odcDebuggerBudget, requireOdcInvocationBudget, runOdcNativeLive } from '../debug-odc-native-live.mjs';
import { appUserBinding } from '../debug-app-user.mjs';

test('debugger diagnostics retain safe native status/id and separate stop failure, excluding arbitrary fields', () => {
  const diagnostic = debugSessionDiagnostic({ error: 'debug_start_rejected:403:Debugger_ConsumerNoDebugPermission',
    exceptionType: 'WebException', stopError: 'debug_stop_uncertain', stopExceptionClass: 'IOException',
    message: 'PRIVATE', token: 'PRIVATE', transport: { startPhase: 'rest-start', stopPhase: 'no-session-token',
      startOutcome: 'attempted', tokenObtained: false, token: 'PRIVATE' } });
  assert.equal(diagnostic.startError, 'debug_start_rejected:403:Debugger_ConsumerNoDebugPermission');
  assert.equal(diagnostic.stopError, 'debug_stop_uncertain');
  assert.equal(diagnostic.transport.tokenObtained, false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE/);
  assert.deepEqual(debugSessionDiagnostic({ startError: null, error: 'debug_stop_uncertain', exceptionType: 'PRIVATE',
    transport: { startPhase: 'PRIVATE' } }), { startError: null, startExceptionClass: 'unknown', stopError: null, stopExceptionClass: null });
  assert.equal(debugSessionDiagnostic({ error: 'debug_x:private message' }).startError, null);
});

test('ODC startup budget preserves native100/hub10/stop8 and never extends app authority', () => {
  const now = Date.now(), expiry = seconds => new Date(now + seconds * 1000).toISOString();
  assert.equal(debugBootstrapTimeoutMs('odc'), 125000);
  assert.equal(debugBootstrapTimeoutMs('o11'), 40000);
  assert.equal(odcDebuggerBudget(expiry(240), 90, 1, now), 240);
  assert.equal(odcDebuggerBudget(expiry(600), 90, 1, now), 275);
  assert.equal(odcDebuggerBudget(expiry(800), 90, 10, now), 600);
  assert.throws(() => odcDebuggerBudget(expiry(214), 90, 1, now), /budget_insufficient/);
  assert.throws(() => requireOdcInvocationBudget(expiry(104), 90, now), /budget_insufficient/);
  assert.throws(() => requireOdcInvocationBudget('invalid', 90, now), /budget_insufficient/);
  requireOdcInvocationBudget(expiry(105), 90, now);
});

async function refusedRun(t, { stopped, expiresIn = 600000 } = {}) {
  const tmp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tmp, 'odc-start-diagnostic-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(tmp + path.sep)); fs.rmSync(root, { recursive: true }); });
  const key = 'A'.repeat(22), binding = { tenant: 'dev.example.test', module: 'Store', moduleKey: 'B'.repeat(22),
    runtimeUrl: 'https://dev.example.test/Store/', revision: 1 };
  const member = { key, chunk: 'client.js', holder: { name: 'work', local: 'work' }, type: 'CLIENT_ACTION' };
  let starts = 0, stops = 0, invoked = 0;
  const result = await runOdcNativeLive({ trace: 'full' }, { action: { key, kind: 'ServerAction' }, entry: { key },
    path: [{ key }], bindings: [], assumptions: [], scenarios: [{ name: 'never', inputs: {} }] },
  { binding, sourceContract: { sha256: 'f'.repeat(64) }, traceTarget: async () => ({ nodeKeys: ['node'] }),
    runtime: { moduleVersion: 'v1', index: { functions: { [key]: [member] }, views: {}, screens: {}, groups: {} } } },
  { root, prepareUser: async (input, { sessionId }) => ({ ok: true, descriptor: {
    binding: appUserBinding(input, sessionId), expiresAt: new Date(Date.now() + expiresIn).toISOString() } }),
    releaseUser: async () => ({ ok: true }), debug: async input => {
      if (input.op === 'start') { starts++; return { ok: false, state: stopped ? 'stopped' : 'stop-uncertain', sessionId: 'trace',
        startError: 'debug_start_rejected:403:Debugger_ConsumerNoDebugPermission', startExceptionClass: 'DebugFailure' }; }
      stops++; return { ok: false, state: stopped ? 'stopped' : 'stop-uncertain', stopError: stopped ? null : 'debug_stop_uncertain' };
    }, broker: () => ({ prepare: async () => {}, authenticate: async () => ({ authenticated: true, identityMatches: true }),
      invoke: async () => { invoked++; throw new Error('must not invoke'); }, dispose: async () => ({ completed: true }) }) });
  return { result, starts, stops, invoked };
}

test('failed startup plus failed cleanup preserves native cause and retains uncertainty without invoking', async t => {
  const { result, starts, stops, invoked } = await refusedRun(t);
  assert.equal(result.error, 'debug_start_rejected:403:Debugger_ConsumerNoDebugPermission');
  assert.equal(result.serverTrace.stop.stopError, 'debug_stop_uncertain');
  assert.equal(result.uncertain, true); assert.equal(result.lockRetained, true);
  assert.equal(result.credentialsReleased, true); assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(invoked, 0);
});

test('confirmed stop after rejected start and insufficient startup lease are definite no-action refusals', async t => {
  const clean = await refusedRun(t, { stopped: true });
  assert.equal(clean.result.error, 'debug_start_rejected:403:Debugger_ConsumerNoDebugPermission');
  assert.equal(clean.result.serverTrace.stopped, true); assert.equal(clean.result.uncertain, false);
  assert.equal(clean.result.lockRetained, false); assert.equal(clean.invoked, 0);
  const expired = await refusedRun(t, { expiresIn: 10000 });
  assert.equal(expired.result.error, 'debug_odc_native_debugger_budget_insufficient');
  assert.equal(expired.starts, 0); assert.equal(expired.stops, 0); assert.equal(expired.invoked, 0);
  assert.equal(expired.result.uncertain, false); assert.equal(expired.result.credentialsReleased, true);
});
