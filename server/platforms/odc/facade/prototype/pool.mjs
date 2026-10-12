// Pool of capture child processes (docs/PROTOTIPO-NATIVO.md 2.1, 2.6): P = min(8, floor(CPUs / 4)) children,
// batches ordered by key and distributed by hash, results merged in key order so that the IR never depends on the
// scheduling. Each child runs with TZ pinned and without proxy variables; a batch that exceeds the timeout kills its
// child (a fresh one takes the remaining batches) and comes back as a failure.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./child.mjs', import.meta.url));

// Sandbox of the capture child (docs/PROTOTIPO-NATIVO.md 2.1 "a renderer that sandboxes the prototype JS"): the child
// runs untrusted prototype scripts, so it is forked under Node's permission model (--permission) with no child
// process, worker, native addon, WASI or inspector permission, filesystem reads limited to the runtime, the third-party
// packages, the modules the child itself loads (file by file: never the rest of the facade nor the kernel) and this one
// prototype folder, and writes limited to a private work directory. jsdom's vm context is not a security
// boundary (a page script can reach the host realm through, for example, `document.createElement.constructor`), so the
// OS-level permission model — not the realm — is what denies the escaped code the filesystem, spawning and the host
// environment. Set SSAM_PROTOTYPE_NO_SANDBOX=1 to disable it (debugging only; never in a server/thin-agent path).
const SANDBOX = process.env.SSAM_PROTOTYPE_NO_SANDBOX !== '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));           // .../facade/prototype
const FACADE = path.resolve(HERE, '..');                            // .../facade
const ODC = path.resolve(FACADE, '..');                            // .../platforms/odc
const NODE_ROOT = path.dirname(process.execPath);
// A single work directory for every capture child: the compile cache and os.tmpdir() of the child live here, and it is
// the only path the child may write. It never carries prototype data between captures (the children are re-init'd).
const WORK_TMP = path.join(os.tmpdir(), 'ssam-prototype-work');

function realOrSelf(target) { try { return fs.realpathSync(target); } catch { return target; } }

// The relative imports of a module: static (`from './x.mjs'`, `import './x.mjs'`) and dynamic (`import('./x.mjs')`).
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]+)\1/g;
let childModules = null;

// The facade modules the capture child loads: child.mjs and every module its relative imports reach, read from the
// source once. These files (not the facade folder) are what the child may read of the facade: the rest of the facade
// source tree and the kernel stay denied, so escaped prototype code cannot read SSAM's own code or configuration.
export function childModuleFiles() {
  if (childModules) return childModules;
  const seen = new Set();
  const pending = [CHILD];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const match of text.matchAll(RELATIVE_IMPORT)) pending.push(path.resolve(path.dirname(file), match[2]));
  }
  childModules = [...seen].sort();
  return childModules;
}

// Read roots the child needs, as directory trees: the Node runtime, the third-party packages (node_modules of the ODC
// platform, following the dev junction to its real target), this prototype folder and the work directory. Everything
// else — the facade and kernel sources, the user profile, credential and vault files, the rest of the disk — is denied.
function readRoots(root) {
  const roots = [NODE_ROOT, path.resolve(NODE_ROOT, '..'), path.join(ODC, 'node_modules'), realOrSelf(path.join(ODC, 'node_modules')), root, realOrSelf(root), WORK_TMP];
  // The package lookups of the module resolver from the child's folder up to the platform folder (node_modules folders
  // that do not exist there, and the package.json scopes): allowed as names so a lookup is answered "not found", never
  // denied; none of them is a source file.
  for (let dir = HERE; ; dir = path.dirname(dir)) {
    roots.push(path.join(dir, 'node_modules'));
    if (dir === ODC || path.dirname(dir) === dir) break;
  }
  return [...new Set(roots.filter(Boolean).map(entry => path.resolve(entry)))];
}

// The single files the child reads outside the roots: its own modules and the package.json scopes on the way up.
function readFiles() {
  const files = [...childModuleFiles()];
  for (let dir = HERE; ; dir = path.dirname(dir)) {
    files.push(path.join(dir, 'package.json'));
    if (dir === ODC || path.dirname(dir) === dir) break;
  }
  return [...new Set(files.map(file => path.resolve(file)))];
}

// A path, as the permission model matches it: on Windows the ESM loader resolves modules to extended-length (\\?\)
// paths, and the model does not match those against a plain allow entry, so both forms are listed; a directory also as
// its recursive subtree, a file as itself only.
function allowForms(entry, tree = true) {
  const forms = tree ? [entry, entry + path.sep + '*'] : [entry];
  if (process.platform === 'win32') forms.push(...forms.map(form => '\\\\?\\' + form));
  return forms;
}

export function sandboxArgs(root) {
  if (!SANDBOX) return [];
  try { fs.mkdirSync(WORK_TMP, { recursive: true }); } catch { /* best effort; the child reports a write refusal */ }
  const args = ['--permission'];
  for (const dir of readRoots(root)) for (const form of allowForms(dir)) args.push('--allow-fs-read=' + form);
  for (const file of readFiles()) for (const form of allowForms(file, false)) args.push('--allow-fs-read=' + form);
  for (const form of allowForms(WORK_TMP)) args.push('--allow-fs-write=' + form);
  return args;
}

export function defaultPoolSize() {
  const cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, Math.floor(cpus / 4)));
}

function fnv(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}

// Windows always force-merges a set of system variables into a forked child's environment (USERPROFILE, PATH, APPDATA,
// HOMEDRIVE/HOMEPATH, USERNAME, ...), even when `env` is given; so to withhold them the sandbox must set each to the
// empty string, not just leave it out.
const REDACT_ENV = ['USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'PATH', 'Path', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'APPDATA', 'LOCALAPPDATA'];

// The capture child executes untrusted prototype JS. It is not given the user's environment: PATH, USERPROFILE, HOME and
// the rest of REDACT_ENV are blanked (so escaped code cannot locate the home directory or its credential files), and
// TEMP/TMP point at the sandbox work directory (the only writable path). SystemRoot/windir/SystemDrive stay because Node
// needs them to start on Windows; TZ is pinned and NODE_OPTIONS is cleared for determinism.
function childEnv(tz) {
  if (!SANDBOX) {
    const env = { TZ: tz, NODE_OPTIONS: '' };
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']) if (process.env[key]) env[key] = process.env[key];
    return env;
  }
  const env = { TZ: tz, NODE_OPTIONS: '', TEMP: WORK_TMP, TMP: WORK_TMP };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'SYSTEMDRIVE']) if (process.env[key]) env[key] = process.env[key];
  for (const key of REDACT_ENV) env[key] = '';
  return env;
}

class Child {
  constructor(index, options) {
    this.index = index;
    this.options = options;
    this.process = null;
    this.ready = null;
    this.stderr = '';
  }
  start() {
    this.stderr = '';
    this.process = fork(CHILD, [], {
      execArgv: ['--experimental-vm-modules', '--no-warnings', ...sandboxArgs(path.resolve(this.options.config.root)), ...(process.env.SSAM_PROTOTYPE_CPU_PROF ? ['--cpu-prof', '--cpu-prof-dir=' + process.env.SSAM_PROTOTYPE_CPU_PROF] : [])],
      env: childEnv(this.options.tz),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    this.process.stderr.on('data', chunk => { if (this.stderr.length < 8000) this.stderr += chunk; });
    this.ready = new Promise((resolve, reject) => {
      const onExit = code => reject(new Error('capture child exited (' + code + '): ' + this.stderr.slice(0, 2000)));
      const onMessage = message => { if (message.type === 'ready') { this.process.off('message', onMessage); this.process.off('exit', onExit); this.info = message; resolve(message); } };
      this.process.on('message', onMessage);
      this.process.once('exit', onExit);
    });
    this.process.send({ type: 'init', config: this.options.config });
    return this.ready;
  }
  // A resident child takes the configuration of the next capture (source, clock, vendors); its script cache stays.
  reinit(config) {
    this.options.config = config;
    return new Promise((resolve, reject) => {
      const onExit = code => { this.process.off('message', onMessage); reject(new Error('capture child exited (' + code + ')')); };
      const onMessage = message => { if (message.type === 'ready') { this.process.off('message', onMessage); this.process.off('exit', onExit); resolve(message); } };
      this.process.on('message', onMessage);
      this.process.once('exit', onExit);
      this.process.send({ type: 'init', config });
    });
  }
  hold(on) {
    try { if (on) { this.process.ref(); this.process.channel?.ref(); } else { this.process.unref(); this.process.channel?.unref(); } } catch { /* gone */ }
  }
  run(batch) {
    return new Promise(resolve => {
      const child = this.process;
      let done = false;
      const finish = value => { if (done) return; done = true; clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); resolve(value); };
      const onMessage = message => {
        if (message.key !== batch.key) return;
        if (message.type === 'result') finish({ ok: true, result: message.result });
        else if (message.type === 'error') finish({ ok: false, error: message.error });
      };
      const onExit = code => finish({ ok: false, error: 'capture child exited (' + code + '): ' + this.stderr.slice(0, 2000), restart: true });
      const timer = setTimeout(() => { finish({ ok: false, error: 'capture batch ' + batch.key + ' exceeded ' + this.options.timeoutMs + ' ms', timeout: true, restart: true }); try { child.kill(); } catch { /* gone */ } }, this.options.timeoutMs);
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.send({ type: 'batch', batch });
    });
  }
  stop() { try { this.process?.send({ type: 'exit' }); } catch { /* gone */ } setTimeout(() => { try { this.process?.kill(); } catch { /* gone */ } }, 2000).unref(); }
}

export class Pool {
  constructor({ size = defaultPoolSize(), config, tz = 'UTC', timeoutMs = 20000 }) {
    this.size = Math.max(1, size | 0);
    this.options = { config, tz, timeoutMs };
    this.children = [];
    this.stats = { probes: 0, windows: 0, batches: 0, children: this.size, busyMs: 0, openMs: 0 };
  }
  async start() {
    this.children = Array.from({ length: this.size }, (_, index) => new Child(index, this.options));
    const infos = await Promise.all(this.children.map(child => child.start()));
    this.tzInfo = infos[0];
    return this;
  }
  // Runs batches; returns an array of {key, ok, result|error} in key order.
  async run(batches, { warmIdle = null } = {}) {
    const ordered = [...batches].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const queues = this.children.map(() => []);
    for (const batch of ordered) queues[fnv(batch.key) % this.size].push(batch);
    if (warmIdle) queues.forEach((queue, index) => { if (!queue.length) { try { this.children[index].process.send({ type: 'warm', page: warmIdle }); } catch { /* restarted later */ } } });
    const out = new Map();
    const take = index => {
      if (queues[index].length) return queues[index].shift();
      const longest = queues.reduce((best, queue, i) => queue.length > (queues[best]?.length ?? 0) ? i : best, -1);
      return longest >= 0 && queues[longest].length ? queues[longest].pop() : null;
    };
    await Promise.all(queues.map(async (_, index) => {
      for (let batch = take(index); batch; batch = take(index)) {
        const child = this.children[index];
        const answer = await child.run(batch);
        if (answer.restart) { try { await child.start(); } catch (error) { answer.error += '; restart failed: ' + error.message; } }
        out.set(batch.key, { key: batch.key, ...answer });
        this.stats.batches++;
        this.stats.probes += batch.probes.length;
        if (answer.ok) { this.stats.windows += answer.result.windows; this.stats.busyMs += answer.result.ms ?? 0; this.stats.openMs += answer.result.openMs ?? 0; }
      }
    }));
    return ordered.map(batch => out.get(batch.key));
  }
  close() {
    if (this.resident) return;
    for (const child of this.children) child.stop();
  }
  hold(on) { for (const child of this.children) child.hold(on); }
}

// Resident pools (per size and time zone): the facade is long-lived, so the children (node + jsdom, ~1 s to start on
// Windows) are spawned once and re-initialized per capture. Results never depend on residency: every batch opens its
// own window and the configuration is replaced on each capture.
const RESIDENT = new Map();

export async function acquirePool({ size = defaultPoolSize(), tz = 'UTC', timeoutMs = 20000, config, resident = true }) {
  if (!resident) return new Pool({ size, tz, timeoutMs, config }).start();
  // The sandbox read allowlist is fixed when the child is forked (it names this prototype folder), so a resident child
  // can only serve the root it was forked for; the root is part of the key, and a new root gets its own children.
  const key = size + '|' + tz + '|' + (SANDBOX ? path.resolve(config.root) : '');
  let pool = RESIDENT.get(key);
  if (pool && pool.busy) pool = null;
  if (pool) {
    pool.options.timeoutMs = timeoutMs;
    pool.options.config = config;
    pool.hold(true);
    try { await Promise.all(pool.children.map(child => child.reinit(config))); }
    catch { RESIDENT.delete(key); pool.resident = false; pool.close(); pool = null; }
  }
  if (!pool) {
    pool = await new Pool({ size, tz, timeoutMs, config }).start();
    pool.resident = true;
    RESIDENT.set(key, pool);
  }
  pool.busy = true;
  pool.stats = { probes: 0, windows: 0, batches: 0, children: pool.size, busyMs: 0, openMs: 0 };
  return pool;
}

export function releasePool(pool) {
  if (!pool) return;
  if (!pool.resident) { pool.close(); return; }
  pool.busy = false;
  pool.hold(false);
}

export function closeResidentPools() {
  for (const pool of RESIDENT.values()) { pool.resident = false; pool.close(); }
  RESIDENT.clear();
}
