// A persistent JSON-lines transport for the same interactive tools used by MCP.
// The owner stays alive across commands; it never reconstructs or replays a run.
import readline from 'node:readline';
import { debugRunToolSchema } from './debug-run.mjs';
import { registerServerSessionTool } from './debug-server-session.mjs';
import { registerClientSessionTool } from './debug-client-session.mjs';

const terminal = value => ['completed', 'failed', 'uncertain'].includes(value?.state);
const errorCode = error => /^debug_[a-z0-9_:.@-]+$/i.test(error?.message ?? '')
  ? error.message : 'debug_inspection_cli_invalid_request';

export function inspectionHandler(runtime) {
  let handler;
  const registry = { registerTool(_name, _metadata, callback) { handler = callback; } };
  const register = runtime === 'server' ? registerServerSessionTool
    : runtime === 'client' ? registerClientSessionTool : null;
  if (!register) throw new Error('debug_inspection_cli_invalid_runtime');
  register(registry, debugRunToolSchema, callback => callback);
  return handler;
}

export async function runInspectionCli({ runtime, lane, input = process.stdin, output = process.stdout,
  handler = inspectionHandler(runtime), cleanupMs = 60000 } = {}) {
  const sessions = new Set(), seen = new Set();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let outputUnavailable = false;
  const outputFailed = () => { outputUnavailable = true; lines.close(); };
  output.on('error', outputFailed);
  const write = async value => {
    if (outputUnavailable || output.destroyed) { outputUnavailable = true; return; }
    await new Promise(resolve => {
      try { output.write(JSON.stringify(value) + '\n', error => { if (error) outputFailed(); resolve(); }); }
      catch { outputFailed(); resolve(); }
    });
  };
  try {
    for await (const line of lines) {
      let id = null;
      try {
        if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error('debug_inspection_cli_request_too_large');
        const envelope = JSON.parse(line);
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
          || Object.keys(envelope).some(k => !['id', 'request'].includes(k))
          || typeof envelope.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(envelope.id)
          || !envelope.request || typeof envelope.request !== 'object' || Array.isArray(envelope.request))
          throw new Error('debug_inspection_cli_invalid_envelope');
        id = envelope.id;
        if (seen.has(id)) throw new Error('debug_inspection_cli_duplicate_id');
        seen.add(id);
        const request = envelope.request;
        if (lane && request.run?.lane && lane !== request.run.lane) throw new Error('debug_run_lane_mismatch');
        const effective = lane && request.run ? { ...request, run: { ...request.run, lane } } : request;
        const result = await handler(effective);
        if (request.op === 'start' && result.ok && result.sessionId) sessions.add(result.sessionId);
        if (terminal(result)) sessions.delete(result.sessionId);
        await write({ id, result });
      } catch (error) {
        await write({ id, result: { ok: false, error: errorCode(error) } });
      }
      // A lost output channel cancels ownership. Do not accept more commands
      // whose replies the client cannot observe, especially another start.
      if (outputUnavailable) break;
    }
  } finally {
    lines.close();
    // EOF is cancellation, not a successful action result. The coordinator owns
    // native stop deduplication and the runner owns response/credential cleanup.
    try { for (const sessionId of sessions) {
      let state;
      try {
        state = await handler({ op: 'stop', sessionId });
        const deadline = Date.now() + cleanupMs;
        while (!terminal(state) && Date.now() < deadline) {
          state = await handler({ op: 'status', sessionId, afterRevision: state.revision,
            waitMs: Math.min(10000, Math.max(1, deadline - Date.now())) });
        }
      } catch (error) { state = { ok: false, error: errorCode(error) }; }
      await write({ id: null, event: 'owner-closing', sessionId,
        terminalObserved: terminal(state), result: state });
    } } finally { output.removeListener('error', outputFailed); }
  }
}
