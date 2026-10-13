// The acceptance of phase 2 (docs/FASE2-AGENTE.md 10.7): the real hosted server (runServed, hub, AgentExecutor, gate)
// on a 7400-7499 port with a temporary SSAM_SERVER_DIR, a token with its agent credential, the real agent in this
// process with fake Studios (a fake ODC bridge pipe, a fake O11 bridge, injected processes and versions), and an MCP
// client over HTTP. It skips until the four lanes are merged (agent-hub.mjs, executor.mjs, hosted/agent-executor.mjs and
// agent/ssam-agent.mjs all present). Never a real Studio: the pipe and the bridge are fakes with unlikely pids.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ODC_BRIDGE } from './fixtures/odc-bridge-version.mjs';

const facade = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repo = path.resolve(facade, '..', '..', '..');
const required = [path.join(facade, 'agent-hub.mjs'), path.join(facade, 'executor.mjs'), path.join(facade, 'hosted', 'agent-executor.mjs'), path.join(repo, 'agent', 'ssam-agent.mjs')];
const missing = required.filter(file => !fs.existsSync(file));
const skip = missing.length ? 'waiting for the other lanes: ' + missing.map(f => path.relative(repo, f)).join(', ') : false;

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(50); } return null; };
const textOf = result => JSON.stringify(result);

// A fingerprint of a folder (relative path -> size and mtime), to prove nothing was written there.
function fingerprint(dir, skipTop = new Set()) {
  const out = {};
  const walk = (current, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (depth === 0 && skipTop.has(entry.name)) continue;
      if (entry.isDirectory()) walk(full, depth + 1);
      else { try { const s = fs.statSync(full); out[path.relative(dir, full)] = s.size + ':' + s.mtimeMs; } catch { /* gone */ } }
    }
  };
  walk(dir, 0);
  return out;
}

// A fake ODC bridge on \\.\pipe\ODC3-Bridge-<ODC_BRIDGE>-<pid> (an unlikely pid, never a Studio's). handler(line) -> reply object.
async function fakeOdcPipe(pid, handler) {
  const seen = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk.toString('utf8'); const i = buffer.indexOf('\n'); if (i < 0) return;
      const line = buffer.slice(0, i); seen.push(line);
      socket.write(JSON.stringify(await handler(line)) + '\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(`\\\\.\\pipe\\ODC3-Bridge-${ODC_BRIDGE}-${pid}`, resolve));
  return { seen, close: () => new Promise(resolve => server.close(resolve)) };
}

async function freePort() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = 7400 + Math.floor(Math.random() * 100);
    const free = await new Promise(resolve => { const s = net.createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
    if (free) return port;
  }
  throw new Error('no free port in 7400-7499');
}

test('hosted end to end: agent, ws: paths, O11 relay, refusals, protocol violation, revoke, and no write outside the workspace', { skip, timeout: 240000 }, async t => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { fakeBridge } = await import('./fixtures/fake-o11-bridge.mjs');
  const { frictionTool } = await import(pathToFileURL(path.join(repo, 'facade', 'friction-boundary.mjs')).href);
  const ssam = await import('../ssam.mjs');
  const { createTokenStore } = await import('../server-tokens.mjs');
  const { createAgent } = await import(pathToFileURL(path.join(repo, 'agent', 'ssam-agent.mjs')).href);

  // The stdio tool list, before the served process default becomes the DenyExecutor.
  const stdio = await ssam.createSsamServer(ssam.servedLanes());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const local = new Client({ name: 'e2e-stdio', version: '1' });
  await Promise.all([stdio.connect(a), local.connect(b)]);
  const stdioNames = [...(await local.listTools()).tools.map(x => x.name), frictionTool.name].sort();
  await local.close(); await stdio.close();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-e2e-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'server');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify({ o11: '11.55.91', odc: '1.7.28', odcBridge: ODC_BRIDGE }));
  const odcRoot = path.join(facade, '..');
  const stamp = file => { try { const s = fs.statSync(file); return s.size + ':' + s.mtimeMs; } catch { return null; } };
  // In a parallel `node --test` run other test files write their own scratch into the repository's data folders
  // (journal/inspect, .local/reader-tests, .local/discovery, .local/debugger, kernel readers), so the guard has two
  // parts: what only a misrouted hosted write would touch is compared whole (the owner's tenants.json, the O11
  // connection records, this process's profile), and the shared folders are searched for this run's unique module name
  // (a capture or a journal line of this test that landed outside the workspace). The process end to end
  // (hosted-e2e-processes.mjs) runs alone and compares the whole folders.
  const moduleName = 'E2eOrders' + randomBytes(4).toString('hex');
  const guarded = {
    tenants: () => stamp(path.join(odcRoot, 'tenants.json')),
    connections: () => fingerprint(path.join(repo, 'kernel', '.local', 'connections')),
    profile: () => fingerprint(path.join(os.homedir(), '.ssam-hybrid')),
  };
  const startedAt = Date.now();
  const names = file => {
    if (file.includes(moduleName)) return true;
    try { const s = fs.statSync(file); return s.mtimeMs >= startedAt && s.size < 8 * 1024 * 1024 && /\.(json|jsonl|log)$/i.test(file) && fs.readFileSync(file, 'utf8').includes(moduleName); }
    catch { return false; }
  };
  const leaked = () => [path.join(odcRoot, 'snapshots'), path.join(odcRoot, 'lab'), path.join(odcRoot, 'journal'), path.join(odcRoot, '.local'),
    path.join(repo, 'kernel', '.local'), path.join(repo, '.local')]
    .flatMap(folder => Object.keys(fingerprint(folder)).map(file => path.join(folder, file)).filter(names));
  const before = Object.fromEntries(Object.entries(guarded).map(([k, f]) => [k, f()]));

  process.env.SSAM_SERVER_DIR = dir;
  // The module index and the reader caches are shared by design (6.1, keyed by the capture's sha256): kept in the test folder.
  process.env.SSAM_MODULE_INDEX_ROOT = path.join(base, 'module-index');
  process.env.SSAM_READER_CACHE_ROOT = path.join(base, 'readers');
  const port = await freePort();
  const handle = await ssam.runServed(['--port', String(port)]);
  t.after(() => handle.close());
  const url = `http://127.0.0.1:${port}/mcp`;
  const store = createTokenStore(dir);
  const issued = store.issue({ customer: 'E2E' });
  assert.ok(issued.token && issued.agentCredential, 'issue gives the MCP token and the agent credential once');
  const workspace = path.join(dir, 'customers', issued.id);

  // Fake Studios of the customer machine.
  const odcPid = 900000 + Math.floor(Math.random() * 90000), o11Pid = odcPid + 1;
  const agentRoot = path.join(base, 'SSAM-Agent');
  const pipe = await fakeOdcPipe(odcPid, line => {
    const [command, ...args] = line.split(' ');
    if (command === 'status') return { ok: true, bridge: ODC_BRIDGE, busy: null, modules: [] };
    if (command === 'snapshot' && args[0] === 'Evil') return { ok: true, module: 'Evil', path: 'agent:..\\..\\x' };
    if (command === 'snapshot') {
      const bytes = Buffer.from('fake capture of ' + args[0]);
      const hash = sha(bytes).toUpperCase();
      const file = path.join(agentRoot, 'odc', 'snapshots', args[0] + '-' + hash + '.oml');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
      fs.writeFileSync(file + '.json', JSON.stringify({ ok: true, module: args[0], sha256: hash, path: file }));
      return { ok: true, module: args[0], sha256: hash, path: file, host: 'tenant.outsystems.dev' };
    }
    return { ok: false, error: 'fake bridge: ' + command };
  });
  t.after(() => pipe.close());
  // The agent's o11.connect probes the thin Anvil bridge (protocol 2, authenticated, flavor thin) already serving this pid:
  // reused, no attach.
  const bridge = await fakeBridge(request => request.method === 'ping' ? { success: true, data: { bridge: 'anvil', flavor: 'thin', pid: o11Pid, version: '11.55.91.65012' } }
    : request.method === 'bridge_manifest' ? { success: true, data: { bridge: 'anvil', flavor: 'thin', protocolVersion: 2, authentication: true } }
    : request.method === 'ui_alive' ? { success: true, data: { alive: true } }
    : { success: true, data: { method: request.method, modules: [], active: null, errors: [], windows: [] } });
  t.after(() => bridge.close());

  const agentEvents = [];
  async function startAgent(credential, { odcVersion = '1.7.28.4021', root = agentRoot } = {}) {
    for (const d of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private/authority']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'odc', 'README.md'), 'agent');
    fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-e2e', lanes: ['odc', 'o11'], odcBridge: ODC_BRIDGE, o11BuiltFor: '11.55.91', files: [] }));
    fs.writeFileSync(path.join(root, 'private', 'credential'), credential);
    fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), randomBytes(32).toString('base64url'));
    const config = { server: `http://127.0.0.1:${port}`, o11Port: bridge.port };
    fs.writeFileSync(path.join(root, 'private', 'config.json'), JSON.stringify(config));
    const versions = { 'ODCStudio.exe': odcVersion, 'ServiceStudio.exe': '11.55.91.65012' };
    const agent = await createAgent({ root, config, log: (event, fields) => agentEvents.push({ root: path.basename(root), event, ...fields }), deps: {
      processes: async image => image === 'ODCStudio.exe' ? [{ pid: odcPid, path: 'C:\\Fake\\ODC Studio\\ODCStudio.exe', version: odcVersion }]
        : [{ pid: o11Pid, path: 'C:\\Fake\\Service Studio\\ServiceStudio.exe', version: '11.55.91.65012' }],
      locate: async kind => (kind === 'odc' ? 'C:\\Fake\\ODC Studio' : 'C:\\Fake\\Service Studio'),
      fileVersion: async exe => versions[path.basename(exe)] ?? null,
      describe: async pid => ({ pid: Number(pid), startedUtc: '2026-10-04T10:00:00Z', version: '11.55.91.65012', diagnosticsAvailable: true, bridgePath: null, corePath: null }),
      attachOdc: async ({ pid }) => ({ ok: true, attached: true, pid, version: ODC_BRIDGE, note: 'fake' }),
      attachO11: async () => { throw new Error('the fake bridge already serves this Studio; no attach expected'); },
      icacls: async () => ({ ok: true }),
    } });
    const running = Promise.resolve((agent.run ?? agent.start).call(agent));
    t.after(async () => { await (agent.stop ?? agent.close)?.call(agent); await running.catch(() => {}); });
    return { agent, running };
  }
  const connect = async token => {
    const client = new Client({ name: 'e2e-http', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    return client;
  };

  const { running } = await startAgent(issued.agentCredential);
  const client = await connect(issued.token);
  t.after(() => client.close().catch(() => {}));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  // tools/list equals stdio; the doctor shows the agent.
  assert.deepEqual((await client.listTools()).tools.map(x => x.name).sort(), stdioNames);
  const doctor = await waitFor(async () => { const d = (await call('ssam_doctor')).structuredContent; return d?.agent?.connected ? d : null; }, 15000);
  assert.ok(doctor, 'the agent connected: ' + JSON.stringify(agentEvents.slice(-10)));
  assert.equal(doctor.lanes.odc.serverKernel, '1.7.28');

  // ODC through the agent: status and a snapshot mirrored into the workspace as ws:.
  const status = await call('studio_status', {});
  assert.notEqual(status.isError, true, textOf(status));
  assert.ok(pipe.seen.some(line => line.startsWith('status')));
  const snapshot = (await call('studio_snapshot', { module: moduleName })).structuredContent;
  assert.match(snapshot.path, new RegExp('^ws:odc/snapshots/' + moduleName + '-[0-9A-F]{64}\\.oml$'));
  assert.ok(fs.existsSync(path.join(workspace, ...snapshot.path.slice(3).split('/'))), 'the capture is in the workspace');

  // O11: nothing before ssam_connect; then through the relay to the fake bridge.
  assert.equal((await call('o11_studio', { command: 'status' })).structuredContent?.code, 'O11_NOT_CONNECTED');
  const connected = await call('ssam_connect', { lane: 'o11' });
  assert.notEqual(connected.isError, true, textOf(connected));
  const seenBefore = bridge.seen.length;
  const o11 = await call('o11_studio', { command: 'status' });
  assert.notEqual(o11.structuredContent?.code, 'O11_NOT_CONNECTED', textOf(o11));
  assert.ok(bridge.seen.length > seenBefore, 'the O11 status went through the fake bridge');
  assert.ok(bridge.seen.every(r => !Object.hasOwn(r.params ?? {}, 'port')));

  // Refusals: a path outside the workspace; a Studio version the kernel does not have (a second customer, still on the
  // ODC Studio 1.7.27 the server had before 2026-10-12).
  assert.equal((await call('studio_open', { module: 'M', localOml: 'C:\\Windows\\win.ini' })).structuredContent?.code, 'PATH_OUTSIDE_WORKSPACE');
  const other = store.issue({ customer: 'E2E-Other' });
  await startAgent(other.agentCredential, { odcVersion: '1.7.27.10846', root: path.join(base, 'SSAM-Agent-2') });
  const otherClient = await connect(other.token);
  t.after(() => otherClient.close().catch(() => {}));
  const mismatch = await waitFor(async () => { const r = (await otherClient.callTool({ name: 'studio_status', arguments: {} })).structuredContent; return r?.code === 'STUDIO_VERSION_MISMATCH' ? r : null; }, 15000);
  assert.ok(mismatch, 'version mismatch refused');
  assert.match(mismatch.error, /kernel for ODC Studio 1\.7\.28; the agent reports ODC Studio 1\.7\.27\.10846/);

  // A reply naming agent:..\..\x is a protocol violation and writes nothing.
  const evil = await call('studio_snapshot', { module: 'Evil' });
  assert.equal(evil.isError, true);
  assert.match(textOf(evil), /AGENT_PROTOCOL_VIOLATION|outside its workspace/);
  assert.equal(fs.existsSync(path.join(dir, 'x')), false);
  assert.equal(fs.existsSync(path.join(dir, 'customers', 'x')), false);

  // Revoke: the MCP session and the agent channel close within 2 s.
  await waitFor(async () => (await call('ssam_doctor')).structuredContent?.agent?.connected, 15000);
  const revokedAt = Date.now();
  store.revoke(issued.id);
  const sessionClosed = await waitFor(async () => { try { await client.listTools(); return false; } catch { return true; } }, 2000);
  assert.ok(sessionClosed, 'the MCP session closed within 2 s');
  const hello = await fetch(`http://127.0.0.1:${port}/agent/v1/hello`, { method: 'POST', headers: { authorization: 'Bearer ' + issued.agentCredential, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(hello.status, 403);
  const stopped = await Promise.race([running.then(() => true, () => true), delay(2000 - Math.min(2000, Date.now() - revokedAt)).then(() => false)]);
  assert.ok(stopped, 'the agent channel closed and the agent stopped within 2 s');

  // Nothing written outside customers/<tokenId> (and the server's own files).
  for (const [key, take] of Object.entries(guarded)) assert.deepEqual(take(), before[key], key + ' unchanged');
  assert.deepEqual(leaked(), [], 'no file of this run outside the workspace');
  // The quality record (docs/QUALIDADE.md) lives beside the audit: codes, counts and times, never this run's module name.
  const top = fs.readdirSync(dir).filter(name => !['customers', 'tokens.json', 'kernel.json', 'machine-pins.json', 'access-alerts.jsonl'].includes(name) && !/^(audit|quality)-\d{8}\.jsonl$/.test(name) && !/^tokens\.json\..*\.tmp$/.test(name));
  assert.deepEqual(top, [], 'the server folder holds only tokens, kernel.json, machine pins, audit, quality and customers');
  for (const name of fs.readdirSync(dir).filter(n => /^quality-\d{8}\.jsonl$/.test(n))) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8').includes(moduleName), false, 'no module name in ' + name);
});
