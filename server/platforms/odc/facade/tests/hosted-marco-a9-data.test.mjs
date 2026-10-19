// servidor/fase4-26 a9: CX13 (file loads by reference, both lanes) on the hosted line.
// - every file a tool takes by a files list (o11_data request.files, studio_data_insert/update files) is a path of the
//   customer's workspace, resolved and confined by the gate like any path of hosted/tools.json (ws:, agent:inbox/<file>, a
//   path of the agent's machine): a path of the server or of another customer is PATH_OUTSIDE_WORKSPACE and is never read,
//   and the load reads the customer's copy. Before, files was no pointer: the server read any file the call named;
// - the load's plan, journal, reservations and locks are the customer's (<ws>/o11/data/loads, <ws>/odc/journal/data/loads),
//   never the server's lane folder nor the code root of the ODC lane, which every customer of a hosted server shares;
// - the O11 offline check of a dryRun runs the server's own CLI with --check --no-write-fields (the CX13 data flag of
//   marco-a6, never --dry-run), and no CLI form reaches the customer;
// - an ODC write that fails names its native report in the text of the bridge, a file of the user's machine: the server
//   never opens a path it names outside the customer's workspace (a hosted agent's text could name a server file), and the
//   outcome stays uncertain, as for any report it cannot read;
// - updatePreview.rows[].file is the customer's file as ws:<rel>, never the real folder on the server.
// Fake executor, agent, CLI and Studio data service; no Studio, no process, no socket. Synthetic values only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { o11Lane, anvilRoot } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { createFacadeServer } = await import('../mcp.mjs');
const lib = await import('../lib.mjs');
const { hostedTools } = await import('../hosted/policy.mjs');

const LANE = o11Lane.lane;
const PID = 5150, RELAY = 41561;
const AGENT_ROOT = 'C:\\SSAM-Agent';
const operationId = '7a9a9a9a-1111-2222-3333-444444444444';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-a9d-'));
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
const agent = { connected: () => true, protocolError() {},
  info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', agentRoot: AGENT_ROOT, kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' },
    compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function customer() {
  const tokenId = 'tok_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const workspace = path.join(root, 'customers', tokenId);
  prepareWorkspace(workspace);
  const agentDir = path.join(root, 'agent-' + tokenId);
  fs.mkdirSync(path.join(agentDir, 'inbox'), { recursive: true });
  const executor = new FakeExecutor({ workspace, agentDir, record: { ok: true, lane: 'o11', anvilLane: LANE, pid: PID, startedUtc: '2026-10-19T10:00:00.0000000Z',
    studioVersion: '11.55.92', port: RELAY, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-19T10:00:05.000Z', hosted: true } });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Synthetic ' + tokenId, lanes: ['odc', 'o11'], workspace, agentDir, agent, executor, o11: { lane: LANE }, close: async () => {} };
}
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
// Every read-side file-system call of this process that names a path under one of the folders, while the spy is on.
function fsSpy(folders) {
  const key = p => { const resolved = path.resolve(String(p)); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const watched = folders.map(key);
  const seen = [];
  const note = p => { if (typeof p !== 'string' && !(p instanceof URL)) return; const k = key(p instanceof URL ? p.pathname : p); if (watched.some(w => k === w || k.startsWith(w + path.sep))) seen.push(k); };
  const undo = [];
  const wrap = (holder, name) => {
    const original = holder[name];
    if (typeof original !== 'function') return;
    const wrapped = function (p, ...rest) { note(p); return original.call(this, p, ...rest); };
    Object.assign(wrapped, original);
    holder[name] = wrapped; undo.push(() => { holder[name] = original; });
  };
  for (const name of ['statSync', 'lstatSync', 'readFileSync', 'existsSync', 'openSync', 'createReadStream', 'realpathSync']) wrap(fs, name);
  for (const name of ['stat', 'lstat', 'readFile', 'open', 'realpath']) wrap(fs.promises, name);
  return { seen, off: () => { for (const step of undo.reverse()) step(); } };
}
const listing = dir => { const out = []; const walk = d => { let entries = []; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } }; walk(dir); return out.sort(); };
const said = value => JSON.stringify(value).slice(0, 900);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function assertNothingReal(text, workspace) {
  assert.doesNotMatch(text, new RegExp(escape(JSON.stringify(workspace).slice(1, -1)), 'i'), 'the real workspace path: ' + text.slice(0, 600));
  assert.ok(!text.includes(root.split(path.sep).at(-1)), 'the server folder: ' + text.slice(0, 600));
  assert.doesNotMatch(text, /--(?:no-write-fields|check|schema|request|work|dry-run)\b/, 'a CLI form: ' + text.slice(0, 600));
}

// ---- the O11 lane: o11_data, the fake CLI of data-load-o11.test.mjs (schema, check, read-all and writes)
function o11Cli() {
  const calls = [], rows = [];
  const schema = { module: 'Load_CS', entities: [{ name: 'Item', identifier: 'Id', static: false, attributes: [
    { name: 'Id', type: 'Item Identifier', autoNumber: true }, { name: 'Name', type: 'Text' }, { name: 'Qty', type: 'Integer' }] }] };
  const runAnvil = async args => {
    const request = args.includes('--request') ? JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8')) : null;
    calls.push({ args, request });
    let data;
    if (args.includes('--schema')) data = { ...schema, moduleKey: 'module-load', entities: schema.entities.map(e => ({ ...e, key: 'entity-' + e.name })) };
    else if (args.includes('--check')) data = { ok: true, operations: request.batch.length, records: request.batch.reduce((n, o) => n + o.records.length, 0) };
    else data = { ok: true, results: (request.batch ?? [request]).map(op => (op.operation === 'read-all' ? { ok: true, records: rows.slice(op.offset, op.offset + op.limit), complete: true }
      : { ok: true, ids: (op.records ?? []).map(record => { rows.push({ Id: String(rows.length + 1), ...record }); return String(rows.length); }) })) };
    return { ok: true, envelope: { ok: true, command: 'data', data }, wallMs: 1 };
  };
  return { calls, rows, runAnvil };
}
async function o11Server(context, runAnvil) {
  const server = await runWithExecutor(context, () => createSsamServer({ o11: true, odc: false, deps: { runAnvil, callDeadlineMs: 600000 },
    hosted: { context, session: { agent, lanes: context.lanes } } }));
  const client = new Client({ name: 'hosted-a9-data-o11', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async args => { const r = await client.callTool({ name: 'o11_data', arguments: args }, undefined, { timeout: 600000 });
    return { body: r.structuredContent ?? JSON.parse(r.content[0].text), text: r.content?.[0]?.text ?? '' }; };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

// ---- the ODC lane: studio_data_insert/update through the ODC facade of the hosted server, the Studio data service faked
function odcStudio({ insertError = null } = {}) {
  const seen = [];
  const data = async args => {
    seen.push(args);
    if (args.op === 'read' && args.limit === 1) return { ok: true, tenant: 'synthetic.tenant', identifier: 'Id', moduleKey: 'module-m', entityKey: 'entity-e', attributes: ['Id:Identifier', 'Name:Text', 'Age:Integer'], records: [{ Id: '1', Name: 'existing', Age: '1' }] };
    if (args.op === 'read') return args.offset === 0 ? { ok: true, records: [{ Id: '1', Name: 'existing', Age: '1' }], more: true } : { ok: true, records: [], more: false };
    if (insertError && args.op === 'insert') return { ok: false, error: insertError };
    return { ok: true, reports: args.records.map((r, i) => ({ recordId: r.Id ?? String(2 + i), clientRecordId: r.Id ?? `new-${i + 1}`, status: 'Success' })) };
  };
  return { seen, data };
}
async function odcServer(context, data) {
  const server = await runWithExecutor(context, () => createSsamServer({ o11: false, odc: true,
    deps: { odcFacade: () => createFacadeServer({ env: { ...process.env, SSAM_ODC_OFFLINE: '1' }, deps: { studioData: data } }), callDeadlineMs: 600000 },
    hosted: { context, session: { agent, lanes: context.lanes } } }));
  const client = new Client({ name: 'hosted-a9-data-odc', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    return { body: r.structuredContent ?? JSON.parse(r.content[0].text), text: r.content?.[0]?.text ?? '' }; };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

test('every files list a hosted tool takes is an input path of hosted/tools.json (the family: CX13 o11_data and studio_data_insert/update)', async () => {
  const server = await createSsamServer({});
  const client = new Client({ name: 'hosted-a9-files', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tools = (await client.listTools()).tools;
    const catalog = hostedTools();
    const missing = [];
    const walk = (name, schema, pointer) => {
      if (!schema || typeof schema !== 'object') return;
      for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]) walk(name, branch, pointer);
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        const here = pointer + '/' + key;
        if (key === 'files' && (sub?.type === 'array' || sub?.items)) {
          const entry = catalog[name];
          if (entry?.class !== 'unavailable' && !(entry?.paths?.in ?? []).includes(here + '/*')) missing.push(name + ' ' + here + '/*');
        }
        if (here.split('/').length < 4) walk(name, sub, here);
      }
    };
    for (const tool of tools) walk(tool.name, tool.inputSchema, '');
    assert.ok(tools.some(t => t.name === 'o11_data') && tools.some(t => t.name === 'studio_data_insert'), 'both lanes listed');
    assert.deepEqual([...new Set(missing)].sort(), [], 'a files list the gate does not confine: ' + missing.join(', '));
  } finally { await client.close(); await server.close(); }
});

test('o11_data files: a path outside the workspace is refused and never read; agent:inbox is brought and checked with --check --no-write-fields; nothing in the server lane folder', async () => {
  const A = customer(), other = customer();
  const oml = put(path.join(A.workspace, 'o11', 'snapshots', 'Load_CS.oml'), 'synthetic offline schema fixture');
  const secret = put(path.join(other.workspace, 'inbox', 'secret.csv'), 'Name,Qty\nS,1\n');
  put(path.join(A.agentDir, 'inbox', 'items.csv'), 'Name,Qty\nA,1\nB,2\n');
  const serverData = [path.join(anvilRoot, '.local', 'data'), path.join(anvilRoot, '.local', 'lane-ss5', 'data')];
  const before = serverData.flatMap(listing);
  const cli = o11Cli();
  const s = await o11Server(A, cli.runAnvil);
  try {
    const target = { host: 'dev.example.test', module: 'Load_CS', oml: 'ws:o11/snapshots/Load_CS.oml' };
    const spy = fsSpy([other.workspace]);
    let refused;
    try { refused = await s.call({ ...target, request: { operation: 'insert', entity: 'Item', files: [secret], keys: ['Name'], dryRun: true } }); } finally { spy.off(); }
    assert.equal(refused.body.code, 'PATH_OUTSIDE_WORKSPACE', said(refused.body));
    assert.deepEqual(spy.seen, [], 'the other customer\'s file is never read');
    assert.equal(cli.calls.length, 0, 'nothing ran');
    const checked = await s.call({ ...target, request: { operation: 'insert', entity: 'Item', files: ['agent:inbox/items.csv'], keys: ['Name'], dryRun: true } });
    assert.equal(checked.body.ok, true, said(checked.body));
    assert.equal(checked.body.inserted, 2, said(checked.body));
    assert.deepEqual(A.executor.pulls, ['agent:inbox/items.csv']);
    assert.ok(fs.existsSync(path.join(A.workspace, 'inbox', 'items.csv')), 'the load read the customer\'s copy');
    const check = cli.calls.find(c => c.args.includes('--check'));
    assert.ok(check && check.args.includes('--no-write-fields'), 'the offline check without the write fields: ' + said(cli.calls.map(c => c.args)));
    assert.ok(!cli.calls.some(c => c.args.includes('--dry-run')), 'never the old flag');
    for (const c of cli.calls) {
      for (const flag of ['--request', '--work', '--oml']) {
        const at = c.args.indexOf(flag);
        if (at >= 0) assert.ok(path.resolve(c.args[at + 1]).toLowerCase().startsWith(path.resolve(A.workspace).toLowerCase() + path.sep), flag + ' in the workspace: ' + c.args[at + 1]);
      }
    }
    for (const row of checked.body.rowsPreview ?? []) assert.equal(row.file, 'ws:inbox/items.csv', said(checked.body));
    assert.ok((checked.body.rowsPreview ?? []).length >= 1, said(checked.body));
    assert.match(String(checked.body.rowsPreviewFile), /^ws:o11\/data\/loads\//, 'the preview file is the customer\'s: ' + said(checked.body));
    assertNothingReal(checked.text, A.workspace);
    assert.deepEqual(serverData.flatMap(listing), before, 'nothing in the server\'s own lane data folder');
  } finally { await s.close(); }
});

test('studio_data files: outside the workspace refused; a load\'s journal is the customer\'s; updatePreview.rows[].file is ws:', async () => {
  const A = customer(), B = customer(), other = customer();
  const secret = put(path.join(other.workspace, 'inbox', 'secret.json'), '[{"Name":"s","Age":1}]');
  put(path.join(A.agentDir, 'inbox', 'upsert.json'), '[{"Name":"existing","Age":2},{"Name":"new","Age":3}]');
  const serverLoads = path.join(lib.root, 'journal', 'data');
  const before = listing(serverLoads);
  const studio = odcStudio();
  const s = await odcServer(A, studio.data);
  try {
    const spy = fsSpy([other.workspace]);
    let refused;
    try { refused = await s.call('studio_data_insert', { module: 'M', entity: 'E', files: [secret], keys: ['Name'], dryRun: true }); } finally { spy.off(); }
    assert.equal(refused.body.code, 'PATH_OUTSIDE_WORKSPACE', said(refused.body));
    assert.deepEqual(spy.seen, []); assert.equal(studio.seen.length, 0, 'nothing reached the Studio');
    const args = { module: 'M', entity: 'E', files: ['agent:inbox/upsert.json'], keys: ['Name'], insertMissing: true, operationId, authorize: 'Autorizo' };
    const stop = await s.call('studio_data_update', args);
    assert.equal(stop.body.code, 'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED', said(stop.body));
    assert.equal(studio.seen.filter(a => a.op !== 'read').length, 0, 'the overwrite is previewed before any write');
    const rows = stop.body.updatePreview?.rows ?? [];
    assert.ok(rows.length >= 1, 'the preview names the rows it would overwrite: ' + said(stop.body));
    for (const row of rows) assert.equal(row.file, 'ws:inbox/upsert.json', said(stop.body));
    assertNothingReal(stop.text, A.workspace);
    const loads = listing(path.join(A.workspace, 'odc', 'journal', 'data', 'loads'));
    assert.ok(loads.length > 0, 'the plan and journal of the load are the customer\'s: ' + said(listing(path.join(A.workspace, 'odc'))));
    assert.deepEqual(listing(serverLoads), before, 'nothing in the code root of the ODC lane (every customer shares it)');
    // another customer, the same operationId: its own load, never A's plan
    put(path.join(B.agentDir, 'inbox', 'upsert.json'), '[{"Name":"existing","Age":9}]');
    const sb = await odcServer(B, odcStudio().data);
    try {
      const otherStop = await sb.call('studio_data_update', { ...args, insertMissing: false });
      assert.equal(otherStop.body.code, 'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED', said(otherStop.body));
      assert.equal(otherStop.body.updatePreview.count, 1, said(otherStop.body));
      assert.ok(listing(path.join(B.workspace, 'odc', 'journal', 'data', 'loads')).length > 0);
    } finally { await sb.close(); }
  } finally { await s.close(); }
});

test('an ODC write whose bridge text names a report outside the workspace: the server never opens it; the outcome stays uncertain', async () => {
  const A = customer();
  const canary = put(path.join(root, 'server-files', 'report.json'), JSON.stringify({ count: 1, request: { records: [] } }));
  put(path.join(A.agentDir, 'inbox', 'new.json'), '[{"Name":"fresh","Age":5}]');
  const studio = odcStudio({ insertError: '1 of 1 records failed; the full report is in ' + canary + '. Do not repeat the write.' });
  const s = await odcServer(A, studio.data);
  const spy = fsSpy([path.dirname(canary)]);
  try {
    const answer = await s.call('studio_data_insert', { module: 'M', entity: 'E', files: ['agent:inbox/new.json'], keys: ['Name'], operationId: '7a9a9a9a-5555-2222-3333-444444444444', authorize: 'Autorizo' });
    spy.off();
    assert.deepEqual(spy.seen, [], 'the server never opened the file the bridge text named: ' + said(answer.body));
    assert.equal(studio.seen.filter(a => a.op === 'insert').length, 1, said(answer.body));
    assert.notEqual(answer.body.ok, true, said(answer.body));
    assert.doesNotMatch(answer.text, /does not match the submitted batch/, said(answer.body));
    assertNothingReal(answer.text, A.workspace);
  } finally { spy.off(); await s.close(); }
});

// ---- X3 on the hosted line: autoPatch is listed by the four job tools and reaches the handler as sent (no path, nothing the
// gate rewrites); a repaired job comes back as nextBasedOn (ws:), patchedJob never (review marco-a6 B1, licensee rule).
test('X3 autoPatch hosted: listed by o11_deliver, studio_deliver, ssam_job and o11_job; autoPatch:false reaches the job tool; the repaired job is ws:', async () => {
  const A = customer();
  const corrected = put(path.join(A.workspace, 'o11', 'jobs', 'inline', 'a1.json.patched-job.json'), '{"ops":[]}');
  const seen = [];
  const jobTool = async args => { seen.push(args); return { ok: true, lane: 'o11', accepted: true, job: corrected, nextBasedOn: { job: corrected, sha256: 'b'.repeat(64) },
    patchedJob: { path: corrected, sha256: 'b'.repeat(64), source: { path: corrected + '.source.json', sha256: 'c'.repeat(64) } },
    patchesApplied: [{ code: 'HTML_INVALID', pointer: '/ops/0/data/html', patchRule: 'TEXT_LITERAL_QUOTED', reason: 'quoted', from: 'a', to: '"a"', patchSha256: 'd'.repeat(64) }] }; };
  const server = await runWithExecutor(A, () => createSsamServer({ o11: true, odc: true, deps: { jobTool, callDeadlineMs: 600000 },
    hosted: { context: A, session: { agent, lanes: A.lanes } } }));
  const client = new Client({ name: 'hosted-a9-x3', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job']) {
      const tool = tools.find(t => t.name === name);
      assert.ok(tool, name);
      const props = tool.inputSchema?.properties ?? {};
      const found = props.autoPatch ?? Object.values(props).find(p => p?.properties?.autoPatch)?.properties?.autoPatch;
      assert.equal(found?.type, 'boolean', name + ' lists autoPatch: ' + JSON.stringify(Object.keys(props)));
    }
    const r = await client.callTool({ name: 'ssam_job', arguments: { lane: 'o11', job: { ops: [] }, autoPatch: false } }, undefined, { timeout: 600000 });
    const body = r.structuredContent ?? JSON.parse(r.content[0].text);
    assert.equal(seen.length, 1, said(body)); assert.equal(seen[0].autoPatch, false, 'the opt-out reaches the job tool');
    assert.equal(body.patchedJob, undefined, said(body));
    assert.deepEqual(body.nextBasedOn, { job: 'ws:o11/jobs/inline/a1.json.patched-job.json', sha256: 'b'.repeat(64) }, said(body));
    assert.equal(body.patchesApplied.length, 1, said(body));
    assertNothingReal(r.content[0].text, A.workspace);
  } finally { await client.close(); await server.close(); }
});
