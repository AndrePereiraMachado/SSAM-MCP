// Port D7 (24th release review, blocker 2): run.roleCycle of ssam_debug_server/ssam_debug_client gets its default ODC
// access from sc-portal-access.mjs, which the SC/Portal lane has not delivered to this build. While it is pending, a
// roleCycle start is refused with the registry's typed code before the session exists (no receipt, no runner, no
// sign-in, no role read or write) instead of answering ok:true and failing later on a raw module import; the three
// debug tool descriptions say roleCycle is unavailable. An injected roleCycleAccess (tests, other hosts) needs no file.
// Offline; fakes only. The refusal tests run only while the file is pending; when it lands they skip by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createServerSessionManager, serverSessionSchema, serverSessionDescription } from '../debug-server-session.mjs';
import { createClientSessionManager, clientSessionSchema, registerClientSessionTool } from '../debug-client-session.mjs';
import { debugRunToolSchema, registerRunTools } from '../debug-run.mjs';
import { inspectionHandler, runInspectionCli } from '../debug-inspection-cli.mjs';
import { foreignPendingReason, roleCyclePending } from '../debug-foreign-pending.mjs';
import { workspaceRoot } from '../workspace.mjs';

const pending = foreignPendingReason('sc-portal-access');
const skip = pending ? false : 'sc-portal-access delivered: debug-wave1-integration and debug-odc-role-cycle cover the role cycle';
const CODE = 'debug_adapter_dependency_pending:sc-portal-access';
const REFUSAL = /^debug_[a-z0-9_:.@-]+$/i; // the public-code rule of both sessions, the inspection CLI and the MCP reply

const moduleKey = 'A'.repeat(22), functionKey = 'B'.repeat(22), nodeKey = 'C'.repeat(22);
const roleKey = '0f8fad5b-d9cb-469f-a165-70867728950e';
const roleCycle = { roleKey, words: 'Grant the Tester role for one debug run' };
const odcRun = { op: 'run', lane: 'odc', tenant: 'fixture.example', module: 'Fixture', action: '@' + functionKey };
const scopes = [{ functionKey, nodeKeys: [nodeKey] }];
const serverStart = serverSessionSchema(debugRunToolSchema).parse({ op: 'start', run: { ...odcRun, roleCycle }, scopes });
const clientStart = clientSessionSchema(debugRunToolSchema).parse({ op: 'start', run: { ...odcRun, trace: 'none', roleCycle }, scopes });
const files = dir => { try { return fs.readdirSync(dir, { recursive: true }).sort(); } catch { return []; } };

function tempRoot(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-role-cycle-' + name + '-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// Every collaborator records its call: the refusal must come before any of them.
function spies() {
  const calls = [];
  const spy = name => async () => { calls.push(name); throw new Error('unexpected ' + name); };
  return { calls, run: spy('run'), debug: spy('debug'), readScopes: spy('readScopes'), prepareUser: spy('prepareUser'), odcBroker: () => { calls.push('odcBroker'); return {}; } };
}

test('the pending code names sc-portal-access and passes the public refusal rule', { skip }, () => {
  assert.equal(roleCyclePending(), CODE);
  assert.match(CODE, REFUSAL);
});

test('ssam_debug_server: an ODC roleCycle start is refused typed before the session exists', { skip }, async t => {
  const root = tempRoot(t, 'server'), s = spies();
  const manager = createServerSessionManager({ root, run: s.run, debug: s.debug, readScopes: s.readScopes, prepareUser: s.prepareUser, pollMs: 5 });
  await assert.rejects(manager(serverStart), error => error.message === CODE);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(files(path.join(root, '.local')), [], 'no session receipt, no role-cycle journal');
});

test('ssam_debug_client: an ODC roleCycle start is refused typed before the session exists', { skip }, async t => {
  const root = tempRoot(t, 'client'), s = spies();
  const manager = createClientSessionManager({ root, run: s.run, readScopes: s.readScopes, odcBroker: s.odcBroker });
  await assert.rejects(manager(clientStart), error => error.message === CODE);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(files(path.join(root, '.local')), [], 'no session receipt, no role-cycle journal');
});

test('an injected roleCycleAccess still starts the session (it needs no sc-portal-access.mjs)', async t => {
  const root = tempRoot(t, 'injected');
  let release; const held = new Promise(resolve => { release = resolve; });
  const access = { role: async key => ({ key, name: 'Tester' }), readRoles: async () => [], grant: async () => ({ ok: true }), revoke: async () => ({ ok: true }) };
  const manager = createClientSessionManager({ root, roleCycleAccess: async () => access, odcBroker: () => ({}),
    run: async () => { await held; return { ok: true, uncertain: false, credentialsReleased: true }; } });
  const started = await manager(clientStart);
  assert.equal(started.ok, true); assert.equal(started.state, 'preparing');
  release();
  let status = started;
  for (let i = 0; i < 80 && !['completed', 'failed', 'uncertain'].includes(status.state); i++)
    status = await manager({ op: 'status', sessionId: started.sessionId, afterRevision: status.revision, waitMs: 50 });
  // The run never signs in here, so the cycle itself reports not-started; what matters is that it ran past the gate.
  assert.ok(['completed', 'failed', 'uncertain'].includes(status.state), JSON.stringify(status));
  assert.notEqual(status.error, CODE);
});

test('the registered tools (default wiring, no injected access) refuse typed and write no receipt', { skip }, async () => {
  const receipts = ['server-sessions', 'client-sessions'].map(dir => path.join(workspaceRoot, '.local', 'debugger', dir));
  const before = receipts.map(files);
  for (const [runtime, request] of [['server', serverStart], ['client', clientStart]]) {
    // The MCP tool callback (the same one ssam.mjs wraps with debugReply) rejects with the code...
    await assert.rejects(inspectionHandler(runtime)(request), error => error.message === CODE, runtime);
    // ...and the persistent inspection CLI answers it as the public refusal.
    const input = new PassThrough(), output = new PassThrough(); let text = '';
    output.on('data', chunk => { text += chunk; });
    const done = runInspectionCli({ runtime, input, output, cleanupMs: 0 });
    input.end(JSON.stringify({ id: 'r1', request }) + '\n');
    await done;
    const [line] = text.trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(line, { id: 'r1', result: { ok: false, error: CODE } }, runtime);
    assert.doesNotMatch(text, /Cannot find module|ERR_MODULE_NOT_FOUND|sc-portal-access\.mjs/);
  }
  assert.deepEqual(receipts.map(files), before, 'no session receipt was written by the refused starts');
});

test('the three debug tool descriptions say roleCycle is unavailable while sc-portal-access is pending', { skip }, async () => {
  const described = {};
  const registry = { registerTool(name, metadata) { described[name] = metadata.description; } };
  registerClientSessionTool(registry, debugRunToolSchema, callback => callback);
  registerRunTools(registry, async () => ({ ok: true }), callback => callback);
  described.ssam_debug_server = serverSessionDescription();
  for (const name of ['ssam_debug_server', 'ssam_debug_client', 'ssam_debug_run']) {
    const text = described[name];
    assert.ok(text, name + ' registered');
    assert.match(text, /roleCycle \{roleKey, ?words\}[^.;]*\) is unavailable in this build until the SC\/Portal dependency sc-portal-access/, name);
    assert.ok(text.includes(CODE), name + ' names the refusal code');
    assert.doesNotMatch(text, /roleCycle[^.]*?grants one[^.]*?implemented, live proof pending/, name);
    assert.doesNotMatch(text, /Both are implemented, live proof pending|both are implemented, live proof pending/, name);
  }
  // holdBetweenScenarios keeps its own status.
  assert.match(described.ssam_debug_server, /stop during a hold ends without a native start; implemented, live proof pending/);
  assert.match(described.ssam_debug_run, /renews the native session; implemented, live proof pending/);
});
