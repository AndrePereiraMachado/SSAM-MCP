// A1 of the review of studio-build-identity (C:\t\revisoes\studio-build-id\REVISAO.md): the hub judges the Studio
// INSTALLED on disk, which the agent re-reads every 5 minutes and sends in a pong that is never sent again if it is lost.
// Right after a Studio update the process that runs is another build: the server must judge, on every call, the version
// of THAT process, which the 0.3.1 agent already sends (studio.processes {pid, version}; the O11 connection record's
// studioVersion), with the same rule (studio-identity.mjs) and the same refusal, warning and event. Server only: the
// agent of the 2026-10-13 pack is the real one (createAgent, channel, kinds) and does not change.
// One world: the real agent talks to the real hub through an in-memory fetch (no socket, no network); the real hosted
// gate (wrapHostedTool) and the real AgentExecutor (createHostedContext) run the tool; the clock is fake; the machine
// (installed version, processes, attaches) is a model. Synthetic values only.
// B1 (round 3, C:\t\revisoes\studio-build-id-2\REVISAO.md): ssam_connect {lane:"o11"} right after a Service Studio update
// goes through the real gate, the real AgentExecutor and the real connectAll (the hosted handler of ssam.mjs) to the real
// agent's o11.connect; the only model on the O11 side is the Service Studio itself: describe, the attach of the hook, and
// the thin bridge it loads, a loopback listener on 127.0.0.1 that starts when the hook is attached (no other network).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentHub } from '../agent-hub.mjs';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { createHostedContext, runWithExecutor, currentExecutor, seamFields } from '../executor.mjs';
import { connectAll } from '../studio-connect.mjs';

// The agent box: beside platforms/ on the server line (server/agent/lib), or the agent box of SSAM-MCP (agent/agent/lib).
const serverRoot = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const AGENT_LIB = [path.join(serverRoot, 'agent', 'lib'), path.join(serverRoot, '..', 'agent', 'agent', 'lib')].find(dir => fs.existsSync(path.join(dir, 'agent.mjs')));
const skip = AGENT_LIB ? false : 'the agent box is not beside this server box: this test runs the agent\'s own code';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-studio-process-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ODC_OLD = '1.7.28.5000', ODC_NEW = '1.7.28.5023', ODC_NEXT = '1.7.29.100';
const O11_OLD = '11.55.92.6000', O11_NEW = '11.55.92.6011';
// B3: what a pt-BR text of these answers looks like (accented letters, or the words of the old pt-BR texts)
const PT_BR = /[ãõçáéíóúâêôà]|\b(não|deste|computador|Atualize|Aviso|Nada rodou|servidor|dono|ferramentas|continuam|rodou|repita|peça|abra|conecte|versões|faixa)\b/i;
const CREDENTIAL = 'ssam_agent_' + 'A'.repeat(43);
const TOKEN = 'tok_5a5a5a5a5a5a';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
// A free loopback port for the model of the thin bridge (nothing listens on it until the hook is attached).
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

async function world({ lane = 'odc', policy = null, failVersionsPong = false } = {}) {
  const { createAgent } = await import(pathToFileURL(path.join(AGENT_LIB, 'agent.mjs')).href);
  const dir = fs.mkdtempSync(path.join(tmp, 'hub-'));
  const root = fs.mkdtempSync(path.join(tmp, 'agent-'));
  for (const d of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private/authority']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-synth', lanes: [lane], odcBridge: 'v96', o11BuiltFor: O11_OLD, o11Hook: 'dev', files: [] }));
  for (const rel of ['odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.dll', 'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v96.dll',
    'bin/o11/hook/Anvil.RuntimeHook.Agent.dll']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'synthetic');
  }
  // B1: the Service Studio side of the real agent's o11.connect. The bridge port of this agent; the bridge of the hook
  // listens only after attachO11 (before it the port refuses, as for a Studio that just reopened).
  const o11Port = lane === 'o11' ? await freePort() : 4516;
  const o11Attaches = [];
  const bridge = { server: null, pid: null, methods: [] };
  const startBridge = pid => new Promise((resolve, reject) => {
    bridge.pid = pid;
    bridge.server = net.createServer(socket => {
      let text = '';
      socket.on('error', () => {});
      socket.on('data', chunk => {
        text += chunk;
        const end = text.indexOf('\n');
        if (end < 0) return;
        const { method } = JSON.parse(text.slice(0, end));
        bridge.methods.push(method);
        const data = { ping: { bridge: 'anvil', pid: bridge.pid, version: 'thin' }, bridge_manifest: { protocolVersion: 2, authentication: true, flavor: 'thin' },
          ui_alive: { alive: true } }[method] ?? {};
        socket.end(JSON.stringify({ success: true, data }) + '\n');
      });
    });
    bridge.server.once('error', reject);
    bridge.server.listen(o11Port, '127.0.0.1', resolve);
  });
  const SYNTHETIC_KEY = 'synthetic-bridge-key-' + 'b'.repeat(24);
  if (lane === 'o11') fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), SYNTHETIC_KEY);
  let now = Date.parse('2026-10-15T10:00:00Z');
  const clock = () => now;
  const events = [];
  const store = {
    verifyAgent: () => ({ status: 'ok', id: TOKEN, customer: 'Cliente Sintetico', lanes: [lane], agentSha256: 'a'.repeat(64) }),
    lookup: () => ({ customer: 'Cliente Sintetico', lanes: [lane], credential: true, state: 'active', agentSha256: 'a'.repeat(64) }),
  };
  const kernel = lane === 'odc' ? { odc: '1.7.28', odcBridge: 'v96', builds: { odc: ODC_OLD }, ...(policy ? { studioBuildPolicy: policy } : {}) }
    : { o11: '11.55.92', odc: '1.7.28', odcBridge: 'v96', builds: { o11: O11_OLD }, ...(policy ? { studioBuildPolicy: policy } : {}) };
  const hub = createAgentHub({ dir, store, kernel, log: e => events.push(e), now: clock, limits: { heartbeatMs: 2147483000, sweepMs: 3600000 } });

  // the user's machine: the installed Studio (disk) and the running processes
  const image = lane === 'odc' ? 'ODCStudio.exe' : 'ServiceStudio.exe';
  const machine = { installed: lane === 'odc' ? ODC_OLD : O11_OLD, processes: [{ pid: 4101, path: 'C:\\synthetic\\' + image, version: lane === 'odc' ? ODC_OLD : O11_OLD }] };
  if (lane === 'o11') fs.writeFileSync(path.join(root, 'private', 'o11-connection.json'),
    JSON.stringify({ pid: 4101, startedUtc: '2026-10-15T09:00:00.000Z', port: o11Port, studioVersion: O11_OLD }));
  const attaches = [];
  const agentCalls = [];
  let stream = null;
  const posts = [];
  let failNext = failVersionsPong;
  const response = (status, text) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => JSON.parse(text), text: async () => text, arrayBuffer: async () => Buffer.from(text) });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const bodyText = init.body === undefined ? '' : typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8');
    if (init.method === 'POST' && u.pathname === '/agent/v1/messages') {
      const parsed = JSON.parse(bodyText);
      const versionsPong = parsed.messages.some(m => m.t === 'pong' && m.versions);
      if (versionsPong && failNext) { failNext = false; posts.push({ versions: true, status: 503 }); return response(503, ''); }
      if (versionsPong) posts.push({ versions: true, status: 204 });
    }
    const req = Readable.from(bodyText ? [Buffer.from(bodyText)] : []);
    req.url = u.pathname + u.search; req.method = init.method ?? 'GET';
    req.headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    req.socket = { remoteAddress: '127.0.0.9' };
    const isStream = u.pathname === '/agent/v1/stream';
    return new Promise((resolve, reject) => {
      const res = new EventEmitter();
      let status = 0; const chunks = [];
      res.headersSent = false; res.writableEnded = false; res.destroyed = false;
      const queue = []; let wake = null, ended = false;
      const body = { [Symbol.asyncIterator]() { return { async next() {
        for (;;) {
          if (queue.length) return { value: queue.shift(), done: false };
          if (ended) return { value: undefined, done: true };
          await new Promise(r => { wake = r; });
        } } }; } };
      const push = line => { queue.push(new TextEncoder().encode(line)); const w = wake; wake = null; w?.(); };
      res.writeHead = s => { status = s; res.headersSent = true; return res; };
      res.flushHeaders = () => { if (isStream) { stream = { push }; resolve({ status, ok: true, body, headers: { get: () => null } }); } };
      res.write = chunk => {
        if (isStream) { for (const line of String(chunk).split('\n').filter(Boolean)) { try { const m = JSON.parse(line); if (m.t === 'call') agentCalls.push(m.kind); } catch { /* not a call */ } } push(String(chunk)); }
        else chunks.push(Buffer.from(chunk));
        return true;
      };
      res.end = chunk => {
        if (chunk) res.write(chunk);
        res.writableEnded = true;
        if (isStream) { ended = true; const w = wake; wake = null; w?.(); res.emit('close'); return; }
        resolve(response(status, Buffer.concat(chunks).toString('utf8')));
      };
      res.destroy = () => { res.destroyed = true; ended = true; res.emit('close'); };
      init.signal?.addEventListener?.('abort', () => { if (isStream) { ended = true; const w = wake; wake = null; w?.(); res.emit('close'); } });
      hub.handle(req, res).then(handled => { if (!handled) reject(new Error('not handled ' + u.pathname)); }, reject);
    });
  };
  const agent = createAgent({ root, config: { server: 'http://hub.invalid', credential: CREDENTIAL, o11Port },
    deps: { fetch: fetchImpl, now: clock, machine: { id: 'synthmachine0001', name: 'SYNTH-PC', user: 'synth' },
      locate: async kind => (kind === lane ? 'C:\\synthetic\\Studio' : null),
      fileVersion: async exe => (path.basename(exe) === image ? machine.installed : null),
      processes: async name => (name === image ? machine.processes.map(p => ({ ...p })) : []),
      attachOdc: async ({ pid }) => { attaches.push(pid); return { ok: true, attached: true }; },
      // the Service Studio: its diagnostics answer, and the hook it loads starts the thin bridge on the agent's port
      describe: async pid => ({ pid, startedUtc: '2026-10-15T10:01:00.000Z', diagnosticsAvailable: true, bridgePath: null, corePath: null,
        version: machine.processes.find(p => p.pid === Number(pid))?.version ?? null }),
      attachO11: async pid => { o11Attaches.push(pid); fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), SYNTHETIC_KEY); await startBridge(pid); } } });
  const running = agent.run();
  for (let i = 0; i < 400 && !stream; i++) await sleep(5);
  if (!stream) throw new Error('the agent stream never opened');
  await tick();
  const link = hub.link(TOKEN);
  const workspace = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const context = await createHostedContext({ tokenId: TOKEN, customer: 'Cliente Sintetico', lanes: [lane], agent: link, workspace });
  let seq = 0;
  // one heartbeat of the hub: the agent answers with a pong (versions only when they changed and were re-read)
  async function ping() { now += 15000; stream.push(JSON.stringify({ t: 'ping', seq: ++seq, at: now }) + '\n'); await sleep(3); await tick(12); }
  // what the hosted handlers do: the call goes through the customer's executor (lib.mjs client -> AgentExecutor)
  const runs = [];
  const gate = (name, body) => wrapHostedTool(name, { inputSchema: {} }, async args => {
    runs.push(name);
    try { return reply({ ok: true, value: await body(currentExecutor(), args) }); }
    catch (error) { return reply({ ok: false, code: error.code ?? 'ERROR', error: error.message, ...seamFields(error) }); }
  }, { context, link, lanes: [lane], run: runWithExecutor });
  // B1: the hosted ssam_connect handler of ssam.mjs as it is (connectAll through the customer's executor, CONNECT_FAILED).
  const connectTool = wrapHostedTool('ssam_connect', { inputSchema: {} }, async (input = {}) => {
    runs.push('ssam_connect');
    let value;
    try { value = await connectAll(input, { served: [lane] }); } catch (error) { value = { ok: false, stage: 'connect', error: error.message }; }
    if (value && value.ok === false && !value.code) value = { ...value, code: 'CONNECT_FAILED', stage: 'connect' };
    return reply(value);
  }, { context, link, lanes: [lane], run: runWithExecutor });
  const pid = () => machine.processes[0].pid;
  const tools = {
    attach: gate('studio_attach', ex => ex.call('odc.attach', { pid: pid() })),
    status: gate('studio_status', ex => ex.call('odc.pipe', { pid: pid(), version: null, args: ['status'], connectMs: 50 })),
    // lib.mjs studioPids lists first (30 s cache), then the command
    listed: gate('studio_assets', async ex => { await ex.call('studio.processes', { image: 'ODCStudio.exe' }); return ex.call('odc.attach', { pid: pid() }); }),
    o11: gate('o11_studio', () => 'ran'),
    // a state report: its own answer stays, the refused Studio call comes back in studioSkipped
    report: gate('studio_doctor', async ex => { try { await ex.call('odc.pipe', { pid: pid(), version: null, args: ['status'], connectMs: 50 }); return 'pipe ok'; } catch (error) { return 'pipe ' + error.code; } }),
    connect: connectTool,
  };
  const call = async (tool, args = {}) => (await tools[tool](args, { requestId: 1 })).structuredContent;
  const unserved = () => events.filter(e => e.event === 'studio-version-unserved');
  const hubSees = () => link.info().studios?.[lane]?.installed?.version ?? null;
  // the Studio updates and reopens: another build on disk and a new process running it
  const update = version => { machine.installed = version; machine.processes = [{ pid: 4102, path: 'C:\\synthetic\\' + image, version }]; };
  return { hub, link, context, machine, events, posts, attaches, agentCalls, runs, ping, call, unserved, hubSees, update, o11Attaches, bridge,
    advance: ms => { now += ms; },
    stop: async () => {
      await context.close().catch(() => {}); await agent.stop().catch(() => {}); await running?.catch?.(() => {}); await hub.close();
      if (bridge.server) await new Promise(resolve => bridge.server.close(() => resolve()));
    } };
}
const assertRefusal = (answer, { cause, relation, installed, served }) => {
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.deepEqual({ code: answer.code, cause: answer.cause, relation: answer.relation, installed: answer.installed, served: answer.served, outcome: answer.outcome },
    { code: 'STUDIO_VERSION_MISMATCH', cause, relation, installed, served: [served], outcome: 'not-sent' }, JSON.stringify(answer));
  // B3 (owner rule of 2026-10-15): every text SSAM emits is English, the user's one included; no pt-BR line
  assert.match(answer.userMessage, /Nothing ran on your Studio\./);
  assert.doesNotMatch(JSON.stringify(answer), PT_BR, 'no pt-BR text in the refusal');
  assert.match(answer.error, /Nothing ran on the user's Studio\./);
  assert.ok(Array.isArray(answer.stillWorks) && answer.stillWorks.length > 0);
  assert.equal(answer.continuation?.tool, 'ssam_doctor');
};

test('A1 ODC: the Studio updates to another build, a call before any pong: refused with the full answer (refuse) or run with studioBuildDiffers (warn)', { skip }, async () => {
  const strict = await world({ policy: 'refuse' });
  try {
    assert.equal((await strict.call('attach')).ok, true, 'the served build runs');
    assert.deepEqual(strict.attaches, [4101]);
    strict.update(ODC_NEW);
    assert.equal(strict.hubSees(), ODC_OLD, 'precondition: the hub still has the Hello\'s build');
    const refused = await strict.call('attach');
    assertRefusal(refused, { cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'build-differs', installed: ODC_NEW, served: ODC_OLD });
    assert.deepEqual(strict.attaches, [4101], 'nothing attached to the new process');
    const pipe = await strict.call('status');
    assertRefusal(pipe, { cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'build-differs', installed: ODC_NEW, served: ODC_OLD });
    assert.equal(strict.agentCalls.filter(k => k === 'odc.pipe').length, 0, 'the pipe call never reached the agent');
    assert.deepEqual(strict.unserved().map(({ time, ...e }) => e), [{ event: 'studio-version-unserved', token: TOKEN, lane: 'odc', installed: ODC_NEW,
      served: ODC_OLD, relation: 'build-differs', cause: 'STUDIO_VERSION_NOT_SERVED_YET', policy: 'refuse' }], 'one event for the two refused calls');
    // the listing that lib.mjs makes first (studio.processes) is the same source
    assertRefusal(await strict.call('listed'), { cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'build-differs', installed: ODC_NEW, served: ODC_OLD });
    const report = await strict.call('report');
    assert.deepEqual({ ok: report.ok, value: report.value, skipped: report.studioSkipped?.map(s => [s.lane, s.cause, s.installed]) },
      { ok: true, value: 'pipe STUDIO_VERSION_MISMATCH', skipped: [['odc', 'STUDIO_VERSION_NOT_SERVED_YET', ODC_NEW]] }, 'a state report is not replaced');
    assert.equal(strict.unserved().length, 1, 'still one event');
  } finally { await strict.stop(); }
  const lenient = await world({ policy: 'warn' });
  try {
    lenient.update(ODC_NEW);
    const ran = await lenient.call('attach');
    assert.equal(ran.ok, true, JSON.stringify(ran));
    assert.deepEqual(lenient.attaches, [4102]);
    assert.deepEqual({ code: ran.studioWarning?.code, installed: ran.studioWarning?.installed, served: ran.studioWarning?.served },
      { code: 'studioBuildDiffers', installed: ODC_NEW, served: ODC_OLD }, JSON.stringify(ran));
    assert.equal(lenient.unserved().length, 0, 'served with a warning is no refusal');
  } finally { await lenient.stop(); }
});

test('A1 ODC: the pong that carries the update is lost (503); 60 min later the call is still refused (refuse) or warned (warn)', { skip }, async () => {
  for (const policy of ['refuse', 'warn']) {
    const w = await world({ policy, failVersionsPong: true });
    try {
      w.update(ODC_NEW);
      w.advance(5 * 60000);
      for (let i = 0; i < 240; i++) await w.ping(); // 60 min of heartbeats
      assert.equal(w.hubSees(), ODC_OLD, policy + ': precondition: the hub never learned the update');
      assert.ok(w.posts.some(p => p.versions && p.status === 503), policy + ': the pong with the versions was lost');
      const answer = await w.call('attach');
      if (policy === 'refuse') {
        assertRefusal(answer, { cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'build-differs', installed: ODC_NEW, served: ODC_OLD });
        assert.deepEqual(w.attaches, []);
      } else {
        assert.equal(answer.ok, true);
        assert.equal(answer.studioWarning?.code, 'studioBuildDiffers');
      }
    } finally { await w.stop(); }
  }
});

test('A1 ODC: another three-part version inside the window: the server\'s full refusal, not the agent\'s short one, and one event', { skip }, async () => {
  const w = await world({ policy: 'warn' });
  try {
    w.update(ODC_NEXT);
    const answer = await w.call('attach');
    assertRefusal(answer, { cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'newer', installed: ODC_NEXT, served: ODC_OLD });
    assert.match(answer.userMessage, /The server does not have this version yet/);
    assert.equal(w.agentCalls.filter(k => k === 'odc.attach').length, 0, 'the agent never saw the attach');
    assert.equal(w.unserved().length, 1);
    // the pong arrives later: the hub judges the same Studio, and the event is not repeated
    w.advance(5 * 60000); await w.ping(); await w.ping();
    assert.equal(w.hubSees(), ODC_NEXT);
    assert.equal(w.link.info().compatible.odc.cause, 'STUDIO_VERSION_NOT_SERVED_YET');
    assert.equal(w.unserved().length, 1);
  } finally { await w.stop(); }
});

test('A1 O11: the connected Service Studio record (o11.connect) is judged on every call: refused (refuse) or warned (warn)', { skip }, async () => {
  for (const policy of ['refuse', 'warn']) {
    const w = await world({ lane: 'o11', policy });
    try {
      assert.equal((await w.call('o11')).ok, true, policy + ': the served build runs');
      // the Service Studio updated and the user reconnected it: the o11.connect result is the executor's record
      w.update(O11_NEW);
      w.context.executor.remember({ ok: true, connected: true, pid: 4102, startedUtc: '2026-10-15T10:01:00.000Z', studioVersion: O11_NEW });
      assert.equal(w.hubSees(), O11_OLD, 'precondition: the hub still has the Hello\'s build');
      const before = w.runs.length;
      const answer = await w.call('o11');
      if (policy === 'refuse') {
        assertRefusal(answer, { cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'build-differs', installed: O11_NEW, served: O11_OLD });
        assert.equal(w.runs.length, before, 'the handler never ran');
        assert.equal(w.unserved().length, 1);
        assert.equal(w.unserved()[0].lane, 'o11');
      } else {
        assert.equal(answer.ok, true);
        assert.deepEqual({ code: answer.studioWarning?.code, installed: answer.studioWarning?.installed }, { code: 'studioBuildDiffers', installed: O11_NEW });
      }
    } finally { await w.stop(); }
  }
});

// B1 (round 3): the o11.connect itself is judged by the process it attaches, before any bridge call (the probe included):
// right after a Service Studio update the hub still has the disk's build, and the call that follows every update is the
// connect. Through the real gate, executor, connectAll and agent; never executor.remember().
const o11Sent = w => w.agentCalls.filter(k => k === 'o11.connect' || k === 'o11.bridge');
test('B1 O11 refuse: ssam_connect {lane:"o11"} after the update is the full refusal, nothing is attached, no bridge call goes out, one event', { skip }, async () => {
  const w = await world({ lane: 'o11', policy: 'refuse' });
  try {
    w.update(O11_NEW);
    assert.equal(w.hubSees(), O11_OLD, 'precondition: the hub still has the Hello\'s build');
    const answer = await w.call('connect', { lane: 'o11' });
    assertRefusal(answer, { cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'build-differs', installed: O11_NEW, served: O11_OLD });
    assert.deepEqual(o11Sent(w), [], 'neither the probe nor the o11.connect reached the agent');
    assert.deepEqual(w.o11Attaches, [], 'nothing attached to the new Service Studio');
    assert.deepEqual(w.unserved().map(({ time, ...e }) => e), [{ event: 'studio-version-unserved', token: TOKEN, lane: 'o11', installed: O11_NEW,
      served: O11_OLD, relation: 'build-differs', cause: 'STUDIO_VERSION_NOT_SERVED_YET', policy: 'refuse' }], 'one event');
    // ssam_connect {} with a token of the O11 lane only: the same refusal, still one event
    const all = await w.call('connect', {});
    assertRefusal(all, { cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'build-differs', installed: O11_NEW, served: O11_OLD });
    assert.deepEqual(o11Sent(w), []);
    assert.deepEqual(w.o11Attaches, []);
    assert.equal(w.unserved().length, 1, 'still one event');
  } finally { await w.stop(); }
});

test('B1 O11 warn: ssam_connect {lane:"o11"} and ssam_connect {} attach the new Service Studio and say studioBuildDiffers', { skip }, async () => {
  const w = await world({ lane: 'o11', policy: 'warn' });
  try {
    w.update(O11_NEW);
    const answer = await w.call('connect', { lane: 'o11' });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(answer.studios?.map(s => [s.lane, s.pid, s.attached]), [['o11', 4102, true]], JSON.stringify(answer));
    assert.deepEqual(w.o11Attaches, [4102], 'the real agent attached the hook');
    assert.deepEqual({ code: answer.studioWarning?.code, lane: answer.studioWarning?.lane, installed: answer.studioWarning?.installed, served: answer.studioWarning?.served },
      { code: 'studioBuildDiffers', lane: 'o11', installed: O11_NEW, served: O11_OLD }, JSON.stringify(answer));
    assert.doesNotMatch(JSON.stringify(answer.studioWarning), PT_BR);
    assert.equal(w.unserved().length, 0, 'served with a warning is no refusal');
    // the bridge already answers for this Studio now: ssam_connect {} reuses it and says the same
    const again = await w.call('connect', {});
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.studioWarning?.code, 'studioBuildDiffers', JSON.stringify(again));
    assert.deepEqual(w.o11Attaches, [4102], 'no second attach');
  } finally { await w.stop(); }
});

test('B1 counterproof: ssam_connect {lane:"o11"} to the served build attaches with no refusal and no warning', { skip }, async () => {
  const w = await world({ lane: 'o11', policy: 'refuse' });
  try {
    const answer = await w.call('connect', { lane: 'o11' });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(answer.studios?.map(s => [s.lane, s.pid, s.attached]), [['o11', 4101, true]]);
    assert.equal(answer.studioWarning, undefined);
    assert.equal(answer.studioSkipped, undefined);
    assert.deepEqual(w.o11Attaches, [4101]);
    assert.equal(w.unserved().length, 0);
  } finally { await w.stop(); }
});

test('A1 counterproof: the same build, on disk and in the process, gets no refusal and no warning in either lane', { skip }, async () => {
  for (const lane of ['odc', 'o11']) {
    const w = await world({ lane, policy: 'refuse' });
    try {
      const answer = await w.call(lane === 'odc' ? 'attach' : 'o11');
      assert.equal(answer.ok, true, lane);
      assert.equal(answer.studioWarning, undefined, lane);
      if (lane === 'odc') assert.equal((await w.call('status')).code === 'STUDIO_VERSION_MISMATCH', false, 'the pipe call is not judged as another build');
      assert.equal(w.unserved().length, 0);
    } finally { await w.stop(); }
  }
});
