// Lane C, C22: one ssam_connect. Without lane it attaches every open Studio of the served lanes that is not attached yet
// (O11 by connectO11, ODC by lib.mjs attach), asks each bridge without the 10 s wait (pipeProbe), answers per Studio
// {lane, pid, target, attached, alreadyAttached, tenant, account}, ok only for the target, and reconnectNeeded:false when
// nothing had to be attached. Fake Studios only: no process listing, no pipe, no bridge, no hook.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as m_studio_connect from '../studio-connect.mjs';
const { connectAll } = m_studio_connect; // a namespace: at the base each test fails on its own rule, not at import
import * as m_odc_pipe from '../odc-pipe.mjs';
const { pipeProbe, PipeError } = m_odc_pipe; // a namespace: at the base each test fails on its own rule, not at import
import * as m_ssam from '../ssam.mjs';
const { createSsamServer } = m_ssam; // a namespace: at the base each test fails on its own rule, not at import

// One fake O11 Studio side (one bridge port per lane) and one fake ODC side (a pipe per Studio).
function fakeSides({ o11 = [], odc = [], odcAttachFails = [] } = {}) {
  const state = { o11Served: null, record: null, odcAttached: new Set(), calls: [] };
  const o11Side = {
    processes: async () => o11.map(pid => ({ pid, path: 'C:\\SS\\ServiceStudio.exe' })),
    probe: async () => (state.o11Served ? { connected: true, pid: state.o11Served } : { connected: false, occupied: false }),
    record: () => state.record,
    connect: async pid => { state.calls.push(['o11-connect', pid]); state.o11Served = pid; state.record = { pid }; return { ok: true, pid }; },
    session: async () => ({ tenant: 'personal.example.test', account: 'dev@example.test' }),
  };
  const odcSide = {
    processes: async () => odc.map(pid => ({ pid })),
    probe: async pid => (state.odcAttached.has(pid) ? { attached: true, busy: false, reply: { ok: true, sessions: [{ host: 'tenant-' + pid + '.example.test', loggedIn: true, user: 'u' + pid + '@example.test' }] } } : { attached: false, reply: null }),
    attach: async pid => {
      state.calls.push(['odc-attach', pid]);
      if (odcAttachFails.includes(pid)) return { ok: false, error: 'attach refused by the fake' };
      state.odcAttached.add(pid); return { ok: true, status: { ok: true }, version: 'v37' };
    },
  };
  return { state, deps: { o11: o11Side, odc: odcSide } };
}

test('no lane, one O11 and one ODC Studio: both attached in one call; the second call needs no reconnection', async () => {
  const { state, deps } = fakeSides({ o11: [100], odc: [200] });
  const first = await connectAll({}, { served: ['o11', 'odc'], ...deps });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.reconnectNeeded, true);
  assert.deepEqual(first.studios.map(s => [s.lane, s.pid, s.target, s.attached, s.alreadyAttached]), [['o11', 100, true, true, false], ['odc', 200, true, true, false]]);
  assert.deepEqual(first.studios.map(s => [s.tenant, s.account]), [['personal.example.test', 'dev@example.test'], ['tenant-200.example.test', 'u200@example.test']]);
  assert.deepEqual(state.calls, [['o11-connect', 100], ['odc-attach', 200]]);
  const second = await connectAll({}, { served: ['o11', 'odc'], ...deps });
  assert.deepEqual([second.ok, second.reconnectNeeded], [true, false]);
  assert.ok(second.studios.every(s => s.attached && s.alreadyAttached));
  assert.equal(state.calls.length, 2, 'nothing attached twice');
});

test('ok speaks for the target only: another Studio that fails never fails the call; two ODC Studios without pid are both attached', async () => {
  const { deps } = fakeSides({ o11: [100], odc: [200, 300], odcAttachFails: [300] });
  const targeted = await connectAll({ pid: 100 }, { served: ['o11', 'odc'], ...deps });
  assert.equal(targeted.ok, true, targeted.error);
  const byPid = Object.fromEntries(targeted.studios.map(s => [s.pid, s]));
  assert.deepEqual([byPid[100].target, byPid[100].attached], [true, true]);
  assert.deepEqual([byPid[300].target, byPid[300].attached, byPid[300].error], [false, false, 'attach refused by the fake']);
  assert.equal(byPid[200].attached, true, 'every ODC Studio has its own pipe: attached too');
  // The target itself failing is the answer's ok.
  const { deps: other } = fakeSides({ odc: [300], odcAttachFails: [300] });
  const failed = await connectAll({ lane: 'odc' }, { served: ['o11', 'odc'], ...other });
  assert.deepEqual([failed.ok, failed.reconnectNeeded], [false, false]); assert.match(failed.error, /odc 300: attach refused/);
  // Two ODC Studios and no pid: no single target, both attached, the call is ok.
  const { deps: two } = fakeSides({ odc: [200, 400] });
  const both = await connectAll({ lane: 'odc' }, { served: ['odc'], ...two });
  assert.equal(both.ok, true, both.error); assert.ok(both.studios.every(s => s.attached)); assert.equal(both.reconnectNeeded, true);
  // A lane this checkout does not serve, and no Studio at all.
  const notServed = await connectAll({ lane: 'odc' }, { served: ['o11'], ...deps });
  assert.deepEqual([notServed.ok, notServed.code], [false, 'LANE_NOT_SERVED']);
  const { deps: none } = fakeSides();
  const empty = await connectAll({}, { served: ['o11', 'odc'], ...none });
  assert.equal(empty.ok, false); assert.match(empty.error, /No Studio is open/);
});

test('the pipe probe answers without the 10 s wait: no pipe is "not attached" at once, a busy pipe is a bridge', async () => {
  const absent = async (pid, version, args, options) => { assert.ok(options.connectMs <= 400, 'a short connect window'); throw new PipeError('no pipe', { code: 'BRIDGE_NOT_ATTACHED', sent: false }); };
  assert.deepEqual(await pipeProbe(1, 'v37', { call: absent }), { attached: false, reply: null });
  const busy = async () => { throw new PipeError('busy', { code: 'BRIDGE_BUSY', sent: false }); };
  assert.deepEqual(await pipeProbe(1, 'v37', { call: busy }), { attached: true, busy: true, reply: null });
  const answers = async (pid, version, args) => JSON.stringify({ ok: true, command: args[0], sessions: [] });
  assert.deepEqual(await pipeProbe(1, 'v37', { call: answers }), { attached: true, busy: false, reply: { ok: true, command: 'auth-status', sessions: [] } });
  const silent = async () => { throw new PipeError('no reply', { code: 'PIPE_REPLY_TIMEOUT', sent: true }); };
  assert.equal((await pipeProbe(1, 'v37', { call: silent })).attached, true, 'it accepted the connection: the bridge is there');
  // The real pipe of a Studio that does not exist: answered well inside a second.
  const started = Date.now();
  assert.equal((await pipeProbe(4194303, 'v0-pacote-c')).attached, false);
  assert.ok(Date.now() - started < 1500, (Date.now() - started) + ' ms');
});

test('MCP ssam_connect: lane is optional and the call reaches the one connect of every served lane', async t => {
  const seen = [];
  const connect = async (input, options) => { seen.push({ input, served: options.served }); return { ok: true, studios: [], reconnectNeeded: false }; };
  const server = await createSsamServer({ o11: true, odc: false, deps: { connect } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pacote-c-connect', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(x => x.name === 'ssam_connect');
  assert.equal((tool.inputSchema.required ?? []).includes('lane'), false, 'lane is optional');
  const reply = await client.callTool({ name: 'ssam_connect', arguments: {} });
  assert.notEqual(reply.isError, true, reply.content[0].text);
  assert.deepEqual(seen, [{ input: {}, served: ['o11'] }]);
  const value = JSON.parse(reply.content[0].text);
  assert.equal(value.reconnectNeeded, false);
});
