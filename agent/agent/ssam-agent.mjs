#!/usr/bin/env node
// SSAM agent for the customer's machine (phase 2, docs/FASE2-AGENTE.md and docs/AGENTE-CLIENTE.md). It opens one
// OUTBOUND connection to the SSAM server and runs only the 9 kinds of call that must touch this machine: the Studio
// bridges, the Studio process list and files inside its own folders. No port is opened here; no LLM runs here.
//   node agent\ssam-agent.mjs setup --server <url> [--root <dir>] [--credential-file <file>] [--o11-port <port>]
//   node agent\ssam-agent.mjs run [--root <dir>] [--log-file <file>]
//   node agent\ssam-agent.mjs status [--root <dir>]
//   node agent\ssam-agent.mjs doctor [--root <dir>] [--json]
// The credential (ssam_agent_...) is read from the standard input or a file, written to private\credential and never
// printed. Nothing here imports from platforms/.
// macOS (docs/AGENTE-MAC.md): the same commands, behind agent/ssam-agent.sh and install.sh; the root is POSIX
// (~/SSAM-Agent by default), private/ is closed with chmod 700 and the doctor adds the checks of lib/mac-doctor.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgent, readPack, credentialFile, CREDENTIAL_PATTERN, AGENT_VERSION } from './lib/agent.mjs';
import { LAYOUT } from './lib/workspace.mjs';
import { installedStudios } from './lib/studios.mjs';
import { readConnection } from './lib/o11-connect.mjs';
import { macDoctor } from './lib/mac-doctor.mjs';
import { writeInstallRecord, INSTALL_RECORD } from './lib/launcher.mjs';

export { createAgent } from './lib/agent.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = root => path.join(root, 'private', 'config.json');
const stateFile = root => path.join(root, 'private', 'agent.json');
const stopFile = root => path.join(root, 'private', 'agent.stop');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
// mode (macOS): the file is created with it (the credential: 0600), before it gets its name.
const writeAtomic = (file, text, mode) => { const temporary = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temporary, text, mode === undefined ? undefined : { mode }); fs.renameSync(temporary, file); };
// The words of a path for the person, by system: private\credential on Windows, private/credential on macOS.
const shown = (platform, ...parts) => parts.join(platform === 'darwin' ? '/' : '\\');
const launcherOf = platform => (platform === 'darwin' ? 'agent/ssam-agent.sh' : 'agent\\ssam-agent.ps1');
const guideOf = platform => (platform === 'darwin' ? 'docs/AGENTE-MAC.md' : 'docs\\AGENTE-CLIENTE.md');
const EXIT_TEXT = {
  2: 'credential refused, revoked, expired or replaced by the server owner: ask for a new credential and run setup again',
  3: 'another agent with the same credential took over this account; this one stopped so as not to compete with it',
  4: 'the server does not accept this version of the agent protocol: ask the server owner for the current pack',
};

// The agent root: the folder the pack was extracted to (the one with pack.json above agent\), else
// %USERPROFILE%\SSAM-Agent.
export function defaultRoot({ env = process.env, scriptDir = here } = {}) {
  const parent = path.dirname(scriptDir);
  if (fs.existsSync(path.join(parent, 'pack.json'))) return parent;
  return path.join(env.USERPROFILE || os.homedir(), 'SSAM-Agent');
}

// Why a root is not usable, or null. The ODC bridge splits its command line by spaces (so no whitespace); MSIX
// processes see a private %LOCALAPPDATA% (so the Studio would not find the DLLs there).
export function rootProblem(root, env = process.env, platform = process.platform) {
  if (platform === 'darwin') return posixRootProblem(root, env);
  if (/\s/.test(root)) return `the folder ${root} has a space; the agent needs a folder without spaces. Use --root, for example --root C:\\SSAM-Agent`;
  if (!/^[A-Za-z]:\\/.test(path.win32.resolve(root)) || /^\\\\/.test(root)) return `the folder ${root} must be a local path with a drive letter, such as C:\\SSAM-Agent`;
  const local = env.LOCALAPPDATA ? path.win32.resolve(env.LOCALAPPDATA).toLowerCase() : null;
  const resolved = path.win32.resolve(root).toLowerCase();
  if (local && (resolved === local || resolved.startsWith(local + '\\'))) return `the folder ${root} is inside %LOCALAPPDATA%, which some processes see differently; use another one, such as C:\\SSAM-Agent`;
  return null;
}

// macOS: an absolute folder without spaces (the bridge splits its line by spaces), outside the folders macOS guards for
// privacy (TCC: the Studio would be asked for access or refused there), outside the temporary folders macOS cleans and
// off /Volumes (another disk, maybe a network or removable one: the Windows rule of a local drive). Names are compared
// without case, as APFS does by default.
const fold = text => String(text).normalize('NFC').toLowerCase().replace(/\/+$/, '');
export function posixRootProblem(root, env = process.env) {
  const home = env.HOME && env.HOME.startsWith('/') ? env.HOME.replace(/\/+$/, '') : os.homedir();
  const example = path.posix.join(home, 'SSAM-Agent');
  if (/\s/.test(root)) return `the folder ${root} has a space; the agent needs a folder without spaces. Use --root, for example --root ${example}`;
  if (!String(root).startsWith('/')) return `the folder ${root} must be an absolute path, such as ${example}`;
  const target = fold(path.posix.resolve(root));
  const inside = parent => target === fold(parent) || target.startsWith(fold(parent) + '/');
  for (const guarded of ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents', 'Library/CloudStorage'].map(name => path.posix.join(home, name)))
    if (inside(guarded)) return `the folder ${root} is inside ${guarded}, which macOS guards for privacy: the Studio would be asked for access or refused there. Use ${example}`;
  for (const temporary of ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', ...(env.TMPDIR ? [env.TMPDIR] : [])])
    if (inside(temporary)) return `the folder ${root} is a temporary folder that macOS cleans; use ${example}`;
  if (inside('/Volumes')) return `the folder ${root} is on another volume (/Volumes); use a folder of this Mac's disk, such as ${example}`;
  return null;
}

// Server URL check: https, or plain http only on loopback (tests, or a tunnel endpoint on this machine).
export function serverProblem(server) {
  let url;
  try { url = new URL(server); } catch { return `invalid server address: ${server}`; }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  return 'the server address must be https:// (the credential must not travel in clear text)';
}

function icaclsUser(env) {
  return env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : os.userInfo().username;
}
const runIcacls = async args => { await exec('icacls', args, { windowsHide: true, timeout: 60000 }); };

// The credential from a file, or from standard input (piped, or typed without echo on a console).
async function readCredential({ file, stdin, stderr }) {
  if (file) return fs.readFileSync(file, 'utf8').trim();
  if (!stdin.isTTY) { let text = ''; for await (const chunk of stdin) text += chunk; return text.trim(); }
  stderr.write('Paste the agent credential (ssam_agent_...) and press Enter: ');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = error => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stderr.write('\n'); error ? reject(error) : resolve(value.trim()); };
    const onData = chunk => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        value = ch === '\u0008' || ch === '\u007f' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume(); stdin.on('data', onData);
  });
}

// private/ on macOS: owner only (0700), checked after the change; the credential file is then created 0600.
async function restrictPosix(dir) {
  fs.chmodSync(dir, 0o700);
  const mode = fs.statSync(dir).mode & 0o777;
  if (mode !== 0o700) throw new Error(`the folder kept the mode ${mode.toString(8)}`);
}

export async function setup({ root, server, credentialFile: file, o11Port, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  env = process.env, icacls = runIcacls, platform = process.platform, restrict = restrictPosix }) {
  if (platform === 'darwin') return setupPosix({ root, server, file, o11Port, stdin, stdout, stderr, env, restrict });
  const say = text => stdout.write(text + '\n'); const fail = text => { stderr.write('Error: ' + text + '\n'); return 1; };
  if (!server) return fail('missing --server <url> (the address the server owner gave you)');
  const badServer = serverProblem(server);
  if (badServer) return fail(badServer);
  // The loopback port of the O11 bridge in the customer's Service Studio (default 4516; another one when a second bridge
  // lane already uses 4516 on this machine).
  const port = o11Port === undefined || o11Port === null ? null : /^\d{4,5}$/.test(String(o11Port)) ? Number(o11Port) : NaN;
  if (port !== null && !(port >= 1024 && port <= 65535)) return fail(`--o11-port must be a port between 1024 and 65535: ${o11Port}`);
  const target = path.resolve(root);
  const badRoot = rootProblem(target, env);
  if (badRoot) return fail(badRoot);
  let credential;
  try { credential = await readCredential({ file, stdin, stderr }); } catch (error) { return fail('could not read the credential: ' + error.message); }
  if (!CREDENTIAL_PATTERN.test(credential)) return fail('the credential does not have the 54-character ssam_agent_... format (it was neither shown nor saved)');
  for (const folder of LAYOUT) fs.mkdirSync(path.join(target, ...folder.split('/')), { recursive: true });
  const privateDir = path.join(target, 'private');
  // private\ is restricted to the current user BEFORE the credential is written, so it never has an inherited ACL.
  try { await icacls([privateDir, '/inheritance:r', '/grant:r', icaclsUser(env) + ':(OI)(CI)F']); }
  catch (error) { return fail('could not restrict private\\ to the current user (icacls): ' + error.message); }
  const previous = readJson(configFile(target)) ?? {};
  writeAtomic(configFile(target), JSON.stringify({ server: server.replace(/\/+$/, ''), o11Port: port ?? (Number.isInteger(previous.o11Port) ? previous.o11Port : 4516) }, null, 2));
  writeAtomic(credentialFile(target), credential);
  say(`Agent set up in ${target} for ${server}. The credential was saved in private\\credential (only this user can read it).`);
  say(`Next step: ${path.join(target, 'agent', 'ssam-agent.ps1')} start`);
  return 0;
}

// setup on macOS: the same checks and files as on Windows; private/ is closed with chmod 700 before the credential is
// written, and the credential is created 0600.
async function setupPosix({ root, server, file, o11Port, stdin, stdout, stderr, env, restrict }) {
  const say = text => stdout.write(text + '\n'); const fail = text => { stderr.write('Error: ' + text + '\n'); return 1; };
  if (!server) return fail('missing --server <url> (the address the server owner gave you)');
  const badServer = serverProblem(server);
  if (badServer) return fail(badServer);
  const port = o11Port === undefined || o11Port === null ? null : /^\d{4,5}$/.test(String(o11Port)) ? Number(o11Port) : NaN;
  if (port !== null && !(port >= 1024 && port <= 65535)) return fail(`--o11-port must be a port between 1024 and 65535: ${o11Port}`);
  if (typeof root !== 'string' || !root.startsWith('/')) return fail(posixRootProblem(String(root ?? ''), env) ?? `the folder ${root} must be an absolute path`);
  const target = path.posix.resolve(root);
  const badRoot = posixRootProblem(target, env);
  if (badRoot) return fail(badRoot);
  let credential;
  try { credential = await readCredential({ file, stdin, stderr }); } catch (error) { return fail('could not read the credential: ' + error.message); }
  if (!CREDENTIAL_PATTERN.test(credential)) return fail('the credential does not have the 54-character ssam_agent_... format (it was neither shown nor saved)');
  // The folders this setup creates (those not there yet), for the record that uninstall reads (review M2).
  const created = [];
  for (const folder of LAYOUT) {
    const parts = folder.split('/');
    for (let i = 1; i <= parts.length; i++) { const rel = parts.slice(0, i).join('/'); if (!created.includes(rel) && !fs.existsSync(path.join(target, ...parts.slice(0, i)))) created.push(rel); }
  }
  for (const folder of LAYOUT) fs.mkdirSync(path.join(target, ...folder.split('/')), { recursive: true });
  const privateDir = path.join(target, 'private');
  try { await restrict(privateDir); }
  catch (error) { return fail('could not restrict private/ to the current user (chmod 700): ' + error.message); }
  const previous = readJson(configFile(target)) ?? {};
  writeAtomic(configFile(target), JSON.stringify({ server: server.replace(/\/+$/, ''), o11Port: port ?? (Number.isInteger(previous.o11Port) ? previous.o11Port : 4516) }, null, 2), 0o600);
  writeAtomic(credentialFile(target), credential, 0o600);
  try { writeInstallRecord(target, created); }
  catch (error) { return fail(`could not write the setup record ${INSTALL_RECORD} (uninstall needs it): ` + error.message); }
  say(`Agent set up in ${target} for ${server}. The credential was saved in private/credential (only this user can read it).`);
  say(`Next step: ${path.posix.join(target, 'agent', 'ssam-agent.sh')} start`);
  return 0;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// A state file whose pid lives and was refreshed in the last 90 s means an agent runs for this root.
function runningAgent(root, now = Date.now()) {
  const state = readJson(stateFile(root));
  if (!state || state.state === 'stopped' || !Number.isInteger(state.pid) || state.pid === process.pid) return null;
  return alive(state.pid) && now - Date.parse(state.at) < 90000 ? state : null;
}

export async function runAgent({ root, logFile = null, stderr = process.stderr, platform = process.platform }) {
  const target = path.resolve(root);
  const config = readJson(configFile(target));
  if (!config?.server || !fs.existsSync(credentialFile(target))) { stderr.write(`Error: the agent is not set up; run setup first (${guideOf(platform)}).\n`); return 1; }
  const other = runningAgent(target);
  if (other) { stderr.write(`Error: another agent already runs in this folder (pid ${other.pid}). Stop it first (${launcherOf(platform)} stop).\n`); return 1; }
  const write = line => { if (logFile) fs.appendFileSync(logFile, line + '\n'); else stderr.write(line + '\n'); };
  const log = (event, fields = {}) => write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
  let current = { pid: process.pid, server: config.server, state: 'starting', at: new Date().toISOString() };
  const saveState = (state, extra = {}) => {
    current = { pid: process.pid, server: config.server, state, at: new Date().toISOString(), ...extra };
    writeAtomic(stateFile(target), JSON.stringify(current));
  };
  saveState('starting');
  fs.rmSync(stopFile(target), { force: true });
  const agent = createAgent({ root: target, config: { server: config.server, o11Port: config.o11Port }, log, onState: (state, extra) => saveState(state, extra) });
  log('start', { version: AGENT_VERSION, node: process.version, instance: agent.instance, server: config.server });
  // agent\ssam-agent.ps1 stop asks for a clean stop through private\agent.stop; the state file is refreshed meanwhile.
  let ticks = 0;
  const poll = setInterval(() => {
    if (fs.existsSync(stopFile(target))) { fs.rmSync(stopFile(target), { force: true }); agent.stop(); return; }
    if (++ticks % 30 === 0) { const { pid, server, state, at, ...extra } = current; saveState(state, extra); }
  }, 1000);
  const onSignal = () => agent.stop();
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const code = await agent.run();
  clearInterval(poll);
  if (EXIT_TEXT[code]) log('stopped', { code, reason: EXIT_TEXT[code] });
  return code;
}

export function status({ root, stdout = process.stdout }) {
  const target = path.resolve(root);
  const config = readJson(configFile(target));
  const pack = readPack(target);
  const state = readJson(stateFile(target));
  const running = runningAgent(target);
  const connection = readConnection(target);
  stdout.write(JSON.stringify({ root: target, server: config?.server ?? null, credential: fs.existsSync(credentialFile(target)),
    pack: { id: pack.id, lanes: pack.lanes, odcBridge: pack.odcBridge, o11BuiltFor: pack.o11BuiltFor },
    agent: running ? { running: true, pid: running.pid, state: running.state, since: running.at } : { running: false, last: state?.state ?? null, exitCode: state?.exitCode ?? null },
    o11Connection: connection ? { pid: connection.pid, port: connection.port, studioVersion: connection.studioVersion ?? null, connectedAt: connection.connectedAt ?? null } : null }, null, 2) + '\n');
  return running ? 0 : 3;
}

async function packIntegrity(root) {
  const pack = readJson(path.join(root, 'pack.json'));
  if (!pack || !Array.isArray(pack.files)) return { ok: false, detail: 'pack.json missing or invalid' };
  const bad = [];
  for (const file of pack.files) {
    const full = path.join(root, ...String(file.path).split('/'));
    if (!fs.existsSync(full)) { bad.push(file.path + ' (missing)'); continue; }
    if (createHash('sha256').update(fs.readFileSync(full)).digest('hex') !== file.sha256) bad.push(file.path + ' (changed)');
  }
  return bad.length ? { ok: false, detail: bad.slice(0, 5).join(', ') + (bad.length > 5 ? ` and ${bad.length - 5} more` : '') }
    : { ok: true, detail: `${pack.files.length} files checked (${pack.id})` };
}
const runtimesOf = async () => (await exec('dotnet', ['--list-runtimes'], { windowsHide: true, timeout: 60000 })).stdout;

// doctor: what this machine needs, without printing any secret. deps (tests): flags, runtimes, studios, fetch, env,
// platform, mac (the deps of lib/mac-doctor.mjs). json: one JSON object instead of the lines (macOS: with the facts).
export async function doctor({ root, stdout = process.stdout, deps = {}, json = false }) {
  const platform = deps.platform ?? process.platform;
  const target = platform === 'darwin' ? path.posix.resolve(root) : path.resolve(root);
  const env = deps.env ?? process.env;
  const flags = deps.flags ?? process.allowedNodeEnvironmentFlags;
  const checks = [];
  const add = (ok, name, detail, required = true) => checks.push({ ok, name, detail, required });
  for (const flag of ['--use-env-proxy', '--use-system-ca'])
    add(flags.has(flag), 'Node ' + flag, flags.has(flag) ? `${process.version} has ${flag}` : `${process.version} does not have ${flag}: install the current Node 24`);
  const badRoot = rootProblem(target, env, platform);
  add(!badRoot, 'agent folder', badRoot ?? target);
  const integrity = await packIntegrity(target);
  add(integrity.ok, 'pack', integrity.detail);
  const pack = readPack(target);
  const config = readJson(configFile(target));
  const badServer = config?.server ? serverProblem(config.server) : `no ${shown(platform, 'private', 'config.json')}: run setup`;
  add(!badServer, 'server', badServer ?? config.server);
  let credentialOk = false;
  try { credentialOk = CREDENTIAL_PATTERN.test(fs.readFileSync(credentialFile(target), 'utf8').trim()); } catch { /* missing */ }
  add(credentialOk, 'credential', credentialOk ? `${shown(platform, 'private', 'credential')} present (not shown)` : 'no valid credential: run setup');
  let facts = null;
  if (platform === 'darwin') {
    // No .NET on a Mac: the agent attaches the Studios itself (the .NET diagnostic IPC); the macOS facts instead.
    add(true, 'attach', 'the agent speaks the .NET diagnostic IPC itself: no .NET runtime is needed on this Mac', false);
    const mac = await macDoctor({ pack, deps: deps.mac ?? {} }).catch(error => ({ checks: [{ ok: false, name: 'macOS checks', detail: String(error?.message ?? error), required: false }], facts: null }));
    checks.push(...mac.checks);
    facts = mac.facts;
  } else {
    let runtimes = '';
    try { runtimes = await (deps.runtimes ?? runtimesOf)(); } catch { /* no dotnet */ }
    const hasRuntime = major => new RegExp('^Microsoft\\.NETCore\\.App ' + major + '\\.', 'm').test(runtimes);
    if (pack.lanes.includes('odc')) add(hasRuntime(10), '.NET 10 (attach ODC)', hasRuntime(10) ? 'installed' : 'the .NET 10 runtime is missing (Microsoft.NETCore.App 10.x)');
    if (pack.lanes.includes('o11')) { const ok = [8, 9, 10, 11].some(hasRuntime); add(ok, '.NET 8+ (Anvil.Connect)', ok ? 'installed' : 'the .NET 8 or newer runtime is missing'); }
    const studios = await (deps.studios ?? (() => installedStudios()))().catch(() => ({}));
    for (const lane of pack.lanes) {
      const installed = studios?.[lane]?.installed;
      add(Boolean(installed), lane === 'odc' ? 'ODC Studio' : 'Service Studio', installed ? `${installed.version ?? 'unknown version'} in ${installed.dir}` : 'not found on this machine', false);
    }
  }
  if (config?.server && !badServer) {
    let reached = false; let detail = '';
    try { const reply = await (deps.fetch ?? fetch)(config.server.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(10000) }); reached = reply.ok; detail = 'HTTP ' + reply.status; }
    catch (error) { detail = error.message; }
    add(reached, 'server responds', reached ? detail : `${detail}; check the network, the proxy (HTTPS_PROXY) and the certificate (--use-system-ca)`);
  }
  const ok = checks.every(check => check.ok || !check.required);
  if (json) stdout.write(JSON.stringify({ ok, platform, agentVersion: AGENT_VERSION, node: process.version, root: target, pack: { id: pack.id, lanes: pack.lanes, odcBridge: pack.odcBridge, o11BuiltFor: pack.o11BuiltFor },
    checks: checks.map(check => ({ status: check.ok ? 'ok' : check.required ? 'fail' : 'warn', name: check.name, detail: check.detail })), ...(facts ? { mac: facts } : {}) }, null, 2) + '\n');
  else for (const check of checks) stdout.write(`[${check.ok ? 'ok' : check.required ? 'fail' : 'warn'}] ${check.name}: ${check.detail}\n`);
  return ok ? 0 : 1;
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (!name.startsWith('--')) throw new Error('unexpected argument: ' + name);
    const key = name.slice(2);
    if (key === 'json' && command === 'doctor') { options.json = true; continue; }
    if (!['server', 'root', 'credential-file', 'log-file', 'o11-port'].includes(key)) throw new Error('unknown option: ' + name);
    if (i + 1 >= rest.length) throw new Error('missing value for ' + name);
    options[key] = rest[++i];
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parse(argv); } catch (error) { process.stderr.write('Error: ' + error.message + '\n'); return 1; }
  const { command, options } = parsed;
  const root = options.root ?? process.env.SSAM_AGENT_ROOT ?? defaultRoot();
  if (command === 'setup') return setup({ root, server: options.server, credentialFile: options['credential-file'], o11Port: options['o11-port'] });
  if (command === 'run') return runAgent({ root, logFile: options['log-file'] ?? null });
  if (command === 'status') return status({ root });
  if (command === 'doctor') return doctor({ root, json: options.json === true });
  process.stderr.write('Usage: ssam-agent.mjs setup --server <url> [--root <folder>] [--credential-file <file>] [--o11-port <port>] | run | status | doctor [--json]\n');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // `run` exits as soon as the agent stops (idle keep-alive sockets must not hold the process); the log is written
  // synchronously. The other commands only set the exit code, so their output is never cut.
  main().then(code => { if (process.argv[2] === 'run') process.exit(code); process.exitCode = code; },
    error => { process.stderr.write('Error: ' + error.message + '\n'); process.exitCode = 1; });
}
