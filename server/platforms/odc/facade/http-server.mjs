// The served mode of the SSAM MCP (docs/SERVIDOR-LOCAL.md, docs/FASE2-AGENTE.md): the SAME server that `ssam mcp`
// puts on stdio, now behind Streamable HTTP at /mcp. No tool code is forked: every client session gets its own server
// from the same factory (createSsamServer), so tools, schemas and instructions are those of stdio.
//   - Transport: WebStandardStreamableHTTPServerTransport of @modelcontextprotocol/server 2.0.0 (Web Request /
//     Response); this file only adapts node:http to it. One transport and one server per mcp-session-id. Idle SSE
//     responses get a ': keepalive' comment (only between events) so a tunnel or proxy keeps a long call open.
//   - Two modes. agents:{kernel} is the hosted mode: /agent/v1/* goes to the agent hub (agent-hub.mjs) and every
//     session gets {tokenId, customer, lanes, workspace, agent}. agents:false (the library default, `ssam serve
//     --local-studios`) is the owner-only phase-1 mode: the tools drive THIS machine's Studios, so it refuses
//     allowRemote and publicHosts at start and answers 403 FORWARDED_REFUSED to any request that came through a proxy.
//   - Bind: loopback only by default; any other address is refused unless allowRemote (hosted mode only). A tunnel on
//     this machine is the way out: publicHosts adds its host names to the accepted Host and https Origin values.
//   - Access: Authorization: Bearer <token> on every request (server-tokens.mjs). 401 missing/unknown, 403 revoked or
//     expired; a revoke closes the open sessions of that token. A session belongs to the token that opened it. An agent
//     credential never opens /mcp, an MCP token never opens /agent.
//   - Audit: one JSON line per tool call (time, token id, customer, tool, duration, ok/error code), never the
//     arguments nor the results. Rate limit per token with 429.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createTokenStore, AGENT_PREFIX } from './server-tokens.mjs';
import { createAgentHub } from './agent-hub.mjs';

export const DEFAULTS = Object.freeze({ host: '127.0.0.1', port: 7300, ratePerMinute: 240, maxSessionsPerToken: 8,
  maxBodyBytes: 16 * 1024 * 1024, idleMs: 60 * 60 * 1000, sweepMs: 500, keepaliveMs: 25000 });

export const isLoopback = host => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
export const REMOTE_REFUSAL = 'O servidor escuta só em loopback: o token viaja sem TLS. Use --host 127.0.0.1 (padrão) e exponha por um túnel '
  + 'ou proxy TLS nesta máquina com --public-host <nome> (docs/SERVIDOR-HTTPS.md). --allow-remote só no servidor hospedado, atrás de um proxy TLS que você controla.';
export const OWNER_ONLY_REFUSAL = 'o modo --local-studios dirige os Studios do PRÓPRIO dono e serve só esta máquina, em loopback. '
  + 'Para atender de fora use o servidor hospedado (ssam serve sem --local-studios; docs/SERVIDOR-HTTPS.md).';
// Headers a proxy or tunnel adds. In the owner-only mode their presence refuses the request (a safety net, not a guarantee).
export const FORWARDED_HEADERS = Object.freeze(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip', 'cf-ray']);

const toolName = name => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : '?';
const errorCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : null;
// The outcome of a tool call without any of its content: ok, or a symbolic error code.
export function outcomeOf(message) {
  if (message.error) return { ok: false, error: 'RPC_' + String(Math.abs(Number(message.error.code) || 0)) };
  const result = message.result ?? {};
  // C33: an answer with ok:false is a failure even without isError (a refusal some tools shape that way).
  if (!result.isError && result.structuredContent?.ok !== false) return { ok: true };
  const s = result.structuredContent ?? {};
  return { ok: false, error: errorCode(s.code) ?? errorCode(s.errorCode) ?? errorCode(s.reason) ?? 'TOOL_ERROR' };
}

function jsonError(res, status, code, message, headers = {}, data) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message, ...(data ? { data } : {}) }, id: null }));
}

// Start the server. createServer: (session) => Promise<McpServer> (the same factory as stdio), with session =
// {tokenId, customer, lanes, workspace: <dir>/customers/<tokenId>, agent: AgentLink | null}.
// Returns {url, port, host, sessions, hub, close}.
export async function startHttpServer({ createServer, dir, host = DEFAULTS.host, port = DEFAULTS.port, allowRemote = false,
  publicHosts = [], logFile = null, agents = false,
  ratePerMinute = DEFAULTS.ratePerMinute, maxSessionsPerToken = DEFAULTS.maxSessionsPerToken, maxBodyBytes = DEFAULTS.maxBodyBytes,
  idleMs = DEFAULTS.idleMs, sweepMs = DEFAULTS.sweepMs, keepaliveMs = DEFAULTS.keepaliveMs, log: sink = () => {}, now = () => new Date(),
  // observeCall(params, session) -> {finish(response)} | null: the friction record of stdio (facade/friction-boundary.mjs), per call.
  observeCall = null } = {}) {
  if (typeof createServer !== 'function') throw new Error('createServer is required');
  if (!dir) throw new Error('dir is required');
  const hosts = [...new Set((publicHosts ?? []).map(h => String(h).toLowerCase()))];
  if (!agents && allowRemote) throw new Error('Recusado: --allow-remote. ' + OWNER_ONLY_REFUSAL);
  if (!agents && hosts.length) throw new Error('Recusado: --public-host. ' + OWNER_ONLY_REFUSAL);
  if (!isLoopback(host) && !allowRemote) throw new Error('Recusado: --host ' + host + '. ' + REMOTE_REFUSAL);
  if (!Number.isInteger(ratePerMinute) || ratePerMinute < 1) throw new Error('ratePerMinute must be a positive integer');
  const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/server');
  fs.mkdirSync(dir, { recursive: true });
  if (logFile) fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
  // The events of the caller's log also go to the log file (scripts/servidor.ps1 starts the server without a console).
  const log = !logFile ? sink : event => {
    sink(event);
    try { fs.appendFileSync(logFile, JSON.stringify({ time: now().toISOString(), ...event }) + '\n'); } catch { /* the log never stops the server */ }
  };
  const store = createTokenStore(dir, { now });
  const hub = agents ? createAgentHub({ dir, store, kernel: agents.kernel, log, now, limits: agents.limits }) : null;
  const sessions = new Map(); // sid -> {tokenId, customer, served, server, transport, responses:Set, lastSeen, closing}
  const windows = new Map();  // tokenId -> {start, count}

  const audit = entry => {
    const time = now();
    const file = path.join(dir, 'audit-' + time.toISOString().slice(0, 10).replaceAll('-', '') + '.jsonl');
    try { fs.appendFileSync(file, JSON.stringify({ time: time.toISOString(), ...entry }) + '\n'); }
    catch (error) { log({ event: 'audit-failed', error: error.code ?? 'EIO' }); }
  };

  async function closeSession(sid, reason) {
    const session = sessions.get(sid);
    if (!session || session.closing) return;
    session.closing = true;
    sessions.delete(sid);
    log({ event: 'session-closed', session: sid, token: session.tokenId, reason });
    try { await session.server.close(); } catch { /* already closed */ }
    for (const res of session.responses) res.destroy();
  }

  // A revoked, expired or removed token loses its sessions at the next sweep; idle sessions are closed too.
  // (The agent hub sweeps its channels with its own timer.)
  const sweep = () => {
    const at = Date.now();
    for (const [sid, s] of sessions) {
      let state;
      try { state = store.stateOf(s.tokenId); } catch { state = 'unknown'; }
      if (state !== 'active') closeSession(sid, 'token-' + state);
      // A session with an open stream (a connected client, a running call) is never idle.
      else if (s.responses.size === 0 && at - s.lastSeen > idleMs) closeSession(sid, 'idle');
    }
  };
  const timer = setInterval(sweep, sweepMs); timer.unref();

  function allowedHost(header, actualPort) {
    if (allowRemote) return true;
    const value = String(header ?? '').toLowerCase();
    return ['127.0.0.1', 'localhost', '[::1]'].some(h => value === h + ':' + actualPort)
      || hosts.some(h => value === h || value === h + ':443');
  }
  const allowedOrigin = (origin, actualPort) => origin === undefined
    || ['http://127.0.0.1:', 'http://localhost:', 'http://[::1]:'].some(p => origin === p + actualPort)
    || hosts.some(h => origin === 'https://' + h);

  function rateLimited(tokenId) {
    const at = Date.now();
    const w = windows.get(tokenId);
    if (!w || at - w.start >= 60000) { windows.set(tokenId, { start: at, count: 1 }); return 0; }
    w.count++;
    return w.count > ratePerMinute ? Math.ceil((w.start + 60000 - at) / 1000) : 0;
  }

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) return { tooLarge: true };
      chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks) };
  }

  // node:http -> Web Request -> transport -> Web Response -> node:http. The Authorization header never reaches the transport.
  async function relay(session, req, res, body, parsedBody) {
    // C03: when the answer of a tool call left this server (the last byte written to the socket), with its time since the
    // request arrived: a client that waited 60 s for an answer the server flushed at once points at the tunnel, not here.
    const started = performance.now();
    const calls = [parsedBody].flat().filter(m => m?.method === 'tools/call').map(m => toolName(m.params?.name));
    let bytes = 0;
    const flushed = () => { if (calls.length) log({ event: 'mcp-response-flushed', session: req.headers['mcp-session-id'] ?? null, token: session.tokenId, tools: calls, bytes, ms: Math.round(performance.now() - started) }); };
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (k !== 'authorization') for (const x of [v].flat()) headers.append(k, x);
    const request = new Request('http://' + (req.headers.host ?? 'localhost') + req.url, {
      method: req.method, headers, ...(body && body.length && req.method === 'POST' ? { body } : {}) });
    const response = await session.transport.handleRequest(request, parsedBody !== undefined ? { parsedBody } : undefined);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (!response.body) { res.end(flushed); return; }
    res.flushHeaders();
    session.responses.add(res);
    const reader = response.body.getReader();
    // SSE keepalive: after keepaliveMs without a write, a comment line, and only where an event ended ("\n\n").
    const sse = /^text\/event-stream/i.test(response.headers.get('content-type') ?? '');
    let tail = '\n\n', keepalive = null;
    const arm = () => {
      if (!sse) return;
      clearTimeout(keepalive);
      keepalive = setTimeout(() => { if (tail === '\n\n' && !res.writableEnded) res.write(': keepalive\n\n'); arm(); }, keepaliveMs);
      keepalive.unref?.();
    };
    res.on('close', () => { clearTimeout(keepalive); session.responses.delete(res); reader.cancel().catch(() => {}); });
    arm();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        bytes += value?.length ?? 0;
        if (value?.length) tail = (tail + Buffer.from(value.subarray(-2)).toString('latin1')).slice(-2);
        arm();
      }
    } catch { /* stream cancelled: client gone or session closed */ }
    clearTimeout(keepalive);
    session.responses.delete(res);
    res.end(flushed);
  }

  // Access trail (owner test, 2026-10-08): where a session comes from. Behind the tunnel the first x-forwarded-for hop is
  // the client; the MCP client names itself in initialize.clientInfo.
  function accessOf(req, body) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const info = [body].flat().find(m => m?.method === 'initialize')?.params?.clientInfo;
    return { ip: (forwarded || req.socket?.remoteAddress || '').slice(0, 64), ua: String(req.headers['user-agent'] ?? '').slice(0, 120),
      client: info ? (String(info.name ?? '') + ' ' + String(info.version ?? '')).trim().slice(0, 80) : null };
  }

  async function openSession(auth, access = {}) {
    const pending = new Map(); // JSON-RPC id -> {tool, start}
    let sid;
    const served = { tokenId: auth.id, customer: auth.customer, lanes: auth.lanes ?? [], workspace: path.join(dir, 'customers', auth.id),
      agent: hub ? hub.link(auth.id) : null };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => { sid = id; sessions.set(id, session); log({ event: 'session-opened', session: id, token: auth.id, customer: auth.customer, ...access }); },
      onsessionclosed: id => { setImmediate(() => closeSession(id, 'client-delete')); },
    });
    const session = { tokenId: auth.id, customer: auth.customer, served, transport, server: null, responses: new Set(), lastSeen: Date.now(), closing: false };
    // Audit hooks, set before connect (Protocol.connect chains them): the request names the tool, the response its outcome.
    transport.onmessage = message => {
      if (message?.method !== 'tools/call' || message.id === undefined) return;
      let observer = null;
      try { observer = observeCall?.(message.params ?? {}, served) ?? null; } catch { /* the observer never changes the call */ }
      pending.set(message.id, { tool: toolName(message.params?.name), start: performance.now(), observer });
    };
    transport.onclose = () => { if (sid) closeSession(sid, 'transport-closed'); };
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (message && message.id !== undefined && pending.has(message.id) && ('result' in message || 'error' in message)) {
        const call = pending.get(message.id); pending.delete(message.id);
        audit({ token: auth.id, customer: auth.customer, tool: call.tool, ms: Math.round(performance.now() - call.start), ...outcomeOf(message) });
        try { call.observer?.finish(message); } catch { /* idem */ }
      }
      return send(message, options);
    };
    session.server = await createServer(served);
    await session.server.connect(transport);
    return session;
  }

  async function handle(req, res) {
    const actualPort = server.address().port;
    const url = new URL(req.url, 'http://localhost');
    // Routing reads the raw path: no percent-decoding and no dot-segment folding decides where a request goes.
    const rawPath = String(req.url ?? '').split('?')[0];
    if (!allowedHost(req.headers.host, actualPort)) return jsonError(res, 403, -32000, 'Host not allowed');
    if (!allowedOrigin(req.headers.origin, actualPort)) return jsonError(res, 403, -32000, 'Origin not allowed');
    if (!hub && FORWARDED_HEADERS.some(h => req.headers[h] !== undefined))
      return jsonError(res, 403, -32000, 'FORWARDED_REFUSED: this server drives the owner\'s own Studios (--local-studios) and refuses requests that came through a proxy or tunnel.', {}, { code: 'FORWARDED_REFUSED' });
    if (rawPath === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, pid: process.pid })); return; }
    if (rawPath === '/agent' || rawPath.startsWith('/agent/')) {
      if (hub && await hub.handle(req, res, url)) return;
      return jsonError(res, 404, -32000, 'Not found');
    }
    if (rawPath !== '/mcp') return jsonError(res, 404, -32000, 'Not found');

    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!bearer) return jsonError(res, 401, -32001, 'Missing bearer token', { 'www-authenticate': 'Bearer realm="ssam"' });
    if (bearer.startsWith(AGENT_PREFIX)) return jsonError(res, 401, -32001, 'An agent credential is not an MCP token', { 'www-authenticate': 'Bearer realm="ssam", error="invalid_token"' });
    let auth;
    try { auth = store.verify(bearer); } catch (error) { log({ event: 'tokens-unreadable' }); return jsonError(res, 500, -32603, 'Token store unavailable'); }
    if (auth.status === 'unknown') return jsonError(res, 401, -32001, 'Unknown token', { 'www-authenticate': 'Bearer realm="ssam", error="invalid_token"' });
    if (auth.status !== 'ok') {
      for (const [sid, s] of sessions) if (s.tokenId === auth.id) closeSession(sid, 'token-' + auth.status);
      return jsonError(res, 403, -32003, auth.status === 'revoked' ? 'Token revoked' : 'Token expired');
    }
    const retry = rateLimited(auth.id);
    if (retry) return jsonError(res, 429, -32029, 'Rate limit: ' + ratePerMinute + ' requests per minute', { 'retry-after': String(retry) });

    const read = req.method === 'POST' ? await readBody(req) : { body: undefined };
    if (read.tooLarge) return jsonError(res, 413, -32000, 'Request body too large');
    let parsedBody;
    if (read.body?.length) {
      try { parsedBody = JSON.parse(read.body.toString('utf8')); } catch { return jsonError(res, 400, -32700, 'Parse error'); }
    }
    const sid = req.headers['mcp-session-id'];
    if (sid) {
      const session = sessions.get(String(sid));
      // A session of another token is as unknown as one that never existed.
      if (!session || session.tokenId !== auth.id) return jsonError(res, 404, -32001, 'Session not found');
      session.lastSeen = Date.now();
      return relay(session, req, res, read.body, parsedBody);
    }
    const initialize = [parsedBody].flat().some(m => m?.method === 'initialize');
    if (req.method !== 'POST' || !initialize) return jsonError(res, 400, -32000, 'Bad Request: no session id; start with initialize');
    // At the session limit, a client that reconnects without DELETE replaces its oldest session with no open stream.
    const own = [...sessions].filter(([, s]) => s.tokenId === auth.id);
    if (own.length >= maxSessionsPerToken) {
      const stale = own.filter(([, s]) => s.responses.size === 0).sort(([, x], [, y]) => x.lastSeen - y.lastSeen)[0];
      if (!stale) return jsonError(res, 429, -32029, 'Too many open sessions for this token (' + maxSessionsPerToken + ')');
      await closeSession(stale[0], 'replaced');
    }
    const session = await openSession(auth, accessOf(req, parsedBody));
    await relay(session, req, res, read.body, parsedBody);
    // An initialize the transport refused never became a session: its server is released at once.
    if (![...sessions.values()].includes(session)) await session.server.close().catch(() => {});
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => { log({ event: 'request-failed', error: error.code ?? error.name }); jsonError(res, 500, -32603, 'Internal error'); });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  } catch (error) { clearInterval(timer); await hub?.close(); throw error; }
  const actual = server.address();
  const shownHost = actual.family === 'IPv6' ? '[' + actual.address + ']' : actual.address;
  log({ event: 'listening', url: 'http://' + shownHost + ':' + actual.port + '/mcp', mode: hub ? 'hosted' : 'local-studios', pid: process.pid,
    ratePerMinute, maxSessionsPerToken, ...(hosts.length ? { publicHosts: hosts } : {}) });
  return {
    url: 'http://' + shownHost + ':' + actual.port + '/mcp', port: actual.port, host: actual.address, sessions, hub,
    async close() {
      clearInterval(timer);
      await hub?.close();
      await Promise.all([...sessions.keys()].map(sid => closeSession(sid, 'server-stop')));
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

const USAGE = 'Usage: ssam serve [--port 7300] [--host 127.0.0.1] [--public-host <nome>]... [--log-file <arquivo>] [--local-studios] [--allow-remote] [--rate-per-minute N] [--max-sessions N]';
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// `ssam serve` arguments. --public-host (repeatable) adds a host name a tunnel or proxy on this machine answers for;
// --local-studios is the owner-only mode and never goes with --public-host or --allow-remote.
export function parseServeArguments(args, env = process.env) {
  const known = new Set(['--port', '--host', '--rate-per-minute', '--max-sessions', '--public-host', '--log-file']);
  const out = { host: DEFAULTS.host, port: Number(env.SSAM_SERVER_PORT ?? DEFAULTS.port), allowRemote: false,
    ratePerMinute: Number(env.SSAM_SERVER_RATE_PER_MINUTE ?? DEFAULTS.ratePerMinute), maxSessionsPerToken: DEFAULTS.maxSessionsPerToken,
    publicHosts: [], logFile: null, localStudios: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--allow-remote') { out.allowRemote = true; continue; }
    if (a === '--local-studios') { out.localStudios = true; continue; }
    if (!known.has(a) || args[i + 1] === undefined) throw new Error(USAGE);
    const v = args[++i];
    if (a === '--host') out.host = v;
    else if (a === '--port') out.port = Number(v);
    else if (a === '--rate-per-minute') out.ratePerMinute = Number(v);
    else if (a === '--public-host') {
      const name = String(v).trim().toLowerCase();
      if (!HOST_NAME.test(name)) throw new Error('Invalid --public-host: ' + v + ' (a host name such as ssam.example.com, without scheme or port)');
      if (!out.publicHosts.includes(name)) out.publicHosts.push(name);
    }
    else if (a === '--log-file') out.logFile = path.resolve(v);
    else out.maxSessionsPerToken = Number(v);
  }
  for (const [k, v] of Object.entries({ port: out.port, ratePerMinute: out.ratePerMinute, maxSessionsPerToken: out.maxSessionsPerToken }))
    if (!Number.isInteger(v) || v < (k === 'port' ? 0 : 1) || (k === 'port' && v > 65535)) throw new Error('Invalid ' + k + ': ' + v);
  if (out.localStudios && (out.publicHosts.length || out.allowRemote))
    throw new Error('Recusado: --local-studios com ' + (out.publicHosts.length ? '--public-host' : '--allow-remote') + '. ' + OWNER_ONLY_REFUSAL);
  return out;
}
