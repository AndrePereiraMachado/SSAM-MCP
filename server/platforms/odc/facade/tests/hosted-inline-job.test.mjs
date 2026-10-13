// Jobs inline on the hosted server (fase4-24, docs/FASE2-AGENTE.md 2.10): the production test of 2026-10-11 sent a 60 KB
// job through the agent inbox because the hosted rules said so, and its upload from the user's machine stalled for 26.9 s.
// Here the real hosted server (runServed, hub, gate, AgentExecutor) and the real agent with fake Studios take a job of
// about 2 MB in the MCP call itself, as an object and as its JSON text: the job reaches the delivery whole, is written in
// the customer's workspace, the answer names it as ws: without echoing it, and the agent uploads nothing for it; the same
// job named agent:inbox/<file> costs one more agent upload (file.get). Never a real Studio: fake pipe and fake bridge.
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
// The real agent runs here: the agent box must be beside this server box. In SSAM-MCP the agent lives in a box of its own
// (agent/, next to server/), so there this test skips with the reason, as hosted-e2e does; the server line runs it.
const AGENT_ENTRY = path.join(repo, 'agent', 'ssam-agent.mjs');
const agentSkip = fs.existsSync(AGENT_ENTRY) ? false : 'the agent box is not beside this server box (missing ' + path.relative(repo, AGENT_ENTRY)
  + '): this test runs the real agent; run it on the server line, where agent/ sits next to platforms/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(50); } return null; };

async function fakeOdcPipe(pid, handler) {
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk.toString('utf8'); const i = buffer.indexOf('\n'); if (i < 0) return;
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      socket.write(JSON.stringify(await handler(line)) + '\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(`\\\\.\\pipe\\ODC3-Bridge-${ODC_BRIDGE}-${pid}`, resolve));
  return { close: () => new Promise(resolve => server.close(resolve)) };
}
async function freePort() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = 7400 + Math.floor(Math.random() * 100);
    const free = await new Promise(resolve => { const s = net.createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
    if (free) return port;
  }
  throw new Error('no free port in 7400-7499');
}
// A job of about `bytes` bytes as compact JSON: server actions with long descriptions (the size is what matters here; the
// kernel's own verdict on it does not).
function bigJob(bytes) {
  const actions = [];
  for (let i = 0; JSON.stringify({ actions }).length < bytes; i++)
    actions.push({ name: 'InlineAction' + i, description: 'Ação ' + i + ' do job inline: ' + 'regra de negócio '.repeat(40), public: false,
      inputs: [{ name: 'Valor', type: 'Integer' }], steps: [{ as: 'start' }, { as: 'end' }] });
  return { actions };
}

test('hosted: a job of ~2 MB inline (object and JSON text) reaches o11_deliver and studio_deliver whole, in the workspace, with no agent upload; agent:inbox costs one', { skip: agentSkip, timeout: 240000 }, async t => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { fakeBridge } = await import('./fixtures/fake-o11-bridge.mjs');
  const ssam = await import('../ssam.mjs');
  const { createTokenStore } = await import('../server-tokens.mjs');
  const { createAgent } = await import(pathToFileURL(path.join(repo, 'agent', 'ssam-agent.mjs')).href);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-inline-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'server');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify({ o11: '11.55.91', odc: '1.7.28', odcBridge: ODC_BRIDGE }));
  process.env.SSAM_SERVER_DIR = dir;
  process.env.SSAM_MODULE_INDEX_ROOT = path.join(base, 'module-index');
  process.env.SSAM_READER_CACHE_ROOT = path.join(base, 'readers');
  const port = await freePort();
  const handle = await ssam.runServed(['--port', String(port)]);
  t.after(() => handle.close());
  const issued = createTokenStore(dir).issue({ customer: 'Inline' });
  const workspace = path.join(dir, 'customers', issued.id);

  const odcPid = 900000 + Math.floor(Math.random() * 90000), o11Pid = odcPid + 1;
  const agentRoot = path.join(base, 'SSAM-Agent');
  const moduleName = 'InlineShop' + randomBytes(3).toString('hex');
  const pipe = await fakeOdcPipe(odcPid, line => {
    const [command, ...args] = line.split(' ');
    if (command === 'status') return { ok: true, bridge: ODC_BRIDGE, busy: null, modules: [{ name: moduleName }] };
    if (command === 'snapshot') {
      const bytes = Buffer.from('fake capture of ' + args[0]);
      const hash = sha(bytes).toUpperCase();
      const file = path.join(agentRoot, 'odc', 'snapshots', args[0] + '-' + hash + '.oml');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
      return { ok: true, module: args[0], sha256: hash, path: file, host: 'tenant.outsystems.dev' };
    }
    return { ok: false, error: 'fake bridge: ' + command };
  });
  t.after(() => pipe.close());
  const bridge = await fakeBridge(request => request.method === 'ping' ? { success: true, data: { bridge: 'anvil', flavor: 'thin', pid: o11Pid, version: '11.55.91.65012' } }
    : request.method === 'bridge_manifest' ? { success: true, data: { bridge: 'anvil', flavor: 'thin', protocolVersion: 2, authentication: true } }
    : request.method === 'ui_alive' ? { success: true, data: { alive: true } }
    : request.method === 'list_open_modules' ? { success: true, data: { modules: [{ name: 'Headless_CS', key: 'k' }], active: 'Headless_CS' } }
    : { success: false, error: 'fake thin bridge: ' + request.method, executed: false });
  t.after(() => bridge.close());

  const events = [];
  for (const d of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private/authority']) fs.mkdirSync(path.join(agentRoot, d), { recursive: true });
  fs.writeFileSync(path.join(agentRoot, 'pack.json'), JSON.stringify({ id: 'pack-inline', lanes: ['odc', 'o11'], odcBridge: ODC_BRIDGE, o11BuiltFor: '11.55.91', files: [] }));
  fs.writeFileSync(path.join(agentRoot, 'private', 'credential'), issued.agentCredential);
  fs.writeFileSync(path.join(agentRoot, 'private', 'authority', 'bridge.key'), randomBytes(32).toString('base64url'));
  const config = { server: `http://127.0.0.1:${port}`, o11Port: bridge.port };
  fs.writeFileSync(path.join(agentRoot, 'private', 'config.json'), JSON.stringify(config));
  const versions = { 'ODCStudio.exe': '1.7.28.4021', 'ServiceStudio.exe': '11.55.91.65012' };
  const agent = await createAgent({ root: agentRoot, config, log: (event, fields) => events.push({ event, ...fields }), deps: {
    processes: async image => image === 'ODCStudio.exe' ? [{ pid: odcPid, path: 'C:\\Fake\\ODC Studio\\ODCStudio.exe', version: versions['ODCStudio.exe'] }]
      : [{ pid: o11Pid, path: 'C:\\Fake\\Service Studio\\ServiceStudio.exe', version: versions['ServiceStudio.exe'] }],
    locate: async kind => (kind === 'odc' ? 'C:\\Fake\\ODC Studio' : 'C:\\Fake\\Service Studio'),
    fileVersion: async exe => versions[path.basename(exe)] ?? null,
    describe: async pid => ({ pid: Number(pid), startedUtc: '2026-10-04T10:00:00Z', version: '11.55.91.65012', diagnosticsAvailable: true, bridgePath: null, corePath: null }),
    attachOdc: async ({ pid }) => ({ ok: true, attached: true, pid, version: ODC_BRIDGE, note: 'fake' }),
    attachO11: async () => { throw new Error('no attach expected'); },
    icacls: async () => ({ ok: true }),
  } });
  const running = Promise.resolve(agent.run());
  t.after(async () => { await agent.stop(); await running.catch(() => {}); });

  const client = new Client({ name: 'inline-http', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + issued.token } } }));
  t.after(() => client.close().catch(() => {}));
  const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  assert.ok(await waitFor(async () => (await call('ssam_doctor')).structuredContent?.agent?.connected, 15000), 'the agent connected');
  assert.notEqual((await call('ssam_connect', { lane: 'o11' })).isError, true);

  const uploads = () => events.filter(e => e.event === 'call' && e.kind === 'file.get').length;
  const inlineFiles = folder => { try { return fs.readdirSync(folder).filter(f => f.endsWith('.json')).map(f => path.join(folder, f)); } catch { return []; } };
  const o11Inline = path.join(workspace, 'o11', 'jobs', 'inline');
  const job = bigJob(2 * 1024 * 1024);
  const text = JSON.stringify(job);
  assert.ok(text.length > 2 * 1024 * 1024 && text.length < 3 * 1024 * 1024, 'about 2 MB: ' + text.length);

  // O11, the job as an object and as its JSON text: one call each, the whole job in ws:o11/jobs/inline, nothing uploaded.
  for (const [shape, value] of [['object', job], ['JSON text', text]]) {
    const before = uploads(), files = new Set(inlineFiles(o11Inline));
    const answer = await call('o11_deliver', { module: 'Headless_CS', job: value, authorize: 'pode entregar o job inline no Headless_CS' });
    const shown = JSON.stringify(answer);
    const written = inlineFiles(o11Inline).filter(f => !files.has(f));
    assert.equal(written.length, 1, shape + ': the job was written once in the workspace: ' + shown.slice(0, 600));
    assert.deepEqual(JSON.parse(fs.readFileSync(written[0], 'utf8')), job, shape + ': the job reached the delivery whole');
    assert.equal(uploads(), before, shape + ': the agent uploaded nothing for the job');
    assert.ok(!/JOB_NOT_FOUND|PATH_OUTSIDE_WORKSPACE|JOB_INVALID/.test(shown), shape + ': ' + shown.slice(0, 600));
    assert.ok(shown.length < 200000, shape + ': the answer does not echo the job (' + shown.length + ' bytes)');
    const named = answer.structuredContent?.nextBasedOn?.job ?? answer.structuredContent?.job;
    if (named) assert.equal(named, 'ws:o11/jobs/inline/' + path.basename(written[0]), shape + ': the answer names the job in the workspace');
  }

  // The same job as a file of the agent inbox: one more agent upload (file.get) before the delivery.
  fs.writeFileSync(path.join(agentRoot, 'inbox', 'big-job.json'), text);
  const before = uploads();
  await call('o11_deliver', { module: 'Headless_CS', job: 'agent:inbox/big-job.json', authorize: 'pode entregar o job do inbox no Headless_CS' });
  assert.equal(uploads(), before + 1, 'agent:inbox costs one upload through the agent');
  assert.equal(sha(fs.readFileSync(path.join(workspace, 'inbox', 'big-job.json'))), sha(Buffer.from(text)));

  // ODC: studio_deliver with the JSON text of the job: the proxy takes it as the job (never a path of the ODC root).
  const odcInline = path.join(workspace, 'odc', '.local', 'jobs', 'inline');
  const odcJob = { ops: [{ op: 'note', text: 'inline ' + 'x'.repeat(4000) }] };
  const odcAnswer = await call('studio_deliver', { feature: 'inline-job', module: moduleName, owners: ['a'], changes: ['b'], job: JSON.stringify(odcJob) });
  const odcWritten = inlineFiles(odcInline);
  assert.equal(odcWritten.length, 1, JSON.stringify(odcAnswer).slice(0, 600));
  assert.deepEqual(JSON.parse(fs.readFileSync(odcWritten[0], 'utf8')), odcJob);
  assert.ok(!/JOB_NOT_FOUND|PATH_OUTSIDE_WORKSPACE|JOB_INVALID|No job file/.test(JSON.stringify(odcAnswer)), JSON.stringify(odcAnswer).slice(0, 600));
});
