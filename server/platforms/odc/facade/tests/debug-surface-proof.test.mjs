import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { runInspectionCli } from '../debug-inspection-cli.mjs';
import { parseSurfaceProofScript, runSurfaceProof, canonicalSha256 } from '../debug-surface-proof.mjs';
import { createFakeCoordinator, createFakeMcpServer } from './fixtures/debug-surface-proof-coordinator.mjs';

const SESSION = '11111111-2222-4333-8444-555555555555';
const WORDS = 'private run words 4711', GRANT = 'grant hook words 0815';
const fixtureEntry = fileURLToPath(new URL('./fixtures/debug-surface-proof-fake-ssam.mjs', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-surface-proof-'));
const key = c => c.repeat(22);

function script(runtime, overrides = {}) {
  const server = runtime === 'server';
  return { schema: 'ssam-debug-surface-proof-script/1', name: 'fake-' + runtime, runtime, lane: 'o11',
    start: { seconds: 600, scopes: [{ functionKey: key('F'), nodeKeys: [key('N')] }],
      run: { op: 'run', lane: 'o11', module: 'Fixture', action: '@' + key('F'), execution: 'native-entry',
        trace: server ? 'full' : 'none', contextMode: 'native-background', words: WORDS } },
    expectedStops: { min: 2, max: 2 },
    perStop: [{ op: 'frame', frame: 'top' }, { op: 'scope' }, { op: 'read-many', args: server ? { depth: 2 } : { detail: 2 } },
      { op: 'private-read', select: { names: ['Seed'] }, as: 'seed' }, { op: 'step', kind: 'over' }, { op: 'scope', probe: 'stale' }],
    atStop: { 2: [{ op: 'scope' }, { op: 'private-read', select: { names: ['Seed'] }, as: 'seed' },
      { op: 'private-compare', handlesFrom: ['seed'] }, { op: 'step', kind: 'over' }, { op: 'scope', probe: 'stale' }] },
    hooks: [{ at: 'after-start', tool: 'odc_configurations', arguments: { action: 'set-value', operationUuid: '22222222-3333-4444-8555-666666666666' },
      authorization: GRANT, authorizationField: 'words' }],
    statusWaitMs: 0, replyTimeoutMs: 3000, cleanupMs: 3000, deadlineMs: 20000, ...overrides };
}

function mcpDeps(coordinators, recorded, tools) {
  return { StdioClientTransport: function FakeStdio(options) {
    recorded.push({ kind: 'mcp', command: options.command, args: options.args, cwd: options.cwd });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const ready = createFakeMcpServer({ coordinators, tools }).then(server => server.connect(serverSide));
    const start = clientSide.start.bind(clientSide);
    clientSide.start = async () => { await ready; return start(); };
    return clientSide;
  } };
}

function cliDeps(coordinator, recorded, crash) {
  return { spawn(command, args, options) {
    recorded.push({ kind: 'cli', command, args, cwd: options.cwd, stdio: options.stdio });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.exitCode = null; child.unref = () => {};
    const exit = () => { if (child.exitCode !== null) return; child.exitCode = 0; child.stdout.end(); child.emit('exit', 0, null); child.emit('close', 0, null); };
    if (crash) crash.now = exit;
    process.nextTick(() => child.emit('spawn'));
    runInspectionCli({ runtime: args[2], lane: args[5], input: child.stdin, output: child.stdout, handler: coordinator.handler, cleanupMs: 1000 }).finally(exit);
    return child;
  } };
}

async function prove(transport, s, { root = tempRoot(), out = 'proof-' + transport, coordinatorOptions = {} } = {}) {
  const coordinator = createFakeCoordinator({ runtime: s.runtime, root, ...coordinatorOptions });
  const recorded = [], hookCalls = [];
  const tools = { odc_configurations: async args => { hookCalls.push(args); return { ok: true }; } };
  const entry = path.join(root, 'facade', 'ssam.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '// fake entry, never executed\n');
  const deps = transport === 'mcp' ? mcpDeps({ [s.runtime]: coordinator }, recorded, tools)
    : { ...cliDeps(coordinator, recorded, coordinatorOptions.crash), ...mcpDeps({}, recorded, tools) };
  const audit = await runSurfaceProof({ script: s, transport, root, outDir: path.join(root, out), deps });
  return { audit, coordinator, recorded, hookCalls, root };
}
const sequence = audit => audit.requests.map(r => [r.seq, r.phase, r.channel, r.op, r.requestSha256, r.templateSha256, r.outcome, r.responseSha256 ?? null]);

for (const runtime of ['server', 'client']) {
  test(`one script yields the identical request sequence over fake MCP and fake CLI (${runtime})`, async () => {
    const root = tempRoot(), s = script(runtime);
    const mcp = await prove('mcp', s, { root }), cli = await prove('cli', s, { root });
    assert.deepEqual(mcp.coordinator.log, cli.coordinator.log);
    assert.deepEqual(sequence(mcp.audit), sequence(cli.audit));
    assert.equal(mcp.audit.sequence.requestsSha256, cli.audit.sequence.requestsSha256);
    assert.equal(mcp.audit.sequence.templatesSha256, cli.audit.sequence.templatesSha256);
    assert.equal(mcp.audit.transport, 'mcp-stdio'); assert.equal(cli.audit.transport, 'cli-json-lines');
    const entry = path.join(root, 'facade', 'ssam.mjs');
    assert.deepEqual(mcp.recorded, [{ kind: 'mcp', command: process.execPath, args: [entry, 'mcp', '--profile', 'all'], cwd: root }]);
    assert.deepEqual(cli.recorded[0], { kind: 'cli', command: process.execPath, args: [entry, 'debug', runtime, '--stdio', '--lane', 'o11'],
      cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    assert.deepEqual(cli.recorded[1], { kind: 'mcp', command: process.execPath, args: [entry, 'mcp', '--profile', 'all'], cwd: root });
    for (const { audit, hookCalls } of [mcp, cli]) {
      assert.deepEqual(hookCalls, [{ action: 'set-value', operationUuid: '22222222-3333-4444-8555-666666666666', words: GRANT }]);
      assert.equal(audit.sessionId, SESSION); assert.equal(audit.runnerOperationId, '99999999-8888-4777-8666-555555555555');
      assert.deepEqual(audit.terminal, { observed: true, state: 'completed', source: 'status' });
      assert.equal(audit.stops.observed, 2); assert.equal(audit.stops.withinRange, true); assert.equal(audit.stops.exceeded, false);
      assert.deepEqual(audit.staleRefusals.map(r => [r.stop, r.op, r.error]),
        [[1, 'scope', 'debug_' + runtime + '_session_stale_stop'], [2, 'scope', 'debug_' + runtime + '_session_stale_stop']]);
      assert.equal(audit.uncertainty, null); assert.equal(audit.error, null);
      assert.deepEqual(audit.flags, { response: { answered: true, results: 1, uncertainResults: 0 },
        nativeStop: runtime === 'server' ? { value: true, kind: 'debugger-stopped', source: 'runResult.serverTrace.stopped' }
          : { value: true, kind: 'inspector-host-exited', source: 'runResult.worker.workerExited' },
        stopCommand: null,
        // native-background takes no app-user lease: not applicable, sourced, never a false failure.
        credentials: { value: null, outcome: 'not-applicable', source: 'runResult.needs.contextMode', contextMode: 'native-background' },
        mutexReleased: true, runUncertain: false, cleanupCompleted: null });
      assert.equal(audit.ownerTerminatedWithLiveSession, false); assert.equal(audit.owner.liveSessionAtClose, false);
      assert.equal(audit.runResult.receipt.sha256, sha(fs.readFileSync(path.join(root, '.local', 'debugger', 'fake-runs', 'op-1', 'receipt.json'))));
      assert.equal(audit.surfaceCriteriaPassed, true); assert.equal(audit.complete, true);
    }
  });
}

test('server stop commands carry the observed threadId/eventId/generation and adopt returned generations', async () => {
  const { coordinator } = await prove('cli', script('server', { hooks: [] }));
  const token = (eventId, generation) => ({ sessionId: SESSION, threadId: 'T1', eventId, generation });
  const commands = coordinator.log.filter(r => !['start', 'status'].includes(r.op));
  assert.deepEqual(commands, [
    { op: 'frame', ...token('10', 1), frame: 1 },
    { op: 'scope', ...token('10', 2) },
    { op: 'read-many', ...token('10', 3), references: ['a'.repeat(32), 'b'.repeat(32)], depth: 2 },
    { op: 'private-read', ...token('10', 3), reference: 'a'.repeat(32) },
    { op: 'step-over', ...token('10', 3) },
    { op: 'scope', ...token('10', 3) },
    { op: 'scope', ...token('20', 1) },
    { op: 'private-read', ...token('20', 2), reference: 'a'.repeat(32) },
    { op: 'private-compare', sessionId: SESSION, handles: ['pc_' + '1'.padStart(32, '0'), 'pc_' + '2'.padStart(32, '0')] },
    { op: 'step-over', ...token('20', 2) },
    { op: 'scope', ...token('20', 2) }]);
  const statuses = coordinator.log.filter(r => r.op === 'status');
  assert.ok(statuses.every(r => r.sessionId === SESSION && r.waitMs === 0 && Number.isInteger(r.afterRevision)));
});

test('client stop commands carry the observed stop/generation and the client reference names', async () => {
  const { coordinator } = await prove('mcp', script('client', { hooks: [] }));
  const token = (stop, generation) => ({ sessionId: SESSION, stop, generation });
  const commands = coordinator.log.filter(r => !['start', 'status'].includes(r.op));
  assert.deepEqual(commands.slice(0, 6), [
    { op: 'frame', ...token(1, 1), frame: 0 },
    { op: 'scope', ...token(1, 2) },
    { op: 'read-many', ...token(1, 3), refs: ['a'.repeat(48), 'b'.repeat(48)], detail: 2 },
    { op: 'private-read', ...token(1, 3), ref: 'a'.repeat(48) },
    { op: 'stepOver', ...token(1, 3) },
    { op: 'scope', ...token(1, 3) }]);
  assert.equal(coordinator.log[0].run.lane, 'o11');
});

test('a lost CLI reply halts the script without resend and the EOF owner-closing is captured', async () => {
  const { audit, coordinator } = await prove('cli', script('server', { hooks: [], replyTimeoutMs: 80 }),
    { coordinatorOptions: { hang: { op: 'read-many', ms: 400 } } });
  const last = audit.requests.at(-1);
  assert.equal(last.op, 'read-many'); assert.equal(last.outcome, 'lost'); assert.equal(last.lostReason, 'reply-timeout');
  assert.deepEqual(audit.uncertainty, { seq: last.seq, phase: 'script', channel: 'debug', op: 'read-many', requestSha256: last.requestSha256, reason: 'reply-timeout' });
  assert.equal(coordinator.log.filter(r => r.op === 'read-many').length, 1);
  const after = coordinator.log.slice(coordinator.log.findIndex(r => r.op === 'read-many') + 1).map(r => r.op);
  assert.equal(after[0], 'stop'); assert.ok(after.length > 1 && after.slice(1).every(op => op === 'status'));
  assert.equal(audit.requests.some(r => r.phase === 'cleanup'), false);
  assert.equal(audit.owner.releasedBy, 'stdin-eof'); assert.equal(audit.owner.exitObserved, true);
  assert.equal(audit.ownerClosing.length, 1);
  assert.equal(audit.ownerClosing[0].sessionId, SESSION); assert.equal(audit.ownerClosing[0].terminalObserved, true);
  assert.deepEqual(audit.terminal, { observed: true, state: 'failed', source: 'owner-closing' });
  assert.equal(audit.lateReplies, 1);
  // The CLI owner stopped the live session on EOF: not abandoned.
  assert.equal(audit.owner.liveSessionAtClose, true); assert.equal(audit.ownerTerminatedWithLiveSession, false);
  assert.equal(audit.surfaceCriteriaPassed, false);
});

test('a lost MCP reply halts the script; nothing is resent and no cleanup command is sent', async () => {
  const { audit, coordinator } = await prove('mcp', script('server', { hooks: [], replyTimeoutMs: 80 }),
    { coordinatorOptions: { hang: { op: 'read-many', ms: 300 } } });
  await new Promise(resolve => setTimeout(resolve, 400));
  const last = audit.requests.at(-1);
  assert.equal(last.op, 'read-many'); assert.equal(last.outcome, 'lost'); assert.equal(last.lostReason, 'reply-timeout');
  assert.equal(audit.uncertainty.op, 'read-many');
  assert.equal(coordinator.log.at(-1).op, 'read-many'); assert.equal(coordinator.log.filter(r => r.op === 'read-many').length, 1);
  assert.equal(audit.owner.releasedBy, 'transport-close'); assert.deepEqual(audit.ownerClosing, []);
  // Closing `ssam mcp` kills the session owner without a stop; native debugger, lease and mutex go to expiry/reconcile.
  assert.equal(audit.owner.liveSessionAtClose, true); assert.equal(audit.owner.sessionStopOnClose, 'none');
  assert.equal(audit.ownerTerminatedWithLiveSession, true);
  assert.equal(audit.terminal.observed, false); assert.equal(audit.surfaceCriteriaPassed, false);
});

test('a CLI owner that exits during a request is a lost reply, never retried', async () => {
  const crash = { op: 'scope' };
  const { audit, coordinator } = await prove('cli', script('server', { hooks: [] }), { coordinatorOptions: { crash } });
  assert.equal(audit.requests.at(-1).op, 'scope'); assert.equal(audit.requests.at(-1).lostReason, 'channel-closed');
  assert.equal(audit.uncertainty.reason, 'channel-closed');
  assert.equal(coordinator.log.filter(r => r.op === 'scope').length, 1);
  assert.equal(audit.terminal.observed, false);
});

test('a refused command stops the session once through the same cleanup on both surfaces', async () => {
  const root = tempRoot(), s = script('server', { hooks: [] }), refuse = { op: 'private-compare', code: 'private_compare_unavailable' };
  const mcp = await prove('mcp', s, { root, coordinatorOptions: { refuse } }), cli = await prove('cli', s, { root, coordinatorOptions: { refuse } });
  assert.deepEqual(sequence(mcp.audit), sequence(cli.audit)); assert.deepEqual(mcp.coordinator.log, cli.coordinator.log);
  for (const { audit, coordinator } of [mcp, cli]) {
    assert.equal(audit.error, 'debug_surface_proof_command_refused');
    assert.equal(audit.requests.find(r => r.op === 'private-compare').error, 'debug_server_session_private_compare_unavailable');
    const cleanup = audit.requests.filter(r => r.phase === 'cleanup').map(r => r.op);
    assert.equal(cleanup[0], 'stop'); assert.ok(cleanup.slice(1).every(op => op === 'status'));
    assert.equal(coordinator.log.filter(r => r.op === 'stop').length, 1);
    assert.deepEqual(audit.terminal, { observed: true, state: 'failed', source: 'status' });
    assert.equal(audit.surfaceCriteriaPassed, false);
  }
});

test('private-compare takes privateCompareHandle only; without one the script stops before comparing', async () => {
  const { audit, coordinator } = await prove('cli', script('server', { hooks: [] }), { coordinatorOptions: { compareHandles: false } });
  assert.equal(audit.error, 'debug_surface_proof_private_handle_unavailable');
  assert.equal(coordinator.log.some(r => r.op === 'private-compare'), false);
  assert.equal(coordinator.log.filter(r => r.op === 'stop').length, 1);
  assert.equal(audit.terminal.state, 'failed'); assert.equal(audit.surfaceCriteriaPassed, false);
});

test('more stops than the expected range stop the session before touching the extra stop', async () => {
  const { audit, coordinator } = await prove('mcp', script('server', { hooks: [] }), { coordinatorOptions: { stops: 3 } });
  assert.equal(audit.error, 'debug_surface_proof_stop_range_exceeded'); assert.equal(audit.stops.exceeded, true);
  assert.equal(coordinator.log.some(r => r.eventId === '30'), false);
  assert.equal(coordinator.log.filter(r => r.op === 'stop').length, 1);
});

test('pause and resume use the latest observed revision once; held hooks run before resume', async () => {
  const s = script('server', { onRunning: [{ op: 'pause', afterStops: 0 }], onHeld: [{ op: 'resume' }],
    hooks: [{ at: 'held', tool: 'odc_configurations', arguments: { action: 'set-value' }, authorization: GRANT, authorizationField: 'words' }] });
  const { audit, coordinator, hookCalls } = await prove('cli', s, { coordinatorOptions: { held: 1 } });
  assert.equal(audit.error, null); assert.equal(audit.terminal.state, 'completed');
  assert.equal(coordinator.log.filter(r => r.op === 'pause').length, 1); assert.equal(coordinator.log.filter(r => r.op === 'resume').length, 1);
  assert.equal(hookCalls.length, 1);
  const hook = audit.requests.find(r => r.phase === 'hook'), resume = audit.requests.find(r => r.op === 'resume');
  assert.ok(hook.seq < resume.seq); assert.equal(hook.authorizationSha256, sha(GRANT)); assert.equal(hook.ok, true);
});

test('audit hashes are deterministic and the audit carries no private or authorization values', async () => {
  const root = tempRoot(), s = script('server');
  const a = await prove('mcp', s, { root, out: 'a' }), b = await prove('mcp', s, { root, out: 'b' });
  assert.deepEqual(a.audit.requests.map(r => [r.requestSha256, r.responseSha256]), b.audit.requests.map(r => [r.requestSha256, r.responseSha256]));
  assert.equal(canonicalSha256({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalSha256({ a: [{ c: 3, d: 2 }], b: 1 }));
  const text = fs.readFileSync(a.audit.auditPath, 'utf8');
  assert.equal(JSON.parse(text).sequence.requestsSha256, a.audit.sequence.requestsSha256);
  for (const value of [WORDS, GRANT, 'visible-17', '00000000-0000-4000-8000-000000000001', 'pc_' + '1'.padStart(32, '0'), 'a'.repeat(32)])
    assert.equal(text.includes(value), false, value);
  const transcript = fs.readFileSync(path.join(root, 'a', 'transcript.jsonl'), 'utf8');
  assert.equal(transcript.includes(WORDS), false); assert.equal(transcript.includes(GRANT), false);
  assert.equal(a.audit.script.sha256, b.audit.script.sha256);
  assert.equal(a.audit.requests.find(r => r.phase === 'hook').authorizationSha256, sha(GRANT));
});

test('parity of two audits compares shapes and refusal codes, ignoring status poll counts', async () => {
  const { surfaceParity, mcpReplyValue } = await import('../debug-surface-proof.mjs');
  const root = tempRoot(), s = script('server', { hooks: [] });
  const mcp = await prove('mcp', s, { root, out: 'p1' }), cli = await prove('cli', s, { root, out: 'p2' });
  const verdict = surfaceParity(mcp.audit, cli.audit);
  assert.equal(verdict.parity, true); assert.equal(verdict.bothPassed, true); assert.equal(verdict.bothSurfaces, true);
  const extraPoll = structuredClone(cli.audit);
  extraPoll.requests.splice(1, 0, { ...extraPoll.requests.find(r => r.op === 'status'), seq: 0 });
  assert.equal(surfaceParity(mcp.audit, extraPoll).parity, true);
  const otherRuntime = await prove('cli', script('client', { hooks: [] }), { root, out: 'p3' });
  assert.equal(surfaceParity(mcp.audit, otherRuntime.audit).parity, false);
  assert.equal(surfaceParity(mcp.audit, structuredClone(mcp.audit)).bothSurfaces, false);
  // The MCP SDK refuses an invalid request before the tool handler, as text; the CLI answers a public code.
  const sdk = mcpReplyValue({ isError: true, content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool ssam_debug_server: x' }] });
  assert.equal(sdk.ok, false); assert.equal(sdk.error, 'debug_surface_proof_mcp_input_validation'); assert.equal(JSON.stringify(sdk).includes('Invalid arguments'), false);
  const refusal = audit => ({ ...audit, requests: [{ phase: 'script', channel: 'debug', op: 'start', templateSha256: 't', error: audit === mcp.audit
    ? 'debug_surface_proof_mcp_input_validation' : 'debug_inspection_cli_invalid_request' }] });
  const refused = surfaceParity(refusal(mcp.audit), refusal(cli.audit));
  assert.equal(refused.sameErrorCodes, false); assert.equal(refused.sameRefusalClasses, true); assert.equal(refused.parity, false);
});

test('a receipt outside the debugger state root is not read', async () => {
  const outside = path.join(tempRoot(), 'receipt.json');
  const { audit } = await prove('mcp', script('server', { hooks: [] }), { coordinatorOptions: { receiptPath: outside } });
  assert.deepEqual(audit.runResult.receipt, { path: outside, sha256: null, refused: 'outside-debugger-root' });
  assert.equal(audit.surfaceCriteriaPassed, false);
});

test('scripts that could evaluate, replay or mutate without authorization are refused before any transport', () => {
  const refused = {
    'write hook without authorization': s => { delete s.hooks[0].authorization; },
    'debugger tool as hook': s => { s.hooks[0].tool = 'ssam_debug_server'; },
    'unlisted hook tool': s => { s.hooks[0].tool = 'studio_publish'; },
    'authorization smuggled in arguments': s => { s.hooks[0].arguments.words = 'x'; },
    'evaluator in arguments': s => { s.perStop[2].args = { expression: '1+1' }; },
    'bound token in arguments': s => { s.perStop[2].args = { generation: 9 }; },
    'no consuming command': s => { s.perStop = [{ op: 'scope' }]; },
    'probe before consumption': s => { s.perStop = [{ op: 'scope', probe: 'stale' }, { op: 'step', kind: 'over' }]; },
    'command after consumption': s => { s.perStop = [{ op: 'step', kind: 'over' }, { op: 'scope' }]; },
    'reference read without scope': s => { s.perStop = [{ op: 'read-many' }, { op: 'continue' }]; },
    'lane mismatch': s => { s.start.run.lane = 'odc'; },
    'unknown field': s => { s.replay = true; },
    'undefined handle label': s => { s.atStop[2][2].handlesFrom = ['other']; },
    'client op on server': s => { s.perStop[4] = { op: 'stepOver' }; },
    'start with sessionId': s => { s.start.sessionId = SESSION; },
    'inverted stop range': s => { s.expectedStops = { min: 3, max: 2 }; },
    'second pause': s => { s.onRunning = [{ op: 'pause' }, { op: 'pause' }]; },
  };
  for (const [name, mutate] of Object.entries(refused)) {
    const s = structuredClone(script('server')); mutate(s);
    assert.throws(() => parseSurfaceProofScript(s), /^Error: debug_surface_proof_script_invalid/, name);
  }
  assert.equal(parseSurfaceProofScript(script('server')).runtime, 'server');
  assert.equal(parseSurfaceProofScript('﻿' + JSON.stringify(script('client'))).runtime, 'client');
});

test('a lost start reply is not resent; the CLI owner still cancels and names the session', async () => {
  const { audit, coordinator } = await prove('cli', script('server', { hooks: [], replyTimeoutMs: 60 }),
    { coordinatorOptions: { hang: { op: 'start', ms: 300 } } });
  assert.deepEqual(audit.requests.map(r => [r.op, r.outcome]), [['start', 'lost']]);
  assert.deepEqual(coordinator.log.map(r => r.op).slice(0, 2), ['start', 'stop']);
  assert.equal(audit.sessionId, SESSION); assert.equal(audit.sessionIdSource, 'owner-closing');
  assert.equal(audit.terminal.source, 'owner-closing'); assert.equal(audit.surfaceCriteriaPassed, false);
  assert.equal(audit.owner.liveSessionAtClose, null); assert.equal(audit.ownerTerminatedWithLiveSession, false);
});

test('a lost MCP start reply leaves the session owner state unknown, never assumed stopped', async () => {
  const { audit } = await prove('mcp', script('server', { hooks: [], replyTimeoutMs: 60 }), { coordinatorOptions: { hang: { op: 'start', ms: 300 } } });
  assert.deepEqual(audit.requests.map(r => [r.op, r.outcome]), [['start', 'lost']]);
  assert.equal(audit.owner.liveSessionAtClose, null); assert.equal(audit.ownerTerminatedWithLiveSession, null);
  assert.equal(audit.surfaceCriteriaPassed, false);
});

test('credential release is sourced: anonymous REST/SOAP and native-background are not applicable, app-user needs the release', async () => {
  // Explicitly anonymous endpoint (REST/SOAP anonymous adapters): the runner takes no descriptor, so no credentialsReleased.
  for (const transport of ['mcp', 'cli']) {
    const s = script('server', { hooks: [] }); s.start.run.contextMode = 'anonymous';
    const { audit } = await prove(transport, s);
    assert.equal(audit.runResult.ok, true);
    assert.deepEqual(audit.flags.credentials, { value: null, outcome: 'not-applicable', source: 'runResult.needs.contextMode', contextMode: 'anonymous' });
    assert.equal(audit.surfaceCriteriaPassed, true, transport);
  }
  const appUser = script('server', { hooks: [] }); appUser.start.run.contextMode = 'app-user';
  const released = await prove('mcp', appUser);
  assert.deepEqual(released.audit.flags.credentials, { value: true, outcome: 'released', source: 'runResult.credentialsReleased' });
  assert.equal(released.audit.surfaceCriteriaPassed, true);
  // An app-user run without a release record is unknown, never not-applicable.
  const missing = await prove('mcp', appUser, { coordinatorOptions: { credentials: 'omit' } });
  assert.deepEqual(missing.audit.flags.credentials, { value: null, outcome: 'unknown', source: null });
  assert.equal(missing.audit.surfaceCriteriaPassed, false);
  const { surfaceFlags } = await import('../debug-surface-proof.mjs');
  const rr = { ok: true, state: 'answered', results: [{ ok: true }], needs: { loginWindow: false, contextMode: 'anonymous' } };
  assert.equal(surfaceFlags({ runResult: rr }, { contextMode: 'anonymous' }).credentials.outcome, 'not-applicable');
  // The requested context must match the runner's own needs; a login window or app-user evidence is never waived.
  assert.equal(surfaceFlags({ runResult: rr }, { contextMode: 'app-user' }).credentials.outcome, 'unknown');
  assert.equal(surfaceFlags({ runResult: { ...rr, needs: { loginWindow: true, contextMode: 'anonymous' } } }).credentials.outcome, 'unknown');
  assert.equal(surfaceFlags({ runResult: { ...rr, appUserAuthenticated: true } }).credentials.outcome, 'unknown');
  assert.equal(surfaceFlags({ runResult: { ...rr, results: [{ ok: true, authentication: { credentialsFromPrivateDialog: true } }] } }).credentials.outcome, 'unknown');
  assert.deepEqual(surfaceFlags({ runResult: { ...rr, credentialsReleased: false } }).credentials, { value: false, outcome: 'not-released', source: 'runResult.credentialsReleased' });
});

test('a stale probe refused for another reason is a mismatch, not a stale-reference refusal', async () => {
  for (const transport of ['mcp', 'cli']) {
    const { audit, coordinator } = await prove(transport, script('server', { hooks: [] }), { coordinatorOptions: { staleCode: 'unknown_field' } });
    assert.deepEqual(audit.staleRefusals, []);
    assert.deepEqual(audit.staleProbeMismatches, [{ stop: 1, op: 'scope', error: 'debug_server_session_unknown_field', expected: 'debug_server_session_stale_stop' }]);
    assert.equal(audit.error, 'debug_surface_proof_stale_probe_refusal_mismatch');
    assert.equal(coordinator.log.filter(r => r.op === 'stop').length, 1); assert.equal(audit.surfaceCriteriaPassed, false);
  }
});

test('client flags keep the stop acknowledgement apart and name the weaker inspector-host exit', async () => {
  const { surfaceFlags } = await import('../debug-surface-proof.mjs');
  const flags = surfaceFlags({ stopEvidence: { command: 'stop', workerTerminationRequested: true, executionOutcome: 'requires-reconciliation',
    privateInspectionCleanup: { completed: false, pending: 2 }, acknowledgedAt: 'x' }, runResult: { worker: { workerExited: true } } });
  assert.deepEqual(flags.nativeStop, { value: true, kind: 'inspector-host-exited', source: 'runResult.worker.workerExited' });
  assert.deepEqual(flags.stopCommand, { source: 'stopEvidence', workerTerminationRequested: true, executionOutcome: 'requires-reconciliation',
    privateInspectionCleanup: { completed: false, pending: 2 } });
  // A refused client command ends through the coordinator's stop; its acknowledgement reaches the audit.
  const { audit } = await prove('cli', script('client', { hooks: [] }), { coordinatorOptions: { refuse: { op: 'private-compare', code: 'x' } } });
  assert.equal(audit.flags.stopCommand.workerTerminationRequested, true); assert.equal(audit.surfaceCriteriaPassed, false);
});

test('a non-public MCP error maps to the CLI invalid-request refusal class and its text stays out of the audit', async () => {
  const { surfaceParity, mcpReplyValue } = await import('../debug-surface-proof.mjs');
  const raw = 'TypeError: Cannot read properties of undefined (reading secretish)';
  const value = mcpReplyValue({ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: raw }) }] });
  assert.equal(value.error, 'debug_surface_proof_mcp_nonpublic_error'); assert.equal(JSON.stringify(value).includes('Cannot read'), false);
  const root = tempRoot(), s = script('server', { hooks: [] }), refuse = { op: 'private-compare', raw };
  const mcp = await prove('mcp', s, { root, out: 'n1', coordinatorOptions: { refuse } }), cli = await prove('cli', s, { root, out: 'n2', coordinatorOptions: { refuse } });
  assert.equal(mcp.audit.requests.find(r => r.op === 'private-compare').error, 'debug_surface_proof_mcp_nonpublic_error');
  assert.equal(cli.audit.requests.find(r => r.op === 'private-compare').error, 'debug_inspection_cli_invalid_request');
  const verdict = surfaceParity(mcp.audit, cli.audit);
  assert.equal(verdict.sameRequestShapes, true); assert.equal(verdict.sameErrorCodes, false); assert.equal(verdict.sameRefusalClasses, true);
  for (const dir of ['n1', 'n2']) for (const file of ['audit.json', 'transcript.jsonl'])
    assert.equal(fs.readFileSync(path.join(root, dir, file), 'utf8').includes('Cannot read'), false, dir + '/' + file);
});

test('module CLI runs a script file and prints only a summary', { timeout: 90000 }, async () => {
  const { execFile } = await import('node:child_process');
  const root = tempRoot(), file = path.join(root, 'script.json'), log = path.join(root, 'cli.jsonl');
  fs.writeFileSync(file, '﻿' + JSON.stringify(script('server', { hooks: [] })));
  const driver = fileURLToPath(new URL('../debug-surface-proof.mjs', import.meta.url));
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath,
    [driver, '--script', file, '--transport', 'cli', '--root', root, '--out', path.join(root, 'out'), '--entry', fixtureEntry],
    { env: { ...process.env, SSAM_SURFACE_PROOF_FAKE: JSON.stringify({ logPath: log }) }, timeout: 60000, windowsHide: true },
    (error, out) => error ? reject(error) : resolve(out)));
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.ok, true); assert.equal(summary.transport, 'cli-json-lines'); assert.equal(summary.sessionId, SESSION);
  assert.equal(summary.auditSha256, sha(fs.readFileSync(path.join(root, 'out', 'audit.json'))));
  for (const value of [WORDS, 'visible-17']) assert.equal(stdout.includes(value), false);
  const { parseSurfaceProofCli } = await import('../debug-surface-proof.mjs');
  assert.throws(() => parseSurfaceProofCli(['--script', 'relative.json', '--transport', 'cli', '--root', root, '--out', root]), /cli_usage/);
  assert.throws(() => parseSurfaceProofCli(['--script', file, '--words', 'x']), /cli_usage/);
});

test('relative roots, missing entries and reused output directories are refused before spawning', async () => {
  const root = tempRoot(), recorded = [], s = script('server', { hooks: [] });
  const deps = { spawn: () => { recorded.push(1); throw new Error('spawned'); } };
  await assert.rejects(runSurfaceProof({ script: s, transport: 'cli', root: 'relative', outDir: path.join(root, 'x'), deps }), /root_not_absolute/);
  await assert.rejects(runSurfaceProof({ script: s, transport: 'cli', root, outDir: path.join(root, 'x'), deps }), /entry_unavailable/);
  await assert.rejects(runSurfaceProof({ script: s, transport: 'cli', root, entry: fixtureEntry, outDir: root, deps }), /out_exists/);
  await assert.rejects(runSurfaceProof({ script: s, transport: 'ws', root, entry: fixtureEntry, outDir: path.join(root, 'y'), deps }), /transport_invalid/);
  assert.equal(recorded.length, 0);
});

async function real(transport, s, root, fake) {
  const log = path.join(root, transport + '-' + Object.keys(fake).join('-') + '.jsonl');
  const audit = await runSurfaceProof({ script: s, transport, root, entry: fixtureEntry, outDir: path.join(root, 'real-' + path.basename(log, '.jsonl')),
    deps: { env: { ...process.env, SSAM_SURFACE_PROOF_FAKE: JSON.stringify({ ...fake, logPath: log }) } } });
  return { audit, log: fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('real child processes: both public surfaces of one entry receive the same requests', { timeout: 90000 }, async () => {
  const root = tempRoot(), s = script('server', { hooks: [] });
  const mcp = await real('mcp', s, root, { stops: 2 }), cli = await real('cli', s, root, { stops: 2 });
  assert.deepEqual(mcp.log, cli.log); assert.deepEqual(sequence(mcp.audit), sequence(cli.audit));
  for (const { audit } of [mcp, cli]) { assert.equal(audit.terminal.state, 'completed'); assert.equal(audit.surfaceCriteriaPassed, true); }
  assert.equal(cli.audit.owner.exitObserved, true); assert.equal(mcp.audit.entry.sha256, sha(fs.readFileSync(fixtureEntry)));
});

test('real CLI child: a lost reply is never resent and EOF cancellation reports owner-closing', { timeout: 90000 }, async () => {
  const root = tempRoot();
  // The cold child must answer start within the reply budget; only read-many outlives it.
  const { audit, log } = await real('cli', script('server', { hooks: [], replyTimeoutMs: 4000, cleanupMs: 20000 }), root, { hang: { op: 'read-many', ms: 7000 } });
  assert.equal(audit.uncertainty.op, 'read-many'); assert.equal(log.filter(r => r.op === 'read-many').length, 1);
  const after = log.slice(log.findIndex(r => r.op === 'read-many') + 1).map(r => r.op);
  assert.equal(after[0], 'stop'); assert.ok(after.slice(1).every(op => op === 'status'));
  assert.equal(audit.requests.some(r => r.phase === 'cleanup'), false); assert.equal(audit.lateReplies, 1);
  assert.equal(audit.ownerClosing.length, 1); assert.equal(audit.ownerClosing[0].terminalObserved, true);
  assert.equal(audit.terminal.source, 'owner-closing');
});
