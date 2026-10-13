// The served mode (http-server.mjs, server-tokens.mjs; docs/SERVIDOR-LOCAL.md): bearer tokens (401/403), rate limit
// (429), revoke closes a live session, loopback-only bind, no plaintext token on disk, audit lines without arguments,
// /health with the pid, --public-host, the owner-only mode (--local-studios: start refusals, FORWARDED_REFUSED), SSE
// keepalive, the session handed to createServer, and the real `ssam serve --local-studios` listing exactly the tools
// of `ssam mcp` and answering a read-only tool end to end.
// No tool here reaches a Studio: the fake server has none, and the real one is only listed and asked ssam_discover.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startHttpServer, parseServeArguments, outcomeOf } from '../http-server.mjs';
import { createTokenStore, tokenCli } from '../server-tokens.mjs';

const workspace = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-http-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => { const d = path.join(tmp, 'dir' + (++n)); fs.mkdirSync(d); return d; };
const SECRET = 'TOPSECRET-arg-4711';

// A fake MCP server: one tool that echoes its argument, one that refuses with a code. No Studio, no lane.
async function fakeServer() {
  const server = new McpServer({ name: 'fake', version: '1.0.0' }, { instructions: 'fake' });
  server.registerTool('echo_tool', { description: 'echo', inputSchema: fromJsonSchema({ type: 'object', properties: { text: { type: 'string' } } }) },
    async ({ text }) => ({ content: [{ type: 'text', text: 'got ' + text }] }));
  server.registerTool('fail_tool', { description: 'fails', inputSchema: fromJsonSchema({ type: 'object', properties: { text: { type: 'string' } } }) },
    async ({ text }) => ({ content: [{ type: 'text', text: 'no ' + text }], structuredContent: { ok: false, code: 'PREFLIGHT_REFUSED', error: 'no ' + text }, isError: true }));
  return server;
}
async function start(options = {}) {
  const dir = options.dir ?? freshDir();
  const handle = await startHttpServer({ createServer: fakeServer, dir, port: 0, sweepMs: 50, ...options });
  return { handle, dir, store: createTokenStore(dir) };
}
async function connect(url, token) {
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  return client;
}
const post = (url, headers, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body ?? { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) });
const waitFor = async (check, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };

test('no token or an unknown token is 401; a revoked or expired token is 403', async () => {
  let clock = new Date();
  const { handle, store } = await start({ now: () => clock });
  try {
    const none = await post(handle.url, {});
    assert.equal(none.status, 401); assert.match(none.headers.get('www-authenticate'), /^Bearer/);
    assert.equal((await post(handle.url, { authorization: 'Bearer ssam_' + 'A'.repeat(43) })).status, 401);
    assert.equal((await post(handle.url, { authorization: 'Basic abc' })).status, 401);
    const revoked = store.issue({ customer: 'Revogado' }); store.revoke(revoked.id);
    const r403 = await post(handle.url, { authorization: 'Bearer ' + revoked.token });
    assert.equal(r403.status, 403); assert.match((await r403.json()).error.message, /revoked/);
    const expiring = store.issue({ customer: 'Expira', days: 1 });
    assert.equal((await post(handle.url, { authorization: 'Bearer ' + expiring.token })).status, 200);
    clock = new Date(Date.now() + 2 * 86400000);
    const expired = await post(handle.url, { authorization: 'Bearer ' + expiring.token });
    assert.equal(expired.status, 403); assert.match((await expired.json()).error.message, /expired/);
  } finally { await handle.close(); }
});

test('the rate limit per token answers 429 with Retry-After', async () => {
  const { handle, store } = await start({ ratePerMinute: 3 });
  try {
    const { token } = store.issue({ customer: 'Rapido' });
    const other = store.issue({ customer: 'Outro' }).token;
    for (let i = 0; i < 3; i++) assert.equal((await fetch(handle.url, { headers: { authorization: 'Bearer ' + token } })).status, 400); // no session: counted, refused
    const limited = await fetch(handle.url, { headers: { authorization: 'Bearer ' + token } });
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await fetch(handle.url, { headers: { authorization: 'Bearer ' + other } })).status, 400, 'another token has its own budget');
  } finally { await handle.close(); }
});

test('at the session limit a reconnect replaces the oldest session without an open stream', async () => {
  const { handle, store } = await start({ maxSessionsPerToken: 2 });
  try {
    const { token } = store.issue({ customer: 'Reconecta' });
    const ids = [];
    for (let i = 0; i < 3; i++) { const r = await post(handle.url, { authorization: 'Bearer ' + token }); assert.equal(r.status, 200); await r.text(); ids.push(r.headers.get('mcp-session-id')); }
    assert.deepEqual([...handle.sessions.keys()].sort(), ids.slice(1).sort());
  } finally { await handle.close(); }
});

test('revoking a token answers 403 at once and closes its open sessions, live stream included', async () => {
  const { handle, store } = await start();
  try {
    const a = store.issue({ customer: 'Alfa' }), b = store.issue({ customer: 'Beta' });
    const client = await connect(handle.url, a.token);
    const keep = await connect(handle.url, b.token);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['echo_tool', 'fail_tool']);
    assert.equal(handle.sessions.size, 2);
    // A second, raw session of token A whose standalone SSE stream stays open until the revoke.
    const opened = await post(handle.url, { authorization: 'Bearer ' + a.token });
    assert.equal(opened.status, 200); await opened.text();
    const sid = opened.headers.get('mcp-session-id');
    assert.equal((await post(handle.url, { authorization: 'Bearer ' + a.token, 'mcp-session-id': sid }, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    // A session belongs to the token that opened it.
    assert.equal((await fetch(handle.url, { headers: { authorization: 'Bearer ' + b.token, 'mcp-session-id': sid, accept: 'text/event-stream' } })).status, 404);
    const stream = await fetch(handle.url, { headers: { authorization: 'Bearer ' + a.token, 'mcp-session-id': sid, accept: 'text/event-stream' } });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const ended = (async () => { try { for (;;) { const { done } = await reader.read(); if (done) return true; } } catch { return true; } })();
    tokenCli(['revoke', '--id', a.id], { root: tmp, env: { SSAM_SERVER_DIR: path.dirname(store.file) } });
    assert.equal((await post(handle.url, { authorization: 'Bearer ' + a.token }, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).status, 403);
    assert.ok(await waitFor(() => ![...handle.sessions.values()].some(s => s.tokenId === a.id)), 'session of the revoked token closed');
    assert.equal(await Promise.race([ended, new Promise(r => setTimeout(() => r(false), 3000))]), true, 'live stream ended');
    await assert.rejects(client.listTools());
    assert.equal((await keep.listTools()).tools.length, 2, 'the other customer keeps working');
    await keep.close(); await client.close().catch(() => {});
  } finally { await handle.close(); }
});

test('binds to loopback only; another address is refused unless allowed explicitly; a foreign Host header is 403', async () => {
  await assert.rejects(startHttpServer({ createServer: fakeServer, dir: freshDir(), host: '0.0.0.0', port: 0 }), /Recusado.*TLS/s);
  await assert.rejects(startHttpServer({ createServer: fakeServer, dir: freshDir(), host: '192.168.0.10', port: 0 }), /Recusado/);
  assert.equal(parseServeArguments([]).host, '127.0.0.1');
  assert.equal(parseServeArguments([]).port, 7300);
  assert.throws(() => parseServeArguments(['--port', 'x']), /Invalid port/);
  const { handle, store } = await start();
  try {
    assert.equal(handle.host, '127.0.0.1');
    const { token } = store.issue({ customer: 'Host' });
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: handle.port, path: '/mcp', method: 'GET', headers: { host: 'evil.example:' + handle.port, authorization: 'Bearer ' + token } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
    assert.equal((await fetch(handle.url, { headers: { authorization: 'Bearer ' + token, origin: 'https://evil.example' } })).status, 403);
  } finally { await handle.close(); }
});

test('the tokens file keeps only SHA-256 hashes; the token is printed once by issue', () => {
  const dir = freshDir();
  const env = { SSAM_SERVER_DIR: dir };
  const issued = tokenCli(['issue', '--customer', 'Cliente Um', '--days', '30'], { root: tmp, env });
  assert.match(issued.token, /^ssam_[A-Za-z0-9_-]{43}$/);
  assert.ok(Buffer.from(issued.token.slice(5), 'base64url').length >= 32);
  const text = fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8');
  assert.ok(!text.includes(issued.token) && !text.includes(issued.token.slice(5)), 'no plaintext token');
  assert.ok(text.includes(createHash('sha256').update(issued.token).digest('hex')));
  const listed = tokenCli(['list'], { root: tmp, env });
  assert.equal(listed.tokens[0].state, 'active');
  assert.ok(!JSON.stringify(listed).includes(issued.token) && !JSON.stringify(listed).includes('sha256'), 'list shows neither token nor hash');
  assert.throws(() => tokenCli(['issue', '--customer', '../x'], { root: tmp, env }), /customer/);
  assert.throws(() => tokenCli(['revoke', '--id', 'tok_nope'], { root: tmp, env }), /Unknown token id/);
});

test('one audit line per tool call, with token, customer, tool, duration and outcome, never arguments or results', async () => {
  const { handle, dir, store } = await start();
  try {
    const issued = store.issue({ customer: 'Auditado' });
    const client = await connect(handle.url, issued.token);
    const ok = await client.callTool({ name: 'echo_tool', arguments: { text: SECRET } });
    assert.equal(ok.content[0].text, 'got ' + SECRET);
    await client.callTool({ name: 'fail_tool', arguments: { text: SECRET } });
    await client.close();
    const files = fs.readdirSync(dir).filter(f => /^audit-\d{8}\.jsonl$/.test(f));
    assert.equal(files.length, 1);
    const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.ok(!text.includes(SECRET) && !text.includes('got ') && !text.includes(issued.token), 'no arguments, results or token');
    const lines = text.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['customer', 'ms', 'ok', 'time', 'token', 'tool']);
    assert.deepEqual({ token: lines[0].token, customer: lines[0].customer, tool: lines[0].tool, ok: lines[0].ok }, { token: issued.id, customer: 'Auditado', tool: 'echo_tool', ok: true });
    assert.deepEqual({ tool: lines[1].tool, ok: lines[1].ok, error: lines[1].error }, { tool: 'fail_tool', ok: false, error: 'PREFLIGHT_REFUSED' });
    assert.equal(typeof lines[0].ms, 'number');
    // A free-text error never becomes the code.
    assert.deepEqual(outcomeOf({ result: { isError: true, structuredContent: { code: 'path C:\\x\\Cliente.oml' } } }), { ok: false, error: 'TOOL_ERROR' });
    assert.deepEqual(outcomeOf({ error: { code: -32602, message: SECRET } }), { ok: false, error: 'RPC_32602' });
    // An UPPER_SNAKE word the product never declared (a customer's table name in a code field) is CODE_UNLISTED, never the word
    // (privacy review of 2026-10-12); a declared code stays.
    assert.deepEqual(outcomeOf({ result: { isError: true, structuredContent: { code: 'OSUSR_K3X_FOLHA_SNTL' } } }), { ok: false, error: 'CODE_UNLISTED' });
    assert.deepEqual(outcomeOf({ result: { structuredContent: { ok: false, reason: 'DEBUG_FOLHA_PAGAMENTO_SNTL' } } }), { ok: false, error: 'CODE_UNLISTED' });
    assert.deepEqual(outcomeOf({ result: { structuredContent: { ok: false, errorCode: 'AGENT_NOT_CONNECTED' } } }), { ok: false, error: 'AGENT_NOT_CONNECTED' });
  } finally { await handle.close(); }
});

const raw = (port, { method = 'GET', path: target = '/health', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: target, method, headers: { host: '127.0.0.1:' + port, ...headers } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject); req.end(body);
});
const KERNEL = { o11: '11.55.91', odc: '1.7.28', odcBridge: 'v35' };

test('/health answers ok with the pid of the server process', async () => {
  const { handle } = await start();
  try {
    const health = await fetch(handle.url.replace('/mcp', '/health'));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, pid: process.pid });
  } finally { await handle.close(); }
});

test('--public-host is parsed, accepts its Host and https Origin, still binds loopback and refuses other hosts', async () => {
  assert.deepEqual(parseServeArguments(['--public-host', 'SSAM.Example.com', '--public-host', 'b.example.org']).publicHosts, ['ssam.example.com', 'b.example.org']);
  assert.deepEqual(parseServeArguments([]).publicHosts, []);
  assert.throws(() => parseServeArguments(['--public-host', 'https://ssam.example.com']), /Invalid --public-host/);
  assert.throws(() => parseServeArguments(['--public-host', 'ssam.example.com:443']), /Invalid --public-host/);
  const { handle, store } = await start({ agents: { kernel: KERNEL }, publicHosts: ['ssam.example.com'] });
  try {
    assert.equal(handle.host, '127.0.0.1');
    const { token } = store.issue({ customer: 'Tunel' });
    for (const host of ['ssam.example.com', 'ssam.example.com:443', 'SSAM.example.com'])
      assert.equal((await raw(handle.port, { headers: { host } })).status, 200, host);
    assert.equal((await raw(handle.port, { headers: { origin: 'https://ssam.example.com' } })).status, 200);
    assert.equal((await raw(handle.port, { headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await raw(handle.port, { headers: { host: 'ssam.example.com:8443' } })).status, 403);
    assert.equal((await raw(handle.port, { headers: { origin: 'http://ssam.example.com' } })).status, 403);
    assert.equal((await raw(handle.port, { headers: { origin: 'https://evil.example' } })).status, 403);
    const tunneled = await post(handle.url, { authorization: 'Bearer ' + token, origin: 'https://ssam.example.com' });
    assert.equal(tunneled.status, 200); await tunneled.text();
  } finally { await handle.close(); }
});

test('--local-studios is the owner-only mode: refused with --public-host or --allow-remote at parse and at start', async () => {
  assert.equal(parseServeArguments(['--local-studios']).localStudios, true);
  assert.equal(parseServeArguments([]).localStudios, false);
  assert.throws(() => parseServeArguments(['--local-studios', '--public-host', 'ssam.example.com']), /local-studios.*public-host/s);
  assert.throws(() => parseServeArguments(['--public-host', 'ssam.example.com', '--local-studios']), /local-studios.*public-host/s);
  assert.throws(() => parseServeArguments(['--local-studios', '--allow-remote']), /local-studios.*allow-remote/s);
  assert.equal(parseServeArguments(['--allow-remote']).allowRemote, true, 'the hosted server may still bind elsewhere');
  assert.equal(parseServeArguments(['--log-file', 'x.log']).logFile, path.resolve('x.log'));
  // agents:false (the library default) is the owner-only mode at start too.
  await assert.rejects(startHttpServer({ createServer: fakeServer, dir: freshDir(), port: 0, publicHosts: ['ssam.example.com'] }), /Recusado: --public-host/);
  await assert.rejects(startHttpServer({ createServer: fakeServer, dir: freshDir(), port: 0, allowRemote: true }), /Recusado: --allow-remote/);
});

test('owner-only mode answers 403 FORWARDED_REFUSED to a request that came through a proxy; the hosted mode does not', async () => {
  const local = await start();
  const hosted = await start({ agents: { kernel: KERNEL } });
  try {
    for (const header of ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-forwarded-host', 'cf-ray']) {
      const refused = await raw(local.handle.port, { headers: { [header]: '203.0.113.7' } });
      assert.equal(refused.status, 403, header);
      assert.equal(JSON.parse(refused.text).error.data.code, 'FORWARDED_REFUSED');
      assert.equal((await raw(hosted.handle.port, { headers: { [header]: '203.0.113.7' } })).status, 200, header);
    }
    const { token } = local.store.issue({ customer: 'Proxy' });
    assert.equal((await post(local.handle.url, { authorization: 'Bearer ' + token, 'x-forwarded-for': '203.0.113.7' })).status, 403);
  } finally { await local.handle.close(); await hosted.handle.close(); }
});

test('an idle SSE response gets ": keepalive" comments between events while a slow tool runs', async () => {
  const slow = async () => {
    const server = new McpServer({ name: 'slow', version: '1.0.0' });
    server.registerTool('slow_tool', { description: 'slow', inputSchema: fromJsonSchema({ type: 'object', properties: {} }) },
      async () => { await new Promise(r => setTimeout(r, 400)); return { content: [{ type: 'text', text: 'done' }] }; });
    return server;
  };
  const { handle, store } = await start({ createServer: slow, keepaliveMs: 50 });
  try {
    const { token } = store.issue({ customer: 'Lento' });
    const opened = await post(handle.url, { authorization: 'Bearer ' + token });
    assert.equal(opened.status, 200); await opened.text();
    const sid = opened.headers.get('mcp-session-id');
    const headers = { authorization: 'Bearer ' + token, 'mcp-session-id': sid };
    assert.equal((await post(handle.url, headers, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const call = await post(handle.url, headers, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow_tool', arguments: {} } });
    assert.equal(call.status, 200);
    assert.match(call.headers.get('content-type'), /text\/event-stream/);
    const text = await call.text();
    assert.ok((text.match(/^: keepalive$/gm) ?? []).length >= 2, text);
    assert.match(text, /"done"/);
    // Only at event boundaries: every keepalive starts right after a blank line or at the start.
    for (const at of [...text.matchAll(/: keepalive\n\n/g)].map(m => m.index)) assert.ok(at === 0 || text.slice(at - 2, at) === '\n\n', text);
  } finally { await handle.close(); }
});

test('createServer and observeCall receive the session: token, customer, lanes, workspace and agent link', async () => {
  const seen = [], observed = [];
  const capture = async session => { seen.push(session); return fakeServer(); };
  const hosted = await start({ agents: { kernel: KERNEL }, createServer: capture, observeCall: (params, session) => { observed.push([params.name, session]); return null; } });
  const local = await start({ createServer: capture });
  try {
    const issued = hosted.store.issue({ customer: 'Sessao', lanes: ['odc'] });
    const client = await connect(hosted.handle.url, issued.token);
    await client.callTool({ name: 'echo_tool', arguments: { text: 'x' } });
    await client.close();
    const session = seen.at(-1);
    assert.equal(session.tokenId, issued.id); assert.equal(session.customer, 'Sessao'); assert.deepEqual(session.lanes, ['odc']);
    assert.equal(session.workspace, path.join(hosted.dir, 'customers', issued.id));
    assert.equal(session.agent, hosted.handle.hub.link(issued.id), 'the stable link of the token');
    assert.equal(session.agent.tokenId, issued.id); assert.equal(session.agent.connected(), false);
    assert.deepEqual(observed.map(([name, s]) => [name, s.tokenId]), [['echo_tool', issued.id]]);
    assert.equal(observed[0][1], session);
    const phase1 = local.store.issue({ customer: 'Dono' });
    const owner = await connect(local.handle.url, phase1.token);
    await owner.close();
    assert.equal(seen.at(-1).agent, null, 'owner-only mode has no agent');
    assert.equal(local.handle.hub, null);
  } finally { await hosted.handle.close(); await local.handle.close(); }
});

test('/mcp refuses an agent credential and /agent refuses an MCP token; --log-file receives the server events', async () => {
  const dir = freshDir();
  const logFile = path.join(dir, 'logs', 'server.log');
  const { handle, store } = await start({ dir, agents: { kernel: KERNEL }, logFile });
  try {
    const issued = store.issue({ customer: 'Credenciais' });
    assert.equal((await post(handle.url, { authorization: 'Bearer ' + issued.agentCredential })).status, 401);
    const agent = await fetch(handle.url.replace('/mcp', '/agent/v1/hello'), { method: 'POST', headers: { authorization: 'Bearer ' + issued.token }, body: '{}' });
    assert.equal(agent.status, 401); assert.equal((await agent.json()).code, 'AGENT_CREDENTIAL_UNKNOWN');
    const ok = await post(handle.url, { authorization: 'Bearer ' + issued.token });
    assert.equal(ok.status, 200); await ok.text();
  } finally { await handle.close(); }
  const events = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(events.some(e => e.event === 'listening' && e.mode === 'hosted' && e.pid === process.pid));
  assert.ok(events.some(e => e.event === 'session-opened'));
  assert.ok(events.every(e => typeof e.time === 'string'));
  const text = fs.readFileSync(logFile, 'utf8');
  assert.ok(!/ssam_[A-Za-z0-9_-]{43}/.test(text), 'no secret in the log');
});

// The real thing: `ssam serve` from the root launcher, against `ssam mcp` on stdio. Same tools, same schemas, same
// instructions; ssam_discover (read-only, no Studio) answers over HTTP and leaves one audit line without its intent.
// The owner-only mode (--local-studios) is the one with stdio parity; the hosted parity is hosted-e2e.test.mjs.
test('ssam serve lists exactly the tools of ssam mcp and answers ssam_discover end to end', { timeout: 240000 }, async t => {
  const dir = freshDir();
  const env = { ...process.env, SSAM_SERVER_DIR: dir, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const launcher = path.join(workspace, 'facade', 'ssam.mjs');
  const child = spawn(process.execPath, [launcher, 'serve', '--port', '0', '--local-studios'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', c => { err += c; });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', chunk => {
        out += chunk;
        for (const line of out.split('\n')) { try { const e = JSON.parse(line); if (e.event === 'listening') resolve(e.url); } catch { /* partial line */ } }
      });
      child.on('exit', code => reject(new Error('serve exited ' + code + ': ' + err)));
    });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const { token } = createTokenStore(dir).issue({ customer: 'Paridade' });
    const overHttp = await connect(url, token);
    const stdio = new Client({ name: 'stdio-test', version: '1.0.0' });
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [launcher, 'mcp'], cwd: workspace, env, stderr: 'ignore' }));
    try {
      const byName = list => [...list].sort((x, y) => x.name.localeCompare(y.name));
      const [h, s] = await Promise.all([overHttp.listTools(), stdio.listTools()]);
      assert.ok(s.tools.length > 50, 'the full server: ' + s.tools.length);
      assert.deepEqual(byName(h.tools), byName(s.tools));
      assert.equal(overHttp.getInstructions?.(), stdio.getInstructions?.());
      // lane odc: its index key does not depend on the (isolated) profile, so a warm index answers at once.
      const intent = 'publish an ODC module';
      const started = Date.now();
      const reply = await overHttp.callTool({ name: 'ssam_discover', arguments: { intent, lane: 'odc', budgetBytes: 8192 } });
      const ms = Date.now() - started;
      assert.notEqual(reply.isError, true, JSON.stringify(reply).slice(0, 500));
      assert.ok(reply.structuredContent?.tools?.length || reply.content?.length, 'an answer');
      const audit = fs.readdirSync(dir).filter(f => f.startsWith('audit-')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
      const line = audit.trim().split('\n').map(l => JSON.parse(l)).find(l => l.tool === 'ssam_discover');
      assert.equal(line?.ok, true);
      assert.ok(!audit.includes(intent) && !audit.includes(token));
      t.diagnostic('tools ' + s.tools.length + ', ssam_discover over HTTP ' + ms + ' ms');
    } finally { await overHttp.close(); await stdio.close(); }
  } finally { child.kill(); }
});
