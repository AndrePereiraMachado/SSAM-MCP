// The closed list of what the server may ask of this machine (docs/FASE2-AGENTE.md 4.4) and the checks of 4.8. Any
// other kind is refused (KIND_NOT_ALLOWED); the server never sends code, scripts or DLL paths. Every refusal happens
// before anything touches the machine (executed:false).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AgentError, refuse } from './errors.mjs';
import { DOT_SEGMENT, segmentsOf, MANIFEST_PATH_FIELDS } from './workspace.mjs';
import { pipeCall, PipeError } from './odc-pipe.mjs';
import { bridgeRequest, BridgeError } from './o11-wire.mjs';
import { validateRef, fileSha256, TEMP_SUFFIX } from './blobs.mjs';
import { IMAGES } from './studios.mjs';
import { connectO11, selectedO11, readConnection, readBridgeKey } from './o11-connect.mjs';

export const KINDS = Object.freeze(['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected',
  'file.put', 'file.get', 'file.list', 'file.sync']);
// file.sync (C14, fase4): at most this many files per call, at most this many downloads at a time.
export const SYNC_MAX_FILES = 256;
export const SYNC_PARALLEL = 4;
export const ODC_COMMANDS = Object.freeze(['status', 'wait', 'authorize', 'open', 'snapshot', 'latest', 'check-base', 'preview', 'merge',
  'publish', 'publish-status', 'publish-log', 'dismiss-dialog', 'close', 'module-info', 'assets', 'consumers', 'create', 'create-app',
  'templates', 'template-download', 'refresh-references', 'reference-snapshot', 'data', 'data-insert', 'data-update', 'data-delete',
  'portal-call', 'portal-session', 'auth-status', 'stop', 'query-test']);
// The 22 verbs of the thin O11 bridge, in the order of its bridge_manifest (docs/O11-BRIDGE-FINA.md 3.2 and 14):
// refresh_references (the Studio's own Refresh References, no path) since the ninth release; answer_dependencies_dialog (the
// Manage Dependencies dialog answered as Cancel, no path) since servidor/fase4.
export const O11_METHODS = Object.freeze(['ping', 'bridge_manifest', 'get_active_module', 'list_open_modules', 'get_errors', 'open_module',
  'close_module', 'publish', 'windows', 'ui_alive', 'close_dialog', 'snapshot_module', 'merge_from_oml', 'merge_status',
  'environment_session', 'sc_api', 'sc_web', 'studio_login', 'sc_session', 'publish_log', 'refresh_references', 'answer_dependencies_dialog']);
const MANIFEST_COMMANDS = new Set(['check-base', 'preview', 'merge', 'publish', 'publish-status', 'create', 'authorize', 'create-app']);
const LANE_IMAGE = { odc: 'ODCStudio.exe', o11: 'ServiceStudio.exe' };
const STUDIO_NAME = { odc: 'ODC Studio', o11: 'Service Studio' };
const MAX_LIST = 2000;

const invalid = message => refuse('PARAMS_INVALID', message);
const three = version => { const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '')); return match ? match.slice(1, 4).map(Number).join('.') : null; };
export const sameVersion = (a, b) => three(a) !== null && three(a) === three(b);
const pathLike = token => /^[A-Za-z]:/.test(token) || /^[\\/]/.test(token) || DOT_SEGMENT.test(token);

// Path positions of an ODC bridge command (4.5/4.8), as {index: role} over a list of words. Used twice: on the args
// array (each position must be agent:<rel>) and on the words of the final line the bridge splits by spaces itself.
function odcPositions(words) {
  const roles = new Map();
  const command = words[0];
  if (MANIFEST_COMMANDS.has(command) && words.length > 1) roles.set(1, 'write');
  if (command === 'open' && words.length > 2) roles.set(2, 'read');
  if (command === 'portal-call' && words.length > 1) roles.set(1, 'read');
  if (command === 'portal-session' && words[1] === 'fetch' && words.length > 2) roles.set(2, 'read');
  const flag = { 'data-insert': '--records-file', 'data-update': '--records-file', data: '--out' }[command];
  if (flag) words.forEach((word, i) => { if (word === flag && i + 1 < words.length) roles.set(i + 1, command === 'data' ? 'write' : 'read'); });
  return roles;
}

export function createKinds({ root, ws, pack = {}, kernel = () => null, deps = {}, blobs = null, limits = () => ({}), o11Port = 4516,
  onConnection = () => {} }) {
  const lanes = Array.isArray(pack.lanes) ? pack.lanes : [];
  const pids = new Map(); // pid -> {image, version}, from the last listing
  const maxFileBytes = () => limits().maxFileBytes ?? 512 * 1024 * 1024;
  const requireLane = lane => { if (!lanes.includes(lane)) throw refuse('LANE_DISABLED', `The agent pack does not carry the ${lane} lane`); };

  async function listing(image) {
    const processes = [];
    const listed = (await deps.processes(image)) ?? [];
    for (const [pid, entry] of pids) if (entry.image === image) pids.delete(pid);
    for (const p of listed) {
      const pid = Number(p?.pid);
      if (!Number.isSafeInteger(pid) || pid < 1) continue;
      const version = p.version ?? (p.path ? await deps.fileVersion(p.path) : null) ?? null;
      pids.set(pid, { image, version });
      processes.push({ pid, path: p.path ?? null, version });
    }
    return processes;
  }

  // The chosen process must be the lane's Studio and its ProductVersion (first 3 numbers) the server kernel's (4.8).
  async function checkPid(lane, value) {
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid < 1) throw invalid('pid must be a positive integer');
    const image = LANE_IMAGE[lane];
    let known = pids.get(pid);
    if (known?.image !== image) { await listing(image); known = pids.get(pid); }
    if (known?.image !== image) throw refuse('STUDIO_NOT_SELECTED', `No ${image} process ${pid} is running on this machine`);
    const expected = kernel()?.[lane] ?? null;
    if (!expected) throw refuse('STUDIO_VERSION_MISMATCH', `The server reports no kernel for the ${lane} lane`);
    if (!sameVersion(known.version, expected))
      throw refuse('STUDIO_VERSION_MISMATCH', `${STUDIO_NAME[lane]} ${pid} is version ${known.version ?? 'unknown'}; the server kernel is for ${STUDIO_NAME[lane]} ${expected}`);
    return { pid, ...known };
  }

  // ---- odc.pipe: allowlist, positions, every agent: word, the final line, the manifest's own paths, the process.
  function mapOdcArgs(args) {
    let words = args;
    if (words[0] === 'reference-snapshot') {
      let request;
      try { request = JSON.parse(words.slice(1).join(' ')); } catch { throw invalid('reference-snapshot takes one JSON object'); }
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid('reference-snapshot takes one JSON object');
      request.output = bridgePath(request.output, 'write');
      words = ['reference-snapshot', JSON.stringify(request)];
    } else if (words[0] === 'query-test') {
      // The native query test (bridge v45): one JSON request whose source is the capture it reads.
      let request;
      try { request = JSON.parse(words.slice(1).join(' ')); } catch { throw invalid('query-test takes one JSON object'); }
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid('query-test takes one JSON object');
      if (request.source !== undefined && request.source !== null) request.source = bridgePath(request.source, 'read');
      words = ['query-test', JSON.stringify(request)];
    }
    const roles = odcPositions(words);
    return words.map((word, i) => {
      if (roles.has(i)) return bridgePath(word, roles.get(i));
      return word.replace(/(^|\s)(agent:\S*)/g, (match, space, value) => space + ws.resolve(value, 'read'));
    });
  }
  function bridgePath(value, role) {
    if (typeof value !== 'string' || !value.startsWith('agent:')) throw refuse('PATH_NOT_AGENT', `A bridge path position takes agent:<relative path>, not ${JSON.stringify(value ?? null)}`);
    if (/\s/.test(value)) throw refuse('PATH_FORBIDDEN', `A bridge path may not contain spaces (the bridge splits its line by spaces): ${JSON.stringify(value)}`);
    return ws.resolve(value, role);
  }
  // The bridge reads ONE line and splits it by spaces itself, so the array alone proves nothing (4.8): every word that
  // is absolute, UNC or has a '..' segment must be under the agent root in a readable prefix, and the words at path
  // positions of the line (even when hidden inside one argument) must be such paths, writable for outputs.
  function checkFinalLine(args) {
    const words = args.join(' ').split(/\s+/).filter(Boolean);
    const roles = words[0] === 'reference-snapshot' || words[0] === 'query-test' ? new Map() : odcPositions(words);
    words.forEach((word, i) => {
      const role = roles.get(i);
      if (!role && !pathLike(word)) return;
      ws.checkAbsolute(word, role ?? 'read');
    });
  }
  // A manifest names files the bridge reads and a folder it writes: those must be agent paths too (6.2).
  function checkManifestFile(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; } // the bridge answers for a missing manifest
    let manifest;
    try { manifest = JSON.parse(text.replace(/^﻿/, '')); } catch { throw refuse('PATH_FORBIDDEN', 'The manifest is not JSON; the agent only passes manifests whose paths it can check'); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return;
    for (const [key, value] of Object.entries(manifest)) {
      const role = MANIFEST_PATH_FIELDS[key.toLowerCase()];
      if (!role || value === null || value === undefined || value === '') continue;
      if (typeof value !== 'string') throw refuse('PATH_FORBIDDEN', `Manifest field ${key} is not a path`);
      ws.checkAbsolute(value, role);
    }
  }
  // {line, paths}: the reply with its paths under the root as agent:<rel>, and the key paths of those strings.
  function relativizeLine(line) {
    const paths = [];
    try { return { line: JSON.stringify(ws.relativize(JSON.parse(line), paths)), paths }; } catch { return { line, paths: [] }; }
  }

  async function odcPipe({ pid, version, args, connectMs }) {
    requireLane('odc');
    if (!Array.isArray(args) || args.length === 0 || args.some(a => typeof a !== 'string' && typeof a !== 'number')) throw invalid('args must be a non-empty array of strings');
    const texts = args.map(String);
    if (texts.some(a => /[\r\n\0]/.test(a))) throw refuse('COMMAND_NOT_ALLOWED', 'A bridge argument may not contain a line break or NUL');
    if (!ODC_COMMANDS.includes(texts[0]))
      throw refuse('COMMAND_NOT_ALLOWED', texts[0] === 'attach' ? 'attach never goes through odc.pipe; the agent attaches its own bridge (odc.attach)' : `The ODC bridge command ${JSON.stringify(texts[0])} is not allowed on this agent`);
    if (!pack.odcBridge || version !== pack.odcBridge)
      throw refuse('BRIDGE_VERSION_MISMATCH', `The agent pack carries the ODC bridge ${pack.odcBridge ?? '(none)'}; the server asked for ${version}`);
    const mapped = mapOdcArgs(texts);
    checkFinalLine(mapped);
    if (MANIFEST_COMMANDS.has(mapped[0]) && mapped[1]) checkManifestFile(mapped[1]);
    const target = await checkPid('odc', pid);
    const connect = Number.isFinite(Number(connectMs)) ? Math.min(Math.max(Number(connectMs), 1), 120000) : undefined;
    try {
      const line = await pipeCall(target.pid, version, mapped, connect === undefined ? {} : { connectMs: connect });
      return relativizeLine(line);
    } catch (error) {
      if (error instanceof PipeError) throw new AgentError(error.code, error.message, { executed: error.sent ? null : false, sent: error.sent });
      throw error;
    }
  }

  async function odcAttach({ pid }) {
    requireLane('odc');
    const target = await checkPid('odc', pid);
    const version = pack.odcBridge;
    if (!/^v\d+$/.test(version ?? '')) throw refuse('BRIDGE_VERSION_MISMATCH', 'The agent pack carries no ODC bridge');
    const client = path.join(root, 'odc', 'studio', 'bridge', 'client', 'bin', 'Release', 'net10.0', 'ODC3.Bridge.Client.dll');
    const bridge = path.join(root, 'odc', 'studio', 'bridge', 'bin', 'Release', 'net8.0', 'ODC3.Bridge.' + version + '.dll');
    for (const file of [client, bridge]) if (!fs.existsSync(file)) throw refuse('ATTACH_FAILED', 'The agent pack is missing ' + path.relative(root, file));
    const result = await deps.attachOdc({ pid: target.pid, client, bridge });
    return { ok: result?.ok === true, attached: result?.attached === true, pid: target.pid, version, note: result?.note ?? result?.error ?? null };
  }

  // ---- o11.bridge: allowlist, positions, the local key and the port of this agent's own connection record.
  function mapO11Params(method, params) {
    const p = structuredClone(params ?? {});
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw invalid('params must be an object');
    // Non-agent values (absolute included) -> PATH_NOT_AGENT. O11 outputs stay in o11/ (4.6: agent:o11/<rel>).
    const at = (value, role) => {
      const file = ws.resolve(value, role);
      if (role === 'write' && !/^o11[\\/]/i.test(value.slice('agent:'.length)))
        throw refuse('PATH_FORBIDDEN', `An O11 bridge output goes under agent:o11/, not ${JSON.stringify(value)}`);
      return file;
    };
    if (method === 'snapshot_module') p.path = at(p.path, 'write');
    if (method === 'merge_from_oml') {
      p.foreign_path = at(p.foreign_path, 'read');
      if (p.base_path !== undefined && p.base_path !== null) p.base_path = at(p.base_path, 'read');
      // The merge order's first-pass copy, read like the candidate (two native merges in one call).
      if (p.first_pass_path !== undefined && p.first_pass_path !== null) p.first_pass_path = at(p.first_pass_path, 'read');
    }
    if (method === 'environment_session' && p.operation === 'download') {
      if (!p.arguments || typeof p.arguments !== 'object') throw refuse('PATH_NOT_AGENT', 'environment_session download takes arguments.outputDirectory as agent:o11/<folder>');
      p.arguments.outputDirectory = at(p.arguments.outputDirectory, 'write');
    }
    if (method === 'sc_api' || method === 'sc_web') {
      const args = p.args;
      if (args && typeof args === 'object' && args.outFile !== undefined && args.outFile !== null)
        throw refuse('PATH_FORBIDDEN', `${method} args.outFile is never accepted by the agent; results come back in the reply`);
      if (method === 'sc_api' && args && typeof args === 'object' && args.file !== undefined && args.file !== null) args.file = at(args.file, 'read');
    }
    return p;
  }

  async function o11Bridge({ method, params, timeoutMs }) {
    requireLane('o11');
    if (!O11_METHODS.includes(method)) throw refuse('METHOD_NOT_ALLOWED', `The O11 bridge method ${JSON.stringify(method ?? null)} is not allowed on this agent`);
    const mapped = mapO11Params(method, params);
    const record = readConnection(root);
    if (!record) throw refuse('O11_NOT_CONNECTED', 'No Service Studio is connected on this agent (o11.connect first)');
    const key = readBridgeKey(root);
    if (!key) throw refuse('O11_NOT_CONNECTED', 'The bridge key of this agent is missing; connect the Service Studio again');
    const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 3600000) : undefined;
    try {
      // Any port or authorization the server sent is ignored: the port is this agent's record, the key its own.
      const reply = await bridgeRequest({ port: record.port, authorization: key }, method, mapped, limit === undefined ? {} : { timeoutMs: limit });
      const paths = [];
      return { reply: ws.relativize(reply, paths), paths };
    } catch (error) {
      if (error instanceof BridgeError) throw new AgentError(error.code, error.message, { executed: error.executed === false ? false : null });
      throw error;
    }
  }

  async function o11ConnectKind({ pid }) {
    requireLane('o11');
    const processes = await listing(LANE_IMAGE.o11);
    const candidates = pid === undefined || pid === null ? processes : processes.filter(p => p.pid === Number(pid));
    if (candidates.length === 0) throw refuse('STUDIO_NOT_SELECTED', 'No matching Service Studio is open. Open it normally, then connect.');
    if (candidates.length > 1) throw refuse('STUDIO_NOT_SELECTED', 'Several Service Studios are open (' + candidates.map(p => p.pid).join(', ') + '); select one with pid.');
    const target = await checkPid('o11', candidates[0].pid);
    if (pack.o11BuiltFor && !sameVersion(target.version, pack.o11BuiltFor))
      throw refuse('STUDIO_VERSION_MISMATCH', `Service Studio ${target.pid} is version ${target.version ?? 'unknown'}; the agent pack bridge is built for ${pack.o11BuiltFor}`);
    // pack.json decides the hook (o11Hook "h1": the signed release layout) and the bridge file of the version handshake.
    const record = await connectO11({ root, pid: target.pid, port: o11Port, studioVersion: target.version, describe: deps.describe,
      attach: deps.attachO11, sleep: deps.sleep, now: deps.now, pack, ...(deps.env ? { env: deps.env } : {}) });
    onConnection(record);
    return record;
  }

  async function o11Selected() {
    requireLane('o11');
    return selectedO11({ root, describe: deps.describe });
  }

  // ---- file.*: only inside the agent's own folders (6.2).
  async function filePut({ path: target, blob, json }) {
    const file = ws.resolve(target, 'write');
    if (json !== undefined && json !== null && json !== 'agent-paths') throw invalid('json must be "agent-paths" when present');
    validateRef(blob, { ...limits(), maxFileBytes: maxFileBytes() });
    if (!blobs) throw refuse('BLOB_TRANSFER_FAILED', 'No channel for files');
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw refuse('PATH_FORBIDDEN', `${target} is a folder`);
    if (!json && stat && stat.size === blob.size && await fileSha256(file) === blob.sha256) return { path: target, sha256: blob.sha256, size: blob.size, skipped: true };
    if (!json) { await blobs.download(blob, file); return { path: target, sha256: blob.sha256, size: blob.size, skipped: false }; }
    const temporary = path.join(root, 'private', 'tmp', randomBytes(8).toString('hex') + '.json');
    try {
      await blobs.download(blob, temporary);
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(temporary, 'utf8').replace(/^﻿/, '')); } catch { throw invalid('json:"agent-paths" needs a JSON file'); }
      ws.agentPathsIn(manifest);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const staged = file + '.' + randomBytes(6).toString('hex') + TEMP_SUFFIX;
      fs.writeFileSync(staged, JSON.stringify(manifest, null, 2));
      fs.renameSync(staged, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return { path: target, sha256: blob.sha256, size: blob.size, skipped: false };
  }

  // file.sync (C14, fase4): the file.put of several files in ONE call (the ~20 sequential round trips of a merge's staging
  // become one). files: [{path, blob, json?, ifMissing?}]; each entry answers as file.put does ({path, sha256, size,
  // skipped}) or with its own error ({path, error: {code, message}}), so one refused file never hides the others.
  // ifMissing:true keeps a file the agent already has, whatever its content (a receipt the bridge wrote there). Up to
  // SYNC_PARALLEL downloads at a time; a path named twice is refused before anything is written.
  async function fileSync({ files }) {
    if (!Array.isArray(files) || files.length === 0 || files.length > SYNC_MAX_FILES) throw invalid('files must be a non-empty array of at most ' + SYNC_MAX_FILES + ' entries');
    const seen = new Set();
    for (const entry of files) {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') throw invalid('each file is {path, blob, json?, ifMissing?}');
      const key = entry.path.toLowerCase().replace(/\\/g, '/');
      if (seen.has(key)) throw invalid('the path ' + JSON.stringify(entry.path) + ' is named twice');
      seen.add(key);
    }
    const results = new Array(files.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < files.length; i = next++) {
        const entry = files[i];
        try {
          if (entry.ifMissing === true && fs.existsSync(ws.resolve(entry.path, 'write'))) { results[i] = { path: entry.path, skipped: true, present: true }; continue; }
          results[i] = await filePut({ path: entry.path, blob: entry.blob, json: entry.json });
        } catch (error) {
          results[i] = { path: entry.path, error: { code: typeof error?.code === 'string' ? error.code : 'AGENT_ERROR', message: String(error?.message ?? error).slice(0, 400) } };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SYNC_PARALLEL, files.length) }, worker));
    return { results };
  }

  async function fileGet({ path: target, json }) {
    const file = ws.resolve(target, 'read');
    if (json !== undefined && json !== null && json !== 'agent-paths') throw invalid('json must be "agent-paths" when present');
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw refuse('FILE_NOT_FOUND', `${target} is not a file on the agent`);
    if (stat.size > maxFileBytes()) throw refuse('FILE_TOO_LARGE', `${target} has ${stat.size} bytes, above ${maxFileBytes()}`);
    if (!blobs) throw refuse('BLOB_TRANSFER_FAILED', 'No channel for files');
    if (!json) return { path: target, blob: await blobs.upload(file) };
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { throw invalid(`${target} is not JSON`); }
    ws.agentPathsOut(manifest);
    return { path: target, blob: await blobs.upload(Buffer.from(JSON.stringify(manifest, null, 2))) };
  }

  async function fileList({ path: target, max }) {
    const folder = ws.resolve(target, 'read');
    const limit = Number.isSafeInteger(max) && max > 0 ? Math.min(max, MAX_LIST) : MAX_LIST;
    const base = 'agent:' + segmentsOf(target.slice('agent:'.length)).join('/');
    const entries = []; let truncated = false;
    const add = async (file, name) => {
      if (entries.length >= limit) { truncated = true; return; }
      const stat = fs.statSync(file);
      entries.push({ path: name, size: stat.size, sha256: await fileSha256(file), mtimeMs: stat.mtimeMs });
    };
    const walk = async (dir, prefix) => {
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const item of items) {
        if (truncated) return;
        // Links and junctions are never followed; names the server could not take back are skipped, as are downloads
        // still in progress.
        if (item.isSymbolicLink() || item.name.endsWith(TEMP_SUFFIX)) continue;
        try { segmentsOf(item.name); } catch { continue; }
        const full = path.join(dir, item.name);
        if (item.isDirectory()) await walk(full, prefix + '/' + item.name);
        else if (item.isFile()) await add(full, prefix + '/' + item.name);
      }
    };
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
    if (stat?.isFile()) await add(folder, base);
    else if (stat?.isDirectory()) await walk(folder, base);
    return { entries, truncated };
  }

  async function studioProcesses({ image }) {
    if (!IMAGES.includes(image)) throw invalid(`image must be one of ${IMAGES.join(', ')}`);
    return { processes: await listing(image) };
  }

  const handlers = { 'studio.processes': studioProcesses, 'odc.pipe': odcPipe, 'odc.attach': odcAttach, 'o11.bridge': o11Bridge,
    'o11.connect': o11ConnectKind, 'o11.selected': o11Selected, 'file.put': filePut, 'file.get': fileGet, 'file.list': fileList, 'file.sync': fileSync };

  return {
    async execute(kind, params) {
      if (typeof kind !== 'string' || !Object.hasOwn(handlers, kind)) throw refuse('KIND_NOT_ALLOWED', `The SSAM agent does not run ${JSON.stringify(kind ?? null)}`);
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object');
      return handlers[kind](params);
    },
    pidVersion: pid => pids.get(Number(pid)) ?? null,
  };
}
