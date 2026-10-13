// An in-memory AgentLink (docs/FASE2-AGENTE.md I-1) for the hosted tests: never a hub, an agent or a Studio.
//   - call(kind, params): scripted handlers per kind; file.put / file.get / file.list behave like the agent on a
//     temporary agent root (agentRoot/<rel> for agent:<rel>, json:"agent-paths" on the five manifest fields).
//   - putFile / receiveBlob: an in-memory blob store with sha256, as the hub's transfers (atomic write at the destination).
//   - protocolError(message) is recorded; disconnect() makes every call fail with AGENT_NOT_CONNECTED (executed:false).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MANIFEST_FIELDS = ['basePath', 'candidatePath', 'producerPath', 'builderReceipt', 'evidenceDir'];
export const coded = (code, message, { executed = false, delivered = false } = {}) => Object.assign(new Error(message), { code, executed, delivered });
// The key paths an agent reports for a reply it rewrote (agent/lib/workspace.mjs relativize): every agent: string of
// the scripted reply, as if the agent had turned it from an absolute path under its root.
export function agentPaths(value, keys = [], out = []) {
  if (typeof value === 'string') { if (value.startsWith('agent:')) out.push(keys); }
  else if (Array.isArray(value)) value.forEach((item, index) => agentPaths(item, [...keys, index], out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) agentPaths(item, [...keys, key], out);
  return out;
}

// sync: the agent runs file.sync (agent 0.2.0+, C14); the link then says so in supports() and keeps the released transfers.
export function fakeAgentLink({ tokenId = 'tok_test', customer = 'Test', agentRoot, connected = true, info = {}, handlers = {}, sync = false } = {}) {
  const calls = [], protocolErrors = [], puts = [], gets = [], released = [];
  const blobs = new Map();
  const closers = new Set();
  let isConnected = connected;
  let extra = { ...info };
  const abs = agentPath => {
    if (typeof agentPath !== 'string' || !agentPath.startsWith('agent:')) throw coded('PATH_NOT_AGENT', 'not an agent path: ' + agentPath);
    return path.join(agentRoot, ...agentPath.slice(6).split(/[\\/]/));
  };
  const rel = file => 'agent:' + path.relative(agentRoot, file).split(path.sep).join('/');
  const register = bytes => {
    const transfer = randomBytes(16).toString('hex');
    blobs.set(transfer, Buffer.from(bytes));
    return { transfer, sha256: sha256(bytes), size: bytes.length, parts: 1, partBytes: 4194304 };
  };
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []);

  const fileKinds = {
    'file.put': ({ path: target, blob, json }) => {
      const bytes = blobs.get(blob.transfer);
      if (!bytes) throw coded('TRANSFER_INVALID', 'unknown transfer', { delivered: true });
      const file = abs(target);
      let content = bytes;
      if (json === 'agent-paths') {
        const manifest = JSON.parse(bytes.toString('utf8'));
        for (const field of MANIFEST_FIELDS) if (typeof manifest[field] === 'string' && manifest[field]) {
          if (!manifest[field].startsWith('agent:')) throw coded('PATH_FORBIDDEN', field + ' is absolute', { delivered: true });
          manifest[field] = abs(manifest[field]);
        }
        content = Buffer.from(JSON.stringify(manifest, null, 2));
      }
      const skipped = fs.existsSync(file) && sha256(fs.readFileSync(file)) === sha256(content);
      if (!skipped) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
      puts.push({ path: target, skipped, json: json ?? null });
      return { path: target, sha256: sha256(content), size: content.length, skipped };
    },
    'file.get': ({ path: target, json }) => {
      const file = abs(target);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw coded('FILE_NOT_FOUND', 'no such file: ' + target, { delivered: true });
      let bytes = fs.readFileSync(file);
      if (json === 'agent-paths') {
        const manifest = JSON.parse(bytes.toString('utf8'));
        for (const field of MANIFEST_FIELDS) if (typeof manifest[field] === 'string' && manifest[field]) manifest[field] = rel(manifest[field]);
        bytes = Buffer.from(JSON.stringify(manifest, null, 2));
      }
      gets.push({ path: target, json: json ?? null });
      return { path: target, blob: register(bytes) };
    },
    // file.sync (C14): the file.put of each entry, ifMissing keeping a file the agent has; one error per entry.
    'file.sync': ({ files }) => ({ results: files.map(entry => {
      try {
        if (entry.ifMissing && fs.existsSync(abs(entry.path))) return { path: entry.path, skipped: true, present: true };
        return fileKinds['file.put'](entry);
      } catch (error) { return { path: entry.path, error: { code: error.code ?? 'AGENT_ERROR', message: error.message } }; }
    }) }),
    'file.list': ({ path: target }) => {
      const dir = abs(target);
      if (!fs.existsSync(dir)) throw coded('FILE_NOT_FOUND', 'no such folder: ' + target, { delivered: true });
      return { entries: walk(dir).map(f => ({ path: rel(f), size: fs.statSync(f).size, sha256: sha256(fs.readFileSync(f)), mtimeMs: fs.statSync(f).mtimeMs })), truncated: false };
    },
  };

  const link = {
    tokenId, customer, calls, protocolErrors, puts, gets, blobs, agentRoot, released,
    connected: () => isConnected,
    supports: kind => kind !== 'file.sync' || sync,
    releaseTransfer(ref) { released.push(ref?.transfer ?? null); },
    // C03: a test schedules reconnectIn (ms) to make waitConnected see the Hello of a reconnecting agent.
    reconnectIn: null,
    async waitConnected(ms) {
      if (isConnected) return true;
      if (link.reconnectIn == null || link.reconnectIn > ms) { await new Promise(resolve => setTimeout(resolve, Math.min(ms, 50))); return false; }
      await new Promise(resolve => setTimeout(resolve, link.reconnectIn));
      isConnected = true;
      return true;
    },
    disconnect() { isConnected = false; },
    reconnect() { isConnected = true; },
    info: () => ({ connected: isConnected, credential: true, instance: 'fake-instance', agentVersion: '0.1.0', connectedAt: '2026-10-04T18:00:00.000Z',
      lastSeenAt: null, lanes: ['odc', 'o11'], pack: { id: 'pack-test', lanes: ['odc', 'o11'], odcBridge: 'v35', o11BuiltFor: '11.55.91' },
      studios: { odc: { installed: { dir: 'C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio', version: '1.7.28.4021' } },
        o11: { installed: { dir: 'C:\\Program Files\\OutSystems\\Service Studio 11\\Service Studio', version: '11.55.91.65012' } } },
      o11Connection: null, kernel: { o11: '11.55.91', odc: '1.7.28', odcBridge: 'v35' }, compatible: { odc: { ok: true }, o11: { ok: true } }, ...extra }),
    setInfo(patch) { extra = { ...extra, ...patch }; },
    handlers,
    async call(kind, params = {}, options = {}) {
      calls.push({ kind, params: structuredClone(params), options });
      if (!isConnected) throw coded('AGENT_NOT_CONNECTED', 'AGENT_NOT_CONNECTED: no agent channel', { executed: false, delivered: false });
      const handler = handlers[kind] ?? fileKinds[kind];
      if (!handler) throw coded('KIND_NOT_ALLOWED', 'no scripted reply for ' + kind, { executed: false, delivered: true });
      return handler(params, link, options);
    },
    async putFile(file) { return register(fs.readFileSync(file)); },
    async receiveBlob(ref, dest) {
      const bytes = blobs.get(ref?.transfer);
      if (!bytes || sha256(bytes) !== ref.sha256) throw coded('BLOB_HASH_MISMATCH', 'blob does not match', { delivered: true });
      const temp = dest + '.part-' + randomBytes(4).toString('hex');
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, dest);
      return { sha256: ref.sha256, size: bytes.length };
    },
    protocolError(message) { protocolErrors.push(message); },
    onClose(fn) { closers.add(fn); return () => closers.delete(fn); },
    close(reason = 'revoked') { for (const fn of [...closers]) fn(reason); },
    // Agent disk helpers for the tests.
    agentFile: agentPath => abs(agentPath),
    writeAgent(agentPath, content) { const file = abs(agentPath); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; },
    readAgent: agentPath => fs.readFileSync(abs(agentPath), 'utf8'),
  };
  return link;
}

// A temporary customer workspace (the layout of 6.1) and agent root, under the test's own temp folder; removed by
// cleanupHostedDirs (test.after).
const created = [];
export function cleanupHostedDirs() { for (const root of created.splice(0)) fs.rmSync(root, { recursive: true, force: true }); }
export function hostedDirs(base) {
  const root = fs.mkdtempSync(path.join(base, 'hosted-'));
  created.push(root);
  const workspace = path.join(root, 'server', 'customers', 'tok_test');
  for (const dir of ['odc', 'o11', 'inbox', 'state/relay-authority', '.local']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  const agentRoot = path.join(root, 'agent');
  for (const dir of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private']) fs.mkdirSync(path.join(agentRoot, dir), { recursive: true });
  return { root, workspace, agentRoot };
}
