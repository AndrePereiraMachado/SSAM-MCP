import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { bridgeCall, probeO11, chooseStudio, classifyO11, assertSelectedO11, forgetVerifiedO11, pollWithBackoff, pingO11 } from '../studio-connect.mjs';
import { connectionEnvironment, readConnection, connectionFile } from '../studio-session.mjs';

test('selection never guesses between open Studios or accepts an unrelated pid', () => {
  const processes = [{ pid: 10, path: '/normal/ServiceStudio.exe' }, { pid: 20, path: '/other/ServiceStudio.exe' }];
  assert.throws(() => chooseStudio(processes), /Several.*select one with pid\.$/);
  assert.equal(chooseStudio(processes, 20).pid, 20);
  assert.throws(() => chooseStudio(processes, 30), /No matching/);
  for (const value of [NaN, 0, -1, 1.5, '3;anything']) assert.throws(() => chooseStudio(processes, value), /positive integer/);
  assert.throws(() => chooseStudio([]), /Open it normally/);
});

test('doctor recognizes normal installations and distinguishes open from connected', () => {
  const processes = [{ pid: 10, path: path.resolve('normal/ServiceStudio.exe') }];
  assert.equal(classifyO11(processes, { connected: false }).open, true);
  assert.equal(classifyO11(processes, { connected: false }).connected, false);
  assert.equal(classifyO11(processes, { connected: true, pid: 10 }).connected, true);
  assert.equal(classifyO11(processes, { connected: true, pid: 20 }).connected, false);
});

async function serve(handler, action) {
  const server = net.createServer(socket => socket.once('data', data => handler(socket, JSON.parse(data.toString()))));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await action(server.address().port); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('health probes do not inspect or validate models and reject foreign listeners', async () => {
  const methods = [];
  await serve((socket, request) => {
    methods.push(request.method);
    socket.end(JSON.stringify({ success: true, data: request.method === 'ping'
      ? { pid: 123, bridge: 'anvil', version: '1' } : { protocolVersion: 2, authentication: true } }) + '\n');
  }, async port => assert.equal((await probeO11(port)).pid, 123));
  assert.deepEqual(methods, ['ping', 'bridge_manifest']);
  await serve(socket => socket.end('{"service":"other"}\n'), async port => {
    const result = await probeO11(port); assert.equal(result.connected, false); assert.equal(result.occupied, true);
  });
});

test('partial and oversized handshakes fail rather than hanging or reporting success', async () => {
  await serve(socket => socket.end('{'), async port => await assert.rejects(bridgeCall(port, 'ping'), /without a reply/));
  await serve(socket => socket.end('x'.repeat(66000)), async port => await assert.rejects(bridgeCall(port, 'ping'), /size limit/));
});

test('session record carries only local paths and process identity, and rejects malformed selections', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-connect-test-'));
  const file = connectionFile(root, 'ss4');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.deepEqual(connectionEnvironment(root, 'ss4'), {});
  const record = { ok: true, lane: 'o11', anvilLane: 'ss4', pid: 123, startedUtc: new Date().toISOString(),
    studioDir: path.resolve('studio'), authorityDir: path.resolve('authority') };
  fs.writeFileSync(file, JSON.stringify(record));
  assert.deepEqual(connectionEnvironment(root, 'ss4'), { ANVIL_STUDIO_DIR: record.studioDir, ANVIL_AUTHORITY_DIR: record.authorityDir });
  fs.writeFileSync(file, JSON.stringify({ ...record, studioDir: 'relative' }));
  assert.throws(() => readConnection(root, 'ss4'), /Invalid Studio connection/);
});

// A synthetic bridge on an ephemeral port whose identity the test changes; never a Studio.
async function fakeBridge(identity, action) {
  const methods = [];
  await serve((socket, request) => {
    methods.push(request.method);
    socket.end(JSON.stringify({ success: true, data: request.method === 'ping'
      ? { pid: identity.pid, bridge: 'anvil', version: identity.version } : { protocolVersion: 2, authentication: true } }) + '\n');
  }, port => action(port, methods));
}

test('the selected O11 Studio is described once per selection; later calls only ping the bridge, and a restart is still refused', async () => {
  forgetVerifiedO11();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-assert-o11-'));
  const identity = { pid: 4242, version: '1.0.0' };
  const startedUtc = '2026-10-02T10:00:00.0000000Z';
  await fakeBridge(identity, async (port, methods) => {
    const record = { ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, startedUtc, port, studioDir: path.join(root, 'studio'), authorityDir: path.join(root, 'authority') };
    fs.mkdirSync(path.dirname(connectionFile(root, 'ss4')), { recursive: true });
    fs.writeFileSync(connectionFile(root, 'ss4'), JSON.stringify(record));
    const described = [];
    let actualStart = startedUtc;
    const deps = () => ({ entry: { root, lane: 'ss4' }, env: {}, describe: async args => { described.push(args); return { ok: true, pid: 4242, startedUtc: actualStart }; } });
    const first = deps(); await assertSelectedO11(first);
    assert.deepEqual(described, [['describe', 4242]]);
    assert.deepEqual(first.env, { ANVIL_STUDIO_DIR: record.studioDir, ANVIL_AUTHORITY_DIR: record.authorityDir });
    assert.deepEqual(methods, ['ping', 'bridge_manifest']);
    methods.length = 0;
    const second = deps(); await assertSelectedO11(second); await assertSelectedO11(deps());
    assert.equal(described.length, 1, 'no describe while the record and the ping match');
    assert.deepEqual(methods, ['ping', 'ping'], 'one cheap ping per call');
    assert.deepEqual(second.env, first.env);
    // Restart: another process answers on the port. The memo is dropped and the full check refuses, without describe.
    identity.pid = 5151;
    await assert.rejects(assertSelectedO11(deps()), /no longer connected\. Call ssam_connect \{lane:"o11"\}/);
    assert.equal(described.length, 1);
    // Same pid, other bridge version (reloaded): not trusted from memory, described again.
    identity.pid = 4242; identity.version = '1.0.1';
    await assertSelectedO11(deps());
    assert.equal(described.length, 2);
    // A process that reused the pid with another start time: refused by describe, and never remembered.
    forgetVerifiedO11(); actualStart = '2026-10-02T11:00:00.0000000Z';
    await assert.rejects(assertSelectedO11(deps()), /restarted\. Call ssam_connect \{lane:"o11"\} again/);
    await assert.rejects(assertSelectedO11(deps()), /restarted/);
    assert.equal(described.length, 4, 'a refused selection is checked in full every time');
    // A new connection record (new startedUtc) is checked in full once, then remembered.
    fs.writeFileSync(connectionFile(root, 'ss4'), JSON.stringify({ ...record, startedUtc: actualStart }));
    await assertSelectedO11(deps()); await assertSelectedO11(deps());
    assert.equal(described.length, 5);
  });
  // No bridge at all (Studio closed): an ephemeral port that was just released does not answer.
  forgetVerifiedO11();
  const closed = net.createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const freePort = closed.address().port; await new Promise(resolve => closed.close(resolve));
  assert.equal((await pingO11(freePort)).connected, false);
  // Without a connection record there is nothing to check.
  await assertSelectedO11({ entry: { root: fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-assert-none-')), lane: 'ss4' }, env: {}, describe: async () => { throw new Error('not called'); } });
});

test('ODC attach waits for the bridge to answer, not for a fixed 1.5 s: at once when ready, backoff while not, one status after a refusal', async () => {
  const { attach } = await import('../lib.mjs');
  const run = async (statuses, attachReply = { ok: true, attached: true }) => {
    let clock = 0; const waits = []; const calls = [];
    const call = async (pid, args) => {
      calls.push(args[0]);
      if (args[0] === 'attach') return attachReply;
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      if (next instanceof Error) throw next;
      return next;
    };
    const result = await attach(77, { call, findPid: async pid => pid, dll: { path: 'C:\\fake\\ODC3.Bridge.v32.dll', version: 'v32' },
      sleep: async ms => { waits.push(ms); clock += ms; }, now: () => clock });
    return { result, waits, calls, clock };
  };
  let r = await run([{ ok: true, bridge: 'v32' }]);
  assert.deepEqual(r.waits, [], 'a bridge that answers needs no wait');
  assert.deepEqual(r.calls, ['attach', 'status']);
  assert.equal(r.result.status.ok, true); assert.equal(r.result.pid, 77); assert.equal(r.result.version, 'v32');
  r = await run([new Error('pipe timeout'), { ok: false, error: 'starting' }, { ok: true, bridge: 'v32' }]);
  assert.deepEqual(r.waits, [250, 500]); assert.equal(r.result.status.ok, true);
  r = await run([{ ok: true }], { ok: false, error: 'hook refused' });
  assert.deepEqual(r.waits, [], 'a refused attach is reported with one status, without waiting');
  assert.equal(r.result.ok, false);
  r = await run([new Error('pipe timeout')]);
  assert.equal(r.clock, 15000, 'gives up at the deadline'); assert.equal(r.result.status.error, 'pipe timeout');
});

test('polling with backoff answers at once, doubles its wait up to 2 s and stops at the deadline', async () => {
  let clock = 0; const waits = [];
  const sleep = async ms => { waits.push(ms); clock += ms; };
  const now = () => clock;
  assert.equal(await pollWithBackoff(async () => 'ready', { sleep, now }), 'ready');
  assert.deepEqual(waits, [], 'no wait when the state is already there');
  let calls = 0;
  assert.equal(await pollWithBackoff(async () => (++calls === 4 ? 'up' : false), { sleep, now }), 'up');
  assert.deepEqual(waits, [250, 500, 1000]);
  waits.length = 0; clock = 0;
  assert.equal(await pollWithBackoff(async () => false, { sleep, now, deadlineMs: 6000 }), null);
  assert.deepEqual(waits, [250, 500, 1000, 2000, 2000, 250]);
  assert.equal(clock, 6000);
});
