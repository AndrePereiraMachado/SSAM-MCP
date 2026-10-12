import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { hostedContext } from '../../facade/executor.mjs';

const refused = () => Object.assign(new Error('Private HTTP session handoff did not complete; no session value is exposed.'), { code: 'PRIVATE_CONTEXT_UNAVAILABLE' });
// servidor/fase4-24 (R3): the handoff is a pipe of the machine that runs SSAM to a bridge on the same machine. Hosted, the
// bridge is on the user's machine: the pipe is never opened and the session never leaves this process.
export const hostedHandoffRefusal = () => Object.assign(new Error('The private HTTP session handoff is a local pipe of the machine that runs SSAM; it is never used in hosted mode, '
  + 'where only the session of the user\'s own Studio is a path. Nothing was sent.'), { code: 'HOSTED_STUDIO_SESSION_ONLY', sent: false, executed: false });
const pause = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
});

// This is private in-process plumbing, never a model-facing tool argument. Only
// a current-user-only server inside the native bridge receives the session. The
// public request and journal carry a hash and a random pipe id, never headers.
export function privateContext(scope, now = new Date()) {
  const { host, principal, requestSha256, cookie, csrf = '' } = scope;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host ?? '')
      || typeof principal !== 'string' || !principal.trim() || !/^[a-f0-9]{64}$/.test(requestSha256 ?? '')
      || typeof cookie !== 'string' || !cookie || cookie.length > 48000
      || typeof csrf !== 'string' || csrf.length > 4096 || /[\x00-\x1f\x7f]/.test(cookie + csrf)) throw refused();
  const bytes = Buffer.from(JSON.stringify({ schema: 'ssam-private-http-context/1', requestSha256, host, principal,
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30000).toISOString(), cookie, csrf }));
  if (bytes.length > 65536) { bytes.fill(0); throw refused(); }
  return bytes;
}

async function sendOnce(pipe, bytes, signal, connect, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const outcome = await new Promise(resolve => {
      let connected = false, settled = false;
      const socket = connect(pipe);
      const finish = result => { if (settled) return; settled = true; signal.removeEventListener('abort', aborted); socket.destroy(); resolve(result); };
      const aborted = () => finish('cancelled');
      signal.addEventListener('abort', aborted, { once: true });
      socket.setTimeout(Math.max(1, deadline - Date.now()), () => finish('failed'));
      socket.once('connect', () => {
        connected = true;
        const prefix = Buffer.alloc(4); prefix.writeInt32LE(bytes.length);
        socket.write(prefix); socket.end(bytes, () => finish('sent'));
      });
      socket.once('error', error => finish(!connected && ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'not-ready' : 'failed'));
      socket.once('close', () => finish(connected ? 'failed' : 'not-ready'));
    });
    if (outcome === 'sent') return;
    if (outcome !== 'not-ready') throw refused();
    // Retries only connection establishment before any context byte is sent.
    // There is exactly one bridge invocation and no HTTP retry here.
    await pause(25, signal);
  }
  throw refused();
}

export async function withPrivateSessionHandoff(scope, invoke, {
  connect = pipe => net.createConnection(pipe), timeoutMs = 15000, platform = process.platform,
} = {}) {
  if (hostedContext()) throw hostedHandoffRefusal();
  if (platform !== 'win32' || typeof invoke !== 'function') throw refused();
  const bytes = privateContext(scope);
  const pipeId = randomUUID(), controller = new AbortController();
  let delivered = false;
  const transfer = sendOnce('\\\\.\\pipe\\SSAM-PrivateHttp-' + pipeId, bytes, controller.signal, connect, timeoutMs)
    .then(() => { delivered = true; }).catch(() => {});
  try {
    // Always await the bridge's authoritative result, including when IPC fails:
    // lack of a local acknowledgement cannot establish whether HTTP was sent.
    const result = await invoke(pipeId);
    controller.abort(); await transfer;
    if (!delivered && result?.ok === true) throw Object.assign(refused(), { code: 'PRIVATE_CONTEXT_OUTCOME_UNCERTAIN', sent: true });
    return result;
  } finally { controller.abort(); await transfer; bytes.fill(0); }
}
