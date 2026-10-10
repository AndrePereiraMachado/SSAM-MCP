// Release layout: the one module that knows where things live, in the checkout and in an installed release
// (plan §2.2, §2.3 R2, lane A). It is also the only module allowed to read import.meta.url (DONOS §3): the others ask
// it for their paths, so the bytecode bundle never depends on where a source file was.
//
// RELEASE is true only inside the release bundle, where esbuild defines SSAM_RELEASE=true (lane O). It never comes from
// release.json nor from an environment variable: deleting release.json does not turn a release into a checkout
// (CRITICA-ADENDO AM16). With RELEASE false (the checkout) every function answers what the checkout code uses today,
// so the checkout behaviour does not change.
//
// RELEASE is for behaviour, not for hiding text. esbuild folds the SSAM_RELEASE define only in the expression that reads
// it: an imported RELEASE (or a local const) becomes `var X=!0; ... X ? a : b`, and both texts stay in the bytecode
// (measured by lane V with the pinned esbuild-wasm 0.25.10, define SSAM_RELEASE=true, minify). A text that must be gone
// from the release (a client name, a checkout-only text) needs the test written at the very point:
//   typeof SSAM_RELEASE !== 'undefined' && SSAM_RELEASE === true ? <release text> : <checkout text>
// (with /* global SSAM_RELEASE */; example: platforms/odc/portal/runtime/cognito-login.mjs; docs/DISTRIBUICAO.md R2).
//
// Every function takes an optional last argument `opts` (tests use it to get the release answers without a bundle):
//   release   default RELEASE
//   env       default process.env
//   execPath  default process.execPath (an installed release runs releases\<v>\runtime\node\node.exe)
//
// Frozen API (wave 1). Release paths are under %USERPROFILE%\.ssam-hybrid; USERPROFILE is read from the environment
// first and os.homedir() only when it is missing, the same rule as kernel/src/SSAM.Runtime/RuntimeContract.cs.
//   RELEASE, PORT_COUNT (20), DEFAULT_PORTS {first: 4516, last: 4535}, LANES ['o11', 'odc']
//   root(opts)                   checkout: repository root; release: release root (SSAM_RELEASE_ROOT, else
//                                <execPath>\..\..\..; it must hold release.json)
//   layoutPath(checkoutRel, releaseRel, opts)
//                                checkout: <repo>\<checkoutRel>; release: <release root>\<releaseRel> (a path that has no
//                                place in the release passes releaseRel null and gets an error there)
//   releaseManifest(opts)        release: release.json; checkout: null
//   workspaceConfig(opts)        checkout: .ssam-workspace.json; release: null
//   kernelRoot(opts)             checkout: ANVIL_ROOT or <repo>\<workspace kernel>; release: release root
//   userProfile(opts)            USERPROFILE, else os.homedir()
//   userRoot(opts)               <profile>\.ssam-hybrid (P11)
//   dataRoot(opts)               release: <userRoot>\data; checkout: <repo>\.local
//   laneDataDir(lane, opts)      release: <dataRoot>\<o11|odc>; checkout: <kernel>\.local (ss4), <kernel>\.local\lane-ss5,
//                                <kernel>\.local\lane-odc (the lane folders of Anvil.Cli Program.cs:784 and Cli.Odc :216)
//   licenseRoot(opts)            <userRoot>\license
//   configFile(opts)             <userRoot>\config.json
//   readConfig(opts)             release: config.json ({} when absent, error when invalid); checkout: {} (never read)
//   authorityDir(opts)           release: config authorityDir (absolute), else <profile>\.anvil\authority;
//                                checkout: ANVIL_AUTHORITY_DIR, else <profile>\.anvil\authority (studio-connect.mjs:147)
//   dotnetPath(opts)             release: <release root>\runtime\dotnet\dotnet.exe; checkout: 'dotnet' (PATH)
//   connectionFile(lane, opts)   release: <dataRoot>\<lane>\connection.json;
//                                checkout: <kernel>\.local\connections\<ss4|ss5|odc>.json (studio-session.mjs:4)
//   readConnection(lane, opts)   the connection record, or null when there is none
//   hookExchangeDir(pid, startedUtcMs, opts)
//                                the folder of the O11 hook requests and receipts of one Studio process:
//                                <laneDataDir('o11')>\runtime-connect\<pid>-<start time in Unix ms> (added in phase 2;
//                                only release code uses it, the checkout hook keeps <hook>.json beside its DLL)
//   portRange(opts)              {first, last, bridges[10], workers[10], source}: 20 ports, the first half for O11
//                                bridges, the second half for workers; release: config `ports: {first, last}` or the
//                                default; checkout: the default (the checkout keeps its own ports)
//   bridgePort(opts)             the O11 bridge port. release: the connection record's port, else bridges[0];
//                                checkout: ANVIL_BRIDGE_PORT, else 4536 for the ss5 lane and 4516 otherwise
//   childEnv(base, opts)         the environment of a child process. release: base plus ANVIL_BRIDGE_PORT (opts.port or
//                                bridgePort), ANVIL_AUTHORITY_DIR, USERPROFILE, SSAM_HYBRID_HOME, SSAM_DATA_DIR and
//                                DOTNET_ROOT; the .NET children recompute the same roots from USERPROFILE and
//                                config.json (RuntimeContract) and read ANVIL_BRIDGE_PORT first. checkout: a copy of base.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* global SSAM_RELEASE */
export const RELEASE = typeof SSAM_RELEASE !== 'undefined' && SSAM_RELEASE === true;
export const PORT_COUNT = 20;
export const DEFAULT_PORTS = Object.freeze({ first: 4516, last: 4535 });
export const LANES = Object.freeze(['o11', 'odc']);

const settings = (opts = {}) => ({ release: opts.release ?? RELEASE, env: opts.env ?? process.env, execPath: opts.execPath ?? process.execPath });
const readJson = (file, what) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(what + ' is not valid JSON (' + file + '): ' + error.message); }
};
function checkLane(lane) {
  if (!LANES.includes(lane)) throw new Error('Unknown lane ' + lane + '; lanes: ' + LANES.join(', '));
  return lane;
}
// Only evaluated in the checkout: the bundle has no meaningful import.meta.url.
const checkoutRepo = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function root(opts) {
  const { release, env, execPath } = settings(opts);
  if (!release) return checkoutRepo();
  const folder = env.SSAM_RELEASE_ROOT && path.isAbsolute(env.SSAM_RELEASE_ROOT)
    ? path.resolve(env.SSAM_RELEASE_ROOT) : path.resolve(path.dirname(execPath), '..', '..');
  if (!fs.existsSync(path.join(folder, 'release.json'))) throw new Error('Not an SSAM release folder (no release.json): ' + folder);
  return folder;
}

export function layoutPath(checkoutRel, releaseRel, opts) {
  const { release } = settings(opts);
  if (!release) return path.join(root(opts), checkoutRel);
  if (releaseRel == null) throw new Error('Not part of the release layout: ' + checkoutRel);
  return path.join(root(opts), releaseRel);
}

export function releaseManifest(opts) {
  return settings(opts).release ? readJson(path.join(root(opts), 'release.json'), 'release.json') : null;
}

export function workspaceConfig(opts) {
  return settings(opts).release ? null : readJson(path.join(root(opts), '.ssam-workspace.json'), '.ssam-workspace.json');
}

export function kernelRoot(opts) {
  const { release, env } = settings(opts);
  if (release) return root(opts);
  return env.ANVIL_ROOT ?? path.join(root(opts), workspaceConfig(opts).kernel);
}

// The checkout's O11 lane, by the rule of workspace.mjs resolveO11Lane: ANVIL_LANE, else the workspace's o11Lane.
function checkoutO11Lane(opts) {
  const { env } = settings(opts);
  const explicit = typeof env.ANVIL_LANE === 'string' && env.ANVIL_LANE.trim() ? env.ANVIL_LANE.trim().toLowerCase() : null;
  const configured = workspaceConfig(opts).o11Lane;
  const lane = explicit ?? (typeof configured === 'string' && configured.trim() ? configured.trim().toLowerCase() : null);
  if (!lane) throw new Error('No O11 lane: set ANVIL_LANE (ss4|ss5) or `o11Lane` in .ssam-workspace.json; nothing is assumed');
  return lane;
}

export function userProfile(opts) {
  const { env } = settings(opts);
  return env.USERPROFILE ? path.resolve(env.USERPROFILE) : os.homedir();
}
export const userRoot = opts => path.join(userProfile(opts), '.ssam-hybrid');
export const licenseRoot = opts => path.join(userRoot(opts), 'license');
export const configFile = opts => path.join(userRoot(opts), 'config.json');

export function dataRoot(opts) {
  return settings(opts).release ? path.join(userRoot(opts), 'data') : path.join(root(opts), '.local');
}

export function laneDataDir(lane, opts) {
  checkLane(lane);
  if (settings(opts).release) return path.join(dataRoot(opts), lane);
  const local = path.join(kernelRoot(opts), '.local');
  if (lane === 'odc') return path.join(local, 'lane-odc');
  return checkoutO11Lane(opts) === 'ss5' ? path.join(local, 'lane-ss5') : local;
}

export function readConfig(opts) {
  if (!settings(opts).release) return {};
  const file = configFile(opts);
  if (!fs.existsSync(file)) return {};
  const config = readJson(file, 'config.json');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config.json must hold an object: ' + file);
  return config;
}

export function authorityDir(opts) {
  const { release, env } = settings(opts);
  if (!release) return env.ANVIL_AUTHORITY_DIR ?? path.join(userProfile(opts), '.anvil', 'authority');
  const configured = readConfig(opts).authorityDir;
  if (configured === undefined || configured === null || configured === '') return path.join(userProfile(opts), '.anvil', 'authority');
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw new Error('config.json authorityDir must be an absolute path');
  return path.resolve(configured);
}

export function dotnetPath(opts) {
  return settings(opts).release ? path.join(root(opts), 'runtime', 'dotnet', 'dotnet.exe') : 'dotnet';
}

export function connectionFile(lane = 'o11', opts) {
  checkLane(lane);
  if (settings(opts).release) return path.join(dataRoot(opts), lane, 'connection.json');
  return path.join(kernelRoot(opts), '.local', 'connections', (lane === 'o11' ? checkoutO11Lane(opts) : lane) + '.json');
}

export function readConnection(lane = 'o11', opts) {
  const file = connectionFile(lane, opts);
  return fs.existsSync(file) ? readJson(file, 'Connection record') : null;
}

export function hookExchangeDir(pid, startedUtcMs, opts) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startedUtcMs) || startedUtcMs <= 0)
    throw new Error('hookExchangeDir needs a positive pid and the process start time in Unix milliseconds');
  return path.join(laneDataDir('o11', opts), 'runtime-connect', pid + '-' + startedUtcMs);
}

const validPort = value => Number.isSafeInteger(value) && value >= 1024 && value <= 65535;

export function portRange(opts) {
  const configured = readConfig(opts).ports;
  let first = DEFAULT_PORTS.first, last = DEFAULT_PORTS.last, source = 'default';
  if (configured !== undefined) {
    if (!configured || !validPort(configured.first) || !validPort(configured.last) || configured.last - configured.first + 1 !== PORT_COUNT)
      throw new Error('config.json ports must be {"first": n, "last": n + ' + (PORT_COUNT - 1) + '} inside 1024-65535');
    ({ first, last } = configured); source = 'config';
  }
  const half = PORT_COUNT / 2;
  return { first, last, source,
    bridges: Array.from({ length: half }, (_, i) => first + i),
    workers: Array.from({ length: half }, (_, i) => first + half + i) };
}

export function bridgePort(opts) {
  const { release, env } = settings(opts);
  if (!release) {
    const explicit = Number.parseInt(env.ANVIL_BRIDGE_PORT ?? '', 10);
    return Number.isSafeInteger(explicit) ? explicit : checkoutO11Lane(opts) === 'ss5' ? 4536 : 4516;
  }
  const record = readConnection('o11', opts);
  return validPort(record?.port) ? record.port : portRange(opts).bridges[0];
}

export function childEnv(base = process.env, opts = {}) {
  const resolved = { ...opts, env: opts.env ?? base };
  if (!settings(resolved).release) return { ...base };
  return { ...base,
    ANVIL_BRIDGE_PORT: String(opts.port ?? bridgePort(resolved)),
    ANVIL_AUTHORITY_DIR: authorityDir(resolved),
    USERPROFILE: userProfile(resolved),
    SSAM_HYBRID_HOME: userRoot(resolved),
    SSAM_DATA_DIR: dataRoot(resolved),
    DOTNET_ROOT: path.dirname(dotnetPath(resolved)) };
}
