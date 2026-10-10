// Quick tunnel in front of the HOSTED server (docs/FASE2-AGENTE.md 9.1; owner decision of 2026-10-05: the default quick
// tunnel of the docs). Only the owner runs it, on the server machine:
//   node scripts/tunel.mjs start  [--port 7300] [--cloudflared <cloudflared.exe>]
//        1. scripts/servidor.ps1 start -Port <port>: the hosted server (ssam serve without --local-studios), 127.0.0.1 only;
//        2. refuses unless the process behind the port is that hosted server (never a --local-studios server: through the
//           tunnel any token would drive the owner's own Studios);
//        3. cloudflared tunnel --url http://127.0.0.1:<port> --http-host-header 127.0.0.1:<port> --no-autoupdate
//           --logfile <server dir>\tunnel.log, detached, no console; the Host header rewrite passes the loopback check
//           without --public-host;
//        4. waits for the public https://<random>.trycloudflare.com URL in the log (it changes on every start) and prints
//           it with the client configuration (URL + "Bearer ${SSAM_TOKEN}": a placeholder, never a token).
//   node scripts/tunel.mjs stop   [--server]   stops the tunnel it started (and the server with --server)
//   node scripts/tunel.mjs status              tunnel pid, port, URL and the server status
//   node scripts/tunel.mjs config [--url <https://host>]   the client configuration for the recorded (or given) URL
//   node scripts/tunel.mjs plan   [--port 7300] [--cloudflared <exe>]   the commands start would run; runs nothing
// State: <server dir>\tunnel.json {pid, port, url, cloudflared, startedAt} and tunnel.log; the server dir is
// SSAM_SERVER_DIR or <repo>\.local\server (the folder of scripts/servidor.ps1). cloudflared is never downloaded:
// --cloudflared, SSAM_CLOUDFLARED or the cloudflared on the PATH. Nothing listens beyond 127.0.0.1; the tunnel is an
// outbound connection from this machine. Every external effect goes through `deps`, so the tests run with fakes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 7300;
export const ACTIONS = Object.freeze(['start', 'stop', 'status', 'config', 'plan']);
const URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com\b/i;

export class TunnelError extends Error {
  constructor(message, exitCode = 1) { super(message); this.name = 'TunnelError'; this.exitCode = exitCode; }
}

// argv (after the script) -> {action, port, cloudflared, url, server}. Unknown actions, flags or values are refused.
export function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!ACTIONS.includes(action)) throw new TunnelError('Uso: node scripts/tunel.mjs start|stop|status|config|plan [--port N] [--cloudflared <exe>] [--url <https://host>] [--server]', 2);
  const options = { action, port: DEFAULT_PORT, cloudflared: null, url: null, server: false };
  const allowed = { start: ['--port', '--cloudflared'], plan: ['--port', '--cloudflared'], stop: ['--server'], status: [], config: ['--url'] }[action];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!allowed.includes(flag)) throw new TunnelError(`Opcao desconhecida para ${action}: ${flag}`, 2);
    if (flag === '--server') { options.server = true; continue; }
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new TunnelError(`${flag} precisa de um valor`, 2);
    if (flag === '--port') options.port = validPort(value);
    if (flag === '--cloudflared') options.cloudflared = value;
    if (flag === '--url') options.url = publicUrl(value);
  }
  return options;
}

export function validPort(value) {
  const port = /^\d{1,5}$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new TunnelError(`Porta invalida: ${value} (use 1024-65535)`, 2);
  return port;
}

// The public base URL: https, a host name, no path, query, port or credentials.
export function publicUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new TunnelError(`URL invalida: ${value}`, 2); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new TunnelError(`A URL publica e https://<host>, sem caminho nem porta: ${value}`, 2);
  return 'https://' + url.hostname;
}

export const serverDir = (env = process.env) => (env.SSAM_SERVER_DIR ? path.resolve(env.SSAM_SERVER_DIR) : path.join(repo, '.local', 'server'));
export const servidorScript = () => path.join(repo, 'scripts', 'servidor.ps1');

// The commands of `start`, exactly: the server through scripts/servidor.ps1 and the quick tunnel of the docs.
export function plan({ port = DEFAULT_PORT, cloudflared, dir }) {
  const origin = '127.0.0.1:' + port;
  return {
    server: { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', servidorScript(), 'start', '-Port', String(port)] },
    tunnel: { file: cloudflared, args: ['tunnel', '--url', 'http://' + origin, '--http-host-header', origin, '--no-autoupdate', '--logfile', path.join(dir, 'tunnel.log')] },
    stateFile: path.join(dir, 'tunnel.json'),
  };
}

// The quick tunnel's URL in cloudflared's log, or null (api.trycloudflare.com is the service it asks, not the tunnel).
export function parseTunnelUrl(text) {
  const match = URL_PATTERN.exec(String(text ?? ''));
  return match ? match[0].toLowerCase() : null;
}

// What the owner gives the customer next to the token: the MCP client configuration and the agent setup line. The token
// stays a placeholder, ${SSAM_TOKEN}, resolved by the customer's MCP client from the environment.
export function clientConfig(url) {
  const base = publicUrl(url);
  return {
    mcpUrl: base + '/mcp',
    mcpJson: { mcpServers: { ssam: { type: 'http', url: base + '/mcp', headers: { Authorization: 'Bearer ${SSAM_TOKEN}' } } } },
    claudeCli: `claude mcp add --transport http ssam ${base}/mcp --header "Authorization: Bearer $env:SSAM_TOKEN"`,
    agentSetup: `C:\\SSAM-Agent\\agent\\node\\node.exe C:\\SSAM-Agent\\agent\\ssam-agent.mjs setup --server ${base} --root C:\\SSAM-Agent`,
  };
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

// The real effects; the tests replace each one.
export const realDeps = {
  env: process.env,
  run: (file, args) => { const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 }); return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') }; },
  // {name, commandLine} of a running process, or null.
  processInfo: pid => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { @{ name = $p.Name; commandLine = $p.CommandLine } | ConvertTo-Json -Compress }`],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    try { return JSON.parse(r.stdout.trim()); } catch { return null; }
  },
  spawnDetached: (file, args) => { const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); return child.pid; },
  kill: pid => process.kill(pid),
  which: name => { const r = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null; },
  exists: file => fs.existsSync(file),
  readText: file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } },
  writeJson: (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); },
  readJson,
  remove: file => fs.rmSync(file, { force: true }),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

function findCloudflared(option, deps) {
  const chosen = option ?? deps.env.SSAM_CLOUDFLARED ?? deps.which('cloudflared');
  if (!chosen) throw new TunnelError('cloudflared nao encontrado: instale-o (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) ou passe --cloudflared <exe> / SSAM_CLOUDFLARED. Este script nunca baixa nada.');
  if (!deps.exists(chosen)) throw new TunnelError('cloudflared nao existe: ' + chosen);
  return chosen;
}

// The process behind the port must be the hosted server scripts/servidor.ps1 started: its pid file, a node running
// ssam.mjs serve with this folder's log file, and never --local-studios.
function requireHostedServer(dir, port, deps) {
  const state = deps.readJson(path.join(dir, 'server.json'));
  if (!state || state.port !== port || !Number.isSafeInteger(state.pid)) throw new TunnelError(`Nenhum servidor hospedado do servidor.ps1 na porta ${port} (${path.join(dir, 'server.json')}).`);
  const info = deps.processInfo(state.pid);
  const line = String(info?.commandLine ?? '');
  if (!/ssam\.mjs/i.test(line) || !/\bserve\b/.test(line)) throw new TunnelError(`O pid ${state.pid} da porta ${port} nao e o servidor do ssam; o tunel nao sobe.`);
  if (/--local-studios/i.test(line)) throw new TunnelError(`O servidor da porta ${port} roda com --local-studios (dirige os Studios do dono): nunca o exponha por tunel. Use o servidor hospedado (scripts\\servidor.ps1 start).`);
  if (/--allow-remote|--host\s+(?!127\.0\.0\.1)/i.test(line)) throw new TunnelError(`O servidor da porta ${port} nao escuta so em 127.0.0.1; o tunel nao sobe.`);
  return state.pid;
}

// A recorded tunnel that still runs (a cloudflared started for this port), or null; a stale record is removed.
function liveTunnel(dir, deps) {
  const file = path.join(dir, 'tunnel.json');
  const record = deps.readJson(file);
  if (!record) return null;
  const info = Number.isSafeInteger(record.pid) ? deps.processInfo(record.pid) : null;
  const ours = info && /cloudflared/i.test(String(info.name ?? '')) && String(info.commandLine ?? '').includes('--url http://127.0.0.1:' + record.port);
  if (ours) return record;
  deps.remove(file);
  return null;
}

export async function main(argv, deps = realDeps, print = line => console.log(line)) {
  const options = parseArgs(argv);
  const dir = serverDir(deps.env);
  const stateFile = path.join(dir, 'tunnel.json');
  const show = config => {
    print('URL publica: ' + config.mcpUrl.replace(/\/mcp$/, ''));
    print('Cliente MCP (.mcp.json; o token fica na variavel SSAM_TOKEN do cliente, nunca no arquivo):');
    print(JSON.stringify(config.mcpJson));
    print('Ou: ' + config.claudeCli);
    print('Agente do cliente: ' + config.agentSetup);
  };

  if (options.action === 'plan') {
    const commands = plan({ port: options.port, cloudflared: options.cloudflared ?? deps.env.SSAM_CLOUDFLARED ?? deps.which('cloudflared') ?? 'cloudflared', dir });
    print(JSON.stringify(commands, null, 2));
    return 0;
  }
  if (options.action === 'config') {
    const url = options.url ?? deps.readJson(stateFile)?.url;
    if (!url) throw new TunnelError('Nenhuma URL: suba o tunel (start) ou passe --url https://<host>.');
    show(clientConfig(url));
    return 0;
  }
  if (options.action === 'status') {
    const live = liveTunnel(dir, deps);
    const server = deps.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', servidorScript(), 'status']);
    print(live ? `Tunel: pid ${live.pid}, porta ${live.port}, ${live.url ?? 'URL ainda nao lida'} (desde ${live.startedAt}).` : 'Tunel: parado.');
    print('Servidor: ' + server.out.trim());
    return live ? 0 : 3;
  }
  if (options.action === 'stop') {
    const live = liveTunnel(dir, deps);
    if (live) { deps.kill(live.pid); deps.remove(stateFile); print(`Tunel parado: pid ${live.pid}.`); } else print('Tunel: ja estava parado.');
    if (options.server) print('Servidor: ' + deps.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', servidorScript(), 'stop']).out.trim());
    return 0;
  }

  // start
  const existing = liveTunnel(dir, deps);
  if (existing) {
    if (existing.port !== options.port) throw new TunnelError(`Ja ha um tunel na porta ${existing.port} (pid ${existing.pid}); pare-o antes (stop).`);
    print(`O tunel ja esta no ar: pid ${existing.pid}.`);
    if (existing.url) show(clientConfig(existing.url));
    return 0;
  }
  const cloudflared = findCloudflared(options.cloudflared, deps);
  const commands = plan({ port: options.port, cloudflared, dir });
  const started = deps.run(commands.server.file, commands.server.args);
  if (started.code !== 0) throw new TunnelError('O servidor hospedado nao subiu; o tunel nao sobe. ' + started.out.trim());
  print(started.out.trim());
  requireHostedServer(dir, options.port, deps);
  const logFile = commands.tunnel.args[commands.tunnel.args.length - 1];
  deps.remove(logFile);
  const pid = deps.spawnDetached(commands.tunnel.file, commands.tunnel.args);
  if (!Number.isSafeInteger(pid)) throw new TunnelError('cloudflared nao iniciou.');
  const record = { pid, port: options.port, url: null, cloudflared, startedAt: new Date(deps.now()).toISOString() };
  deps.writeJson(stateFile, record);
  const deadline = deps.now() + 45000;
  while (deps.now() < deadline) {
    const url = parseTunnelUrl(deps.readText(logFile));
    if (url) {
      deps.writeJson(stateFile, { ...record, url });
      print(`Tunel no ar: pid ${pid}, origem http://127.0.0.1:${options.port}. Log: ${logFile}`);
      show(clientConfig(url));
      return 0;
    }
    if (!deps.processInfo(pid)) break;
    await deps.sleep(500);
  }
  try { deps.kill(pid); } catch { /* already gone */ }
  deps.remove(stateFile);
  throw new TunnelError(`cloudflared nao mostrou a URL publica em 45 s; veja ${logFile}. O servidor continua no ar (scripts\\servidor.ps1 stop para parar).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; },
    error => { console.error(error instanceof TunnelError ? error.message : error.stack); process.exitCode = error.exitCode ?? 1; });
}
