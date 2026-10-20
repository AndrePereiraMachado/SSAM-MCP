// SSAM server dashboard (owner request, 2026-10-08): licenses, open sessions, agents, live activity and access alerts of
// the hosted server, from what the server already writes (server.log, the token store's public view, machine-pins.json,
// access-alerts.jsonl). Loopback only (127.0.0.1), never shows a secret, never writes except a revoke the owner confirms.
//   node scripts\dashboard.mjs [--dir <server state dir>] [--port 7320]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const dir = path.resolve(arg('--dir', process.env.SSAM_SERVER_DIR ?? path.join(here, '..', '.local', 'server')));
const port = Number(arg('--port', 7320));
const { openTokenStore } = await import(new URL('../platforms/odc/facade/server-tokens.mjs', import.meta.url));
const store = await openTokenStore({ dir });
const logFile = path.join(dir, 'server.log');

// The log is read incrementally; the live state is replayed from the last "listening" (the running server process).
let offset = 0, carry = '', events = [];
function readLog() {
  let size; try { size = fs.statSync(logFile).size; } catch { return; }
  if (size < offset) { offset = 0; carry = ''; events = []; }
  if (size === offset) return;
  const fd = fs.openSync(logFile, 'r');
  const buf = Buffer.alloc(size - offset); fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd);
  offset = size;
  const text = carry + buf.toString('utf8'); const lines = text.split('\n'); carry = lines.pop();
  for (const line of lines) { if (!line.startsWith('{')) continue; try { events.push(JSON.parse(line)); } catch { /* partial */ } }
  if (events.length > 200000) events = events.slice(-100000);
}
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const readLines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

async function health() {
  try { const r = await fetch('http://127.0.0.1:7310/health', { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}

async function snapshot() {
  readLog();
  const start = events.findLastIndex(e => e.event === 'listening');
  const live = start >= 0 ? events.slice(start) : events;
  const today = new Date().toISOString().slice(0, 10);
  const names = {}; for (const e of events) if (e.token && e.customer) names[e.token] = e.customer;
  const sessions = new Map(), agents = new Map(), perToken = {};
  const stat = t => (perToken[t] ??= { calls: 0, failures: 0, lastAt: null, lastTool: null, sessionsToday: 0 });
  for (const e of events) {
    if (!e.token) continue;
    const s = stat(e.token);
    if (e.time?.startsWith(today)) {
      if (e.event === 'mcp-response-flushed') s.calls += (e.tools?.length ?? 1);
      if (e.event === 'agent-call' && e.ok === false) s.failures++;
      if (e.event === 'session-opened') s.sessionsToday++;
    }
    if (e.event === 'mcp-response-flushed' || e.event === 'session-opened' || e.event === 'agent-call') { s.lastAt = e.time; if (e.tools) s.lastTool = e.tools.join(', '); }
  }
  for (const e of live) {
    if (e.event === 'session-opened') sessions.set(e.session, { id: e.session, token: e.token, customer: e.customer ?? names[e.token] ?? e.token, openedAt: e.time, lastAt: e.time, ip: e.ip ?? null, client: e.client ?? null, calls: 0, lastTool: null });
    else if (e.event === 'session-closed') sessions.delete(e.session);
    else if (e.event === 'mcp-response-flushed' && sessions.has(e.session)) { const s = sessions.get(e.session); s.calls += e.tools?.length ?? 1; s.lastTool = e.tools?.join(', ') ?? s.lastTool; s.lastAt = e.time; }
    if (e.event === 'agent-connected' || e.event === 'agent-resumed') agents.set(e.token, { token: e.token, customer: names[e.token] ?? e.token, since: agents.get(e.token)?.since ?? e.time, version: e.agent ?? null, ip: e.ip ?? null, machine: e.machine ?? null, lastAt: e.time, online: true });
    else if (e.event === 'agent-channel-closed' || e.event === 'agent-dead') { const a = agents.get(e.token); if (a) { a.online = e.event === 'agent-channel-closed' && e.reason === 'ended' ? a.online : false; a.lastAt = e.time; } }
    else if (e.event === 'agent-stream-opened') { const a = agents.get(e.token); if (a) { a.online = true; a.lastAt = e.time; } }
    else if (e.event === 'agent-call') { const a = agents.get(e.token); if (a) a.lastAt = e.time; }
  }
  const pins = readJson(path.join(dir, 'machine-pins.json'), {});
  const alerts = readLines(path.join(dir, 'access-alerts.jsonl')).slice(-50).reverse();
  let tokens = []; try { tokens = store.list(); } catch { tokens = []; }
  const licenses = tokens.map(t => ({ ...t, machine: pins[t.id] ?? null, usage: perToken[t.id] ?? null,
    sessionsOpen: [...sessions.values()].filter(s => s.token === t.id).length, agentOnline: agents.get(t.id)?.online ?? false }))
    .sort((a, b) => (a.state === 'active' ? 0 : 1) - (b.state === 'active' ? 0 : 1) || String(b.usage?.lastAt ?? '').localeCompare(String(a.usage?.lastAt ?? '')));
  const activity = events.filter(e => e.event === 'mcp-response-flushed' || e.event === 'session-opened' || e.event === 'session-closed'
    || e.event === 'agent-connected' || e.event === 'agent-resumed' || e.event === 'agent-machine-changed' || (e.event === 'agent-call' && e.ok === false))
    .slice(-80).reverse().map(e => ({ time: e.time, event: e.event, customer: e.customer ?? names[e.token] ?? e.token ?? '', tools: e.tools?.join(', ') ?? null, ms: e.ms ?? null, kind: e.kind ?? null, code: e.code ?? null, reason: e.reason ?? null }));
  const listening = start >= 0 ? events[start] : null;
  return { now: new Date().toISOString(), server: { health: await health(), since: listening?.time ?? null, pid: listening?.pid ?? null },
    licenses, sessions: [...sessions.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)), agents: [...agents.values()], activity, alerts };
}

const page = fs.readFileSync(path.join(here, 'dashboard.html'), 'utf8');
http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(page); }
    if (req.method === 'GET' && req.url === '/api/state') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(await snapshot())); }
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const push = async () => res.write('data: ' + JSON.stringify(await snapshot()) + '\n\n');
      await push(); const timer = setInterval(() => push().catch(() => {}), 2000);
      return req.on('close', () => clearInterval(timer));
    }
    if (req.method === 'POST' && req.url === '/api/revoke') {
      // Same-origin only: the page sends this header; another site cannot set it on a simple request.
      if (req.headers['x-ssam-dashboard'] !== '1' || !String(req.headers.origin ?? 'http://127.0.0.1:' + port).startsWith('http://127.0.0.1:' + port)) { res.writeHead(403); return res.end(); }
      let body = ''; for await (const chunk of req) body += chunk;
      const { id } = JSON.parse(body || '{}');
      const out = await store.revoke(String(id));
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, revoked: out }));
    }
    res.writeHead(404); res.end();
  } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: error.message })); }
}).on('error', error => {
  if (error.code !== 'EADDRINUSE') throw error;
  console.log('O painel já está rodando: abra http://127.0.0.1:' + port + ' no navegador.');
  process.exit(0);
}).listen(port, '127.0.0.1', () => console.log('Painel SSAM: http://127.0.0.1:' + port + '  (estado: ' + dir + ')'));
