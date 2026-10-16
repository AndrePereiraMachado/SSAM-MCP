// Atritos 3, lane fa, C11: a live MCP process never goes stale. The launcher's relay (facade/launch.mjs createMcpRelay)
// reloads the server child in place when the facade or the catalog it loaded change: the client's initialize is sent again
// once under an internal id and its answer swallowed, the call is answered by the new child, and nothing reaches the
// client but the answers it asked for (plus tools/list_changed for a catalog change). A change of the CLI alone reloads
// nothing, and nothing is reloaded while a request is pending. A fake entry stands for the server: it says which child it
// is and how many initialize requests it got. Child node processes only; no Studio.
import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMcpRelay } from '../facade/launch.mjs';

const FAKE = `
let initializes = 0, buffer = '';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.setEncoding('utf8');
if (process.env.FAKE_BROKEN === '1') process.exit(3);
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let n; (n = buffer.indexOf('\\n')) >= 0;) {
    const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') { initializes++; send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: process.env.FAKE_GEN } } }); }
    else if (m.method === 'tools/call') {
      if (m.params.name === 'detached-one' || m.params.name === 'detached-zero')
        send({ jsonrpc: '2.0', method: 'notifications/ssam/detached_tasks', params: { running: m.params.name === 'detached-one' ? 1 : 0 } });
      const value = { child: process.env.FAKE_GEN, initializes, name: m.params.name, reloadedAt: process.env.SSAM_RELOADED_AT ?? null, reloadedFrom: process.env.SSAM_RELOADED_FROM ?? null };
      const reply = () => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } });
      if (m.params.name === 'slow') setTimeout(reply, 300); else reply();
    }
  }
});
`;

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-launch-'));
  const fake = path.join(dir, 'fake-server.mjs'); fs.writeFileSync(fake, FAKE);
  const outputs = [], children = [];
  let identity = { facadeSha256: 'facade-1', catalogSha256: 'catalog-1', launcherSha256: 'launcher-1' };
  let broken = false;
  const relay = createMcpRelay({
    spawnChild: extra => {
      const child = spawn(process.execPath, [fake], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, ...extra, FAKE_GEN: String(children.length + 1), FAKE_BROKEN: broken ? '1' : '0' } });
      children.push(child); return child;
    },
    identity: () => identity, loaded: identity, initTimeoutMs: 10000,
    toObserver: chunk => outputs.push(...String(chunk).split('\n').filter(Boolean).map(line => JSON.parse(line))),
  });
  t.after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } fs.rmSync(dir, { recursive: true, force: true }); });
  relay.start();
  const send = value => relay.toServer(JSON.stringify(value) + '\n');
  const answer = async id => {
    const end = Date.now() + 15000;
    for (;;) {
      const found = outputs.find(m => m.id === id);
      if (found) return found;
      if (Date.now() > end) throw new Error('no answer for ' + id + ': ' + JSON.stringify(outputs));
      await new Promise(r => setTimeout(r, 10));
    }
  };
  const call = async (id, name = 'o11_deliver') => { send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }); return (await answer(id)).result.structuredContent; };
  return { relay, outputs, children, send, answer, call, set: value => { identity = { ...identity, ...value }; }, breakNext: () => { broken = true; }, heal: () => { broken = false; } };
}

test('C11: a facade change reloads the child in place: the new child answers, initialize resent once and swallowed, no RELEASE_CHANGED', async t => {
  const h = harness(t);
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } });
  assert.equal((await h.answer(1)).result.serverInfo.version, '1');
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await h.call(2)).child, '1');
  h.set({ facadeSha256: 'facade-2' });
  const reloaded = await h.call(3);
  assert.equal(reloaded.child, '2', 'the new child answered the call');
  assert.equal(reloaded.initializes, 1, 'the initialize of the client was sent once to the new child');
  assert.match(reloaded.reloadedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(reloaded.reloadedFrom), { facadeSha256: 'facade-1', catalogSha256: 'catalog-1' });
  assert.deepEqual(h.outputs.map(m => m.id ?? m.method), [1, 2, 3], 'the internal initialize answer never reached the client');
  assert.equal(h.outputs.some(m => JSON.stringify(m).includes('RELEASE_CHANGED')), false);
  // The old child ended (by itself when its input closed, or by the kill: then only signalCode is set).
  const old = h.children[0];
  await new Promise(resolve => (old.exitCode != null || old.signalCode != null ? resolve() : old.once('exit', resolve)));
  assert.equal(h.relay.state.reloads, 1);
});

test('C11: a change of the CLI alone (not in the identity) reloads nothing; a pending request postpones the reload', async t => {
  const h = harness(t);
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  await h.answer(1); h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.set({ cli: { mtimeMs: 2 } }); // the kernel CLI runs per call: not part of what the process loaded
  assert.equal((await h.call(2)).child, '1');
  assert.equal(h.children.length, 1, 'nothing reloaded');
  // A slow call is pending: the next call reaches the same child even though the facade changed meanwhile.
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow', arguments: {} } });
  h.set({ facadeSha256: 'facade-2' });
  assert.equal((await h.call(4)).child, '1', 'a reload never happens with a request pending');
  assert.equal((await h.answer(3)).result.structuredContent.child, '1');
  assert.equal(h.children.length, 1);
  // Nothing pending any more: the next call reloads.
  assert.equal((await h.call(5)).child, '2');
});

test('C11: a catalog change also says tools/list_changed; a new child that fails its initialize leaves the old one serving', async t => {
  const h = harness(t);
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  await h.answer(1); h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.set({ catalogSha256: 'catalog-2' });
  assert.equal((await h.call(2)).child, '2');
  assert.ok(h.outputs.some(m => m.method === 'notifications/tools/list_changed'), 'the client is told the tools changed');
  h.breakNext(); h.set({ facadeSha256: 'facade-3' });
  assert.equal((await h.call(3)).child, '2', 'the broken child never took over; the old one answered');
  assert.equal(h.children.length, 3);
  h.heal();
  assert.equal((await h.call(4)).child, '2', 'the same identity is not tried again');
  h.set({ facadeSha256: 'facade-4' });
  assert.equal((await h.call(5)).child, '4');
});

test('CX12: detached work keeps the old child serving until zero, and its notifications stay private', async t => {
  const h = harness(t);
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  await h.answer(1); h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await h.call(2, 'detached-one');
  assert.equal(h.relay.state.detachedTasks, 1);
  h.set({ facadeSha256: 'facade-2', catalogSha256: 'catalog-2' });
  assert.equal((await h.call(3)).child, '1');
  assert.equal(h.children.length, 1, 'a running detached task prevents a reload');
  assert.equal((await h.call(4, 'detached-zero')).child, '1');
  assert.equal(h.relay.state.detachedTasks, 0);
  assert.equal(h.children.length, 1, 'zero itself does not reload the child');
  assert.equal((await h.call(5)).child, '2', 'the next tools/call reloads');
  assert.equal(h.outputs.some(message => message.method === 'notifications/ssam/detached_tasks'), false);
  assert.equal(h.outputs.filter(message => message.method === 'notifications/tools/list_changed').length, 1);
});

test('CX12: a child that exits clears the detached count so the changed release can take over', async t => {
  const h = harness(t);
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  await h.answer(1); h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await h.call(2, 'detached-one');
  assert.equal(h.relay.state.detachedTasks, 1);
  const old = h.children[0];
  const ended = new Promise(resolve => old.once('close', resolve));
  old.kill(); await ended;
  assert.equal(h.relay.state.detachedTasks, 0);
  h.set({ facadeSha256: 'facade-2' });
  assert.equal((await h.call(3)).child, '2');
  assert.equal(h.outputs.some(message => message.method === 'notifications/ssam/detached_tasks'), false);
});
