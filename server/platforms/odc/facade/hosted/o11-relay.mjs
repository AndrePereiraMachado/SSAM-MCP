// The O11 bridge relay of one customer (docs/FASE2-AGENTE.md 4.6). The server's O11 kernel (BridgeClient, C#) and the
// facade's own bridge client speak the Service Studio bridge protocol to this loopback port as if the Studio were
// local: one JSON line {method, params, authorization} in, one line out. Each request goes to THIS customer's agent
// through call('o11.bridge'), and only with THIS customer's relay key (<ws>/state/relay-authority/bridge.key), compared
// in constant time: the server controller key (the one the owner's own Service Studio trusts) and another customer's
// relay key are refused, so a misrouted kernel or two relays swapping ports are never authenticated.
//   - Not delivered (executed:false, e.g. AGENT_NOT_CONNECTED): a refusal line with executed:false.
//   - Delivered with no result (the agent dropped, the deadline passed): the socket closes with NO reply, which the
//     kernel already treats as an unknown outcome and never repeats.
//   - A reply that arrives after the kernel gave up (socket closed) is dropped and logged as relay-late.
import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const digest = text => createHash('sha256').update(String(text), 'utf8').digest();
export const REFUSED_KEY = "Relay refused: not this customer's relay key";
// prazos B (2026-10-12): the time a relayed call may take on the agent, where the kernel's own budget is longer than the
// wire's default (timeoutFor: 120 s). The kernel's environment verbs and the delivery's producer authority wait 330 s for
// an environment_session reply (Anvil.Cli Program.cs, BridgeClient(port, 330)), and the full bridge has no cut of its own,
// so the local path gives each environment read 330 s; hosted, the agent cut the same read at 120 s. Sent as timeoutMs:
// the agent honors it (kinds.mjs o11Bridge, at most 1 h) and the hub adds its margin (agent-executor DEADLINES).
export const RELAY_BUDGET_MS = Object.freeze({ environment_session: 330000 });

export async function startRelay({ key, call, log = () => {}, host = '127.0.0.1', port = 0 }) {
  if (typeof key !== 'string' || !key) throw new Error("The relay needs this customer's relay key");
  if (typeof call !== 'function') throw new Error('The relay needs call(kind, params)');
  const expected = digest(key);
  const accepts = presented => typeof presented === 'string' && presented.length > 0 && timingSafeEqual(digest(presented), expected);
  const sockets = new Set();

  const server = net.createServer(socket => {
    sockets.add(socket);
    let closed = false, taken = false, size = 0;
    const chunks = [];
    socket.on('close', () => { closed = true; sockets.delete(socket); });
    socket.on('error', () => {});
    // One reply line; false when the client is already gone.
    const answer = value => {
      if (closed || socket.destroyed) return false;
      socket.end(JSON.stringify(value) + '\n');
      return true;
    };
    async function handle(text) {
      let request;
      try { request = JSON.parse(text); }
      catch { answer({ success: false, executed: false, error: 'Relay refused: malformed request' }); return; }
      if (!accepts(request?.authorization)) {
        log({ event: 'relay-refused' });
        answer({ success: false, executed: false, error: REFUSED_KEY });
        return;
      }
      const method = typeof request.method === 'string' ? request.method : '';
      try {
        const budget = Object.hasOwn(RELAY_BUDGET_MS, method) ? RELAY_BUDGET_MS[method] : null;
        const value = await call('o11.bridge', { method, params: request.params ?? {}, ...(budget ? { timeoutMs: budget } : {}) });
        const reply = value?.reply;
        // A delivered call without a bridge reply is an unknown outcome, never a made-up answer.
        if (!reply || typeof reply !== 'object') { log({ event: 'relay-unknown', method, code: 'NO_REPLY' }); socket.destroy(); return; }
        if (!answer(reply)) log({ event: 'relay-late', method });
      } catch (error) {
        if (error?.executed === false) {
          if (!answer({ success: false, executed: false, error: (error.code ?? 'AGENT_ERROR') + ': ' + error.message })) log({ event: 'relay-late', method });
        } else {
          log({ event: 'relay-unknown', method, code: error?.code ?? null });
          socket.destroy();
        }
      }
    }
    socket.on('data', chunk => {
      if (taken) return;
      size += chunk.length;
      if (size > MAX_LINE_BYTES) { taken = true; socket.destroy(); return; }
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) { chunks.push(chunk); return; }
      chunks.push(chunk.subarray(0, newline));
      taken = true;
      handle(Buffer.concat(chunks).toString('utf8').replace(/\r$/, ''));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  return {
    port: server.address().port,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}
