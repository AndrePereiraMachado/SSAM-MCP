// The agent channel of the hosted mode (agent-hub.mjs behind http-server.mjs; docs/FASE2-AGENTE.md sections 2, 3 and
// 7): hello/welcome and compatibility, calls over the NDJSON stream with accepted/result, delivery semantics
// (executed:false only when never written), resume and replacement by instance, death without POSTs, revoke and
// agent-rotate within a second, the 32-call cap, ids of other tokens, raw checks of channel/transfer/index before any
// file, blobs in parts with sha256 both ways, the inline limit measured on the serialized message, isolation between
// tokens, 413/429, and a hub session that never writes tokens.json. A fake agent speaks the protocol with fetch.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { startHttpServer } from '../http-server.mjs';
import { createTokenStore, tokenCli } from '../server-tokens.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compatibility, LIMITS, threePart, callVerbs, ENVIRONMENT_OPERATIONS } from '../agent-hub.mjs';
import { ODC_COMMANDS, O11_METHODS } from '../quality-line.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-hub-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => { const d = path.join(tmp, 'dir' + (++n)); fs.mkdirSync(d); return d; };
const hex = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KERNEL = { o11: '11.55.91', odc: '1.7.28', odcBridge: 'v35' };
const studios = (odc = '1.7.28.4021', o11 = '11.55.91.65012') => ({
  odc: { installed: odc ? { dir: 'C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio', version: odc } : null },
  o11: { installed: o11 ? { dir: 'C:\\Program Files\\OutSystems\\Service Studio 11\\Service Studio', version: o11 } : null } });
const helloOf = (over = {}) => ({ t: 'hello', protocol: 'ssam-agent/1', instance: randomUUID(),
  agent: { version: '0.1.0', node: process.version, platform: 'win32', startedAt: new Date().toISOString() },
  pack: { id: 'pack-test', lanes: ['odc', 'o11'], odcBridge: 'v35', o11BuiltFor: '11.55.91' },
  studios: studios(), o11Connection: null, ...over });

async function start(limits = {}, { kernel = KERNEL, ...options } = {}) {
  const dir = freshDir();
  const events = [];
  const handle = await startHttpServer({ createServer: async () => new McpServer({ name: 'none', version: '1.0.0' }), dir, port: 0,
    agents: { kernel, limits: { sweepMs: 50, ...limits } }, log: e => events.push(e), ...options });
  return { handle, dir, events, store: createTokenStore(dir), base: handle.url.replace(/\/mcp$/, ''), env: { SSAM_SERVER_DIR: dir } };
}

// An NDJSON reader over a fetch body: next(predicate) waits for the next matching line.
function ndjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const seen = []; let buffer = '', done = false, cursor = 0;
  const waiters = new Set();
  const notify = () => { for (const w of [...waiters]) w(); };
  const ended = (async () => {
    try {
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) seen.push(JSON.parse(line)); }
        notify();
      }
    } catch { /* cancelled */ }
    done = true; notify();
    return true;
  })();
  return {
    seen, ended,
    async next(predicate = () => true, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        while (cursor < seen.length) { const m = seen[cursor++]; if (predicate(m)) return m; }
        if (done) throw new Error('stream ended');
        const left = end - Date.now();
        if (left <= 0) throw new Error('timeout waiting for a stream line');
        await new Promise(r => { const t = setTimeout(w, left); function w() { waiters.delete(w); clearTimeout(t); r(); } waiters.add(w); });
      }
    },
    calls: () => seen.filter(m => m.t === 'call'),
    cancel() { reader.cancel().catch(() => {}); },
  };
}

// The fake agent: the HTTP side of ssam-agent/1 with fetch.
function agentOf(base, credential) {
  const authorization = 'Bearer ' + credential;
  const self = {
    channel: null,
    async hello(body = helloOf()) {
      const r = await fetch(base + '/agent/v1/hello', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      const json = await r.json().catch(() => null);
      if (r.status === 200) self.channel = json.channel;
      return { status: r.status, body: json };
    },
    async stream(channel = self.channel) {
      const r = await fetch(base + '/agent/v1/stream?channel=' + channel, { headers: { authorization } });
      if (r.status !== 200) return { status: r.status, body: await r.json().catch(() => null) };
      assert.match(r.headers.get('content-type'), /application\/x-ndjson/);
      return { status: 200, lines: ndjson(r) };
    },
    async post(messages, channel = self.channel) {
      const r = await fetch(base + '/agent/v1/messages?channel=' + channel, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
      await r.text();
      return r.status;
    },
    async put(transfer, index, bytes, { total, size, parts, partSha }, channel = self.channel) {
      const r = await fetch(base + '/agent/v1/blobs/' + transfer + '/' + index + '?channel=' + channel, { method: 'PUT', body: bytes,
        headers: { authorization, 'content-type': 'application/octet-stream', 'x-ssam-part-sha256': partSha ?? hex(bytes), 'x-ssam-total-sha256': total, 'x-ssam-total-size': String(size), 'x-ssam-parts': String(parts) } });
      return { status: r.status, body: r.status === 204 ? null : await r.json() };
    },
    async get(transfer, index, channel = self.channel) {
      const r = await fetch(base + '/agent/v1/blobs/' + transfer + '/' + index + '?channel=' + channel, { headers: { authorization } });
      const bytes = Buffer.from(await r.arrayBuffer());
      return { status: r.status, bytes, sha: r.headers.get('x-ssam-part-sha256') };
    },
    // Uploads bytes in parts (agent -> server) and returns the BlobRef.
    async upload(bytes, partBytes, { total = hex(bytes) } = {}) {
      const transfer = randomBytes(16).toString('hex');
      const parts = Math.max(1, Math.ceil(bytes.length / partBytes));
      for (let i = 0; i < parts; i++) {
        const put = await self.put(transfer, i, bytes.subarray(i * partBytes, (i + 1) * partBytes), { total, size: bytes.length, parts });
        assert.equal(put.status, 204, JSON.stringify(put.body));
      }
      return { transfer, sha256: total, size: bytes.length, parts, partBytes };
    },
    async download(ref) {
      const chunks = [];
      for (let i = 0; i < ref.parts; i++) { const got = await self.get(ref.transfer, i); assert.equal(got.status, 200); assert.equal(got.sha, hex(got.bytes)); chunks.push(got.bytes); }
      return Buffer.concat(chunks);
    },
  };
  return self;
}

// A request with a raw path (fetch would fold %2e%2e and ..).
const raw = (port, target, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: target, method, headers: { host: '127.0.0.1:' + port, ...headers } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject); req.end(body);
});
const settled = promise => promise.then(value => ({ value }), error => ({ error }));

test('hello answers welcome with the kernel and the compatibility per lane (equal, different, no Studio, stale pack, lane off)', async () => {
  const { handle, store, base } = await start();
  try {
    const full = store.issue({ customer: 'Cliente X' });
    const a = agentOf(base, full.agentCredential);
    const w = await a.hello();
    assert.equal(w.status, 200);
    assert.match(w.body.channel, /^[0-9a-f]{32}$/);
    assert.deepEqual({ ...w.body, channel: 'x' }, { t: 'welcome', channel: 'x', customer: 'Cliente X', resumed: false,
      heartbeatMs: LIMITS.heartbeatMs, deadAfterMs: LIMITS.deadAfterMs, maxMessageBytes: LIMITS.maxMessageBytes, inlineMaxBytes: LIMITS.inlineMaxBytes,
      partBytes: LIMITS.partBytes, maxFileBytes: LIMITS.maxFileBytes, maxValueBytes: LIMITS.maxValueBytes, kernel: KERNEL, compatible: { odc: { ok: true }, o11: { ok: true } } });
    assert.ok(LIMITS.maxValueBytes < LIMITS.maxFileBytes / 16, 'a value assembled in memory is capped far below a file');
    const info = handle.hub.link(full.id).info();
    assert.equal(info.connected, true); assert.equal(info.credential, true); assert.equal(info.agentVersion, '0.1.0');
    assert.deepEqual(info.lanes, ['odc', 'o11']); assert.deepEqual(info.kernel, KERNEL); assert.equal(typeof info.lastSeenAt, 'string');
    // Different version: the first three numbers decide.
    const different = (await a.hello(helloOf({ studios: studios('1.7.27.100') }))).body.compatible;
    assert.equal(different.odc.code, 'STUDIO_VERSION_MISMATCH');
    assert.match(different.odc.message, /ODC Studio 1\.7\.27\.100.*1\.7\.28/);
    assert.deepEqual(different.o11, { ok: true });
    // No Studio installed.
    assert.equal((await a.hello(helloOf({ studios: studios('1.7.28.1', null) }))).body.compatible.o11.code, 'STUDIO_NOT_INSTALLED');
    // A stale agent package: other ODC bridge, O11 bridge built for another Service Studio, a lane missing.
    const stale = (await a.hello(helloOf({ pack: { id: 'old', lanes: ['odc', 'o11'], odcBridge: 'v34', o11BuiltFor: '11.54.10' } }))).body.compatible;
    assert.equal(stale.odc.code, 'AGENT_PACK_MISMATCH'); assert.equal(stale.o11.code, 'AGENT_PACK_MISMATCH');
    assert.equal((await a.hello(helloOf({ pack: { id: 'odc', lanes: ['odc'], odcBridge: 'v35', o11BuiltFor: null } }))).body.compatible.o11.code, 'AGENT_PACK_MISMATCH');
    // A lane that is not in the token.
    const odcOnly = store.issue({ customer: 'So ODC', lanes: ['odc'] });
    const compat = (await agentOf(base, odcOnly.agentCredential).hello()).body.compatible;
    assert.deepEqual(compat.odc, { ok: true }); assert.equal(compat.o11.code, 'LANE_DISABLED');
    // Protocol and shape.
    assert.equal((await a.hello(helloOf({ protocol: 'ssam-agent/2' }))).status, 409);
    assert.equal((await a.hello(helloOf({ protocol: 'ssam-agent/2' }))).body.code, 'AGENT_PROTOCOL_UNSUPPORTED');
    assert.equal((await a.hello('{not json')).status, 400);
    assert.equal((await a.hello(helloOf({ instance: '../x' }))).status, 400);
    // The pure rule: no kernel for a lane, versions trimmed to three numbers.
    assert.equal(compatibility(helloOf(), { o11: null, odc: '1.7.28', odcBridge: 'v35' }, ['odc', 'o11']).o11.code, 'KERNEL_UNAVAILABLE');
    assert.equal(compatibility(helloOf(), { o11: '11.55.91.65012', odc: '1.7.28.4021', odcBridge: 'v35' }, ['odc', 'o11']).o11.ok, true);
    assert.equal(threePart('11.55.91.65012'), '11.55.91'); assert.equal(threePart('v35'), null);
    // The O11 hook of the package (docs/O11-BRIDGE-FINA.md 13): dev (or none, an older package) and h1 pass; an unknown
    // hook never does; kernel.json {"o11Hook":"h1"} accepts only the signed release hook.
    const withHook = o11Hook => helloOf({ pack: { id: 'p', lanes: ['odc', 'o11'], odcBridge: 'v35', o11BuiltFor: '11.55.91', o11Hook } });
    for (const hook of [undefined, 'dev', 'h1']) assert.deepEqual(compatibility(withHook(hook), KERNEL, ['odc', 'o11']).o11, { ok: true }, String(hook));
    assert.equal(compatibility(withHook('h2'), KERNEL, ['odc', 'o11']).o11.code, 'AGENT_PACK_MISMATCH');
    const releaseOnly = { ...KERNEL, o11Hook: 'h1' };
    assert.equal(compatibility(withHook('dev'), releaseOnly, ['odc', 'o11']).o11.code, 'AGENT_PACK_MISMATCH');
    assert.match(compatibility(withHook(undefined), releaseOnly, ['odc', 'o11']).o11.message, /only agent packages with the signed release hook h1/);
    assert.deepEqual(compatibility(withHook('h1'), releaseOnly, ['odc', 'o11']).o11, { ok: true });
    assert.deepEqual(compatibility(withHook('dev'), releaseOnly, ['odc', 'o11']).odc, { ok: true }, 'the ODC lane does not depend on the O11 hook');
  } finally { await handle.close(); }
});

// A-M1 + E1 (C:\t\multiver\minimo\PROPOSTA.md; docs/FASE2-AGENTE.md 7): the Studio is identified by its four-part build
// against the build the server serves (kernel.builds, from the image's Studio folder). Synthetic builds.
test('A-M1: the hub compares the four-part build; another build is served with studioBuildDiffers (warn, the default) or refused (refuse); another version is refused by direction before the package', async () => {
  const BUILT = { ...KERNEL, builds: { odc: '1.7.28.4021', o11: '11.55.91.65012' } };
  const { handle, store, base } = await start({}, { kernel: BUILT });
  try {
    const a = agentOf(base, store.issue({ customer: 'Build' }).agentCredential);
    const same = await a.hello();
    assert.deepEqual(same.body.compatible, { odc: { ok: true }, o11: { ok: true } }, 'the same build: nothing to say');
    assert.deepEqual(same.body.kernel, BUILT, 'the welcome names the served builds (agent 0.3.1 reads only kernel[lane], three numbers)');
    // another build of the same version: served with the warning, the default policy
    const differs = (await a.hello(helloOf({ studios: studios('1.7.28.4044') }))).body.compatible.odc;
    assert.equal(differs.ok, true);
    assert.equal(differs.warning.code, 'studioBuildDiffers');
    assert.deepEqual({ installed: differs.studio.installed, served: differs.studio.served, relation: differs.studio.relation, policy: differs.studio.policy },
      { installed: '1.7.28.4044', served: '1.7.28.4021', relation: 'build-differs', policy: 'warn' });
    // another version, newer or older: refused by direction, before any package check (a stale package changes nothing)
    const stalePack = { id: 'old', lanes: ['odc', 'o11'], odcBridge: 'v34', o11BuiltFor: '11.54.10' };
    const newer = (await a.hello(helloOf({ studios: studios('1.7.29.10'), pack: stalePack }))).body.compatible.odc;
    assert.equal(newer.code, 'AGENT_PACK_MISMATCH', 'newer Studio does not bypass the package check');
    const current = (await a.hello(helloOf({ studios: studios('1.7.29.10') }))).body.compatible.odc;
    assert.equal(current.ok, true);
    assert.equal(current.warning.code, 'studioNewerThanServed');
    const older = (await a.hello(helloOf({ studios: studios('1.7.27.100', '11.55.90.1') }))).body.compatible;
    assert.equal(older.odc.cause, 'STUDIO_UPDATE_REQUIRED'); assert.equal(older.o11.cause, 'STUDIO_UPDATE_REQUIRED');
    assert.match(older.odc.message, /Update ODC Studio and reconnect/);
  } finally { await handle.close(); }
  // kernel.json {"studioBuildPolicy":"refuse"}: another build is refused like another version, by direction
  const strict = await start({}, { kernel: { ...BUILT, studioBuildPolicy: 'refuse' } });
  try {
    const a = agentOf(strict.base, strict.store.issue({ customer: 'Estrito' }).agentCredential);
    const refused = (await a.hello(helloOf({ studios: studios('1.7.28.4044') }))).body.compatible.odc;
    assert.deepEqual({ ok: refused.ok, code: refused.code, cause: refused.cause, relation: refused.studio.relation, policy: refused.studio.policy },
      { ok: false, code: 'STUDIO_VERSION_MISMATCH', cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'build-differs', policy: 'refuse' });
    assert.equal((await a.hello(helloOf({ studios: studios('1.7.28.4000') }))).body.compatible.odc.cause, 'STUDIO_UPDATE_REQUIRED');
    assert.deepEqual((await a.hello()).body.compatible.odc, { ok: true });
    assert.deepEqual(strict.handle.hub.link(strict.store.list()[0].id).info().kernel.studioBuildPolicy, { odc: 'refuse', o11: 'refuse' });
  } finally { await strict.handle.close(); }
  // the pure rule, with a kernel that names no build (a server that does not know its own): three numbers, as before
  assert.deepEqual(compatibility(helloOf({ studios: studios('1.7.28.9999') }), KERNEL, ['odc', 'o11']).odc, { ok: true });
});

test('E1: agent-connected records the Studio versions (numbers only); studio-version-unserved names each refused Studio once, also after a pong', async () => {
  const BUILT = { ...KERNEL, builds: { odc: '1.7.28.4021', o11: '11.55.91.65012' } };
  const { handle, store, base, events } = await start({ heartbeatMs: 30 }, { kernel: BUILT });
  try {
    const t = store.issue({ customer: 'Eventos' });
    const a = agentOf(base, t.agentCredential);
    await a.hello(helloOf({ studios: studios('1.7.28.4044') }));
    const connected = events.find(e => e.event === 'agent-connected');
    assert.deepEqual(connected.studios, { odc: '1.7.28.4044', o11: '11.55.91.65012' });
    assert.equal(events.some(e => e.event === 'studio-version-unserved'), false, 'a build served with a warning is not a refusal');
    // a newer ODC Studio: one event; the same Hello again (a reconnection) does not repeat it
    await a.hello(helloOf({ studios: studios('1.7.29.10') }));
    await a.hello(helloOf({ studios: studios('1.7.29.10') }));
    const unserved = events.filter(e => e.event === 'studio-version-unserved');
    assert.deepEqual(unserved.map(({ time, ...e }) => e), [{ event: 'studio-version-unserved', token: t.id, lane: 'odc', installed: '1.7.29.10',
      served: '1.7.28.4021', relation: 'newer', cause: 'STUDIO_VERSION_NOT_SERVED_YET', policy: 'warn' }]);
    // the Studio changes while the agent stays connected (pong.versions): the change is judged and named at once
    const s = await a.stream();
    const ping = await s.lines.next(m => m.t === 'ping');
    await a.post([{ t: 'pong', seq: ping.seq, versions: { studios: studios('1.7.28.4021', '11.55.90.1'), o11Connection: null } }]);
    const link = handle.hub.link(t.id);
    assert.equal(link.info().compatible.o11.cause, 'STUDIO_UPDATE_REQUIRED');
    assert.deepEqual(link.info().compatible.odc, { ok: true });
    const last = events.filter(e => e.event === 'studio-version-unserved').at(-1);
    assert.deepEqual({ lane: last.lane, installed: last.installed, cause: last.cause }, { lane: 'o11', installed: '11.55.90.1', cause: 'STUDIO_UPDATE_REQUIRED' });
    s.lines.cancel();
    // privacy: ids and version numbers only, never the Studio folder, a credential, a token or an argument
    const text = JSON.stringify(events);
    for (const secret of ['Program Files', t.agentCredential, t.token, 'ssam_agent_']) assert.equal(text.includes(secret), false, secret);
  } finally { await handle.close(); }
});

test('a call arrives on the stream with a deadline and its result resolves link.call; an agent error keeps its fields', async () => {
  const { handle, store, base } = await start({ heartbeatMs: 60 });
  try {
    const t = store.issue({ customer: 'Chamada' });
    const a = agentOf(base, t.agentCredential);
    await a.hello();
    const s = await a.stream();
    assert.equal(s.status, 200);
    const ping = await s.lines.next(m => m.t === 'ping');
    assert.equal(typeof ping.seq, 'number'); assert.equal(typeof ping.at, 'number');
    const link = handle.hub.link(t.id);
    const before = Date.now();
    const pending = link.call('odc.pipe', { pid: 4120, version: 'v35', args: ['status', 'brief'] }, { timeoutMs: 5000 });
    const call = await s.lines.next(m => m.t === 'call');
    assert.match(call.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual({ kind: call.kind, params: call.params }, { kind: 'odc.pipe', params: { pid: 4120, version: 'v35', args: ['status', 'brief'] } });
    assert.ok(call.deadline >= before + 5000 && call.deadline <= Date.now() + 5000);
    assert.equal(await a.post([{ t: 'accepted', id: call.id }]), 204);
    assert.equal(await a.post([{ t: 'result', id: call.id, ok: true, value: { line: '{"ok":true,"bridge":"v35"}' } }]), 204);
    assert.deepEqual(await pending, { line: '{"ok":true,"bridge":"v35"}' });
    const failing = settled(link.call('o11.bridge', { method: 'ping', params: {} }));
    const second = await s.lines.next(m => m.t === 'call');
    await a.post([{ t: 'accepted', id: second.id }, { t: 'result', id: second.id, ok: false, error: { code: 'PIPE_ABSENT', message: 'not attached', sent: false } }]);
    const { error } = await failing;
    assert.deepEqual({ code: error.code, message: error.message, executed: error.executed, sent: error.sent, delivered: error.delivered },
      { code: 'PIPE_ABSENT', message: 'not attached', executed: null, sent: false, delivered: true });
    const refused = (await settled(link.call('shell.exec', {}))).error;
    assert.deepEqual({ code: refused.code, executed: refused.executed }, { code: 'KIND_NOT_ALLOWED', executed: false });
    s.lines.cancel();
  } finally { await handle.close(); }
});

test('executed:false only when the call was never written; written and unanswered is unknown (executed:null)', async () => {
  const { handle, store, base } = await start();
  try {
    const t = store.issue({ customer: 'Entrega' });
    const link = handle.hub.link(t.id);
    const none = (await settled(link.call('studio.processes', { image: 'ODCStudio.exe' }))).error;
    assert.deepEqual({ code: none.code, executed: none.executed, delivered: none.delivered }, { code: 'AGENT_NOT_CONNECTED', executed: false, delivered: false });
    const a = agentOf(base, t.agentCredential);
    await a.hello();
    // Channel without a stream: the call waits and never gets written.
    const undelivered = (await settled(link.call('studio.processes', { image: 'ODCStudio.exe' }, { timeoutMs: 150 }))).error;
    assert.deepEqual({ code: undelivered.code, executed: undelivered.executed, delivered: undelivered.delivered }, { code: 'AGENT_TIMEOUT', executed: false, delivered: false });
    const s = await a.stream();
    const accepted = settled(link.call('studio.processes', { image: 'ODCStudio.exe' }, { timeoutMs: 300 }));
    const call = await s.lines.next(m => m.t === 'call');
    assert.equal(await a.post([{ t: 'accepted', id: call.id }]), 204);
    const { error } = await accepted;
    assert.deepEqual({ code: error.code, executed: error.executed, delivered: error.delivered }, { code: 'AGENT_TIMEOUT', executed: null, delivered: true });
    assert.equal(s.lines.calls().length, 1, 'the timed-out call that was never written is gone, not written later');
    s.lines.cancel();
  } finally { await handle.close(); }
});

test('resume with the same instance rewrites only the never-accepted call, and a repeated result changes nothing', async () => {
  const { handle, store, base, events } = await start();
  try {
    const t = store.issue({ customer: 'Retoma' });
    const a = agentOf(base, t.agentCredential);
    const hello = helloOf();
    await a.hello(hello);
    const first = a.channel;
    const s1 = await a.stream();
    const link = handle.hub.link(t.id);
    let resolutions = 0;
    const pa = link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 5000 }).then(v => { resolutions++; return v; });
    const pb = link.call('odc.pipe', { args: ['assets'] }, { timeoutMs: 5000 }).then(v => { resolutions++; return v; });
    const ca = await s1.lines.next(m => m.t === 'call'), cb = await s1.lines.next(m => m.t === 'call');
    assert.equal(await a.post([{ t: 'accepted', id: ca.id }]), 204);
    s1.lines.cancel();
    const resumed = await a.hello({ ...hello });
    assert.equal(resumed.body.resumed, true);
    assert.notEqual(a.channel, first);
    assert.equal((await a.stream(first)).status, 404, 'the old channel is gone');
    const s2 = await a.stream();
    const again = await s2.lines.next(m => m.t === 'call');
    assert.equal(again.id, cb.id, 'only the call never accepted is written again');
    assert.equal(again.kind, cb.kind);
    await a.post([{ t: 'result', id: ca.id, ok: true, value: 'A' }, { t: 'result', id: cb.id, ok: true, value: 'B' }]);
    assert.deepEqual(await Promise.all([pa, pb]), ['A', 'B']);
    assert.equal(await a.post([{ t: 'result', id: ca.id, ok: true, value: 'A2' }, { t: 'accepted', id: cb.id }]), 204, 'a repeated result is answered 204');
    await sleep(50);
    assert.equal(resolutions, 2);
    assert.equal(s2.lines.calls().length, 1);
    assert.ok(events.some(e => e.event === 'agent-unknown-id' && e.token === t.id));
    s2.lines.cancel();
  } finally { await handle.close(); }
});

test('a new instance replaces the old one: close replaced, the old pending calls fail AGENT_DISCONNECTED', async () => {
  const { handle, store, base } = await start();
  try {
    const t = store.issue({ customer: 'Substitui' });
    const old = agentOf(base, t.agentCredential);
    await old.hello();
    const oldChannel = old.channel;
    const s1 = await old.stream();
    const link = handle.hub.link(t.id);
    const written = settled(link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 5000 }));
    await s1.lines.next(m => m.t === 'call');
    const fresh = agentOf(base, t.agentCredential);
    const w = await fresh.hello();
    assert.equal(w.body.resumed, false);
    const close = await s1.lines.next(m => m.t === 'close');
    assert.equal(close.reason, 'replaced');
    assert.equal(await s1.lines.ended, true);
    const { error } = await written;
    assert.deepEqual({ code: error.code, executed: error.executed }, { code: 'AGENT_DISCONNECTED', executed: null });
    assert.equal((await old.stream(oldChannel)).status, 404);
    assert.equal(await old.post([{ t: 'pong', seq: 1 }], oldChannel), 404);
    assert.equal(link.connected(), true, 'the new instance is the channel now');
  } finally { await handle.close(); }
});

test('a channel without any POST for deadAfterMs dies; a pong keeps it alive; the same instance resumes the pending call', async () => {
  const { handle, store, base, events } = await start({ heartbeatMs: 40, deadAfterMs: 250 });
  try {
    const t = store.issue({ customer: 'Silencio' });
    const a = agentOf(base, t.agentCredential);
    const hello = helloOf();
    await a.hello(hello);
    const s1 = await a.stream();
    const link = handle.hub.link(t.id);
    for (let i = 0; i < 5; i++) { const ping = await s1.lines.next(m => m.t === 'ping'); assert.equal(await a.post([{ t: 'pong', seq: ping.seq }]), 204); await sleep(70); }
    assert.equal(link.connected(), true, 'alive while it answers');
    const pending = link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 5000 });
    const call = await s1.lines.next(m => m.t === 'call');
    const started = Date.now();
    assert.equal(await s1.lines.ended, true, 'the server ended the stream');
    assert.ok(Date.now() - started < 1500);
    assert.ok(!s1.lines.seen.some(m => m.t === 'close'), 'no Close: the agent reconnects');
    assert.equal(link.connected(), false);
    // C03 (servidor/fase4): the agent was seen a moment ago, so a new call waits for its Hello instead of failing at once.
    const waiting = link.call('odc.pipe', { args: ['status', 'brief'] }, { timeoutMs: 5000 });
    assert.ok(events.some(e => e.event === 'agent-dead'));
    const resumed = await a.hello({ ...hello });
    assert.equal(resumed.body.resumed, true);
    const s2 = await a.stream();
    const again = await s2.lines.next(m => m.t === 'call' && m.id === call.id);
    const later = await s2.lines.next(m => m.t === 'call' && m.id !== call.id);
    assert.deepEqual(later.params.args, ['status', 'brief']);
    await a.post([{ t: 'result', id: again.id, ok: true, value: 7 }, { t: 'result', id: later.id, ok: true, value: 8 }]);
    assert.equal(await pending, 7);
    assert.equal(await waiting, 8);
    s2.lines.cancel();
  } finally { await handle.close(); }
});

test('revoke closes the stream, rejects pending calls with AGENT_REVOKED and the next request gets 403, within 1 s', async () => {
  const { handle, store, base, env } = await start({ sweepMs: LIMITS.sweepMs });
  try {
    const t = store.issue({ customer: 'Revogado' });
    const a = agentOf(base, t.agentCredential);
    await a.hello();
    const s = await a.stream();
    const link = handle.hub.link(t.id);
    const closed = [];
    link.onClose(reason => closed.push(reason));
    const written = settled(link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 10000 }));
    await s.lines.next(m => m.t === 'call');
    const queued = settled(link.call('odc.pipe', { args: ['assets'] }, { timeoutMs: 10000 }));
    const started = Date.now();
    tokenCli(['revoke', '--id', t.id], { root: tmp, env });
    const close = await s.lines.next(m => m.t === 'close', 1500);
    assert.equal(close.reason, 'revoked');
    assert.equal(await s.lines.ended, true);
    const [w, q] = await Promise.all([written, queued]);
    assert.equal(w.error.code, 'AGENT_REVOKED'); assert.equal(q.error.code, 'AGENT_REVOKED');
    const next = await a.hello();
    assert.equal(next.status, 403); assert.equal(next.body.code, 'AGENT_REVOKED');
    assert.ok(Date.now() - started <= 1000, 'all within 1 s: ' + (Date.now() - started) + ' ms');
    assert.deepEqual(closed, ['revoked']);
    assert.equal(link.connected(), false);
  } finally { await handle.close(); }
});

test('agent-rotate closes the channel with close rotated within 1 s and the old credential then gets 401', async () => {
  const { handle, store, base, env } = await start({ sweepMs: LIMITS.sweepMs });
  try {
    const t = store.issue({ customer: 'Troca' });
    const a = agentOf(base, t.agentCredential);
    await a.hello();
    const s = await a.stream();
    const link = handle.hub.link(t.id);
    const closed = [];
    link.onClose(reason => closed.push(reason));
    const written = settled(link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 10000 }));
    await s.lines.next(m => m.t === 'call');
    const started = Date.now();
    const rotated = tokenCli(['agent-rotate', '--id', t.id], { root: tmp, env });
    const close = await s.lines.next(m => m.t === 'close', 1500);
    assert.equal(close.reason, 'rotated');
    assert.equal(await s.lines.ended, true);
    assert.ok(Date.now() - started <= 1000, 'within 1 s: ' + (Date.now() - started) + ' ms');
    const { error } = await written;
    assert.deepEqual({ code: error.code, executed: error.executed }, { code: 'AGENT_DISCONNECTED', executed: null });
    const stale = await a.hello();
    assert.equal(stale.status, 401); assert.equal(stale.body.code, 'AGENT_CREDENTIAL_UNKNOWN');
    const renewed = await agentOf(base, rotated.agentCredential).hello();
    assert.equal(renewed.status, 200);
    assert.deepEqual(closed, [], 'a rotation does not end the token');
  } finally { await handle.close(); }
});

test('the 33rd pending call of a token fails at once with AGENT_BUSY (executed:false)', async () => {
  const { handle, store, base } = await start();
  try {
    const t = store.issue({ customer: 'Ocupado' });
    await agentOf(base, t.agentCredential).hello();
    const link = handle.hub.link(t.id);
    const pending = Array.from({ length: 32 }, () => settled(link.call('studio.processes', { image: 'ServiceStudio.exe' }, { timeoutMs: 30000 })));
    const busy = (await settled(link.call('studio.processes', { image: 'ServiceStudio.exe' }))).error;
    assert.deepEqual({ code: busy.code, executed: busy.executed, delivered: busy.delivered }, { code: 'AGENT_BUSY', executed: false, delivered: false });
    await handle.close();
    const ends = await Promise.all(pending);
    assert.ok(ends.every(e => e.error?.code === 'AGENT_DISCONNECTED' && e.error.executed === false), 'server stop fails them, never written');
  } finally { await handle.close(); }
});

test('accepted or result with an unknown id or an id of another token is ignored (204) and logged', async () => {
  const { handle, store, base, events } = await start();
  try {
    const ta = store.issue({ customer: 'Alfa' }), tb = store.issue({ customer: 'Beta' });
    const a = agentOf(base, ta.agentCredential), b = agentOf(base, tb.agentCredential);
    await a.hello(); await b.hello();
    const sa = await a.stream();
    let done = false;
    const pending = handle.hub.link(ta.id).call('odc.pipe', { args: ['status'] }, { timeoutMs: 5000 }).then(v => { done = true; return v; });
    const call = await sa.lines.next(m => m.t === 'call');
    assert.equal(await b.post([{ t: 'accepted', id: call.id }, { t: 'result', id: call.id, ok: true, value: 'forged' }]), 204);
    assert.equal(await a.post([{ t: 'result', id: randomUUID(), ok: true, value: 'nobody' }, { t: 'result', id: 42, ok: true }]), 204);
    await sleep(50);
    assert.equal(done, false, 'another token cannot settle it');
    assert.ok(events.some(e => e.event === 'agent-unknown-id' && e.token === tb.id));
    assert.ok(!JSON.stringify(events).includes('forged'), 'the log has no values');
    await a.post([{ t: 'result', id: call.id, ok: true, value: 'real' }]);
    assert.equal(await pending, 'real');
    sa.lines.cancel();
  } finally { await handle.close(); }
});

test('a bad transfer id, an encoded ".." or an index >= parts is 400 TRANSFER_INVALID and creates no file', async () => {
  const { handle, store, base, dir } = await start({ partBytes: 1024 });
  try {
    const t = store.issue({ customer: 'Caminhos' });
    const a = agentOf(base, t.agentCredential);
    await a.hello();
    const ch = a.channel;
    const good = randomBytes(16).toString('hex');
    const headers = { authorization: 'Bearer ' + t.agentCredential, 'x-ssam-part-sha256': hex(Buffer.from('x')), 'x-ssam-total-sha256': hex(Buffer.from('x')), 'x-ssam-total-size': '1', 'x-ssam-parts': '1' };
    const bad = ['/agent/v1/blobs/not-hex/0', '/agent/v1/blobs/%2e%2e/0', '/agent/v1/blobs/' + good + '/%2e%2e', '/agent/v1/blobs/..%2F..%2Ftokens.json/0',
      '/agent/v1/blobs/' + good.toUpperCase() + '/0', '/agent/v1/blobs/' + good + '/01', '/agent/v1/blobs/' + good + '/-1', '/agent/v1/blobs/' + good + '/1', '/agent/v1/blobs/' + good + '/9999999'];
    for (const target of bad) for (const method of ['PUT', 'GET']) {
      const r = await raw(handle.port, target + '?channel=' + ch, { method, headers, body: method === 'PUT' ? 'x' : undefined });
      if (method === 'GET' && target.endsWith('/1')) { assert.equal(r.status, 404, target); continue; } // a well-formed id never registered
      assert.equal(r.status, 400, method + ' ' + target + ' ' + r.text);
      assert.equal(JSON.parse(r.text).code, 'TRANSFER_INVALID');
    }
    // A raw channel value is never decoded either.
    const encoded = ch.replace(/^./, c => '%' + c.charCodeAt(0).toString(16));
    assert.equal((await raw(handle.port, '/agent/v1/stream?channel=' + encoded, { headers })).status, 404);
    // index >= parts of a registered download.
    const src = path.join(dir, 'src.bin'); fs.writeFileSync(src, randomBytes(1500));
    const ref = await handle.hub.link(t.id).putFile(src);
    assert.equal(ref.parts, 2);
    const over = await raw(handle.port, '/agent/v1/blobs/' + ref.transfer + '/2?channel=' + ch, { headers });
    assert.equal(over.status, 400); assert.equal(JSON.parse(over.text).code, 'TRANSFER_INVALID');
    assert.equal(fs.existsSync(path.join(dir, 'customers')), false, 'no file nor folder was created');
  } finally { await handle.close(); }
});

test('blobs: upload in parts with per-part check, bad part 400, assembled hash mismatch, download in parts', async () => {
  const { handle, store, base, dir } = await start({ partBytes: 1024 });
  try {
    const t = store.issue({ customer: 'Blobs' });
    const a = agentOf(base, t.agentCredential);
    await a.hello();
    const s = await a.stream();
    const link = handle.hub.link(t.id);
    const transfers = path.join(dir, 'customers', t.id, 'state', 'transfers');
    // Agent -> server: file.get answers a BlobRef; receiveBlob assembles, verifies and writes atomically.
    const content = randomBytes(2500);
    const getting = link.call('file.get', { path: 'agent:odc/snapshots/M.oml' }, { timeoutMs: 5000 });
    const call = await s.lines.next(m => m.t === 'call');
    const ref = await a.upload(content, 1024);
    assert.equal(ref.parts, 3);
    assert.equal((await a.put(ref.transfer, 1, content.subarray(1024, 2048), { total: ref.sha256, size: 2500, parts: 3 })).status, 204, 'the same part again is idempotent');
    const other = Buffer.alloc(1024, 7);
    const conflict = await a.put(ref.transfer, 1, other, { total: ref.sha256, size: 2500, parts: 3 });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'TRANSFER_CONFLICT');
    await a.post([{ t: 'accepted', id: call.id }, { t: 'result', id: call.id, ok: true, value: { path: 'agent:odc/snapshots/M.oml', blob: ref } }]);
    const value = await getting;
    const dest = path.join(dir, 'customers', t.id, 'odc', 'snapshots', 'M.oml');
    assert.deepEqual(await link.receiveBlob(value.blob, dest), { sha256: hex(content), size: 2500 });
    assert.ok(fs.readFileSync(dest).equals(content));
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['M.oml'], 'no temporary file left');
    assert.equal(fs.existsSync(path.join(transfers, ref.transfer)), false, 'parts removed after assembly');
    await assert.rejects(link.receiveBlob(value.blob, dest + '2'), e => e.code === 'TRANSFER_INVALID', 'a transfer is assembled once');
    // A part whose bytes do not match its sha256: 400 and nothing written.
    const wrong = randomBytes(16).toString('hex');
    const badPart = await a.put(wrong, 0, Buffer.from('hello'), { total: hex(Buffer.from('hello')), size: 5, parts: 1, partSha: hex(Buffer.from('jello')) });
    assert.equal(badPart.status, 400); assert.equal(badPart.body.code, 'PART_HASH_MISMATCH');
    assert.equal(fs.existsSync(path.join(transfers, wrong)), false);
    const shortPart = await a.put(wrong, 0, Buffer.from('hell'), { total: hex(Buffer.from('hello')), size: 5, parts: 1 });
    assert.equal(shortPart.status, 400); assert.equal(shortPart.body.code, 'TRANSFER_INVALID');
    // Every part right, the whole file not: BLOB_HASH_MISMATCH and no destination.
    const lying = await a.upload(randomBytes(1500), 1024, { total: hex(Buffer.from('another file')) });
    const target = path.join(dir, 'customers', t.id, 'odc', 'snapshots', 'L.oml');
    await assert.rejects(link.receiveBlob(lying, target), e => e.code === 'BLOB_HASH_MISMATCH');
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['M.oml']);
    // Server -> agent: putFile registers the file; the agent downloads each part with its sha256.
    const src = path.join(dir, 'candidate.oml'); const bytes = randomBytes(2100); fs.writeFileSync(src, bytes);
    const down = await link.putFile(src);
    assert.deepEqual({ ...down, transfer: 'x' }, { transfer: 'x', sha256: hex(bytes), size: 2100, parts: 3, partBytes: 1024 });
    assert.ok((await a.download(down)).equals(bytes));
    await assert.rejects(link.putFile(path.join(dir, 'missing.oml')), e => e.code === 'FILE_NOT_FOUND');
    s.lines.cancel();
  } finally { await handle.close(); }
});

test('a call or value that exceeds inlineMaxBytes only once serialized (escapes, non-ASCII) travels as a blob', async () => {
  const { handle, store, base } = await start({ inlineMaxBytes: 4096, partBytes: 1024 });
  try {
    const t = store.issue({ customer: 'Inline' });
    const a = agentOf(base, t.agentCredential);
    await a.hello();
    const s = await a.stream();
    const link = handle.hub.link(t.id);
    for (const text of ['"'.repeat(2100), '\u00e9'.repeat(2100)]) {
      assert.ok(text.length < 4096);
      const params = { pid: 1, version: 'v35', args: ['portal-call', text] };
      const pending = link.call('odc.pipe', params, { timeoutMs: 5000 });
      const call = await s.lines.next(m => m.t === 'call');
      assert.equal(call.params, undefined, 'no inline params');
      assert.equal(call.paramsBlob.partBytes, 1024);
      assert.deepEqual(JSON.parse((await a.download(call.paramsBlob)).toString('utf8')), params);
      // The answer: a value over the limit once serialized goes back as valueBlob.
      const value = { line: JSON.stringify({ ok: true, text }) };
      const ref = await a.upload(Buffer.from(JSON.stringify(value), 'utf8'), 1024);
      await a.post([{ t: 'accepted', id: call.id }, { t: 'result', id: call.id, ok: true, valueBlob: ref }]);
      assert.deepEqual(await pending, value);
      assert.equal((await a.get(call.paramsBlob.transfer, 0)).status, 404, 'the params blob is released with the call');
    }
    const small = link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 5000 });
    const inline = await s.lines.next(m => m.t === 'call');
    assert.deepEqual(inline.params, { args: ['status'] });
    await a.post([{ t: 'result', id: inline.id, ok: true, value: null }]);
    assert.equal(await small, null);
    // A value blob that does not match: the call fails as delivered with an unknown outcome.
    const bad = settled(link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 5000 }));
    const third = await s.lines.next(m => m.t === 'call');
    const lie = await a.upload(Buffer.from('{"a":1}'), 1024, { total: hex(Buffer.from('{"a":2}')) });
    await a.post([{ t: 'result', id: third.id, ok: true, valueBlob: lie }]);
    const { error } = await bad;
    assert.deepEqual({ code: error.code, executed: error.executed, delivered: error.delivered }, { code: 'BLOB_HASH_MISMATCH', executed: null, delivered: true });
    s.lines.cancel();
  } finally { await handle.close(); }
});

test('a value blob above maxValueBytes is refused before any part is read; a late result frees the uploads it names', async () => {
  const { handle, store, base, dir } = await start({ inlineMaxBytes: 1024, partBytes: 1024, maxValueBytes: 4096, maxTransfers: 2 });
  try {
    const t = store.issue({ customer: 'Valor' });
    const a = agentOf(base, t.agentCredential);
    await a.hello();
    const s = await a.stream();
    const link = handle.hub.link(t.id);
    const transfers = path.join(dir, 'customers', t.id, 'state', 'transfers');
    const reads = [];
    const readFile = fs.promises.readFile;
    fs.promises.readFile = async (file, ...rest) => { if (String(file).startsWith(transfers)) reads.push(file); return readFile(file, ...rest); };
    try {
      // A modified agent answers with a value of 5000 bytes (allowed as a file, not as a value).
      const big = settled(link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 5000 }));
      const call = await s.lines.next(m => m.t === 'call');
      const ref = await a.upload(Buffer.from(JSON.stringify({ line: 'x'.repeat(4980) })), 1024);
      assert.equal(ref.size > 4096, true);
      await a.post([{ t: 'result', id: call.id, ok: true, valueBlob: ref }]);
      const { error } = await big;
      assert.deepEqual({ code: error.code, executed: error.executed, delivered: error.delivered }, { code: 'VALUE_TOO_LARGE', executed: null, delivered: true });
      assert.deepEqual(reads, [], 'no part was read');
      assert.equal(fs.existsSync(path.join(transfers, ref.transfer)), false, 'the parts are removed');
      // A value at the cap still resolves.
      const fits = link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 5000 });
      const second = await s.lines.next(m => m.t === 'call');
      const value = { line: 'y'.repeat(2000) };
      await a.post([{ t: 'result', id: second.id, ok: true, valueBlob: await a.upload(Buffer.from(JSON.stringify(value)), 1024) }]);
      assert.deepEqual(await fits, value);
    } finally { fs.promises.readFile = readFile; }
    // Late results (their call already gone): the uploads they name do not keep the 2 upload slots.
    for (let i = 0; i < 3; i++) {
      const late = await a.upload(Buffer.from(JSON.stringify({ line: 'z'.repeat(1500) })), 1024);
      const blob = await a.upload(Buffer.from('file bytes ' + i), 1024);
      assert.equal(await a.post([{ t: 'result', id: randomUUID(), ok: true, valueBlob: late }, { t: 'result', id: randomUUID(), ok: true, value: { path: 'agent:odc/lab/x', blob } }]), 204);
      assert.equal(fs.existsSync(path.join(transfers, late.transfer)), false);
      assert.equal(fs.existsSync(path.join(transfers, blob.transfer)), false);
    }
    s.lines.cancel();
  } finally { await handle.close(); }
});

test('a channel or a transfer of another token answers 404, like one that never existed', async () => {
  const { handle, store, base, dir } = await start({ partBytes: 1024 });
  try {
    const ta = store.issue({ customer: 'Alfa' }), tb = store.issue({ customer: 'Beta' });
    const a = agentOf(base, ta.agentCredential), b = agentOf(base, tb.agentCredential);
    await a.hello(); await b.hello();
    const theirs = (await b.stream(a.channel));
    assert.equal(theirs.status, 404); assert.equal(theirs.body.code, 'CHANNEL_UNKNOWN');
    assert.equal(await b.post([{ t: 'pong', seq: 1 }], a.channel), 404);
    const bytes = Buffer.from('payload');
    assert.equal((await b.put(randomBytes(16).toString('hex'), 0, bytes, { total: hex(bytes), size: bytes.length, parts: 1 }, a.channel)).status, 404);
    const src = path.join(dir, 'a.bin'); fs.writeFileSync(src, bytes);
    const ref = await handle.hub.link(ta.id).putFile(src);
    assert.equal((await b.get(ref.transfer, 0)).status, 404, "another token's download");
    assert.equal((await a.get(ref.transfer, 0)).status, 200);
    const up = await a.upload(bytes, 1024);
    await assert.rejects(handle.hub.link(tb.id).receiveBlob(up, path.join(dir, 'x.bin')), e => e.code === 'TRANSFER_INVALID', "another token's upload");
    const deleted = await fetch(base + '/agent/v1/channel?channel=' + a.channel, { method: 'DELETE', headers: { authorization: 'Bearer ' + tb.agentCredential } });
    assert.equal(deleted.status, 404);
    assert.equal(handle.hub.link(ta.id).connected(), true);
  } finally { await handle.close(); }
});

test('413 for a body over maxMessageBytes or a part over partBytes; 429 past the agent rate limit, per token', async () => {
  const sized = await start({ maxMessageBytes: 2048, partBytes: 1024 });
  try {
    const t = sized.store.issue({ customer: 'Grande' });
    const a = agentOf(sized.base, t.agentCredential);
    const huge = await a.hello(helloOf({ agent: { version: 'x'.repeat(3000) } }));
    assert.equal(huge.status, 413); assert.equal(huge.body.code, 'MESSAGE_TOO_LARGE');
    assert.equal((await a.hello()).status, 200);
    assert.equal(await a.post([{ t: 'pong', seq: 1, versions: { pad: 'y'.repeat(3000) } }]), 413);
    const part = Buffer.alloc(1025, 1);
    const big = await a.put(randomBytes(16).toString('hex'), 0, part, { total: hex(Buffer.alloc(5000)), size: 5000, parts: 5 });
    assert.equal(big.status, 413); assert.equal(big.body.code, 'MESSAGE_TOO_LARGE');
  } finally { await sized.handle.close(); }
  const limited = await start({ ratePerMinute: 5 });
  try {
    const t = limited.store.issue({ customer: 'Rapido' }), other = limited.store.issue({ customer: 'Calmo' });
    const a = agentOf(limited.base, t.agentCredential);
    for (let i = 0; i < 5; i++) assert.equal((await a.hello()).status, 200);
    const r = await fetch(limited.base + '/agent/v1/hello', { method: 'POST', headers: { authorization: 'Bearer ' + t.agentCredential }, body: JSON.stringify(helloOf()) });
    assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) >= 1); assert.equal((await r.json()).code, 'RATE_LIMITED');
    assert.equal((await agentOf(limited.base, other.agentCredential).hello()).status, 200, 'another token has its own budget');
  } finally { await limited.handle.close(); }
});

test('a clean shutdown, a protocol error and a server stop end the channel as specified', async () => {
  const { handle, store, base } = await start();
  try {
    const t = store.issue({ customer: 'Fim' });
    const a = agentOf(base, t.agentCredential);
    const hello = helloOf();
    await a.hello(hello);
    let s = await a.stream();
    const link = handle.hub.link(t.id);
    // protocolError: Close protocol-error; the pending call waits for the resume.
    const pending = link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 5000 });
    const call = await s.lines.next(m => m.t === 'call');
    link.protocolError('agent path outside the rules');
    assert.equal((await s.lines.next(m => m.t === 'close')).reason, 'protocol-error');
    assert.equal(link.connected(), false);
    await a.hello({ ...hello });
    s = await a.stream();
    assert.equal((await s.lines.next(m => m.t === 'call')).id, call.id);
    await a.post([{ t: 'result', id: call.id, ok: true, value: 1 }]);
    assert.equal(await pending, 1);
    // DELETE /agent/v1/channel: the instance is gone, so its pending calls fail.
    const orphan = settled(link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 5000 }));
    await s.lines.next(m => m.t === 'call');
    const deleted = await fetch(base + '/agent/v1/channel?channel=' + a.channel, { method: 'DELETE', headers: { authorization: 'Bearer ' + t.agentCredential } });
    assert.equal(deleted.status, 204);
    assert.equal((await orphan).error.code, 'AGENT_DISCONNECTED');
    assert.equal(link.connected(), false);
    assert.equal((await a.stream()).status, 404);
    // Server stop: Close server-stop and onClose('server-stop').
    await a.hello();
    s = await a.stream();
    const closed = [];
    link.onClose(reason => closed.push(reason));
    await handle.close();
    assert.equal((await s.lines.next(m => m.t === 'close')).reason, 'server-stop');
    assert.deepEqual(closed, ['server-stop']);
  } finally { await handle.close(); }
});

test('a full hub session leaves tokens.json with the same content and mtime', async () => {
  const { handle, store, base, dir } = await start({ partBytes: 1024, heartbeatMs: 30 });
  try {
    const t = store.issue({ customer: 'Intacto' });
    const file = path.join(dir, 'tokens.json');
    const before = { text: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs };
    const a = agentOf(base, t.agentCredential);
    await a.hello();
    const s = await a.stream();
    const link = handle.hub.link(t.id);
    const ping = await s.lines.next(m => m.t === 'ping');
    await a.post([{ t: 'pong', seq: ping.seq, versions: { studios: studios('1.7.28.5000'), o11Connection: null } }]);
    const getting = link.call('file.get', { path: 'agent:o11/x.oml' }, { timeoutMs: 5000 });
    const call = await s.lines.next(m => m.t === 'call');
    const ref = await a.upload(randomBytes(3000), 1024);
    await a.post([{ t: 'accepted', id: call.id }, { t: 'result', id: call.id, ok: true, value: { blob: ref } }]);
    await link.receiveBlob((await getting).blob, path.join(dir, 'customers', t.id, 'o11', 'x.oml'));
    const src = path.join(dir, 'up.bin'); fs.writeFileSync(src, randomBytes(2000));
    await a.download(await link.putFile(src));
    assert.equal(link.info().studios.odc.installed.version, '1.7.28.5000', 'pong.versions updates the info in memory');
    assert.equal(typeof link.info().lastSeenAt, 'string');
    await fetch(base + '/agent/v1/channel?channel=' + a.channel, { method: 'DELETE', headers: { authorization: 'Bearer ' + t.agentCredential } });
    s.lines.cancel();
    await sleep(120);
    assert.equal(fs.readFileSync(file, 'utf8'), before.text);
    assert.equal(fs.statSync(file).mtimeMs, before.mtime);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('lastSeenAt'));
  } finally { await handle.close(); }
});

// ---- C03 of the atritos 3 package (servidor/fase4): the channel survives a stuck POST, a dead stream and a reconnection.
test('C03: a result posted on the previous channel of the same instance resolves its call (no 404, no reconnection cycle)', async () => {
  const { handle, store, base, events } = await start();
  try {
    const t = store.issue({ customer: 'Anterior' });
    const a = agentOf(base, t.agentCredential);
    const hello = helloOf();
    await a.hello(hello);
    const s1 = await a.stream();
    const link = handle.hub.link(t.id);
    const pending = link.call('studio.processes', { image: 'ODCStudio.exe' });
    const call = await s1.lines.next(m => m.t === 'call');
    assert.equal(await a.post([{ t: 'accepted', id: call.id }]), 204);
    const old = a.channel;
    // The agent reconnects (same instance) while the result of the call is still on its way on the old channel.
    await a.hello({ ...hello });
    assert.notEqual(a.channel, old);
    assert.equal(await a.post([{ t: 'result', id: call.id, ok: true, value: { processes: [] } }], old), 204, 'the previous channel still takes it');
    assert.deepEqual(await pending, { processes: [] });
    assert.equal(await a.post([{ t: 'pong', seq: 1 }], 'f'.repeat(32)), 404, 'any other channel is unknown');
    assert.ok(events.some(e => e.event === 'agent-call' && e.kind === 'studio.processes' && e.ok === true && Number.isFinite(e.ms)));
    s1.lines.cancel();
  } finally { await handle.close(); }
});

test('C03: a call written and not accepted in acceptMs closes the stream; written again on the resumed stream, it resolves with one grace period', async () => {
  const { handle, store, base, events } = await start({ acceptMs: 200, reconnectGraceMs: 3000 });
  try {
    const t = store.issue({ customer: 'Mudo' });
    const a = agentOf(base, t.agentCredential);
    const hello = helloOf();
    await a.hello(hello);
    const s1 = await a.stream();
    const link = handle.hub.link(t.id);
    const started = Date.now();
    const pending = link.call('odc.pipe', { args: ['status'] }, { timeoutMs: 1500 });
    const call = await s1.lines.next(m => m.t === 'call');
    assert.equal(await s1.lines.ended, true, 'the stream of a call nobody accepted is closed');
    assert.ok(Date.now() - started < 1400, 'well before the call deadline');
    assert.ok(events.some(e => e.event === 'agent-call-unaccepted' && e.kind === 'odc.pipe'));
    await a.hello({ ...hello });
    const s2 = await a.stream();
    assert.equal((await s2.lines.next(m => m.t === 'call')).id, call.id, 'written again on the resumed stream');
    await sleep(1600 - (Date.now() - started)); // past the original deadline: the grace period holds the call
    assert.equal(await a.post([{ t: 'accepted', id: call.id }, { t: 'result', id: call.id, ok: true, value: 'ok' }]), 204);
    assert.equal(await pending, 'ok');
    s2.lines.cancel();
  } finally { await handle.close(); }
});

test('C03: a call while a recently seen agent reconnects waits for its Hello; without one in reconnectWaitMs it is AGENT_RECONNECTING with retryAfterSeconds; a clean stop answers AGENT_NOT_CONNECTED at once', async () => {
  const { handle, store, base } = await start({ heartbeatMs: 40, deadAfterMs: 200, reconnectWaitMs: 300 });
  try {
    const t = store.issue({ customer: 'Volta' });
    const a = agentOf(base, t.agentCredential);
    const hello = helloOf();
    await a.hello(hello);
    const s1 = await a.stream();
    const link = handle.hub.link(t.id);
    assert.equal(await s1.lines.ended, true, 'no POST: the channel dies');
    assert.equal(link.connected(), false);
    let started = Date.now();
    const late = await settled(link.call('studio.processes', { image: 'ODCStudio.exe' }));
    assert.equal(late.error.code, 'AGENT_RECONNECTING');
    assert.equal(late.error.executed, false);
    assert.equal(late.error.retryAfterSeconds, 15);
    assert.equal(late.error.continuation.tool, 'ssam_doctor');
    // B3 (round 3 of studio-build-identity, owner rule of 2026-10-15): every text SSAM emits is English
    assert.match(late.error.continuation.why, /^the agent reconnects by itself: repeat the same call in 15 s/);
    assert.ok(Date.now() - started >= 280, 'it waited for the Hello first');
    // The Hello comes while a call waits: the call runs.
    const waiting = link.call('studio.processes', { image: 'ODCStudio.exe' });
    await sleep(50);
    await a.hello({ ...hello });
    const s2 = await a.stream();
    const call = await s2.lines.next(m => m.t === 'call');
    await a.post([{ t: 'result', id: call.id, ok: true, value: 1 }]);
    assert.equal(await waiting, 1);
    // A clean stop: the instance is gone, nothing to wait for.
    const r = await fetch(base + '/agent/v1/channel?channel=' + a.channel, { method: 'DELETE', headers: { authorization: 'Bearer ' + t.agentCredential } });
    assert.equal(r.status, 204);
    started = Date.now();
    assert.equal((await settled(link.call('studio.processes', { image: 'ODCStudio.exe' }))).error.code, 'AGENT_NOT_CONNECTED');
    assert.ok(Date.now() - started < 200);
    assert.equal(link.supports('file.sync'), false, 'an agent before 0.2.0 does not run file.sync');
    s2.lines.cancel();
  } finally { await handle.close(); }
});

test('C26 and C14: the Hello of an agent 0.2.0 gives its folder and its kinds (info.agentRoot, supports file.sync)', async () => {
  const { handle, store, base } = await start();
  try {
    const t = store.issue({ customer: 'Pasta' });
    const a = agentOf(base, t.agentCredential);
    await a.hello(helloOf({ agent: { version: '0.2.0', node: process.version, platform: 'win32', startedAt: new Date().toISOString(), root: 'C:\\SSAM-Agent',
      kinds: ['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected', 'file.put', 'file.get', 'file.list', 'file.sync'] } }));
    const link = handle.hub.link(t.id);
    assert.equal(link.info().agentRoot, 'C:\\SSAM-Agent');
    assert.equal(link.supports('file.sync'), true);
  } finally { await handle.close(); }
});
test('machine alert: the first machine is recorded, another one still connects and is alerted, no machine is not judged', async () => {
  process.env.SSAM_ACCESS_NOTIFY = '0';
  const { handle, store, base, dir, events } = await start();
  try {
    const t = store.issue({ customer: 'Pino' });
    const machine = (id, name) => ({ version: '0.2.0', node: process.version, platform: 'win32', startedAt: new Date().toISOString(), machine: { id, name, user: 'u' } });
    assert.equal((await agentOf(base, t.agentCredential).hello(helloOf({ agent: machine('aaaa', 'PC-1') }))).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'machine-pins.json'), 'utf8'))[t.id].id, 'aaaa');
    assert.equal((await agentOf(base, t.agentCredential).hello(helloOf({ agent: machine('aaaa', 'PC-1') }))).status, 200, 'same machine again');
    assert.ok(!events.some(e => e.event === 'agent-machine-changed'), 'no alert for the same machine');
    assert.equal((await agentOf(base, t.agentCredential).hello(helloOf({ agent: machine('bbbb', 'PC-2') }))).status, 200, 'another machine still connects');
    assert.ok(events.some(e => e.event === 'agent-machine-changed' && e.machine.name === 'PC-2' && e.first.name === 'PC-1'));
    const alerts = fs.readFileSync(path.join(dir, 'access-alerts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(alerts.length, 1); assert.equal(alerts[0].customer, 'Pino');
    assert.equal((await agentOf(base, t.agentCredential).hello(helloOf())).status, 200, 'an agent without machine (older pack) passes');
  } finally { await handle.close(); }
});

// The verbs that name an agent call (log and quality) come only from closed lists, never from their shape: the command of
// studio_command is the model's own text. The pipe commands and bridge methods are the agent's (agent/lib/kinds.mjs), kept in
// the ssam-quality/1 contract; the environment operations are the kernel's. Drift tests compare each list with its source.
test('callVerbs: only the closed lists name an agent call', () => {
  assert.deepEqual(callVerbs('odc.pipe', { args: ['snapshot', 'SntlModuloQx7'] }), { command: 'snapshot' });
  assert.deepEqual(callVerbs('odc.pipe', { args: ['publish-status'] }), { command: 'publish-status' });
  for (const args of [['acme-folha-pagamento-sntl'], ['sntl-cmd'], ['attach'], ['Snapshot'], [], 'snapshot', [7], undefined])
    assert.deepEqual(callVerbs('odc.pipe', { args }), {}, JSON.stringify(args));
  assert.deepEqual(callVerbs('o11.bridge', { method: 'open_module', params: { module: 'SntlModuloQx7' } }), { method: 'open_module' });
  assert.deepEqual(callVerbs('o11.bridge', { method: 'sntl_method', params: { operation: 'download' } }), {});
  assert.deepEqual(callVerbs('o11.bridge', { method: 'export_modules' }), {}, 'a full-bridge method the agent refuses');
  assert.deepEqual(callVerbs('o11.bridge', { method: 'environment_session', params: { operation: 'download' } }), { method: 'environment_session', operation: 'download' });
  assert.deepEqual(callVerbs('o11.bridge', { method: 'environment_session', params: { operation: 'sntl-op' } }), { method: 'environment_session' });
  assert.deepEqual(callVerbs('o11.bridge', { method: 'open_module', params: { operation: 'download' } }), { method: 'open_module' });
  assert.deepEqual(callVerbs('file.get', { path: 'agent:inbox/sntl.json' }), {});
  assert.deepEqual(callVerbs('odc.pipe', null), {});
  assert.ok(Object.isFrozen(ENVIRONMENT_OPERATIONS));
});

const AGENT_KINDS_FILE = fileURLToPath(new URL('../../../../agent/lib/kinds.mjs', import.meta.url));
test("drift: the pipe commands and bridge methods of the contract are the agent's own lists", { skip: !fs.existsSync(AGENT_KINDS_FILE) && 'agent/ is not in this checkout' }, async () => {
  const kinds = await import(pathToFileURL(AGENT_KINDS_FILE).href);
  assert.deepEqual([...ODC_COMMANDS], [...kinds.ODC_COMMANDS]);
  assert.deepEqual([...O11_METHODS], [...kinds.O11_METHODS]);
});

// The string values of a C# array initializer "Names = [ ... ];": literals, and constants of this file (Name) or of a class
// of the same folder (Class.Name).
function csharpNames(file) {
  const text = fs.readFileSync(file, 'utf8');
  const block = /\bNames\s*=\s*\[([\s\S]*?)\];/.exec(text);
  assert.ok(block, 'no Names block in ' + file);
  const constant = (source, name) => {
    const m = new RegExp('const\\s+string\\s+' + name + '\\s*=\\s*"([^"]+)"').exec(source);
    assert.ok(m, 'constant ' + name + ' not found');
    return m[1];
  };
  return block[1].replace(/\/\/[^\n]*/g, '').split(',').map(s => s.trim()).filter(Boolean).map(item => {
    const literal = /^"([^"]+)"$/.exec(item);
    if (literal) return literal[1];
    const [owner, name] = item.includes('.') ? item.split('.') : [null, item];
    return constant(owner ? fs.readFileSync(path.join(path.dirname(file), owner + '.cs'), 'utf8') : text, name);
  });
}
const KERNEL_SRC = fileURLToPath(new URL('../../../../kernel/src/', import.meta.url));
const ENVIRONMENT_FILE = path.join(KERNEL_SRC, 'Anvil.Core', 'Adapters.SS11', 'EnvironmentOperations.cs');
test("drift: the environment operations are connect, close and the kernel's EnvironmentOperations.Names (the thin bridge's are a part)",
  { skip: !fs.existsSync(ENVIRONMENT_FILE) && 'kernel/src is not in this checkout' }, () => {
  assert.deepEqual([...ENVIRONMENT_OPERATIONS], ['connect', 'close', ...csharpNames(ENVIRONMENT_FILE)]);
  const handler = path.join(KERNEL_SRC, 'Anvil.Bridge', 'EnvironmentSessionHandler.cs');
  if (fs.existsSync(handler)) for (const word of ['connect', 'close']) assert.ok(fs.readFileSync(handler, 'utf8').includes('operation == "' + word + '"'), word);
  const thin = path.join(KERNEL_SRC, 'Anvil.Bridge.Thin', 'EnvironmentPrimitives.cs');
  if (fs.existsSync(thin)) for (const name of csharpNames(thin)) assert.ok(ENVIRONMENT_OPERATIONS.includes(name), 'thin bridge operation ' + name);
});

// Quality (docs/QUALIDADE.md, design ssam-quality/1 2.7 and 3.4): every settled call reaches onCallSettled (wired by
// http-server.mjs to the recorder's agentSpan) with its kind, its protocol verb (the bridge method, the pipe command), when
// it started, how long it took, its outcome, the bytes it moved when known and the tool call that made it (the
// quality-meter call context; null for a call made outside one, as the O11 relay's). Never an argument or a value.
test('quality: a settled call reports kind, verb, times, outcome, size and the tool call that made it; the log names the pipe command', async () => {
  const { withCall } = await import('../quality-meter.mjs');
  const spans = [];
  const quality = { agentSpan: span => spans.push(span), arrived() {}, flushed() {}, sessionOpened() {}, sessionClosed() {}, callStarted() {}, callCancelled() {}, callAnswered() {} };
  const { handle, store, base, events } = await start({}, { quality });
  try {
    const t = store.issue({ customer: 'Qualidade' });
    const a = agentOf(base, t.agentCredential);
    await a.hello();
    const s = await a.stream();
    const link = handle.hub.link(t.id);
    const key = 'mcp-session\u0000"7"';
    const pipe = withCall(key, () => link.call('odc.pipe', { args: ['snapshot', 'SntlModuloQx7'], version: 'v35' }));
    const bridge = link.call('o11.bridge', { method: 'open_module', params: { module: 'SntlModuloQx7' } }).then(() => null, error => error);
    const put = withCall(key, () => link.call('file.put', { path: 'agent:odc/sntl.oml', blob: { transfer: 'a'.repeat(32), sha256: 'b'.repeat(64), size: 1234, parts: 1 } }));
    const get = withCall(key, () => link.call('file.get', { path: 'agent:inbox/sntl.json' }));
    const calls = [];
    for (let i = 0; i < 4; i++) calls.push(await s.lines.next(m => m.t === 'call'));
    const of = kind => calls.find(c => c.kind === kind);
    await sleep(20);
    assert.equal(await a.post([
      { t: 'accepted', id: of('odc.pipe').id }, { t: 'result', id: of('odc.pipe').id, ok: true, value: { ok: true, path: 'C:\\sntl\\x.oml' } },
      { t: 'result', id: of('o11.bridge').id, ok: false, error: { code: 'BRIDGE_ERROR', message: 'sntl message', executed: true } },
      { t: 'result', id: of('file.put').id, ok: true, value: { path: 'agent:odc/sntl.oml' } },
      { t: 'result', id: of('file.get').id, ok: true, value: { path: 'agent:inbox/sntl.json', blob: { transfer: 'c'.repeat(32), sha256: 'd'.repeat(64), size: 4567, parts: 1 } } }]), 204);
    await pipe; await put; await get;
    assert.equal((await bridge)?.code, 'BRIDGE_ERROR');
    const byKind = Object.fromEntries(spans.map(sp => [sp.kind, sp]));
    assert.deepEqual(Object.keys(byKind).sort(), ['file.get', 'file.put', 'o11.bridge', 'odc.pipe']);
    for (const sp of spans) {
      assert.equal(sp.tokenId, t.id);
      assert.ok(Number.isFinite(sp.startMs) && Math.abs(sp.startMs - Date.now()) < 60000, 'epoch start');
      assert.ok(Number.isFinite(sp.ms) && sp.ms >= 15, 'the time until it settled');
    }
    assert.deepEqual({ ...byKind['odc.pipe'], startMs: 0, ms: 0 }, { tokenId: t.id, kind: 'odc.pipe', verb: 'snapshot', startMs: 0, ms: 0, ok: true, code: null, callKey: key });
    assert.deepEqual({ ...byKind['o11.bridge'], startMs: 0, ms: 0 }, { tokenId: t.id, kind: 'o11.bridge', verb: 'open_module', startMs: 0, ms: 0, ok: false, code: 'BRIDGE_ERROR', callKey: null });
    assert.equal(byKind['file.put'].bytes, 1234); assert.equal(byKind['file.put'].callKey, key); assert.equal(byKind['file.put'].verb, null);
    assert.equal(byKind['file.get'].bytes, 4567);
    assert.ok(events.some(e => e.event === 'agent-call' && e.kind === 'odc.pipe' && e.command === 'snapshot'), 'the log names the pipe command');
    assert.ok(!JSON.stringify(spans).includes('sntl') && !JSON.stringify(spans).includes('Sntl'), 'no argument or value in a span');
    assert.ok(!JSON.stringify(events.filter(e => e.event === 'agent-call')).toLowerCase().includes('sntl'), 'nor in the log line');
    // Verb-shaped words outside the closed lists (privacy finding of 2026-10-12: the model's own text as the command of
    // studio_command reached the span and the agent-call line): a pipe command the agent refuses (COMMAND_NOT_ALLOWED), an
    // unlisted bridge method and an unlisted environment operation name nothing; a listed operation is still named.
    const seen = spans.length;
    const freePipe = withCall(key, () => link.call('odc.pipe', { args: ['sntl-cmd'], version: 'v35' })).then(() => null, error => error);
    const freeMethod = withCall(key, () => link.call('o11.bridge', { method: 'sntl_method', params: {} })).then(() => null, error => error);
    const freeOperation = link.call('o11.bridge', { method: 'environment_session', params: { operation: 'sntl-op', lease: 'l1' } }).then(() => null, error => error);
    const listed = link.call('o11.bridge', { method: 'environment_session', params: { operation: 'modules', lease: 'l1' } });
    const more = [];
    for (let i = 0; i < 4; i++) more.push(await s.lines.next(m => m.t === 'call'));
    const which = c => (c.kind === 'odc.pipe' ? 'pipe' : c.params?.method === 'sntl_method' ? 'method' : c.params?.params?.operation === 'modules' ? 'listed' : 'operation');
    const id = name => more.find(c => which(c) === name).id;
    assert.equal(await a.post([
      { t: 'result', id: id('pipe'), ok: false, error: { code: 'COMMAND_NOT_ALLOWED', message: 'The ODC bridge command "sntl-cmd" is not allowed on this agent', executed: false } },
      { t: 'result', id: id('method'), ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'The O11 bridge method "sntl_method" is not allowed on this agent', executed: false } },
      { t: 'result', id: id('operation'), ok: false, error: { code: 'BRIDGE_ERROR', message: 'Unknown environment operation: sntl-op', executed: true } },
      { t: 'result', id: id('listed'), ok: true, value: { reply: { success: true, data: { modules: [] } } } }]), 204);
    assert.equal((await freePipe)?.code, 'COMMAND_NOT_ALLOWED'); assert.equal((await freeMethod)?.code, 'METHOD_NOT_ALLOWED');
    assert.equal((await freeOperation)?.code, 'BRIDGE_ERROR'); await listed;
    const added = spans.slice(seen).map(sp => [sp.kind, sp.verb, sp.code, sp.callKey]);
    assert.deepEqual(added.map(e => JSON.stringify(e)).sort(), [['o11.bridge', 'environment_session', 'BRIDGE_ERROR', null], ['o11.bridge', 'environment_session', null, null],
      ['o11.bridge', null, 'METHOD_NOT_ALLOWED', key], ['odc.pipe', null, 'COMMAND_NOT_ALLOWED', key]].map(e => JSON.stringify(e)).sort());
    const callLines = events.filter(e => e.event === 'agent-call');
    assert.ok(!JSON.stringify(spans).toLowerCase().includes('sntl'), 'no free word in a span');
    assert.ok(!JSON.stringify(callLines).toLowerCase().includes('sntl'), 'no free word in the log: ' + JSON.stringify(callLines.slice(-4)));
    assert.ok(callLines.some(e => e.kind === 'odc.pipe' && e.code === 'COMMAND_NOT_ALLOWED' && !Object.hasOwn(e, 'command')), 'the refused pipe call is logged without a command');
    assert.ok(callLines.some(e => e.kind === 'o11.bridge' && e.code === 'METHOD_NOT_ALLOWED' && !Object.hasOwn(e, 'method')), 'the refused bridge call without a method');
    assert.ok(callLines.some(e => e.method === 'environment_session' && e.code === 'BRIDGE_ERROR' && !Object.hasOwn(e, 'operation')), 'an unlisted operation is not named');
    assert.ok(callLines.some(e => e.method === 'environment_session' && e.operation === 'modules' && e.ok === true), 'a listed operation is still named');
    // A failure before any answer (the deadline) is reported too, with its code.
    const late = withCall(key, () => link.call('studio.processes', {}, { timeoutMs: 100 }));
    await assert.rejects(late, e => e.code === 'AGENT_TIMEOUT');
    const timeout = spans.find(sp => sp.kind === 'studio.processes');
    assert.deepEqual([timeout.ok, timeout.code, timeout.callKey], [false, 'AGENT_TIMEOUT', key]);
    s.lines.cancel();
  } finally { await handle.close(); }
});
test('window detection persists a new Studio even when the agent package is refused', async () => {
  const {handle,store,base,dir,events} = await start();
  try {
    const account = store.issue({customer:'Window detection'});
    const a = agentOf(base, account.agentCredential);
    const welcome = await a.hello(helloOf({studios:studios('1.7.30.1'),pack:{lanes:['odc'],odcBridge:'v0'}}));
    assert.equal(welcome.body.compatible.odc.code,'AGENT_PACK_MISMATCH');
    const data = JSON.parse(fs.readFileSync(path.join(dir,'state','studio-versions.json'),'utf8'));
    assert.deepEqual(data.unserved.odc['1.7.30'].tokens,[account.id]);
    assert.ok(events.some(e=>e.event==='studio-version-unserved' && e.installed==='1.7.30.1'));
    const raw=JSON.stringify(data);
    assert.equal(raw.includes(account.token),false);
    assert.equal(raw.includes(account.agentCredential),false);
    assert.equal(raw.includes('Program Files'),false);
  } finally { await handle.close(); }
});
