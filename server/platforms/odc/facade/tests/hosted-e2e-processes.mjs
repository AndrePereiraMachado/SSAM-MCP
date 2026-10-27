// The process end to end of phase 2 (docs/FASE2-AGENTE.md): every piece in its own process, as on two machines, with
// fake Studios only. Not part of `node --test` (it starts PowerShell, servers and agents); run it by hand:
//   node platforms\odc\facade\tests\hosted-e2e-processes.mjs [--report <file.json>]
// with ANVIL_WORKER=0 and ANVIL_ODC_NO_WORKER=1. It prints {ok, checks:[{name, ok, detail}]} and exits 0 only when
// every check passed. Steps:
//   - the agent pack is built by scripts\agent-pack.ps1 -NoBuild -Prebuilt (fake binaries) and extracted into the
//     folder of each simulated customer machine (own USERPROFILE/LOCALAPPDATA/TEMP), configured by the real
//     `ssam-agent.mjs setup` and run by fixtures/agent-process.mjs (the pack's agent with the Studio touch points of
//     the machine replaced by fixtures/fake-studios-process.mjs: a fake ODC bridge pipe and a fake O11 bridge);
//   - the hosted server is started by scripts\servidor.ps1 start (temporary SSAM_SERVER_DIR, isolated owner profile),
//     tokens are issued and revoked by `ssam server-token`, and an MCP client talks to /mcp over HTTP;
//   - phase 3 (docs/O11-BRIDGE-FINA.md): the fake O11 bridge keeps the thin bridge's wire contract and has the kernel's
//     blank-service fixture open; o11_deliver, o11_studio snapshot/publish-log and o11_environment refresh-refs run the
//     server's real kernel CLI (ANVIL_BRIDGE_FLAVOR=thin, the installed Service Studio loaded headless) through the relay
//     and the agent; a hosted ssam_job {lane:"odc"} without base and ssam_discover show the neutral fixture and scrub.
//   - the 24th release (servidor/fase4-24, step 9i): studio_reference_producers, the Service Center through sc_http and
//     the Portal through the headless Studio session (odc_mcp_connection readiness), the tools unavailable hosted, the
//     prototype op and a renamed path argument refused at the gate, and a third customer still on the v48 pack: accepted
//     by kernel.json odcBridgeAccepted, typed refusals for what the 23rd pack lacks.
//   - the product's marco-a5 (servidor/fase4-25, step 9j): the generators pending their blind test refused at the gate,
//     odc_portal_login prompt and focus refused (no credential window).
//   - deliveries without the 25 s deadline (servidor/fase4-26 a8, step 9k): ssam_code write naming an agent: file twice at
//     once (case f: one delivery, the second joins) and a delivery of 3 min (E2E_LONG_DELIVERY_MS) through a proxy that cuts a
//     response idle for 60 s.
//   - servidor/fase4-26 a8 (step 9l, owner request 18/10): ssam_code served hosted, both lanes: read (O11 by the open
//     module's name through the relay, ODC over the ws: capture), check over the newest capture of the customer's workspace,
//     plan (prompts brought to the customer's machine, batch files named in its agent inbox, a batch check that brings its
//     file), write (O11 delivered through o11_deliver's gate and the thin bridge, an edit of a read action included; ODC
//     through studio_deliver until the build); customer B (step 10) never reaches any of A's.
// Tokens and agent credentials only ever go to files under the temporary folder; nothing here prints them.
// Ports: the server and the fake O11 bridges take free ports in 7400-7499. Never a real Studio: the fake ODC pipes use
// unlikely pids, and the agents list only the fake Studio processes.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ODC_BRIDGE } from './fixtures/odc-bridge-version.mjs';

const facade = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repo = path.resolve(facade, '..', '..', '..');
const fixtures = path.join(facade, 'tests', 'fixtures');
const reportAt = process.argv.indexOf('--report');
const reportFile = reportAt > 0 ? path.resolve(process.argv[reportAt + 1]) : null;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const waitFor = async (check, ms, every = 100) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(every); } return null; };
const brief = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text && text.length > 400 ? text.slice(0, 400) + '...' : text; };

// ODC intents whose owner-side discover answers cite jobs over the third-party capture or name a client (step 9f): a
// list screen, an agent, a Mobile app, a workflow and the debugger. The hosted answers carry none of the client text of
// scripts/release/client-content.json.
const DISCOVER_INTENTS = ['tela com lista de registros', 'agente de IA que chama uma acao', 'app mobile com sync', 'workflow com nos de decisao', 'debugger de app user login'];
const CLIENT_TEXT = JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'release', 'client-content.json'), 'utf8')).forbidden.map(f => new RegExp(f.pattern, 'i'));
const clientHits = value => { const text = JSON.stringify(value); return CLIENT_TEXT.filter(re => re.test(text)).map(re => re.source); };
const checks = [];
function check(name, ok, detail = '') { checks.push({ name, ok: !!ok, detail: brief(detail) }); return !!ok; }
class Stop extends Error {}
function must(name, ok, detail) { if (!check(name, ok, detail)) throw new Stop(name); }

// ---------------------------------------------------------------- folders and environments
const privateTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-f2e2e-'));
const runRoot = fs.mkdtempSync('C:/t/multiver-impl/etapa2/e2e-');
const T = path.join(runRoot, 'segredo');
fs.mkdirSync(T);
const serverDir = path.join(T, 'server');
const secrets = path.join(T, 'credentials');
const ownerHome = path.join(T, 'owner-home');
for (const dir of [serverDir, secrets, path.join(ownerHome, 'AppData', 'Local'), path.join(ownerHome, 'AppData', 'Roaming'), path.join(T, 'owner-authority'), path.join(privateTemp, 'owner-tmp')])
  fs.mkdirSync(dir, { recursive: true });
const clean = env => ({...Object.fromEntries(Object.entries(env).filter(([k]) => !/^(ANVIL_|SSAM_)/i.test(k))), PSModulePath: path.join(env.SystemRoot || 'C:/Windows','System32/WindowsPowerShell/v1.0/Modules') + path.delimiter + (env.PSModulePath || '')});
// The owner's machine has its Anvil authority initialized (bridge.key): the server's own resident readers (ssam_map, the
// module digest) trust it. Hosted child processes never get it (hosted-roots.test.mjs): each customer has its relay key.
fs.writeFileSync(path.join(T, 'owner-authority', 'bridge.key'), randomBytes(32).toString('base64url'));
// The Service Studio the server's O11 kernel loads headless (apply, the reference plan, find, refresh): compile-time and
// model runtime only, never a Studio process.
const serverStudio = process.env.ANVIL_STUDIO_DIR || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OutSystems', 'Service Studio 11', 'Service Studio');
const ownerEnv = { ...clean(process.env), SSAM_SERVER_DIR: serverDir, SSAM_NODE: process.execPath, ANVIL_STUDIO_DIR: serverStudio,
  ...(process.env.ANVIL_ODC_STUDIO_DIR ? {ANVIL_ODC_STUDIO_DIR:process.env.ANVIL_ODC_STUDIO_DIR}:{}),
  SSAM_MODULE_INDEX_ROOT: path.join(privateTemp, 'module-index'), SSAM_READER_CACHE_ROOT: path.join(T, 'readers'),
  ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1', ANVIL_AUTHORITY_DIR: path.join(T, 'owner-authority'),
  USERPROFILE: ownerHome, HOME: ownerHome, APPDATA: path.join(ownerHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(ownerHome, 'AppData', 'Local'),
  TEMP: path.join(privateTemp, 'owner-tmp'), TMP: path.join(privateTemp, 'owner-tmp'),
  ...(process.env.ANVIL_ODC_FEATURES_DIR ? { ANVIL_ODC_FEATURES_DIR: process.env.ANVIL_ODC_FEATURES_DIR } : {}) };
// The server's kernel is pinned (the fake Studios report these versions); detection would read the installed Studios.
// The 24th release keeps serving the packs of v48 and v45 (PLANO-24-PRODUCAO 6): customer C of step 9i is on v48.
write(path.join(serverDir, 'kernel.json'), JSON.stringify({ o11: '11.55.92', odc: '1.7.28', odcBridge: ODC_BRIDGE, odcBridgeAccepted: ['v96', 'v48', 'v45'] }));

function customerMachine(name) {
  const base = path.join(T, name);
  const home = path.join(base, 'home');
  for (const dir of [path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'), path.join(privateTemp, name, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  return { name, base, root: path.join(base, 'SSAM-Agent'), studiosFile: path.join(base, 'studios.json'),
    env: { ...clean(process.env), USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: path.join(privateTemp, name, 'tmp'), TMP: path.join(privateTemp, name, 'tmp') } };
}

// ---------------------------------------------------------------- processes
const children = new Set();
function start(args, { env, cwd = repo, name }) {
  const child = spawn(process.execPath, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const run = { name, child, out: '', exited: null, code: null };
  child.stdout.on('data', c => { run.out += c; }); child.stderr.on('data', c => { run.out += c; });
  run.exit = new Promise(resolve => child.on('exit', code => { run.exited = Date.now(); run.code = code; children.delete(run); resolve(code); }));
  children.add(run);
  return run;
}
function powershell(args, env, limitMs = 120000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
    const timer = setTimeout(() => reject(new Error('powershell ' + args.join(' ') + ' did not return within ' + limitMs + ' ms')), limitMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim(), ms: Date.now() - started }); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
  });
}
// `ssam <args>` of this checkout as the owner runs it; the JSON answer is parsed here and never printed.
function ssam(args) {
  const run = spawnSync(process.execPath, [path.join(repo, 'facade', 'ssam.mjs'), ...args], { cwd: repo, env: ownerEnv, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  let value = null;
  try { value = JSON.parse(run.stdout); } catch { /* not JSON */ }
  return { status: run.status, value };
}
const free = port => new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const taken = new Set();
async function freePort() {
  const first = Math.floor(Math.random() * 100);
  for (let i = 0; i < 100; i++) { const port = 7400 + ((first + i) % 100); if (!taken.has(port) && await free(port)) { taken.add(port); return port; } }
  throw new Error('no free port in 7400-7499');
}

// ---------------------------------------------------------------- what must not change
function fingerprint(dir, skipTop = new Set()) {
  const out = {};
  const walk = (current, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (depth === 0 && skipTop.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else { try { const s = fs.statSync(full); out[path.relative(dir, full)] = s.size + ':' + s.mtimeMs; } catch { /* gone */ } }
    }
  };
  walk(dir, 0);
  return out;
}
const odcRoot = path.join(repo, 'platforms', 'odc');
// .local/discovery (the shared discover index, 6.1) and the owner's own CLI friction queue (.local/friction, written by
// `ssam server-token`) are server data by design, not customer data.
const guarded = {
  odcData: () => ({ snapshots: fingerprint(path.join(odcRoot, 'snapshots')), journal: fingerprint(path.join(odcRoot, 'journal')), lab: fingerprint(path.join(odcRoot, 'lab')),
    local: fingerprint(path.join(odcRoot, '.local'), new Set(['discovery'])), tenants: fs.existsSync(path.join(odcRoot, 'tenants.json')) ? shaFile(path.join(odcRoot, 'tenants.json')) : null }),
  kernelLocal: () => fingerprint(path.join(repo, 'kernel', '.local')),
  repoLocal: () => fingerprint(path.join(repo, '.local'), new Set(['setup', 'friction'])),
  // Windows PowerShell (servidor.ps1, agent-pack.ps1) keeps its own startup cache under the profile.
  ownerProfile: () => Object.fromEntries(Object.entries(fingerprint(ownerHome)).filter(([file]) => !file.startsWith(path.join('AppData', 'Local', 'Microsoft', 'Windows', 'PowerShell')))),
};

// ---------------------------------------------------------------- MCP over HTTP
const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
let port, backendPort, url, router, routerStore;
const clients = new Set();
async function connect(token) {
  const client = new Client({ name: 'e2e-processes', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  clients.add(client);
  return client;
}
const call = async (client, name, args = {}, timeout) => { try { return await client.callTool({ name, arguments: args }, timeout ? { timeout } : undefined); } catch (error) { return { isError: true, thrown: error.message }; } };
const sc = result => result?.structuredContent ?? null;
const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
const rawMcp = bearer => fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: initialize })
  .then(async r => { await r.arrayBuffer().catch(() => {}); return r.status; });
const rawHello = bearer => fetch(`http://127.0.0.1:${port}/agent/v1/hello`, { method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: '{}' })
  .then(async r => { await r.arrayBuffer().catch(() => {}); return r.status; });

const studioLog = machine => { try { return fs.readFileSync(machine.studiosFile + '.log', 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
const odcLines = machine => studioLog(machine).filter(e => e.studio === 'odc');
const agentCalls = machine => { try { return fs.readFileSync(path.join(machine.root, 'private', 'agent.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.event === 'call'); } catch { return []; } };

// The O11 module the fake Service Studio has open: the kernel's blank-service fixture (Headless_CS, a (System)
// reference with an empty signature hash), read with `anvil inspect`.
const O11_MODULE = { oml: path.join(repo, 'kernel', 'tests', 'fixtures', 'blank-service.oml'), name: 'Headless_CS', key: 'Kawk_WFx5USxo7qFAB0lCQ',
  environment: 'thin-e2e.outsystemscloud.com', systemKey: 'uXCIR2Atc0+es3zYuZSnNw' };
const moduleFile = path.join(T, 'o11-module.json');
write(moduleFile, JSON.stringify(O11_MODULE));
// The ODC module the fake ODC Studio captures with real bytes (servidor/fase4-22): the neutral blank CrossDevice app of
// the kernel (anvil-odc create-blank), with the identity a capture of the real bridge carries.
const ODC_MODULE = { name: 'SsamNeutralApp', oml: path.join(repo, 'kernel', 'tests', 'fixtures', 'odc', 'blank-crossdevice.oml'),
  moduleKey: 'ojF0o++TwanqKJN76uNzpw', host: 'neutral-e2e.outsystems.dev', developerId: 'e2e.dev@neutral-e2e' };
const odcModuleFile = path.join(T, 'odc-module.json');
write(odcModuleFile, JSON.stringify(ODC_MODULE));
async function startStudios(machine, profile = 'current') {
  const o11Port = await freePort();
  machine.studios = start([path.join(fixtures, 'fake-studios-process.mjs'), machine.root, machine.studiosFile, String(o11Port), '0', moduleFile, odcModuleFile, profile],
    { env: machine.env, name: machine.name + '-studios' });
  const ready = await waitFor(() => fs.existsSync(machine.studiosFile), 15000);
  must(machine.name + ': fake Studios up (ODC pipe + O11 bridge)', ready, machine.studios.out);
  machine.fakes = JSON.parse(fs.readFileSync(machine.studiosFile, 'utf8'));
}
function startAgent(machine) {
  machine.agent = start([path.join(fixtures, 'agent-process.mjs'), machine.root, machine.studiosFile], { env: machine.env, cwd: machine.root, name: machine.name + '-agent' });
  return machine.agent;
}
const agentConnected = async client => (sc(await call(client, 'ssam_doctor'))?.agent?.connected === true);
// Loopback ports a process listens on (read-only query).
async function listeningPorts(pid) {
  const out = await powershell(['-Command', `Get-NetTCPConnection -State Listen -OwningProcess ${Number(pid)} -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort }`], ownerEnv, 60000);
  return [...new Set(out.out.split(/\r?\n/).map(s => Number(s.trim())).filter(Number.isInteger))].sort((a, b) => a - b);
}
// One request line to a bridge-protocol port, like the kernel's BridgeClient: {reply} or {closed:true} with no reply.
function relayLine(relayPort, request, limitMs = 30000) {
  return new Promise(resolve => {
    const socket = net.connect(relayPort, '127.0.0.1');
    let buffer = '';
    const done = value => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done({ timeout: true }), limitMs);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { buffer += chunk; const i = buffer.indexOf('\n'); if (i >= 0) { let reply = null; try { reply = JSON.parse(buffer.slice(0, i)); } catch { /* not JSON */ } done({ reply }); } });
    socket.on('close', () => done({ closed: true }));
    socket.on('error', error => done({ error: error.message }));
  });
}

// A proxy in front of the server that cuts any response idle for idleMs (a tunnel or a load balancer before Caddy: 60 s is
// common), at the HTTP level so that idle pooled connections between requests are not counted. It counts the ": keepalive"
// comments of the SSE responses (http-server.mjs writes one after 25 s without a write) and every cut.
async function idleCutProxy(targetPort, idleMs) {
  const stats = { responses: 0, sse: 0, keepalives: 0, idleCuts: 0, longestGapMs: 0, streams: [] };
  const NEEDLE = ': keepalive\n\n';
  const server = http.createServer((req, res) => {
    // The server accepts only its own Host (DNS rebinding guard): the proxy names it, as Caddy does with --public-host.
    const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: '127.0.0.1:' + targetPort } }, up => {
      stats.responses++;
      const sse = /^text\/event-stream/i.test(String(up.headers['content-type'] ?? ''));
      if (sse) stats.sse++;
      res.writeHead(up.statusCode, up.headers);
      res.flushHeaders?.();
      let timer = null, last = Date.now(), carry = '';
      const stream = { sse, keepalives: 0, ms: 0, started: Date.now() };
      stats.streams.push(stream);
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stats.idleCuts++; up.destroy(); res.destroy(); }, idleMs); };
      arm();
      up.on('data', chunk => {
        const now = Date.now(); stats.longestGapMs = Math.max(stats.longestGapMs, now - last); last = now; arm();
        if (sse) { const text = carry + chunk.toString('latin1'); for (let i = text.indexOf(NEEDLE); i >= 0; i = text.indexOf(NEEDLE, i + NEEDLE.length)) { stats.keepalives++; stream.keepalives++; } carry = text.slice(-(NEEDLE.length - 1)); }
        res.write(chunk);
      });
      up.on('end', () => { clearTimeout(timer); stream.ms = Date.now() - stream.started; res.end(); });
      up.on('error', () => { clearTimeout(timer); res.destroy(); });
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { stats, port: server.address().port, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}
// ---------------------------------------------------------------- the run
let failure = null;
const A = customerMachine('cliente-a'), B = customerMachine('cliente-b'), C = customerMachine('cliente-c');
const before = Object.fromEntries(Object.entries(guarded).map(([k, f]) => [k, f()]));
try {
  // 1. Agent pack (fake binaries), extracted on both customer machines.
  const prebuilt = path.join(T, 'prebuilt');
  for (const name of [`ODC3.Bridge.${ODC_BRIDGE}.dll`, `ODC3.Bridge.${ODC_BRIDGE}.deps.json`]) write(path.join(prebuilt, 'odc', 'bridge', name), name);
  for (const name of ['ODC3.Bridge.Client.dll', 'ODC3.Bridge.Client.deps.json', 'ODC3.Bridge.Client.runtimeconfig.json']) write(path.join(prebuilt, 'odc', 'client', name), name);
  for (const name of ['Anvil.Connect.dll', 'Anvil.Connect.runtimeconfig.json']) write(path.join(prebuilt, 'o11', 'connect', name), name);
  write(path.join(prebuilt, 'o11', 'hook', 'Anvil.RuntimeHook.Agent.dll'), 'hook');
  // The thin O11 bridge only (docs/O11-BRIDGE-FINA.md 6.1); -NoNode keeps the real node.exe out of the pack.
  for (const name of ['Anvil.Bridge.dll', 'Anvil.Bridge.deps.json']) write(path.join(prebuilt, 'o11', 'bridge', name), name);
  write(path.join(prebuilt, 'o11', 'built-for.txt'), '11.55.92\r\n');
  const zip = path.join(T, 'ssam-agent.zip');
  const pack = await powershell(['-File', path.join(repo, '..', 'agent', 'scripts', 'agent-pack.ps1'), '-Out', zip, '-Lanes', 'odc,o11', '-NoNode', '-NoBuild', '-Prebuilt', prebuilt], ownerEnv);
  // The prebuilt files are placeholders: the scan ran, but over no real binary (the real pack is the acceptance of
  // docs/O11-BRIDGE-FINA.md 8.8; the thin DLL's own bytes are checked by Anvil.Bridge.Thin.Tests BoundaryTests).
  must('agent pack built by scripts\\agent-pack.ps1 -NoBuild -Prebuilt -NoNode (placeholder binaries)', pack.code === 0 && fs.existsSync(zip), pack.out);
  for (const machine of [A, B]) {
    const expanded = await powershell(['-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${machine.root}'`], machine.env);
    must(machine.name + ': pack extracted (agent code + pack.json)', expanded.code === 0 && fs.existsSync(path.join(machine.root, 'pack.json')) && fs.existsSync(path.join(machine.root, 'agent', 'lib', 'agent.mjs')), expanded.out);
  }
  const bridgeFolder = fs.readdirSync(path.join(A.root, 'bin', 'o11', 'bridge')).sort();
  check('bin\\o11\\bridge holds only the thin bridge (Anvil.Bridge.dll + .deps.json), no node.exe in the pack',
    JSON.stringify(bridgeFolder) === JSON.stringify(['Anvil.Bridge.deps.json', 'Anvil.Bridge.dll']) && !fs.existsSync(path.join(A.root, 'agent', 'node')), bridgeFolder);

  // 2. Hosted server through scripts\servidor.ps1, with captured output (it must return).
  port = await freePort();backendPort=port;
  url = `http://127.0.0.1:${port}/mcp`;
  const started = await powershell(['-File', path.join(repo, 'scripts', 'servidor.ps1'), 'start', '-Port', String(port)], ownerEnv, 60000);
  must('servidor.ps1 start returns with captured output and the server is up', started.code === 0 && /Servidor no ar/.test(started.out), started.out + ' (' + started.ms + ' ms)');
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json()).catch(() => null);
  check('/health answers {ok, pid}', health?.ok === true && Number.isInteger(health.pid), health);
  const listening = fs.readFileSync(path.join(serverDir, 'server.log'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }).find(e => e.event === 'listening');
  check('the server runs the hosted mode (not --local-studios)', listening?.mode === 'hosted', listening);

  // The same end-to-end checks now traverse the production router.
  const {createRouter}=await import('../hosted/router.mjs');
  const {openTokenStore}=await import('../server-tokens.mjs');
  routerStore=await openTokenStore({dir:serverDir});
  router=await createRouter({store:routerStore,dir:path.join(T,'router'),port:0,backends:[{name:'e2e',preserveHost:false,url:'http://127.0.0.1:'+port,odc:'1.7.28',o11:'11.55.92',default:true}]});
  port=router.server.address().port;url=router.url+'/mcp';
  // 3. Tokens (to files only).
  const issued = {};
  for (const [key, customer] of [['a', 'Cliente A'], ['b', 'Cliente B'], ['c', 'Cliente C']]) {
    const { status, value } = ssam(['server-token', 'issue', '--customer', customer]);
    must(`ssam server-token issue (${customer}) gives an MCP token and an agent credential`, status === 0 && /^ssam_/.test(value?.token ?? '') && /^ssam_agent_/.test(value?.agentCredential ?? ''), { status, id: value?.id ?? null });
    write(path.join(secrets, key + '.token'), value.token);
    write(path.join(secrets, key + '.agent'), value.agentCredential);
    issued[key] = { id: value.id, token: value.token, credential: value.agentCredential, workspace: path.join(serverDir, 'customers', value.id) };
  }
  const tokensText = fs.readFileSync(path.join(serverDir, 'tokens.json'), 'utf8');
  check('tokens.json holds no plaintext token or agent credential', ![issued.a, issued.b, issued.c].some(x => tokensText.includes(x.token) || tokensText.includes(x.credential)));

  // 4. Customer A: real setup (credential from a file, icacls on private\), fake Studios, agent process.
  for (const [machine, key] of [[A, 'a'], [B, 'b']]) {
    const setup = spawnSync(process.execPath, [path.join(machine.root, 'agent', 'ssam-agent.mjs'), 'setup', '--server', `http://127.0.0.1:${port}`, '--root', machine.root,
      '--credential-file', path.join(secrets, key + '.agent')], { cwd: machine.root, env: machine.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const output = (setup.stdout ?? '') + (setup.stderr ?? '');
    must(machine.name + ': ssam-agent.mjs setup configures the agent and never prints the credential',
      setup.status === 0 && fs.existsSync(path.join(machine.root, 'private', 'credential')) && !output.includes(issued[key].credential), output.replace(issued[key].credential, '<credential>'));
  }
  await startStudios(A);
  const configA = path.join(A.root, 'private', 'config.json');
  fs.writeFileSync(configA, JSON.stringify({ ...JSON.parse(fs.readFileSync(configA, 'utf8')), o11Port: A.fakes.o11Port }, null, 2));
  startAgent(A);

  const clientA = await connect(issued.a.token);
  // Phase-1 parity: the hosted tools/list equals the stdio list (+ ssam_friction, which the root launcher adds).
  const ssamModule = await import(pathToFileURL(path.join(facade, 'ssam.mjs')).href);
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { frictionTool } = await import(pathToFileURL(path.join(repo, 'facade', 'friction-boundary.mjs')).href);
  // servidor/fase4-25: marco-a5 keeps a whole answer above its kind's budget in <answersRoot>/.local/answers even locally
  // (answer-size.mjs); the owner's stdio server of this step writes them in the temporary folder, so kernel/.local keeps
  // proving that no hosted call wrote there.
  // servidor/fase4-26 a7: a hosted session serves the profile all (CX11); the parity is with the stdio list of that profile.
const stdio = await ssamModule.createSsamServer({ ...ssamModule.servedLanes(), profile: 'all', deps: { answersRoot: path.join(T, 'owner-answers') } });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const local = new Client({ name: 'e2e-stdio', version: '1' });
  await Promise.all([stdio.connect(left), local.connect(right)]);
  const stdioNames = [...(await local.listTools()).tools.map(t => t.name), frictionTool.name].sort();
  // The owner's own discover answers for the intents step 9f asks hosted: they carry the third-party capture's evidence.
  const ownerDiscover = [];
  for (const intent of DISCOVER_INTENTS) ownerDiscover.push(await call(local, 'ssam_discover', { intent, lane: 'odc' }, 300000));
  await local.close(); await stdio.close();
  const hostedNames = (await clientA.listTools()).tools.map(t => t.name).sort();
  check('MCP initialize + tools/list over HTTP: same names as the stdio server', JSON.stringify(hostedNames) === JSON.stringify(stdioNames), { hosted: hostedNames.length, stdio: stdioNames.length });

  must('customer A agent connected (ssam_doctor agent.connected)', await waitFor(() => agentConnected(clientA), 20000, 250), A.agent.out + fs.readFileSync(path.join(A.root, 'private', 'agent.log'), 'utf8').slice(-1500));

  // 5. A tool through the agent: studio_status reaches the fake ODC bridge of machine A.
  const linesBefore = odcLines(A).length;
  const status = await call(clientA, 'studio_status');
  check('studio_status routes through the agent to the customer\'s (fake) ODC Studio', status.isError !== true && odcLines(A).slice(linesBefore).some(e => e.line.startsWith('status')), sc(status) ?? status);
  const attached = await call(clientA, 'studio_attach', {});
  check('studio_attach is odc.attach on the agent (the pack\'s own client and bridge, no DLL path from the server)',
    attached.isError !== true && sc(attached)?.ok === true && sc(attached)?.dll === undefined && agentCalls(A).some(e => e.kind === 'odc.attach' && e.ok === true), sc(attached) ?? attached);

  // 6. Agent -> server: a 6 MiB capture written by the bridge on the agent comes to the workspace (2 parts).
  const snap = sc(await call(clientA, 'studio_snapshot', { module: 'Orders' }));
  const snapRel = typeof snap?.path === 'string' && snap.path.startsWith('ws:') ? snap.path.slice(3) : null;
  const snapServer = snapRel ? path.join(issued.a.workspace, ...snapRel.split('/')) : null;
  const snapAgent = snapRel ? path.join(A.root, ...snapRel.split('/')) : null;
  const snapHash = /-([0-9A-F]{64})\.oml$/.exec(snap?.path ?? '')?.[1]?.toLowerCase();
  check('agent -> server OML: studio_snapshot answers a ws: path and the server copy has the sha256 of the agent file',
    snapServer && fs.existsSync(snapServer) && fs.existsSync(snapAgent) && shaFile(snapServer) === snapHash && shaFile(snapAgent) === snapHash && fs.statSync(snapServer).size > 4 * 1024 * 1024,
    { path: snap?.path, size: snapServer && fs.existsSync(snapServer) ? fs.statSync(snapServer).size : null });
  check('the .json sibling of the capture came too', snapServer && fs.existsSync(snapServer + '.json'));

  // 7. Server -> agent: a 9 MiB OML in the workspace (as a server tool would leave it) goes to the agent (3 parts)
  //    and the fake Studio reads exactly those bytes.
  const candidate = path.join(issued.a.workspace, 'odc', 'lab', 'Candidate.oml');
  write(candidate, randomBytes(9 * 1024 * 1024 + 77));
  const candidateSha = shaFile(candidate);
  const opened = await call(clientA, 'studio_open', { module: 'Orders', localOml: 'ws:odc/lab/Candidate.oml' });
  const openLine = odcLines(A).filter(e => e.line.startsWith('open ')).at(-1)?.line ?? '';
  const agentCandidate = path.join(A.root, 'odc', 'lab', 'Candidate.oml');
  check('server -> agent OML: studio_open sends the workspace file; the agent copy and what the Studio read have its sha256',
    opened.isError !== true && sc(opened)?.sha256 === candidateSha && fs.existsSync(agentCandidate) && shaFile(agentCandidate) === candidateSha
      && openLine.includes(agentCandidate) && !openLine.includes(serverDir),
    { reply: sc(opened), bridgeLine: openLine.replace(T, '<T>') });

  // 8. Confinement: a path outside the customer's workspace never reaches the agent.
  const linesBeforeRefusal = odcLines(A).length;
  const outside = sc(await call(clientA, 'studio_open', { module: 'Orders', localOml: 'C:\\Windows\\win.ini' }));
  const internal = sc(await call(clientA, 'studio_open', { module: 'Orders', localOml: 'ws:state/relay-authority/bridge.key' }));
  check('an absolute path outside the workspace is refused (PATH_OUTSIDE_WORKSPACE) before the agent', outside?.code === 'PATH_OUTSIDE_WORKSPACE' && odcLines(A).length === linesBeforeRefusal, outside);
  check('ws:state/... (internal workspace area) is refused too', internal?.code === 'PATH_OUTSIDE_WORKSPACE' && odcLines(A).length === linesBeforeRefusal, internal);

  // 8b. A reply naming agent:..\..\..\.local\server\tokens.json is a protocol violation: nothing read or written, the
  //     channel closes with protocol-error and the agent reconnects by itself.
  const tokensBefore = shaFile(path.join(serverDir, 'tokens.json'));
  const evil = await call(clientA, 'studio_snapshot', { module: 'Evil' });
  check('a path outside the workspace in an agent reply -> AGENT_PROTOCOL_VIOLATION, tokens.json untouched',
    evil.isError === true && /AGENT_PROTOCOL_VIOLATION|outside its workspace/.test(JSON.stringify(evil)) && shaFile(path.join(serverDir, 'tokens.json')) === tokensBefore, sc(evil) ?? evil);
  const back = await waitFor(async () => (await call(clientA, 'studio_status')).isError !== true, 15000, 500);
  check('after the protocol-error close the agent reconnects and calls work again', back);

  // 9. O11 through the relay: nothing before ssam_connect; then the agent's own key, no port from the server.
  const before11 = sc(await call(clientA, 'o11_studio', { command: 'status' }));
  check('o11_studio before ssam_connect -> O11_NOT_CONNECTED', before11?.code === 'O11_NOT_CONNECTED', before11);
  const connected = await call(clientA, 'ssam_connect', { lane: 'o11' });
  check('ssam_connect {lane:o11} connects the customer\'s (fake) Service Studio through the agent', connected.isError !== true, sc(connected) ?? connected);
  const o11Before = studioLog(A).filter(e => e.studio === 'o11').length;
  const o11 = await call(clientA, 'o11_studio', { command: 'status' });
  const o11Seen = studioLog(A).filter(e => e.studio === 'o11').slice(o11Before);
  check('o11_studio status goes server -> agent (o11.bridge) -> fake O11 bridge with the agent\'s own key and no port param',
    o11.isError !== true && o11Seen.length > 0 && o11Seen.every(e => e.authOk || ['ping', 'bridge_manifest'].includes(e.method)) && o11Seen.every(e => !e.hasPort),
    { reply: sc(o11), seen: o11Seen.map(e => e.method + (e.authOk ? '+key' : '')) });

  // 9b. The O11 relay of customer A, spoken to as the server's O11 kernel (BridgeClient) does: one line with A's relay
  //     key. Only A has a hosted context now, so the server process listens on exactly one port besides /mcp.
  const relayPorts = await listeningPorts(health.pid);
  const relayPort = relayPorts.filter(p => p !== backendPort);
  const relayKeyA = fs.readFileSync(path.join(issued.a.workspace, 'state', 'relay-authority', 'bridge.key'), 'ascii').trim();
  const o11Count = () => studioLog(A).filter(e => e.studio === 'o11').length;
  if (check('the server opened one O11 relay (loopback) for customer A', relayPort.length === 1, relayPorts)) {
    const seen0 = o11Count();
    const relayed = await relayLine(relayPort[0], { method: 'list_open_modules', params: {}, authorization: relayKeyA });
    const last = studioLog(A).filter(e => e.studio === 'o11').at(-1);
    check('relay with A\'s relay key -> A\'s agent -> fake bridge, which sees the agent\'s own key (never the relay key)',
      relayed.reply?.success === true && relayed.reply?.data?.method === 'list_open_modules' && o11Count() > seen0 && last?.method === 'list_open_modules' && last?.authOk === true, relayed);
    const seen1 = o11Count();
    const foreign = await relayLine(relayPort[0], { method: 'list_open_modules', params: {}, authorization: randomBytes(32).toString('base64url') });
    check('relay refuses any other key (e.g. the server controller key) with executed:false; nothing reaches the agent',
      foreign.reply?.success === false && foreign.reply?.executed === false && /not this customer's relay key/.test(foreign.reply?.error ?? '') && o11Count() === seen1, foreign);
    A.relayPort = relayPort[0];
  }

  // 9c. The thin O11 bridge contract (docs/O11-BRIDGE-FINA.md 3 and 4): the server's kernel computes the candidate, the
  //     producer signature plan, the element checks and the reference refresh; the fake thin bridge of machine A only
  //     answers primitives. o11Since(n): the requests the fake thin bridge saw after the n-th.
  const o11Since = n => studioLog(A).filter(e => e.studio === 'o11').slice(n);
  const fixtureSha = shaFile(O11_MODULE.oml);
  const serverFile = wsPath => (typeof wsPath === 'string' && wsPath.startsWith('ws:') ? path.join(issued.a.workspace, ...wsPath.slice(3).split('/')) : null);
  let seen = o11Count();
  const capture = sc(await call(clientA, 'o11_studio', { command: 'snapshot' }));
  const captureFile = serverFile(capture?.path);
  check('thin: o11_studio snapshot is snapshot_module on the thin bridge; the open module\'s bytes come to the workspace (sha256 of the module)',
    capture?.ok === true && captureFile && fs.existsSync(captureFile) && shaFile(captureFile) === fixtureSha && capture.sha256 === fixtureSha.toUpperCase()
      && o11Since(seen).some(e => e.method === 'snapshot_module' && e.authOk), { reply: capture, seen: o11Since(seen).map(e => e.method) });

  seen = o11Count();
  const thinJob = { expectValid: true, ops: [{ op: 'logic', data: { actions: [{ name: 'ThinE2EPing', public: true,
    outputs: [{ name: 'Result', type: 'Integer' }], steps: [{ assign: { Result: '1' } }] }] } }] };
  const delivered = await call(clientA, 'o11_deliver', { module: O11_MODULE.name, job: thinJob, checks: ['ThinE2EPing'], authorize: 'pode entregar o ThinE2EPing no Headless_CS' }, 900000);
  const deliverSeen = o11Since(seen);
  const merges = deliverSeen.filter(e => e.method === 'merge_from_oml');
  const work11 = path.join(issued.a.workspace, 'o11', 'work', 'deliver');
  // The newest delivery task of customer A's workspace (the kernel's task.json, payload as JSON text or inline).
  const latestTask = () => {
    const taskIds = fs.existsSync(work11) ? fs.readdirSync(work11).filter(id => /^[0-9a-f]{32}$/i.test(id)) : [];
    return taskIds.map(id => { try { const doc = JSON.parse(fs.readFileSync(path.join(work11, id, 'task.json'), 'utf8').replace(/^﻿/, '')); return typeof doc.payload === 'string' ? JSON.parse(doc.payload) : doc; } catch { return null; } })
      .filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
  };
  const task = latestTask();
  const serverBase = task?.artifacts?.[0]?.path, serverForeign = task?.artifacts?.[1]?.path;
  check('thin: o11_deliver delivers ("delivered") through the relay and the agent to the fake thin bridge',
    delivered.isError !== true && sc(delivered)?.ok === true && sc(delivered)?.result === 'delivered' && task?.delivered === true && task?.writeState === 'applied',
    { reply: sc(delivered) ?? delivered, task: task ? { stage: task.stage, error: task.error, writeState: task.writeState } : null, seen: deliverSeen.map(e => e.method + (e.success ? '' : ':' + e.error)) });
  check('thin: the candidate is computed on the server (apply over the capture) and differs from the base; the bridge merged exactly those bytes',
    task?.apply?.accepted === true && serverBase && serverForeign && fs.existsSync(serverBase) && fs.existsSync(serverForeign) && shaFile(serverForeign) !== shaFile(serverBase)
      && merges.length === 1 && merges[0].merged === true && merges[0].foreignSha256 === shaFile(serverForeign) && merges[0].baseSha256 === shaFile(serverBase),
    { apply: task?.apply ? { accepted: task.apply.accepted, isValid: task.apply.isValid } : null, merges });
  check('thin: merge_from_oml carries the reference_plan the server computed (strict ReferencePlan shape, no producer change in this job)',
    merges.length === 1 && merges[0].plan === 'ok' && merges[0].planChanges === 0 && merges[0].planConflicts === 0 && merges[0].paramKeys.includes('reference_plan'), merges);
  // Captures: the base, the one ThinBridge takes for find_element, and the delivered one of the data proof when the
  // job's data contract has assertions (Delivery.cs "data-proof").
  check('thin: the element check runs on the server over a capture (snapshot_module), never find_element on the bridge',
    task?.checks?.[0]?.count >= 1 && task.checks[0].results?.[0]?.name === 'ThinE2EPing' && !deliverSeen.some(e => e.method === 'find_element')
      && deliverSeen.filter(e => e.method === 'snapshot_module').length === 2 + (task?.deliveredSnapshot ? 1 : 0),
    { checks: task?.checks, dataProof: task?.dataProof?.accepted ?? null, seen: deliverSeen.map(e => e.method) });
  // ping and bridge_manifest answer without a key (the selected-Studio probe); every other request carries the agent's key.
  const probe = e => ['ping', 'bridge_manifest'].includes(e.method);
  // The ninth release: a delivery reads the module's last publication once (publish_log, lastPublication), a read-only
  // primitive of the thin bridge, after the verify.
  check('thin: the bridge saw only primitive verbs of the 21, each with the agent\'s own key',
    // list_open_modules (a read verb of the 21, capability list_open_modules:server_operation) is how a delivery confirms
    // the open module before the capture.
    deliverSeen.length > 0 && deliverSeen.every(e => probe(e) || (e.authOk && ['list_open_modules', 'open_module', 'get_active_module', 'snapshot_module', 'merge_from_oml', 'get_errors', 'publish_log'].includes(e.method)))
      && deliverSeen.filter(e => e.method === 'publish_log').length <= 1,
    deliverSeen.map(e => e.method));
  // C28 over the thin wire: the kernel's verify after the merge asks get_errors with settle; the thin bridge answers
  // settled with a validation generation (get_errors:generation).
  check('thin: the verify after the merge asks get_errors with settle (capability get_errors:generation)',
    deliverSeen.some(e => e.method === 'get_errors' && e.settle === true && e.authOk), deliverSeen.filter(e => e.method === 'get_errors'));
  seen = o11Count();
  const after = sc(await call(clientA, 'o11_studio', { command: 'snapshot' }));
  check('thin: after the merge the open module holds the server\'s candidate (a new capture has its sha256)',
    after?.ok === true && serverForeign && fs.existsSync(serverForeign) && after.sha256 === shaFile(serverForeign).toUpperCase(), { reply: after });
  // The 21st verb (ninth release, O11-BRIDGE-FINA.md 14): the Studio's own Refresh References through the relay and the
  // agent, on the open module's key, with the agent's key.
  seen = o11Count();
  const studioRefresh = sc(await call(clientA, 'o11_studio', { command: 'refresh-references', args: { producers: ['ThinProducer'] } }));
  const studioRefreshSeen = o11Since(seen);
  check('thin: o11_studio refresh-references is refresh_references on the thin bridge, on the open module, with the agent\'s key',
    studioRefresh?.ok === true && studioRefreshSeen.some(e => e.method === 'refresh_references' && e.authOk && JSON.stringify(e.producers) === '["ThinProducer"]'),
    { reply: studioRefresh, seen: studioRefreshSeen.map(e => e.method + (e.success ? '' : ':' + e.error)) });
  // a8 (the next agent pack, C:\t\agent-pack-next\PLANO.md 2.1): the Studio's own Manage Dependencies by code through the thin
  // bridge of the current pack (capability refresh_references:add): add and published reach the bridge unchanged, with the
  // agent's key, and the answer is the Studio's commit.
  seen = o11Count();
  const managedAdd = [{ producer: 'ThinProducer', elements: ['IServerActionSignature:ThinAction'] }];
  const managed = sc(await call(clientA, 'o11_studio', { command: 'refresh-references', args: { add: managedAdd, published: true } }));
  const managedSeen = o11Since(seen);
  check('a8 (a): o11_studio refresh-references with add and published is the Studio\'s Manage Dependencies on the current pack\'s thin bridge (refresh_references:add), the parameters unchanged, the agent\'s key',
    managed?.ok === true && managed.committed === true && managed.command === 'Manage Dependencies'
      && managedSeen.some(e => e.method === 'refresh_references' && e.authOk && e.published === true && JSON.stringify(e.add) === JSON.stringify(managedAdd)),
    { reply: managed, seen: managedSeen.map(e => e.method + (e.success ? '' : ':' + e.error)) });
  // a8 round 2 (review M1 and IP option D): a dialog the Studio opened during the command. The thin bridge closed it: one typed
  // refusal, the dialog first, every text written by the server. A dialog it could not close: never ok, STUDIO_DIALOG_PENDING.
  const dialogReply = sc(await call(clientA, 'o11_studio', { command: 'refresh-references', args: { add: [{ producer: 'ThinDialogProducer', elements: ['IServerActionSignature:ThinAction'] }], published: true } }));
  check('a8 round 2 (M1): the thin bridge closed the dialog of its Manage Dependencies: one typed refusal, the dialog first, the server\'s texts, never ok',
    dialogReply?.ok === false && dialogReply.code === 'REFERENCES_NOT_ADDED' && dialogReply.problems?.[0]?.cause === 'studio-dialog'
      && /^A Studio dialog opened during the Manage Dependencies of [^:]+: "Sign in"/.test(dialogReply.problems[0].message ?? '') && !/fix the cause, then repeat/.test(JSON.stringify(dialogReply)),
    dialogReply);
  const blockedReply = sc(await call(clientA, 'o11_studio', { command: 'refresh-references', args: { add: [{ producer: 'ThinBlockedProducer', elements: ['IServerActionSignature:ThinAction'] }], published: true } }));
  check('a8 round 2 (M1): a dialog the thin bridge could not close is never ok: STUDIO_DIALOG_PENDING, outcome running, the dialog',
    blockedReply?.ok === false && blockedReply.code === 'STUDIO_DIALOG_PENDING' && blockedReply.outcome === 'running' && blockedReply.blockedBy?.kind === 'MergeEditor', blockedReply);
  // a8 (b): the installed extensions and Forge components of the customer's environment: the kernel's listing over the
  // customer's Studio session (environment_session referenceable and signature through the agent), the cache in the
  // customer's own folder, nothing in the server's roots.
  const serverCaches = [path.join(repo, 'kernel', '.local', 'components'), path.join(repo, '.local', 'components')];
  const cacheFiles = () => serverCaches.flatMap(dir => (fs.existsSync(dir) ? fs.readdirSync(dir).map(f => path.join(dir, f) + ':' + fs.statSync(path.join(dir, f)).mtimeMs) : []));
  const serverCachesBefore = cacheFiles();
  seen = o11Count();
  // A call above the hosted deadline (25 s) answers running with its continuation; the client follows it, as an MCP client does.
  const componentsStarted = Date.now();
  let componentsAnswer = sc(await call(clientA, 'ssam_discover', { lane: 'o11', intent: 'which installed extensions of the environment can I use to generate a PDF' }, 600000));
  const componentsRounds = [componentsAnswer?.state ?? 'answer'];
  for (let i = 0; i < 40 && componentsAnswer?.state === 'running' && componentsAnswer?.continuation?.arguments?.continueTask; i++) {
    componentsAnswer = sc(await call(clientA, componentsAnswer.continuation.tool ?? 'ssam_discover', componentsAnswer.continuation.arguments, 600000));
    componentsRounds.push(componentsAnswer?.state ?? 'answer');
  }
  const componentsMs = Date.now() - componentsStarted;
  const componentsSeen = o11Since(seen).filter(e => !probe(e));
  const customerCache = path.join(issued.a.workspace, 'state', 'components');
  const customerCacheFiles = fs.existsSync(customerCache) ? fs.readdirSync(customerCache) : [];
  check('a8 (b): a hosted ssam_discover lists the PDF producer of the customer\'s environment through the agent, keeps the cache in the customer\'s folder and nothing in the server\'s',
    componentsAnswer?.environment?.ok === true && (componentsAnswer.environment.components ?? []).some(c => c.name === 'NeutralPdfEngine' && c.kind === 'Extension')
      && componentsSeen.length > 0 && componentsSeen.every(e => e.method === 'environment_session' && e.authOk) && componentsSeen.some(e => e.operation === 'referenceable')
      && customerCacheFiles.some(f => f.endsWith('.json') && f !== 'last.json') && JSON.stringify(cacheFiles()) === JSON.stringify(serverCachesBefore)
      && ![repo, T, serverDir].some(p => JSON.stringify(componentsAnswer.environment ?? null).toLowerCase().includes(JSON.stringify(p).slice(1, -1).toLowerCase())),
    { rounds: componentsRounds, ms: componentsMs, customerCache: customerCacheFiles, serverCaches: cacheFiles(),
      seen: componentsSeen.map(e => e.method + ':' + e.operation + (e.success ? '' : ':' + e.error)), environment: componentsAnswer?.environment ?? componentsAnswer });

  // 9c. The merge order (Delivery.cs, bridge capability merge_from_oml:first_pass) over the thin wire: an entity attribute
  //     of an identifier type with a default, created by the job, is a default one native merge drops (MergeOrderTests,
  //     OfficePet_CS). The server plans it, asks the bridge's capabilities, mirrors the first-pass copy next to the
  //     candidate, and the thin bridge runs both merges in one merge_from_oml.
  seen = o11Count();
  const orderJob = { expectValid: true, ops: [{ op: 'spec', data: { static: [{ name: 'ThinSpecies', public: true, records: [{ name: 'Dog', id: 1 }, { name: 'Cat', id: 2 }] }],
    entities: [{ name: 'ThinPet', public: true, attributes: [{ name: 'SpeciesId', type: 'ThinSpecies Identifier', mandatory: true, default: 'Entities.ThinSpecies.Dog' }] }] } }] };
  const ordered = await call(clientA, 'o11_deliver', { module: O11_MODULE.name, job: orderJob, checks: ['ThinPet'], authorize: 'pode entregar o ThinPet no Headless_CS' }, 900000);
  const orderSeen = o11Since(seen);
  const orderMerges = orderSeen.filter(e => e.method === 'merge_from_oml');
  const orderTask = latestTask();
  const firstPass = orderTask?.mergePlan?.firstPass;
  check('thin: the merge order over the relay: the server plans the deferred default, the first-pass copy reaches the thin bridge with its sha256, one call merges twice',
    sc(ordered)?.ok === true && sc(ordered)?.result === 'delivered' && orderTask?.writeState === 'applied' && orderTask?.mergePlan?.deferred?.length >= 1
      && typeof firstPass === 'string' && fs.existsSync(firstPass) && orderSeen.some(e => e.method === 'bridge_manifest')
      && orderMerges.length === 1 && orderMerges[0].merged === true && orderMerges[0].paramKeys.includes('first_pass_path')
      && orderMerges[0].paramKeys.includes('first_pass_sha256') && orderMerges[0].firstPassSha256 === shaFile(firstPass) && orderMerges[0].plan === 'ok',
    { reply: sc(ordered) ?? ordered, plan: orderTask?.mergePlan ?? null, task: orderTask ? { stage: orderTask.stage, error: orderTask.error, writeState: orderTask.writeState } : null,
      merges: orderMerges, seen: orderSeen.map(e => e.method + (e.success ? '' : ':' + e.error)) });

  // 9d. The thin wire refusals: find_element is not a verb of the agent's thin list; a merge_from_oml with a base and no
  //     reference_plan (what a phase-2 server sends) is refused by the thin bridge executed:false, before any write.
  if (A.relayPort && serverBase && serverForeign) {
    seen = o11Count();
    const find = await relayLine(A.relayPort, { method: 'find_element', params: { name: 'ThinE2EPing' }, authorization: relayKeyA });
    check('thin: find_element through the relay is refused by the agent (METHOD_NOT_ALLOWED, executed:false); nothing reaches the bridge',
      find.reply?.success === false && find.reply?.executed === false && /METHOD_NOT_ALLOWED|not allowed/i.test(find.reply?.error ?? '') && o11Count() === seen, find);
    const oldBase = path.join(issued.a.workspace, 'o11', 'work', 'phase2-base.oml'), oldForeign = path.join(issued.a.workspace, 'o11', 'work', 'phase2-foreign.oml');
    fs.copyFileSync(serverBase, oldBase); fs.copyFileSync(serverForeign, oldForeign);
    const before2 = sc(await call(clientA, 'o11_studio', { command: 'snapshot' }));
    seen = o11Count();
    const planless = await relayLine(A.relayPort, { method: 'merge_from_oml', params: { base_path: oldBase, foreign_path: oldForeign, mode: 'auto',
      operation_id: randomBytes(16).toString('hex'), module_key: O11_MODULE.key, environment: O11_MODULE.environment }, authorization: relayKeyA }, 120000);
    const planlessSeen = o11Since(seen);
    const after2 = sc(await call(clientA, 'o11_studio', { command: 'snapshot' }));
    check('thin: merge_from_oml with base and without reference_plan (a phase-2 server) -> executed:false from the thin bridge, the module unchanged',
      planless.reply?.success === false && planless.reply?.executed === false && /reference_plan computed by the server/.test(planless.reply?.error ?? '')
        && planlessSeen.length === 1 && planlessSeen[0].plan === 'missing' && before2?.sha256 && before2.sha256 === after2?.sha256,
      { reply: planless.reply ?? planless, seen: planlessSeen });
  }

  // 9e. Publish log and reference refresh: the panel read is a primitive (element only from ExtraInfo); the refresh runs
  //     on the server over environment_session primitives (connect, modules, download, referenceable, signature, close).
  seen = o11Count();
  const log = sc(await call(clientA, 'o11_studio', { command: 'publish-log' }));
  check('thin: o11_studio publish-log reads publish_log on the thin bridge (element from ExtraInfo, fix continuation)',
    log?.ok === true && log.found === true && log.status === 'failed' && log.messages?.[0]?.element?.name === 'ThinE2EPing' && log.continuation?.tool === 'ssam_map'
      && o11Since(seen).some(e => e.method === 'publish_log'), log);
  seen = o11Count();
  const refreshed = await call(clientA, 'o11_environment', { action: 'refresh-refs', module: O11_MODULE.name, authorize: 'pode atualizar as referências do Headless_CS' }, 900000);
  const refreshSeen = o11Since(seen).filter(e => !probe(e));
  const refreshedFile = serverFile(sc(refreshed)?.file);
  const operations = refreshSeen.map(e => e.operation);
  check('thin: the reference refresh is computed on the server: staleness from the referenceable primitive, the refreshed module saved in the workspace',
    sc(refreshed)?.ok === true && (sc(refreshed).refreshed ?? []).includes('(System)') && refreshedFile && fs.existsSync(refreshedFile) && !refreshedFile.startsWith(A.root),
    { reply: sc(refreshed) ?? refreshed, operations });
  check('thin: the refresh reached the bridge only as environment_session primitives',
    refreshSeen.length > 0 && refreshSeen.every(e => e.method === 'environment_session' && e.authOk && ['connect', 'modules', 'download', 'referenceable', 'signature', 'close'].includes(e.operation))
      && ['connect', 'download', 'referenceable'].every(op => operations.includes(op)), refreshSeen.map(e => e.method + ':' + e.operation + (e.success ? '' : ':' + e.error)));

  // 9f. The neutral hosted ODC base and the evidence scrub (docs/O11-BRIDGE-FINA.md 7.2).
  const neutral = await call(clientA, 'ssam_job', { lane: 'odc', job: { expectValid: true, ops: [{ op: 'get', target: '@espace' }] } }, 600000);
  const neutralResult = serverFile(sc(neutral)?.resultFile);
  const neutralSaved = neutralResult && fs.existsSync(neutralResult) ? fs.readFileSync(neutralResult, 'utf8') : '';
  check('neutral: a hosted ssam_job {lane:"odc"} without base runs on the neutral fixture (SsamNeutralApp), never the third-party capture',
    neutral.isError !== true && sc(neutral)?.ok === true && /SsamNeutralApp/.test(neutralSaved) && !/wrightflood/i.test(neutralSaved + JSON.stringify(neutral)),
    { reply: sc(neutral) ?? neutral, saved: neutralSaved.slice(0, 300) });
  const hostedDiscover = [];
  for (const intent of DISCOVER_INTENTS) hostedDiscover.push(await call(clientA, 'ssam_discover', { intent, lane: 'odc' }, 300000));
  const discoverSeen = DISCOVER_INTENTS.map((intent, i) => ({ intent, owner: clientHits(ownerDiscover[i]), hosted: clientHits(hostedDiscover[i]),
    omitted: sc(hostedDiscover[i])?.hostedEvidenceOmitted ?? null,
    error: hostedDiscover[i].thrown ?? (hostedDiscover[i].isError || !sc(hostedDiscover[i]) ? sc(hostedDiscover[i])?.error ?? 'no answer' : null) }));
  check('neutral: the ODC lane runs on the anonymized fixture, so neither the owner\'s discover answers nor the hosted ones cite the client capture; the hosted answers carry no client text of client-content.json',
    discoverSeen.every(d => d.error === null && d.hosted.length === 0)
      && !/wrightflood-personal-r8/i.test(JSON.stringify(ownerDiscover[0])),
    discoverSeen);

  // 9g. The 22nd product release over the hosted path (servidor/fase4-22).
  //   - studio_deliver: the capture comes from the customer's (fake) ODC Studio through the agent, the server's kernel
  //     builds over it and refuses ONCE with every problem of every phase; the Studio sees the capture only.
  //   - o11_deliver: the same through the relay and the thin bridge; no merge_from_oml, the open module unchanged.
  //   - ssam_map view:"digest": the server's kernel readers write the module digest of a capture of the customer's
  //     workspace; the answer pins the ws: capture and names no server path.
  //   - ssam_reference check-job with a declared base: only the job is read hosted (the base would resolve on the server).
  const textOf = value => JSON.stringify(value ?? null);
  const serverPathIn = value => { const text = textOf(value); return [repo, T, serverDir].some(p => text.toLowerCase().includes(JSON.stringify(p).slice(1, -1).toLowerCase())); };
  const pcOdc = JSON.parse(fs.readFileSync(path.join(repo, 'kernel', 'tests', 'jobs-odc-negative', 'pa4-pc-four-phases.json'), 'utf8').replace(/^﻿/, ''));
  const pcO11 = JSON.parse(fs.readFileSync(path.join(repo, 'kernel', 'tests', 'jobs-negative', 'pa4-pc-four-phases.json'), 'utf8').replace(/^﻿/, ''));
  const PC_CODES = ['EXPR_UNKNOWN_IDENTIFIER', 'DEFAULT_LITERAL_INVALID', 'REFERENCE_UNRESOLVED', 'ExpressionInvalidExpressionType'];
  const refusalSummary = value => (value && typeof value === 'object' ? { code: value.code ?? null, failed: value.failed ?? value.stage ?? null, verifyRan: value.verifyRan ?? null,
    verifyReason: value.verifyReason ?? null, phases: value.phases ?? null, problems: Array.isArray(value.problems) ? value.problems.map(p => (p.phase ?? '?') + ':' + p.code) : null,
    error: typeof value.error === 'string' ? value.error.slice(0, 160) : null } : value);
  const singleRefusal = value => value?.ok === false && value.code === 'PREFLIGHT_REFUSED' && Array.isArray(value.problems)
    && PC_CODES.every(code => textOf(value.problems).includes(code)) && /has no child 'PcNoSuchNode'/.test(textOf(value.problems)) && value.verifyRan === true
    // The phase of each problem (the answer's `phases` list is replaced by the build-phase timings of lane wp on a delivery
    // that built: studio-write-lock.mjs runPhased, product behavior, the same outside a hosted server).
    && ['preflight', 'base', 'apply', 'verify'].every(phase => value.problems.some(p => p.phase === phase));
  const odcCapture = sc(await call(clientA, 'studio_snapshot', { module: ODC_MODULE.name }));
  const odcCaptureFile = serverFile(odcCapture?.path);
  check('22nd: studio_snapshot of the ODC module brings its real capture to the workspace (ws:odc/snapshots)',
    odcCaptureFile && fs.existsSync(odcCaptureFile) && shaFile(odcCaptureFile) === shaFile(ODC_MODULE.oml) && /^ws:odc\/snapshots\//.test(odcCapture.path), odcCapture);
  write(path.join(A.root, 'inbox', 'pc-odc-four-phases.json'), JSON.stringify({ ops: pcOdc.ops }, null, 1));
  const odcLinesBeforeDeliver = odcLines(A).length;
  const odcRefused = await call(clientA, 'studio_deliver', { feature: 'pc-four-phases', module: ODC_MODULE.name, job: 'agent:inbox/pc-odc-four-phases.json',
    owners: ['e2e'], changes: ['The single refusal over the hosted path'] }, 900000);
  const odcDeliverLines = odcLines(A).slice(odcLinesBeforeDeliver).map(e => e.line.split(' ')[0]);
  check('22nd: hosted studio_deliver refuses ONCE with every problem of every phase (preflight, base, apply, Verify), verifyRan:true, built on the server over the capture the agent brought',
    singleRefusal(sc(odcRefused)), sc(odcRefused) ? refusalSummary(sc(odcRefused)) : odcRefused);
  check('22nd: the customer\'s ODC Studio saw only the capture of that delivery (snapshot), never a merge, check-base, preview or open',
    odcDeliverLines.length >= 1 && odcDeliverLines.every(c => c === 'snapshot' || c === 'status'), odcDeliverLines);
  check('22nd: the hosted refusal names no server path', !serverPathIn(sc(odcRefused)), textOf(sc(odcRefused)).slice(0, 300));

  seen = o11Count();
  const o11BeforeRefusal = sc(await call(clientA, 'o11_studio', { command: 'snapshot' }));
  seen = o11Count();
  const o11Refused = await call(clientA, 'o11_deliver', { module: O11_MODULE.name, job: { ops: pcO11.ops }, authorize: 'pode entregar no Headless_CS' }, 900000);
  const o11RefusedSeen = o11Since(seen);
  const o11AfterRefusal = sc(await call(clientA, 'o11_studio', { command: 'snapshot' }));
  check('22nd: hosted o11_deliver refuses ONCE with every problem of every phase over the live module (relay + thin bridge capture, kernel on the server), verifyRan:true',
    singleRefusal(sc(o11Refused)), sc(o11Refused) ? refusalSummary(sc(o11Refused)) : o11Refused);
  check('22nd: the thin bridge saw reads only (no merge_from_oml, no refresh_references) and the open module is unchanged',
    o11RefusedSeen.some(e => e.method === 'snapshot_module' && e.authOk) && !o11RefusedSeen.some(e => ['merge_from_oml', 'refresh_references', 'publish'].includes(e.method))
      && o11BeforeRefusal?.sha256 && o11BeforeRefusal.sha256 === o11AfterRefusal?.sha256,
    { seen: o11RefusedSeen.map(e => e.method), before: o11BeforeRefusal?.sha256 ?? null, after: o11AfterRefusal?.sha256 ?? null });

  for (const [lane, captured, moduleName] of [['odc', odcCapture?.path, ODC_MODULE.name], ['o11', o11AfterRefusal?.path, O11_MODULE.name]]) {
    const digest = await call(clientA, 'ssam_map', { lane, target: captured, view: 'digest' }, 600000);
    const page = sc(digest);
    const next = page?.continuations?.next ?? null;
    // servidor/fase4-25 (pre-swap Q1): marco-a5 fits each answer to its kind's budget (answer-size.mjs): a read answer may
    // lose store and continuations from its envelope (never text or contents) and is kept whole in the customer's
    // ws:o11/answers, named by omitted {tool:"ssam_evidence"}. Either form passes; whatever is there pins the capture.
    const omitted = page?.omitted ?? null;
    const viaEvidence = omitted?.tool === 'ssam_evidence' && /^ws:o11\/answers\/[0-9a-f]{64}\.json$/.test(omitted.arguments?.file ?? '');
    check(`22nd: hosted ssam_map {lane:"${lane}", view:"digest"} over a capture of the customer's workspace: the server's reader writes the digest, page 1 names the module`,
      digest.isError !== true && page?.ok === true && page.schema === 'ssam-digest-page/1' && page.page === 1 && typeof page.text === 'string' && page.text.includes(moduleName)
        && page.file === captured && (page.store === undefined ? viaEvidence : page.store?.file === '<server>'),
      page ? { ok: page.ok, schema: page.schema, file: page.file, store: page.store, pages: page.pages, cache: page.cache, omitted, error: page.error } : digest);
    check(`22nd: the ${lane} digest answer pins the ws: capture in its continuations and names no server path`,
      (page?.continuations ? page.continuations.page?.arguments?.target === captured && (next === null || next.arguments?.target === captured) : viaEvidence)
        && !serverPathIn(page),
      { next, page: page?.continuations?.page ?? null, omitted });
  }

  const hostedCheck = sc(await call(clientA, 'ssam_reference', { lane: 'odc', kind: 'check-job', query: { base: 'tests/fixtures/odc/blank-mobile.oml', ops: pcOdc.ops } }));
  check('22nd: hosted ssam_reference check-job with a declared base reads the job alone (verifyRan:false, the hosted reason), never an apply over a server file',
    hostedCheck?.verifyRan === false && /^hosted SSAM server: the base this job declares is not read here/.test(hostedCheck?.verifyReason ?? '') && !serverPathIn(hostedCheck), hostedCheck);

  // 9h. The 23rd product release over the hosted path (servidor/fase4-23).
  //   - patch by name and partial job: a refused studio_deliver / o11_deliver names nextBasedOn in the customer's
  //     workspace (ws:) and each certain patch also by name; the correction travels as a patch by name, or as only the
  //     changed action (a partial job), over that basedOn; the whole job is written in the workspace, the Studio still
  //     sees captures only, and nothing names a server path;
  //   - ssam_reference check-job {basedOn, patch}: the patched job in ws:odc/.local/jobs/inline, read alone (hosted reason);
  //   - ssam_discover {app, packet:true}: the work packet over a ws: capture, its module section read by the server's
  //     kernel reader;
  //   - ssam_map views search and uses: over ws: captures and over a list with the open module's name (captured through
  //     the relay), the rich index written by the server's reader; a server path in the list never reaches the reader.
  const inWs = (wsPath, prefix) => typeof wsPath === 'string' && wsPath.startsWith(prefix) && fs.existsSync(serverFile(wsPath));
  const codesOf = value => (Array.isArray(value?.problems) ? value.problems.map(p => p.code) : []);
  const firstOdc = sc(odcRefused);
  check('23rd: the hosted studio_deliver refusal names nextBasedOn in the customer\'s workspace (the job it ran) and each certain patch also by name',
    firstOdc?.nextBasedOn?.job === 'ws:inbox/pc-odc-four-phases.json' && firstOdc.nextBasedOn.sha256 === shaFile(path.join(issued.a.workspace, 'inbox', 'pc-odc-four-phases.json'))
      && (firstOdc.problems ?? []).some(p => Array.isArray(p.patchByName) && p.patchByName.length),
    { nextBasedOn: firstOdc?.nextBasedOn ?? null, problems: (firstOdc?.problems ?? []).map(p => p.code + (p.patchByName ? '+byName' : '')) });
  const odcLinesBeforePatch = odcLines(A).length;
  const byName = await call(clientA, 'studio_deliver', { feature: 'pc-four-phases', module: ODC_MODULE.name, owners: ['e2e'], changes: ['Patch by name over the hosted path'],
    basedOn: firstOdc?.nextBasedOn, patch: [{ op: 'replace', path: 'actions/PcTotal/steps/0/assign/Total', value: 'Quantity' }] }, 900000);
  const second = sc(byName);
  const patchedFile = serverFile(second?.nextBasedOn?.job);
  check('23rd: hosted studio_deliver with a patch by name over basedOn: the corrected job is written in ws:odc/.local/jobs/inline, the fixed problem is gone, the others come again at once',
    second?.ok === false && inWs(second?.nextBasedOn?.job, 'ws:odc/.local/jobs/inline/') && JSON.parse(fs.readFileSync(patchedFile, 'utf8')).ops[0].data.actions[0].steps[0].assign.Total === 'Quantity'
      && !codesOf(second).includes('EXPR_UNKNOWN_IDENTIFIER') && ['REFERENCE_UNRESOLVED', 'ExpressionInvalidExpressionType'].every(code => textOf(second.problems).includes(code)) && !serverPathIn(second),
    second ? { ...refusalSummary(second), nextBasedOn: second.nextBasedOn ?? null } : byName);
  const partialOdc = await call(clientA, 'studio_deliver', { feature: 'pc-four-phases', module: ODC_MODULE.name, owners: ['e2e'], changes: ['Partial job over the hosted path'],
    basedOn: second?.nextBasedOn, job: { ops: [{ op: 'logic', data: { actions: [{ name: 'PcTotal', kind: 'server', description: 'Synthetic action of the four-phase refusal, corrected.',
      inputs: [{ name: 'Quantity', type: 'Integer' }, { name: 'Prefix', type: 'Text', default: '"abc"', mandatory: false }],
      outputs: [{ name: 'Total', type: 'Integer' }, { name: 'Code', type: 'Integer' }, { name: 'Shown', type: 'Text' }],
      steps: [{ assign: { Total: 'Quantity' } }, { assign: { Code: '1' } }, { assign: { Shown: 'Prefix' } }] }] } }] } }, 900000);
  const third = sc(partialOdc);
  check('23rd: hosted studio_deliver with only the changed action (a partial job) over basedOn: partial names what it replaced, the whole job is in the workspace, only the problems left come back',
    third?.ok === false && third.partial?.replaced === 1 && inWs(third?.nextBasedOn?.job, 'ws:odc/.local/jobs/inline/') && third.nextBasedOn.job !== second?.nextBasedOn?.job
      && !codesOf(third).some(code => ['EXPR_UNKNOWN_IDENTIFIER', 'ExpressionInvalidExpressionType'].includes(code)) && textOf(third.problems).includes('REFERENCE_UNRESOLVED') && !serverPathIn(third),
    third ? { ...refusalSummary(third), partial: third.partial ?? null, nextBasedOn: third.nextBasedOn ?? null } : partialOdc);
  const odcPatchLines = odcLines(A).slice(odcLinesBeforePatch).map(e => e.line.split(' ')[0]);
  check('23rd: the customer\'s ODC Studio saw only captures of those two deliveries, never a merge',
    odcPatchLines.length >= 1 && odcPatchLines.every(c => c === 'snapshot' || c === 'status'), odcPatchLines);

  const firstO11 = sc(o11Refused);
  seen = o11Count();
  const o11ByName = await call(clientA, 'o11_deliver', { module: O11_MODULE.name, basedOn: firstO11?.nextBasedOn,
    patch: [{ op: 'replace', path: 'actions/PcTotal/steps/0/assign/Total', value: 'Quantity' }], authorize: 'pode entregar no Headless_CS' }, 900000);
  const o11Second = sc(o11ByName);
  const o11PatchSeen = o11Since(seen);
  const o11AfterPatch = sc(await call(clientA, 'o11_studio', { command: 'snapshot' }));
  check('23rd: hosted o11_deliver: the refusal named nextBasedOn in ws:o11/; a patch by name over it refuses again without the fixed problem, the corrected job in ws:o11/jobs/inline',
    inWs(firstO11?.nextBasedOn?.job, 'ws:o11/') && o11Second?.ok === false && inWs(o11Second?.nextBasedOn?.job, 'ws:o11/jobs/inline/')
      && !codesOf(o11Second).includes('EXPR_UNKNOWN_IDENTIFIER') && textOf(o11Second.problems).includes('REFERENCE_UNRESOLVED') && !serverPathIn(o11Second),
    o11Second ? { ...refusalSummary(o11Second), first: firstO11?.nextBasedOn ?? null, nextBasedOn: o11Second.nextBasedOn ?? null, continuation: o11Second.continuation ?? null } : o11ByName);
  check('23rd: the thin bridge saw reads only for the patched delivery and the open module is unchanged',
    !o11PatchSeen.some(e => ['merge_from_oml', 'refresh_references', 'publish'].includes(e.method)) && o11AfterRefusal?.sha256 && o11AfterRefusal.sha256 === o11AfterPatch?.sha256,
    { seen: o11PatchSeen.map(e => e.method), before: o11AfterRefusal?.sha256 ?? null, after: o11AfterPatch?.sha256 ?? null });

  const named = sc(await call(clientA, 'ssam_reference', { lane: 'odc', kind: 'check-job',
    query: { basedOn: hostedCheck?.nextBasedOn, patch: [{ op: 'replace', path: 'actions/PcTotal/steps/0/assign/Total', value: 'Quantity' }] } }));
  check('23rd: hosted ssam_reference check-job {basedOn, patch by name}: the patched job in ws:odc/.local/jobs/inline, still read alone (hosted reason), nextBasedOn for the next call',
    inWs(hostedCheck?.nextBasedOn?.job, 'ws:odc/.local/jobs/inline/') && inWs(named?.job, 'ws:odc/.local/jobs/inline/') && named.nextBasedOn?.job === named.job && named.job !== hostedCheck.nextBasedOn.job
      && named.verifyRan === false && /^hosted SSAM server: the base this job declares is not read here/.test(named.verifyReason ?? '') && !serverPathIn(named),
    { first: hostedCheck?.nextBasedOn ?? null, named });
  const foreignBase = sc(await call(clientA, 'ssam_reference', { lane: 'odc', kind: 'check-job',
    query: { basedOn: { job: path.join(serverDir, 'tokens.json'), sha256: 'a'.repeat(64) }, patch: [] } }));
  check('23rd: a check-job basedOn outside the workspace is refused by the gate (PATH_OUTSIDE_WORKSPACE)', foreignBase?.code === 'PATH_OUTSIDE_WORKSPACE', foreignBase);

  for (const [lane, captured, moduleName] of [['odc', odcCapture?.path, ODC_MODULE.name], ['o11', o11AfterPatch?.path, O11_MODULE.name]]) {
    const packet = await call(clientA, 'ssam_discover', { lane, intent: 'mudar a action PcTotal do modulo', app: captured, packet: true }, 600000);
    const value = sc(packet);
    check(`23rd: hosted ssam_discover {lane:"${lane}", app: ws: capture, packet:true}: the work packet with the module read by the server's kernel reader, no server path, no client text`,
      // module.file is the capture that answers the read: this one, or the first intact one of the same content (C15).
      // servidor/fase4-26 a7 (CX11 R5): the packet's default budget is 8 KB; a module section that does not fit is a cut whose
      // recover call names the same ws: capture. The read is the server's either way: the delivery step names the module, and
      // it is the lane's delivery tool, or (a8: ssam_code served hosted, the local packet) the code form of ssam_code.
      packet.isError !== true && value?.ok === true && value.schemaVersion === 'ssam-packet/1' && value.app === captured
        && (value.module ? value.module.name === moduleName && inWs(value.module.file, 'ws:' + lane + '/')
          : (value.cuts ?? []).some(c => c.section === 'module' && c.recover?.tool === 'ssam_discover' && c.recover.arguments?.app === captured))
        && ['ssam_code', lane === 'o11' ? 'o11_deliver' : 'studio_deliver'].includes(value.next?.deliver?.tool) && value.next.deliver.arguments?.module === moduleName
        && !serverPathIn(value) && clientHits(value).length === 0,
      value ? { ok: value.ok, schema: value.schemaVersion, app: value.app, module: value.module ? { name: value.module.name, file: value.module.file } : null,
        moduleCut: (value.cuts ?? []).find(c => c.section === 'module') ?? null, deliver: value.next?.deliver ? { tool: value.next.deliver.tool, module: value.next.deliver.arguments?.module ?? null } : null,
        serverPath: serverPathIn(value), size: value.size, error: value.error ?? null, client: clientHits(value) } : packet);
  }

  const search = sc(await call(clientA, 'ssam_map', { lane: 'odc', target: odcCapture?.path, view: 'search', text: ODC_MODULE.name }, 600000));
  check('23rd: hosted ssam_map {view:"search"} over a ws: capture: the server\'s reader writes the rich index, hits with @key, captures pinned to ws:, no server path',
    search?.ok === true && search.count >= 1 && inWs(search.captures?.[0]?.file, 'ws:odc/') && search.captures[0].rich?.file === '<server>' && !serverPathIn(search),
    search ? { ok: search.ok, count: search.count, captures: search.captures?.map(c => ({ module: c.module, file: c.file, rich: c.rich?.file, cache: c.cache })), error: search.error ?? null } : search);
  seen = o11Count();
  const uses = sc(await call(clientA, 'ssam_map', { lane: 'o11', target: [capture?.path, O11_MODULE.name], view: 'uses', element: 'ThinE2EPing' }, 600000));
  const usesSeen = o11Since(seen);
  // The module name is captured as captureO11Module decides (the open tab by its key, else its published OML through the
  // environment_session primitives): either way through the relay and the agent, with the agent's key, read-only.
  check('23rd: hosted ssam_map {view:"uses"} over a list with a ws: capture and the module\'s name: the name is captured through the relay and the agent (read-only, the agent\'s key), both captures in ws:o11/, the element resolved, no server path',
    uses?.ok === true && uses.captures?.length === 2 && uses.captures.every(c => inWs(c.file, 'ws:o11/')) && uses.resolved?.name === 'ThinE2EPing'
      && usesSeen.some(e => ['snapshot_module', 'environment_session'].includes(e.method) && e.authOk) && usesSeen.every(e => probe(e) || e.authOk)
      && !usesSeen.some(e => ['merge_from_oml', 'publish', 'refresh_references', 'open_module'].includes(e.method)) && !serverPathIn(uses),
    uses ? { ok: uses.ok, seen: usesSeen.map(e => e.method + (e.authOk ? '+key' : '')), files: uses.captures?.map(c => c.file), consumers: uses.consumers ?? null, server: serverPathIn(uses),
      code: uses.code ?? null, error: uses.error ?? null } : uses);
  const outsideList = sc(await call(clientA, 'ssam_map', { lane: 'odc', target: [odcCapture?.path, path.join(repo, 'kernel', 'tests', 'fixtures', 'odc', 'blank-mobile.oml')], view: 'search', text: 'x' }));
  check('23rd: a server path in a list target is refused by the gate (PATH_OUTSIDE_WORKSPACE) before any read', outsideList?.code === 'PATH_OUTSIDE_WORKSPACE', outsideList);

  // 9i. The 24th product release over the hosted path (servidor/fase4-24, PLANO-24-PRODUCAO B6.7).
  //   - studio_reference_producers: odc.pipe reference-producers <Module> on the customer's (fake) ODC Studio, read only;
  //   - o11_service_center_read through sc_http: the Studio's own headless HTTP session on the thin bridge, never sc_web,
  //     studio_login or a window;
  //   - odc_mcp_connection readiness through the headless Portal session (portal-session fetch): each request file in
  //     ws:odc/journal/portal/requests, mirrored to the agent, never under a bridge root of the server (R4);
  //   - HOSTED_UNAVAILABLE on the three debugger tools and the four API Client tools (cause API_CLIENT_ONLY), the
  //     prototype op refused at the gate (D2) and a server path under a renamed argument ({targt}) confined (R1);
  //   - customer C still on the v48 pack (the 23rd agent lists, ODC bridge v48, the thin bridge of the 23rd): accepted by
  //     kernel.json odcBridgeAccepted and served on its v48 pipe; the Service Center answers STUDIO_BRIDGE_OUTDATED and
  //     reference-producers COMMAND_NOT_ALLOWED, typed, before anything of theirs reaches a Studio (R5, R7).
  const odcSince = n => odcLines(A).slice(n).map(e => e.line);
  let odcSeen = odcLines(A).length;
  const producers = await call(clientA, 'studio_reference_producers', { module: ODC_MODULE.name });
  const producerLines = odcSince(odcSeen);
  check('24th: studio_reference_producers is odc.pipe reference-producers <Module> on the customer\'s (fake) ODC Studio through the agent, read only, no server path',
    producers.isError !== true && sc(producers)?.ok === true && sc(producers).scope === 'consumer-session-visible-producers' && sc(producers).producers?.[0]?.name === 'NeutralProducerLib'
      && producerLines.includes('reference-producers ' + ODC_MODULE.name) && !producerLines.some(l => /^(merge|publish|open|check-base|preview) /.test(l)) && !serverPathIn(sc(producers)),
    { reply: sc(producers) ?? producers, seen: producerLines });

  seen = o11Count();
  const scRead = await call(clientA, 'o11_service_center_read', { action: 'db-connections', host: O11_MODULE.environment }, 120000);
  const scSeen = o11Since(seen);
  const scValue = sc(scRead);
  // The O11 lane answers {ok, lane, verb, exitCode, result}: result is the Service Center's own answer.
  const scBody = scValue?.result && typeof scValue.result === 'object' ? scValue.result : scValue;
  check('24th: hosted o11_service_center_read {action:"db-connections"} reads the page through sc_http (the Studio\'s own headless HTTP session, auth studio-http), with the agent\'s key',
    scRead.isError !== true && scValue?.ok === true && scBody?.ok === true && scBody.auth?.path === 'studio-http' && scBody.connections?.[0]?.name === 'SampleWarehouse' && scBody.connections[0].id === '7'
      && scSeen.some(e => e.method === 'sc_http' && e.authOk && e.scAction === 'fetch' && e.scMethod === 'GET' && e.scPath === '/ServiceCenter/DatabaseConnections_List.aspx'),
    { reply: scValue ?? scRead, seen: scSeen.map(e => e.method + (e.scAction ? ':' + e.scAction : '') + (e.success ? '' : ':' + e.error)) });
  check('24th: the Service Center read never asked sc_web, studio_login or the private transport of the thin bridge, and names no server path',
    scSeen.length > 0 && !scSeen.some(e => ['sc_web', 'studio_login', 'sc_private_http', 'sc_private_http_cookie'].includes(e.method)) && !serverPathIn(scValue), scSeen.map(e => e.method));

  const requestsDir = path.join(issued.a.workspace, 'odc', 'journal', 'portal', 'requests');
  const listRequests = () => (fs.existsSync(requestsDir) ? fs.readdirSync(requestsDir) : []);
  const requestsBefore = listRequests();
  odcSeen = odcLines(A).length;
  const readiness = await call(clientA, 'odc_mcp_connection', { tenant: ODC_MODULE.host, action: 'readiness', connectionId: 'e2e-mcp-connection' }, 300000);
  const ready = sc(readiness);
  const fetchFiles = odcSince(odcSeen).filter(l => l.startsWith('portal-session fetch ')).map(l => l.split(' ')[2]);
  const newRequests = listRequests().filter(name => !requestsBefore.includes(name));
  check('24th: hosted odc_mcp_connection readiness through the headless Portal session of the customer\'s Studio (portal-session fetch): the connection, its actions, readyForToolImport',
    readiness.isError !== true && ready?.ok === true && ready.exists === true && ready.readyForToolImport === true && ready.connection?.connectionId === 'e2e-mcp-connection'
      && ready.availableActionCount === 2 && ready.selectedActionCount === 1 && fetchFiles.length >= 5,
    { reply: ready ?? readiness, fetches: fetchFiles.length });
  check('24th: every Portal request is a file of the customer\'s workspace (ws:odc/journal/portal/requests) that the agent read from its own mirror; no server path in the answer',
    fetchFiles.length > 0 && fetchFiles.every(file => path.dirname(file) === path.join(A.root, 'odc', 'journal', 'portal', 'requests') && newRequests.includes(path.basename(file)))
      && !serverPathIn(ready), { agentFiles: fetchFiles.map(file => file.replace(T, '<T>')), newRequests: newRequests.length });

  const UNAVAILABLE_24 = { ssam_debug_server: { command: 'status' }, ssam_debug_client: { command: 'status' }, ssam_debug_matrix: { op: 'check' },
    odc_native_package: { tenant: ODC_MODULE.host, operationKey: randomUUID(), operationUuid: randomUUID() },
    odc_generated_code: { tenant: ODC_MODULE.host, buildKey: randomUUID() },
    odc_asset_source: { tenant: ODC_MODULE.host, assetKey: randomUUID(), revisionNumber: 1 },
    odc_asset_revision: { tenant: ODC_MODULE.host, assetKey: randomUUID(), expectedRevision: 1, file: 'ws:odc/lab/Candidate.oml', expectedSha256: 'a'.repeat(64) } };
  const API_CLIENT_ONLY = ['odc_native_package', 'odc_generated_code', 'odc_asset_source', 'odc_asset_revision'];
  odcSeen = odcLines(A).length; seen = o11Count();
  const unavailable = {};
  for (const [name, args] of Object.entries(UNAVAILABLE_24)) unavailable[name] = sc(await call(clientA, name, args));
  check('24th: the three debugger tools and the four API Client tools answer HOSTED_UNAVAILABLE (cause API_CLIENT_ONLY and a continuation to another tool for the four); nothing reached a Studio',
    Object.entries(unavailable).every(([name, value]) => value?.code === 'HOSTED_UNAVAILABLE'
      && (API_CLIENT_ONLY.includes(name) ? value.cause === 'API_CLIENT_ONLY' && typeof value.continuation?.tool === 'string' && value.continuation.tool !== name : value.cause === undefined))
      && odcLines(A).length === odcSeen && o11Count() === seen,
    Object.fromEntries(Object.entries(unavailable).map(([name, value]) => [name, { code: value?.code ?? null, cause: value?.cause ?? null, next: value?.continuation?.tool ?? null }])));

  const PROTOTYPE = { op: 'prototype', data: { source: 'ws:inbox/prototype' } };
  odcSeen = odcLines(A).length; seen = o11Count();
  const prototypes = {};
  for (const [name, args] of [['ssam_job', { lane: 'odc', job: { ops: [PROTOTYPE] } }], ['o11_job', { job: { ops: [PROTOTYPE] } }],
    ['studio_deliver', { feature: 'prototype', module: ODC_MODULE.name, job: { ops: [PROTOTYPE] }, owners: ['e2e'], changes: ['The prototype op over the hosted path'] }],
    ['o11_deliver', { module: O11_MODULE.name, job: { ops: [PROTOTYPE] }, authorize: 'pode entregar no Headless_CS' }]])
    prototypes[name] = sc(await call(clientA, name, args, 120000));
  check('24th (D2): the prototype op is refused at the gate in the four job tools (HOSTED_UNAVAILABLE, cause PROTOTYPE_IMPORT_DISABLED, not-sent), before any capture',
    Object.values(prototypes).every(value => value?.code === 'HOSTED_UNAVAILABLE' && value.cause === 'PROTOTYPE_IMPORT_DISABLED' && value.outcome === 'not-sent')
      && odcLines(A).length === odcSeen && o11Count() === seen,
    Object.fromEntries(Object.entries(prototypes).map(([name, value]) => [name, { code: value?.code ?? null, cause: value?.cause ?? null, outcome: value?.outcome ?? null }])));

  // 24th (D2): a COMPOSITE job hides the prototype op in a sub-part the kernel's CollectOps would concatenate. The
  // customer stages both files in the workspace inbox; the sub-part's data.capture points at a server file outside the
  // workspace. The gate follows the composite part strictly inside the workspace and refuses before any capture, so the
  // server file is never read.
  const outsideCapture = path.join(serverDir, 'tokens.json'); // a server file outside any customer workspace
  const tokensBeforeComposite = shaFile(outsideCapture);
  write(path.join(issued.a.workspace, 'inbox', 'proto-sub.json'), JSON.stringify({ ops: [{ op: 'prototype', data: { source: 'x', capture: outsideCapture, captureSha256: 'a'.repeat(64) } }] }));
  write(path.join(issued.a.workspace, 'inbox', 'proto-main.json'), JSON.stringify({ jobs: ['proto-sub.json'] }));
  odcSeen = odcLines(A).length; seen = o11Count();
  const composites = {};
  for (const [name, args] of [['ssam_job', { lane: 'o11', job: 'ws:inbox/proto-main.json' }], ['o11_job', { job: 'ws:inbox/proto-main.json' }],
    ['studio_deliver', { feature: 'composite', module: ODC_MODULE.name, job: 'ws:inbox/proto-main.json', owners: ['e2e'], changes: ['A composite prototype job over the hosted path'] }],
    ['o11_deliver', { module: O11_MODULE.name, job: 'ws:inbox/proto-main.json', authorize: 'pode entregar no Headless_CS' }]])
    composites[name] = sc(await call(clientA, name, args, 120000));
  check('24th (D2): a composite job whose sub-part carries the prototype op is refused at the gate too, before any capture; the server file its data.capture named was never read',
    Object.values(composites).every(value => value?.code === 'HOSTED_UNAVAILABLE' && value.cause === 'PROTOTYPE_IMPORT_DISABLED' && value.outcome === 'not-sent')
      && odcLines(A).length === odcSeen && o11Count() === seen && shaFile(outsideCapture) === tokensBeforeComposite,
    Object.fromEntries(Object.entries(composites).map(([name, value]) => [name, { code: value?.code ?? null, cause: value?.cause ?? null, outcome: value?.outcome ?? null }])));

  const renamedOutside = sc(await call(clientA, 'ssam_map', { lane: 'odc', targt: ODC_MODULE.oml, view: 'search', text: 'x' }));
  check('24th (R1): a server path under a renamed argument ({targt}) is confined as the target it runs as: PATH_OUTSIDE_WORKSPACE before any read',
    renamedOutside?.code === 'PATH_OUTSIDE_WORKSPACE', renamedOutside);
  const renamedInside = sc(await call(clientA, 'ssam_map', { lane: 'odc', targt: odcCapture?.path, view: 'search', text: ODC_MODULE.name }, 600000));
  check('24th (R1): the same renamed argument naming a ws: capture runs as target (the rich index over the customer\'s capture, no server path)',
    renamedInside?.ok === true && renamedInside.count >= 1 && inWs(renamedInside.captures?.[0]?.file, 'ws:odc/') && !serverPathIn(renamedInside),
    renamedInside ? { ok: renamedInside.ok, count: renamedInside.count, code: renamedInside.code ?? null, error: renamedInside.error ?? null } : renamedInside);

  // 9j. The product's marco-a5 over the hosted path (servidor/fase4-25, C:\t\vps-a5\PLANO.md section 5): the generators still
  // pending their blind test are refused at the gate (rest-consume naming an internal address included: nothing is fetched),
  // and the private credential window of odc_portal_login never opens. (ssam_code: served since a8, step 9k.)
  odcSeen = odcLines(A).length; seen = o11Count();
  const GENERATOR_OPS = { 'entity-actions': { op: 'entity-actions', data: { entities: 'all' } },
    'rest-consume': { op: 'rest-consume', data: { name: 'Internal', methods: [{ name: 'Probe', url: 'http://127.0.0.1:9/internal' }] } },
    'gen-screen': { op: 'screen', data: { generate: { entities: ['Order'] } } } };
  const generated = {};
  for (const [id, op] of Object.entries(GENERATOR_OPS))
    for (const [name, args] of [['ssam_job', { lane: 'o11', job: { ops: [op] } }], ['o11_job', { job: { ops: [op] } }],
      ['studio_deliver', { feature: 'generator', module: ODC_MODULE.name, job: { ops: [op] }, owners: ['e2e'], changes: ['A pending generator over the hosted path'] }],
      ['o11_deliver', { module: O11_MODULE.name, job: { ops: [op] }, authorize: 'pode entregar no Headless_CS' }]])
      generated[id + ' ' + name] = { id, value: sc(await call(clientA, name, args, 120000)) };
  check('marco-a5 (D2): the generators pending their blind test are refused at the gate in the four job tools (HOSTED_UNAVAILABLE, cause GENERATOR_PENDING, not-sent), before any capture',
    Object.values(generated).every(({ id, value }) => value?.code === 'HOSTED_UNAVAILABLE' && value.cause === 'GENERATOR_PENDING' && value.generator === id && value.outcome === 'not-sent')
      && odcLines(A).length === odcSeen && o11Count() === seen,
    Object.fromEntries(Object.entries(generated).map(([key, { value }]) => [key, { code: value?.code ?? null, cause: value?.cause ?? null, generator: value?.generator ?? null }])));
  const windows = {};
  for (const action of ['prompt', 'focus']) windows[action] = sc(await call(clientA, 'odc_portal_login', { tenant: ODC_MODULE.host, action }));
  check('marco-a5: odc_portal_login prompt and focus answer HOSTED_PROMPT_UNAVAILABLE before the Studio is read; no credential window',
    Object.values(windows).every(value => value?.code === 'HOSTED_PROMPT_UNAVAILABLE') && odcLines(A).length === odcSeen,
    Object.fromEntries(Object.entries(windows).map(([action, value]) => [action, { ok: value?.ok ?? null, code: value?.code ?? null }])));

  // 9k. Deliveries without the 25 s deadline (servidor/fase4-26 a8, fix/delivery-no-deadline; C:\t\no-deadline\RESULTADO.md):
  //   - case f: ssam_code write {files} naming an agent: file, twice at once. ssam_code is served since a8 phase 6 and its
  //     write runs a delivery inside, so the deadline reads its files as the gate does (hosted/policy.mjs replayInputs: the
  //     sha256 the agent lists, never a transfer): ONE delivery, both answers "delivered", the second joined the first, never
  //     DELIVERY_STILL_RUNNING; the deadline only listed the file (file.list, one per call) and one gate reached the agent;
  //   - a delivery of E2E_LONG_DELIVERY_MS (3 min) through a proxy that cuts a response idle for 60 s: ONE call answers
  //     "delivered" at its end (never state "running" nor a continueTask), its SSE response carried a ": keepalive" about
  //     every 25 s, so the proxy cut nothing, and the fake thin bridge merged once (its answer held for the 3 min).
  {
    write(path.join(A.root, 'inbox', 'case-f.logic'), 'server action ThinCaseF\n  out Result: Integer\n  assign Result = 6\n  end\n');
    const callsBefore = agentCalls(A).length, studioBefore = o11Count();
    const codeArgs = { lane: 'o11', action: 'write', module: O11_MODULE.name, files: ['agent:inbox/case-f.logic'], authorize: 'pode entregar a ThinCaseF no Headless_CS' };
    const codeCalls = await Promise.all([0, 1].map(() => call(clientA, 'ssam_code', codeArgs, 900000).then(sc)));
    const fMerges = o11Since(studioBefore).filter(e => e.method === 'merge_from_oml');
    const fKinds = agentCalls(A).slice(callsBefore).map(e => e.kind);
    check('a8 (f): ssam_code write naming an agent: file, twice at once (served since a8 phase 6): ONE delivery, both "delivered", the second joined the first; the deadline only listed the file (one file.list per call, before any transfer) and only one gate reached the agent; never DELIVERY_STILL_RUNNING',
      codeCalls.every(value => value?.ok === true && value.result === 'delivered') && codeCalls.filter(value => value.joined === true).length === 1 && fMerges.length === 1
        && fKinds.filter(kind => kind === 'file.list').length === 2 && fKinds.indexOf('file.get') > fKinds.lastIndexOf('file.list') && fKinds.filter(kind => kind === 'o11.selected').length === 1
        && !codeCalls.some(value => value?.code === 'DELIVERY_STILL_RUNNING'),
      { replies: codeCalls.map(value => ({ ok: value?.ok ?? null, result: value?.result ?? null, joined: value?.joined ?? null, code: value?.code ?? null, error: value?.error ? String(value.error).slice(0, 200) : null })),
        merges: fMerges.length, kinds: fKinds });
    const LONG_MS = Number(process.env.E2E_LONG_DELIVERY_MS ?? 180000);
    const proxy = await idleCutProxy(port, 60000);
    const longClient = new Client({ name: 'e2e-long-delivery', version: '1' });
    await longClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${proxy.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + issued.a.token } } }));
    const delayFile = A.studiosFile + '.merge-delay-ms';
    fs.writeFileSync(delayFile, String(LONG_MS));
    const before9k = o11Count();
    const started = Date.now();
    const longJob = { expectValid: true, ops: [{ op: 'logic', data: { actions: [{ name: 'ThinLongDelivery', public: true,
      outputs: [{ name: 'Result', type: 'Integer' }], steps: [{ assign: { Result: '3' } }] }] } }] };
    let long;
    try { long = await call(longClient, 'o11_deliver', { module: O11_MODULE.name, job: longJob, checks: ['ThinLongDelivery'], authorize: 'deliver ThinLongDelivery to Headless_CS' }, LONG_MS + 600000); }
    finally { fs.rmSync(delayFile, { force: true }); }
    const elapsedMs = Date.now() - started;
    const longSeen = studioLog(A).filter(e => e.studio === 'o11').slice(before9k);
    const longMerges = longSeen.filter(e => e.method === 'merge_from_oml');
    const value = sc(long);
    check('a8: a delivery of 3 min through a proxy that cuts idle responses at 60 s: ONE call answers "delivered" at its end, never state "running" nor continueTask; one merge',
      value?.ok === true && value.result === 'delivered' && value.state !== 'running' && !JSON.stringify(value).includes('continueTask') && elapsedMs >= LONG_MS
        && longMerges.length === 1 && longMerges[0].merged === true && longMerges[0].heldMs === LONG_MS,
      { elapsedMs, reply: value ? { ok: value.ok, result: value.result, state: value.state ?? null, code: value.code ?? null, error: value.error ?? null } : long, merges: longMerges.map(e => ({ merged: e.merged, heldMs: e.heldMs })) });
    check('a8: the SSE answer of that call carried a ": keepalive" about every 25 s and the proxy cut nothing (longest silence under 60 s)',
      proxy.stats.streams.some(s => s.sse && s.ms >= LONG_MS && s.keepalives >= Math.floor(LONG_MS / 25000) - 1) && proxy.stats.idleCuts === 0 && proxy.stats.longestGapMs < 60000,
      { ...proxy.stats, streams: proxy.stats.streams.map(({ sse, keepalives, ms }) => ({ sse, keepalives, ms })) });
    await longClient.close().catch(() => {});
    await proxy.close();
  }

  // 9l. servidor/fase4-26 a8 (owner request 18/10): ssam_code over the hosted path, both lanes, every file of it A's own.
  //   - read: O11 by the open module's name (captured through the relay and the thin bridge), ODC over its ws: capture; the
  //     action read is kept as a read of A (an edit of it expands only for A);
  //   - check: over the newest capture of A's workspace, its job in A's workspace, the kernel on the server, no Studio call;
  //   - plan: the plan folder in A's workspace, its prompts and plan.json brought to A's machine by the agent, every batch
  //     file named in A's agent inbox; a subagent's batch check (the call of its prompt) brings its file through the agent;
  //   - write: O11 delivered through o11_deliver's gate, the relay and the thin bridge (a text, then an edit of the read
  //     action); ODC through studio_deliver's gate until the build (the fake ODC bridge has no merge).
  // The paths of A's own machine (its agent folder) are the user's, taken out before looking for server paths.
  const userForms = machine => { const once = JSON.stringify(machine.root).slice(1, -1); return [JSON.stringify(once).slice(1, -1), once]; };
  const onMachineOf = (value, machine) => { let text = textOf(value); for (const form of userForms(machine)) text = text.split(form).join('<user folder>'); return text; };
  const serverPathInA = value => { const text = onMachineOf(value, A).toLowerCase(); return [repo, T, serverDir].some(p => text.includes(JSON.stringify(p).slice(1, -1).toLowerCase())); };
  const CODE_DDL = 'create entity HostedCodeE2E (\n  Id Long Integer identifier auto required,\n  Name Text(50)\n);\n';
  seen = o11Count();
  const o11Ddl = sc(await call(clientA, 'ssam_code', { lane: 'o11', action: 'read', part: 'ddl', target: O11_MODULE.name }, 600000));
  const o11ReadSeen = o11Since(seen);
  check('a8: hosted ssam_code read {lane:"o11", part:"ddl", target: the open module}: captured through the relay and the thin bridge (read-only, the agent\'s key) into ws:o11/, read on the server, no server path',
    o11Ddl?.ok === true && inWs(o11Ddl.file, 'ws:o11/') && o11ReadSeen.some(e => ['snapshot_module', 'environment_session'].includes(e.method) && e.authOk)
      && o11ReadSeen.every(e => probe(e) || e.authOk) && !o11ReadSeen.some(e => ['merge_from_oml', 'publish', 'refresh_references', 'open_module'].includes(e.method)) && !serverPathInA(o11Ddl),
    o11Ddl ? { ok: o11Ddl.ok, file: o11Ddl.file ?? null, code: o11Ddl.code ?? null, error: o11Ddl.error ?? null, seen: o11ReadSeen.map(e => e.method) } : o11Ddl);
  const flowRead = sc(await call(clientA, 'ssam_code', { lane: 'o11', action: 'read', part: 'logic', target: o11Ddl?.file, element: 'ThinE2EPing' }, 600000));
  const flowText = String(flowRead?.text ?? flowRead?.action?.text ?? '');
  const assignId = flowText.split('\n').find(l => /\bassign\b/.test(l))?.trim().split(/\s+/).at(-1) ?? null;
  const readSha = flowRead?.action?.textSha ?? null;
  check('a8: hosted ssam_code read {part:"logic", element}: the action as text with its textSha, kept as a read of this customer (ws:state, never served back)',
    flowRead?.ok === true && /^[0-9a-f]{16}$/.test(readSha ?? '') && /^@n\d+$/.test(assignId ?? '') && fs.existsSync(path.join(issued.a.workspace, 'state', 'code-readings', 'o11', readSha ?? 'none'))
      && !serverPathInA(flowRead), flowRead ? { ok: flowRead.ok, textSha: readSha, assignId, code: flowRead.code ?? null, error: flowRead.error ?? null } : flowRead);
  const odcRead = sc(await call(clientA, 'ssam_code', { lane: 'odc', action: 'read', part: 'ddl', target: odcCapture?.path }, 600000));
  check('a8: hosted ssam_code read {lane:"odc", part:"ddl"} over the ws: capture: answered by A\'s own capture, no server path',
    odcRead?.ok === true && odcRead.file === odcCapture?.path && !serverPathInA(odcRead), odcRead ? { ok: odcRead.ok, file: odcRead.file ?? null, code: odcRead.code ?? null, error: odcRead.error ?? null } : odcRead);
  const codeChecks = {};
  // a8 review (M2): a check leaves its job (the base of a correction) and never its candidate or work folder
  const checkFolderOf = job => (typeof job === 'string' && job.startsWith('ws:') ? path.dirname(path.join(issued.a.workspace, ...job.slice(3).split('/'))) : null);
  const leftOf = job => { const dir = checkFolderOf(job); return dir ? { job: fs.existsSync(path.join(dir, 'job.json')), candidate: fs.existsSync(path.join(dir, 'candidate.oml')), result: fs.existsSync(path.join(dir, 'candidate.oml.result.json')), work: fs.existsSync(path.join(dir, 'work')) } : null; };
  for (const [lane, module] of [['o11', O11_MODULE.name], ['odc', ODC_MODULE.name]]) {
    seen = o11Count(); odcSeen = odcLines(A).length;
    codeChecks[lane] = sc(await call(clientA, 'ssam_code', { lane, action: 'check', module, part: 'ddl', text: CODE_DDL }, 600000));
    const value = codeChecks[lane];
    const left = leftOf(value?.job);
    check(`a8: hosted ssam_code check {lane:"${lane}"}: over the newest capture of A's workspace (ws:${lane}/snapshots), its job in A's workspace, the kernel on the server, no Studio call, no server path; its candidate and work folder removed when it ended`,
      value?.ok === true && new RegExp('^ws:' + lane + '/snapshots/').test(value.capture?.path ?? '') && new RegExp(lane === 'o11' ? '^ws:o11/jobs/check/' : '^ws:odc/lab/jobs/check/').test(value.job ?? '')
        && o11Count() === seen && odcLines(A).length === odcSeen && !serverPathInA(value) && left?.job === true && left.candidate === false && left.result === false && left.work === false,
      value ? { ok: value.ok, code: value.code ?? null, capture: value.capture?.path ?? null, job: value.job ?? null, left, problems: (value.problems ?? []).slice(0, 3), error: value.error ?? null } : value);
  }
  const PLAN_ITEMS = [{ kind: 'data', name: 'HostedShape', intent: 'type HostedShape = { Name: Text; }' },
    ...Array.from({ length: 6 }, (_, i) => ({ kind: 'action', name: `HostedPlan${i}`, intent: `returns ${i}`, signature: `server action HostedPlan${i}\n  out Result: Integer`, calls: i < 5 ? [`HostedPlan${i + 1}`] : [] }))];
  for (const [lane, module] of [['o11', O11_MODULE.name], ['odc', ODC_MODULE.name]]) {
    const plan = sc(await call(clientA, 'ssam_code', { lane, action: 'plan', module, items: PLAN_ITEMS, workers: 2 }, 600000));
    const folder = typeof plan?.dir === 'string' && plan.dir.startsWith('ws:') ? plan.dir.slice(3) : null;
    const onMachine = folder ? path.join(A.root, ...folder.split('/'), 'plan.json') : null;
    const full = onMachine && fs.existsSync(onMachine) ? JSON.parse(fs.readFileSync(onMachine, 'utf8')) : null;
    const all = full ? [full.data, ...full.batches].filter(Boolean) : [];
    const promptsHere = all.length > 0 && all.every(b => typeof b.promptFile === 'string' && b.promptFile.toLowerCase().startsWith(A.root.toLowerCase() + '\\') && fs.existsSync(b.promptFile));
    const filesInInbox = all.length > 0 && all.every(b => b.files.every(f => f.toLowerCase().startsWith(path.join(A.root, 'inbox').toLowerCase() + '\\')));
    const prompts = promptsHere ? all.map(b => fs.readFileSync(b.promptFile, 'utf8')) : [];
    check(`a8: hosted ssam_code plan {lane:"${lane}"}: the plan folder in A's workspace, its prompts and plan.json brought to A's machine by the agent, every batch file named in A's agent inbox, no server path, no client text`,
      plan?.ok === true && new RegExp(lane === 'o11' ? '^ws:o11/plans/[0-9a-f]{16}$' : '^ws:odc/lab/plans/[0-9a-f]{16}$').test(plan.dir) && promptsHere && filesInInbox
        && plan.batches.every(b => b.launchPrompt.toLowerCase().includes(A.root.toLowerCase() + '\\')) && !serverPathInA(plan) && !serverPathInA(full) && prompts.every(p => !serverPathInA(p)) && clientHits(prompts).length === 0,
      plan ? { ok: plan.ok, code: plan.code ?? null, dir: plan.dir ?? null, error: plan.error ?? null, batches: plan.batches?.length ?? null, onMachine: Boolean(full), promptsHere, filesInInbox } : plan);
    if (full) {
      const batch = full.batches[0];
      for (const file of batch.files) write(file, batch.items.map(name => `server action ${name}\n  out Result: Integer\n  assign Result = 1\n  end\n`).join('\n'));
      write(full.data.files[0], 'type HostedShape = {\n  Name: Text;\n}\n');
      const batchCheck = sc(await call(clientA, batch.check.tool, batch.check.arguments, 600000));
      const brought = batch.files.map(f => path.join(issued.a.workspace, 'inbox', ...path.relative(path.join(A.root, 'inbox'), f).split(path.sep)));
      check(`a8: hosted ssam_code plan {lane:"${lane}"}: a subagent's batch check (the call of its prompt) brings its file from A's agent inbox and checks it over A's capture`,
        (batchCheck?.ok === true || batchCheck?.code === 'CHECK_REFUSED') && brought.every(f => fs.existsSync(f)) && !serverPathInA(batchCheck),
        batchCheck ? { ok: batchCheck.ok, code: batchCheck.code ?? null, problems: (batchCheck.problems ?? []).slice(0, 3), error: batchCheck.error ?? null } : batchCheck);
      // Every subagent wrote its batch: the session sends the plan's final write, ONE ssam_code write with every file (O11
      // delivered through the thin bridge; ODC until the build, the fake ODC bridge has no merge).
      for (const other of full.batches.slice(1)) for (const file of other.files) write(file, other.items.map(name => `server action ${name}\n  out Result: Integer\n  assign Result = 1\n  end\n`).join('\n'));
      seen = o11Count(); odcSeen = odcLines(A).length;
      const finalArgs = { ...full.final.arguments, ...(lane === 'o11' ? { authorize: 'pode entregar o plano HostedPlan no Headless_CS' } : { until: 'build' }) };
      const delivered = sc(await call(clientA, full.final.tool, finalArgs, 900000));
      const finalSeen = lane === 'o11' ? o11Since(seen).map(e => e.method) : odcLines(A).slice(odcSeen).map(e => e.line.split(' ')[0]);
      check(`a8: hosted ssam_code plan {lane:"${lane}"}: the plan's final write (every file from A's agent inbox) ${lane === 'o11' ? 'is delivered through the thin bridge' : 'is built on the server, the Studio saw the capture only'}, no server path`,
        delivered?.ok === true && (lane === 'o11' ? delivered.result === 'delivered' && finalSeen.includes('merge_from_oml') : finalSeen.every(c => c === 'snapshot' || c === 'status'))
          && full.final.tool === 'ssam_code' && full.final.arguments.files.length === 1 + full.batches.reduce((n, b) => n + b.files.length, 0) && !serverPathInA(delivered),
        delivered ? { ok: delivered.ok, result: delivered.result ?? null, code: delivered.code ?? null, error: delivered.error ?? null, problems: (delivered.problems ?? []).slice(0, 3), seen: finalSeen } : delivered);
    }
  }
  seen = o11Count();
  const o11Write = sc(await call(clientA, 'ssam_code', { lane: 'o11', action: 'write', module: O11_MODULE.name, part: 'ddl', text: CODE_DDL, authorize: 'pode entregar a HostedCodeE2E no Headless_CS' }, 900000));
  const o11WriteSeen = o11Since(seen);
  check('a8: hosted ssam_code write {lane:"o11"}: delivered ("delivered") through o11_deliver\'s gate, the relay and the thin bridge (one merge_from_oml, the agent\'s key), no server path',
    o11Write?.ok === true && o11Write.result === 'delivered' && o11WriteSeen.filter(e => e.method === 'merge_from_oml').length === 1 && o11WriteSeen.every(e => probe(e) || e.authOk) && !serverPathInA(o11Write),
    o11Write ? { ok: o11Write.ok, result: o11Write.result ?? null, code: o11Write.code ?? null, error: o11Write.error ?? null, seen: o11WriteSeen.map(e => e.method) } : o11Write);
  if (readSha && assignId) {
    seen = o11Count();
    const edited = sc(await call(clientA, 'ssam_code', { lane: 'o11', action: 'write', module: O11_MODULE.name, part: 'logic', element: 'ThinE2EPing', basedOn: readSha,
      edits: [{ replace: assignId, with: 'assign Result = 2' }], authorize: 'pode entregar a mudança do ThinE2EPing no Headless_CS' }, 900000));
    const editSeen = o11Since(seen);
    check('a8: hosted ssam_code write {edits} over the read A was served: expanded on the server and delivered through the thin bridge',
      edited?.ok === true && edited.result === 'delivered' && editSeen.some(e => e.method === 'merge_from_oml') && !serverPathInA(edited),
      edited ? { ok: edited.ok, result: edited.result ?? null, code: edited.code ?? null, error: edited.error ?? null, seen: editSeen.map(e => e.method) } : edited);
  } else check('a8: hosted ssam_code write {edits} over the read A was served (no read to edit)', false, { readSha, assignId });
  odcSeen = odcLines(A).length;
  const odcWrite = sc(await call(clientA, 'ssam_code', { lane: 'odc', action: 'write', module: ODC_MODULE.name, part: 'ddl', text: CODE_DDL, until: 'build' }, 900000));
  const odcWriteLines = odcLines(A).slice(odcSeen).map(e => e.line.split(' ')[0]);
  check('a8: hosted ssam_code write {lane:"odc", until:"build"}: through studio_deliver\'s gate, the capture from A\'s ODC Studio through the agent, built on the server; the Studio saw the capture only, no server path',
    odcWrite?.ok === true && odcWriteLines.includes('snapshot') && odcWriteLines.every(c => c === 'snapshot' || c === 'status') && !serverPathInA(odcWrite),
    odcWrite ? { ok: odcWrite.ok, result: odcWrite.result ?? null, code: odcWrite.code ?? null, error: odcWrite.error ?? null, lines: odcWriteLines, keys: Object.keys(odcWrite) } : odcWrite);

  // Customer C: the same pack, turned into the v48 pack of the 23rd. pack.json and the ODC bridge files name v48, and the
  // agent carries the lists of the 23rd (no sc_http, no reference-producers; AGENT_VERSION 0.2.0). Each edit is checked,
  // so a change of the agent code fails here instead of testing a pack that no longer looks like v48.
  const expandedC = await powershell(['-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${C.root}'`], C.env);
  must(C.name + ': pack extracted', expandedC.code === 0 && fs.existsSync(path.join(C.root, 'pack.json')), expandedC.out);
  const edits = [];
  const downgrade = (rel, from, to) => { const file = path.join(C.root, ...rel.split('/')); const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(from)) return edits.push(rel + ': no ' + from); fs.writeFileSync(file, text.replace(from, to)); };
  downgrade('agent/lib/kinds.mjs', "'reference-snapshot', 'reference-producers', 'data',", "'reference-snapshot', 'data',");
  downgrade('agent/lib/kinds.mjs', "'sc_web', 'sc_http', 'studio_login',", "'sc_web', 'studio_login',");
  downgrade('agent/lib/agent.mjs', "export const AGENT_VERSION = '0.3.3';", "export const AGENT_VERSION = '0.2.0';");
  const packC = JSON.parse(fs.readFileSync(path.join(C.root, 'pack.json'), 'utf8').replace(/^﻿/, ''));
  const bridgeDir = path.join(C.root, 'odc', 'studio', 'bridge', 'bin', 'Release', 'net8.0');
  for (const suffix of ['.dll', '.deps.json']) {
    const from = path.join(bridgeDir, `ODC3.Bridge.${ODC_BRIDGE}${suffix}`);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(bridgeDir, 'ODC3.Bridge.v48' + suffix)); else edits.push('no ' + path.basename(from));
  }
  packC.odcBridge = 'v48'; packC.id = 'e2e-pack-v48';
  if (Array.isArray(packC.files)) packC.files = packC.files.map(f => ({ ...f, path: String(f.path).replace(`ODC3.Bridge.${ODC_BRIDGE}.`, 'ODC3.Bridge.v48.') }));
  fs.writeFileSync(path.join(C.root, 'pack.json'), JSON.stringify(packC, null, 2));
  must(C.name + ': the pack turned into the v48 pack (pack.json, bridge files, the 23rd agent lists)', edits.length === 0, edits);
  const setupC = spawnSync(process.execPath, [path.join(C.root, 'agent', 'ssam-agent.mjs'), 'setup', '--server', `http://127.0.0.1:${port}`, '--root', C.root,
    '--credential-file', path.join(secrets, 'c.agent')], { cwd: C.root, env: C.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  must(C.name + ': ssam-agent.mjs setup of the v48 pack', setupC.status === 0 && !((setupC.stdout ?? '') + (setupC.stderr ?? '')).includes(issued.c.credential),
    ((setupC.stdout ?? '') + (setupC.stderr ?? '')).replace(issued.c.credential, '<credential>'));
  await startStudios(C, 'pack-v48');
  const configC = path.join(C.root, 'private', 'config.json');
  fs.writeFileSync(configC, JSON.stringify({ ...JSON.parse(fs.readFileSync(configC, 'utf8')), o11Port: C.fakes.o11Port }, null, 2));
  startAgent(C);
  const clientC = await connect(issued.c.token);
  must('v48 pack: customer C agent connected', await waitFor(() => agentConnected(clientC), 20000, 250), C.agent.out);
  const doctorC = sc(await call(clientC, 'ssam_doctor'));
  check('v48 pack: the hub accepts customer C\'s pack (odcBridge v48, agent 0.2.0) through kernel.json odcBridgeAccepted: the ODC lane is compatible',
    doctorC?.agent?.connected === true && doctorC.agent.pack?.odcBridge === 'v48' && doctorC.agent.agentVersion === '0.2.0' && doctorC.lanes?.odc?.compatible?.ok === true,
    { agent: doctorC?.agent ? { version: doctorC.agent.agentVersion, pack: doctorC.agent.pack, compatible: doctorC.agent.compatible } : null, odc: doctorC?.lanes?.odc?.compatible ?? null });
  const linesC = () => studioLog(C).filter(e => e.studio === 'odc').map(e => e.line);
  let seenC = linesC().length;
  const statusC = await call(clientC, 'studio_status');
  check('v48 pack: the server asks customer C\'s pipe for the bridge the pack carries (ODC3-Bridge-v48) and the call goes through',
    statusC.isError !== true && C.fakes.odcBridge === 'v48' && linesC().slice(seenC).some(line => line.startsWith('status')), sc(statusC) ?? statusC);
  seenC = linesC().length;
  const producersC = await call(clientC, 'studio_reference_producers', { module: ODC_MODULE.name });
  check('v48 pack: reference-producers is not in the 23rd agent lists: COMMAND_NOT_ALLOWED from the agent, the command never reached C\'s Studio',
    producersC.isError === true && /COMMAND_NOT_ALLOWED/.test(textOf(sc(producersC) ?? producersC)) && !linesC().slice(seenC).some(line => line.startsWith('reference-producers')),
    sc(producersC) ?? producersC);
  const connectedC = await call(clientC, 'ssam_connect', { lane: 'o11' });
  const o11C = () => studioLog(C).filter(e => e.studio === 'o11');
  const seenO11C = o11C().length;
  const scC = sc(await call(clientC, 'o11_service_center_read', { action: 'db-connections', host: O11_MODULE.environment }, 120000));
  const scSeenC = o11C().slice(seenO11C);
  check('v48 pack: o11_service_center_read answers STUDIO_BRIDGE_OUTDATED (the thin bridge of the 23rd has no sc_http:studioSession) with the reconnect continuation; no page was asked',
    connectedC.isError !== true && scC?.code === 'STUDIO_BRIDGE_OUTDATED' && scC.continuation?.tool === 'ssam_connect'
      && !scSeenC.some(e => ['sc_http', 'sc_web', 'studio_login'].includes(e.method)),
    { connect: sc(connectedC)?.ok ?? connectedC, reply: scC, seen: scSeenC.map(e => e.method) });
  // a8: customer C's pack is older than the next agent pack: its thin bridge has no refresh_references:add, so the Studio's
  // Manage Dependencies by code is refused typed (nothing sent to C's bridge), with the exact step for the user.
  const seenManageC = o11C().length;
  const manageC = sc(await call(clientC, 'o11_studio', { command: 'refresh-references', args: { add: [{ producer: 'ThinProducer', elements: ['IServerActionSignature:ThinAction'] }], published: true } }));
  const manageSeenC = o11C().slice(seenManageC);
  check('a8 (a): an older pack (customer C) answers MANAGE_DEPENDENCIES_HOSTED_PENDING with the exact step; nothing refreshed or added on C\'s Studio',
    manageC?.code === 'HOSTED_UNAVAILABLE' && manageC.cause === 'MANAGE_DEPENDENCIES_HOSTED_PENDING' && manageC.outcome === 'not-sent'
      && /install the current agent package/.test(manageC.error ?? '') && manageSeenC.some(e => e.method === 'bridge_manifest') && !manageSeenC.some(e => e.method === 'refresh_references'),
    { reply: manageC, seen: manageSeenC.map(e => e.method) });
  fs.writeFileSync(path.join(C.root, 'private', 'agent.stop'), '');
  check('v48 pack: customer C agent stops cleanly (exit 0)', (await Promise.race([C.agent.exit, delay(10000).then(() => 'timeout')])) === 0);

  // 10. Customer B never reaches customer A's agent or workspace.
  const clientB = await connect(issued.b.token);
  const aLines = odcLines(A).length;
  const bStatus = sc(await call(clientB, 'studio_status'));
  check('customer B (no agent yet) gets AGENT_NOT_CONNECTED although A\'s agent is connected; A\'s Studio saw nothing',
    bStatus?.code === 'AGENT_NOT_CONNECTED' && odcLines(A).length === aLines, bStatus);
  check('an MCP token never opens the agent channel (401)', (await rawHello(issued.b.token)) === 401);
  check('an agent credential never opens /mcp (401)', (await rawMcp(issued.a.credential)) === 401);
  await startStudios(B);
  const configB = path.join(B.root, 'private', 'config.json');
  fs.writeFileSync(configB, JSON.stringify({ ...JSON.parse(fs.readFileSync(configB, 'utf8')), o11Port: B.fakes.o11Port }, null, 2));
  startAgent(B);
  must('customer B agent connected', await waitFor(() => agentConnected(clientB), 20000, 250), B.agent.out);
  const aLines2 = odcLines(A).length, bLines = odcLines(B).length;
  const bStatus2 = await call(clientB, 'studio_status');
  check('customer B\'s studio_status reaches B\'s Studio only', bStatus2.isError !== true && odcLines(B).length > bLines && odcLines(A).length === aLines2, sc(bStatus2) ?? bStatus2);
  if (A.relayPort) {
    const relayKeyB = fs.readFileSync(path.join(issued.b.workspace, 'state', 'relay-authority', 'bridge.key'), 'ascii').trim();
    const seen2 = studioLog(A).filter(e => e.studio === 'o11').length;
    const crossRelay = await relayLine(A.relayPort, { method: 'list_open_modules', params: {}, authorization: relayKeyB });
    check('customer B\'s relay key is refused by customer A\'s relay; nothing reaches A\'s agent',
      crossRelay.reply?.success === false && crossRelay.reply?.executed === false && studioLog(A).filter(e => e.studio === 'o11').length === seen2, crossRelay);
  }
  // a8: B never reaches anything of A's ssam_code: A's capture as base, a check of a module B never captured, and B's
  // workspace holds no plan or check job.
  const aCapture = serverFile(codeChecks.o11?.capture?.path);
  const bBase = sc(await call(clientB, 'ssam_code', { lane: 'o11', action: 'check', module: O11_MODULE.name, part: 'ddl', text: CODE_DDL, base: aCapture }));
  const bNone = sc(await call(clientB, 'ssam_code', { lane: 'odc', action: 'check', module: ODC_MODULE.name, part: 'ddl', text: CODE_DDL }));
  const bFolders = ['o11/plans', 'odc/lab/plans', 'o11/jobs/check', 'odc/lab/jobs/check', 'state/code-readings'].map(rel => path.join(issued.b.workspace, ...rel.split('/')))
    .filter(dir => fs.existsSync(dir) && fs.readdirSync(dir).length);
  check('a8: customer B never reaches A\'s ssam_code files: A\'s capture as base is PATH_OUTSIDE_WORKSPACE, a check of a module B never captured is CAPTURE_MISSING, B\'s workspace holds no plan, check job or read of A',
    typeof aCapture === 'string' && bBase?.code === 'PATH_OUTSIDE_WORKSPACE' && bNone?.code === 'CAPTURE_MISSING' && bFolders.length === 0,
    { base: bBase?.code ?? bBase, none: bNone?.code ?? bNone, folders: bFolders.map(f => path.relative(issued.b.workspace, f)) });
  // With its agent connected (the gate checks the agent first), B still cannot name a file of A's workspace.
  const crossPath = sc(await call(clientB, 'studio_open', { module: 'Orders', localOml: candidate }));
  check('customer B cannot name a file of customer A\'s workspace (PATH_OUTSIDE_WORKSPACE), nothing reached either Studio',
    crossPath?.code === 'PATH_OUTSIDE_WORKSPACE' && odcLines(A).length === aLines2 && !odcLines(B).some(e => e.line.startsWith('open ')), crossPath);

  // 11. No agent: a clean stop of A's agent; the next call is refused before anything runs.
  fs.writeFileSync(path.join(A.root, 'private', 'agent.stop'), '');
  const stoppedCode = await Promise.race([A.agent.exit, delay(10000).then(() => 'timeout')]);
  check('customer A agent stops cleanly (exit 0)', stoppedCode === 0, stoppedCode);
  const aLines3 = odcLines(A).length;
  const noAgent = sc(await call(clientA, 'studio_status'));
  check('without the agent: AGENT_NOT_CONNECTED with the ssam_doctor continuation, nothing reached the Studio',
    noAgent?.code === 'AGENT_NOT_CONNECTED' && noAgent?.continuation?.tool === 'ssam_doctor' && odcLines(A).length === aLines3, noAgent);
  const doctorOff = sc(await call(clientA, 'ssam_doctor'));
  check('ssam_doctor still answers and shows agent.connected:false', doctorOff?.agent?.connected === false, doctorOff?.agent);

  // 12. Revocation: A's agent back, then `ssam server-token revoke`: MCP 403 and the agent channel closes in seconds.
  startAgent(A);
  must('customer A agent reconnected (new instance)', await waitFor(() => agentConnected(clientA), 20000, 250), A.agent.out);
  const revoke = ssam(['server-token', 'revoke', '--id', issued.a.id]);
  const revokedAt = Date.now();
  check('ssam server-token revoke', revoke.status === 0 && revoke.value?.ok === true, { status: revoke.status });
  const agentCode = await Promise.race([A.agent.exit, delay(10000).then(() => 'timeout')]);
  const agentMs = A.agent.exited ? A.agent.exited - revokedAt : null;
  check('the agent channel closes and the agent exits with code 2 within 2 s of the revoke', agentCode === 2 && agentMs !== null && agentMs <= 2000, { exitCode: agentCode, ms: agentMs });
  const sessionGone = await waitFor(async () => { try { await clientA.listTools(); return false; } catch { return true; } }, 2000);
  check('the open MCP session of the revoked token is closed', sessionGone);
  check('a new MCP request with the revoked token gets 403', (await rawMcp(issued.a.token)) === 403);
  check('the revoked agent credential gets 403 on /agent/v1/hello', (await rawHello(issued.a.credential)) === 403);
  const bAfter = await call(clientB, 'studio_status');
  check('customer B keeps working after A is revoked', bAfter.isError !== true, sc(bAfter) ?? bAfter);

  // 13. Nothing outside customers/<tokenId> (and the server's own files); no secret in the logs.
  await delay(300);
  fs.rmSync(secrets,{recursive:true,force:true});
  for (const [key, take] of Object.entries(guarded)) {
    const now = take();
    const changed = [...new Set([...Object.keys(before[key] ?? {}), ...Object.keys(now ?? {})])]
      .filter(k => JSON.stringify(before[key]?.[k]) !== JSON.stringify(now?.[k]));
    check(`no write outside the workspaces: ${key} unchanged`, JSON.stringify(now) === JSON.stringify(before[key]),
      JSON.stringify(now) === JSON.stringify(before[key]) ? '' : { changed: changed.slice(0, 12), count: changed.length });
  }
  // machine-pins.json and access-alerts.jsonl: the access trail of each token (agent-hub.mjs), as hosted-e2e.test.mjs allows.
  // The quality record (docs/QUALIDADE.md) lives beside the audit.
  // a7 (no-internals list item 7): exposure/ holds the bytes each token is served per day (served-<day>.json, sizes only).
  const top = fs.readdirSync(serverDir).filter(name => !['customers', 'tokens.json', 'kernel.json', 'server.log', 'server.pid', 'server.json', 'machine-pins.json', 'access-alerts.jsonl', 'exposure', 'state'].includes(name) && !/^(audit|quality)-\d{8}\.jsonl$/.test(name));
  check('the server folder holds only tokens, kernel.json, servidor.ps1 files, audit, quality, the access trail, the served bytes and customers', top.length === 0, top);
  const served = (() => { try { return fs.readdirSync(path.join(serverDir, 'exposure')); } catch { return []; } })();
  const servedText = served.map(n => fs.readFileSync(path.join(serverDir, 'exposure', n), 'utf8')).join('\n');
  check('the served bytes are one file per day, by token id and tool, with no token, credential or argument', served.length > 0 && served.every(n => /^served-\d{4}-\d{2}-\d{2}\.json$/.test(n))
    && ![issued.a, issued.b, issued.c].some(x => servedText.includes(x.token) || servedText.includes(x.credential)) && !/ws:|"file"|"query"|"intent"/.test(servedText), { files: served, sample: servedText.slice(0, 300) });
  const logs = fs.readdirSync(serverDir).filter(n => n.endsWith('.log') || n.endsWith('.jsonl')).map(n => fs.readFileSync(path.join(serverDir, n), 'utf8')).join('\n');
  check('server.log and audit carry no token or agent credential', ![issued.a, issued.b, issued.c].some(x => logs.includes(x.token) || logs.includes(x.credential)));
  check('the customer workspaces are separate folders', fs.existsSync(issued.a.workspace) && fs.existsSync(issued.b.workspace) && !fs.existsSync(path.join(issued.b.workspace, 'odc', 'lab', 'Candidate.oml')));
} catch (error) {
  if (!(error instanceof Stop)) { failure = error; check('unexpected error', false, error.stack ?? error.message); }
} finally {
  for (const client of clients) await client.close().catch(() => {});
  await router?.close();await routerStore?.close?.();
  for (const machine of [A, B, C]) if (machine.agent && machine.agent.code === null) {
    try { fs.writeFileSync(path.join(machine.root, 'private', 'agent.stop'), ''); } catch { /* folder gone */ }
    await Promise.race([machine.agent.exit, delay(5000)]);
  }
  if (port) await powershell(['-File', path.join(repo, 'scripts', 'servidor.ps1'), 'stop'], ownerEnv, 60000).catch(() => {});
  for (const run of [...children]) { try { run.child.stdin.end(); } catch { /* closed */ } await Promise.race([run.exit, delay(3000)]); }
  for (const run of [...children]) { try { run.child.kill(); } catch { /* gone */ } }
  // The server's resident readers (ssam_map, step 9g) live under T and exit only after 15 idle minutes: stopped here by
  // the pid of their own state file (reader-client.mjs worker.json).
  const states = [];
  const findStates = dir => { let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) { const full = path.join(dir, entry.name); if (entry.isDirectory()) { if (entry.name !== 'bin') findStates(full); } else if (entry.name === 'worker.json') states.push(full); } };
  for (const folder of ['readers', 'readers-prefetch']) findStates(path.join(T, folder));
  for (const file of states) { try { const pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid; if (Number.isInteger(pid)) process.kill(pid); } catch { /* already gone */ } }
  await delay(300);
  try { fs.rmSync(runRoot, { recursive: true, force: true }); fs.rmSync(privateTemp, { recursive: true, force: true }); } catch { /* best effort */ }
}
const report = { ok: checks.length > 0 && checks.every(c => c.ok) && !failure, checks };
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exit(report.ok ? 0 : 1);
