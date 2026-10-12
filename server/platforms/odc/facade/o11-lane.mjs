// The O11 lane table in the facade's own process (ported from kernel/scripts/lanes.py and anvil_authority.py, so no
// Python runs to answer it): one Service Studio copy, bridge, CDP and worker port, and work folders per lane.
//
// | Lane | Bridge | CDP  | Worker            | Studio installation                                        | Folders          |
// |------|--------|------|-------------------|------------------------------------------------------------|------------------|
// | ss4  | 4516   | 9226 | workers.o11ss4    | %USERPROFILE%\OutSystems\Service Studio 11 - Anvil 4516    | .local/          |
// | ss5  | 4536   | 9246 | workers.o11ss5    | %USERPROFILE%\OutSystems\Service Studio 11 - Anvil 4536    | .local/lane-ss5/ |
//
// The worker ports come from .ssam-workspace.json ("workers"), as lanes.py reads them; without that file the table
// keeps 4517/4537. ANVIL_STUDIO_DIR, USERPROFILE and LOCALAPPDATA are read at call time, never cached.
//
// Hosted (executor.mjs, docs/FASE2-AGENTE.md 4.7), with the default root: `local` is the customer's <ws>/o11, the CLI and
// the Studio stay the server's, there is no lane worker (the customer's own one is anvil-worker.mjs hostedWorkerClient),
// and `bridge` is the relay port of the customer's connection record, or O11_NOT_CONNECTED without one: every caller that
// reads it fails closed, never on the lane table port.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { anvilRoot, workspaceRoot } from './workspace.mjs';
import { currentExecutor, hostedSpawnEnv, o11NotConnected, usesWorkspace, workspacePath } from './executor.mjs';

const DEFAULT_TABLE = { ss4: { bridge: 4516, cdp: 9226, worker: 4517, local: '.local' },
  ss5: { bridge: 4536, cdp: 9246, worker: 4537, local: path.join('.local', 'lane-ss5') } };

export function laneTable(root = workspaceRoot) {
  const table = structuredClone(DEFAULT_TABLE);
  const file = path.join(root, '.ssam-workspace.json');
  if (!fs.existsSync(file)) return table;
  const workers = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).workers ?? {};
  for (const name of Object.keys(table)) if (Number.isInteger(workers['o11' + name])) table[name].worker = workers['o11' + name];
  return table;
}

const home = (env = process.env) => env.USERPROFILE || os.homedir();
const baseStudio = (env = process.env) => path.join(env.ProgramFiles || 'C:\\Program Files', 'OutSystems', 'Service Studio 11', 'Service Studio');
const studioDirOf = (row, env) => env.ANVIL_STUDIO_DIR || path.join(home(env), 'OutSystems', `Service Studio 11 - Anvil ${row.bridge}`, 'Service Studio');
// The Studio a lane's kernel loads, on this machine (createHostedContext reads it for the customer's CLI runs).
export function kernelStudioDir(name, { workspace = workspaceRoot, env = process.env } = {}) {
  const laneName = String(name ?? env.ANVIL_LANE ?? 'ss4').trim().toLowerCase();
  const row = laneTable(workspace)[laneName];
  if (!row) throw new Error(`Unknown O11 lane '${laneName}'; lanes: ${Object.keys(DEFAULT_TABLE).join(', ')}`);
  return studioDirOf(row, env);
}

// One lane, with the same fields and resolution order as lanes.py `Lane`.
export function o11LaneOf(name, { root = anvilRoot, workspace = workspaceRoot, env = process.env } = {}) {
  const laneName = String(name ?? env.ANVIL_LANE ?? 'ss4').trim().toLowerCase();
  const row = laneTable(workspace)[laneName];
  if (!row) throw new Error(`Unknown O11 lane '${laneName}'; lanes: ${Object.keys(DEFAULT_TABLE).join(', ')}`);
  const hosted = usesWorkspace(root, anvilRoot);
  const own = path.join(root, row.local);
  const local = hosted ? workspacePath('o11') : own;
  const studioDir = () => studioDirOf(row, env);
  const cli = () => [path.join(own, 'cli', 'anvil.dll'), path.join(root, '.local', 'cli', 'anvil.dll')].find(p => fs.existsSync(p))
    ?? path.join(root, 'src', 'Anvil.Cli', 'bin', 'Release', 'net8.0', 'anvil.dll');
  const lane = {
    name: laneName, bridge: row.bridge, cdp: row.cdp, worker: hosted ? null : row.worker, local, root,
    get studioDir() { return studioDir(); },
    get cli() { return cli(); },
    jobs: path.join(local, 'jobs'), proofs: path.join(local, 'proofs'), work: path.join(local, 'work'), soak: path.join(local, 'soak'),
    get bridgeLog() { return path.join(env.LOCALAPPDATA || home(env), 'Anvil', `bridge-${row.bridge}.log`); },
    // Environment for child processes: the lane and, when the installation exists, that lane's Studio. Hosted: the
    // closed environment of the customer's workspace (executor.mjs hostedSpawnEnv), never this process's.
    env(base = env) {
      if (hosted) return hostedSpawnEnv('o11').env;
      const result = { ...base, ANVIL_LANE: laneName };
      if (!result.ANVIL_STUDIO_DIR && fs.existsSync(studioDir())) result.ANVIL_STUDIO_DIR = studioDir();
      return result;
    },
    asDict() {
      const dir = studioDir();
      // A report: without the customer's connection the hosted bridge port is null (reading `bridge` refuses).
      let bridge = row.bridge;
      if (hosted) { try { bridge = this.bridge; } catch (error) { if (error?.code !== 'O11_NOT_CONNECTED') throw error; bridge = null; } }
      return { name: laneName, bridge, cdp: row.cdp, worker: hosted ? null : row.worker, local, studioDir: dir,
        studioExists: fs.existsSync(dir), baseStudio: baseStudio(env), cli: cli(), bridgeLog: this.bridgeLog };
    },
  };
  if (hosted) Object.defineProperty(lane, 'bridge', { enumerable: true, get() {
    const record = currentExecutor().o11Connection();
    if (!Number.isInteger(record?.port)) throw o11NotConnected();
    return record.port;
  } });
  return lane;
}

// The folder of the trusted-controller key (bridge.key), in the order anvil_authority.py and BridgeAccess.cs use:
// ANVIL_AUTHORITY_DIR of this process, then the user's HKCU\Environment value, then %LOCALAPPDATA%\Anvil\authority.
// A connection record's authorityDir, when the caller has one, wins: the attach put the key there.
export function authorityDir({ env = process.env, record = null, readUserEnvironment = userEnvironmentValue } = {}) {
  if (record?.authorityDir) return record.authorityDir;
  if (env.ANVIL_AUTHORITY_DIR) return env.ANVIL_AUTHORITY_DIR;
  const user = readUserEnvironment('ANVIL_AUTHORITY_DIR');
  if (user) return user;
  return path.join(env.LOCALAPPDATA || path.join(home(env), 'AppData', 'Local'), 'Anvil', 'authority');
}
export const authorityKeyPath = options => path.join(authorityDir(options), 'bridge.key');
export function readAuthorityKey(options) {
  try { return fs.readFileSync(authorityKeyPath(options), 'ascii').trim() || null; }
  catch { return null; }
}

// HKCU\Environment, read without Python or PowerShell (reg.exe ships with Windows). Null when absent or not Windows.
export function userEnvironmentValue(name) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split(/\r?\n/).find(l => l.trim().toLowerCase().startsWith(name.toLowerCase()));
    const value = line?.trim().split(/\s+REG_(?:EXPAND_)?SZ\s+/)[1]?.trim();
    return value ? value.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m) : null;
  } catch { return null; }
}
