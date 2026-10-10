// The server side of the agent file mirror (docs/FASE2-AGENTE.md 4.5, 6.1, 6.2). The customer workspace on this
// server (<ws> = .local/server/customers/<tokenId>) and the agent root on the customer machine share one layout:
// <ws>/<rel> <-> agent:<rel>, with <rel> under odc/, o11/ or inbox/. Files travel by sha256 through the AgentLink
// (putFile + file.put one way; file.list + file.get + receiveBlob the other); an OML never passes through the LLM.
//   - fromAgent is the ONLY door for a path that came from the agent: a modified agent never reads or writes outside
//     the visible area of its own customer's workspace (state/, .local/server/tokens.json, another customer).
//   - Inputs (files a bridge only reads) keep their <rel> inside a prefix the agent may write; elsewhere in the
//     workspace they are copied to <ws>/<lane>/journal/staging/<sha256><ext> first. Outputs must already be in such a
//     prefix. Server copies go to the agent by sha256 and never replace a file the bridge wrote there.
//   - Quota: 5 GiB per workspace, measured by a walk kept 60 s plus the bytes received since.
//   - C14 (servidor/fase4): the files of one command go in ONE file.sync call when the agent runs it (agent 0.2.0+; else
//     one file.put each, as before); a transfer the agent answers skipped is released at once; an agent folder comes back
//     by up to PULL_PARALLEL file.get at a time, and the caller may leave out evidence nobody reads on success.
export const PULL_PARALLEL = 4;
export const SYNC_MAX_FILES = 256;
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const VISIBLE = Object.freeze(['odc', 'o11', 'inbox']);
export const WRITABLE = Object.freeze(['odc/snapshots/', 'odc/journal/', 'odc/lab/', 'o11/']);
// What the agent may name at all (its readable folders, agent/lib/workspace.mjs READABLE): the rest of the visible
// area (odc/tenants.json, odc/tmp/, ...) is the server's, and a path there never comes from the real agent.
export const AGENT_READABLE = Object.freeze([...WRITABLE, 'inbox/']);
export const agentReadable = segments => { const rel = segments.join('/').toLowerCase() + '/'; return AGENT_READABLE.some(prefix => rel.startsWith(prefix)); };
export const QUOTA_BYTES = 5 * 1024 ** 3;
const FILE_TIMEOUT_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 120 * 1000;

// A refusal of the mirror. sent:false = nothing reached the agent for the command being staged.
export class MirrorError extends Error {
  constructor(code, message, { sent = false } = {}) { super(message); this.name = 'MirrorError'; this.code = code; this.sent = sent; }
}

const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const shown = value => JSON.stringify(String(value).slice(0, 200));

// The segments of an agent:<rel> value with the agent's own normalization (6.2), or why it is refused. Never touches
// the disk: callers that act on the answer confine it with insideVisible (fromAgent does both).
export function agentSegments(value) {
  if (typeof value !== 'string' || !value.startsWith('agent:')) return { error: 'not an agent: path' };
  const rel = value.slice('agent:'.length);
  if (!rel) return { error: 'empty path' };
  // ':' covers drive letters and alternate data streams; control characters include NUL.
  if (/[\x00-\x1f<>"|?*:]/.test(rel)) return { error: 'forbidden character' };
  if (/^[\\/]/.test(rel)) return { error: 'absolute or UNC path' };
  const segments = rel.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === '') return { error: 'empty segment' };
    if (segment === '.' || segment === '..') return { error: 'dot segment' };
    if (/[. ]$/.test(segment)) return { error: 'segment ending in a dot or space' };
    if (DEVICE.test(segment)) return { error: 'device name' };
  }
  if (!VISIBLE.includes(segments[0])) return { error: 'outside odc/, o11/ and inbox/' };
  return { segments, rel: segments.join('/') };
}

const within = (base, target) => { const rel = path.relative(base, target); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const firstSegment = rel => rel.split(/[\\/]/)[0].toLowerCase();
function nearestReal(target) {
  let probe = target;
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  return fs.realpathSync.native(probe);
}

// True when abs is inside odc/, o11/ or inbox/ of the workspace, lexically AND by the real path of its nearest existing
// ancestor (a junction or symbolic link that leads out, or into state/, is refused).
export function insideVisible(workspace, abs) {
  if (typeof abs !== 'string' || !path.isAbsolute(abs)) return false;
  const lexical = path.relative(workspace, path.resolve(abs));
  if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical) || !VISIBLE.includes(firstSegment(lexical))) return false;
  let wsReal, real;
  try { wsReal = fs.realpathSync.native(workspace); real = nearestReal(path.resolve(abs)); } catch { return false; }
  if (!within(wsReal, real)) return false;
  const relReal = path.relative(wsReal, real);
  return relReal === '' || VISIBLE.includes(firstSegment(relReal));
}

// A protocol violation of the agent: link.protocolError (the hub closes the channel with protocol-error), then the
// error to throw (an unknown outcome once the command was delivered).
export function violation(link, reason, value) {
  const message = 'The agent sent a path outside its workspace (' + reason + '): ' + shown(value);
  try { link?.protocolError?.(message); } catch { /* the refusal stands */ }
  return new MirrorError('AGENT_PROTOCOL_VIOLATION', message, { sent: true });
}

// <ws>/<rel> for a path that came from the agent, inside the folders the agent may name. A violation reads and writes
// nothing.
export function fromAgent(value, { workspace, link }) {
  const parsed = agentSegments(value);
  if (!parsed.error && !agentReadable(parsed.segments)) parsed.error = 'outside the folders the agent may name';
  const abs = parsed.error ? null : path.join(workspace, ...parsed.segments);
  if (parsed.error || !insideVisible(workspace, abs)) throw violation(link, parsed.error ?? 'escapes the workspace', value);
  return abs;
}

// Where a server path sits: inside the visible area or not, its <rel> with '/', and whether the agent may write there.
export function classify(workspace, abs) {
  if (!insideVisible(workspace, abs)) return { visible: false };
  const [first, ...rest] = path.relative(workspace, path.resolve(abs)).split(path.sep);
  const rel = [first.toLowerCase(), ...rest].join('/'); // odc/, o11/, inbox/ as the agent names them
  const lower = rel.toLowerCase() + '/';
  return { visible: true, rel, writable: WRITABLE.some(prefix => lower.startsWith(prefix)) };
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
async function shaIfFile(file) { return isFile(file) ? sha256File(file) : null; }

function walkSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += walkSize(full);
    else if (entry.isFile()) { try { total += fs.statSync(full).size; } catch { /* gone meanwhile */ } }
  }
  return total;
}

// The workspace quota (6.1): the walk is kept ttlMs and the bytes received after it are added.
export function createQuota(workspace, { limitBytes = QUOTA_BYTES, ttlMs = 60000, now = Date.now } = {}) {
  let walked = null, at = 0, since = 0;
  return {
    limitBytes,
    used() {
      if (walked === null || now() - at >= ttlMs) { walked = walkSize(workspace); at = now(); since = 0; }
      return walked + since;
    },
    add(bytes) { since += Number(bytes) || 0; },
    full(extra = 0) { return this.used() + (Number(extra) || 0) > limitBytes; },
  };
}
export const workspaceFull = quota => new MirrorError('WORKSPACE_FULL',
  'The workspace of this account on the SSAM server is over its quota (' + Math.round(quota.limitBytes / 1024 ** 3) + ' GiB); nothing was copied.');

const listedFiles = dir => {
  const out = [];
  const walk = current => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full); else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
};
const missing = error => error?.code === 'FILE_NOT_FOUND' || error?.code === 'PATH_NOT_FOUND';

// One customer's mirror over its AgentLink. Every method that reaches the agent goes through link.call/putFile/
// receiveBlob; every agent path that comes back goes through fromAgent.
export class Mirror {
  constructor({ workspace, link, quota = createQuota(workspace), log = () => {} }) {
    this.workspace = path.resolve(workspace); this.link = link; this.quota = quota; this.log = log;
  }

  fromAgent(value) { return fromAgent(value, { workspace: this.workspace, link: this.link }); }
  classify(abs) { return classify(this.workspace, abs); }
  agentOf(rel) { return 'agent:' + rel; }

  // An output (a file or folder the bridge writes): agent:<rel> when the agent may write there.
  output(abs) {
    const where = this.classify(abs);
    if (!where.visible) throw new MirrorError('PATH_OUTSIDE_WORKSPACE', 'Path outside the workspace of this account: ' + shown(abs));
    if (!where.writable) throw new MirrorError('PATH_NOT_STAGEABLE', 'The agent cannot write ' + shown('ws:' + where.rel)
      + '; outputs go under ws:odc/snapshots/, ws:odc/journal/, ws:odc/lab/ or ws:o11/.');
    return this.agentOf(where.rel);
  }

  // A server file pushed by sha256 (the agent answers skipped:true without downloading when it already has it; its
  // transfer is released then, never left to expire).
  async put(abs, agentPath, { json } = {}) {
    const blob = await this.link.putFile(abs);
    const reply = await this.link.call('file.put', { path: agentPath, blob, ...(json ? { json } : {}) }, { timeoutMs: FILE_TIMEOUT_MS });
    if (reply?.skipped === true) this.link.releaseTransfer?.(blob);
    return reply;
  }

  // Several server files to the agent: [{source, target, json?, ifMissing?}]. One file.sync call per SYNC_MAX_FILES when the
  // agent runs it, else one file.put each (ifMissing then lists the target's folder first, as pushMissing did). A file the
  // agent refused fails the whole staging: MirrorError with its code (nothing of the command was sent yet).
  async putMany(entries) {
    const list = []; const seen = new Set();
    for (const entry of entries ?? []) { const id = String(entry.target).toLowerCase(); if (!seen.has(id)) { seen.add(id); list.push(entry); } }
    if (!list.length) return [];
    if (this.link.supports?.('file.sync') !== true) {
      const out = [];
      for (const entry of list) {
        if (entry.ifMissing && await this.agentHas(entry.target)) { out.push({ path: entry.target, skipped: true, present: true }); continue; }
        out.push(await this.put(entry.source, entry.target, entry.json ? { json: entry.json } : {}));
      }
      return out;
    }
    const out = [];
    for (let at = 0; at < list.length; at += SYNC_MAX_FILES) {
      const chunk = list.slice(at, at + SYNC_MAX_FILES);
      const files = [];
      for (const entry of chunk) files.push({ path: entry.target, blob: await this.link.putFile(entry.source), ...(entry.json ? { json: entry.json } : {}), ...(entry.ifMissing ? { ifMissing: true } : {}) });
      const reply = await this.link.call('file.sync', { files }, { timeoutMs: FILE_TIMEOUT_MS });
      const results = Array.isArray(reply?.results) ? reply.results : [];
      files.forEach((file, i) => { if (results[i]?.skipped === true || results[i]?.error) this.link.releaseTransfer?.(file.blob); });
      const failed = results.find(r => r?.error);
      if (failed) throw new MirrorError(failed.error.code ?? 'AGENT_ERROR', 'The agent refused ' + shown(failed.path) + ': ' + String(failed.error.message ?? '').slice(0, 300), { sent: true });
      if (results.length !== files.length) throw new MirrorError('AGENT_PROTOCOL_VIOLATION', 'file.sync answered ' + results.length + ' results for ' + files.length + ' files', { sent: true });
      out.push(...results);
    }
    return out;
  }
  // The agent has a file at agentPath (one file.list of its folder, used only without file.sync).
  async agentHas(agentPath) {
    const folder = agentPath.slice(0, agentPath.lastIndexOf('/'));
    const wanted = path.resolve(this.fromAgent(agentPath)).toLowerCase();
    return (await this.list(folder)).some(entry => path.resolve(entry.abs).toLowerCase() === wanted);
  }

  // The staged copy of a workspace file: <ws>/<lane>/journal/staging/<sha256><ext> (written once, content-named).
  async stage(abs, lane) {
    const sha = await sha256File(abs);
    const target = path.join(this.workspace, lane, 'journal', 'staging', sha + path.extname(abs).toLowerCase());
    if (!isFile(target)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(abs, target); }
    return target;
  }

  // The plan of an input, nothing sent: {target, puts: [{source, target}]} (the .oml's .json sibling included).
  async inputPlan(abs, lane, { to = null, stageAlways = false } = {}) {
    const where = this.classify(abs);
    if (!where.visible) throw new MirrorError('PATH_OUTSIDE_WORKSPACE', 'Path outside the workspace of this account: ' + shown(abs));
    if (!isFile(abs)) {
      // A file the server does not have may still be on the agent (the bridge wrote it): passed on as it is.
      if (where.writable && !to && !stageAlways) return { target: this.agentOf(where.rel), puts: [] };
      throw new MirrorError('FILE_NOT_FOUND', 'File not found in the workspace: ' + shown('ws:' + where.rel));
    }
    let source = abs, target;
    if (to) target = to;
    else if (where.writable && !stageAlways) target = this.agentOf(where.rel);
    else { source = await this.stage(abs, lane); target = this.agentOf(this.classify(source).rel); }
    const puts = [{ source, target }];
    if (/\.oml$/i.test(abs) && isFile(abs + '.json')) puts.push({ source: abs + '.json', target: target + '.json' });
    return { target, puts };
  }

  // An input (a file the bridge only reads), 4.5 rule 2. `to` forces the agent destination (request folders). An .oml
  // takes its .json sibling along when the server has one. Returns the agent path to put in the command.
  async input(abs, lane, { to = null, stageAlways = false } = {}) {
    const plan = await this.inputPlan(abs, lane, { to, stageAlways });
    await this.putMany(plan.puts);
    return plan.target;
  }

  // Receives one blob into a confined destination, within the quota.
  async receive(ref, dest) {
    if (this.quota.full(ref?.size)) throw workspaceFull(this.quota);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const got = await this.link.receiveBlob(ref, dest);
    this.quota.add(got?.size ?? ref?.size);
    return got;
  }

  // One agent file to the server, unless the server already has the same sha256. `transform(temp)` runs on a received
  // copy before it replaces the destination (manifest paths); a throw there leaves the destination untouched.
  async pull(agentPath, { sha256 = null, json = null, transform = null } = {}) {
    const dest = this.fromAgent(agentPath);
    if (sha256 && (await shaIfFile(dest)) === String(sha256).toLowerCase()) return { path: dest, skipped: true };
    const got = await this.link.call('file.get', { path: agentPath, ...(json ? { json } : {}) }, { timeoutMs: FILE_TIMEOUT_MS });
    if (got?.path !== undefined) this.fromAgent(got.path);
    if (!got?.blob) throw new MirrorError('AGENT_PROTOCOL_VIOLATION', 'file.get answered without a blob for ' + shown(agentPath), { sent: true });
    if (!transform) { await this.receive(got.blob, dest); return { path: dest, skipped: false }; }
    const temp = dest + '.pull-' + randomUUID().slice(0, 8);
    try {
      await this.receive(got.blob, temp);
      const keep = await transform(temp, dest);
      if (keep === false) return { path: dest, skipped: true };
      fs.renameSync(temp, dest);
      return { path: dest, skipped: false };
    } finally { try { fs.rmSync(temp, { force: true }); } catch { /* already renamed */ } }
  }

  // The recursive listing of an agent folder, every entry confined (and inside that folder) before anything is used.
  async list(agentDir) {
    let listing;
    try { listing = await this.link.call('file.list', { path: agentDir, max: 2000 }, { timeoutMs: LIST_TIMEOUT_MS }); }
    catch (error) { if (missing(error)) return []; throw error; }
    const base = this.fromAgent(agentDir);
    return (listing?.entries ?? []).map(entry => {
      const abs = this.fromAgent(entry?.path);
      if (abs === base || !within(base, abs)) throw violation(this.link, 'a listed entry outside ' + agentDir, entry.path);
      return { agentPath: entry.path, abs, sha256: String(entry.sha256 ?? '').toLowerCase(), size: entry.size };
    });
  }

  // Agent -> server: every file of an agent folder whose sha256 differs on the server, PULL_PARALLEL at a time.
  // `options(entry)` gives per-file pull options (the manifest takes json:"agent-paths"); `skip(entry)` true leaves a file
  // on the agent (evidence nobody reads on success; a later read of it brings it on demand). Returns the listed agent paths
  // (now in sync, the skipped ones excluded), the pulled files and the skipped agent paths.
  async pullDir(agentDir, options = () => ({}), { skip = () => false } = {}) {
    const entries = await this.list(agentDir);
    const pulled = [], skipped = [], todo = [];
    for (const entry of entries) {
      if (skip(entry)) { skipped.push(entry.agentPath); continue; }
      if ((await shaIfFile(entry.abs)) === entry.sha256) continue;
      todo.push(entry);
    }
    let next = 0;
    const worker = async () => { for (let i = next++; i < todo.length; i = next++) { const result = await this.pull(todo[i].agentPath, options(todo[i])); if (!result.skipped) pulled.push(result.path); } };
    await Promise.all(Array.from({ length: Math.min(PULL_PARALLEL, todo.length) }, worker));
    return { listed: entries.filter(entry => !skipped.includes(entry.agentPath)).map(entry => entry.agentPath), pulled, skipped };
  }

  // Server -> agent: the files of a server folder that the agent does not have at all (never a replacement: a receipt
  // the bridge wrote there stays as the bridge wrote it). `except` lists server files already sent by sha256.
  // The plan of pushMissing, nothing sent: [{source, target, ifMissing:true}] (file.sync keeps what the agent has).
  missingPlan(dir, except = new Set()) {
    const where = this.classify(dir);
    if (!where.visible || !where.writable || !fs.existsSync(dir)) return [];
    return listedFiles(dir).filter(file => !except.has(path.resolve(file).toLowerCase()) && !/\.pull-[0-9a-f]{8}$/.test(file))
      .map(file => ({ source: file, target: this.agentOf(this.classify(file).rel), ifMissing: true }));
  }
  async pushMissing(dir, except = new Set()) {
    if (this.link.supports?.('file.sync') === true) return (await this.putMany(this.missingPlan(dir, except))).filter(r => r && !r.skipped).map(r => this.fromAgent(r.path));
    const where = this.classify(dir);
    if (!where.visible || !where.writable || !fs.existsSync(dir)) return [];
    const agentDir = this.agentOf(where.rel);
    const present = new Set((await this.list(agentDir)).map(entry => path.resolve(entry.abs).toLowerCase()));
    const pushed = [];
    for (const file of listedFiles(dir)) {
      const key = path.resolve(file).toLowerCase();
      if (present.has(key) || except.has(key) || /\.pull-[0-9a-f]{8}$/.test(file)) continue;
      await this.put(file, this.agentOf(this.classify(file).rel));
      pushed.push(file);
    }
    return pushed;
  }
}
