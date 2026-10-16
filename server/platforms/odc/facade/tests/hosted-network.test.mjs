// The network check of a hosted session (fase4-24, docs/FASE2-AGENTE.md 2.10): the hub's probe route, the per-exit
// verdicts in plain words, the slow upload parts the hub notes, ssam_doctor {network:true}, and the whole path over the
// real hub with the agent's own channel and net.mjs, through a relay that sends every other new connection by a second
// public exit that lets small requests pass and stalls large bodies (the owner's network in the production test of
// 2026-10-11). Fakes only: no Studio, no real agent machine.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { startHttpServer } from '../http-server.mjs';
import { createTokenStore } from '../server-tokens.mjs';
import { maskAddress, slowUpload, CALL_KINDS } from '../agent-hub.mjs';
import { summarizeProbes, networkCheck, uploadsHint, DEFAULT_PLAN } from '../hosted/network-check.mjs';
import { createSsamServer, hostedDoctor } from '../ssam.mjs';

const repo = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const agentLib = name => import(pathToFileURL(path.join(repo, 'agent', 'lib', name)).href);
// The two tests that run the agent's own code (the end to end over the real hub, and createAgent) need the agent box beside
// this server box. In SSAM-MCP the agent lives in a box of its own (agent/, next to server/), so there they skip with the
// reason, as hosted-e2e does; the server line has both and runs them.
const AGENT_FILES = ['channel.mjs', 'outbox.mjs', 'net.mjs', 'net-probe.mjs', 'kinds.mjs', 'agent.mjs'].map(name => path.join(repo, 'agent', 'lib', name));
const agentMissing = AGENT_FILES.filter(file => !fs.existsSync(file));
const agentSkip = agentMissing.length ? 'the agent box is not beside this server box (missing ' + agentMissing.map(file => path.relative(repo, file)).join(', ')
  + "): this test runs the agent's own code; run it on the server line, where agent/ sits next to platforms/" : false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-net-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KERNEL = { o11: '11.55.91', odc: '1.7.28', odcBridge: 'v35' };
const EXIT_A = '177.26.82.10', EXIT_B = '177.26.87.20';

async function hub(limits = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'dir-'));
  const events = [];
  const handle = await startHttpServer({ createServer: async () => new McpServer({ name: 'none', version: '1.0.0' }), dir, port: 0, allowRemote: true,
    agents: { kernel: KERNEL, limits: { sweepMs: 50, ...limits } }, log: e => events.push(e) });
  const issued = createTokenStore(dir).issue({ customer: 'Rede' });
  return { handle, events, issued, base: handle.url.replace(/\/mcp$/, ''), link: () => handle.hub.link(issued.id) };
}
const helloOf = kinds => ({ t: 'hello', protocol: 'ssam-agent/1', instance: randomUUID(),
  agent: { version: '0.2.1-test', node: process.version, platform: 'win32', startedAt: new Date().toISOString(), ...(kinds ? { kinds } : {}) },
  pack: { id: 'pack-test', lanes: ['odc', 'o11'], odcBridge: 'v35', o11BuiltFor: '11.55.91' }, studios: null, o11Connection: null });

// A relay of TCP connections to the hub with the X-Forwarded-For the proxy would add: every new probe connection leaves by
// the next exit of `exits` in turn, anything else by the first. On the lossy exit only the first `passBytes` of a connection
// reach the hub, then its bytes are accepted and dropped (no answer, no reset): small requests pass, large bodies stall.
async function twoExitRelay(targetPort, { exits = [EXIT_A, EXIT_B], lossy = EXIT_B, passBytes = 16384 } = {}) {
  let probes = 0;
  const open = new Set();
  const relay = { exits: [] };
  const server = net.createServer(client => {
    let head = Buffer.alloc(0), upstream = null, cut = false, forwarded = 0;
    open.add(client);
    client.on('error', () => {});
    client.on('close', () => { open.delete(client); upstream?.destroy(); });
    const send = bytes => {
      if (cut) { const room = passBytes - forwarded; if (room <= 0) return; bytes = bytes.subarray(0, room); }
      forwarded += bytes.length; upstream.write(bytes);
    };
    client.on('data', chunk => {
      if (upstream) return send(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n');
      if (end < 0) return;
      const probe = head.subarray(0, end).toString('latin1').startsWith('PUT /agent/v1/probe/');
      const exit = probe ? exits[probes++ % exits.length] : exits[0];
      if (probe) relay.exits.push(exit);
      cut = probe && exit === lossy;
      upstream = net.connect(targetPort, '127.0.0.1');
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => client.destroy());
      upstream.on('data', bytes => { if (!client.destroyed) client.write(bytes); });
      send(Buffer.concat([head.subarray(0, end + 2), Buffer.from('x-forwarded-for: ' + exit + '\r\n'), head.subarray(end + 2)]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  relay.url = 'http://127.0.0.1:' + server.address().port;
  relay.close = () => new Promise(resolve => { for (const c of open) c.destroy(); server.close(resolve); });
  return relay;
}

// The agent side the way agent.mjs runs a call (outbox, accepted, result), with the kind net.probe of net-probe.mjs and
// the agent's own channel over net.mjs. kinds: what its Hello lists (null: an agent before 0.2.0).
async function miniAgent(server, credential, { kinds = ['studio.processes', 'net.probe'] } = {}) {
  const { createChannel } = await agentLib('channel.mjs');
  const { createOutbox } = await agentLib('outbox.mjs');
  const { createHttp } = await agentLib('net.mjs');
  const { netProbe } = await agentLib('net-probe.mjs');
  const transport = createHttp();
  const outbox = createOutbox();
  let channel;
  const execute = async call => {
    try {
      if (call.kind !== 'net.probe') throw Object.assign(new Error('not here'), { code: 'KIND_NOT_ALLOWED' });
      return { t: 'result', id: call.id, ok: true, value: await netProbe(call.params, { put: (id, body, options) => channel.probePut(id, body, options) }) };
    } catch (error) { return { t: 'result', id: call.id, ok: false, error: { code: error.code ?? 'AGENT_ERROR', message: error.message, executed: false } }; }
  };
  const onCall = call => {
    const state = outbox.receive(call.id);
    channel.flush();
    if (state === 'new') execute(call).then(result => { outbox.finish(call.id, result); channel.flush(); });
  };
  channel = createChannel({ server, credential, hello: async () => helloOf(kinds), onCall, outbox, fetch: transport.fetch });
  const running = channel.run();
  for (let i = 0; i < 200 && !channel.connected(); i++) await sleep(20);
  assert.equal(channel.connected(), true, 'the mini agent connected');
  return { channel, transport, stop: async () => { await channel.stop(); transport.close(); await running; } };
}

test('hub: PUT /agent/v1/probe/<id> counts and discards the body, answers the exit (masked) and keeps a record taken once; size, id and channel checked', async t => {
  const h = await hub({ probeMaxBytes: 4096 });
  t.after(() => h.handle.close());
  assert.ok(CALL_KINDS.includes('net.probe'));
  const auth = { authorization: 'Bearer ' + h.issued.agentCredential };
  const welcome = await (await fetch(h.base + '/agent/v1/hello', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(helloOf(['net.probe'])) })).json();
  const put = (id, body, headers = {}, channel = welcome.channel) => fetch(h.base + '/agent/v1/probe/' + id + '?channel=' + channel, { method: 'PUT', headers: { ...auth, ...headers }, body });
  const id = randomBytes(16).toString('hex');
  const answer = await put(id, randomBytes(3000), { 'x-forwarded-for': EXIT_B + ', 10.0.0.1' });
  assert.equal(answer.status, 200);
  const value = await answer.json();
  assert.equal(value.ok, true); assert.equal(value.bytes, 3000); assert.equal(value.via, '177.26.87.x'); assert.ok(Number.isFinite(value.ms));
  const link = h.link();
  assert.equal(link.supports('net.probe'), true);
  const [record] = link.probes([id, 'f'.repeat(32)]);
  assert.equal(record.id, id); assert.equal(record.via, '177.26.87.x'); assert.equal(record.received, 3000); assert.equal(record.complete, true);
  assert.deepEqual(link.probes([id]), [], 'a record is taken once');
  assert.equal((await put(randomBytes(16).toString('hex'), randomBytes(5000))).status, 413);
  assert.equal((await put('xyz', randomBytes(10))).status, 400);
  assert.equal((await put(randomBytes(16).toString('hex'), randomBytes(10), {}, 'a'.repeat(32))).status, 404);
  assert.equal((await fetch(h.base + '/agent/v1/probe/' + id + '?channel=' + welcome.channel, { method: 'PUT', body: 'x' })).status, 401, 'the agent credential is required');
  assert.equal(maskAddress('::ffff:127.0.0.1'), '127.0.0.x');
  assert.equal(maskAddress('2804:14c:5b:1::2'), '2804:14c:5b::/48');
  assert.equal(maskAddress(''), null);
});

test('hub: a slow upload part is noted per token (agent.uploads, log agent-upload-slow); a fast one only counts', async t => {
  const h = await hub({ uploadSlowMs: 100 });
  t.after(() => h.handle.close());
  const auth = { authorization: 'Bearer ' + h.issued.agentCredential };
  const welcome = await (await fetch(h.base + '/agent/v1/hello', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(helloOf(null)) })).json();
  const part = (transfer, body, delayMs) => new Promise((resolve, reject) => {
    const { createHash } = globalThis.process.getBuiltinModule('node:crypto');
    const sha = createHash('sha256').update(body).digest('hex');
    const url = new URL(h.base + '/agent/v1/blobs/' + transfer + '/0?channel=' + welcome.channel);
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(`PUT ${url.pathname}${url.search} HTTP/1.1\r\nhost: ${url.host}\r\n${auth.authorization ? 'authorization: ' + auth.authorization + '\r\n' : ''}`
        + `x-forwarded-for: ${EXIT_B}\r\nx-ssam-part-sha256: ${sha}\r\nx-ssam-total-sha256: ${sha}\r\nx-ssam-total-size: ${body.length}\r\nx-ssam-parts: 1\r\n`
        + `content-length: ${body.length}\r\nconnection: close\r\n\r\n`);
      socket.write(body.subarray(0, 10));
      setTimeout(() => socket.write(body.subarray(10)), delayMs);
    });
    let reply = '';
    socket.on('data', c => { reply += c; });
    socket.on('end', () => resolve(reply.split(' ')[1]));
    socket.on('error', reject);
  });
  assert.equal(await part(randomBytes(16).toString('hex'), randomBytes(2000), 0), '204');
  assert.equal(await part(randomBytes(16).toString('hex'), randomBytes(2000), 1300), '204');
  const uploads = h.link().uploads();
  assert.equal(uploads.parts, 2);
  assert.equal(uploads.slow, 1);
  assert.equal(uploads.recent[0].via, '177.26.87.x');
  assert.ok(uploads.recent[0].ms >= 1200);
  assert.ok(h.events.some(e => e.event === 'agent-upload-slow' && e.via === '177.26.87.x'));
  const hint = uploadsHint(h.link());
  assert.equal(hint.code, 'UPLOADS_SLOW');
  assert.match(hint.message, /1 subida de arquivo do agente demorou nos últimos 30 min \(a pior: 2 KB em 1,\d s, pela saída 177\.26\.87\.x\)/);
  assert.deepEqual(hint.continuation, { tool: 'ssam_doctor', arguments: { network: true }, why: hint.continuation.why });
  assert.equal(slowUpload(60631, 26300), true, 'the production part of 60 KB in 26.3 s');
  assert.equal(slowUpload(60631, 750), false);
  assert.equal(slowUpload(2200000, 135800), true);
  assert.equal(slowUpload(3100000, 750), false);
});

test('summarizeProbes: per exit, in plain words: one exit loses packets, all good, slow, lossy everywhere, new connections lost', () => {
  const id = n => String(n).padStart(32, '0');
  const ok = (n, bytes, ms, via) => [{ id: id(n), bytes, ms, ok: true, status: 200 }, { id: id(n), via, received: bytes, complete: true, ms: Math.max(1, ms - 20) }];
  const stalled = (n, bytes, received, via) => [{ id: id(n), bytes, ms: 2700, ok: false, status: 0, error: 'budget' }, { id: id(n), via, received, complete: false, ms: 2600 }];
  const lost = (n, bytes) => [{ id: id(n), bytes, ms: 1800, ok: false, status: 0, error: 'budget' }, null];
  const of = rows => summarizeProbes(rows.map(r => r[0]), rows.map(r => r[1]).filter(Boolean));

  const oneExit = of([ok(1, 1024, 90, '177.26.82.x'), ok(2, 1024, 110, '177.26.87.x'), ok(3, 1024, 95, '177.26.82.x'), ok(4, 1024, 120, '177.26.87.x'),
    ok(5, 1048576, 700, '177.26.82.x'), stalled(6, 1048576, 14000, '177.26.87.x')]);
  assert.equal(oneExit.verdict, 'one-exit-lossy');
  assert.match(oneExit.message, /^uma das suas saídas de internet \(177\.26\.87\.x\) perde pacotes nas subidas: 1 de 3 envios por ela travaram; a outra, 177\.26\.82\.x \(subiu 1 MB em 700 ms\), está boa\./);
  assert.deepEqual(oneExit.paths.map(p => [p.via, p.status, p.uploads, p.ok, p.stalled]), [['177.26.82.x', 'boa', 3, 3, 0], ['177.26.87.x', 'perde', 3, 2, 1]]);

  const good = of([ok(1, 1024, 80, '127.0.0.x'), ok(2, 1024, 85, '127.0.0.x'), ok(3, 1048576, 400, '127.0.0.x')]);
  assert.equal(good.verdict, 'ok');
  assert.equal(good.message, 'subidas boas: 3 de 3 envios em conexão nova chegaram (pequenos em 80 ms, 1 MB em 400 ms).');
  const twoGood = of([ok(1, 1024, 80, '177.26.82.x'), ok(2, 1024, 85, '177.26.87.x')]);
  assert.match(twoGood.message, /a sua internet sai por 2 endereços \(177\.26\.82\.x, 177\.26\.87\.x\) e todos estão bons/);

  const slow = of([ok(1, 1024, 300, '10.1.2.x'), ok(2, 1048576, 4200, '10.1.2.x')]);
  assert.equal(slow.verdict, 'slow');
  assert.match(slow.message, /^a sua internet está lenta nas subidas: 10\.1\.2\.x \(subiu 1 MB em 4,2 s\)\. Nada travou/);

  const lossy = of([ok(1, 1024, 90, '10.1.2.x'), ok(2, 1024, 95, '10.1.2.x'), stalled(3, 1048576, 9000, '10.1.2.x'), stalled(4, 1048576, 0, '10.1.2.x')]);
  assert.equal(lossy.verdict, 'uploads-lossy');
  assert.match(lossy.message, /^a sua internet perde pacotes nas subidas: 2 de 4 envios em conexão nova chegaram ao servidor e travaram\./);

  const unreached = of([ok(1, 1024, 90, '10.1.2.x'), lost(2, 1024), lost(3, 1024), ok(4, 1024, 90, '10.1.2.x')]);
  assert.equal(unreached.verdict, 'new-connections-fail');
  assert.match(unreached.message, /^2 de 4 envios em conexão nova não chegaram ao servidor: a sua internet está perdendo conexões novas/);
  assert.equal(unreached.unreached, 2);

  // A large upload that moved at more than 32 KiB/s before its time ran out is slow, not stalled.
  const crawling = of([ok(1, 1024, 90, '10.1.2.x'), stalled(2, 1048576, 400000, '10.1.2.x')]);
  assert.equal(crawling.verdict, 'slow');
  assert.equal(of([]).verdict, 'no-probes');
});

test('networkCheck: never throws; an agent without the kind or not connected is told apart, and nothing is asked of it', async () => {
  const calls = [];
  const link = (over = {}) => ({ connected: () => true, info: () => ({ agentVersion: '0.2.1' }), supports: kind => kind !== 'net.probe',
    call: async (...args) => { calls.push(args); return {}; }, ...over });
  assert.deepEqual(await networkCheck(link({ connected: () => false })), { ran: false, code: 'AGENT_NOT_CONNECTED', message: 'o teste de rede roda pelo agente, que não está conectado agora' });
  const old = await networkCheck(link());
  assert.equal(old.code, 'AGENT_KIND_MISSING');
  assert.match(old.message, /o agente desta conta \(0\.2\.1\) ainda não faz o teste de rede/);
  assert.equal(calls.length, 0);
  const failing = await networkCheck(link({ supports: () => true, call: async () => { throw Object.assign(new Error('The agent did not answer net.probe before the deadline.'), { code: 'AGENT_TIMEOUT' }); } }));
  assert.deepEqual([failing.ran, failing.code], [false, 'AGENT_TIMEOUT']);
  const asked = [];
  const ran = await networkCheck(link({ supports: () => true, call: async (kind, params, options) => { asked.push({ kind, params, options }); return { probes: [{ id: 'a'.repeat(32), bytes: 1024, ms: 50, ok: true, status: 200 }] }; },
    probes: ids => ids.map(id => ({ id, via: '10.9.8.x', received: 1024, complete: true, ms: 40 })) }));
  assert.equal(ran.ran, true); assert.equal(ran.verdict, 'ok'); assert.equal(ran.paths[0].via, '10.9.8.x');
  assert.deepEqual(asked, [{ kind: 'net.probe', params: DEFAULT_PLAN, options: { timeoutMs: DEFAULT_PLAN.budgetMs + 5000 } }]);
});

test('ssam_doctor {network:true} (hosted): the check in network; without it, slow uploads add agent.uploads and the hint; ok unchanged; local: NOT_HOSTED', async t => {
  const workspace = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const probes = [];
  const link = { tokenId: 'tok_net', connected: () => true, supports: () => true,
    info: () => ({ connected: true, credential: true, instance: 'i', agentVersion: '0.2.1', kernel: KERNEL, compatible: {}, studios: null }),
    call: async (kind, params) => { probes.push({ kind, params }); return { probes: [{ id: 'b'.repeat(32), bytes: 1024, ms: 60, ok: true, status: 200 }] }; },
    probes: ids => ids.map(id => ({ id, via: '177.26.82.x', received: 1024, complete: true, ms: 50 })),
    uploads: () => ({ parts: 7, slow: 2, recent: [{ bytes: 60631, ms: 26300, via: '177.26.87.x', at: new Date().toISOString() }, { bytes: 75221, ms: 36600, via: '177.26.87.x', at: new Date().toISOString() }] }) };
  const context = { id: 'ctx-net', hosted: true, tokenId: 'tok_net', customer: 'Rede', lanes: [], workspace, agent: link,
    // servidor/fase4-26 (C): the call deadline runs in the customer's real context (runWithExecutor), which needs an executor
    // with call, as every hosted context has; this one runs no machine call.
    executor: { o11Connection: () => null, call: async kind => { throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); } },
    close: async () => {} };
  const plain = await hostedDoctor(null, { context, session: { agent: link } });
  assert.equal(probes.length, 0, 'no check without network:true');
  assert.deepEqual(plain.agent.uploads.slow, 2);
  assert.equal(plain.network.code, 'UPLOADS_SLOW');
  assert.match(plain.network.message, /2 subidas de arquivo do agente demoraram nos últimos 30 min \(a pior: 73 KB em 36,6 s, pela saída 177\.26\.87\.x\)/);
  assert.deepEqual(plain.network.continuation.arguments, { network: true });
  const server = await createSsamServer({ o11: false, odc: false, hosted: { context, session: { tokenId: 'tok_net', lanes: [], workspace, agent: link }, run: (ctx, fn) => fn() } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-network-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const doctor = (await client.callTool({ name: 'ssam_doctor', arguments: { network: true } })).structuredContent;
  assert.equal(probes.length, 1);
  assert.equal(doctor.network.ran, true);
  assert.equal(doctor.network.verdict, 'ok');
  assert.equal(doctor.ok, plain.ok, 'the check never changes ok');
  const local = await createSsamServer({ o11: false, odc: false, deps: { doctor: { lanes: { o11: async () => ({ lane: 'o11', ok: true, studio: { open: true } }), odc: async () => ({ lane: 'odc', ok: true, studio: { open: true } }) } } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const localClient = new Client({ name: 'local-network-test', version: '1.0.0' });
  await Promise.all([local.connect(a), localClient.connect(b)]);
  t.after(async () => { await localClient.close(); await local.close(); });
  const localDoctor = (await localClient.callTool({ name: 'ssam_doctor', arguments: { network: true } })).structuredContent;
  assert.equal(localDoctor.network.code, 'NOT_HOSTED');
});

test('end to end over the real hub: the agent\'s channel and net.mjs, every other new connection by a second exit that stalls large bodies: the doctor names the bad exit within about 5 s', { skip: agentSkip }, async t => {
  const h = await hub();
  t.after(() => h.handle.close());
  const relay = await twoExitRelay(Number(new URL(h.base).port));
  t.after(() => relay.close());
  const agent = await miniAgent(relay.url, h.issued.agentCredential);
  t.after(() => agent.stop());
  const started = Date.now();
  const result = await networkCheck(h.link());
  const elapsed = Date.now() - started;
  assert.equal(result.ran, true, JSON.stringify(result));
  assert.ok(elapsed < 6500, 'the check took ' + elapsed + ' ms');
  assert.deepEqual(relay.exits.filter((_, i) => i < 10), [EXIT_A, EXIT_B, EXIT_A, EXIT_B, EXIT_A, EXIT_B, EXIT_A, EXIT_B, EXIT_A, EXIT_B]);
  assert.equal(result.verdict, 'one-exit-lossy', JSON.stringify(result));
  assert.match(result.message, /^uma das suas saídas de internet \(177\.26\.87\.x\) perde pacotes nas subidas: 1 de 5 envios por ela travaram; a outra, 177\.26\.82\.x \(subiu 1 MB em [\d,]+ (ms|s)\), está boa\./);
  const byVia = Object.fromEntries(result.paths.map(p => [p.via, p]));
  assert.deepEqual([byVia['177.26.82.x'].status, byVia['177.26.82.x'].ok, byVia['177.26.82.x'].uploads], ['boa', 5, 5]);
  assert.deepEqual([byVia['177.26.87.x'].status, byVia['177.26.87.x'].ok, byVia['177.26.87.x'].stalled], ['perde', 4, 1]);
  // The same agent without the kind in its Hello is never asked.
  const old = await hub();
  t.after(() => old.handle.close());
  const before = await miniAgent(old.base, old.issued.agentCredential, { kinds: ['studio.processes'] });
  t.after(() => before.stop());
  assert.equal((await networkCheck(old.link())).code, 'AGENT_KIND_MISSING');
  assert.ok(!old.events.some(e => e.event === 'agent-call' && e.kind === 'net.probe'));
});

// With the kinds.mjs patch of this lane (C:\t\vel\patch-kinds.diff) the real agent runs the kind: the same check with
// createAgent. Skipped until kinds.mjs lists net.probe.
test('the real agent (createAgent) runs net.probe through the hub once kinds.mjs lists it', { skip: agentSkip }, async t => {
  const { KINDS } = await agentLib('kinds.mjs');
  if (!KINDS.includes('net.probe')) { t.skip('kinds.mjs does not list net.probe yet (patch-kinds.diff of fase4-24/vel-hosted)'); return; }
  const { createAgent } = await agentLib('agent.mjs');
  const h = await hub();
  t.after(() => h.handle.close());
  const root = fs.mkdtempSync(path.join(tmp, 'agent-'));
  for (const d of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private/authority']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-net', lanes: ['odc', 'o11'], odcBridge: 'v35', o11BuiltFor: '11.55.91', files: [] }));
  const agent = createAgent({ root, config: { server: h.base, credential: h.issued.agentCredential }, deps: { machine: null, processes: async () => [],
    locate: async () => null, fileVersion: async () => null } });
  const running = agent.run();
  t.after(async () => { await agent.stop(); await running; });
  for (let i = 0; i < 200 && !h.link().connected(); i++) await sleep(20);
  assert.equal(h.link().supports('net.probe'), true);
  const result = await networkCheck(h.link());
  assert.equal(result.ran, true, JSON.stringify(result));
  assert.equal(result.verdict, 'ok', JSON.stringify(result));
  assert.equal(result.uploads, 10);
});
