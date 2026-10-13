// The channel against a fake hub (docs/FASE2-AGENTE.md 2, 3): hello, stream, call -> accepted -> result, pong,
// reconnection with an injected clock, the stops (401/403/409, close replaced/rotated/...), the outbox (a lost POST
// never makes a call run twice; the result is sent again after reconnecting until a 204) and blobs both ways.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAgent } from '../lib/agent.mjs';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { makeRoot, removeRoot, CREDENTIAL } from './fixtures/agent-root.mjs';

const PROCESSES = { 'ODCStudio.exe': [{ pid: 4120, path: 'C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio\\ODCStudio.exe', version: '1.7.28.4021' }] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, ms = 5000) {
  for (const deadline = Date.now() + ms; !check(); await sleep(5)) if (Date.now() > deadline) throw new Error('condition not met in ' + ms + ' ms');
}
// Real timers, shortened (the 45 s dead timer stays as it is): reconnections and POST retries take milliseconds.
const fast = (fn, ms) => setTimeout(fn, ms >= 45000 ? ms : Math.min(ms, 25));
const live = new Set();
afterEach(async () => { for (const agent of live) await agent.stop(); live.clear(); });

function agentFor(root, hub, deps = {}) {
  const agent = createAgent({ root, config: { server: hub.url, credential: CREDENTIAL },
    deps: { processes: async image => PROCESSES[image] ?? [], fileVersion: async () => null, locate: async () => null, setTimeout: fast, sleep: async () => {}, ...deps } });
  live.add(agent);
  return agent;
}

// A manual clock: timers are recorded and fired by the test.
function fakeClock() {
  const timers = []; const waiters = [];
  const clock = {
    t: 1_000_000, timers,
    now: () => clock.t,
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); for (const waiter of [...waiters]) waiter(); return timer; },
    clearTimeout: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    fire: timer => { clock.clearTimeout(timer); timer.fn(); },
    next: (match, ms = 5000) => new Promise((resolve, reject) => {
      const limit = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error('no matching timer')); }, ms);
      const check = () => { const found = timers.find(match); if (!found) return; waiters.splice(waiters.indexOf(check), 1); clearTimeout(limit); resolve(found); };
      waiters.push(check); check();
    }),
  };
  return clock;
}

test('hello, stream, call -> accepted -> result, pong, clean stop', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    const agent = agentFor(root, hub);
    const running = agent.run();
    await hub.until(() => hub.streams === 1);
    const [hello] = hub.hellos;
    assert.equal(hello.t, 'hello'); assert.equal(hello.protocol, 'ssam-agent/1');
    assert.match(hello.instance, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(hello.instance, agent.instance);
    assert.deepEqual(hello.pack, { id: 'pack-test', lanes: ['odc', 'o11'], odcBridge: 'v35', o11BuiltFor: '11.55.91', o11Hook: null });
    assert.deepEqual(hello.studios, { odc: { installed: null }, o11: { installed: null } });
    assert.equal(hello.o11Connection, null);
    assert.equal(hello.agent.platform, process.platform); assert.equal(hello.agent.node, process.version);

    hub.send({ t: 'call', id: 'call-1', kind: 'studio.processes', params: { image: 'ODCStudio.exe' }, deadline: Date.now() + 60000 });
    await hub.until(() => hub.results('call-1').length === 1);
    const accepted = hub.messages.findIndex(m => m.t === 'accepted' && m.id === 'call-1');
    const result = hub.messages.findIndex(m => m.t === 'result' && m.id === 'call-1');
    assert.ok(accepted >= 0 && accepted < result, 'accepted goes before the result');
    assert.deepEqual(hub.messages[result].value, { processes: [{ pid: 4120, path: PROCESSES['ODCStudio.exe'][0].path, version: '1.7.28.4021' }] });

    hub.send({ t: 'call', id: 'call-2', kind: 'agent.info', params: {} });
    await hub.until(() => hub.results('call-2').length === 1);
    assert.deepEqual(hub.results('call-2')[0].error, { code: 'KIND_NOT_ALLOWED', message: 'The SSAM agent does not run "agent.info"', executed: false });

    hub.send({ t: 'ping', seq: 7, at: Date.now() });
    await hub.until(() => hub.messages.some(m => m.t === 'pong' && m.seq === 7));
    assert.equal(hub.messages.find(m => m.t === 'pong').versions, undefined, 'versions only when they changed');
    await waitFor(() => agent.outbox.tracked === 0);

    await agent.stop();
    assert.equal(await running, 0);
    assert.equal(hub.deletes, 1);
  } finally { await hub.close(); removeRoot(root); }
});

test('the Hello carries the O11 connection while that Service Studio still runs', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    fs.writeFileSync(path.join(root, 'private', 'o11-connection.json'), JSON.stringify({ ok: true, pid: 6000, startedUtc: 'S', port: 4516, studioVersion: '11.55.91.1', connectedAt: 'x' }));
    const agent = agentFor(root, hub, { processes: async image => (image === 'ServiceStudio.exe' ? [{ pid: 6000, path: 'C:\\SS\\ServiceStudio.exe', version: '11.55.91.1' }] : []) });
    const running = agent.run();
    await hub.until(() => hub.streams === 1);
    assert.deepEqual(hub.hellos[0].o11Connection, { pid: 6000, startedUtc: 'S', port: 4516, studioVersion: '11.55.91.1' });
    await agent.stop(); await running;
    const closed = agentFor(root, hub, { processes: async () => [] });
    const again = closed.run();
    await hub.until(() => hub.streams === 2);
    assert.equal(hub.hellos[1].o11Connection, null);
    await closed.stop(); await again;
  } finally { await hub.close(); removeRoot(root); }
});

test('401 and 403 stop with 2, 409 with 4, without reconnecting', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    for (const [status, code] of [[403, 2], [401, 2], [409, 4]]) {
      const before = hub.hellos.length;
      hub.helloStatus.push(status);
      assert.equal(await agentFor(root, hub).run(), code);
      await sleep(100);
      assert.equal(hub.hellos.length, before + 1);
    }
    // A wrong credential is a plain 401 from the hub.
    const stranger = createAgent({ root, config: { server: hub.url, credential: 'ssam_agent_' + 'x'.repeat(43) }, deps: { locate: async () => null, processes: async () => [] } });
    assert.equal(await stranger.run(), 2);
  } finally { await hub.close(); removeRoot(root); }
});

test('close replaced (3), rotated/revoked/expired (2) end the agent; protocol-error and server-stop reconnect', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    for (const [reason, code] of [['replaced', 3], ['rotated', 2], ['revoked', 2], ['expired', 2]]) {
      const agent = agentFor(root, hub);
      const streams = hub.streams;
      const running = agent.run();
      await hub.until(() => hub.streams === streams + 1);
      const hellos = hub.hellos.length;
      hub.send({ t: 'close', reason, message: 'x' });
      assert.equal(await running, code, reason);
      await sleep(150);
      assert.equal(hub.hellos.length, hellos, reason + ': no reconnection');
    }
    const agent = agentFor(root, hub);
    const running = agent.run();
    const streams = hub.streams;
    await hub.until(() => hub.streams === streams + 1);
    for (const [i, reason] of ['protocol-error', 'server-stop'].entries()) {
      hub.send({ t: 'close', reason, message: 'x' });
      await hub.until(() => hub.streams === streams + 2 + i);
      assert.equal(hub.hellos.at(-1).instance, agent.instance, 'same instance: a resumption, not a replacement');
    }
    await agent.stop();
    assert.equal(await running, 0);
  } finally { await hub.close(); removeRoot(root); }
});

test('reconnection backoff with an injected clock: 1, 2, 4 s, reset after 60 s stable, dead after 45 s without a line', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    const clock = fakeClock();
    hub.helloStatus.push(503, 503, 503);
    const agent = agentFor(root, hub, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random: () => 0.5 });
    const running = agent.run();
    const delays = [];
    for (let i = 0; i < 3; i++) { const timer = await clock.next(t => t.ms < 45000); delays.push(timer.ms); clock.fire(timer); }
    assert.deepEqual(delays, [1000, 2000, 4000]);
    await hub.until(() => hub.streams === 1);
    // A short-lived channel keeps growing the delay.
    hub.endStream();
    const grown = await clock.next(t => t.ms < 45000);
    assert.equal(grown.ms, 8000);
    clock.fire(grown);
    await hub.until(() => hub.streams === 2);
    await waitFor(() => agent.channel.connected());
    // 61 s of a stable channel: back to 1 s.
    clock.t += 61000;
    hub.endStream();
    const reset = await clock.next(t => t.ms < 45000);
    assert.equal(reset.ms, 1000);
    clock.fire(reset);
    await hub.until(() => hub.streams === 3);
    await waitFor(() => agent.channel.connected());
    // Any line re-arms the 45 s dead timer; without lines the stream is dropped and the agent reconnects.
    const armed = await clock.next(t => t.ms === 45000);
    hub.send({ t: 'ping', seq: 1, at: 0 });
    await hub.until(() => hub.messages.some(m => m.t === 'pong' && m.seq === 1));
    const rearmed = await clock.next(t => t.ms === 45000 && t !== armed);
    assert.equal(clock.timers.includes(armed), false);
    clock.fire(rearmed);
    const afterDead = await clock.next(t => t.ms < 45000);
    assert.equal(afterDead.ms, 2000);
    clock.fire(afterDead);
    await hub.until(() => hub.streams === 4);
    await agent.stop();
    assert.equal(await running, 0);
  } finally { await hub.close(); removeRoot(root); }
});

test('backoff jitter stays within +-20%', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    for (const [random, expected] of [[0, 800], [0.9999, 1200]]) {
      const clock = fakeClock();
      hub.helloStatus.push(503);
      const agent = agentFor(root, hub, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random: () => random });
      const running = agent.run();
      const timer = await clock.next(t => t.ms < 45000);
      assert.equal(timer.ms, expected);
      await agent.stop();
      assert.equal(await running, 0);
    }
  } finally { await hub.close(); removeRoot(root); }
});

test('outbox: a lost accepted makes the hub write the call again and it does not run again; the result is resent after reconnecting until a 204', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    let runs = 0; let release;
    const gate = new Promise(resolve => { release = resolve; });
    const agent = agentFor(root, hub, { processes: async image => { runs++; await gate; return PROCESSES[image] ?? []; } });
    const running = agent.run();
    await hub.until(() => hub.streams === 1);
    const call = { t: 'call', id: 'call-x', kind: 'studio.processes', params: { image: 'ODCStudio.exe' }, deadline: Date.now() + 60000 };

    // The POST carrying `accepted` is lost; the channel drops; the resumed stream writes the never-accepted call again.
    hub.dropPosts = 1e9;
    hub.send(call);
    await hub.until(() => hub.posts >= 1);
    hub.dropPosts = 0;
    hub.invalidate();
    await hub.until(() => hub.streams === 2);
    assert.equal(hub.hellos[1].instance, hub.hellos[0].instance);
    hub.send(call);
    await hub.until(() => hub.messages.some(m => m.t === 'accepted' && m.id === 'call-x'));
    assert.equal(runs, 1, 'a call whose id is running never runs again');
    assert.equal(agent.outbox.state('call-x'), 'running');

    // The POSTs carrying the result are lost; a repeated call while done queues nothing new; after reconnecting the
    // result goes again and the 204 releases the id.
    const posts = hub.posts;
    hub.dropPosts = 1e9;
    release();
    await hub.until(() => hub.posts >= posts + 2);
    assert.equal(agent.outbox.state('call-x'), 'done');
    hub.send(call);
    await sleep(50);
    assert.equal(hub.results('call-x').length, 0);
    hub.dropPosts = 0;
    hub.invalidate();
    await hub.until(() => hub.results('call-x').length === 1);
    assert.equal(hub.streams, 3);
    assert.equal(runs, 1);
    assert.deepEqual(hub.results('call-x')[0].value.processes.map(p => p.pid), [4120]);
    await waitFor(() => agent.outbox.tracked === 0);
    await agent.stop();
    assert.equal(await running, 0);
  } finally { await hub.close(); removeRoot(root); }
});

test('a POST still in flight on the old channel that gets 404 sends its batch again at once on the new channel', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  try {
    const agent = agentFor(root, hub);
    const running = agent.run();
    await hub.until(() => hub.streams === 1);
    // The batch with `accepted` is in flight on the first channel when the channel is replaced by a reconnection.
    hub.holdPosts = 1;
    hub.send({ t: 'call', id: 'held', kind: 'studio.processes', params: { image: 'ODCStudio.exe' }, deadline: Date.now() + 60000 });
    await hub.until(() => hub.held.length === 1);
    hub.invalidate();
    await hub.until(() => hub.streams === 2);
    await waitFor(() => agent.channel.connected());
    // The old POST answers 404 now; no ping comes (the next would be up to 15 s away): the batch goes again by itself.
    hub.release();
    await hub.until(() => hub.results('held').length === 1, 3000);
    assert.ok(hub.messages.some(m => m.t === 'accepted' && m.id === 'held'));
    await waitFor(() => agent.outbox.tracked === 0);
    await agent.stop();
    assert.equal(await running, 0);
  } finally { await hub.close(); removeRoot(root); }
});

test('a value above maxValueBytes is refused as VALUE_TOO_LARGE without uploading anything', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL, welcome: { inlineMaxBytes: 2048, maxValueBytes: 4096 } });
  try {
    const many = Array.from({ length: 60 }, (_, i) => ({ pid: 1000 + i * 4, path: 'C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio\\ODCStudio.exe', version: '1.7.28.4021' }));
    assert.ok(Buffer.byteLength(JSON.stringify({ processes: many })) > 4096);
    const agent = agentFor(root, hub, { processes: async () => many });
    const running = agent.run();
    await hub.until(() => hub.streams === 1);
    hub.send({ t: 'call', id: 'huge', kind: 'studio.processes', params: { image: 'ODCStudio.exe' }, deadline: Date.now() + 60000 });
    await hub.until(() => hub.results('huge').length === 1);
    const [result] = hub.results('huge');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VALUE_TOO_LARGE');
    assert.equal(result.error.executed, null);
    assert.equal(hub.blobPuts, 0, 'nothing uploaded');
    await agent.stop(); await running;
  } finally { await hub.close(); removeRoot(root); }
});

test('blobs both ways in parts, with a corrupted part refused and a refused upload part sent again', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL, welcome: { partBytes: 1000 } });
  try {
    const agent = agentFor(root, hub);
    const running = agent.run();
    await hub.until(() => hub.streams === 1);
    const ask = async (id, kind, params) => { hub.send({ t: 'call', id, kind, params, deadline: Date.now() + 60000 }); await hub.until(() => hub.results(id).length === 1); return hub.results(id)[0]; };

    // server -> agent, 3 parts
    const data = randomBytes(2500);
    const ref = hub.putBlob(data, 1000);
    const put = await ask('put-1', 'file.put', { path: 'agent:odc/lab/in/data.bin', blob: ref });
    assert.deepEqual(put.value, { path: 'agent:odc/lab/in/data.bin', sha256: ref.sha256, size: 2500, skipped: false });
    assert.deepEqual(fs.readFileSync(path.join(root, 'odc', 'lab', 'in', 'data.bin')), data);
    assert.equal(hub.blobGets, 3);
    const skipped = await ask('put-2', 'file.put', { path: 'agent:odc/lab/in/data.bin', blob: ref });
    assert.equal(skipped.value.skipped, true);
    assert.equal(hub.blobGets, 3, 'same sha256: no part downloaded');

    // agent -> server, 3 parts, the first PUT refused once (PART_HASH_MISMATCH) and sent again
    const out = randomBytes(2100);
    fs.mkdirSync(path.join(root, 'o11', 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'o11', 'out', 'result.bin'), out);
    hub.corruptPuts = 1;
    const got = await ask('get-1', 'file.get', { path: 'agent:o11/out/result.bin' });
    assert.equal(got.ok, true);
    assert.equal(got.value.blob.parts, 3); assert.equal(got.value.blob.partBytes, 1000);
    assert.deepEqual(hub.assembled(got.value.blob), out);
    assert.equal(hub.blobPuts, 4);

    // a part whose bytes do not match its sha256 is refused (after 3 more tries); nothing is written
    const bad = hub.putBlob(randomBytes(2500), 1000);
    hub.corruptParts.add(bad.transfer + '/1');
    const refused = await ask('put-3', 'file.put', { path: 'agent:odc/lab/in/bad.bin', blob: bad });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'BLOB_HASH_MISMATCH');
    assert.equal(refused.error.executed, false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'odc', 'lab', 'in')), ['data.bin']);
    await agent.stop(); await running;
  } finally { await hub.close(); removeRoot(root); }
});

test('a value above inlineMaxBytes (measured on the whole message) goes as valueBlob', async () => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL, welcome: { inlineMaxBytes: 2048 } });
  try {
    const many = Array.from({ length: 60 }, (_, i) => ({ pid: 1000 + i * 4, path: 'C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio\\ODCStudio.exe', version: '1.7.28.4021' }));
    const agent = agentFor(root, hub, { processes: async () => many });
    const running = agent.run();
    await hub.until(() => hub.streams === 1);
    hub.send({ t: 'call', id: 'big', kind: 'studio.processes', params: { image: 'ODCStudio.exe' }, deadline: Date.now() + 60000 });
    await hub.until(() => hub.results('big').length === 1);
    const [result] = hub.results('big');
    assert.equal(result.value, undefined);
    assert.deepEqual(JSON.parse(hub.assembled(result.valueBlob).toString('utf8')), { processes: many });
    await agent.stop(); await running;
  } finally { await hub.close(); removeRoot(root); }
});
