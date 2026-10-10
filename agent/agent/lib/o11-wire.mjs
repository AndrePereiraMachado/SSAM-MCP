// A copy of the O11 bridge wire client of platforms/odc/facade/o11-bridge.mjs (bridgeRequest, BridgeError, TIMEOUTS,
// timeoutFor, MAX_REPLY_BYTES; frozen there for every lane, docs/FASE2-AGENTE.md 10.2). The agent never imports from
// platforms/: the block between the markers is kept byte-equal to the facade's (agent/tests/drift.test.mjs).
import net from 'node:net';

// ---- begin copy of o11-bridge.mjs
export const MAX_REPLY_BYTES = 100 * 1024 * 1024;
// Milliseconds a reply may take, per bridge method. The bridge bounds its own waits (open_module timeout <= 300 s,
// publish 300 s, login 90 s, studio_login waitMs <= 60 s); the client adds a margin, as studio_env.py does.
const seconds = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback) * 1000;
export const TIMEOUTS = {
  ping: () => 5000, bridge_manifest: () => 5000, ui_alive: p => (p?.timeout_ms ?? 5000) + 5000,
  open_module: p => seconds(p?.timeout, 120) + 60000, close_module: () => 120000,
  snapshot_module: () => 300000, merge_from_oml: () => 900000, merge_status: () => 60000,
  get_errors: () => 300000, windows: () => 30000, close_dialog: () => 30000,
  publish: p => seconds(p?.timeout, 300) + 60000, login: p => seconds(p?.timeout, 90) + 30000,
  studio_login: p => (Number(p?.waitMs) || 3000) + 30000, sc_session: () => 60000,
  sc_api: () => 300000, sc_web: () => 300000, export_modules: () => 900000,
  // The native Refresh References downloads each producer signature through the Studio's own login.
  refresh_references: p => seconds(p?.timeout, 600) + 60000,
};
export const timeoutFor = (method, params) => (TIMEOUTS[method] ?? (() => 120000))(params);

export class BridgeError extends Error {
  constructor(message, { code, method, executed, reply } = {}) {
    super(message); this.name = 'BridgeError'; this.code = code; this.method = method; this.executed = executed; this.reply = reply;
  }
}

// One request on its own connection. Resolves with the bridge reply object; rejects only for transport failures
// (refused, timeout, malformed or oversize reply) and for a cancellation (signal, code CANCELLED: the caller stops
// waiting; a request already written keeps running in the Studio, so its outcome is unknown). A refusal by the bridge
// is a reply with success:false.
export function bridgeRequest({ port, host = '127.0.0.1', authorization, maxBytes = MAX_REPLY_BYTES }, method, params = {}, { timeoutMs, signal } = {}) {
  const limit = timeoutMs ?? timeoutFor(method, params);
  if (signal?.aborted) return Promise.reject(new BridgeError(`Bridge ${method} cancelled before it was sent`, { code: 'CANCELLED', method, executed: false }));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = []; let size = 0; let settled = false; let sent = false;
    const onAbort = () => finish(new BridgeError(`Bridge ${method} cancelled`, { code: 'CANCELLED', method, executed: sent ? undefined : false }));
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); socket.destroy(); error ? reject(error) : resolve(value); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    // executed:false only when nothing was written: a timeout after the request is an unknown outcome.
    const timer = setTimeout(() => finish(new BridgeError(`Bridge ${method} timed out after ${limit} ms`, { code: 'BRIDGE_TIMEOUT', method, executed: sent ? undefined : false })), limit);
    socket.on('error', error => finish(new BridgeError(error.message, { code: error.code === 'ECONNREFUSED' ? 'BRIDGE_NOT_LISTENING' : 'BRIDGE_TRANSPORT', method, executed: sent ? undefined : false })));
    socket.on('connect', () => { socket.write(JSON.stringify({ method, params, ...(authorization ? { authorization } : {}) }) + '\n'); sent = true; });
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) return finish(new BridgeError(`Bridge ${method} reply exceeded ${maxBytes} bytes`, { code: 'BRIDGE_REPLY_TOO_LARGE', method }));
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) { chunks.push(chunk); return; }
      chunks.push(chunk.subarray(0, newline));
      let reply;
      try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return finish(new BridgeError('Unexpected service on the bridge port', { code: 'BRIDGE_PROTOCOL', method })); }
      finish(null, reply);
    });
    socket.on('end', () => finish(new BridgeError(`Bridge closed ${method} without a reply`, { code: 'BRIDGE_NO_REPLY', method })));
  });
}
// ---- end copy of o11-bridge.mjs
