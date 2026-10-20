// The hosted session of the a9 follow-ups, round 2 (review C:\t\revisoes\a9-followups-line\REVISAO.md, B, C and D): a
// customer's workspace and agent folder, a fake executor and agent (connected, or reconnecting by itself), a fake O11 CLI and
// the Studio data service with the exact read shape of the ODC bridge v97, and an MCP client over the hosted server. No
// Studio, process or socket: imported right after isolated-profile.mjs, before anything imports ssam.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  const child = new EventEmitter(); child.stdin = { end() {} }; child.unref = () => {}; child.kill = () => {}; child.pid = 0;
  setImmediate(() => callback?.(new Error('no child process in hosted tests'), '', ''));
  return child;
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));
cp.spawn = () => { throw new Error('spawn is not allowed in hosted tests'); };
net.createConnection = () => { throw new Error('no TCP or pipe connection in hosted tests'); };
syncBuiltinESMExports();

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../../executor.mjs');
const { o11Lane } = await import('../../workspace.mjs');
const { createSsamServer } = await import('../../ssam.mjs');
const { createFacadeServer } = await import('../../mcp.mjs');

const LANE = o11Lane.lane;
const PID = 5150, RELAY = 41579;
export const AGENT_ROOT = 'C:\\SSAM-Agent';
export const MARKER = "<the user's own words>";
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-a9f2-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

class FakeExecutor {
  constructor({ workspace, agentDir, record }) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.workspace = workspace; this.agentDir = agentDir; this.record = record; this.pulls = []; }
  relayPort() { return RELAY; }
  async call(kind) {
    if (kind === 'studio.processes') return { processes: [] };
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  o11Connection() { return this.record; }
  agentFile(agentPath) { return path.join(this.agentDir, ...agentPath.replace(/^agent:/, '').split('/')); }
  async pullFile(agentPath, { ifMissing = false } = {}) {
    const dest = path.join(this.workspace, ...agentPath.replace(/^agent:/, '').split('/'));
    if (ifMissing && fs.existsSync(dest)) return dest;
    if (!fs.existsSync(this.agentFile(agentPath))) throw Object.assign(new Error('no such agent file'), { code: 'FILE_NOT_FOUND' });
    this.pulls.push(agentPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(this.agentFile(agentPath), dest);
    return dest;
  }
  async agentFileSha256(agentPath) { try { return sha(fs.readFileSync(this.agentFile(agentPath))); } catch { return null; } }
  async close() {}
}
const INFO = { credential: true, agentVersion: '0.3.1', agentRoot: AGENT_ROOT, kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' }, compatible: { odc: { ok: true }, o11: { ok: true } } };
export const connectedAgent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, ...INFO }) };
// An agent seen 10 s ago, reconnecting by itself (C03), that does not come back within the gate's wait.
export const reconnectingAgent = { connected: () => false, protocolError() {}, waitConnected: async () => false,
  info: () => ({ connected: false, instance: 'synthetic-instance', lastSeenAt: new Date(Date.now() - 10000).toISOString(), ...INFO }) };
export function customer(agent = connectedAgent) {
  const tokenId = 'tok_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const workspace = path.join(root, 'customers', tokenId);
  prepareWorkspace(workspace);
  const agentDir = path.join(root, 'agent-' + tokenId);
  fs.mkdirSync(path.join(agentDir, 'inbox'), { recursive: true });
  const executor = new FakeExecutor({ workspace, agentDir, record: { ok: true, lane: 'o11', anvilLane: LANE, pid: PID, startedUtc: '2026-10-19T10:00:00.0000000Z',
    studioVersion: '11.55.92', port: RELAY, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-19T10:00:05.000Z', hosted: true } });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Synthetic ' + tokenId, lanes: ['odc', 'o11'], workspace, agentDir, agent, executor, o11: { lane: LANE }, close: async () => {} };
}
export const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
export const said = value => String(JSON.stringify(value)).slice(0, 1500);
export const downloads = name => ['C:', 'Users', 'ana', 'Downloads', name].join('\\');
// Every marker of the owner's words in a step replaced by the words the owner gives now (nothing else added or changed).
export const withWords = (value, words) => (Array.isArray(value) ? value.map(v => withWords(v, words))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withWords(v, words)])) : value === MARKER ? words : value);
// The places of a step that hold the marker, as paths (authorize, request/authorization, confirmUpdates/authorize).
export const markersOf = (value, at = '', out = []) => {
  if (Array.isArray(value)) value.forEach((v, i) => markersOf(v, at + '/' + i, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) markersOf(v, at + '/' + k, out);
  else if (value === MARKER) out.push(at.replace(/^\//, ''));
  return out;
};
export function assertNoWords(answer, words) {
  for (const w of words) {
    assert.ok(!answer.text.includes(w), 'the user\'s words came back in the text: ' + answer.text.slice(0, 1500));
    assert.ok(!JSON.stringify(answer.raw.structuredContent ?? {}).includes(w), 'the user\'s words came back: ' + said(answer.body));
  }
}

// ---- the O11 lane: o11_data over a fake CLI (schema, check, read-all, writes)
export function o11Cli({ indexes = [] } = {}) {
  const calls = [];
  const schema = { module: 'Load_CS', entities: [{ name: 'Item', identifier: 'Id', static: false, indexes, attributes: [
    { name: 'Id', type: 'Item Identifier', autoNumber: true }, { name: 'Name', type: 'Text' }, { name: 'Qty', type: 'Integer' }] }] };
  const runAnvil = async args => {
    const request = args.includes('--request') ? JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8')) : null;
    calls.push({ args, request });
    let data;
    if (args.includes('--schema')) data = { ...schema, moduleKey: 'module-load', entities: schema.entities.map(e => ({ ...e, key: 'entity-' + e.name })) };
    else if (args.includes('--check')) data = { ok: true, operations: request.batch.length, records: request.batch.reduce((n, o) => n + o.records.length, 0) };
    else data = { ok: true, results: (request.batch ?? [request]).map(op => (op.operation === 'read-all' ? { ok: true, records: [], complete: true } : { ok: true, ids: [] })) };
    return { ok: true, envelope: { ok: true, command: 'data', data }, wallMs: 1 };
  };
  const writes = () => calls.filter(c => !c.args.includes('--schema') && !c.args.includes('--check') && (c.request?.batch ?? [c.request]).some(op => op && op.operation !== 'read-all')).length;
  return { calls, runAnvil, writes };
}
// ---- the ODC lane: the Studio data service with the exact read shape of the bridge v97 (no identifier, identifierAutoNumber
// nor indexes; the identifier is the first column of a row)
export function v97Studio({ rows = [] } = {}) {
  const seen = [];
  const db = rows.map(r => ({ ...r }));
  const data = async args => {
    seen.push(args);
    if (args.op === 'read') {
      const offset = args.offset ?? 0, limit = args.limit ?? 100;
      const records = db.slice(offset, offset + limit);
      return { ok: true, module: 'M', entity: 'E', owner: 'own', moduleKey: 'module-m', entityKey: 'entity-e', tenant: 'synthetic.tenant', offset, limit, count: records.length,
        more: offset + records.length < db.length, attributes: ['Id:Long Integer', 'Name:Text', 'Age:Integer'], records, source: 'DataService.GetRecords (development database)' };
    }
    if (args.op === 'insert') {
      const reports = args.records.map((r, i) => { const id = String(100 + db.length); db.push({ Id: id, ...r }); return { recordId: id, clientRecordId: `new-${i + 1}`, status: 'Success' }; });
      return { ok: true, reports };
    }
    return { ok: false, error: 'unexpected op ' + args.op };
  };
  return { seen, db, data, writes: () => seen.filter(a => a.op !== 'read').length };
}
async function connect(server, label) {
  const client = new Client({ name: 'hosted-a9f2-' + label, version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    return { raw: r, body: r.structuredContent ?? JSON.parse(r.content[0].text), text: r.content?.[0]?.text ?? '' }; };
  return { call, close: async () => { await client.close(); await server.close(); } };
}
export const o11Server = async (context, runAnvil) => connect(await runWithExecutor(context, () => createSsamServer({ o11: true, odc: false, deps: { runAnvil, callDeadlineMs: 600000 },
  hosted: { context, session: { agent: context.agent, lanes: context.lanes } } })), 'o11');
// (a9 follow-ups round 3, review a9-followups-2 N1: studio, the fake ODC Studio bridge of the facade's studio_* commands)
export const odcServer = async (context, data, { studio } = {}) => connect(await runWithExecutor(context, () => createSsamServer({ o11: false, odc: true,
  deps: { odcFacade: () => createFacadeServer({ env: { ...process.env, SSAM_ODC_OFFLINE: '1' }, deps: { studioData: data, ...(studio ? { studio } : {}) } }), callDeadlineMs: 600000 },
  hosted: { context, session: { agent: context.agent, lanes: context.lanes } } })), 'odc');
