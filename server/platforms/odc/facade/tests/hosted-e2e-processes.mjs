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
// Tokens and agent credentials only ever go to files under the temporary folder; nothing here prints them.
// Ports: the server and the fake O11 bridges take free ports in 7400-7499. Never a real Studio: the fake ODC pipes use
// unlikely pids, and the agents list only the fake Studio processes.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-f2e2e-'));
const serverDir = path.join(T, 'server');
const secrets = path.join(T, 'secrets');
const ownerHome = path.join(T, 'owner-home');
for (const dir of [serverDir, secrets, path.join(ownerHome, 'AppData', 'Local'), path.join(ownerHome, 'AppData', 'Roaming'), path.join(T, 'owner-authority'), path.join(T, 'owner-tmp')])
  fs.mkdirSync(dir, { recursive: true });
const clean = env => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(ANVIL_|SSAM_)/i.test(k)));
// The Service Studio the server's O11 kernel loads headless (apply, the reference plan, find, refresh): compile-time and
// model runtime only, never a Studio process.
const serverStudio = process.env.ANVIL_STUDIO_DIR || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OutSystems', 'Service Studio 11', 'Service Studio');
const ownerEnv = { ...clean(process.env), SSAM_SERVER_DIR: serverDir, SSAM_NODE: process.execPath, ANVIL_STUDIO_DIR: serverStudio,
  SSAM_MODULE_INDEX_ROOT: path.join(T, 'module-index'), SSAM_READER_CACHE_ROOT: path.join(T, 'readers'),
  ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1', ANVIL_AUTHORITY_DIR: path.join(T, 'owner-authority'),
  USERPROFILE: ownerHome, HOME: ownerHome, APPDATA: path.join(ownerHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(ownerHome, 'AppData', 'Local'),
  TEMP: path.join(T, 'owner-tmp'), TMP: path.join(T, 'owner-tmp'),
  ...(process.env.ANVIL_ODC_FEATURES_DIR ? { ANVIL_ODC_FEATURES_DIR: process.env.ANVIL_ODC_FEATURES_DIR } : {}) };
// The server's kernel is pinned (the fake Studios report these versions); detection would read the installed Studios.
write(path.join(serverDir, 'kernel.json'), JSON.stringify({ o11: '11.55.91', odc: '1.7.27', odcBridge: ODC_BRIDGE }));

function customerMachine(name) {
  const base = path.join(T, name);
  const home = path.join(base, 'home');
  for (const dir of [path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'), path.join(base, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  return { name, base, root: path.join(base, 'SSAM-Agent'), studiosFile: path.join(base, 'studios.json'),
    env: { ...clean(process.env), USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: path.join(base, 'tmp'), TMP: path.join(base, 'tmp') } };
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
let port, url;
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
async function startStudios(machine) {
  const o11Port = await freePort();
  machine.studios = start([path.join(fixtures, 'fake-studios-process.mjs'), machine.root, machine.studiosFile, String(o11Port), '0', moduleFile], { env: machine.env, name: machine.name + '-studios' });
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

// ---------------------------------------------------------------- the run
let failure = null;
const A = customerMachine('cliente-a'), B = customerMachine('cliente-b');
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
  write(path.join(prebuilt, 'o11', 'built-for.txt'), '11.55.91\r\n');
  const zip = path.join(T, 'ssam-agent.zip');
  const pack = await powershell(['-File', path.join(repo, 'scripts', 'agent-pack.ps1'), '-Out', zip, '-Lanes', 'odc,o11', '-NoNode', '-NoBuild', '-Prebuilt', prebuilt], ownerEnv);
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
  port = await freePort();
  url = `http://127.0.0.1:${port}/mcp`;
  const started = await powershell(['-File', path.join(repo, 'scripts', 'servidor.ps1'), 'start', '-Port', String(port)], ownerEnv, 60000);
  must('servidor.ps1 start returns with captured output and the server is up', started.code === 0 && /Servidor no ar/.test(started.out), started.out + ' (' + started.ms + ' ms)');
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json()).catch(() => null);
  check('/health answers {ok, pid}', health?.ok === true && Number.isInteger(health.pid), health);
  const listening = fs.readFileSync(path.join(serverDir, 'server.log'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }).find(e => e.event === 'listening');
  check('the server runs the hosted mode (not --local-studios)', listening?.mode === 'hosted', listening);

  // 3. Tokens (to files only).
  const issued = {};
  for (const [key, customer] of [['a', 'Cliente A'], ['b', 'Cliente B']]) {
    const { status, value } = ssam(['server-token', 'issue', '--customer', customer]);
    must(`ssam server-token issue (${customer}) gives an MCP token and an agent credential`, status === 0 && /^ssam_/.test(value?.token ?? '') && /^ssam_agent_/.test(value?.agentCredential ?? ''), { status, id: value?.id ?? null });
    write(path.join(secrets, key + '.token'), value.token);
    write(path.join(secrets, key + '.agent'), value.agentCredential);
    issued[key] = { id: value.id, token: value.token, credential: value.agentCredential, workspace: path.join(serverDir, 'customers', value.id) };
  }
  const tokensText = fs.readFileSync(path.join(serverDir, 'tokens.json'), 'utf8');
  check('tokens.json holds no plaintext token or agent credential', ![issued.a, issued.b].some(x => tokensText.includes(x.token) || tokensText.includes(x.credential)));

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
  const stdio = await ssamModule.createSsamServer(ssamModule.servedLanes());
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
  const relayPort = relayPorts.filter(p => p !== port);
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
  check('thin: o11_deliver delivers ("entregue") through the relay and the agent to the fake thin bridge',
    delivered.isError !== true && sc(delivered)?.ok === true && sc(delivered)?.result === 'entregue' && task?.delivered === true && task?.writeState === 'applied',
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
    deliverSeen.length > 0 && deliverSeen.every(e => probe(e) || (e.authOk && ['open_module', 'get_active_module', 'snapshot_module', 'merge_from_oml', 'get_errors', 'publish_log'].includes(e.method)))
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
    sc(ordered)?.ok === true && sc(ordered)?.result === 'entregue' && orderTask?.writeState === 'applied' && orderTask?.mergePlan?.deferred?.length >= 1
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
  for (const [key, take] of Object.entries(guarded)) {
    const now = take();
    const changed = [...new Set([...Object.keys(before[key] ?? {}), ...Object.keys(now ?? {})])]
      .filter(k => JSON.stringify(before[key]?.[k]) !== JSON.stringify(now?.[k]));
    check(`no write outside the workspaces: ${key} unchanged`, JSON.stringify(now) === JSON.stringify(before[key]),
      JSON.stringify(now) === JSON.stringify(before[key]) ? '' : { changed: changed.slice(0, 12), count: changed.length });
  }
  const top = fs.readdirSync(serverDir).filter(name => !['customers', 'tokens.json', 'kernel.json', 'server.log', 'server.pid', 'server.json'].includes(name) && !/^audit-\d{8}\.jsonl$/.test(name));
  check('the server folder holds only tokens, kernel.json, servidor.ps1 files, audit and customers', top.length === 0, top);
  const logs = fs.readdirSync(serverDir).filter(n => n.endsWith('.log') || n.endsWith('.jsonl')).map(n => fs.readFileSync(path.join(serverDir, n), 'utf8')).join('\n');
  check('server.log and audit carry no token or agent credential', ![issued.a, issued.b].some(x => logs.includes(x.token) || logs.includes(x.credential)));
  check('the customer workspaces are separate folders', fs.existsSync(issued.a.workspace) && fs.existsSync(issued.b.workspace) && !fs.existsSync(path.join(issued.b.workspace, 'odc', 'lab', 'Candidate.oml')));
} catch (error) {
  if (!(error instanceof Stop)) { failure = error; check('unexpected error', false, error.stack ?? error.message); }
} finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const machine of [A, B]) if (machine.agent && machine.agent.code === null) {
    try { fs.writeFileSync(path.join(machine.root, 'private', 'agent.stop'), ''); } catch { /* folder gone */ }
    await Promise.race([machine.agent.exit, delay(5000)]);
  }
  if (port) await powershell(['-File', path.join(repo, 'scripts', 'servidor.ps1'), 'stop'], ownerEnv, 60000).catch(() => {});
  for (const run of [...children]) { try { run.child.stdin.end(); } catch { /* closed */ } await Promise.race([run.exit, delay(3000)]); }
  for (const run of [...children]) { try { run.child.kill(); } catch { /* gone */ } }
  await delay(300);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
}
const report = { ok: checks.length > 0 && checks.every(c => c.ok) && !failure, checks };
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exit(report.ok ? 0 : 1);
