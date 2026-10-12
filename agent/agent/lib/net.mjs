// The agent's HTTP to its server (docs/FASE2-AGENTE.md 2.9), on node:http/node:https instead of the built-in fetch, for
// the three connection rules fetch does not let the agent set (fase4-24, production test of 2026-10-11: a 60 KB and a
// 75 KB result part took 26.8 s and 48.3 s while the owner's public IP changed behind a carrier-grade NAT; the same parts
// took 0.2 s a minute later):
//   - a pooled keep-alive connection idle for more than IDLE_REUSE_MS (2 s) is closed, never reused: one that went dead
//     while idle (new public IP) is not picked up by the next request;
//   - TCP keep-alive probes after KEEPALIVE_PROBE_MS (5 s) without traffic on every connection (Windows: 10 probes 1 s
//     apart), so a dead long-lived stream is reset by the system in about 15 s instead of waiting for the 45 s timer;
//   - `fresh: true` sends one request on a connection of its own, opened for it and closed after it, and any failed
//     request drops every idle pooled connection (they may sit on the same dead path).
// fetch(url, {method, headers, body, signal, fresh}) answers a standard Response, so the channel keeps the fetch API and
// tests can still inject their own fetch. Redirects are not followed (the server is https and never redirects /agent/v1);
// the body is not decompressed (accept-encoding: identity). Proxy: the same as fetch, from the runtime: with
// --use-env-proxy (ssam-agent.ps1) Node gives its global agents the environment's HTTPS_PROXY/NO_PROXY, and these
// agents take that same proxyEnv.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export const IDLE_REUSE_MS = 2000;
export const KEEPALIVE_PROBE_MS = 5000;
// The give-up rule of a request that carries data (C03 messages, blob parts): its base plus 1 s per 64 KiB (a floor of
// about 512 kbit/s on the customer's link).
export const BYTES_PER_SECOND = 65536;
export const deadlineMs = (bytes, base) => base + Math.ceil(Math.max(0, Number(bytes) || 0) / BYTES_PER_SECOND) * 1000;

const NO_BODY = new Set([204, 205, 304]);

export function createHttp({ idleMs = IDLE_REUSE_MS, probeMs = KEEPALIVE_PROBE_MS, proxyEnv } = {}) {
  const moduleOf = protocol => (protocol === 'https:' ? https : http);
  const proxyOf = protocol => (proxyEnv !== undefined ? proxyEnv : moduleOf(protocol).globalAgent?.options?.proxyEnv);
  const agentFor = (protocol, keepAlive) => {
    const proxy = proxyOf(protocol);
    return new (moduleOf(protocol).Agent)({ keepAlive, keepAliveMsecs: probeMs, scheduling: 'lifo',
      // `timeout` on a keep-alive agent: an idle pooled socket is destroyed after idleMs (Node's agent destroys a free
      // socket on its timeout; a socket in use only emits an event nobody listens to).
      ...(keepAlive ? { timeout: idleMs } : {}), ...(proxy ? { proxyEnv: proxy } : {}) });
  };
  const pools = new Map();
  const pool = protocol => { let agent = pools.get(protocol); if (!agent) { agent = agentFor(protocol, true); pools.set(protocol, agent); } return agent; };
  let opened = 0;

  // Every idle pooled connection is closed (a request just failed: the others may sit on the same dead path).
  function dropIdle() {
    for (const agent of pools.values()) for (const list of Object.values(agent.freeSockets)) for (const socket of [...(list ?? [])]) socket.destroy();
  }

  function fetch(input, init = {}) {
    const { method = 'GET', body, signal, fresh = false } = init;
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(String(input)); } catch (error) { reject(error); return; }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') { reject(new TypeError('Only http and https: ' + url.protocol)); return; }
      if (signal?.aborted) { reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError')); return; }
      const headers = {};
      for (const [name, value] of new Headers(init.headers ?? {})) headers[name] = value;
      headers['accept-encoding'] = 'identity';
      let payload = null;
      if (body !== undefined && body !== null) {
        payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.isBuffer(body) ? body : ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : null;
        if (!payload) { reject(new TypeError('Unsupported request body')); return; }
        headers['content-length'] = String(payload.length);
      }
      const single = fresh ? agentFor(url.protocol, false) : null;
      let settled = false;
      const fail = error => { dropIdle(); single?.destroy(); if (!settled) { settled = true; reject(error); } };
      let req;
      try { req = moduleOf(url.protocol).request(url, { method, headers, agent: single ?? pool(url.protocol), ...(signal ? { signal } : {}) }); }
      catch (error) { fail(error); return; }
      req.on('socket', socket => {
        socket.setKeepAlive(true, probeMs);
        if (!socket.ssamCounted) { socket.ssamCounted = true; opened++; }
      });
      req.on('error', fail);
      req.on('response', res => {
        res.on('error', () => { dropIdle(); });
        if (single) res.once('close', () => single.destroy());
        const replyHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const item of [].concat(value ?? [])) replyHeaders.append(name, String(item));
        const empty = NO_BODY.has(res.statusCode) || method === 'HEAD';
        if (empty) res.resume();
        let response;
        try { response = new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage ?? '', headers: replyHeaders }); }
        catch (error) { res.destroy(); fail(error); return; }
        settled = true;
        resolve(response);
      });
      req.end(payload ?? undefined);
    });
  }

  return {
    fetch,
    dropIdle,
    // Connections opened so far (tests, diagnostics).
    opened: () => opened,
    close() { for (const agent of pools.values()) agent.destroy(); pools.clear(); },
  };
}
