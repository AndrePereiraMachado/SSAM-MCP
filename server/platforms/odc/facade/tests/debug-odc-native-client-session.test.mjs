import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { beginOdcNativeClientInvocation } from '../debug-odc-native-host.mjs';

const native = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-odc-native-debugger-session.json', import.meta.url), 'utf8'));

test('native session selects the guarded debugger transport without trace and restores it on success or failure', async () => {
  // These two method bodies are verbatim from the published SDK. Only the DI
  // container and clients are synthetic; there is no application or network call.
  for (const trace of ['none', 'full']) for (const rejected of [false, true]) {
    const O = { HttpClient: Symbol(), DebuggerHttpClient: Symbol(), NonDebuggerHttpClient: Symbol() };
    const payload = { viewName: 'Synthetic.OriginalScreen', privateContext: { identity: Symbol('same-user') } };
    let selectedCalls = 0, observed = 0, nativeBreakpoints = 0;
    const normalClient = { post() { throw new Error('debug_odc_native_metadata_request_refused'); } };
    const guardedClient = { post(input) { selectedCalls++; assert.equal(input, payload);
      if (rejected) throw new Error('synthetic-native-failure'); return { accepted: true }; } };
    const registry = new Map([[O.HttpClient, normalClient], [O.NonDebuggerHttpClient, normalClient], [O.DebuggerHttpClient, guardedClient]]);
    const M = { resolve: key => registry.get(key) }, x = (key, factory) => registry.set(key, factory());
    const dbg = vm.runInNewContext('({' + native.startSession.text + ',' + native.endSession.text + '})',
      { M, O, x, w: { Prepared: 2 }, l: () => { throw new Error('unexpected native lifecycle warning'); } });
    dbg.isInSession = false;
    const originalBreakpoint = dbg.handleBreakpoint = () => { nativeBreakpoints++; };
    assert.throws(() => M.resolve(O.HttpClient).post(payload), /metadata_request_refused/);
    const end = beginOdcNativeClientInvocation(dbg, trace, { handleBreakpoint: () => { observed++; } });
    assert.equal(dbg.isInSession, true);
    assert.equal(M.resolve(O.HttpClient), guardedClient);
    try {
      dbg.handleBreakpoint('synthetic-key', 'synthetic-context');
      if (rejected) assert.throws(() => M.resolve(O.HttpClient).post(payload), /synthetic-native-failure/);
      else assert.deepEqual(M.resolve(O.HttpClient).post(payload), { accepted: true });
    } finally { end(); }
    assert.equal(selectedCalls, 1);
    assert.equal(nativeBreakpoints, 1);
    assert.equal(observed, trace === 'none' ? 0 : 1);
    assert.equal(dbg.handleBreakpoint, originalBreakpoint);
    assert.equal(dbg.isInSession, false);
    assert.equal(M.resolve(O.HttpClient), normalClient);
    assert.throws(() => M.resolve(O.HttpClient).post(payload), /metadata_request_refused/);
  }
  assert.throws(() => beginOdcNativeClientInvocation({}, 'none'), /client_debugger_session_unavailable/);
});
