// A Node client of the O11 Service Studio bridge (kernel\src\Anvil.Bridge\Server.cs): JSON lines over loopback TCP,
// `{method, params, authorization}` in, `{success, data, error}` out. One connection per call, a reply cap and a
// timeout per command, so long verbs (open_module, merge_from_oml, publish) and large replies (get_errors, windows)
// fit, unlike the 2.5 s / 64 KiB health probe of studio-connect.mjs. Nothing here decides policy: callers do.
//
// The target comes from the lane's connection record (.local\connections\<lane>.json, written by ssam_connect):
// its port, pid and authorityDir. Without a record, the lane table port and the authority folder rules of
// o11-lane.mjs. No Python, no credential: the bridge key is the trusted-controller key, never a user secret.
import net from 'node:net';
import { readConnection } from './studio-session.mjs';
import { o11LaneOf, authorityKeyPath, readAuthorityKey } from './o11-lane.mjs';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { currentExecutor } from './executor.mjs';
import { registerBridgeFlight, FLIGHT_CAP_MS } from './studio-write-lock.mjs';

export const MAX_REPLY_BYTES = 100 * 1024 * 1024;
// Milliseconds a reply may take, per bridge method. The bridge bounds its own waits (open_module timeout <= 300 s,
// publish 300 s + 45 s settle, login 90 s, studio_login waitMs <= 60 s, close_module 30 s read + idle_timeout_ms + 30 s
// close, every UI step: UiGate.cs); the client adds a margin, as studio_env.py does.
const seconds = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback) * 1000;
export const TIMEOUTS = {
  ping: () => 5000, bridge_manifest: () => 5000, ui_alive: p => (p?.timeout_ms ?? 5000) + 5000,
  open_module: p => seconds(p?.timeout, 120) + 60000, close_module: p => 60000 + (Number(p?.idle_timeout_ms) || 30000) + 30000,
  snapshot_module: () => 300000, merge_from_oml: () => 900000, merge_status: () => 60000,
  get_errors: () => 300000, windows: () => 30000, close_dialog: () => 30000,
  publish: p => seconds(p?.timeout, 300) + 45000 + 60000, login: p => seconds(p?.timeout, 90) + 30000,
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
// UI freeze of 2026-10-08 (pattern 4): a request written to the bridge that times out or is cancelled is still running in
// the Studio. The caller gets its BRIDGE_TIMEOUT / CANCELLED at once, but the connection stays open, listening for the
// late answer, and the call is registered as in flight (studio-write-lock.mjs registerBridgeFlight, target.flight): no
// write of that Studio starts until the bridge answers, the Studio closes the connection or FLIGHT_CAP_MS passes.
export function bridgeRequest({ port, host = '127.0.0.1', authorization, maxBytes = MAX_REPLY_BYTES, flight }, method, params = {}, { timeoutMs, signal } = {}) {
  const limit = timeoutMs ?? timeoutFor(method, params);
  if (signal?.aborted) return Promise.reject(new BridgeError(`Bridge ${method} cancelled before it was sent`, { code: 'CANCELLED', method, executed: false }));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = []; let size = 0; let settled = false; let sent = false; let release = null; let cap = null;
    const close = () => { clearTimeout(cap); socket.destroy(); if (release) { const r = release; release = null; r(); } };
    // The caller is answered; a request already written keeps the socket (and its flight) until the late answer.
    const abandon = error => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort);
      if (!sent) { socket.destroy(); return reject(error); }
      try { release = flight ? flight(method, params) : null; } catch { release = null; }
      cap = setTimeout(close, FLIGHT_CAP_MS); cap.unref?.();
      socket.unref?.(); // a one-shot CLI still exits; its flight file then goes stale with its pid
      reject(error);
    };
    const finish = (error, value) => { if (settled) return close(); settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); close(); error ? reject(error) : resolve(value); };
    const onAbort = () => abandon(new BridgeError(`Bridge ${method} cancelled`, { code: 'CANCELLED', method, executed: sent ? undefined : false }));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    // executed:false only when nothing was written: a timeout after the request is an unknown outcome.
    const timer = setTimeout(() => abandon(new BridgeError(`Bridge ${method} timed out after ${limit} ms`, { code: 'BRIDGE_TIMEOUT', method, executed: sent ? undefined : false })), limit);
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
    socket.on('close', () => { if (settled) close(); });
  });
}

// The flight of a lane's Studio (bridgeTarget): the module of the call, never its other arguments.
const flightModule = params => {
  const name = typeof params?.name === 'string' ? params.name : typeof params?.module === 'string' ? params.module : null;
  const key = typeof params?.module_key === 'string' ? params.module_key : null;
  return name || key ? { name, key } : null;
};
export function flightOf({ lane, root, record }) {
  if (!Number.isSafeInteger(record?.pid)) return undefined;
  return (method, params) => registerBridgeFlight({ lane, root, record, method, module: flightModule(params) });
}

// Where the lane's bridge listens and which key it trusts. A record names the selected Studio; without one the
// lane table port is used (the bridge may not be there: the first call says so). Hosted: the relay port of the
// customer's record and no key (the agent puts its own); without a record O11_NOT_CONNECTED (o11-lane.mjs). The flight
// (pattern 4) applies in both: locally the late answer ends it (bridgeRequest); hosted it is keyed by the customer's
// record in the customer's <ws>/state/locks (studio-write-lock.mjs o11StudioLockDir) and ends at FLIGHT_CAP_MS, since the
// late answer stays on the customer's machine.
export function bridgeTarget({ lane = o11Lane.lane, root = anvilRoot, env = process.env } = {}) {
  const record = readConnection(root, lane);
  const port = Number.isInteger(record?.port) ? record.port : o11LaneOf(lane, { root, env }).bridge;
  if (currentExecutor().hosted) return { lane, port, pid: record?.pid ?? null, record, keyFile: null, authorization: null, flight: flightOf({ lane, root, record }) };
  return { lane, port, pid: record?.pid ?? null, record, keyFile: authorityKeyPath({ env, record }),
    authorization: readAuthorityKey({ env, record }), flight: flightOf({ lane, root, record }) };
}

// Hosted, a call whose outcome is unknown (timed out or cancelled after it was sent) may still run in the customer's
// Studio: it is registered as in flight for FLIGHT_CAP_MS, so no write of that Studio starts on this server meanwhile.
const UNKNOWN_OUTCOME = new Set(['BRIDGE_TIMEOUT', 'AGENT_TIMEOUT', 'CANCELLED']);
function hostedFlight(target, method, params, error) {
  if (typeof target?.flight !== 'function' || !UNKNOWN_OUTCOME.has(error?.code) || error?.executed === false) return;
  let release = null;
  try { release = target.flight(method, params); } catch { release = null; }
  if (release) { const cap = setTimeout(release, FLIGHT_CAP_MS); cap.unref?.(); }
}

// The client callers use: call() returns the reply; ok() returns data or throws a BridgeError with the bridge's code.
// Every request is the o11.bridge call of the executor seam: locally bridgeRequest on the target, hosted the customer's
// agent (no port and no key leave this server).
export function o11Bridge(target = bridgeTarget()) {
  const request = async (method, params, options) => {
    const executor = currentExecutor();
    if (!executor.hosted) {
      // Locally the flight and the cancellation reach bridgeRequest itself (it keeps listening for the late answer).
      const { reply } = await executor.call('o11.bridge', { method, params, timeoutMs: options?.timeoutMs, signal: options?.signal,
        port: target.port, host: target.host, authorization: target.authorization, maxBytes: target.maxBytes, flight: target.flight });
      return reply;
    }
    try {
      const { reply } = await executor.call('o11.bridge', { method, params: params ?? {}, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
      return reply;
    } catch (error) {
      hostedFlight(target, method, params, error);
      throw error;
    }
  };
  return {
    target,
    call: request,
    async ok(method, params = {}, options) {
      const reply = await request(method, params, options);
      if (reply?.success === true) return reply.data;
      const code = reply?.code ?? reply?.data?.code ?? (reply?.executed === false ? 'BRIDGE_REFUSED' : 'BRIDGE_ERROR');
      throw new BridgeError(reply?.error ?? reply?.data?.message ?? `Bridge ${method} failed`, { code, method, executed: reply?.executed, reply });
    },
  };
}
