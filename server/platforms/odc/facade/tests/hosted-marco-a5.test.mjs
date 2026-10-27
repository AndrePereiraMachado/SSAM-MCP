// servidor/fase4-25 (C:\t\vps-a5\PLANO.md, sections 3.2 and 5): what the product's marco-a5 adds that the hosted server
// must keep inside its seam.
// - ssam_code (D1 a): unavailable hosted (HOSTED_UNAVAILABLE, cause SSAM_CODE_HOSTED_PENDING) while its check and plan read
//   and wrote the server's own roots. servidor/fase4-26 a8 (owner request 18/10): served hosted, every read and write of it
//   the customer's (hosted-ssam-code.test.mjs); here, that it is a server tool whose grammar answers with nothing sent.
// - 3.2-A: ssam_code writes through the registered handler of the lane's delivery tool (the handler map of ssam.mjs). That
//   map keeps the GATED handler, the one a client reaches: a job ssam_code hands to o11_deliver is confined like any other.
// - 3.2-C (D4): the environment components of ssam_discover (environment-components.mjs) read the server's own connection
//   record and keep one cache per server: hosted they are off (HOSTED_UNAVAILABLE), nothing read or written.
// Fake executor and agent; no Studio, no process, no socket.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
const spawned = [];
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  spawned.push({ file, args: [...(args ?? [])] });
  const child = new EventEmitter(); child.stdin = { end() {} }; child.unref = () => {}; child.kill = () => {}; child.pid = 0;
  setImmediate(() => callback?.(new Error('no child process in hosted tests'), '', ''));
  return child;
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));
cp.spawn = (file, args) => { spawned.push({ file, args, spawn: true }); throw new Error('spawn is not allowed in hosted tests'); };
net.createConnection = () => { throw new Error('no TCP or pipe connection in hosted tests'); };
syncBuiltinESMExports();

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { o11Lane } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { hostedTools } = await import('../hosted/policy.mjs');
const { laneComponents } = await import('../environment-components.mjs');

const LANE = o11Lane.lane;
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
class FakeExecutor {
  constructor({ record = null, relay = null } = {}) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.calls = []; this.record = record; this.relay = relay; }
  relayPort() { return this.relay; }
  async call(kind, params = {}) {
    this.calls.push({ kind, params: structuredClone(params) });
    if (kind === 'studio.processes') return { processes: [] };
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  o11Connection() { return this.record; }
  async close() {}
}
const agent = { connected: () => true, protocolError() {},
  info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' },
    compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function hosted() {
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(temp('ssam-a5-'), 'customers', tokenId);
  prepareWorkspace(workspace);
  const relay = 41000 + Math.floor(Math.random() * 8000);
  const executor = new FakeExecutor({ relay, record: { ok: true, lane: 'o11', anvilLane: LANE, pid: 5150, startedUtc: '2026-10-15T10:00:00.0000000Z',
    studioVersion: '11.55.92', port: relay, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-15T10:00:05.000Z', hosted: true } });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Customer ' + tokenId, lanes: ['odc', 'o11'], workspace, agent, executor, o11: { lane: LANE }, close: async () => {} };
}
const within = (context, fn) => runWithExecutor(context, fn);
async function hostedServer(context, { tools } = {}) {
  const server = await within(context, () => createSsamServer({ o11: true, odc: false, hosted: { context, session: { agent, lanes: context.lanes }, ...(tools ? { tools } : {}) } }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-marco-a5-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { close: async () => { await client.close(); await server.close(); },
    call: async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); } };
}

test('a8: ssam_code is a server tool of the hosted catalog; its grammar answers on the server with nothing sent', async () => {
  const entry = hostedTools().ssam_code;
  assert.equal(entry?.class, 'server');
  assert.equal(entry.cause, undefined);
  const context = hosted();
  const sb = await hostedServer(context);
  try {
    for (const lane of ['o11', 'odc']) {
      const value = await sb.call('ssam_code', { lane, action: 'grammar' });
      assert.equal(value.ok, true, JSON.stringify(value).slice(0, 300));
      assert.equal(value.action, 'grammar');
    }
  } finally { await sb.close(); }
  assert.deepEqual(context.executor.calls, [], 'nothing reached the customer\'s machine');
  assert.deepEqual(spawned, [], 'no process on the server');
});

test('the handler map ssam_code writes through keeps the gated handler: a job it hands to o11_deliver is confined like a client\'s', async () => {
  // ssam_code classified as a server tool here only, to reach its write path: the delivery it makes must meet the gate.
  const tools = { ...hostedTools(), ssam_code: { class: 'server', lane: 'arg:lane', agent: 'never', paths: { in: [], out: [] }, reason: 'test only' } };
  const context = hosted();
  const sb = await hostedServer(context, { tools });
  try {
    const outside = path.join(os.tmpdir(), 'server-secret-' + randomUUID() + '.html');
    const value = await sb.call('ssam_code', { lane: 'o11', action: 'write', module: 'M', ops: [{ op: 'html', file: outside, data: {} }], authorize: 'test' });
    assert.equal(value.ok, false, JSON.stringify(value).slice(0, 400));
    assert.equal(value.code, 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(value).slice(0, 400));
    const proto = await sb.call('ssam_code', { lane: 'o11', action: 'write', module: 'M', ops: [{ op: 'prototype', data: { source: 'ws:inbox/p' } }], authorize: 'test' });
    assert.equal(proto.code, 'HOSTED_UNAVAILABLE', JSON.stringify(proto).slice(0, 400));
    assert.equal(proto.cause, 'PROTOTYPE_IMPORT_DISABLED');
  } finally { await sb.close(); }
  assert.deepEqual(spawned, [], 'no kernel process ran for a refused job');
});

// servidor/fase4-26 a8 (declared change of this test): the components are no longer off hosted. They read the customer's own
// connection and list through the customer's lane (hosted-a8-agent.test.mjs proves the listing and the per-customer cache);
// what this test kept stays: nothing is read or written in the server's root. Here the customer's lane refuses (the fake
// executor runs no o11.selected), so the answer is NO_LISTING and nothing is kept.
test('hosted, the environment components of ssam_discover never read or write a root of the server (a8: listed through the customer\'s lane)', async () => {
  const context = hosted();
  const root = temp('ssam-a5-root-');
  const value = await within(context, () => laneComponents({ lane: 'o11', intent: 'gerar um PDF do relatorio', needs: ['pdf'] }, { root }));
  assert.equal(value.ok, false);
  assert.equal(value.code, 'NO_LISTING', JSON.stringify(value).slice(0, 300));
  assert.notEqual(value.cause, 'COMPONENTS_HOSTED_PENDING');
  assert.deepEqual(fs.readdirSync(root), [], 'no .local/components cache was written');
  assert.ok(!fs.existsSync(path.join(context.workspace, 'state', 'components')) || fs.readdirSync(path.join(context.workspace, 'state', 'components')).length === 0);
  assert.deepEqual(context.executor.calls.map(c => c.kind).filter(k => k !== 'o11.selected'), [], 'only the customer\'s own lane was asked');
});

test('a8: the hosted instructions send a session to ssam_code as the local ones do, where its subagent files go, the generators and the prompt', async () => {
  const context = hosted();
  const server = await within(context, () => createSsamServer({ o11: true, odc: false, hosted: { context, session: { agent, lanes: context.lanes } } }));
  const local = await createSsamServer({ o11: true, odc: false });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-marco-a5-instructions', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const text = client.getInstructions();
    assert.equal(text.includes('mcp__ssam__ssam_code'), true, 'in the core tools to load');
    assert.match(text, /ssam_code (plan|check|write|\{lane)/, 'the ssam_code steps of the session rules');
    assert.doesNotMatch(text, /ssam_code is unavailable/);
    assert.match(text, /files subagents write for it go in the agent inbox folder/);
    assert.match(text, /GENERATOR_PENDING/);
    assert.match(text, /HOSTED_PROMPT_UNAVAILABLE/);
    const [s2, c2] = InMemoryTransport.createLinkedPair();
    const localClient = new Client({ name: 'local-instructions', version: '1.0.0' });
    await Promise.all([local.connect(s2), localClient.connect(c2)]);
    assert.match(localClient.getInstructions(), /mcp__ssam__ssam_code/, 'local use is unchanged');
    await localClient.close();
  } finally { await client.close(); await server.close(); await local.close(); }
});
