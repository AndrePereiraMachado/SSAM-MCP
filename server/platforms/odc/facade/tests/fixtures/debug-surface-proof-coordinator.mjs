// Deterministic fake of ssam_debug_server/ssam_debug_client for debug-surface-proof tests.
// No runner, no native debugger, no network: it only checks stop tokens like the coordinators.
import fs from 'node:fs';
import path from 'node:path';

const SESSION = '11111111-2222-4333-8444-555555555555';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const steps = { server: ['step-into', 'step-over', 'step-out', 'continue'], client: ['stepInto', 'stepOver', 'stepOut', 'continue'] };

export function createFakeCoordinator({ runtime = 'server', root, stops = 2, held = 0, hang = null, crash = null,
  refuse = null, logPath = null, receiptPath = null, compareHandles = true, credentials = 'release', staleCode = 'stale_stop' } = {}) {
  const log = [], server = runtime === 'server', prefix = server ? 'debug_server_session_' : 'debug_client_session_';
  let phase = 'idle', revision = 0, stop = 0, generation = 1, pause = null, heldLeft = held, result = null, hung = false, context = 'app-user', stopEvidence = null;
  const receipt = receiptPath ?? path.join(root, '.local', 'debugger', 'fake-runs', 'op-1', 'receipt.json');
  const fail = code => { throw new Error(prefix + code); };
  const changed = () => { revision++; };
  const finish = (state, ok) => {
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ schema: 'fake-receipt/1', state, ok }));
    // Like debug-o11-native-run.mjs: only an app-user run leases (and releases) a credential descriptor.
    const lease = context === 'app-user';
    result = { ok, uncertain: false, operationId: '99999999-8888-4777-8666-555555555555', receiptPath: receipt,
      needs: { loginWindow: lease, contextMode: context },
      results: ok ? [{ ok: true, outputs: { Result: 42 }, ...(context === 'anonymous' ? { authentication: { protocol: 'none', context: 'explicit-anonymous', credentialsFromPrivateDialog: false } } : {}) }] : [],
      ...(lease && credentials === 'release' ? { credentialsReleased: true } : {}), lockRetained: false,
      ...(server ? { serverTrace: { stopped: true, sessionId: 'native-1' } } : { worker: { workerExited: true } }) };
    phase = state; pause = null; changed();
  };
  const snapshot = () => ({ ok: true, sessionId: SESSION, runtime, state: phase, revision,
    receiptPath: path.join(root, '.local', 'debugger', runtime + '-sessions', SESSION + '.json'),
    ...(server ? { pauses: pause ? [pause] : [] } : pause ? { pause } : {}), ...(stopEvidence ? { stopEvidence } : {}), ...(result ? { runResult: result } : {}) });
  const advance = () => {
    if (phase === 'preparing') { phase = 'running'; changed(); return; }
    if (phase === 'ending') return finish('failed', false);
    if (phase !== 'running') return;
    if (stop === 1 && heldLeft > 0) { heldLeft--; phase = 'held'; changed(); return; }
    if (stop >= stops) return finish('completed', true);
    stop++; generation = 1; phase = 'paused';
    pause = server ? { threadId: 'T1', eventId: String(stop * 10), generation, stack: [{ frame: 0 }, { frame: 1 }] }
      : { stop, generation, frame: 0, frames: [{ elementKey: 'A' }, { elementKey: 'B' }] };
    changed();
  };
  const current = request => server
    ? pause && request.threadId === pause.threadId && request.eventId === pause.eventId && request.generation === pause.generation
    : pause && request.stop === pause.stop && request.generation === pause.generation;
  const bump = () => { generation++; pause = { ...pause, generation }; changed(); return generation; };
  async function handler(request) {
    log.push(JSON.parse(JSON.stringify(request)));
    if (logPath) fs.appendFileSync(logPath, JSON.stringify(request) + '\n');
    if (hang && request.op === hang.op && !hung) { hung = true; await delay(hang.ms); }
    if (crash && request.op === crash.op) { crash.now(); return new Promise(() => {}); }
    if (refuse && request.op === refuse.op) { if (refuse.raw) throw new Error(refuse.raw); fail(refuse.code); }
    if (request.op === 'start') { context = request.run?.contextMode ?? 'app-user'; phase = 'preparing'; changed(); return snapshot(); }
    if (request.sessionId !== SESSION) fail('owner_unavailable');
    if (request.op === 'status') { advance(); return snapshot(); }
    if (request.op === 'stop') {
      if (!['completed', 'failed', 'uncertain'].includes(phase)) {
        // debug-client-session.mjs keeps the stop acknowledgement apart from the runner's completion.
        if (!server) stopEvidence = { command: 'stop', workerTerminationRequested: true, executionOutcome: 'requires-reconciliation', privateInspectionCleanup: { completed: true, pending: 0 } };
        phase = 'ending'; pause = null; changed();
      }
      return snapshot();
    }
    if (request.op === 'pause') { if (phase !== 'running' || request.afterRevision !== revision) fail('pause_requires_current_running_revision'); return { ok: true, sessionId: SESSION, pauseObserved: false }; }
    if (request.op === 'resume') { if (phase !== 'held' || request.afterRevision !== revision) fail('resume_stale_revision'); phase = 'running'; changed(); return { ok: true, sessionId: SESSION }; }
    if (request.op === 'private-compare') {
      if (!Array.isArray(request.handles) || request.handles.length < 2) fail('private_compare_invalid');
      // Like debug-private-compare.mjs: privateCompareHandle values only, never the DPAPI descriptor reference.
      if (request.handles.some(h => !/^pc_[0-9a-f]{32}$/.test(h))) fail('private_compare_handle_invalid');
      return { ok: true, sessionId: SESSION, equal: true, bothNonEmpty: true, sameNativeType: true };
    }
    if (!current(request)) fail(staleCode);
    if (steps[runtime].includes(request.op)) { pause = null; phase = 'running'; changed(); return { ok: true, sessionId: SESSION, generation: null }; }
    if (request.op === 'frame') return { ok: true, sessionId: SESSION, frame: request.frame, generation: bump() };
    if (request.op === 'scope') return { ok: true, sessionId: SESSION, generation: bump(), variables: [
      { name: 'Seed', ...(server ? { reference: 'a'.repeat(32) } : { ref: 'a'.repeat(48) }) },
      { name: 'Result', ...(server ? { reference: 'b'.repeat(32) } : { ref: 'b'.repeat(48) }) }] };
    if (request.op === 'read-many') {
      const refs = server ? request.references : request.refs;
      return { ok: true, sessionId: SESSION, generation, values: refs.map(ref => ({ [server ? 'reference' : 'ref']: ref, value: { type: 'Integer', value: 'visible-17' } })) };
    }
    if (request.op === 'private-read') return { ok: true, sessionId: SESSION, generation, privateValueReturnedPublicly: false,
      privateInspection: { reference: '00000000-0000-4000-8000-' + String(stop).padStart(12, '0'), sealed: true },
      ...(compareHandles ? { privateCompareHandle: 'pc_' + String(stop).padStart(32, '0') } : {}) };
    if (['read', 'refresh', 'read-scope', 'read-frame'].includes(request.op)) return { ok: true, sessionId: SESSION, generation };
    fail('unknown_op');
  }
  return { log, handler, sessionId: SESSION, receipt };
}

// The MCP wrapper used by ssam.mjs: structuredContent on success, text JSON on refusal.
export const mcpWrap = fn => async args => {
  try { const value = await fn(args); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok ? {} : { isError: true }) }; }
  catch (error) { return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message }) }], isError: true }; }
};

export async function createFakeMcpServer({ coordinators, tools = {} }) {
  const { McpServer, fromJsonSchema } = await import('@modelcontextprotocol/server');
  const server = new McpServer({ name: 'fake-ssam', version: '1' });
  const open = () => fromJsonSchema({ type: 'object' });
  for (const [runtime, coordinator] of Object.entries(coordinators))
    server.registerTool(runtime === 'server' ? 'ssam_debug_server' : 'ssam_debug_client', { inputSchema: open() }, mcpWrap(coordinator.handler));
  for (const [name, fn] of Object.entries(tools)) server.registerTool(name, { inputSchema: open() }, mcpWrap(fn));
  return server;
}
